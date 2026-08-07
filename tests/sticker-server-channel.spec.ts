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
function createTestImageBuffer(size = 64): Buffer {
    const zlib = require('zlib');
    const raw = Buffer.alloc(1 + size * size * 3, 0);
    for (let y = 0; y < size; y++) {
        raw[y * (size * 3 + 1)] = 0;
        for (let x = 0; x < size; x++) {
            const idx = y * (size * 3 + 1) + 1 + x * 3;
            raw[idx] = 80 + (x * 60 / size); raw[idx + 1] = 40; raw[idx + 2] = 200;
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
    ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
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

async function uploadStickerViaApi(page: any, token: string, imageBuffer: Buffer, name: string): Promise<string> {
    // Upload file
    const initRes = await page.request.post(BASE + '/api/files/init', {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { size: imageBuffer.length, mime: 'image/png' },
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
    }, { fileId: file_id, pngBase64: imageBuffer.toString('base64') });
    // Register sticker via API (mirrors the app's own upload path in chat.js)
    await page.evaluate(async ({ fid, fk, nm }) => {
        const identity = E2ECrypto.getIdentityKeyPair();
        const encKey = E2ECrypto.encodeEncryptedFileKey(fk, identity.privateKey);
        const parts = encKey.split(':');
        const encNameRes = E2ECrypto.aeadEncrypt(nm, identity.privateKey, null);
        const encMimeRes = E2ECrypto.aeadEncrypt('image/png', new Uint8Array(E2ECrypto.base64ToArrayBuffer(fk)));
        await fetch('/api/users/me/stickers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({
                file_id: fid,
                sticker_name: nm,
                encrypted_mime_type: encMimeRes.ciphertext,
                mime_nonce: encMimeRes.nonce,
                encrypted_file_key: parts[1],
                file_key_nonce: parts[0],
                encrypted_sticker_name: encNameRes.ciphertext,
                sticker_name_nonce: encNameRes.nonce,
            }),
        });
    }, { fid: file_id, fk: fileKeyB64, nm: name });
    await page.waitForTimeout(1500);
    return file_id;
}

test.describe('Stickers in server channels (both sides)', () => {

test('sticker renders for both users in server channel, after refresh', async ({ page, context }) => {
    test.setTimeout(180000);
    const ts = Date.now();
    const ctxA = await context.browser()!.newContext();
    const pageA = await ctxA.newPage();
    const pageB = page;

    const a = await registerUser(pageA, 'stk_a_' + ts);
    const b = await registerUser(pageB, 'stk_b_' + ts);

    const { serverId, channelId, inviteCode } = await createServerAndKey(pageA, a.token, a.user.id, 'STKSRV ' + ts);
    await joinServerAndGetKey(pageA, pageB, serverId, inviteCode, b.user.id);

    // A uploads a sticker
    const stickerFileId = await uploadStickerViaApi(pageA, a.token, createTestImageBuffer(64), 'diag_sticker_' + ts);
    console.log('DIAG sticker file id:', stickerFileId);

    // Both load index fresh and open the channel
    await pageA.goto(BASE + '/index.html');
    await pageA.waitForTimeout(4000);
    await pageB.goto(BASE + '/index.html');
    await pageB.waitForTimeout(4000);
    for (const p of [pageA, pageB]) {
        await p.click('.server-icon:not(.add-server)');
        await p.waitForSelector('.channel-item', { timeout: 10000 });
        await p.click('.channel-item >> nth=0');
        await p.waitForTimeout(2000);
    }

    // A opens sticker panel, sends the sticker
    await pageA.click('#sticker-btn');
    await pageA.waitForSelector('#sticker-panel', { state: 'visible' });
    await pageA.waitForTimeout(500);
    const stickerTab = pageA.locator('.sticker-tab[data-tab="stickers"]');
    if (await stickerTab.isVisible()) { await stickerTab.click(); }
    await pageA.waitForTimeout(2500);
    const firstSticker = pageA.locator('.sticker-grid-item, .sticker-grid img').first();
    const vis = await firstSticker.isVisible({ timeout: 5000 }).catch(() => false);
    console.log('DIAG sticker grid item visible:', vis);
    if (vis) {
        await firstSticker.click();
        await pageA.waitForTimeout(4000);
    }

    // Check A sees own sticker
    const aSticker = await pageA.evaluate(() => {
        const s = document.querySelector('.sticker-message');
        return s ? { hasImg: !!s.querySelector('img'), unavailable: (s.textContent || '').indexOf('sticker unavailable') !== -1 } : null;
    });
    expect(aSticker).toBeTruthy();
    expect(aSticker.hasImg).toBe(true);
    expect(aSticker.unavailable).toBe(false);

    // Check B sees it (live WS path)
    await pageB.waitForTimeout(4000);
    const bSticker = await pageB.evaluate(() => {
        const s = document.querySelector('.sticker-message');
        return s ? { hasImg: !!s.querySelector('img'), unavailable: (s.textContent || '').indexOf('sticker unavailable') !== -1 } : null;
    });
    expect(bSticker).toBeTruthy();
    expect(bSticker.hasImg).toBe(true);
    expect(bSticker.unavailable).toBe(false);

    // B refreshes and re-checks (REST load path)
    await pageB.reload();
    await pageB.waitForTimeout(4000);
    await pageB.click('.server-icon:not(.add-server)');
    await pageB.waitForSelector('.channel-item', { timeout: 10000 });
    await pageB.click('.channel-item >> nth=0');
    await pageB.waitForTimeout(4000);
    const bStickerAfter = await pageB.evaluate(() => {
        const s = document.querySelector('.sticker-message');
        return s ? { hasImg: !!s.querySelector('img'), unavailable: (s.textContent || '').indexOf('sticker unavailable') !== -1 } : null;
    });
    expect(bStickerAfter).toBeTruthy();
    expect(bStickerAfter.hasImg).toBe(true);
    expect(bStickerAfter.unavailable).toBe(false);

    await ctxA.close();
});
});
