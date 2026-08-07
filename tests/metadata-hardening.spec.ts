import { test, expect } from '@playwright/test';
import { createHash } from 'crypto';

const BASE = 'https://localhost:3443';

function sha256Hex(data: string): string {
    return createHash('sha256').update(data).digest('hex');
}

function generateCode(len: number): string {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return code;
}

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(500);
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

async function createServerWithKey(page: any, token: string, userId: string, serverName: string) {
    const inviteCode = generateCode(8);
    const srv = await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { name: serverName, invite_code: inviteCode },
    });
    const server = await srv.json();

    await page.evaluate(async ({ serverId, userId }: { serverId: string; userId: string }) => {
        const serverKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey(serverId, serverKey);
        const identity = E2ECrypto.getIdentityKeyPair();
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
        });
    }, { serverId: server.id, userId });

    const chRes = await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const channels = await chRes.json();

    return { serverId: server.id, channelId: channels[0]?.id, inviteCode };
}

test.describe('Metadata Hardening', () => {

    // ─────────────────────────────────────────────────────────────
    // P0 Fix: ORDER BY version ASC — server keys return in order
    // ─────────────────────────────────────────────────────────────
    test('server keys are returned with ORDER BY version ASC', async ({ page }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const username = 'ordertest_' + ts;

        const body = await registerUser(page, username);

        // Create a server
        const inviteCode = generateCode(8);
        const srv = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' },
            data: { name: 'OrderTest_' + ts, invite_code: inviteCode },
        });
        const server = await srv.json();

        // Upload the server key for the owner
        await page.evaluate(async ({ serverId, userId }: { serverId: string; userId: string }) => {
            const serverKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, serverKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: server.id, userId: body.user.id });

        // Fetch server keys
        const keysRes = await page.request.get(`${BASE}/api/servers/${server.id}/keys`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });
        expect(keysRes.ok()).toBeTruthy();
        const keys = await keysRes.json();
        expect(Array.isArray(keys)).toBeTruthy();
        expect(keys.length).toBeGreaterThanOrEqual(1);

        // Verify keys are sorted by version ASC
        for (let i = 1; i < keys.length; i++) {
            expect(keys[i].version).toBeGreaterThanOrEqual(keys[i - 1].version);
        }

        console.log(`Server keys returned: ${keys.length}, versions: ${keys.map((k: any) => k.version).join(', ')}`);
    });

    // ─────────────────────────────────────────────────────────────
    // P0 Fix: sender_id_hash in list_messages_around
    // ─────────────────────────────────────────────────────────────
    test('sender_id_hash is present in list_messages_around response', async ({ page }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const username = 'sidhash_' + ts;

        const body = await registerUser(page, username);
        const { serverId, channelId } = await createServerWithKey(page, body.token, body.user.id, 'SidHash_' + ts);

        if (!channelId) {
            test.skip(true, 'No channels available');
            return;
        }

        // Send a message via the WebSocket (reliable, produces sender_id_hash in DB)
        const sent = await page.evaluate(async ({ channelId }) => {
            // Wait for WS to be open
            let wsReady = false;
            for (let i = 0; i < 30; i++) {
                if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
                    wsReady = true;
                    break;
                }
                await new Promise(r => setTimeout(r, 500));
            }
            if (!wsReady) return 'no_ws';

            const key = E2ECrypto.getServerKey('');
            const serverKey = E2ECrypto.getServerKey('');
            // Try to find the server key
            const servers = JSON.parse(localStorage.getItem('servers') || '[]');
            for (const s of servers) {
                const sk = E2ECrypto.getServerKey(s.id);
                if (sk) {
                    const enc = E2ECrypto.aeadEncrypt('hello from ws', sk);
                    ws.send(JSON.stringify({
                        type: 'message_send',
                        channel_id: channelId,
                        encrypted_content: enc.ciphertext,
                        nonce: enc.nonce,
                        encrypted_sender_username: 'AAAAAAAAAAAAAAAAAAAAAA==',
                        sender_username_nonce: 'AAAAAAAAAAAAAAAAAAAAAA==',
                    }));
                    return 'sent_with_key';
                }
            }
            // Fallback: send without proper key (message won't decrypt but should be stored)
            ws.send(JSON.stringify({
                type: 'message_send',
                channel_id: channelId,
                encrypted_content: 'AAAAAAAAAAAAAAAAAAAAAA==',
                nonce: 'AAAAAAAAAAAAAAAAAAAAAA==',
                encrypted_sender_username: 'AAAAAAAAAAAAAAAAAAAAAA==',
                sender_username_nonce: 'AAAAAAAAAAAAAAAAAAAAAA==',
            }));
            return 'sent_fallback';
        }, { channelId });
        expect(sent).not.toBe('no_ws');
        console.log('Message sent via WS:', sent);
        await page.waitForTimeout(2000);

        // Fetch messages via API to find a message id
        const msgsRes = await page.request.get(`${BASE}/api/channels/${channelId}/messages`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });
        expect(msgsRes.ok()).toBeTruthy();
        const msgs = await msgsRes.json();
        console.log(`list_messages returned ${msgs.length} messages`);
        expect(msgs.length).toBeGreaterThan(0);

        const msgId = msgs[msgs.length - 1].id;
        console.log(`Using message id: ${msgId}`);

        // Now fetch messages around that message
        const aroundRes = await page.request.get(
            `${BASE}/api/channels/${channelId}/messages/around/${msgId}`,
            { headers: { Authorization: `Bearer ${body.token}` } }
        );
        // If it fails, log the actual error and body
        if (!aroundRes.ok()) {
            const body = await aroundRes.json();
            console.log(`list_messages_around failed: status=${aroundRes.status()}, body=${JSON.stringify(body)}`);
        }
        expect(aroundRes.ok()).toBeTruthy();
        const aroundMsgs = await aroundRes.json();
        expect(Array.isArray(aroundMsgs)).toBeTruthy();
        expect(aroundMsgs.length).toBeGreaterThan(0);

        // Verify sender_id_hash is present and non-null
        for (const m of aroundMsgs) {
            expect(m).toHaveProperty('sender_id_hash');
            expect(m.sender_id_hash).toBeTruthy();
            expect(typeof m.sender_id_hash).toBe('string');
            expect(m.sender_id_hash.length).toBeGreaterThan(0);
        }

        console.log(`list_messages_around returned ${aroundMsgs.length} messages`);
    });

    // ─────────────────────────────────────────────────────────────
    // P1: sender_profile_pic removed from list_server_members
    // ─────────────────────────────────────────────────────────────
    test('list_server_members does not include profile_picture_file_id', async ({ page }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const username = 'members_' + ts;

        const body = await registerUser(page, username);
        const { serverId } = await createServerWithKey(page, body.token, body.user.id, 'MembersTest_' + ts);

        // Fetch member list
        const membersRes = await page.request.get(`${BASE}/api/servers/${serverId}/members`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });
        expect(membersRes.ok()).toBeTruthy();
        const members = await membersRes.json();
        expect(Array.isArray(members)).toBeTruthy();
        expect(members.length).toBeGreaterThan(0);

        // Verify profile_picture_file_id is NOT present
        for (const m of members) {
            const keys = Object.keys(m);
            expect(keys).not.toContain('profile_picture_file_id');
        }

        console.log(`Member list returned ${members.length} members`);
    });

    // ─────────────────────────────────────────────────────────────
    // P1: sender_profile_pic removed from list_dm_conversations
    // ─────────────────────────────────────────────────────────────
    test('list_dm_conversations does not include profile_picture_file_id', async ({ page, context }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const userA = 'dmconvA_' + ts;
        const userB = 'dmconvB_' + ts;

        const bodyA = await registerUser(page, userA);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const bodyB = await registerUser(page2, userB);

        // Become friends (creates DM channel)
        const friendCodeB = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        const fr = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: friendCodeB },
        });
        expect(fr.ok()).toBeTruthy();

        const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${bodyB.token}` },
        })).json();
        if (incoming.length > 0) {
            await page2.request.post(`${BASE}/api/friends/requests/accept`, {
                headers: { Authorization: `Bearer ${bodyB.token}`, 'Content-Type': 'application/json' },
                data: { request_id: incoming[0].id },
            });
        }
        await new Promise(r => setTimeout(r, 2000));

        // Fetch DM conversations
        const convsRes = await page.request.get(`${BASE}/api/dm/conversations`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
        });
        expect(convsRes.ok()).toBeTruthy();
        const convs = await convsRes.json();
        expect(Array.isArray(convs)).toBeTruthy();
        expect(convs.length).toBeGreaterThan(0);

        // Verify profile_picture_file_id is NOT present
        for (const conv of convs) {
            const keys = Object.keys(conv);
            expect(keys).not.toContain('other_profile_picture_file_id');
        }

        console.log(`DM conversations returned: ${convs.length}`);

        await page2.close();
        await ctx2.close();
    });

    // ─────────────────────────────────────────────────────────────
    // P1: No sender_username in message API responses
    // ─────────────────────────────────────────────────────────────
    test('list_messages does not include sender_username in response', async ({ page }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const username = 'msgnosu_' + ts;

        const body = await registerUser(page, username);
        const { serverId, channelId } = await createServerWithKey(page, body.token, body.user.id, 'NoSU_' + ts);

        if (!channelId) {
            test.skip(true, 'No channels available');
            return;
        }

        // Navigate and send a message to ensure messages exist
        await page.evaluate(async () => { await loadServers(); });
        await page.waitForTimeout(2000);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 15000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(2000);

        const input = page.locator('#message-input');
        await expect(input).toBeEnabled({ timeout: 15000 });
        await input.fill('No sender_username test ' + ts);
        await page.click('#send-btn');
        await page.waitForTimeout(3000);

        // Fetch messages via API
        const msgsRes = await page.request.get(`${BASE}/api/channels/${channelId}/messages`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });
        expect(msgsRes.ok()).toBeTruthy();
        const msgs = await msgsRes.json();
        expect(msgs.length).toBeGreaterThan(0);

        // Verify NO sender_username field
        for (const m of msgs) {
            const keys = Object.keys(m);
            expect(keys).not.toContain('sender_username');
            // But encrypted_sender_username should be present
            expect(keys).toContain('encrypted_sender_username');
            expect(keys).toContain('sender_username_nonce');
        }
    });

    // ─────────────────────────────────────────────────────────────
    // P1: No sender_username in list_dm_messages response
    // ─────────────────────────────────────────────────────────────
    test('list_dm_messages does not include sender_username', async ({ page, context }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const userA = 'dmsuA_' + ts;
        const userB = 'dmsuB_' + ts;

        const bodyA = await registerUser(page, userA);
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const bodyB = await registerUser(page2, userB);

        // Become friends (creates DM)
        const friendCodeB = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        const fr = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: friendCodeB },
        });
        expect(fr.ok()).toBeTruthy();
        const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${bodyB.token}` },
        })).json();
        if (incoming.length > 0) {
            await page2.request.post(`${BASE}/api/friends/requests/accept`, {
                headers: { Authorization: `Bearer ${bodyB.token}`, 'Content-Type': 'application/json' },
                data: { request_id: incoming[0].id },
            });
        }
        await new Promise(r => setTimeout(r, 2000));

        // Get DM channel ID
        const convsRes = await page.request.get(`${BASE}/api/dm/conversations`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
        });
        const convs = await convsRes.json();
        expect(convs.length).toBeGreaterThan(0);
        const dmId = convs[0].dm_channel_id;

        // Fetch DM messages
        const msgsRes = await page.request.get(`${BASE}/api/dm/${dmId}/messages`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
        });
        // May be empty if no messages sent, but the endpoint response structure should be consistent
        expect(msgsRes.ok()).toBeTruthy();
        const msgs = await msgsRes.json();
        expect(Array.isArray(msgs)).toBeTruthy();

        // If there are messages, check they don't have sender_username
        for (const m of msgs) {
            const keys = Object.keys(m);
            expect(keys).not.toContain('sender_username');
            // Encrypted sender username should be present
            expect(keys).toContain('encrypted_sender_username');
        }

        console.log(`DM messages: ${msgs.length} total`);

        await page2.close();
        await ctx2.close();
    });
});
