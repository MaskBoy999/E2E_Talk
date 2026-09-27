import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

/**
 * The Icons settings tab, three things the user asked for:
 *
 *  1. The Direct Messages button in the far-left strip is now a real sprite
 *     symbol (`#icon-dm`), not a hard-coded inline <svg>, so it appears in the
 *     Icons tab and can be replaced like every other icon.
 *  2. Replacing one icon with a picture opens a moveable 1:1 crop (like the
 *     sticker crop) instead of dropping the picture into the sprite as-is.
 *  3. An animated GIF used as an icon keeps animating: the crop is expressed as
 *     a viewBox over the ORIGINAL bytes, never rasterised through a canvas.
 */

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';

const TAURI_STUB = () => {
    (window as any).__TAURI__ = {
        core: { invoke: async () => null },
        event: { emit: async () => {} },
    };
};

/** A real PNG, so the app's own image pipeline is exercised (no fixture file). */
function makePng(w: number, h: number): Buffer {
    const chunk = (type: string, data: Buffer) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const typeBuf = Buffer.from(type, 'ascii');
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
        return Buffer.concat([len, typeBuf, data, crc]);
    };
    const stride = w * 4 + 1;
    const raw = Buffer.alloc(stride * h);
    for (let y = 0; y < h; y++) {
        raw[y * stride] = 0; // filter: none
        for (let x = 0; x < w; x++) {
            const o = y * stride + 1 + x * 4;
            raw[o] = Math.round((x * 255) / Math.max(1, w - 1));
            raw[o + 1] = Math.round((y * 255) / Math.max(1, h - 1));
            raw[o + 2] = 180;
            raw[o + 3] = 255;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;    // bit depth
    ihdr[9] = 6;    // RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

async function registerAndOpenIcons(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-confirm-password', { state: 'visible', timeout: 10000 });
    await page.fill('#register-username', `ico_${ts}`);
    await page.fill('#register-password', 'testpass123');
    await page.fill('#register-confirm-password', 'testpass123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.click('#settings-btn');
    await expect(page.locator('#settings-modal')).toBeVisible();
    await page.click('#icon-settings-tab');
    await expect(page.locator('#icon-settings-container .settings-tab, #icon-settings-container')).toBeTruthy();
    // The grid is rendered from the server response; wait for it.
    await expect(page.locator('#icon-settings-container [title*="click to upload"]').first()).toBeVisible({ timeout: 20000 });
}

/** Feed a file to the single-icon input (the second hidden input). */
async function replaceIconWith(page: Page, name: string, file: { name: string; mimeType: string; buffer: Buffer }) {
    await page.evaluate((iconName: string) => {
        const inputs = document.querySelectorAll('#icon-settings-container input[type="file"]');
        const single = inputs[1] as HTMLInputElement;
        single.setAttribute('data-icon-name', iconName);
    }, name);
    await page.locator('#icon-settings-container input[type="file"]').nth(1).setInputFiles(file);
}

function draftEntry(page: Page, name: string) {
    return page.evaluate((iconName: string) => {
        const raw = localStorage.getItem('iconDraft_1') || localStorage.getItem('iconDraft_2') || '{}';
        const map = JSON.parse(raw);
        return map[iconName] || null;
    }, name);
}

test.describe('icons: customizable DM button, 1:1 crop, animated GIFs', () => {
    test('the DM strip button is a sprite symbol the Icons tab can replace', async ({ page }) => {
        await page.addInitScript(TAURI_STUB);
        await registerAndOpenIcons(page);

        // It is drawn through the sprite, which is what makes it visible to the
        // Icons tab and replaceable by a pack.
        await expect(page.locator('#dm-strip-btn use[href="#icon-dm"]')).toHaveCount(1);
        const names = await page.evaluate(() => (window as any).IconPacks.iconNames());
        expect(names, 'the DM icon must be offered in the Icons tab').toContain('dm');
    });

    test('replacing an icon with a picture asks for a moveable 1:1 crop', async ({ page }) => {
        await page.addInitScript(TAURI_STUB);
        await registerAndOpenIcons(page);

        // Deliberately non-square, so a crop has to happen.
        await replaceIconWith(page, 'dm', { name: 'wide.png', mimeType: 'image/png', buffer: makePng(64, 32) });

        // The crop step appears, with a square that can be MOVED.
        await expect(page.getByText('Crop this icon to a square')).toBeVisible({ timeout: 10000 });
        const box = page.locator('[data-icon-crop-box]');
        await expect(box, 'the crop has a draggable square').toBeVisible();
        const w0 = await box.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
        const h0 = await box.evaluate((el) => (el as HTMLElement).getBoundingClientRect().height);
        expect(Math.abs(w0 - h0), 'the crop square stays 1:1').toBeLessThan(2);
        const left0 = await box.evaluate((el) => parseFloat((el as HTMLElement).style.left));

        const bb = (await box.boundingBox())!;
        await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
        await page.mouse.down();
        await page.mouse.move(bb.x + bb.width / 2 - 18, bb.y + bb.height / 2);
        await page.mouse.up();
        const left1 = await box.evaluate((el) => parseFloat((el as HTMLElement).style.left));
        expect(left1, 'dragging the square must move the crop').toBeLessThan(left0);

        // …and cancelling changes nothing.
        await page.click('[data-icon-crop-cancel]');
        expect(await draftEntry(page, 'dm')).toBeNull();

        // Doing it again and accepting stores a SQUARE viewBox over the picture.
        await replaceIconWith(page, 'dm', { name: 'wide.png', mimeType: 'image/png', buffer: makePng(64, 32) });
        await expect(page.getByText('Crop this icon to a square')).toBeVisible({ timeout: 10000 });
        await page.click('[data-icon-crop-apply]');

        const entry = await draftEntry(page, 'dm');
        expect(entry, 'the accepted crop is stored in the draft').toBeTruthy();
        expect(entry.inner).toContain('<image');
        expect(entry.inner).toContain('width="64"');
        expect(entry.inner).toContain('height="32"');
        const [x, y, w, h] = String(entry.viewBox).trim().split(/\s+/).map(Number);
        expect(w, 'the icon viewBox must be square').toBe(h);
        expect(w).toBeLessThanOrEqual(32);           // never wider than the picture allows
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
    });

    test('an animated GIF stays animated as an icon', async ({ page }) => {
        await page.addInitScript(TAURI_STUB);
        await registerAndOpenIcons(page);

        const gif = readFileSync(join(__dirname, 'fixtures', 'anim-2frame.gif'));
        await replaceIconWith(page, 'dm', { name: 'anim.gif', mimeType: 'image/gif', buffer: gif });
        await expect(page.getByText('Crop this icon to a square')).toBeVisible({ timeout: 10000 });
        await page.click('[data-icon-crop-apply]');

        const entry = await draftEntry(page, 'dm');
        expect(entry, 'the accepted crop is stored').toBeTruthy();
        // The original GIF bytes survive: no canvas re-encode to a static PNG.
        expect(entry.inner).toContain('data:image/gif;base64,');
        expect(entry.inner).not.toContain('data:image/png');
        const [, , w, h] = String(entry.viewBox).trim().split(/\s+/).map(Number);
        expect(w).toBe(h);

        // Apply the draft to the live sprite and watch the actual DM button.
        await page.evaluate(() => {
            const raw = localStorage.getItem('iconDraft_1') || localStorage.getItem('iconDraft_2') || '{}';
            (window as any).IconPacks.applyMap(JSON.parse(raw));
        });
        expect(await page.evaluate(() => (window as any).IconPacks.applied())).toContain('dm');

        const seen: string[] = [];
        for (let i = 0; i < 14; i++) {
            seen.push((await page.locator('#dm-strip-btn').screenshot()).toString('base64'));
            await page.waitForTimeout(150);
        }
        expect(new Set(seen).size, 'the GIF icon must still animate in the strip').toBeGreaterThan(1);
    });
});
