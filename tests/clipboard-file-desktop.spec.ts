import { test, expect, chromium } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';

/**
 * *Copy file* end to end, in the real box window.
 *
 * `tests/clipboard-file.spec.ts` proves the page *routes* a non-image file to
 * `plugin:box-shell|copyFileToClipboard` and that the payload it builds is the
 * file's exact bytes — with a stubbed shell. That leaves the links a browser
 * test cannot reach:
 *
 *   1. the ACL (the app window's page is a remote origin; a command missing from
 *      the capability is refused before any native code runs),
 *   2. the IPC **transport** — the page is served by a server-supplied CSP, and
 *      this app's own server sends `connect-src 'self' ws: wss:`, so the engine
 *      blocks Tauri's custom-protocol IPC (`http://ipc.localhost`) and Tauri
 *      silently falls back to an interface that serialises JSON and cannot carry
 *      a request body. The raw-body payload desktop used to send therefore never
 *      arrived, and the shell answered "expected the raw request body". This is
 *      the failure the box test exists for,
 *   3. the native write itself.
 *
 * So this spec calls the page's own `copyFileToOsClipboard` in the real window
 * over CDP, then verifies the result with **PowerShell's
 * `Get-Clipboard -Format FileDropList`** — the same reader an Explorer-style
 * paste uses — and compares the file's bytes on disk with the bytes that were
 * sent.
 *
 * Run it (the box must be started with the variable set, on the server origin):
 *
 *     # one terminal
 *     E2E_BOX_DEBUG_PORT=9340 src-tauri/target/release/e2e-chat-app.exe
 *     # another (E2E_BOX_DEBUG_PORT must be set HERE too — the spec reads it)
 *     E2E_BOX_DEBUG_PORT=9340 npx playwright test tests/clipboard-file-desktop.spec.ts
 *
 * It never navigates and never signs anybody in: it uses the window as it is
 * found, so a signed-in session is left exactly as it was. It does replace the
 * contents of your system clipboard (unavoidable for a test of the system
 * clipboard).
 */

const DEBUG_PORT = process.env.E2E_BOX_DEBUG_PORT || '';
const CDP = `http://127.0.0.1:${DEBUG_PORT || '9340'}`;

async function cdpUp(): Promise<boolean> {
    try {
        const res = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1500) });
        return res.ok;
    } catch {
        return false;
    }
}

function clipboardFiles(): string[] {
    const out = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', 'Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }'],
        { encoding: 'utf8' },
    );
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** The app window, attached over the box's debug port. */
async function boxPage() {
    const browser = await chromium.connectOverCDP(CDP);
    const pages = browser.contexts().flatMap((c) => c.pages());
    const page = pages.find((p) => p.url().startsWith('http')) || pages[0];
    await page.waitForLoadState('domcontentloaded');
    return { browser, page };
}

/**
 * The real thing, from the page's own entry point: build a blob with exactly
 * these bytes and ask the page to put it on the clipboard.
 */
function copyInBox(page: any, name: string, payload: number[]) {
    return page.evaluate(
        async ({ name, payload }: { name: string; payload: number[] }) => {
            const W = window as any;
            if (!W.__TAURI__?.core?.invoke) return { ok: false, why: 'no Tauri bridge in this window' };
            if (typeof W.copyFileToOsClipboard !== 'function') {
                return { ok: false, why: 'the page has no copyFileToOsClipboard to call' };
            }
            const blob = new Blob([new Uint8Array(payload)], { type: 'application/x-msdownload' });
            const res = await W.copyFileToOsClipboard(blob, name, 'application/x-msdownload');
            return { ok: !!res.ok, why: res.reason || '' };
        },
        { name, payload },
    );
}

test.describe('copy a file to the clipboard (needs a running box with E2E_BOX_DEBUG_PORT)', () => {
    test('a base64-JSON copy from the app window reaches the OS clipboard', async () => {
        test.skip(!DEBUG_PORT, 'Set E2E_BOX_DEBUG_PORT and start the box first — see this file\'s header.');
        expect(await cdpUp(), `no DevTools endpoint on ${CDP}`).toBeTruthy();

        // 0x4d 0x5a… is the start of a real PE header, i.e. a file type the page
        // could never have put on the clipboard by itself.
        const payload = [0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0xff, 0x2a, 0x11, 0x22];
        const name = 'e2e-clipboard-check.exe';

        const { browser, page } = await boxPage();
        try {
            test.skip(
                !page.url().startsWith('https://'),
                `the box window is on ${page.url()} — this test needs the app served from the box's server`,
            );

            const result = await copyInBox(page, name, payload);
            expect(
                result.ok,
                `the shell refused the copy: ${result.why}\n` +
                    '(a refusal here means the transport, the ACL, or the command is missing for the app window\'s origin)',
            ).toBe(true);

            const files = clipboardFiles();
            expect(files.length, 'the clipboard holds no file after a successful copy').toBeGreaterThan(0);
            const copied = files[0];
            expect(copied.toLowerCase()).toContain(name);
            // The file lives in the *app's own* clipboard folder. On Windows the
            // cache dir is `%LOCALAPPDATA%\<app identifier>` (so there is no
            // folder literally named "cache"), then `\clipboard` — what has to
            // hold is that it is inside the app's directory, not a shared temp
            // folder anything on the machine can enumerate (asserted below).
            expect(copied.toLowerCase()).toContain('clipboard');
            // The paste has to hand over the file the sender sent, byte for byte.
            expect(Array.from(fs.readFileSync(copied))).toEqual(payload);

            // And it is the app's own cache folder, not a shared temp directory
            // anything else on the machine can enumerate.
            expect(copied.toLowerCase()).toContain('e2echat');
        } finally {
            // Detach only — never close, that would shut the user's app window.
            await browser.close().catch(() => {});
        }
    });

    test('the copy is replace-not-accumulate: one file is kept, and it is the newest', async () => {
        test.skip(!DEBUG_PORT, 'Set E2E_BOX_DEBUG_PORT and start the box first — see this file\'s header.');
        expect(await cdpUp(), `no DevTools endpoint on ${CDP}`).toBeTruthy();

        const { browser, page } = await boxPage();
        try {
            test.skip(!page.url().startsWith('https://'), 'the box window is not on the app server');

            const first = await copyInBox(page, 'first-copy.bin', [1, 1, 1]);
            expect(first.ok, `the first copy failed: ${first.why}`).toBe(true);
            const firstDir = clipboardFiles()[0].replace(/[^\\/]+$/, '');

            const second = await copyInBox(page, 'second-copy.bin', [2, 2, 2]);
            expect(second.ok, `the second copy failed: ${second.why}`).toBe(true);

            const after = clipboardFiles();
            expect(after).toHaveLength(1);
            expect(after[0]).toContain('second-copy.bin');
            // The first copy is gone, not merely unreferenced: a replaced entry
            // must not leave a decrypted attachment in the cache folder.
            expect(fs.existsSync(`${firstDir}first-copy.bin`)).toBe(false);
            expect(fs.existsSync(after[0])).toBe(true);
        } finally {
            await browser.close().catch(() => {});
        }
    });
});
