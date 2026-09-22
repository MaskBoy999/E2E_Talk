import { test, expect, type Page } from '@playwright/test';

// E2E_TEST_BASE_URL lets the suite run against a second, isolated server
// instance (its own DB and raised rate limits) without disturbing a dev server.
const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';
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

/**
 * The tiniest valid JPEG, so the page's `new Image()` decode path runs for real
 * rather than being stubbed out. 1x1 — the drawn size comes from the frame
 * message, which is what the production code uses.
 */
const TINY_JPEG =
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

/**
 * Stand in for the Tauri bridge the Android box provides.
 *
 * `Channel` is a plain class whose instances the test can reach, because that is
 * the whole point of the contract: the page hands a channel to
 * `startScreenCapture` and the native side talks back through it. Faking it
 * here is what lets the *page half* of screen sharing be tested at all without
 * a device — the Kotlin half is the only part that genuinely needs hardware.
 */
async function installTauriBridge(page: Page) {
    await page.addInitScript(() => {
        const channels: any[] = [];
        (window as any).__testChannels = channels;
        class Channel {
            onmessage: ((m: any) => void) | null = null;
            constructor() { channels.push(this); }
        }
        const invoked: any[] = [];
        (window as any).__testInvoked = invoked;
        (window as any).__TAURI__ = {
            core: {
                Channel,
                invoke: (cmd: string, args: any) => {
                    invoked.push({ cmd, args });
                    return Promise.resolve(null);
                },
            },
        };
    });
}

/** Make the page look like the Android WebView: no Screen Capture API. */
async function removeGetDisplayMedia(page: Page) {
    await page.addInitScript(() => {
        try {
            Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
                value: undefined,
                configurable: true,
            });
        } catch (_) { /* already absent */ }
    });
}

/** A deliberately non-Android UA, to prove the platform check is not the gate. */
async function desktopUserAgent(page: Page) {
    await page.addInitScript(() => {
        try {
            Object.defineProperty(navigator, 'userAgent', {
                get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                configurable: true,
            });
        } catch (_) { /* ignore */ }
    });
}

/**
 * Press Share screen on the native path.
 *
 * The bridge being present now means the pre-share sheet opens first ("share app
 * audio" has to be answered before the one-shot MediaProjection picker runs —
 * the resolution comes from Settings, see screen-share-audio-mobile.spec.ts for
 * the sheet itself), so a share is only under way once its Start streaming
 * button is pressed.
 */
async function startNativeShare(page: Page) {
    await page.evaluate(() => (window as any).VoiceManager.toggleScreen());
    await page.waitForSelector('#screen-share-sheet', { timeout: 5000 });
    await page.click('#share-sheet-start');
    await page.waitForTimeout(400);
}

