import { test, expect } from '@playwright/test';
import { createHash } from 'crypto';

const BASE = process.env.BASE_URL || 'https://localhost:3443';

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
            raw[idx] = 255; raw[idx + 1] = 128 + (x * 127 / width); raw[idx + 2] = 0;
        }
    }
    const deflated = zlib.deflateSync(raw);
    function crc32(buf: Buffer): number {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) { crc ^= buf[i]; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0); }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    function u32(v: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; }
    const parts: Buffer[] = [];
    parts.push(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]));
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const ihdrType = Buffer.from('IHDR');
    parts.push(u32(13), ihdrType, ihdr, u32(crc32(Buffer.concat([ihdrType, ihdr]))));
    const idatType = Buffer.from('IDAT');
    parts.push(u32(deflated.length), idatType, deflated, u32(crc32(Buffer.concat([idatType, deflated]))));
    const iendType = Buffer.from('IEND');
    parts.push(u32(0), iendType, u32(crc32(iendType)));
    return Buffer.concat(parts);
}

async function registerUser(page: any, username: string) {
    await page.goto(BASE + '/login.html');
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
    const fr = await page1.request.post(BASE + '/api/friends/request', {
        headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        data: { friend_code: friendCode2 },
    });
    expect(fr.ok()).toBeTruthy();
    const incoming = await (await page2.request.get(BASE + '/api/friends/requests/incoming', {
        headers: { Authorization: `Bearer ${token2}` },
    })).json();
    const acc = await page2.request.post(BASE + '/api/friends/requests/accept', {
        headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[incoming.length - 1].id },
    });
    expect(acc.ok()).toBeTruthy();
}

async function createServerAndKey(page: any, token: string, userId: string, serverName: string) {
    const inviteCode = generateCode(8);
    const srv = await page.request.post(BASE + '/api/servers', {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { name: serverName, invite_code: inviteCode },
    });
    expect(srv.ok()).toBeTruthy();
    const server = await srv.json();
    await page.evaluate(async ({ serverId, uid }) => {
        const serverKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey(serverId, serverKey);
        const identity = E2ECrypto.getIdentityKeyPair();
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: uid, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
        });
    }, { serverId: server.id, uid: userId });
    const chRes = await page.request.get(BASE + `/api/servers/${server.id}/channels`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const channels = await chRes.json();
    return { serverId: server.id, channelId: channels[0].id, inviteCode };
}

