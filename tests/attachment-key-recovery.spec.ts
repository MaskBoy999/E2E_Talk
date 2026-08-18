import { test, expect, type Page } from '@playwright/test';

const BASE = 'https://localhost:3443';

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function makeWav(): Buffer {
    const sampleRate = 8000;
    const numSamples = Math.floor(0.4 * sampleRate);
    const buf = Buffer.alloc(44 + numSamples * 2);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + numSamples * 2, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(numSamples * 2, 40);
    for (let i = 0; i < numSamples; i++) {
        buf.writeInt16LE(Math.round(Math.sin(i / (sampleRate / 440)) * 8000), 44 + i * 2);
    }
    return buf;
}

async function registerUser(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(500);
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 20000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
    await page.waitForTimeout(2000);
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function becomeFriendsViaApi(page1: Page, page2: Page, token1: string, token2: string) {
    const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    expect(fc2).toBeTruthy();
    const fr = await page1.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        data: { friend_code: fc2 },
    });
    expect(fr.ok()).toBeTruthy();
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${token2}` },
    })).json();
    expect(Array.isArray(incoming)).toBe(true);
    expect(incoming.length).toBeGreaterThanOrEqual(1);
    const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    expect(acc.ok()).toBeTruthy();
}

async function openFirstDm(page: Page) {
    await page.click('#dm-strip-btn');
    await page.waitForSelector('.dm-item', { timeout: 10000 });
    await page.click('.dm-item');
    await page.waitForTimeout(800);
}

async function uploadFileViaUi(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
    await page.locator('#file-input').setInputFiles(file);
    await page.waitForSelector('#upload-modal', { state: 'visible', timeout: 8000 });
    await page.click('#confirm-upload');
    await expect(page.locator('#upload-modal')).not.toBeVisible({ timeout: 30000 });
    await expect(page.locator('#upload-error')).not.toBeVisible({ timeout: 3000 });
}

async function getFirstAttachmentFileId(page: Page) {
    return await page.evaluate(() => {
        const card = document.querySelector('.file-card, .audio-file-card');
        return card ? card.getAttribute('data-file-id') : null;
    });
}

// Simulate a mobile-browser media-cache eviction AND a payload that lost its
// file key: wipe every fkc_* entry and blank the DOM key attributes so the
// only way to decrypt is re-deriving from the message content.
async function wipeMediaCacheAndBlankDomKeys(page: Page, fileId: string) {
    await page.evaluate((fid) => {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('fkc_')) keys.push(k);
        }
        keys.forEach((k) => localStorage.removeItem(k));
        const card = document.querySelector('.file-card, .audio-file-card');
        if (card) card.setAttribute('data-file-key', '');
        const preview = document.querySelector('.file-preview');
        if (preview) preview.setAttribute('data-key', '');
        const audioCard = document.querySelector('.audio-file-card');
        if (audioCard && audioCard !== card) audioCard.setAttribute('data-file-key', '');
    }, fileId);
    expect(await page.evaluate((fid) => localStorage.getItem('fkc_' + fid), fileId)).toBeNull();
}

// Re-trigger the preview with a key-less fileData — recovery must re-derive the
// key from the message content (conversation key) and render the media again.
async function retriggerPreviewWithoutKey(page: Page, fileId: string): Promise<boolean> {
    return await page.evaluate(async (fid) => {
        const preview = document.querySelector('.file-preview');
        if (!preview) return false;
        const fileData = {
            file_id: fid,
            file_key: '',
            mime_type: preview.getAttribute('data-mime') || 'image/png',
            filename: preview.getAttribute('data-filename') || 'file',
            file_size: parseInt(preview.getAttribute('data-size') || '0', 10) || 0,
        };
        await (window as any).loadMediaPreview(preview, fileData);
        return true;
    }, fileId);
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('Attachment file-key self-heal (DM + channels)', () => {
    test.setTimeout(180000);

    test('DM image: key cached at render, re-derived from the DM conversation key after cache loss, download self-heals', async ({ browser }) => {
        const ts = Date.now().toString(36);
        const userA = 'akr_a_' + ts;
        const userB = 'akr_b_' + ts;

        const ctxA = await browser.newContext();
        const pageA = await ctxA.newPage();
        const aInfo = await registerUser(pageA, userA);

        const ctxB = await browser.newContext({ acceptDownloads: true });
        const pageB = await ctxB.newPage();
        const bInfo = await registerUser(pageB, userB);

        await becomeFriendsViaApi(pageA, pageB, aInfo.token, bInfo.token);

        // A sends an image into the DM via the real upload UI.
        await pageA.goto(`${BASE}/index.html`);
        await pageA.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await openFirstDm(pageA);
        await uploadFileViaUi(pageA, { name: 'dm-avatar.png', mimeType: 'image/png', buffer: makePng() });
        await pageA.waitForSelector('.file-card', { timeout: 15000 });
        const fileId = await getFirstAttachmentFileId(pageA);
        expect(fileId, 'upload must produce a file id').toBeTruthy();

        // B opens the DM and the preview decrypts + renders.
        await pageB.goto(`${BASE}/index.html`);
        await pageB.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await openFirstDm(pageB);
        const bImg = pageB.locator('.file-preview img');
        await expect(bImg).toBeVisible({ timeout: 25000 });
        const srcBefore = await bImg.getAttribute('src');
        expect(srcBefore || '').toContain('blob:');

        // Render-time caching: the attachment key landed in the fkc_* media cache.
        await expect.poll(async () => {
            return await pageB.evaluate((fid) => !!localStorage.getItem('fkc_' + fid), fileId!);
        }, { timeout: 10000 }).toBe(true);

        // Eviction + lost payload key: only re-derivation from the message
        // content (DM key) can decrypt the attachment now.
        await wipeMediaCacheAndBlankDomKeys(pageB, fileId!);
        expect(await retriggerPreviewWithoutKey(pageB, fileId!)).toBe(true);
        const bImg2 = pageB.locator('.file-preview img');
        await expect(bImg2).toBeVisible({ timeout: 20000 });
        const srcAfter = await bImg2.getAttribute('src');
        expect(srcAfter || '').toContain('blob:');
        expect(srcAfter).not.toBe(srcBefore); // fresh blob URL from the recovered download
        await expect.poll(async () => {
            return await pageB.evaluate((fid) => !!localStorage.getItem('fkc_' + fid), fileId!);
        }, { timeout: 10000 }).toBe(true);

        // Download path: with the card key blanked AND the cache wiped again,
        // clicking download must recover the key and produce a real file.
        await wipeMediaCacheAndBlankDomKeys(pageB, fileId!);
        const dlPromise = pageB.waitForEvent('download', { timeout: 20000 });
        await pageB.locator('.file-download-btn').first().click();
        const dl = await dlPromise;
        expect(dl.suggestedFilename()).toContain('dm-avatar');

        await ctxA.close();
        await ctxB.close();
    });

    test('server channel image: key re-derived from the server conversation key (all key versions)', async ({ browser }) => {
        const ts = Date.now().toString(36);
        const userA = 'akr_srv_' + ts;

        const ctxA = await browser.newContext();
        const pageA = await ctxA.newPage();
        await registerUser(pageA, userA);

        // Create a server via the real UI and open the first channel.
        await pageA.click('#add-server-btn');
        await pageA.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 8000 });
        await pageA.click('#choice-create-server');
        await pageA.waitForSelector('#create-server-modal', { state: 'visible', timeout: 8000 });
        await pageA.fill('#new-server-name', 'Recovery Server');
        await pageA.click('#confirm-create-server');
        await pageA.waitForSelector('#create-server-modal', { state: 'hidden', timeout: 15000 });
        await pageA.waitForTimeout(1200);
        await pageA.locator('.server-icon').filter({ hasText: 'R' }).click({ timeout: 8000 });
        await pageA.waitForTimeout(1000);
        await pageA.waitForSelector('.channel-item', { timeout: 8000 });
        await pageA.click('.channel-item >> nth=0');
        await pageA.waitForTimeout(800);

        // A uploads an image into the channel.
        await uploadFileViaUi(pageA, { name: 'channel-pic.png', mimeType: 'image/png', buffer: makePng(200, 40, 140) });
        await pageA.waitForSelector('.file-preview img', { timeout: 20000 });
        const fileId = await getFirstAttachmentFileId(pageA);
        expect(fileId, 'upload must produce a file id').toBeTruthy();

        // Render-time caching into fkc_* on the server path.
        await expect.poll(async () => {
            return await pageA.evaluate((fid) => !!localStorage.getItem('fkc_' + fid), fileId!);
        }, { timeout: 10000 }).toBe(true);

        // Direct recovery probe: the function returns the re-derived key.
        const recoveredKey = await pageA.evaluate(async (fid) => {
            const preview = document.querySelector('.file-preview');
            return await (window as any).recoverAttachmentFileKey(fid, preview);
        }, fileId!);
        expect(recoveredKey, 'recoverAttachmentFileKey re-derives the server-channel key').toBeTruthy();
        expect(recoveredKey).not.toContain(':');

        // Eviction + lost payload key → preview must still render (server key path).
        await wipeMediaCacheAndBlankDomKeys(pageA, fileId!);
        expect(await retriggerPreviewWithoutKey(pageA, fileId!)).toBe(true);
        const img = pageA.locator('.file-preview img');
        await expect(img).toBeVisible({ timeout: 20000 });
        expect((await img.getAttribute('src')) || '').toContain('blob:');
        await expect.poll(async () => {
            return await pageA.evaluate((fid) => !!localStorage.getItem('fkc_' + fid), fileId!);
        }, { timeout: 10000 }).toBe(true);

        await ctxA.close();
    });

    test('DM audio: non-image attachment re-derives its key and replays after cache loss', async ({ browser }) => {
        const ts = Date.now().toString(36);
        const userA = 'akr_au_a_' + ts;
        const userB = 'akr_au_b_' + ts;

        const ctxA = await browser.newContext();
        const pageA = await ctxA.newPage();
        const aInfo = await registerUser(pageA, userA);

        const ctxB = await browser.newContext();
        const pageB = await ctxB.newPage();
        const bInfo = await registerUser(pageB, userB);

        await becomeFriendsViaApi(pageA, pageB, aInfo.token, bInfo.token);

        // A sends a WAV into the DM.
        await pageA.goto(`${BASE}/index.html`);
        await pageA.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await openFirstDm(pageA);
        await uploadFileViaUi(pageA, { name: 'note.wav', mimeType: 'audio/wav', buffer: makeWav() });
        await pageA.waitForSelector('.audio-file-card', { timeout: 15000 });
        const fileId = await getFirstAttachmentFileId(pageA);
        expect(fileId).toBeTruthy();

        // B opens the DM; audio preview renders.
        await pageB.goto(`${BASE}/index.html`);
        await pageB.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await openFirstDm(pageB);
        const bAudio = pageB.locator('.file-preview audio');
        await expect(bAudio).toBeVisible({ timeout: 25000 });
        const srcBefore = await bAudio.getAttribute('src');
        expect(srcBefore || '').toContain('blob:');

        // Key cached at render.
        await expect.poll(async () => {
            return await pageB.evaluate((fid) => !!localStorage.getItem('fkc_' + fid), fileId!);
        }, { timeout: 10000 }).toBe(true);

        // Eviction + lost payload key → audio must still render after recovery.
        await wipeMediaCacheAndBlankDomKeys(pageB, fileId!);
        expect(await retriggerPreviewWithoutKey(pageB, fileId!)).toBe(true);
        const bAudio2 = pageB.locator('.file-preview audio');
        await expect(bAudio2).toBeVisible({ timeout: 20000 });
        const srcAfter = await bAudio2.getAttribute('src');
        expect(srcAfter || '').toContain('blob:');
        expect(srcAfter).not.toBe(srcBefore);
        await expect.poll(async () => {
            return await pageB.evaluate((fid) => !!localStorage.getItem('fkc_' + fid), fileId!);
        }, { timeout: 10000 }).toBe(true);

        await ctxA.close();
        await ctxB.close();
    });
});
