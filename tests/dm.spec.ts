import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('Direct Messages', () => {

    async function registerUser(page: any, username: string) {
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
                await page.fill('#register-confirm-password', 'password123');
await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });
        return await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));
    }

    async function becomeFriends(page1: any, page2: any, token1: string, token2: string) {
        // Get user2's friend code from localStorage (stored during registration)
        const me2_code = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));

        // User1 sends friend request
        const fr = await page1.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
            data: { friend_code: me2_code },
        });
        expect(fr.ok()).toBeTruthy();

        // User2 accepts
        const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${token2}` },
        })).json();
        expect(Array.isArray(incoming)).toBe(true);
        expect(incoming.length).toBe(1);
        const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        expect(acc.ok()).toBeTruthy();
    }

    async function createDmViaApi(page: any, page2: any, token1: string, user2: string): Promise<{dmChannelId: string, userId2: string}> {
        // Look up user2 by username
        const userData = await (await page.request.get(`${BASE}/api/user/${user2}`, {
            headers: { Authorization: `Bearer ${token1}` },
        })).json();

        // Create DM channel
        const dm = await page.request.post(`${BASE}/api/dm/${userData.id}`, {
            headers: { Authorization: `Bearer ${token1}` },
        });
        expect(dm.ok()).toBeTruthy();
        const dmChannel = await dm.json();
        return { dmChannelId: dmChannel.id, userId2: userData.id };
    }

    test('direct messages: user registration + DM creation works', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'dmuser1_' + ts;
        const user2 = 'dmuser2_' + ts;

        const body1 = await registerUser(page, user1);
        expect(body1.token).toBeTruthy();

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        expect(body2.token).toBeTruthy();

        // DM should not exist yet
        const preCheck = await (await page.request.get(`${BASE}/api/dm/conversations`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        expect(Array.isArray(preCheck)).toBe(true);
        expect(preCheck.length).toBe(0);

        await becomeFriends(page, page2, body1.token, body2.token);

        // DM should now auto-exist after accepting friend request
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('#dm-strip-btn');
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(1500);

        await page.waitForSelector('.dm-item', { timeout: 5000 });
        const dmItemText = await page.locator('.dm-item').first().textContent();
        expect(dmItemText).toContain(user2);

        await page2.close();
        await ctx2.close();
    });

    test('direct messages: send and receive encrypted message', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'alice_' + ts;
        const user2 = 'bob_' + ts;

        const body1 = await registerUser(page, user1);
        expect(body1.token).toBeTruthy();

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        expect(body2.token).toBeTruthy();

        await becomeFriends(page, page2, body1.token, body2.token);

        // Create DM via API directly
        const { dmChannelId, userId2 } = await createDmViaApi(page, page2, body1.token, user2);

        // Navigate user1 to DM view and select the channel via JS
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('#dm-strip-btn');
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(1500);

        // Wait for WS and select DM channel directly via evaluate
        const selected = await page.evaluate(async ({ dmChannelId, userId2, user2 }) => {
            // Wait for WebSocket to be connected
            for (let i = 0; i < 50; i++) {
                if (ws && ws.readyState === WebSocket.OPEN) break;
                await new Promise(r => setTimeout(r, 100));
            }
            // Select DM channel directly
            if (typeof selectDmChannel === 'function') {
                try {
                    await selectDmChannel(dmChannelId, userId2, user2, null);
                    return 'ok: ' + JSON.stringify(currentDmOtherUser);
                } catch (e) {
                    return 'err: ' + e.message;
                }
            } else {
                return 'selectDmChannel is not a function';
            }
        }, { dmChannelId, userId2, user2 });
        console.log('selectDmChannel result:', selected);
        expect(selected).toContain('ok:');
        await page.waitForTimeout(500);

        // Send message via WebSocket (inside browser context)
        await page.evaluate(async ({ dmChannelId, msg }) => {
            const kp = E2ECrypto.getIdentityKeyPair();
            const res = await fetch('/api/identity/' + currentDmOtherUser.id, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
            });
            const data = await res.json();
            const otherPubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
            const encrypted = E2ECrypto.encryptDm(msg, dmChannelId, kp.privateKey, otherPubKey);
            ws.send(JSON.stringify({
                type: 'dm_send',
                dm_channel_id: dmChannelId,
                encrypted_content: encrypted.ciphertext,
                nonce: encrypted.nonce,
                message_nonce: encrypted.messageNonce || null,
            }));
        }, { dmChannelId, msg: 'Hello from DM, user2!' });
        await page.waitForTimeout(1000);

        // User2 should see the message
        await page2.goto(`${BASE}/index.html`);
        await page2.click('#dm-strip-btn');
        await page2.waitForSelector('.dm-item', { timeout: 5000 });
        await page2.click('.dm-item');

        await page2.waitForSelector('.text');
        await page2.waitForTimeout(2000);

        const messageText = await page2.locator('.text').first().textContent();
        expect(messageText).toContain('Hello from DM, user2!');
        expect(messageText).not.toContain('encrypted');

        await page2.close();
        await ctx2.close();
    });

    test('direct messages: encrypted storage verification', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'ctuser1_' + ts;
        const user2 = 'ctuser2_' + ts;

        const body1 = await registerUser(page, user1);
        expect(body1.token).toBeTruthy();

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        expect(body2.token).toBeTruthy();

        await becomeFriends(page, page2, body1.token, body2.token);

        // Create DM and send message via API/WS directly
        const { dmChannelId, userId2 } = await createDmViaApi(page, page2, body1.token, user2);

        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('#dm-strip-btn');
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(1500);

        // Select DM channel and send via WS
        await page.evaluate(async ({ dmChannelId, userId2, user2, msg }) => {
            for (let i = 0; i < 50; i++) {
                if (ws && ws.readyState === WebSocket.OPEN) break;
                await new Promise(r => setTimeout(r, 100));
            }
            if (typeof selectDmChannel === 'function') {
                await selectDmChannel(dmChannelId, userId2, user2, null);
            }
            const kp = E2ECrypto.getIdentityKeyPair();
            const res = await fetch('/api/identity/' + currentDmOtherUser.id, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
            });
            const data = await res.json();
            const otherPubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
            const encrypted = E2ECrypto.encryptDm(msg, dmChannelId, kp.privateKey, otherPubKey);
            ws.send(JSON.stringify({
                type: 'dm_send',
                dm_channel_id: dmChannelId,
                encrypted_content: encrypted.ciphertext,
                nonce: encrypted.nonce,
                message_nonce: encrypted.messageNonce || null,
            }));
        }, { dmChannelId, userId2, user2, msg: 'Secret DM message' });
        await page.waitForTimeout(1000);
        await page.waitForTimeout(1000);

        // Verify the message is stored encrypted on the server
        const convRes = await page.request.get(`${BASE}/api/dm/conversations`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        const conversations = await convRes.json();
        expect(Array.isArray(conversations)).toBe(true);
        expect(conversations.length).toBeGreaterThanOrEqual(1);
        const foundDmId = conversations[0].dm_channel_id;

        const msgsRes = await page.request.get(`${BASE}/api/dm/${foundDmId}/messages`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        const msgs = await msgsRes.json();
        expect(msgs.length).toBeGreaterThanOrEqual(1);
        for (const m of msgs) {
            expect(m).toHaveProperty('encrypted_content');
            expect(m).toHaveProperty('nonce');
            expect(m).not.toHaveProperty('content');
            expect(m.encrypted_content.length).toBeGreaterThan(0);
        }

        // The ciphertext returned by the host cannot be opened with an
        // unrelated identity, even though public keys and the DM id are known.
        const attackerCanDecrypt = await page.evaluate(({ message, dmId }) => {
            const attacker = E2ECrypto.x25519GenerateKeyPair();
            try {
                E2ECrypto.decryptDm(
                    message.encrypted_content, message.nonce, dmId,
                    attacker.privateKey, attacker.publicKey
                );
                return true;
            } catch (_) {
                return false;
            }
        }, { message: msgs[0], dmId: foundDmId });
        expect(attackerCanDecrypt).toBeFalsy();

        await page2.close();
        await ctx2.close();
    });

    test('identity keys stay bound to their account when accounts share a browser', async ({ page }) => {
        const ts = Date.now();
        const user1 = 'keyuser1_' + ts;
        const user2 = 'keyuser2_' + ts;

        const body1 = await registerUser(page, user1);
        const key1 = await page.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().privateKey));

        // Simulate signing out and creating a second account in the same
        // browser profile. Account one’s private key must remain untouched.
        await page.evaluate(() => {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
        });
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', user2);
        await page.fill('#register-password', 'password123');
                await page.fill('#register-confirm-password', 'password123');
await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html');
        const key2 = await page.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().privateKey));
        expect(key2).not.toBe(key1);

        await page.evaluate(() => {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
        });
        await page.goto(`${BASE}/login.html`);
        await page.fill('#login-username', user1);
        await page.fill('#login-password', 'password123');
        await page.click('#login-form button[type="submit"]');
        await page.waitForURL('**/index.html');

        const restoredKey1 = await page.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().privateKey));
        expect(restoredKey1).toBe(key1);
        expect(body1.user.id).toBeTruthy();
    });

    test('a declined friend request can be sent again', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'retryuser1_' + ts;
        const user2 = 'retryuser2_' + ts;
        const body1 = await registerUser(page, user1);
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const friendCode2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));

        const first = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: friendCode2 },
        });
        expect(first.ok()).toBeTruthy();
        const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        })).json();
        const decline = await page2.request.post(`${BASE}/api/friends/requests/decline`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        expect(decline.ok()).toBeTruthy();

        const resent = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: friendCode2 },
        });
        expect(resent.ok()).toBeTruthy();
        const retriedIncoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        })).json();
        expect(retriedIncoming).toHaveLength(1);

        await page2.close();
        await ctx2.close();
    });
});
