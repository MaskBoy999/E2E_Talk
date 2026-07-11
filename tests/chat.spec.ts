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

        // Register both users
        const reg1 = await page.request.post(`${BASE}/api/register`, {
            data: { username: user1, password: 'password123' },
        });
        const body1 = await reg1.json();
        expect(body1.token).toBeTruthy();

        const reg2 = await page.request.post(`${BASE}/api/register`, {
            data: { username: user2, password: 'password123' },
        });
        const body2 = await reg2.json();

        // User1 creates a server
        const srv = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body1.token}` },
            data: { name: 'Test Server' },
        });
        const server = await srv.json();
        expect(server.id).toBeTruthy();

        // User1 gets the default #general channel
        const chRes = await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        const channels = await chRes.json();
        expect(channels.length).toBeGreaterThanOrEqual(1);
        const generalChannel = channels.find((c: any) => c.name === 'general') || channels[0];

        // User1 generates invite
        const invRes = await page.request.post(`${BASE}/api/servers/${server.id}/invite`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        const invite = await invRes.json();
        expect(invite.code).toBeTruthy();

        // User2 joins via invite
        const joinRes = await page.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${body2.token}` },
            data: { code: invite.code },
        });
        const joined = await joinRes.json();
        expect(joined.id).toBe(server.id);

        // User1 loads chat
        await page.goto(`${BASE}/index.html`);
        await page.evaluate(({ token, user }) => {
            localStorage.setItem('token', token);
            localStorage.setItem('user', JSON.stringify(user));
        }, { token: body1.token, user: body1.user });
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon', { timeout: 10000 });
        // Click first server icon (not the + button)
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(500);

        // User2 loads chat
        const ctx2 = await page.context().browser()!.newContext();
        const page2 = await ctx2.newPage();
        await page2.goto(`${BASE}/index.html`);
        await page2.evaluate(({ token, user }) => {
            localStorage.setItem('token', token);
            localStorage.setItem('user', JSON.stringify(user));
        }, { token: body2.token, user: body2.user });
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForSelector('.server-icon', { timeout: 10000 });
        await page2.click('.server-icon:not(.add-server)');
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
        const ts = Date.now();
        const username = 'reload_' + ts;

        const reg = await page.request.post(`${BASE}/api/register`, {
            data: { username, password: 'password123' },
        });
        const body = await reg.json();

        // Create server
        const srv = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body.token}` },
            data: { name: 'Reload Server' },
        });
        const server = await srv.json();

        await page.goto(`${BASE}/index.html`);
        await page.evaluate(({ token, user }) => {
            localStorage.setItem('token', token);
            localStorage.setItem('user', JSON.stringify(user));
        }, { token: body.token, user: body.user });
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

        const reg = await page.request.post(`${BASE}/api/register`, {
            data: { username, password: 'password123' },
        });
        const body = await reg.json();

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

        await page.goto(`${BASE}/index.html`);
        await page.evaluate(({ token, user }) => {
            localStorage.setItem('token', token);
            localStorage.setItem('user', JSON.stringify(user));
        }, { token: body.token, user: body.user });
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

    test('admin panel loads', async ({ page }) => {
        await page.goto(`${BASE}/admin.html`);
        await expect(page.locator('h1').first()).toBeVisible({ timeout: 5000 });
    });
});
