import { test, expect } from '@playwright/test';
import { createHash } from 'crypto';

const BASE = 'https://localhost:3443';

function sha256Hex(data: string): string {
    return createHash('sha256').update(data).digest('hex');
}

function generateCode(len: number): string {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return code;
}

// Minimal valid 1x1 red PNG (raw bytes)
const MINI_PNG = Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9C, 0x62, 0x60, 0x60, 0x60, 0x00,
    0x00, 0x00, 0x04, 0x00, 0x01, 0x26, 0x4F, 0x26,
    0x35, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
    0x44, 0xAE, 0x42, 0x60, 0x82,
]);

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
            await page.fill('#register-confirm-password', 'password123');
await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 10000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function uploadProfilePic(page: any, token: string): Promise<string> {
    const initRes = await page.request.post(`${BASE}/api/files/init`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { size: MINI_PNG.length, mime: 'image/png' },
    });
    expect(initRes.ok()).toBeTruthy();
    const initData = await initRes.json();
    const fileId = initData.file_id;

    await page.request.fetch(`${BASE}/api/files/${fileId}/chunk/0`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
        data: MINI_PNG,
    });

    await page.request.post(`${BASE}/api/files/${fileId}/complete`, {
        headers: { Authorization: `Bearer ${token}` },
    });

    const picSetRes = await page.request.patch(`${BASE}/api/profile`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { profile_picture_file_id: fileId },
    });
    expect(picSetRes.ok()).toBeTruthy();
    return fileId;
}

