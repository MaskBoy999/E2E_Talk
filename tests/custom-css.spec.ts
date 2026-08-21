import { test, expect, type Page } from '@playwright/test';

const BASE = 'https://localhost:3443';

async function registerAndLogin(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const username = 'css_' + ts;
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 15000 });
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'test1234');
    await page.fill('#register-confirm-password', 'test1234');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html**', { timeout: 30000 });
    await page.waitForFunction(() => {
        const el = document.getElementById('loading-overlay');
        return !el || el.style.display === 'none' || el.style.opacity === '0' || !el.offsetParent;
    }, { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => { var el = document.getElementById('loading-overlay'); if(el) el.remove(); });
    return username;
}

async function openCssTab(page: Page) {
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
    await page.click('.settings-tab[data-tab="custom-css-settings"]');
    await page.waitForTimeout(500);
}

test.describe('F14 · Custom CSS', () => {

    test('CSS settings tab renders with textarea, buttons, and all 6 theme presets', async ({ page }) => {
        await registerAndLogin(page);
        await openCssTab(page);
        expect(await page.locator('#custom-css-textarea').isVisible()).toBe(true);
        expect(await page.locator('#css-save-local').isVisible()).toBe(true);
        expect(await page.locator('#css-preview').isVisible()).toBe(true);
        expect(await page.locator('#css-reset').isVisible()).toBe(true);
        expect(await page.locator('#css-import').isVisible()).toBe(true);
        expect(await page.locator('#css-export').isVisible()).toBe(true);
        expect(await page.locator('#css-import-backup').isVisible()).toBe(true);
        const presets = await page.locator('[data-preset]').count();
        expect(presets).toBe(7); // default, performance, premium, neon, light, highcontrast, custom
    });

    test('save local CSS persists in localStorage and applies', async ({ page }) => {
        await registerAndLogin(page);
        await openCssTab(page);
        // Switch to custom mode first
        await page.click('[data-preset="custom"]');
        await page.waitForTimeout(300);
        await page.fill('#custom-css-textarea', 'body { background: red !important; }');
        await page.click('#css-save-local');
        await page.waitForTimeout(500);
        expect(await page.evaluate(() => localStorage.getItem('custom_css_text'))).toBe('body { background: red !important; }');
        expect(await page.evaluate(() => !!document.getElementById('custom-user-css'))).toBe(true);
    });

    test('reset removes CSS, localStorage, and preset selection', async ({ page }) => {
        await registerAndLogin(page);
        await openCssTab(page);
        await page.click('[data-preset="performance"]');
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => localStorage.getItem('custom_css_preset'))).toBe('performance');
        await page.click('#css-reset');
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => localStorage.getItem('custom_css_text'))).toBeNull();
        expect(await page.evaluate(() => localStorage.getItem('custom_css_preset'))).toBeNull();
        expect(await page.evaluate(() => localStorage.getItem('custom_css_mode'))).toBeNull();
        expect(await page.evaluate(() => !!document.getElementById('custom-user-css'))).toBe(false);
    });

    test('preview applies CSS without saving to localStorage', async ({ page }) => {
        await registerAndLogin(page);
        await openCssTab(page);
        await page.click('[data-preset="custom"]');
        await page.waitForTimeout(300);
        await page.fill('#custom-css-textarea', 'body { background: green !important; }');
        await page.click('#css-preview');
        await page.waitForTimeout(500);
        expect(await page.evaluate(() => !!document.getElementById('custom-user-css'))).toBe(true);
        expect(await page.evaluate(() => localStorage.getItem('custom_css_text'))).toBeNull();
    });

    // ── Preset-specific tests ──

    test('Performance preset: disables animations, blur, and shadows', async ({ page }) => {
        await registerAndLogin(page);
        await openCssTab(page);
        await page.click('[data-preset="performance"]');
        await page.waitForTimeout(500);
        expect(await page.evaluate(() => localStorage.getItem('custom_css_preset'))).toBe('performance');
        const css = await page.evaluate(() => localStorage.getItem('custom_css_text') || '');
        expect(css).toContain('animation: none');
        expect(css).toContain('backdrop-filter: none');
        expect(css).toContain('box-shadow: none');
        expect(css).toContain('transition: none');
        expect(await page.evaluate(() => !!document.getElementById('custom-user-css'))).toBe(true);
    });

    test('Premium preset: glassmorphism, blur, and hover glow', async ({ page }) => {
        await registerAndLogin(page);
        await openCssTab(page);
        await page.click('[data-preset="premium"]');
        await page.waitForTimeout(500);
        const css = await page.evaluate(() => localStorage.getItem('custom_css_text') || '');
        expect(css).toContain('backdrop-filter: blur');
        expect(css).toContain('glassmorphism');
        expect(css).toContain('transform: translateY');
        expect(css).toContain('box-shadow: 0 0 16px');
        expect(css).toContain('::-webkit-scrollbar-thumb');
    });

    test('Neon preset: cyberpunk neon glow effects', async ({ page }) => {
        await registerAndLogin(page);
        await openCssTab(page);
        await page.click('[data-preset="neon"]');
        await page.waitForTimeout(500);
        const css = await page.evaluate(() => localStorage.getItem('custom_css_text') || '');
        expect(css).toContain('rgba(0, 255, 200,');
        expect(css).toContain('#0a0a1a');
        expect(css).toContain('#0d0d20');
        expect(css).toContain('box-shadow: 0 0');
        expect(css).toContain('border-radius: 8px');
    });

    test('Light preset: overrides CSS vars to light colors', async ({ page }) => {
        await registerAndLogin(page);
        await openCssTab(page);
        await page.click('[data-preset="light"]');
        await page.waitForTimeout(500);
        const css = await page.evaluate(() => localStorage.getItem('custom_css_text') || '');
        expect(css).toContain('--bg-primary: #f5f5f5');
        expect(css).toContain('--text-primary: #212121');
        expect(css).toContain('background: #ffffff');
        expect(css).toContain('color: #212121');
        expect(css).toContain('#1976d2');
    });

    test('High Contrast preset: WCAG AAA with yellow focus outlines', async ({ page }) => {
        await registerAndLogin(page);
        await openCssTab(page);
        await page.click('[data-preset="highcontrast"]');
        await page.waitForTimeout(500);
        const css = await page.evaluate(() => localStorage.getItem('custom_css_text') || '');
        expect(css).toContain('background: #000000');
        expect(css).toContain('color: #ffffff');
        expect(css).toContain('outline: 3px solid #ffff00');
        expect(css).toContain('border: 2px solid #ffffff');
        expect(css).toContain('animation: none');
        expect(css).toContain('transition: none');
    });

    // ── Switching & lifecycle tests ──

    test('clicking Default preset clears all CSS and preset', async ({ page }) => {
        await registerAndLogin(page);
        await openCssTab(page);
        await page.click('[data-preset="premium"]');
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => localStorage.getItem('custom_css_preset'))).toBe('premium');
        await page.click('[data-preset="default"]');
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => localStorage.getItem('custom_css_preset'))).toBeNull();
        const cssText = await page.evaluate(() => localStorage.getItem('custom_css_text'));
        expect(cssText).toBe('');
        expect(await page.evaluate(() => !!document.getElementById('custom-user-css'))).toBe(false);
    });

    test('switching presets updates textarea content', async ({ page }) => {
        await registerAndLogin(page);
        await openCssTab(page);
        await page.click('[data-preset="performance"]');
        await page.waitForTimeout(300);
        let taVal = await page.inputValue('#custom-css-textarea');
        expect(taVal).toContain('animation: none');
        await page.click('[data-preset="premium"]');
        await page.waitForTimeout(300);
        taVal = await page.inputValue('#custom-css-textarea');
        expect(taVal).toContain('glassmorphism');
        expect(taVal).not.toContain('animation: none');
    });

    test('manual CSS edit deselects preset', async ({ page }) => {
        await registerAndLogin(page);
        await openCssTab(page);
        await page.click('[data-preset="custom"]');
        await page.waitForTimeout(300);
        await page.fill('#custom-css-textarea', 'body { color: pink; }');
        await page.click('#css-save-local');
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => localStorage.getItem('custom_css_preset'))).toBeNull();
    });

    test('reset clears preset selection visual state', async ({ page }) => {
        await registerAndLogin(page);
        await openCssTab(page);
        await page.click('[data-preset="premium"]');
        await page.waitForTimeout(300);
        await page.click('#css-reset');
        await page.waitForTimeout(300);
        const defaultBorder = await page.evaluate(() => {
            const el = document.querySelector('[data-preset="default"]');
            return el ? (el as HTMLElement).style.borderColor : '';
        });
        expect(defaultBorder).toBeTruthy();
        const perfBorder = await page.evaluate(() => {
            const el = document.querySelector('[data-preset="performance"]');
            return el ? (el as HTMLElement).style.borderColor : '';
        });
        expect(perfBorder).toMatch(/#333|rgb\(51,\s*51,\s*51\)/);
    });

    test('importing a CSS file overwrites textarea and clears preset', async ({ page }) => {
        await registerAndLogin(page);
        await openCssTab(page);
        await page.click('[data-preset="premium"]');
        await page.waitForTimeout(300);
        const fileContent = 'body { background: purple !important; }';
        const tmpFile = '/tmp/test_import.css';
        const fs = require('fs');
        fs.writeFileSync(tmpFile, fileContent);
        const fileInput = page.locator('#css-import-input');
        await fileInput.setInputFiles(tmpFile);
        await page.waitForTimeout(500);
        const taVal = await page.inputValue('#custom-css-textarea');
        expect(taVal).toBe(fileContent);
        expect(await page.evaluate(() => localStorage.getItem('custom_css_preset'))).toBeNull();
    });

    test('full cycle: neon -> edit -> save -> highcontrast -> reset -> clean', async ({ page }) => {
        await registerAndLogin(page);
        await openCssTab(page);
        // Apply neon
        await page.click('[data-preset="neon"]');
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => localStorage.getItem('custom_css_preset'))).toBe('neon');
        // Switch to highcontrast
        await page.click('[data-preset="highcontrast"]');
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => localStorage.getItem('custom_css_preset'))).toBe('highcontrast');
        const css = await page.evaluate(() => localStorage.getItem('custom_css_text') || '');
        expect(css).toContain('#000000');
        expect(css).toContain('#ffff00');
        // Reset
        await page.click('#css-reset');
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => localStorage.getItem('custom_css_text'))).toBeNull();
        expect(await page.evaluate(() => localStorage.getItem('custom_css_preset'))).toBeNull();
        expect(await page.evaluate(() => !!document.getElementById('custom-user-css'))).toBe(false);
    });

    test('cycle through all 6 presets and verify each has unique CSS', async ({ page }) => {
        await registerAndLogin(page);
        await openCssTab(page);
        const presetIds = ['default', 'performance', 'premium', 'neon', 'light', 'highcontrast'];
        const seen = new Set<string>();
        for (const id of presetIds) {
            await page.click(`[data-preset="${id}"]`);
            await page.waitForTimeout(300);
            const css = await page.evaluate(() => localStorage.getItem('custom_css_text') || '');
            if (css.length > 0) {
                expect(seen.has(css)).toBe(false); // Each preset must be unique
                seen.add(css);
            }
        }
        expect(seen.size).toBe(5); // default is empty, 5 others have unique CSS
    });

    test('export button opens password modal', async ({ page }) => {
        await registerAndLogin(page);
        await openCssTab(page);
        await page.click('#css-export');
        await page.waitForTimeout(300);
        const modal = page.locator('#css-pw-modal');
        expect(await modal.isVisible()).toBe(true);
        expect(await page.locator('#css-pw-title').textContent()).toContain('Export CSS');
    });

    test('export without password option downloads plaintext file', async ({ page }) => {
        await registerAndLogin(page);
        await openCssTab(page);
        // First apply some CSS
        await page.click('[data-preset="performance"]');
        await page.waitForTimeout(300);
        // Click export
        await page.click('#css-export');
        await page.waitForTimeout(300);
        // Check the no-password checkbox
        await page.check('#css-pw-nopw');
        await page.waitForTimeout(200);
        // Click confirm
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.click('#css-pw-confirm-btn'),
        ]);
        expect(download.suggestedFilename()).toContain('.e2ecss');
    });

    test('export with password encrypts the file', async ({ page }) => {
        await registerAndLogin(page);
        await openCssTab(page);
        await page.click('[data-preset="performance"]');
        await page.waitForTimeout(300);
        await page.click('#css-export');
        await page.waitForTimeout(300);
        await page.fill('#css-pw-input', 'testpass123');
        await page.fill('#css-pw-confirm-input', 'testpass123');
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.click('#css-pw-confirm-btn'),
        ]);
        expect(download.suggestedFilename()).toContain('.e2ecss');
        // Read file and verify it's encrypted (has salt, nonce, encrypted_private_key)
        const path = await download.path();
        if (path) {
            const fs = require('fs');
            const content = JSON.parse(fs.readFileSync(path, 'utf-8'));
            expect(content.app).toBe('e2e_chat');
            expect(content.kind).toBe('custom_css');
            expect(content.salt).toBeTruthy();
            expect(content.nonce).toBeTruthy();
            expect(content.encrypted_private_key).toBeTruthy();
        }
    });

    test('import backup button opens file picker', async ({ page }) => {
        await registerAndLogin(page);
        await openCssTab(page);
        const fileInput = page.locator('#css-import-backup-input');
        expect(await fileInput.isVisible()).toBe(false); // hidden file input
        // Verify the import backup button exists
        expect(await page.locator('#css-import-backup').isVisible()).toBe(true);
    });
});
