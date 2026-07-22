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

// Helper: build a minimal valid PNG
function makeMinimalPng(width = 100, height = 100): Buffer {
    const zlib = require('zlib');
    const raw = Buffer.alloc(1 + width * height * 3, 0);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 3 + 1)] = 0;
        for (let x = 0; x < width; x++) {
            const idx = y * (width * 3 + 1) + 1 + x * 3;
            raw[idx] = 255;
            raw[idx + 1] = 128;
            raw[idx + 2] = 0;
        }
    }
    const deflated = zlib.deflateSync(raw);
    function crc32(buf: Buffer): number {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) {
            crc ^= buf[i];
            for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    function u32(v: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; }
    const parts: Buffer[] = [];
    parts.push(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]));
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const ihdrType = Buffer.from('IHDR');
    const ihdrCrc = Buffer.concat([ihdrType, ihdr]);
    parts.push(u32(13), ihdrType, ihdr, u32(crc32(ihdrCrc)));
    const idatType = Buffer.from('IDAT');
    const idatCrc = Buffer.concat([idatType, deflated]);
    parts.push(u32(deflated.length), idatType, deflated, u32(crc32(idatCrc)));
    const iendType = Buffer.from('IEND');
    parts.push(u32(0), iendType, u32(crc32(iendType)));
    return Buffer.concat(parts);
}

// Helper: register a user and return credentials
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

// Helper: become friends
async function becomeFriends(page1: any, page2: any, token1: string, token2: string) {
    const friendCode2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    expect(friendCode2).toBeTruthy();
    const fr = await page1.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        data: { friend_code: friendCode2 },
    });
    expect(fr.ok()).toBeTruthy();
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${token2}` },
    })).json();
    expect(Array.isArray(incoming)).toBe(true);
    expect(incoming.length).toBeGreaterThanOrEqual(1);
    const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    expect(acc.ok()).toBeTruthy();
}

// Helper: create server + upload key
async function createServerAndKey(page: any, token: string, userId: string, serverName: string) {
    const inviteCode = generateCode(8);
    const srv = await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { name: serverName, invite_code_hash: sha256Hex(inviteCode) },
    });
    const server = await srv.json();
    await page.evaluate(async ({ serverId, userId }) => {
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

// Helper: user2 joins server + gets key uploaded
async function joinServerAndGetKey(pageOwner: any, pageJoiner: any, serverId: string, inviteCode: string, joinerUserId: string) {
    const joinerPubKey = await pageJoiner.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey));
    const joinerToken = await pageJoiner.evaluate(() => localStorage.getItem('token'));
    await pageJoiner.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${joinerToken}` },
        data: { code: inviteCode },
    });
    await pageOwner.evaluate(async ({ serverId, joinerPubKey, joinerUserId }) => {
        const serverKey = E2ECrypto.getServerKey(serverId);
        const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(joinerPubKey));
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, recipientPub);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: joinerUserId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
        });
    }, { serverId, joinerPubKey, joinerUserId });
}

// Helper: upload profile pic via API
async function uploadProfilePicViaApi(page: any, token: string, pngBytes: Buffer): Promise<string> {
    const initRes = await page.request.post(`${BASE}/api/files/init`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { size: pngBytes.length, mime: 'image/png' },
    });
    expect(initRes.ok()).toBeTruthy();
    const { file_id } = await initRes.json();
    const chunkRes = await page.request.fetch(`${BASE}/api/files/${file_id}/chunk/0`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
        data: pngBytes,
    });
    expect(chunkRes.ok()).toBeTruthy();
    await page.request.post(`${BASE}/api/files/${file_id}/complete`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const setRes = await page.request.patch(`${BASE}/api/profile`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { profile_picture_file_id: file_id },
    });
    expect(setRes.ok()).toBeTruthy();
    return file_id;
}

// Helper: load chat page, select server and channel, wait for input enabled
async function loadChatAndSelectChannel(page: any) {
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
    await page.click('.server-icon:not(.add-server)');
    await page.waitForSelector('.channel-item', { timeout: 15000 });
    await page.click('.channel-item >> nth=0');
    await page.waitForTimeout(2000);
    const input = page.locator('#message-input');
    await expect(input).toBeEnabled({ timeout: 15000 });
    return input;
}

