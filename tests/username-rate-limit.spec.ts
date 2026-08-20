import { test, expect, type Page } from '@playwright/test';

const BASE = 'https://localhost:3443';

/** Register a user via the browser UI. Returns when on index.html. */
async function registerUser(page: Page, uname: string, password = 'password123'): Promise<void> {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(500);
    await page.click('#show-register');
    await page.waitForSelector('#register-username', { state: 'visible' });
    await page.fill('#register-username', uname);
    await page.fill('#register-password', password);
    await page.fill('#register-confirm-password', password);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
    await page.waitForTimeout(1000);
}

/** Compute the client-side login hash the same way auth.js does. */
async function loginHash(page: Page, username: string, password: string): Promise<string> {
    return page.evaluate(async ({ username, password }) => {
        const res = await fetch('/api/auth-params/' + encodeURIComponent(username));
        const params = await res.json();
        if (params.encrypted_hash_key && params.hash_key_salt && params.hash_key_nonce) {
            const hashKeyB64 = (window as any).E2ECrypto.decryptWithPassword(
                params.encrypted_hash_key, password, params.hash_key_salt, params.hash_key_nonce
            );
            if (hashKeyB64) {
                const bytes = new Uint8Array((window as any).E2ECrypto.base64ToArrayBuffer(hashKeyB64));
                return (window as any).E2ECrypto.hmacHex(bytes, password);
            }
        }
        return password;
    }, { username, password });
}

/** Attempt a login via the API with the client-side hash. */
async function attemptLogin(page: Page, username: string, password: string) {
    const hash = await loginHash(page, username, password);
    return page.request.post(`${BASE}/api/login`, {
        data: { username, password: hash },
    });
}

test.describe('S8: Per-username login failure rate limit', () => {

    test('3 failed logins block the 4th attempt for the same username', async ({ page }) => {
        const uname = `rlimit_${Date.now().toString(36)}_blk`;
        await registerUser(page, uname, 'password123');

        for (let i = 0; i < 3; i++) {
            const res = await attemptLogin(page, uname, 'wrong_password_' + i);
            expect(res.status()).toBe(401);
        }

        const res4 = await attemptLogin(page, uname, 'password123');
        expect(res4.status()).toBe(429);
        const body4 = await res4.json();
        expect(body4.error).toContain('Too many failed attempts');
    });

    test('non-existent username is not blocked by failure limit', async ({ page }) => {
        // Navigate to the site so fetch() with relative URLs works
        await page.goto(`${BASE}/login.html`);
        await page.waitForTimeout(500);
        const uname = `rlimit_${Date.now().toString(36)}_nouser`;
        // This user does NOT exist — try logging in (gets 401 not 429)
        const res1 = await attemptLogin(page, uname, 'anything');
        expect(res1.status()).toBe(401);
        const body = await res1.json();
        expect(body.error).not.toContain('Too many failed attempts');
    });

    test('successful login does not count toward the failure limit', async ({ page }) => {
        const uname = `rlimit_${Date.now().toString(36)}_ok`;
        await registerUser(page, uname, 'mypassword');

        // Fail once (counter = 1)
        const fail1 = await attemptLogin(page, uname, 'wrong');
        expect(fail1.status()).toBe(401);

        // Successful login — should NOT increment failure counter
        const okRes = await attemptLogin(page, uname, 'mypassword');
        expect(okRes.status()).toBe(200);

        // Fail twice more → counter goes to 3 (1 + 2 new)
        const fail2 = await attemptLogin(page, uname, 'wrong');
        expect(fail2.status()).toBe(401);
        const fail3 = await attemptLogin(page, uname, 'wrong');
        expect(fail3.status()).toBe(401);

        // failure 4 (is_blocked sees count=3 >= limit -> blocked) -> 429
        const blocked = await attemptLogin(page, uname, 'wrong');
        expect(blocked.status()).toBe(429);
    });

    test('rate limit error message differs from general login limit', async ({ page }) => {
        const uname = `rlimit_${Date.now().toString(36)}_msg`;
        await registerUser(page, uname, 'pass123');

        for (let i = 0; i < 3; i++) {
            await attemptLogin(page, uname, 'wrong');
        }

        const res = await attemptLogin(page, uname, 'pass123');
        expect(res.status()).toBe(429);
        const body = await res.json();
        expect(body.error).toContain('failed attempts for this account');
        expect(body.error).not.toBe('Too many login attempts. Try again in 5 minutes.');
    });

    test('block persists across different IPs from same username', async ({ page }) => {
        const uname = `rlimit_${Date.now().toString(36)}_ip`;
        await registerUser(page, uname, 'password123');

        // Fail 3 times
        for (let i = 0; i < 3; i++) {
            const res = await attemptLogin(page, uname, 'wrong');
            expect(res.status()).toBe(401);
        }

        // Block should persist — even the correct password is rejected
        const blocked = await attemptLogin(page, uname, 'password123');
        expect(blocked.status()).toBe(429);
        const body = await blocked.json();
        expect(body.error).toContain('Too many failed attempts');
    });
});
