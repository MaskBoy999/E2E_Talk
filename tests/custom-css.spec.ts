import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';

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
    await page.evaluate(() => { var el = document.getElementById('loading-overlay'); if (el) el.remove(); });
    return username;
}

async function openCssTab(page: Page) {
    // Dismiss any app modal (changelog, backup nags, …) that would swallow clicks.
    await page.evaluate(() => {
        document.querySelectorAll('.modal').forEach((m) => {
            const el = m as HTMLElement;
            if (m.id !== 'settings-modal' && m.id !== 'css-pw-modal') el.style.display = 'none';
        });
    });
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
    await page.click('.settings-tab[data-tab="custom-css-settings"]');
    // The editor first renders a spinner, then fetches /api/user-css/slots.
    await page.waitForSelector('#custom-css-editor-container [data-css-slot]', { timeout: 15000 });
}

async function selectSlot(page: Page, slot: number) {
    await page.click(`[data-css-slot="${slot}"]`);
    // The active card gets its colored border; clicking re-renders asynchronously.
    await page.waitForFunction((s) => {
        const el = document.querySelector(`[data-css-slot="${s}"]`) as HTMLElement | null;
        return !!el && el.style.borderColor !== '#333';
    }, slot, { timeout: 15000 });
    await page.waitForSelector(slot > 0 ? '#css-edit-slot, #css-save-slot' : '#css-refresh', { timeout: 10000 });
}

async function startEditing(page: Page) {
    await page.click('#css-edit-slot');
    await page.waitForSelector('#css-save-slot', { timeout: 10000 });
}

async function saveActiveSlot(page: Page, css: string) {
    await startEditing(page);
    await page.fill('#custom-css-textarea', css);
    await page.click('#css-save-slot');
    // The save PUT re-renders the panel out of edit mode.
    await page.waitForSelector('#css-edit-slot', { timeout: 15000 });
}

/** The raw /api/user-css/slots payload (server-side truth, encrypted). */
async function serverSlots(page: Page): Promise<any> {
    return page.evaluate(() => (window as any).authFetch('/api/user-css/slots').then((r: any) => r.json()));
}

/** Text of the live `#custom-user-css` <style> element, '' when absent. */
function appliedCss(page: Page) {
    return page.evaluate(() => {
        const el = document.getElementById('custom-user-css');
        return el ? (el.textContent || '') : '';
    });
}

