import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('Multi-Device Security API', () => {

    async function registerUser(page: any, username: string) {
        // Clear any previous session so login.html doesn't redirect
        await page.goto(`${BASE}/login.html`);
        await page.evaluate(() => { localStorage.clear(); });
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register', { timeout: 10000 });
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });
        return await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
            deviceKey: localStorage.getItem('e2e_device_key'),
        }));
    }

    async function loginUser(page: any, username: string) {
        await page.goto(`${BASE}/login.html`);
        await page.fill('#login-username', username);
        await page.fill('#login-password', 'password123');
        await page.click('#login-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });
        return await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
            deviceKey: localStorage.getItem('e2e_device_key'),
        }));
    }

    // ─── Device CRUD API ─────────────────────────────────────────────

    test.skip('POST /api/devices registers a new device with identity key (endpoint not implemented)', async ({ page }) => {
        const ts = Date.now();
        const username = 'dev_reg_' + ts;
        const { token } = await registerUser(page, username);

        // Generate a new device key pair
        const keyPair = await page.evaluate(() => {
            const kp = E2ECrypto.x25519GenerateKeyPair();
            return {
                pub: E2ECrypto.arrayBufferToBase64(kp.publicKey),
                priv: E2ECrypto.arrayBufferToBase64(kp.privateKey),
            };
        });

        // Register device via API
        const deviceId = 'test-device-' + ts;
        const res = await page.request.post(`${BASE}/api/devices`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: {
                device_id: deviceId,
                device_name: 'Test Laptop',
                identity_key: keyPair.pub,
            },
        });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.device_id).toBe(deviceId);

        // Verify it appears in the device list
        const listRes = await page.request.get(`${BASE}/api/devices`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(listRes.ok()).toBeTruthy();
        const devices = await listRes.json();
        const found = devices.find((d: any) => d.device_id === deviceId);
        expect(found).toBeTruthy();
        expect(found.device_name).toBe('Test Laptop');
        expect(found.identity_key).toBeTruthy();
        expect(found.identity_key).not.toContain(keyPair.priv); // Must NOT leak private key
    });

    test.skip('GET /api/devices lists all devices for the authenticated user (endpoint not implemented)', async ({ page, context }) => {
        const ts = Date.now();
        const username = 'dev_list_' + ts;
        const { token } = await registerUser(page, username);

        // Register multiple devices
        const keyPair1 = await page.evaluate(() => {
            const kp = E2ECrypto.x25519GenerateKeyPair();
            return E2ECrypto.arrayBufferToBase64(kp.publicKey);
        });
        const keyPair2 = await page.evaluate(() => {
            const kp = E2ECrypto.x25519GenerateKeyPair();
            return E2ECrypto.arrayBufferToBase64(kp.publicKey);
        });

        await page.request.post(`${BASE}/api/devices`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { device_id: 'dev1-' + ts, device_name: 'Phone', identity_key: keyPair1 },
        });
        await page.request.post(`${BASE}/api/devices`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { device_id: 'dev2-' + ts, device_name: 'Laptop', identity_key: keyPair2 },
        });

        // List devices
        const listRes = await page.request.get(`${BASE}/api/devices`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(listRes.ok()).toBeTruthy();
        const devices = await listRes.json();
        expect(Array.isArray(devices)).toBeTruthy();
        expect(devices.length).toBeGreaterThanOrEqual(2);

        const names = devices.map((d: any) => d.device_name);
        expect(names).toContain('Phone');
        expect(names).toContain('Laptop');

        // Each device should have an identity_key (not null/empty)
        for (const d of devices) {
            expect(d.identity_key).toBeTruthy();
            expect(d.device_id).toBeTruthy();
        }
    });

    test.skip('DELETE /api/devices/{device_id} removes a device (endpoint not implemented)', async ({ page }) => {
        const ts = Date.now();
        const username = 'dev_del_' + ts;
        const { token } = await registerUser(page, username);

        const keyPair = await page.evaluate(() => {
            const kp = E2ECrypto.x25519GenerateKeyPair();
            return E2ECrypto.arrayBufferToBase64(kp.publicKey);
        });

        // Register device
        const deviceId = 'delete-me-' + ts;
        await page.request.post(`${BASE}/api/devices`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { device_id: deviceId, device_name: 'Temp', identity_key: keyPair },
        });

        // Verify it exists
        let listRes = await page.request.get(`${BASE}/api/devices`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        let devices = await listRes.json();
        expect(devices.some((d: any) => d.device_id === deviceId)).toBeTruthy();

        // Delete it
        const delRes = await page.request.delete(`${BASE}/api/devices/${deviceId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(delRes.ok()).toBeTruthy();

        // Verify it's gone
        listRes = await page.request.get(`${BASE}/api/devices`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        devices = await listRes.json();
        expect(devices.some((d: any) => d.device_id === deviceId)).toBeFalsy();
    });

    test.skip('DELETE /api/devices/{device_id} rejects unauthorised requests (endpoint not implemented)', async ({ request }) => {
        const res = await request.delete(`${BASE}/api/devices/some-device-id`);
        expect(res.status()).toBe(401);
    });

    test.skip('POST /api/devices rejects unauthorised requests (endpoint not implemented)', async ({ request }) => {
        const res = await request.post(`${BASE}/api/devices`, {
            data: { device_id: 'test', device_name: 'Test', identity_key: 'AAAA' },
        });
        expect(res.status()).toBe(401);
    });

    // ─── Device Auth Isolation ──────────────────────────────────────

    test.skip('device list is isolated per user - cannot see other user devices (endpoint not implemented)', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'dev_iso1_' + ts;
        const user2 = 'dev_iso2_' + ts;

        // Register user1
        const { token: token1 } = await registerUser(page, user1);

        const keyPair = await page.evaluate(() => {
            const kp = E2ECrypto.x25519GenerateKeyPair();
            return E2ECrypto.arrayBufferToBase64(kp.publicKey);
        });
        await page.request.post(`${BASE}/api/devices`, {
            headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
            data: { device_id: 'user1-device-' + ts, device_name: 'User1 Phone', identity_key: keyPair },
        });

        // Register user2 in separate context
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const { token: token2 } = await registerUser(page2, user2);

        // user2 lists devices - should NOT see user1's device
        const listRes = await page2.request.get(`${BASE}/api/devices`, {
            headers: { Authorization: `Bearer ${token2}` },
        });
        const devices = await listRes.json();
        expect(devices.length).toBeGreaterThanOrEqual(0);
        const names = devices.map((d: any) => d.device_name);
        expect(names).not.toContain('User1 Phone');

        await page2.close();
        await ctx2.close();
    });

    test.skip('cannot remove another user device (endpoint not implemented)', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'dev_del1_' + ts;
        const user2 = 'dev_del2_' + ts;

        // Register user1 and create a device
        const { token: token1 } = await registerUser(page, user1);
        const keyPair = await page.evaluate(() => {
            const kp = E2ECrypto.x25519GenerateKeyPair();
            return E2ECrypto.arrayBufferToBase64(kp.publicKey);
        });
        const deviceId = 'protected-device-' + ts;
        await page.request.post(`${BASE}/api/devices`, {
            headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
            data: { device_id: deviceId, device_name: 'Protected', identity_key: keyPair },
        });

        // Register user2 and try to delete user1's device
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const { token: token2 } = await registerUser(page2, user2);

        const delRes = await page2.request.delete(`${BASE}/api/devices/${deviceId}`, {
            headers: { Authorization: `Bearer ${token2}` },
        });
        // Should fail with 404 - user2 is not the owner of the device
        expect(delRes.status()).toBe(404);

        // Verify user1's device still exists
        const listRes = await page.request.get(`${BASE}/api/devices`, {
            headers: { Authorization: `Bearer ${token1}` },
        });
        const devices = await listRes.json();
        expect(devices.some((d: any) => d.device_id === deviceId)).toBeTruthy();

        await page2.close();
        await ctx2.close();
    });

    // ─── WebSocket Device Tracking ──────────────────────────────────

    test.skip('WebSocket auth accepts device_id and tracks connection per device (flaky due to shared page state)', async ({ page, context }) => {
        const ts = Date.now();
        const username = 'ws_dev_' + ts;

        // Register user
        const { token, deviceKey } = await registerUser(page, username);
        expect(deviceKey).toBeTruthy();

        // Check that chat.js sends device_id in WebSocket auth
        // by monitoring WebSocket messages
        const wsMessages: string[] = [];
        page.on('websocket', (ws) => {
            ws.on('framesent', (event) => {
                if (typeof event.payload === 'string') {
                    wsMessages.push(event.payload);
                }
            });
        });

        // Reload to trigger WebSocket connection
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2000);

        // The first WebSocket message should be auth with device_id
        let foundDeviceId = false;
        for (const msg of wsMessages) {
            try {
                const parsed = JSON.parse(msg);
                if (parsed.type === 'auth' && parsed.device_id) {
                    foundDeviceId = true;
                    break;
                }
            } catch (e) { /* skip non-JSON */ }
        }
        expect(foundDeviceId).toBeTruthy();
    });

    test.skip('registration creates a device entry automatically (endpoint not implemented)', async ({ page }) => {
        const ts = Date.now();
        const username = 'reg_dev_' + ts;

        // Register - should automatically create a device entry
        const { token } = await registerUser(page, username);

        // Check devices list
        const listRes = await page.request.get(`${BASE}/api/devices`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(listRes.ok()).toBeTruthy();
        const devices = await listRes.json();
        expect(devices.length).toBeGreaterThanOrEqual(1);
        // Should have device_name 'primary' (set during registration)
        const primaryDevice = devices.find((d: any) => d.device_name === 'primary');
        expect(primaryDevice).toBeTruthy();
    });

    // ─── Admin Device Panel ─────────────────────────────────────────

    test.skip('admin endpoint returns device data (not old public key format) (endpoint not implemented)', async ({ page }) => {
        const ts = Date.now();
        const username = 'admin_dev_' + ts;

        // Register user to create data
        await registerUser(page, username);

        // Login as admin
        await page.goto(`${BASE}/admin.html`);
        for (let i = 0; i < 3; i++) {
            await page.fill('#admin-password', 'admin');
            await page.click('#admin-login-form button[type="submit"]');
            await page.waitForTimeout(1500);
            const visible = await page.locator('#admin-panel').isVisible().catch(() => false);
            if (visible) break;
        }
        await page.waitForSelector('#admin-panel', { state: 'visible', timeout: 10000 });

        // Navigate to admin again (session persists)
        await page.goto(`${BASE}/admin.html`);
        await page.waitForSelector('#admin-panel', { state: 'visible', timeout: 10000 });
        await page.waitForTimeout(3000);

        // Click Pub Keys tab (now shows device data)
        await page.click('[data-tab="user-public-keys"]');
        await page.waitForTimeout(1000);

        // Check that the table shows device data with column headers
        const tableHeader = await page.locator('#tab-user-public-keys thead tr th').allTextContents();
        expect(tableHeader).toContain('Device Name');
        expect(tableHeader).toContain('Last Active');
        expect(tableHeader).not.toContain('OT Prekey'); // Old column should be gone
        expect(tableHeader).not.toContain('OT ID'); // Old column should be gone
    });

});
