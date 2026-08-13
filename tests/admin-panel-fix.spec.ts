import { test, expect } from '@playwright/test';

test.describe('Admin Panel - data endpoints return 200, not 500', () => {

  test('Admin endpoints return 200, not 500', async ({ page }) => {
    // Track HTTP responses with status >= 400 on ANY admin endpoint
    const badResponses: { url: string; status: number }[] = [];
    page.on('response', response => {
      if (response.status() >= 400 && response.url().includes('/api/admin/')) {
        badResponses.push({ url: response.url(), status: response.status() });
      }
    });

    // Navigate to admin panel
    await page.goto('/admin.html');
    await page.waitForSelector('#admin-login-form', { timeout: 10000 });

    // Try 'admin' as password first (from earlier setup), then 'admin123'
    const passwordField = page.locator('#admin-password');
    const loginBtn = page.locator('#admin-login-btn');

    for (const pw of ['admin', 'admin123']) {
      // Fill password and submit
      await passwordField.fill(pw);
      await loginBtn.click();
      await page.waitForTimeout(1000);

      // Check if the admin panel appeared (login succeeded)
      const panel = page.locator('#admin-panel');
      const visible = await panel.isVisible().catch(() => false);
      if (visible) break;

      // If subtitle says "Set admin password", the password was set
      const subtitle = await page.textContent('#admin-login-subtitle').catch(() => '');
      if (subtitle && subtitle.includes('set')) {
        // Password was set, login again
        await passwordField.fill(pw);
        await loginBtn.click();
        await page.waitForTimeout(1000);
        const panel2 = await page.locator('#admin-panel').isVisible().catch(() => false);
        if (panel2) break;
      }

      // Check for error message
      const errorText = await page.textContent('#error-message').catch(() => '');
      if (errorText && errorText.includes('Wrong password')) {
        continue; // Try next password
      }
    }

    // Wait for admin panel to be visible
    await expect(page.locator('#admin-panel')).toBeVisible({ timeout: 5000 });
    await page.waitForLoadState('networkidle');

    // No admin endpoint may 400+ (regression: dm-keys used to 500)
    expect(badResponses.length,
      `No 400+ responses on admin endpoints. Got: ${JSON.stringify(badResponses)}`).toBe(0);

    // Directly verify the dm-keys endpoint (it has no tab in the panel)
    const adminToken = await page.evaluate(() => sessionStorage.getItem('admin_token'));
    const dmKeysRes = await page.request.get('/api/admin/dm-keys', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(dmKeysRes.status()).toBe(200);

    // Click real data tabs and verify the tables render
    await page.locator('.tab-btn[data-tab="server-keys"]').click();
    await expect(page.locator('#server-key-list')).toBeVisible();
    await page.locator('.tab-btn[data-tab="dm-channels"]').click();
    await expect(page.locator('#dm-channel-list')).toBeVisible();
  });

});
