import { test, expect, type Page } from '@playwright/test';

/**
 * The "clear all app data" control (static/app-overlay.js).
 *
 * The rule changed: it is drawn **only inside the native shell**, never in an
 * ordinary browser. A page-drawn button showed up in the browser too — the tell
 * that it was website chrome rather than part of the app — and the vault lock
 * overlay sat on top of it. So `boot()` gates on `window.__TAURI__`, and this
 * spec pins both halves:
 *
 *  1. In the shell it is on the app screens (chat, login, the box's address
 *     screen), never in the mini call-controls window, hidden for the rest of
 *     the run once you press "Hide" (and back in a fresh window, which is what
 *     reopening the app is — nothing of the flag goes to localStorage).
 *  2. In a plain browser there is no page-drawn wipe control anywhere. The
 *     browser still has Settings → Clear All Local Data and the Alt+Shift+W
 *     chord, but that is not this file's subject.
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

/** A plain browser, i.e. no shell and therefore no page-drawn wipe control. */
const NO_SHELL = () => {
    delete (window as any).__TAURI__;
};

/** A quiet box shell for the flows that only need the button to exist. */
const TAURI_STUB = () => {
    (window as any).__TAURI__ = {
        core: { invoke: async () => null },
        event: { emit: async () => {} },
    };
};

async function register(page: Page, waitForButton: boolean) {
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
    // In the shell the button is there; in a browser the session is what proves boot.
    if (waitForButton) await page.waitForSelector('#app-wipe-button', { timeout: 30000 });
    else await page.waitForSelector('#current-user', { timeout: 30000 });
}

test.describe('the clear-all-data overlay is native-app only', () => {
    test('inside the shell it is on the app screens, and never in the mini window', async ({ page }) => {
        await page.addInitScript(TAURI_STUB);

        await page.goto(`${BASE}/login.html`);
        await expect(page.locator('#app-wipe-button')).toBeVisible({ timeout: 20000 });

        // Signed in, with a live connection.
        await register(page, true);
        await expect(page.locator('#app-wipe-button')).toBeVisible();

        // The box's address screen: the one place a wiped app returns to.
        await page.goto(`${BASE}/box-setup.html`);
        await expect(page.locator('#app-wipe-button')).toBeVisible({ timeout: 20000 });

        // 4.2's mini call-controls window is a strip of buttons for a call that is
        // already running; it owns no storage, so it offers no wipe.
        await page.goto(`${BASE}/index.html?mini=1`);
        await expect(page.locator('#app-wipe-button')).toHaveCount(0);
    });

    test('in a plain browser no page-drawn wipe button exists anywhere', async ({ page }) => {
        await page.addInitScript(NO_SHELL);

        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register', { timeout: 20000 });
        await expect(page.locator('#app-wipe-button')).toHaveCount(0);

        await register(page, false);
        await expect(page.locator('#app-wipe-button')).toHaveCount(0);

        await page.goto(`${BASE}/box-setup.html`);
        await expect(page.locator('#app-wipe-button')).toHaveCount(0);
    });

    test('visible on start, hidden until the app is reopened', async ({ page, browser }) => {
        await page.addInitScript(TAURI_STUB);
        await page.goto(`${BASE}/login.html`);

        // Rule 1: it is there when a run of the app starts.
        await expect(page.locator('#app-wipe-button')).toBeVisible({ timeout: 20000 });

        await page.click('#app-wipe-button');
        await expect(page.locator('[data-app-wipe-panel]')).toBeVisible();
        await page.click('[data-app-wipe-hide]');
        await expect(page.locator('#app-wipe-button')).toHaveCount(0);

        // Rule 2: still hidden after a reload and an in-app navigation.
        await page.reload();
        await page.waitForSelector('#show-register', { timeout: 20000 });
        await expect(page.locator('#app-wipe-button')).toHaveCount(0);
        await page.goto(`${BASE}/box-setup.html`);
        await expect(page.locator('#app-wipe-button')).toHaveCount(0);

        // Rule 3: reopening the app brings it back. Nothing of the hidden state is
        // persisted, so a fresh window is exactly what "close and open again" is.
        const persisted = await page.evaluate(() => Object.keys(localStorage).filter((k) => /overlay|wipe|hidden/i.test(k)));
        expect(persisted, 'hiding must never be written to localStorage').toEqual([]);
        const fresh = await browser.newContext({ ignoreHTTPSErrors: true });
        await fresh.addInitScript(TAURI_STUB);
        const reopened = await fresh.newPage();
        await reopened.goto(`${BASE}/login.html`);
        await expect(reopened.locator('#app-wipe-button')).toBeVisible({ timeout: 20000 });
        await fresh.close();
    });

    test('erasing everything wipes local data, signs out, and tells the shell to forget the connection', async ({ page }) => {
        await page.addInitScript(TAURI_RECORDING_STUB);
        await register(page, true);

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

        // The shell is asked to forget the address + pinned certificate.
        await expect.poll(() => page.evaluate(() => (window as any).__emits || []), { timeout: 20000 })
            .toContain('box:clear-connection');

        const left = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            probe: localStorage.getItem('a_probe_key'),
            cookie: document.cookie,
        }));
        expect(left.token, 'the session must be gone').toBeNull();
        expect(left.probe, 'every localStorage key must be gone').toBeNull();
        expect(left.cookie).not.toContain('probe_cookie');
    });
});
