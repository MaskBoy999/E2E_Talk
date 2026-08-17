import { test, expect, type Page } from '@playwright/test';

const BASE = 'https://localhost:3443';

async function registerAndSetup(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const username = `bg_${ts}`;
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'TestPass123!');
    await page.fill('#register-confirm-password', 'TestPass123!');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 20000 });

    await page.click('#add-server-btn');
    await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
    await page.click('#choice-create-server');
    await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 5000 });
    await page.fill('#new-server-name', 'BG Test Server');
    await page.click('#confirm-create-server');
    await page.waitForSelector('#create-server-modal', { state: 'hidden', timeout: 10000 });
    await page.waitForTimeout(1000);

    const serverIcon = page.locator('.server-icon').filter({ hasText: 'B' });
    await serverIcon.click({ timeout: 5000 });
    await page.waitForTimeout(1000);
    await page.waitForSelector('.channel-item', { timeout: 5000 });
    await page.click('.channel-item >> nth=0');
    await page.waitForTimeout(500);
}

async function openDisplaySettings(page: Page) {
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
    await page.click('[data-tab="display-settings"]');
    await page.waitForSelector('#app-bg-upload-btn', { state: 'visible', timeout: 5000 });
}

async function uploadBackground(page: Page) {
    const pngData = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        const ctx = canvas.getContext('2d')!;
        const grad = ctx.createLinearGradient(0, 0, 320, 180);
        grad.addColorStop(0, '#ff0000');
        grad.addColorStop(1, '#0000ff');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 320, 180);
        return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.locator('#app-bg-file').setInputFiles({
        name: 'bg-photo.png',
        mimeType: 'image/png',
        buffer: Buffer.from(pngData, 'base64'),
    });
}

test.describe('App Background (device-local photo layer)', () => {
    test('upload, per-section tune, position/zoom, persistence, remove', async ({ page }) => {
        await registerAndSetup(page);
        await openDisplaySettings(page);

        // Feature is off by default: no body class, controls hidden.
        await expect(page.locator('body')).not.toHaveClass(/app-bg-on/);
        await expect(page.locator('#app-bg-controls')).toBeHidden();
        await expect(page.locator('#app-bg-remove-btn')).toBeHidden();

        // Upload an image → layer turns on with a compressed JPEG data URL.
        await uploadBackground(page);
        await expect(page.locator('body')).toHaveClass(/app-bg-on/, { timeout: 10000 });
        await expect(page.locator('#app-bg-controls')).toBeVisible();
        await expect(page.locator('#app-bg-remove-btn')).toBeVisible();
        const bgImage = await page.locator('#app-bg').evaluate((el) => (el as HTMLElement).style.backgroundImage);
        expect(bgImage).toContain('data:image/jpeg');
        expect(bgImage.length).toBeGreaterThan(500);
        // Stored copy is device-local only.
        const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('app_bg') || 'null'));
        expect(stored).not.toBeNull();
        expect(stored.img.startsWith('data:image/jpeg')).toBe(true);

        // Default per-section dims/blurs applied to :root custom properties.
        const rootProps = () => page.evaluate(() => {
            const cs = getComputedStyle(document.documentElement);
            const out: Record<string, string> = {};
            ['strip', 'sidebar', 'header', 'chat', 'members', 'input', 'footer'].forEach((k) => {
                out['dim-' + k] = cs.getPropertyValue('--bg-dim-' + k).trim();
                out['blur-' + k] = cs.getPropertyValue('--bg-blur-' + k).trim();
            });
            return out;
        });
        let props = await rootProps();
        expect(props['dim-strip']).toBe('55%');
        expect(props['blur-strip']).toBe('6px');
        expect(props['dim-chat']).toBe('65%');
        expect(props['blur-chat']).toBe('4px');

        // Per-section tune: sidebar blur 14 / dim 30.
        await page.locator('.app-bg-blur[data-section="sidebar"]').evaluate((el) => {
            (el as HTMLInputElement).value = '14';
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.locator('.app-bg-dim[data-section="sidebar"]').evaluate((el) => {
            (el as HTMLInputElement).value = '30';
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        props = await rootProps();
        expect(props['blur-sidebar']).toBe('14px');
        expect(props['dim-sidebar']).toBe('30%');

        // Turning a section off makes it fully solid (100% dim).
        await page.locator('.app-bg-on[data-section="strip"]').uncheck();
        props = await rootProps();
        expect(props['dim-strip']).toBe('100%');
        expect(props['blur-strip']).toBe('0px');

        // Position + zoom.
        await page.selectOption('#app-bg-pos', 'left top');
        await page.locator('#app-bg-zoom').evaluate((el) => {
            (el as HTMLInputElement).value = '200';
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const bgEl = page.locator('#app-bg');
        expect(await bgEl.evaluate((el) => (el as HTMLElement).style.backgroundPosition)).toBe('left top');
        expect(await bgEl.evaluate((el) => (el as HTMLElement).style.transform)).toBe('scale(2)');
        expect(await bgEl.evaluate((el) => (el as HTMLElement).style.transformOrigin)).toBe('0% 0%');

        // Persistence across reload (device-local).
        await page.reload();
        await page.waitForSelector('#settings-btn', { timeout: 15000 });
        await expect(page.locator('body')).toHaveClass(/app-bg-on/);
        const bgImage2 = await page.locator('#app-bg').evaluate((el) => (el as HTMLElement).style.backgroundImage);
        expect(bgImage2).toContain('data:image/jpeg');
        const props2 = await rootProps();
        expect(props2['blur-sidebar']).toBe('14px');
        expect(props2['dim-sidebar']).toBe('30%');
        expect(props2['dim-strip']).toBe('100%');
        expect(await page.locator('#app-bg').evaluate((el) => (el as HTMLElement).style.backgroundPosition)).toBe('left top');

        // Remove resets to default (feature off).
        await openDisplaySettings(page);
        await page.click('#app-bg-remove-btn');
        await expect(page.locator('body')).not.toHaveClass(/app-bg-on/);
        await expect(page.locator('#app-bg-controls')).toBeHidden();
        const storedAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('app_bg') || 'null'));
        expect(storedAfter.img).toBe('');
    });

    // Extract the alpha channel from whatever the computed background-color
    // serializes to (color-mix reports oklab/color() in Chromium):
    //   oklab(0.21 -0.01 -0.02)            → 1 (opaque)
    //   color(srgb 0.04 0.1 0.13 / 0.55)   → 0.55
    //   rgba(26, 26, 46, 0.55)             → 0.55
    function alphaOf(bgColor: string): number {
        // color(srgb ... / 0.55) or oklab(... / 0.55) carry the alpha after '/'
        // (check this FIRST so 'srgb(' isn't mistaken for 'rgb(').
        const m = bgColor.match(/\/\s*([\d.]+)\)/);
        if (m) return parseFloat(m[1]);
        const m2 = bgColor.match(/(?:^|[^a-z])rgba?\(([^)]+)\)/);
        if (m2) {
            const parts = m2[1].split(',').map((p) => parseFloat(p.trim()));
            return parts.length >= 4 ? parts[3] : 1;
        }
        return 1;
    }

    test('sections render translucently over the image (no solid blockers)', async ({ page }) => {
        await registerAndSetup(page);
        await openDisplaySettings(page);
        await uploadBackground(page);
        await expect(page.locator('body')).toHaveClass(/app-bg-on/, { timeout: 10000 });

        // Each major surface must settle to a translucent theme color (not fully
        // solid) so the fixed photo underneath shows through. Poll because the
        // theme's 150ms smooth-background transition starts from the opaque value.
        const surfaces = ['.server-strip', '.sidebar', '.main', '.chat-header', '.chat-input'];
        for (const sel of surfaces) {
            // alphaOf is implemented inline here because evaluate() runs in the page.
            const readAlpha = () =>
                page.locator(sel).first().evaluate((el) => {
                    const bg = getComputedStyle(el).backgroundColor;
                    const m = bg.match(/\/\s*([\d.]+)\)/);
                    if (m) return parseFloat(m[1]);
                    const m2 = bg.match(/(?:^|[^a-z])rgba?\(([^)]+)\)/);
                    if (m2) {
                        const parts = m2[1].split(',').map((p) => parseFloat(p.trim()));
                        return parts.length >= 4 ? parts[3] : 1;
                    }
                    return 1;
                });
            await expect
                .poll(async () => readAlpha(), { timeout: 5000, message: `${sel} should settle translucent` })
                .toBeLessThan(1);
            expect(await readAlpha(), `${sel} should still have color`).toBeGreaterThan(0);
        }
        // And the fixed layer is actually behind the app.
        expect(await page.locator('#app-bg').evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
    });
});

