import { test, expect, type Page } from '@playwright/test';
import { gzipSync } from 'zlib';

// Archive and legacy-Office document views.
//
// What this pins: every archive type the app *claims* to preview really lists
// (zip, tar, gz, tgz, tar.gz — the tar/gz ones through the app's own parser, not
// JSZip, which only reads zip); a legacy `.doc` that is really RTF shows its
// text; a genuine OLE2 `.doc`/`.ppt` gets an honest card instead of the old
// "Failed to render document"; and `.rar`/`.7z`, which no shipped reader can
// read, are no longer claimed as previewable at all.

const BASE = 'https://localhost:3443';

async function registerAndSetup(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const username = `docarch_${ts}`;
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

// ── A real tar, built to the spec (512-byte header, octal size at 124, the
// checksum at 148 computed over the header with that field read as spaces) ──
function tarHeader(name: string, size: number): Buffer {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8);
    header.write('0000000\0', 108, 8);
    header.write('0000000\0', 116, 8);
    header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
    header.write('00000000000\0', 136, 12);
    header.write('        ', 148, 8); // checksum field, spaces for the sum
    header.write('0', 156, 1); // typeflag: a regular file
    header.write('ustar\0', 257, 6);
    header.write('00', 263, 2);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    return header;
}

function makeTar(files: { name: string; data: Buffer }[]): Buffer {
    const parts: Buffer[] = [];
    for (const f of files) {
        parts.push(tarHeader(f.name, f.data.length));
        parts.push(f.data);
        const pad = (512 - (f.data.length % 512)) % 512;
        if (pad) parts.push(Buffer.alloc(pad));
    }
    parts.push(Buffer.alloc(1024)); // two zero blocks end an archive
    return Buffer.concat(parts);
}

// Hand the bytes to the app the way an attachment would: as a Blob inside the
// page, then open the preview.
async function previewBytes(page: Page, b64: string, filename: string, mime: string) {
    return await page.evaluate(async ({ b64, filename, mime }) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const DP = (window as any).DocPreview;
        await DP.previewDocument(new Blob([bytes], { type: mime }), filename, mime);
        await new Promise(r => setTimeout(r, 1200));
        const overlay = document.getElementById('doc-preview-overlay');
        const content = overlay ? overlay.querySelector('#doc-preview-content') : null;
        return {
            hasOverlay: !!overlay,
            text: content ? (content.textContent || '') : '',
            rows: content ? content.querySelectorAll('div[style*="border-bottom"]').length : 0,
            stillLoading: content ? (content.textContent || '').includes('Loading document…') : false,
        };
    }, { b64, filename, mime });
}

