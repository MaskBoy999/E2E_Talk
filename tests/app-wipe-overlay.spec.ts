import { test, expect, type Page } from '@playwright/test';

/**
 * The always-on "clear all app data" overlay (static/app-overlay.js).
 *
 * The user's request, in three parts, and each one is a test below:
 *
 *  1. "always on the app even when a connection is made or not" — the button is
 *     on the chat, on the login screen and on the box's address screen (the
 *     screen a wiped app returns to), and it is not in the mini call-controls
 *     window, which has no storage of its own to erase.
 *  2. "the button should be visible on start until we hide it, and it only
 *     reappears if we reopen the app" — so: visible when a run of the app
 *     starts; still hidden after in-page navigation and reloads (and after the
 *     app has been in the background); and visible again in a fresh window,
 *     which is what reopening the app is. No part of the flag goes to
 *     localStorage, which is what makes the last rule true — there is nothing
 *     for a restart to inherit — and nothing on a timer or a visibilitychange
 *     handler touches the flag, so backgrounding cannot lose it either.
 *  3. "clears all app data completely (including all local data and connection
 *     made)" — a two-press erase drops localStorage, sessionStorage, cookies,
 *     IndexedDB and Cache Storage, signs the account out server-side, and asks
 *     the box shell to forget the saved connection and pinned certificate
 *     (`box:clear-connection`, which the shell turns into "back to the address
 *     screen" — see forget_connection in src-tauri/src/lib.rs).
 */

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';

/** A box shell that records what the page asks it to do. */
const TAURI_RECORDING_STUB = () => {
    (window as any).__emits = [];
    (window as any).__TAURI__ = {
        core: { invoke: async () => null },
        event: {
            emit: async (name: string) => {
                (window as any).__emits.push(name);
            },
        },
    };
};

/** A plain browser, i.e. no shell to ask (the setup page's own `invoke` is absent). */
const NO_SHELL = () => {
    delete (window as any).__TAURI__;
};

async function register(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-confirm-password', { state: 'visible', timeout: 10000 });
    await page.fill('#register-username', `wipe_${ts}`);
    await page.fill('#register-password', 'testpass123');
    await page.fill('#register-confirm-password', 'testpass123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#app-wipe-button', { timeout: 30000 });
}

test.describe('the always-on clear-all-data overlay', () => {
    test('is on every screen of the app — chat, login, address — and never in the mini window', async ({ page }) => {
        await page.addInitScript(NO_SHELL);

        await page.goto(`${BASE}/login.html`);
        await expect(page.locator('#app-wipe-button')).toBeVisible({ timeout: 20000 });

        // Signed in, with a live connection.
        await register(page);
        await expect(page.locator('#app-wipe-button')).toBeVisible();

        // The box's address screen: the one place a wiped app returns to, and the
        // one that can still hold the leftovers of a connection.
        await page.goto(`${BASE}/box-setup.html`);
        await expect(page.locator('#app-wipe-button')).toBeVisible({ timeout: 20000 });

        // 4.2's mini call-controls window is a strip of buttons for a call that is
        // already running; it owns no storage, so it offers no wipe.
        await page.goto(`${BASE}/index.html?mini=1`);
        await expect(page.locator('#app-wipe-button')).toHaveCount(0);
    });

    test('visible on start, hidden until the app is reopened', async ({ page, browser }) => {
        await page.addInitScript(NO_SHELL);
        await page.goto(`${BASE}/login.html`);

        // Rule 1: it is there when a run of the app starts.
        await expect(page.locator('#app-wipe-button')).toBeVisible({ timeout: 20000 });

        await page.click('#app-wipe-button');
        await expect(page.locator('[data-app-wipe-panel]')).toBeVisible();
        await page.click('[data-app-wipe-hide]');
        await expect(page.locator('#app-wipe-button')).toHaveCount(0);

        // Rule 2: still hidden after a reload — the "backgrounded / navigated
        // around the app" half of the request.
        await page.reload();
        await page.waitForSelector('#show-register', { timeout: 20000 });
        await expect(page.locator('#app-wipe-button')).toHaveCount(0);
        // …and across an in-app navigation to a different page of the same app.
        await page.goto(`${BASE}/box-setup.html`);
        await expect(page.locator('#app-wipe-button')).toHaveCount(0);

        // Rule 3: reopening the app brings it back. Nothing of the hidden state is
        // persisted (the flag is the window's own name plus a same-origin
        // sessionStorage entry, and neither can outlive the process), so a fresh
        // window is exactly what "close the app and open it again" looks like.
        const persisted = await page.evaluate(() => Object.keys(localStorage).filter((k) => /overlay|wipe|hidden/i.test(k)));
        expect(persisted, 'hiding must never be written to localStorage').toEqual([]);
        const fresh = await browser.newContext({ ignoreHTTPSErrors: true });
        const reopened = await fresh.newPage();
        await reopened.goto(`${BASE}/login.html`);
        await expect(reopened.locator('#app-wipe-button')).toBeVisible({ timeout: 20000 });
        await fresh.close();
    });

    test('erasing everything wipes local data, signs out, and tells the shell to forget the connection', async ({ page }) => {
        await page.addInitScript(TAURI_RECORDING_STUB);
        await register(page);

        // Something of the user's own, plus a row in IndexedDB: "all local data"
        // has to mean all of it, not just the keys the app happens to manage.
        await page.evaluate(async () => {
            localStorage.setItem('a_probe_key', 'left-behind');
            document.cookie = 'probe_cookie=1;path=/';
            await new Promise<void>((resolve) => {
                const req = indexedDB.open('e2e_app_bg', 1);
                req.onupgradeneeded = () => { try { req.result.createObjectStore('files'); } catch (_) {} };
                req.onsuccess = () => { req.result.close(); resolve(); };
                req.onerror = () => resolve();
            });
        });

        await page.click('#app-wipe-button');
        await expect(page.locator('[data-app-wipe-panel]')).toBeVisible();

        // Two presses: the first arms it, the second does the irreversible part.
        await page.click('[data-app-wipe-erase]');
        await expect(page.locator('[data-app-wipe-erase]')).toContainText('Really erase everything?');
        await page.click('[data-app-wipe-erase]');

        // The shell is asked to forget the address + pinned certificate, which is
        // the only way back to "the user must enter the connection again".
        await expect.poll(() => page.evaluate(() => (window as any).__emits || []), { timeout: 20000 })
            .toContain('box:clear-connection');

        const left = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            probe: localStorage.getItem('a_probe_key'),
            cookie: document.cookie,
            dbs: typeof indexedDB.databases === 'function' ? null : 'unavailable',
        }));
        expect(left.token, 'the session must be gone').toBeNull();
        expect(left.probe, 'every localStorage key must be gone').toBeNull();
        expect(left.cookie).not.toContain('probe_cookie');
    });

    test('in a plain browser the same button signs out and lands on the login screen', async ({ page }) => {
        await page.addInitScript(NO_SHELL);
        await register(page);
        await page.click('#app-wipe-button');
        await page.click('[data-app-wipe-erase]');
        await page.click('[data-app-wipe-erase]');
        await page.waitForURL('**/login.html?wiped=1', { timeout: 20000 });
        expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();
    });
});
