import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(500);
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
            await page.fill('#register-confirm-password', 'password123');
await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
        friendCode: localStorage.getItem('e2e_friend_code'),
    }));
}

// Show a modal, then close by clicking the backdrop (top-left corner of the modal overlay)
async function showModalVerifyBackdropClick(page: any, modalId: string): Promise<boolean> {
    const modal = page.locator(`#${modalId}`);
    await expect(modal).toBeVisible({ timeout: 5000 });
    // The .modal fills the viewport — click at (5, 5) to hit the backdrop
    await page.mouse.click(5, 5);
    await page.waitForTimeout(400);
    const visible = await page.isVisible(`#${modalId}`).catch(() => false);
    return !visible;
}

// Show a modal, then close with Escape key
async function showModalVerifyEscape(page: any, modalId: string): Promise<boolean> {
    await expect(page.locator(`#${modalId}`)).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const visible = await page.isVisible(`#${modalId}`).catch(() => false);
    return !visible;
}

// ============================================================
// MODAL BACKDROP CLICK-OFF
// ============================================================
test.describe('Modal Backdrop Click-Off', () => {

    test('settings modal closes on backdrop click', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'bd_settings_' + ts);
        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        expect(await showModalVerifyBackdropClick(page, 'settings-modal')).toBeTruthy();
    });

    test('add friend modal closes on backdrop click', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'bd_addfriend_' + ts);
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(1500);
        await page.waitForSelector('#add-friend-btn', { timeout: 5000 }).catch(() => {});
        await page.click('#add-friend-btn');
        await page.waitForSelector('#add-friend-modal', { state: 'visible', timeout: 5000 });
        expect(await showModalVerifyBackdropClick(page, 'add-friend-modal')).toBeTruthy();
    });

    test('server choice modal closes on backdrop click', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'bd_choice_' + ts);
        await page.click('#add-server-btn');
        await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
        expect(await showModalVerifyBackdropClick(page, 'server-choice-modal')).toBeTruthy();
    });

    test('create server modal closes on backdrop click', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'bd_createsrv_' + ts);
        await page.click('#add-server-btn');
        await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
        await page.click('#choice-create-server');
        await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 5000 });
        expect(await showModalVerifyBackdropClick(page, 'create-server-modal')).toBeTruthy();
    });

    test('join server modal closes on backdrop click', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'bd_joinsrv_' + ts);
        await page.click('#add-server-btn');
        await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
        await page.click('#choice-join-server');
        await page.waitForSelector('#join-server-modal', { state: 'visible', timeout: 5000 });
        expect(await showModalVerifyBackdropClick(page, 'join-server-modal')).toBeTruthy();
    });
});

// ============================================================
// ESCAPE KEY CLOSE MODALS
// ============================================================
test.describe('Escape Key Closes Modals', () => {

    test('settings modal closes on Escape key', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'esc_settings_' + ts);
        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        expect(await showModalVerifyEscape(page, 'settings-modal')).toBeTruthy();
    });

    test('add friend modal closes on Escape key', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'esc_addfriend_' + ts);
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(1500);
        await page.waitForSelector('#add-friend-btn', { timeout: 5000 }).catch(() => {});
        await page.click('#add-friend-btn');
        await page.waitForSelector('#add-friend-modal', { state: 'visible', timeout: 5000 });
        expect(await showModalVerifyEscape(page, 'add-friend-modal')).toBeTruthy();
    });

    test('server choice modal closes on Escape key', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'esc_choice_' + ts);
        await page.click('#add-server-btn');
        await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
        expect(await showModalVerifyEscape(page, 'server-choice-modal')).toBeTruthy();
    });
});

// ============================================================
// STICKER UPLOAD PANEL CANCEL BUTTON
// ============================================================
test.describe('Sticker Upload Panel Cancel Button', () => {

    test('upload tab shows cancel button that closes sticker panel', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'sticker_cancel_' + ts);

        const stickerBtn = page.locator('#sticker-btn');
        await stickerBtn.click();
        await page.waitForTimeout(500);

        // Switch to Upload tab
        const uploadTab = page.locator('.sticker-tab[data-tab="upload"]');
        await expect(uploadTab).toBeVisible({ timeout: 3000 });
        await uploadTab.click();
        await page.waitForTimeout(500);

        // Verify cancel button exists in the upload panel
        const cancelBtn = page.locator('#sticker-upload-cancel-btn');
        await expect(cancelBtn).toBeVisible({ timeout: 3000 });
        expect(await cancelBtn.textContent()).toContain('Cancel');

        // Click cancel
        await cancelBtn.click();
        await page.waitForTimeout(500);

        // Verify sticker panel is now closed
        expect(await page.isVisible('#sticker-panel').catch(() => false)).toBeFalsy();
    });

    test('cancel button is only visible on upload tab', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'sticker_cancel2_' + ts);

        const stickerBtn = page.locator('#sticker-btn');
        await stickerBtn.click();
        await page.waitForTimeout(500);

        // Cancel button should NOT be visible on emoji tab
        const emojiTab = page.locator('.sticker-tab[data-tab="emojis"]');
        await emojiTab.click();
        await page.waitForTimeout(300);
        expect(await page.isVisible('#sticker-upload-cancel-btn').catch(() => false)).toBeFalsy();

        // Switch to upload tab — cancel SHOULD be visible
        const uploadTab = page.locator('.sticker-tab[data-tab="upload"]');
        await uploadTab.click();
        await page.waitForTimeout(300);
        expect(await page.isVisible('#sticker-upload-cancel-btn').catch(() => false)).toBeTruthy();

        await stickerBtn.click();
    });
});