test.describe('Archive + legacy Office views', () => {
    test('a .tar lists its entries', async ({ page }) => {
        await registerAndSetup(page);
        const tar = makeTar([
            { name: 'readme.txt', data: Buffer.from('hello from a tar') },
            { name: 'notes/data.csv', data: Buffer.from('a,b\n1,2') },
        ]);
        const out = await previewBytes(page, tar.toString('base64'), 'bundle.tar', 'application/x-tar');
        expect(out.hasOverlay).toBe(true);
        expect(out.text).toContain('readme.txt');
        expect(out.text).toContain('notes/data.csv');
        expect(out.text).toContain('2 files');
        expect(out.text).not.toContain('Failed to render document');
        expect(out.stillLoading).toBe(false);
        await page.evaluate(() => (window as any).DocPreview.close());
    });

    test('a .tar.gz lists the entries inside the compressed tar', async ({ page }) => {
        await registerAndSetup(page);
        const tar = makeTar([
            { name: 'a.txt', data: Buffer.from('first') },
            { name: 'b.txt', data: Buffer.from('second') },
        ]);
        const gz = gzipSync(tar);
        const out = await previewBytes(page, gz.toString('base64'), 'bundle.tar.gz', 'application/gzip');
        expect(out.hasOverlay).toBe(true);
        expect(out.text).toContain('a.txt');
        expect(out.text).toContain('b.txt');
        expect(out.text).not.toContain('Failed to render document');
        await page.evaluate(() => (window as any).DocPreview.close());
    });

    test('a plain .gz of one file lists that file, and .tgz works too', async ({ page }) => {
        await registerAndSetup(page);
        const gz = gzipSync(Buffer.from('just one plain text file'));
        const plain = await previewBytes(page, gz.toString('base64'), 'notes.txt.gz', 'application/gzip');
        expect(plain.text).toContain('notes.txt');
        await page.evaluate(() => (window as any).DocPreview.close());

        const tgz = gzipSync(makeTar([{ name: 'inner.txt', data: Buffer.from('in tgz') }]));
        const out = await previewBytes(page, tgz.toString('base64'), 'inner.tgz', 'application/gzip');
        expect(out.text).toContain('inner.txt');
        await page.evaluate(() => (window as any).DocPreview.close());
    });

    test('a .doc that is really RTF shows its text', async ({ page }) => {
        await registerAndSetup(page);
        const rtf = Buffer.from(
            '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0\\fs24 Hello from RTF.\\par Second paragraph.}',
            'latin1'
        );
        const out = await previewBytes(page, rtf.toString('base64'), 'letter.doc', 'application/msword');
        expect(out.hasOverlay).toBe(true);
        expect(out.text).toContain('Hello from RTF.');
        expect(out.text).toContain('Second paragraph.');
        // The font table must have been skipped, not printed.
        expect(out.text).not.toContain('fonttbl');
        expect(out.text).not.toContain('Failed to render document');
        await page.evaluate(() => (window as any).DocPreview.close());
    });

    test('a real OLE2 .doc/.ppt gets an honest card, not an error', async ({ page }) => {
        await registerAndSetup(page);
        // The OLE2 signature followed by filler: a genuine Word 97-2003 header.
        const ole2 = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(2048, 7)]);
        for (const [name, mime] of [['old.doc', 'application/msword'], ['old.ppt', 'application/vnd.ms-powerpoint']] as const) {
            const out = await previewBytes(page, ole2.toString('base64'), name, mime);
            expect(out.hasOverlay).toBe(true);
            expect(out.text).toMatch(/97–2003/);
            expect(out.text).not.toContain('Failed to render document');
            expect(out.text).not.toContain('Error rendering document');
            await page.evaluate(() => (window as any).DocPreview.close());
        }
    });

    test('.rar and .7z are no longer claimed as previewable', async ({ page }) => {
        await registerAndSetup(page);
        const claimed = await page.evaluate(() => {
            const DP = (window as any).DocPreview;
            return {
                rarDoc: DP.isDocumentFile('archive.rar', 'application/vnd.rar'),
                rarType: DP.getDocType('archive.rar', 'application/vnd.rar'),
                sevenDoc: DP.isDocumentFile('archive.7z', 'application/x-7z-compressed'),
                sevenType: DP.getDocType('archive.7z', 'application/x-7z-compressed'),
                // The ones that DO work must stay claimed.
                tarType: DP.getDocType('bundle.tar', 'application/x-tar'),
                tgzType: DP.getDocType('bundle.tgz', 'application/gzip'),
                gzType: DP.getDocType('notes.txt.gz', 'application/gzip'),
                zipType: DP.getDocType('bundle.zip', 'application/zip'),
            };
        });
        expect(claimed.rarDoc).toBe(false);
        expect(claimed.rarType).toBeNull();
        expect(claimed.sevenDoc).toBe(false);
        expect(claimed.sevenType).toBeNull();
        expect(claimed.tarType).toBe('zip');
        expect(claimed.tgzType).toBe('zip');
        expect(claimed.gzType).toBe('zip');
        expect(claimed.zipType).toBe('zip');
    });
});
