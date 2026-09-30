// The two mobile layout rules that came out of the notch + keyboard pass.
//
// 1. The keyboard COMPACTS, it does not move the app. A phone WebView without
//    `interactive-widget=resizes-content` keeps the layout viewport at full
//    height and shows the keyboard over it, so the shell scrolls the page up and
//    the channel name leaves the screen. `initKeyboardCompaction()` measures how
//    much of the layout the keyboard covers and publishes it as `--kb-inset`,
//    which `.app` subtracts — the header stays where it is and the message list
//    is what gives up the space.
//
// 2. The notch pushes down the bars that carry NAMES (`.sidebar-header`,
//    `.chat-header`), and nothing else. The server rail — whose first row is the
//    DM button — keeps the position it always had; it was pushed down with
//    everything else for a while, which is the complaint this pins.
//
// The keyboard is simulated by replacing `window.visualViewport` with a stub
// before the app boots (the real one cannot be shrunk from a test), so the same
// code path runs as on a phone: a `resize` on the visual viewport.
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

/** A shrinkable visualViewport, in place before any app script runs. */
const FAKE_KEYBOARD = () => {
    const listeners: Record<string, Array<(e: Event) => void>> = {};
    const fake = {
        width: window.innerWidth,
        height: window.innerHeight,
        offsetTop: 0,
        addEventListener: (t: string, f: (e: Event) => void) => { (listeners[t] = listeners[t] || []).push(f); },
        removeEventListener: () => {},
    };
    (window as any).__kb = {
        /** Open a keyboard `px` tall, the way Android does. */
        open(px: number) {
            fake.height = window.innerHeight - px;
            fake.offsetTop = 0;
            (listeners['resize'] || []).forEach((f) => f(new Event('resize')));
        },
        close() {
            fake.height = window.innerHeight;
            fake.offsetTop = 0;
            (listeners['resize'] || []).forEach((f) => f(new Event('resize')));
        },
    };
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
};

async function registerUser(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-confirm-password', { state: 'visible', timeout: 10000 });
    await page.fill('#register-username', `kb_${ts}`);
    await page.fill('#register-password', 'testpass1234');
    await page.fill('#register-confirm-password', 'testpass1234');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 30000 });
}

const appHeight = (page: Page) => page.evaluate(() => (document.querySelector('.app') as HTMLElement).getBoundingClientRect().height);
const kbInset = (page: Page) => page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--kb-inset').trim());
const headerBox = (page: Page) => page.evaluate(() => {
    const h = document.querySelector('.chat-header') as HTMLElement;
    const r = h.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height };
});

test.describe('the keyboard compacts the app instead of scrolling it', () => {
    test('opening the keyboard keeps the top bar on screen', async ({ page }) => {
        test.setTimeout(180000);
        await page.addInitScript(FAKE_KEYBOARD);
        await registerUser(page);

        expect(await kbInset(page), 'no keyboard, no inset').toBe('0px');
        const closedApp = await appHeight(page);
        const closedHeader = await headerBox(page);

        // Type in a channel: the keyboard opens over the bottom 320 px.
        await page.evaluate(() => (window as any).__kb.open(320));

        await expect.poll(() => kbInset(page), { timeout: 5000 }).toBe('320px');
        const openApp = await appHeight(page);
        expect(closedApp - openApp, 'the frame must give up exactly the keyboard height').toBeGreaterThan(300);
        expect(closedApp - openApp).toBeLessThan(340);

        const openHeader = await headerBox(page);
        expect(openHeader.top, 'the top bar must not move').toBe(closedHeader.top);
        expect(openHeader.height).toBeGreaterThan(0);
        // The channel name is the thing that has to stay readable.
        await expect(page.locator('#channel-name')).toBeVisible();

        // Closing it hands the space back.
        await page.evaluate(() => (window as any).__kb.close());
        await expect.poll(() => kbInset(page), { timeout: 5000 }).toBe('0px');
        expect(await appHeight(page)).toBe(closedApp);
    });

});

test.describe('a desktop has nothing to compact for', () => {
    // No touch, a fine pointer: the same stub must change nothing, because no
    // keyboard can open over a desktop app.
    test.use({ hasTouch: false, isMobile: false, viewport: { width: 1280, height: 800 } });

    test('the stub cannot shrink a desktop frame', async ({ page }) => {
        test.setTimeout(180000);
        await page.addInitScript(FAKE_KEYBOARD);
        await registerUser(page);
        const before = await appHeight(page);
        await page.evaluate(() => (window as any).__kb.open(320));
        await page.waitForTimeout(400);
        expect(await kbInset(page), 'a fine-pointer device must never be compacted').toBe('0px');
        expect(await appHeight(page)).toBe(before);
    });
});

test.describe('the notch pushes down names, not the server rail', () => {
    test('the DM button sits where it always did, and the header keeps its inset', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);

        const rail = await page.evaluate(() => {
            const railEl = document.querySelector('.server-strip') as HTMLElement;
            const dm = document.getElementById('dm-strip-btn') as HTMLElement;
            const cs = getComputedStyle(railEl);
            return {
                paddingTop: parseFloat(cs.paddingTop),
                paddingBottom: parseFloat(cs.paddingBottom),
                railTop: railEl.getBoundingClientRect().top,
                dmTop: dm.getBoundingClientRect().top,
            };
        });

        // Symmetric padding is the mark of "no safe-area inset on this element":
        // the notch term would be added to the top only.
        expect(Math.abs(rail.paddingTop - rail.paddingBottom), 'the rail must not carry a top-only inset').toBeLessThanOrEqual(1);
        // The DM button (the rail's first row) starts at the rail's own padding,
        // with only the row's own margin between them.
        expect(rail.dmTop - rail.railTop, 'the DM row must not be pushed down by the notch').toBeLessThanOrEqual(rail.paddingTop + 8);

        // The declarations themselves: only the bars that carry names ask for
        // the safe-area inset, and the rail does not. This is the assertion that
        // does not depend on the browser reporting a notch, and it is the one
        // that fails if anyone re-adds the inset to the rail.
        const css = await page.evaluate(() => {
            const out: Record<string, string> = {};
            const wanted = ['.server-strip', '.chat-header', '.sidebar-header'];
            for (const sheet of Array.from(document.styleSheets)) {
                let rules: CSSRuleList | null = null;
                try { rules = sheet.cssRules; } catch (_) { continue; }
                if (!rules) continue;
                for (const rule of Array.from(rules) as CSSStyleRule[]) {
                    if (rule.selectorText && wanted.includes(rule.selectorText) && rule.style) {
                        out[rule.selectorText] = rule.style.padding || rule.style.paddingTop || '';
                    }
                }
            }
            return out;
        });
        expect(css['.server-strip'], 'the rail is found in the stylesheet').toBeTruthy();
        expect(css['.server-strip'], 'the server rail must not use the notch inset').not.toContain('safe-area-inset-top');
        expect(css['.chat-header'], 'the channel name must clear a cutout').toContain('safe-area-inset-top');
        expect(css['.sidebar-header'], 'the server name must clear a cutout').toContain('safe-area-inset-top');
    });
});
