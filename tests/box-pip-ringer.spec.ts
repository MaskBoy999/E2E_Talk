import { test, expect, type Page } from '@playwright/test';
import {
    contentBox,
    frameOfViewport,
    isFullPattern,
    quadrants,
    type Rect,
} from './_vision';

/**
 * The Android-only behaviour that has no web equivalent.
 *
 * Three separate reports are covered here:
 *
 *  1. **PiP does nothing on a phone.** The system WebView implements neither
 *     `document.pictureInPictureEnabled` nor `requestPictureInPicture()`, so the
 *     desktop path is unreachable and the button said "not supported". The box
 *     uses *activity* PiP instead (the system shrinks the window) with the tile
 *     lifted into a full-viewport wrapper — exactly what the app's own fullscreen
 *     does, so rotation/mirror come along. The assertions below are pixels, not
 *     flags: the tile has to actually fill the window, and everything else has to
 *     actually be gone.
 *  2. **Declining from the notification was cosmetic.** The action only dismissed
 *     the notification; nothing told the page, so the caller kept ringing. It now
 *     reaches the page through the plugin (see CallServicePlugin.kt), and the
 *     hand-off is asserted here.
 *  3. **The phone ignored the user's ringer settings.** The notification's own
 *     channel follows the ringer mode, but the app also rings *itself* through
 *     WebAudio and the vibrator, neither of which knows a phone can be silenced.
 *     The profile gate is asserted per mode.
 */

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';
const PASSWORD = 'testpass1234';
const SHOT = 'test-results/box-pip-ringer';

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
 * The Tauri bridge the Android box provides, with per-command replies the test
 * can change while the page is live (so a PiP window can be "closed" externally,
 * which is exactly what the system's own close button does).
 */
async function installAndroidBridge(page: Page, replies: Record<string, unknown> = {}) {
    await page.addInitScript((initial) => {
        const invoked: any[] = [];
        (window as any).__testInvoked = invoked;
        (window as any).__bridgeReplies = initial;
        (window as any).__TAURI__ = {
            core: {
                invoke: (cmd: string, args: any) => {
                    invoked.push({ cmd, args });
                    const r = (window as any).__bridgeReplies[cmd];
                    if (r === undefined) return Promise.resolve(null);
                    return Promise.resolve(r);
                },
            },
        };
    }, replies);
}

/**
 * The Android WebView, as far as this page can tell: an Android UA and **no**
 * Picture-in-Picture API on the document.
 */
async function androidWebView(page: Page) {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'userAgent', {
            get: () =>
                'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.43 Mobile Safari/537.36',
            configurable: true,
        });
        Object.defineProperty(Document.prototype, 'pictureInPictureEnabled', {
            get: () => false,
            configurable: true,
        });
    });
}

/**
 * A relay tile carrying a 64x64 four-colour 2x2 image — exactly what
 * `_vision`'s quadrant sampler reads.
 *
 * It goes in a fixed 200x200 host, because the real `.relay-video` rules
 * (`height:100% !important`) would resolve against the whole document if the
 * element were left loose on the body.
 */
async function installPatternTile(page: Page) {
    await page.evaluate(() => {
        const c = document.createElement('canvas');
        c.width = 64;
        c.height = 64;
        const g = c.getContext('2d')!;
        g.fillStyle = '#ff0000'; g.fillRect(0, 0, 32, 32);
        g.fillStyle = '#00ff00'; g.fillRect(32, 0, 32, 32);
        g.fillStyle = '#0000ff'; g.fillRect(0, 32, 32, 32);
        g.fillStyle = '#ffff00'; g.fillRect(32, 32, 32, 32);
        const host = document.createElement('div');
        host.id = 'test-pip-host';
        host.style.cssText = 'position:fixed;left:120px;top:120px;width:200px;height:200px;z-index:5';
        const img = document.createElement('img');
        img.className = 'relay-video';
        img.setAttribute('data-uid', 'pip-user');
        img.setAttribute('data-kind', 'camera');
        (window as any).__pipTile = img;
        img.src = c.toDataURL('image/png');
        host.appendChild(img);
        document.body.appendChild(host);
        return new Promise<void>((resolve) => {
            const done = () => resolve();
            img.onload = done;
            try { img.decode().then(done, done); } catch (_) { /* onload covers it */ }
        });
    });
}

