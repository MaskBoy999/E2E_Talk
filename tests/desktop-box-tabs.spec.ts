import { test, expect, chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The two things this release keeps on the *desktop box*, driven in the real
 * app window (WebView2 / WebKit) rather than a test browser:
 *
 *   1. The custom-icons settings tab. It is app-only on purpose (the same gate
 *      as the hidden Connection tab: `window.__TAURI__.core.invoke`), so the
 *      only place its bridge can be observed is a running box. The gate's
 *      *behaviour* — reveal with the bridge, hide without it — is pinned in
 *      tests/app-only-tabs.spec.ts, which does not depend on the account state
 *      of someone's app window.
 *   2. Live captions. They must exist and actually transcribe in the box: the
 *      bundled whisper model has to load in that webview and turn one
 *      participant's audio into a labelled line, with nothing leaving the box.
 *
 * The box may legitimately be sitting on the key-vault unlock screen (the
 * window is only booted as far as that), and the app deliberately stops there —
 * so the tab *reveal* is only asserted once the page has actually booted.
 *
 * Run it (a box must be up with the debug port set):
 *
 *     E2E_BOX_DEBUG_PORT=9340 src-tauri/target/release/e2e-chat-app.exe
 *     E2E_BOX_DEBUG_PORT=9340 npx playwright test tests/desktop-box-tabs.spec.ts
 */

const DEBUG_PORT = process.env.E2E_BOX_DEBUG_PORT || '';
const CDP = `http://127.0.0.1:${DEBUG_PORT || '9340'}`;
const WAV = join(__dirname, 'fixtures', 'hello-captions.wav');

test.describe.configure({ timeout: 300000 });

async function cdpUp(): Promise<boolean> {
    try {
        const res = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1500) });
        return res.ok;
    } catch {
        return false;
    }
}

test.describe('desktop box: app-only tabs and local captions', () => {
    test('the box exposes the bridge, has the Icons tab, and transcribes locally', async () => {
        test.skip(!DEBUG_PORT, "Set E2E_BOX_DEBUG_PORT and start the box first — see this file's header.");
        expect(await cdpUp(), `no DevTools endpoint on ${CDP}`).toBeTruthy();

        const browser = await chromium.connectOverCDP(CDP);
        try {
            const pages = browser.contexts().flatMap((c) => c.pages());
            const page = pages.find((p) => p.url().startsWith('http')) || pages[0];
            test.skip(
                !page.url().startsWith('https://'),
                `the box window is on ${page.url()} — this test needs the app served from the box's server`,
            );

            const errors: string[] = [];
            page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

            // The window has been open since launch, so reload it: the box must be
            // running the markup and scripts that are actually on the server.
            await page.reload({ waitUntil: 'load' }).catch(() => {});
            await page.waitForTimeout(2000);

            const state = await page.evaluate(() => {
                const el = (id: string) => document.getElementById(id) as HTMLElement | null;
                const shown = (id: string) => {
                    const e = el(id);
                    return !e ? 'missing' : getComputedStyle(e).display === 'none' ? 'hidden' : 'shown';
                };
                return {
                    bridge: !!(window as any).__TAURI__?.core?.invoke,
                    // Booted = the app got past the vault/token gate, which is the
                    // only state in which the settings tabs are meant to matter.
                    booted: !document.getElementById('vault-lock-overlay')
                        && !!document.getElementById('settings-modal'),
                    icons: shown('icon-settings-tab'),
                    connection: shown('connection-settings-tab'),
                    iconsPanel: !!el('icon-packs-settings'),
                    cssTab: !!document.querySelector('.settings-tab[data-tab="custom-css-settings"]'),
                    captionsToggle: !!el('captions-toggle'),
                    captionsLanguage: !!el('captions-language'),
                    captionsSelf: !!el('captions-self-toggle'),
                };
            });

            expect(state.bridge, 'the box must expose the Tauri bridge').toBe(true);
            // The elements the gate reveals must exist in the box's own markup.
            expect(state.iconsPanel, 'the Icons panel must exist').toBe(true);
            expect(state.cssTab, 'the CSS settings tab must still exist').toBe(true);
            expect(state.captionsToggle, 'the captions control must exist in the box').toBe(true);
            expect(state.captionsLanguage, 'the captions language control must exist in the box').toBe(true);
            expect(state.captionsSelf, 'the "also caption my voice" control must exist in the box').toBe(true);
            if (state.booted) {
                expect(state.icons, 'the Icons tab must be revealed in a booted box').toBe('shown');
                expect(state.connection, 'the Connection tab must be revealed in a booted box').toBe('shown');
            } else {
                // Locked at the key-vault screen: boot stops there on purpose.
                console.log('box is on the vault-lock screen; skipping the reveal assertion (bridge + markup still verified)');
            }

            // ── captions run on-device, in this webview ──
            const external: string[] = [];
            page.on('request', (req) => {
                const url = req.url();
                const local = url.startsWith('https://') || url.startsWith('data:') || url.startsWith('blob:');
                if (!local) external.push(url);
            });
            const beforeExternal = external.length;

            await page.evaluate(() => (window as any).__captions.start());
            await expect
                .poll(async () => page.evaluate(() => (window as any).__captions.modelState().state), { timeout: 240000 })
                .toBe('ready');

            const wavB64 = readFileSync(WAV).toString('base64');
            const pcm = await page.evaluate(async (b64: string) => {
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const ctx = new AudioContext({ sampleRate: 16000 });
                const buf = await ctx.decodeAudioData(bytes.buffer);
                const data = Array.from(buf.getChannelData(0));
                await ctx.close();
                return data;
            }, wavB64);

            const accepted = await page.evaluate(
                (data) => (window as any).__captions._feedForTest('box-peer-1', 'Alice', new Float32Array(data), 16000),
                pcm,
            );
            expect(accepted, 'the box must accept a speech window').toBe(true);

            await expect
                .poll(async () => {
                    const lines = await page.evaluate(() => (window as any).__captions.lines());
                    return lines.length ? lines[lines.length - 1].who + ': ' + lines[lines.length - 1].text : '';
                }, { timeout: 120000 })
                .toContain('Alice:');

            const line = await page.evaluate(() => {
                const lines = (window as any).__captions.lines();
                return lines[lines.length - 1];
            });
            expect(line.text.toLowerCase(), 'the box must recognise real speech').toContain('speech recognition');

            expect(external.slice(beforeExternal), 'captions in the box must not reach the network').toEqual([]);

            // Leave the app as we found it: captions off, lines dropped.
            await page.evaluate(() => (window as any).__captions.stop());
            expect(await page.evaluate(() => (window as any).__captions.isRunning())).toBe(false);

            expect(errors, `the box window reported errors:\n${errors.join('\n')}`).toEqual([]);
        } finally {
            // Detach only — never close: that would shut the user's app window.
            await browser.close().catch(() => {});
        }
    });
});
