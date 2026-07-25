import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForTimeout(2000);
    return page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

test.describe('Channel Name on Server Creation', () => {

    test('initial channel shows as "general" after creating server via UI', async ({ page }) => {
        const ts = Date.now();
        const username = 'chname_' + ts;

        // Register
        await registerUser(page, username);

        // Create server via UI
        await page.click('#add-server-btn');
        await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
        await page.click('#choice-create-server');
        await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 5000 });
        await page.fill('#new-server-name', 'ChannelNameTest');
        await page.click('#confirm-create-server');
        await page.waitForTimeout(2000);

        // Wait for server icon to appear
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });

        // Click the server to load channels
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.waitForTimeout(1000);

        // Check channel name text
        const channelTexts = await page.locator('.channel-item').allTextContents();
        console.log('Channel texts:', JSON.stringify(channelTexts));

        // The channel should show as "# general" (or similar, the exact format)
        const hasGeneral = channelTexts.some(t => t.includes('general'));
        expect(hasGeneral).toBeTruthy();

        // Also verify no channel shows as blank or empty
        for (const text of channelTexts) {
            expect(text.trim()).not.toBe('');
            expect(text.trim()).not.toBe('#');
            expect(text.trim()).not.toBe('# ');
        }
    });

    test('channel name persists as "general" after page reload', async ({ page }) => {
        const ts = Date.now();
        const username = 'chname2_' + ts;

        // Register and create server
        await registerUser(page, username);
        await page.click('#add-server-btn');
        await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
        await page.click('#choice-create-server');
        await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 5000 });
        await page.fill('#new-server-name', 'ReloadTest');
        await page.click('#confirm-create-server');
        await page.waitForTimeout(2000);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });

        // Reload the page
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.waitForTimeout(2000);

        // Verify channel still shows "general" after reload
        const channelTexts = await page.locator('.channel-item').allTextContents();
        console.log('Channel texts after reload:', JSON.stringify(channelTexts));
        const hasGeneral = channelTexts.some(t => t.includes('general'));
        expect(hasGeneral).toBeTruthy();
    });
});
