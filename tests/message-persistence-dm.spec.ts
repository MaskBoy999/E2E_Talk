import { test, expect } from '@playwright/test';
const BASE = 'https://localhost:3443';

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

test.describe('DM Message Persistence', () => {

    test('DM messages persist after full page refresh', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const user1 = 'dmpersist_a_' + ts;
        const user2 = 'dmpersist_b_' + ts;
        const testMessage = 'DM message that must survive reload ' + ts;

        // STEP 1: Register user2 first (in separate context)
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        expect(body2.token).toBeTruthy();

        // STEP 2: Register user1 (main page)
        const body1 = await registerUser(page, user1);
        expect(body1.token).toBeTruthy();

        // STEP 3: Become friends (user1 sends request to user2)
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

        // STEP 4: Wait for WS on both pages
        const ws1 = await waitForWs(page);
        expect(ws1).toBeTruthy();
        const ws2 = await waitForWs(page2);
        expect(ws2).toBeTruthy();

        // STEP 5: Get DM channel ID from conversations API
        let convs = await (await page.request.get(`${BASE}/api/dm/conversations`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        expect(convs.length).toBeGreaterThanOrEqual(1);
        const dmChannelId = convs[0].dm_channel_id;
        const otherUserId = convs[0].other_user_id;
        console.log('DM channel ID:', dmChannelId, 'Other user:', otherUserId);

        // STEP 6: Send a DM message via WebSocket from user1's page
        const sendResult = await page.evaluate(async ({ dmChannelId, msg, otherUserId }) => {
            // Wait for WS to be open
            for (let i = 0; i < 50; i++) {
                if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) break;
                await new Promise(r => setTimeout(r, 100));
            }
            try {
                const kp = E2ECrypto.getIdentityKeyPair();
                if (!kp) return 'NO_IDENTITY_KEY';
                const res = await fetch('/api/identity/' + otherUserId, {
                    headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
                });
                if (!res.ok) return 'IDENTITY_FETCH_FAILED: ' + res.status;
                const data = await res.json();
                if (!data.identity_public_key) return 'NO_OTHER_PUB_KEY';
                const otherPubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
                const encrypted = E2ECrypto.encryptDm(msg, dmChannelId, kp.privateKey, otherPubKey);
                ws.send(JSON.stringify({
                    type: 'dm_send',
                    dm_channel_id: dmChannelId,
                    encrypted_content: encrypted.ciphertext,
                    nonce: encrypted.nonce,
                    message_nonce: encrypted.messageNonce || null,
                }));
                return 'SENT';
            } catch (e) {
                return 'ERROR: ' + e.message;
            }
        }, { dmChannelId, msg: testMessage, otherUserId });
        console.log('DM send result:', sendResult);
        expect(sendResult).toBe('SENT');
        await page.waitForTimeout(3000);

        // STEP 7: Verify via REST API that message is on server
        let apiMsgs = [];
        for (let i = 0; i < 20; i++) {
            await page.waitForTimeout(500);
            const res = await page.request.get(`${BASE}/api/dm/${dmChannelId}/messages`, {
                headers: { Authorization: `Bearer ${body1.token}` },
            });
            if (res.ok) {
                apiMsgs = await res.json();
                if (Array.isArray(apiMsgs) && apiMsgs.length >= 1) break;
            }
        }
        console.log('API messages count:', apiMsgs.length);
        expect(apiMsgs.length).toBeGreaterThanOrEqual(1);

        // STEP 8: Navigate user1 to DM view to verify message appears in UI
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2000);
        await page.waitForSelector('#dm-strip-btn', { timeout: 10000 });
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(1500);

        // Wait for DM items to appear
        await page.waitForSelector('.dm-item', { timeout: 10000 });
        await page.click('.dm-item');
        await page.waitForTimeout(3000);

        // Check if the message is visible in the UI
        let msgTexts = await page.locator('.message .text').allTextContents();
        console.log('Before reload (UI):', JSON.stringify(msgTexts));
        expect(msgTexts.some(t => t && t.includes(testMessage))).toBeTruthy();

        // STEP 9: FULL PAGE RELOAD
        await page.reload();
        await page.waitForTimeout(3000);

        // STEP 10: Wait for initialization
        await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });

        // STEP 11: Navigate to DM view again
        await page.waitForSelector('#dm-strip-btn', { timeout: 10000 });
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(1500);

        // Wait for DM items
        let dmFound = false;
        for (let i = 0; i < 30; i++) {
            const count = await page.locator('.dm-item').count();
            if (count > 0) { dmFound = true; break; }
            await page.waitForTimeout(300);
        }
        expect(dmFound).toBeTruthy();
        await page.click('.dm-item');
        await page.waitForTimeout(4000);

        // STEP 12: Verify the DM message is still displayed after reload
        await expect(async () => {
            msgTexts = await page.locator('.message .text').allTextContents();
            console.log('After reload:', JSON.stringify(msgTexts));
            expect(msgTexts.some(t => t && t.includes(testMessage))).toBeTruthy();
        }).toPass({ timeout: 20000 });

        // STEP 13: Verify no encryption errors
        const allText = msgTexts.join(' ');
        expect(allText).not.toContain('[encrypted message');
        expect(allText).not.toContain('unable to decrypt');
        expect(allText).not.toContain('Cannot load messages');

        console.log('=== DM PERSISTENCE TEST PASSED ===');

        await page2.close();
        await ctx2.close();
    });

});