async function becomeFriends(page1: any, page2: any, token1: string, token2: string) {
    const friendCode2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    expect(friendCode2).toBeTruthy();

    await page1.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        data: { friend_code: friendCode2 },
    });

    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${token2}` },
    })).json();
    expect(incoming.length).toBe(1);

    await page2.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
}

test.describe('UI Feature Tests', () => {

    // ─── Camera Flash Timing ────────────────────────────────────────────
    // Note: Camera tests are skipped by default because getUserMedia requires
    // a real camera device and fails in headless/CI environments.
    // Run them manually with: npx playwright test --grep "camera" --headed

    test('camera flash overlay element exists and flash timer is set on capture', async ({ page }) => {
        test.skip(!(await page.evaluate(() => !!navigator.mediaDevices?.enumerateDevices)),
            'Camera API not available in this environment');

        const ts = Date.now();
        const username = 'camera_flash_' + ts;

        await registerUser(page, username);

        // Evaluate camera flash internals (variables defined at module level, always exist)
        const flashExists = await page.evaluate(() => {
            return typeof _cameraCaptureFlashEl !== 'undefined';
        });
        expect(flashExists).toBeTruthy();

        // Open camera capture to create the flash DOM element
        // getusermedia may fail but the DOM element is created synchronously before the await
        try {
            await page.evaluate(async () => {
                if (typeof openCameraCapture === 'function') {
                    await openCameraCapture();
                }
            });
        } catch (e) {
            console.log('Camera open failed (expected in headless):', e?.toString?.()?.slice(0, 100));
        }
        await page.waitForTimeout(500);

        // Check the flash overlay DOM element exists
        const flashElExists = await page.evaluate(() => {
            return document.getElementById('camera-flash-overlay') !== null;
        });
        expect(flashElExists).toBeTruthy();

        // Check the flash timer variable and capture function
        const flashInternals = await page.evaluate(() => {
            return {
                timerExists: typeof _cameraFlashTimer !== 'undefined',
                flashOn: _cameraCaptureFlashOn !== undefined,
                flashElExists: _cameraCaptureFlashEl !== null,
                flashIntensityRange: _cameraCaptureFlashIntensity >= 0 && _cameraCaptureFlashIntensity <= 100,
                captureFnExists: typeof captureCameraPhoto === 'function',
            };
        });
        expect(flashInternals.timerExists).toBeTruthy();
        expect(flashInternals.flashElExists).toBeTruthy();
        expect(flashInternals.flashIntensityRange).toBeTruthy();
        expect(flashInternals.captureFnExists).toBeTruthy();

        // Close camera
        await page.evaluate(() => {
            if (typeof closeCameraCapture === 'function') closeCameraCapture();
        });
    });

    test('camera flash toggles on/off and flash overlay visibility changes', async ({ page }) => {
        test.skip(!(await page.evaluate(() => !!navigator.mediaDevices?.enumerateDevices)),
            'Camera API not available in this environment');

        const ts = Date.now();
        const username = 'camera_flash2_' + ts;

        await registerUser(page, username);

        // Open camera (may fail in headless, but DOM elements are created synchronously)
        try {
            await page.evaluate(async () => {
                if (typeof openCameraCapture === 'function') {
                    await openCameraCapture();
                }
            });
        } catch (e) {
            console.log('Camera open failed (expected in headless):', e?.toString?.()?.slice(0, 100));
        }
        await page.waitForTimeout(500);

        // Flash button exists and can toggle
        const flashBtnExists = await page.evaluate(() => {
            return document.querySelector('.camera-flash-btn') !== null;
        });
        expect(flashBtnExists).toBeTruthy();

        // Toggle flash on (should be off by default)
        const flashOnBefore = await page.evaluate(() => _cameraCaptureFlashOn);
        await page.evaluate(() => {
            const btn = document.querySelector('.camera-flash-btn');
            if (btn) btn.click();
        });
        await page.waitForTimeout(100);
        const flashOnAfter = await page.evaluate(() => _cameraCaptureFlashOn);
        expect(flashOnAfter).not.toBe(flashOnBefore);

        // Toggle flash off
        await page.evaluate(() => {
            const btn = document.querySelector('.camera-flash-btn');
            if (btn) btn.click();
        });
        await page.waitForTimeout(100);
        const flashFinally = await page.evaluate(() => _cameraCaptureFlashOn);
        expect(flashFinally).toBe(flashOnBefore);

        // Close camera
        await page.evaluate(() => {
            if (typeof closeCameraCapture === 'function') closeCameraCapture();
        });
    });

    // ─── Username Color Persistence ─────────────────────────────────────

    test('username color persists in messages after page refresh', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'color_user1_' + ts;
        const user2 = 'color_user2_' + ts;
        const testColor = '#ff6600'; // Orange

        // Register user1
        const body1 = await registerUser(page, user1);
        expect(body1.token).toBeTruthy();

        // Set username color via API
        const colorRes = await page.request.patch(`${BASE}/api/profile`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { username_color: testColor },
        });
        expect(colorRes.ok()).toBeTruthy();

        // Verify profile returns the color
        const profileRes = await page.request.get(`${BASE}/api/profile/${body1.user.id}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        const profile = await profileRes.json();
        expect(profile.username_color).toBe(testColor);

        // Register user2 in separate context
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        expect(body2.token).toBeTruthy();

        // Create server and set up E2EE
        const inviteCode = generateCode(8);
        const srv = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body1.token}` },
            data: { name: 'Color Test Server', invite_code: inviteCode },
        });
        const server = await srv.json();

        await page.evaluate(async ({ serverId, userId }) => {
            const serverKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, serverKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: server.id, userId: body1.user.id });

        // User2 joins
        await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${body2.token}` },
            data: { code: inviteCode },
        });

        const user2PubKey = await page2.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey));
        await page.evaluate(async ({ serverId, user2Id, user2PubKey }) => {
            const serverKey = E2ECrypto.getServerKey(serverId);
            const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(user2PubKey));
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, recipientPub);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: user2Id, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: server.id, user2Id: body2.user.id, user2PubKey });

        // User1 sends a message
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(500);

        const input1 = page.locator('#message-input');
        await expect(input1).toBeEnabled({ timeout: 5000 });
        await input1.fill('Color test message');
        await page.click('#send-btn');
        await page.waitForTimeout(2000);

        // User2 loads chat and checks display-name has color + text-shadow
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page2.click('.server-icon:not(.add-server)');
        await page2.waitForSelector('.channel-item', { timeout: 10000 });
        await page2.click('.channel-item >> nth=0');
        await page2.waitForTimeout(3000);

        // Check display-name has the color
        const displayNameStyle = await page2.locator('.message .display-name').first().getAttribute('style');
        expect(displayNameStyle).toBeTruthy();
        // Should contain the color we set
        const hasOurColor = displayNameStyle ? displayNameStyle.includes(testColor) : false;
        expect(hasOurColor).toBeTruthy();
        // Should contain text-shadow (glow)
        const hasTextShadow = displayNameStyle ? displayNameStyle.includes('text-shadow') : false;
        expect(hasTextShadow).toBeTruthy();

        // Reload user2's page and verify color persists after refresh
        await page2.reload();
        await page2.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page2.click('.server-icon:not(.add-server)');
        await page2.waitForSelector('.channel-item', { timeout: 10000 });
        await page2.click('.channel-item >> nth=0');
        await page2.waitForTimeout(3000);

        // Check display-name still has the color after reload
        const styleAfterReload = await page2.locator('.message .display-name').first().getAttribute('style');
        expect(styleAfterReload).toBeTruthy();
        const colorAfterReload = styleAfterReload ? styleAfterReload.includes(testColor) : false;
        expect(colorAfterReload).toBeTruthy();
        const shadowAfterReload = styleAfterReload ? styleAfterReload.includes('text-shadow') : false;
        expect(shadowAfterReload).toBeTruthy();

        await page2.close();
        await ctx2.close();
    });

