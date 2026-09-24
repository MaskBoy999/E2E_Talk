import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';
const PASSWORD = 'testpass1234';
const ROOT = path.join(__dirname, '..');

function unique(b: string): string {
    return `${b}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', PASSWORD);
    await page.fill('#register-confirm-password', PASSWORD);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 20000 });
}

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * Fingerprint unlock is REMOVED (0.2.30) — not disabled, not hidden behind a
 * flag. This spec is the proof, layer by layer, because "the button is not on
 * screen" is not the same as "the app cannot unlock with a fingerprint":
 *
 *   1. the WebView half — no settings row, no login button, no vault-screen
 *      button, no JS API, and no call to the plugin;
 *   2. the Kotlin half — no BiometricPrompt, no Keystore wrap/unwrap command;
 *   3. the plugin's declared surface — the commands are gone from build.rs and
 *      from the permission set, so even a page that tried to call them could
 *      not (the ACL has nothing to grant);
 *   4. what the app leaves behind — no seal is written, and a stale seal from an
 *      older build is wiped rather than honoured.
 */
test.describe('biometric unlock is removed (0.2.30)', () => {
    test('no biometric UI or JS API exists in the app', async ({ page }) => {
        await register(page, unique('nobio'));

        const out = await page.evaluate(() => {
            const w = window as any;
            return {
                toggle: !!document.getElementById('biometric-unlock-toggle'),
                statusLine: !!document.getElementById('biometric-status-line'),
                jsApi: typeof w.__biometric,
                // Nothing in the served markup still advertises the feature,
                // hidden panel or not.
                markup: document.body.innerHTML.toLowerCase().includes('fingerprint unlock'),
                anyBiometricId: document.querySelectorAll('[id^="biometric"]').length,
            };
        });

        expect(out.toggle).toBe(false);
        expect(out.statusLine).toBe(false);
        expect(out.jsApi).toBe('undefined');
        // No "Fingerprint Unlock" row and no id left behind.
        expect(out.markup).toBe(false);
        expect(out.anyBiometricId).toBe(0);
    });

    test('the login page offers the password form only', async ({ page }) => {
        await page.goto(`${BASE}/login.html`);

        const out = await page.evaluate(() => ({
            button: !!document.getElementById('biometric-unlock-btn'),
            loginForm: !!document.getElementById('login-form'),
            password: !!document.getElementById('login-password'),
        }));

        expect(out.button).toBe(false);
        expect(out.loginForm).toBe(true);
        expect(out.password).toBe(true);
    });

    test('the web layer never calls a biometric command, and names no seal key', () => {
        // Compute-fingerprint/verify-fingerprint (TOFU identity keys) legitimately
        // use the word: this is about the unlock FEATURE, so the assertions are
        // on the exact identifiers the feature shipped with.
        const web = ['static/chat.js', 'static/auth.js', 'static/keyvault.js', 'static/login.html', 'static/index.html'];
        for (const rel of web) {
            const src = read(rel);
            expect(src.includes('plugin:box-shell|biometric'), `${rel} must not call the biometric plugin`).toBe(false);
            expect(src.includes('e2e_bio_seal'), `${rel} must not name the seal key`).toBe(false);
            expect(src.includes('e2e_bio_user'), `${rel} must not name the seal key`).toBe(false);
            expect(src.includes('biometric-unlock'), `${rel} must not carry unlock UI ids`).toBe(false);
            expect(src.includes('vault-lock-bio'), `${rel} must not offer a fingerprint vault unlock`).toBe(false);
        }
    });

    test('the Kotlin half has no prompt, no Keystore seal, and no declared command', () => {
        const plugin = read('src-tauri/plugins/box-shell/android/src/main/java/com/e2echat/boxshell/BoxShellPlugin.kt');
        expect(plugin.includes('BiometricPrompt')).toBe(false);
        expect(plugin.includes('biometricSeal')).toBe(false);
        expect(plugin.includes('biometricAvailable')).toBe(false);
        expect(plugin.includes('BIOMETRIC_KEY_ALIAS')).toBe(false);
        // The Keystore machinery existed only for the seal.
        expect(plugin.includes('KeyGenParameterSpec')).toBe(false);
        expect(plugin.includes('AndroidKeyStore')).toBe(false);

        const buildRs = read('src-tauri/plugins/box-shell/build.rs');
        expect(buildRs.includes('biometric')).toBe(false);

        const defaultToml = read('src-tauri/plugins/box-shell/permissions/default.toml');
        expect(defaultToml.includes('biometric')).toBe(false);

        // …and the generated per-command permission files are gone too, so
        // `box-shell:allow-biometricSeal` does not exist to be granted.
        const cmdDir = path.join(ROOT, 'src-tauri', 'plugins', 'box-shell', 'permissions', 'autogenerated', 'commands');
        const files = fs.readdirSync(cmdDir);
        expect(files.some((f) => f.toLowerCase().includes('biometric'))).toBe(false);
    });

    test('no seal is written on sign-in, and a stale one is wiped', async ({ page }) => {
        await page.goto(`${BASE}/login.html`);
        await page.evaluate(() => {
            localStorage.clear();
            // A seal an older build could have left on this device.
            localStorage.setItem('e2e_bio_seal', 'STALE-KEYSTORE-CIPHERTEXT');
            localStorage.setItem('e2e_bio_user', 'someone');
        });
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register', { timeout: 20000 });
        await page.click('#show-register');
        await page.fill('#register-username', unique('staleseal'));
        await page.fill('#register-password', PASSWORD);
        await page.fill('#register-confirm-password', PASSWORD);
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 60000 });
        await page.waitForSelector('#current-user', { timeout: 20000 });

        const left = await page.evaluate(() => ({
            seal: localStorage.getItem('e2e_bio_seal'),
            user: localStorage.getItem('e2e_bio_user'),
        }));
        // Nothing sealed it again, and the login page's wipe took the old one
        // with it: a removed feature must not leave a decryptable credential
        // (or the username that went with it) sitting in storage.
        expect(left.seal).toBeNull();
        expect(left.user).toBeNull();
    });
});