// ============================================================
// ENCRYPTED FRIEND CODE
// ============================================================
test.describe('Encrypted Friend Code', () => {

    test('friend code is stored encrypted on server after registration', async ({ page }) => {
        const ts = Date.now();
        const username = 'encfc_reg_' + ts;
        const body = await registerUser(page, username);
        expect(body.token).toBeTruthy();
        expect(body.friendCode).toBeTruthy();

        // Fetch encrypted friend code from server via API
        const fcRes = await page.request.get(`${BASE}/api/friend-code`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });
        expect(fcRes.ok()).toBeTruthy();
        const fcData = await fcRes.json();

        // Server should return encrypted data, NOT plaintext
        expect(fcData.encrypted_friend_code).toBeTruthy();
        expect(fcData.salt).toBeTruthy();
        expect(fcData.nonce).toBeTruthy();
        expect(fcData.friend_code).toBeUndefined();

        // Encrypted blob should differ from the plaintext code
        expect(fcData.encrypted_friend_code).not.toBe(body.friendCode);

        // Decrypt with password and verify it matches
        const decrypted = await page.evaluate(({ encrypted, salt, nonce }) => {
            if (typeof E2ECrypto.decryptWithPassword !== 'function') return null;
            return E2ECrypto.decryptWithPassword(encrypted, 'password123', salt, nonce);
        }, { encrypted: fcData.encrypted_friend_code, salt: fcData.salt, nonce: fcData.nonce });

        expect(decrypted).toBe(body.friendCode);
    });

    test('friend code password modal opens on recover button click', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'encfc_modal_' + ts);

        await page.click('#dm-strip-btn');
        await page.waitForTimeout(2000);

        const recoverBtn = page.locator('#recover-friend-code-btn');
        await expect(recoverBtn).toBeVisible({ timeout: 5000 });
        await recoverBtn.click();
        await page.waitForTimeout(500);

        // Verify the password modal opened with all expected elements
        await expect(page.locator('#friend-code-password-modal')).toBeVisible({ timeout: 3000 });
        await expect(page.locator('#fc-password-input')).toBeVisible({ timeout: 3000 });
        await expect(page.locator('#fc-recover-btn')).toBeVisible({ timeout: 3000 });
        await expect(page.locator('#fc-regenerate-btn')).toBeVisible({ timeout: 3000 });

        // Close via cancel button (cleaner than backdrop for this test)
        await page.locator('#fc-cancel-btn').click();
        await page.waitForTimeout(300);
        expect(await page.isVisible('#friend-code-password-modal').catch(() => false)).toBeFalsy();
    });

    test('recover friend code with correct password works via modal', async ({ page }) => {
        const ts = Date.now();
        const username = 'encfc_recover_' + ts;
        await registerUser(page, username);

        // Clear localStorage to simulate lost friend code
        await page.evaluate(() => localStorage.removeItem('e2e_friend_code'));

        await page.click('#dm-strip-btn');
        await page.waitForTimeout(2000);

        await page.locator('#recover-friend-code-btn').click();
        await page.waitForTimeout(500);
        await page.locator('#fc-password-input').fill('password123');
        await page.locator('#fc-recover-btn').click();

        // Success appears and auto-closes after 2 seconds — check immediately
        const successEl = page.locator('#fc-password-success');
        await expect(successEl).toBeVisible({ timeout: 5000 });
        expect(await successEl.textContent()).toContain('recovered');

        // Wait for modal to auto-close
        await page.waitForTimeout(3000);

        // Verify friend code is back in localStorage
        const restoredFC = await page.evaluate(() => localStorage.getItem('e2e_friend_code'));
        expect(restoredFC).toBeTruthy();
        expect(restoredFC!.length).toBe(8);

        // Toggle display to verify the code shows in the UI
        await page.locator('#toggle-friend-code-btn').click();
        await page.waitForTimeout(300);
        const displayValue = await page.locator('#my-friend-code').getAttribute('data-value');
        expect(displayValue).toBe(restoredFC);
    });

    test('recover friend code with wrong password shows error', async ({ page }) => {
        const ts = Date.now();
        const username = 'encfc_wrongpw_' + ts;
        await registerUser(page, username);

        // Clear localStorage so recovery is needed
        await page.evaluate(() => localStorage.removeItem('e2e_friend_code'));

        await page.click('#dm-strip-btn');
        await page.waitForTimeout(2000);
        await page.locator('#recover-friend-code-btn').click();
        await page.waitForTimeout(500);
        await page.locator('#fc-password-input').fill('wrongpassword');
        await page.locator('#fc-recover-btn').click();
        await page.waitForTimeout(1500);

        // Error message should be visible (it does NOT auto-close)
        const errorEl = page.locator('#fc-password-error');
        await expect(errorEl).toBeVisible({ timeout: 5000 });
        expect(await errorEl.textContent()).toContain('Wrong password');

        await page.locator('#fc-cancel-btn').click();
        await page.waitForTimeout(300);
    });

    test('regenerate friend code with password creates new valid code', async ({ page }) => {
        const ts = Date.now();
        const username = 'encfc_regen_' + ts;
        const body = await registerUser(page, username);
        const oldFC = body.friendCode;
        expect(oldFC).toBeTruthy();

        // Set up dialog handler BEFORE clicking (Playwright auto-dismisses by default, we need accept)
        page.on('dialog', dialog => {
            console.log('Dialog:', dialog.message());
            dialog.accept();
        });

        await page.click('#dm-strip-btn');
        await page.waitForTimeout(2000);
        await page.locator('#recover-friend-code-btn').click();
        await page.waitForTimeout(500);
        await page.locator('#fc-password-input').fill('password123');
        await page.locator('#fc-regenerate-btn').click();

        // Success appears and auto-closes after 2 seconds
        const successEl = page.locator('#fc-password-success');
        await expect(successEl).toBeVisible({ timeout: 10000 });
        expect(await successEl.textContent()).toContain('generated');

        // Wait for modal to close
        await page.waitForTimeout(3000);

        const newFC = await page.evaluate(() => localStorage.getItem('e2e_friend_code'));
        expect(newFC).toBeTruthy();
        expect(newFC!.length).toBe(8);
        expect(newFC).not.toBe(oldFC);

        await page.locator('#toggle-friend-code-btn').click();
        await page.waitForTimeout(300);
        const displayValue = await page.locator('#my-friend-code').getAttribute('data-value');
        expect(displayValue).toBe(newFC);
    });

    test('server returns encrypted format (not plaintext) for friend code endpoint', async ({ page }) => {
        const ts = Date.now();
        const username = 'encfc_format_' + ts;
        const body = await registerUser(page, username);
        expect(body.token).toBeTruthy();

        const fcRes = await page.request.get(`${BASE}/api/friend-code`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });
        const data = await fcRes.json();

        expect(typeof data.encrypted_friend_code).toBe('string');
        expect(data.encrypted_friend_code.length).toBeGreaterThan(20);
        expect(typeof data.salt).toBe('string');
        expect(data.salt.length).toBeGreaterThan(10);
        expect(typeof data.nonce).toBe('string');
        expect(data.nonce.length).toBeGreaterThan(10);
        expect(data.friend_code).toBeUndefined();
    });
});