test.describe('Display-name glow is not clipped (overflow: clip + clip margin)', () => {
    test('all name surfaces keep the smooth glow instead of rectangular clipping', async ({ page }) => {
        await registerAndSetup(page);

        // Real member list row (server channel members panel).
        await page.click('#members-toggle');
        await page.waitForSelector('.member-name', { timeout: 5000 });
        const memberOverflow = await page.locator('.member-name').first().evaluate((el) => {
            const cs = getComputedStyle(el);
            return { overflow: cs.overflow, clipMargin: cs.overflowClipMargin };
        });
        expect(memberOverflow.overflow).toBe('clip');
        expect(parseFloat(memberOverflow.clipMargin)).toBeGreaterThanOrEqual(20);

        // The other glow-carrying name classes use the same rule.
        const cls = ['member-name', 'dm-name', 'mention-item-name', 'mst-name', 'voice-member-name'];
        const results = await page.evaluate((names) => {
            const out: Record<string, string> = {};
            for (const c of names) {
                const el = document.createElement('div');
                el.className = c;
                el.textContent = 'Some Long Display Name';
                document.body.appendChild(el);
                const cs = getComputedStyle(el);
                out[c] = cs.overflow + '|' + cs.overflowClipMargin;
                el.remove();
            }
            return out;
        }, cls);
        for (const c of cls) {
            const [overflow, clipMargin] = results[c].split('|');
            expect(overflow, `${c} overflow`).toBe('clip');
            expect(parseFloat(clipMargin), `${c} clip margin`).toBeGreaterThanOrEqual(20);
        }

        // The glow itself is present on a colored name (inline text-shadow).
        const hasShadow = await page.evaluate(() => {
            const el = document.createElement('div');
            el.className = 'member-name';
            el.style.color = '#ffcc00';
            el.style.textShadow = '0 0 4px #000, 0 0 8px #000, 0 0 16px #000';
            document.body.appendChild(el);
            const ok = getComputedStyle(el).textShadow !== 'none';
            el.remove();
            return ok;
        });
        expect(hasShadow).toBe(true);
    });
});
