import { test, expect, chromium } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';

/**
 * *Copy file* end to end, in the real box window (0.2.30).
 *
 * `tests/clipboard-file.spec.ts` proves the page *routes* a non-image file to
 * `plugin:box-shell|copyFileToClipboard` and that the payload it builds is the
 * file's exact bytes — with a stubbed shell. That leaves the one link a browser
 * test cannot reach: whether a **raw-body** invoke from a *remote* origin is
 * actually accepted by the shell and lands on the operating system's clipboard.
 * Three separate things can break there, and each is invisible until a user
 * right-clicks an attachment:
 *
 *   1. the ACL (the app window's page is a remote origin; a command missing from
 *      the capability is refused before any native code runs),
 *   2. the raw IPC body (desktop sends `[u32 LE name length][name][bytes]`, not
 *      JSON),
 *   3. the native write itself.
 *
 * So this spec talks to the real window over CDP and then verifies the result
 * with **PowerShell's `Get-Clipboard -Format FileDropList`** — the same reader an
 * Explorer-style paste uses — and compares the file's bytes on disk with the
 * bytes that were sent.
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

test.describe('copy a file to the clipboard (needs a running box with E2E_BOX_DEBUG_PORT)', () => {
    test('a raw-body invoke from the app window reaches the OS clipboard', async () => {
        test.skip(!DEBUG_PORT, 'Set E2E_BOX_DEBUG_PORT and start the box first — see this file\'s header.');
        expect(await cdpUp(), `no DevTools endpoint on ${CDP}`).toBeTruthy();

        // 0x4d 0x5a… is the start of a real PE header, i.e. a file type the page
        // could never have put on the clipboard by itself.
        const payload = [0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0xff, 0x2a, 0x11, 0x22];
        const name = 'e2e-clipboard-check.exe';

        const browser = await chromium.connectOverCDP(CDP);
        try {
            const pages = browser.contexts().flatMap((c) => c.pages());
            const page = pages.find((p) => p.url().startsWith('http')) || pages[0];
            await page.waitForLoadState('domcontentloaded');
            test.skip(
                !page.url().startsWith('https://'),
                `the box window is on ${page.url()} — this test needs the app served from the box's server`,
            );

            const result = await page.evaluate(
                async ({ payload, name }: { payload: number[]; name: string }) => {
                    const W = window as any;
                    if (!W.__TAURI__?.core?.invoke) return { ok: false, why: 'no Tauri bridge in this window' };
                    // Exactly what `copyFileToOsClipboard` builds on desktop.
                    const nameBytes = new TextEncoder().encode(name);
                    const head = new Uint8Array(4);
                    new DataView(head.buffer).setUint32(0, nameBytes.length, true);
                    const data = new Uint8Array(payload);
                    const body = new Uint8Array(4 + nameBytes.length + data.length);
                    body.set(head, 0);
                    body.set(nameBytes, 4);
                    body.set(data, 4 + nameBytes.length);
                    try {
                        await W.__TAURI__.core.invoke('plugin:box-shell|copyFileToClipboard', body);
                        return { ok: true, why: '' };
                    } catch (e) {
                        return { ok: false, why: String(e) };
                    }
                },
                { payload, name },
            );

            expect(
                result.ok,
                `the shell refused the copy: ${result.why}\n` +
                    '(a refusal here means the ACL or the command is missing for the app window\'s origin)',
            ).toBe(true);

            const files = clipboardFiles();
            expect(files.length, 'the clipboard holds no file after a successful copy').toBeGreaterThan(0);
            const copied = files[0];
            expect(copied.toLowerCase()).toContain(name);
            expect(copied.toLowerCase()).toContain('cache');
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

        const browser = await chromium.connectOverCDP(CDP);
        try {
            const pages = browser.contexts().flatMap((c) => c.pages());
            const page = pages.find((p) => p.url().startsWith('http')) || pages[0];
            await page.waitForLoadState('domcontentloaded');
            test.skip(!page.url().startsWith('https://'), 'the box window is not on the app server');

            const copy = (name: string, bytes: number[]) =>
                page.evaluate(
                    async ({ name, bytes }: { name: string; bytes: number[] }) => {
                        const W = window as any;
                        const nameBytes = new TextEncoder().encode(name);
                        const head = new Uint8Array(4);
                        new DataView(head.buffer).setUint32(0, nameBytes.length, true);
                        const data = new Uint8Array(bytes);
                        const body = new Uint8Array(4 + nameBytes.length + data.length);
                        body.set(head, 0);
                        body.set(nameBytes, 4);
                        body.set(data, 4 + nameBytes.length);
                        await W.__TAURI__.core.invoke('plugin:box-shell|copyFileToClipboard', body);
                    },
                    { name, bytes },
                );

            await copy('first-copy.bin', [1, 1, 1]);
            const firstDir = clipboardFiles()[0].replace(/[^\\/]+$/, '');
            await copy('second-copy.bin', [2, 2, 2]);

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
