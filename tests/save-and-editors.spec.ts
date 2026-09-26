import { test, expect, type Browser, type Page } from '@playwright/test';
// @ts-ignore – the vendored SheetJS build ships no type declarations
import XLSX from '../static/libs/xlsx.full.min.js';

const BASE = 'https://localhost:3443';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// A two-sheet workbook generated in Node, so the test feeds the app real
// bytes instead of a fixture blob.
function makeWorkbookBuffer() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([['Region', 'Sales'], ['East', 120], ['West', 95]]),
        'Q1',
    );
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['note']]), 'Notes');
    return Buffer.from(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));
}

// ── A shell stub ─────────────────────────────────────────────────────────────
// box-shell.js reads `window.__TAURI__` live (it never captures the bridge), so
// a stub installed at any point makes the page believe it is inside the app.
//
// The payload is JSON with the bytes in base64 — the same shape on both
// platforms, because the raw request body the desktop half used to take never
// arrives (a server-supplied CSP blocks Tauri's custom-protocol IPC and the
// fallback interface cannot carry a body). The recorder decodes it, so the test
// asserts on the *contents* the page handed over, not just the command name.
function installShellStub(page: Page, opts: { android?: boolean } = {}) {
    return page.evaluate((android) => {
        window.__saveCalls = [];
        window.__TAURI__ = {
            core: {
                invoke: function (cmd: string, args: any) {
                    const record: any = { cmd: cmd };
                    if (args && typeof args === 'object' && args.data !== undefined) {
                        record.name = args.name;
                        record.mime = args.mime;
                        record.body = atob(args.data);
                    } else if (args && args.byteLength !== undefined) {
                        // Defence in depth: nothing sends this shape any more, but
                        // if something does, record it rather than pass silently.
                        const u8 = new Uint8Array(args);
                        const len = new DataView(u8.buffer).getUint32(0, true);
                        record.rawBody = true;
                        record.name = new TextDecoder().decode(u8.subarray(4, 4 + len));
                    }
                    window.__saveCalls.push(record);
                    return Promise.resolve(
                        android ? { name: record.name, uri: 'content://downloads/1' }
                               : 'C:/Users/test/Downloads/' + record.name
                    );
                },
            },
        };
    }, !!opts.android);
}

test.describe('native save to disk (desktop shell)', () => {
    test('boxSaveFile sends the bytes as base64 JSON and reports success', async ({ page }) => {
        await page.goto('about:blank');
        await page.addScriptTag({ path: 'static/box-shell.js' });
        await installShellStub(page);

        expect(await page.evaluate(() => window.boxCanSaveToDisk())).toBe(true);

        const ok = await page.evaluate(() =>
            window.boxSaveFile(new Blob(['hello world']), 'note.txt'));
        expect(ok).toBe(true);

        const calls = await page.evaluate(() => window.__saveCalls);
        expect(calls).toHaveLength(1);
        expect(calls[0].cmd).toBe('plugin:box-shell|saveFile');
        expect(calls[0].name).toBe('note.txt');
        expect(calls[0].body).toBe('hello world');
        expect(calls[0].rawBody).toBeUndefined();
        // One payload shape for desktop and Android.
        expect(calls[0].mime).toBe('application/octet-stream');
    });

    test('a file over the shell transfer ceiling is refused before a payload is built', async ({ page }) => {
        await page.goto('about:blank');
        await page.addScriptTag({ path: 'static/box-shell.js' });
        await installShellStub(page);

        const result = await page.evaluate(async () => {
            // The ceiling is the shell's own (100 MB). Assembling a 1.3x base64
            // string for something the shell would refuse is the crash, not the
            // fix, so the page checks first.
            const big = new Blob([new Uint8Array(100 * 1024 * 1024 + 1)]);
            const toasts: string[] = [];
            (window as any).showToast = (m: string) => toasts.push(m);
            const ok = await window.boxSaveFile(big, 'huge.iso');
            return { ok, calls: window.__saveCalls.length, toasts };
        });

        expect(result.ok).toBe(false);
        expect(result.calls).toBe(0);
        expect(result.toasts.join(' ')).toContain('too large');
    });

    test('no shell → no native save; the helper still resolves', async ({ page }) => {
        await page.goto('about:blank');
        await page.addScriptTag({ path: 'static/box-shell.js' });

        expect(await page.evaluate(() => window.boxCanSaveToDisk())).toBe(false);
        // A plain browser download is not observable from the page; the contract
        // that matters is that the helper exists everywhere and does not throw.
        const result = await page.evaluate(async () =>
            window.saveBlobToDisk(new Blob(['x']), 'x.txt'));
        expect(result).toBe(true);
    });
});

