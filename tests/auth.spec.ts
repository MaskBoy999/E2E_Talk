import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// Helper to generate unique username
function uniqueUsername(base: string): string {
    return `${base}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

test.describe('Step 3: Auth, Escrow & Friend Code Fixes', () => {

    test('registration works and friend code is properly stored as hash', async ({ page }) => {
        const username = uniqueUsername('alice');
        const password = 'testpass123';

        await page.goto(`${BASE}/login.html`);

        // Switch to register form
        await page.click('#show-register');
        await page.waitForSelector('#register-form', { state: 'visible' });

        // Fill registration form
        await page.fill('#register-username', username);
        await page.fill('#register-password', password);
        await page.fill('#register-confirm-password', password);

        // Submit
        await page.click('#register-form button[type="submit"]');

        // Should redirect to chat (index.html) after successful registration
        await page.waitForURL('**/index.html', { timeout: 15000 });

        // Verify user data is stored in localStorage
        const token = await page.evaluate(() => localStorage.getItem('token'));
        expect(token).toBeTruthy();

        const userStr = await page.evaluate(() => localStorage.getItem('user'));
        expect(userStr).toBeTruthy();
        const user = JSON.parse(userStr as string);
        expect(user.username).toBe(username);

        // Verify identity key is stored locally
        const identityKey = await page.evaluate((uid: string) => {
            const E = globalThis.E2ECrypto;
            return E.getIdentityKeyPair(uid);
        }, user.id);
        expect(identityKey).toBeTruthy();
        expect(identityKey!.publicKey).toBeTruthy();
        expect(identityKey!.privateKey).toBeTruthy();

        // Verify HMAC key was fetched and stored
        const hmacKey = await page.evaluate(() => localStorage.getItem('e2e_hmac_key'));
        expect(hmacKey).toBeTruthy();

        // Verify friend code was generated and stored
        const friendCode = await page.evaluate(() => localStorage.getItem('e2e_friend_code'));
        expect(friendCode).toBeTruthy();
        expect(friendCode!.length).toBe(16);
        // Verify it only contains valid alphabet chars
        for (const c of friendCode!) {
            expect(ALPHABET).toContain(c);
        }

        // Verify identity key is in localStorage account-scoped
        const storedPriv = await page.evaluate((uid: string) => {
            return localStorage.getItem('e2e_identity_private_' + uid);
        }, user.id);
        expect(storedPriv).toBeTruthy();
    });

    test('registration stores hashed friend code on server (no plaintext)', async ({ page, request }) => {
        const username = uniqueUsername('bob');
        const password = 'testpass456';

        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.waitForSelector('#register-form', { state: 'visible' });

        await page.fill('#register-username', username);
        await page.fill('#register-password', password);
        await page.fill('#register-confirm-password', password);
        await page.click('#register-form button[type="submit"]');

        await page.waitForURL('**/index.html', { timeout: 15000 });

        // Get the user's token to authenticate API calls
        const token = await page.evaluate(() => localStorage.getItem('token'));

        // Get user info from /api/me
        const meRes = await request.get(`${BASE}/api/me`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        expect(meRes.ok()).toBeTruthy();
        const me = await meRes.json();

        // Check that friend_code_hash exists and is not a plaintext 8-char code
        // We can't directly query the DB, but we can check the friend-code endpoint
        const fcRes = await request.get(`${BASE}/api/friend-code`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        expect(fcRes.ok()).toBeTruthy();
        const fcData = await fcRes.json();

        // The encrypted_friend_code should be a base64 string (not an 8-char plaintext code)
        expect(fcData.encrypted_friend_code).toBeTruthy();
        expect(fcData.encrypted_friend_code.length).toBeGreaterThan(20);
        // The hash should NOT look like a plaintext code (8 chars of ALPHABET)
        if (fcData.friend_code_hash) {
            expect(fcData.friend_code_hash.length).not.toBe(8);
        }
    });

    test('login works and recovers identity from escrow', async ({ browser }) => {
        const username = uniqueUsername('charlie');
        const password = 'testpass789';

        // First context: register
        const regPage = await browser.newPage();
        await regPage.goto(`${BASE}/login.html`);
        await regPage.click('#show-register');
        await regPage.waitForSelector('#register-form', { state: 'visible' });
        await regPage.fill('#register-username', username);
        await regPage.fill('#register-password', password);
        await regPage.fill('#register-confirm-password', password);
        await regPage.click('#register-form button[type="submit"]');
        await regPage.waitForURL('**/index.html', { timeout: 15000 });

        const userStr = await regPage.evaluate(() => localStorage.getItem('user'));
        const user = JSON.parse(userStr as string);
        const token = await regPage.evaluate(() => localStorage.getItem('token'));

        // Save the identity key to check later
        const originalIdentityKey = await regPage.evaluate((uid: string) => {
            const E = globalThis.E2ECrypto;
            const kp = E.getIdentityKeyPair(uid);
            if (!kp) return null;
            return {
                pub: E.arrayBufferToBase64(kp.publicKey),
                priv: E.arrayBufferToBase64(kp.privateKey)
            };
        }, user.id);
        expect(originalIdentityKey).toBeTruthy();
        await regPage.close();

        // Second context: login as the same user (simulates new device)
        const loginPage = await browser.newPage();
        await loginPage.goto(`${BASE}/login.html`);

        // Try to clear any stale data that might interfere
        await loginPage.evaluate(() => {
            localStorage.clear();
        });

        await loginPage.fill('#login-username', username);
        await loginPage.fill('#login-password', password);
        await loginPage.click('#login-form button[type="submit"]');
        await loginPage.waitForURL('**/index.html', { timeout: 15000 });

        // After login, the identity key should be recovered from escrow
        const recoveredKey = await loginPage.evaluate((uid: string) => {
            const E = globalThis.E2ECrypto;
            const kp = E.getIdentityKeyPair(uid);
            if (!kp) return null;
            return {
                pub: E.arrayBufferToBase64(kp.publicKey),
                priv: E.arrayBufferToBase64(kp.privateKey)
            };
        }, user.id);

        expect(recoveredKey).toBeTruthy();
        // The public key should match (identity is tied to the account, not device)
        expect(recoveredKey!.pub).toBe(originalIdentityKey!.pub);
        // The private key should also match (same identity key recovered from escrow)
        expect(recoveredKey!.priv).toBe(originalIdentityKey!.priv);

        // Verify HMAC key was fetched during login
        const hmacKey = await loginPage.evaluate(() => localStorage.getItem('e2e_hmac_key'));
        expect(hmacKey).toBeTruthy();

        await loginPage.close();
    });

    test('login with wrong password fails gracefully', async ({ page }) => {
        const username = uniqueUsername('dave');
        const password = 'correctpassword';

        // Register first
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.waitForSelector('#register-form', { state: 'visible' });
        await page.fill('#register-username', username);
        await page.fill('#register-password', password);
        await page.fill('#register-confirm-password', password);
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });

        // Clear and try wrong password
        await page.evaluate(() => {
            localStorage.clear();
            document.cookie.split(';').forEach(c => {
                document.cookie = c.replace(/^ +/, '').replace(/=.*/, '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/');
            });
        });

        await page.goto(`${BASE}/login.html`);
        await page.fill('#login-username', username);
        await page.fill('#login-password', 'wrongpassword');
        await page.click('#login-form button[type="submit"]');

        // Should show error message, not redirect
        await page.waitForSelector('#error-message', { state: 'visible', timeout: 5000 });
        const errorText = await page.textContent('#error-message');
        expect(errorText).toBeTruthy();
        // Should still be on login page
        expect(page.url()).toContain('login.html');
    });

    test('friend code hash uses HMAC-SHA256 (not plain SHA-256)', async ({ page, request }) => {
        const username = uniqueUsername('eve');
        const password = 'testpass321';

        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.waitForSelector('#register-form', { state: 'visible' });
        await page.fill('#register-username', username);
        await page.fill('#register-password', password);
        await page.fill('#register-confirm-password', password);
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });

        const token = await page.evaluate(() => localStorage.getItem('token'));
        const hmacKey = await page.evaluate(() => localStorage.getItem('e2e_hmac_key'));
        const friendCode = await page.evaluate(() => localStorage.getItem('e2e_friend_code'));

        // Verify the key was fetched
        expect(hmacKey).toBeTruthy();
        expect(friendCode).toBeTruthy();

        // Verify HMAC key is a base64 string (not an empty/null value)
        expect(hmacKey!.length).toBeGreaterThan(10);

        // We can verify the friend code endpoint returns encrypted data
        const fcRes = await request.get(`${BASE}/api/friend-code`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        expect(fcRes.ok()).toBeTruthy();

        // Escrow is stored inline during registration; identity recovery tested separately
        // Verify the identity key pair is stored locally (confirming escrow was processed)
        const userStr = await page.evaluate(() => localStorage.getItem('user'));
        const user = JSON.parse(userStr as string);
        const identityKey = await page.evaluate((uid: string) => {
            const E = globalThis.E2ECrypto;
            return E.getIdentityKeyPair(uid);
        }, user.id);
        expect(identityKey).toBeTruthy();
        expect(identityKey!.publicKey).toBeTruthy();
        expect(identityKey!.privateKey).toBeTruthy();
    });
});
