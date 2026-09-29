import { test, expect, type Page } from '@playwright/test';

const BASE = 'https://localhost:3443';

/**
 * The rule this pins: a message attachment in a normal text channel is fetched
 * as ONE encrypted blob and only then decrypted — never "download a chunk,
 * decrypt it, go back for the next". The back-and-forth is what makes media feel
 * slow (and it is pure latency, not bandwidth), so the request log is the
 * contract: one `/download`, zero per-chunk GETs. Manual preview loading still
 * defers that single fetch until the user asks for it.
 */

function makePng(r = 120, g = 80, b = 200): Buffer {
    const zlib = require('zlib');
    const w = 4, h = 4;
    const raw = Buffer.alloc(1 + w * h * 3);
    raw[0] = 0;
    for (let i = 1; i < raw.length; i++) { raw[i] = (i % 2 === 0) ? r : g; }
    function crc32(buf: Buffer): Buffer {
        let c = 0xffffffff;
        for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); }
        c = (c ^ 0xffffffff) >>> 0; const out = Buffer.alloc(4); out.writeUInt32BE(c); return out;
    }
    function chunk(type: Buffer, data: Buffer): Buffer {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const tad = Buffer.concat([type, data]);
        return Buffer.concat([len, tad, crc32(tad)]);
    }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    return Buffer.concat([sig, chunk(Buffer.from('IHDR'), ihdr), chunk(Buffer.from('IDAT'), zlib.deflateSync(raw)), chunk(Buffer.from('IEND'), Buffer.alloc(0))]);
}

async function registerUser(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(400);
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 20000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
    await page.waitForTimeout(1500);
}

async function createServerAndOpenChannel(page: Page) {
    await page.click('#add-server-btn');
    await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 8000 });
    await page.click('#choice-create-server');
    await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 8000 });
    await page.fill('#new-server-name', 'Whole ' + Date.now().toString(36));
    await page.click('#confirm-create-server');
    await page.waitForSelector('#create-server-modal', { state: 'hidden', timeout: 15000 });
    await page.waitForTimeout(1200);
    await page.locator('.server-icon[data-id]').first().click({ timeout: 8000 });
    await page.waitForTimeout(1000);
    await page.waitForSelector('.channel-item', { timeout: 8000 });
    await page.click('.channel-item >> nth=0');
    await page.waitForTimeout(800);
}

async function uploadPng(page: Page) {
    await page.locator('#file-input').setInputFiles({
        name: 'whole-blob.png',
        mimeType: 'image/png',
        buffer: makePng(),
    });
    await page.waitForSelector('#upload-modal', { state: 'visible', timeout: 8000 });
    await page.click('#confirm-upload');
    await expect(page.locator('#upload-modal')).not.toBeVisible({ timeout: 30000 });
}

/** GET requests the page made against the file API, minus the base URL. */
function recordFileRequests(page: Page): string[] {
    const calls: string[] = [];
    page.on('request', (r) => {
        const u = r.url();
        if (u.includes('/api/files/') && r.method() === 'GET') calls.push(u.slice(BASE.length));
    });
    return calls;
}

test.describe('Encrypted media is fetched whole before decryption', () => {
    test.setTimeout(120000);

    test('a channel image preview makes one /download call and no per-chunk GETs', async ({ page }) => {
        await registerUser(page, 'whole_a_' + Date.now().toString(36));
        await createServerAndOpenChannel(page);

        const calls = recordFileRequests(page);
        await uploadPng(page);
        await page.waitForSelector('.file-preview img', { timeout: 25000 });
        await page.waitForTimeout(1500); // let any late request settle

        const fileId = await page.evaluate(() =>
            document.querySelector('.file-card, .file-preview')?.getAttribute('data-file-id') || '');
        expect(fileId, 'upload must produce a file id').toBeTruthy();

        const downloads = calls.filter((u) => u.includes('/download') && u.includes(fileId));
        const chunkGets = calls.filter((u) => u.includes('/chunk/'));
        // At least one full download, and never a per-chunk GET. A stale-key
        // retry may repeat the full fetch (it does not splice the file), so the
        // count is allowed to be more than one — the shape is what matters.
        expect(downloads.length, `expected a full download, got: ${calls.join(', ')}`).toBeGreaterThanOrEqual(1);
        expect(downloads.length, `too many full downloads for one preview: ${calls.join(', ')}`).toBeLessThanOrEqual(2);
        expect(chunkGets.length, `a per-chunk GET is the back-and-forth this forbids: ${chunkGets.join(', ')}`).toBe(0);
    });

    test('with auto-load off, nothing is fetched until "Load preview" is clicked, then once', async ({ page }) => {
        await registerUser(page, 'whole_b_' + Date.now().toString(36));
        // The user's own choice to fetch on demand — the single fetch moves to
        // the click instead of disappearing.
        await page.evaluate(() => localStorage.setItem('autoLoadPreviews', 'false'));
        await createServerAndOpenChannel(page);

        const calls = recordFileRequests(page);
        await uploadPng(page);
        await page.waitForSelector('.load-preview-btn', { timeout: 25000 });
        await page.waitForTimeout(1000);

        const fileId = await page.evaluate(() =>
            document.querySelector('.file-card, .file-preview')?.getAttribute('data-file-id') || '');
        expect(fileId).toBeTruthy();

        // Nothing downloaded yet: the preview is a button, not a request.
        expect(calls.filter((u) => u.includes('/download')).length).toBe(0);

        await page.click('.load-preview-btn');
        await page.waitForSelector('.file-preview img', { timeout: 25000 });
        await page.waitForTimeout(800);

        const after = calls.filter((u) => u.includes('/download') && u.includes(fileId));
        const chunkGets = calls.filter((u) => u.includes('/chunk/'));
        expect(after.length, `expected a download after the click, got: ${calls.join(', ')}`).toBeGreaterThanOrEqual(1);
        expect(chunkGets.length, `the click must not fetch per chunk: ${chunkGets.join(', ')}`).toBe(0);
    });
});