test.describe('native save to disk (android shell)', () => {
    test.use({
        userAgent:
            'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    });

    test('boxSaveFile carries base64 and the mime type', async ({ page }) => {
        await page.goto('about:blank');
        await page.addScriptTag({ path: 'static/box-shell.js' });
        await installShellStub(page, { android: true });

        const ok = await page.evaluate(() =>
            window.boxSaveFile(new Blob(['hi']), 'photo.png'));
        expect(ok).toBe(true);

        const calls = await page.evaluate(() => window.__saveCalls);
        expect(calls).toHaveLength(1);
        expect(calls[0].cmd).toBe('plugin:box-shell|saveFile');
        expect(calls[0].name).toBe('photo.png');
        // Blob(['hi']) has no type, so the bridge sends the octet-stream default.
        expect(calls[0].mime).toBe('application/octet-stream');
        expect(calls[0].body).toBe('hi');
    });
});

// ── The real app ─────────────────────────────────────────────────────────────
// Registration is rate-limited per IP (5 / 10 min by default), so the suite
// registers ONE account and every test logs in — the same budget the existing
// specs live within when the dev server is already running.

let account: { username: string; password: string } | null = null;
const PASSWORD = 'TestPass123!';

async function registerOnce(browser: Browser) {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    try {
        const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const username = `save_${ts}`;
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', PASSWORD);
        await page.fill('#register-confirm-password', PASSWORD);
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 30000 });

        // One server with one channel, reused by every test.
        await page.click('#add-server-btn');
        await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
        await page.click('#choice-create-server');
        await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 5000 });
        await page.fill('#new-server-name', 'Save Test Server');
        await page.click('#confirm-create-server');
        await page.waitForSelector('#create-server-modal', { state: 'hidden', timeout: 15000 });
        account = { username: username, password: PASSWORD };
    } finally {
        await page.close();
    }
}

async function loginAndOpenChannel(page: Page) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#login-username');
    await page.fill('#login-username', account!.username);
    await page.fill('#login-password', account!.password);
    await page.click('#login-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });

    const serverIcon = page.locator('.server-icon').first();
    await serverIcon.waitFor({ state: 'visible', timeout: 15000 });
    await serverIcon.click();
    await page.waitForSelector('.channel-item', { timeout: 10000 });
    await page.click('.channel-item >> nth=0');
    await page.waitForTimeout(500);
}

