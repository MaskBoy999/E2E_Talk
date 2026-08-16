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
            encName: E2ECrypto.encryptMessage('Status Test Server', key),
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

// Send a DM message via the real WS path. Returns the message id (the sending
// client derives it from the broadcast, so give it a beat and read the DOM).
async function sendDmMessageViaWs(page: any, dmChannelId: string, otherUserId: string, text: string) {
    await waitForWs(page);
    return await page.evaluate(async ({ dmChannelId, otherUserId, text }) => {
        const kp = E2ECrypto.getIdentityKeyPair();
        if (!kp) return 'no_identity';
        const res = await fetch('/api/identity/' + otherUserId, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const data = await res.json();
        const otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
        const enc = E2ECrypto.encryptDm(JSON.stringify({ type: 'text', text }), dmChannelId, kp.privateKey, otherPub);
        ws.send(JSON.stringify({
            type: 'dm_send',
            dm_channel_id: dmChannelId,
            encrypted_content: enc.ciphertext,
            nonce: enc.nonce,
            message_nonce: enc.messageNonce || null,
        }));
        return 'sent';
    }, { dmChannelId, otherUserId, text });
}

async function sendChannelMessageViaWs(page: any, channelId: string, serverId: string, text: string) {
    await waitForWs(page);
    return await page.evaluate(async ({ channelId, serverId, text }) => {
        const key = E2ECrypto.getServerKey(serverId);
        if (!key) return 'no_key';
        const enc = E2ECrypto.encryptMessage(JSON.stringify({ type: 'text', text }), key);
        ws.send(JSON.stringify({
            type: 'message_send',
            channel_id: channelId,
            encrypted_content: enc.ciphertext,
            nonce: enc.nonce,
            message_nonce: enc.messageNonce || null,
        }));
        return 'sent';
    }, { channelId, serverId, text });
}

// Send an explicit ack via the real WS path (computes the blind token client-side).
async function sendDmAck(page: any, dmChannelId: string, otherUserId: string, messageId: string, status: string) {
    await waitForWs(page);
    return await page.evaluate(async ({ dmChannelId, otherUserId, messageId, status }) => {
        const kp = E2ECrypto.getIdentityKeyPair();
        if (!kp) return 'no_identity';
        const res = await fetch('/api/identity/' + otherUserId, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const data = await res.json();
        const otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
        const dk = E2ECrypto.getDmKey(dmChannelId, kp.privateKey, otherPub);
        ws.send(JSON.stringify({
            type: 'dm_message_ack',
            dm_channel_id: dmChannelId,
            message_id: messageId,
            status: status,
            ack_token: E2ECrypto.hmacHex(dk, 'ack-v1:' + messageId),
        }));
        return 'sent';
    }, { dmChannelId, otherUserId, messageId, status });
}

async function sendChannelAck(page: any, channelId: string, serverId: string, messageId: string, status: string) {
    await waitForWs(page);
    return await page.evaluate(async ({ channelId, serverId, messageId, status }) => {
        const key = E2ECrypto.getServerKey(serverId);
        if (!key) return 'no_key';
        ws.send(JSON.stringify({
            type: 'message_ack',
            channel_id: channelId,
            message_id: messageId,
            status: status,
            ack_token: E2ECrypto.hmacHex(key, 'ack-v1:' + messageId),
        }));
        return 'sent';
    }, { channelId, serverId, messageId, status });
}

// Read the rendered status element of one message on a page.
async function msgStatus(page: any, messageId: string) {
    return await page.evaluate((mid) => {
        const el = document.querySelector(`.message[data-message-id="${mid}"] .msg-status`) as HTMLElement | null;
        if (!el) return null;
        return { status: el.getAttribute('data-status'), read: el.classList.contains('read'), text: el.textContent };
    }, messageId);
}

async function enterChannelView(page: any) {
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
    await page.click('.server-icon:not(.add-server)');
    await page.waitForSelector('.channel-item', { timeout: 10000 });
    await page.click('.channel-item >> nth=0');
    await expect(page.locator('#message-input')).toBeEnabled({ timeout: 8000 });
    await waitForWs(page);
}

async function enterDmView(page: any) {
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
    await waitForWs(page);
    await page.click('#dm-strip-btn');
    await page.waitForSelector('.dm-item', { timeout: 8000 });
    await page.click('.dm-item');
    await expect(page.locator('#message-input')).toBeEnabled({ timeout: 8000 });
}

test.describe('Per-message delivery/read status (E2E acks)', () => {

    test('DM: recipient viewing the chat auto-acks delivered then read; sender sees ✓✓ read live', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'msa_' + Date.now();
        const uB = 'msa2_' + Date.now();
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

        // Both users open the DM conversation (B must be viewing to auto-ack).
        await enterDmView(pageA);
        await enterDmView(pageB);

        expect(await sendDmMessageViaWs(pageA, dmChannelId, bodyB.user.id, 'check my read receipt')).toBe('sent');
        // A's own message renders with a status first — either ✓ sent or, if B's
        // delivered ack lands within milliseconds of the render, ✓✓ delivered
        // (B is already viewing the chat). read arrives ~600ms later.
        await pageA.waitForFunction(() => {
            const el = document.querySelector('.message .msg-status') as HTMLElement | null;
            return el && (el.getAttribute('data-status') === 'sent' || el.getAttribute('data-status') === 'delivered');
        }, undefined, { timeout: 8000 });
        const ownMessageId = await pageA.evaluate(() => {
            const el = document.querySelector('.message[data-sender-user-id]') as HTMLElement | null;
            const me = localStorage.getItem('user') ? JSON.parse(localStorage.getItem('user') || '{}').id : null;
            const own = Array.from(document.querySelectorAll('.message[data-sender-user-id]')).find((m) => (m as HTMLElement).getAttribute('data-sender-user-id') === me) as HTMLElement | null;
            return own ? own.getAttribute('data-message-id') : null;
        });
        expect(ownMessageId).toBeTruthy();
        const earlyStatus = await msgStatus(pageA, ownMessageId!);
        expect(['sent', 'delivered']).toContain(earlyStatus.status);
        expect(earlyStatus.read).toBe(false);
        if (earlyStatus.status === 'sent') {
            expect(earlyStatus.text).toBe('✓');
        } else {
            expect(earlyStatus.text).toBe('✓✓');
        }

        // B is viewing → auto-acks delivered + read → A's checkmark upgrades live.
        await pageA.waitForFunction((mid) => {
            const el = document.querySelector(`.message[data-message-id="${mid}"] .msg-status`) as HTMLElement | null;
            return el && el.getAttribute('data-status') === 'read' && el.classList.contains('read');
        }, ownMessageId, { timeout: 10000 });
        expect(await msgStatus(pageA, ownMessageId!)).toEqual({ status: 'read', read: true, text: '✓✓' });

        await ctxA.close();
        await ctxB.close();
    });

    test('DM: explicit delivered → read transitions, and the read state survives a reload', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'msb_' + Date.now();
        const uB = 'msb2_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);
        (pageA as any).token = bodyA.token;
        (pageB as any).token = bodyB.token;

        const codeB = await pageB.evaluate(() => localStorage.getItem('e2e_friend_code'));
        await pageA.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: codeB },
        });
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

        // Only A opens the DM (B stays on the DM list, so no auto-read acks).
        await enterDmView(pageA);
        expect(await sendDmMessageViaWs(pageA, dmChannelId, bodyB.user.id, 'two phase receipt')).toBe('sent');
        await pageA.waitForFunction(() => {
            const el = document.querySelector('.message .msg-status') as HTMLElement | null;
            return el && el.getAttribute('data-status') === 'sent';
        }, undefined, { timeout: 8000 });
        const ownMessageId = await pageA.evaluate(() => {
            const me = localStorage.getItem('user') ? JSON.parse(localStorage.getItem('user') || '{}').id : null;
            const own = Array.from(document.querySelectorAll('.message[data-sender-user-id]')).find((m) => (m as HTMLElement).getAttribute('data-sender-user-id') === me) as HTMLElement | null;
            return own ? own.getAttribute('data-message-id') : null;
        });
        expect(ownMessageId).toBeTruthy();

        // B (on their DM list page — not viewing) acks delivered explicitly.
        await waitForWs(pageB);
        expect(await sendDmAck(pageB, dmChannelId, bodyA.user.id, ownMessageId!, 'delivered')).toBe('sent');
        await pageA.waitForFunction((mid) => {
            const el = document.querySelector(`.message[data-message-id="${mid}"] .msg-status`) as HTMLElement | null;
            return el && el.getAttribute('data-status') === 'delivered';
        }, ownMessageId, { timeout: 10000 });
        expect(await msgStatus(pageA, ownMessageId!)).toEqual({ status: 'delivered', read: false, text: '✓✓' });

        // B acks read → A sees the accent-colored read state.
        expect(await sendDmAck(pageB, dmChannelId, bodyA.user.id, ownMessageId!, 'read')).toBe('sent');
        await pageA.waitForFunction((mid) => {
            const el = document.querySelector(`.message[data-message-id="${mid}"] .msg-status`) as HTMLElement | null;
            return el && el.getAttribute('data-status') === 'read' && el.classList.contains('read');
        }, ownMessageId, { timeout: 10000 });

        // Reload A: the read state must come back from the server-attached acks.
        await enterDmView(pageA);
        await pageA.waitForFunction((mid) => {
            const el = document.querySelector(`.message[data-message-id="${mid}"] .msg-status`) as HTMLElement | null;
            return el && el.getAttribute('data-status') === 'read';
        }, ownMessageId, { timeout: 10000 });

        // Host-safety: the ack row is a blind 64-hex token, never the message id.
        const dbOut = execSync(
            `python3 -c "import sqlite3; con=sqlite3.connect('server/e2e_chat.db'); rows=con.execute('SELECT acker_id, status, ack_token FROM dm_message_acks WHERE message_id=?', ('${ownMessageId}',)).fetchall(); print(len(rows), [r[1] for r in rows], all(len(r[2])==64 and all(c in '0123456789abcdef' for c in r[2]) for r in rows), any(r[2]=='${ownMessageId}' for r in rows))"`,
            { encoding: 'utf-8' }
        ).trim();
        const [nRows, statuses, allTokensHex, tokenIsId] = dbOut.split(' ');
        expect(parseInt(nRows, 10)).toBe(1); // one row per recipient, upgraded not duplicated
        expect(statuses).toBe("['read']");
        expect(allTokensHex).toBe('True');
        expect(tokenIsId).toBe('False');

        await ctxA.close();
        await ctxB.close();
    });

    test('channel: member viewing acks delivered; sender sees ✓✓ (capped, never read)', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'msc_' + Date.now();
        const uB = 'msc2_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);
        (pageB as any).token = bodyB.token;
        const { serverId, channelId, inviteCode } = await createServerAndKey(pageA, bodyA.token, bodyA.user.id);
        await joinServerAndLoadKey(pageA, pageB, bodyA.token, serverId, inviteCode, bodyB.user.id);
        await enterChannelView(pageA);
        await enterChannelView(pageB);

        expect(await sendChannelMessageViaWs(pageA, channelId, serverId, 'status in channel')).toBe('sent');
        await pageA.waitForFunction(() => {
            const el = document.querySelector('.message .msg-status') as HTMLElement | null;
            return el && el.getAttribute('data-status') === 'sent';
        }, undefined, { timeout: 8000 });
        const ownMessageId = await pageA.evaluate(() => {
            const me = localStorage.getItem('user') ? JSON.parse(localStorage.getItem('user') || '{}').id : null;
            const own = Array.from(document.querySelectorAll('.message[data-sender-user-id]')).find((m) => (m as HTMLElement).getAttribute('data-sender-user-id') === me) as HTMLElement | null;
            return own ? own.getAttribute('data-message-id') : null;
        });
        expect(ownMessageId).toBeTruthy();

        // B is viewing the channel → auto delivered ack → A sees ✓✓.
        await pageA.waitForFunction((mid) => {
            const el = document.querySelector(`.message[data-message-id="${mid}"] .msg-status`) as HTMLElement | null;
            return el && el.getAttribute('data-status') === 'delivered';
        }, ownMessageId, { timeout: 10000 });
        expect(await msgStatus(pageA, ownMessageId!)).toEqual({ status: 'delivered', read: false, text: '✓✓' });

        // Even a read ack keeps the channel UI at delivered (read is a DM affordance).
        expect(await sendChannelAck(pageB, channelId, serverId, ownMessageId!, 'read')).toBe('sent');
        await pageA.waitForTimeout(800);
        expect(await msgStatus(pageA, ownMessageId!)).toEqual({ status: 'delivered', read: false, text: '✓✓' });

        await ctxA.close();
        await ctxB.close();
    });

    test('DM: hovering the read status names who read it', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'msf_' + Date.now();
        const uB = 'msf2_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);
        (pageA as any).token = bodyA.token;
        (pageB as any).token = bodyB.token;

        const codeB = await pageB.evaluate(() => localStorage.getItem('e2e_friend_code'));
        await pageA.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: codeB },
        });
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

        await enterDmView(pageA);
        expect(await sendDmMessageViaWs(pageA, dmChannelId, bodyB.user.id, 'who saw this?')).toBe('sent');
        await pageA.waitForFunction(() => {
            const el = document.querySelector('.message .msg-status') as HTMLElement | null;
            return el && el.getAttribute('data-status') !== null;
        }, undefined, { timeout: 8000 });
        const ownMessageId = await pageA.evaluate(() => {
            const me = localStorage.getItem('user') ? JSON.parse(localStorage.getItem('user') || '{}').id : null;
            const own = Array.from(document.querySelectorAll('.message[data-sender-user-id]')).find((m) => (m as HTMLElement).getAttribute('data-sender-user-id') === me) as HTMLElement | null;
            return own ? own.getAttribute('data-message-id') : null;
        });
        expect(ownMessageId).toBeTruthy();

        // Delivered → the glyph names the recipient.
        await waitForWs(pageB);
        expect(await sendDmAck(pageB, dmChannelId, bodyA.user.id, ownMessageId!, 'delivered')).toBe('sent');
        await pageA.waitForFunction((mid) => {
            const el = document.querySelector(`.message[data-message-id="${mid}"] .msg-status`) as HTMLElement | null;
            return el && el.getAttribute('data-status') === 'delivered';
        }, ownMessageId, { timeout: 10000 });
        let tip = await pageA.evaluate((mid) => (document.querySelector(`.message[data-message-id="${mid}"] .msg-status`) as HTMLElement | null)?.getAttribute('data-tooltip') || '', ownMessageId!);
        expect(tip).toBe('Delivered to ' + uB);

        // Read → the label flips to "Read by <name>" (also on the live WS path).
        expect(await sendDmAck(pageB, dmChannelId, bodyA.user.id, ownMessageId!, 'read')).toBe('sent');
        await pageA.waitForFunction((mid) => {
            const el = document.querySelector(`.message[data-message-id="${mid}"] .msg-status`) as HTMLElement | null;
            return el && el.getAttribute('data-status') === 'read';
        }, ownMessageId, { timeout: 10000 });
        tip = await pageA.evaluate((mid) => (document.querySelector(`.message[data-message-id="${mid}"] .msg-status`) as HTMLElement | null)?.getAttribute('data-tooltip') || '', ownMessageId!);
        expect(tip).toBe('Read by ' + uB);

        // Hovering the glyph surfaces the label in the shared hover card.
        await pageA.hover(`.message[data-message-id="${ownMessageId}"] .msg-status`);
        await pageA.waitForSelector('#msg-status-tooltip', { state: 'visible', timeout: 3000 });
        const shown = await pageA.evaluate(() => (document.getElementById('msg-status-tooltip') as HTMLElement | null)?.textContent || '');
        expect(shown).toContain('Read by ' + uB);

        await ctxA.close();
        await ctxB.close();
    });

    test('channel: status tooltip counts members; Display setting switches always/hover/off', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'msg_' + Date.now();
        const uB = 'msg2_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);
        (pageB as any).token = bodyB.token;
        const { serverId, channelId, inviteCode } = await createServerAndKey(pageA, bodyA.token, bodyA.user.id);
        await joinServerAndLoadKey(pageA, pageB, bodyA.token, serverId, inviteCode, bodyB.user.id);
        await enterChannelView(pageA);
        await enterChannelView(pageB);

        expect(await sendChannelMessageViaWs(pageA, channelId, serverId, 'status modes')).toBe('sent');
        await pageA.waitForFunction(() => {
            const el = document.querySelector('.message .msg-status') as HTMLElement | null;
            return el && el.getAttribute('data-status') === 'delivered';
        }, undefined, { timeout: 10000 });
        const ownMessageId = await pageA.evaluate(() => {
            const me = localStorage.getItem('user') ? JSON.parse(localStorage.getItem('user') || '{}').id : null;
            const own = Array.from(document.querySelectorAll('.message[data-sender-user-id]')).find((m) => (m as HTMLElement).getAttribute('data-sender-user-id') === me) as HTMLElement | null;
            return own ? own.getAttribute('data-message-id') : null;
        });
        expect(ownMessageId).toBeTruthy();
        // The glyph carries the acker ids; hovering opens the member-list card
        // with B's avatar + display name resolved from the member cache.
        const ackers = await pageA.evaluate((mid) => (document.querySelector(`.message[data-message-id="${mid}"] .msg-status`) as HTMLElement | null)?.getAttribute('data-ackers') || '', ownMessageId!);
        expect(ackers.split(',')).toContain(bodyB.user.id);
        await pageA.hover(`.message[data-message-id="${ownMessageId}"] .msg-status`);
        await pageA.waitForSelector('#msg-status-tooltip', { state: 'visible', timeout: 3000 });
        const tipText = await pageA.evaluate(() => (document.getElementById('msg-status-tooltip') as HTMLElement | null)?.textContent || '');
        expect(tipText).toContain('Delivered to 1 member');
        expect(tipText).toContain(uB);
        const hasAvatar = await pageA.evaluate(() => !!document.querySelector('#msg-status-tooltip .mst-avatar'));
        expect(hasAvatar).toBe(true);

        const statusDisplay = (mid: string) => pageA.evaluate((m) => {
            const el = document.querySelector(`.message[data-message-id="${m}"] .msg-status`) as HTMLElement | null;
            return el ? getComputedStyle(el).display : '';
        }, mid);

        // Default mode is 'always' → the glyph is visible.
        expect(await pageA.evaluate(() => document.body.classList.contains('show-msg-status-always'))).toBe(true);
        expect(await statusDisplay(ownMessageId!)).toBe('block');

        // Settings → Display → set to Off → hidden immediately.
        await pageA.click('#settings-btn');
        await pageA.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        await pageA.click('.settings-tab[data-tab="display-settings"]');
        await pageA.selectOption('#show-msg-status', 'off');
        expect(await pageA.evaluate(() => document.body.classList.contains('show-msg-status-always'))).toBe(false);
        expect(await statusDisplay(ownMessageId!)).toBe('none');

        // Hover mode → hidden until the message is hovered (close the settings
        // modal first so it no longer covers the message list).
        await pageA.selectOption('#show-msg-status', 'hover');
        expect(await pageA.evaluate(() => document.body.classList.contains('show-msg-status-hover'))).toBe(true);
        expect(await statusDisplay(ownMessageId!)).toBe('none');
        await pageA.click('#close-settings');
        await pageA.hover(`.message[data-message-id="${ownMessageId}"]`);
        await expect.poll(async () => statusDisplay(ownMessageId!)).toBe('block');

        // Back to always → visible again, and the choice persisted.
        await pageA.click('#settings-btn');
        await pageA.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        await pageA.selectOption('#show-msg-status', 'always');
        expect(await statusDisplay(ownMessageId!)).toBe('block');
        expect(await pageA.evaluate(() => localStorage.getItem('show_msg_status'))).toBe('always');

        await ctxA.close();
        await ctxB.close();
    });

    test('non-member ack frames are dropped server-side (no row, no broadcast)', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const ctxC = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const pageC = await ctxC.newPage();
        const uA = 'msd_' + Date.now();
        const uB = 'msd2_' + Date.now();
        const uC = 'msd3_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);
        const bodyC = await registerUser(pageC, uC);
        (pageB as any).token = bodyB.token;
        const { serverId, channelId, inviteCode } = await createServerAndKey(pageA, bodyA.token, bodyA.user.id);
        await joinServerAndLoadKey(pageA, pageB, bodyA.token, serverId, inviteCode, bodyB.user.id);
        await enterChannelView(pageA);
        await enterChannelView(pageB);

        expect(await sendChannelMessageViaWs(pageA, channelId, serverId, 'protected receipt')).toBe('sent');
        await pageA.waitForFunction(() => {
            const el = document.querySelector('.message .msg-status') as HTMLElement | null;
            return el && el.getAttribute('data-status') === 'sent';
        }, undefined, { timeout: 8000 });
        const ownMessageId = await pageA.evaluate(() => {
            const me = localStorage.getItem('user') ? JSON.parse(localStorage.getItem('user') || '{}').id : null;
            const own = Array.from(document.querySelectorAll('.message[data-sender-user-id]')).find((m) => (m as HTMLElement).getAttribute('data-sender-user-id') === me) as HTMLElement | null;
            return own ? own.getAttribute('data-message-id') : null;
        });
        expect(ownMessageId).toBeTruthy();

        // C is not a member — its ack frame (valid-looking token) must be dropped
        // before it touches the DB or reaches the author.
        await waitForWs(pageC);
        await pageC.evaluate(async ({ channelId, serverId, messageId }) => {
            ws.send(JSON.stringify({
                type: 'message_ack',
                channel_id: channelId,
                message_id: messageId,
                status: 'read',
                ack_token: 'f'.repeat(64),
            }));
            return 'sent';
        }, { channelId, serverId, messageId: ownMessageId });
        await pageA.waitForTimeout(1000);

        // The DB has NO ack row from C on this message (B's legitimate acks
        // from viewing the channel are fine — they are not C).
        const dbOut = execSync(
            `python3 -c "import sqlite3; con=sqlite3.connect('server/e2e_chat.db'); rows=con.execute('SELECT acker_id FROM message_acks WHERE message_id=? AND acker_id=?', ('${ownMessageId}', '${bodyC.user.id}')).fetchall(); print(len(rows))"`,
            { encoding: 'utf-8' }
        ).trim();
        expect(dbOut).toBe('0');
        // And the only ack rows on the message are from members (B).
        const allRows = execSync(
            `python3 -c "import sqlite3; con=sqlite3.connect('server/e2e_chat.db'); rows=con.execute('SELECT acker_id, status FROM message_acks WHERE message_id=?', ('${ownMessageId}',)).fetchall(); print(sorted([(r[0], r[1]) for r in rows]))"`,
            { encoding: 'utf-8' }
        ).trim();
        expect(allRows).toContain(bodyB.user.id);
        expect(allRows).not.toContain(bodyC.user.id);

        await ctxA.close();
        await ctxB.close();
        await ctxC.close();
    });
});
