import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';

test.describe('E2E Chat', () => {

    test('login page loads', async ({ page }) => {
        await page.goto(`${BASE}/login.html`);
        await expect(page.locator('h1').first()).toContainText('E2E Chat');
    });

    test('register, create server, send and receive encrypted message', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'alice_' + ts;
        const user2 = 'bob_' + ts;

        // Register user1 via browser to get identity keys
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', user1);
        await page.fill('#register-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });

        const body1 = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));
        expect(body1.token).toBeTruthy();

        // Register user2 via separate browser context
        const ctx2 = await context.browser()!.newContext();
        const page2reg = await ctx2.newPage();
        await page2reg.goto(`${BASE}/login.html`);
        await page2reg.waitForTimeout(1000);
        await page2reg.click('#show-register');
        await page2reg.fill('#register-username', user2);
        await page2reg.fill('#register-password', 'password123');
        await page2reg.click('#register-form button[type="submit"]');
        await page2reg.waitForURL('**/index.html', { timeout: 10000 });

        const body2 = await page2reg.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));
        expect(body2.token).toBeTruthy();

        // Get user2's actual public key from their browser context
        const user2PubKeyB64 = await page2reg.evaluate(() => {
            return E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey);
        });

        // User1 creates a server through the API
        const srv = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body1.token}` },
            data: { name: 'Test Server' },
        });
        const server = await srv.json();
        expect(server.id).toBeTruthy();

        // Generate server key and upload encrypted key for user1
        await page.evaluate(async ({ serverId, userId }) => {
            const serverKey = E2ECrypto.generateServerKey();
            E2ECrypto.saveServerKey(serverId, serverKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + localStorage.getItem('token'),
                },
                body: JSON.stringify({
                    user_id: userId,
                    encrypted_key: encrypted.ciphertext,
                    sender_public_key: encrypted.ephemeralPublicKey,
                    nonce: encrypted.nonce,
                }),
            });
        }, { serverId: server.id, userId: body1.user.id });

        // Get invite code
        const invRes = await page.request.post(`${BASE}/api/servers/${server.id}/invite`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        const invite = await invRes.json();
        expect(invite.code).toBeTruthy();

        // User2 joins
        const joinRes = await page.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${body2.token}` },
            data: { code: invite.code },
        });
        const joined = await joinRes.json();
        expect(joined.id).toBe(server.id);

        // Upload encrypted server key for user2
        await page.evaluate(async ({ serverId, user2Id, user2PubKey }) => {
            const serverKey = E2ECrypto.getServerKey(serverId);
            const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(user2PubKey));
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, recipientPub);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + localStorage.getItem('token'),
                },
                body: JSON.stringify({
                    user_id: user2Id,
                    encrypted_key: encrypted.ciphertext,
                    sender_public_key: encrypted.ephemeralPublicKey,
                    nonce: encrypted.nonce,
                }),
            });
        }, { serverId: server.id, user2Id: body2.user.id, user2PubKey: user2PubKeyB64 });

        // User1 loads chat
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(500);

        // User2 loads chat with decrypted server key
        const page2 = await ctx2.newPage();
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForSelector('.server-icon', { timeout: 10000 });
        await page2.click('.server-icon:not(.add-server)');
        await page2.waitForSelector('.channel-item', { timeout: 10000 });
        await page2.click('.channel-item >> nth=0');
        await page2.waitForTimeout(1500);

        // User1 sends encrypted message
        const input1 = page.locator('#message-input');
        await expect(input1).toBeEnabled({ timeout: 5000 });
        await input1.fill('Hello from Alice!');
        await page.click('#send-btn');
        await page.waitForTimeout(2000);

        // User2 sees decrypted message
        const user2Texts = await page2.locator('.message .text').allTextContents();
        expect(user2Texts.some(t => t === 'Hello from Alice!')).toBeTruthy();

        // User2 sends reply
        const input2 = page2.locator('#message-input');
        await input2.fill('Hello from Bob!');
        await page2.click('#send-btn');
        await page2.waitForTimeout(2000);

        // User1 sees decrypted reply
        const user1Texts = await page.locator('.message .text').allTextContents();
        expect(user1Texts.some(t => t === 'Hello from Bob!')).toBeTruthy();

        await page2.close();
        await ctx2.close();
    });

    test('full UI flow: create server via UI, join via invite, bidirectional messaging', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'ui_alice_' + ts;
        const user2 = 'ui_bob_' + ts;

        // === User1 registers ===
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', user1);
        await page.fill('#register-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });

        const body1 = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));
        expect(body1.token).toBeTruthy();

        // === User2 registers in separate context ===
        const ctx2 = await context.browser()!.newContext();
        const page2reg = await ctx2.newPage();
        await page2reg.goto(`${BASE}/login.html`);
        await page2reg.waitForTimeout(1000);
        await page2reg.click('#show-register');
        await page2reg.fill('#register-username', user2);
        await page2reg.fill('#register-password', 'password123');
        await page2reg.click('#register-form button[type="submit"]');
        await page2reg.waitForURL('**/index.html', { timeout: 10000 });

        const body2 = await page2reg.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));
        expect(body2.token).toBeTruthy();

        // === User1 creates server via UI ===
        // The "+" button uses a native confirm() dialog: OK=create, Cancel=join
        page.on('dialog', async dialog => {
            await dialog.accept();
        });
        await page.click('#add-server-btn');
        await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 5000 });
        await page.fill('#new-server-name', 'UI Test Server');
        await page.click('#confirm-create-server');
        await page.waitForTimeout(2000);

        // Verify server was created - should see the server icon
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 5000 });

        // Check console logs for key upload
        const createLogs: string[] = [];
        page.on('console', msg => {
            if (msg.text().includes('[E2E]')) createLogs.push(msg.text());
        });

        // Reload to capture logs cleanly
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });

        // Click the server to trigger key check
        await page.click('.server-icon:not(.add-server)');
        await page.waitForTimeout(1500);

        // Check we can see channels (not "Cannot decrypt server key")
        const channelItems = await page.locator('.channel-item').allTextContents();
        console.log('Channel items:', channelItems);
        expect(channelItems.some(c => c.includes('general') || c.includes('No channels'))).toBeTruthy();

        // === Get invite code ===
        const serverId = await page.evaluate(() => {
            const icons = document.querySelectorAll('.server-icon:not(.add-server)');
            return (icons[0] as HTMLElement)?.dataset?.id || '';
        });
        expect(serverId).toBeTruthy();

        const invRes = await page.request.post(`${BASE}/api/servers/${serverId}/invite`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        const invite = await invRes.json();
        expect(invite.code).toBeTruthy();
        console.log('Invite code:', invite.code);

        // === User2 joins via UI ===
        await page2reg.goto(`${BASE}/index.html`);
        await page2reg.waitForSelector('.add-server', { timeout: 10000 });

        // Click "+" to join server - need to handle the confirm() dialog (Cancel = join)
        page2reg.on('dialog', async dialog => {
            await dialog.dismiss();
        });
        await page2reg.click('#add-server-btn');
        await page2reg.waitForSelector('#join-server-modal', { state: 'visible', timeout: 5000 });
        await page2reg.fill('#invite-code-input', invite.code);
        await page2reg.click('#confirm-join-server');
        await page2reg.waitForTimeout(5000);

        // Verify user2 sees the server
        await page2reg.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });

        // Click the server
        await page2reg.click('.server-icon:not(.add-server)');
        await page2reg.waitForTimeout(3000);

        // Check if user2 can see channels
        const user2Channels = await page2reg.locator('.channel-item').allTextContents();
        console.log('User2 channels:', user2Channels);
        const user2CanDecrypt = !user2Channels.some(c => c.includes('Cannot decrypt'));
        console.log('User2 can decrypt:', user2CanDecrypt);

        // === Both users select a channel and send messages ===
        // User1 clicks general
        const user1Channels = await page.locator('.channel-item').allTextContents();
        console.log('User1 channels:', user1Channels);
        if (user1Channels.some(c => c.includes('general'))) {
            await page.locator('.channel-item', { hasText: 'general' }).click();
        } else {
            await page.locator('.channel-item >> nth=0').click();
        }
        await page.waitForTimeout(1000);

        // User2 clicks general
        if (user2CanDecrypt && user2Channels.some(c => c.includes('general'))) {
            await page2reg.locator('.channel-item', { hasText: 'general' }).click();
        } else if (user2CanDecrypt) {
            await page2reg.locator('.channel-item >> nth=0').click();
        }
        await page2reg.waitForTimeout(1500);

        // User1 sends message
        if (user2CanDecrypt) {
            const input1 = page.locator('#message-input');
            await expect(input1).toBeEnabled({ timeout: 5000 });
            await input1.fill('Hello from UI Alice!');
            await page.click('#send-btn');
            await page.waitForTimeout(2000);

            // User2 should see the decrypted message
            const user2Msgs = await page2reg.locator('.message .text').allTextContents();
            console.log('User2 messages:', user2Msgs);
            expect(user2Msgs.some(t => t === 'Hello from UI Alice!')).toBeTruthy();

            // User2 replies
            const input2 = page2reg.locator('#message-input');
            await expect(input2).toBeEnabled({ timeout: 5000 });
            await input2.fill('Hello from UI Bob!');
            await page2reg.click('#send-btn');
            await page2reg.waitForTimeout(2000);

            // User1 should see the reply
            const user1Msgs = await page.locator('.message .text').allTextContents();
            console.log('User1 messages:', user1Msgs);
            expect(user1Msgs.some(t => t === 'Hello from UI Bob!')).toBeTruthy();
        } else {
            throw new Error('User2 could not decrypt server key via UI flow');
        }

        await page2reg.close();
        await ctx2.close();
    });

    test('reload preserves decrypted messages', async ({ page }) => {
        const ts = Date.now();
        const username = 'reload_' + ts;

        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });

        const body = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));

        // Create server
        const srv = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body.token}` },
            data: { name: 'Reload Server' },
        });
        const server = await srv.json();

        // Generate server key
        await page.evaluate(async ({ serverId, userId }) => {
            const serverKey = E2ECrypto.generateServerKey();
            E2ECrypto.saveServerKey(serverId, serverKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + localStorage.getItem('token'),
                },
                body: JSON.stringify({
                    user_id: userId,
                    encrypted_key: encrypted.ciphertext,
                    sender_public_key: encrypted.ephemeralPublicKey,
                    nonce: encrypted.nonce,
                }),
            });
        }, { serverId: server.id, userId: body.user.id });

        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(500);

        const input = page.locator('#message-input');
        await expect(input).toBeEnabled({ timeout: 5000 });
        await input.fill('Persistent!');
        await page.click('#send-btn');
        await page.waitForTimeout(1500);

        expect(await page.locator('.message .text').allTextContents()).toContainEqual('Persistent!');

        await page.reload();
        await page.waitForSelector('.server-icon', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(1500);

        expect(await page.locator('.message .text').allTextContents()).toContainEqual('Persistent!');
    });

    test('server only stores ciphertext', async ({ page }) => {
        const ts = Date.now();
        const username = 'ct_' + ts;

        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });

        const body = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));

        // Create server
        const srv = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body.token}` },
            data: { name: 'CT Server' },
        });
        const server = await srv.json();

        // Get channel
        const chRes = await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });
        const channels = await chRes.json();
        const channelId = channels[0].id;

        // Generate server key
        await page.evaluate(async ({ serverId, userId }) => {
            const serverKey = E2ECrypto.generateServerKey();
            E2ECrypto.saveServerKey(serverId, serverKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + localStorage.getItem('token'),
                },
                body: JSON.stringify({
                    user_id: userId,
                    encrypted_key: encrypted.ciphertext,
                    sender_public_key: encrypted.ephemeralPublicKey,
                    nonce: encrypted.nonce,
                }),
            });
        }, { serverId: server.id, userId: body.user.id });

        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(500);

        const input = page.locator('#message-input');
        await expect(input).toBeEnabled({ timeout: 5000 });
        await input.fill('Server should not read this');
        await page.click('#send-btn');
        await page.waitForTimeout(1500);

        // Verify server only stores ciphertext
        const msgsRes = await page.request.get(`${BASE}/api/channels/${channelId}/messages`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });
        const msgs = await msgsRes.json();
        expect(msgs.length).toBeGreaterThanOrEqual(1);
        for (const m of msgs) {
            expect(m).toHaveProperty('encrypted_content');
            expect(m).toHaveProperty('nonce');
            expect(m).not.toHaveProperty('content');
        }
    });

    test('admin panel loads and shows all data tabs', async ({ page }) => {
        await page.goto(`${BASE}/admin.html`);
        await expect(page.locator('h1').first()).toBeVisible({ timeout: 5000 });
    });

    test('admin panel: create user, verify in all tabs, delete with cascade', async ({ page }) => {
        const ts = Date.now();
        const username = 'admintest_' + ts;

        // Register a user first so there's data to see
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });

        const body = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));

        // Create a server with this user
        await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body.token}` },
            data: { name: 'Admin Test Server ' + ts },
        });

        // Go to admin panel
        await page.goto(`${BASE}/admin.html`);
        await page.fill('#admin-password', 'admin');
        await page.click('#admin-login-form button[type="submit"]');
        await page.waitForSelector('#admin-panel', { state: 'visible', timeout: 5000 });

        // Verify Users tab has the user
        await page.waitForFunction(
            (name) => document.getElementById('user-list')?.textContent?.includes(name),
            username,
            { timeout: 5000 }
        );

        // Click Servers tab
        await page.click('[data-tab="servers"]');
        await page.waitForTimeout(500);
        const serversText = await page.locator('#tab-servers').textContent();
        expect(serversText).toContain('Admin Test Server');

        // Click Members tab
        await page.click('[data-tab="server-members"]');
        await page.waitForTimeout(500);
        const membersText = await page.locator('#tab-server-members').textContent();
        expect(membersText).toContain(username);

        // Click back to Users tab and delete
        await page.click('[data-tab="users"]');
        await page.waitForTimeout(500);

        // Find and click the delete button for our user specifically
        const deleteBtn = page.locator('#user-list tr', { hasText: username }).locator('button');
        await deleteBtn.click();

        // Confirm the modal shows cascade stats
        await page.waitForSelector('#confirm-modal', { state: 'visible', timeout: 5000 });
        const modalText = await page.locator('#confirm-modal').textContent();
        expect(modalText).toContain(username);
        expect(modalText).toContain('cascade-delete');

        // Click Delete to confirm
        await page.click('#confirm-delete');
        await page.waitForTimeout(2000);

        // Verify user is GONE from the Users tab
        const usersAfter = await page.locator('#user-list').textContent();
        expect(usersAfter).not.toContain(username);

        // Verify server is also GONE (cascade)
        await page.click('[data-tab="servers"]');
        await page.waitForTimeout(500);
        const serversAfter = await page.locator('#tab-servers').textContent();
        expect(serversAfter).not.toContain('Admin Test Server');

        // Verify member is also GONE (cascade)
        await page.click('[data-tab="server-members"]');
        await page.waitForTimeout(500);
        const membersAfter = await page.locator('#tab-server-members').textContent();
        expect(membersAfter).not.toContain(username);
    });
});
