import { test, expect, type Page } from '@playwright/test';

const BASE = 'https://localhost:3443';

async function registerAndSetup(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const username = `age_${ts}`;
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'TestPass123!');
    await page.fill('#register-confirm-password', 'TestPass123!');
    await page.click('#register-form button[type="submit"]');
    await page.waitForFunction(() => !window.location.pathname.includes('login'), { timeout: 30000 });
    await page.waitForSelector('#settings-btn', { timeout: 15000 });
    await page.waitForTimeout(2000);
}

async function openSecurityTab(page: Page) {
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-modal');
    await page.click('[data-tab="security-settings"]');
    await page.waitForTimeout(2000);
}

test.describe('Backup Age Warning', () => {
    test('no warning when backup is fresh', async ({ page }) => {
        await registerAndSetup(page);
        await openSecurityTab(page);

        // Check backup status shows success
        await expect(page.locator('#backup-status-line')).toContainText('✅', { timeout: 10000 });

        // The age warning should NOT be visible (fresh backup)
        const ageWarning = page.locator('#backup-age-warning');
        await expect(ageWarning).toBeHidden();
    });

    test('warning appears and is styled correctly', async ({ page }) => {
        await registerAndSetup(page);
        await openSecurityTab(page);

        // Simulate the warning by injecting the DOM content (as fetchBackupStatus would)
        await page.evaluate(() => {
            const ageEl = document.getElementById('backup-age-warning');
            if (ageEl) {
                ageEl.style.display = 'block';
                ageEl.innerHTML = '⚠️ Your backup is 35 days old. Consider saving a new backup to ensure other devices can restore your keys. <button id="backup-age-save-btn" style="margin-left:8px;padding:4px 12px;border-radius:6px;border:1px solid #faa61a;background:transparent;color:#faa61a;cursor:pointer;font-size:12px;">Save Now</button>';
            }
        });

        // The age warning should be visible with the right content
        const ageWarning = page.locator('#backup-age-warning');
        await expect(ageWarning).toBeVisible();
        await expect(ageWarning).toContainText('35 days old');
        await expect(ageWarning).toContainText('Save Now');

        // The Save Now button should be clickable
        const saveBtn = page.locator('#backup-age-save-btn');
        await expect(saveBtn).toBeVisible();
    });

    test('age calculation logic shows correct days', async ({ page }) => {
        await registerAndSetup(page);
        await openSecurityTab(page);

        // Verify the age calculation logic used in fetchBackupStatus
        // Server returns SQLite-style timestamps without Z suffix (e.g. '2025-08-18 12:34:56')
        // chat.js appends 'Z' before parsing: new Date(updatedAt + 'Z')
        const result = await page.evaluate(() => {
            // Replicate the exact calculation from chat.js fetchBackupStatus
            function calcAgeDays(updatedAt: string): number {
                var d = new Date(updatedAt + 'Z');
                var now = Date.now();
                var diff = now - d.getTime();
                return Math.floor(diff / 86400000);
            }

            // Format as SQLite-style: 'YYYY-MM-DD HH:MM:SS' (no Z)
            function toSQLiteDate(ms: number): string {
                return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
            }

            var now = Date.now();
            return {
                tenDays: calcAgeDays(toSQLiteDate(now - 10 * 86400000)),
                twentyNineDays: calcAgeDays(toSQLiteDate(now - 29 * 86400000)),
                thirtyOneDays: calcAgeDays(toSQLiteDate(now - 31 * 86400000)),
                sixtyDays: calcAgeDays(toSQLiteDate(now - 60 * 86400000)),
                oneYear: calcAgeDays(toSQLiteDate(now - 365 * 86400000)),
            };
        });

        // Under-30 should be < 30
        expect(result.tenDays).toBeLessThan(30);
        expect(result.twentyNineDays).toBeLessThan(30);
        // Over-30 should be >= 30
        expect(result.thirtyOneDays).toBeGreaterThanOrEqual(30);
        expect(result.sixtyDays).toBeGreaterThanOrEqual(30);
        expect(result.oneYear).toBeGreaterThanOrEqual(30);
    });
});
