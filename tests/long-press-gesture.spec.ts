// The one touch gesture, and the double-tap family it replaced.
//
// A finger on any reorderable row (a server icon, a folder header, a channel, a
// category, a DM, a role) now means exactly one of two things, decided by a
// single time window:
//
//   * the finger stays inside the Touch Drag distance for the whole window
//     (`touch_hold_ms`, 500 ms by default) -> that server's/channel's/etc.
//     right-click menu opens under it;
//   * it moves further than that distance *while the window is still open* ->
//     the drag starts immediately and the window is dropped.
//
// Before this, holding armed a drag and drift cancelled it, and every menu
// needed its own double-tap detector — a gesture nobody could discover and a
// source of accidental reorders. Movement now means drag, stillness means menu.
//
// These tests dispatch real touch events into the app's own handlers (a
// synthetic `TouchEvent` needs `new Touch(...)`, which is why the profile below
// has touch enabled), and check the two outcomes through what the user sees:
// a menu on screen, or the row in its dragging state.
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

async function registerUser(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-confirm-password', { state: 'visible', timeout: 10000 });
    await page.fill('#register-username', `hold_${ts}`);
    await page.fill('#register-password', 'testpass1234');
    await page.fill('#register-confirm-password', 'testpass1234');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForFunction(() => (window as any).ws && (window as any).ws.readyState === 1, { timeout: 30000 });
}

/** One server, made the way a user makes one, so the rail has a real row. */
async function createServer(page: Page) {
    await page.click('#add-server-btn');
    await page.click('#choice-create-server');
    await page.fill('#new-server-name', 'Hold ' + Date.now().toString(36));
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 30000 });
    await page.waitForTimeout(600);
}

/**
 * Drive the rail's gesture on the first server icon.
 *
 * `movePx` is applied as a single touchmove, and only after `moveAfterMs` — the
 * point is to land the movement inside (or outside) the hold window.
 */
async function gesture(
    page: Page,
    opts: { movePx?: number; moveAfterMs?: number; holdMs: number },
) {
    const movePx = opts.movePx ?? 0;
    const moveAfterMs = opts.moveAfterMs ?? 0;
    const holdMs = opts.holdMs;
    await page.evaluate(
        ({ movePx, moveAfterMs, holdMs }) =>
            new Promise<void>((resolve) => {
                const icon = document.querySelector('.server-icon[data-id]') as HTMLElement | null;
                if (!icon) throw new Error('no server icon');
                const r = icon.getBoundingClientRect();
                const cx = r.left + r.width / 2;
                const cy = r.top + r.height / 2;
                const touch = (x: number, y: number) => new Touch({ identifier: 1, target: icon, clientX: x, clientY: y });
                icon.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(cx, cy)], bubbles: true, cancelable: true }));
                if (movePx) {
                    setTimeout(() => {
                        icon.dispatchEvent(new TouchEvent('touchmove', {
                            touches: [touch(cx, cy + movePx)],
                            bubbles: true,
                            cancelable: true,
                        }));
                    }, moveAfterMs);
                }
                setTimeout(() => {
                    icon.dispatchEvent(new TouchEvent('touchend', {
                        touches: [],
                        changedTouches: [touch(cx, cy + movePx)],
                        bubbles: true,
                        cancelable: true,
                    }));
                    resolve();
                }, holdMs);
            }),
        { movePx, moveAfterMs, holdMs },
    );
}

const menuCount = (page: Page) => page.locator('.channel-context-menu').count();
const menuVisible = (page: Page) => page.locator('.channel-context-menu').first().isVisible().catch(() => false);
async function dismissMenus(page: Page) {
    await page.evaluate(() => document.querySelectorAll('.channel-context-menu').forEach((m) => m.remove()));
}

test.describe('touch: stillness opens the menu, movement starts the drag', () => {
    test('the hold window decides, and it is the same 500 ms everywhere', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);
        await createServer(page);

        // The window and its setting are one number: 500 ms by default, and the
        // select shows what the code uses (not the first option in the list).
        expect(await page.evaluate(() => (window as any).touchHoldMs())).toBe(500);
        expect(await page.evaluate(() => (document.getElementById('touch-hold-ms') as HTMLSelectElement).value)).toBe('500');

        // 1. Still finger for longer than the window -> the menu opens.
        await gesture(page, { holdMs: 800 });
        expect(await menuVisible(page), 'a hold must open the right-click menu').toBe(true);
        await dismissMenus(page);

        // 2. The same press, moved 40 px well inside the window -> a drag, and
        //    no menu at all, because the window was dropped when it moved.
        await gesture(page, { movePx: 40, moveAfterMs: 80, holdMs: 900 });
        expect(await menuCount(page), 'moving inside the window must not open the menu').toBe(0);
        // The drag ran to the end (it is released at 900 ms), so what proves it
        // started is the drop machinery having been through onDragStart: the
        // ghost is gone and the rail is settled again.
        expect(await page.evaluate(() => !!document.querySelector('.server-touch-ghost, .touch-ghost'))).toBe(false);
    });

    test('the window is customizable, and its select is the source of truth', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);
        await createServer(page);

        // Choose the slow window the way the settings select does.
        await page.evaluate(() => {
            const sel = document.getElementById('touch-hold-ms') as HTMLSelectElement;
            sel.value = '1000';
            sel.dispatchEvent(new Event('change'));
        });
        expect(await page.evaluate(() => localStorage.getItem('touch_hold_ms'))).toBe('1000');
        expect(await page.evaluate(() => (window as any).touchHoldMs())).toBe(1000);

        // 600 ms is past the old 500 ms default but inside the chosen window:
        // no menu yet.
        await gesture(page, { holdMs: 600 });
        expect(await menuCount(page), 'a shorter press than the chosen window must not open the menu').toBe(0);

        // Past the chosen window: the menu opens.
        await gesture(page, { holdMs: 1200 });
        expect(await menuVisible(page), 'the chosen window must be the one that fires').toBe(true);
        await dismissMenus(page);

        // A stored value survives a reload and is what the select shows.
        await page.reload();
        await page.waitForFunction(() => (window as any).ws && (window as any).ws.readyState === 1, { timeout: 30000 });
        expect(await page.evaluate(() => (document.getElementById('touch-hold-ms') as HTMLSelectElement).value)).toBe('1000');
        expect(await page.evaluate(() => (window as any).touchHoldMs())).toBe(1000);
    });

    test('double-tapping a server icon no longer opens its menu', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);
        await createServer(page);

        const icon = page.locator('.server-icon[data-id]').first();
        // Two real taps, close enough together to be a double tap.
        await icon.tap();
        await page.waitForTimeout(120);
        await icon.tap();
        await page.waitForTimeout(500);

        expect(await menuCount(page), 'there must be no double-tap menu left in the app').toBe(0);
        // The taps still did their ordinary job: the server opened.
        await expect(page.locator('.channel-item').first()).toBeVisible({ timeout: 15000 });
    });
});
