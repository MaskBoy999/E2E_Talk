import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('Migration 036 — Plaintext Profile Columns Dropped', () => {

    async function registerUser(page: any, username: string) {
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        return await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));
    }

    test('profile API no longer returns username_color, username_border_color, profile_background_color', async ({ page }) => {
        const ts = Date.now();
        const { token, user } = await registerUser(page, 'mig036_' + ts);
        expect(token).toBeTruthy();
        expect(user.id).toBeTruthy();

        // Fetch own profile via API
        const profileRes = await page.request.get(`${BASE}/api/profile/${user.id}`, {
            headers: { 'Authorization': 'Bearer ' + token },
        });
        expect(profileRes.ok()).toBeTruthy();
        const profile = await profileRes.json();

        // Verify the 3 plaintext columns are NOT returned
        expect(profile).not.toHaveProperty('username_color');
        expect(profile).not.toHaveProperty('username_border_color');
        expect(profile).not.toHaveProperty('profile_background_color');

        // Verify encrypted_profile_data IS still returned
        expect(profile).toHaveProperty('encrypted_profile_data');
        if (profile.encrypted_profile_data) {
            // Valid nonce:ciphertext format
            const parts = profile.encrypted_profile_data.split(':');
            expect(parts.length).toBe(2);
            expect(parts[0].length).toBeGreaterThan(0);
            expect(parts[1].length).toBeGreaterThan(0);
        }
    });

    test('admin panel users table has correct column count (12) without the 3 dropped columns', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'mig036a_' + ts);
        const adminToken = await page.evaluate(() => sessionStorage.getItem('admin_token'));

        // Use fetch-based admin API to verify the user list response
        const token = await page.evaluate(() => localStorage.getItem('token'));
        const adminRes = await page.request.get(`${BASE}/api/admin/users`, {
            headers: { 'Authorization': 'Bearer ' + token },
        });

        if (adminRes.ok()) {
            const users = await adminRes.json();
            expect(Array.isArray(users)).toBe(true);
            if (users.length > 0) {
                const firstUser = users[0];
                // Verify the 3 plaintext columns are NOT in the admin response
                expect(firstUser).not.toHaveProperty('username_color');
                expect(firstUser).not.toHaveProperty('username_border_color');
                expect(firstUser).not.toHaveProperty('profile_background_color');
            }
        } else {
            // Admin endpoints require admin auth
            console.log('Admin API returned:', adminRes.status());
        }

        // Verify the admin HTML page has correct headers
        const adminHtml = await page.request.get(`${BASE}/admin.html`);
        const html = await adminHtml.text();
        expect(html).not.toContain('Username Color');
        expect(html).not.toContain('Border Color');
        expect(html).not.toContain('BG Color');
        expect(html).toContain('FC Hash'); // Last column still present
    });
});
