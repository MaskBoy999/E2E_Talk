import { test, expect, type Page } from '@playwright/test';

const BASE = 'https://localhost:3443';

async function registerAndSetup(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const username = `hwaccel_${ts}`;
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

/**
 * A stand-in for the Tauri bridge. The switch is desktop-shell only, so the
 * page's gate (`window.__TAURI__`, not Android) has to be satisfied before the
 * code under test will run at all — and this records what the page asks the
 * shell to do, which is the contract that matters: the shell persists the
 * choice and applies `--disable-gpu` on the next launch.
 */
async function installNativeStub(page: Page) {
    await page.addInitScript(() => {
        const w = window as any;
        w.__boxCalls = [];
        w.__boxListeners = {};
        w.__TAURI__ = {
            core: {
                invoke: (cmd: string, args?: any) => {
                    w.__boxCalls.push({ invoke: cmd, args });
                    return Promise.resolve({});
                },
            },
            event: {
                emit: (name: string, payload: any) => {
                    w.__boxCalls.push({ emit: name, payload });
                    return Promise.resolve();
                },
                listen: (name: string, cb: (e: any) => void) => {
                    w.__boxListeners[name] = cb;
                    return Promise.resolve(() => {});
                },
            },
        };
    });
}

test.describe('Hardware acceleration toggle', () => {
    test('only a native desktop shell shows it, and it drives the shell', async ({ page }) => {
        await installNativeStub(page);
        await registerAndSetup(page);

        // 1. The control exists and is revealed by the native gate, default on.
        const shown = await page.evaluate(() => {
            const g = document.getElementById('hardware-acceleration-group') as HTMLElement | null;
            const t = document.getElementById('hardware-acceleration-toggle') as HTMLInputElement | null;
            return { group: !!g, visible: !!g && g.style.display !== 'none', checked: !!t && t.checked };
        });
        expect(shown.group).toBe(true);
        expect(shown.visible).toBe(true);
        expect(shown.checked).toBe(true);

        // 2. On load the page asks the shell what it will actually do.
        const asked = await page.evaluate(() =>
            (window as any).__boxCalls.filter((c: any) => c.emit === 'box:get-hardware-acceleration').length);
        expect(asked).toBeGreaterThanOrEqual(1);

        // 3. The shell's answer is what the toggle reflects, and it is remembered.
        await page.evaluate(() => {
            (window as any).__boxListeners['box:hardware-acceleration']({ payload: { enabled: false } });
        });
        const afterReply = await page.evaluate(() => {
            const t = document.getElementById('hardware-acceleration-toggle') as HTMLInputElement;
            return { checked: t.checked, stored: localStorage.getItem('hardware_acceleration') };
        });
        expect(afterReply.checked).toBe(false);
        expect(afterReply.stored).toBe('0');

        // 4. Toggling it tells the shell to persist the new value.
        await page.evaluate(() => {
            const t = document.getElementById('hardware-acceleration-toggle') as HTMLInputElement;
            t.checked = true;
            t.dispatchEvent(new Event('change'));
        });
        const emitted = await page.evaluate(() =>
            (window as any).__boxCalls.find((c: any) => c.emit === 'box:set-hardware-acceleration'));
        expect(emitted).toBeTruthy();
        expect(emitted.payload).toEqual({ enabled: true });
    });

    test('a plain browser never reveals the switch', async ({ page }) => {
        await registerAndSetup(page);
        const hidden = await page.evaluate(() => {
            const g = document.getElementById('hardware-acceleration-group') as HTMLElement | null;
            return { group: !!g, visible: !!g && g.style.display !== 'none', tauri: !!(window as any).__TAURI__ };
        });
        expect(hidden.group).toBe(true);
        expect(hidden.tauri).toBe(false);
        expect(hidden.visible).toBe(false);
    });
});