test.describe('screen share — native bridge', () => {
    /**
     * The regression this locks down: the native path used to require an
     * Android user agent *and* a channel, so a single failed flag produced a
     * flat "screen sharing is not supported on this device" on hardware that
     * had the bridge. The bridge is now what decides, and the UA is only a hint.
     */
    test('a non-Android UA with no getDisplayMedia still takes the native path', async ({ page }) => {
        const user = unique('ssn');
        await installTauriBridge(page);
        await desktopUserAgent(page);
        await removeGetDisplayMedia(page);
        await register(page, user);

        await startNativeShare(page);
        await page.waitForTimeout(200);

        const diag = await page.evaluate(() => (window as any).VoiceManager.getScreenDiag());
        expect(diag.path).toBe('native');
        expect(diag.blockedBy).toBeNull();
        expect(diag.probe.hasInvoke).toBe(true);
        expect(diag.probe.hasChannel).toBe(true);
        expect(diag.probe.isAndroid).toBe(false);
        // And it actually asked the native side, rather than bailing out.
        const invoked = await page.evaluate(() => (window as any).__testInvoked.map((i: any) => i.cmd));
        expect(invoked).toContain('plugin:call-service|startScreenCapture');
    });

    test('without any bridge the refusal names the real reason', async ({ page }) => {
        const user = unique('ssb');
        await removeGetDisplayMedia(page);
        await register(page, user);

        const toastBefore = await page.evaluate(() => document.querySelector('.global-toast, .toast, #toast-container')?.textContent || '');
        void toastBefore;

        await page.evaluate(() => (window as any).VoiceManager.toggleScreen());
        await page.waitForTimeout(600);

        const diag = await page.evaluate(() => (window as any).VoiceManager.getScreenDiag());
        expect(diag.state).toBe('error');
        expect(diag.path).toBe('native');
        expect(String(diag.blockedBy)).toContain('no native bridge');
    });

    test('frames from the bridge are decoded onto the shared canvas stream', async ({ page }) => {
        const user = unique('ssf');
        await installTauriBridge(page);
        await desktopUserAgent(page);
        await removeGetDisplayMedia(page);
        await register(page, user);

        await startNativeShare(page);

        // The native side answers the picker and starts producing frames.
        // (`expect` is not available inside page.evaluate — the channel's
        // existence is asserted below by its effect instead.)
        const sent = await page.evaluate((jpeg) => {
            const ch = (window as any).__testChannels[0];
            if (!ch) return false;
            ch.onmessage({ type: 'started', w: 16, h: 8, fps: 10 });
            ch.onmessage({ type: 'frame', jpeg, w: 16, h: 8 });
            ch.onmessage({ type: 'frame', jpeg, w: 16, h: 8 });
            return true;
        }, TINY_JPEG);
        expect(sent, 'the page must have created a channel to hand to the native side').toBe(true);
        await page.waitForTimeout(1200);

        const diag = await page.evaluate(() => (window as any).VoiceManager.getScreenDiag());
        expect(diag.state).toBe('capturing');
        expect(diag.frames).toBeGreaterThanOrEqual(2);
        expect(diag.decoded).toBeGreaterThanOrEqual(1);
        expect(diag.w).toBe(16);
        expect(diag.h).toBe(8);
        expect(diag.bytes).toBeGreaterThan(0);

        // The canvas stream is what the rest of the pipeline consumes, so its
        // existence is the real proof that a native share became a normal one.
        const hasStream = await page.evaluate(() => {
            const s = (window as any).VoiceManager._debug.state.localStreams.screen;
            return !!(s && s.getVideoTracks().length > 0);
        });
        expect(hasStream).toBe(true);
    });

    test('a browser share is reported as the browser path', async ({ page }) => {
        const user = unique('ssbr');
        await register(page, user);

        // Pin the path only; the picker itself needs a user gesture in a real
        // browser and cannot be driven headless. A rejection is still a real
        // answer and must be recorded as the browser path, not the native one.
        await page.evaluate(() => {
            (navigator.mediaDevices as any).getDisplayMedia = () => Promise.reject(new DOMException('cancelled', 'AbortError'));
        });
        await page.evaluate(() => (window as any).VoiceManager.toggleScreen());
        await page.waitForTimeout(500);

        const diag = await page.evaluate(() => (window as any).VoiceManager.getScreenDiag());
        expect(diag.path).toBe('browser');
        expect(diag.state).toBe('error');
        expect(String(diag.lastError)).toContain('AbortError');
    });
});

test.describe('screen share — diagnostics panel', () => {
    test('the panel surfaces the screen-share block even outside a call', async ({ page }) => {
        const user = unique('ssd');
        await installTauriBridge(page);
        await desktopUserAgent(page);
        await removeGetDisplayMedia(page);
        await register(page, user);

        await page.evaluate(() => {
            const d = document.createElement('div');
            d.id = 'voice-diag-list';
            document.body.appendChild(d);
        });
        await page.evaluate(() => (window as any).VoiceManager.refreshVoiceDiag());
        await page.waitForTimeout(400);

        const html = await page.evaluate(() => document.getElementById('voice-diag-list')?.innerHTML || '');
        // No call in progress — the screen-share state is exactly what is still
        // worth knowing, so the block must render anyway.
        expect(html).toContain('Screen share');
        expect(html.toLowerCase()).toContain('no screen share attempted');
    });

    test('a failed native share is readable in the panel without adb', async ({ page }) => {
        const user = unique('ssde');
        await installTauriBridge(page);
        await desktopUserAgent(page);
        await removeGetDisplayMedia(page);
        await register(page, user);

        await page.evaluate(() => {
            const d = document.createElement('div');
            d.id = 'voice-diag-list';
            document.body.appendChild(d);
        });
        await startNativeShare(page);
        // The native side reports the failure over the channel.
        await page.evaluate(() => {
            const ch = (window as any).__testChannels[0];
            ch.onmessage({ type: 'error', message: 'could not start screen capture: SecurityException' });
        });
        await page.waitForTimeout(300);
        await page.evaluate(() => (window as any).VoiceManager.refreshVoiceDiag());
        await page.waitForTimeout(400);

        const html = await page.evaluate(() => document.getElementById('voice-diag-list')?.innerHTML || '');
        expect(html).toContain('Screen share');
        expect(html).toContain('error');
        expect(html).toContain('SecurityException');
    });
});
