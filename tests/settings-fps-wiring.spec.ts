import { test, expect, type Page } from '@playwright/test';

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

/** A canvas-backed camera, so the test does not depend on real hardware. */
async function stubCamera(page: Page) {
    await page.evaluate(() => {
        const w = window as any;
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        const stream = (canvas as any).captureStream(5);
        w.__gumCalls = [];
        navigator.mediaDevices.getUserMedia = (constraints: any) => {
            w.__gumCalls.push(constraints);
            return Promise.resolve(stream);
        };
    });
}

// The resolution and frame-rate settings are the app's single source of truth
// for what it sends. The frame rate used to drive ONLY the relay capture loop
// while every other path hard-coded 30 (and the Android capture hard-coded 10),
// so the value chosen in Settings was silently ignored depending on which
// pipeline you happened to be on.
test.describe('Send frame rate setting is wired everywhere', () => {
    test('the camera is captured at the Settings frame rate', async ({ page }) => {
        await register(page, unique('fpscam'));
        await stubCamera(page);

        await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            S.settings.relayVideoFps = 7;
            localStorage.setItem('voice_settings', JSON.stringify(S.settings));
        });

        await page.evaluate(() => (window as any).VoiceManager.toggleCamera());
        await page.waitForTimeout(1000);

        const calls = await page.evaluate(() => (window as any).__gumCalls);
        expect(calls.length, 'the camera must have been requested').toBeGreaterThan(0);
        expect(calls[0].video.frameRate.ideal).toBe(7);
        expect(calls[0].video.frameRate.max).toBe(7);
    });

    test('changing the frame rate in Settings persists it and restarts a live camera at the new rate', async ({ page }) => {
        await register(page, unique('fpsset'));
        await stubCamera(page);
        await page.evaluate(() => (window as any).VoiceManager.toggleCamera());
        await page.waitForTimeout(600);

        await page.click('#settings-btn');
        await page.click('.settings-tab[data-tab="voice-settings"]');
        await page.locator('#voice-relay-video-fps').selectOption('5');
        await page.waitForTimeout(600);

        const state = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            return {
                live: S.settings.relayVideoFps,
                stored: JSON.parse(localStorage.getItem('voice_settings') || '{}').relayVideoFps,
                calls: (window as any).__gumCalls.map((c: any) => c.video.frameRate.ideal),
            };
        });

        expect(state.live).toBe(5);
        expect(state.stored).toBe(5);
        // The live camera was re-requested at the new rate (the last capture
        // request), which is what makes the change visible without a rejoin.
        expect(state.calls[state.calls.length - 1]).toBe(5);
    });

    test('the setting survives a reload', async ({ page }) => {
        await register(page, unique('fpsreload'));

        await page.click('#settings-btn');
        await page.click('.settings-tab[data-tab="voice-settings"]');
        await page.locator('#voice-relay-video-fps').selectOption('20');
        await page.waitForTimeout(400);

        await page.reload();
        await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
        await page.click('#settings-btn');
        await page.click('.settings-tab[data-tab="voice-settings"]');
        await expect(page.locator('#voice-relay-video-fps')).toHaveValue('20');
    });
});
