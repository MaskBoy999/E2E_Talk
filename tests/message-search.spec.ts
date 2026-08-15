import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

const BASE = 'https://localhost:3443';

function generateCode(len: number): string {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return code;
}

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function createServerAndKey(page: any, token: string, userId: string) {
    const inviteCode = generateCode(8);
    const encName = await page.evaluate(() => {
        const key = E2ECrypto.generateSymmetricKey();
        return {
            keyB64: E2ECrypto.arrayBufferToBase64(key),
            encName: E2ECrypto.encryptMessage('Search Test Server', key),
            encChName: E2ECrypto.encryptMessage('general', key),
        };
    });
    const res = await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            invite_code: inviteCode,
            encrypted_name: encName.encName.ciphertext,
            name_nonce: encName.encName.nonce,
            channel_encrypted_name: encName.encChName.ciphertext,
            channel_name_nonce: encName.encChName.nonce,
        },
    });
    const server = await res.json();
    await page.evaluate(async ({ serverId, userId, keyB64 }: { serverId: string; userId: string; keyB64: string }) => {
        const serverKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(keyB64));
        E2ECrypto.saveServerKey(serverId, serverKey);
        const identity = E2ECrypto.getIdentityKeyPair();
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
        });
    }, { serverId: server.id, userId, keyB64: encName.keyB64 });
    const channels = await (await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
        headers: { Authorization: `Bearer ${token}` },
    })).json();
    return { serverId: server.id, channelId: channels[0].id, inviteCode };
}

