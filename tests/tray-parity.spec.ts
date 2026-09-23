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

/** Desktop box (no Android UA): records everything the page emits. */
function mockDesktopBox(page: Page) {
    return page.addInitScript(() => {
        const emitted: any[] = [];
        (window as any).__emitted = emitted;
        (window as any).__TAURI__ = {
            core: { invoke: () => Promise.resolve(null) },
            event: {
                emit: (name: string, payload: any) => {
                    emitted.push({ name, payload });
                    return Promise.resolve();
                },
            },
        };
    });
}

/** Android box: same bridge, Android UA. */
function mockAndroidBox(page: Page) {
    return page.addInitScript(() => {
        Object.defineProperty(navigator, 'userAgent', {
            get: () => 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36',
            configurable: true,
        });
        const emitted: any[] = [];
        (window as any).__emitted = emitted;
        (window as any).__TAURI__ = {
            core: { invoke: () => Promise.resolve(null) },
            event: {
                emit: (name: string, payload: any) => {
                    emitted.push({ name, payload });
                    return Promise.resolve();
                },
            },
        };
    });
}

/**
 * Desktop tray parity — FEATURE_PLAN.md §4.6.
 *
 * The tray is an OS surface that anyone standing at the machine can read
 * (Windows keeps it on screen next to the clock), so it may carry only
 * server-known metadata: a call flag, the local mute flags and an unread count.
 * The payload shape is pinned here because it is the boundary — an added string
 * field is exactly how a channel or partner name would leak into the tray.
 */
test.describe('desktop tray parity (4.6)', () => {
    test('the tray payload is booleans and a count — nothing name-shaped', async ({ page }) => {
        await mockDesktopBox(page);
        await register(page, unique('tray'));

        const payload = await page.evaluate(async () => {
            const w = window as any;
            w.__emitted.length = 0;
            w.updateBoxTrayState();
            await new Promise((r) => setTimeout(r, 50));
            const evs = w.__emitted.filter((e: any) => e.name === 'box:tray-state');
            return evs.length ? evs[evs.length - 1].payload : null;
        });

        expect(payload, 'the page must raise box:tray-state').not.toBeNull();
        expect(Object.keys(payload).sort()).toEqual(['deafened', 'in_call', 'muted', 'unread']);
        expect(typeof payload.in_call).toBe('boolean');
        expect(typeof payload.muted).toBe('boolean');
        expect(typeof payload.deafened).toBe('boolean');
        expect(Number.isInteger(payload.unread)).toBe(true);
        expect(payload.unread).toBeGreaterThanOrEqual(0);
    });

    test('mute / unmute reach the tray through the normal self-state path', async ({ page }) => {
        await mockDesktopBox(page);
        await register(page, unique('tray-mute'));

        const out = await page.evaluate(async () => {
            const w = window as any;
            const vm = w.VoiceManager;
            const latest = () => {
                const evs = w.__emitted.filter((e: any) => e.name === 'box:tray-state');
                return evs.length ? evs[evs.length - 1].payload : null;
            };
            w.__emitted.length = 0;
            try { vm.toggleMute(); } catch (_) { /* the flip happens before any audio */ }
            await new Promise((r) => setTimeout(r, 50));
            const muted = latest();
            try { vm.toggleMute(); } catch (_) { /* ditto */ }
            await new Promise((r) => setTimeout(r, 50));
            const unmuted = latest();
            return { muted, unmuted };
        });

        expect(out.muted, 'muting must reach the tray without a manual emit').not.toBeNull();
        expect(out.muted.muted).toBe(true);
        expect(out.unmuted.muted).toBe(false);
    });

    test('a phone has no tray, so nothing is emitted', async ({ page }) => {
        await mockAndroidBox(page);
        await register(page, unique('tray-android'));

        const emitted = await page.evaluate(async () => {
            const w = window as any;
            w.__emitted.length = 0;
            w.updateBoxTrayState();
            await new Promise((r) => setTimeout(r, 50));
            return w.__emitted.filter((e: any) => e.name === 'box:tray-state').length;
        });

        expect(emitted).toBe(0);
    });
});
