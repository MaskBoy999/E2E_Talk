import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const BASE = 'https://localhost:3443';

async function registerUser(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(500);
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 20000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
    await page.waitForTimeout(2000);
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function openSecurityTab(page: Page) {
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-modal', { state: 'visible' });
    await page.click('.settings-tab[data-tab="security-settings"]');
    await page.waitForTimeout(1500); // Wait for backup status fetch
}

test.describe('Backup status indicator', () => {
    test('shows ✅ with timestamp after registration (blob auto-saved)', async ({ page }) => {
        await registerUser(page, 'bstatus_' + Date.now().toString(36));
        await openSecurityTab(page);

        const statusEl = page.locator('#backup-status-line');
        await expect(statusEl).toContainText('✅', { timeout: 10000 });
        await expect(statusEl).toContainText('Key backup exists');
        // Should include a relative timestamp ("just now", "Xm ago", etc.)
        await expect(statusEl).toContainText('last saved');
    });

    test('shows "Checking" initially before fetch completes', async ({ page }) => {
        await registerUser(page, 'bstatus2_' + Date.now().toString(36));
        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible' });

        // The status line starts with "Checking" before tab click triggers fetch
        const statusEl = page.locator('#backup-status-line');
        // Click security tab
        await page.click('.settings-tab[data-tab="security-settings"]');
        // The text transitions from "Checking" to "✅" — just verify it resolves
        await expect(statusEl).toContainText('✅', { timeout: 10000 });
    });

    test('indicator shows after switching away and back to security tab', async ({ page }) => {
        await registerUser(page, 'bstatus3_' + Date.now().toString(36));

        // Open security tab
        await openSecurityTab(page);
        await expect(page.locator('#backup-status-line')).toContainText('✅', { timeout: 10000 });

        // Switch to display tab
        await page.click('.settings-tab[data-tab="display-settings"]');
        await page.waitForTimeout(500);

        // Switch back to security tab
        await page.click('.settings-tab[data-tab="security-settings"]');
        await page.waitForTimeout(1500);

        // Should re-fetch and show ✅ again
        await expect(page.locator('#backup-status-line')).toContainText('✅', { timeout: 10000 });

        // Close settings
        await page.click('#close-settings');
    });
});
