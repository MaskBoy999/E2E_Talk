import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Custom animated wallpaper (Settings → Display → App Background).
 *
 * The still wallpaper has always been a JPEG data URL in localStorage, and that
 * is the one place an animation cannot live: the origin gets ~5 MB there, the
 * bytes would be base64 (+37%) on top of that, and the still path rasterises
 * through a canvas — which flattens an animation to its first frame. So the
 * bytes go to IndexedDB as a Blob and only the kind ('gif' | 'video') is part of
 * the settings.
 *
 * What these tests pin, in the user's words ("all its settings and live
 * preview"):
 *
 *  1. choosing an animation paints it behind the app immediately, and it is
 *     still animating (two screenshots of the same element must differ);
 *  2. every existing background setting applies to it — position here, and the
 *     per-section blur/dim sliders ride the same layer and the same body class
 *     as the still picture (asserted through the CSS variables the sections use);
 *  3. it survives a reload (the blob is read back out of IndexedDB), and Remove
 *     takes the bytes with it.
 */

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';

const TAURI_STUB = () => {
    (window as any).__TAURI__ = {
        core: { invoke: async () => null },
        event: { emit: async () => {} },
    };
};

async function registerAndOpenDisplay(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-confirm-password', { state: 'visible', timeout: 10000 });
    await page.fill('#register-username', `wall_${ts}`);
    await page.fill('#register-password', 'testpass123');
    await page.fill('#register-confirm-password', 'testpass123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.click('#settings-btn');
    await expect(page.locator('#settings-modal')).toBeVisible();
    await page.click('.settings-tab[data-tab="display-settings"]');
    await expect(page.locator('#app-bg-anim-upload-btn')).toBeVisible();
}

/** Feed the animation input the animated GIF fixture. */
async function chooseAnimation(page: Page) {
    const gif = readFileSync(join(__dirname, 'fixtures', 'anim-2frame.gif'));
    await page.locator('#app-bg-anim-file').setInputFiles({ name: 'wall.gif', mimeType: 'image/gif', buffer: gif });
    await expect(page.locator('#app-bg-anim-status')).toContainText('Using wall.gif', { timeout: 20000 });
}

test.describe('custom animated wallpaper', () => {
    test('shows up behind the app, keeps animating, and follows the background settings', async ({ page }) => {
        await page.addInitScript(TAURI_STUB);
        await registerAndOpenDisplay(page);
        await chooseAnimation(page);

        // 1. It is on screen, from the stored blob, inside the background layer.
        const img = page.locator('#app-bg-anim-img');
        await expect(img).toBeVisible({ timeout: 10000 });
        const src = await img.getAttribute('src');
        expect(src, 'the wallpaper must render from the stored file').toMatch(/^blob:/);
        await expect(page.locator('body')).toHaveClass(/app-bg-on/);

        // 2. It really animates: two frames of the same element differ.
        const frames: string[] = [];
        for (let i = 0; i < 12; i++) {
            frames.push((await img.screenshot()).toString('base64'));
            await page.waitForTimeout(120);
        }
        expect(new Set(frames).size, 'the wallpaper must still be animating').toBeGreaterThan(1);

        // 3. The settings apply to it exactly as they do to a still picture:
        //    position becomes object-position on the animated element…
        await page.selectOption('#app-bg-pos', 'left top');
        await expect.poll(() => img.evaluate((el) => (el as HTMLElement).style.objectPosition), { timeout: 10000 })
            .toBe('left top');
        // …and the per-section blur/dim sliders still drive the CSS variables the
        // sections read, which is what "all its settings" means.
        await page.evaluate(() => {
            const dim = document.querySelector('#app-bg-sections .app-bg-dim') as HTMLInputElement;
            dim.value = '90';
            dim.dispatchEvent(new Event('change', { bubbles: true }));
        });
        const dimVar = await page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--bg-dim-strip').trim());
        expect(dimVar, 'section dimming must apply over an animated wallpaper').toBe('90%');

        // 4. The settings survive a reload — the bytes come back out of IndexedDB.
        await page.reload();
        await page.waitForSelector('#app-bg', { timeout: 60000 });
        await expect(page.locator('#app-bg-anim-img')).toBeVisible({ timeout: 30000 });
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem('app_bg') || '{}').anim)).toBe('gif');

        // 5. Remove takes it — and its bytes — away.
        await page.click('#settings-btn');
        await page.click('.settings-tab[data-tab="display-settings"]');
        await page.click('#app-bg-remove-btn');
        await expect(page.locator('#app-bg-anim-img')).toBeHidden({ timeout: 10000 });
        await expect(page.locator('body')).not.toHaveClass(/app-bg-on/);
        const leftover = await page.evaluate(() => new Promise<boolean>((resolve) => {
            const req = indexedDB.open('e2e_app_bg', 1);
            req.onsuccess = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('files')) { resolve(false); return; }
                const get = db.transaction('files', 'readonly').objectStore('files').get('wallpaper');
                get.onsuccess = () => resolve(!!get.result);
                get.onerror = () => resolve(false);
            };
            req.onerror = () => resolve(false);
        }));
        expect(leftover, 'Remove must delete the stored animation').toBe(false);
    });

    test('the speed control re-times the animation live, at any rate', async ({ page }) => {
        await page.addInitScript(TAURI_STUB);
        await registerAndOpenDisplay(page);

        // Nothing animated yet, so there is no rate to set.
        await expect(page.locator('#app-bg-anim-speed-row')).toBeHidden();

        await chooseAnimation(page);
        await expect(page.locator('#app-bg-anim-speed-row')).toBeVisible();
        await expect(page.locator('#app-bg-speed')).toHaveValue('1');

        // 1× is the file's own rate: the <img> animates natively and no decoder
        // is running. The note explains why this is ONE setting: every section
        // shows the same animation, so per-section speeds would be seven
        // controls writing one number.
        await expect(page.locator('#app-bg-anim-img')).toBeVisible();
        await expect(page.locator('#app-bg-anim-canvas')).toBeHidden();
        await expect(page.locator('#app-bg-speed-hint'))
            .toContainText('one setting rather than one per section');

        const setSpeed = async (v: string) => {
            await page.evaluate((value: string) => {
                const s = document.getElementById('app-bg-speed') as HTMLInputElement;
                s.value = value;
                s.dispatchEvent(new Event('input', { bubbles: true }));
            }, v);
        };
        /** Counts the frames the canvas actually paints over a fixed window. */
        const framesDrawn = async (ms: number) => page.evaluate(async (howLong: number) => {
            const c = document.getElementById('app-bg-anim-canvas') as HTMLCanvasElement | null;
            if (!c || getComputedStyle(c).display === 'none') return -1;
            let last = c.toDataURL();
            let n = 0;
            const end = Date.now() + howLong;
            while (Date.now() < end) {
                await new Promise((r) => setTimeout(r, 40));
                const now = c.toDataURL();
                if (now !== last) { n++; last = now; }
            }
            return n;
        }, ms);

        // A quarter speed: the file's 300 ms frames become 1.2 s each.
        await setSpeed('0.25');
        await expect(page.locator('#app-bg-speed-val')).toHaveText('0.25×');
        await expect(page.locator('#app-bg-anim-canvas')).toBeVisible();
        await expect(page.locator('#app-bg-anim-img')).toBeHidden();
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem('app_bg') || '{}').speed)).toBe(0.25);
        const slow = await framesDrawn(1600);

        // …and the same frames at 3× are 100 ms apart.
        await setSpeed('3');
        await expect(page.locator('#app-bg-speed-val')).toHaveText('3×');
        const fast = await framesDrawn(1600);
        expect(slow, 'the re-timed wallpaper must actually be animating').toBeGreaterThan(-1);
        expect(slow, 'a quarter speed must paint far fewer frames than 3×').toBeLessThan(fast);

        // Back at the file's own rate the canvas goes away and the <img> returns.
        await setSpeed('1');
        await expect(page.locator('#app-bg-anim-canvas')).toBeHidden();
        await expect(page.locator('#app-bg-anim-img')).toBeVisible();

        // The rate survives a reload, and the wallpaper comes back re-timed.
        await setSpeed('0.5');
        await page.reload();
        await page.waitForSelector('#app-bg', { timeout: 60000 });
        await expect(page.locator('#app-bg-anim-canvas')).toBeVisible({ timeout: 30000 });
        await page.click('#settings-btn');
        await page.click('.settings-tab[data-tab="display-settings"]');
        await expect(page.locator('#app-bg-speed')).toHaveValue('0.5');
        await expect(page.locator('#app-bg-speed-val')).toHaveText('0.5×');
    });

    test('refuses a file that is not an animation, and says why', async ({ page }) => {
        await page.addInitScript(TAURI_STUB);
        await registerAndOpenDisplay(page);
        await page.locator('#app-bg-anim-file').setInputFiles({
            name: 'photo.jpg',
            mimeType: 'image/jpeg',
            buffer: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0x02, 0x03]),
        });
        await expect(page.locator('#app-bg-anim-status'))
            .toContainText('Use a GIF, an animated WebP or APNG, or an MP4/WebM video', { timeout: 10000 });
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem('app_bg') || '{}').anim || '')).toBe('');
    });
});
