import { test, expect, type Page } from '@playwright/test';

/**
 * The box's first-run setup screen (`static/box-setup.html`).
 *
 * This is the screen every install passes through, and it is the only place that
 * explains *why* the app could not open the saved server. It runs inside the
 * native shell, so the whole page is written against `window.__TAURI__` — which
 * is absent in a browser. The tests therefore stub that surface with
 * `addInitScript` and drive the page exactly as the WebView does.
 *
 * The behaviour under test exists because of two real failures:
 *
 *   1. **Android could never get past setup.** "Test connection" succeeded, then
 *      Save & Launch left the window blank forever (the self-signed certificate
 *      is accepted by the WebView only through the override injected by
 *      `.cargo/config.toml`). The pin is the WebView's only trust anchor there,
 *      so it must be forced on, and the page must not be able to hang silently.
 *   2. **A silent fallback back to setup.** When startup cannot open the app it
 *      shows this screen again — with no explanation, which on a phone (no
 *      console) is indistinguishable from the app forgetting everything. It now
 *      asks `get_startup_error` and shows the reason.
 */

const BASE = 'https://localhost:3443';
const SHOT = 'test-results/box-setup';

const ANDROID_UA =
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36';

const PIN = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

type IpcCall = { cmd: string; args: any };

/** The IPC calls the page has made so far, read fresh from the page each time. */
async function ipcCalls(page: Page): Promise<IpcCall[]> {
    return await page.evaluate(() => ((window as any).__boxStub?.calls || []) as IpcCall[]);
}

/**
 * Install a fake `window.__TAURI__` before the page's own scripts run.
 *
 * `resolve` maps a command name to the value its invocation resolves with. A
 * command that is absent returns a promise that never settles — which is how a
 * real IPC call behaves while the Rust side is still working, and the setup
 * screen has to cope with that rather than leaving its button dead.
 */
async function openSetup(page: Page, resolve: Record<string, any> = {}, reject?: string[]): Promise<void> {
    await page.addInitScript(
        ({ resolved, rejected }: { resolved: Record<string, any>; rejected: string[] }) => {
            const calls: IpcCall[] = [];
            (window as any).__boxStub = { calls };
            (window as any).__TAURI__ = {
                core: {
                    invoke: (cmd: string, args: any) => {
                        calls.push({ cmd, args });
                        // get_config / get_startup_error are always answered by the
                        // real app; only list them in `resolved` to change that.
                        if (rejected.includes(cmd)) {
                            return Promise.reject(new Error('Could not read the server certificate: TCP connect failed'));
                        }
                        if (cmd in resolved) return Promise.resolve(resolved[cmd]);
                        if (cmd === 'get_config' || cmd === 'get_startup_error') return Promise.resolve(null);
                        return new Promise(() => {});
                    },
                },
            };
        },
        { resolved: resolve, rejected: reject || [] },
    );
    await page.goto(`${BASE}/box-setup.html`);
    await page.waitForSelector('#server-url');
}

/** Fill in an address and press Save & Launch. */
async function save(page: Page, address: string): Promise<void> {
    await page.fill('#server-url', address);
    await page.click('#save-btn');
}