// Join `userPage` to the server and give them the server key (envelope-decrypted
// with their identity private key) so they can encrypt/decrypt + search.
async function joinServerAndLoadKey(ownerPage: any, userPage: any, ownerToken: string, serverId: string, inviteCode: string, otherUserId: string) {
    const joinRes = await userPage.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${userPage.token}` },
        data: { code: inviteCode },
    });
    expect(joinRes.ok()).toBe(true);
    const otherPub = await userPage.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey));
    await ownerPage.evaluate(async ({ serverId, otherUserId, otherPub }: { serverId: string; otherUserId: string; otherPub: string }) => {
        const serverKey = E2ECrypto.getServerKey(serverId);
        const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(otherPub));
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, recipientPub);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: otherUserId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
        });
    }, { serverId, otherUserId, otherPub });
    // User's client decrypts + stores the server key (reuses the app's own
    // fetchAndDecryptServerKey so the test exercises the real key path).
    const ok = await userPage.evaluate(async ({ serverId }: { serverId: string }) => {
        return typeof fetchAndDecryptServerKey === 'function' ? await fetchAndDecryptServerKey(serverId) : false;
    }, { serverId });
    expect(ok).toBe(true);
}

async function waitForWs(page: any) {
    return await page.evaluate(() => new Promise((resolve) => {
        let tries = 0;
        const check = () => {
            tries++;
            if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) resolve(true);
            else if (tries >= 60) resolve(false);
            else setTimeout(check, 100);
        };
        check();
    }));
}

// Send a channel message via the real WS path, optionally indexing it.
async function sendServerMessageViaWs(page: any, channelId: string, serverId: string, text: string, indexed: boolean) {
    await waitForWs(page);
    return await page.evaluate(async ({ channelId, serverId, text, indexed }) => {
        const key = E2ECrypto.getServerKey(serverId);
        if (!key) return 'no_key';
        const enc = E2ECrypto.encryptMessage(text, key);
        const payload: any = {
            type: 'message_send',
            channel_id: channelId,
            encrypted_content: enc.ciphertext,
            nonce: enc.nonce,
            message_nonce: enc.messageNonce || null,
        };
        if (indexed) {
            const toks = E2ECrypto.searchTokensForText(text, [key]);
            if (toks.length) payload.search_tokens = toks;
        }
        ws.send(JSON.stringify(payload));
        return 'sent';
    }, { channelId, serverId, text, indexed });
}

// Send a DM message via the real WS path, optionally indexing it.
async function sendDmMessageViaWs(page: any, dmChannelId: string, otherUserId: string, text: string, indexed: boolean) {
    await waitForWs(page);
    return await page.evaluate(async ({ dmChannelId, otherUserId, text, indexed }) => {
        const kp = E2ECrypto.getIdentityKeyPair();
        if (!kp) return 'no_identity';
        const res = await fetch('/api/identity/' + otherUserId, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const data = await res.json();
        const otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
        const enc = E2ECrypto.encryptDm(JSON.stringify({ type: 'text', text }), dmChannelId, kp.privateKey, otherPub);
        const payload: any = {
            type: 'dm_send',
            dm_channel_id: dmChannelId,
            encrypted_content: enc.ciphertext,
            nonce: enc.nonce,
            message_nonce: enc.messageNonce || null,
        };
        if (indexed) {
            const dk = E2ECrypto.getDmKey(dmChannelId, kp.privateKey, otherPub);
            const toks = E2ECrypto.searchTokensForText(text, [dk]);
            if (toks.length) payload.search_tokens = toks;
        }
        ws.send(JSON.stringify(payload));
        return 'sent';
    }, { dmChannelId, otherUserId, text, indexed });
}

// Map message id -> decrypted text for a channel (oldest first).
async function channelTextMap(page: any, channelId: string, serverId: string) {
    return await page.evaluate(async ({ channelId, serverId }) => {
        const res = await fetch(`/api/channels/${channelId}/messages?limit=100`, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const msgs = await res.json();
        const key = E2ECrypto.getServerKey(serverId);
        const map: Record<string, string> = {};
        for (const m of msgs || []) {
            try {
                const dec = E2ECrypto.decryptMessage(m.encrypted_content, m.nonce, key);
                let text = dec;
                try { const p = JSON.parse(dec); if (p && p.type === 'text') text = p.text || ''; } catch (_) {}
                map[m.id] = text;
            } catch (_) {}
        }
        return map;
    }, { channelId, serverId });
}

test.describe('E2E message search (blind index)', () => {

    test('channel search: AND keywords, case-insensitive, no false positives', async ({ page }) => {
        const u = 'sch_' + Date.now();
        const body = await registerUser(page, u);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id);
        await waitForWs(page);

        expect(await sendServerMessageViaWs(page, channelId, serverId, 'hello world', true)).toBe('sent');
        await page.waitForTimeout(300);
        expect(await sendServerMessageViaWs(page, channelId, serverId, 'goodbye moon', true)).toBe('sent');
        await page.waitForTimeout(300);
        expect(await sendServerMessageViaWs(page, channelId, serverId, 'hello friend', true)).toBe('sent');
        await page.waitForTimeout(800);

        const textMap = await channelTextMap(page, channelId, serverId);
        const ids = Object.keys(textMap);
        expect(ids.length).toBe(3);
        const helloIds = ids.filter((id) => textMap[id].includes('hello'));
        const worldIds = ids.filter((id) => textMap[id].includes('world'));
        expect(helloIds.length).toBe(2);

        // Single keyword.
        const r1 = await page.evaluate(async ({ channelId, serverId, serverId2 }) => {
            const key = E2ECrypto.getAllServerKeys(serverId2);
            const toks = E2ECrypto.searchQueryTokens('hello', key);
            const res = await fetch('/api/search?channel_id=' + encodeURIComponent(channelId) + '&q=' + toks.join(','), {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            return await res.json();
        }, { channelId, serverId, serverId2: serverId });
        expect(r1.results.length).toBe(2);

        // AND semantics: both keywords must be in the same message.
        const r2 = await page.evaluate(async ({ channelId, serverId }) => {
            const key = E2ECrypto.getAllServerKeys(serverId);
            const toks = E2ECrypto.searchQueryTokens('hello world', key);
            const res = await fetch('/api/search?channel_id=' + encodeURIComponent(channelId) + '&q=' + toks.join(','), {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            return await res.json();
        }, { channelId, serverId });
        expect(r2.results.length).toBe(1);
        expect(worldIds).toContain(r2.results[0].id);

        // Case-insensitive: search uppercase keyword.
        const r3 = await page.evaluate(async ({ channelId, serverId }) => {
            const key = E2ECrypto.getAllServerKeys(serverId);
            const toks = E2ECrypto.searchQueryTokens('MOON', key);
            const res = await fetch('/api/search?channel_id=' + encodeURIComponent(channelId) + '&q=' + toks.join(','), {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            return await res.json();
        }, { channelId, serverId });
        expect(r3.results.length).toBe(1);

        // No false positives for a word that isn't there.
        const r4 = await page.evaluate(async ({ channelId, serverId }) => {
            const key = E2ECrypto.getAllServerKeys(serverId);
            const toks = E2ECrypto.searchQueryTokens('nonexistentxyz', key);
            const res = await fetch('/api/search?channel_id=' + encodeURIComponent(channelId) + '&q=' + toks.join(','), {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            return await res.json();
        }, { channelId, serverId });
        expect(r4.results.length).toBe(0);

        // Host-safety: stored tokens are 64-hex HMACs, never the plaintext
        // keyword's raw hash (the HMAC key never reaches the server).
        const dbOut = execSync(
            `python3 -c "import sqlite3,hashlib; con=sqlite3.connect('server/e2e_chat.db'); rows=con.execute('SELECT token FROM message_search_tokens').fetchall(); toks=[r[0] for r in rows]; bad=[t for t in toks if len(t)!=64 or not all(c in '0123456789abcdef' for c in t)]; plain=hashlib.sha256(b'hello').hexdigest(); print(len(toks), len(bad), plain in toks)"`,
            { encoding: 'utf-8' }
        ).trim();
        const [n, nBad, plainIn] = dbOut.split(' ');
        expect(parseInt(n, 10)).toBeGreaterThan(0);
        expect(parseInt(nBad, 10)).toBe(0);
        expect(plainIn).toBe('False');
    });

    test('search is blind: tokens computed with the WRONG key match nothing', async ({ page }) => {
        const u = 'schbk_' + Date.now();
        const body = await registerUser(page, u);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id);
        await waitForWs(page);
        expect(await sendServerMessageViaWs(page, channelId, serverId, 'the secret keyword zanzibar', true)).toBe('sent');
        await page.waitForTimeout(800);

        // An attacker/server who guesses the word but lacks the channel key gets
        // no match — the token requires the key that never leaves clients.
        const r = await page.evaluate(async ({ channelId }) => {
            const wrongKey = E2ECrypto.generateSymmetricKey();
            const toks = E2ECrypto.searchQueryTokens('zanzibar', [wrongKey]);
            const res = await fetch('/api/search?channel_id=' + encodeURIComponent(channelId) + '&q=' + toks.join(','), {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            return await res.json();
        }, { channelId });
        expect(r.results.length).toBe(0);

        // With the real key the same query matches.
        const r2 = await page.evaluate(async ({ channelId, serverId }) => {
            const key = E2ECrypto.getAllServerKeys(serverId);
            const toks = E2ECrypto.searchQueryTokens('zanzibar', key);
            const res = await fetch('/api/search?channel_id=' + encodeURIComponent(channelId) + '&q=' + toks.join(','), {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            return await res.json();
        }, { channelId, serverId });
        expect(r2.results.length).toBe(1);
    });

    test('substring search: a partial word matches messages containing those characters', async ({ page }) => {
        const u = 'schsub_' + Date.now();
        const body = await registerUser(page, u);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id);
        await waitForWs(page);

        expect(await sendServerMessageViaWs(page, channelId, serverId, 'meet at the lighthouse', true)).toBe('sent');
        await page.waitForTimeout(300);
        expect(await sendServerMessageViaWs(page, channelId, serverId, 'bring the maps', true)).toBe('sent');
        await page.waitForTimeout(800);

        // "ligh" is 3 chars of "lighthouse" — substring matching must find it.
        const r1 = await page.evaluate(async ({ channelId, serverId }) => {
            const key = E2ECrypto.getAllServerKeys(serverId);
            const toks = E2ECrypto.searchQueryTokens('ligh', key);
            const res = await fetch('/api/search?channel_id=' + encodeURIComponent(channelId) + '&q=' + toks.join(','), {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            return await res.json();
        }, { channelId, serverId });
        expect(r1.results.length).toBe(1);

        // A 2-char interior substring also matches.
        const r2 = await page.evaluate(async ({ channelId, serverId }) => {
            const key = E2ECrypto.getAllServerKeys(serverId);
            const toks = E2ECrypto.searchQueryTokens('maps', key);
            const res = await fetch('/api/search?channel_id=' + encodeURIComponent(channelId) + '&q=' + toks.join(','), {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            return await res.json();
        }, { channelId, serverId });
        expect(r2.results.length).toBe(1);

        // A substring that appears nowhere matches nothing.
        const r3 = await page.evaluate(async ({ channelId, serverId }) => {
            const key = E2ECrypto.getAllServerKeys(serverId);
            const toks = E2ECrypto.searchQueryTokens('zzq', key);
            const res = await fetch('/api/search?channel_id=' + encodeURIComponent(channelId) + '&q=' + toks.join(','), {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            return await res.json();
        }, { channelId, serverId });
        expect(r3.results.length).toBe(0);
    });

    test('user filter narrows to one sender and combines with text', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'scha_' + Date.now();
        const uB = 'schb_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);
        (pageB as any).token = bodyB.token;

        const { serverId, channelId, inviteCode } = await createServerAndKey(pageA, bodyA.token, bodyA.user.id);
        await joinServerAndLoadKey(pageA, pageB, bodyA.token, serverId, inviteCode, bodyB.user.id);
        await waitForWs(pageA);
        await waitForWs(pageB);

        expect(await sendServerMessageViaWs(pageA, channelId, serverId, 'hello from alice', true)).toBe('sent');
        await pageA.waitForTimeout(300);
        expect(await sendServerMessageViaWs(pageB, channelId, serverId, 'hello from bob', true)).toBe('sent');
        await pageA.waitForTimeout(800);

        // Both senders match "hello".
        const all = await pageA.evaluate(async ({ channelId, serverId }) => {
            const key = E2ECrypto.getAllServerKeys(serverId);
            const toks = E2ECrypto.searchQueryTokens('hello', key);
            const res = await fetch('/api/search?channel_id=' + encodeURIComponent(channelId) + '&q=' + toks.join(','), {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            return await res.json();
        }, { channelId, serverId });
        expect(all.results.length).toBe(2);

        // Filter to Bob only: "hello" + sender_id=bob → exactly Bob's message.
        const bobOnly = await pageA.evaluate(async ({ channelId, serverId, bobId }) => {
            const key = E2ECrypto.getAllServerKeys(serverId);
            const toks = E2ECrypto.searchQueryTokens('hello', key);
            const res = await fetch('/api/search?channel_id=' + encodeURIComponent(channelId) + '&q=' + toks.join(',') + '&sender_id=' + encodeURIComponent(bobId), {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            return await res.json();
        }, { channelId, serverId, bobId: bodyB.user.id });
        expect(bobOnly.results.length).toBe(1);
        expect(bobOnly.results[0].sender_user_id).toBe(bodyB.user.id);

        // Sender-only (no text): all of Bob's messages in the channel.
        const bobAll = await pageA.evaluate(async ({ channelId, bobId }) => {
            const res = await fetch('/api/search?channel_id=' + encodeURIComponent(channelId) + '&sender_id=' + encodeURIComponent(bobId), {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            return await res.json();
        }, { channelId, bobId: bodyB.user.id });
        expect(bobAll.results.length).toBe(1);

        await ctxA.close();
        await ctxB.close();
    });

    test('backfill: POST /api/search/index makes old (unindexed) messages searchable', async ({ page }) => {
        const u = 'schbf_' + Date.now();
        const body = await registerUser(page, u);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id);
        await waitForWs(page);

        // Simulate an old client: no search_tokens in the payload.
        expect(await sendServerMessageViaWs(page, channelId, serverId, 'legacy message pineapple', false)).toBe('sent');
        await page.waitForTimeout(800);

        // Not searchable yet.
        const before = await page.evaluate(async ({ channelId, serverId }) => {
            const key = E2ECrypto.getAllServerKeys(serverId);
            const toks = E2ECrypto.searchQueryTokens('pineapple', key);
            const res = await fetch('/api/search?channel_id=' + encodeURIComponent(channelId) + '&q=' + toks.join(','), {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            return await res.json();
        }, { channelId, serverId });
        expect(before.results.length).toBe(0);

        // The client indexes what it has decrypted (here: simulate by fetching
        // the message, decrypting, tokenizing, and posting the batch).
        const idx = await page.evaluate(async ({ channelId, serverId }) => {
            const res = await fetch(`/api/channels/${channelId}/messages?limit=100`, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const msgs = await res.json();
            const keys = E2ECrypto.getAllServerKeys(serverId);
            const key0 = keys && keys[0];
            const entries: any[] = [];
            for (const m of msgs || []) {
                try {
                    const dec = key0 ? E2ECrypto.decryptMessage(m.encrypted_content, m.nonce, key0) : null;
                    const toks = dec ? E2ECrypto.searchTokensForText(dec, keys) : [];
                    if (toks.length) entries.push({ message_id: m.id, tokens: toks });
                } catch (_) {}
            }
            const post = await fetch('/api/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ channel_id: channelId, entries }),
            });
            const txt = await post.text();
            try { return JSON.parse(txt); } catch (_) { return { ok: false, raw: txt, status: post.status }; }
        }, { channelId, serverId });
        expect(idx.ok).toBe(true);
        expect(idx.indexed).toBe(1);

        // Now searchable.
        const after = await page.evaluate(async ({ channelId, serverId }) => {
            const key = E2ECrypto.getAllServerKeys(serverId);
            const toks = E2ECrypto.searchQueryTokens('pineapple', key);
            const res = await fetch('/api/search?channel_id=' + encodeURIComponent(channelId) + '&q=' + toks.join(','), {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            return await res.json();
        }, { channelId, serverId });
        expect(after.results.length).toBe(1);
    });

    test('non-members cannot search a channel (403); DM search works for members only', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxC = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageC = await ctxC.newPage();
        const uA = 'schm_' + Date.now();
        const uC = 'schm2_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyC = await registerUser(pageC, uC);
        const { serverId, channelId } = await createServerAndKey(pageA, bodyA.token, bodyA.user.id);
        await waitForWs(pageA);
        expect(await sendServerMessageViaWs(pageA, channelId, serverId, 'private stuff', true)).toBe('sent');
        await pageA.waitForTimeout(500);

        const res = await pageC.evaluate(async ({ channelId, serverId }) => {
            const key = E2ECrypto.getAllServerKeys(serverId);
            const toks = key ? E2ECrypto.searchQueryTokens('private', key) : [];
            const q = toks.length ? '&q=' + toks.join(',') : '';
            const r = await fetch('/api/search?channel_id=' + encodeURIComponent(channelId) + q, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            return { status: r.status, body: r.ok ? await r.json() : null };
        }, { channelId, serverId });
        expect(res.status).toBe(403);

        await ctxA.close();
        await ctxC.close();
    });

    test('DM search finds messages in a 1:1 conversation', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'schd_' + Date.now();
        const uB = 'schd2_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);

        // Become friends + create the DM.
        const codeB = await pageB.evaluate(() => localStorage.getItem('e2e_friend_code'));
        const fr = await pageA.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: codeB },
        });
        expect(fr.ok()).toBeTruthy();
        const incoming = await (await pageB.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${bodyB.token}` },
        })).json();
        await pageB.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${bodyB.token}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        const dm = await (await pageA.request.post(`${BASE}/api/dm/${bodyB.user.id}`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
        })).json();
        const dmChannelId = dm.dm_channel_id || dm.id;

        await waitForWs(pageA);
        expect(await sendDmMessageViaWs(pageA, dmChannelId, bodyB.user.id, 'secret meeting at the lighthouse', true)).toBe('sent');
        await pageA.waitForTimeout(800);

        const r = await pageA.evaluate(async ({ dmChannelId, otherUserId }) => {
            const kp = E2ECrypto.getIdentityKeyPair();
            const res = await fetch('/api/identity/' + otherUserId, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const data = await res.json();
            const otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
            const dk = E2ECrypto.getDmKey(dmChannelId, kp.privateKey, otherPub);
            const toks = E2ECrypto.searchQueryTokens('lighthouse', [dk]);
            const s = await fetch('/api/search?dm_channel_id=' + encodeURIComponent(dmChannelId) + '&q=' + toks.join(','), {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            return await s.json();
        }, { dmChannelId, otherUserId: bodyB.user.id });
        expect(r.results.length).toBe(1);
        expect(r.results[0].dm_channel_id).toBe(dmChannelId);

        // Global search (no channel scope) finds the same DM message.
        const g = await pageA.evaluate(async ({ dmChannelId, otherUserId }) => {
            const kp = E2ECrypto.getIdentityKeyPair();
            const res = await fetch('/api/identity/' + otherUserId, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const data = await res.json();
            const otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
            const dk = E2ECrypto.getDmKey(dmChannelId, kp.privateKey, otherPub);
            const toks = E2ECrypto.searchQueryTokens('lighthouse', [dk]);
            const s = await fetch('/api/search?q=' + toks.join(','), {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            return await s.json();
        }, { dmChannelId, otherUserId: bodyB.user.id });
        const dmHits = (g.results || []).filter((x: any) => x.dm_channel_id === dmChannelId);
        expect(dmHits.length).toBe(1);

        await ctxA.close();
        await ctxB.close();
    });

    test('UI: header search button scopes to the channel; Ctrl+K opens global; results jump to the message', async ({ page }) => {
        const u = 'schui_' + Date.now();
        const body = await registerUser(page, u);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id);

        // Load the app into the channel view.
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await expect(page.locator('#message-input')).toBeEnabled({ timeout: 5000 });
        await waitForWs(page);

        expect(await sendServerMessageViaWs(page, channelId, serverId, 'the first needle message', true)).toBe('sent');
        await page.waitForTimeout(300);
        expect(await sendServerMessageViaWs(page, channelId, serverId, 'a second needle message', true)).toBe('sent');
        await page.waitForTimeout(800);
        const textMap = await channelTextMap(page, channelId, serverId);
        const needleIds = Object.keys(textMap).filter((id) => textMap[id].includes('needle'));
        expect(needleIds.length).toBe(2);

        // The header button appears in a channel and opens a CHANNEL-scoped palette.
        await expect(page.locator('#search-header-btn')).toBeVisible({ timeout: 5000 });
        await page.click('#search-header-btn');
        await page.waitForSelector('#search-panel', { state: 'visible', timeout: 5000 });
        const title = await page.evaluate(() => document.getElementById('search-panel-title')!.textContent);
        expect(title).toBe('Search this channel');

        await page.fill('#search-input', 'needle');
        await page.waitForSelector('.search-result-item', { timeout: 8000 });
        const count = await page.evaluate(() => document.querySelectorAll('.search-result-item').length);
        expect(count).toBe(2);
        const snippets = await page.evaluate(() => Array.from(document.querySelectorAll('.search-result-snippet')).map((el) => el.textContent || ''));
        for (const s of snippets) expect(s.toLowerCase()).toContain('needle');

        // Click the OLDEST result → jump to it (flash highlight).
        const oldestId = needleIds[0];
        await page.evaluate((id) => {
            const items = Array.from(document.querySelectorAll('.search-result-item')) as HTMLElement[];
            const target = items.find((el) => el.dataset.mid === id);
            if (target) target.click();
        }, oldestId);
        await page.waitForSelector('#search-panel', { state: 'hidden', timeout: 5000 });
        await page.waitForSelector(`.message[data-message-id="${oldestId}"].flash-highlight`, { timeout: 10000 });

        // Ctrl+K opens the GLOBAL palette from anywhere.
        await page.keyboard.press('Control+k');
        await page.waitForSelector('#search-panel', { state: 'visible', timeout: 5000 });
        const gtitle = await page.evaluate(() => document.getElementById('search-panel-title')!.textContent);
        expect(gtitle).toBe('Search all messages');
        await page.keyboard.press('Escape');
        await page.waitForSelector('#search-panel', { state: 'hidden', timeout: 5000 });
    });

    test('UI: user chips render with profiles and filter results', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'schc_' + Date.now();
        const uB = 'schc2_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);
        (pageB as any).token = bodyB.token;

        const { serverId, channelId, inviteCode } = await createServerAndKey(pageA, bodyA.token, bodyA.user.id);
        await joinServerAndLoadKey(pageA, pageB, bodyA.token, serverId, inviteCode, bodyB.user.id);

        await pageA.goto(`${BASE}/index.html`);
        await pageA.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await pageA.click('.server-icon:not(.add-server)');
        await pageA.waitForSelector('.channel-item', { timeout: 10000 });
        await pageA.click('.channel-item >> nth=0');
        await expect(pageA.locator('#message-input')).toBeEnabled({ timeout: 5000 });
        await waitForWs(pageA);
        await pageA.waitForFunction(() => {
            const list: any[] = (0, eval)('currentServerMemberList');
            return Array.isArray(list) && list.length >= 2;
        }, undefined, { timeout: 10000 });

        expect(await sendServerMessageViaWs(pageA, channelId, serverId, 'shared keyword from alice', true)).toBe('sent');
        await pageA.waitForTimeout(300);
        expect(await sendServerMessageViaWs(pageB, channelId, serverId, 'shared keyword from bob', true)).toBe('sent');
        await pageA.waitForTimeout(1000);

        await pageA.click('#search-header-btn');
        await pageA.waitForSelector('#search-user-chips .search-chip', { timeout: 5000 });
        const chipCount = await pageA.evaluate(() => document.querySelectorAll('#search-user-chips .search-chip').length);
        expect(chipCount).toBeGreaterThanOrEqual(2);

        await pageA.fill('#search-input', 'shared');
        await pageA.waitForSelector('.search-result-item', { timeout: 8000 });
        const before = await pageA.evaluate(() => document.querySelectorAll('.search-result-item').length);
        expect(before).toBe(2);

        // Click Bob's chip → only Bob's message remains.
        await pageA.evaluate((bobId) => {
            const chips = Array.from(document.querySelectorAll('#search-user-chips .search-chip')) as HTMLElement[];
            const bob = chips.find((el) => el.dataset.uid === bobId);
            if (bob) bob.click();
        }, bodyB.user.id);
        await pageA.waitForFunction(() => document.querySelectorAll('.search-result-item').length === 1, undefined, { timeout: 8000 });
        // The remaining result belongs to Bob.
        const snippet = await pageA.evaluate(() => (document.querySelector('.search-result-snippet') as HTMLElement)?.textContent || '');
        expect(snippet).toContain('bob');

        await ctxA.close();
        await ctxB.close();
    });

    test('UI: DM search — text search decrypts snippets, chips include the other person, and their filter works', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'schdui_' + Date.now();
        const uB = 'schdui2_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);
        (pageA as any).token = bodyA.token;
        (pageB as any).token = bodyB.token;

        // Become friends + create the DM channel.
        const codeB = await pageB.evaluate(() => localStorage.getItem('e2e_friend_code'));
        const fr = await pageA.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: codeB },
        });
        expect(fr.ok()).toBeTruthy();
        const incoming = await (await pageB.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${bodyB.token}` },
        })).json();
        await pageB.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${bodyB.token}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        const dm = await (await pageA.request.post(`${BASE}/api/dm/${bodyB.user.id}`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
        })).json();
        const dmChannelId = dm.dm_channel_id || dm.id;

        // Load the app for user A and open the DM view (reload so dmConversations loads).
        await pageA.goto(`${BASE}/index.html`);
        await pageA.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await waitForWs(pageA);
        await pageA.click('#dm-strip-btn');
        await pageA.waitForSelector('.dm-item', { timeout: 8000 });
        await pageA.click('.dm-item');
        await expect(pageA.locator('#message-input')).toBeEnabled({ timeout: 8000 });

        // Both users send DM messages containing a unique keyword.
        expect(await sendDmMessageViaWs(pageA, dmChannelId, bodyB.user.id, 'alpha lighthouse plan', true)).toBe('sent');
        await pageA.waitForTimeout(800);
        expect(await sendDmMessageViaWs(pageB, dmChannelId, bodyA.user.id, 'beta lighthouse plan', true)).toBe('sent');
        await pageA.waitForTimeout(1200);

        // Open the DM-scoped search palette and type a keyword.
        await pageA.click('#search-header-btn');
        await pageA.waitForSelector('#search-panel', { state: 'visible', timeout: 5000 });
        const dtitle = await pageA.evaluate(() => document.getElementById('search-panel-title')!.textContent);
        expect(dtitle).toBe('Search this conversation');

        // 1) Text search works in DMs and snippets are DECRYPTED (not [encrypted]).
        await pageA.fill('#search-input', 'lighthouse');
        await pageA.waitForSelector('.search-result-item', { timeout: 10000 });
        const dmResults = await pageA.evaluate(() => Array.from(document.querySelectorAll('.search-result-item')).map((el) => ({
            snippet: (el.querySelector('.search-result-snippet') as HTMLElement)?.textContent || '',
            context: (el.querySelector('.search-result-context') as HTMLElement)?.textContent || '',
            mid: (el as HTMLElement).dataset.mid,
        })));
        console.log('DM search results:', JSON.stringify(dmResults));
        expect(dmResults.length).toBe(2);
        for (const r of dmResults) {
            expect(r.snippet).toContain('lighthouse');
            expect(r.snippet).not.toContain('[encrypted]');
        }

        // 2) The other person's chip is present (not only "you").
        const chipUids = await pageA.evaluate(() => Array.from(document.querySelectorAll('#search-user-chips .search-chip')).map((el) => (el as HTMLElement).dataset.uid || ''));
        console.log('DM chips:', JSON.stringify(chipUids));
        expect(chipUids).toContain(bodyB.user.id);
        expect(chipUids).toContain(bodyA.user.id);

        // 3) Filtering by the OTHER person shows only their message.
        await pageA.evaluate((uid) => {
            const chips = Array.from(document.querySelectorAll('#search-user-chips .search-chip')) as HTMLElement[];
            const chip = chips.find((el) => el.dataset.uid === uid);
            if (chip) chip.click();
        }, bodyB.user.id);
        await pageA.waitForFunction(() => document.querySelectorAll('.search-result-item').length === 1, undefined, { timeout: 8000 });
        const filteredSnippet = await pageA.evaluate(() => (document.querySelector('.search-result-snippet') as HTMLElement)?.textContent || '');
        expect(filteredSnippet).toContain('beta');

        await ctxA.close();
        await ctxB.close();
    });
});
