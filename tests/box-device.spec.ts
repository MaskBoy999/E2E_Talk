import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// Two features that only exist because the WebView cannot do them itself:
//
//   1. Haptics. Chromium **disabled the Vibration API on Android in v79** and
//      left the interface in place: `navigator.vibrate` is defined, is not
//      blocked, returns true while the page is visible, and does nothing. So
//      every cue — including the Settings "Test pattern" buttons, which are
//      exactly where a user goes to check — worked in a browser and was silently
//      dead inside the Android app. `window.boxHaptic` routes them to the
//      box-shell plugin's real vibrator instead, and keeps the web API for a
//      browser and the desktop box.
//   2. Notification hygiene. Notifications the user had already read stayed in
//      the shade for good (the notification plugin's shim posts a plain object
//      with no `close()`), and the app posted system notifications even while the
//      user was looking at it. Coming back to the app now clears the shade —
//      minus an ongoing call — and the app posts nothing while it is in front.
//
// Both are checked against the JS bridge (isolated, in a bare page) and through
// the real app page, because "the Test pattern button does nothing" is a fact
// about the shipped page, not about the bridge alone.

const ROOT = path.join(__dirname, '..');
const SHELL = fs.readFileSync(path.join(ROOT, 'static', 'box-shell.js'), 'utf8');
const BASE = 'https://localhost:3443';

const ANDROID_UA =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

/** Stands in for the Tauri bridge: records every `plugin:box-shell|…` invoke. */
const STUB = `
    window.__boxCalls = [];
    window.__TAURI__ = {
        core: {
            invoke: function (cmd, args) {
                window.__boxCalls.push({ cmd: cmd, args: args || {} });
                return Promise.resolve();
            }
        },
        event: { listen: function () { return Promise.resolve(function () {}); } }
    };
    window.__vibrated = [];
    navigator.vibrate = function (pattern) { window.__vibrated.push(pattern); return true; };
`;

function callsFor(cmd: string) {
    return `window.__boxCalls.filter(function (c) { return c.cmd === 'plugin:box-shell|' + '${cmd}'; })`;
}

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 20000 });
}

/** Install the bridge stub + a counting Notification on an already-loaded page. */
async function stubBridge(page: any) {
    await page.evaluate(() => {
        (window as any).__boxCalls = [];
        (window as any).__TAURI__ = {
            core: {
                invoke: (cmd: string, args: any) => {
                    (window as any).__boxCalls.push({ cmd, args: args || {} });
                    return Promise.resolve();
                },
            },
            event: { listen: () => Promise.resolve(() => {}) },
        };
        (window as any).__posted = [];
        (window as any).Notification = function (title: string) {
            (window as any).__posted.push(title);
        };
        (window as any).Notification.permission = 'granted';
    });
}

test.describe('the haptic bridge, in isolation', () => {
    test.use({ userAgent: ANDROID_UA });

    test('inside the Android box it buzzes the real vibrator, not the dead web API', async ({ page }) => {
        await page.setContent('<p>app</p>');
        // setContent does not navigate, so an init script would never run — the
        // stub has to be a script tag, installed before the shell script.
        await page.addScriptTag({ content: STUB });
        await page.addScriptTag({ content: SHELL });

        expect(await page.evaluate('window.boxHaptic([150, 80, 150])'), 'a cue was delivered').toBe(true);
        await expect.poll(() => page.evaluate(`(${callsFor('vibrate')}).length`)).toBe(1);
        const call = await page.evaluate(`(${callsFor('vibrate')})[0]`);
        expect(call.args.pattern, 'the configured pulse/gap/pulse pattern').toEqual([150, 80, 150]);
        expect(await page.evaluate('window.__vibrated.length'), 'the WebView API is not used in the box').toBe(0);
    });

    test('an empty pattern reaches the plugin too (it means "stop vibrating")', async ({ page }) => {
        await page.setContent('<p>app</p>');
        await page.addScriptTag({ content: STUB });
        await page.addScriptTag({ content: SHELL });

        await page.evaluate('window.boxHaptic([])');
        await expect.poll(() => page.evaluate(`(${callsFor('vibrate')}).length`)).toBe(1);
        expect(await page.evaluate(`(${callsFor('vibrate')})[0].args.pattern`)).toEqual([]);
    });
});

test.describe('the haptic bridge, outside the box', () => {
    test('a plain browser keeps the web Vibration API', async ({ page }) => {
        await page.setContent('<p>app</p>');
        await page.addScriptTag({ content: STUB });
        // No Android UA: `__TAURI__` is present here only to prove the UA guard
        // is what keeps a desktop box off the plugin.
        await page.addScriptTag({ content: 'delete window.__TAURI__;' });
        await page.addScriptTag({ content: SHELL });

        expect(await page.evaluate('window.boxHaptic([60, 40, 60])')).toBe(true);
        expect(await page.evaluate('window.__vibrated')).toEqual([[60, 40, 60]]);
        expect(await page.evaluate('window.__boxCalls.length'), 'no plugin call without the box').toBe(0);
    });

    test('a desktop box with the bridge present still uses the web API', async ({ page }) => {
        await page.setContent('<p>app</p>');
        await page.addScriptTag({ content: STUB });
        await page.addScriptTag({ content: SHELL });

        await page.evaluate('window.boxHaptic([30])');
        expect(await page.evaluate('window.__vibrated')).toEqual([[30]]);
        expect(await page.evaluate(`(${callsFor('vibrate')}).length`)).toBe(0);
    });

    test('a device with no vibrator at all is not an error', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.setContent('<p>app</p>');
        await page.addScriptTag({
            content: "Object.defineProperty(navigator, 'vibrate', { value: undefined, configurable: true });",
        });
        await page.addScriptTag({ content: SHELL });

        expect(await page.evaluate('window.boxHaptic([30])')).toBe(false);
        expect(errors).toEqual([]);
    });
});