async function joinServerAndGetKey(pageOwner: any, pageJoiner: any, serverId: string, inviteCode: string, joinerUserId: string) {
    const joinerPubKey = await pageJoiner.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey));
    const joinerToken = await pageJoiner.evaluate(() => localStorage.getItem('token'));
    await pageJoiner.request.post(BASE + '/api/invites/join', {
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

async function uploadAndSet(page: any, pngBytes: Buffer, field: 'pfp' | 'banner'): Promise<string> {
    const token = await page.evaluate(() => localStorage.getItem('token'));
    const initRes = await page.request.post(BASE + '/api/files/init', {
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
    const status = await page.evaluate(async ({ fid, fk, f }) => {
        if (f === 'pfp') {
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
    }, { fid: file_id, fk: fileKeyB64, f: field });
    await page.waitForTimeout(1500);
    return status;
}

async function openProfileAndProbe(page: any, uid: string): Promise<any> {
    await page.evaluate((u) => { (openProfileModal as any)(u); }, uid);
    await page.waitForTimeout(2500);
    return await page.evaluate(() => {
        const bannerEl = document.getElementById('profile-banner-img');
        const avatarImgs = document.querySelectorAll('#profile-modal-avatar img').length;
        return {
            banner: bannerEl ? bannerEl.style.backgroundImage.slice(0, 40) : 'no-el',
            pfpImgs: avatarImgs,
        };
    });
}

test.describe('Profile persistence across refresh (both sides)', () => {
    test('B sees A pfp+banner in DM and server channel, before and after A refresh', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const ctxA = await context.browser()!.newContext();
        const pageA = await ctxA.newPage();
        const pageB = page;

        const a = await registerUser(pageA, 'pers_a_' + ts);
        const b = await registerUser(pageB, 'pers_b_' + ts);
        await becomeFriends(pageA, pageB, a.token, b.token);

        const { serverId, inviteCode } = await createServerAndKey(pageA, a.token, a.user.id, 'PSRV ' + ts);
        await joinServerAndGetKey(pageA, pageB, serverId, inviteCode, b.user.id);

        // A sets PFP then banner — two separate saves (the real user flow that
        // used to hit the server-side FK bug and silently drop the banner)
        const pfpStatus = await uploadAndSet(pageA, makeMinimalPng(50, 50), 'pfp');
        const bannerStatus = await uploadAndSet(pageA, makeMinimalPng(120, 40), 'banner');
        expect(pfpStatus).toContain('Profile saved');
        expect(bannerStatus).toContain('Profile saved');

        // Both reload fresh
        await pageA.goto(BASE + '/index.html');
        await pageA.waitForTimeout(4000);
        await pageB.goto(BASE + '/index.html');
        await pageB.waitForTimeout(4000);

        // DM context
        await pageB.evaluate(() => {
            const items = document.querySelectorAll('.dm-item, .dm-sidebar-item, [data-dm-user]');
            if (items[0]) (items[0] as HTMLElement).click();
        });
        await pageB.waitForTimeout(1500);
        const dmBefore = await openProfileAndProbe(pageB, a.user.id);
        expect(dmBefore.pfpImgs).toBeGreaterThan(0);
        expect(dmBefore.banner.length).toBeGreaterThan(0);
        await pageB.evaluate(() => { (closeProfileModal as any)(); });

        // Server context
        await pageB.click('.server-icon:not(.add-server)');
        await pageB.waitForSelector('.channel-item', { timeout: 10000 });
        await pageB.click('.channel-item >> nth=0');
        await pageB.waitForTimeout(2500);
        const srvBefore = await openProfileAndProbe(pageB, a.user.id);
        expect(srvBefore.pfpImgs).toBeGreaterThan(0);
        expect(srvBefore.banner.length).toBeGreaterThan(0);
        await pageB.evaluate(() => { (closeProfileModal as any)(); });

        // A refreshes — the critical scenario from the bug report
        await pageA.reload();
        await pageA.waitForTimeout(6000);

        // B re-opens in server context fresh — pfp+banner must still render
        const srvAfter = await openProfileAndProbe(pageB, a.user.id);
        expect(srvAfter.pfpImgs).toBeGreaterThan(0);
        expect(srvAfter.banner.length).toBeGreaterThan(0);
        await pageB.evaluate(() => { (closeProfileModal as any)(); });

        // B re-opens in DM context fresh
        await pageB.evaluate(() => {
            const items = document.querySelectorAll('.dm-item, .dm-sidebar-item, [data-dm-user]');
            if (items[0]) (items[0] as HTMLElement).click();
        });
        await pageB.waitForTimeout(1500);
        const dmAfter = await openProfileAndProbe(pageB, a.user.id);
        expect(dmAfter.pfpImgs).toBeGreaterThan(0);
        expect(dmAfter.banner.length).toBeGreaterThan(0);

        await ctxA.close();
    });

    test('A changes banner and B sees it live without refresh', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const ctxA = await context.browser()!.newContext();
        const pageA = await ctxA.newPage();
        const pageB = page;

        const a = await registerUser(pageA, 'live_a_' + ts);
        const b = await registerUser(pageB, 'live_b_' + ts);
        await becomeFriends(pageA, pageB, a.token, b.token);

        await pageA.goto(BASE + '/index.html');
        await pageA.waitForTimeout(4000);
        await pageB.goto(BASE + '/index.html');
        await pageB.waitForTimeout(4000);

        // A sets a banner; B should see it shortly after (profile_updated +
        // profile_key_sync broadcasts) without B refreshing
        await uploadAndSet(pageA, makeMinimalPng(120, 40), 'banner');

        // B opens A's profile fresh
        await pageB.evaluate(() => {
            const items = document.querySelectorAll('.dm-item, .dm-sidebar-item, [data-dm-user]');
            if (items[0]) (items[0] as HTMLElement).click();
        });
        await pageB.waitForTimeout(1500);
        const probe = await openProfileAndProbe(pageB, a.user.id);
        expect(probe.banner.length).toBeGreaterThan(0);

        await ctxA.close();
    });
});
