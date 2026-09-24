import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';
const PASSWORD = 'testpass1234';

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

/**
 * Encrypted local export — 5.5, FEATURE_PLAN.md.
 *
 * Format E2EXP1: magic + Argon2id salt + nonce + crypto_secretbox ciphertext
 * (libsodium). Properties asserted here:
 *   (a) round-trips with the right passphrase and rejects the wrong one;
 *   (b) the raw bytes carry NO plaintext — ciphertext must not leak the very
 *       strings it protects (the whole point of the file);
 *   (c) the payload builder never includes session credentials (the export is
 *       data, not a second copy of your login).
 */
test.describe('encrypted local export (5.5)', () => {
    test('seal → open round-trips, wrong passphrase fails, bytes are opaque', async ({ page }) => {
        await register(page, unique('exp'));

        const out = await page.evaluate(async () => {
            const w = window as any;
            const probe = { probe: 'ZEPPELIN-UNIQUE-77', user: 'alice', nested: { msg: 'hello export' } };
            const b64: string = await w.__exportSealB64('testpass1234', probe);
            // Raw byte view of the ciphertext — no plaintext may appear here.
            // (libsodium's default base64 is URL-safe/unpadded, so decode with
            // sodium itself rather than atob.)
            const rawBytes: Uint8Array = w.sodium.from_base64(b64);
            let raw = '';
            for (let i = 0; i < rawBytes.length; i++) raw += String.fromCharCode(rawBytes[i]);
            const leaks = raw.includes('ZEPPELIN-UNIQUE-77') || raw.includes('alice') || raw.includes('hello export');
            const back = await w.e2eExportOpen(b64, 'testpass1234');
            let wrongFailed = false;
            try { await w.e2eExportOpen(b64, 'wrong-passphrase'); } catch (_) { wrongFailed = true; }
            let garbageFailed = false;
            try { await w.e2eExportOpen(w.sodium.to_base64(new TextEncoder().encode('not-an-export')), 'testpass1234'); } catch (_) { garbageFailed = true; }
            return { b64: b64.substring(0, 16), hasMagic: raw.startsWith('E2EXP1\0'), leaks, back, wrongFailed, garbageFailed };
        });

        expect(out.hasMagic).toBe(true);
        expect(out.leaks).toBe(false);
        expect(out.back).toEqual({ probe: 'ZEPPELIN-UNIQUE-77', user: 'alice', nested: { msg: 'hello export' } });
        expect(out.wrongFailed).toBe(true);
        expect(out.garbageFailed).toBe(true);
    });

    test('the export payload carries no session credentials', async ({ page }) => {
        await register(page, unique('expcred'));

        const out = await page.evaluate(async () => {
            const w = window as any;
            // Mark the credential-like keys so their absence is provable even
            // if the real values ever change shape.
            const tokenVal = localStorage.getItem('token');
            const payload = await w.__exportPayload();
            const json = JSON.stringify(payload);
            return {
                json,
                hadToken: !!tokenVal,
                leaksToken: !!tokenVal && json.includes(tokenVal),
                anyTokenKey: /"token"\s*:/.test(json),
                anyPassword: /password/i.test(json),
                shape: { v: payload.v, hasFormat: typeof payload.format === 'string', hasSettings: !!payload.settings, hasConversations: !!payload.conversations },
            };
        });

        expect(out.hadToken).toBe(true); // a logged-in session has a token
        expect(out.leaksToken).toBe(false);
        expect(out.anyTokenKey).toBe(false);
        expect(out.anyPassword).toBe(false);
        expect(out.shape.v).toBe(1);
        expect(out.shape.hasFormat).toBe(true);
        expect(out.shape.hasSettings).toBe(true);
        expect(out.shape.hasConversations).toBe(true);
    });

    test('the settings UI exposes the export controls', async ({ page }) => {
        await register(page, unique('expui'));
        const ids = await page.evaluate(() => ['export-passphrase', 'export-passphrase-confirm', 'export-data-btn', 'export-status']
            .map((id) => !!document.getElementById(id)));
        expect(ids).toEqual([true, true, true, true]);
    });
});
