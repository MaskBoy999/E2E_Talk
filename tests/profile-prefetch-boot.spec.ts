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
    ihdr[8] = 8; ihdr[9] = 2;
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

async function loginUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#login-form');
    await page.fill('#login-username', username);
    await page.fill('#login-password', 'password123');
    await page.click('#login-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
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

// Real E2EE saveProfile() PFP upload so the OTHER side can decrypt the file.
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
    await page.waitForTimeout(1200);
    return file_id;
}

test.describe('Boot-time DM-list profile prefetch (no conversation click)', () => {

    test('fresh device login renders DM-list avatars without clicking anything', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'ppb1_' + ts;
        const user2 = 'ppb2_' + ts;

        // A + B (two separate contexts), friends + DM.
        const ctxB = await context.browser()!.newContext();
        const pageB = await ctxB.newPage();
        const bodyB = await registerUser(pageB, user2);
        const bodyA = await registerUser(page, user1);
        await setupFriends(page, pageB, bodyA, bodyB);
        await createDm(page, bodyA, bodyB);

        // A sets a PFP through the real saveProfile() E2EE flow.
        await uploadProfilePic(page, bodyA.token, makeMinimalPng(64, 64));

        // B logs in on a FRESH device (new context) — the profile must land
        // via the boot-time prefetch, not via a conversation click.
        const ctxFresh = await context.browser()!.newContext();
        const pageFresh = await ctxFresh.newPage();
        await loginUser(pageFresh, user2);

        await waitForWs(pageFresh);

        // The DM item renders with an avatar <img> (blob URL) — we never click
        // the conversation.
        await pageFresh.waitForFunction((uname) => {
            const item = document.querySelector(`.dm-item[data-username="${uname}"]`);
            if (!item) return false;
            const img = item.querySelector('.dm-avatar img');
            return !!(img && (img as HTMLImageElement).src && (img as HTMLImageElement).src.startsWith('blob:'));
        }, user1, { timeout: 30000 });

        const state = await pageFresh.evaluate((uname) => {
            const item = document.querySelector(`.dm-item[data-username="${uname}"]`);
            const img = item ? item.querySelector('.dm-avatar img') : null;
            const cacheEntry = (window as any).userDisplayNameCache || {};
            // The item's data-user-id is the HMAC-hashed id; find the cache key
            // whose profile_picture_file_id is set for this user's conversation.
            const conv = ((window as any).dmConversations || []).find((c: any) => c.other_username === uname);
            const cacheHit = conv ? !!(cacheEntry[conv.other_user_id] && cacheEntry[conv.other_user_id].profile_picture_file_id) : false;
            return {
                hasImg: !!img,
                src: img ? (img as HTMLImageElement).src : null,
                cacheHasPicId: cacheHit,
            };
        }, user1);
        expect(state.hasImg).toBe(true);
        expect(state.src).toContain('blob:');
        expect(state.cacheHasPicId).toBe(true);
    });

    test('source: prefetchDmConversationProfiles exists and is wired into boot paths', async ({ page }) => {
        test.setTimeout(60000);
        await registerUser(page, 'ppb_src_' + Date.now());
        const src = await page.evaluate(() => {
            const fn = typeof prefetchDmConversationProfiles === 'function' ? prefetchDmConversationProfiles.toString() : '';
            const waitingFn = typeof refreshDmWaitingState === 'function' ? refreshDmWaitingState.toString() : '';
            const loadFn = typeof loadDmConversations === 'function' ? loadDmConversations.toString() : '';
            return {
                defined: fn.length > 0,
                fetchesProfiles: fn.includes('fetchDmConversationProfile('),
                rendersOnlyInDmView: fn.includes("viewMode === 'dms'"),
                kickedFromWaiting: waitingFn.includes('prefetchDmConversationProfiles()'),
                calledFromLoad: loadFn.includes('prefetchDmConversationProfiles()'),
            };
        });
        expect(src.defined).toBe(true);
        expect(src.fetchesProfiles).toBe(true);
        expect(src.rendersOnlyInDmView).toBe(true);
        expect(src.kickedFromWaiting).toBe(true);
        expect(src.calledFromLoad).toBe(true);
    });
});
