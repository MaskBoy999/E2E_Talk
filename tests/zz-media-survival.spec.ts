import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';

const BASE = 'https://localhost:3443';
const DB = 'server/e2e_chat.db';

function dbQuery(sql: string, args: any[] = []): any[] {
    const json = JSON.stringify(args).replace(/'/g, "''");
    const script = `import sqlite3,sys,json;con=sqlite3.connect(${JSON.stringify(DB)});cur=con.cursor();cur.execute(${JSON.stringify(sql)},json.loads('${json}'));print(json.dumps(cur.fetchall()))`;
    const out = execSync(`python3 -c ${JSON.stringify(script)}`, { encoding: 'utf8' }).trim();
    return JSON.parse(out);
}

function makeMinimalPng(w: number, h: number): Buffer {
    // 1x1-ish PNG built programmatically via zlib
    const zlib = require('zlib');
    const width = w, height = h;
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0; // filter none
        for (let x = 0; x < width; x++) {
            const off = y * (width * 4 + 1) + 1 + x * 4;
            raw[off] = 200; raw[off + 1] = 100; raw[off + 2] = 50; raw[off + 3] = 255;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type RGB
    const chunk = (type: string, data: Buffer) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length, 0);
        const typeBuf = Buffer.from(type, 'ascii');
        const crc = require('zlib').crc32;
        const crcBuf = Buffer.alloc(4);
        crcBuf.writeUInt32BE(crc(Buffer.concat([typeBuf, data])), 0);
        return Buffer.concat([len, typeBuf, data, crcBuf]);
    };
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForTimeout(1500);
    return page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function uploadFile(page: Page, token: string, bytes: Buffer): Promise<{ fileId: string; fileKeyB64: string }> {
    const initRes = await page.request.post(`${BASE}/api/files/init`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { size: bytes.length },
    });
    expect(initRes.ok()).toBeTruthy();
    const { file_id } = await initRes.json();

    const enc = await page.evaluate(async ({ fileId, b64 }) => {
        const rawBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const fileKey = E2ECrypto.generateFileKey();
        const encrypted = E2ECrypto.encryptFileChunk(fileKey, rawBytes);
        await fetch(`/api/files/${fileId}/chunk/0`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: new Blob([encrypted], { type: 'application/octet-stream' }),
        });
        await fetch(`/api/files/${fileId}/complete`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        return E2ECrypto.arrayBufferToBase64(fileKey);
    }, { fileId: file_id, b64: bytes.toString('base64') });
    return { fileId: file_id, fileKeyB64: enc };
}

async function registerSticker(page: Page, token: string, fileId: string, fileKeyB64: string, name: string, mime: string) {
    const enc = await page.evaluate(async ({ fk, nm, mm }) => {
        const identity = E2ECrypto.getIdentityKeyPair();
        const keyBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(fk));
        const encFileKey = E2ECrypto.encodeEncryptedFileKey(fk, identity.privateKey);
        const parts = encFileKey.split(':');
        const encName = E2ECrypto.aeadEncrypt(nm, identity.privateKey, null);
        const encMime = E2ECrypto.aeadEncrypt(mm, keyBytes, null);
        return {
            encrypted_file_key: E2ECrypto.arrayBufferToBase64(E2ECrypto.base64ToArrayBuffer(parts[1])),
            file_key_nonce: parts[0],
            encrypted_sticker_name: encName.ciphertext,
            sticker_name_nonce: encName.nonce,
            encrypted_mime_type: encMime.ciphertext,
            mime_nonce: encMime.nonce,
        };
    }, { fk: fileKeyB64, nm: name, mm: mime });

    const res = await page.request.post(`${BASE}/api/users/me/stickers`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { file_id: fileId, ...enc },
    });
    expect(res.ok()).toBeTruthy();
}

