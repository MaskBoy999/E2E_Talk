import { test, expect, chromium, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The **native** "clear all app data" overlay
 * (`src-tauri/src/wipe_overlay.rs`, `static/box-wipe.html`).
 *
 * The desktop box owns a second, tiny, always-on-top window for the wipe
 * control — deliberately not a page drawn by the app's own pages, and not one
 * the host's website can serve. That is what makes the button survive the
 * states the old in-page overlay could not: Chromium's own error page
 * ("can't reach this page"), a blank/grey boot, a host that stopped hosting
 * forever. None of those run a script of ours, so a page-drawn control was
 * simply absent exactly when the user needed it.
 *
 * So this spec attaches to the real box (the same `E2E_BOX_DEBUG_PORT` hook
 * `tests/box-desktop.spec.ts` documents) and asserts the overlay window exists
 * and keeps its button while the main window is blanked, and that the panel
 * opens, arms twice and cancels without erasing.
 *
 * Run it (the box must be started with the variable set):
 *
 *     # one terminal
 *     E2E_BOX_DEBUG_PORT=9333 src-tauri/target/release/e2e-chat-app.exe
 *     # another
 *     E2E_BOX_DEBUG_PORT=9333 npx playwright test tests/box-wipe-overlay.spec.ts
 *
 * Two optional variables:
 *   * `E2E_BOX_WIPE_DEAD_HOST=1` — additionally reload the main window and
 *     assert the button outlives the error page. Only meaningful when the box's
 *     saved host is currently down.
 *   * `E2E_BOX_WIPE_DESTRUCTIVE=1` — actually press "Erase everything". This
 *     erases the box's stored session, all of its WebView storage and its saved
 *     connection for real (the config file is backed up and restored), so it is
 *     opt-in.
 *
 * Without the debug port (i.e. in CI) the whole file skips rather than fails.
 */

const DEBUG_PORT = process.env.E2E_BOX_DEBUG_PORT || '';
const CDP = `http://127.0.0.1:${DEBUG_PORT || '9333'}`;

function boxConfigPath(): string {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'com.e2echat.app', 'config.json');
}

async function cdpUp(): Promise<boolean> {
    try {
        const res = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1500) });
        return res.ok;
    } catch {
        return false;
    }
}

test.describe('the native wipe overlay (needs a running box with E2E_BOX_DEBUG_PORT)', () => {
    test.beforeEach(async () => {
        test.skip(!DEBUG_PORT, 'Set E2E_BOX_DEBUG_PORT and start the box first — see this file\'s header.');
        expect(await cdpUp(), `no DevTools endpoint on ${CDP}`).toBeTruthy();
    });

    /** The overlay page, found by the bundled page it loads. */
    function overlayOf(browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>): Page | undefined {
        return browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('box-wipe.html'));
    }

    test('the overlay window exists with its button, and outlives a main window that went blank', async () => {
        const browser = await chromium.connectOverCDP(CDP);
        try {
            // 1. It is there at launch, whatever else is on screen (a saved host,
            //    the address screen, an error page — this spec does not care).
            const overlay = overlayOf(browser);
            expect(overlay, 'the shell must create its own box-wipe.html window at launch').toBeTruthy();
            await overlay!.waitForLoadState('domcontentloaded');
            await expect(overlay!.locator('#wipe-button')).toBeVisible({ timeout: 10000 });

            // 2. The main window goes blank — the grey-page state a stale cache or
            //    a failed boot leaves behind. The overlay is a different window, so
            //    nothing about it changes. (`about:blank` is allowed by the box's
            //    navigation allow-list, which lets any non-http(s) scheme through.)
            const main = browser.contexts().flatMap((c) => c.pages())
                .find((p) => p.url().startsWith('http') && !p.url().includes('box-wipe.html'));
            if (main) {
                await main.goto('about:blank').catch(() => {});
                await expect(main.locator('body')).toBeAttached();
            }
            await expect(overlay!.locator('#wipe-button')).toBeVisible();

            // 3. The state this whole window exists for: the host is gone, so the
            //    main window shows Chromium's own error page (which runs no script
            //    at all). Opt-in, because it needs the host to actually be down.
            if (process.env.E2E_BOX_WIPE_DEAD_HOST === '1' && main) {
                await main.reload().catch(() => {});
                await main.waitForTimeout(1500);
                await expect(overlay!.locator('#wipe-button')).toBeVisible();
            }
        } finally {
            await browser.close();
        }
    });

    test('the panel opens from the button, arms twice, and cancels without erasing', async () => {
        const browser = await chromium.connectOverCDP(CDP);
        try {
            const overlay = overlayOf(browser);
            expect(overlay, 'the shell must create its own box-wipe.html window at launch').toBeTruthy();
            await overlay!.waitForLoadState('domcontentloaded');

            await overlay!.locator('#wipe-button').click();
            await expect(overlay!.locator('#panel')).toBeVisible();
            await expect(overlay!.locator('#wipe-erase')).toHaveText('Erase everything');

            // One press only arms it — an accidental click must not erase a device.
            await overlay!.locator('#wipe-erase').click();
            await expect(overlay!.locator('#wipe-erase')).toHaveText('Really erase everything?');
            await expect(overlay!.locator('#wipe-status')).toContainText('Press again');

            // Cancel closes the panel and disarms.
            await overlay!.locator('#wipe-cancel').click();
            await expect(overlay!.locator('#panel')).toBeHidden();
            await expect(overlay!.locator('#wipe-button')).toBeVisible();

            await overlay!.locator('#wipe-button').click();
            await expect(overlay!.locator('#wipe-erase')).toHaveText('Erase everything');
            await overlay!.locator('#wipe-cancel').click();
        } finally {
            await browser.close();
        }
    });

    test('erasing drops the saved connection and lands on the address screen', async () => {
        test.skip(process.env.E2E_BOX_WIPE_DESTRUCTIVE !== '1',
            'Set E2E_BOX_WIPE_DESTRUCTIVE=1 to run the real erase (it wipes the box\'s session and saved connection).');

        const backup = (() => {
            try { return fs.readFileSync(boxConfigPath(), 'utf8'); } catch { return null; }
        })();

        const browser = await chromium.connectOverCDP(CDP);
        try {
            const overlay = overlayOf(browser);
            expect(overlay).toBeTruthy();
            await overlay!.waitForLoadState('domcontentloaded');

            await overlay!.locator('#wipe-button').click();
            await overlay!.locator('#wipe-erase').click(); // arm
            await overlay!.locator('#wipe-erase').click(); // erase

            // The shell clears the WebView's own storage, drops the address and
            // pinned certificate, and puts the address screen back.
            await expect.poll(() => {
                try {
                    return JSON.parse(fs.readFileSync(boxConfigPath(), 'utf8')).server_url ?? null;
                } catch { return 'missing'; }
            }, { timeout: 20000 }).toBeNull();

            await expect.poll(() => {
                return browser.contexts().flatMap((c) => c.pages()).some((p) => p.url().includes('box-setup.html'));
            }, { timeout: 20000 }).toBeTruthy();

            // And the button is still there, on top of the address screen.
            await expect(overlay!.locator('#wipe-button')).toBeVisible();
        } finally {
            await browser.close();
            if (backup !== null) {
                try { fs.writeFileSync(boxConfigPath(), backup); } catch { /* best effort */ }
            }
        }
    });
});
