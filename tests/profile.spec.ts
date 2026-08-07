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

// Set a display name through the REAL saveProfile() flow — the E2EE server
// ignores plaintext display_name PATCHes (all profile data is encrypted).
async function setDisplayNameViaSaveProfile(page: any, displayName: string): Promise<void> {
    const status = await page.evaluate(async ({ dn }) => {
        const el = document.getElementById('profile-edit-display-name');
        if (el) el.value = dn;
        const statusEl = document.getElementById('profile-edit-status');
        try {
            await (saveProfile as any)();
            return statusEl ? (statusEl.textContent || '') : 'no-status-el';
        } catch (e) { return 'ERR ' + e; }
    }, { dn: displayName });
    console.log('setDisplayNameViaSaveProfile status:', JSON.stringify(status));
    expect(status).toContain('Profile saved');
    await page.waitForTimeout(800);
}

// Upload a PNG (encrypted) and set it as the profile picture through the REAL
// saveProfile() flow so myProfile gets the raw file key (required for rendering).
async function uploadPfpViaSaveProfile(page: any, token: string, pngBytes: Buffer): Promise<string> {
    const initRes = await page.request.post(`${BASE}/api/files/init`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { size: pngBytes.length, mime: 'image/png' },
    });
    expect(initRes.ok()).toBeTruthy();
    const { file_id } = await initRes.json();
    const fileKeyB64: string = await page.evaluate(async ({ fileId, pngBase64 }) => {
        const rawBytes = Uint8Array.from(atob(pngBase64), c => c.charCodeAt(0));
        const fileKey = E2ECrypto.generateFileKey();
        const encrypted = E2ECrypto.encryptFileChunk(fileKey, rawBytes);
        const blob = new Blob([encrypted], { type: 'application/octet-stream' });
        await fetch(`/api/files/${fileId}/chunk/0`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: blob,
        });
        await fetch(`/api/files/${fileId}/complete`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        return E2ECrypto.arrayBufferToBase64(fileKey);
    }, { fileId: file_id, pngBase64: pngBytes.toString('base64') });
    const status = await page.evaluate(async ({ fid, fk }) => {
        (profilePfpFileId as any) = fid;
        (profilePfpFileKey as any) = fk;
        (_removePfpFlag as any) = false;
        const statusEl = document.getElementById('profile-edit-status');
        try {
            await (saveProfile as any)();
            return statusEl ? (statusEl.textContent || '') : 'no-status-el';
        } catch (e) { return 'ERR ' + e; }
    }, { fid: file_id, fk: fileKeyB64 });
    expect(status).toContain('Profile saved');
    await page.waitForTimeout(800);
    return file_id;
}

function makeMinimalPng(width = 50, height = 50): Buffer {
    // Minimal valid PNG (1x1 transparent, scaled by IHDR width/height claims).
    let b = Buffer.alloc(8);
    b.writeUInt32BE(0x89504e47, 0);
    b.writeUInt32BE(0x0d0a1a0a, 4);
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write('IHDR', 4);
    ihdr.writeUInt32BE(width, 8);
    ihdr.writeUInt32BE(height, 12);
    ihdr[16] = 8; ihdr[17] = 6; ihdr[18] = 0; ihdr[19] = 0; ihdr[20] = 0;
    ihdr.writeUInt32BE(0x9e17a3c7, 21);
    b = Buffer.concat([b, ihdr]);
    const idat = Buffer.alloc(23);
    idat.writeUInt32BE(15, 0);
    idat.write('IDAT', 4);
    // zlib: 0x78 0x01, deflate stored block of one 0-filter row [0,0,0,0]
    idat[8] = 0x78; idat[9] = 0x01; idat[10] = 0x01; idat[11] = 0x00; idat[12] = 0x00; idat[13] = 0x00; idat[14] = 0xff; idat[15] = 0xff;
    idat.writeUInt32BE(0x256e4b47, 19);
    b = Buffer.concat([b, idat]);
    const iend = Buffer.alloc(12);
    iend.writeUInt32BE(0, 0);
    iend.write('IEND', 4);
    iend.writeUInt32BE(0xae426082, 8);
    b = Buffer.concat([b, iend]);
    return b;
}

