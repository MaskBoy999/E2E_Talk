// One gesture, two outcomes, and the number that separates them.
//
// The Touch Drag distance is the middle of the app's single touch gesture: the
// finger goes down and two timers start — the minimum hold (`touchHoldMinMs`,
// 150 ms, Settings → Touch) and the hold window (`touchHoldMs`, 500 ms, see
// tests/long-press-gesture.spec.ts). Inside that frame the distance is the
// whole question —
//
//   * **before the minimum**, moved further than it -> you were scrolling: the
//     gesture is abandoned, nothing drags, and no menu can open afterwards;
//   * **after the minimum**, moved further than it -> the DRAG starts right then
//     and the window is dropped, so a drag can never be mistaken for a menu;
//   * stayed inside it for the whole window -> the right-click MENU opens, so a
//     shaky finger on a real phone does not turn a hold into a reorder.
//
// The setting has to reach that comparison, so the same drift is run against
// three different settings and must produce three different outcomes. The rows
// are driven through synthetic touch events because that is the only way to hold
// a finger still for a measured length of time.
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';

async function registerAndSetup(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const username = `dragthr_${ts}`;
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-confirm-password', { state: 'visible', timeout: 5000 });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'testpass123');
    await page.fill('#register-confirm-password', 'testpass123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForFunction(() => {
        const ws = (window as any).ws;
        return ws && ws.readyState === 1;
    }, { timeout: 15000 });
}

async function createServer(page: Page) {
    await page.click('#add-server-btn');
    await page.click('#choice-create-server');
    await page.fill('#new-server-name', 'Drag ' + Date.now().toString(36));
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 20000 });
    await page.waitForTimeout(600);
}

/**
 * Press a server icon, drift `movePx` pixels after `moveAfterMs`, and read what
 * the gesture became before letting go.
 *
 * `moveAfterMs` matters as much as the distance: movement before the minimum
 * hold (150 ms) is the browser's scroll and can never drag, so the drag cases
 * drift after it. `holdForMs` is how long the finger stays down in total: long
 * enough that a gesture which was *not* taken over by a drag has opened its
 * menu.
 */
async function pressAndDrift(page: Page, movePx: number, holdForMs: number, moveAfterMs = 300) {
    return await page.evaluate(
        ({ move, hold, moveAfter }) =>
            new Promise<{ dragging: boolean; menu: boolean; threshold: number | null }>((resolve) => {
                const icon = document.querySelector('.server-icon[data-id]') as HTMLElement | null;
                if (!icon) throw new Error('no server icon to press');
                const r = icon.getBoundingClientRect();
                const cx = r.left + r.width / 2;
                const cy = r.top + r.height / 2;
                const touch = (x: number, y: number) => new Touch({ identifier: 1, target: icon, clientX: x, clientY: y });
                icon.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(cx, cy)], bubbles: true, cancelable: true }));
                if (move) {
                    setTimeout(() => {
                        icon.dispatchEvent(new TouchEvent('touchmove', {
                            touches: [touch(cx, cy + move)],
                            bubbles: true,
                            cancelable: true,
                        }));
                    }, moveAfter);
                }
                setTimeout(() => {
                    const dragging = icon.classList.contains('dragging');
                    const menu = !!document.querySelector('.channel-context-menu');
                    icon.dispatchEvent(new TouchEvent('touchend', {
                        touches: [],
                        changedTouches: [touch(cx, cy + move)],
                        bubbles: true,
                    }));
                    const threshold = (window as any).touchDragMoveThreshold
                        ? (window as any).touchDragMoveThreshold()
                        : null;
                    resolve({ dragging, menu, threshold });
                }, hold);
            }),
        { move: movePx, hold: holdForMs, moveAfter: moveAfterMs },
    );
}

const cleanup = (page: Page) => page.evaluate(() => document.querySelectorAll('.channel-context-menu').forEach((m) => m.remove()));

test.describe('Touch drag movement threshold', () => {
    test('the setting persists and drives the shared threshold', async ({ page }) => {
        await registerAndSetup(page);

        const result = await page.evaluate(() => {
            const sel = document.getElementById('touch-drag-threshold') as HTMLSelectElement | null;
            if (!sel) return { found: false };
            const before = (window as any).touchDragMoveThreshold();
            sel.value = 'loose';
            sel.dispatchEvent(new Event('change'));
            return {
                found: true,
                options: Array.from(sel.options).map((o) => o.value),
                before,
                stored: localStorage.getItem('touch_drag_threshold'),
                after: (window as any).touchDragMoveThreshold(),
            };
        });

        expect(result.found).toBe(true);
        expect(result.options).toEqual(['tight', 'normal', 'loose', 'very-loose']);
        expect(result.before).toBe(10);
        expect(result.stored).toBe('loose');
        expect(result.after).toBe(18);
    });

    test('under the default (10px) a 14px drift becomes the drag, not the menu', async ({ page }) => {
        test.setTimeout(120000);
        await registerAndSetup(page);
        await page.evaluate(() => { localStorage.removeItem('touch_drag_threshold'); });
        await createServer(page);

        // The finger drifts at 300 ms — past the 150 ms minimum, well inside
        // the 500 ms window — and then stays down past the window to prove the
        // window was dropped.
        const r = await pressAndDrift(page, 14, 800);
        expect(r.threshold).toBe(10);
        expect(r.dragging, 'past the distance after the floor the drag must start').toBe(true);
        expect(r.menu, 'a gesture that became a drag must not also open the menu').toBe(false);
        await cleanup(page);
    });

    test('the same drift before the minimum hold is a scroll, not a drag', async ({ page }) => {
        test.setTimeout(120000);
        await registerAndSetup(page);
        await page.evaluate(() => { localStorage.removeItem('touch_drag_threshold'); });
        await createServer(page);

        // Identical movement, but at 80 ms — before the 150 ms floor. Scrolling
        // was unbearable because this exact gesture picked the rail up; it must
        // do nothing at all now, and it must not open a menu when the finger
        // outlives the window either.
        const r = await pressAndDrift(page, 14, 800, 80);
        expect(r.dragging, 'movement inside the minimum is a scroll, never a drag').toBe(false);
        expect(r.menu, 'a scroll never opens a menu').toBe(false);
        expect(await page.evaluate(() => (window as any)._serverDragActive === true),
            'the rail must not be left in drag mode').toBe(false);
        await cleanup(page);
    });

    test('under a very loose threshold (28px) the same drift stays a hold', async ({ page }) => {
        test.setTimeout(120000);
        await registerAndSetup(page);
        await page.evaluate(() => { localStorage.setItem('touch_drag_threshold', 'very-loose'); });
        await createServer(page);

        const r = await pressAndDrift(page, 14, 800);
        expect(r.threshold).toBe(28);
        expect(r.dragging, 'inside the distance the gesture is still a hold').toBe(false);
        expect(r.menu, 'a hold that never became a drag opens the menu').toBe(true);
        await cleanup(page);
    });

    test('under a tight threshold (6px) an 8px drift becomes the drag', async ({ page }) => {
        test.setTimeout(120000);
        await registerAndSetup(page);
        await page.evaluate(() => { localStorage.setItem('touch_drag_threshold', 'tight'); });
        await createServer(page);

        const r = await pressAndDrift(page, 8, 800);
        expect(r.threshold).toBe(6);
        expect(r.dragging, 'a steady hand gets its drag at 8px').toBe(true);
        expect(r.menu).toBe(false);
        await cleanup(page);
    });
});
