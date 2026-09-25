import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Copying a *file* to the clipboard (0.2.30).
 *
 * The bug this pins: right-clicking an attachment and choosing "Copy file" said
 * **"Could not copy that file type — this browser only allows images"**. That
 * message was accurate — Chromium's async Clipboard API accepts text/plain,
 * text/html and image/png and refuses every other type *in the engine itself* —
 * so the fix is not a prettier toast but a second path: the page hands the
 * decrypted bytes to the shell, which writes them into the app's own cache
 * directory and puts that path on the OS clipboard in the platform's file
 * format (Windows CF_HDROP, the macOS file pasteboard, X11/Wayland
 * text/uri-list, an Android FileProvider URI).
 *
 * Three things have to hold together, each asserted on the layer that can break
 * it:
 *
 *  1. the page routes non-images to `plugin:box-shell|copyFileToClipboard` with
 *     the file's real name and its exact bytes (browser test, real page);
 *  2. the command exists on both halves of the plugin and is in the ACL — a
 *     missing ACL entry is refused before native code ever runs, and the Android
 *     half cannot be run here at all (source assertions);
 *  3. images keep using the page's own clipboard, so a pasted sticker still
 *     arrives as a picture rather than as a file.
 */

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';
const PASSWORD = 'testpass1234';
const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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

test.describe('copy any file type to the clipboard (0.2.30)', () => {
    test('a non-image file goes to the shell, name and bytes intact', async ({ page }) => {
        await register(page, unique('clip'));

        const seen = await page.evaluate(async () => {
            const W = window as any;
            const calls: any[] = [];
            // The shell is a WebView primitive: stand in for it and record the
            // exact call the page makes. Everything else is the real code.
            W.__TAURI__ = {
                core: {
                    invoke: async (cmd: string, args?: any) => {
                        calls.push({ cmd, args });
                        return null;
                    },
                },
            };
            const payload = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0xff, 0x2a]);
            const blob = new Blob([payload], { type: 'application/x-msdownload' });
            const ok = await W.copyBlobToClipboard(
                blob, 'File "Equilotl.exe"', 'Equilotl.exe', 'application/x-msdownload');
            return { ok, calls, payload: Array.from(payload) };
        });

        expect(seen.ok).toBe(true);
        expect(seen.calls).toHaveLength(1);
        expect(seen.calls[0].cmd).toBe('plugin:box-shell|copyFileToClipboard');

        // Desktop shape: one raw body, `[u32 LE name length][name][bytes]`.
        const body: Uint8Array = seen.calls[0].args;
        expect(body).toBeInstanceOf(Uint8Array);
        const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
        const nameLen = view.getUint32(0, true);
        const name = new TextDecoder().decode(body.slice(4, 4 + nameLen));
        expect(name).toBe('Equilotl.exe');
        // The bytes must be the decrypted file itself: an .exe pasted after a
        // re-encode is not the file the sender sent.
        expect(Array.from(body.slice(4 + nameLen))).toEqual(seen.payload);
    });

    test('with no shell behind it, the page says so and names the file', async ({ page }) => {
        await register(page, unique('clipweb'));

        const result = await page.evaluate(async () => {
            const W = window as any;
            delete W.__TAURI__; // a plain browser: no shell at all
            const toasts: string[] = [];
            W.showToast = (m: string) => toasts.push(m);
            const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'application/zip' });
            let threw = false;
            let ok = false;
            try {
                ok = await W.copyBlobToClipboard(blob, 'File "logs.zip"', 'logs.zip', 'application/zip');
            } catch (_) { threw = true; }
            return { ok, threw, toasts };
        });

        // A refusal, never a crash and never a silent no-op.
        expect(result.threw).toBe(false);
        expect(result.ok).toBe(false);
        expect(result.toasts.length).toBe(1);
        expect(result.toasts[0]).toContain('logs.zip');
        expect(result.toasts[0].toLowerCase()).toContain('app');
    });

    test('images still copy through the page clipboard, as images', async ({ page }) => {
        await register(page, unique('clipimg'));

        const result = await page.evaluate(async () => {
            const W = window as any;
            const invokeCalls: string[] = [];
            W.__TAURI__ = { core: { invoke: async (cmd: string) => { invokeCalls.push(cmd); return null; } } };
            const written: string[] = [];
            // Stand in for the engine's clipboard, which a headless browser
            // cannot touch: what matters here is which route the page chooses.
            W.ClipboardItem = function (this: any, item: any) { Object.assign(this, item); };
            // `navigator.clipboard` is a read-only accessor, so a plain
            // assignment is a silent no-op and the real engine clipboard would
            // take the write. Define it instead.
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: {
                    write: async (items: any[]) => {
                        for (const it of items) written.push(...Object.keys(it));
                    },
                },
            });
            const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
            const ok = await W.copyBlobToClipboard(blob, 'Image "shot.png"', 'shot.png', 'image/png');
            return { ok, invokeCalls, written };
        });

        expect(result.ok).toBe(true);
        expect(result.written).toEqual(['image/png']);
        // Nothing is sent to the shell for an image: the page path is what makes
        // a paste land as a picture rather than as a file.
        expect(result.invokeCalls).toEqual([]);
    });

    test('both halves of the plugin declare the command, and the ACL grants it', async () => {
        const buildRs = read('src-tauri/plugins/box-shell/build.rs');
        const acl = read('src-tauri/plugins/box-shell/permissions/default.toml');
        const pluginRs = read('src-tauri/plugins/box-shell/src/lib.rs');
        const clipboardRs = read('src-tauri/plugins/box-shell/src/clipboard.rs');
        const kotlin = read('src-tauri/plugins/box-shell/android/src/main/java/com/e2echat/boxshell/BoxShellPlugin.kt');

        // The command list generates `allow-copyFileToClipboard`; the default
        // permission set is what the remote app page is actually granted.
        expect(buildRs).toContain('"copyFileToClipboard"');
        expect(acl).toContain('allow-copyFileToClipboard');

        // Desktop: a Rust command that reads the raw body and writes the file.
        expect(pluginRs).toContain('fn copyFileToClipboard');
        expect(pluginRs).toContain('tauri::ipc::InvokeBody::Raw');
        expect(clipboardRs).toContain('CF_HDROP');
        expect(clipboardRs).toContain('text/uri-list');

        // Android: the same command name, in Kotlin, against the FileProvider the
        // generated manifest already declares — and the entry is cleared before
        // every write, so a replaced copy leaves no plaintext behind.
        expect(kotlin).toContain('fun copyFileToClipboard');
        expect(kotlin).toContain('ClipData.newUri');
        expect(kotlin).toContain('FileProvider.getUriForFile');
        expect(kotlin).toContain('stale.delete()');
    });

    test('the clipboard is a write-only path — nothing can read a file back in', async () => {
        // The tempting next feature is "paste a file from the clipboard", which
        // would hand any page in the WebView read access to whatever the host had
        // copied. It is absent on purpose, so it is pinned here.
        const kotlin = read('src-tauri/plugins/box-shell/android/src/main/java/com/e2echat/boxshell/BoxShellPlugin.kt');
        expect(kotlin).not.toContain('getPrimaryClip');
        expect(kotlin).not.toContain('primaryClip');

        const chatJs = read('static/chat.js');
        expect(chatJs).not.toContain('navigator.clipboard.read');
        // And no command in the native surface reads anything back.
        const buildRs = read('src-tauri/plugins/box-shell/build.rs');
        expect(buildRs.toLowerCase()).not.toContain('readclipboard');
        expect(buildRs.toLowerCase()).not.toContain('pastefile');
    });
});
