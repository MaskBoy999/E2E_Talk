import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

/**
 * The Icons settings tab, with the autosave model:
 *
 *  - replacing one icon with a picture opens a moveable 1:1 crop (like the
 *    sticker crop) instead of dropping the picture in as-is;
 *  - an animated GIF used as an icon keeps animating (the crop is a viewBox over
 *    the ORIGINAL bytes, never a canvas re-encode);
 *  - every change is PUT to the encrypted server slot on its own — there is no
 *    "Save & apply", and no draft is kept on the device (that device draft is
 *    what produced "this draft is too large to keep on this device"). The live
 *    sprite is the source of truth for "what is applied", so these tests read it
 *    instead of a localStorage draft.
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

/** The live sprite's override for `name`, or null when it is still built-in. */
function spriteEntry(page: Page, name: string) {
    return page.evaluate((iconName: string) => {
        const applied = (window as any).IconPacks.applied() as string[];
        if (applied.indexOf(iconName) === -1) return null;
        const sym = document.getElementById('icon-' + iconName);
        if (!sym) return null;
        return { inner: sym.innerHTML, viewBox: sym.getAttribute('viewBox') };
    }, name);
}

test.describe('icons: customizable DM button, 1:1 crop, animated GIFs', () => {
    test('the DM strip button is a sprite symbol the Icons tab can replace', async ({ page }) => {
        await page.addInitScript(TAURI_STUB);
        await registerAndOpenIcons(page);

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
        expect(await spriteEntry(page, 'dm')).toBeNull();

        // Doing it again and accepting stores a SQUARE viewBox over the picture.
        await replaceIconWith(page, 'dm', { name: 'wide.png', mimeType: 'image/png', buffer: makePng(64, 32) });
        await expect(page.getByText('Crop this icon to a square')).toBeVisible({ timeout: 10000 });
        await page.click('[data-icon-crop-apply]');

        const entry = await spriteEntry(page, 'dm');
        expect(entry, 'the accepted crop is applied to the live sprite').toBeTruthy();
        expect(entry!.inner).toContain('<image');
        expect(entry!.inner).toContain('width="64"');
        expect(entry!.inner).toContain('height="32"');
        const [x, y, w, h] = String(entry!.viewBox).trim().split(/\s+/).map(Number);
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

        const entry = await spriteEntry(page, 'dm');
        expect(entry, 'the accepted crop is applied').toBeTruthy();
        // The original GIF bytes survive: no canvas re-encode to a static PNG.
        expect(entry!.inner).toContain('data:image/gif;base64,');
        expect(entry!.inner).not.toContain('data:image/png');
        const [, , w, h] = String(entry!.viewBox).trim().split(/\s+/).map(Number);
        expect(w).toBe(h);

        const seen: string[] = [];
        for (let i = 0; i < 14; i++) {
            seen.push((await page.locator('#dm-strip-btn').screenshot()).toString('base64'));
            await page.waitForTimeout(150);
        }
        expect(new Set(seen).size, 'the GIF icon must still animate in the strip').toBeGreaterThan(1);
    });
});

/**
 * The slot half of the same feature, now under autosave: a change is on the
 * server without any Save click, and a slot the server refuses is reported while
 * you are still editing.
 */
test.describe('icons: an edit reaches the slot on its own', () => {
    test('a GIF applied to slot 1 is still there after switching slots and after a reload', async ({ page }) => {
        await page.addInitScript(TAURI_STUB);
        await registerAndOpenIcons(page);

        const gif = readFileSync(join(__dirname, 'fixtures', 'anim-2frame.gif'));
        await replaceIconWith(page, 'dm', { name: 'anim.gif', mimeType: 'image/gif', buffer: gif });
        await expect(page.getByText('Crop this icon to a square')).toBeVisible({ timeout: 10000 });
        await page.click('[data-icon-crop-apply]');

        // No Save button anywhere; the change saves itself.
        expect(await page.locator('#icon-settings-container button', { hasText: 'Save & apply' }).count()).toBe(0);
        await expect(page.locator('#icon-pack-status')).toContainText('Saved to slot 1', { timeout: 30000 });

        // The server really holds it.
        const stored = await page.evaluate(async () => {
            const r = await (window as any).authFetch('/api/user-icons/slots');
            const j = await r.json();
            return { slot1: j.slot1 && j.slot1.encrypted_icons ? j.slot1.encrypted_icons.length : 0, active: j.active_slot };
        });
        expect(stored.slot1, 'the server must hold the icon pack').toBeGreaterThan(100);
        expect(stored.active).toBe(1);

        // Switch to the empty slot: the picture icon is gone from the sprite…
        await page.getByText('Slot 2', { exact: true }).click();
        await expect(page.locator('#icon-pack-status')).toContainText('Slot 2:', { timeout: 20000 });
        await expect.poll(() => page.evaluate(() => (window as any).IconPacks.applied()), { timeout: 15000 })
            .not.toContain('dm');

        // …and switching BACK brings the same GIF back, from the server.
        await page.getByText('Slot 1', { exact: true }).click();
        await expect.poll(() => page.evaluate(() => (window as any).IconPacks.applied()), { timeout: 20000 })
            .toContain('dm');
        const inner = await page.evaluate(() => {
            const sym = document.getElementById('icon-dm') as any;
            return sym ? sym.innerHTML : '';
        });
        expect(inner, 'the slot must still be the animated GIF, not a re-encode').toContain('data:image/gif;base64,');

        // A reload reads it back from the server.
        await page.reload();
        await page.waitForSelector('#dm-strip-btn', { timeout: 60000 });
        await expect.poll(() => page.evaluate(() => (window as any).IconPacks && (window as any).IconPacks.applied()), { timeout: 40000 })
            .toContain('dm');
    });

    test('a slot the server refuses is reported and the edit is kept on screen', async ({ page }) => {
        await page.addInitScript(TAURI_STUB);
        // Stand in for the response the old code ignored: a 413 with the server's
        // own wording (server/src/handlers.rs, MAX_ICON_SLOT_B64).
        await page.route('**/api/user-icons/slot/*', (route) => route.fulfill({
            status: 413,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'icon pack too large (5112 KiB; the limit is 4096 KiB)' }),
        }));
        await registerAndOpenIcons(page);

        await replaceIconWith(page, 'dm', { name: 'icon.png', mimeType: 'image/png', buffer: makePng(32, 32) });
        await expect(page.getByText('Crop this icon to a square')).toBeVisible({ timeout: 10000 });
        await page.click('[data-icon-crop-apply]');

        const status = page.locator('#icon-pack-status');
        await expect(status).toContainText('Auto-save failed', { timeout: 20000 });
        await expect(status).toContainText('the limit is 4096 KiB');
        // Never claim success, and the edit stays applied so it can be fixed.
        await expect(status).not.toContainText('Saved to slot');
        expect(await spriteEntry(page, 'dm'), 'the edit must stay on screen after a refused save').toBeTruthy();
    });
});
