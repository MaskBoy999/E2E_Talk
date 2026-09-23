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
                invoke: (cmd: string, args: any) => {
                    invokes.push({ cmd, args });
                    if (cmd === 'plugin:box-shell|batteryStatus') {
                        return Promise.resolve({ ignoring: (window as any).__ignoringBattery });
                    }
                    return Promise.resolve(null);
                },
            },
            event: { emit: () => Promise.resolve() },
        };
        (window as any).__ignoringBattery = false;
    });
}

/**
 * Call comfort — FEATURE_PLAN.md Sprint S:
 *   6.2 keep-screen-on during a call (FLAG_KEEP_SCREEN_ON via box-shell)
 *   6.1 battery-optimization prompt (system dialog, asked at most once/30 days,
 *       and never when the app is already exempt)
 */
test.describe('call comfort (6.1 battery prompt, 6.2 keep screen on)', () => {
    test('keep-screen-on follows the call: on at start, off at teardown', async ({ page }) => {
        await mockAndroidBox(page);
        await register(page, unique('keepon'));

        const result = await page.evaluate(() => {
            const vm = (window as any).VoiceManager;
            (window as any).__invokes.length = 0;
            vm.boxKeepScreenOn(true);
            vm.boxKeepScreenOn(false);
            return (window as any).__invokes.filter(
                (i: any) => i.cmd === 'plugin:box-shell|keepScreenOn'
            );
        });

        expect(result.length).toBe(2);
        expect(result[0].args).toEqual({ active: true });
        expect(result[1].args).toEqual({ active: false });
    });

    test('the battery prompt asks once, opens the system dialog, and never again for 30 days', async ({ page }) => {
        await mockAndroidBox(page);
        await register(page, unique('battery'));

        const first = await page.evaluate(async () => {
            const w = window as any;
            w.localStorage.removeItem('batteryAskedAt');
            w.__ignoringBattery = false; // phone optimizes us → Doze risk is real
            w.__invokes.length = 0;
            w.VoiceManager.boxBatteryPrompt();
            await new Promise((r) => setTimeout(r, 100));
            return w.__invokes.filter((i: any) => i.cmd.startsWith('plugin:box-shell|battery'));
        });

        // Status checked first, and because we are NOT exempt the system
        // dialog is requested — the user (not the app) grants the exemption.
        expect(first.map((i: any) => i.cmd)).toEqual([
            'plugin:box-shell|batteryStatus',
            'plugin:box-shell|batteryRequest',
        ]);

        const second = await page.evaluate(async () => {
            const w = window as any;
            w.__invokes.length = 0;
            w.VoiceManager.boxBatteryPrompt(); // immediately again (every call join)
            await new Promise((r) => setTimeout(r, 100));
            return w.__invokes.filter((i: any) => i.cmd.startsWith('plugin:box-shell|battery'));
        });
        expect(second, 'at most one system prompt per 30 days').toEqual([]);
    });

    test('an already-exempt phone is never shown the dialog', async ({ page }) => {
        await mockAndroidBox(page);
        await register(page, unique('battery-ok'));

        const invokes = await page.evaluate(async () => {
            const w = window as any;
            w.localStorage.removeItem('batteryAskedAt');
            w.__ignoringBattery = true;
            w.__invokes.length = 0;
            w.VoiceManager.boxBatteryPrompt();
            await new Promise((r) => setTimeout(r, 100));
            return w.__invokes.filter((i: any) => i.cmd.startsWith('plugin:box-shell|battery'));
        });

        expect(invokes.map((i: any) => i.cmd)).toEqual(['plugin:box-shell|batteryStatus']);
    });
});

/**
 * Call notification actions — FEATURE_PLAN.md Sprint S 1.1:
 *   the ongoing-call notification carries Mute/Unmute, Deafen/Undeafen and
 *   Hang up, driven by a new `updateCallState` command whose payload must be
 *   ids/booleans only (server-known metadata — never names, never E2EE data),
 *   and the Kotlin taps land in window.__e2eCallAction.
 */
test.describe('call notification actions (1.1)', () => {
    test('updateCallState carries the current flags and media types', async ({ page }) => {
        await mockAndroidBox(page);
        await register(page, unique('callstate'));

        const out = await page.evaluate(() => {
            const vm = (window as any).VoiceManager;
            (window as any).__invokes.length = 0;
            try { vm.toggleMute(); } catch (e) { /* flip happens before any audio */ }
            vm.boxCallState();
            return (window as any).__invokes.filter(
                (i: any) => i.cmd === 'plugin:call-service|updateCallState'
            );
        });

        // toggleMute fires _boxCallState() itself now, plus the explicit
        // sync above → one or two identical posts; both must be valid.
        expect(out.length).toBeGreaterThanOrEqual(1);
        for (const i of out) {
            expect(i.args.muted).toBe(true);
            expect(typeof i.args.deafened).toBe('boolean');
            expect(i.args.mediaTypes).toContain('audio');
        }
        // The privacy invariant, asserted on the payload itself: booleans and
        // media-type ids — no strings that could carry a name or channel title.
        expect(Object.values(out[0].args).every(
            (v: any) => typeof v === 'boolean' || (Array.isArray(v) && v.every((x) => typeof x === 'string' && /^[a-z]+$/.test(x)))
        )).toBe(true);
    });

    test('the shade-tap hook exists and rejects unknown actions', async ({ page }) => {
        await mockAndroidBox(page);
        await register(page, unique('callaction'));

        const res = await page.evaluate(() => {
            const w = window as any;
            return {
                callAction: typeof w.__e2eCallAction,
                accept: typeof w.__e2eAcceptIncomingCall,
                bogus: w.__e2eCallAction('self-destruct'),
                noCall: w.__e2eCallAction('mute'), // not connected → must refuse
            };
        });

        expect(res.callAction).toBe('function');
        expect(res.accept).toBe('function');
        expect(res.bogus).toBe(false);
        expect(res.noCall).toBe(false);
    });
});
