import { test, expect } from '@playwright/test';
import crypto from 'crypto';

function randomId() { return 'test_' + crypto.randomBytes(8).toString('hex'); }

async function registerUser(page: any, username: string, password: string) {
    await page.goto('/login.html');
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { timeout: 5000 });
    // Wait for register form to be visible
    await page.waitForFunction(() => {
        const f = document.getElementById('register-form');
        return f && f.style.display !== 'none';
    }, { timeout: 5000 });
    await page.fill('#register-username', username);
    await page.fill('#register-password', password);
    await page.fill('#register-confirm-password', password);
    // Click the Register submit button inside register-form
    await page.click('#register-form button[type="submit"]');
    // Wait for redirect to index.html after successful registration
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#channel-list', { timeout: 10000 });
}

async function loginUser(page: any, username: string, password: string) {
    await page.goto('/login.html');
    await page.waitForSelector('#login-form', { timeout: 10000 });
    // Ensure login form is visible
    await page.waitForFunction(() => {
        const f = document.getElementById('login-form');
        return f && f.style.display !== 'none';
    }, { timeout: 5000 });
    await page.fill('#login-username', username);
    await page.fill('#login-password', password);
    // If HMAC key was preserved, login may auto-skip
    await page.click('#login-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#channel-list', { timeout: 10000 });
}

async function openSettings(page: any) {
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-modal', { timeout: 5000 });
    // Wait for modal to be visible
    await page.waitForFunction(() => {
        const el = document.getElementById('settings-modal');
        return el && el.style.display !== 'none' && el.style.display !== '';
    }, { timeout: 5000 });
}

async function closeSettings(page: any) {
    await page.click('#close-settings');
    await page.waitForFunction(() => {
        const el = document.getElementById('settings-modal');
        return !el || el.style.display === 'none' || el.style.display === '';
    }, { timeout: 5000 }).catch(() => {});
}

