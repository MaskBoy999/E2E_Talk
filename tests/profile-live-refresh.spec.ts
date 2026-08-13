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
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 2; // bit depth 8, color type 2 (RGB)
    const chunk = (type: string, data: Buffer) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
        const typeBuf = Buffer.from(type, 'ascii');
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
        return Buffer.concat([len, typeBuf, data, crc]);
    };
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
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

async function waitForWs(page: any, maxRetries = 60) {
    return await page.evaluate((maxRetries) => {
        return new Promise((resolve) => {
            let tries = 0;
            const check = () => {
                tries++;
                if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
                    resolve(true);
                } else if (tries >= maxRetries) {
                    resolve(false);
                } else {
                    setTimeout(check, 200);
                }
            };
            setTimeout(check, 500);
        });
    }, maxRetries);
}

async function setupFriends(page: any, page2: any, body1: any, body2: any) {
    const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    const fr = await page.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
        data: { friend_code: fc2 },
    });
    expect(fr.ok()).toBeTruthy();
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${body2.token}` },
    })).json();
    const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    expect(acc.ok()).toBeTruthy();
}

async function createDm(page: any, body1: any, body2: any) {
    const userData = await (await page.request.get(`${BASE}/api/user/${body2.user.username}`, {
        headers: { Authorization: `Bearer ${body1.token}` },
    })).json();
    const dm = await (await page.request.post(`${BASE}/api/dm/${userData.id}`, {
        headers: { Authorization: `Bearer ${body1.token}` },
    })).json();
    expect(dm.id).toBeTruthy();
    return { userData, dm };
}

// Upload a profile picture through the REAL saveProfile() flow (encrypted
// chunk + raw key inside encrypted_profile_data) — the only flow the modern
// E2EE pipeline reads, and the one that broadcasts profile_updated to friends.
async function uploadProfilePic(page: any, token: string, pngBytes: Buffer): Promise<string> {
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
    await page.waitForTimeout(1000);
    return file_id;
}

async function showDmList(page: any) {
    await page.click('#dm-strip-btn').catch(() => {});
    await page.waitForTimeout(600);
}

test.describe('Profile PFP live refresh (no click / no view reopen)', () => {

    test('01 source hooks: every profile-fetch path refreshes voice + DM surfaces in place', async ({ page }) => {
        test.setTimeout(60000);
        await registerUser(page, 'plr_src_' + Date.now());
        const src = await page.evaluate(() => {
            const f1 = typeof fetchAndCacheUserProfile === 'function' ? fetchAndCacheUserProfile.toString() : '';
            const f2 = typeof fetchServerConversationProfile === 'function' ? fetchServerConversationProfile.toString() : '';
            const f3 = typeof fetchDmConversationProfile === 'function' ? fetchDmConversationProfile.toString() : '';
            const f4 = typeof refreshDmSidebarItem === 'function' ? refreshDmSidebarItem.toString() : '';
            const f5 = (window as any).VoiceManager && (window as any).VoiceManager.refreshMemberProfile
                ? (window as any).VoiceManager.refreshMemberProfile.toString() : '';
            return {
                f1Voice: f1.includes('refreshVoiceMemberProfile(userId)'),
                f1Sidebar: f1.includes('refreshDmSidebarItem(userId)'),
                f2Voice: f2.includes('refreshVoiceMemberProfile(userId)'),
                f2Sidebar: f2.includes('refreshDmSidebarItem(userId)'),
                f3Voice: f3.includes('refreshVoiceMemberProfile(userId)'),
                f3Sidebar: f3.includes('refreshDmSidebarItem(userId)'),
                sidebarAsyncLoad: f4.includes("avatarEl.setAttribute('data-profile-pic-load', cacheKey)"),
                guardCleared: f5.includes("delete S._pfpLoading[_gk]"),
            };
        });
        expect(src).toEqual({
            f1Voice: true, f1Sidebar: true,
            f2Voice: true, f2Sidebar: true,
            f3Voice: true, f3Sidebar: true,
            sidebarAsyncLoad: true,
            guardCleared: true,
        });
    });

    test('02 DM list: new PFP appears live when the other user changes it (no conversation click)', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'plr1_' + ts;
        const user2 = 'plr2_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);

        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, body1, body2);

        // Reload B so their client picks up the API-created DM conversation.
        await page2.goto(`${BASE}/index.html`);
        await waitForWs(page);
        await waitForWs(page2);

        // B (page2) shows the DM list. Wait until the DM item for A renders.
        // NOTE: DM rows carry the HMAC-hashed user id in data-user-id, so we
        // select by the plaintext username instead.
        await showDmList(page2);
        await page2.waitForSelector(`.dm-item[data-username="${user1}"]`, { timeout: 20000 });

        // A uploads a NEW profile picture while B's list is already rendered.
        const png = makeMinimalPng(64, 64);
        await uploadProfilePic(page, body1.token, png);

        // B's DM-list avatar for A must become a real <img> WITHOUT any click
        // on the conversation (we never click — the fix does it in place).
        await page2.waitForFunction((uname) => {
            const item = document.querySelector(`.dm-item[data-username="${uname}"]`);
            if (!item) return false;
            const img = item.querySelector('.dm-avatar img');
            return !!(img && (img as HTMLImageElement).src && (img as HTMLImageElement).src.startsWith('blob:'));
        }, user1, { timeout: 30000 });

        const avatarState = await page2.evaluate((uname) => {
            const item = document.querySelector(`.dm-item[data-username="${uname}"]`);
            const img = item ? item.querySelector('.dm-avatar img') : null;
            return {
                hasImg: !!img,
                src: img ? (img as HTMLImageElement).src : null,
                stillHasLoadAttr: item ? !!item.querySelector('.dm-avatar[data-profile-pic-load]') : false,
            };
        }, user1);
        expect(avatarState.hasImg).toBe(true);
        expect(avatarState.src).toContain('blob:');
        expect(avatarState.stillHasLoadAttr).toBe(false);
    });

    test('03 DM call: PFP updates live on the other-user tile (no close/reopen)', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'plrc1_' + ts;
        const user2 = 'plrc2_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);

        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, body1, body2);

        await waitForWs(page);
        await waitForWs(page2);

        // A starts a DM call; B accepts.
        await page.waitForFunction(() => {
            const v = (window as any).VoiceManager;
            return v && typeof v.startDmCall === 'function';
        }, undefined, { timeout: 15000 });
        await page.evaluate(({ dmId, uid, uname }) => {
            (window as any).VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: user2 });

        await page2.waitForSelector('#incoming-call-bar', { state: 'visible', timeout: 20000 });
        await page2.click('#incoming-call-accept');
        await page2.waitForFunction(() => {
            const v = (window as any).VoiceManager;
            return v && v.isConnected();
        }, undefined, { timeout: 25000 });

        // B's tile for A is visible in the DM call panel.
        await page2.waitForSelector(`#dm-call-body .dm-call-tile[data-uid="${body1.user.id}"]`, { state: 'visible', timeout: 20000 });

        // A changes their PFP mid-call.
        const png = makeMinimalPng(64, 64);
        await uploadProfilePic(page, body1.token, png);

        // B's tile avatar for A must gain a real <img> WITHOUT closing the panel.
        await page2.waitForFunction((uid) => {
            const tile = document.querySelector(`#dm-call-body .dm-call-tile[data-uid="${uid}"]`);
            if (!tile) return false;
            const img = tile.querySelector('.dm-call-avatar img');
            return !!(img && (img as HTMLImageElement).src && (img as HTMLImageElement).src.startsWith('blob:'));
        }, body1.user.id, { timeout: 30000 });

        const tileState = await page2.evaluate((uid) => {
            const tile = document.querySelector(`#dm-call-body .dm-call-tile[data-uid="${uid}"]`);
            const img = tile ? tile.querySelector('.dm-call-avatar img') : null;
            return {
                hasImg: !!img,
                src: img ? (img as HTMLImageElement).src : null,
                panelOpen: !!document.getElementById('dm-call-panel'),
            };
        }, body1.user.id);
        expect(tileState.hasImg).toBe(true);
        expect(tileState.src).toContain('blob:');
        expect(tileState.panelOpen).toBe(true);
    });
});
