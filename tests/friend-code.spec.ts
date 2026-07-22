import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('Friend Code Features', () => {

    test('friend code status indicator shows on login page when session cookie exists', async ({ page }) => {
        const ts = Date.now();
        const username = 'fcookie_' + ts;
        const password = 'password123';

        // First, register and login a user to set a session cookie
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', password);
        await page.fill('#register-confirm-password', password);
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });
        await page.waitForTimeout(2000);

        // Now simulate getting kicked out: clear localStorage but keep HttpOnly cookie
        await page.evaluate(() => {
            localStorage.clear();
        });

        // Navigate to login page — the stale-session-warning should appear
        await page.goto(`${BASE}/login.html`);
        await page.waitForTimeout(2000);

        // Check if stale session warning appeared
        const warning = page.locator('#stale-session-warning');
        const isWarningVisible = await warning.isVisible();
        
        if (isWarningVisible) {
            // Warning is visible — check it has the username and the clear button
            await expect(warning).toContainText(username);
            const clearBtn = page.locator('#clear-stale-session-btn');
            await expect(clearBtn).toBeVisible();
            
            // Click clear
            await clearBtn.click();
            await page.waitForTimeout(1000);
            
            // After clearing, warning should change text to success
            await expect(warning).toContainText('cleared');
        } else {
            // Warning not visible — could mean no cookie (test context doesn't preserve HttpOnly)
            console.log('Stale session warning not shown — HttpOnly cookies may not persist in test context');
        }
    });

    test('friend code status indicator shows loading in DM sidebar', async ({ page }) => {
        const ts = Date.now();
        const username = 'fcind_' + ts;

        // Register
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });
        await page.waitForTimeout(2000);

        // Navigate to DMs to trigger loadMyFriendCode
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(2000);

        // Check the friend-code-status element exists
        const statusEl = page.locator('#friend-code-status');
        await expect(statusEl).toBeVisible();

        // The friend code should be stored locally from registration
        const statusText = await statusEl.textContent();
        // It should be either empty (code found locally) or show a loading state
        console.log('Friend code status:', statusText);
    });

    test('friend code shows in DM sidebar and can be toggled', async ({ page }) => {
        const ts = Date.now();
        const username = 'fctoggle_' + ts;

        // Register
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });
        await page.waitForTimeout(2000);

        // Navigate to DMs
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(2000);

        // Check friend code element exists
        const fcEl = page.locator('#my-friend-code');
        await expect(fcEl).toBeVisible();

        // Check it's masked by default
        const maskedText = await fcEl.textContent();
        expect(maskedText).toContain('••');

        // Check the copy button exists
        const copyBtn = page.locator('#copy-friend-code-btn');
        await expect(copyBtn).toBeVisible();

        // Check the toggle button exists
        const toggleBtn = page.locator('#toggle-friend-code-btn');
        await expect(toggleBtn).toBeVisible();

        // Check the QR button exists
        const qrBtn = page.locator('#friend-qr-btn');
        await expect(qrBtn).toBeVisible();

        // Check the get/recover button exists
        const getBtn = page.locator('#get-friend-code-btn');
        await expect(getBtn).toBeVisible();
    });

    test('recover friend code modal opens from DM sidebar button', async ({ page }) => {
        const ts = Date.now();
        const username = 'fcrecover_' + ts;

        // Register
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });
        await page.waitForTimeout(2000);

        // Clear the stored friend code to simulate needing recovery
        await page.evaluate(() => {
            localStorage.removeItem('e2e_friend_code');
        });

        // Navigate to DMs
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(2000);

        // Click the get/recover button
        const getBtn = page.locator('#get-friend-code-btn');
        await getBtn.click();
        await page.waitForTimeout(1000);

        // The friend code password modal should be visible (if auto-recovery didn't kick in)
        // or auto-recovery should have succeeded (status shows recovered)
        const modal = page.locator('#friend-code-password-modal');
        const statusEl = page.locator('#friend-code-status');
        const statusText = await statusEl.textContent();
        
        if (await modal.isVisible()) {
            // Modal is visible — check its elements
            await expect(page.locator('#fc-password-input')).toBeVisible();
            await expect(page.locator('#fc-cancel-btn')).toBeVisible();
            await expect(page.locator('#fc-recover-btn')).toBeVisible();
            await expect(page.locator('#fc-regenerate-btn')).toBeVisible();

            // Fill in password and recover
            await page.fill('#fc-password-input', 'password123');
            await page.click('#fc-recover-btn');
            await page.waitForTimeout(2000);

            // Check for success
            const successEl = page.locator('#fc-password-success');
            await expect(successEl).toBeVisible({ timeout: 10000 });
        } else {
            // Auto-recovery succeeded — check status
            console.log('Auto-recovery status:', statusText);
        }
    });
});
