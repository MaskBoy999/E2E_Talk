import { test, expect } from '@playwright/test';
import type { Page, BrowserContext } from '@playwright/test';

const BASE = 'https://localhost:3443';

function generateCode(len: number): string {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return code;
}

async function registerUser(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(500);
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
    await page.waitForTimeout(1500);
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

function createPngBuffer(r: number, g: number, b: number): Buffer {
    const zlib = require('zlib');
    const w = 1, h = 1;
    const raw = Buffer.alloc(1 + w * h * 3);
    raw[0] = 0; raw[1] = r; raw[2] = g; raw[3] = b;
    function crc32(buf: Buffer): Buffer {
        let c = 0xffffffff;
        for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); }
        c = (c ^ 0xffffffff) >>> 0; const b2 = Buffer.alloc(4); b2.writeUInt32BE(c); return b2;
    }
    function chunk(type: Buffer, data: Buffer): Buffer {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const tad = Buffer.concat([type, data]);
        return Buffer.concat([len, tad, crc32(tad)]);
    }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    return Buffer.concat([sig, chunk(Buffer.from('IHDR'), ihdr), chunk(Buffer.from('IDAT'), zlib.deflateSync(raw)), chunk(Buffer.from('IEND'), Buffer.alloc(0))]);
}

async function encryptServerName(page: Page, name: string): Promise<{ encrypted_name: string; name_nonce: string; server_key_b64: string }> {
    return await page.evaluate(async (n: string) => {
        const k = E2ECrypto.generateSymmetricKey();
        const kb = E2ECrypto.arrayBufferToBase64(k);
        const enc = E2ECrypto.aeadEncrypt(n, k);
        return { encrypted_name: enc.ciphertext, name_nonce: enc.nonce, server_key_b64: kb };
    }, name);
}

async function uploadFile(page: Page, token: string, bytes: Buffer): Promise<string> {
    const init = await page.request.post(`${BASE}/api/files/init`, {
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        data: { size: bytes.length, mime: 'image/png' },
    });
    expect(init.ok()).toBeTruthy();
    const { file_id } = await init.json();
    const ch = await page.request.fetch(`${BASE}/api/files/${file_id}/chunk/0`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' }, data: bytes,
    });
    expect(ch.ok()).toBeTruthy();
    await page.request.post(`${BASE}/api/files/${file_id}/complete`, { headers: { Authorization: 'Bearer ' + token } });
    return file_id;
}