function viewportRect(page: Page): Promise<Rect> {
    return page.evaluate(() => {
        const w = document.querySelector('.e2e-pip-wrap');
        const r = w ? w.getBoundingClientRect() : document.documentElement.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
}

test.describe('native (Android) picture-in-picture', () => {
    test('the tile fills the whole PiP window and everything else is hidden', async ({ page }) => {
        const user = unique('apip');
        await installAndroidBridge(page, { 'plugin:call-service|enterPip': { inPip: true }, 'plugin:call-service|pipState': { inPip: true } });
        await androidWebView(page);
        await register(page, user);
        await installPatternTile(page);

        // Control: before PiP the four-colour pattern is a thumbnail inside the
        // app, and the app itself is on screen.
        const before = await page.evaluate(() => {
            const t = (window as any).__pipTile as HTMLElement;
            const r = t.getBoundingClientRect();
            return {
                wrap: !!document.querySelector('.e2e-pip-wrap'),
                vis: getComputedStyle(document.querySelector('.app')!).visibility,
                size: Math.min(r.width, r.height),
            };
        });
        const vp = await viewportRect(page);
        await page.screenshot({ path: `${SHOT}/01-before-pip.png` });
        expect(before.wrap).toBe(false);
        expect(before.vis).toBe('visible');
        expect(
            before.size,
            'the tile must be a thumbnail before PiP is asked for'
        ).toBeLessThan(Math.min(vp.width, vp.height) * 0.6);

        // Ask for PiP on the tile, through the same entry point the picker uses.
        const started = await page.evaluate(() =>
            (window as any).VoiceManager.startAndroidPiP((window as any).__pipTile, 'pip-user', 'camera')
        );
        expect(started).toBe(true);

        // It asked the platform, with the tile's own (post-rotation) aspect ratio.
        const invoke = await page.evaluate(() =>
            (window as any).__testInvoked.filter((i: any) => i.cmd === 'plugin:call-service|enterPip')[0]
        );
        expect(invoke).toBeTruthy();
        expect(invoke.args.aspectRatio).toBeGreaterThan(0.4195);
        expect(invoke.args.aspectRatio).toBeLessThan(2.38);
        expect(invoke.args.aspectRatio).toBeCloseTo(1, 1); // a square 64x64 tile

        // The app is stripped down: only the wrapper is visible.
        const vis = await page.evaluate(() => {
            const app = document.querySelector('.app');
            return {
                app: app ? getComputedStyle(app).visibility : 'missing',
                tile: getComputedStyle((window as any).__pipTile).visibility,
                inWrap: !!(window as any).__pipTile.closest('.e2e-pip-wrap'),
            };
        });
        expect(vis.inWrap, 'the tile must live in the PiP wrapper').toBe(true);
        expect(vis.tile).toBe('visible');
        expect(vis.app, 'the rest of the app must be hidden').toBe('hidden');

        // And the pixels say the same thing: the four colours fill the window.
        await page.waitForTimeout(250);
        const frame = await frameOfViewport(page);
        const box = contentBox(frame, vp);
        await page.screenshot({ path: `${SHOT}/02-pip-active.png` });
        expect(box, 'the PiP window must be showing the tile, not a blank rectangle').not.toBeNull();
        expect(isFullPattern(quadrants(frame, box!)), 'the picture must be the full tile, uncropped').toBe(true);
        expect(
            Math.min(box!.width, box!.height),
            'the tile must fill the window, not sit in it'
        ).toBeGreaterThan(Math.min(vp.width, vp.height) * 0.6);

        // Leaving PiP puts the tile back and un-hides the app.
        await page.evaluate(() => (window as any).VoiceManager.teardownAndroidPiP());
        await page.waitForTimeout(400);
        const after = await page.evaluate(() => ({
            active: document.body.classList.contains('e2e-pip-active'),
            wrap: !!document.querySelector('.e2e-pip-wrap'),
            vis: getComputedStyle(document.querySelector('.app')!).visibility,
            connected: !!(window as any).__pipTile.isConnected,
        }));
        expect(after).toEqual({ active: false, wrap: false, vis: 'visible', connected: true });
        await page.screenshot({ path: `${SHOT}/03-after-pip.png` });
    });

    test('a refused PiP request puts the tile back and says why', async ({ page }) => {
        const user = unique('apipx');
        // What an OEM that does not offer PiP (or a user who turned it off for
        // the app) looks like.
        await installAndroidBridge(page, {
            'plugin:call-service|enterPip': { inPip: false },
            'plugin:call-service|pipState': { inPip: false },
        });
        await androidWebView(page);
        await register(page, user);
        await installPatternTile(page);

        const started = await page.evaluate(() =>
            (window as any).VoiceManager.startAndroidPiP((window as any).__pipTile, 'pip-user', 'camera')
        );
        expect(started).toBe(false);

        const state = await page.evaluate(() => ({
            active: document.body.classList.contains('e2e-pip-active'),
            wrap: !!document.querySelector('.e2e-pip-wrap'),
            vis: getComputedStyle(document.querySelector('.app')!).visibility,
        }));
        // The app must not be left stripped down with no window to show for it.
        expect(state.active).toBe(false);
        expect(state.wrap).toBe(false);
        expect(state.vis).toBe('visible');
        // ...and the user has to be told why nothing happened. (The box raises
        // other toasts at load — the notification-permission one — so this looks
        // for the message anywhere on the page rather than in a specific node.)
        await expect
            .poll(() => page.evaluate(() => document.body.innerText.includes('not available')), {
                timeout: 5000,
            })
            .toBe(true);
    });

    test('closing the PiP window with the system button restores the tile', async ({ page }) => {
        const user = unique('apipc');
        await installAndroidBridge(page, {
            'plugin:call-service|enterPip': { inPip: true },
            // Still open at first — then the user closes it. There is no event
            // for that, which is why the page polls.
            'plugin:call-service|pipState': { inPip: true },
        });
        await androidWebView(page);
        await register(page, user);
        await installPatternTile(page);

        await page.evaluate(() =>
            (window as any).VoiceManager.startAndroidPiP((window as any).__pipTile, 'pip-user', 'camera')
        );
        expect(await page.evaluate(() => (window as any).VoiceManager.isAndroidPipActive())).toBe(true);

        await page.evaluate(() => {
            (window as any).__bridgeReplies['plugin:call-service|pipState'] = { inPip: false };
        });
        await expect
            .poll(() => page.evaluate(() => (window as any).VoiceManager.isAndroidPipActive()), { timeout: 5000 })
            .toBe(false);
        expect(await page.evaluate(() => document.body.classList.contains('e2e-pip-active'))).toBe(false);
        expect(await page.evaluate(() => document.querySelector('.e2e-pip-wrap') === null)).toBe(true);
    });

    test('leaving the call cannot leave a PiP window behind', async ({ page }) => {
        const user = unique('apipd');
        await installAndroidBridge(page, {
            'plugin:call-service|enterPip': { inPip: true },
            'plugin:call-service|pipState': { inPip: true },
        });
        await androidWebView(page);
        await register(page, user);
        await installPatternTile(page);

        await page.evaluate(() =>
            (window as any).VoiceManager.startAndroidPiP((window as any).__pipTile, 'pip-user', 'camera')
        );
        await page.evaluate(() => (window as any).VoiceManager.leaveVoice());
        await page.waitForTimeout(400);

        const state = await page.evaluate(() => ({
            active: document.body.classList.contains('e2e-pip-active'),
            wrap: !!document.querySelector('.e2e-pip-wrap'),
            // It must also have asked the platform to close the window.
            asked: (window as any).__testInvoked.some((i: any) => i.cmd === 'plugin:call-service|exitPip'),
        }));
        expect(state.active).toBe(false);
        expect(state.wrap).toBe(false);
        expect(state.asked).toBe(true);
    });
});

test.describe('the phone decides whether the app makes a noise', () => {
    test('the ringer mode gates every haptic cue, and DND overrides it', async ({ page }) => {
        const user = unique('ring');
        await register(page, user);

        // Every cue in the app ends in `navigator.vibrate` outside the box, so
        // this is the observable end of the gate.
        const cues = await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            const seen: any[] = [];
            (navigator as any).vibrate = (p: any) => { seen.push(p); return true; };
            const cue = () => V.vibrateNotifCue('notifDm');

            V.setAudioProfile({ mode: 'silent' });
            cue();
            const silent = { buzz: seen.length, sound: V.soundAllowed(), haptic: V.hapticAllowed() };

            V.setAudioProfile({ mode: 'vibrate' });
            cue();
            const vibrate = { buzz: seen.length, sound: V.soundAllowed(), haptic: V.hapticAllowed() };

            V.setAudioProfile({ mode: 'normal', dnd: true });
            cue();
            const dnd = { buzz: seen.length, sound: V.soundAllowed(), haptic: V.hapticAllowed() };

            V.setAudioProfile({ mode: 'normal', dnd: false });
            cue();
            const normal = { buzz: seen.length, sound: V.soundAllowed(), haptic: V.hapticAllowed() };

            V.setAudioProfile(null);
            cue();
            const unknown = { buzz: seen.length, sound: V.soundAllowed(), haptic: V.hapticAllowed() };
            return { silent, vibrate, dnd, normal, unknown };
        });

        // Silent: neither. Vibrate: buzz, no sound. DND: neither. Normal: both.
        expect(cues.silent).toEqual({ buzz: 0, sound: false, haptic: false });
        expect(cues.vibrate).toEqual({ buzz: 1, sound: false, haptic: true });
        expect(cues.dnd).toEqual({ buzz: 1, sound: false, haptic: false });
        expect(cues.normal).toEqual({ buzz: 2, sound: true, haptic: true });
        // Unknown (a browser, or a cold start): allow — a ring the user hears
        // beats a call they never notice.
        expect(cues.unknown).toEqual({ buzz: 3, sound: true, haptic: true });
    });

    test('an incoming call does not ring out loud on a silenced phone', async ({ page }) => {
        const user = unique('ringt');
        await register(page, user);

        const result = await page.evaluate(async () => {
            const V = (window as any).VoiceManager;
            const gain = () => !!V._debug.state._ringtoneGain;

            V.setAudioProfile({ mode: 'silent' });
            V.playRingtone(true);
            await new Promise((r) => setTimeout(r, 400));
            const onSilent = gain();
            V.stopRingtone();

            V.setAudioProfile({ mode: 'vibrate' });
            V.playRingtone(true);
            await new Promise((r) => setTimeout(r, 400));
            const onVibrate = gain();
            V.stopRingtone();

            V.setAudioProfile({ mode: 'normal' });
            V.playRingtone(true);
            await new Promise((r) => setTimeout(r, 600));
            const onNormal = gain();
            V.stopRingtone();

            // The Settings preview is an explicit request, so it still plays.
            V.setAudioProfile({ mode: 'silent' });
            V.playRingtone(false);
            await new Promise((r) => setTimeout(r, 600));
            const preview = gain();
            V.stopRingtone();
            V.setAudioProfile(null);
            return { onSilent, onVibrate, onNormal, preview };
        });

        expect(result.onSilent, 'silent mode must not ring').toBe(false);
        expect(result.onVibrate, 'vibrate mode must not ring').toBe(false);
        expect(result.onNormal, 'a normal ringer must still ring').toBe(true);
        expect(result.preview, 'the Test ringtone button must still be audible').toBe(true);
    });

    test('the notification is built from the app\u2019s own ring cue', async ({ page }) => {
        const user = unique('ringn');
        await installAndroidBridge(page);
        await androidWebView(page);
        await register(page, user);

        // The ring notification is only raised while the app is backgrounded.
        await page.evaluate(() => {
            Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
        });

        const ring = () =>
            page.evaluate(() => {
                (window as any).VoiceManager.showIncomingCall({
                    callerId: 'caller-1',
                    callerUsername: 'bob',
                    dmChannelId: 'dm-1',
                });
                const all = (window as any).__testInvoked.filter(
                    (i: any) => i.cmd === 'plugin:call-service|incomingCall'
                );
                return all[all.length - 1];
            });

        const first = await ring();
        // A notification channel's vibration pattern is fixed at creation, so the
        // pattern has to be handed to the native side with every ring — otherwise
        // the phone uses its own default buzz, which is the reported bug.
        expect(first.args.vibratePattern).toEqual([150, 80, 150]);

        await page.evaluate(() => (window as any).VoiceManager.setHapticSetting('hapticIncoming', false));
        const second = await ring();
        expect(second.args.vibratePattern).toEqual([]);
    });

    test('declining from the shade ends the call, and only the right one', async ({ page }) => {
        const user = unique('decl');
        await register(page, user);

        const res = await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            V._debug.state.incomingCall = {
                callerId: 'caller-1',
                callerUsername: 'bob',
                dmChannelId: 'dm-77',
            };
            // A stale notification for another channel must not end anything.
            const wrong = V.declineIncomingFromNotification('dm-99');
            const survived = !!V.getIncomingCall();
            // The real one ends the call exactly as the in-app Decline does.
            const right = V.declineIncomingFromNotification('dm-77');
            return { wrong, survived, right, after: V.getIncomingCall() };
        });

        expect(res.wrong).toBe(false);
        expect(res.survived).toBe(true);
        expect(res.right).toBe(true);
        expect(res.after).toBeNull();

        // With no ring in flight at all it is a no-op rather than an error.
        expect(
            await page.evaluate(() => (window as any).VoiceManager.declineIncomingFromNotification('dm-77'))
        ).toBe(false);
    });
});
