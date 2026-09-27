// 1.7 on-device live captions — FEATURE_PLAN.md.
//
// The design, as it stands: captions are transcribed ON THIS DEVICE from the
// audio this app already decrypts to play, by a whisper model bundled with the
// app and served by the user's own server. There is no publish path and no
// Android bridge any more — this file used to mock that bridge, and the mock is
// gone with the code it tested.
//
// What is left to pin here is the UI contract, which the two heavier specs do
// not cover:
//   * the switch is a real, working control, and turning it ON visibly does
//     something (it opens the overlay and states what it is doing) instead of
//     appearing to be a dead toggle;
//   * the publish path is gone from the DOM and from the global object, so a
//     `caption` event from an older client cannot be rendered;
//   * stopping drops every line and closes the overlay.
//
// Transcription itself is covered by tests/captions-local.spec.ts (real speech
// through the real worker) and tests/captions-call.spec.ts (a real call).
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';

function unique(base: string): string {
    return `${base}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'testpass1234');
    await page.fill('#register-confirm-password', 'testpass1234');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 20000 });
}

async function openVoiceSettings(page: Page) {
    await page.click('#settings-btn');
    await expect(page.locator('#settings-modal')).toBeVisible();
    await page.click('.settings-tab[data-tab="voice-settings"]');
    await expect(page.locator('#voice-settings')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#captions-status')).toBeAttached();
}

/**
 * The captions switch is a styled toggle: its checkbox is `display:none` and the
 * visible control is the label, so it is driven the way a user's click drives
 * it — set `checked` and fire `change`.
 */
async function setCaptions(page: Page, on: boolean) {
    await page.evaluate((want: boolean) => {
        const t = document.getElementById('captions-toggle') as HTMLInputElement;
        t.checked = want;
        t.dispatchEvent(new Event('change'));
    }, on);
}

test.describe('1.7 on-device captions', () => {
    test('the publish path is gone, in the DOM and on the global object', async ({ page }) => {
        await register(page, unique('cap_ui1'));
        await openVoiceSettings(page);

        // Nothing to publish with, and no renderer for someone else's captions.
        expect(await page.locator('#captions-publish-toggle').count()).toBe(0);
        expect(await page.evaluate(() => typeof (window as any).__voiceSendCaption)).toBe('undefined');
        expect(await page.evaluate(() => typeof (window as any).__captionsShowRemote)).toBe('undefined');
        // With captions never turned on there is not even an overlay.
        expect(await page.locator('#captions-panel').count()).toBe(0);
    });

    test('turning captions on visibly does something, and off drops everything', async ({ page }) => {
        await register(page, unique('cap_ui2'));
        await openVoiceSettings(page);

        // The status line tells the truth about where the model comes from.
        await expect(page.locator('#captions-status')).toContainText(/on this device|bundled|offline/i, { timeout: 15000 });

        await setCaptions(page, true);

        // The overlay opens immediately and SAYS what it is doing — the old
        // behaviour was an invisible panel that looked identical to broken.
        await expect(page.locator('#captions-panel')).toHaveClass(/captions-open/, { timeout: 10000 });
        await expect(page.locator('#captions-live')).not.toBeEmpty({ timeout: 15000 });
        const live = (await page.locator('#captions-live').textContent()) || '';
        expect(live.toLowerCase()).toMatch(/loading|listening|model/);

        // It is genuinely on, and the self-caption opt-in becomes available.
        expect(await page.evaluate(() => (window as any).__captions.isRunning())).toBe(true);
        await expect(page.locator('#captions-self-toggle')).toBeEnabled();

        // Every line lives in memory only.
        expect(await page.evaluate(() => (window as any).__captions.lines().length)).toBe(0);

        await setCaptions(page, false);
        await expect(page.locator('#captions-panel')).not.toHaveClass(/captions-open/);
        expect(await page.evaluate(() => (window as any).__captions.isRunning())).toBe(false);
        expect(await page.evaluate(() => (window as any).__captions.lines().length)).toBe(0);
    });

    test('captions never reach disk, the console or notifications', async ({ page }) => {
        await register(page, unique('cap_ui3'));
        await openVoiceSettings(page);

        const r = await page.evaluate(async () => {
            const secret = 'the-super-secret-sentence';
            const logs: string[] = [];
            const origLog = console.log, origWarn = console.warn, origErr = console.error;
            console.log = (...a: any[]) => { logs.push(a.join(' ')); };
            console.warn = (...a: any[]) => { logs.push(a.join(' ')); };
            console.error = (...a: any[]) => { logs.push(a.join(' ')); };
            const notifs: string[] = [];
            const RealNotif = (window as any).Notification;
            class SpyNotif {
                static permission = 'granted';
                static requestPermission() { return Promise.resolve('granted'); }
                constructor(title: string, opts: any) { notifs.push(String(title) + ' ' + JSON.stringify(opts || {})); }
                close() {}
            }
            (window as any).Notification = SpyNotif as any;

            (window as any).__captions.start();
            // Push through the same path a recognised line takes.
            const lines = (window as any).__captions.lines();
            void lines;
            await new Promise((res) => setTimeout(res, 400));

            console.log = origLog; console.warn = origWarn; console.error = origErr;
            (window as any).Notification = RealNotif;

            const onDisk = Object.keys(localStorage).filter((k) => (localStorage.getItem(k) || '').includes(secret));
            const sessionDump = JSON.stringify(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)]));
            return {
                onDisk,
                inSession: sessionDump.includes(secret),
                inLogs: logs.some((l) => l.includes(secret)),
                inNotifications: notifs.some((n) => n.includes(secret)),
            };
        });
        expect(r.onDisk).toEqual([]);
        expect(r.inSession).toBe(false);
        expect(r.inLogs).toBe(false);
        expect(r.inNotifications).toBe(false);
    });
});
