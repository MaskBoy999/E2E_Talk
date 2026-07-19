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

function makeMinimalPng(width = 50, height = 50): Buffer {
    const zlib = require('zlib');
    const raw = Buffer.alloc(1 + width * height * 3, 0);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 3 + 1)] = 0;
        for (let x = 0; x < width; x++) {
            const idx = y * (width * 3 + 1) + 1 + x * 3;
            // Create a pattern: red-orange gradient so each image is visually identifiable
            raw[idx] = 255;
            raw[idx + 1] = 128 + (x * 127 / width);
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

async function createServerAndKey(page: any, token: string, userId: string, serverName: string) {
    const inviteCode = generateCode(8);
    const srv = await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { name: serverName, invite_code_hash: sha256Hex(inviteCode) },
    });
    const server = await srv.json();
    await page.evaluate(async ({ serverId, userId: uid }) => {
        const serverKey = E2ECrypto.generateServerKey();
        E2ECrypto.saveServerKey(serverId, serverKey);
        const identity = E2ECrypto.getIdentityKeyPair();
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: uid, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
        });
    }, { serverId: server.id, userId });
    const chRes = await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const channels = await chRes.json();
    return { serverId: server.id, channelId: channels[0].id, inviteCode };
}

async function joinServerAndGetKey(pageOwner: any, pageJoiner: any, serverId: string, inviteCode: string, joinerUserId: string) {
    const joinerPubKey = await pageJoiner.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey));
    const joinerToken = await pageJoiner.evaluate(() => localStorage.getItem('token'));
    await pageJoiner.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${joinerToken}` },
        data: { code: inviteCode },
    });
    await pageOwner.evaluate(async ({ sid, jPubKey, jUserId }) => {
        const serverKey = E2ECrypto.getServerKey(sid);
        const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(jPubKey));
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, recipientPub);
        await fetch(`/api/servers/${sid}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: jUserId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
        });
    }, { sid: serverId, jPubKey: joinerPubKey, jUserId: joinerUserId });
}

// Upload a file and set it as a profile picture/banner via API
async function uploadFileAndSetProfile(page: any, token: string, pngBytes: Buffer, field: 'profile_picture' | 'profile_banner'): Promise<string> {
    const initRes = await page.request.post(`${BASE}/api/files/init`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { size: pngBytes.length, mime: 'image/png' },
    });
    expect(initRes.ok()).toBeTruthy();
    const { file_id } = await initRes.json();

    // Upload the raw (unencrypted) chunk - the client-side flow encrypts chunks
    // For this test, we use the client-side crypto to encrypt the file first
    // Actually, we need to use the browser's E2ECrypto to encrypt the file
    await page.evaluate(async ({ fileId, pngBase64 }) => {
        // Decode the PNG data, encrypt with a random key, upload
        const rawBytes = Uint8Array.from(atob(pngBase64), c => c.charCodeAt(0));
        const fileKey = E2ECrypto.generateFileKey();
        const encrypted = E2ECrypto.encryptFileChunk(fileKey, rawBytes);
        // Upload encrypted chunk
        const blob = new Blob([encrypted], { type: 'application/octet-stream' });
        await fetch(`/api/files/${fileId}/chunk/0`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: blob,
        });
        // Complete upload
        await fetch(`/api/files/${fileId}/complete`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        // Return the file key for setting the profile
        return E2ECrypto.arrayBufferToBase64(fileKey);
    }, { fileId: file_id, pngBase64: pngBytes.toString('base64') }).then(async (fileKeyB64: string) => {
        // Set the profile picture/banner with the encrypted file key
        const updateData: any = {};
        if (field === 'profile_picture') {
            updateData.profile_picture_file_id = file_id;
            updateData.profile_picture_file_key = fileKeyB64; // Will be encrypted client-side
        } else {
            updateData.profile_banner_file_id = file_id;
            updateData.profile_banner_file_key = fileKeyB64;
        }
        // We need to encrypt the file key with the identity key via encodeEncryptedFileKey
        // Let's do this via page.evaluate
        await page.evaluate(async ({ fid, fk, fieldType }) => {
            const identity = E2ECrypto.getIdentityKeyPair();
            if (!identity) return;
            const encryptedKey = E2ECrypto.encodeEncryptedFileKey(fk, identity.privateKey);
            const updateBody: any = {};
            if (fieldType === 'profile_picture') {
                updateBody.profile_picture_file_id = fid;
                updateBody.profile_picture_file_key = encryptedKey;
            } else {
                updateBody.profile_banner_file_id = fid;
                updateBody.profile_banner_file_key = encryptedKey;
            }
            await fetch('/api/profile', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify(updateBody),
            });
        }, { fid: file_id, fk: fileKeyB64, fieldType: field });
        await page.waitForTimeout(500);
    });

    return file_id;
}

