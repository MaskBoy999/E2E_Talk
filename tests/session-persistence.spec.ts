import { test, expect, type Page, type BrowserContext } from '@playwright/test';

/**
 * Phase 0 regression tests: the session must survive a mobile browser restart.
 *
 * On a phone, closing the browser clears `sessionStorage` while `localStorage`
 * stays. The storage key is password-derived, and secure-storage used to mint a
 * random fallback whenever derivation wasn't possible at parse time (libsodium
 * not ready yet) — orphaning the encrypted `token` and bouncing the user to the
 * login page. These tests pin the fixed behaviour.
 */

const BASE = 'https://localhost:3443';
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

/** Read the decrypted token through secure-storage (null when unreadable). */
async function readToken(page: Page): Promise<string | null> {
    return page.evaluate(() => {
        const anyWin = window as any;
        return anyWin._secGet ? anyWin._secGet('token') : localStorage.getItem('token');
    });
}

test.describe('session persistence across a cold start', () => {
    test.setTimeout(180000);

    test('session survives clearing sessionStorage (mobile browser restart)', async ({ browser }) => {
        const ctx: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
        const page = await ctx.newPage();
        await register(page, unique('sess_persist'));

        const before = await readToken(page);
        expect(before).toBeTruthy();

        // Mobile browser restart: sessionStorage gone, localStorage stays.
        await page.evaluate(() => sessionStorage.clear());
        await page.reload();
        await page.waitForLoadState('domcontentloaded');

        // Must NOT be bounced to the login page, and the token must still decrypt.
        await page.waitForSelector('#current-user', { timeout: 30000 });
        const after = await readToken(page);
        expect(after).toBe(before);

        await ctx.close();
    });

    test('no random fallback key is minted while a vault/key source exists', async ({ browser }) => {
        const ctx: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
        const page = await ctx.newPage();
        await register(page, unique('sess_nofallback'));

        const state = await page.evaluate(() => {
            const anyWin = window as any;
            const raw = (k: string) => (anyWin._secGetRaw ? anyWin._secGetRaw(k) : localStorage.getItem(k));
            return {
                // 5.6: the key source is the Argon2id vault — the migration
                // deliberately DELETES the old password bootstrap blob, so
                // "a key source exists" means the legacy bootstrap OR the vault.
                hasKeySource: (!!raw('e2e_encrypted_password') && !!raw('e2e_device_key')) || !!raw('e2e_key_vault'),
                migrated: !!raw('vault_migrated_at'),
                fallback: raw('e2e_local_storage_key'),
            };
        });
        expect(state.hasKeySource).toBe(true);
        expect(state.migrated).toBe(true);
        expect(state.fallback).toBeNull();

        await ctx.close();
    });

    test('a pre-existing poisoned fallback key is ignored on the next load', async ({ browser }) => {
        const ctx: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
        const page = await ctx.newPage();
        await register(page, unique('sess_poison'));
        const before = await readToken(page);
        expect(before).toBeTruthy();

        // Reproduce the historical poisoning: a bogus random fallback key left
        // behind by a load that lost the sodium-ready race.
        await page.evaluate(() => {
            const b = new Uint8Array(32);
            crypto.getRandomValues(b);
            let s = '';
            for (const x of b) s += String.fromCharCode(x);
            Storage.prototype.setItem.call(localStorage, 'e2e_local_storage_key', btoa(s));
            sessionStorage.clear();
        });

        await page.reload();
        await page.waitForSelector('#current-user', { timeout: 30000 });
        const after = await readToken(page);
        expect(after).toBe(before);

        await ctx.close();
    });
});