test.describe('Custom CSS — 2 server-side slots + default', () => {

    test('renders the 3 CSS sources and the default slot actions', async ({ page }) => {
        await registerAndLogin(page);
        await openCssTab(page);

        await expect(page.locator('[data-css-slot]')).toHaveCount(3);
        await expect(page.locator('[data-css-slot="0"]')).toContainText('Default');
        await expect(page.locator('[data-css-slot="1"]')).toContainText('Slot 1');
        await expect(page.locator('[data-css-slot="2"]')).toContainText('Slot 2');

        const ta = page.locator('#custom-css-textarea');
        await expect(ta).toBeVisible();
        expect(await ta.evaluate((el) => (el as HTMLTextAreaElement).readOnly)).toBe(true);

        // Default source: copy + refresh only; no save button until Edit.
        await expect(page.locator('#css-copy')).toBeVisible();
        await expect(page.locator('#css-refresh')).toBeVisible();
        await expect(page.locator('#css-save-slot')).toHaveCount(0);

        // The shipped stylesheet is loaded into the textarea for inspection.
        await expect(ta).toHaveValue(/--bg-primary/, { timeout: 15000 });
    });

    test('save to Slot 1 persists on the server and re-applies after reload', async ({ page }) => {
        test.setTimeout(120000);
        await registerAndLogin(page);
        await openCssTab(page);
        await selectSlot(page, 1);

        const css = 'body { outline: 3px solid rgb(255, 0, 0) !important; }';
        await saveActiveSlot(page, css);

        await expect.poll(() => appliedCss(page), { timeout: 10000 }).toContain('outline: 3px solid');

        const data = await serverSlots(page);
        expect(data.active_slot).toBe(1);
        expect(String(data.slot1.encrypted_css || '').length).toBeGreaterThan(0);
        expect(data.slot1.nonce).toBeTruthy();
        // Stored ciphertext, not plaintext.
        expect(String(data.slot1.encrypted_css)).not.toContain('outline: 3px solid');

        // A fresh load of the app auto-applies the active slot's CSS.
        await page.reload();
        await page.waitForFunction(() => {
            const el = document.getElementById('loading-overlay');
            return !el || el.style.display === 'none' || el.style.opacity === '0' || !el.offsetParent;
        }, { timeout: 15000 }).catch(() => {});
        await page.evaluate(() => { var el = document.getElementById('loading-overlay'); if (el) el.remove(); });
        await expect.poll(() => appliedCss(page), { timeout: 20000 }).toContain('outline: 3px solid');
    });

    test('slots are independent: slot 1 and slot 2 keep different CSS', async ({ page }) => {
        test.setTimeout(150000);
        await registerAndLogin(page);
        await openCssTab(page);

        await selectSlot(page, 1);
        await saveActiveSlot(page, 'body { filter: hue-rotate(90deg) !important; }');

        await selectSlot(page, 2);
        await page.waitForFunction(() => {
            const ta = document.getElementById('custom-css-textarea') as HTMLTextAreaElement | null;
            return !!ta && ta.value.indexOf('Empty slot') !== -1;
        }, null, { timeout: 10000 });
        await saveActiveSlot(page, 'body { filter: invert(1) !important; }');

        // Back to slot 1: its own CSS is decrypted and shown again.
        await selectSlot(page, 1);
        await page.waitForFunction(() => {
            const ta = document.getElementById('custom-css-textarea') as HTMLTextAreaElement | null;
            return !!ta && ta.value.indexOf('hue-rotate(90deg)') !== -1;
        }, null, { timeout: 15000 });
        await expect.poll(() => appliedCss(page), { timeout: 10000 }).toContain('hue-rotate(90deg)');

        const data = await serverSlots(page);
        expect(String(data.slot1.encrypted_css || '').length).toBeGreaterThan(0);
        expect(String(data.slot2.encrypted_css || '').length).toBeGreaterThan(0);
        expect(data.slot1.encrypted_css).not.toBe(data.slot2.encrypted_css);
    });

    test('Preview applies CSS live without saving it', async ({ page }) => {
        test.setTimeout(120000);
        await registerAndLogin(page);
        await openCssTab(page);
        await selectSlot(page, 1);
        await saveActiveSlot(page, 'body { border-color: rgb(1, 2, 3) !important; }');
        const before = await serverSlots(page);

        await startEditing(page);
        await page.fill('#custom-css-textarea', 'body { border-color: rgb(9, 9, 9) !important; }');
        await page.click('#css-preview');
        await expect.poll(() => appliedCss(page), { timeout: 10000 }).toContain('rgb(9, 9, 9)');

        // Nothing was written to the server by Preview.
        const after = await serverSlots(page);
        expect(after.slot1.encrypted_css).toBe(before.slot1.encrypted_css);

        // Cancel drops the preview and the saved CSS comes back.
        await page.click('#css-cancel-edit');
        await page.waitForSelector('#css-edit-slot', { timeout: 15000 });
        await expect.poll(() => appliedCss(page), { timeout: 10000 }).toContain('rgb(1, 2, 3)');
    });

    test('Export without a password downloads an unencrypted .e2ecss file', async ({ page }) => {
        test.setTimeout(120000);
        await registerAndLogin(page);
        await openCssTab(page);
        await selectSlot(page, 1);
        const css = 'body { text-decoration: underline !important; }';
        await saveActiveSlot(page, css);

        await page.click('#css-export');
        await page.waitForSelector('#css-pw-modal', { state: 'visible', timeout: 5000 });
        await expect(page.locator('#css-pw-title')).toHaveText('Export CSS');
        await page.check('#css-pw-nopw');

        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.click('#css-pw-confirm-btn'),
        ]);
        expect(download.suggestedFilename()).toContain('.e2ecss');
        const filePath = await download.path();
        expect(filePath).toBeTruthy();
        const backup = JSON.parse(fs.readFileSync(filePath as string, 'utf-8'));
        expect(backup.app).toBe('e2e_chat');
        expect(backup.kind).toBe('custom_css');
        expect(backup.v).toBe(1);
        expect(backup.payload.css).toBe(css);
        expect(backup.encrypted_private_key).toBeFalsy();
    });

    test('Export with a password encrypts the backup (and it decrypts)', async ({ page }) => {
        test.setTimeout(120000);
        await registerAndLogin(page);
        await openCssTab(page);
        await selectSlot(page, 1);
        const css = 'body { text-transform: uppercase !important; }';
        await saveActiveSlot(page, css);

        await page.click('#css-export');
        await page.waitForSelector('#css-pw-modal', { state: 'visible', timeout: 5000 });
        await page.fill('#css-pw-input', 'csspass123');
        await page.fill('#css-pw-confirm-input', 'csspass123');

        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.click('#css-pw-confirm-btn'),
        ]);
        const filePath = await download.path();
        expect(filePath).toBeTruthy();
        const backup = JSON.parse(fs.readFileSync(filePath as string, 'utf-8'));
        expect(backup.app).toBe('e2e_chat');
        expect(backup.kind).toBe('custom_css');
        expect(backup.salt).toBeTruthy();
        expect(backup.nonce).toBeTruthy();
        expect(backup.encrypted_private_key).toBeTruthy();
        expect(backup.payload).toBeUndefined();

        const decrypted = await page.evaluate((data) => {
            return (window as any).E2ECrypto.decryptWithPassword(
                data.encrypted_private_key, 'csspass123', data.salt, data.nonce);
        }, backup);
        expect(JSON.parse(decrypted).css).toBe(css);

        const wrong = await page.evaluate((data) => {
            return (window as any).E2ECrypto.decryptWithPassword(
                data.encrypted_private_key, 'not-the-password', data.salt, data.nonce);
        }, backup);
        expect(wrong).toBeNull();
    });

    test('Import Backup restores a plaintext backup into the active slot', async ({ page }, testInfo) => {
        test.setTimeout(120000);
        await registerAndLogin(page);
        await openCssTab(page);
        await selectSlot(page, 1);

        const imported = 'body { letter-spacing: 2px !important; }';
        const file = testInfo.outputPath('plain.e2ecss');
        fs.writeFileSync(file, JSON.stringify({ app: 'e2e_chat', kind: 'custom_css', v: 1, payload: { css: imported } }));

        await page.locator('#css-import-backup-input').setInputFiles(file);
        await page.waitForSelector('#css-pw-modal', { state: 'visible', timeout: 5000 });
        await expect(page.locator('#css-pw-title')).toHaveText('Import CSS');
        await page.click('#css-pw-confirm-btn');

        await expect.poll(() => appliedCss(page), { timeout: 15000 }).toContain('letter-spacing: 2px');
        const data = await serverSlots(page);
        expect(String(data.slot1.encrypted_css || '').length).toBeGreaterThan(0);
    });

    test('Import Backup refuses a wrong password and accepts the right one', async ({ page }, testInfo) => {
        test.setTimeout(120000);
        await registerAndLogin(page);
        await openCssTab(page);
        await selectSlot(page, 1);

        const imported = 'body { word-spacing: 6px !important; }';
        const backup = await page.evaluate((css) => {
            const enc = (window as any).E2ECrypto.encryptWithPassword(JSON.stringify({ css }), 'backup-pass-1');
            return {
                app: 'e2e_chat', kind: 'custom_css', v: 1,
                salt: enc.salt, nonce: enc.nonce, encrypted_private_key: enc.encrypted_private_key,
            };
        }, imported);
        const file = testInfo.outputPath('encrypted.e2ecss');
        fs.writeFileSync(file, JSON.stringify(backup));

        await page.locator('#css-import-backup-input').setInputFiles(file);
        await page.waitForSelector('#css-pw-modal', { state: 'visible', timeout: 5000 });

        await page.fill('#css-pw-input', 'wrong-password');
        await page.click('#css-pw-confirm-btn');
        await expect(page.locator('#css-pw-error')).toBeVisible({ timeout: 5000 });
        expect(await appliedCss(page)).not.toContain('word-spacing: 6px');

        await page.fill('#css-pw-input', 'backup-pass-1');
        await page.click('#css-pw-confirm-btn');
        await expect.poll(() => appliedCss(page), { timeout: 15000 }).toContain('word-spacing: 6px');
    });

    test('Import .css file fills the editor and Save stores it', async ({ page }, testInfo) => {
        test.setTimeout(120000);
        await registerAndLogin(page);
        await openCssTab(page);
        await selectSlot(page, 1);
        await startEditing(page);

        const css = 'body { font-variant: small-caps !important; }';
        const file = testInfo.outputPath('import.css');
        fs.writeFileSync(file, css);
        await page.locator('#css-import-file-input').setInputFiles(file);

        await expect(page.locator('#custom-css-textarea')).toHaveValue(css);
        await page.click('#css-save-slot');
        await page.waitForSelector('#css-edit-slot', { timeout: 15000 });

        await expect.poll(() => appliedCss(page), { timeout: 10000 }).toContain('small-caps');
        const data = await serverSlots(page);
        expect(String(data.slot1.encrypted_css || '').length).toBeGreaterThan(0);
    });

    test('Clear Slot deletes the stored CSS', async ({ page }) => {
        test.setTimeout(120000);
        await registerAndLogin(page);
        await openCssTab(page);
        await selectSlot(page, 1);
        await saveActiveSlot(page, 'body { cursor: crosshair !important; }');

        await startEditing(page);
        // ui-dialog auto-answers confirm() under automation.
        await page.click('#css-clear-slot');
        await page.waitForFunction(() => {
            const ta = document.getElementById('custom-css-textarea') as HTMLTextAreaElement | null;
            return !!ta && ta.value.indexOf('Empty slot') !== -1;
        }, null, { timeout: 15000 });

        const data = await serverSlots(page);
        expect(String((data.slot1 && data.slot1.encrypted_css) || '')).toBe('');
        expect(await page.evaluate(() => !!document.getElementById('custom-user-css'))).toBe(false);
    });
});