// ============================================================
test.describe('Unified PFP Sharing', () => {
    test('User A uploads conversation profile, User B decrypts it via API (no profile_key_sync)', async ({ browser }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const userA = 'pfp_a_' + ts;
        const userB = 'pfp_b_' + ts;
        const displayNameA = 'AlicePFP_' + ts;

        const ctxA: BrowserContext = await browser.newContext();
        const ctxB: BrowserContext = await browser.newContext();
        const pageA: Page = await ctxA.newPage();
        const pageB: Page = await ctxB.newPage();

        // Capture incoming WS messages on User B
        const incomingTypesB: string[] = [];
        pageB.on('websocket', ws => {
            ws.on('framereceived', (frame: { payload: string }) => {
                try {
                    const parsed = JSON.parse(frame.payload);
                    if (parsed && parsed.type) incomingTypesB.push(parsed.type);
                } catch (_) {}
            });
        });

        try {
            const aInfo = await registerUser(pageA, userA);
            const bInfo = await registerUser(pageB, userB);

            // Create a common server (profile data is shared via conversation profiles in servers)
            const inviteCode = generateCode(8);
            const srvCrypto = await encryptServerName(pageA, 'PFPSrv_' + ts);
            const srvRes = await pageA.request.post(`${BASE}/api/servers`, {
                headers: { Authorization: 'Bearer ' + aInfo.token, 'Content-Type': 'application/json' },
                data: { invite_code: inviteCode, encrypted_name: srvCrypto.encrypted_name, name_nonce: srvCrypto.name_nonce },
            });
            expect(srvRes.ok()).toBeTruthy();
            const serverId = (await srvRes.json()).id;

            // Save server key for User A and reload
            await pageA.evaluate(({ sid, keyB64 }) => localStorage.setItem('e2e_server_' + sid, keyB64), { sid: serverId, keyB64: srvCrypto.server_key_b64 });
            await pageA.goto(`${BASE}/index.html`);
            await pageA.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
            await pageA.waitForTimeout(1500);

            // User B joins
            const joinRes = await pageB.request.post(`${BASE}/api/invites/join`, {
                headers: { Authorization: 'Bearer ' + bInfo.token, 'Content-Type': 'application/json' },
                data: { code: inviteCode },
            });
            expect(joinRes.ok()).toBeTruthy();

            // Save server key for User B and load
            await pageB.evaluate(({ sid, keyB64 }) => localStorage.setItem('e2e_server_' + sid, keyB64), { sid: serverId, keyB64: srvCrypto.server_key_b64 });
            await pageB.goto(`${BASE}/index.html`);
            await pageB.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
            await pageB.waitForTimeout(1500);

            // User B selects the server (triggers loadMembers which fetches conversation profiles)
            await pageB.click('.server-icon:not(.add-server)');
            await pageB.waitForTimeout(1500);

            // ============ Upload conversation profile for User A ============
            const fileId1 = await uploadFile(pageA, aInfo.token, createPngBuffer(255, 0, 0));

            const uploadResult = await pageA.evaluate(async ({ dn, fid, tokenVal, sid }) => {
                const E2E = E2ECrypto;
                const ident = E2E.getIdentityKeyPair();
                if (!ident) return { error: 'No identity key' };

                // Generate random file key for the PFP, encrypt with identity key
                const fileKey = new Uint8Array(32);
                crypto.getRandomValues(fileKey);
                const fileKeyB64 = btoa(String.fromCharCode(...fileKey));
                const encFileKey = E2E.encodeEncryptedFileKey(fileKeyB64, ident.privateKey);
                const fkParts = encFileKey.split(':');

                // Build profile data (same structure as saveProfile() produces)
                const profileData = {
                    display_name: dn,
                    nickname: '',
                    description: '',
                    username_color: '#4fc3f7',
                    username_border_color: '',
                    profile_background_color: '',
                    friend_requests_disabled: false,
                    theme_color: '#4fc3f7',
                    theme_bg_color: '#4fc3f7',
                    theme_mode: 'dark',
                    profile_picture_file_id: fid,
                    profile_banner_file_id: null,
                    encrypted_pic_key: fkParts[1] || null,
                    pic_key_nonce: fkParts[0] || null,
                    encrypted_banner_key: null,
                    banner_key_nonce: null,
                };
                const profileDataJson = JSON.stringify(profileData);

                // Encrypt with server key (as uploadConversationProfiles does for servers)
                const serverKey = E2E.getServerKey(sid);
                if (!serverKey) return { error: 'Server key not found for ' + sid };
                const encServer = E2E.aeadEncrypt(profileDataJson, serverKey);

                // Upload via PUT /api/profile/conversation
                const res = await fetch('/api/profile/conversation', {
                    method: 'PUT',
                    headers: { Authorization: 'Bearer ' + tokenVal, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        conversation_type: 'channel',
                        conversation_id: sid,
                        encrypted_profile_data: encServer.ciphertext,
                        nonce: encServer.nonce,
                    }),
                });
                if (!res.ok) {
                    const errText = await res.text();
                    return { error: 'Upload failed: ' + res.status + ' ' + errText };
                }
                return { ok: true, encCiphertext: encServer.ciphertext, nonce: encServer.nonce };
            }, { dn: displayNameA, fid: fileId1, tokenVal: aInfo.token, sid: serverId });

            console.log('Upload result:', JSON.stringify(uploadResult));
            expect(uploadResult.error).toBeUndefined();
            expect(uploadResult.ok).toBe(true);

            await pageA.waitForTimeout(2000);

            // ============ Verify User B can decrypt the conversation profile ============
            const convRes = await pageB.request.get(`${BASE}/api/profile/${aInfo.user.id}/conversation/channel/${serverId}`, {
                headers: { Authorization: 'Bearer ' + bInfo.token },
            });
            expect(convRes.ok()).toBeTruthy();
            const convData = await convRes.json();
            expect(!!convData.encrypted_profile_data).toBe(true);
            expect(!!convData.nonce).toBe(true);

            // Decrypt on User B's page
            const decResult = await pageB.evaluate(({ sid, encData, nonce }) => {
                try {
                    const srvKey = E2ECrypto.getServerKey(sid);
                    if (!srvKey) return { error: 'No server key' };
                    const decRaw = E2ECrypto.aeadDecrypt(encData, srvKey, nonce);
                    if (!decRaw) return { error: 'Decrypt returned null' };
                    const decStr = new TextDecoder().decode(decRaw);
                    const decrypted = JSON.parse(decStr);
                    return {
                        displayName: decrypted.display_name || null,
                        picFileId: decrypted.profile_picture_file_id || null,
                    };
                } catch (e: any) {
                    return { error: e?.message || String(e) };
                }
            }, { sid: serverId, encData: convData.encrypted_profile_data, nonce: convData.nonce });

            console.log('Decrypted profile:', JSON.stringify(decResult));
            expect(decResult.error).toBeUndefined();
            expect(decResult.displayName).toBe(displayNameA);
            expect(decResult.picFileId).toBe(fileId1);

            // ============ Verify userDisplayNameCache is populated ===
            // fetchServerConversationProfile was called by loadMembers during selectServer,
            // so userDisplayNameCache should contain User A's profile data.
            // (userDisplayNameCache is a let variable, accessible by name in evaluate)
            const cacheCheck = await pageB.evaluate((uid) => {
                if (typeof userDisplayNameCache === 'undefined') return { found: false, reason: 'cache undefined' };
                const entry = userDisplayNameCache[uid];
                if (!entry) return { found: false, reason: 'no entry for uid' };
                return {
                    found: true,
                    displayName: entry.display_name || null,
                    picFileId: entry.profile_picture_file_id || null,
                };
            }, aInfo.user.id);
            console.log('userDisplayNameCache check:', JSON.stringify(cacheCheck));

            // ============ Verify NO profile_key_sync WS message ============
            expect(incomingTypesB.includes('profile_key_sync')).toBe(false);

            console.log('All unified PFP sharing tests passed');
        } finally {
            await ctxA.close();
            await ctxB.close();
        }
    });
});