// ============================================================
// FRIEND CODE PASSWORD MODAL
// ============================================================
test.describe('Friend Code Password Modal', () => {

    test('password modal closes on backdrop click', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'fcmodal_bd_' + ts);
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(2000);
        await page.locator('#recover-friend-code-btn').click();
        await page.waitForTimeout(500);

        await expect(page.locator('#friend-code-password-modal')).toBeVisible({ timeout: 3000 });
        expect(await showModalVerifyBackdropClick(page, 'friend-code-password-modal')).toBeTruthy();
    });

    test('password modal closes on cancel button', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'fcmodal_cancel_' + ts);
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(2000);
        await page.locator('#recover-friend-code-btn').click();
        await page.waitForTimeout(500);

        await expect(page.locator('#friend-code-password-modal')).toBeVisible({ timeout: 3000 });
        await page.locator('#fc-cancel-btn').click();
        await page.waitForTimeout(300);
        expect(await page.isVisible('#friend-code-password-modal').catch(() => false)).toBeFalsy();
    });

    test('password modal closes on Escape key', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'fcmodal_esc_' + ts);
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(2000);
        await page.locator('#recover-friend-code-btn').click();
        await page.waitForTimeout(500);

        await expect(page.locator('#friend-code-password-modal')).toBeVisible({ timeout: 3000 });
        expect(await showModalVerifyEscape(page, 'friend-code-password-modal')).toBeTruthy();
    });

    test('password modal Enter key triggers recover', async ({ page }) => {
        const ts = Date.now();
        const username = 'fcmodal_enter_' + ts;
        await registerUser(page, username);

        await page.evaluate(() => localStorage.removeItem('e2e_friend_code'));

        await page.click('#dm-strip-btn');
        await page.waitForTimeout(2000);
        await page.locator('#recover-friend-code-btn').click();
        await page.waitForTimeout(500);
        await page.locator('#fc-password-input').fill('password123');
        await page.keyboard.press('Enter');

        // Success auto-closes after 2s — check immediately
        const successEl = page.locator('#fc-password-success');
        await expect(successEl).toBeVisible({ timeout: 5000 });
        expect(await successEl.textContent()).toContain('recovered');
    });
});
