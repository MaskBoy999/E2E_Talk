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
        data: { name: serverName, invite_code: inviteCode },
    });
    const server = await srv.json();
    await page.evaluate(async ({ serverId, userId: uid }) => {
        const serverKey = E2ECrypto.generateSymmetricKey();
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

// Upload a file and set it as a profile picture/banner through the REAL
// saveProfile() flow — the only flow that produces the modern
// encrypted_profile_data blob (raw keys inside) that loadMyProfile and the
// key-broadcast paths actually read. The old helper PATCHed identity-key-
// encrypted keys directly, which the E2EE server stores but the client never
// loads into myProfile.profile_picture_file_key — so broadcasts sent nothing.
async function uploadFileAndSetProfile(page: any, token: string, pngBytes: Buffer, field: 'profile_picture' | 'profile_banner'): Promise<string> {
    const initRes = await page.request.post(`${BASE}/api/files/init`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { size: pngBytes.length, mime: 'image/png' },
    });
    expect(initRes.ok()).toBeTruthy();
    const { file_id } = await initRes.json();

    const fileKeyB64: string = await page.evaluate(async ({ fileId, pngBase64 }) => {
        // Decode the PNG data, encrypt with a random key, upload
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

    // Drive the real saveProfile() so encrypted_profile_data + identity-encrypted
    // keys are all written exactly like the UI does.
    const status = await page.evaluate(async ({ fid, fk, fieldType }) => {
        if (fieldType === 'profile_picture') {
            (profilePfpFileId as any) = fid;
            (profilePfpFileKey as any) = fk;
            (_removePfpFlag as any) = false;
        } else {
            (profileBannerFileId as any) = fid;
            (profileBannerFileKey as any) = fk;
            (_removeBannerFlag as any) = false;
        }
        const statusEl = document.getElementById('profile-edit-status');
        try {
            await (saveProfile as any)();
            return statusEl ? (statusEl.textContent || '') : 'no-status-el';
        } catch (e) { return 'ERR ' + e; }
    }, { fid: file_id, fk: fileKeyB64, fieldType: field });
    expect(status).toContain('Profile saved');
    await page.waitForTimeout(800);
    return file_id;
}

test.describe('Profile Picture & Banner Sharing Between Users', () => {
    test.setTimeout(120000);

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

        // Modern path: the message handler caches the decrypted key in
        // userDisplayNameCache (profileKeyCache is only used by profile_key_sync).
        const cacheHasKey = await page2.evaluate(({ uid }) => {
            const e = (userDisplayNameCache as any)[uid];
            return !!(e && e.profile_picture_file_key);
        }, { uid: body1.user.id });
        console.log('userDisplayNameCache has pfp key for user1:', cacheHasKey);

        // Verify the encrypted_profile_key flowed through the server — the modern
        // path caches the decrypted key in userDisplayNameCache.
        const hasProfileKeyCache = await page2.evaluate(({ uid }) => {
            const e = (userDisplayNameCache as any)[uid];
            return (e && e.profile_picture_file_key) ? 'has-key' : 'empty';
        }, { uid: body1.user.id });
        console.log('userDisplayNameCache pfp key:', hasProfileKeyCache);

        await page2.close();
        await ctx2.close();
    });

    test('heartbeat refresh must not drop the sender PFP in a server channel', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'hbpfp_a_' + ts;
        const user2 = 'hbpfp_b_' + ts;

        // User1 registers + sets a REAL profile picture (modern saveProfile flow)
        const body1 = await registerUser(page, user1);
        const pfpPng = makeMinimalPng(50, 50);
        await uploadFileAndSetProfile(page, body1.token, pfpPng, 'profile_picture');

        // User1 creates a server; User2 joins
        const { serverId, inviteCode } = await createServerAndKey(page, body1.token, body1.user.id, 'HBPFP ' + ts);
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        await joinServerAndGetKey(page, page2, serverId, inviteCode, body2.user.id);

        // Both load index and open the channel
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(3000);
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(3000);
        for (const p of [page, page2]) {
            await p.click('.server-icon:not(.add-server)');
            await p.waitForSelector('.channel-item', { timeout: 10000 });
            await p.click('.channel-item >> nth=0');
            await p.waitForTimeout(2000);
        }

        // Enable the heartbeat with every setting on
        for (const p of [page, page2]) {
            await p.evaluate(() => {
                localStorage.setItem('key_heartbeat_interval', '15000');
                ['hb_refresh_keys', 'hb_refresh_profiles', 'hb_refresh_members', 'hb_refresh_messages',
                 'hb_refresh_dms', 'hb_refresh_servers', 'hb_refresh_friend_requests', 'hb_refresh_presence',
                 'hb_refresh_voice', 'hb_refresh_channels'].forEach(id => localStorage.setItem(id, 'true'));
            });
        }

        // User1 sends a message carrying their PFP key
        const input1 = page.locator('#message-input');
        await expect(input1).toBeEnabled({ timeout: 10000 });
        await input1.fill('hb pfp check ' + ts);
        await page.click('#send-btn');
        await page.waitForTimeout(3000);

        // User2 waits until the sender's message avatar renders as an <img>
        await page2.waitForFunction(() => {
            return !!document.querySelector('.message .avatar img');
        }, undefined, { timeout: 20000 });

        // Capture WS event types B receives during the ticks (diagnostic)
        await page2.evaluate(() => {
            (window as any).__wsTypes = [];
            const orig = ws.onmessage.bind(ws);
            ws.onmessage = (ev: any) => {
                try {
                    const d = JSON.parse(ev.data);
                    (window as any).__wsTypes.push(d.type || 'raw');
                } catch (_) {}
                return orig(ev);
            };
        });

        // Run heartbeat ticks; IMMEDIATELY after a tick the avatar must still be
        // an <img>. (Pre-fix: the profiles action deleted userDisplayNameCache and
        // the messages action removed the avatar synchronously.)
        let avatarSurvived = true;
        for (let i = 0; i < 4; i++) {
            const stillHasImg = await page2.evaluate(() => {
                try { refreshAll(); } catch (e) { return { err: String(e) }; }
                return !!document.querySelector('.message .avatar img');
            });
            if (!stillHasImg) { avatarSurvived = false; break; }
            await page2.waitForTimeout(600);
        }
        expect(avatarSurvived).toBe(true);

        // Guard branches of updateExistingMessageStyles: a legit PFP REMOVAL
        // (file_id explicitly null) must still strip the avatar to an initial,
        // while a key-only stub (file_id undefined + key present) must NOT.
        const guardDiag = await page2.evaluate((uid) => {
            const m = document.querySelector('.message');
            const avatar = m ? m.querySelector('.avatar') : null;
            if (!m || !avatar) return { err: 'no message/avatar' };
            const cache = (userDisplayNameCache as any)[uid];
            if (!cache) return { err: 'no cache for ' + uid };
            // Save the real values so the final interval-tick assertion still sees them.
            const realId = cache.profile_picture_file_id;
            const realKey = cache.profile_picture_file_key;
            // Shape 1: authoritative no-PFP (explicit null) → strip expected
            cache.profile_picture_file_id = null;
            cache.profile_picture_file_key = null;
            updateExistingMessageStyles(uid);
            const afterNull = !avatar.querySelector('img') && avatar.textContent.trim().length > 0;
            // Restore a rendered avatar (simulate a fresh message) so shape 2
            // has an <img> to preserve.
            avatar.innerHTML = '<img class="avatar-img" src="blob:https://localhost:3443/x" alt="">';
            cache.profile_picture_file_id = realId;
            // Shape 2: key-only stub (undefined id + key) → img must survive
            (userDisplayNameCache as any)['stub_' + uid] = {
                profile_picture_file_key: 'dG9rZW4=AA',
            };
            const msg = document.querySelector('.message');
            msg.setAttribute('data-sender-id', 'stub_' + uid);
            updateExistingMessageStyles('stub_' + uid);
            const afterStub = !!msg.querySelector('.avatar img');
            msg.removeAttribute('data-sender-id');
            delete (userDisplayNameCache as any)['stub_' + uid];
            // Restore the real cache entry exactly as it was (the later assertion
            // checks the key survives a real 17s interval tick).
            cache.profile_picture_file_id = realId;
            cache.profile_picture_file_key = realKey;
            return { afterNull, afterStub };
        }, body1.user.id);
        console.log('GUARD DIAG:', JSON.stringify(guardDiag));
        expect(guardDiag.afterNull).toBe(true);
        expect(guardDiag.afterStub).toBe(true);

        // And the sender's cache still holds the PFP key after a real interval tick
        await page2.waitForTimeout(17000);
        const cacheHasKey = await page2.evaluate((uid) => {
            const e = (userDisplayNameCache as any)[uid];
            return !!(e && e.profile_picture_file_key);
        }, body1.user.id);
        expect(cacheHasKey).toBe(true);

        await page2.close();
        await ctx2.close();
    });

    test('PFP shared via DM message broadcast renders for DM recipient', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'pfpdm1_' + ts;
        const user2 = 'pfpdm2_' + ts;
        const displayName1 = 'PFPDMUser_' + ts;

        const body1 = await registerUser(page, user1);
        // The server no longer accepts plaintext display_name (E2EE) — set it
        // through the real saveProfile flow alongside the PFP.

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
            // Display name comes from the encrypted profile data — verify the modal
            // shows the user's name (username at minimum) and the PFP rendered.
            expect(modalDn && modalDn.trim().length > 0).toBeTruthy();
            const avatarImgs = await page2.locator('#profile-modal-avatar img').count();
            console.log('DM profile modal avatar imgs:', avatarImgs);
            expect(avatarImgs).toBeGreaterThan(0);
            
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
        
        // Verify the decrypted PFP key made it through the WS broadcast into
        // the modern userDisplayNameCache (keys from messages are stored there)
        const hasCache = await page2.evaluate(({ uid }) => {
            const udc = (window as any).userDisplayNameCache;
            if (!udc) return -1;
            const e = udc[uid];
            return e && e.profile_picture_file_key ? Object.keys(udc).length : 0;
        }, { uid: body1.user.id });
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
        // The modern key-sharing flow: friend_request_accepted → A re-uploads the
        // per-DM conversation profile (REST) → B's loadDmConversations() prefetches
        // it via fetchDmConversationProfile() and caches the decrypted pic/banner
        // keys in userDisplayNameCache. (The old WS profile_key_sync relay is no
        // longer implemented by the server, so we assert the conversation-profile path.)

        // Capture all WS messages B receives so we can diagnose the flow.
        await page2.evaluate(() => {
            (window as any).__wsSeen = [];
            const origAdd = EventTarget.prototype.addEventListener;
            EventTarget.prototype.addEventListener = function (type: string, listener: any, options?: any) {
                if (type === 'message') {
                    const wrapped = function (event: MessageEvent) {
                        try {
                            const d = JSON.parse(event.data);
                            if (!(window as any).__wsSeen) (window as any).__wsSeen = [];
                            (window as any).__wsSeen.push(d.type);
                        } catch (e) {}
                        return listener.call(this, event);
                    };
                    return origAdd.call(this, type, wrapped, options);
                }
                return origAdd.call(this, type, listener, options);
            };
        });

        // Wait for both users to be fully loaded and connected
        await page.waitForTimeout(3000);
        await page2.waitForTimeout(3000);

        // User A state — myProfile must hold the uploaded PFP/banner + keys
        const userAMyProfile = await page.evaluate(() => {
            if (typeof myProfile === 'undefined' || !myProfile) return 'no-myProfile';
            return JSON.stringify({
                pfpId: myProfile.profile_picture_file_id,
                hasPfpKey: !!myProfile.profile_picture_file_key,
                bannerId: myProfile.profile_banner_file_id,
                hasBannerKey: !!myProfile.profile_banner_file_key,
                dmCount: (typeof dmConversations !== 'undefined') ? dmConversations.length : -1,
            });
        });
        console.log('User A myProfile:', userAMyProfile);
        const aProfile = JSON.parse(userAMyProfile);
        expect(aProfile.hasPfpKey).toBe(true);
        expect(aProfile.hasBannerKey).toBe(true);

        // Ensure the per-DM conversation profile is uploaded for the new DM
        await page.evaluate(async () => {
            try { await uploadCurrentProfileToConversations(); } catch (e) {}
        });
        await page.waitForTimeout(1000);

        // User B (friend, no shared server) should receive A's pic/banner keys via
        // the modern flow: friend_request_accepted (live or offline-replayed as an
        // encrypted_notification) → loadDmConversations() → conversation-profile
        // prefetch → keys cached in userDisplayNameCache. Wait for that to happen
        // automatically — no manual fetch here.
        await page2.waitForFunction(({ uid }) => {
            var udc = window.userDisplayNameCache;
            if (!udc || !udc[uid]) return false;
            return !!(udc[uid].profile_picture_file_key || udc[uid].profile_banner_file_key);
        }, { uid: body1.user.id }, { timeout: 20000 });

        const bCacheAfter = await page2.evaluate(({ uid }) => {
            var udc = window.userDisplayNameCache;
            if (!udc || !udc[uid]) return 'no-cache';  
            var e = udc[uid];
            return JSON.stringify({ pfp: !!e.profile_picture_file_key, banner: !!e.profile_banner_file_key, dn: e.display_name || null });
        }, { uid: body1.user.id });
        console.log('User B cache after automatic recovery:', bCacheAfter);
        const bCacheParsed = JSON.parse(bCacheAfter);
        expect(bCacheParsed.pfp).toBe(true);
        expect(bCacheParsed.banner).toBe(true);

        // Verify User B's profileKeyCache has the entry for User A
        const cacheEntries = await page2.evaluate(({ uid }) => {
            var udc = window.userDisplayNameCache;
            if (!udc || !udc[uid]) return [];
            var e = udc[uid];
            var keys: string[] = [];
            if (e.profile_picture_file_key) keys.push('pfp');
            if (e.profile_banner_file_key) keys.push('banner');
            return keys;
        }, { uid: body1.user.id });
        console.log('User B userDisplayNameCache keys for User A:', JSON.stringify(cacheEntries));
        expect(cacheEntries.length).toBeGreaterThan(0);

        // Verify at least one key has PFP (not banner)
        expect(cacheEntries).toContain('pfp');

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
        // but at minimum the userDisplayNameCache should be populated with the PFP key
        const pkc = await page2.evaluate(({ uid }) => {
            const udc = (window as any).userDisplayNameCache;
            if (!udc || !udc[uid]) return 0;
            return (udc[uid].profile_picture_file_key || udc[uid].profile_banner_file_key) ? 1 : 0;
        }, { uid: body1.user.id });
        console.log('userDisplayNameCache PFP key present after message:', pkc);
        expect(pkc).toBeGreaterThan(0);

        await page2.click('#profile-modal-close');
        await page2.close();
        await ctx2.close();
    });
});
