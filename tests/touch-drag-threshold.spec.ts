import { test, expect, type Page } from '@playwright/test';

const BASE = 'https://localhost:3443';

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
 * Long-press a server icon and drift `movePx` pixels before the 350ms timer
 * fires. Returns whether the drag armed (`.dragging` on the icon).
 */
async function longPressWithDrift(page: Page, movePx: number) {
    return await page.evaluate((move: number) => new Promise<{ armed: boolean; threshold: number | null }>((resolve) => {
        const icon = document.querySelector('.server-icon[data-id]') as HTMLElement | null;
        if (!icon) { resolve({ armed: false, threshold: null }); return; }
        const r = icon.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const touch = (x: number, y: number) => new Touch({ identifier: 1, target: icon, clientX: x, clientY: y });
        icon.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(cx, cy)], bubbles: true, cancelable: true }));
        // Drift well inside the long-press window (350ms), which is exactly when
        // a scroll would normally win.
        requestAnimationFrame(() => {
            icon.dispatchEvent(new TouchEvent('touchmove', {
                touches: [touch(cx, cy + move)],
                bubbles: true,
                cancelable: true,
            }));
        });
        setTimeout(() => {
            const armed = icon.classList.contains('dragging');
            icon.dispatchEvent(new TouchEvent('touchend', {
                touches: [],
                changedTouches: [touch(cx, cy + move)],
                bubbles: true,
            }));
            const threshold = (window as any).touchDragMoveThreshold
                ? (window as any).touchDragMoveThreshold()
                : null;
            resolve({ armed, threshold });
        }, 700);
    }), movePx);
}

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

    test('drift under the default (10px) aborts the pick-up, as a scroll should', async ({ page }) => {
        await registerAndSetup(page);
        await page.evaluate(() => { localStorage.removeItem('touch_drag_threshold'); });
        await createServer(page);

        const r = await longPressWithDrift(page, 14);
        expect(r.threshold).toBe(10);
        expect(r.armed).toBe(false);
    });

    test('the same drift arms the drag under a looser threshold', async ({ page }) => {
        await registerAndSetup(page);
        await page.evaluate(() => { localStorage.setItem('touch_drag_threshold', 'loose'); });
        await createServer(page);

        const r = await longPressWithDrift(page, 14);
        expect(r.threshold).toBe(18);
        expect(r.armed).toBe(true);
    });
});