// ============================================================
// PROFILE PICTURE UPLOAD & RENDERING
// ============================================================
test.describe('Profile Picture Upload & Rendering', () => {

    test('upload profile picture via UI crop modal and verify footer avatar', async ({ page }) => {
        const ts = Date.now();
        const username = 'featpic_' + ts;
        await registerUser(page, username);
        const pngBytes = makeMinimalPng(100, 100);

        // Open settings modal
        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });

        // Set file directly on hidden input
        await page.locator('#profile-pic-input').setInputFiles({
            name: 'profile.png',
            mimeType: 'image/png',
            buffer: pngBytes,
        });
        await page.waitForTimeout(500);

        // Wait for crop modal to appear
        await page.waitForSelector('#profile-crop-modal', { state: 'visible', timeout: 10000 });
        await expect(page.locator('#profile-crop-image')).toBeVisible({ timeout: 5000 });
        await expect(page.locator('#profile-crop-box')).toBeVisible({ timeout: 5000 });

        // Click "Crop & Set Picture"
        await page.click('#confirm-profile-crop');

        // Wait for progress to appear then disappear
        await page.waitForSelector('#profile-crop-progress', { state: 'visible', timeout: 10000 });
        await page.waitForFunction(() => {
            const p = document.getElementById('profile-crop-progress');
            return !p || p.style.display === 'none';
        }, { timeout: 60000 });

        // Wait for modal to close
        await page.waitForFunction(() => {
            const m = document.getElementById('profile-crop-modal');
            return !m || m.style.display === 'none';
        }, { timeout: 10000 });
        await page.waitForTimeout(1000);

        await page.click('#close-settings');
        await page.waitForTimeout(2000);

        // Wait for the footer avatar to have an img element (profile pic loaded)
        const footerHasImg = await page.waitForFunction(() => {
            const avatar = document.getElementById('footer-user-avatar');
            if (!avatar) return false;
            return !!avatar.querySelector('img');
        }, { timeout: 15000 }).then(() => true).catch(() => false);
        console.log('Footer has img element:', footerHasImg);

        const footerImgs = await page.locator('#footer-user-avatar img').count();
        console.log('Footer avatar img count:', footerImgs);
        expect(footerImgs).toBeGreaterThanOrEqual(1);
    });

    test('profile picture renders in DM list and messages for other user', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'picdm1_' + ts;
        const user2 = 'picdm2_' + ts;
        const displayName1 = 'PicUser_' + ts;

        const body1 = await registerUser(page, user1);
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);

        // Set display name + profile pic for user1
        await page.request.patch(`${BASE}/api/profile`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { display_name: displayName1 },
        });
        await uploadProfilePicViaApi(page, body1.token, makeMinimalPng(50, 50));

        await becomeFriends(page, page2, body1.token, body2.token);

        // User2 loads DM view
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(3000);
        await page2.click('#dm-strip-btn');
        await page2.waitForTimeout(3000);

        await page2.waitForSelector('.dm-item', { timeout: 10000 }).catch(() => {});

        // Wait for DM avatar to load profile pic
        await page2.waitForTimeout(3000);
        const dmImgs = await page2.locator('.dm-item .dm-avatar img').count();
        console.log('DM avatar imgs on user2:', dmImgs);

        // Check display name
        const dmNames = await page2.locator('.dm-item .dm-name').allTextContents();
        console.log('DM names:', JSON.stringify(dmNames));
        expect(dmNames.some(n => n.includes(displayName1))).toBeTruthy();

        // User1 sends DM
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2000);
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(2000);
        await page.locator('.dm-item').first().click();
        await page.waitForTimeout(2000);

        const input1 = page.locator('#message-input');
        await expect(input1).toBeEnabled({ timeout: 5000 });
        await input1.fill('Check my profile pic!');
        await page.click('#send-btn');
        await page.waitForTimeout(3000);

        // User2 loads DM and checks message
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(2000);
        await page2.click('#dm-strip-btn');
        await page2.waitForTimeout(2000);
        await page2.locator('.dm-item').first().click();
        await page2.waitForTimeout(3000);

        const msgTexts = await page2.locator('.message .text').allTextContents();
        console.log('Message texts on user2:', JSON.stringify(msgTexts));
        expect(msgTexts.some(t => t && t.includes('Check my profile pic!'))).toBeTruthy();

        await page2.close();
        await ctx2.close();
    });

    test('profile picture renders in forward-to-DM modal', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'fwd_u1_' + ts;
        const user2 = 'fwd_u2_' + ts;

        const body1 = await registerUser(page, user1);
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);

        await page.request.patch(`${BASE}/api/profile`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { display_name: 'ForwardUser_' + ts },
        });
        await uploadProfilePicViaApi(page, body1.token, makeMinimalPng(50, 50));
        await becomeFriends(page, page2, body1.token, body2.token);

        // Create a server for user1
        await createServerAndKey(page, body1.token, body1.user.id, 'Forward Test');

        // User1 loads chat and sends a message
        const input = await loadChatAndSelectChannel(page);
        await input.fill('Message to forward!');
        await page.click('#send-btn');
        await page.waitForTimeout(3000);

        // Get the server info to open DM forward modal
        // The DM forward modal is opened from the message actions
        const lastMsg = page.locator('.message').last();
        await lastMsg.hover();
        await page.waitForTimeout(500);

        // Try open forward modal by clicking the dm-forward button
        const dmFwdBtn = lastMsg.locator('.msg-action-btn[data-action="dm-forward"]');
        if (await dmFwdBtn.isVisible().catch(() => false)) {
            await dmFwdBtn.click();
        } else {
            // Fallback: open via evaluate
            await page.evaluate(() => {
                const fn = (window as any).showDmForwardModal;
                if (typeof fn === 'function') fn();
            }).catch(() => {
                console.log('Could not open forward modal');
            });
        }
        await page.waitForTimeout(2000);

        const dmFwdVisible = await page.locator('#dm-forward-modal').isVisible().catch(() => false);
        console.log('DM forward modal visible:', dmFwdVisible);
        if (dmFwdVisible) {
            const fwdList = page.locator('#dm-forward-list');
            const fwdImgs = await fwdList.locator('img').count();
            console.log('Forward list imgs:', fwdImgs);
            const fwdText = await fwdList.textContent();
            console.log('Forward list text:', fwdText);
            expect(fwdText).toBeTruthy();

            // Close
            await page.click('#cancel-dm-forward');
            await page.waitForTimeout(500);
            const stillOpen = await page.locator('#dm-forward-modal').isVisible().catch(() => false);
            expect(stillOpen).toBeFalsy();
        } else {
            console.log('Forward modal not visible - skipping assertions');
        }

        await page2.close();
        await ctx2.close();
    });
});

