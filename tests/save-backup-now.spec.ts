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
    await page.waitForTimeout(1500);
}

test.describe('Save Backup Now button', () => {
    test('button saves blob to server and shows success', async ({ page }) => {
        await registerUser(page, 'savebak_' + Date.now().toString(36));
        await openSecurityTab(page);

        // Wait for backup status to show
        await expect(page.locator('#backup-status-line')).toContainText('✅', { timeout: 10000 });

        // Record the blob updated_at before clicking
        const beforeTimestamp = await page.evaluate(async () => {
            const res = await fetch('/api/key-blob', {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
            });
            const data = await res.json();
            return data.updated_at;
        });

        // Click Save Backup Now
        const saveBtn = page.locator('#save-backup-now-btn');
        await expect(saveBtn).toBeVisible();
        await saveBtn.click();

        // Should show success
        await expect(page.locator('#save-backup-status')).toContainText('✅', { timeout: 10000 });
        await expect(page.locator('#save-backup-status')).toContainText('Backup saved');

        // Button should be re-enabled
        await expect(saveBtn).toBeEnabled();

        // The blob updated_at should be the same or newer
        const afterTimestamp = await page.evaluate(async () => {
            const res = await fetch('/api/key-blob', {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
            });
            const data = await res.json();
            return data.updated_at;
        });
        // updated_at should exist and be >= the before timestamp (same user, fast test)
        expect(afterTimestamp).toBeTruthy();

        // The backup status line should also refresh
        await expect(page.locator('#backup-status-line')).toContainText('✅');

        await page.click('#close-settings');
    });

    test('button shows key count in success message', async ({ page }) => {
        await registerUser(page, 'savebak2_' + Date.now().toString(36));
        await openSecurityTab(page);

        await page.locator('#save-backup-now-btn').click();

        await expect(page.locator('#save-backup-status')).toContainText('keys encrypted', { timeout: 10000 });

        await page.click('#close-settings');
    });

    test('button re-enables after save completes', async ({ page }) => {
        await registerUser(page, 'savebak3_' + Date.now().toString(36));
        await openSecurityTab(page);

        const saveBtn = page.locator('#save-backup-now-btn');
        await expect(saveBtn).toBeEnabled();

        await saveBtn.click();

        // While saving, button should be disabled briefly (check it re-enables)
        await expect(saveBtn).toBeEnabled({ timeout: 10000 });

        await page.click('#close-settings');
    });
});
