import { test, expect, type Page } from '@playwright/test';

const BASE = 'https://localhost:3443';
const PASSWORD = 'testpass1234';

function unique(b: string): string {
    return `${b}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 15000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', PASSWORD);
    await page.fill('#register-confirm-password', PASSWORD);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 20000 });
}

test.describe('context menu icons', () => {
    test('showContextMenuAt renders an icon glyph and a plain-text label', async ({ page }) => {
        const user = unique('cmi');
        await register(page, user);

        // Call the real menu renderer with an icon item and a label that looks
        // like markup, to prove the label is inserted as TEXT (never parsed).
        await page.evaluate(() => {
            (window as any).showContextMenuAt(
                new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }),
                [
                    { icon: 'download', label: 'Download file.png', action: () => {} },
                    { icon: 'image', label: 'Copy image', action: () => {} },
                ]
            );
        });

        const menu = page.locator('.channel-context-menu');
        await expect(menu).toBeVisible();

        // 1. Real SVG elements exist (the sprite glyph), not escaped text.
        const svgCount = await menu.locator('.context-menu-item > svg.ui-icon use').count();
        expect(svgCount).toBe(2);

        // 2. The raw markup must NOT appear as visible text anywhere.
        const text = await menu.innerText();
        expect(text).not.toContain('<svg');
        expect(text).not.toContain('</svg>');
        expect(text).not.toContain('#icon-');

        // 3. Labels are readable text, not markup.
        await expect(menu.locator('.context-menu-label').first()).toHaveText('Download file.png');
        await expect(menu.locator('.context-menu-label').nth(1)).toHaveText('Copy image');
    });

    test('a filename containing angle brackets stays text, not markup', async ({ page }) => {
        const user = unique('cmi2');
        await register(page, user);

        await page.evaluate(() => {
            (window as any).showContextMenuAt(
                new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }),
                [{ icon: 'download', label: 'Download <img src=x onerror=alert(1)>.png', action: () => {} }]
            );
        });

        const menu = page.locator('.channel-context-menu');
        await expect(menu).toBeVisible();
        // The dangerous markup is inert text: no injected <img> element.
        expect(await menu.locator('img').count()).toBe(0);
        const labelText = await menu.locator('.context-menu-label').first().innerText();
        expect(labelText).toContain('<img src=x onerror=alert(1)>.png');
    });
});
