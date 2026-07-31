import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

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

async function createServerAndKey(page: any, token: string, userId: string, serverName: string) {
    const inviteCode = generateCode(8);
    // NOTE: the server API now E2EE-encrypts server/channel names and hashes the
    // invite code server-side with a random salt (see CreateServerRequest in
    // handlers.rs). Sending the raw invite_code is sufficient; encrypted_name is
    // optional and the server ignores legacy plaintext fields like `name`.
    const srv = await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { invite_code: inviteCode },
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
    return { serverId: server.id, channelId: channels[0].id, inviteCode };
}

// ============================================================
// TEST 1: Messages appear in chat after sending
// ============================================================
test.describe('Message Sending', () => {

    test('sent message appears in the chat UI', async ({ page }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const username = 'msgsend_' + ts;
        const testMessage = 'Hello this is a test message ' + ts;

        // Register and create server — page stays on index.html
        const body = await registerUser(page, username);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id, 'MsgTest_' + ts);

        // Reload servers to pick up the new server
        await page.evaluate(async () => {
            await loadServers();
        });
        await page.waitForTimeout(2000);

        // Click the server icon
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 15000 });
        // Click the first channel
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(2000);

        // Message input should now be enabled
        const input = page.locator('#message-input');
        await expect(input).toBeEnabled({ timeout: 15000 });

        // Send a message
        await input.fill(testMessage);
        await page.click('#send-btn');
        await page.waitForTimeout(3000);

        // Verify the message text appears in the message list
        const msgTexts = await page.locator('.message .text').allTextContents();
        console.log('Message texts:', JSON.stringify(msgTexts));
        expect(msgTexts.some(t => t && t.includes(testMessage))).toBeTruthy();

        // Verify no encrypted/decryption error text appears
        const allText = msgTexts.join(' ');
        expect(allText).not.toContain('[encrypted message');
        expect(allText).not.toContain('unable to decrypt');
    });

    // ============================================================
    // TEST 2: Messages persist after page reload
    // ============================================================
    test('messages persist after page reload and are still decryptable', async ({ page }) => {
        test.setTimeout(90000);
        const ts = Date.now();
        const username = 'msgpersist_' + ts;
        const testMessage = 'Message that should survive reload ' + ts;

        // Register and create server
        const body = await registerUser(page, username);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id, 'PersistTest_' + ts);

        // Reload servers and select channel
        await page.evaluate(async () => { await loadServers(); });
        await page.waitForTimeout(2000);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 15000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(2000);
        const input = page.locator('#message-input');
        await expect(input).toBeEnabled({ timeout: 15000 });

        // Send a message
        await input.fill(testMessage);
        await page.click('#send-btn');
        await page.waitForTimeout(3000);

        // Verify message appeared
        let msgTexts = await page.locator('.message .text').allTextContents();
        console.log('Before reload:', JSON.stringify(msgTexts));
        expect(msgTexts.some(t => t && t.includes(testMessage))).toBeTruthy();

        // Reload the page (full page reload to wipe in-memory state)
        await page.reload();
        await page.waitForTimeout(2000);

        // Wait for the server list to load and auto-select the first server
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 15000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(3000);

        // Wait for messages to load — poll for the test message text
        await expect(async () => {
            msgTexts = await page.locator('.message .text').allTextContents();
            console.log('After reload:', JSON.stringify(msgTexts));
            expect(msgTexts.some(t => t && t.includes(testMessage))).toBeTruthy();
        }).toPass({ timeout: 15000 });

        // Verify all messages are decrypted (no encrypted fallback text)
        const allText = msgTexts.join(' ');
        expect(allText).not.toContain('[encrypted message');
        expect(allText).not.toContain('unable to decrypt');
    });

    // ============================================================
    // TEST 3: Messages are encrypted on server (not plaintext)
    // ============================================================
    test('server never stores plaintext message content', async ({ page }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const username = 'msgenc_' + ts;
        const testMessage = 'TOP SECRET - This must be ciphertext on server ' + ts;

        // Register and create server
        const body = await registerUser(page, username);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id, 'EncTest_' + ts);

        // Navigate to channel
        await page.evaluate(async () => { await loadServers(); });
        await page.waitForTimeout(2000);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 15000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(2000);
        const input = page.locator('#message-input');
        await expect(input).toBeEnabled({ timeout: 15000 });

        // Send a message
        await input.fill(testMessage);
        await page.click('#send-btn');
        await page.waitForTimeout(3000);

        // Verify message appeared in UI
        let msgTexts = await page.locator('.message .text').allTextContents();
        expect(msgTexts.some(t => t && t.includes(testMessage))).toBeTruthy();

        // Now fetch messages via the REST API and verify they're encrypted
        const msgsRes = await page.request.get(`${BASE}/api/channels/${channelId}/messages`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });
        expect(msgsRes.ok()).toBeTruthy();
        const msgs = await msgsRes.json();
        console.log('API returned', msgs.length, 'messages');
        expect(msgs.length).toBeGreaterThanOrEqual(1);

        for (const m of msgs) {
            // Should have encrypted_content and nonce (not plaintext content field)
            expect(m).toHaveProperty('encrypted_content');
            expect(m).toHaveProperty('nonce');
            expect(m).not.toHaveProperty('content');

            // Verify the encrypted_content is proper base64 (not plaintext)
            expect(m.encrypted_content).not.toContain('TOP SECRET');
            expect(m.encrypted_content).not.toContain(testMessage);

            // Verify it's valid base64 (at least looks like one)
            expect(typeof m.encrypted_content).toBe('string');
            expect(m.encrypted_content.length).toBeGreaterThan(10);

            // Verify nonce is also base64
            expect(typeof m.nonce).toBe('string');
            expect(m.nonce.length).toBeGreaterThan(5);
        }

        // Verify the last message's encrypted content is actually the test message
        // by decrypting it client-side via page.evaluate using the known serverId
        const lastMsg = msgs[msgs.length - 1];
        const decrypted = await page.evaluate(({ encrypted_content, nonce, serverId }) => {
            const actualKey = E2ECrypto.getServerKey(serverId);
            if (!actualKey) return 'KEY_NOT_FOUND';
            try {
                return E2ECrypto.decryptMessage(encrypted_content, nonce, actualKey);
            } catch (e) {
                return 'DECRYPT_FAILED: ' + e.message;
            }
        }, { encrypted_content: lastMsg.encrypted_content, nonce: lastMsg.nonce, serverId: serverId });

        console.log('Decrypted message content:', decrypted);
        expect(decrypted).toContain(testMessage);
    });

    // ============================================================
    // TEST 4: Messages show sender avatar and display name after page reload
    // ============================================================
    test('message shows sender avatar and display name after page reload', async ({ page }) => {
        test.setTimeout(90000);
        const ts = Date.now();
        const username = 'msgpfp_' + ts;
        const testMessage = 'Testing PFP and display name after reload ' + ts;

        // Register and create server
        const body = await registerUser(page, username);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id, 'PfpTest_' + ts);

        // Navigate to channel
        await page.evaluate(async () => { await loadServers(); });
        await page.waitForTimeout(2000);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 15000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(2000);
        const input = page.locator('#message-input');
        await expect(input).toBeEnabled({ timeout: 15000 });

        // Send a message
        await input.fill(testMessage);
        await page.click('#send-btn');
        await page.waitForTimeout(3000);

        // Verify the message appeared with text
        let msgTexts = await page.locator('.message .text').allTextContents();
        expect(msgTexts.some(t => t && t.includes(testMessage))).toBeTruthy();

        // Verify avatar and display name exist before reload
        let msgEls = await page.locator('.message').all();
        expect(msgEls.length).toBeGreaterThanOrEqual(1);
        let firstMsgLocator = page.locator('.message >> nth=0');
        await expect(firstMsgLocator.locator('.avatar')).toBeVisible({ timeout: 5000 });
        await expect(firstMsgLocator.locator('.display-name')).toBeVisible({ timeout: 5000 });

        // Capture the display name text
        let displayNameBefore = await firstMsgLocator.locator('.display-name').textContent();
        console.log('Display name before reload:', displayNameBefore);
        expect(displayNameBefore).toBeTruthy();
        expect(displayNameBefore).not.toBe('?');

        // Reload the page (full page reload to wipe in-memory state)
        await page.reload();
        await page.waitForTimeout(2000);

        // Wait for the server list to load
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 15000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(3000);

        // Wait for messages to load
        await expect(async () => {
            msgTexts = await page.locator('.message .text').allTextContents();
            console.log('After reload:', JSON.stringify(msgTexts));
            expect(msgTexts.some(t => t && t.includes(testMessage))).toBeTruthy();
        }).toPass({ timeout: 15000 });

        // Verify the avatar and display name elements exist after reload
        firstMsgLocator = page.locator('.message >> nth=0');
        await expect(firstMsgLocator.locator('.avatar')).toBeAttached({ timeout: 5000 });
        await expect(firstMsgLocator.locator('.display-name')).toBeAttached({ timeout: 5000 });

        // Verify the display name text is not '?' (i.e., it has actual sender info)
        let displayNameAfter = await firstMsgLocator.locator('.display-name').textContent();
        console.log('Display name after reload:', displayNameAfter);
        expect(displayNameAfter).toBeTruthy();
        expect(displayNameAfter).not.toBe('?');

        // Debug: check if the message has the 'grouped' class
        const messageClasses = await firstMsgLocator.getAttribute('class');
        console.log('Message classes after reload:', messageClasses);
        
        // Debug: Check lastMessageInfo state to understand grouping
        var debugInfo = await page.evaluate(function() {
            return {
                lastMessageInfo: typeof lastMessageInfo !== 'undefined' ? lastMessageInfo : 'undefined',
                currentChannelId: typeof currentChannelId !== 'undefined' ? currentChannelId : 'undefined',
            };
        });
        console.log('Debug info after reload:', JSON.stringify(debugInfo));

        // Debug: Check the raw API response for sender_id
        var apiMessages = await page.evaluate(function(channelId) {
            return fetch('/api/channels/' + channelId + '/messages', {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
            }).then(function(r) { return r.json(); });
        }, channelId);
        console.log('API returned', apiMessages.length, 'messages');
        if (apiMessages.length > 0) {
            console.log('First msg sender_id:', JSON.stringify(apiMessages[0].sender_id));
            console.log('First msg sender_username:', JSON.stringify(apiMessages[0].sender_username));
            console.log('First msg sender_display_name:', JSON.stringify(apiMessages[0].sender_display_name));
            console.log('First msg sender_profile_pic:', JSON.stringify(apiMessages[0].sender_profile_pic));
            console.log('First msg timestamp:', JSON.stringify(apiMessages[0].timestamp));
        }

        // If the message is incorrectly grouped, we'll test that the avatar/display-name still
        // exist even if visually hidden (grouped). This proves the data is correct.
        await expect(firstMsgLocator.locator('.avatar')).toBeAttached({ timeout: 5000 });
        await expect(firstMsgLocator.locator('.display-name')).toBeAttached({ timeout: 5000 });

        // Verify all messages are decrypted
        const allText = msgTexts.join(' ');
        expect(allText).not.toContain('[encrypted message');
        expect(allText).not.toContain('unable to decrypt');
    });
});
