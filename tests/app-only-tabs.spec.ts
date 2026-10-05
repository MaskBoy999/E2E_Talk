import { test, expect, type Page } from '@playwright/test';

/**
 * The Icons tab is app-only: chat.js reveals it only when the page runs inside
 * a box, detected by the Tauri bridge `window.__TAURI__.core.invoke`. A plain
 * browser must never show it — that is the whole point of the gate.
 *
 * The Connection tab next to it is deliberately NOT app-only: a browser can be
 * left running the cached app with its server gone (host moved, port changed),
 * and that tab is the only way back to the connection screen there. It is
 * shown everywhere and this spec pins both halves of that rule.
 *
 * The box half runs in a browser with the bridge injected, which is the same
 * condition the desktop box provides (tests/desktop-box-tabs.spec.ts asserts
 * the real box has the bridge), so the reveal logic itself is pinned without
 * depending on a running app window or on an account being logged in inside it.
 */

const BASE = 'https://localhost:3443';

const TAURI_STUB = () => {
    (window as any).__TAURI__ = {
        core: { invoke: async () => null },
        event: { emit: async () => {} },
    };
};

async function registerAndEnter(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-confirm-password', { state: 'visible', timeout: 5000 });
    await page.fill('#register-username', `tab_${ts}`);
    await page.fill('#register-password', 'testpass123');
    await page.fill('#register-confirm-password', 'testpass123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
}

function tabState(page: Page) {
    return page.evaluate(() => {
        const state = (id: string) => {
            const el = document.getElementById(id) as HTMLElement | null;
            if (!el) return 'missing';
            return getComputedStyle(el).display === 'none' ? 'hidden' : 'shown';
        };
        return {
            icons: state('icon-settings-tab'),
            connection: state('connection-settings-tab'),
            css: !!document.querySelector('.settings-tab[data-tab="custom-css-settings"]'),
            iconsPanel: !!document.getElementById('icon-settings-container'),
        };
    });
}

test.describe('app-only settings tabs', () => {
    test('a plain browser hides the Icons tab and keeps the Connection escape hatch', async ({ page }) => {
        await registerAndEnter(page);
        const state = await tabState(page);
        expect(state.icons, 'the Icons tab is app-only').toBe('hidden');
        // Deliberate: the web app is served by the server it points at, so when
        // that server is gone the page can still be running from cache and the
        // Connection tab is how a browser reaches the new address.
        expect(state.connection, 'the Connection tab is the browser escape hatch').toBe('shown');
        expect(state.css, 'the CSS tab is for everyone').toBe(true);
    });

    test('with the box bridge present, the Icons tab is revealed and its panel exists', async ({ page }) => {
        await page.addInitScript(TAURI_STUB);
        await registerAndEnter(page);
        const state = await tabState(page);
        expect(state.icons, 'the Icons tab must appear where the app runs').toBe('shown');
        expect(state.connection, 'the Connection tab must appear where the app runs').toBe('shown');
        expect(state.iconsPanel, 'the Icons tab needs its panel').toBe(true);

        // Opening the tab must not throw and must render its UI.
        await page.click('#settings-btn');
        await expect(page.locator('#settings-modal')).toBeVisible();
        await page.click('#icon-settings-tab');
        // The panel id must NOT be `icon-settings`: an SVG sprite symbol already
        // owns that id, and the tab switch resolves the panel by id.
        await expect(page.locator('#settings-modal #icon-packs-settings')).toBeVisible();
    });
});
