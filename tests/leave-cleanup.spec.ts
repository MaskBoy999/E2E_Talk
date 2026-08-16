import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

const BASE = 'https://localhost:3443';
const DB = 'server/e2e_chat.db';

function dbQuery(sql: string, args: any[] = []): any[] {
    const json = JSON.stringify(args).replace(/'/g, "''");
    const script = `import sqlite3,sys,json;con=sqlite3.connect(${JSON.stringify(DB)});cur=con.cursor();cur.execute(${JSON.stringify(sql)},json.loads('${json}'));print(json.dumps(cur.fetchall()))`;
    const out = execSync(`python3 -c ${JSON.stringify(script)}`, { encoding: 'utf8' }).trim();
    return JSON.parse(out);
}
function dbExec(sql: string, args: any[] = []): void {
    const json = JSON.stringify(args).replace(/'/g, "''");
    const script = `import sqlite3,json;con=sqlite3.connect(${JSON.stringify(DB)});cur=con.cursor();cur.execute(${JSON.stringify(sql)},json.loads('${json}'));con.commit()`;
    execSync(`python3 -c ${JSON.stringify(script)}`, { encoding: 'utf8' });
}

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
            encName: E2ECrypto.encryptMessage('Leave Cleanup Server', key),
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

async function enterChannelView(page: any) {
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
    await page.click('.server-icon:not(.add-server)');
    await page.waitForSelector('.channel-item', { timeout: 10000 });
    await page.click('.channel-item >> nth=0');
    await expect(page.locator('#message-input')).toBeEnabled({ timeout: 8000 });
    await waitForWs(page);
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

// Grab the message id of the last message rendered on a page.
async function lastMessageId(page: any) {
    return await page.evaluate(() => {
        const els = document.querySelectorAll('.message[data-message-id]');
        const el = els[els.length - 1] as HTMLElement | null;
        return el ? el.getAttribute('data-message-id') : null;
    });
}

async function sendChannelReaction(page: any, channelId: string, serverId: string, messageId: string, canonical: string) {
    await waitForWs(page);
    return await page.evaluate(async ({ channelId, serverId, messageId, canonical }) => {
        const key = E2ECrypto.getServerKey(serverId);
        if (!key) return 'no_key';
        const payload = { e: canonical };
        const enc = E2ECrypto.encryptMessage(JSON.stringify(payload), key);
        const token = E2ECrypto.hmacHex(key, 'reaction-v1:' + canonical);
        ws.send(JSON.stringify({
            type: 'message_reaction',
            channel_id: channelId,
            message_id: messageId,
            emoji_token: token,
            encrypted_emoji: enc.ciphertext,
            emoji_nonce: enc.nonce,
        }));
        return 'sent';
    }, { channelId, serverId, messageId, canonical });
}

async function sendChannelPollVote(page: any, channelId: string, serverId: string, messageId: string, optionId: string) {
    await waitForWs(page);
    return await page.evaluate(async ({ channelId, serverId, messageId, optionId }) => {
        const key = E2ECrypto.getServerKey(serverId);
        if (!key) return 'no_key';
        const token = E2ECrypto.hmacHex(key, 'poll-v1:' + optionId);
        ws.send(JSON.stringify({
            type: 'poll_vote',
            channel_id: channelId,
            message_id: messageId,
            option_token: token,
            remove_option_tokens: [],
        }));
        return 'sent';
    }, { channelId, serverId, messageId, optionId });
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

test.describe('Server-leave data wipe', () => {

    test('willingly leaving wipes the leaver: reactions, poll votes, read acks, pins, messages, profile, keys', async ({ browser }) => {
        test.setTimeout(120000);
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'lv_' + Date.now();
        const uB = 'lv2_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);
        (pageB as any).token = bodyB.token;
        const { serverId, channelId, inviteCode } = await createServerAndKey(pageA, bodyA.token, bodyA.user.id);
        await joinServerAndLoadKey(pageA, pageB, bodyA.token, serverId, inviteCode, bodyB.user.id);
        await enterChannelView(pageA);
        await enterChannelView(pageB);

        // A posts a plain message; B reacts to it, acks it read, and pins it.
        expect(await sendChannelMessageViaWs(pageA, channelId, serverId, 'seed text from A')).toBe('sent');
        await pageA.waitForSelector('.message', { timeout: 8000 });
        const aTextMsgId = await lastMessageId(pageA);
        expect(aTextMsgId).toBeTruthy();
        await pageB.waitForSelector('.message', { timeout: 8000 });
        expect(await sendChannelReaction(pageB, channelId, serverId, aTextMsgId!, '👍')).toBe('sent');
        expect(await sendChannelAck(pageB, channelId, serverId, aTextMsgId!, 'read')).toBe('sent');
        dbExec("INSERT OR IGNORE INTO message_pins (channel_id, message_id, pinned_by) VALUES (?1,?2,?3)", [channelId, aTextMsgId, bodyB.user.id]);

        // A posts a poll; B votes in it.
        await pageA.evaluate(async ({ channelId, serverId }) => {
            const key = E2ECrypto.getServerKey(serverId);
            const stamp = Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
            const options = [{ id: 'opt-' + stamp + '-0', text: 'Yes' }, { id: 'opt-' + stamp + '-1', text: 'No' }];
            const payload = { type: 'poll', question: 'stay or go?', options, multiple: false };
            const enc = E2ECrypto.encryptMessage(JSON.stringify(payload), key);
            ws.send(JSON.stringify({
                type: 'message_send',
                channel_id: channelId,
                encrypted_content: enc.ciphertext,
                nonce: enc.nonce,
                message_nonce: enc.messageNonce || null,
            }));
            return options;
        }, { channelId, serverId });
        await pageA.waitForSelector('.poll-card', { timeout: 8000 });
        const pollId = await pageA.evaluate(() => {
            const el = document.querySelector('.poll-card') as HTMLElement | null;
            return el ? (el.closest('.message') as HTMLElement | null)?.getAttribute('data-message-id') : null;
        });
        expect(pollId).toBeTruthy();
        await pageB.waitForSelector('.poll-card', { timeout: 8000 });
        const pollOpt = await pageB.evaluate(() => {
            const card = document.querySelector('.poll-card') as HTMLElement | null;
            const opt = card?.querySelector('.poll-option') as HTMLElement | null;
            return opt ? opt.getAttribute('data-option-id') : null;
        });
        expect(pollOpt).toBeTruthy();
        expect(await sendChannelPollVote(pageB, channelId, serverId, pollId!, pollOpt!)).toBe('sent');
        await pageB.waitForTimeout(600);

        // B posts their own message in the server.
        expect(await sendChannelMessageViaWs(pageB, channelId, serverId, 'B leaving soon')).toBe('sent');
        await pageB.waitForTimeout(600);

        // B uploads a per-server profile snapshot (conversation_type='channel', conversation_id=serverId).
        const profilePut = await pageB.request.put(`${BASE}/api/profile/conversation`, {
            headers: { Authorization: `Bearer ${bodyB.token}`, 'Content-Type': 'application/json' },
            data: { conversation_type: 'channel', conversation_id: serverId, encrypted_profile_data: 'x', nonce: 'x' },
        });
        expect(profilePut.ok()).toBe(true);

        // Confirm every row exists BEFORE leaving. (B's client auto-acks both of
        // A's messages while viewing, so the ack count is 2, not 1.)
        expect(dbQuery("SELECT COUNT(*) FROM message_reactions WHERE reactor_id = ?1", [bodyB.user.id])[0][0]).toBe(1);
        expect(dbQuery("SELECT COUNT(*) FROM message_poll_votes WHERE voter_id = ?1", [bodyB.user.id])[0][0]).toBe(1);
        expect(dbQuery("SELECT COUNT(*) FROM message_acks WHERE acker_id = ?1", [bodyB.user.id])[0][0]).toBeGreaterThanOrEqual(1);
        expect(dbQuery("SELECT COUNT(*) FROM message_pins WHERE pinned_by = ?1", [bodyB.user.id])[0][0]).toBe(1);
        expect(dbQuery("SELECT COUNT(*) FROM messages WHERE sender_id = ?1", [bodyB.user.id])[0][0]).toBe(1);
        expect(dbQuery("SELECT COUNT(*) FROM conversation_profile_data WHERE user_id = ?1 AND conversation_type = 'channel' AND conversation_id = ?2", [bodyB.user.id, serverId])[0][0]).toBe(1);

        // B leaves the server.
        const leave = await pageB.request.post(`${BASE}/api/servers/${serverId}/leave`, {
            headers: { Authorization: `Bearer ${bodyB.token}` },
        });
        expect(leave.status()).toBe(200);
        const leaveBody = await leave.json();
        expect(leaveBody.server_deleted).toBe(false);

        // Every trace of B in the server is gone; A's messages survive untouched.
        const checks: [string, string, any[]][] = [
            ['message_reactions', 'reactor_id = ?1 AND message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?2))', [bodyB.user.id, serverId]],
            ['message_poll_votes', 'voter_id = ?1 AND message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?2))', [bodyB.user.id, serverId]],
            ['message_acks', 'acker_id = ?1 AND message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?2))', [bodyB.user.id, serverId]],
            ['message_pins', 'pinned_by = ?1 AND message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?2))', [bodyB.user.id, serverId]],
            ['messages', 'sender_id = ?1 AND channel_id IN (SELECT id FROM channels WHERE server_id = ?2)', [bodyB.user.id, serverId]],
            ['server_members', 'server_id = ?1 AND user_id = ?2', [serverId, bodyB.user.id]],
            ['server_keys', 'server_id = ?1 AND user_id = ?2', [serverId, bodyB.user.id]],
            ['conversation_profile_data', "user_id = ?1 AND conversation_type = 'channel' AND conversation_id = ?2", [bodyB.user.id, serverId]],
        ];
        for (const [table, where, args] of checks) {
            const n = dbQuery(`SELECT COUNT(*) FROM ${table} WHERE ${where}`, args)[0][0] as number;
            expect(n, `${table} still references the leaver`).toBe(0);
        }
        // A's message that B reacted to still exists.
        expect(dbQuery("SELECT COUNT(*) FROM messages WHERE id = ?1", [aTextMsgId!])[0][0]).toBe(1);
        // A is still a member; B is not.
        expect(dbQuery("SELECT COUNT(*) FROM server_members WHERE server_id = ?1 AND user_id = ?2", [serverId, bodyA.user.id])[0][0]).toBe(1);

        await ctxA.close();
        await ctxB.close();
    });

    test('owner leaving deletes the whole server including tables with no FK to it', async ({ browser }) => {
        test.setTimeout(120000);
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'lv3_' + Date.now();
        const uB = 'lv4_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);
        (pageB as any).token = bodyB.token;
        const { serverId, channelId, inviteCode } = await createServerAndKey(pageA, bodyA.token, bodyA.user.id);
        await joinServerAndLoadKey(pageA, pageB, bodyA.token, serverId, inviteCode, bodyB.user.id);

        // Seed rows that have NO foreign key to servers (they used to leak):
        // per-server profile snapshots, pending events, voice sanctions.
        dbExec("INSERT OR IGNORE INTO conversation_profile_data (user_id, conversation_type, conversation_id, encrypted_profile_data, nonce) VALUES (?1,'channel',?2,'x','x')", [bodyB.user.id, serverId]);
        dbExec("INSERT OR IGNORE INTO conversation_profile_data (user_id, conversation_type, conversation_id, encrypted_profile_data, nonce) VALUES (?1,'channel',?2,'x','x')", [bodyB.user.id, channelId]);
        dbExec("INSERT OR IGNORE INTO pending_events (user_id, server_id, event_type, affected_user_id) VALUES (?1,?2,'member_left',?1)", [bodyB.user.id, serverId]);
        dbExec("INSERT OR IGNORE INTO voice_sanctions (server_id, user_id) VALUES (?1,?2)", [serverId, bodyB.user.id]);

        // Owner leaves → the whole server (and those rows) must disappear.
        const leave = await pageA.request.post(`${BASE}/api/servers/${serverId}/leave`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
        });
        expect(leave.status()).toBe(200);
        const leaveBody = await leave.json();
        expect(leaveBody.server_deleted).toBe(true);

        expect(dbQuery("SELECT COUNT(*) FROM servers WHERE id = ?1", [serverId])[0][0]).toBe(0);
        expect(dbQuery("SELECT COUNT(*) FROM channels WHERE server_id = ?1", [serverId])[0][0]).toBe(0);
        expect(dbQuery("SELECT COUNT(*) FROM conversation_profile_data WHERE conversation_type = 'channel' AND (conversation_id = ?1 OR conversation_id = ?2)", [serverId, channelId])[0][0]).toBe(0);
        expect(dbQuery("SELECT COUNT(*) FROM pending_events WHERE server_id = ?1", [serverId])[0][0]).toBe(0);
        expect(dbQuery("SELECT COUNT(*) FROM voice_sanctions WHERE server_id = ?1", [serverId])[0][0]).toBe(0);
        expect(dbQuery("SELECT COUNT(*) FROM server_members WHERE server_id = ?1", [serverId])[0][0]).toBe(0);

        await ctxA.close();
        await ctxB.close();
    });
});