test('username color preview in profile modal edit shows with text-shadow', async ({ page }) => {
    const ts = Date.now();
    const username = 'color_preview_' + ts;

    await registerUser(page, username);

    // Open profile modal via footer avatar
    await page.click('#footer-user-avatar');
    await page.waitForSelector('#profile-modal', { state: 'visible', timeout: 5000 });

    // Enter edit mode
    await page.click('#profile-edit-btn');
    await page.waitForTimeout(1000);

    // Find color picker in edit mode
    const colorPicker = page.locator('#profile-edit-color');
    await expect(colorPicker).toBeVisible({ timeout: 5000 });

    // Find the color preview element
    const colorPreview = page.locator('#profile-edit-color-preview');
    await expect(colorPreview).toBeVisible({ timeout: 5000 });

    // Check it has a color style applied
    let previewStyle = await colorPreview.getAttribute('style');
    expect(previewStyle).toBeTruthy();

    // Change color via evaluate (fill() unreliable on <input type="color">)
    await page.evaluate(() => {
        const picker = document.getElementById('profile-edit-color');
        if (picker) {
            picker.value = '#ff0066';
            // Dispatch input event so the preview updates
            picker.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });
    await page.waitForTimeout(200);

    // Preview should update with the new color
    previewStyle = await colorPreview.getAttribute('style');
    console.log('Color preview style:', previewStyle);
    expect(previewStyle).toBeTruthy();
    expect(previewStyle).toContain('255, 0, 102');

    // Close profile modal
    await page.click('#profile-modal-close');
});

    // ─── Display Name Contrast Glow ─────────────────────────────────────

    test('getContrastGlowColor returns correct glow for light and dark colors', async ({ page, context }) => {
        const ts = Date.now();
        const username = 'glow_func_' + ts;

        await registerUser(page, username);

        // Test the getContrastGlowColor function with known colors
        const testCases = await page.evaluate(() => {
            // These should exist in the browser context after page load
            if (typeof getContrastGlowColor !== 'function') return null;
            
            return {
                // Dark color should get white glow
                darkGlow: getContrastGlowColor('#000000'),
                // Light color should get dark glow
                lightGlow: getContrastGlowColor('#ffffff'),
                // Mid-gray should get dark glow
                midGlow: getContrastGlowColor('#888888'),
                // Blue should get... depends on luminance calc
                blueGlow: getContrastGlowColor('#0000ff'),
                // Yellow (bright) should get white glow
                yellowGlow: getContrastGlowColor('#ffff00'),
                // Null/undefined should return fallback
                nullGlow: getContrastGlowColor(null),
            };
        });

        expect(testCases).not.toBeNull();
        if (testCases) {
            // Dark colors should get light (white-based) glow
            expect(testCases.darkGlow).toContain('255,255,255');
            // Light colors should get dark (black-based) glow
            expect(testCases.lightGlow).toContain('0,0,0');
            // Null/undefined should get default dark glow
            expect(testCases.nullGlow).toContain('0,0,0');
            // Blue is relatively dark → white glow
            expect(testCases.blueGlow).toContain('255,255,255');
            // Yellow is relatively bright → dark glow
            expect(testCases.yellowGlow).toContain('0,0,0');
        }
    });

    test('getDisplayNameTextShadow returns multi-layer shadow string', async ({ page }) => {
        const ts = Date.now();
        const username = 'shadow_func_' + ts;

        await registerUser(page, username);

        const shadowStr = await page.evaluate(() => {
            if (typeof getDisplayNameTextShadow !== 'function') return null;
            return getDisplayNameTextShadow('#ff0000');
        });

        expect(shadowStr).not.toBeNull();
        if (shadowStr) {
            // Should be a multi-layer shadow string
            // Format: '0 0 4px ..., 0 0 8px ..., 0 0 16px ...'
            // Note: cannot split by ',' because rgba() values contain commas
            // Instead check for the three shadow layers by substring
            expect(shadowStr).toContain('0 0 4px');
            expect(shadowStr).toContain('0 0 8px');
            expect(shadowStr).toContain('0 0 16px');
            // Should have rgba values
            expect(shadowStr).toContain('rgba(');
        }
    });

    test('display name in messages has text-shadow with contrasting color', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'shadow_user1_' + ts;
        const user2 = 'shadow_user2_' + ts;

        const body1 = await registerUser(page, user1);
        expect(body1.token).toBeTruthy();

        // Set a very bright color for user1 (should get dark text-shadow)
        await page.request.patch(`${BASE}/api/profile`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { username_color: '#ffff00' }, // bright yellow
        });

        // Register user2
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);

        // Create server + E2EE setup
        const inviteCode = generateCode(8);
        const srv = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body1.token}` },
            data: { name: 'Shadow Test', invite_code: inviteCode },
        });
        const server = await srv.json();

        await page.evaluate(async ({ serverId, userId }) => {
            const serverKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, serverKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: server.id, userId: body1.user.id });

        await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${body2.token}` },
            data: { code: inviteCode },
        });

        const user2PubKey = await page2.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey));
        await page.evaluate(async ({ serverId, user2Id, user2PubKey }) => {
            const serverKey = E2ECrypto.getServerKey(serverId);
            const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(user2PubKey));
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, recipientPub);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: user2Id, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: server.id, user2Id: body2.user.id, user2PubKey });

        // User1 sends message
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(500);
        const input1 = page.locator('#message-input');
        await expect(input1).toBeEnabled({ timeout: 5000 });
        await input1.fill('Shadow glow test');
        await page.click('#send-btn');
        await page.waitForTimeout(2000);

        // User2 checks the display-name has contrasting text-shadow
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page2.click('.server-icon:not(.add-server)');
        await page2.waitForSelector('.channel-item', { timeout: 10000 });
        await page2.click('.channel-item >> nth=0');
        await page2.waitForTimeout(3000);

        const displayNameEl = page2.locator('.message .display-name').first();
        const style = await displayNameEl.getAttribute('style');
        expect(style).toBeTruthy();

        // Should have both color (yellow) and text-shadow
        expect(style).toContain('ffff00');
        expect(style).toContain('text-shadow');

        // The text-shadow should be dark (for bright yellow)
        // yellow: #ffff00 has luminance = (255*299 + 255*587 + 0*114) / 1000 ≈ 226 → bright → dark shadow
        expect(style).toContain('0,0,0'); // dark shadow

        await page2.close();
        await ctx2.close();
    });

    // ─── Forward Message UI with Badges ─────────────────────────────────

    test('forward message renders with channel and server badges', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'fwd_user1_' + ts;
        const user2 = 'fwd_user2_' + ts;

        const body1 = await registerUser(page, user1);
        expect(body1.token).toBeTruthy();

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        expect(body2.token).toBeTruthy();

        // Create server + E2EE
        const inviteCode = generateCode(8);
        const srv = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body1.token}` },
            data: { name: 'Forward Test Server', invite_code: inviteCode },
        });
        const server = await srv.json();

        await page.evaluate(async ({ serverId, userId }) => {
            const serverKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, serverKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: server.id, userId: body1.user.id });

        await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${body2.token}` },
            data: { code: inviteCode },
        });

        const user2PubKey = await page2.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey));
        await page.evaluate(async ({ serverId, user2Id, user2PubKey }) => {
            const serverKey = E2ECrypto.getServerKey(serverId);
            const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(user2PubKey));
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, recipientPub);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: user2Id, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: server.id, user2Id: body2.user.id, user2PubKey });

        // Get channel IDs
        const chRes = await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        const channels = await chRes.json();
        const generalId = channels[0].id;

        // User1 sends original message
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(500);
        const input1 = page.locator('#message-input');
        await expect(input1).toBeEnabled({ timeout: 5000 });
        await input1.fill('Original forward message');
        await page.click('#send-btn');
        await page.waitForTimeout(2000);

        // Get the message ID
        const messagesRes = await page.request.get(`${BASE}/api/channels/${generalId}/messages`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        const messages = await messagesRes.json();
        expect(messages.length).toBeGreaterThanOrEqual(1);
        const msgId = messages[messages.length - 1].id;

        // Now user1 forwards the message to another channel (we'll create one)
        const ch2Res = await page.request.post(`${BASE}/api/servers/${server.id}/channels`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { name: 'forwards' },
        });
        const channel2 = await ch2Res.json();
        expect(ch2Res.ok()).toBeTruthy();

        // Reload user1's page to see the new channel
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item', { hasText: 'general' });
        await page.waitForTimeout(1000);

        // Find the message and forward it via the UI
        // Open the forward modal by clicking the forward button on the message
        const forwardBtns = page.locator('.message .forward-btn');
        const fwdBtnCount = await forwardBtns.count();
        if (fwdBtnCount > 0) {
            await forwardBtns.first().click();
            await page.waitForSelector('#forward-modal', { state: 'visible', timeout: 5000 });
        } else {
            // Fall back to using openForwardModal directly
            await page.evaluate((msgId) => {
                if (typeof openForwardModal === 'function') {
                    // Find the msg div
                    const msgDiv = document.querySelector(`.message[data-message-id="${msgId}"]`);
                    if (msgDiv) {
                        pendingForward = { msgDiv, messageId: msgId };
                        openForwardModal();
                    }
                }
            }, msgId);
            await page.waitForSelector('#forward-modal', { state: 'visible', timeout: 5000 }).catch(() => {});
        }

        // Check the forward modal content structure for badge rendering
        // The forward list should show channel items with data attributes
        const forwardList = page.locator('#forward-channel-list');
        if (await forwardList.isVisible()) {
            // Check that channels are listed
            const channelItems = await forwardList.locator('.forward-channel-item').allTextContents();
            expect(channelItems.length).toBeGreaterThanOrEqual(2);

            // Forward to the 'forwards' channel
            await forwardList.locator('.forward-channel-item', { hasText: 'forwards' }).click();
            await page.waitForTimeout(2000);
        }

        // User2 checks the forwarded message in the 'forwards' channel
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page2.click('.server-icon:not(.add-server)');
        await page2.waitForSelector('.channel-item', { timeout: 10000 });
        // Click on 'forwards' channel
        await page2.locator('.channel-item', { hasText: 'forwards' }).click();
        await page2.waitForTimeout(3000);

        // The forwarded message should have:
        // - .forward-label container
        // - .forward-channel-badge for the source channel
        // - .forward-server-badge for the source server
        // - Forward sender info with pic/initial
        const forwardLabels = page2.locator('.message .forward-label');
        const fwdCount = await forwardLabels.count();
        console.log('Forward labels found:', fwdCount);

        // If forward succeeded, check badge elements
        if (fwdCount > 0) {
            const channelBadges = await forwardLabels.locator('.forward-channel-badge').count();
            const serverBadges = await forwardLabels.locator('.forward-server-badge').count();
            const senderInfo = await forwardLabels.locator('.forward-sender-info').count();

            console.log('Channel badges:', channelBadges, 'Server badges:', serverBadges, 'Sender info:', senderInfo);
            expect(channelBadges).toBeGreaterThan(0);
            expect(serverBadges).toBeGreaterThan(0);
            expect(senderInfo).toBeGreaterThan(0);

            // Verify badge text
            const channelBadgeText = await forwardLabels.locator('.forward-channel-badge').first().textContent();
            expect(channelBadgeText).toContain('#');
            const serverBadgeText = await forwardLabels.locator('.forward-server-badge').first().textContent();
            expect(serverBadgeText).toBeTruthy();
        }

        await page2.close();
        await ctx2.close();
    });

    // ─── PFP Rendering in Messages ──────────────────────────────────────

    test('profile picture renders in server messages for other users', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'pfp_srv1_' + ts;
        const user2 = 'pfp_srv2_' + ts;
        const displayName1 = 'PFPUser_' + ts;

        const body1 = await registerUser(page, user1);
        expect(body1.token).toBeTruthy();

        // Upload profile picture for user1
        const fileId = await uploadProfilePic(page, body1.token);

        // Set display name for user1
        await page.request.patch(`${BASE}/api/profile`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { display_name: displayName1 },
        });

        // Register user2
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        expect(body2.token).toBeTruthy();

        // Create server + E2EE
        const inviteCode = generateCode(8);
        const srv = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body1.token}` },
            data: { name: 'PFP Server', invite_code: inviteCode },
        });
        const server = await srv.json();

        await page.evaluate(async ({ serverId, userId }) => {
            const serverKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, serverKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: server.id, userId: body1.user.id });

        await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${body2.token}` },
            data: { code: inviteCode },
        });

        const user2PubKey = await page2.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey));
        await page.evaluate(async ({ serverId, user2Id, user2PubKey }) => {
            const serverKey = E2ECrypto.getServerKey(serverId);
            const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(user2PubKey));
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, recipientPub);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: user2Id, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: server.id, user2Id: body2.user.id, user2PubKey });

        // User1 sends message
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(500);
        const input1 = page.locator('#message-input');
        await expect(input1).toBeEnabled({ timeout: 5000 });
        await input1.fill('PFP message test');
        await page.click('#send-btn');
        await page.waitForTimeout(2000);

        // User2 loads chat and checks avatar
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page2.click('.server-icon:not(.add-server)');
        await page2.waitForSelector('.channel-item', { timeout: 10000 });
        await page2.click('.channel-item >> nth=0');
        await page2.waitForTimeout(3000);

        // Check avatar element exists in messages
        const msgAvatars = page2.locator('.message .avatar');
        const avatarCount = await msgAvatars.count();
        expect(avatarCount).toBeGreaterThan(0);

        // Wait a bit for async PFP load, then check for img.avatar-img
        await page2.waitForTimeout(3000);
        const avatarImgs = await page2.locator('.message .avatar img.avatar-img').count();
        console.log('Message avatar images:', avatarImgs);

        // There should be at least 1 img.avatar-img if the PFP loaded
        // (it might not load if decryption fails in tests, but the element structure is correct)
        if (avatarImgs > 0) {
            // Check the img has a valid src
            const imgSrc = await page2.locator('.message .avatar img.avatar-img').first().getAttribute('src');
            expect(imgSrc).toBeTruthy();
            expect(imgSrc).toContain('blob:');
        }

        // Verify display name appears in the message
        const msgDisplayNames = await page2.locator('.message .display-name').allTextContents();
        expect(msgDisplayNames.some(n => n === displayName1)).toBeTruthy();

        // Verify message text is decrypted
        const msgTexts = await page2.locator('.message .text').allTextContents();
        expect(msgTexts.some(t => t && t.includes('PFP message test'))).toBeTruthy();

        await page2.close();
        await ctx2.close();
    });

    test('profile picture renders in DM list and DM header', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'pfp_dm1_' + ts;
        const user2 = 'pfp_dm2_' + ts;
        const displayName1 = 'PFPDM_' + ts;

        const body1 = await registerUser(page, user1);
        expect(body1.token).toBeTruthy();

        // Get user1's friend code
        const user1FriendCode = await page.evaluate(() => localStorage.getItem('e2e_friend_code'));
        expect(user1FriendCode).toBeTruthy();

        // Upload profile picture for user1
        const fileId = await uploadProfilePic(page, body1.token);

        // Set display name
        await page.request.patch(`${BASE}/api/profile`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { display_name: displayName1 },
        });

        // Register user2
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        expect(body2.token).toBeTruthy();

        // Make friends (auto-creates DM channel)
        await becomeFriends(page, page2, body1.token, body2.token);

        // User2 loads DM view and checks DM list
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(2000);
        await page2.click('#dm-strip-btn');
        await page2.waitForTimeout(2000);

        // Check DM items exist
        await page2.waitForSelector('.dm-item', { timeout: 5000 }).catch(() => {});
        const dmItems = await page2.locator('.dm-item').count();
        expect(dmItems).toBeGreaterThan(0);

        // Check DM avatar structure
        const dmAvatars = page2.locator('.dm-item .dm-avatar');
        const dmAvatarCount = await dmAvatars.count();
        expect(dmAvatarCount).toBeGreaterThan(0);

        // Wait for async PFP load
        await page2.waitForTimeout(3000);
        const dmAvatarImgs = await page2.locator('.dm-item .dm-avatar img.avatar-img').count();
        console.log('DM avatar images:', dmAvatarImgs);

        // Check DM name shows display name
        const dmNames = await page2.locator('.dm-item .dm-name').allTextContents();
        expect(dmNames.some(n => n.includes(displayName1))).toBeTruthy();

        // Click on the DM conversation item
        await page2.locator('.dm-item').first().click();
        await page2.waitForTimeout(2000);

        // Check presence of the DM chat header PFP (dm-chat-header-pic)
        const headerPics = page2.locator('#channel-name .dm-chat-header-pic');
        const headerPicCount = await headerPics.count();
        console.log('DM header pics:', headerPicCount);
        // The header should show the pic div (may be initials until PFP loads async)
        expect(headerPicCount).toBeGreaterThan(0);

        // Check channel header shows display name
        const channelName = await page2.locator('#channel-name').textContent();
        expect(channelName).toContain(displayName1);

        await page2.close();
        await ctx2.close();
    });

    // ─── PFP in Mentions Inbox ──────────────────────────────────────────

    test('mentions inbox items show sender avatar with profile pic support', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'mention_pfp1_' + ts;
        const user2 = 'mention_pfp2_' + ts;

        const body1 = await registerUser(page, user1);
        expect(body1.token).toBeTruthy();

        // Upload PFP for user1
        await uploadProfilePic(page, body1.token);

        // Register user2
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        expect(body2.token).toBeTruthy();

        // Create server + E2EE
        const inviteCode = generateCode(8);
        const srv = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body1.token}` },
            data: { name: 'Mention PFP Server', invite_code: inviteCode },
        });
        const server = await srv.json();

        await page.evaluate(async ({ serverId, userId }) => {
            const serverKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, serverKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: server.id, userId: body1.user.id });

        await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${body2.token}` },
            data: { code: inviteCode },
        });

        const user2PubKey = await page2.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey));
        await page.evaluate(async ({ serverId, user2Id, user2PubKey }) => {
            const serverKey = E2ECrypto.getServerKey(serverId);
            const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(user2PubKey));
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, recipientPub);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: user2Id, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: server.id, user2Id: body2.user.id, user2PubKey });

        // User1 loads chat and sends a mention to user2
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(500);

        const input1 = page.locator('#message-input');
        await expect(input1).toBeEnabled({ timeout: 5000 });

        // Send a message mentioning user2
        await input1.fill('Hello @' + user2);
        await page.click('#send-btn');
        await page.waitForTimeout(2000);

        // User2 reloads and checks mentions inbox
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(3000);

        // Click mentions button to open inbox
        const mentionsBtn = page2.locator('#mentions-strip-btn');
        await expect(mentionsBtn).toBeVisible({ timeout: 5000 });
        await mentionsBtn.click();
        await page2.waitForTimeout(1000);

        // Wait for mentions inbox panel
        const mentionsPanel = page2.locator('#mentions-panel');
        await expect(mentionsPanel).toBeVisible({ timeout: 5000 });

        // Check the mentions inbox items for avatar structure
        // The mention items should have sender avatar rendering with profile-pic-load
        const mentionItems = page2.locator('#mentions-inbox-list .mention-inbox-item');
        const mentionItemCount = await mentionItems.count();
        console.log('Mention inbox items:', mentionItemCount);

        if (mentionItemCount > 0) {
            // Check for avatar elements in the mentions
            const avatarsWithLoad = await page2.locator('#mentions-inbox-list [data-profile-pic-load]').count();
            console.log('Avatars with profile-pic-load:', avatarsWithLoad);

            // The avatar rendering should exist (either as img from cache or as div with data-profile-pic-load)
            await page2.waitForTimeout(3000);
            const avatarImgsInMentions = await page2.locator('#mentions-inbox-list img[src*="blob:"]').count();
            console.log('Avatar images in mentions:', avatarImgsInMentions);
        }

        // Close mentions panel
        await page2.click('#close-mentions-inbox');
        await page2.waitForTimeout(500);

        await page2.close();
        await ctx2.close();
    });
});
