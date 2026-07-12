import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';

test.describe('QR Code Key Transfer', () => {

    async function registerUser(page: any, username: string) {
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });
        await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
        return await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));
    }

    test('settings modal shows QR code section', async ({ page }) => {
        const ts = Date.now();
        const body = await registerUser(page, 'qr_settings_' + ts);
        expect(body.token).toBeTruthy();

        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });

        const qrSection = page.locator('#qr-code-container');
        await expect(qrSection).toBeVisible();

        const showQrBtn = page.locator('#show-qr-btn');
        await expect(showQrBtn).toBeVisible();
        await expect(showQrBtn).toContainText('Show QR Code');
    });

    test('QR code displays after confirmation dialog', async ({ page }) => {
        const ts = Date.now();
        const body = await registerUser(page, 'qr_display_' + ts);
        expect(body.token).toBeTruthy();

        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });

        page.on('dialog', async dialog => {
            expect(dialog.type()).toBe('confirm');
            await dialog.accept();
        });

        await page.click('#show-qr-btn');
        await page.waitForTimeout(500);

        const qrDisplay = page.locator('#qr-code-display');
        await expect(qrDisplay).toBeVisible();

        const svgElement = page.locator('#qr-code-canvas svg');
        await expect(svgElement).toBeVisible();
    });

    test('QR code dismissed when user clicks cancel', async ({ page }) => {
        const ts = Date.now();
        const body = await registerUser(page, 'qr_cancel_' + ts);
        expect(body.token).toBeTruthy();

        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });

        page.on('dialog', async dialog => {
            await dialog.dismiss();
        });

        await page.click('#show-qr-btn');
        await page.waitForTimeout(500);

        const placeholder = page.locator('#qr-code-placeholder');
        await expect(placeholder).toBeVisible();
    });

    test('connect with key section shows QR scan button', async ({ page }) => {
        await page.goto(`${BASE}/login.html`);

        await page.click('#show-connect-key');
        await page.waitForSelector('#connect-key-section', { state: 'visible', timeout: 5000 });

        const scanBtn = page.locator('#scan-qr-btn');
        await expect(scanBtn).toBeVisible();

        const scannerSection = page.locator('#qr-scanner-section');
        await expect(scannerSection).toBeHidden();
    });

    test('connect with key form accepts pasted key', async ({ page }) => {
        const ts = Date.now();
        const user1 = 'qr_connect1_' + ts;
        const user2 = 'qr_connect2_' + ts;

        const body1 = await registerUser(page, user1);
        expect(body1.token).toBeTruthy();

        const user1Key = await page.evaluate(() => {
            return E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().privateKey);
        });

        await page.evaluate(() => {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
        });

        await registerUser(page, user2);

        await page.evaluate(() => {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
        });

        await page.goto(`${BASE}/login.html`);
        await page.click('#show-connect-key');
        await page.waitForSelector('#connect-key-section', { state: 'visible', timeout: 5000 });

        await page.fill('#connect-username', user1);
        await page.fill('#connect-password', 'password123');
        await page.fill('#connect-key-input', user1Key);

        await page.click('#connect-key-btn');
        await page.waitForURL('**/index.html', { timeout: 10000 });

        const currentToken = await page.evaluate(() => localStorage.getItem('token'));
        expect(currentToken).toBeTruthy();

        const restoredKey = await page.evaluate(() => {
            return E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().privateKey);
        });
        expect(restoredKey).toBe(user1Key);
    });

    test('connect with key shows error for invalid key', async ({ page }) => {
        const ts = Date.now();
        const username = 'qr_invalid_' + ts;

        await registerUser(page, username);

        await page.evaluate(() => {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
        });

        await page.goto(`${BASE}/login.html`);
        await page.click('#show-connect-key');
        await page.waitForSelector('#connect-key-section', { state: 'visible', timeout: 5000 });

        await page.fill('#connect-username', username);
        await page.fill('#connect-password', 'password123');
        await page.fill('#connect-key-input', 'not-a-valid-base64-key');

        await page.click('#connect-key-btn');
        await page.waitForTimeout(1000);

        const errorDiv = page.locator('#connect-key-error');
        await expect(errorDiv).toBeVisible();
        await expect(errorDiv).toContainText('Invalid key format');
    });

    test('connect with key shows error for wrong account key', async ({ page }) => {
        const ts = Date.now();
        const user1 = 'qr_wrong1_' + ts;
        const user2 = 'qr_wrong2_' + ts;

        await registerUser(page, user1);

        await page.evaluate(() => {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
        });

        await registerUser(page, user2);
        const user2Key = await page.evaluate(() => {
            return E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().privateKey);
        });

        await page.evaluate(() => {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
        });

        await page.goto(`${BASE}/login.html`);
        await page.click('#show-connect-key');
        await page.waitForSelector('#connect-key-section', { state: 'visible', timeout: 5000 });

        await page.fill('#connect-username', user1);
        await page.fill('#connect-password', 'password123');
        await page.fill('#connect-key-input', user2Key);

        await page.click('#connect-key-btn');
        await page.waitForTimeout(2000);

        const errorDiv = page.locator('#connect-key-error');
        await expect(errorDiv).toBeVisible();
        await expect(errorDiv).toContainText('does not belong to that account');
    });
});
