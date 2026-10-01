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
 * `movePx` is applied as a single touchmove after `moveAfterMs`, and the
 * outcome is sampled just BEFORE the finger lifts — which is what makes the
 * difference between the two halves of the rule observable: a drag is only a
 * drag while the finger is down.
 */
async function gesture(
    page: Page,
    opts: { movePx?: number; moveAfterMs?: number; holdMs: number },
): Promise<{ menu: boolean; dragging: boolean; dragActive: boolean; ghost: boolean }> {
    const movePx = opts.movePx ?? 0;
    const moveAfterMs = opts.moveAfterMs ?? 0;
    const holdMs = opts.holdMs;
    return await page.evaluate(
        ({ movePx, moveAfterMs, holdMs }) =>
            new Promise<{ menu: boolean; dragging: boolean; dragActive: boolean; ghost: boolean }>((resolve) => {
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
                    const snapshot = {
                        menu: !!document.querySelector('.channel-context-menu'),
                        dragging: !!document.querySelector('#server-list .dragging, .server-icon.dragging'),
                        dragActive: (window as any)._serverDragActive === true,
                        ghost: !!document.querySelector('body > .server-drag-ghost, body > .touch-ghost'),
                    };
                    icon.dispatchEvent(new TouchEvent('touchend', {
                        touches: [],
                        changedTouches: [touch(cx, cy + movePx)],
                        bubbles: true,
                        cancelable: true,
                    }));
                    resolve(snapshot);
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

        // 2. Still past the minimum floor (150 ms), then moved: a drag. The
        //    window is dropped the moment it moves, so no menu can follow.
        const dragged = await gesture(page, { movePx: 40, moveAfterMs: 300, holdMs: 900 });
        expect(dragged.dragging, 'after the floor, movement starts the drag').toBe(true);
        expect(dragged.ghost, 'a drag in flight carries its ghost').toBe(true);
        expect(dragged.dragActive, 'the rail is in drag mode while the finger is down').toBe(true);
        expect(dragged.menu, 'a gesture that became a drag must not also open the menu').toBe(false);

        // The finger lifts: the drop machinery must tear itself down — no ghost
        // left on <body>, no rail left in drag mode.
        await page.waitForTimeout(250);
        expect(await page.evaluate(() => document.querySelectorAll('body > .server-drag-ghost, body > .touch-ghost').length)).toBe(0);
        expect(await page.evaluate(() => (window as any)._serverDragActive === true)).toBe(false);
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

    test('movement before the minimum hold is a scroll, never a drag', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);
        await createServer(page);

        // The floor exists because scrolling was unbearable: the first pixel of
        // a scroll used to race the drag and throw the rail around under the
        // thumb. Moving at 80 ms — inside the 150 ms minimum — must therefore be
        // nothing at all: no drag, and no menu either, because the gesture was
        // handed back to the browser's scroll and is over for that finger.
        const scrolled = await gesture(page, { movePx: 40, moveAfterMs: 80, holdMs: 900 });
        expect(scrolled.dragging, 'movement inside the minimum must not pick anything up').toBe(false);
        expect(scrolled.dragActive, 'the rail must not be left in drag mode').toBe(false);
        expect(scrolled.ghost, 'no drag ghost may be left behind').toBe(false);
        expect(scrolled.menu, 'a scroll never opens a menu, even if the finger stays down').toBe(false);

        // And it stays that way: waiting past the window must not retroactively
        // treat the gesture as a hold.
        expect(await menuCount(page)).toBe(0);

        // With the floor raised, the same timing is still a scroll, and a move
        // after the raised floor is still a drag.
        await page.evaluate(() => {
            const sel = document.getElementById('touch-hold-min-ms') as HTMLSelectElement;
            sel.value = '300';
            sel.dispatchEvent(new Event('change'));
        });
        expect(await page.evaluate(() => (window as any).touchHoldMinMs())).toBe(300);
        const early = await gesture(page, { movePx: 40, moveAfterMs: 150, holdMs: 900 });
        expect(early.dragging, '150 ms of movement is still a scroll at a 300 ms floor').toBe(false);
        expect(early.menu).toBe(false);
        const late = await gesture(page, { movePx: 40, moveAfterMs: 420, holdMs: 900 });
        expect(late.dragging, 'movement after the raised floor drags').toBe(true);
        expect(late.menu).toBe(false);
        await dismissMenus(page);
    });

    test('the minimum is its own setting, and it starts at 150 ms', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);
        await createServer(page);

        // Like the window, the floor and its select are one number: what the
        // code uses is what the select shows.
        expect(await page.evaluate(() => (window as any).touchHoldMinMs())).toBe(150);
        expect(await page.evaluate(() => (document.getElementById('touch-hold-min-ms') as HTMLSelectElement).value)).toBe('150');

        // Switching it off (0) is allowed: movement may drag at once again,
        // which is what the drag-pipeline tests rely on.
        await page.evaluate(() => {
            const sel = document.getElementById('touch-hold-min-ms') as HTMLSelectElement;
            sel.value = '0';
            sel.dispatchEvent(new Event('change'));
        });
        expect(await page.evaluate(() => localStorage.getItem('touch_hold_min_ms'))).toBe('0');
        expect(await page.evaluate(() => (window as any).touchHoldMinMs())).toBe(0);

        const instant = await gesture(page, { movePx: 40, moveAfterMs: 60, holdMs: 900 });
        expect(instant.dragging, 'with the floor off, early movement drags').toBe(true);
        expect(instant.menu).toBe(false);

        // A floor can never swallow the window it sits under: it is clamped
        // below whatever Hold to Open Menu is set to.
        await page.evaluate(() => localStorage.setItem('touch_hold_min_ms', '400'));
        expect(await page.evaluate(() => (window as any).touchHoldMinMs())).toBe(400);
        await page.evaluate(() => {
            const sel = document.getElementById('touch-hold-ms') as HTMLSelectElement;
            sel.value = '300';
            sel.dispatchEvent(new Event('change'));
        });
        expect(await page.evaluate(() => (window as any).touchHoldMs())).toBe(300);
        expect(await page.evaluate(() => (window as any).touchHoldMinMs()), 'the floor stays below the window').toBe(200);
        await dismissMenus(page);
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
