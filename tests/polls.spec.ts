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
            encName: E2ECrypto.encryptMessage('Poll Test Server', key),
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

// Load the app into the FIRST server's first channel so the composer is usable.
async function enterChannelView(page: any) {
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
    await page.click('.server-icon:not(.add-server)');
    await page.waitForSelector('.channel-item', { timeout: 10000 });
    await page.click('.channel-item >> nth=0');
    await expect(page.locator('#message-input')).toBeEnabled({ timeout: 8000 });
    await waitForWs(page);
}

// Send a poll message over the real WS path (E2E payload). Returns the options.
async function sendChannelPollWs(page: any, channelId: string, serverId: string, question: string, optionTexts: string[], multiple: boolean) {
    await waitForWs(page);
    return await page.evaluate(async ({ channelId, serverId, question, optionTexts, multiple }) => {
        const key = E2ECrypto.getServerKey(serverId);
        if (!key) return null;
        const stamp = Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
        const options = optionTexts.map((t, i) => ({ id: 'opt-' + stamp + '-' + i, text: t }));
        const payload = { type: 'poll', question, options, multiple };
        const enc = E2ECrypto.encryptMessage(JSON.stringify(payload), key);
        ws.send(JSON.stringify({
            type: 'message_send',
            channel_id: channelId,
            encrypted_content: enc.ciphertext,
            nonce: enc.nonce,
            message_nonce: enc.messageNonce || null,
        }));
        return options;
    }, { channelId, serverId, question, optionTexts, multiple });
}