test.describe('app', () => {
    test.beforeAll(async ({ browser }) => {
        await registerOnce(browser);
    });

    test('downloads route through the shell', async ({ page }) => {
        await loginAndOpenChannel(page);
        await installShellStub(page);

        const shapes = await page.evaluate(() => ({
            save: typeof window.saveBlobToDisk,
            saveUrl: typeof window.saveUrlAs,
            canSave: typeof window.boxCanSaveToDisk,
            trigger: typeof window.triggerBlobDownload,
            blobAs: typeof window.downloadBlobAs,
        }));
        expect(shapes.save).toBe('function');
        expect(shapes.saveUrl).toBe('function');
        expect(shapes.canSave).toBe('function');
        expect(shapes.trigger).toBe('function');
        expect(shapes.blobAs).toBe('function');

        await page.evaluate(() =>
            window.triggerBlobDownload(new Blob(['attachment bytes']), 'report.pdf'));
        await page.waitForFunction(() => window.__saveCalls.length > 0, { timeout: 5000 });

        const calls = await page.evaluate(() => window.__saveCalls);
        expect(calls[0].cmd).toBe('plugin:box-shell|saveFile');
        expect(calls[0].name).toBe('report.pdf');
        expect(calls[0].body).toBe('attachment bytes');
    });

    test('more file types open in the text editor', async ({ page }) => {
        await loginAndOpenChannel(page);
        const cases = [
            { name: 'config.yaml', mime: 'text/yaml', body: 'a: 1\nb: 2\n' },
            { name: 'notes.md', mime: 'text/markdown', body: '# hello\n' },
            { name: 'data.json', mime: 'application/json', body: '{"a":1}\n' },
            { name: 'Dockerfile', mime: '', body: 'FROM scratch\n' },
            { name: '.env', mime: '', body: 'KEY=value\n' },
            { name: 'styles.scss', mime: 'text/x-scss', body: '.a { color: red; }\n' },
        ];
        for (const c of cases) {
            await page.locator('#file-input').setInputFiles({
                name: c.name,
                mimeType: c.mime,
                buffer: Buffer.from(c.body),
            });
            await page.waitForSelector('#upload-modal', { state: 'visible', timeout: 5000 });
            await page.click('#upload-btn-edit');
            await expect(page.locator('#text-edit-modal')).toBeVisible({ timeout: 5000 });
            expect(await page.inputValue('#text-edit-area')).toBe(c.body);
            await page.click('#text-edit-cancel');
            await expect(page.locator('#text-edit-modal')).toBeHidden({ timeout: 5000 });
            await page.click('#cancel-upload');
            await expect(page.locator('#upload-modal')).toBeHidden({ timeout: 5000 });
        }
    });

    test('spreadsheet edits round-trip through the file', async ({ page }) => {
        await loginAndOpenChannel(page);

        await page.locator('#file-input').setInputFiles({
            name: 'regions.xlsx',
            mimeType: XLSX_MIME,
            buffer: makeWorkbookBuffer(),
        });
        await page.waitForSelector('#upload-modal', { state: 'visible', timeout: 5000 });
        await page.click('#upload-btn-edit');
        await expect(page.locator('#sheet-edit-modal')).toBeVisible({ timeout: 5000 });
        await expect(page.locator('#sheet-edit-tabs button')).toHaveText(['Q1', 'Notes']);
        const cell = (sheet: string, addr: string) =>
            page.locator(`#sheet-edit-body table[data-sheet="${sheet}"] td[data-addr="${addr}"]`);
        await expect(cell('Q1', 'A1')).toHaveText('Region');

        // Edit a text cell and a numeric one.
        await cell('Q1', 'A1').fill('Region2');
        await cell('Q1', 'B2').fill('130');
        await page.click('#sheet-edit-confirm');
        await expect(page.locator('#sheet-edit-modal')).toBeHidden({ timeout: 5000 });

        // Re-open: the values came back through real serialized bytes.
        await page.click('#upload-btn-edit');
        await expect(page.locator('#sheet-edit-modal')).toBeVisible({ timeout: 5000 });
        await expect(cell('Q1', 'A1')).toHaveText('Region2');
        await expect(cell('Q1', 'B2')).toHaveText('130');
        // The untouched second sheet survived.
        await page.click('#sheet-edit-tabs button:has-text("Notes")');
        await expect(cell('Notes', 'A1')).toHaveText('note');

        await page.click('#sheet-edit-cancel');
        await expect(page.locator('#sheet-edit-modal')).toBeHidden({ timeout: 5000 });
        await page.click('#cancel-upload');
        await expect(page.locator('#upload-modal')).toBeHidden({ timeout: 5000 });
    });

    test.describe('phone viewport', () => {
        test.use({ viewport: { width: 390, height: 844 } });

        test('photo editor header fits the screen', async ({ page }) => {
            await loginAndOpenChannel(page);

            const pngData = await page.evaluate(() => {
                const canvas = document.createElement('canvas');
                canvas.width = 200;
                canvas.height = 150;
                canvas.getContext('2d')!.fillRect(0, 0, 200, 150);
                return canvas.toDataURL('image/png').split(',')[1];
            });
            await page.locator('#file-input').setInputFiles({
                name: 'phone-photo.png',
                mimeType: 'image/png',
                buffer: Buffer.from(pngData, 'base64'),
            });
            await page.waitForSelector('#upload-modal', { state: 'visible', timeout: 5000 });
            await page.click('#upload-btn-edit');
            await expect(page.locator('#photo-edit-modal')).toBeVisible({ timeout: 5000 });

            // Touch targets are grown to 40px by the phone media query.
            const toolWidth = await page.evaluate(() =>
                getComputedStyle(document.getElementById('photo-tool-brush')!).width);
            expect(toolWidth).toBe('40px');

            // Cancel/Confirm stay inside the viewport instead of wrapping off it.
            const confirm = await page.locator('#photo-edit-confirm').boundingBox();
            expect(confirm).not.toBeNull();
            expect(confirm!.x).toBeGreaterThanOrEqual(0);
            expect(confirm!.x + confirm!.width).toBeLessThanOrEqual(390);

            // The header does not swallow the editor: the canvas area keeps most
            // of the 844px screen, and the canvas itself never overflows the
            // 390px width.
            const wrap = await page.locator('#photo-edit-wrap').boundingBox();
            expect(wrap).not.toBeNull();
            expect(wrap!.height).toBeGreaterThan(400);
            const canvasBox = await page.locator('#photo-edit-canvas').boundingBox();
            expect(canvasBox).not.toBeNull();
            expect(canvasBox!.width).toBeLessThanOrEqual(390);
        });

        test('spreadsheet editor fits the screen', async ({ page }) => {
            await loginAndOpenChannel(page);

            await page.locator('#file-input').setInputFiles({
                name: 'regions.xlsx',
                mimeType: XLSX_MIME,
                buffer: makeWorkbookBuffer(),
            });
            await page.waitForSelector('#upload-modal', { state: 'visible', timeout: 5000 });
            await page.click('#upload-btn-edit');
            await expect(page.locator('#sheet-edit-modal')).toBeVisible({ timeout: 5000 });

            // The card never grows past the viewport…
            const card = await page.locator('#sheet-edit-modal > div').boundingBox();
            expect(card).not.toBeNull();
            expect(card!.width).toBeLessThanOrEqual(390);
            // …and Cancel/Save stay reachable without scrolling the page.
            const confirm = await page.locator('#sheet-edit-confirm').boundingBox();
            expect(confirm).not.toBeNull();
            expect(confirm!.x).toBeGreaterThanOrEqual(0);
            expect(confirm!.x + confirm!.width).toBeLessThanOrEqual(390);
            // The grid scrolls inside its own pane instead of shoving the
            // footer off the bottom.
            const body = await page.locator('#sheet-edit-body').boundingBox();
            expect(body).not.toBeNull();
            expect(body!.y + body!.height).toBeLessThanOrEqual(844);

            await page.click('#sheet-edit-cancel');
            await page.click('#cancel-upload');
            await expect(page.locator('#upload-modal')).toBeHidden({ timeout: 5000 });
        });
    });
});
