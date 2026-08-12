import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

function makeMinimalPng(width = 50, height = 50): Buffer {
    const zlib = require('zlib');
    const raw = Buffer.alloc(1 + width * height * 3, 0);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 3 + 1)] = 0;
        for (let x = 0; x < width; x++) {
            const idx = y * (width * 3 + 1) + 1 + x * 3;
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

async function uploadFileAndSet(page: any, token: string, pngBytes: Buffer, field: 'profile_picture' | 'profile_banner'): Promise<string> {
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
    await page.waitForTimeout(1200);
    return file_id;
}

// Decrypt the stored conversation profile for user uid in dm cid (from B's page).
async function readConvProfile(page: any, uid: string, cid: string): Promise<any> {
    return await page.evaluate(async ({ uid, cid }) => {
        const ident = E2ECrypto.getIdentityKeyPair();
        const conv = dmConversations.find((c: any) => c.dm_channel_id === cid);
        const otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(conv.other_public_key));
        const dmKey = E2ECrypto.getDmKey(cid, ident.privateKey, otherPub);
        const res = await fetch(`/api/profile/${uid}/conversation/dm/${cid}`, {
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') },
        });
        if (!res.ok) return { status: res.status };
        const data = await res.json();
        const raw = E2ECrypto.aeadDecrypt(data.encrypted_profile_data, dmKey, data.nonce);
        if (!raw) return { status: 'decrypt-failed' };
        return JSON.parse(new TextDecoder().decode(raw));
    }, { uid, cid });
}

test('stale-device auto-upload no longer wipes the banner from conversation profiles', async ({ page, context }) => {
    test.setTimeout(180000);
    const ts = Date.now();
    const userA = 'bnr_a_' + ts;
    const userB = 'bnr_b_' + ts;
    const bodyA = await registerUser(page, userA);
    const ctxB = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
    const pageB = await ctxB.newPage();
    const bodyB = await registerUser(pageB, userB);

    // Become friends.
    const fcA = await page.evaluate(() => localStorage.getItem('e2e_friend_code'));
    const fr = await pageB.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${bodyB.token}`, 'Content-Type': 'application/json' },
        data: { friend_code: fcA },
    });
    expect(fr.ok()).toBeTruthy();
    const incoming = await (await page.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${bodyA.token}` },
    })).json();
    const acc = await page.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    expect(acc.ok()).toBeTruthy();
    await page.waitForTimeout(2500);

    // B sets a banner -> conversation profile carries the banner key.
    await uploadFileAndSet(pageB, bodyB.token, makeMinimalPng(200, 100), 'profile_banner');
    const convId = await pageB.evaluate((uid) => {
        const c = dmConversations.find((x: any) => x.other_user_id === uid);
        return c ? c.dm_channel_id : null;
    }, bodyA.user.id);
    expect(convId).toBeTruthy();

    const good = await readConvProfile(pageB, bodyB.user.id, convId);
    expect(good.profile_banner_file_id).toBeTruthy();
    expect(good.profile_banner_file_key).toBeTruthy();
    const goodBannerId = good.profile_banner_file_id;
    const goodBannerKey = good.profile_banner_file_key;

    // Simulate B's OTHER device with a STALE myProfile (booted before the banner
    // existed) calling the auto-upload path. The fixed function must refresh
    // myProfile from the server and NOT clobber the good conversation profile.
    const staleResult = await pageB.evaluate(async () => {
        (myProfile as any) = {
            display_name: (user as any).username,
            nickname: '',
            description: '',
            username_color: '#4fc3f7',
            username_border_color: '',
            profile_background_color: '',
            profile_picture_file_id: null,
            profile_banner_file_id: null,
            profile_picture_file_key: null,
            profile_banner_file_key: null,
        };
        await (uploadCurrentProfileToConversations as any)();
        return true;
    });
    expect(staleResult).toBe(true);

    const after = await readConvProfile(pageB, bodyB.user.id, convId);
    expect(after.profile_banner_file_id).toBe(goodBannerId);
    expect(after.profile_banner_file_key).toBe(goodBannerKey);
});

