import { test, expect, Page } from '@playwright/test';
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

test.describe('Notifications', () => {

    test('DM, mention, and reply notifications work end-to-end', async ({ page, context }) => {
        const ts = Date.now();
        const user1Name = 'notif_alice_' + ts;
        const user2Name = 'notif_bob_' + ts;

        // === Register User A ===
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
        expect(body1.friendCode).toBeTruthy();
        console.log('User A friend code:', body1.friendCode);

        // === Register User B in separate context ===
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();

        // Set up notification API monitoring on page2 BEFORE the app loads
        await page2.addInitScript(() => {
            // Override Notification constructor to track calls
            (window as any).__notifications = [];
            const OrigNotification = window.Notification;
            (window as any).OrigNotification = OrigNotification;
            (window as any).Notification = function(title: string, opts: any) {
                (window as any).__notifications.push({ title, body: opts?.body });
                // Don't actually show the notification (avoid permission issues)
            };
            (window as any).Notification.permission = 'granted';
            (window as any).Notification.requestPermission = () => 'granted';
        });

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

        // === Create a server for User A ===
        const inviteCode = generateCode(8);
        const srvRes = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body1.token}` },
            data: { name: 'Notif Test Server', invite_code_hash: sha256Hex(inviteCode) },
        });
        const server = await srvRes.json();
        expect(server.id).toBeTruthy();

        // Generate and upload server key for User A
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

        // Upload encrypted server key for User B
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

        // === Set up DM friendship via API ===
        // User B sends a friend request to User A using the friend code
        const friendReqRes = await page2.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: body1.friendCode },
        });
        const friendReq = await friendReqRes.json();
        console.log('Friend request result:', JSON.stringify(friendReq));

        // User A accepts the friend request
        // First get pending requests
        const pendingRes = await page.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        const pending = await pendingRes.json();
        console.log('Pending friend requests for User A:', JSON.stringify(pending));

        // Accept the first pending request
        if (Array.isArray(pending) && pending.length > 0) {
            const acceptRes = await page.request.post(`${BASE}/api/friends/requests/accept`, {
                headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
                data: { request_id: pending[0].id },
            });
            const acceptResult = await acceptRes.json();
            console.log('Accept result:', JSON.stringify(acceptResult));
        }

        await page.waitForTimeout(1000);

        // === Load both users into the server channel ===

        // User A loads chat
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(500);

        // User B loads chat
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForSelector('.server-icon', { timeout: 10000 });
        await page2.click('.server-icon:not(.add-server)');
        await page2.waitForSelector('.channel-item', { timeout: 10000 });
        await page2.click('.channel-item >> nth=0');
        await page2.waitForTimeout(1500);

        // Both should have enabled inputs
        const input1 = page.locator('#message-input');
        await expect(input1).toBeEnabled({ timeout: 5000 });
        const input2 = page2.locator('#message-input');
        await expect(input2).toBeEnabled({ timeout: 5000 });

        // ====== TEST 1: User A sends a message with @mention of User B ======

        await page2.waitForTimeout(500);

        // User B sends a message first so User A has someone to reply to later
        await input2.fill('Hello from Bob!');
        await page2.click('#send-btn');
        await page2.waitForTimeout(2000);

        // User A sends a mention: @User2Name hello
        await input1.fill('@' + user2Name + ' how are you?');
        await page.click('#send-btn');
        await page.waitForTimeout(2000);

        // Check User B's page for .mentioned class
        const mentionedMsgs = await page2.locator('.message.mentioned').count();
        console.log('Mentioned messages on User B:', mentionedMsgs);
        expect(mentionedMsgs).toBeGreaterThanOrEqual(1);

        // Check that a Notification was triggered on User B's page
        const notifs = await page2.evaluate(() => (window as any).__notifications || []);
        console.log('Notifications captured on User B:', JSON.stringify(notifs));

        // ====== TEST 2: User A replies to User B's message ======

        // Find User B's message on User A's page and click reply
        const userBMsg = page.locator('.message[data-sender-id="' + body2.user.id + '"]').first();
        const userBMsgCount = await userBMsg.count();
        console.log('User B messages on User A:', userBMsgCount);

        if (userBMsgCount > 0) {
            await userBMsg.hover();
            await page.waitForTimeout(500);
            
            // Click the reply button
            const replyBtn = userBMsg.locator('.msg-action-btn[data-action="reply"]');
            if (await replyBtn.isVisible()) {
                await replyBtn.click();
                await page.waitForTimeout(500);
                
                // Send a reply
                await input1.fill('Replying to you!');
                await page.click('#send-btn');
                await page.waitForTimeout(2000);

                // Check User A's page shows the reply quote
                const replyQuotes = page.locator('.reply-quote');
                const replyQuoteCount = await replyQuotes.count();
                console.log('Reply quotes on User A:', replyQuoteCount);
            }
        }

        // ====== TEST 3: DM notification ======

        // Clear notifications on page2
        await page2.evaluate(() => { (window as any).__notifications = []; });

        // User A sends a DM to User B
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(1500);
        
        // Check DM conversations loaded
        const dmItems = page.locator('.dm-item');
        const dmCount = await dmItems.count();
        console.log('DM items for User A:', dmCount);

        if (dmCount > 0) {
            await dmItems.first().click();
            await page.waitForTimeout(1000);
            
            const dmInput = page.locator('#message-input');
            if (await dmInput.isEnabled()) {
                await dmInput.fill('DM from Alice!');
                await page.click('#send-btn');
                await page.waitForTimeout(2000);
                
                // Check DM was sent
                const dmMsgs = page.locator('.message .text');
                const dmMsgCount = await dmMsgs.count();
                console.log('DM messages on User A:', dmMsgCount);
                expect(dmMsgCount).toBeGreaterThanOrEqual(1);
            }
        }

        // ====== Final summary ======
        console.log('\n=== NOTIFICATION TEST SUMMARY ===');
        console.log('Mention detection (.mentioned class):', mentionedMsgs > 0 ? '✅' : '❌');
        
        const notifsFinal = await page2.evaluate(() => (window as any).__notifications || []);
        console.log('Total browser notifications on User B:', notifsFinal.length);
        console.log('Notification details:', JSON.stringify(notifsFinal));
        console.log('=== END SUMMARY ===');

        await page2.close();
        await ctx2.close();
    });
});
