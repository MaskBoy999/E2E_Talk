import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('Shared keys + sender_username regression — full stack', () => {

    // ─── Helpers ──────────────────────────────────────────────────

    async function registerUser(page: any, username: string) {
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await page.waitForLoadState('networkidle');
        return await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
            friendCode: localStorage.getItem('e2e_friend_code'),
        }));
    }

    async function waitForWs(page: any, maxRetries = 60) {
        return await page.evaluate((maxRetries) => {
            return new Promise((resolve) => {
                let tries = 0;
                const check = () => {
                    tries++;
                    if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
                        resolve(true);
                    } else if (tries >= maxRetries) {
                        resolve(false);
                    } else {
                        setTimeout(check, 200);
                    }
                };
                setTimeout(check, 500);
            });
        }, maxRetries);
    }

    async function becomeFriends(page1: any, page2: any, token1: string, token2: string) {
        const friendCode2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        const fr = await page1.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
            data: { friend_code: friendCode2 },
        });
        expect(fr.ok()).toBeTruthy();

        // Wait for friend request to appear on page2
        for (let i = 0; i < 40; i++) {
            const hasReq = await page2.evaluate(() => {
                const badge = document.getElementById('friend-request-badge');
                return badge && badge.style.display !== 'none';
            });
            if (hasReq) break;
            await new Promise(r => setTimeout(r, 500));
        }

        await page2.evaluate(() => {
            const btns = document.querySelectorAll('.friend-request-item .accept-btn');
            if (btns.length > 0) (btns[0] as HTMLElement).click();
        });
        await new Promise(r => setTimeout(r, 3000));
    }

    async function createServerViaPage(page: any, token: string) {
        // Use the page's own createServer flow so the server key is generated and uploaded
        return await page.evaluate(async (token) => {
            const inviteCode = 'INVITE_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
            const channelKey = E2ECrypto.generateSymmetricKey();
            const nameStr = 'TestServer';
            const encName = E2ECrypto.aeadEncrypt(nameStr, channelKey);
            const encChName = E2ECrypto.aeadEncrypt('General', channelKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            if (!identity) return null;
            const encrypted = E2ECrypto.envelopeEncrypt(channelKey, identity.publicKey, identity.privateKey);
            const res = await authFetch('/api/servers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    invite_code_hash: inviteCode,
                    encrypted_name: E2ECrypto.arrayBufferToBase64(encName.ciphertext),
                    name_nonce: E2ECrypto.arrayBufferToBase64(encName.nonce),
                    channel_encrypted_name: E2ECrypto.arrayBufferToBase64(encChName.ciphertext),
                    channel_name_nonce: E2ECrypto.arrayBufferToBase64(encChName.nonce),
                }),
            });
            if (!res.ok) return null;
            const serverData = await res.json();
            E2ECrypto.saveServerKey(serverData.id, channelKey);
            // Upload the server key for other members
            await authFetch('/api/servers/' + serverData.id + '/keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: user.id,
                    encrypted_key: E2ECrypto.arrayBufferToBase64(encrypted.ciphertext),
                    sender_public_key: E2ECrypto.arrayBufferToBase64(encrypted.senderPublicKey),
                    nonce: E2ECrypto.arrayBufferToBase64(encrypted.nonce),
                }),
            });
            return { id: serverData.id, invite_code: inviteCode };
        }, token);
    }

    async function sendMessageViaWs(page: any, channelId: string) {
        return await page.evaluate(async ({ channelId }) => {
            if (typeof ws === 'undefined' || !ws || ws.readyState !== WebSocket.OPEN) {
                return 'no_ws';
            }
            ws.send(JSON.stringify({
                type: 'message_send',
                channel_id: channelId,
                encrypted_content: 'AAAAAAAAAAAAAAAAAAAAAA==',
                nonce: 'AAAAAAAAAAAAAAAAAAAAAA==',
                encrypted_sender_username: 'AAAAAAAAAAAAAAAAAAAAAA==',
                sender_username_nonce: 'AAAAAAAAAAAAAAAAAAAAAA==',
            }));
            return 'sent';
        }, { channelId });
    }

    // ─── Tests ────────────────────────────────────────────────────

    test('01 — Shared key: uploaded after DM + retrievable via individual GET', async ({ page, context }) => {
        const ts = Date.now() + Math.floor(Math.random() * 10000);
        const userA = 'shkA' + ts;
        const userB = 'shkB' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const ua = await registerUser(page, userA);
        const ub = await registerUser(page2, userB);
        expect(ua.token).toBeTruthy();
        expect(ub.token).toBeTruthy();

        await waitForWs(page);
        await waitForWs(page2);

        // Become friends — triggers DM creation, which calls uploadSharedProfileDataKey
        await becomeFriends(page, page2, ua.token, ub.token);
        // Extra wait for the fire-and-forget uploadSharedProfileDataKey to complete
        await new Promise(r => setTimeout(r, 3000));

        // Get the DM channel ID from userA's page
        const dmConvId = await page.evaluate(() => {
            if (!dmConversations || dmConversations.length === 0) return null;
            return dmConversations[0].dm_channel_id;
        });
        expect(dmConvId).toBeTruthy();

        // Fetch the shared key for this DM channel via the individual GET endpoint
        const fetchRes = await page.request.get(
            `${BASE}/api/profile/data-key/shared/dm_channel/${dmConvId}`,
            { headers: { Authorization: `Bearer ${ua.token}` } }
        );
        expect(fetchRes.ok()).toBeTruthy();
        const keys = await fetchRes.json();
        // The shared key should have been uploaded by userA and/or userB
        expect(Array.isArray(keys)).toBeTruthy();
        expect(keys.length).toBeGreaterThan(0);

        // Each entry must have owner_user_id, encrypted_key, nonce
        for (const entry of keys) {
            expect(entry).toHaveProperty('owner_user_id');
            expect(entry).toHaveProperty('encrypted_key');
            expect(entry).toHaveProperty('nonce');
            expect(typeof entry.owner_user_id).toBe('string');
            expect(typeof entry.encrypted_key).toBe('string');
            expect(typeof entry.nonce).toBe('string');
            expect(entry.owner_user_id.length).toBeGreaterThan(0);
        }

        await ctx2.close();
    });

    test('02 — Batch endpoint returns keys for all DMs and servers', async ({ page, context }) => {
        const ts = Date.now() + Math.floor(Math.random() * 10000);
        const userA = 'batA' + ts;
        const userB = 'batB' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const ua = await registerUser(page, userA);
        const ub = await registerUser(page2, userB);
        expect(ua.token).toBeTruthy();

        await waitForWs(page);
        await waitForWs(page2);

        // Become friends — triggers DM creation and uploadSharedProfileDataKey
        await becomeFriends(page, page2, ua.token, ub.token);
        await new Promise(r => setTimeout(r, 3000));

        // Get the DM channel ID
        const dmConvId = await page.evaluate(() => {
            if (!dmConversations || dmConversations.length === 0) return null;
            return dmConversations[0].dm_channel_id;
        });
        expect(dmConvId).toBeTruthy();

        // Wait a moment for the upload to complete (fire-and-forget)
        await new Promise(r => setTimeout(r, 2000));

        // Call batch endpoint with the DM channel
        const batchRes = await page.request.post(
            `${BASE}/api/profile/data-key/shared/batch`,
            {
                headers: { Authorization: `Bearer ${ua.token}`, 'Content-Type': 'application/json' },
                data: {
                    targets: [
                        { target_type: 'dm_channel', target_id: dmConvId },
                    ],
                },
            }
        );
        expect(batchRes.ok()).toBeTruthy();
        const batchData = await batchRes.json();
        expect(typeof batchData).toBe('object');

        const dmKey = 'dm_channel:' + dmConvId;
        expect(batchData).toHaveProperty(dmKey);
        expect(Array.isArray(batchData[dmKey])).toBeTruthy();
        expect(batchData[dmKey].length).toBeGreaterThan(0);

        // Verify the batch response has the correct structure
        for (const entry of batchData[dmKey]) {
            expect(entry).toHaveProperty('owner_user_id');
            expect(entry).toHaveProperty('encrypted_key');
            expect(entry).toHaveProperty('nonce');
        }

        await ctx2.close();
    });

    test('03 — No plaintext sender_username in message API responses', async ({ page, context: _ctx }) => {
        const ts = Date.now() + Math.floor(Math.random() * 10000);
        const userA = 'secA' + ts;

        // Register user
        const ua = await registerUser(page, userA);
        expect(ua.token).toBeTruthy();
        await waitForWs(page);

        // Create a server via the page's createServer flow (handles key generation + upload)
        const server = await createServerViaPage(page, ua.token);
        expect(server).toBeTruthy();

        // Get channel ID
        const channelsRes = await page.request.get(
            `${BASE}/api/servers/${server.id}/channels`,
            { headers: { Authorization: `Bearer ${ua.token}` } }
        );
        expect(channelsRes.ok()).toBeTruthy();
        const channels = await channelsRes.json();
        expect(channels.length).toBeGreaterThan(0);
        const channelId = channels[0].id;

        // Send a message via WS
        const sent = await sendMessageViaWs(page, channelId);
        expect(sent).toBe('sent');
        await new Promise(r => setTimeout(r, 2000));

        // Fetch messages via API — verify NO sender_username field
        const msgsRes = await page.request.get(
            `${BASE}/api/channels/${channelId}/messages`,
            { headers: { Authorization: `Bearer ${ua.token}` } }
        );
        expect(msgsRes.ok()).toBeTruthy();
        const msgs = await msgsRes.json();
        expect(Array.isArray(msgs)).toBeTruthy();
        // Ensure at least one message was saved (otherwise the test passes vacuously)
        expect(msgs.length).toBeGreaterThan(0);

        for (const m of msgs) {
            const keys = Object.keys(m);
            expect(keys).not.toContain('sender_username');
        }

        // Also verify list_messages_around endpoint
        if (msgs.length > 0) {
            const aroundRes = await page.request.get(
                `${BASE}/api/channels/${channelId}/messages/around/${msgs[0].id}`,
                { headers: { Authorization: `Bearer ${ua.token}` } }
            );
            expect(aroundRes.ok()).toBeTruthy();
            const aroundMsgs = await aroundRes.json();
            expect(Array.isArray(aroundMsgs)).toBeTruthy();
            for (const m of aroundMsgs) {
                const keys = Object.keys(m);
                expect(keys).not.toContain('sender_username');
            }
        }
    });

    test('04 — Server member shared key uploaded after page load', async ({ page, context }) => {
        const ts = Date.now() + Math.floor(Math.random() * 10000);
        const userA = 'srvA' + ts;
        const userB = 'srvB' + ts;

        // Register userA (server owner)
        const ua = await registerUser(page, userA);
        expect(ua.token).toBeTruthy();

        // Create a server as userA via the page's createServer flow (uploads server key)
        const server = await createServerViaPage(page, ua.token);
        expect(server).toBeTruthy();

        // Register userB and join the server via API
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const ub = await registerUser(page2, userB);
        expect(ub.token).toBeTruthy();

        // Join server via API
        const joinRes = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${ub.token}`, 'Content-Type': 'application/json' },
            data: { code: server.invite_code },
        });
        expect(joinRes.ok()).toBeTruthy();

        // Upload the server key for the new server so members can decrypt it.
        // Create an encrypted server key entry by simulating what selectServer does.
        // We navigate userA to the server so selectServer() uploads the key.
        await page.goto(`${BASE}/index.html`);
        await page.waitForLoadState('networkidle');
        await page.evaluate((sid) => {
            if (typeof selectServer === 'function') selectServer(sid);
        }, server.id);
        await new Promise(r => setTimeout(r, 3000));

        // Now navigate userB to index.html so loadServers() runs and uploads shared key
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForLoadState('networkidle');
        // Wait for loadServers() to complete its fire-and-forget upload
        await new Promise(r => setTimeout(r, 3000));

        // Verify from userA's perspective that userB's server key exists via batch endpoint
        const batchRes = await page.request.post(
            `${BASE}/api/profile/data-key/shared/batch`,
            {
                headers: { Authorization: `Bearer ${ua.token}`, 'Content-Type': 'application/json' },
                data: {
                    targets: [{ target_type: 'server', target_id: server.id }],
                },
            }
        );
        expect(batchRes.ok()).toBeTruthy();
        const batchData = await batchRes.json();
        const srvKey = 'server:' + server.id;
        expect(batchData).toHaveProperty(srvKey);
        expect(Array.isArray(batchData[srvKey])).toBeTruthy();
        expect(batchData[srvKey].length).toBeGreaterThan(0);

        // Verify the data has the expected structure
        for (const entry of batchData[srvKey]) {
            expect(entry).toHaveProperty('owner_user_id');
            expect(entry).toHaveProperty('encrypted_key');
            expect(entry).toHaveProperty('nonce');
            // Should include userB's key (the new member)
            expect([ua.user.id, ub.user.id]).toContain(entry.owner_user_id);
        }

        await ctx2.close();
    });

    test('05 — Sender_username absent in WS broadcast message payloads', async ({ page, context }) => {
        const ts = Date.now() + Math.floor(Math.random() * 10000);
        const userA = 'wsA' + ts;

        const ua = await registerUser(page, userA);
        expect(ua.token).toBeTruthy();
        await waitForWs(page);

        // Create a server via the page's createServer flow (handles key generation + upload)
        const server = await createServerViaPage(page, ua.token);
        expect(server).toBeTruthy();
        const channelsRes = await page.request.get(
            `${BASE}/api/servers/${server.id}/channels`,
            { headers: { Authorization: `Bearer ${ua.token}` } }
        );
        expect(channelsRes.ok()).toBeTruthy();
        const channels = await channelsRes.json();
        const channelId = channels[0].id;

        // Set up a listener on the WebSocket to capture the next broadcast
        const capturedMsg = await page.evaluate(async ({ channelId }) => {
            return new Promise((resolve) => {
                if (typeof ws === 'undefined' || !ws || ws.readyState !== WebSocket.OPEN) {
                    resolve({ error: 'ws_not_open', hasSenderUsername: false, hasEncryptedSenderUsername: false, messageKeys: [] });
                    return;
                }
                // Timeout after 5s to prevent hanging
                const timeout = setTimeout(() => {
                    ws.removeEventListener('message', handler);
                    resolve({ error: 'timeout', hasSenderUsername: false, hasEncryptedSenderUsername: false, messageKeys: [] });
                }, 5000);

                const handler = (event: MessageEvent) => {
                    try {
                        const data = JSON.parse(event.data);
                        if (data.type === 'message_new' && data.message && data.message.channel_id === channelId) {
                            clearTimeout(timeout);
                            const hasSenderUsername = 'sender_username' in data.message;
                            const hasEncryptedSenderUsername = 'encrypted_sender_username' in data.message;
                            ws.removeEventListener('message', handler);
                            resolve({
                                hasSenderUsername,
                                hasEncryptedSenderUsername,
                                messageKeys: Object.keys(data.message),
                            });
                        }
                    } catch (_) {}
                };
                ws.addEventListener('message', handler);

                // Send a test message
                ws.send(JSON.stringify({
                    type: 'message_send',
                    channel_id: channelId,
                    encrypted_content: 'AAAAAAAAAAAAAAAAAAAAAA==',
                    nonce: 'AAAAAAAAAAAAAAAAAAAAAA==',
                    encrypted_sender_username: 'AAAAAAAAAAAAAAAAAAAAAA==',
                    sender_username_nonce: 'AAAAAAAAAAAAAAAAAAAAAA==',
                }));
            });
        }, { channelId });

        expect(capturedMsg).toBeTruthy();
        expect(capturedMsg.error).toBeUndefined();
        expect(capturedMsg.hasSenderUsername).toBe(false);
        expect(capturedMsg.hasEncryptedSenderUsername).toBe(true);
        expect(capturedMsg.messageKeys).not.toContain('sender_username');
    });
});