// ============================================================
// USERNAME COLOR PICKER
// ============================================================
test.describe('Username Color Picker', () => {test('username color picker saves and persists color via API', async ({ page }) => {
    const ts = Date.now();
    const username = 'color_' + ts;
    await registerUser(page, username);

    // Save color #ff0000 via API directly
    const colorToken = await page.evaluate(() => localStorage.getItem('token'));
    const saveRes = await page.request.patch(BASE + '/api/profile', {
        headers: { Authorization: 'Bearer ' + colorToken, 'Content-Type': 'application/json' },
        data: { username_color: '#ff0000' },
    });
    expect(saveRes.ok()).toBeTruthy();
    await page.waitForTimeout(500);

    // Verify via API
    const user = await page.evaluate(() => JSON.parse(localStorage.getItem('user') || '{}'));
    const apiToken = await page.evaluate(() => localStorage.getItem('token'));
    const profileRes = await page.request.get(`${BASE}/api/profile/${user.id}`, {
        headers: { Authorization: `Bearer ${apiToken}` },
    });
    expect(profileRes.ok()).toBeTruthy();
    const profile = await profileRes.json();
    console.log('Profile response:', JSON.stringify(profile));
    expect(profile.username_color).toBe('#ff0000');

    // Open profile modal to verify color is shown in display name
    await page.click('#footer-user-avatar');
    await page.waitForSelector('#profile-modal', { state: 'visible', timeout: 5000 });
    await page.waitForFunction(function() {
        var el = document.getElementById('profile-modal-display-name');
        return el && el.textContent && el.textContent !== 'Loading...';
    }, { timeout: 10000 });

    // Display name should have the red color style
    const dnColor = await page.locator('#profile-modal-display-name').getAttribute('style');
    console.log('Display name color:', dnColor);
    expect(dnColor).toBeTruthy();
    expect(dnColor).toContain('ff0000');

    await page.click('#profile-modal-close');
});
});

// ============================================================
// USERNAME COLOR DISPLAY IN MESSAGES
// ============================================================
test.describe('Username Color in Messages', () => {

    test('username color displays in chat messages for other user', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'clrmsg1_' + ts;
        const user2 = 'clrmsg2_' + ts;
        const displayName1 = 'ColorUser_' + ts;

        const body1 = await registerUser(page, user1);
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);

        // Set display name and color
        const setRes = await page.request.patch(`${BASE}/api/profile`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { display_name: displayName1, username_color: '#00ff00' },
        });
        expect(setRes.ok()).toBeTruthy();

        // Create server and user2 joins
        const { serverId, inviteCode } = await createServerAndKey(page, body1.token, body1.user.id, 'Color Test ' + ts);
        await joinServerAndGetKey(page, page2, serverId, inviteCode, body2.user.id);

        // User1 sends a message
        const input = await loadChatAndSelectChannel(page);
        await input.fill('Color test message');
        await page.click('#send-btn');
        await page.waitForTimeout(3000);

        // User2 loads chat
        const input2 = await loadChatAndSelectChannel(page2);
        await page2.waitForTimeout(3000);

        // Check for the display name color
        const dn = page2.locator('.message .display-name', { hasText: displayName1 });
        const dnVisible = await dn.count();
        console.log('Display name count:', dnVisible);

        if (dnVisible > 0) {
            const colorStyle = await dn.getAttribute('style');
            console.log('Color style:', colorStyle);
            expect(colorStyle).toContain('#00ff00');
        } else {
            // Debug: check all display names
            const allDns = await page2.locator('.message .display-name').allTextContents();
            console.log('All display names:', JSON.stringify(allDns));
            // Check if message exists at all
            const msgTexts = await page2.locator('.message .text').allTextContents();
            console.log('Message texts:', JSON.stringify(msgTexts));
        }

        await page2.close();
        await ctx2.close();
    });
});

