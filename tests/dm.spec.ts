import { test, expect } from '@playwright/test';
import { type BrowserContext } from '@playwright/test';

const BASE = 'http://localhost:3000';

test.describe('Direct Messages', () => {

    test('direct messages: user registration + DM creation works', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'dmuser1_' + ts;
        const user2 = 'dmuser2_' + ts;

        // Register user1 to get identity key
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', user1);
        await page.fill('#register-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });
        const body1 = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
            identityKey: E2ECrypto.getIdentityKeyPair(),
        }));
        expect(body1.token).toBeTruthy();

        // Register user2 in separate browser context
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await page2.goto(`${BASE}/login.html`);
        await page2.waitForTimeout(1000);
        await page2.click('#show-register');
        await page2.fill('#register-username', user2);
        await page2.fill('#register-password', 'password123');
        await page2.click('#register-form button[type="submit"]');
        await page2.waitForURL('**/index.html', { timeout: 10000 });
        const body2 = await page2.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
            identityKey: E2ECrypto.getIdentityKeyPair(),
        }));
        expect(body2.token).toBeTruthy();

        // Extract user2's public key from the browser context
        const user2PubKeyB64 = await page2.evaluate(() => {
            return E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey);
        });

        // User1 visits the DM view via the DM strip
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('#dm-strip-btn');
        await page.click('#dm-strip-btn');
        await page.waitForSelector('.dm-list', { timeout: 2000 });

        // New DM starts search for user2
        await page.click('#new-dm-btn');
        await page.waitForSelector('#dm-search-modal', { timeout: 2000 });
        await page.fill('#dm-username-input', user2);
        await page.click('#confirm-dm-search');
        await page.waitForTimeout(2000);

        // Should show DM channel with user2
        await page.waitForSelector('.dm-item');
        const dmItemText = await page.locator('.dm-item').first().textContent();
        expect(dmItemText).toContain(user2);

        await page2.close();
        await ctx2.close();
    });

    test('direct messages: send and receive encrypted message', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'alice_' + ts;
        const user2 = 'bob_' + ts;

        // Register user1
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

        // Register user2 in a separate context (already-authed pages redirect away from login)
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await page2.goto(`${BASE}/login.html`);
        await page2.waitForTimeout(1000);
        await page2.click('#show-register');
        await page2.fill('#register-username', user2);
        await page2.fill('#register-password', 'password123');
        await page2.click('#register-form button[type="submit"]');
        await page2.waitForURL('**/index.html', { timeout: 10000 });
        const body2 = await page2.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));
        expect(body2.token).toBeTruthy();

        // User1 creates DM with user2
        await page.goto(`${BASE}/index.html`);
        await page.click('#dm-strip-btn');
        await page.waitForSelector('#dm-list', { timeout: 2000 });
        await page.click('#new-dm-btn');
        await page.waitForSelector('#dm-search-modal', { timeout: 2000 });
        await page.fill('#dm-username-input', user2);
        await page.click('#confirm-dm-search');
        await page.waitForTimeout(2000);

        // Send message from user1 to user2
        await page.fill('#message-input', 'Hello from DM, user2!');
        await page.click('#send-btn');
        await page.waitForTimeout(1000);

        // User2 should see the message in their DM view
        await page2.goto(`${BASE}/index.html`);
        await page2.click('#dm-strip-btn');
        await page2.waitForSelector('.dm-item');
        await page2.click('.dm-item');

        // Wait for message to appear and decrypt
        await page2.waitForSelector('.text');
        await page2.waitForTimeout(2000);

        // Verify the message was received and can be decrypted
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

        // Register user1
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

        // Register user2 in a separate context
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await page2.goto(`${BASE}/login.html`);
        await page2.waitForTimeout(1000);
        await page2.click('#show-register');
        await page2.fill('#register-username', user2);
        await page2.fill('#register-password', 'password123');
        await page2.click('#register-form button[type="submit"]');
        await page2.waitForURL('**/index.html', { timeout: 10000 });
        const body2 = await page2.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));

        // User2's identity key
        const user2IdentityKey = await page2.evaluate(() => {
            return E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey);
        });

        // User1 creates DM with user2
        await page.goto(`${BASE}/index.html`);
        await page.click('#dm-strip-btn');
        await page.waitForSelector('#dm-list', { timeout: 2000 });
        await page.click('#new-dm-btn');
        await page.waitForSelector('#dm-search-modal', { timeout: 2000 });
        await page.fill('#dm-username-input', user2);
        await page.click('#confirm-dm-search');
        await page.waitForTimeout(2000);

        // Send a message
        await page.fill('#message-input', 'Secret DM message');
        await page.click('#send-btn');
        await page.waitForTimeout(1000);

        // Verify the message is stored encrypted on the server (via API)
        const convRes = await page.request.get(`${BASE}/api/dm/conversations`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        const conversations = await convRes.json();
        expect(Array.isArray(conversations)).toBe(true);
        expect(conversations.length).toBeGreaterThanOrEqual(1);
        const dmChannelId = conversations[0].dm_channel_id;

        const msgsRes = await page.request.get(`${BASE}/api/dm/${dmChannelId}/messages`, {
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

        await page2.close();
        await ctx2.close();
    });
});
