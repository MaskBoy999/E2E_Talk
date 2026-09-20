import { test, expect, chromium } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The desktop box (`e2e-chat-app.exe`) is a native window, so a normal Playwright
 * test cannot reach it — and the failure it needs to catch is invisible from
 * outside: a WebView that loaded *nothing* is a black rectangle either way. A
 * screenshot of the window cannot tell "login screen" from "certificate error",
 * which is exactly how the Android version stayed broken through several
 * "verified" releases.
 *
 * So the box exposes a remote debugging port when `E2E_BOX_DEBUG_PORT` is set
 * (see `webview_browser_args` in `src-tauri/src/lib.rs`), and this spec attaches
 * to it and asserts what a user would actually see.
 *
 * Run it (the box must be started with the variable set):
 *
 *     # one terminal
 *     E2E_BOX_DEBUG_PORT=9333 src-tauri/target/release/e2e-chat-app.exe
 *     # another
 *     npx playwright test tests/box-desktop.spec.ts
 *
 * Without the variable (i.e. in CI) this spec skips rather than failing: it is a
 * verification tool for a real desktop session, not something a headless runner
 * can provide.
 */

const DEBUG_PORT = process.env.E2E_BOX_DEBUG_PORT || '';
const CDP = `http://127.0.0.1:${DEBUG_PORT || '9333'}`;
const SHOT = 'test-results/box-desktop';

type Cfg = { server_url?: string; pinned_cert_sha256?: string };

function boxConfigPath(): string {
    // config.rs → app_config_dir(): %APPDATA%\<identifier>\config.json on Windows.
    return path.join(os.homedir(), 'AppData', 'Roaming', 'com.e2echat.app', 'config.json');
}

function readBoxConfig(): Cfg | null {
    try {
        return JSON.parse(fs.readFileSync(boxConfigPath(), 'utf8')) as Cfg;
    } catch {
        return null;
    }
}

async function cdpUp(): Promise<boolean> {
    try {
        const res = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1500) });
        return res.ok;
    } catch {
        return false;
    }
}

test.describe('desktop box (needs a running box with E2E_BOX_DEBUG_PORT)', () => {
    test('the WebView renders the configured server, not a blank or error page', async () => {
        test.skip(!DEBUG_PORT, 'Set E2E_BOX_DEBUG_PORT and start the box first — see this file\'s header.');
        expect(await cdpUp(), `no DevTools endpoint on ${CDP}`).toBeTruthy();

        const cfg = readBoxConfig();
        test.skip(!cfg?.server_url, 'The box has no saved server to compare against.');

        const browser = await chromium.connectOverCDP(CDP);
        try {
            const pages = browser.contexts().flatMap((c) => c.pages());
            expect(pages.length, 'the box should have exactly one app window').toBeGreaterThan(0);
            const page = pages.find((p) => p.url().startsWith('http')) || pages[0];

            await page.waitForLoadState('domcontentloaded');

            // A configured box that is showing the *setup* page means startup
            // could not open the saved server and silently fell back — the exact
            // "nothing works and nothing explains why" state this is here to catch.
            expect(
                page.url(),
                'the box is showing its setup screen even though a server is saved — ' +
                    'startup failed to open it (check the box\'s stderr for "open_main failed")',
            ).not.toContain('box-setup.html');

            // 1. The loaded document belongs to the server the box was told to use.
            const expectedOrigin = new URL(cfg!.server_url!).origin;
            expect(new URL(page.url()).origin).toBe(expectedOrigin);

            // 2. Something the app itself renders is on screen. A certificate error
            //    (or a cancelled load) leaves Chromium's own page, whose title and
            //    body carry none of this.
            const title = await page.title();
            void title;
            const hasAppShell = await page.evaluate(
                () =>
                    !!document.querySelector('#current-user, #server-strip, #dm-list, .auth-card, #login-form'),
            );
            const bodyText = (await page.evaluate(() => document.body?.innerText || '')).slice(0, 400);
            expect(
                hasAppShell,
                `the box window shows no E2E Chat UI — a failed/cancelled load looks exactly like this.\n` +
                    `url=${page.url()}\nbody="${bodyText}"`,
            ).toBeTruthy();

            // 3. And not Chromium's certificate interstitial, which is the specific
            //    failure this box had on Android.
            expect(bodyText).not.toMatch(/certificate|ERR_CERT|not private|isn't secure/i);

            await page.screenshot({ path: `${SHOT}/box-window.png` });
        } finally {
            // Detach only — never close, that would shut the user's app window.
            await browser.close().catch(() => {});
        }
    });

    test('the box grants camera and microphone without asking the user', async () => {
        test.skip(!DEBUG_PORT, 'Set E2E_BOX_DEBUG_PORT and start the box first — see this file\'s header.');
        expect(await cdpUp(), `no DevTools endpoint on ${CDP}`).toBeTruthy();

        const browser = await chromium.connectOverCDP(CDP);
        try {
            const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('https'))!;
            expect(page, 'the box is not on the app page').toBeTruthy();

            const result = await page.evaluate(async () => {
                const probe = async (constraints: MediaStreamConstraints) => {
                    // A missing grant makes WebView2 raise a modal prompt, and the
                    // request then simply never settles — so bound it, and treat
                    // "still waiting" as the failure it is.
                    const attempt = navigator.mediaDevices
                        .getUserMedia(constraints)
                        .then((s) => {
                            s.getTracks().forEach((t) => t.stop());
                            return { ok: true, name: '', message: '' };
                        })
                        .catch((e) => ({ ok: false, name: e.name, message: String(e.message).slice(0, 120) }));
                    return await Promise.race([
                        attempt,
                        new Promise<{ ok: boolean; name: string; message: string }>((r) =>
                            setTimeout(() => r({ ok: false, name: 'PromptedAndNeverAnswered', message: '' }), 10000),
                        ),
                    ]);
                };
                return {
                    audio: await probe({ audio: true }),
                    video: await probe({ video: true }),
                    micState: (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state,
                    notifications: typeof Notification === 'undefined' ? 'unavailable' : Notification.permission,
                };
            });

            // A device that is missing is not a permission problem: WebView2 only
            // reveals real device names once a grant exists, so an empty label is
            // itself part of "not granted".
            for (const [kind, r] of Object.entries({ audio: result.audio, video: result.video })) {
                expect(
                    r.name,
                    `the box asked for ${kind} instead of granting it (${r.name}: ${r.message}). ` +
                        'Permission grants live in src-tauri/src/win_webview.rs.',
                ).not.toBe('PromptedAndNeverAnswered');
                expect(r.name, `the box denied ${kind} (${r.message})`).not.toMatch(/NotAllowed|Security|Permission/i);
            }
            expect(result.micState).toBe('granted');
            expect(result.notifications).toBe('granted');
        } finally {
            await browser.close().catch(() => {});
        }
    });
});
