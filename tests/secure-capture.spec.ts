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

/** Stand in for the Android box: bridge that records every plugin invoke. */
function mockAndroidBox(page: Page) {
    return page.addInitScript(() => {
        Object.defineProperty(navigator, 'userAgent', {
            get: () => 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36',
            configurable: true,
        });
        const invokes: any[] = [];
        (window as any).__invokes = invokes;
        (window as any).__TAURI__ = {
            core: {
                invoke: (cmd: string, args: any) => { invokes.push({ cmd, args }); return Promise.resolve(null); },
            },
            event: { emit: () => Promise.resolve() },
        };
    });
}

/**
 * Per-channel screenshot blocking — 5.2, FEATURE_PLAN.md.
 *
 * FLAG_SECURE via `plugin:box-shell|setSecureMode`, driven by the viewed
 * channel: a marked channel blocks screenshots while it is on screen, a DM
 * (or any other view) releases the flag, and outside the Android box nothing
 * is invoked at all (a desktop capture is the user's own OS screenshot).
 */
test.describe('per-channel screenshot blocking (5.2 FLAG_SECURE)', () => {
    test('viewing a marked channel applies the flag; leaving it releases', async ({ page }) => {
        await mockAndroidBox(page);
        await register(page, unique('secure'));

        await page.evaluate(`
            localStorage.setItem('secureChannels', JSON.stringify(['chan-sec']));
            viewMode = 'servers';
            currentChannelId = 'chan-sec';
            window.__invokes.length = 0;
        `);

        const result = await page.evaluate(async () => {
            const w = window as any;
            w.applySecureCapture(true); // entering the marked channel
            w.applySecureCapture(false); // a DM / other view takes over
            await new Promise((r) => setTimeout(r, 50));
            return w.__invokes.filter((i: any) => i.cmd === 'plugin:box-shell|setSecureMode');
        });

        expect(result.length).toBe(2);
        expect(result[0].args).toEqual({ active: true });
        expect(result[1].args).toEqual({ active: false });
    });

    test('an unmarked channel never sets the flag', async ({ page }) => {
        await mockAndroidBox(page);
        await register(page, unique('secure-off'));

        await page.evaluate(`
            localStorage.setItem('secureChannels', '[]');
            viewMode = 'servers';
            currentChannelId = 'chan-open';
            window.__invokes.length = 0;
        `);

        const invokes = await page.evaluate(async () => {
            const w = window as any;
            w.applySecureCapture(true);
            await new Promise((r) => setTimeout(r, 50));
            return w.__invokes.filter((i: any) => i.cmd === 'plugin:box-shell|setSecureMode');
        });

        expect(invokes.length).toBe(1);
        expect(invokes[0].args).toEqual({ active: false });
    });

    test('toggling from the channel menu flips the stored policy', async ({ page }) => {
        await mockAndroidBox(page);
        await register(page, unique('secure-toggle'));

        const result = await page.evaluate(() => {
            const w = window as any;
            w.localStorage.removeItem('secureChannels');
            const was = w.isSecureChannel('chan-t');
            w.setSecureChannel('chan-t', true);
            const now = w.isSecureChannel('chan-t');
            const stored = JSON.parse(w.localStorage.getItem('secureChannels') || '[]');
            w.setSecureChannel('chan-t', false);
            const after = w.isSecureChannel('chan-t');
            return { was, now, stored, after };
        });

        expect(result.was).toBe(false);
        expect(result.now).toBe(true);
        expect(result.stored).toEqual(['chan-t']);
        expect(result.after).toBe(false);
    });

    test('outside the Android box nothing is invoked', async ({ page }) => {
        // No bridge mock at all: plain browser (and the desktop box's UA path).
        await register(page, unique('secure-web'));

        await page.evaluate(`
            viewMode = 'servers';
            currentChannelId = 'chan-x';
            localStorage.setItem('secureChannels', JSON.stringify(['chan-x']));
        `);

        const invokes = await page.evaluate(async () => {
            const w = window as any;
            w.applySecureCapture(true);
            await new Promise((r) => setTimeout(r, 50));
            return (window as any).__invokes || [];
        });

        expect(invokes).toEqual([]);
    });
});