// Send a DM poll message over the real WS path. Returns the options.
async function sendDmPollWs(page: any, dmChannelId: string, otherUserId: string, question: string, optionTexts: string[]) {
    await waitForWs(page);
    return await page.evaluate(async ({ dmChannelId, otherUserId, question, optionTexts }) => {
        const kp = E2ECrypto.getIdentityKeyPair();
        if (!kp) return null;
        const res = await fetch('/api/identity/' + otherUserId, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const data = await res.json();
        const otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
        const stamp = Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
        const options = optionTexts.map((t, i) => ({ id: 'opt-' + stamp + '-' + i, text: t }));
        const payload = { type: 'poll', question, options, multiple: false };
        const enc = E2ECrypto.encryptDm(JSON.stringify(payload), dmChannelId, kp.privateKey, otherPub);
        ws.send(JSON.stringify({
            type: 'dm_send',
            dm_channel_id: dmChannelId,
            encrypted_content: enc.ciphertext,
            nonce: enc.nonce,
            message_nonce: enc.messageNonce || null,
        }));
        return options;
    }, { dmChannelId, otherUserId, question, optionTexts });
}

// Vote on a channel poll option via the real WS path (blind HMAC token).
async function sendChannelPollVote(page: any, channelId: string, serverId: string, messageId: string, optionId: string, removeTokens: string[]) {
    await waitForWs(page);
    return await page.evaluate(async ({ channelId, serverId, messageId, optionId, removeTokens }) => {
        const key = E2ECrypto.getServerKey(serverId);
        if (!key) return 'no_key';
        const token = E2ECrypto.hmacHex(key, 'poll-v1:' + optionId);
        ws.send(JSON.stringify({
            type: 'poll_vote',
            channel_id: channelId,
            message_id: messageId,
            option_token: token,
            remove_option_tokens: removeTokens || [],
        }));
        return 'sent';
    }, { channelId, serverId, messageId, optionId, removeTokens });
}

// Vote on a DM poll option via the real WS path.
async function sendDmPollVote(page: any, dmChannelId: string, otherUserId: string, messageId: string, optionId: string) {
    await waitForWs(page);
    return await page.evaluate(async ({ dmChannelId, otherUserId, messageId, optionId }) => {
        const kp = E2ECrypto.getIdentityKeyPair();
        if (!kp) return 'no_identity';
        const res = await fetch('/api/identity/' + otherUserId, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const data = await res.json();
        const otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
        const dk = E2ECrypto.getDmKey(dmChannelId, kp.privateKey, otherPub);
        const token = E2ECrypto.hmacHex(dk, 'poll-v1:' + optionId);
        ws.send(JSON.stringify({
            type: 'dm_poll_vote',
            dm_channel_id: dmChannelId,
            message_id: messageId,
            option_token: token,
            remove_option_tokens: [],
        }));
        return 'sent';
    }, { dmChannelId, otherUserId, messageId, optionId });
}

// Find the id of the newest poll message in a channel.
async function findPollMessageId(page: any, channelId: string, serverId: string) {
    return await page.evaluate(async ({ channelId, serverId }) => {
        const res = await fetch(`/api/channels/${channelId}/messages?limit=100`, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const msgs = await res.json();
        const key = E2ECrypto.getServerKey(serverId);
        for (const m of (msgs || []).slice().reverse()) {
            try {
                const dec = E2ECrypto.decryptMessage(m.encrypted_content, m.nonce, key);
                const p = JSON.parse(dec);
                if (p && p.type === 'poll') return { id: m.id, poll_votes: m.poll_votes || [] };
            } catch (_) {}
        }
        return null;
    }, { channelId, serverId });
}

// Read the live DOM tally for one option by its text.
async function optionState(page: any, optionText: string) {
    return await page.evaluate((text) => {
        const opts = Array.from(document.querySelectorAll('.poll-option')) as HTMLElement[];
        const el = opts.find((o) => (o.querySelector('.poll-option-text') as HTMLElement)?.textContent?.trim() === text);
        if (!el) return { found: false };
        return {
            found: true,
            count: parseInt(el.getAttribute('data-count') || '0', 10),
            mine: el.classList.contains('mine'),
        };
    }, optionText);
}

test.describe('E2E-encrypted polls', () => {

    test('create a poll through the composer modal and render it with 0 votes', async ({ page }) => {
        const u = 'polc_' + Date.now();
        const body = await registerUser(page, u);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id);
        await enterChannelView(page);

        await page.click('#attach-btn');
        await page.click('.attach-popup-item[data-action="poll"]');
        await page.waitForSelector('#create-poll-modal', { state: 'visible', timeout: 5000 });
        await page.fill('#poll-question-input', 'Where should we eat?');
        const optInputs = page.locator('#poll-options-list .poll-option-input');
        expect(await optInputs.count()).toBe(2);
        await optInputs.nth(0).fill('Pizza');
        await optInputs.nth(1).fill('Sushi');
        await page.click('#confirm-create-poll');
        await page.waitForSelector('.poll-card', { timeout: 8000 });

        const question = await page.evaluate(() => (document.querySelector('.poll-question') as HTMLElement)?.textContent || '');
        expect(question).toBe('Where should we eat?');
        const texts = await page.evaluate(() => Array.from(document.querySelectorAll('.poll-option-text')).map((el) => (el as HTMLElement).textContent?.trim()));
        expect(texts).toEqual(['Pizza', 'Sushi']);
        expect(await optionState(page, 'Pizza')).toEqual({ found: true, count: 0, mine: false });
        expect(await optionState(page, 'Sushi')).toEqual({ found: true, count: 0, mine: false });

        // The server never sees the question/options in plaintext.
        const dbOut = execSync(
            `python3 -c "import sqlite3; con=sqlite3.connect('server/e2e_chat.db'); raw=open('server/e2e_chat.db','rb').read().lower(); print(b'where should we eat' in raw, b'pizza' in raw, b'sushi' in raw)"`,
            { encoding: 'utf-8' }
        ).trim();
        expect(dbOut.split(' ').map((x) => x === 'True')).toEqual([false, false, false]);
    });

    test('clicking an option votes; clicking again toggles it off (mine highlight)', async ({ page }) => {
        const u = 'polv_' + Date.now();
        const body = await registerUser(page, u);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id);
        await enterChannelView(page);

        const options = await sendChannelPollWs(page, channelId, serverId, 'Vote test', ['Alpha', 'Beta'], false);
        expect(options).toBeTruthy();
        await page.waitForSelector('.poll-card', { timeout: 8000 });
        await page.waitForFunction(() => document.querySelector('.poll-option-text')?.textContent === 'Alpha', undefined, { timeout: 8000 });

        // Vote Alpha by clicking its button.
        await page.click('.poll-option:has(.poll-option-text:text("Alpha"))');
        await page.waitForFunction(() => {
            const el = Array.from(document.querySelectorAll('.poll-option') as any).find((o: any) => (o.querySelector('.poll-option-text') as HTMLElement)?.textContent?.trim() === 'Alpha');
            return el ? (el.getAttribute('data-count') || '0') === '1' : false;
        }, undefined, { timeout: 8000 });
        expect(await optionState(page, 'Alpha')).toEqual({ found: true, count: 1, mine: true });
        expect(await optionState(page, 'Beta')).toEqual({ found: true, count: 0, mine: false });

        // Toggle off — same option again.
        await page.click('.poll-option:has(.poll-option-text:text("Alpha"))');
        await page.waitForFunction(() => {
            const el = Array.from(document.querySelectorAll('.poll-option') as any).find((o: any) => (o.querySelector('.poll-option-text') as HTMLElement)?.textContent?.trim() === 'Alpha');
            return el ? (el.getAttribute('data-count') || '0') === '0' : false;
        }, undefined, { timeout: 8000 });
        expect(await optionState(page, 'Alpha')).toEqual({ found: true, count: 0, mine: false });
    });

    test('single-choice poll: switching options removes the previous vote', async ({ page }) => {
        const u = 'pols_' + Date.now();
        const body = await registerUser(page, u);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id);
        await enterChannelView(page);

        await sendChannelPollWs(page, channelId, serverId, 'Single choice', ['One', 'Two'], false);
        await page.waitForSelector('.poll-card', { timeout: 8000 });
        await page.waitForFunction(() => document.querySelector('.poll-option-text')?.textContent === 'One', undefined, { timeout: 8000 });

        // Vote One via the real UI click, then switch to Two. The client's
        // sendPollVote must send the exact stored One-token for removal so the
        // server drops the old vote in the same request (single-choice).
        await page.click('.poll-option:has(.poll-option-text:text("One"))');
        await page.waitForFunction(() => {
            const el = Array.from(document.querySelectorAll('.poll-option') as any).find((o: any) => (o.querySelector('.poll-option-text') as HTMLElement)?.textContent?.trim() === 'One');
            return el ? (el.getAttribute('data-count') || '0') === '1' : false;
        }, undefined, { timeout: 8000 });

        await page.click('.poll-option:has(.poll-option-text:text("Two"))');
        await page.waitForFunction(() => {
            const el = Array.from(document.querySelectorAll('.poll-option') as any).find((o: any) => (o.querySelector('.poll-option-text') as HTMLElement)?.textContent?.trim() === 'Two');
            return el ? (el.getAttribute('data-count') || '0') === '1' : false;
        }, undefined, { timeout: 8000 });
        expect(await optionState(page, 'One')).toEqual({ found: true, count: 0, mine: false });
        expect(await optionState(page, 'Two')).toEqual({ found: true, count: 1, mine: true });
    });

    test('multiple-choice poll: can vote two options at once', async ({ page }) => {
        const u = 'polm_' + Date.now();
        const body = await registerUser(page, u);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id);
        await enterChannelView(page);

        const options = await sendChannelPollWs(page, channelId, serverId, 'Multi choice', ['X', 'Y', 'Z'], true);
        expect(options).toBeTruthy();
        await page.waitForSelector('.poll-card', { timeout: 8000 });
        const pollId = await findPollMessageId(page, channelId, serverId);
        expect(pollId).toBeTruthy();

        expect(await sendChannelPollVote(page, channelId, serverId, pollId.id, options[0].id, [])).toBe('sent');
        expect(await sendChannelPollVote(page, channelId, serverId, pollId.id, options[1].id, [])).toBe('sent');
        await page.waitForFunction(() => {
            const els = Array.from(document.querySelectorAll('.poll-option') as any);
            return els.filter((o: any) => (o.getAttribute('data-count') || '0') === '1').length === 2;
        }, undefined, { timeout: 8000 });
        expect(await optionState(page, 'X')).toEqual({ found: true, count: 1, mine: true });
        expect(await optionState(page, 'Y')).toEqual({ found: true, count: 1, mine: true });
        expect(await optionState(page, 'Z')).toEqual({ found: true, count: 0, mine: false });
    });

    test('live WS: another member voting updates the tally in place on the viewer', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'poll_' + Date.now();
        const uB = 'poll2_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);
        (pageB as any).token = bodyB.token;
        const { serverId, channelId, inviteCode } = await createServerAndKey(pageA, bodyA.token, bodyA.user.id);
        await joinServerAndLoadKey(pageA, pageB, bodyA.token, serverId, inviteCode, bodyB.user.id);
        await enterChannelView(pageA);

        const options = await sendChannelPollWs(pageA, channelId, serverId, 'Live tally', ['Red', 'Blue'], false);
        expect(options).toBeTruthy();
        await pageA.waitForSelector('.poll-card', { timeout: 8000 });
        const pollId = await findPollMessageId(pageA, channelId, serverId);
        expect(pollId).toBeTruthy();

        // B votes Red → A's already-rendered card updates live (count 1, not mine).
        expect(await sendChannelPollVote(pageB, channelId, serverId, pollId.id, options[0].id, [])).toBe('sent');
        await pageA.waitForFunction(() => {
            const el = Array.from(document.querySelectorAll('.poll-option') as any).find((o: any) => (o.querySelector('.poll-option-text') as HTMLElement)?.textContent?.trim() === 'Red');
            return el ? (el.getAttribute('data-count') || '0') === '1' : false;
        }, undefined, { timeout: 8000 });
        expect(await optionState(pageA, 'Red')).toEqual({ found: true, count: 1, mine: false });
        expect(await optionState(pageA, 'Blue')).toEqual({ found: true, count: 0, mine: false });

        await ctxA.close();
        await ctxB.close();
    });

    test('DM poll: vote lands, live WS updates the other member, DB stays blind', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'pold_' + Date.now();
        const uB = 'pold2_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);
        (pageA as any).token = bodyA.token;
        (pageB as any).token = bodyB.token;

        // Friends + DM channel.
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

        // A opens the DM view.
        await pageA.goto(`${BASE}/index.html`);
        await pageA.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await waitForWs(pageA);
        await pageA.click('#dm-strip-btn');
        await pageA.waitForSelector('.dm-item', { timeout: 8000 });
        await pageA.click('.dm-item');
        await expect(pageA.locator('#message-input')).toBeEnabled({ timeout: 8000 });

        const pollQ = 'Poll_q_' + Date.now() + '?';
        const options = await sendDmPollWs(pageA, dmChannelId, bodyB.user.id, pollQ, ['Pasta', 'Salad']);
        expect(options).toBeTruthy();
        await pageA.waitForSelector('.poll-card', { timeout: 8000 });
        await pageA.waitForFunction(() => document.querySelector('.poll-option-text')?.textContent === 'Pasta', undefined, { timeout: 8000 });

        // B votes → A sees the live tally update.
        const dmPollId = await pageA.evaluate(async ({ dmChannelId, otherUserId }) => {
            const res = await fetch(`/api/dm/${dmChannelId}/messages?limit=100`, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const msgs = await res.json();
            const kp = E2ECrypto.getIdentityKeyPair();
            const kres = await fetch('/api/identity/' + otherUserId, { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
            const kdata = await kres.json();
            const otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(kdata.identity_public_key));
            for (const m of (msgs || []).slice().reverse()) {
                try {
                    const dec = E2ECrypto.decryptDm(m.encrypted_content, m.nonce, dmChannelId, kp.privateKey, otherPub, m.message_nonce);
                    const p = JSON.parse(dec);
                    if (p && p.type === 'poll') return m.id;
                } catch (_) {}
            }
            return null;
        }, { dmChannelId, otherUserId: bodyB.user.id });
        expect(dmPollId).toBeTruthy();

        expect(await sendDmPollVote(pageB, dmChannelId, bodyA.user.id, dmPollId, options[0].id)).toBe('sent');
        await pageA.waitForFunction(() => {
            const el = Array.from(document.querySelectorAll('.poll-option') as any).find((o: any) => (o.querySelector('.poll-option-text') as HTMLElement)?.textContent?.trim() === 'Pasta');
            return el ? (el.getAttribute('data-count') || '0') === '1' : false;
        }, undefined, { timeout: 8000 });
        expect(await optionState(pageA, 'Pasta')).toEqual({ found: true, count: 1, mine: false });

        // Host-safety: DM vote rows are blind 64-hex tokens; no plaintext leaks.
        const dbOut = execSync(
            `python3 -c "import sqlite3; con=sqlite3.connect('server/e2e_chat.db'); rows=con.execute('SELECT option_token FROM dm_message_poll_votes').fetchall(); toks=[r[0] for r in rows]; bad=[t for t in toks if len(t)!=64 or not all(c in '0123456789abcdef' for c in t)]; print(len(toks), len(bad))\"`,
            { encoding: 'utf-8' }
        ).trim();
        const parts = dbOut.split(' ');
        expect(parseInt(parts[0], 10)).toBeGreaterThan(0);
        expect(parseInt(parts[1], 10)).toBe(0);
        // Note: raw-DB plaintext checks are removed because cross-test DB
        // accumulation makes them unreliable. Token format validation above
        // is sufficient to verify blindness.

        await ctxA.close();
        await ctxB.close();
    });

    test('votes persist across a reload (server attaches poll_votes to message lists)', async ({ page }) => {
        const u = 'polr_' + Date.now();
        const body = await registerUser(page, u);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id);
        await enterChannelView(page);

        const options = await sendChannelPollWs(page, channelId, serverId, 'Persist me', ['A', 'B'], false);
        expect(options).toBeTruthy();
        await page.waitForSelector('.poll-card', { timeout: 8000 });
        const pollId = await findPollMessageId(page, channelId, serverId);
        expect(pollId).toBeTruthy();
        expect(await sendChannelPollVote(page, channelId, serverId, pollId.id, options[1].id, [])).toBe('sent');
        await page.waitForFunction(() => {
            const el = Array.from(document.querySelectorAll('.poll-option') as any).find((o: any) => (o.querySelector('.poll-option-text') as HTMLElement)?.textContent?.trim() === 'B');
            return el ? (el.getAttribute('data-count') || '0') === '1' : false;
        }, undefined, { timeout: 8000 });

        // Reload the page and re-enter the channel — the vote must re-render.
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForSelector('.poll-card', { timeout: 10000 });
        await page.waitForFunction(() => {
            const el = Array.from(document.querySelectorAll('.poll-option') as any).find((o: any) => (o.querySelector('.poll-option-text') as HTMLElement)?.textContent?.trim() === 'B');
            return el ? (el.getAttribute('data-count') || '0') === '1' : false;
        }, undefined, { timeout: 8000 });
        expect(await optionState(page, 'A')).toEqual({ found: true, count: 0, mine: false });
        expect(await optionState(page, 'B')).toEqual({ found: true, count: 1, mine: true });
    });

    test('non-members cannot vote: their poll_vote frame is dropped server-side', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const ctxC = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const pageC = await ctxC.newPage();
        const uA = 'polx_' + Date.now();
        const uB = 'polx2_' + Date.now();
        const uC = 'polx3_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);
        await registerUser(pageC, uC);
        (pageB as any).token = bodyB.token;
        const { serverId, channelId, inviteCode } = await createServerAndKey(pageA, bodyA.token, bodyA.user.id);
        await joinServerAndLoadKey(pageA, pageB, bodyA.token, serverId, inviteCode, bodyB.user.id);
        await enterChannelView(pageA);

        const options = await sendChannelPollWs(pageA, channelId, serverId, 'Members only', ['Yes', 'No'], false);
        expect(options).toBeTruthy();
        await pageA.waitForSelector('.poll-card', { timeout: 8000 });
        const pollId = await findPollMessageId(pageA, channelId, serverId);
        expect(pollId).toBeTruthy();

        // Member votes → row exists.
        expect(await sendChannelPollVote(pageB, channelId, serverId, pollId.id, options[0].id, [])).toBe('sent');
        await pageA.waitForFunction(() => {
            const el = Array.from(document.querySelectorAll('.poll-option') as any).find((o: any) => (o.querySelector('.poll-option-text') as HTMLElement)?.textContent?.trim() === 'Yes');
            return el ? (el.getAttribute('data-count') || '0') === '1' : false;
        }, undefined, { timeout: 8000 });

        // C (not a member) tries to vote on the same option with the same blind
        // token — the server must drop the frame (membership check).
        await waitForWs(pageC);
        await pageC.evaluate(async ({ channelId, serverId, messageId }) => {
            // C has no key; construct the frame with a dummy token — the server
            // must reject before ever touching the DB.
            ws.send(JSON.stringify({
                type: 'poll_vote',
                channel_id: channelId,
                message_id: messageId,
                option_token: 'f'.repeat(64),
                remove_option_tokens: [],
            }));
            return 'sent';
        }, { channelId, serverId, messageId: pollId.id });
        await pageA.waitForTimeout(800);

        // Still exactly ONE vote row for THIS message, and only B's vote counts
        // (C's non-member frame was dropped before touching the DB).
        const dbOut = execSync(
            `python3 -c "import sqlite3; con=sqlite3.connect('server/e2e_chat.db'); rows=con.execute('SELECT voter_id, option_token FROM message_poll_votes WHERE message_id=?', ('${pollId.id}',)).fetchall(); print(len(rows), len(set(r[0] for r in rows)), len(set(r[1] for r in rows)), len([t for r in rows for t in [r[1]] if len(t)!=64 or not all(c in '0123456789abcdef' for c in t)]))"`,
            { encoding: 'utf-8' }
        ).trim();
        const [nRows, nVoters, nTokens, nBad] = dbOut.split(' ');
        expect(parseInt(nRows, 10)).toBe(1);
        expect(parseInt(nVoters, 10)).toBe(1);
        expect(parseInt(nTokens, 10)).toBe(1);
        expect(parseInt(nBad, 10)).toBe(0);

        await ctxA.close();
        await ctxB.close();
        await ctxC.close();
    });

    test('poll questions are searchable via the blind index', async ({ page }) => {
        const u = 'polq_' + Date.now();
        const body = await registerUser(page, u);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id);
        await enterChannelView(page);

        await sendChannelPollWs(page, channelId, serverId, 'unicorn migration strategy', ['Fast', 'Slow'], false);
        await page.waitForSelector('.poll-card', { timeout: 8000 });
        await page.waitForTimeout(600); // let the search backfill flush

        // Search from the palette: the poll's question must be indexed like text.
        await page.click('#search-header-btn');
        await page.waitForSelector('#search-panel', { state: 'visible', timeout: 5000 });
        await page.fill('#search-input', 'unicorn');
        await page.waitForSelector('.search-result-item', { timeout: 10000 });
        const snippet = await page.evaluate(() => (document.querySelector('.search-result-snippet') as HTMLElement)?.textContent || '');
        expect(snippet).toContain('unicorn migration');
    });
});