test.describe('box setup screen — desktop', () => {
    test('prefills the saved address and shows the pinned certificate', async ({ page }) => {
        await openSetup(page, {
            get_config: {
                server_url: 'https://100.101.102.103:3443',
                auto_start: false,
                minimize_to_tray: true,
                pinned_cert_sha256: PIN,
            },
        });

        await expect(page.locator('#server-url')).toHaveValue('https://100.101.102.103:3443');
        // The fingerprint is truncated for display, but both ends must be real.
        await expect(page.locator('#cert-info')).toContainText('abcdef01');
        await expect(page.locator('#cert-info')).toContainText('23456789');

        // Desktop keeps the autostart / tray toggles...
        await expect(page.locator('#desktop-opts')).toBeVisible();
        // ...but not a switchable pin. The host's certificate is self-signed and
        // the WebView only accepts it because the fingerprint is pinned, so an
        // *unpinned* launch is Chromium's "Your connection isn't private" page
        // instead of the app. Trusting is therefore not optional on any platform.
        await expect(page.locator('#pin-cert')).toBeChecked();
        await expect(page.locator('#pin-cert')).toBeDisabled();
        await expect(page.locator('#pin-hint')).toContainText('always pins');
        await expect(page.locator('#launch-error')).toBeHidden();

        expect((await ipcCalls(page)).some((c) => c.cmd === 'get_config')).toBeTruthy();
    });

    test('shows why the last launch fell back to setup', async ({ page }) => {
        await openSetup(page, {
            get_startup_error:
                "The server's certificate changed since you trusted it. If you rotated the " +
                'certificate yourself, re-run setup and tick "Trust this server" again.',
        });

        const err = page.locator('#launch-error');
        await expect(err).toBeVisible();
        await expect(err).toContainText('certificate changed');
        await page.screenshot({ path: `${SHOT}/startup-error.png` });
    });

    test('explains a refusal to open an unpinnable server, and stays usable', async ({ page }) => {
        // The exact message `require_pin` in src-tauri/src/lib.rs returns when a
        // launch can neither use a pin nor establish one. Refusing is what keeps
        // the certificate warning page from ever being shown; this screen is
        // where the user then finds out why.
        await openSetup(
            page,
            {
                get_startup_error:
                    'no certificate is trusted for https://100.1.2.3:3443 yet, and its ' +
                    'certificate could not be read to trust it now. Check that the host is ' +
                    'running and reachable, then press Save & Launch again.',
                probe_certificate: PIN,
                test_connection: { ok: true, status: 200, detail: 'Connected — reachable.' },
            },
            [],
        );

        const err = page.locator('#launch-error');
        await expect(err).toBeVisible();
        await expect(err).toContainText('could not be read to trust it now');
        // Not a dead end: the address is editable and Save is live.
        await expect(page.locator('#server-url')).toBeEditable();
        await expect(page.locator('#save-btn')).toBeEnabled();
        await page.screenshot({ path: `${SHOT}/unpinnable-refusal.png`, fullPage: true });

        // A *successful* Test connection clears it — the retry the message asks
        // for is what makes this screen winnable.
        await page.click('#test-btn');
        await expect(err).toBeHidden();
    });

    test('a bare IP is normalised to https on the default port, and sent as the pin', async ({ page }) => {
        await openSetup(page);

        await save(page, '100.101.102.103');

        await expect.poll(async () => (await ipcCalls(page)).filter((c) => c.cmd === 'save_config').length).toBe(1);
        const cfg = (await ipcCalls(page)).find((c) => c.cmd === 'save_config')!;
        expect(cfg.args.serverUrl).toBe('https://100.101.102.103:3443');
        // The WebView accepts only a pinned certificate, so the pin must be
        // established on the happy path as well — not just on Android.
        expect(cfg.args.pinCert).toBe(true);
        await expect(page.locator('#server-url')).toHaveValue('https://100.101.102.103:3443');
    });

    test('refuses an http address instead of saving something the box cannot load', async ({ page }) => {
        await openSetup(page);

        await save(page, 'http://100.101.102.103:3443');

        await expect(page.locator('#status')).toHaveClass(/err/);
        await expect(page.locator('#status')).toContainText('https://');
        expect((await ipcCalls(page)).some((c) => c.cmd === 'save_config')).toBe(false);
        // The button must stay usable so the user can fix the address.
        await expect(page.locator('#save-btn')).toBeEnabled();

        await page.screenshot({ path: `${SHOT}/http-refused.png` });
    });

    test('a failing save reports the error and re-enables the button', async ({ page }) => {
        await openSetup(page, {}, ['save_config']);

        await save(page, '100.101.102.103');

        await expect(page.locator('#status')).toHaveClass(/err/);
        await expect(page.locator('#status')).toContainText('Could not read the server certificate');
        await expect(page.locator('#save-btn')).toBeEnabled();
        await page.screenshot({ path: `${SHOT}/save-error.png` });
    });

    test('a save that never answers unsticks the button instead of hanging forever', async ({ page }) => {
        // Freeze time so the 25 s watchdog is testable without waiting for it.
        await page.clock.install();
        await openSetup(page);

        await save(page, '100.101.102.103');
        await expect(page.locator('#save-btn')).toBeDisabled();

        await page.clock.fastForward(26000);

        await expect(page.locator('#status')).toHaveClass(/err/);
        await expect(page.locator('#status')).toContainText('did not answer in time');
        await expect(page.locator('#save-btn')).toBeEnabled();
        expect((await ipcCalls(page)).some((c) => c.cmd === 'save_config')).toBe(true);
    });
});

test.describe('box setup screen — Android', () => {
    test.use({ userAgent: ANDROID_UA });

    test('forces certificate pinning and hides the tray-only options', async ({ page }) => {
        await openSetup(page, { get_config: { server_url: 'https://100.101.102.103:3443' } });

        // A phone has no tray and no autostart: those toggles would do nothing.
        await expect(page.locator('#desktop-opts')).toBeHidden();

        // The WebView cannot be told about a pinned fingerprint, and this server's
        // certificate is self-signed, so the pin is the app's only trust anchor —
        // it is established unconditionally and cannot be switched off.
        const pin = page.locator('#pin-cert');
        await expect(pin).toBeChecked();
        await expect(pin).toBeDisabled();
        await expect(page.locator('#pin-hint')).toContainText('always pins');

        await save(page, '100.101.102.103');
        await expect.poll(async () => (await ipcCalls(page)).filter((c) => c.cmd === 'save_config').length).toBe(1);
        expect((await ipcCalls(page)).find((c) => c.cmd === 'save_config')!.args.pinCert).toBe(true);

        await page.screenshot({ path: `${SHOT}/android-setup.png`, fullPage: true });
    });
});