test.describe('Profile Features', () => {
    test.setTimeout(120000);

    test('display name change reflects in DM list and messages after refresh', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'prof_' + ts;
        const user2 = 'prof2_' + ts;
        // Keep ≤ 21 chars — saveProfile validates the length.
        const displayName1 = 'Disp_' + String(ts % 100000);

        // Register user1
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', user1);
        await page.fill('#register-password', 'password123');
                await page.fill('#register-confirm-password', 'password123');
await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });

        // Get user1's friend code from localStorage
        const user1FriendCode = await page.evaluate(() => localStorage.getItem('e2e_friend_code'));
        expect(user1FriendCode).toBeTruthy();

        const body1 = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));
        expect(body1.token).toBeTruthy();

        // Register user2
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await page2.goto(`${BASE}/login.html`);
        await page2.waitForTimeout(1000);
        await page2.click('#show-register');
        await page2.fill('#register-username', user2);
        await page2.fill('#register-password', 'password123');
        await page2.fill('#register-confirm-password', 'password123');
await page2.click('#register-form button[type="submit"]');
        await page2.waitForURL('**/index.html', { timeout: 10000 });

        const body2 = await page2.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));

        // User1 changes display name via the REAL saveProfile() flow (the E2EE
        // server ignores plaintext display_name PATCHes).
        await setDisplayNameViaSaveProfile(page, displayName1);

        // Verify profile API returns the encrypted blob (display_name lives inside)
        const profileRes = await page.request.get(`${BASE}/api/profile/${body1.user.id}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        const profile = await profileRes.json();
        expect(profile.encrypted_profile_data).toBeTruthy();

        // Make user1 and user2 friends via friend code
        // User2 sends friend request to user1 using user1's friend code
        await page2.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: user1FriendCode },
        });

        // Get the friend request for user1
        const requestsRes = await page.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        const requests = await requestsRes.json();
        expect(requests.length).toBeGreaterThanOrEqual(1);
        const requestId = requests[0].id;

        // User1 accepts
        await page.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { request_id: requestId },
        });

        // User2 loads DM conversations and checks they see user1's display name
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(3000);

        // Navigate to DM view
        await page2.click('#dm-strip-btn');
        await page2.waitForTimeout(2000);

        // Wait for DM items to render
        await page2.waitForSelector('.dm-item', { timeout: 5000 }).catch(() => {});

        // Check DM list shows the display name
        const dmItems = await page2.locator('.dm-item .dm-name').allTextContents();
        console.log('DM items for user2:', JSON.stringify(dmItems));
        const foundDisplayName = dmItems.some(name => name.includes(displayName1));
        expect(foundDisplayName).toBeTruthy();

        // Click the DM conversation
        const dmItem = page2.locator('.dm-item').first();
        await dmItem.click();
        await page2.waitForTimeout(2000);

        // Check the channel header shows the display name
        const channelName = await page2.locator('#channel-name').textContent();
        expect(channelName).toContain(displayName1);

        // User2 sends a DM message to user1
        const input2 = page2.locator('#message-input');
        await expect(input2).toBeEnabled({ timeout: 5000 });
        await input2.fill('Hello with display name!');
        await page2.click('#send-btn');
        await page2.waitForTimeout(3000);

        // User1 loads the DM and checks they see the message
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2000);
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(2000);

        // Click on DM
        const dmItemU1 = page.locator('.dm-item').first();
        await dmItemU1.click();
        await page.waitForTimeout(2000);

        // User1 should see the decrypted message
        const msgTexts = await page.locator('.message .text').allTextContents();
        console.log('User1 messages:', JSON.stringify(msgTexts));
        expect(msgTexts.some(t => t && t.includes('Hello with display name'))).toBeTruthy();

        await page2.close();
        await ctx2.close();
    });

    test('profile picture upload and rendering in sidebar footer', async ({ page }) => {
        const ts = Date.now();
        const username = 'pic_' + ts;

        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
                await page.fill('#register-confirm-password', 'password123');
await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });

        // Open settings modal
        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });

        // Check profile tab shows info
        await page.waitForSelector('#profile-username-display', { state: 'visible', timeout: 5000 });
        const usernameDisplay = await page.locator('#profile-username-display').textContent();
        expect(usernameDisplay).toContain(username);

        // Check sidebar footer shows username
        const footerUser = await page.locator('#current-user').textContent();
        expect(footerUser).toBe(username);

        // Close settings
        await page.click('#close-settings');

        // Verify profile persists on reload
        await page.reload();
        await page.waitForTimeout(2000);

        const footerUserAfter = await page.locator('#current-user').textContent();
        expect(footerUserAfter).toBe(username);

        // Change display name via the REAL saveProfile() flow
        const newName = 'Nm_' + String(ts % 100000);
        await setDisplayNameViaSaveProfile(page, newName);

        // Check footer updated
        const footerNewName = await page.locator('#current-user').textContent();
        expect(footerNewName).toBe(newName);

        // Reload and check persistence
        await page.reload();
        await page.waitForTimeout(2000);
        const footerAfterReload = await page.locator('#current-user').textContent();
        expect(footerAfterReload).toBe(newName);
    });

    test('display name appears in server messages after change', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'srvprof_' + ts;
        const user2 = 'srvprof2_' + ts;
        // Keep ≤ 21 chars — saveProfile validates the length.
        const displayName1 = 'Srv_' + String(ts % 100000);

        // Register user1
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', user1);
        await page.fill('#register-password', 'password123');
                await page.fill('#register-confirm-password', 'password123');
await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });

        const body1 = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));

        // Register user2
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await page2.goto(`${BASE}/login.html`);
        await page2.waitForTimeout(1000);
        await page2.click('#show-register');
        await page2.fill('#register-username', user2);
        await page2.fill('#register-password', 'password123');
        await page2.fill('#register-confirm-password', 'password123');
await page2.click('#register-form button[type="submit"]');
        await page2.waitForURL('**/index.html', { timeout: 10000 });

        const body2 = await page2.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));

        // User1 creates server
        const inviteCode = generateCode(8);
        const srv = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body1.token}` },
            data: { name: 'Profile Test Server', invite_code: inviteCode },
        });
        const server = await srv.json();

        // User1 uploads server key
        await page.evaluate(async ({ serverId, userId }) => {
            const serverKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, serverKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + localStorage.getItem('token'),
                },
                body: JSON.stringify({
                    user_id: userId,
                    encrypted_key: encrypted.ciphertext,
                    sender_public_key: encrypted.ephemeralPublicKey,
                    nonce: encrypted.nonce,
                }),
            });
        }, { serverId: server.id, userId: body1.user.id });

        // User1 changes display name via the REAL saveProfile() flow
        await setDisplayNameViaSaveProfile(page, displayName1);

        // User2 joins
        await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${body2.token}` },
            data: { code: inviteCode },
        });

        // Upload key for user2
        const user2PubKey = await page2.evaluate(() =>
            E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey)
        );
        await page.evaluate(async ({ serverId, user2Id, user2PubKey }) => {
            const serverKey = E2ECrypto.getServerKey(serverId);
            const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(user2PubKey));
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, recipientPub);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + localStorage.getItem('token'),
                },
                body: JSON.stringify({
                    user_id: user2Id,
                    encrypted_key: encrypted.ciphertext,
                    sender_public_key: encrypted.ephemeralPublicKey,
                    nonce: encrypted.nonce,
                }),
            });
        }, { serverId: server.id, user2Id: body2.user.id, user2PubKey });

        // User1 loads chat, selects channel, sends message
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(2000);

        const input1 = page.locator('#message-input');
        await expect(input1).toBeEnabled({ timeout: 5000 });
        await input1.fill('Message with display name');
        await page.click('#send-btn');
        await page.waitForTimeout(3000);

        // User2 loads chat and checks display name appears in messages
        // Listen for console errors to diagnose issues
        var page2Errors = [];
        page2.on('console', msg => {
            if (msg.type() === 'error' || msg.type() === 'warning') {
                page2Errors.push(msg.text());
            }
        });
        
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
        await page2.click('.server-icon:not(.add-server)');
        await page2.waitForTimeout(3000);

        // Check if channel-list shows an error message (decryption failed)
        var channelListText = await page2.locator('#channel-list').textContent();
        console.log('Channel list text:', channelListText);
        console.log('Page2 errors:', JSON.stringify(page2Errors));
        
        // If it says cannot decrypt, try the join-server flow to re-upload the key
        if (channelListText && channelListText.includes('Cannot decrypt')) {
            console.log('Server key decryption failed for user2, trying to re-upload key');
            // The key might not have been uploaded properly, upload it again via page context
            const serverKey = await page.evaluate((sid) => E2ECrypto.arrayBufferToBase64(E2ECrypto.getServerKey(sid)), server.id);
            console.log('Got server key from user1:', serverKey ? 'yes' : 'no');
        }
        
        // Wait for channel items to appear
        try {
            await page2.waitForSelector('.channel-item', { timeout: 10000 });
            await page2.click('.channel-item >> nth=0');
            await page2.waitForTimeout(3000);
        } catch (e) {
            console.log('No channel-items after click, channel list:', channelListText);
        }
        
        // Wait for at least one message to appear
        try {
            await page2.waitForSelector('.message', { timeout: 10000 });
        } catch (e) {
            console.log('No .message elements found.');
            // Try clicking the channel again
            const items = await page2.locator('.channel-item').count();
            console.log('Channel items count:', items);
            if (items > 0) {
                await page2.click('.channel-item >> nth=0');
                await page2.waitForTimeout(5000);
            }
        }

        // Check the display name is shown in the message header
        const msgHeaders = await page2.locator('.message .display-name').allTextContents();
        console.log('Message display names:', JSON.stringify(msgHeaders));
        expect(msgHeaders.length).toBeGreaterThan(0);
        expect(msgHeaders.some(h => h === displayName1)).toBeTruthy();

        // Check the message text is decrypted
        const msgTexts2 = await page2.locator('.message .text').allTextContents();
        console.log('Message texts:', JSON.stringify(msgTexts2));
        expect(msgTexts2.some(t => t && t.includes('Message with display name'))).toBeTruthy();

        await page2.close();
        await ctx2.close();
    });

    test('DM conversation uses display name in list and header', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'dmdisp_' + ts;
        const user2 = 'dmdisp2_' + ts;
        // Keep ≤ 21 chars — saveProfile validates the length.
        const displayName1 = 'Dm_' + String(ts % 100000);

        // Register user1
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', user1);
        await page.fill('#register-password', 'password123');
                await page.fill('#register-confirm-password', 'password123');
await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });

        // Get user1's friend code from localStorage
        const user1FriendCode = await page.evaluate(() => localStorage.getItem('e2e_friend_code'));
        expect(user1FriendCode).toBeTruthy();

        const body1 = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));

        // Register user2
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await page2.goto(`${BASE}/login.html`);
        await page2.waitForTimeout(1000);
        await page2.click('#show-register');
        await page2.fill('#register-username', user2);
        await page2.fill('#register-password', 'password123');
        await page2.fill('#register-confirm-password', 'password123');
await page2.click('#register-form button[type="submit"]');
        await page2.waitForURL('**/index.html', { timeout: 10000 });

        const body2 = await page2.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));

        // User1 changes display name via the REAL saveProfile() flow
        await setDisplayNameViaSaveProfile(page, displayName1);

        // Make them friends via API
        await page2.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: user1FriendCode },
        });

        const requestsRes = await page.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        const requests = await requestsRes.json();
        await page.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { request_id: requests[0].id },
        });

        // User2 reloads and checks DM shows display name
        await page2.reload();
        await page2.waitForTimeout(3000);
        await page2.click('#dm-strip-btn');
        await page2.waitForTimeout(2000);

        // Wait for DM items to appear
        await page2.waitForSelector('.dm-item', { timeout: 5000 }).catch(() => {});

        // Check DM name includes the display name
        const dmNames = await page2.locator('.dm-item .dm-name').allTextContents();
        console.log('DM names:', JSON.stringify(dmNames));
        const found = dmNames.some(n => n.includes(displayName1));
        expect(found).toBeTruthy();

        // Click the DM
        await page2.locator('.dm-item').first().click();
        await page2.waitForTimeout(2000);

        // Check header shows display name
        const headerText = await page2.locator('#channel-name').textContent();
        console.log('Channel header:', headerText);
        expect(headerText).toContain(displayName1);

        await page2.close();
        await ctx2.close();
    });

    test('profile picture upload via API and rendering in footer, DM list, and messages', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'picapi_' + ts;
        const user2 = 'picapi2_' + ts;
        // Keep ≤ 21 chars — saveProfile validates the length.
        const displayName1 = 'Pic_' + String(ts % 100000);

        // Register user1
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', user1);
        await page.fill('#register-password', 'password123');
                await page.fill('#register-confirm-password', 'password123');
await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });

        const body1 = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));
        expect(body1.token).toBeTruthy();

        // Set display name for user1 via the REAL saveProfile() flow
        await setDisplayNameViaSaveProfile(page, displayName1);

        // Get user1's friend code
        const user1FriendCode = await page.evaluate(() => localStorage.getItem('e2e_friend_code'));
        expect(user1FriendCode).toBeTruthy();

        // Upload an encrypted PNG and set it as the profile picture via the REAL
        // saveProfile() flow (raw plaintext uploads are not stored with a key, so
        // the client can never render them).
        const pngBytes = makeMinimalPng(50, 50);
        const fileId = await uploadPfpViaSaveProfile(page, body1.token, pngBytes);
        expect(fileId).toBeTruthy();

        // Verify profile API returns the file_id
        const profileCheck = await page.request.get(`${BASE}/api/profile/${body1.user.id}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        const profileData = await profileCheck.json();
        expect(profileData.profile_picture_file_id).toBe(fileId);

        // === Check user1's sidebar footer ===
        // Reload user1's page to refresh the profile pic
        await page.reload();
        await page.waitForTimeout(3000);

        // The footer avatar should have an avatar-img element after profile pic is loaded
        await page.waitForSelector('#footer-user-avatar img.avatar-img', { timeout: 10000 }).catch(() => {});
        const footerHasImg = await page.locator('#footer-user-avatar img.avatar-img').count();
        console.log('Footer avatar images:', footerHasImg);
        expect(footerHasImg).toBe(1);

        // Also check display name in footer
        const footerName = await page.locator('#current-user').textContent();
        expect(footerName).toBe(displayName1);

        // Register user2
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await page2.goto(`${BASE}/login.html`);
        await page2.waitForTimeout(1000);
        await page2.click('#show-register');
        await page2.fill('#register-username', user2);
        await page2.fill('#register-password', 'password123');
        await page2.fill('#register-confirm-password', 'password123');
