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
 * Desktop box: records page→shell emits, and lets the test play the part of the
 * shell for shell→page events (the hotkey's press/release).
 */
function mockDesktopBox(page: Page) {
    return page.addInitScript(() => {
        const emitted: any[] = [];
        const listeners: Record<string, ((e: any) => void)[]> = {};
        (window as any).__emitted = emitted;
        (window as any).__TAURI__ = {
            core: { invoke: () => Promise.resolve(null) },
            event: {
                emit: (name: string, payload: any) => {
                    emitted.push({ name, payload });
                    return Promise.resolve();
                },
                listen: (name: string, cb: (e: any) => void) => {
                    (listeners[name] = listeners[name] || []).push(cb);
                    return Promise.resolve(() => {});
                },
            },
        };
        (window as any).__firePtt = (down: boolean) => {
            (listeners['box:ptt'] || []).forEach((cb) => cb({ payload: { down } }));
        };
    });
}

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
                listen: () => Promise.resolve(() => {}),
            },
        };
    });
}

/**
 * Push-to-talk global hotkey — FEATURE_PLAN.md §4.1.
 *
 * The hotkey is not a second code path: the shell reports key state over an
 * event and the page runs the SAME gate as the in-app hold button, including
 * the server-mute rule. It must also not exist while push-to-talk is off — a
 * globally-held key that does nothing visible is how users get their keyboard
 * "broken" by an app.
 */
test.describe('push-to-talk global hotkey (4.1)', () => {
    test('the key and the hold button drive the same gate', async ({ page }) => {
        await mockDesktopBox(page);
        await register(page, unique('pttkey'));

        const out = await page.evaluate(() => {
            const w = window as any;
            const vm = w.VoiceManager;
            const snap = () => ({ gate: vm.pttGateOpen(), open: !!vm.getState().pttOpen });

            vm.setHoldToTalk(true);
            const closed = snap();
            w.__firePtt(true);
            const down = snap();
            w.__firePtt(false);
            const up = snap();

            // Push-to-talk off → the key must be inert (the mic is already open).
            vm.setHoldToTalk(false);
            w.__firePtt(true);
            const inert = snap();
            return { closed, down, up, inert };
        });

        expect(out.closed).toEqual({ gate: false, open: false });
        expect(out.down).toEqual({ gate: true, open: true });
        expect(out.up).toEqual({ gate: false, open: false });
        expect(out.inert.gate).toBe(true);
        expect(out.inert.open).toBe(false);
    });

    test('the accelerator is handed over only while push-to-talk is on', async ({ page }) => {
        await mockDesktopBox(page);
        await register(page, unique('pttkey-acc'));

        const out = await page.evaluate(async () => {
            const w = window as any;
            const vm = w.VoiceManager;
            const latest = () => {
                const evs = w.__emitted.filter((e: any) => e.name === 'box:ptt-shortcut');
                return evs.length ? evs[evs.length - 1].payload : null;
            };

            w.__emitted.length = 0;
            vm.setHoldToTalk(false); // registers nothing
            await new Promise((r) => setTimeout(r, 30));
            const off = latest();

            vm.setHoldToTalk(true);
            const input = document.getElementById('voice-ptt-shortcut') as HTMLInputElement;
            input.value = 'Ctrl+Alt+T';
            input.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise((r) => setTimeout(r, 30));
            const on = latest();

            vm.setHoldToTalk(false);
            await new Promise((r) => setTimeout(r, 30));
            const withdrawn = latest();

            return {
                off,
                on,
                withdrawn,
                stored: JSON.parse(localStorage.getItem('voice_settings') || '{}').pttShortcut,
            };
        });

        expect(out.off.enabled).toBe(false);
        expect(out.on.enabled).toBe(true);
        expect(out.on.accelerator).toBe('Ctrl+Alt+T');
        expect(out.stored).toBe('Ctrl+Alt+T');
        // Turning it off withdraws the key rather than leaving it held.
        expect(out.withdrawn.enabled).toBe(false);
        // The payload is a boolean and one accelerator string — nothing else.
        expect(Object.keys(out.on).sort()).toEqual(['accelerator', 'enabled']);
    });

    test('a phone registers no global key', async ({ page }) => {
        await mockAndroidBox(page);
        await register(page, unique('pttkey-android'));

        const emitted = await page.evaluate(async () => {
            const w = window as any;
            w.__emitted.length = 0;
            w.VoiceManager.setHoldToTalk(true);
            await new Promise((r) => setTimeout(r, 30));
            return w.__emitted.filter((e: any) => e.name === 'box:ptt-shortcut').length;
        });

        expect(emitted).toBe(0);
    });
});
