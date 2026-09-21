import { test, expect, type Page } from '@playwright/test';

const BASE = 'https://localhost:3443';
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
 * The Android WebView has no Screen Capture API, so the box falls back to a
 * native MediaProjection capture. These tests pin the *branch*: which path the
 * Share-screen button takes in each environment. They cannot exercise the
 * native capture itself (that needs a device), but they do prove the fallback
 * is reached and cannot throw, which is what used to leave the button dead.
 */
test.describe('screen share — capture path selection', () => {
    test('a browser uses getDisplayMedia, not the native path', async ({ page }) => {
        const user = unique('ssb');
        await register(page, user);

        // A real browser page has the API. If this fails, every desktop share
        // would silently fall through to the (box-only) native branch.
        const hasApi = await page.evaluate(() => typeof (navigator.mediaDevices as any).getDisplayMedia === 'function');
        expect(hasApi).toBe(true);

        // And no Tauri bridge, so the native branch is unreachable here.
        const hasTauri = await page.evaluate(() => typeof (window as any).__TAURI__ !== 'undefined');
        expect(hasTauri).toBe(false);
    });

    test('without getDisplayMedia the button takes the native branch and does not throw', async ({ page }) => {
        const user = unique('ssn');
        await register(page, user);

        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));

        // Simulate the Android WebView: mediaDevices exists (camera/mic work)
        // but the Screen Capture API does not.
        await page.evaluate(() => {
            const md = navigator.mediaDevices as any;
            try { delete md.getDisplayMedia; } catch (_) {}
            try { Object.defineProperty(md, 'getDisplayMedia', { value: undefined, configurable: true }); } catch (_) {}
        });
        expect(await page.evaluate(() => typeof (navigator.mediaDevices as any).getDisplayMedia)).toBe('undefined');

        // Pressing Share screen must not throw and must say something useful.
        await page.evaluate(() => (window as any).VoiceManager.toggleScreen());
        await page.waitForTimeout(1200);

        expect(errors).toEqual([]);

        // In a plain browser there is no __TAURI__, so the honest answer is
        // "not supported on this device" — the box replaces this with a real
        // capture because its native bridge *is* present.
        const toastText = await page.evaluate(() => {
            const el = document.querySelector('.global-toast, .toast, #toast-container');
            return el ? (el.textContent || '') : '';
        });
        expect(toastText.toLowerCase()).toContain('not supported');
    });
});
