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

/**
 * Panic wipe + auto-lock — 5.3, FEATURE_PLAN.md.
 *
 * One total wipe path (`window.panicWipe`): localStorage (except the benign
 * session-duration preference), sessionStorage, cookies, Cache Storage, the
 * IndexedDB copies — then a redirect to login. Triggered by the hidden
 * Alt+Shift+W chord (no confirmation, by design), the Settings button, and the
 * auto-lock decision (idle minutes, default OFF so it can never fire by
 * surprise).
 */
test.describe('panic wipe / auto-lock (5.3)', () => {
    test('the auto-lock setting persists and clamps', async ({ page }) => {
        await register(page, unique('autolock'));

        const out = await page.evaluate(() => {
            const el = document.getElementById('auto-lock-minutes') as HTMLInputElement;
            const set = (v: string) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
            set('5');
            const stored5 = localStorage.getItem('autoLockMinutes');
            const mins5 = (window as any).__autoLockTest.mins();
            set('-3');
            const clampedLow = { stored: localStorage.getItem('autoLockMinutes'), mins: (window as any).__autoLockTest.mins() };
            set('99999');
            const clampedHigh = { stored: localStorage.getItem('autoLockMinutes'), mins: (window as any).__autoLockTest.mins() };
            set('0');
            return { stored5, mins5, clampedLow, clampedHigh, final: (window as any).__autoLockTest.mins() };
        });

        expect(out.stored5).toBe('5');
        expect(out.mins5).toBe(5);
        expect(out.clampedLow).toEqual({ stored: '0', mins: 0 });
        expect(out.clampedHigh.stored).toBe('1440');
        expect(out.clampedHigh.mins).toBe(1440);
        expect(out.final).toBe(0);
    });

    test('auto-lock fires only past the idle limit, and the wipe is total', async ({ page }) => {
        await register(page, unique('idlewipe'));
        await page.evaluate(async () => {
            localStorage.setItem('wipe_probe', 'data-that-must-die');
            sessionStorage.setItem('wipe_probe_session', 'data-that-must-die');
            // Pre-seed a cache entry AND an IDB database the wipe must drop.
            const probeCache = await caches.open('wipe-probe-cache');
            await probeCache.put('probe.txt', new Response('probe'));
            await new Promise<void>((resolve) => {
                const req = indexedDB.open('e2e_wipe_probe', 1);
                req.onsuccess = () => { req.result.close(); resolve(); };
                req.onerror = () => resolve();
            });
            (window as any).__autoLockTest.setMins(5);
        });

        // Under the limit → no wipe, nothing navigates.
        const firedEarly = await page.evaluate(() => (window as any).__autoLockTest.tick(4));
        expect(firedEarly).toBe(false);
        expect(page.url()).toContain('index.html');

        // Past the limit → wipe runs: probe keys gone, caches gone, IDB gone,
        // redirected to the login page with the wipe marker.
        await page.evaluate(() => (window as any).__autoLockTest.tick(5));
        await page.waitForURL('**/login.html?wiped=1', { timeout: 15000 });
        const after = await page.evaluate(async () => ({
            local: localStorage.getItem('wipe_probe'),
            session: sessionStorage.getItem('wipe_probe_session'),
            caches: await caches.keys(),
            idbs: (typeof indexedDB.databases === 'function' ? await indexedDB.databases() : []).map((d: any) => d.name),
        }));
        expect(after.local).toBeNull();
        expect(after.session).toBeNull();
        expect(after.caches).not.toContain('wipe-probe-cache');
        expect(after.idbs).not.toContain('e2e_wipe_probe');
    });

    test('the hidden chord wipes instantly with no confirmation', async ({ page }) => {
        await register(page, unique('chordwipe'));
        await page.evaluate(() => { localStorage.setItem('chord_probe', 'must-die'); });

        await page.evaluate(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'W', code: 'KeyW', altKey: true, shiftKey: true, bubbles: true, cancelable: true,
            } as any));
        });
        await page.waitForURL('**/login.html?wiped=1', { timeout: 15000 });
        const probe = await page.evaluate(() => localStorage.getItem('chord_probe'));
        expect(probe).toBeNull();
    });

    test('auto-lock defaults to OFF (a surprise wipe is data loss)', async ({ page }) => {
        await register(page, unique('autolockoff'));
        const out = await page.evaluate(() => {
            localStorage.removeItem('autoLockMinutes');
            const el = document.getElementById('auto-lock-minutes') as HTMLInputElement;
            return { stored: localStorage.getItem('autoLockMinutes'), value: el ? el.value : null };
        });
        // Fresh state: nothing stored, input shows 0 (off).
        expect(out.stored).toBeNull();
        expect(out.value).toBe('0');
    });
});
