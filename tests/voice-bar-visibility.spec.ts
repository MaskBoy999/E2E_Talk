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

test.describe('voice bar visibility vs popup', () => {
    test('floating voice bar hides while the voice popup is open', async ({ page }) => {
        const ts = Date.now();
        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push('PAGEERROR: ' + err.message));
        await registerUser(page, 'vbar_' + ts);

        // Create a server with a voice channel via the API
        await page.click('#add-server-btn');
        await page.click('#choice-create-server');
        await page.fill('#new-server-name', 'VBarTest_' + ts);
        await page.click('#confirm-create-server');
        await page.waitForSelector('.server-icon[data-id]', { timeout: 10000 });
        const serverId = await page.evaluate(() => document.querySelector('.server-icon[data-id]')!.getAttribute('data-id'));
        const token = await page.evaluate(() => localStorage.getItem('token'));

        const encName = await page.evaluate(async (name) => {
            const k = E2ECrypto.base64ToArrayBuffer(localStorage.getItem('e2e_server_' + document.querySelector('.server-icon[data-id]')!.getAttribute('data-id')));
            return E2ECrypto.aeadEncrypt(name, new Uint8Array(k));
        }, 'General');
        const createCh = await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { encrypted_name: encName.ciphertext, name_nonce: encName.nonce, channel_type: 'voice' },
        });
        expect(createCh.ok()).toBeTruthy();
        const chJson = await createCh.json();
        const channelId = chJson.id;

        // Join the voice channel → bar should be visible
        await page.click(`.server-icon[data-id="${serverId}"]`);
        await page.waitForSelector(`.channel-item[data-id="${channelId}"]`, { timeout: 10000 });
        await page.click(`.channel-item[data-id="${channelId}"]`);
        await page.waitForSelector('#voice-bar', { timeout: 10000 });
        const barVisibleAfterJoin = await page.evaluate(() => {
            const b = document.getElementById('voice-bar');
            return b ? getComputedStyle(b).display !== 'none' : false;
        });
        expect(barVisibleAfterJoin).toBe(true);

        // Open the popup (click the voice channel again) → bar should hide
        await page.click(`.channel-item[data-id="${channelId}"]`);
        await page.waitForSelector('#voice-popup', { state: 'visible', timeout: 10000 });
        await page.waitForTimeout(300);
        const barHiddenWithPopup = await page.evaluate(() => {
            const b = document.getElementById('voice-bar');
            return b ? getComputedStyle(b).display === 'none' : true;
        });
        expect(barHiddenWithPopup).toBe(true);

        // Close the popup → bar returns
        await page.click('#voice-popup-close');
        await page.waitForTimeout(300);
        const barBackAfterClose = await page.evaluate(() => {
            const b = document.getElementById('voice-bar');
            return b ? getComputedStyle(b).display !== 'none' : false;
        });
        expect(barBackAfterClose).toBe(true);

        expect(errors).toEqual([]);
    });
});
