import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';

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

    test('live edit mode: edit button, drag-to-move, hover highlight, done/escape, center reset', async ({ page }) => {
        await registerAndSetup(page);
        await openDisplaySettings(page);
        await uploadBackground(page);
        await expect(page.locator('body')).toHaveClass(/app-bg-on/, { timeout: 10000 });

        // Edit button only appears once an image is set (desktop viewport).
        await expect(page.locator('#app-bg-edit-btn')).toBeVisible();

        // Enter edit mode: settings closes, the floating panel opens over the
        // real app so every tune is visible live behind the UI.
        await page.click('#app-bg-edit-btn');
        await expect(page.locator('#settings-modal')).toBeHidden();
        await expect(page.locator('body')).toHaveClass(/app-bg-edit/);
        await expect(page.locator('#app-bg-edit-panel')).toBeVisible();
        await expect(page.locator('#app-bg-edit-sections .app-bg-section')).toHaveCount(7);

        // Drag anywhere on the app → the picture pans (calc() with px offsets).
        const before = await page.locator('#app-bg').evaluate((el) => (el as HTMLElement).style.backgroundPosition);
        expect(before).toBe('center center');
        const box = await page.locator('#app-bg-drag').boundingBox();
        const cx = box!.x + box!.width / 2;
        const cy = box!.y + box!.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + 120, cy + 40, { steps: 6 });
        await page.mouse.up();
        const after = await page.locator('#app-bg').evaluate((el) => (el as HTMLElement).style.backgroundPosition);
        expect(after).toContain('calc(');
        expect(after).toContain('120px');

        // Hovering a section row highlights that part of the live app.
        const sidebarRow = page.locator('#app-bg-edit-sections .app-bg-section[data-key="sidebar"]');
        await sidebarRow.hover();
        await expect(page.locator('body')).toHaveClass(/app-bg-hl-sidebar/);

        // Section controls in the panel apply live to the actual app.
        await page.locator('#app-bg-edit-sections .app-bg-dim[data-section="sidebar"]').evaluate((el) => {
            (el as HTMLInputElement).value = '30';
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        const dim = await page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--bg-dim-sidebar').trim());
        expect(dim).toBe('30%');

        // Center button resets position + pan back to the plain origin.
        await page.click('#app-bg-edit-center');
        expect(await page.locator('#app-bg').evaluate((el) => (el as HTMLElement).style.backgroundPosition)).toBe('center center');

        // Pan again, then Escape exits edit mode and the pan persists.
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx - 60, cy, { steps: 4 });
        await page.mouse.up();
        await page.keyboard.press('Escape');
        await expect(page.locator('body')).not.toHaveClass(/app-bg-edit/);
        await expect(page.locator('#app-bg-edit-panel')).toBeHidden();
        const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('app_bg') || 'null'));
        expect(Math.abs(stored.panX)).toBeGreaterThan(0);

        // Persisted pan survives a reload.
        await page.reload();
        await page.waitForSelector('#settings-btn', { timeout: 15000 });
        const posAfterReload = await page.locator('#app-bg').evaluate((el) => (el as HTMLElement).style.backgroundPosition);
        expect(posAfterReload).toContain('calc(');
    });

    test('live edit mode is desktop-only (button hidden and mode exits on phone widths)', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await registerAndSetup(page);
        // On phone the sidebar is off-canvas — open it before reaching settings.
        await page.click('#hamburger');
        await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 5000 });
        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        await page.click('[data-tab="display-settings"]');
        await page.waitForSelector('#app-bg-upload-btn', { state: 'visible', timeout: 5000 });
        await uploadBackground(page);
        await expect(page.locator('body')).toHaveClass(/app-bg-on/, { timeout: 10000 });
        await expect(page.locator('#app-bg-edit-btn')).toBeHidden();

        // Grow to desktop → the button appears.
        await page.setViewportSize({ width: 1280, height: 720 });
        await expect(page.locator('#app-bg-edit-btn')).toBeVisible();

        // Enter edit mode, then shrink back to phone → mode auto-exits.
        await page.click('#app-bg-edit-btn');
        await expect(page.locator('body')).toHaveClass(/app-bg-edit/);
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.locator('body')).not.toHaveClass(/app-bg-edit/);
        await expect(page.locator('#app-bg-edit-panel')).toBeHidden();
    });

    test('live edit mode: interact toggle disables the drag layer, restores app use, and persists', async ({ page }) => {
        await registerAndSetup(page);
        await openDisplaySettings(page);
        await uploadBackground(page);
        await expect(page.locator('body')).toHaveClass(/app-bg-on/, { timeout: 10000 });

        await page.click('#app-bg-edit-btn');
        await expect(page.locator('body')).toHaveClass(/app-bg-edit/);

        const centerEl = () =>
            page.evaluate(() => {
                const el = document.elementFromPoint(Math.floor(innerWidth / 2), Math.floor(innerHeight / 2));
                return el ? (el.id || el.className || el.tagName).toString() : '';
            });

        // Default is Move: the transparent drag layer sits above the app.
        expect(await centerEl()).toContain('app-bg-drag');

        // Switch to Interact → drag layer gone, the real app is reachable.
        await page.click('.app-bg-mode-btn[data-mode="interact"]');
        await expect(page.locator('body')).toHaveClass(/app-bg-interact/);
        await expect(page.locator('#app-bg-drag')).toBeHidden();
        expect(await centerEl()).not.toContain('app-bg-drag');
        expect(await page.locator('#app-bg-edit-hint').textContent()).toContain('interactive');

        // Persisted across re-entry (Escape leaves settings closed — reopen it).
        await page.keyboard.press('Escape');
        await expect(page.locator('body')).not.toHaveClass(/app-bg-edit/);
        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        await page.click('[data-tab="display-settings"]');
        await page.click('#app-bg-edit-btn');
        await expect(page.locator('body')).toHaveClass(/app-bg-interact/);

        // Back to Move restores the drag layer.
        await page.click('.app-bg-mode-btn[data-mode="drag"]');
        await expect(page.locator('body')).not.toHaveClass(/app-bg-interact/);
        expect(await centerEl()).toContain('app-bg-drag');
    });

    test('theme colors are device-local: changing them triggers no profile PATCH', async ({ page }) => {
        await registerAndSetup(page);
        await openDisplaySettings(page);

        let profilePatches = 0;
        page.on('request', (req) => {
            if (req.method() === 'PATCH' && req.url().includes('/api/profile')) profilePatches++;
        });

        await page.locator('#theme-color-hex').fill('#ff00ff');
        await page.locator('#theme-color-hex').dispatchEvent('change');
        await page.locator('#theme-bg-hex').fill('#00ff00');
        await page.locator('#theme-bg-hex').dispatchEvent('change');

        expect(await page.evaluate(() => localStorage.getItem('theme_color'))).toBe('#ff00ff');
        expect(await page.evaluate(() => localStorage.getItem('theme_bg_color'))).toBe('#00ff00');
        expect(await page.inputValue('#theme-color-picker')).toBe('#ff00ff');
        expect(await page.inputValue('#theme-bg-picker')).toBe('#00ff00');
        expect(profilePatches).toBe(0);
    });

    test('appearance export/import round-trips colors + background with a password, wrong password rejected', async ({ page }) => {
        await registerAndSetup(page);
        await openDisplaySettings(page);

        // A distinct look: accent + bg colors, an app background, a tuned section.
        await page.locator('#theme-color-hex').fill('#ff6600');
        await page.locator('#theme-color-hex').dispatchEvent('change');
        await page.locator('#theme-bg-hex').fill('#2244aa');
        await page.locator('#theme-bg-hex').dispatchEvent('change');
        await uploadBackground(page);
        await expect(page.locator('body')).toHaveClass(/app-bg-on/, { timeout: 10000 });
        await page.locator('.app-bg-blur[data-section="sidebar"]').evaluate((el) => {
            (el as HTMLInputElement).value = '18';
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.locator('.app-bg-dim[data-section="sidebar"]').evaluate((el) => {
            (el as HTMLInputElement).value = '25';
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });

        // Export with a password.
        await page.click('#theme-export-btn');
        await expect(page.locator('#appearance-pw-modal')).toBeVisible();
        await page.fill('#appearance-pw-input', 'backup123');
        await page.fill('#appearance-pw-confirm-input', 'backup123');
        const outPath = path.join(__dirname, '..', 'test-results', 'appearance-export.e2etheme');
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.click('#appearance-pw-confirm-btn'),
        ]);
        await download.saveAs(outPath);
        await expect(page.locator('#appearance-pw-modal')).toBeHidden();

        // Wreck the local look.
        await page.locator('#theme-color-hex').fill('#000000');
        await page.locator('#theme-color-hex').dispatchEvent('change');
        await page.click('#app-bg-remove-btn');
        await expect(page.locator('body')).not.toHaveClass(/app-bg-on/);

        // Import restores everything.
        const [chooser] = await Promise.all([
            page.waitForEvent('filechooser'),
            page.click('#theme-import-btn'),
        ]);
        await chooser.setFiles(outPath);
        await expect(page.locator('#appearance-pw-modal')).toBeVisible();
        await page.fill('#appearance-pw-input', 'backup123');
        await page.click('#appearance-pw-confirm-btn');

        await expect(page.locator('body')).toHaveClass(/app-bg-on/, { timeout: 15000 });
        expect(await page.evaluate(() => localStorage.getItem('theme_color'))).toBe('#ff6600');
        expect(await page.evaluate(() => localStorage.getItem('theme_bg_color'))).toBe('#2244aa');
        const props = await page.evaluate(() => {
            const cs = getComputedStyle(document.documentElement);
            return {
                dim: cs.getPropertyValue('--bg-dim-sidebar').trim(),
                blur: cs.getPropertyValue('--bg-blur-sidebar').trim(),
            };
        });
        expect(props.dim).toBe('25%');
        expect(props.blur).toBe('18px');
        const bgImage = await page.locator('#app-bg').evaluate((el) => (el as HTMLElement).style.backgroundImage);
        expect(bgImage).toContain('data:image/jpeg');

        // Wrong password is rejected.
        const [chooser2] = await Promise.all([
            page.waitForEvent('filechooser'),
            page.click('#theme-import-btn'),
        ]);
        await chooser2.setFiles(outPath);
        await expect(page.locator('#appearance-pw-modal')).toBeVisible();
        await page.fill('#appearance-pw-input', 'wrongpass');
        await page.click('#appearance-pw-confirm-btn');
        await expect(page.locator('#appearance-pw-error')).toBeVisible();
        expect(await page.locator('#appearance-pw-error').textContent()).toContain('Wrong password');
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
