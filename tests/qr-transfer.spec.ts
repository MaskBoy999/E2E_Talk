import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

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

    // Tests for the old "Connect with Local Key" feature and identity key QR display
    // have been removed since that feature was replaced by key escrow (encrypting
    // the private key with the password on register, decrypting on login).
});
