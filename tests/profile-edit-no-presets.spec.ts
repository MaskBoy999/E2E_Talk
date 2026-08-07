import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

async function loginUser(browser, username: string) {
    const page = await browser.newPage();
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
    return page;
}

test.describe('profile edit modal: glow color picker only', () => {
    test('no leftover preset glow swatch grid; color pickers present', async ({ browser }) => {
        const ts = Date.now();
        const page = await loginUser(browser, 'glowedit_' + ts);
        await page.waitForTimeout(1500);

        // Open the profile modal via the footer avatar, then the edit modal.
        await page.click('#footer-user-avatar').catch(() => {});
        await page.waitForSelector('#profile-edit-btn:visible', { timeout: 10000 }).catch(() => {});
        await page.click('#profile-edit-btn').catch(() => {});
        await page.waitForSelector('#profile-edit-modal:visible', { timeout: 10000 });

        const state = await page.evaluate(() => ({
            presetGrid: !!document.getElementById('border-glow-options'),
            glowPicker: !!document.getElementById('profile-edit-glow-color'),
            colorPicker: !!document.getElementById('profile-edit-color'),
            glowHex: !!document.getElementById('profile-edit-glow-color-hex'),
            glowPreview: !!document.getElementById('profile-edit-glow-preview'),
            glowOptionButtons: document.querySelectorAll('.glow-option-btn').length,
            modalVisible: !!document.getElementById('profile-edit-modal') &&
                (document.getElementById('profile-edit-modal') as HTMLElement).style.display !== 'none',
        }));

        expect(state.presetGrid).toBe(false); // the old preset swatch grid is gone
        expect(state.glowOptionButtons).toBe(0); // no preset buttons rendered
        expect(state.glowPicker).toBe(true); // the dedicated color picker remains
        expect(state.colorPicker).toBe(true);
        expect(state.glowHex).toBe(true);
        expect(state.glowPreview).toBe(true);
        expect(state.modalVisible).toBe(true);
    });
});
