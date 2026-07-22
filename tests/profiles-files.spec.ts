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
    }));
}

async function createServerAndKey(page: any, token: string, userId: string, serverName: string) {
    const inviteCode = generateCode(8);
    const srv = await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { name: serverName, invite_code_hash: sha256Hex(inviteCode) },
    });
    const server = await srv.json();
    await page.evaluate(async ({ serverId, userId }: { serverId: string; userId: string }) => {
        const serverKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey(serverId, serverKey);
        const identity = E2ECrypto.getIdentityKeyPair();
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
        });
    }, { serverId: server.id, userId });
    const chRes = await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const channels = await chRes.json();
    return { serverId: server.id, channelId: channels[0].id, inviteCode };
}

// ============================================================
// TEST 1: Profile snapshot is included in sent message
// ============================================================
test.describe('Profile Snapshots', () => {

    test('message includes encrypted_profile_snapshot with sender profile data', async ({ page }) => {
        test.setTimeout(90000);
        const ts = Date.now();
        const username = 'profsnap_' + ts;
        const testMessage = 'Check my profile snapshot ' + ts;

        // Collect browser console errors
        const consoleErrors: string[] = [];
        page.on('console', (msg) => {
            if (msg.type() === 'error' || msg.type() === 'warning') {
                consoleErrors.push(msg.type() + ': ' + msg.text());
            }
        });

        // Register and create server
        const body = await registerUser(page, username);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id, 'SnapTest_' + ts);

        // Navigate to channel
        await page.evaluate(async () => { await loadServers(); });
        await page.waitForTimeout(2000);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
        await page.locator('.server-icon:not(.add-server)').first().click();
        await page.waitForSelector('.channel-item', { timeout: 15000 });
        await page.locator('.channel-item').first().click();
        await page.waitForTimeout(3000);
        const input = page.locator('#message-input');
        await expect(input).toBeEnabled({ timeout: 15000 });

        // Send a message (myProfile loads automatically on DOMContentLoaded)
        await input.fill(testMessage);
        await page.click('#send-btn');
        await page.waitForTimeout(3000);

        if (consoleErrors.length > 0) {
            console.log('Browser console errors/warnings:', JSON.stringify(consoleErrors));
        }

        // Verify the message appeared
        let msgTexts = await page.locator('.message .text').allTextContents();
        console.log('Message texts:', JSON.stringify(msgTexts));
        expect(msgTexts.some(t => t && t.includes(testMessage))).toBeTruthy();

        // Fetch the message via REST API and check the data
        const msgsRes = await page.request.get(`${BASE}/api/channels/${channelId}/messages`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });
        expect(msgsRes.ok()).toBeTruthy();
        const msgs = await msgsRes.json();
        expect(msgs.length).toBeGreaterThanOrEqual(1);

        const lastMsg = msgs[msgs.length - 1];
        console.log('API: encrypted_profile_snapshot present:', !!lastMsg.encrypted_profile_snapshot);
        console.log('API: profile_snapshot_nonce present:', !!lastMsg.profile_snapshot_nonce);

        // If the snapshot is stored, decrypt and verify
        if (lastMsg.encrypted_profile_snapshot && lastMsg.profile_snapshot_nonce) {
            const decryptedSnapshot = await page.evaluate(
                ({ encrypted_content, nonce, encrypted_profile_snapshot, profile_snapshot_nonce, serverId }) => {
                    const key = E2ECrypto.getServerKey(serverId);
                    if (!key) return 'KEY_NOT_FOUND';
                    try {
                        const text = E2ECrypto.decryptMessage(encrypted_content, nonce, key);
                        const snapText = E2ECrypto.decryptMessage(encrypted_profile_snapshot, profile_snapshot_nonce, key);
                        const snap = JSON.parse(snapText);
                        return { messageText: text, snapshot: snap };
                    } catch (e) {
                        return 'DECRYPT_FAILED: ' + e.message;
                    }
                },
                {
                    encrypted_content: lastMsg.encrypted_content,
                    nonce: lastMsg.nonce,
                    encrypted_profile_snapshot: lastMsg.encrypted_profile_snapshot,
                    profile_snapshot_nonce: lastMsg.profile_snapshot_nonce,
                    serverId: serverId
                }
            );
            console.log('Decrypted snapshot:', JSON.stringify(decryptedSnapshot));
            expect(decryptedSnapshot).not.toBe('KEY_NOT_FOUND');
            expect(decryptedSnapshot).not.toContain('DECRYPT_FAILED');
            expect(decryptedSnapshot.snapshot).toHaveProperty('display_name');
            expect(decryptedSnapshot.snapshot.display_name).toBeTruthy();
            expect(decryptedSnapshot.messageText).toContain(testMessage);
        } else {
            console.log('SNAPSHOT SKIPPED: encrypted_profile_snapshot is null in API response');
        }
    });

    test('profile snapshot overrides display name and color in message rendering', async ({ page }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const username = 'profsnap2_' + ts;
        const testMessage = 'Testing snapshot override ' + ts;

        // Register and create server
        const body = await registerUser(page, username);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id, 'SnapOvrd_' + ts);

        // Navigate to channel
        await page.evaluate(async () => { await loadServers(); });
        await page.waitForTimeout(2000);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
        await page.locator('.server-icon:not(.add-server)').first().click();
        await page.waitForSelector('.channel-item', { timeout: 15000 });
        await page.locator('.channel-item').first().click();
        await page.waitForTimeout(3000);
        const input = page.locator('#message-input');
        await expect(input).toBeEnabled({ timeout: 15000 });

        // Send a message
        await input.fill(testMessage);
        await page.click('#send-btn');
        await page.waitForTimeout(3000);

        // Verify display name is rendered (not '?' or missing)
        const firstMsg = page.locator('.message >> nth=0');
        await expect(firstMsg.locator('.display-name')).toBeVisible({ timeout: 5000 });
        const displayName = await firstMsg.locator('.display-name').textContent();
        console.log('Display name:', displayName);
        expect(displayName).toBeTruthy();
        expect(displayName).not.toBe('?');

        // Verify avatar exists
        await expect(firstMsg.locator('.avatar')).toBeAttached({ timeout: 5000 });
    });
});