test('banner survives on a fresh device after the owner auto-heals a corrupted conversation profile', async ({ page, context }) => {
    test.setTimeout(180000);
    const ts = Date.now();
    const userA = 'bha_' + ts;
    const userB = 'bhb_' + ts;
    const bodyA = await registerUser(page, userA);
    const ctxB = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
    const pageB = await ctxB.newPage();
    const bodyB = await registerUser(pageB, userB);

    // Become friends.
    const fcA = await page.evaluate(() => localStorage.getItem('e2e_friend_code'));
    const fr = await pageB.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${bodyB.token}`, 'Content-Type': 'application/json' },
        data: { friend_code: fcA },
    });
    expect(fr.ok()).toBeTruthy();
    const incoming = await (await page.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${bodyA.token}` },
    })).json();
    const acc = await page.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    expect(acc.ok()).toBeTruthy();
    await page.waitForTimeout(2500);

    // B sets a banner.
    await uploadFileAndSet(pageB, bodyB.token, makeMinimalPng(200, 100), 'profile_banner');
    const convId = await pageB.evaluate((uid) => {
        const c = dmConversations.find((x: any) => x.other_user_id === uid);
        return c ? c.dm_channel_id : null;
    }, bodyA.user.id);
    const good = await readConvProfile(pageB, bodyB.user.id, convId);
    const goodBannerId = good.profile_banner_file_id;

    // CORRUPT the conversation profile with a no-banner payload (the pre-fix
    // stale-overwrite from a second device).
    const stalePayload = JSON.stringify({
        display_name: bodyB.user.username,
        nickname: '',
        description: '',
        username_color: '#4fc3f7',
        username_border_color: '',
        profile_background_color: '',
        profile_picture_file_id: null,
        profile_banner_file_id: null,
        profile_picture_file_key: null,
        profile_banner_file_key: null,
    });
    await pageB.evaluate(async ({ uid, cid, payload }) => {
        const ident = E2ECrypto.getIdentityKeyPair();
        const conv = dmConversations.find((c: any) => c.dm_channel_id === cid);
        const otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(conv.other_public_key));
        const dmKey = E2ECrypto.getDmKey(cid, ident.privateKey, otherPub);
        const enc = E2ECrypto.aeadEncrypt(payload, dmKey);
        await fetch('/api/profile/conversation', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({
                conversation_type: 'dm',
                conversation_id: cid,
                encrypted_profile_data: enc.ciphertext,
                nonce: enc.nonce,
            }),
        });
    }, { uid: bodyB.user.id, cid: convId, payload: stalePayload });
    const corrupted = await readConvProfile(pageB, bodyB.user.id, convId);
    expect(corrupted.profile_banner_file_id).toBeFalsy();

    // The owner's next auto-upload (stale in-memory myProfile) heals it.
    await pageB.evaluate(async () => {
        (myProfile as any) = { display_name: (user as any).username };
        await (uploadCurrentProfileToConversations as any)();
    });
    const healed = await readConvProfile(pageB, bodyB.user.id, convId);
    expect(healed.profile_banner_file_id).toBe(goodBannerId);
    expect(healed.profile_banner_file_key).toBeTruthy();

    // A logs in FRESH (B offline) and opens B's profile — the banner must show.
    await page.close();
    await pageB.close();
    const ctxA2 = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
    const pageA2 = await ctxA2.newPage();
    await pageA2.goto(`${BASE}/login.html`);
    await pageA2.waitForSelector('#login-username');
    await pageA2.fill('#login-username', userA);
    await pageA2.fill('#login-password', 'password123');
    await pageA2.click('#login-form button[type="submit"]');
    await pageA2.waitForURL('**/index.html', { timeout: 15000 });
    await pageA2.waitForTimeout(4000);

    const state = await pageA2.evaluate(async (uid) => {
        await (window as any).openProfileModal(uid);
        await new Promise((r) => setTimeout(r, 3000));
        const img = document.getElementById('profile-banner-img');
        const bg = img ? getComputedStyle(img).backgroundImage : 'NO-EL';
        return {
            bg: bg.slice(0, 80),
            cacheBannerId: (userDisplayNameCache[uid] || {}).profile_banner_file_id || null,
            cacheHasKey: !!(userDisplayNameCache[uid] || {}).profile_banner_file_key,
        };
    }, bodyB.user.id);
    expect(state.bg).toContain('blob:');
    expect(state.cacheBannerId).toBe(goodBannerId);
    expect(state.cacheHasKey).toBe(true);
});
