import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('Comprehensive E2E — All Features', () => {

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
                setTimeout(check, 500); // initial delay
            });
        }, maxRetries);
    }

    test('01 — DM message edit propagates in real-time', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'dma' + ts;
        const user2 = 'dmb' + ts;

        // Register user2 FIRST, then user1 (so user2's page is ready)
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);

        const body1 = await registerUser(page, user1);

        // Become friends via API
        const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        const fr = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: fc2 },
        });
        expect(fr.ok()).toBeTruthy();

        const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        })).json();
        expect(incoming.length).toBe(1);
        const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        expect(acc.ok()).toBeTruthy();

        // Both pages are on index.html from registration. WS should be connected.
        // Wait for WS on both pages
        const ws1 = await waitForWs(page);
        expect(ws1).toBeTruthy();
        const ws2 = await waitForWs(page2);
        expect(ws2).toBeTruthy();

        // Get DM channel
        const convs = await (await page.request.get(`${BASE}/api/dm/conversations`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        expect(convs.length).toBeGreaterThanOrEqual(1);
        const dmId = convs[0].dm_channel_id;

        // User1 sends a DM message via WS
        const sent = await page.evaluate(async ({ dmId }) => {
            const kp = E2ECrypto.getIdentityKeyPair();
            if (!kp) { return 'no keypair'; }
            // Need the OTHER user's public key for DM encryption
            const myUser = JSON.parse(localStorage.getItem('user') || '{}');
            // Try to find the other user's info from dmConversations
            const conv = typeof dmConversations !== 'undefined' ? dmConversations.find((c: any) => c.dm_channel_id === dmId) : null;
            let otherUserId = conv ? conv.other_user_id : null;
            if (!otherUserId) { return 'no other user'; }
            try {
                const res = await fetch('/api/identity/' + otherUserId, {
                    headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
                });
                const data = await res.json();
                const otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
                const enc = E2ECrypto.encryptDm('Hello from Alice!', dmId, kp.privateKey, otherPub);
                ws.send(JSON.stringify({
                    type: 'dm_send',
                    dm_channel_id: dmId,
                    encrypted_content: enc.ciphertext,
                    nonce: enc.nonce,
                    message_nonce: enc.messageNonce || null,
                }));
                return 'sent:' + otherUserId;
            } catch (e) {
                return 'error: ' + e.message;
            }
        }, { dmId });
        expect(sent).toBe('sent:' + body2.user.id);
        await page.waitForTimeout(2000);

        // User2 should receive the message (they're on the same page, should auto-receive)
        // Select user2's DM view so they can see the message
        await page2.click('#dm-strip-btn');
        await page2.waitForTimeout(1000);
        // Find the DM item and click it
        let dmClicked = false;
        for (let i = 0; i < 30; i++) {
            const dmItems = page2.locator('.dm-item');
            const count = await dmItems.count();
            if (count > 0) {
                await dmItems.first().click().catch(() => {});
                await page2.waitForTimeout(500);
                dmClicked = true;
                break;
            }
            await page2.waitForTimeout(300);
        }
        expect(dmClicked).toBeTruthy();
        await page2.waitForTimeout(2000);

        // Check user2 received the message
        const msgOn2 = await page2.locator('.text').first().textContent();
        expect(msgOn2).toContain('Hello from Alice');

        // User1 (the AUTHOR) edits the message via WS — the server's
        // edit_dm_message only lets the author edit, so the editor must be the
        // original sender (mirrors the server-channel test 02 below).
        // Encryption matches the client's real DM edit path: the editor's
        // private key + the OTHER participant's public key, so user2 can decrypt.
        const dmMsgs = await (await page.request.get(`${BASE}/api/dm/${dmId}/messages?limit=10`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        const authMsgId = dmMsgs && dmMsgs[0] ? dmMsgs[0].id : null;
        expect(authMsgId).toBeTruthy();

        const user2PubRes = await page.request.get(`${BASE}/api/identity/${body2.user.id}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        const user2PubData = await user2PubRes.json();
        const user2PubKeyB64 = user2PubData.identity_public_key;

        const editSent = await page.evaluate(async ({ dmId, authMsgId, user2PubKeyB64 }) => {
            const kp = E2ECrypto.getIdentityKeyPair();
            if (!kp) { return 'no keypair'; }
            try {
                const user2PubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(user2PubKeyB64));
                const payload = { type: 'text', text: 'EDITED: This DM was changed!' };
                const enc = E2ECrypto.encryptDm(JSON.stringify(payload), dmId, kp.privateKey, user2PubKey);
                ws.send(JSON.stringify({
                    type: 'dm_edit',
                    message_id: authMsgId,
                    encrypted_content: enc.ciphertext,
                    nonce: enc.nonce,
                    message_nonce: enc.messageNonce || null,
                }));
                return 'edit sent: ' + authMsgId;
            } catch (e) {
                return 'error: ' + e.message;
            }
        }, { dmId, authMsgId, user2PubKeyB64 });
        expect(editSent).toContain('edit sent');
        await page.waitForTimeout(3000);

        // User2 (in the DM view with the message rendered) should see the edit live
        const editStatus = await page2.evaluate(() => {
            const label = document.querySelector('.edited-label');
            if (label) { return 'edited_label:' + label.textContent; }
            const textEl = document.querySelector('.text');
            if (textEl && textEl.textContent) {
                if (textEl.textContent.includes('EDITED')) { return 'text_changed:' + textEl.textContent; }
                return 'no_edit:' + textEl.textContent;
            }
            return 'no_text';
        });
        // It may take a moment for user2 to receive + process the edit
        let finalStatus = editStatus;
        for (let i = 0; i < 20 && finalStatus.startsWith('no_'); i++) {
            await page2.waitForTimeout(500);
            finalStatus = await page2.evaluate(() => {
                const label = document.querySelector('.edited-label');
                if (label) { return 'edited_label:' + label.textContent; }
                const textEl = document.querySelector('.text');
                if (textEl && textEl.textContent) {
                    if (textEl.textContent.includes('EDITED')) { return 'text_changed:' + textEl.textContent; }
                    return 'no_edit:' + textEl.textContent;
                }
                return 'no_text';
            });
        }
        expect(finalStatus).not.toMatch(/^no_/);
        // The edit should be detected as either an edited label or changed text
        const editDetected = finalStatus && (finalStatus.startsWith('edited_label') || finalStatus.startsWith('text_changed'));
        expect(editDetected).toBeTruthy();

        await page2.close();
        await ctx2.close();
    });

    test('02 — Server message edit propagates in real-time', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'sra' + ts;
        const user2 = 'srb' + ts;

        // Register user2 first
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);

        // Create server
        const inviteCode = 'SEP' + ts;

        const srv = await (await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { invite_code: inviteCode },
        })).json();
        const serverId = srv.id;

        // Upload server key for user1
        const keyOk = await page.evaluate(async ({ serverId }) => {
            const identity = E2ECrypto.getIdentityKeyPair();
            if (!identity) { return 'no identity'; }
            const symKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, symKey);
            const myId = JSON.parse(localStorage.getItem('user') || '{}').id;
            const pubRes = await fetch('/api/identity/' + myId, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
            });
            const pubData = await pubRes.json();
            const pubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(pubData.identity_public_key));
            const enc = E2ECrypto.envelopeEncrypt(symKey, pubKey, identity.privateKey);
            const res = await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: myId,
                    encrypted_key: enc.ciphertext,
                    sender_public_key: E2ECrypto.arrayBufferToBase64(identity.publicKey),
                    nonce: enc.nonce,
                }),
            });
            return res.ok ? 'ok' : 'upload failed';
        }, { serverId });
        expect(keyOk).toBe('ok');

        // User2 joins with the RAW invite code (the server salts + hashes it)
        const join = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { code: inviteCode },
        });
        expect(join.ok()).toBeTruthy();

        // Upload key for user2 (owner does it)
        const u2KeyRes = await page.request.get(`${BASE}/api/identity/${body2.user.id}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        const u2KeyData = await u2KeyRes.json();

        const keyOk2 = await page.evaluate(async ({ serverId, u2PubKeyB64, user2Id }) => {
            const identity = E2ECrypto.getIdentityKeyPair();
            if (!identity) { return 'no identity'; }
            const symKey = E2ECrypto.getServerKey(serverId);
            if (!symKey) { return 'no symkey'; }
            const u2PubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(u2PubKeyB64));
            const enc = E2ECrypto.envelopeEncrypt(symKey, u2PubKey, identity.privateKey);
            const res = await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: user2Id,
                    encrypted_key: enc.ciphertext,
                    sender_public_key: E2ECrypto.arrayBufferToBase64(identity.publicKey),
                    nonce: enc.nonce,
                }),
            });
            return res.ok ? 'ok' : 'upload failed';
        }, { serverId, u2PubKeyB64: u2KeyData.identity_public_key, user2Id: body2.user.id });
        expect(keyOk2).toBe('ok');

        // Page2 joined via API — reload so its sidebar picks up the new server
        // (the client refreshes the server list on page load; the live
        // member_joined event only updates the member list, not the sidebar).
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForSelector('#settings-btn', { timeout: 15000 });
        await page2.waitForTimeout(1500);

        // Get channel ID
        const channels = await (await page.request.get(`${BASE}/api/servers/${serverId}/channels`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        const channelId = channels[0].id;

        // Both pages are on index.html from registration. WS should be connected.
        const ws1 = await waitForWs(page);
        expect(ws1).toBeTruthy();
        const ws2 = await waitForWs(page2);
        expect(ws2).toBeTruthy();

        // User1 selects the server + channel
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(500);
        // Click first server icon
        for (let i = 0; i < 25; i++) {
            const count = await page.locator('.server-icon:not(.add-server):not(.dm-strip-btn)').count();
            if (count > 0) {
                await page.locator('.server-icon:not(.add-server):not(.dm-strip-btn)').first().click().catch(() => {});
                await page.waitForTimeout(500);
                break;
            }
            await page.waitForTimeout(300);
        }
        await page.waitForTimeout(1500);

        for (let i = 0; i < 25; i++) {
            const count = await page.locator('.channel-item').count();
            if (count > 0) {
                await page.locator('.channel-item').first().click().catch(() => {});
                await page.waitForTimeout(500);
                break;
            }
            await page.waitForTimeout(300);
        }
        await page.waitForTimeout(1000);

        // Send server message via WS
        const sent = await page.evaluate(async ({ channelId, serverId }) => {
            const key = E2ECrypto.getServerKey(serverId);
            if (!key) { return 'no key'; }
            try {
                const enc = E2ECrypto.encryptMessage('Original server message text', key);
                ws.send(JSON.stringify({
                    type: 'message_send',
                    channel_id: channelId,
                    encrypted_content: enc.ciphertext,
                    nonce: enc.nonce,
                    message_nonce: enc.messageNonce || null,
                }));
                return 'sent';
            } catch (e) {
                return 'error: ' + e.message;
            }
        }, { channelId, serverId });
        expect(sent).toBe('sent');
        await page.waitForTimeout(2000);

        // User2 selects the server + channel
        await page2.click('#dm-strip-btn');
        await page2.waitForTimeout(500);
        for (let i = 0; i < 25; i++) {
            const count = await page2.locator('.server-icon:not(.add-server):not(.dm-strip-btn)').count();
            if (count > 0) {
                await page2.locator('.server-icon:not(.add-server):not(.dm-strip-btn)').first().click().catch(() => {});
                await page2.waitForTimeout(500);
                break;
            }
            await page2.waitForTimeout(300);
        }
        await page2.waitForTimeout(1500);
        for (let i = 0; i < 25; i++) {
            const count = await page2.locator('.channel-item').count();
            if (count > 0) {
                await page2.locator('.channel-item').first().click().catch(() => {});
                await page2.waitForTimeout(500);
                break;
            }
            await page2.waitForTimeout(300);
        }
        await page2.waitForTimeout(2000);

        const msgOn2 = await page2.locator('.text').first().textContent();
        expect(msgOn2).toContain('Original server message');

        // User1 edits via WS — the message id comes from the API, not the DOM
        // (page1 never rendered the channel view in this test).
        await page.waitForTimeout(1000);
        const chMsgs = await (await page.request.get(`${BASE}/api/channels/${channelId}/messages?limit=10`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        const authChMsgId = chMsgs && chMsgs[0] ? chMsgs[0].id : null;
        expect(authChMsgId).toBeTruthy();

        const editOk = await page.evaluate(async ({ channelId, serverId, authChMsgId }) => {
            const key = E2ECrypto.getServerKey(serverId);
            if (!key) { return 'no key'; }
            try {
                const payload = { type: 'text', text: 'EDITED: Server message changed!' };
                const enc = E2ECrypto.encryptMessage(JSON.stringify(payload), key);
                ws.send(JSON.stringify({
                    type: 'message_edit',
                    message_id: authChMsgId,
                    encrypted_content: enc.ciphertext,
                    nonce: enc.nonce,
                    message_nonce: enc.messageNonce || null,
                }));
                return 'edit sent: ' + authChMsgId;
            } catch (e) {
                return 'error: ' + e.message;
            }
        }, { channelId, serverId, authChMsgId });
        expect(editOk).toContain('edit sent');
        await page.waitForTimeout(3000);

        // User2 should see the edit
        await page2.waitForTimeout(3000);
        const editStatus = await page2.evaluate(() => {
            const label = document.querySelector('.edited-label');
            if (label) { return 'edited_label:' + label.textContent; }
            const textEl = document.querySelector('.text');
            if (textEl && textEl.textContent) {
                if (textEl.textContent.includes('EDITED')) { return 'text_changed:' + textEl.textContent; }
                return 'no_edit:' + textEl.textContent;
            }
            return 'no_text';
        });
        let finalStatus = editStatus;
        for (let i = 0; i < 20 && finalStatus.startsWith('no_'); i++) {
            await page2.waitForTimeout(500);
            finalStatus = await page2.evaluate(() => {
                const label = document.querySelector('.edited-label');
                if (label) { return 'edited_label:' + label.textContent; }
                const textEl = document.querySelector('.text');
                if (textEl && textEl.textContent) {
                    if (textEl.textContent.includes('EDITED')) { return 'text_changed:' + textEl.textContent; }
                    return 'no_edit:' + textEl.textContent;
                }
                return 'no_text';
            });
        }
        expect(finalStatus).not.toMatch(/^no_/);
        const editDetected = finalStatus && (finalStatus.startsWith('edited_label') || finalStatus.startsWith('text_changed'));
        expect(editDetected).toBeTruthy();

        await page2.close();
        await ctx2.close();
    });

    test('03 — Friend request flow + page refresh', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'fra' + ts;
        const user2 = 'frb' + ts;

        // Register user2 first then user1
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);

        // Friend request: user1 -> user2
        const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        const fr = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: fc2 },
        });
        expect(fr.ok()).toBeTruthy();

        const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        })).json();
        expect(incoming.length).toBe(1);

        const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        expect(acc.ok()).toBeTruthy();

        // Verify DM exists via API
        const convs = await (await page.request.get(`${BASE}/api/dm/conversations`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        expect(convs.length).toBeGreaterThanOrEqual(1);

        // Verify friend code survives
        const fc1 = await page.evaluate(() => localStorage.getItem('e2e_friend_code'));
        expect(fc1).toBeTruthy();

        // Regenerate friend code
        const regen = await page.request.post(`${BASE}/api/friend-code/regenerate`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        expect(regen.ok()).toBeTruthy();
        await page.waitForTimeout(500);

        const fc1new = await page.evaluate(() => localStorage.getItem('e2e_friend_code'));
        expect(fc1new).toBeTruthy();

        // Page refresh: user should still see DMs
        await page.goto(`${BASE}/index.html`);
        await page.waitForLoadState('networkidle');
        await page.waitForSelector('#dm-strip-btn');
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(1000);

        // Wait for DM items to render
        let dmFound = false;
        for (let i = 0; i < 25; i++) {
            const count = await page.locator('.dm-item').count();
            if (count > 0) { dmFound = true; break; }
            await page.waitForTimeout(400);
        }
        expect(dmFound).toBeTruthy();

        // Send a message (verifies WS works after refresh)
        const wsConnected = await waitForWs(page);
        expect(wsConnected).toBeTruthy();

        await page2.close();
        await ctx2.close();
    });

    test('04 — Server key exchange + channels', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'ska' + ts;
        const user2 = 'skb' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);

        const inviteCode = 'SKT' + ts;

        const srv = await (await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { invite_code: inviteCode },
        })).json();
        const serverId = srv.id;

        // Upload key
        const keyOk = await page.evaluate(async ({ serverId }) => {
            const identity = E2ECrypto.getIdentityKeyPair();
            const symKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, symKey);
            const myId = JSON.parse(localStorage.getItem('user') || '{}').id;
            const pubRes = await fetch('/api/identity/' + myId, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
            });
            const pubData = await pubRes.json();
            const pubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(pubData.identity_public_key));
            const enc = E2ECrypto.envelopeEncrypt(symKey, pubKey, identity.privateKey);
            const res = await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: myId, encrypted_key: enc.ciphertext, sender_public_key: E2ECrypto.arrayBufferToBase64(identity.publicKey), nonce: enc.nonce }),
            });
            return res.ok;
        }, { serverId });
        expect(keyOk).toBeTruthy();

        // Verify encrypted keys on server
        const keys = await (await page.request.get(`${BASE}/api/servers/${serverId}/keys`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        expect(Array.isArray(keys)).toBe(true);
        expect(keys.length).toBeGreaterThanOrEqual(1);
        for (const k of keys) {
            expect(k.encrypted_key).toBeTruthy();
            expect(k.sender_public_key).toBeTruthy();
            expect(k.nonce).toBeTruthy();
        }

        // Verify channels
        const channels = await (await page.request.get(`${BASE}/api/servers/${serverId}/channels`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        expect(channels.length).toBeGreaterThanOrEqual(1);

        await page2.close();
        await ctx2.close();
    });
});
