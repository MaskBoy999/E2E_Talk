import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

async function gotoMinimalPage(page: any) {
    await page.goto(`${BASE}/test-secure-minimal.html`);
    await page.waitForFunction(() => {
        return typeof (window as any).E2ECrypto !== 'undefined'
            && typeof (window as any)._secGetRaw === 'function';
    }, { timeout: 15000 });
}

test('_secGetRaw shows encrypted form for sensitive keys', async ({ page }) => {
    await gotoMinimalPage(page);

    const result = await page.evaluate(() => {
        // Write via normal interceptor path
        localStorage.setItem('token_bypass_test', 'my-sensitive-data');

        // _secGetRaw uses _realOrigGet — should see raw encrypted value
        const raw = (window as any)._secGetRaw('token_bypass_test');
        // _secGet uses _realOrigGet too — should see decrypted value
        const decrypted = (window as any)._secGet('token_bypass_test');
        // Normal getItem goes through interceptor
        const normal = localStorage.getItem('token_bypass_test');

        // Cleanup
        localStorage.removeItem('token_bypass_test');

        return {
            raw: raw ? raw.substring(0, 50) : null,
            rawStartsWithTilde: raw !== null && raw.charAt(0) === '~',
            decryptedMatchesOriginal: decrypted === 'my-sensitive-data',
            normalMatchesOriginal: normal === 'my-sensitive-data',
        };
    });

    console.log('DEBUG raw:', result.raw);
    expect(result.rawStartsWithTilde).toBe(true);
    expect(result.decryptedMatchesOriginal).toBe(true);
    expect(result.normalMatchesOriginal).toBe(true);
});

test('sensitive keys encrypted, non-sensitive keys are not', async ({ page }) => {
    await gotoMinimalPage(page);

    const result = await page.evaluate(() => {
        // Write sensitive (starts with 'token') and non-sensitive keys
        localStorage.setItem('token_sensitive_check', 'secret123');
        localStorage.setItem('_test_plain_check', 'plaintext456');

        const rawSensitive = (window as any)._secGetRaw('token_sensitive_check');
        const rawPlain = (window as any)._secGetRaw('_test_plain_check');

        // Read via interceptor to verify round-trip
        const viaInterceptor = localStorage.getItem('token_sensitive_check');

        localStorage.removeItem('token_sensitive_check');
        localStorage.removeItem('_test_plain_check');

        return {
            rawSensitive: rawSensitive ? rawSensitive.substring(0, 50) : null,
            rawPlain: rawPlain ? rawPlain.substring(0, 50) : null,
            sensitiveEncrypted: rawSensitive !== null && rawSensitive.charAt(0) === '~',
            plainPlaintext: rawPlain === 'plaintext456',
            roundTripOk: viaInterceptor === 'secret123',
        };
    });

    console.log('DEBUG rawSensitive:', result.rawSensitive);
    console.log('DEBUG rawPlain:', result.rawPlain);
    expect(result.sensitiveEncrypted).toBe(true);
    expect(result.plainPlaintext).toBe(true);
    expect(result.roundTripOk).toBe(true);
});

test('bootstrap keys remain unencrypted', async ({ page }) => {
    await gotoMinimalPage(page);

    const result = await page.evaluate(() => {
        // Use the interceptor's fallthrough (bootstrap keys are not sensitive)
        const devKey = localStorage.getItem('e2e_device_key');
        const encPw = localStorage.getItem('e2e_encrypted_password');
        return {
            devKeyPresent: devKey !== null,
            devKeyNotEncrypted: devKey === null || devKey.charAt(0) !== '~',
            encPwPresent: encPw !== null,
            encPwNotEncrypted: encPw === null || encPw.charAt(0) !== '~',
        };
    });

    if (result.devKeyPresent) expect(result.devKeyNotEncrypted).toBe(true);
    if (result.encPwPresent) expect(result.encPwNotEncrypted).toBe(true);
});

test('interceptor gracefully handles non-existent keys', async ({ page }) => {
    await gotoMinimalPage(page);

    const result = await page.evaluate(() => {
        return {
            noToken: localStorage.getItem('token') === null,
            noUser: localStorage.getItem('user') === null,
            rawToken: (window as any)._secGetRaw('token') === null,
        };
    });

    expect(result.noToken).toBe(true);
    expect(result.noUser).toBe(true);
    expect(result.rawToken).toBe(true);
});

