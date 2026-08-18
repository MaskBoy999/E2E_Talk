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

    test('Clear All Data wipes everything; re-login restores keys from the server blob', async ({ page }) => {
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

        // 5. The wipe is intentional: ALL local data (including identity keys)
        //    is cleared, and the login page's logged-out wipe guarantees it.
        //    Nothing must survive for a stale account to leak into a new one.
        const wipedAfter = await page.evaluate(() => {
            const keys: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k) keys.push(k);
            }
            return {
                hasIdentity: keys.some(k => k.startsWith('e2e_identity_private_')),
                hasHmac: keys.indexOf('e2e_hmac_key') !== -1,
                hasToken: keys.indexOf('token') !== -1,
                count: keys.length,
            };
        });
        expect(wipedAfter.hasToken).toBe(false);
        expect(wipedAfter.hasIdentity).toBe(false, 'Identity keys should be wiped by Clear All Data');
        expect(wipedAfter.hasHmac).toBe(false);

        // 6. Re-login
        await loginUser(page, username, password);
        await page.waitForTimeout(2000);

        // 7. Verify we're logged in and on the chat page
        const currentUser = await page.evaluate(() => {
            const el = document.getElementById('current-user');
            return el ? el.textContent : null;
        });
        expect(currentUser).toBe(username);

        // 8. Verify identity keys were restored from the server key blob
        const hasIdentityAfterLogin = await page.evaluate(() => {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('e2e_identity_private_')) return true;
            }
            return false;
        });
        expect(hasIdentityAfterLogin).toBe(true, 'Identity keys should be restored from the key blob after re-login');
    });

    test('Session expiry redirects to login page, which wipes ALL leftover keys; re-login restores from blob', async ({ page }) => {
        const username = randomId();
        const password = 'TestPass123!';

        // 1. Register user
        await registerUser(page, username, password);
        await page.waitForTimeout(2000);

        // 2. Verify we have a reasonable set of keys
        const allKeysBefore = await page.evaluate(() => {
            const keys: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                keys.push(localStorage.key(i)!);
            }
            return keys.sort();
        });
        expect(allKeysBefore.length).toBeGreaterThan(5);
        expect(allKeysBefore.some(k => k.startsWith('e2e_identity_private_'))).toBe(true);
        expect(allKeysBefore.some(k => k === 'e2e_hmac_key')).toBe(true);

        // 3. Simulate session expiry exactly like checkTokenExpiry(): the
        //    token + user are dropped and the browser is sent to login.html.
        //    (There is no separate "Sign Out Only" button anymore — signing
        //    out and clearing data both land on the login page logged-out,
        //    where the full wipe runs.)
        await page.evaluate(() => {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
        });
        await page.goto('/login.html');
        await page.waitForSelector('#login-form', { timeout: 15000 });

        // 4. The logged-out login page wipes EVERYTHING (identity, hmac,
        //    server keys, friend code, device key, settings, audio cache).
        const allKeysAfter = await page.evaluate(() => {
            const keys: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                keys.push(localStorage.key(i)!);
            }
            return keys.sort();
        });
        // The wipe removes every account key; only the deliberately-preserved
        // media caches may remain (fkc_*, profile key cache, display-name
        // cache — they hold no account secrets and keep avatars/names alive
        // across the forced re-login).
        const preserved = ['profile_key_cache', 'user_display_name_cache'];
        const staleAfter = allKeysAfter.filter((k: string) =>
            !k.startsWith('fkc_') && preserved.indexOf(k) === -1);
        expect(staleAfter, 'Login page wipe should leave only preserved media caches').toEqual([]);

        // 5. Re-login restores keys from the server blob.
        await loginUser(page, username, password);
        await page.waitForTimeout(2000);

        // Verify we're on the chat page
        await page.waitForSelector('#channel-list', { timeout: 10000 });
        const currentUser = await page.evaluate(() => {
            const el = document.getElementById('current-user');
            return el ? el.textContent : null;
        });
        expect(currentUser).toBe(username);

        const hasIdentity = await page.evaluate(() => {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('e2e_identity_private_')) return true;
            }
            return false;
        });
        expect(hasIdentity).toBe(true, 'Identity keys should be restored from the key blob after re-login');
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
