import { test, expect } from '@playwright/test';

test.describe('Admin Panel - Sessions & DM Keys tabs', () => {

  test('Sessions and DM Keys endpoints return 200, not 500', async ({ page }) => {
    // Track HTTP responses with status >= 400
    const badResponses: { url: string; status: number }[] = [];
    page.on('response', response => {
      if (response.status() >= 400) {
        const url = response.url();
        if (url.includes('/api/admin/sessions') || url.includes('/api/admin/dm-keys')) {
          badResponses.push({ url, status: response.status() });
        }
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

    // Verify no 400+ errors on sessions or dm-keys endpoints
    expect(badResponses.length,
      `No 400+ responses for sessions/dm-keys. Got: ${JSON.stringify(badResponses)}`).toBe(0);

    // Click Sessions tab and verify table renders
    await page.locator('.tab-btn[data-tab="sessions"]').click();
    await expect(page.locator('#session-list')).toBeVisible();

    // Wait for sessions data fetch
    await page.waitForTimeout(500);

    // Click DM Keys tab and verify table renders
    await page.locator('.tab-btn[data-tab="dm-keys"]').click();
    await expect(page.locator('#dm-key-list')).toBeVisible();
  });

});