test('secure-storage test page passes all tests', async ({ page }) => {
    await page.goto(`${BASE}/test-secure-storage.html`);
    // Wait for summary to have actual text content (async test completion)
    await page.waitForFunction(() => {
        const s = document.getElementById('summary');
        return s && s.textContent && s.textContent.length > 0;
    }, { timeout: 30000 });

    const failEls = await page.locator('.result.fail').count();
    if (failEls > 0) {
        const failTexts = await page.locator('.result.fail').allTextContents();
        console.log('FAILURES:', JSON.stringify(failTexts));
    }
    expect(failEls).toBe(0);

    const summaryText = await page.locator('#summary').textContent();
    expect(summaryText).toContain('PASSED');
});

// ─── Cross-Device Key Derivation Tests ─────────────────────────────────

/**
 * The encryption key is DERIVED from the user's password (same across devices),
 * not from the per-device bootstrap keys. This test verifies that:
 *   - Two devices logged into the same account derive the SAME storage key
 *   - Each device has DIFFERENT bootstrap keys (e2e_device_key)
 *   - Values encrypted on one device can be read on the other
 */
test.describe('Cross-Device Storage Key', () => {

    async function registerUser(page: any, username: string, password = 'cross-device-test-pw-789') {
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register', { timeout: 10000 });
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', password);
        await page.fill('#register-confirm-password', password);
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await page.waitForTimeout(1000);
        return await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || 'null'),
        }));
    }

    async function loginUser(page: any, username: string, password = 'cross-device-test-pw-789') {
        await page.goto(`${BASE}/login.html`);
        await page.fill('#login-username', username);
        await page.fill('#login-password', password);
        await page.click('#login-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await page.waitForTimeout(1000);
        return await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || 'null'),
        }));
    }

    function uid(base: string): string {
        return `${base}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    }

    test('same password produces same derived storage key across devices', async ({ browser }) => {
        const username = uid('cross_dev_key');
        const password = 'cross-device-test-pw-789';

        // ─── Device 1: Register ──────────────────────────────────────
        const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
        const page1 = await ctx1.newPage();
        const user1Data = await registerUser(page1, username, password);
        expect(user1Data.token).toBeTruthy();
        expect(user1Data.user).toBeTruthy();

        const device1State = await page1.evaluate(() => {
            const W: any = window;
            return {
                // Storage key fingerprint (base64 of the derived key in sessionStorage)
                ssk: sessionStorage.getItem('_ssk'),
                // Bootstrap keys (should be different per device)
                devKey: (W._secGetRaw ? W._secGetRaw('e2e_device_key') : localStorage.getItem('e2e_device_key')),
                encPw: (W._secGetRaw ? W._secGetRaw('e2e_encrypted_password') : localStorage.getItem('e2e_encrypted_password')),
                // Token raw form (should be encrypted with ~)
                tokenRaw: W._secGetRaw ? W._secGetRaw('token') : null,
                // Token decrypted (should match)
                tokenDecrypted: W._secGet ? W._secGet('token') : localStorage.getItem('token'),
                // User raw form (should be encrypted with ~)
                userRaw: W._secGetRaw ? W._secGetRaw('user') : null,
                // Verify bootstrap keys are NOT encrypted
                devKeyNotEncrypted: !localStorage.getItem('e2e_device_key')?.startsWith('~'),
                encPwNotEncrypted: !localStorage.getItem('e2e_encrypted_password')?.startsWith('~'),
            };
        });

        console.log('Device 1 state:', JSON.stringify({
            sskFingerprint: device1State.ssk ? device1State.ssk.substring(0, 20) + '...' : null,
            tokenEncrypted: device1State.tokenRaw?.startsWith('~'),
            tokenMatch: device1State.tokenDecrypted?.substring(0, 20) + '...',
        }));

        // Verify encryption is working on device 1
        expect(device1State.ssk).toBeTruthy();
        expect(device1State.tokenRaw?.startsWith('~')).toBe(true);
        expect(device1State.tokenDecrypted).toBe(user1Data.token);
        expect(device1State.devKeyNotEncrypted).toBe(true);
        expect(device1State.encPwNotEncrypted).toBe(true);

        // ─── Device 2: Login (same account, new browser context) ─────
        const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
        const page2 = await ctx2.newPage();
        const user2Data = await loginUser(page2, username, password);
        expect(user2Data.token).toBeTruthy();
        // Same user ID (sub) across devices — the JWT payload is the same even
        // though the exp (expiration) changes on each login.
        expect(user2Data.user?.id).toBe(user1Data.user?.id);

        const device2State = await page2.evaluate(() => {
            const W: any = window;
            return {
                ssk: sessionStorage.getItem('_ssk'),
                devKey: (W._secGetRaw ? W._secGetRaw('e2e_device_key') : localStorage.getItem('e2e_device_key')),
                encPw: (W._secGetRaw ? W._secGetRaw('e2e_encrypted_password') : localStorage.getItem('e2e_encrypted_password')),
                tokenRaw: W._secGetRaw ? W._secGetRaw('token') : null,
                tokenDecrypted: W._secGet ? W._secGet('token') : localStorage.getItem('token'),
                userRaw: W._secGetRaw ? W._secGetRaw('user') : null,
                devKeyNotEncrypted: !localStorage.getItem('e2e_device_key')?.startsWith('~'),
                encPwNotEncrypted: !localStorage.getItem('e2e_encrypted_password')?.startsWith('~'),
            };
        });

        console.log('Device 2 state:', JSON.stringify({
            sskFingerprint: device2State.ssk ? device2State.ssk.substring(0, 20) + '...' : null,
            tokenEncrypted: device2State.tokenRaw?.startsWith('~'),
            tokenMatch: device2State.tokenDecrypted?.substring(0, 20) + '...',
            devKeySame: device1State.devKey === device2State.devKey,
            encPwSame: device1State.encPw === device2State.encPw,
            sskSame: device1State.ssk === device2State.ssk,
        }));

        // ─── Assertions ──────────────────────────────────────────────

        // CRITICAL: The derived storage key MUST be the same across devices
        // because it's derived from the PASSWORD, not from device-specific keys.
        expect(device2State.ssk).toBe(device1State.ssk);

        // The token is properly encrypted on device 2 (starts with ~)
        expect(device2State.tokenRaw?.startsWith('~')).toBe(true);

        // The decrypted token contains the same user (sub claim)
        // Note: we can't compare full tokens because `exp` changes per login.
        function parseJwtPayload(jwt: string): any {
            try {
                return JSON.parse(atob(jwt.split('.')[1]));
            } catch { return {}; }
        }
        const payload1 = parseJwtPayload(user1Data.token!);
        const payload2 = parseJwtPayload(device2State.tokenDecrypted!);
        expect(payload2.sub).toBe(payload1.sub);  // Same user ID

        // Bootstrap keys (e2e_device_key) MUST be different per device
        // since each device generates its own random device key.
        expect(device2State.devKey).not.toBe(device1State.devKey);
        expect(device2State.encPw).not.toBe(device1State.encPw);

        // Bootstrap keys must NOT be encrypted (they need to be readable
        // to bootstrap the key derivation on each page load)
        expect(device2State.devKeyNotEncrypted).toBe(true);
        expect(device2State.encPwNotEncrypted).toBe(true);

        // Encryption must be working on device 2
        expect(device2State.tokenRaw?.startsWith('~')).toBe(true);
        expect(device2State.userRaw?.startsWith('~')).toBe(true);

        await ctx1.close();
        await ctx2.close();
    });

    test('clear data and re-login derives the same key again', async ({ page }) => {
        // This test verifies that after clearing all data and re-logging in,
        // the same storage key is derived (deterministic from password).
        const username = uid('cross_dev_clear');
        const password = 'another-test-pw-456';

        // Register
        await registerUser(page, username, password);

        const ssk1 = await page.evaluate(() => sessionStorage.getItem('_ssk'));
        expect(ssk1).toBeTruthy();

        // Simulate clear data: remove sensitive keys and ssk
        await page.evaluate(() => {
            if ((window as any)._secClearAll) {
                (window as any)._secClearAll();
            } else {
                // Manual clear
                const toRemove: string[] = [];
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k && (k.startsWith('token') || k.startsWith('e2e_') || k.startsWith('user') || k.startsWith('admin_') || k.startsWith('fkc_'))) {
                        toRemove.push(k);
                    }
                }
                toRemove.forEach(k => localStorage.removeItem(k));
                sessionStorage.removeItem('_ssk');
            }
        });

        // Verify cleared
        const tokenAfterClear = await page.evaluate(() => localStorage.getItem('token'));
        expect(tokenAfterClear).toBeNull();

        // Re-login
        await loginUser(page, username, password);

        const ssk2 = await page.evaluate(() => sessionStorage.getItem('_ssk'));
        expect(ssk2).toBeTruthy();

        // The derived key after re-login should be the same
        expect(ssk2).toBe(ssk1);
    });
});