test.describe('Clear Data and Sign Out Flows', () => {

    test('Clear All Data preserves encryption keys after re-login', async ({ page }) => {
        const username = randomId();
        const password = 'TestPass123!';

        // 1. Register user
        await registerUser(page, username, password);
        await page.waitForTimeout(2000);

        // 2. Verify identity keys exist in localStorage
        const hasIdentityBefore = await page.evaluate(() => {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('e2e_identity_private_')) return true;
            }
            return false;
        });
        expect(hasIdentityBefore).toBe(true);

        const hasHmacBefore = await page.evaluate(() => !!localStorage.getItem('e2e_hmac_key'));
        expect(hasHmacBefore).toBe(true);

        // 3. Open settings and click Clear All Data
        await openSettings(page);

        // Accept confirm dialog
        page.once('dialog', async (dialog: any) => {
            await dialog.accept();
        });

        await page.click('#clear-all-data-btn');

        // 4. Should redirect to login page
        await page.waitForURL('**/login.html', { timeout: 15000 });

        // 5. Check that identity keys are preserved in localStorage
        const hasIdentityAfter = await page.evaluate(() => {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('e2e_identity_private_')) return true;
            }
            return false;
        });
        expect(hasIdentityAfter).toBe(true, 'Identity keys should be preserved after clear all data');

        const hasHmacAfter = await page.evaluate(() => !!localStorage.getItem('e2e_hmac_key'));
        expect(hasHmacAfter).toBe(true, 'HMAC key should be preserved after clear all data');

        // 6. Re-login
        await loginUser(page, username, password);
        await page.waitForTimeout(2000);

        // 7. Verify we're logged in and on the chat page
        const currentUser = await page.evaluate(() => {
            const el = document.getElementById('current-user');
            return el ? el.textContent : null;
        });
        expect(currentUser).toBe(username);

        // 8. Verify identity keys still exist
        const hasIdentityAfterLogin = await page.evaluate(() => {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('e2e_identity_private_')) return true;
            }
            return false;
        });
        expect(hasIdentityAfterLogin).toBe(true, 'Identity keys should exist after re-login');
    });

    test('Sign Out Only preserves ALL keys', async ({ page }) => {
        const username = randomId();
        const password = 'TestPass123!';

        // 1. Register user
        await registerUser(page, username, password);
        await page.waitForTimeout(2000);

        // 2. Snapshot all localStorage keys
        const allKeysBefore = await page.evaluate(() => {
            const keys: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                keys.push(localStorage.key(i)!);
            }
            return keys.sort();
        });

        // Verify we have a reasonable set of keys
        expect(allKeysBefore.length).toBeGreaterThan(5);
        expect(allKeysBefore.some(k => k.startsWith('e2e_identity_private_'))).toBe(true);
        expect(allKeysBefore.some(k => k === 'e2e_hmac_key')).toBe(true);

        // 3. Open settings and click Sign Out Only
        await openSettings(page);

        page.once('dialog', async (dialog: any) => {
            await dialog.accept();
        });

        await page.click('#sign-out-only-btn');

        // 4. Should redirect to login page
        await page.waitForURL('**/login.html', { timeout: 15000 });

        // 5. Snapshot all localStorage keys after sign out
        const allKeysAfter = await page.evaluate(() => {
            const keys: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                keys.push(localStorage.key(i)!);
            }
            return keys.sort();
        });

        // 6. Verify token and user are GONE
        expect(allKeysAfter.some(k => k === 'token')).toBe(false, 'Token should be removed after sign out');
        expect(allKeysAfter.some(k => k === 'user')).toBe(false, 'User should be removed after sign out');

        // 7. Verify token and user are GONE, but ALL crypto keys are preserved
        // Log missing keys for debugging
        const missingKeys: string[] = [];
        const criticalKeys = ['e2e_hmac_key', 'e2e_device_key', 'e2e_encrypted_password', 'e2e_friend_code'];
        for (const key of criticalKeys) {
            if (!allKeysAfter.includes(key)) missingKeys.push(key);
        }
        // Also check identity private keys (at least one)
        const hasIdentityPrivate = allKeysAfter.some(k => k && k.startsWith('e2e_identity_private_'));
        if (!hasIdentityPrivate) missingKeys.push('e2e_identity_private_*');
        const hasIdentityPublic = allKeysAfter.some(k => k && k.startsWith('e2e_identity_public_'));
        if (!hasIdentityPublic) missingKeys.push('e2e_identity_public_*');

        expect(missingKeys.length).toBe(0, `Keys missing after sign out: ${missingKeys.join(', ')}`);

        // Ensure we didn't lose any e2e_server_* keys
        const serverKeysBefore2 = allKeysBefore.filter(k => k && k.startsWith('e2e_server_'));
        for (const key of serverKeysBefore2) {
            expect(allKeysAfter.includes(key)).toBe(true, `Server key '${key}' should be preserved after sign out`);
        }

        // 8. Re-login and verify everything works
        await loginUser(page, username, password);
        await page.waitForTimeout(2000);

        // Verify we're on the chat page
        await page.waitForSelector('#channel-list', { timeout: 10000 });
        const currentUser = await page.evaluate(() => {
            const el = document.getElementById('current-user');
            return el ? el.textContent : null;
        });
        expect(currentUser).toBe(username);
    });

    test('Key blob is saved before clear-all-data redirects', async ({ page }) => {
        const username = randomId();
        const password = 'TestPass123!';

        // 1. Register user
        await registerUser(page, username, password);
        await page.waitForTimeout(2000);

        // 2. Click add-server-btn to open the create/join server choice modal
        await page.waitForSelector('#add-server-btn', { timeout: 5000 });
        await page.click('#add-server-btn');
        await page.waitForSelector('#choice-create-server', { timeout: 5000 });
        await page.click('#choice-create-server');
        await page.waitForSelector('#create-server-modal', { timeout: 5000 });
        const serverName = 'TestServer_' + randomId().slice(0, 8);
        await page.fill('#new-server-name', serverName);
        await page.click('#confirm-create-server');
        await page.waitForTimeout(3000);

        // 3. Force a key blob save by waiting for debounce
        await page.waitForTimeout(4000); // Wait for 3s debounce + network

        // 4. Check blob was saved (verify via browser-side fetch)
        const blobExists = await page.evaluate(async () => {
            const tkn = localStorage.getItem('token');
            if (!tkn) return false;
            const res = await fetch('/api/key-blob', {
                headers: { 'Authorization': 'Bearer ' + tkn }
            });
            if (!res.ok) return false;
            const data = await res.json();
            return !!data.encrypted_blob;
        });
        expect(blobExists).toBe(true, 'Key blob should exist on server');

        // 5. Open settings and click Clear All Data
        await openSettings(page);

        page.once('dialog', async (dialog: any) => {
            await dialog.accept();
        });

        await page.click('#clear-all-data-btn');

        // 6. Should redirect to login page
        await page.waitForURL('**/login.html', { timeout: 15000 });

        // 7. Re-login
        await loginUser(page, username, password);
        await page.waitForTimeout(3000);

        // 8. Verify keys were restored from blob
        const hasIdentity = await page.evaluate(() => {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('e2e_identity_private_')) return true;
            }
            return false;
        });
        expect(hasIdentity).toBe(true, 'Identity keys should be restored from blob after re-login');
    });
});
