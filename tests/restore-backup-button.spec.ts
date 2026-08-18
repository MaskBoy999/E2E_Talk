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
    await page.waitForTimeout(500);
}

async function closeSettings(page: Page) {
    await page.click('#close-settings');
    await page.waitForSelector('#settings-modal', { state: 'hidden', timeout: 5000 });
}

test.describe('Settings → Security: Restore from Server Backup button', () => {
    test('restore button appears in security settings and restores keys from blob', async ({ page }) => {
        const { token, user } = await registerUser(page, 'restorebtn_' + Date.now().toString(36));

        // Wait for identity keys to be ready after registration
        await page.waitForFunction(() => {
            try { return !!E2ECrypto.getIdentityKeyPair(); }
            catch { return false; }
        }, { timeout: 10000 });

        // Verify blob exists on server
        const blobRes = await page.request.get(`${BASE}/api/key-blob`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(blobRes.ok()).toBeTruthy();
        const blobData = await blobRes.json();
        expect(blobData.encrypted_blob).toBeTruthy();

        // Open Settings → Security
        await openSecurityTab(page);

        // Verify restore button exists
        const restoreBtn = page.locator('#restore-backup-btn');
        await expect(restoreBtn).toBeVisible();

        // Click restore button — should reveal password section
        await restoreBtn.click();
        await page.waitForSelector('#restore-backup-section', { state: 'visible', timeout: 5000 });
        const section = page.locator('#restore-backup-section');
        await expect(section).toBeVisible();

        // Wipe identity keys + media caches to simulate broken state
        await page.evaluate(() => {
            const uid = JSON.parse(localStorage.getItem('user') || '{}').id;
            localStorage.removeItem('e2e_identity_private_' + uid);
            localStorage.removeItem('e2e_identity_public_' + uid);
            const keys: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && (k.startsWith('fkc_') || k === 'profile_key_cache')) keys.push(k);
            }
            keys.forEach(k => localStorage.removeItem(k));
        });

        // Verify keys are gone
        const keysGone = await page.evaluate(() => {
            try { return !E2ECrypto.getIdentityKeyPair(); }
            catch { return true; }
        });
        expect(keysGone).toBe(true);

        // Enter password and click Restore
        await page.locator('#restore-backup-password').fill('password123');
        await page.click('#restore-backup-confirm-btn');

        // Wait for success
        await expect(page.locator('#restore-backup-status')).toContainText('✅', { timeout: 15000 });

        // Verify keys are restored
        const keysRestored = await page.evaluate(() => {
            try { return !!E2ECrypto.getIdentityKeyPair(); }
            catch { return false; }
        });
        expect(keysRestored).toBe(true);

        await closeSettings(page);
    });

    test('wrong password shows error', async ({ page }) => {
        const { user } = await registerUser(page, 'restorebad_' + Date.now().toString(36));

        await openSecurityTab(page);
        await page.click('#restore-backup-btn');
        await page.waitForSelector('#restore-backup-section', { state: 'visible', timeout: 5000 });
        await page.locator('#restore-backup-password').fill('wrongpassword');
        await page.click('#restore-backup-confirm-btn');

        await expect(page.locator('#restore-backup-status')).toContainText('❌', { timeout: 10000 });

        await closeSettings(page);
    });

    test('cancel button closes restore section', async ({ page }) => {
        await registerUser(page, 'restorecancel_' + Date.now().toString(36));

        await openSecurityTab(page);
        await page.click('#restore-backup-btn');
        await page.waitForSelector('#restore-backup-section', { state: 'visible', timeout: 5000 });

        await page.click('#restore-backup-cancel-btn');
        await expect(page.locator('#restore-backup-section')).toBeHidden({ timeout: 3000 });

        await closeSettings(page);
    });

    test('toggle password visibility works', async ({ page }) => {
        await registerUser(page, 'restorevis_' + Date.now().toString(36));

        await openSecurityTab(page);
        await page.click('#restore-backup-btn');
        await page.waitForSelector('#restore-backup-section', { state: 'visible', timeout: 5000 });

        const pwInput = page.locator('#restore-backup-password');
        const toggleBtn = page.locator('#toggle-restore-backup-password');

        await expect(pwInput).toHaveAttribute('type', 'password');

        await toggleBtn.click();
        await expect(pwInput).toHaveAttribute('type', 'text');

        await toggleBtn.click();
        await expect(pwInput).toHaveAttribute('type', 'password');

        await closeSettings(page);
    });
});