test.describe('in the Android app', () => {
    test.use({ userAgent: ANDROID_UA });
    test.setTimeout(90000);

    test('the Settings "Test pattern" buttons buzz the phone (the reported bug)', async ({ page }) => {
        await registerUser(page, 'haptic_' + Date.now());
        await stubBridge(page);

        // The function behind every Test button + the Real one: Settings →
        // Notification haptics. This is what a user presses to check, and what
        // used to do nothing at all inside the app.
        const pattern = await page.evaluate(() => {
            const vm = (window as any).VoiceManager;
            vm.setHapticSetting('hapticNotifInbox', true);
            vm.setHapticSetting('hapticNotifInboxPattern', { pulse: 120, gap: 90, pulses: 2 });
            vm.testHapticPattern('notifInbox');
            return vm.getHapticPattern('notifInbox');
        });
        expect(pattern).toEqual({ pulse: 120, gap: 90, pulses: 2 });

        await expect.poll(() => page.evaluate(`(${callsFor('vibrate')}).length`)).toBe(1);
        expect(await page.evaluate(`(${callsFor('vibrate')})[0].args.pattern`)).toEqual([120, 90, 120]);

        // And the button itself, not just the function it calls.
        await page.evaluate(() => (document.getElementById('notif-haptic-inbox-test') as HTMLButtonElement).click());
        await expect.poll(() => page.evaluate(`(${callsFor('vibrate')}).length`)).toBe(2);
    });

    test('no system notification while the app is open, and one while it is not', async ({ page }) => {
        await registerUser(page, 'notif_' + Date.now());
        await stubBridge(page);

        // In front: the badge/toast/sound already told the user everything.
        expect(await page.evaluate(() => document.hidden), 'the app starts in front').toBe(false);
        await page.evaluate(() => (window as any).showBrowserNotification('Someone', 'A message'));
        expect(await page.evaluate('window.__posted.length'), 'nothing posted while looking at the app').toBe(0);

        // Backgrounded: the shade is exactly where it belongs.
        await page.evaluate(() => {
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        });
        await page.evaluate(() => (window as any).showBrowserNotification('Someone', 'A message'));
        expect(await page.evaluate('window.__posted'), 'posted while the app is not in front').toEqual(['Someone']);
    });

    test('coming back to the app clears the shade, keeping the ongoing call', async ({ page }) => {
        await registerUser(page, 'clear_' + Date.now());
        await stubBridge(page);

        // The events Android delivers for "the box is in front again" — it is
        // inconsistent about which one arrives after a lock-screen cycle or a
        // task switch, so both are wired and both are idempotent.
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect.poll(() => page.evaluate(`(${callsFor('clearNotifications')}).length`)).toBe(1);

        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await expect.poll(() => page.evaluate(`(${callsFor('clearNotifications')}).length`)).toBe(2);
    });

    test('clearing the phone\'s shade leaves the in-app unread state alone', async ({ page }) => {
        await registerUser(page, 'unread_' + Date.now());
        await stubBridge(page);

        // A mention lands in the notification box the way the app really learns
        // about one (the same entry point the WebSocket handler uses). The unread
        // stores are top-level `let` bindings, so they are reachable as bare
        // names in page scope but are *not* on `window`.
        await page.evaluate(() => {
            (window as any).VoiceManager.setHapticSetting('hapticNotifInbox', true);
            (window as any).trackUnreadMention('srv-1', 'chan-1', null, 'msg-1', 'Alice', 'general', 'Server', 'mention', 'u1', null);
        });
        expect(await page.evaluate('mentionItems.length')).toBe(1);

        // The mention is itself a haptic event on the phone — the notification
        // cue, through the same native bridge the Test buttons use.
        await expect.poll(() => page.evaluate(`(${callsFor('vibrate')}).length`)).toBe(1);
        expect(await page.evaluate(`(${callsFor('vibrate')})[0].args.pattern`)).toEqual([120, 90, 120]);

        // Entering the app dismisses the phone's notifications…
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect.poll(() => page.evaluate(`(${callsFor('clearNotifications')}).length`)).toBe(1);

        // …and nothing else. The notification box is the app's own record of
        // what is unread, and it is cleared by opening that channel or DM (or by
        // the reader acking it) — never by walking back into the app, which is
        // exactly the state a user returns to *to see* what they missed.
        expect(await page.evaluate('mentionItems.length'), 'the inbox keeps the mention').toBe(1);
        expect(
            await page.evaluate("unreadMentionsByChannel['chan-1'].count"),
            'the channel still counts as unread',
        ).toBe(1);
        // (unreadDms is deliberately not asserted here: the DM counts are
        // server-derived and re-synced, so a fresh account resets them — which is
        // a property of the server, not of clearing the shade.)
        expect(
            await page.evaluate(`(${callsFor('vibrate')}).length`),
            'and clearing the shade is not a haptic event of its own',
        ).toBe(1);
    });
});

test.describe('outside the box, notification hygiene stays out of the way', () => {
    test('a desktop box never asks to clear the shade', async ({ page }) => {
        await page.setContent('<p>app</p>');
        await page.addScriptTag({ content: STUB });
        await page.addScriptTag({ content: SHELL });

        await page.evaluate(() => {
            window.dispatchEvent(new Event('focus'));
            document.dispatchEvent(new Event('visibilitychange'));
        });
        expect(await page.evaluate(`(${callsFor('clearNotifications')}).length`)).toBe(0);
    });
});
