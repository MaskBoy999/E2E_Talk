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

/** The tiniest valid JPEG, so the page's `new Image()` decode path runs. */
const TINY_JPEG =
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

/** The Tauri bridge the Android box provides (see screen-share-native.spec.ts). */
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

/** Press Share screen and answer the sheet, the way a phone does. */
async function pressShareScreen(page: Page) {
    await page.evaluate(() => (window as any).VoiceManager.toggleScreen());
    await page.waitForSelector('#screen-share-sheet', { timeout: 5000 });
}

async function startStreaming(page: Page, opts?: { audio?: boolean }) {
    await pressShareScreen(page);
    if (opts && opts.audio === false) await page.uncheck('#share-sheet-audio');
    if (opts && opts.audio === true) await page.check('#share-sheet-audio');
    await page.click('#share-sheet-start');
    await page.waitForTimeout(400);
}

/** Answer the picker and push one decodable frame, like the Kotlin half does. */
async function nativeStartsCapture(page: Page) {
    const ok = await page.evaluate((jpeg) => {
        const ch = (window as any).__testChannels[0];
        if (!ch) return false;
        ch.onmessage({ type: 'started', w: 16, h: 8, fps: 10, audio: true });
        ch.onmessage({ type: 'frame', jpeg, w: 16, h: 8 });
        return true;
    }, TINY_JPEG);
    expect(ok, 'the page must have created a channel to hand to the native side').toBe(true);
}

/** One real 20 ms PCM16 chunk (a 440 Hz tone) — what AudioPlaybackCapture sends. */
async function nativeSendsAudio(page: Page, chunks = 3) {
    await page.evaluate((n) => {
        const ch = (window as any).__testChannels[0];
        ch.onmessage({ type: 'audioStarted', rate: 48000 });
        const samples = 960; // 20 ms @ 48 kHz
        for (let c = 0; c < n; c++) {
            const i16 = new Int16Array(samples);
            for (let i = 0; i < samples; i++) {
                i16[i] = Math.round(12000 * Math.sin(2 * Math.PI * 440 * i / 48000));
            }
            const bytes = new Uint8Array(i16.buffer);
            let bin = '';
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            ch.onmessage({ type: 'audio', pcm: btoa(bin) });
        }
    }, chunks);
}

async function screenAudioTracks(page: Page): Promise<number> {
    return page.evaluate(() => {
        const s = (window as any).VoiceManager._debug.state.localStreams.screen;
        return s ? s.getAudioTracks().length : -1;
    });
}