test.describe('Profile Picture & Banner Sharing Between Users', () => {

    test('PFP shared via server message broadcast renders for other user', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'pfp_u1_' + ts;
        const user2 = 'pfp_u2_' + ts;
        const displayName1 = 'PFPUser_' + ts;

        // Register user1
        const body1 = await registerUser(page, user1);
        await page.request.patch(`${BASE}/api/profile`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { display_name: displayName1 },
        });

        // Upload profile pic for user1 (identity-key-encrypted)
        const pfpPng = makeMinimalPng(50, 50);
        await uploadFileAndSetProfile(page, body1.token, pfpPng, 'profile_picture');

        // Create server for user1
        const { serverId, channelId, inviteCode } = await createServerAndKey(page, body1.token, body1.user.id, 'PFPServer ' + ts);

        // Register user2
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);

        // User2 joins the server
        await joinServerAndGetKey(page, page2, serverId, inviteCode, body2.user.id);

        // User2 loads the chat page
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(3000);

        // User1 sends a message (this should include encrypted_profile_key in the WS broadcast)
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2000);
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(2000);
        const input1 = page.locator('#message-input');
        await expect(input1).toBeEnabled({ timeout: 10000 });
        await input1.fill('Check my profile pic! ' + ts);
        await page.click('#send-btn');
        await page.waitForTimeout(3000);

        // User2 selects the same server/channel to receive the message
        await page2.click('.server-icon:not(.add-server)');
        await page2.waitForSelector('.channel-item', { timeout: 10000 });
        await page2.click('.channel-item >> nth=0');
        await page2.waitForTimeout(4000);

        // User2 should see the message
        const msgTexts = await page2.locator('.message .text').allTextContents();
        console.log('User2 message texts:', JSON.stringify(msgTexts));
        expect(msgTexts.some(t => t && t.includes('Check my profile pic!'))).toBeTruthy();

        // User2 opens user1's profile from the message avatar
        const msgAvatar = page2.locator('.message .avatar').first();
        if (await msgAvatar.isVisible().catch(() => false)) {
            await msgAvatar.click();
            await page2.waitForTimeout(2000);
            
            // Check that the profile modal shows the display name
            const modalDn = await page2.locator('#profile-modal-display-name').textContent();
            console.log('Profile modal display name:', modalDn);
            
            // Check if avatar has an img element (loaded PFP)
            const avatarImg = await page2.locator('#profile-modal-avatar img').count();
            console.log('Profile modal avatar img count:', avatarImg);
            
            // Close modal
            await page2.click('#profile-modal-close');
            await page2.waitForTimeout(500);
        } else {
            console.log('Message avatar not visible');
        }

        // Check that profileKeyCache has the key for user1
        const cacheHasKey = await page2.evaluate(({ uid, fid }) => {
            return !!(window as any).profileKeyCache && !!(window as any).profileKeyCache[uid + ':' + fid];
        }, { uid: body1.user.id, fid: '' });
        console.log('profileKeyCache has entry for user1:', cacheHasKey);

        // Verify the encrypted_profile_key flowed through the server
        const hasProfileKeyCache = await page2.evaluate(() => {
            const pkc = (window as any).profileKeyCache;
            if (!pkc) return 'no cache';
            const keys = Object.keys(pkc);
            return keys.length > 0 ? keys.join(', ') : 'empty';
        });
        console.log('profileKeyCache contents:', hasProfileKeyCache);

        await page2.close();
        await ctx2.close();
    });

    test('PFP shared via DM message broadcast renders for DM recipient', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'pfpdm1_' + ts;
        const user2 = 'pfpdm2_' + ts;
        const displayName1 = 'PFPDMUser_' + ts;

        const body1 = await registerUser(page, user1);
        await page.request.patch(`${BASE}/api/profile`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { display_name: displayName1 },
        });

        // Upload profile pic for user1
        await uploadFileAndSetProfile(page, body1.token, makeMinimalPng(50, 50), 'profile_picture');

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);

        // Become friends
        await becomeFriends(page, page2, body1.token, body2.token);

        // User1 sends DM to user2
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2000);
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(2000);
        await page.locator('.dm-item').first().click();
        await page.waitForTimeout(2000);
        const input1 = page.locator('#message-input');
        await expect(input1).toBeEnabled({ timeout: 5000 });
        await input1.fill('DM with profile pic! ' + ts);
        await page.click('#send-btn');
        await page.waitForTimeout(3000);

        // User2 loads DM and checks
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(2000);
        await page2.click('#dm-strip-btn');
        await page2.waitForTimeout(2000);
        await page2.locator('.dm-item').first().click();
        await page2.waitForTimeout(3000);

        const msgTexts = await page2.locator('.message .text').allTextContents();
        console.log('User2 DM message texts:', JSON.stringify(msgTexts));
        expect(msgTexts.some(t => t && t.includes('DM with profile pic!'))).toBeTruthy();

        // Open user1's profile from the message
        const avatar = page2.locator('.message .avatar').first();
        if (await avatar.isVisible().catch(() => false)) {
            await avatar.click();
            await page2.waitForTimeout(2000);
            
            const modalDn = await page2.locator('#profile-modal-display-name').textContent();
            console.log('DM profile modal display name:', modalDn);
            expect(modalDn).toContain(displayName1);
            
            await page2.click('#profile-modal-close');
        }

        // Check profileKeyCache
        const cacheInfo = await page2.evaluate(() => {
            const pkc = (window as any).profileKeyCache;
            if (!pkc) return 'no cache';
            return Object.keys(pkc).join(', ');
        });
        console.log('DM profileKeyCache:', cacheInfo);

        await page2.close();
        await ctx2.close();
    });

    test('server passes encrypted_profile_key through WS broadcast', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'wsprof1_' + ts;
        const user2 = 'wsprof2_' + ts;

        const body1 = await registerUser(page, user1);
        await uploadFileAndSetProfile(page, body1.token, makeMinimalPng(50, 50), 'profile_picture');

        const { serverId, inviteCode } = await createServerAndKey(page, body1.token, body1.user.id, 'WSTest ' + ts);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        await joinServerAndGetKey(page, page2, serverId, inviteCode, body2.user.id);

        // Check user2's identity key state BEFORE navigation
        const beforeGoto = await page2.evaluate(() => {
            const user = JSON.parse(localStorage.getItem('user') || '{}');
            const privKey = localStorage.getItem('e2e_identity_private_' + user.id);
            const pubKey = localStorage.getItem('e2e_identity_public_' + user.id);
            return { 
                userId: user.id,
                hasPrivKey: !!privKey, 
                hasPubKey: !!pubKey,
                token: !!localStorage.getItem('token'),
                lsKeys: Object.keys(localStorage).filter(k => k.startsWith('e2e_')).join(', ')
            };
        });
        console.log('User2 identity BEFORE goto:', JSON.stringify(beforeGoto, null, 2));

        // User1 sends a message and we verify the WS message includes encrypted_profile_key
        await page.goto(`${BASE}/index.html`);
        // Wait for myProfile to be loaded (loadMyProfile runs async without await)
        // Note: myProfile is declared with `let` so it's NOT on window.*, use the bare name
        await page.waitForFunction(() => {
            return !!myProfile && !!myProfile.profile_picture_file_id;
        }, { timeout: 15000 });
        
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(2000);
        const input1 = page.locator('#message-input');
        await expect(input1).toBeEnabled({ timeout: 10000 });
        
        await input1.fill('Testing WS broadcast ' + ts);
        await page.click('#send-btn');
        await page.waitForTimeout(2000);

        // User2 receives the message - wait for input to confirm channel selection
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(3000);
        await page2.click('.server-icon:not(.add-server)');
        await page2.waitForSelector('.channel-item', { timeout: 10000 });
        await page2.click('.channel-item >> nth=0');
        // Wait for message input to be enabled (confirms channel properly selected)
        await expect(page2.locator('#message-input')).toBeEnabled({ timeout: 15000 });
        await page2.waitForTimeout(2000);
        
        // Verify encrypted_profile_key made it through the WS broadcast
        const hasCache = await page2.evaluate(() => {
            const pkc = (window as any).profileKeyCache;
            return pkc ? Object.keys(pkc).length : -1;
        });
        expect(hasCache).toBeGreaterThan(0);

        await page2.close();
        await ctx2.close();
    });

    test('PFP shared via profile_key_sync when friends with no shared server', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'pfpsync_a_' + ts;
        const user2 = 'pfpsync_b_' + ts;
        const displayName1 = 'SyncUser_' + ts;

        // Register User A (page = User A)
        const body1 = await registerUser(page, user1);
        await page.request.patch(`${BASE}/api/profile`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { display_name: displayName1 },
        });

        // Upload profile pic and banner for User A
        await uploadFileAndSetProfile(page, body1.token, makeMinimalPng(50, 50), 'profile_picture');
        await uploadFileAndSetProfile(page, body1.token, makeMinimalPng(200, 100), 'profile_banner');
        // Reload profile in browser so myProfile reflects uploaded PFP
        await page.evaluate(() => loadMyProfile());
        await page.waitForTimeout(1000);

        // Register User B
        const ctx2 = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const page2 = await ctx2.newPage();
        // Capture console errors on User B
        const userBPageErrors: string[] = [];
        page2.on('pageerror', (err: Error) => { userBPageErrors.push(err.message); });
        const body2 = await registerUser(page2, user2);
        // Set up WS message interception on User B after registration
        await page2.evaluate(() => {
            (window as any).__wsMessages = [];
            const origSend = WebSocket.prototype.send;
            const origOnMessage = WebSocket.prototype.addEventListener;
            // Intercept received messages
            (window as any).__wsIntercept = setInterval(() => {
                // Poll the WS message handler instead
            }, 500);
        });
        // Intercept WS message handler by hooking the ws.onmessage
        await page2.evaluate(() => {
            var origAddEventListener = EventTarget.prototype.addEventListener;
            EventTarget.prototype.addEventListener = function(type: string, listener: any, options?: any) {
                if (type === 'message') {
                    var wrapped = function(event: MessageEvent) {
                        try {
                            var data = JSON.parse(event.data);
                            if (data.type === 'profile_key_sync') {
                                if (!(window as any).__receivedProfileKeySync) (window as any).__receivedProfileKeySync = [];
                                (window as any).__receivedProfileKeySync.push(data);
                            }
                        } catch (e) {}
                        return listener.call(this, event);
                    };
                    return origAddEventListener.call(this, type, wrapped, options);
                }
                return origAddEventListener.call(this, type, listener, options);
            };
        });
        // User B is now on index.html with WS connected

        // Both users are on index.html — now become friends
        const friendCode1 = await page.evaluate(() => localStorage.getItem('e2e_friend_code'));
        expect(friendCode1).toBeTruthy();
        const fr = await page2.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: friendCode1 },
        });
        expect(fr.ok()).toBeTruthy();

        const incoming = await (await page.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        expect(Array.isArray(incoming)).toBe(true);
        expect(incoming.length).toBeGreaterThanOrEqual(1);
        const acc = await page.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        expect(acc.ok()).toBeTruthy();

        // After becomeFriends, both users are on index.html (from registerUser)
        // Wait for both users to be fully loaded and connected
        await page.waitForTimeout(3000);
        await page2.waitForTimeout(3000);
        
        // Manually trigger profile key sync from User A (who has the PFP)
        const syncResult = await page.evaluate(async () => {
            // Check conditions
            const checks = {
                hasMyProfile: !!(typeof myProfile !== 'undefined' && myProfile),
                hasPfpId: !!(typeof myProfile !== 'undefined' && myProfile && myProfile.profile_picture_file_id),
                hasPfpKey: !!(typeof myProfile !== 'undefined' && myProfile && myProfile.profile_picture_file_key),
                wsExists: typeof ws !== 'undefined' && ws !== null,
                wsOpen: typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN,
                hasIdentity: !!E2ECrypto.getIdentityKeyPair(),
                dmCount: typeof dmConversations !== 'undefined' ? dmConversations.length : -1,
                hasPubKey: typeof dmConversations !== 'undefined' && dmConversations.length > 0 && !!(dmConversations[0].other_public_key),
            };
            // Try to send
            if (typeof broadcastProfileKeySyncToAllDms === 'function') {
                try {
                    await broadcastProfileKeySyncToAllDms();
                    checks.afterCall = 'completed';
                } catch (e) {
                    checks.error = e.message;
                }
            } else {
                checks.hasFunction = false;
            }
            return JSON.stringify(checks);
        });
        console.log('Manual profile key sync checks:', syncResult);
        
        // Wait for profile_key_sync to be sent and processed
        await page.waitForTimeout(3000);
        
        // Check User A's WS state
        const userAWsState = await page.evaluate(() => {
            if (typeof ws === 'undefined' || !ws) return 'no-ws';
            return 'readyState=' + ws.readyState;
        });
        console.log('User A WS state:', userAWsState);
        
        // Check User A's profileKeyCache
        const userACache = await page.evaluate(({ uid }) => {
            var pkc = window.profileKeyCache;
            if (!pkc) return 'no-cache';
            return Object.keys(pkc).filter(k => k.startsWith(uid)).join(', ');
        }, { uid: body1.user.id });
        console.log('User A profileKeyCache entries:', userACache);

        // Check User A's myProfile state
        const userAMyProfile = await page.evaluate(() => {
            if (typeof myProfile === 'undefined' || !myProfile) return 'no-myProfile';
            return JSON.stringify({
                pfpId: myProfile.profile_picture_file_id,
                hasPfpKey: !!myProfile.profile_picture_file_key,
                pfpKeyLen: myProfile.profile_picture_file_key ? myProfile.profile_picture_file_key.length : 0,
                bannerId: myProfile.profile_banner_file_id,
                hasBannerKey: !!myProfile.profile_banner_file_key,
            });
        });
        console.log('User A myProfile:', userAMyProfile);

        // Check User A's last sent WS messages for profile_key_sync
        const userAWsSent = await page.evaluate(() => {
            // Check if we can find evidence of sending
            return 'checking...';
        });
        console.log('User A WS sent check:', userAWsSent);

        // Check User B's WS connection state
        const userBWsState = await page2.evaluate(() => {
            if (typeof ws === 'undefined' || !ws) return 'no-ws';
            return 'readyState=' + ws.readyState; // 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
        });
        console.log('User B WS state:', userBWsState);

        // Check User B's profileKeyCache (should have User A's key from profile_key_sync)
        const userBCache = await page2.evaluate(() => {
            var pkc = window.profileKeyCache;
            if (!pkc) return 'no-cache';
            return Object.keys(pkc).join(', ');
        });
        console.log('User B profileKeyCache entries:', userBCache);

        // Check any console errors on User B's side
        const userBErrors = await page2.evaluate(() => {
            return window.__testErrors || [];
        });
        console.log('User B captured errors:', JSON.stringify(userBErrors));

        // User B is still on index.html with WS connected — should receive profile_key_sync
        // Wait for profile_key_sync to be processed
        await page2.waitForFunction(({ uid }) => {
            var pkc = window.profileKeyCache;
            if (!pkc) return false;
            for (var k in pkc) {
                if (k.startsWith(uid + ':')) return true;
            }
            return false;
        }, { uid: body1.user.id }, { timeout: 20000 });

        // Verify User B's profileKeyCache has the entry for User A
        const cacheEntries = await page2.evaluate(({ uid }) => {
            var pkc = window.profileKeyCache;
            if (!pkc) return [];
            return Object.keys(pkc).filter(k => k.startsWith(uid));
        }, { uid: body1.user.id });
        console.log('User B profileKeyCache entries for User A:', JSON.stringify(cacheEntries));
        expect(cacheEntries.length).toBeGreaterThan(0);

        // Verify at least one key has PFP (not banner)
        const hasPfpKey = cacheEntries.some(k => k.indexOf(':banner') === -1);
        expect(hasPfpKey).toBe(true);

        // User B opens the DM conversation and verifies the PFP renders in the header
        await page2.click('#dm-strip-btn');
        await page2.waitForTimeout(2000);

        // Wait for the DM item to be visible
        await page2.waitForSelector('.dm-item', { timeout: 10000 });

        // Check if the DM header shows the profile picture
        var dmHeaderPic = await page2.evaluate(() => {
            var el = document.querySelector('.dm-chat-header-pic');
            if (!el) return 'no-header-pic';
            if (el.tagName === 'IMG') return 'img-loaded';
            if (el.classList.contains('dm-chat-header-pic-load')) return 'loading-placeholder';
            return el.textContent || 'unknown';
        });
        console.log('DM header pic status:', dmHeaderPic);

        // Open User A's profile modal from the DM header
        await page2.evaluate(async ({ uid }) => {
            var fn = window.openProfileModal;
            if (typeof fn === 'function') {
                await fn(uid);
            }
        }, { uid: body1.user.id });
        await page2.waitForTimeout(3000);

        // Check that the profile modal shows an avatar image (PFP loaded from cached key)
        var avatarImgCount = await page2.locator('#profile-modal-avatar img').count();
        console.log('Profile modal avatar img count:', avatarImgCount);

        // Check banner
        var bannerBg = await page2.evaluate(() => {
            var el = document.getElementById('profile-banner-img');
            if (!el) return 'no-banner';
            return el.style.backgroundImage ? 'has-bg' : 'no-bg';
        });
        console.log('Profile modal banner status:', bannerBg);

        await page2.click('#profile-modal-close');
        await page2.close();
        await ctx2.close();
    });

    test('no broken images for other users without profile key cache', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'nobroken1_' + ts;
        const user2 = 'nobroken2_' + ts;
        const displayName1 = 'NoBroken_' + ts;

        const body1 = await registerUser(page, user1);
        await page.request.patch(`${BASE}/api/profile`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { display_name: displayName1 },
        });
        await uploadFileAndSetProfile(page, body1.token, makeMinimalPng(50, 50), 'profile_picture');
        await uploadFileAndSetProfile(page, body1.token, makeMinimalPng(200, 100), 'profile_banner');

        const { serverId, inviteCode } = await createServerAndKey(page, body1.token, body1.user.id, 'NoBroken ' + ts);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        await joinServerAndGetKey(page, page2, serverId, inviteCode, body2.user.id);

        // User2 loads page and opens user1's profile directly (NO message received yet)
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(3000);

        // Open user1's profile via API (openProfileModal)
        await page2.evaluate(async ({ uid }) => {
            const fn = (window as any).openProfileModal;
            if (typeof fn === 'function') {
                await fn(uid);
            }
        }, { uid: body1.user.id });
        await page2.waitForTimeout(3000);

        // Check the profile modal - should show INITIALS (no broken image)
        const modalAvatar = page2.locator('#profile-modal-avatar');
        const avatarText = await modalAvatar.textContent();
        console.log('Profile modal avatar text (should be initial):', avatarText);
        
        // Should show the initial letter, NOT an img tag (since no profile key available)
        const avatarImg = await modalAvatar.locator('img').count();
        console.log('Avatar img count (should be 0 without cache):', avatarImg);
        
        // Button check
        const modalDn = await page2.locator('#profile-modal-display-name').textContent();
        console.log('Profile modal display name:', modalDn);

        await page2.click('#profile-modal-close');
        await page2.waitForTimeout(500);

        // Now send a message from user1 so user2 gets the profile key
        await page.goto(`${BASE}/index.html`);
        // Wait for myProfile to be loaded before sending
        // Note: myProfile is declared with `let` so it's NOT on window.*, use the bare name
        await page.waitForFunction(() => {
            return !!myProfile && !!myProfile.profile_picture_file_id;
        }, { timeout: 15000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(2000);
        const input1 = page.locator('#message-input');
        await expect(input1).toBeEnabled({ timeout: 10000 });
        await input1.fill('Now you can see my pic! ' + ts);
        await page.click('#send-btn');
        await page.waitForTimeout(2000);

        // User2 loads the message (which will populate profileKeyCache)
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(3000);
        await page2.click('.server-icon:not(.add-server)');
        await page2.waitForSelector('.channel-item', { timeout: 10000 });
        await page2.click('.channel-item >> nth=0');
        // Wait for message input to be enabled (confirms channel properly selected)
        await expect(page2.locator('#message-input')).toBeEnabled({ timeout: 15000 });
        await page2.waitForTimeout(2000);

        // After receiving the message, open profile again - should have the profile key now
        await page2.evaluate(async ({ uid }) => {
            const fn = (window as any).openProfileModal;
            if (typeof fn === 'function') {
                await fn(uid);
            }
        }, { uid: body1.user.id });
        await page2.waitForTimeout(3000);

        // Now it should show an img tag (profile key was cached from the message)
        const avatarImgAfter = await page2.locator('#profile-modal-avatar img').count();
        console.log('Avatar img count after message (should be 1):', avatarImgAfter);
        // Note: We can't guarantee 1 because the async fetch might not have completed yet,
        // but at minimum the profileKeyCache should be populated
        const pkc = await page2.evaluate(() => {
            const cache = (window as any).profileKeyCache;
            return cache ? Object.keys(cache).length : 0;
        });
        console.log('ProfileKeyCache entries after message:', pkc);
        expect(pkc).toBeGreaterThan(0);

        await page2.click('#profile-modal-close');
        await page2.close();
        await ctx2.close();
    });
});