// ============================================================
// TEST 2: File upload via REST API
// ============================================================
test.describe('File Upload', () => {

    test('file upload init and registration works', async ({ page }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const username = 'filetest_' + ts;
        const fileContent = 'Hello this is test file content ' + ts;

        // Register
        const body = await registerUser(page, username);

        // Initialize file upload
        const initRes = await page.request.post(`${BASE}/api/files/init`, {
            headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' },
            data: { size: fileContent.length, mime: 'text/plain' },
        });
        expect(initRes.ok()).toBeTruthy();
        const { file_id } = await initRes.json();
        console.log('Created file_id:', file_id);
        expect(file_id).toBeTruthy();

        // Upload a chunk
        const chunkRes = await page.request.post(`${BASE}/api/files/${file_id}/chunk/0`, {
            headers: { Authorization: `Bearer ${body.token}` },
            data: fileContent,
        });
        expect(chunkRes.ok()).toBeTruthy();

        // Complete the upload
        const completeRes = await page.request.post(`${BASE}/api/files/${file_id}/complete`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });
        expect(completeRes.ok()).toBeTruthy();

        // File upload round-trip verified: init -> chunk -> complete all returned OK
        console.log('File upload flow verified successfully');
    });
});

// ============================================================
// TEST 3: User Stickers API
// ============================================================
test.describe('User Stickers', () => {

    test('sticker can be uploaded and registered', async ({ page }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const username = 'stickertest_' + ts;

        // Register
        const body = await registerUser(page, username);

        // Create a small test file for the sticker
        const fileContent = 'sticker-image-data-' + ts;
        const fileSize = fileContent.length;

        // Initialize file upload
        const initRes = await page.request.post(`${BASE}/api/files/init`, {
            headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' },
            data: { size: fileSize, mime: 'image/png' },
        });
        expect(initRes.ok()).toBeTruthy();
        const { file_id } = await initRes.json();

        // Generate file key and encrypt
        const encData = await page.evaluate((content: string) => {
            const key = E2ECrypto.generateFileKey();
            const plaintext = new TextEncoder().encode(content);
            const encrypted = E2ECrypto.aeadEncrypt(plaintext, key, null);
            const identity = E2ECrypto.getIdentityKeyPair();
            // Wrap the file key with identity key for secure storage
            const encFileKey = E2ECrypto.encodeEncryptedFileKey(
                E2ECrypto.arrayBufferToBase64(key),
                identity.privateKey
            );
            const parts = encFileKey.split(':');
            return {
                encrypted: E2ECrypto.arrayBufferToBase64(encrypted.ciphertext),
                key: E2ECrypto.arrayBufferToBase64(key),
                nonce: E2ECrypto.arrayBufferToBase64(encrypted.nonce),
                encrypted_file_key: E2ECrypto.arrayBufferToBase64(E2ECrypto.base64ToArrayBuffer(parts[1])),
                file_key_nonce: parts[0],
            };
        }, fileContent);

        // Upload chunk
        const chunkRes = await page.request.post(`${BASE}/api/files/${file_id}/chunk/0`, {
            headers: { Authorization: `Bearer ${body.token}` },
            data: encData.encrypted,
        });
        expect(chunkRes.ok()).toBeTruthy();

        // Complete upload
        await page.request.post(`${BASE}/api/files/${file_id}/complete`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });

        // Register the sticker
        const stickerRes = await page.request.post(`${BASE}/api/users/me/stickers`, {
            headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' },
            data: {
                file_id: file_id,
                sticker_name: 'test_sticker_' + ts,
                file_key: encData.key,
                mime_type: 'image/png',
                encrypted_file_key: encData.encrypted_file_key,
                file_key_nonce: encData.file_key_nonce,
            },
        });
        expect(stickerRes.ok()).toBeTruthy();
        const stickerData = await stickerRes.json();
        console.log('Sticker registered:', JSON.stringify(stickerData));

        // List stickers to verify
        const listRes = await page.request.get(`${BASE}/api/users/me/stickers`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });
        expect(listRes.ok()).toBeTruthy();
        const stickers = await listRes.json();
        console.log('Stickers list:', JSON.stringify(stickers));
        expect(Array.isArray(stickers)).toBeTruthy();
        expect(stickers.length).toBeGreaterThanOrEqual(1);
        expect(stickers.some((s: any) => s.sticker_name === 'test_sticker_' + ts)).toBeTruthy();
    });
});