test.describe('mobile screen share — pre-share sheet', () => {
    /**
     * The sheet is the whole point of the mobile flow: the MediaProjection token
     * is one-shot, so quality and app audio must be answered before the system
     * picker runs. This pins that nothing is asked of the native side until the
     * user confirms.
     */
    test('Share screen asks how first, and only Start streaming captures', async ({ page }) => {
        await installTauriBridge(page);
        await desktopUserAgent(page);
        await removeGetDisplayMedia(page);
        await register(page, unique('ssheet'));

        await pressShareScreen(page);

        // Nothing has been asked of the native side yet.
        const before = await page.evaluate(() =>
            (window as any).__testInvoked.filter((i: any) => i.cmd.includes('ScreenCapture')).length);
        expect(before).toBe(0);
        // The switch defaults to on, so audio sharing is the out-of-the-box answer.
        await expect(page.locator('#share-sheet-audio')).toBeChecked();

        await page.click('#share-sheet-start');
        await page.waitForTimeout(400);

        await expect(page.locator('#screen-share-sheet')).toHaveCount(0);
        const invoked = await page.evaluate(() => (window as any).__testInvoked);
        const start = invoked.find((i: any) => i.cmd === 'plugin:call-service|startScreenCapture');
        expect(start, 'Start streaming must reach the native capture').toBeTruthy();
        expect(start.args.withAudio).toBe(true);
    });

    test('the audio switch is passed to the native side and remembered', async ({ page }) => {
        await installTauriBridge(page);
        await desktopUserAgent(page);
        await removeGetDisplayMedia(page);
        await register(page, unique('ssw'));

        await startStreaming(page, { audio: false });

        const invoked = await page.evaluate(() => (window as any).__testInvoked);
        const start = invoked.find((i: any) => i.cmd === 'plugin:call-service|startScreenCapture');
        expect(start).toBeTruthy();
        expect(start.args.withAudio).toBe(false);

        const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('voice_settings') || '{}'));
        expect(stored.shareScreenAudio).toBe(false);

        // ...and the next sheet reopens on that answer.
        await page.evaluate(() => (window as any).VoiceManager.toggleScreen());
        await pressShareScreen(page);
        await expect(page.locator('#share-sheet-audio')).not.toBeChecked();
    });

    /**
     * The sheet asks about app audio and NOTHING else. It used to offer three
     * "streaming modes" and write the answer into sendScreenRes, so the
     * resolution picked in Settings → Voice → Video Quality was overwritten by
     * whatever the sheet happened to default to every time a phone started a
     * share. The capture size now comes from that one setting.
     */
    test('the sheet has no resolution picker and the Settings resolution is what gets captured', async ({ page }) => {
        await installTauriBridge(page);
        await desktopUserAgent(page);
        await removeGetDisplayMedia(page);
        await register(page, unique('ssres'));

        // What the user chose in Settings.
        await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            S.settings.sendScreenRes = 720;
            localStorage.setItem('voice_settings', JSON.stringify(S.settings));
        });

        await pressShareScreen(page);

        await expect(page.locator('input[name="share-sheet-mode"]')).toHaveCount(0);
        await expect(page.locator('[id^="share-mode-"]')).toHaveCount(0);
        // ...and it still asks the question it is there for.
        await expect(page.locator('#share-sheet-audio')).toHaveCount(1);

        await page.click('#share-sheet-start');
        await page.waitForTimeout(400);

        const invoked = await page.evaluate(() => (window as any).__testInvoked);
        const start = invoked.find((i: any) => i.cmd === 'plugin:call-service|startScreenCapture');
        expect(start.args.maxHeight).toBe(720);
        // The sheet must not rewrite the setting it read.
        const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('voice_settings') || '{}'));
        expect(stored.sendScreenRes).toBe(720);
    });

    /**
     * The Send frame rate (Settings → Voice → Video Quality) reaches the native
     * capture instead of the hard-coded 10 fps the Android path used to ask the
     * Kotlin side for.
     */
    test('the native capture is asked for the Settings frame rate', async ({ page }) => {
        await installTauriBridge(page);
        await desktopUserAgent(page);
        await removeGetDisplayMedia(page);
        await register(page, unique('ssfps'));

        await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            S.settings.relayVideoFps = 12;
            localStorage.setItem('voice_settings', JSON.stringify(S.settings));
        });

        await startStreaming(page);

        const invoked = await page.evaluate(() => (window as any).__testInvoked);
        const start = invoked.find((i: any) => i.cmd === 'plugin:call-service|startScreenCapture');
        expect(start.args.fps).toBe(12);
    });

    test('a desktop browser share never shows the sheet', async ({ page }) => {
        await register(page, unique('ssdesktop'));

        await page.evaluate(() => {
            // A browser has getDisplayMedia; the picker itself cannot be driven
            // headless, and a rejection is still a real answer from the browser
            // path — which is what matters here.
            (navigator.mediaDevices as any).getDisplayMedia =
                () => Promise.reject(new DOMException('cancelled', 'AbortError'));
        });
        await page.evaluate(() => (window as any).VoiceManager.toggleScreen());
        await page.waitForTimeout(500);

        await expect(page.locator('#screen-share-sheet')).toHaveCount(0);
        const diag = await page.evaluate(() => (window as any).VoiceManager.getScreenDiag());
        expect(diag.path).toBe('browser');
    });
});

