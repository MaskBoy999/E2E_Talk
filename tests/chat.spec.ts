import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';

test.describe('E2E Chat', () => {

    test('login page loads', async ({ page }) => {
        await page.goto(`${BASE}/login.html`);
        await expect(page.locator('h1').first()).toContainText('E2E Chat');
    });

    test('register via API, send and receive encrypted message', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'alice_' + ts;
        const user2 = 'bob_' + ts;

        const reg1 = await page.request.post(`${BASE}/api/register`, {
            data: { username: user1, password: 'password123' },
        });
        const body1 = await reg1.json();
        expect(body1.token).toBeTruthy();

        const reg2 = await page.request.post(`${BASE}/api/register`, {
            data: { username: user2, password: 'password123' },
        });
        const body2 = await reg2.json();

        // User1 loads chat
        await page.goto(`${BASE}/index.html`);
        await page.evaluate(({ token, user }) => {
            localStorage.setItem('token', token);
            localStorage.setItem('user', JSON.stringify(user));
        }, { token: body1.token, user: body1.user });
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(500);

        // User2 loads chat in new context
        const ctx2 = await page.context().browser()!.newContext();
        const page2 = await ctx2.newPage();
        await page2.goto(`${BASE}/index.html`);
        await page2.evaluate(({ token, user }) => {
            localStorage.setItem('token', token);
            localStorage.setItem('user', JSON.stringify(user));
        }, { token: body2.token, user: body2.user });
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForSelector('.channel-item', { timeout: 10000 });
        await page2.click('.channel-item >> nth=0');
        await page2.waitForTimeout(500);

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

    test('reload preserves decrypted messages', async ({ page }) => {
        const reg = await page.request.post(`${BASE}/api/register`, {
            data: { username: 'reload_' + Date.now(), password: 'password123' },
        });
        const body = await reg.json();

        await page.goto(`${BASE}/index.html`);
        await page.evaluate(({ token, user }) => {
            localStorage.setItem('token', token);
            localStorage.setItem('user', JSON.stringify(user));
        }, { token: body.token, user: body.user });
        await page.goto(`${BASE}/index.html`);
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
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(1500);

        expect(await page.locator('.message .text').allTextContents()).toContainEqual('Persistent!');
    });

    test('server only stores ciphertext', async ({ page }) => {
        const reg = await page.request.post(`${BASE}/api/register`, {
            data: { username: 'ct_' + Date.now(), password: 'password123' },
        });
        const body = await reg.json();

        await page.goto(`${BASE}/index.html`);
        await page.evaluate(({ token, user }) => {
            localStorage.setItem('token', token);
            localStorage.setItem('user', JSON.stringify(user));
        }, { token: body.token, user: body.user });
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(500);

        const input = page.locator('#message-input');
        await expect(input).toBeEnabled({ timeout: 5000 });
        await input.fill('Server should not read this');
        await page.click('#send-btn');
        await page.waitForTimeout(1500);

        const channels = await (await page.request.get(`${BASE}/api/channels`)).json();
        const msgs = await (await page.request.get(`${BASE}/api/channels/${channels[0].id}/messages`)).json();
        expect(msgs.length).toBeGreaterThanOrEqual(1);
        for (const m of msgs) {
            expect(m).toHaveProperty('encrypted_content');
            expect(m).toHaveProperty('nonce');
            expect(m).not.toHaveProperty('content');
        }
    });

    test('admin panel loads', async ({ page }) => {
        await page.goto(`${BASE}/admin.html`);
        await expect(page.locator('h1').first()).toBeVisible({ timeout: 5000 });
    });
});
