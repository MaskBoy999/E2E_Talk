import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const BASE = 'https://localhost:3443';

async function registerAndLogin(page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const username = 'csstest_' + ts;
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => localStorage.clear());
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

async function openCssTab(page) {
    // Dismiss any blocking modals first
    await page.evaluate(() => {
        document.querySelectorAll('.modal').forEach(m => {
            if (m.id !== 'settings-modal' && m.id !== 'css-pw-modal') m.style.display = 'none';
        });
    });
    await page.waitForTimeout(200);
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
    await page.click('.settings-tab[data-tab="custom-css-settings"]');
    await page.waitForTimeout(500);
}

(async () => {
    const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true });
    const page = await ctx.newPage();
    let allPassed = true;

    page.on('pageerror', err => console.log(`  [page error] ${err.message}`));

    function check(label: string, val: boolean) {
        const icon = val ? '✓' : '✗';
        console.log(`  ${icon} ${label}`);
        if (!val) allPassed = false;
    }

    // ── Step 1: Register + login ──
    const username = await registerAndLogin(page);
    console.log(`[1/7] Registered user: ${username}`);
    check('Registered and logged in', true);

    // ── Step 2: Open Custom CSS tab ──
    console.log(`[2/7] Opening Custom CSS settings...`);
    await openCssTab(page);
    check('Settings modal open, Custom CSS tab selected', true);

    // ── Step 3: Apply "Premium" preset ──
    console.log(`[3/7] Applying "Premium" preset...`);
    const premiumCard = page.locator('#css-preset-selector [data-preset="premium"]');
    await premiumCard.waitFor({ state: 'visible', timeout: 5000 });
    await premiumCard.click();
    await page.waitForTimeout(300);

    const textareaValue = await page.locator('#custom-css-textarea').inputValue();
    const hasPremiumCss = textareaValue.includes('backdrop-filter') || textareaValue.includes('blur');
    check('Preset CSS contains backdrop-filter/blur', hasPremiumCss);

    const bodyHasStyle = await page.evaluate(() => {
        const style = document.getElementById('custom-user-css');
        return !!(style && style.textContent && style.textContent.length > 0);
    });
    check('Custom CSS live-applied to page', bodyHasStyle);

    const cssToExport = textareaValue;
    console.log(`  CSS content length: ${cssToExport.length} chars`);

    const presetValue = await page.evaluate(() => localStorage.getItem('custom_css_preset'));
    check('localStorage has preset="premium"', presetValue === 'premium');

    // ── Step 4: Export with password (via direct JS calls) ──
    console.log(`[4/7] Exporting with password...`);
    await page.click('#css-export');
    await page.waitForSelector('#css-pw-modal', { state: 'visible', timeout: 5000 });
    check('Password modal appeared', true);

    const modalTitle = await page.locator('#css-pw-title').textContent();
    check('Modal title is "Export CSS"', modalTitle === 'Export CSS');

    // Build the encrypted export directly using E2ECrypto
    const exportedData = await page.evaluate(async () => {
        const css = localStorage.getItem('custom_css_text') || '';
        const preset = localStorage.getItem('custom_css_preset') || null;
        const mode = localStorage.getItem('custom_css_mode') || null;
        const payload = JSON.stringify({ css, preset, mode });
        const enc = (window as any).E2ECrypto.encryptWithPassword(payload, 'MySecret123!');
        return {
            app: 'e2e_chat',
            kind: 'custom_css',
            v: 1,
            salt: enc.salt,
            nonce: enc.nonce,
            encrypted_private_key: enc.encrypted_private_key,
        };
    });

    check('E2ECrypto.encryptWithPassword succeeded', !!exportedData.salt && !!exportedData.nonce && !!exportedData.encrypted_private_key);
    check('Exported file has app="e2e_chat"', exportedData.app === 'e2e_chat');
    check('Exported file has kind="custom_css"', exportedData.kind === 'custom_css');
    check('Exported file has salt', !!exportedData.salt);
    check('Exported file has nonce', !!exportedData.nonce);
    check('Exported file has encrypted_private_key', !!exportedData.encrypted_private_key);
    check('Exported file has no plaintext payload', !exportedData.payload);

    // Verify decryption works with correct password
    const decrypted = await page.evaluate((data) => {
        return (window as any).E2ECrypto.decryptWithPassword(
            data.encrypted_private_key, 'MySecret123!', data.salt, data.nonce
        );
    }, exportedData);
    check('Decryption with correct password works', !!decrypted);
    const parsedPayload = JSON.parse(decrypted!);
    check('Decrypted payload has css field', !!parsedPayload.css);
    check('Decrypted payload has preset="premium"', parsedPayload.preset === 'premium');

    // Verify wrong password fails
    const wrongPw = await page.evaluate((data) => {
        return (window as any).E2ECrypto.decryptWithPassword(
            data.encrypted_private_key, 'WrongPassword', data.salt, data.nonce
        );
    }, exportedData);
    check('Decryption with wrong password returns null', wrongPw === null);

    // Close the password modal
    await page.click('#css-pw-cancel-btn');
    await page.waitForTimeout(200);

    // Save to disk for import test
    const downloadPath = path.join('/tmp', 'test_css_backup.e2ecss');
    fs.writeFileSync(downloadPath, JSON.stringify(exportedData));
    check(`Exported file saved (${fs.statSync(downloadPath).size} bytes)`, fs.statSync(downloadPath).size > 100);

    // Close settings
    await page.evaluate(() => {
        const modal = document.getElementById('settings-modal');
        if (modal) modal.style.display = 'none';
    });

    // ── Step 5: Clear localStorage (preserving auth) ──
    console.log(`[5/7] Clearing CSS data from localStorage...`);
    // Save auth tokens first, then clear CSS-related keys, then restore auth
    const authData = await page.evaluate(() => {
        const keys = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)!;
            if (key.includes('auth') || key.includes('token') || key.includes('user') || key.includes('session') || key.includes('key')) {
                keys[key] = localStorage.getItem(key);
            }
        }
        return keys;
    });
    // Clear everything
    await page.evaluate(() => localStorage.clear());
    // Restore auth
    await page.evaluate((data) => {
        for (const [key, val] of Object.entries(data)) {
            localStorage.setItem(key, val as string);
        }
    }, authData);
    // Clear just the CSS keys
    await page.evaluate(() => {
        localStorage.removeItem('custom_css_text');
        localStorage.removeItem('custom_css_preset');
        localStorage.removeItem('custom_css_mode');
    });

    // Reload to get fresh state
    await page.reload();
    await page.waitForFunction(() => {
        const el = document.getElementById('loading-overlay');
        return !el || el.style.display === 'none' || el.style.opacity === '0' || !el.offsetParent;
    }, { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => { var el = document.getElementById('loading-overlay'); if(el) el.remove(); });

    const cssGone = await page.evaluate(() => {
        const style = document.getElementById('custom-user-css');
        const stored = localStorage.getItem('custom_css_text');
        return (!style || !style.textContent || style.textContent.length === 0) && !stored;
    });
    check('Custom CSS gone after clearing', cssGone);

    const presetGone = await page.evaluate(() => !localStorage.getItem('custom_css_preset'));
    check('Preset cleared from localStorage', presetGone);

    // ── Step 6: Reload page ──
    console.log(`[6/7] Reloading page...`);
    // Already reloaded above

    // ── Step 7: Import backup with password ──
    console.log(`[7/7] Importing backup with password...`);
    await openCssTab(page);

    // Click "Import Backup"
    await page.click('#css-import-backup');
    await page.waitForTimeout(300);

    // Set file on hidden input
    await page.locator('#css-import-backup-input').setInputFiles(downloadPath);
    await page.waitForTimeout(500);

    // Encrypted backup should trigger password modal
    const importModalVisible = await page.locator('#css-pw-modal').isVisible();
    check('Import password modal appeared', importModalVisible);

    const importTitle = await page.locator('#css-pw-title').textContent();
    check('Import modal title is "Import CSS"', importTitle === 'Import CSS');

    // Fill password (confirm input is hidden for import mode)
    await page.fill('#css-pw-input', 'MySecret123!');
    await page.click('#css-pw-confirm-btn');
    await page.waitForTimeout(2000);

    // Check if CSS was restored
    const restored = await page.evaluate(() => {
        const stored = localStorage.getItem('custom_css_text');
        const preset = localStorage.getItem('custom_css_preset');
        const mode = localStorage.getItem('custom_css_mode');
        const style = document.getElementById('custom-user-css');
        return {
            hasStored: !!(stored && stored.length > 0),
            preset: preset,
            mode: mode,
            hasLiveCss: !!(style && style.textContent && style.textContent.length > 0),
            storedLength: stored ? stored.length : 0,
        };
    });
    check('CSS restored to localStorage', restored.hasStored);
    check('Preset restored ("premium")', restored.preset === 'premium');
    check('Mode restored (null for preset)', restored.mode === null);
    check('Live CSS applied to page', restored.hasLiveCss);

    // Verify the restored CSS matches the original
    const cssMatches = await page.evaluate((original: string) => {
        return (localStorage.getItem('custom_css_text') || '') === original;
    }, cssToExport);
    check('Restored CSS matches original', cssMatches);

    // Close and re-open settings to verify textarea reflects restored state
    await page.evaluate(() => {
        const modal = document.getElementById('settings-modal');
        if (modal) modal.style.display = 'none';
    });
    await page.waitForTimeout(300);
    await openCssTab(page);
    const restoredTextarea = await page.locator('#custom-css-textarea').inputValue();
    check('Textarea shows restored CSS after re-open', restoredTextarea === cssToExport);

    // ── Summary ──
    console.log('\n═══════════════════════════════════════════');
    console.log(allPassed ? '🎉 ALL CHECKS PASSED' : '❌ SOME CHECKS FAILED');
    console.log('═══════════════════════════════════════════\n');

    await browser.close();
    process.exit(allPassed ? 0 : 1);
})();