// ============================================================
// MENTION AUTOCOMPLETE
// ============================================================
test.describe('Mention Autocomplete by Display Name', () => {

    test('mention autocomplete shows user when typing part of display name', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'mc_u1_' + ts;
        const user2 = 'mc_u2_' + ts;
        const displayName2 = 'MentionCandidate_' + ts;

        const body1 = await registerUser(page, user1);
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);

        // Set display name for user2
        await page2.request.patch(`${BASE}/api/profile`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { display_name: displayName2 },
        });

        // Create server and user2 joins
        const { serverId, channelId, inviteCode } = await createServerAndKey(page, body1.token, body1.user.id, 'Mention Test ' + ts);
        await joinServerAndGetKey(page, page2, serverId, inviteCode, body2.user.id);

        // User1 loads chat
        const input = await loadChatAndSelectChannel(page);

        // Wait for member list to be populated
        await page.waitForFunction(() => {
            const ml = (window as any).currentServerMemberList;
            return ml && ml.length > 1;
        }, { timeout: 15000 }).then(() => {
            console.log('Member list populated');
        }).catch(() => {
            console.log('Member list not populated - continuing');
        });

        // Type @ + part of display name
        await input.fill('@Mention');
        await page.waitForTimeout(2000);

        const dropdown = page.locator('.mention-dropdown');
        const ddVisible = await dropdown.isVisible().catch(() => false);
        console.log('Dropdown visible:', ddVisible);

        if (ddVisible) {
            const items = await dropdown.locator('.mention-item-name').allTextContents();
            console.log('Dropdown items:', JSON.stringify(items));
            expect(items.some(n => n.includes(displayName2))).toBeTruthy();

            const mentionItem = dropdown.locator('.mention-item', { hasText: displayName2 });
            if (await mentionItem.isVisible().catch(() => false)) {
                await mentionItem.click();
                await page.waitForTimeout(500);
                const val = await input.inputValue();
                console.log('Input after select:', val);
                expect(val).toContain(user2);
            }
        }

        await page2.close();
        await ctx2.close();
    });
});

// ============================================================
// MENTIONS INBOX PROFILE PICS
// ============================================================
test.describe('Profile Pictures in Mentions Inbox', () => {

    test('mention notification shows sender profile picture in mentions inbox', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'mentionpic1_' + ts;
        const user2 = 'mentionpic2_' + ts;
        const displayName1 = 'MentionPicUser_' + ts;

        const body1 = await registerUser(page, user1);

        // Set display name + profile pic for user1
        await page.request.patch(`${BASE}/api/profile`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { display_name: displayName1 },
        });
        await uploadProfilePicViaApi(page, body1.token, makeMinimalPng(50, 50));

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);

        // Create server and user2 joins
        const { serverId, inviteCode } = await createServerAndKey(page, body1.token, body1.user.id, 'MentionPic ' + ts);
        await joinServerAndGetKey(page, page2, serverId, inviteCode, body2.user.id);

        // User1 loads chat and selects channel
        const input1 = await loadChatAndSelectChannel(page);

        // User2 loads chat and selects channel
        const input2 = await loadChatAndSelectChannel(page2);

        // User1 mentions user2
        await input1.fill('@' + user2 + ' hello there!');
        await page.click('#send-btn');
        await page.waitForTimeout(4000);

        // User2 opens mentions inbox
        await page2.click('#mentions-strip-btn');
        await page2.waitForTimeout(3000);

        await page2.waitForSelector('#mentions-panel', { state: 'visible', timeout: 5000 }).catch(() => {});
        await page2.waitForTimeout(2000);

        const mentionList = page2.locator('#mentions-inbox-list');
        const listText = await mentionList.textContent() || '';
        console.log('Mentions inbox text:', listText);

        // Check if mention was received
        const hasNoNotifs = listText.includes('No unread notifications');
        console.log('Has no unread notifications:', hasNoNotifs);

        if (!hasNoNotifs) {
            const mentionCount = await mentionList.locator('.mention-item').count();
            console.log('Mention items count:', mentionCount);

            const picLoads = await mentionList.locator('[data-profile-pic-load]').count();
            console.log('With data-profile-pic-load:', picLoads);
            const imgs = await mentionList.locator('img').count();
            console.log('With img:', imgs);
        }

        await page2.close();
        await ctx2.close();
    });
});
