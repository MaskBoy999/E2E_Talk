import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BASE = 'https://localhost:3443';

/**
 * Call `uiConfirm(...)` / `uiPrompt(...)` / ... inside the page and stash the
 * resolved value on window.__dialogResult (the call must not be awaited here,
 * the modal needs the test to click it).
 */
async function callDialog(page: Page, body: string): Promise<void> {
    await page.evaluate((fnBody) => {
        const w = window as any;
        w.__dialogResult = 'pending';
        // eslint-disable-next-line no-new-func
        const run = new Function('w', 'return w.' + fnBody + ';');
        run(w).then((r: any) => { w.__dialogResult = r; });
    }, body);
}

async function resolved(page: Page): Promise<any> {
    await expect.poll(() => page.evaluate(() => (window as any).__dialogResult)).not.toBe('pending');
    return page.evaluate(() => (window as any).__dialogResult);
}

test.describe('in-page dialogs (static/ui-dialog.js)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(`${BASE}/login.html`);
        await page.waitForFunction(() => typeof (window as any).uiConfirm === 'function');
        // Playwright sets navigator.webdriver, which normally auto-answers; force
        // the real modal so the rendering/click path is actually exercised.
        await page.evaluate(() => { (window as any).__uiDialogForceShow = true; });
    });

    test('confirm() renders in the page and resolves from the buttons', async ({ page }) => {
        await callDialog(page, "uiConfirm('Delete this thing?')");
        await expect(page.locator('.ui-dialog')).toBeVisible();
        await expect(page.locator('.ui-dialog-message')).toHaveText('Delete this thing?');

        // Cancel resolves false
        await page.click('.ui-dialog-cancel');
        expect(await resolved(page)).toBe(false);

        // OK resolves true
        await callDialog(page, "uiConfirm('Again?')");
        await page.click('.ui-dialog-ok');
        expect(await resolved(page)).toBe(true);

        // Escape cancels, and the overlay is gone afterwards
        await callDialog(page, "uiConfirm('Escape me')");
        await page.keyboard.press('Escape');
        expect(await resolved(page)).toBe(false);
        await expect(page.locator('.ui-dialog')).toHaveCount(0);
    });

    test('prompt() renders an input and returns its value (masked for passwords)', async ({ page }) => {
        await callDialog(page, "uiPrompt('Rename group:', 'Old')");
        await expect(page.locator('.ui-dialog-input')).toHaveValue('Old');
        await page.fill('.ui-dialog-input', 'Renamed');
        await page.click('.ui-dialog-ok');
        expect(await resolved(page)).toBe('Renamed');

        // Cancel returns null, not an empty string
        await callDialog(page, "uiPrompt('Rename group:', 'Old')");
        await page.click('.ui-dialog-cancel');
        expect(await resolved(page)).toBeNull();

        // Password-ish prompts mask the input
        await callDialog(page, "uiPrompt('Enter your current password to remove the kill switch:')");
        await expect(page.locator('.ui-dialog-input')).toHaveAttribute('type', 'password');
        await page.click('.ui-dialog-cancel');
        expect(await resolved(page)).toBeNull();
    });

    test('alert() is routed to the in-page modal (no browser popup left)', async ({ page }) => {
        await page.evaluate(() => { (window as any).alert('Heads up'); });
        await expect(page.locator('.ui-dialog')).toBeVisible();
        await expect(page.locator('.ui-dialog-message')).toHaveText('Heads up');
        // Alerts have no Cancel button
        await expect(page.locator('.ui-dialog-cancel')).toHaveCount(0);
        await page.click('.ui-dialog-ok');
        await expect(page.locator('.ui-dialog')).toHaveCount(0);
    });
});

test.describe('no native popups remain', () => {
    test('app sources never call the native confirm()/prompt()', async () => {
        const stripComments = (src: string) =>
            src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

        const files = fs.readdirSync('static')
            .filter((f) => (f.endsWith('.js') && f !== 'ui-dialog.js') || f.endsWith('.html'));

        const offenders: string[] = [];
        for (const file of files) {
            const code = stripComments(fs.readFileSync(path.join('static', file), 'utf8'));
            const matches = code.match(/(^|[^A-Za-z0-9_$.])(confirm|prompt)\s*\(/g) || [];
            for (const m of matches) offenders.push(`${file}: ${m.trim()}`);
        }

        expect(offenders, 'use uiConfirm()/uiPrompt() from ui-dialog.js instead').toEqual([]);
    });
});
