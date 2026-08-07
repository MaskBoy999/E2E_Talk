import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// Regression: the login-page wipe (auth.js wipeAllClientData) plus DM-sidebar
// re-renders used to leave the friend-code panel dead after re-login — the
// code value (dataset) was wiped and the button onclick handlers were
// destroyed by renderDmSidebar() without re-binding. loadMyFriendCode() is now
// called at the end of renderDmSidebar so every re-render repopulates it.
test('friend code buttons survive logout + re-login (wipe path) and sidebar re-renders', async ({ page }) => {
    const ts = Date.now();
    const username = 'fcrelogin_' + ts;
    const password = 'password123';

    // Register
    await page.goto(`${BASE}/login.html`);
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', password);
    await page.fill('#register-confirm-password', password);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForTimeout(2000);

    // Simulate logout → login page (wipeAllClientData runs)
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(1200);

    // Re-login
    await page.fill('#login-username', username);
    await page.fill('#login-password', password);
    await page.click('#login-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });

    const sectionState = () => page.evaluate(() => {
        const el = document.getElementById('my-friend-code');
        const getBtn = document.getElementById('get-friend-code-btn');
        const copyBtn = document.getElementById('copy-friend-code-btn');
        return {
            fcLS: localStorage.getItem('e2e_friend_code') || '',
            dataset: el ? el.dataset.value || '' : '',
            getBtnHandler: getBtn ? !!getBtn.onclick : false,
            copyBtnHandler: copyBtn ? !!copyBtn.onclick : false,
        };
    });

    // Give the sidebar time to re-render several times (WS events after re-login)
    await page.waitForTimeout(3000);
    const s1 = await sectionState();
    expect(s1.fcLS, 'e2e_friend_code should be restored from blob after re-login').toBeTruthy();
    expect(s1.dataset, 'friend-code panel should show the restored code').toBe(s1.fcLS);
    expect(s1.getBtnHandler, 'get-friend-code button should be bound').toBe(true);
    expect(s1.copyBtnHandler, 'copy-friend-code button should be bound').toBe(true);

    // Verify it STAYS alive across further re-renders (regression check)
    await page.waitForTimeout(2000);
    const s2 = await sectionState();
    expect(s2.dataset, 'code value must survive later sidebar re-renders').toBe(s2.fcLS);
    expect(s2.getBtnHandler, 'button handlers must survive later sidebar re-renders').toBe(true);
});
