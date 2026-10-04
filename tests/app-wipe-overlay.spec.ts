import { test, expect, type Page } from '@playwright/test';

/**
 * The "clear all app data" control (static/app-overlay.js).
 *
 * On **desktop** the shell no longer lets a page draw this button at all: it
 * owns an always-on-top window of its own (`static/box-wipe.html`, see
 * `src-tauri/src/wipe_overlay.rs`) that survives the WebView's own error page,
 * a blank/grey boot and a host that is gone for good — states where no script
 * of ours runs. The shell marks those windows with
 * `__E2E_NATIVE_WIPE_OVERLAY__` before any page script runs, so the page draws
 * nothing and keeps only its other jobs: the `box:page-alive` beacon,
 * `window.__appWipe`, and the `box:wipe-requested` handler that runs the page
 * half of a wipe. Android has no second window to put the control in, so
 * there the rules in (1) and (2) below still apply — the page draws the only
 * button, and hides it for the rest of the run.
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

/**
 * The desktop shell: it tells the page that the shell's own window draws the
 * button, and records what the page listens for and emits.
 */
const NATIVE_DESKTOP_STUB = () => {
    (window as any).__E2E_NATIVE_WIPE_OVERLAY__ = true;
    (window as any).__emits = [];
    (window as any).__listeners = {} as Record<string, Array<(e?: unknown) => void>>;
    (window as any).__TAURI__ = {
        core: { invoke: async () => null },
        event: {
            emit: async (name: string) => {
                (window as any).__emits.push(name);
            },
            listen: async (name: string, cb: (e?: unknown) => void) => {
                ((window as any).__listeners[name] ||= []).push(cb);
                return () => {};
            },
        },
    };
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

    test('it is on top of the app\'s own overlays and survives the DOM being rebuilt', async ({ page }) => {
        await page.addInitScript(TAURI_STUB);
        await register(page, true);

        /**
         * Is the wipe button the thing at the centre of its own box?
         *
         * `elementFromPoint` answers exactly the user's question — can I press
         * it — while `z-index` alone cannot: the vault lock screen and the boot
         * spinner are full-screen overlays with their own stacking, and they
         * used to swallow the button.
         */
        const reachable = () => page.evaluate(() => {
            const btn = document.getElementById('app-wipe-button');
            if (!btn) return { present: false, atPoint: null as string | null, z: null as string | null };
            const r = btn.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return {
                present: true,
                atPoint: hit ? (hit.closest('#app-wipe-button') ? 'button' : (hit.id || hit.className || hit.tagName)) : null,
                z: getComputedStyle(btn).zIndex,
            };
        });

        // 1. Nothing on screen: it is pressable.
        expect(await reachable()).toEqual({ present: true, atPoint: 'button', z: expect.any(String) });

        // 2. The boot spinner (#loading-overlay) is up: still pressable. This is
        //    the state a user is in when the app is opening against a server
        //    that is no longer answering.
        await page.evaluate(() => {
            let el = document.getElementById('loading-overlay') as HTMLElement | null;
            if (!el) {
                el = document.createElement('div');
                el.id = 'loading-overlay';
                el.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#1e1f22';
                document.body.appendChild(el);
            } else {
                el.style.display = 'flex';
            }
        });
        expect((await reachable()).atPoint, 'the boot spinner must not cover the wipe button').toBe('button');

        // 3. The vault lock screen (.vault-lock-overlay, z-index 100000): the app
        //    is locked, which is exactly when a way out matters most.
        await page.evaluate(() => {
            const el = document.createElement('div');
            el.className = 'vault-lock-overlay';
            el.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#0b0b0d';
            document.body.appendChild(el);
        });
        expect((await reachable()).atPoint, 'the vault lock screen must not cover the wipe button').toBe('button');

        // 4. The document is rebuilt under it (a re-render, or the "grey screen"
        //    an error path leaves behind): the observer puts it straight back.
        await page.evaluate(() => { document.getElementById('app-wipe-button')?.remove(); });
        await expect(page.locator('#app-wipe-button')).toBeAttached({ timeout: 5000 });

        await page.evaluate(() => {
            // Wipe the body the app lives in, the way a failed boot leaves it.
            document.body.innerHTML = '';
        });
        await expect(page.locator('#app-wipe-button')).toBeAttached({ timeout: 5000 });
        expect((await reachable()).atPoint, 'after the DOM is rebuilt the button must still be pressable').toBe('button');

        // 5. And hiding still wins: the observer must not resurrect it.
        await page.evaluate(() => (window as any).__appWipe?.setHidden(true));
        await page.evaluate(() => { document.getElementById('app-wipe-button')?.remove(); });
        await page.waitForTimeout(400);
        await expect(page.locator('#app-wipe-button')).toHaveCount(0);
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

    test('on desktop the shell owns the button: the page draws none, and still beacons', async ({ page }) => {
        await page.addInitScript(NATIVE_DESKTOP_STUB);

        // Signed in — the page that used to carry the button.
        await register(page, false);
        await expect(page.locator('#app-wipe-button')).toHaveCount(0);

        // The address screen too: the shell's window covers it as well, so a
        // second, page-drawn button there would be a duplicate.
        await page.goto(`${BASE}/box-setup.html`);
        await expect(page.locator('#app-wipe-button')).toHaveCount(0);

        // The page keeps its liveness beacon: silence from here is what tells the
        // shell the main window is showing something that runs no script at all
        // (src-tauri/src/lib.rs, PAGE_ALIVE_EVENT — the dead-page watchdog).
        await expect.poll(() => page.evaluate(() => (window as any).__emits || []))
            .toContain('box:page-alive');
    });

    test('a native wipe asks the page for its half: sign out, then drop local data', async ({ page }) => {
        await page.addInitScript(NATIVE_DESKTOP_STUB);
        await register(page, false);

        await page.evaluate(() => {
            localStorage.setItem('a_probe_key', 'left-behind');
            document.cookie = 'probe_cookie=1;path=/';
        });

        // The shell speaks the event the page listens for (WIPE_REQUESTED_EVENT).
        const heard = await page.evaluate(() => Object.keys((window as any).__listeners || {}));
        expect(heard).toContain('box:wipe-requested');

        await page.evaluate(() => {
            ((window as any).__listeners['box:wipe-requested'] || []).forEach((cb: (e?: unknown) => void) => cb({}));
        });

        // Token first (the logout call needs it), then everything JS can reach.
        await expect.poll(() => page.evaluate(() => localStorage.getItem('token')), { timeout: 20000 }).toBeNull();
        expect(await page.evaluate(() => localStorage.getItem('a_probe_key')), 'every localStorage key must go').toBeNull();
        // The shell's own half — the WebView's storage and the saved connection —
        // runs regardless of this page (see tests/box-wipe-overlay.spec.ts).
    });
});
