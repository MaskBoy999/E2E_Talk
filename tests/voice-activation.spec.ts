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
 * Flip a Settings checkbox the way the user does. The settings panels are
 * display:none until opened, so Playwright's check() (which demands
 * visibility) can't be used — dispatch the change event the bindings listen
 * for instead, which is the part under test.
 */
async function toggleSetting(page: Page, id: string, on: boolean) {
    await page.evaluate(({ id, on }) => {
        const el = document.getElementById(id) as HTMLInputElement;
        if (!el) throw new Error('missing settings control: ' + id);
        el.checked = on;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }, { id, on });
}

/**
 * Voice activation — FEATURE_PLAN.md §1.6 (VAD / hold-to-talk):
 *
 *   `speakOnly` must ride the energy gate that already exists in the RNNoise
 *   chain (RNNoise → gate → compressor) instead of adding a second detector,
 *   and it must NOT rewrite a mode that has no worklet to gate.
 *
 *   `holdToTalk` must keep the outgoing mic track disabled until the mic
 *   button is held — a gate, not a mute (toggleMute must not fire on press),
 *   and a server-mute must win over a held button.
 */
test.describe('voice activation (1.6)', () => {
    test('"only transmit while you speak" selects the existing gate chain', async ({ page }) => {
        await register(page, unique('speakonly'));

        const result = await page.evaluate(async () => {
            const vm = (window as any).VoiceManager;
            vm.setNoiseSuppression('rnnoise');
            vm.setSpeakOnly(false);
            const plain = vm.effectiveNsMode();
            vm.setSpeakOnly(true);
            const gated = vm.effectiveNsMode();
            const state = vm.getState();
            vm.setNoiseSuppression('off');
            const offWithSpeakOnly = vm.effectiveNsMode();
            vm.setNoiseSuppression('rnnoise');
            return {
                plain,
                gated,
                saved: state.settings.speakOnly === true,
                stored: JSON.parse(localStorage.getItem('voice_settings') || '{}').speakOnly === true,
                offWithSpeakOnly,
            };
        });

        expect(result.plain).toBe('rnnoise');
        // The setting reuses the shipped gate — no new audio-thread code.
        expect(result.gated).toBe('rnnoise-gate');
        expect(result.saved).toBe(true);
        // Persisted, so it survives the next call and the next page load.
        expect(result.stored).toBe(true);
        // "Off" has no worklet; the setting must not silently re-enable one.
        expect(result.offWithSpeakOnly).toBe('off');
    });

    test('the settings checkbox is wired to the gate (and reads back)', async ({ page }) => {
        await register(page, unique('speakonly-ui'));

        const before = await page.evaluate(() => {
            const el = document.getElementById('voice-speak-only') as HTMLInputElement;
            return el ? el.checked : null;
        });
        expect(before, 'checkbox must exist in Settings → Voice').not.toBeNull();

        await toggleSetting(page, 'voice-speak-only', true);

        const after = await page.evaluate(() => {
            const vm = (window as any).VoiceManager;
            return {
                mode: vm.effectiveNsMode(),
                state: vm.getState().settings.speakOnly,
            };
        });
        expect(after.state).toBe(true);
        expect(after.mode).toBe('rnnoise-gate');

        await toggleSetting(page, 'voice-speak-only', false);
        const off = await page.evaluate(() => (window as any).VoiceManager.effectiveNsMode());
        expect(off).toBe('rnnoise');
    });

    test('hold to talk closes the gate, opens it only while held, and never mutes', async ({ page }) => {
        await register(page, unique('ptt'));

        const result = await page.evaluate(() => {
            const w = window as any;
            const vm = w.VoiceManager;
            const btn = document.getElementById('voice-bar-mute')!;
            const press = () => btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
            const release = () => btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));

            const out: any = {};
            out.beforeEnabled = vm.pttGateOpen();       // hold-to-talk off → always open
            vm.setHoldToTalk(true);
            out.closedImmediately = vm.pttGateOpen();   // a mic nobody holds is NOT live
            out.closedTitle = btn.title;

            press();
            out.whileHeld = vm.pttGateOpen();
            out.heldTitle = btn.title;
            out.heldFlag = vm.getState().pttOpen;

            // A click fires on release in a real browser; it must be swallowed or
            // it would also toggle mute and re-open/close the wrong way.
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            out.mutedAfterClick = vm.getState().muted;

            release();
            out.afterRelease = vm.pttGateOpen();
            vm.setHoldToTalk(false);
            out.backToNormal = vm.pttGateOpen();
            return out;
        });

        expect(result.beforeEnabled).toBe(true);
        expect(result.closedImmediately).toBe(false);
        expect(result.closedTitle).toBe('Hold to talk');
        expect(result.whileHeld).toBe(true);
        expect(result.heldTitle).toBe('Talking — release to stop');
        expect(result.heldFlag).toBe(true);
        // The press must not run toggleMute: hold-to-talk gates, it doesn't mute.
        expect(result.mutedAfterClick).toBe(false);
        expect(result.afterRelease).toBe(false);
        expect(result.backToNormal).toBe(true);
    });

    test('releasing hold-to-talk is idempotent and the feature is inert when off', async ({ page }) => {
        await register(page, unique('ptt-off'));

        const out = await page.evaluate(() => {
            const w = window as any;
            const vm = w.VoiceManager;
            const btn = document.getElementById('voice-bar-mute')!;
            const press = () => btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));

            // Feature OFF (default): the hold handlers must be inert, so a press
            // does not open or close anything and the mic stays live.
            const offOpen = vm.pttGateOpen();
            press();
            const offAfterPress = { gate: vm.pttGateOpen(), pttOpen: vm.getState().pttOpen, muted: vm.getState().muted };

            // Feature ON: releasing twice must be harmless, and the persisted
            // setting must round-trip so a reload keeps it.
            vm.setHoldToTalk(true);
            vm.setPttOpen(false);
            vm.setPttOpen(false);
            const stable = vm.pttGateOpen();
            vm.setHoldToTalk(false);
            return {
                offOpen,
                offAfterPress,
                stable,
                storedOff: JSON.parse(localStorage.getItem('voice_settings') || '{}').holdToTalk,
            };
        });

        expect(out.offOpen).toBe(true);
        expect(out.offAfterPress.gate).toBe(true);
        expect(out.offAfterPress.pttOpen).toBeFalsy();
        expect(out.offAfterPress.muted).toBe(false);
        expect(out.stable).toBe(false);
        // Turning it back off persists the false (not a leftover true).
        expect(out.storedOff).toBe(false);
    });
});