test.describe('mobile screen share — app audio', () => {
    /**
     * The audio path's contract: the PCM the native capture sends has to end up
     * as a real audio track ON the screen stream, because that is what both the
     * relay and the mesh read when they decide whether to send screen audio at
     * all. A track created after that decision is silently ignored.
     */
    test('native PCM becomes an audio track on the screen stream', async ({ page }) => {
        await installTauriBridge(page);
        await desktopUserAgent(page);
        await removeGetDisplayMedia(page);
        await register(page, unique('ssaudio'));

        await startStreaming(page, { audio: true });
        await nativeStartsCapture(page);
        await page.waitForTimeout(1200);
        await nativeSendsAudio(page, 3);
        await page.waitForTimeout(600);

        const diag = await page.evaluate(() => (window as any).VoiceManager.getScreenDiag());
        expect(diag.audioState).toBe('ready');
        expect(diag.audioRate).toBe(48000);
        expect(diag.audioFrames).toBeGreaterThanOrEqual(3);
        expect(diag.audioBytes).toBeGreaterThan(0);
        expect(diag.audioError).toBeNull();

        const audioTracks = await screenAudioTracks(page);
        expect(audioTracks, 'the screen stream must carry the captured app audio').toBe(1);
        const videoTracks = await page.evaluate(() => {
            const s = (window as any).VoiceManager._debug.state.localStreams.screen;
            return s ? s.getVideoTracks().length : -1;
        });
        expect(videoTracks).toBe(1);
    });

    test('with the switch off the stream has no audio track at all', async ({ page }) => {
        await installTauriBridge(page);
        await desktopUserAgent(page);
        await removeGetDisplayMedia(page);
        await register(page, unique('ssnoaudio'));

        await startStreaming(page, { audio: false });
        await nativeStartsCapture(page);
        // The native side was told not to capture, so no audio messages follow —
        // and the page must not have invented a pipeline of its own.
        await page.waitForTimeout(1200);

        const diag = await page.evaluate(() => (window as any).VoiceManager.getScreenDiag());
        expect(diag.audioState).toBe('off');
        expect(diag.audioFrames).toBe(0);
        expect(await screenAudioTracks(page)).toBe(0);
    });

    /**
     * Android (or the app being streamed) can refuse playback capture — DRM
     * audio never can be captured, and the policy is per-app. That must cost the
     * stream its audio, and nothing else: the refusal is reported from `begin()`,
     * so it lands before the stream is handed to the pipeline, and the silent
     * track must not be attached.
     */
    test('a refused audio capture leaves the video share running', async ({ page }) => {
        await installTauriBridge(page);
        await desktopUserAgent(page);
        await removeGetDisplayMedia(page);
        await register(page, unique('ssrefused'));

        await startStreaming(page, { audio: true });
        await page.evaluate(() => {
            const ch = (window as any).__testChannels[0];
            ch.onmessage({ type: 'audioError', message: 'the device refused the audio capture' });
        }, );
        await nativeStartsCapture(page);
        await page.waitForTimeout(1200);

        const diag = await page.evaluate(() => (window as any).VoiceManager.getScreenDiag());
        expect(diag.audioState).toBe('error');
        expect(String(diag.audioError)).toContain('refused');
        expect(diag.state).toBe('capturing');
        expect(diag.decoded).toBeGreaterThanOrEqual(1);
        expect(await screenAudioTracks(page)).toBe(0);
    });

    test('the diagnostics panel names the audio state without adb', async ({ page }) => {
        await installTauriBridge(page);
        await desktopUserAgent(page);
        await removeGetDisplayMedia(page);
        await register(page, unique('ssdiag'));

        await startStreaming(page, { audio: true });
        await page.evaluate(() => {
            const ch = (window as any).__testChannels[0];
            ch.onmessage({ type: 'audioError', message: 'SecurityException: playback capture denied' });
            const d = document.createElement('div');
            d.id = 'voice-diag-list';
            document.body.appendChild(d);
        });
        await nativeStartsCapture(page);
        await page.waitForTimeout(800);
        await page.evaluate(() => (window as any).VoiceManager.refreshVoiceDiag());
        await page.waitForTimeout(400);

        const html = await page.evaluate(() => document.getElementById('voice-diag-list')?.innerHTML || '');
        expect(html).toContain('app audio');
        expect(html).toContain('playback capture denied');
    });
});
