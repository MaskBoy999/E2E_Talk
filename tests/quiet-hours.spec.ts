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

/** Stand in for the Android box so AudioProfile reads are treated as native. */
function mockAndroidBox(page: Page) {
    return page.addInitScript(() => {
        Object.defineProperty(navigator, 'userAgent', {
            get: () => 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36',
            configurable: true,
        });
        (window as any).__TAURI__ = {
            // getAudioProfile resolves null → the profile the test set with the
            // setAudioProfile hook is kept (a real box returns the phone's state).
            core: { invoke: () => Promise.resolve(null) },
            event: { emit: () => Promise.resolve() },
        };
    });
}

/**
 * Quiet hours / DND awareness — FEATURE_PLAN.md §2.6.
 *
 * Android already keeps the *system* notification honest: its channel carries
 * the sound and vibration, and ringer mode/DND are applied by SystemUI. But the
 * app also chimed for messages through WebAudio, which SystemUI knows nothing
 * about — so a silenced phone rang out anyway, right next to a notification
 * that had politely stayed quiet. `notificationSoundAllowed()` closes the gap
 * and must never change *what* is shown, only whether we chime.
 */
test.describe('DND-aware notification sound (2.6)', () => {
    test('silent / vibrate / DND phones are not chimed; a normal one is', async ({ page }) => {
        await mockAndroidBox(page);
        await register(page, unique('quiet'));

        const out = await page.evaluate(async () => {
            const w = window as any;
            let chimes = 0;
            // Count the cue at its source instead of touching audio hardware.
            w.playDefaultChime = () => { chimes++; };
            w.playDataUrlSound = () => { chimes++; };
            w.localStorage.removeItem('notification_sound_url');
            // 'true' would suppress the cue whenever the tab is visible.
            w.localStorage.removeItem('notif_background_only');

            const plays = async (profile: any) => {
                w.VoiceManager.setAudioProfile(profile);
                const before = chimes;
                w.playNotificationSound();
                await new Promise((r) => setTimeout(r, 60));
                return chimes - before;
            };

            return {
                normal: await plays({ mode: 'normal', dnd: false }),
                silent: await plays({ mode: 'silent', dnd: false }),
                vibrate: await plays({ mode: 'vibrate', dnd: false }),
                dnd: await plays({ mode: 'normal', dnd: true }),
            };
        });

        expect(out.normal, 'a normal phone still chimes').toBe(1);
        expect(out.silent, 'silent phone must not chime').toBe(0);
        expect(out.vibrate, 'vibrate-only phone must not chime').toBe(0);
        expect(out.dnd, 'do-not-disturb must not chime').toBe(0);
    });

    test('the Settings "Test sound" button still plays on a silenced phone', async ({ page }) => {
        await mockAndroidBox(page);
        await register(page, unique('quiet-force'));

        const played = await page.evaluate(async () => {
            const w = window as any;
            let chimes = 0;
            w.playDefaultChime = () => { chimes++; };
            w.playDataUrlSound = () => { chimes++; };
            w.localStorage.removeItem('notification_sound_url');
            w.VoiceManager.setAudioProfile({ mode: 'silent', dnd: false });
            // `force` is the user explicitly asking to hear it.
            w.playNotificationSound(true);
            await new Promise((r) => setTimeout(r, 60));
            return chimes;
        });

        expect(played).toBe(1);
    });
});