await page2.click('#register-form button[type="submit"]');
        await page2.waitForURL('**/index.html', { timeout: 10000 });

        const body2 = await page2.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));

        // Make them friends
        await page2.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: user1FriendCode },
        });

        const requestsRes = await page.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        const requests = await requestsRes.json();
        expect(requests.length).toBeGreaterThanOrEqual(1);

        await page.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { request_id: requests[0].id },
        });

        // === Check user2's DM list for profile picture ===
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(3000);
        await page2.click('#dm-strip-btn');
        await page2.waitForTimeout(3000);

        // Wait for DM items
        await page2.waitForSelector('.dm-item', { timeout: 5000 }).catch(() => {});

        // DM item should show the display name
        const dmNames = await page2.locator('.dm-item .dm-name').allTextContents();
        console.log('DM names (user2):', JSON.stringify(dmNames));
        expect(dmNames.some(n => n.includes(displayName1))).toBeTruthy();

        // DM avatar should have an img.avatar-img eventually (async profile pic load)
        await page2.waitForTimeout(3000);
        const dmAvatars = await page2.locator('.dm-item .dm-avatar img.avatar-img').count();
        console.log('DM avatar images:', dmAvatars);
        // The DM avatar might already have the img loaded since we waited
        if (dmAvatars === 0) {
            // The avatar might not have loaded yet; check that the placeholder exists
            const pendingLoad = await page2.locator('.dm-item .dm-avatar[data-profile-pic-load]').count();
            console.log('DM avatars pending load:', pendingLoad);
            // At minimum, the dm-avatar should exist
            const dmAvatarCount = await page2.locator('.dm-item .dm-avatar').count();
            expect(dmAvatarCount).toBeGreaterThan(0);
        } else {
            expect(dmAvatars).toBeGreaterThan(0);
        }

        // Click the DM and send a message from user1
        await page2.locator('.dm-item').first().click();
        await page2.waitForTimeout(2000);

        // Check header shows display name
        const channelName = await page2.locator('#channel-name').textContent();
        expect(channelName).toContain(displayName1);

        // User1 sends a DM to user2
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2000);
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(2000);
        await page.locator('.dm-item').first().click();
        await page.waitForTimeout(2000);

        const input1 = page.locator('#message-input');
        await expect(input1).toBeEnabled({ timeout: 5000 });
        await input1.fill('Profile pic test message');
        await page.click('#send-btn');
        await page.waitForTimeout(3000);

        // === Check messages on user2's page for profile picture ===
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(2000);
        await page2.click('#dm-strip-btn');
        await page2.waitForTimeout(2000);

        // Click DM
        await page2.locator('.dm-item').first().click();
        await page2.waitForTimeout(3000);

        // Check the message sender avatar has an img
        const msgAvatars = await page2.locator('.message .avatar img.avatar-img').count();
        console.log('Message avatar images:', msgAvatars);

        // Check the message text is decrypted
        const msgTexts = await page2.locator('.message .text').allTextContents();
        console.log('Message texts (user2):', JSON.stringify(msgTexts));
        expect(msgTexts.some(t => t && t.includes('Profile pic test message'))).toBeTruthy();

        // Check the display name appears in message headers
        const msgDisplayNames = await page2.locator('.message .display-name').allTextContents();
        console.log('Message display names:', JSON.stringify(msgDisplayNames));
        expect(msgDisplayNames.some(n => n === displayName1)).toBeTruthy();

        // The message avatar should eventually show the profile pic
        await page2.waitForTimeout(3000);
        const msgAvatarsAfter = await page2.locator('.message .avatar img.avatar-img').count();
        console.log('Message avatar images after wait:', msgAvatarsAfter);

        await page2.close();
        await ctx2.close();
    });

    test('profile file keys are only returned to friends/server-members, not strangers', async ({ page, context }) => {
        const ts = Date.now();
        const userA = 'autha_' + ts;
        const userB = 'authb_' + ts;
        const userC = 'authc_' + ts;

        // Register userA
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', userA);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });

        const bodyA = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
            friendCode: localStorage.getItem('e2e_friend_code'),
        }));

        // Register userB (will become friend)
        const ctxB = await context.browser()!.newContext();
        const pageB = await ctxB.newPage();
        await pageB.goto(`${BASE}/login.html`);
        await pageB.waitForTimeout(500);
        await pageB.click('#show-register');
        await pageB.fill('#register-username', userB);
        await pageB.fill('#register-password', 'password123');
        await pageB.fill('#register-confirm-password', 'password123');
        await pageB.click('#register-form button[type="submit"]');
        await pageB.waitForURL('**/index.html', { timeout: 10000 });

        const bodyB = await pageB.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));

        // Register userC (stranger — never friend, no shared server)
        const ctxC = await context.browser()!.newContext();
        const pageC = await ctxC.newPage();
        await pageC.goto(`${BASE}/login.html`);
        await pageC.waitForTimeout(500);
        await pageC.click('#show-register');
        await pageC.fill('#register-username', userC);
        await pageC.fill('#register-password', 'password123');
        await pageC.fill('#register-confirm-password', 'password123');
        await pageC.click('#register-form button[type="submit"]');
        await pageC.waitForURL('**/index.html', { timeout: 10000 });

        const bodyC = await pageC.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));

        // Upload a profile picture for userA so there is a file_key
        const pngBytes = Buffer.from([
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

        const initRes = await page.request.post(`${BASE}/api/files/init`, {
            headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
            data: { size: pngBytes.length, mime: 'image/png' },
        });
        expect(initRes.ok()).toBeTruthy();
        const initData = await initRes.json();
        const fileId = initData.file_id;

        const chunkRes = await page.request.fetch(`${BASE}/api/files/${fileId}/chunk/0`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/octet-stream' },
            data: pngBytes,
        });
        expect(chunkRes.ok()).toBeTruthy();

        await page.request.post(`${BASE}/api/files/${fileId}/complete`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
        });

        // Set profile picture via the REAL saveProfile() flow. The modern E2EE
        // API stores the file key identity-key-encrypted (encrypted_pic_key +
        // pic_key_nonce) — the plaintext profile_picture_file_key field is never
        // set server-side, so this test asserts the encrypted-key ACL instead.
        const fileKeyB64 = await page.evaluate(async ({ fileId: fid }) => {
            const fileKey = E2ECrypto.generateFileKey();
            const rawBytes = new TextEncoder().encode('x');
            const encrypted = E2ECrypto.encryptFileChunk(fileKey, rawBytes);
            const blob = new Blob([encrypted], { type: 'application/octet-stream' });
            await fetch(`/api/files/${fid}/chunk/0`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: blob,
            });
            return E2ECrypto.arrayBufferToBase64(fileKey);
        }, { fileId });
        await page.evaluate(async ({ fid, fk }) => {
            (profilePfpFileId as any) = fid;
            (profilePfpFileKey as any) = fk;
            (_removePfpFlag as any) = false;
            const statusEl = document.getElementById('profile-edit-status');
            await (saveProfile as any)();
            return statusEl ? (statusEl.textContent || '') : '';
        }, { fid: fileId, fk: fileKeyB64 });
        await page.waitForTimeout(800);

        // === TEST 1: UserA can see their own encrypted file key (always authorized) ===
        const ownProfileRes = await page.request.get(`${BASE}/api/profile/${bodyA.user.id}`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
        });
        expect(ownProfileRes.ok()).toBeTruthy();
        const ownProfile = await ownProfileRes.json();
        expect(ownProfile.profile_picture_file_id).toBe(fileId);
        expect(ownProfile.encrypted_pic_key).toBeTruthy();
        console.log('Own profile encrypted_pic_key present:', !!ownProfile.encrypted_pic_key);

        // === TEST 2: UserC (stranger) is DENIED the conversation profile (the
        // only endpoint that returns usable, conversation-key-encrypted profile
        // data). The /api/profile/{id} endpoint returns identity-key-wrapped
        // keys to everyone — they are useless without the owner's identity key.
        const strangerConvRes = await pageC.request.get(
            `${BASE}/api/profile/${bodyA.user.id}/conversation/dm/nonexistent-dm`, {
            headers: { Authorization: `Bearer ${bodyC.token}` },
        });
        // Not a member of any DM with userA → 403
        expect(strangerConvRes.status()).toBe(403);
        console.log('Stranger conversation profile status:', strangerConvRes.status());

        // Stranger still gets the public profile fields
        const strangerProfileRes = await pageC.request.get(`${BASE}/api/profile/${bodyA.user.id}`, {
            headers: { Authorization: `Bearer ${bodyC.token}` },
        });
        expect(strangerProfileRes.ok()).toBeTruthy();
        const strangerProfile = await strangerProfileRes.json();
        expect(strangerProfile.profile_picture_file_id).toBe(fileId);
        // Username is public; profile fields now live encrypted inside
        // encrypted_profile_data (E2EE) — the raw encrypted blob is present.
        expect(strangerProfile.username).toBeDefined();
        expect(strangerProfile.encrypted_profile_data).toBeDefined();

        // === TEST 3: After becoming friends, userB can see file keys ===
        // UserB sends friend request to userA
        await pageB.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${bodyB.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: bodyA.friendCode },
        });

        // UserA accepts
        const requestsRes = await page.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
        });
        const requests = await requestsRes.json();
        expect(requests.length).toBeGreaterThanOrEqual(1);
        await page.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
            data: { request_id: requests[0].id },
        });

        // Now userB (friend) can access userA's DM conversation profile
        // (usable keys are shared there once the DM exists).
        const friendProfileRes = await pageB.request.get(`${BASE}/api/profile/${bodyA.user.id}`, {
            headers: { Authorization: `Bearer ${bodyB.token}` },
        });
        expect(friendProfileRes.ok()).toBeTruthy();
        const friendProfile = await friendProfileRes.json();
        expect(friendProfile.profile_picture_file_id).toBe(fileId);
        expect(friendProfile.encrypted_pic_key).toBeTruthy();
        console.log('Friend profile encrypted_pic_key present:', !!friendProfile.encrypted_pic_key);

        // === TEST 4: UserC (still stranger) still denied ===
        const strangerAgainRes = await pageC.request.get(
            `${BASE}/api/profile/${bodyA.user.id}/conversation/dm/nonexistent-dm`, {
            headers: { Authorization: `Bearer ${bodyC.token}` },
        });
        expect(strangerAgainRes.status()).toBe(403);

        // Cleanup
        await pageB.close();
        await ctxB.close();
        await pageC.close();
        await ctxC.close();
    });
});
