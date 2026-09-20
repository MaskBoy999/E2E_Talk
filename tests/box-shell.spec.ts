import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
const SHELL = fs.readFileSync(path.join(ROOT, 'static', 'box-shell.js'), 'utf8');

const ANDROID_UA =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

/**
 * Stands in for the parts of the Tauri bridge `box-shell.js` touches: records
 * every `plugin:box-shell|…` invoke and lets a test fire `box:back` exactly the
 * way the Kotlin plugin does (`Plugin.trigger`).
 */
const STUB = `
    window.__boxCalls = [];
    window.__boxListeners = {};
    window.__tauri = undefined;
    window.__TAURI__ = {
        core: {
            invoke: function (cmd, args) {
                window.__boxCalls.push({ cmd: cmd, args: args || {} });
                return Promise.resolve();
            }
        },
        event: {
            listen: function (name, cb) {
                (window.__boxListeners[name] = window.__boxListeners[name] || []).push(cb);
                return Promise.resolve(function () {});
            }
        }
    };
`;

function callsFor(cmd: string) {
    return `window.__boxCalls.filter(function (c) { return c.cmd === 'plugin:box-shell|' + '${cmd}'; })`;
}

test.describe('android shell', () => {
    test.use({ userAgent: ANDROID_UA });

    test('asks for immersive bars and the Back handler on load', async ({ page }) => {
        await page.setContent('<p>app</p>');
        // setContent does not navigate, so an init script would never run — the
        // stub has to be a script tag, installed before the shell script.
        await page.addScriptTag({ content: STUB });
        await page.addScriptTag({ content: SHELL });

        // Applied immediately and retried (Android drops the first request while
        // the activity is not yet focused, i.e. during a page load).
        await expect
            .poll(() => page.evaluate(`(${callsFor('enterImmersive')}).length`), { timeout: 3000 })
            .toBeGreaterThan(0);
        await expect.poll(() => page.evaluate(`(${callsFor('setBackHandler')}).length`)).toBe(1);
        const back = await page.evaluate(`(${callsFor('setBackHandler')})[0]`);
        expect(back.args.active, 'Back is routed to the page').toBe(true);
    });

    test('Back closes the top layer instead of leaving the app', async ({ page }) => {
        await page.setContent('<p>app</p>');
        // setContent does not navigate, so an init script would never run — the
        // stub has to be a script tag, installed before the shell script.
        await page.addScriptTag({ content: STUB });
        await page.addScriptTag({
            content: 'window.__closed = 0; window._boxCloseTopLayer = function () { window.__closed++; return true; };',
        });
        await page.addScriptTag({ content: SHELL });

        await page.evaluate(`window.__boxListeners['box:back'][0]()`);
        expect(await page.evaluate('window.__closed'), 'the page was asked to close its top layer').toBe(1);
        expect(await page.evaluate(`(${callsFor('exit')}).length`), 'the app must stay open').toBe(0);
    });

    test('Back with nothing open leaves the app', async ({ page }) => {
        await page.setContent('<p>app</p>');
        // setContent does not navigate, so an init script would never run — the
        // stub has to be a script tag, installed before the shell script.
        await page.addScriptTag({ content: STUB });
        // The setup screen has no chat.js, so no top-layer handler exists — and
        // a page whose handler reports "nothing to close" behaves the same.
        await page.addScriptTag({ content: 'window._boxCloseTopLayer = function () { return false; };' });
        await page.addScriptTag({ content: SHELL });

        await page.evaluate(`window.__boxListeners['box:back'][0]()`);
        await expect.poll(() => page.evaluate(`(${callsFor('exit')}).length`)).toBe(1);
    });

    test('a throwing top-layer handler still cannot trap the user', async ({ page }) => {
        await page.setContent('<p>app</p>');
        // setContent does not navigate, so an init script would never run — the
        // stub has to be a script tag, installed before the shell script.
        await page.addScriptTag({ content: STUB });
        await page.addScriptTag({ content: 'window._boxCloseTopLayer = function () { throw new Error("boom"); };' });
        await page.addScriptTag({ content: SHELL });

        await page.evaluate(`window.__boxListeners['box:back'][0]()`);
        await expect.poll(() => page.evaluate(`(${callsFor('exit')}).length`)).toBe(1);
    });
});

test.describe('outside the box', () => {
    test('a plain browser touches nothing', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.setContent('<p>app</p>');
        await page.addScriptTag({ content: SHELL });

        expect(errors, 'no errors in a normal browser').toEqual([]);
        expect(await page.evaluate('window.__boxCalls')).toBeUndefined();
    });

    test('a desktop box with the bridge present still stays out of the way', async ({ page }) => {
        // Desktop has the Tauri bridge but no Android shell: the UA guard is what
        // keeps it from hiding a desktop window's chrome.
        await page.setContent('<p>app</p>');
        // setContent does not navigate, so an init script would never run — the
        // stub has to be a script tag, installed before the shell script.
        await page.addScriptTag({ content: STUB });
        await page.addScriptTag({ content: SHELL });

        expect(await page.evaluate('window.__boxCalls.length')).toBe(0);
    });
});