test.describe('Media survival after reload', () => {
    test.setTimeout(120000);

    test('pfp + emoji + sticker survive a page reload', async ({ page }) => {
        const ts = Date.now().toString(36);
        const username = 'surv_' + ts;
        const body = await register(page, username);

        // 1. Upload + set PFP through the real saveProfile() flow
        const pfp = await uploadFile(page, body.token, makeMinimalPng(40, 40));
        await page.evaluate(async ({ fid, fk }) => {
            (profilePfpFileId as any) = fid;
            (profilePfpFileKey as any) = fk;
            (_removePfpFlag as any) = false;
            await (saveProfile as any)();
        }, { fid: pfp.fileId, fk: pfp.fileKeyB64 });
        await page.waitForTimeout(1200);

        // 2. Upload an emoji (image/emoji) + a sticker (image/png)
        const emoji = await uploadFile(page, body.token, makeMinimalPng(24, 24));
        await registerSticker(page, body.token, emoji.fileId, emoji.fileKeyB64, 'surv_emoji_' + ts, 'image/emoji');
        const stk = await uploadFile(page, body.token, makeMinimalPng(48, 48));
        await registerSticker(page, body.token, stk.fileId, stk.fileKeyB64, 'surv_sticker_' + ts, 'image/png');

        // 3. Reload the page (simulates the client side of a server restart)
        await page.reload();
        await page.waitForTimeout(4000);

        // 3b. Actually restart the server process, then reload again
        console.log('Restarting server process...');
        const fs = require('fs');
        console.log('.env before:', JSON.stringify(fs.readFileSync('server/.env', 'utf8').length), fs.statSync('server/.env').mtime.toISOString());
        console.log('token head:', body.token.slice(0, 30), '... len', body.token.length);
        const { spawn, execFileSync } = require('child_process');
        try { execFileSync('taskkill', ['/f', '/im', 'e2e-chat.exe'], { encoding: 'utf8' }); } catch (e) { console.log('kill:', String(e).slice(0, 160)); }
        await new Promise(r => setTimeout(r, 2500));
        const serverProc = spawn('cargo', ['run'], { cwd: 'server', detached: true, stdio: 'ignore' });
        serverProc.unref();
        // Wait for the server to answer an AUTHED request (full boot, not just static)
        let up = false;
        let lastStatus = 'none';
        for (let i = 0; i < 120; i++) {
            try {
                const r = await page.request.get('https://localhost:3443/api/me', { headers: { Authorization: 'Bearer ' + body.token } });
                lastStatus = String(r.status());
                if (r.status() === 401 && i === 11) {
                    const txt = await r.text();
                    console.log('401 body:', txt.slice(0, 200));
                    console.log('.env after:', JSON.stringify(fs.readFileSync('server/.env', 'utf8').length), fs.statSync('server/.env').mtime.toISOString());
                    try {
                        const parts = body.token.split('.');
                        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
                        console.log('jwt payload:', JSON.stringify(payload));
                        const secret = fs.readFileSync('server/.env', 'utf8').split('\n').find((l: string) => l.includes('JWT_SECRET'))!.split('=')[1].trim();
                        const crypto = require('crypto');
                        const sig = crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest('base64url');
                        console.log('sig match:', sig === parts[2]);
                    } catch (e) { console.log('decode err:', String(e).slice(0, 120)); }
                }
                if (r.ok()) { up = true; break; }
            } catch (e) { lastStatus = 'ERR ' + String(e).slice(0, 80); }
            if (i % 10 === 0) console.log('poll', i, lastStatus);
            await new Promise(r2 => setTimeout(r2, 1000));
        }
        console.log('Server back up:', up, 'last status:', lastStatus);
        expect(up).toBe(true);
        // If the app redirected to login during the restart, log back in silently via the UI
        if (page.url().includes('login.html')) {
            await page.goto(`${BASE}/index.html`);
        } else {
            await page.reload();
        }
        // Wait for the chat UI to boot (message input present)
        await page.waitForSelector('#message-input', { timeout: 20000 });
        await page.waitForTimeout(3000);

        // Check own PFP: myProfile must carry the key after boot, and the blob must decrypt
        const pfpState = await page.evaluate(async ({ fid }) => {
            const mp = myProfile || {};
            const uid = (user && user.id) || (localStorage.getItem('user') ? JSON.parse(localStorage.getItem('user') || '{}').id : null);
            let url = null;
            if (mp.profile_picture_file_key) {
                url = await getProfilePicUrl(fid, uid);
            }
            return {
                uid: uid,
                myProfileHasKey: !!mp.profile_picture_file_key,
                myProfileFileId: mp.profile_picture_file_id || null,
                cacheUrl: !!(profilePicCache && profilePicCache[uid + ':' + fid]),
                keyPrefix: mp.profile_picture_file_key ? mp.profile_picture_file_key.slice(0, 12) : null,
            };
        }, { fid: pfp.fileId });
        console.log('PFP state after reload:', JSON.stringify(pfpState));
        expect(pfpState.myProfileHasKey).toBe(true);

        // Check emoji cache after reload
        const emojiState = await page.evaluate(async ({ name }) => {
            const identity = E2ECrypto.getIdentityKeyPair();
            const res = await fetch('/api/users/me/stickers', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
            const stickers = await res.json();
            const dbg = [];
            for (const s of stickers) {
                let fk = null, mm = null, nm = s.sticker_name || null;
                try {
                    if (s.encrypted_file_key && s.file_key_nonce && identity) {
                        fk = E2ECrypto.decodeEncryptedFileKey(s.file_key_nonce + ':' + s.encrypted_file_key, identity.privateKey);
                    }
                } catch (e) { dbg.push('keyerr ' + String(e).slice(0, 80)); }
                try {
                    if (s.encrypted_mime_type && s.mime_nonce && fk) {
                        const mk = new Uint8Array(E2ECrypto.base64ToArrayBuffer(fk));
                        const dm = E2ECrypto.aeadDecrypt(s.encrypted_mime_type, mk, s.mime_nonce);
                        if (dm) mm = new TextDecoder().decode(dm);
                    }
                } catch (e) { dbg.push('mimeerr ' + String(e).slice(0, 80)); }
                try {
                    if (s.encrypted_sticker_name && s.sticker_name_nonce && identity) {
                        const dn = E2ECrypto.aeadDecrypt(s.encrypted_sticker_name, identity.privateKey, s.sticker_name_nonce);
                        if (dn) nm = new TextDecoder().decode(dn);
                    }
                } catch (e) { dbg.push('nameerr ' + String(e).slice(0, 80)); }
                dbg.push(JSON.stringify({ id: (s.id || '').slice(0, 8), fid: (s.file_id || '').slice(0, 8), hasKey: !!fk, keyLen: fk ? fk.length : 0, mime: mm, name: nm }));
            }
            return { dbg: dbg, stickersCount: stickers.length };
        }, {});
        console.log('Emoji decrypt debug:', JSON.stringify(emojiState));

        const emojiState2 = await page.evaluate(async ({ name }) => {
            await loadEmojiCache();
            const ec = emojiCache || {};
            const entry = ec[name];
            return {
                entry: entry ? { file_id: entry.file_id, hasKey: !!entry.file_key, mime: entry.mime_type } : null,
                keys: Object.keys(ec),
            };
        }, { name: 'surv_emoji_' + ts });
        console.log('Emoji state after reload:', JSON.stringify(emojiState2));
        expect(emojiState2.entry).not.toBeNull();
        expect(emojiState2.entry.hasKey).toBe(true);

        // Check sticker cache after reload
        const stickerState = await page.evaluate(async ({ name }) => {
            await loadUserStickers();
            const sc = userStickersCache || [];
            const entry = sc.find((s: any) => s.sticker_name === name);
            return {
                entry: entry ? { file_id: entry.file_id, hasKey: !!entry.file_key, mime: entry.mime_type } : null,
                names: sc.map((s: any) => s.sticker_name),
            };
        }, { name: 'surv_sticker_' + ts });
        console.log('Sticker state after reload:', JSON.stringify(stickerState));
        expect(stickerState.entry).not.toBeNull();
        expect(stickerState.entry.hasKey).toBe(true);

        // 4. Verify the DB file rows exist for all three media files
        const fileRows = dbQuery('SELECT id, uploader_id, upload_complete FROM files WHERE id IN (?, ?, ?)', [pfp.fileId, emoji.fileId, stk.fileId]);
        console.log('DB file rows:', JSON.stringify(fileRows));
        expect(fileRows.length).toBe(3);
    });
});