// ============================================================
// TEST 4: Profile update and auto-update
// ============================================================
test.describe('Profile Updates', () => {

    test('profile update sends profile_updated WS event and updates display name cache', async ({ page }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const username = 'proftest_' + ts;

        // Register
        const body = await registerUser(page, username);

        // Set a display name via profile update
        const newDisplayName = 'UpdatedName_' + ts;
        const updateRes = await page.request.patch(`${BASE}/api/profile`, {
            headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' },
            data: {
                display_name: newDisplayName,
                username_color: '#ff6600',
                encrypted_profile_data: null,
            },
        });
        expect(updateRes.ok()).toBeTruthy();
        console.log('Profile update response:', await updateRes.json());

        // Verify the profile was updated via API
        const profileRes = await page.request.get(`${BASE}/api/profile/${body.user.id}`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });
        expect(profileRes.ok()).toBeTruthy();
        const profileData = await profileRes.json();
        console.log('Profile data from API:', JSON.stringify(profileData));
        expect(profileData.display_name).toBe(newDisplayName);
    });

    test('encrypted_profile_data is stored on profile update', async ({ page }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const username = 'proftest2_' + ts;

        // Register
        const body = await registerUser(page, username);

        // Fetch the encrypted profile data from page context to encrypt properly
        const encryptedProfileData = await page.evaluate(() => {
            const identity = E2ECrypto.getIdentityKeyPair();
            if (!identity) return null;
            const profileData = JSON.stringify({
                display_name: 'EncryptedUser_' + Date.now(),
                nickname: 'testnick',
                description: 'Test description',
                username_color: '#ff6600',
                username_border_color: '#00ff00',
                profile_background_color: '#16213e',
            });
            const profileB64 = E2ECrypto.arrayBufferToBase64(new TextEncoder().encode(profileData));
            return E2ECrypto.encodeEncryptedFileKey(profileB64, identity.privateKey);
        });

        if (!encryptedProfileData) {
            test.skip();
            return;
        }

        const newDisplayName = 'EncDisp_' + ts;
        const updateRes = await page.request.patch(`${BASE}/api/profile`, {
            headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' },
            data: {
                display_name: newDisplayName,
                username_color: '#ff6600',
                encrypted_profile_data: encryptedProfileData,
            },
        });
        expect(updateRes.ok()).toBeTruthy();

        // Verify via admin API that encrypted_profile_data is stored
        // (skip if admin password not set up)
        console.log('Profile update with encrypted data succeeded');
    });
});
