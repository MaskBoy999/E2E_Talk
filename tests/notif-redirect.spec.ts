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

test.describe('Notification Redirect Clear', () => {

    test('clicking notification clears badge and inbox item', async ({ page, context }) => {
        const ts = Date.now();
        const user1Name = 'nra_alice_' + ts;
        const user2Name = 'nra_bob_' + ts;

        // Register User A
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', user1Name);
        await page.fill('#register-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });
        const body1 = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
            friendCode: localStorage.getItem('e2e_friend_code'),
        }));
        expect(body1.token).toBeTruthy();

        // Register User B
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await page2.goto(`${BASE}/login.html`);
        await page2.waitForTimeout(500);
        await page2.click('#show-register');
        await page2.fill('#register-username', user2Name);
        await page2.fill('#register-password', 'password123');
        await page2.click('#register-form button[type="submit"]');
        await page2.waitForURL('**/index.html', { timeout: 10000 });
        const body2 = await page2.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));
        expect(body2.token).toBeTruthy();

        // Get User B's public key
        const user2PubKeyB64 = await page2.evaluate(() => {
            return E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey);
        });

        // Create server for User A
        const inviteCode = generateCode(8);
        const srvRes = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body1.token}` },
            data: { name: 'Notif Redirect Test', invite_code_hash: sha256Hex(inviteCode) },
        });
        const server = await srvRes.json();
        expect(server.id).toBeTruthy();

        // Upload server key for User A
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

        // Set up invite
        const invRes = await page.request.post(`${BASE}/api/servers/${server.id}/invite`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { invite_code_hash: sha256Hex(inviteCode) },
        });
        await invRes.json();

        // User B joins
        const joinRes = await page.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${body2.token}` },
            data: { code: inviteCode },
        });
        await joinRes.json();

        // Upload server key for User B
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

        // Create a second channel via API so User A can be in one while being mentioned in the other
        const ch2Res = await page.request.post(`${BASE}/api/servers/${server.id}/channels`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { name: 'other' },
        });
        const ch2 = await ch2Res.json();
        console.log('Channel 2 ID:', ch2.id);

        // User A loads chat, selects first channel
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        const chItems = page.locator('.channel-item');
        const chCount = await chItems.count();
        console.log('Channels:', chCount);
        await chItems.nth(0).click();
        await page.waitForTimeout(500);

        // User B loads chat, selects the SECOND channel
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForSelector('.server-icon', { timeout: 10000 });
        await page2.click('.server-icon:not(.add-server)');
        await page2.waitForSelector('.channel-item', { timeout: 10000 });
        const chItems2 = page2.locator('.channel-item');
        const chCount2 = await chItems2.count();
        console.log('User B channels:', chCount2);
        // Click the second channel (index 1)
        await chItems2.nth(1).click();
        await page2.waitForTimeout(1500);

        // Both should have enabled inputs
        const input1 = page.locator('#message-input');
        await expect(input1).toBeEnabled({ timeout: 5000 });
        const input2 = page2.locator('#message-input');
        await expect(input2).toBeEnabled({ timeout: 5000 });

        // User B sends a mention of User A in channel 2
        await input2.fill('@' + user1Name + ' hello from Bob!');
        await page2.click('#send-btn');
        await page2.waitForTimeout(2000);

        // Wait for bell badge on User A (mention notification for channel 2)
        await page.waitForSelector('#mentions-strip-btn .badge:not([style*="none"])', { timeout: 15000 });

        // Open notification inbox on User A
        await page.click('#mentions-strip-btn');
        await page.waitForSelector('#mentions-panel', { state: 'visible', timeout: 5000 });
        await page.waitForTimeout(500);

        // Count notification items
        const itemsBefore = page.locator('.mention-inbox-item');
        const countBefore = await itemsBefore.count();
        console.log('Inbox items before click:', countBefore);
        expect(countBefore).toBeGreaterThanOrEqual(1);

        const itemServerId = await itemsBefore.first().getAttribute('data-server-id');
        const itemChannelId = await itemsBefore.first().getAttribute('data-channel-id');
        console.log('Item server:', itemServerId, 'channel:', itemChannelId);

        // Click the first notification
        await itemsBefore.first().click();
        await page.waitForTimeout(2000);

        // Bell badge should be hidden (display: none)
        const badge = page.locator('#mentions-strip-btn .badge');
        await expect(badge).not.toBeVisible({ timeout: 5000 });

        // Reopen the inbox
        await page.click('#mentions-strip-btn');
        await page.waitForSelector('#mentions-panel', { state: 'visible', timeout: 5000 });
        await page.waitForTimeout(500);

        // Inbox should show "No unread notifications"
        const inboxText = await page.locator('#mentions-inbox-list').textContent();
        expect(inboxText).toContain('No unread notifications');

        // Close
        await page2.close();
        await ctx2.close();
    });

});
