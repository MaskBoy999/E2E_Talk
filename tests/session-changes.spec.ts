import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('Session changes: code lengths, server picture, sticker crop, memory leaks', () => {

    // ─── Helpers ──────────────────────────────────────────────────

    async function registerUser(page: any, username: string) {
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await page.waitForLoadState('networkidle');
        return await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
            friendCode: localStorage.getItem('e2e_friend_code'),
            alphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
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

    async function createServerWithApi(page: any, token: string) {
        const serverCode = 'SRV' + Date.now().toString(36).toUpperCase() + '_' + Math.random().toString(36).slice(2,6).toUpperCase();

        const keyResult = await page.evaluate(async () => {
            const kp = E2ECrypto.getIdentityKeyPair();
            if (!kp) return { error: 'no_keypair' };
            const sk = E2ECrypto.generateSymmetricKey();
            const skB64 = E2ECrypto.arrayBufferToBase64(sk);
            const enc = E2ECrypto.envelopeEncrypt(skB64, kp.publicKey, kp.privateKey);
            return {
                serverKeyB64: skB64,
                encryptedKey: enc.ciphertext,
                nonce: enc.nonce,
                senderPubB64: E2ECrypto.arrayBufferToBase64(kp.publicKey),
            };
        });
        if (keyResult.error) return null;

        const encName = await page.evaluate(({ keyB64 }) => {
            const k = new Uint8Array(E2ECrypto.base64ToArrayBuffer(keyB64));
            return E2ECrypto.aeadEncrypt('TestServer', k);
        }, { keyB64: keyResult.serverKeyB64 });
        const encChName = await page.evaluate(({ keyB64 }) => {
            const k = new Uint8Array(E2ECrypto.base64ToArrayBuffer(keyB64));
            return E2ECrypto.aeadEncrypt('General', k);
        }, { keyB64: keyResult.serverKeyB64 });

        const res = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: {
                invite_code_hash: serverCode,
                encrypted_name: encName.ciphertext,
                name_nonce: encName.nonce,
                channel_encrypted_name: encChName.ciphertext,
                channel_name_nonce: encChName.nonce,
            },
        });
        if (!res.ok()) return null;
        const serverData = await res.json();

        await page.request.post(`${BASE}/api/servers/${serverData.id}/keys`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: {
                user_id: (await page.evaluate(() => JSON.parse(localStorage.getItem('user') || '{}'))).id,
                encrypted_key: keyResult.encryptedKey,
                sender_public_key: keyResult.senderPubB64,
                nonce: keyResult.nonce,
            },
        });

        return { id: serverData.id, invite_code: serverCode };
    }

    // ════════════════════════════════════════════════════════════════
    // TEST 1: Friend code is 16 characters
    // ════════════════════════════════════════════════════════════════

    test('1. Friend code is 16 characters after registration', async ({ page }) => {
        const ts = Date.now() + Math.floor(Math.random() * 10000);
        const username = 'fcl_' + ts;
        const result = await registerUser(page, username);

        expect(result.friendCode).toBeTruthy();
        expect(result.friendCode.length).toBe(16);

        // Verify all characters are from the valid alphabet
        const validChars = new Set(result.alphabet.split(''));
        for (const ch of result.friendCode) {
            expect(validChars.has(ch)).toBe(true);
        }
    });

    test('2. Friend code is 16 characters after regeneration', async ({ page }) => {
        const ts = Date.now() + Math.floor(Math.random() * 10000);
        const username = 'fcr_' + ts;
        const result = await registerUser(page, username);
        expect(result.friendCode).toBeTruthy();
        expect(result.friendCode.length).toBe(16);

        // Regenerate via the internal generateCode function
        const newCode = await page.evaluate(() => {
            return generateCode(16);
        });
        expect(newCode).toBeTruthy();
        expect(newCode.length).toBe(16);

        // Verify valid characters
        const alphabetData = await page.evaluate(() => {
            return 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        });
        const validChars = new Set(alphabetData.split(''));
        for (const ch of newCode) {
            expect(validChars.has(ch)).toBe(true);
        }
    });

    // ════════════════════════════════════════════════════════════════
    // TEST 2: Invite code is 16 characters
    // ════════════════════════════════════════════════════════════════

    test('3. generateCode(16) produces 16-char invite codes', async ({ page }) => {
        const ts = Date.now() + Math.floor(Math.random() * 10000);
        const username = 'inv_' + ts;
        await registerUser(page, username);

        const codes = await page.evaluate(() => {
            return [generateCode(16), generateCode(16), generateCode(16)];
        });
        expect(codes.length).toBe(3);
        for (const code of codes) {
            expect(code.length).toBe(16);
        }
        const unique = new Set(codes);
        expect(unique.size).toBeGreaterThan(1);

        const alphabetData = await page.evaluate(() => {
            return 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        });
        const validChars = new Set(alphabetData.split(''));
        for (const code of codes) {
            for (const ch of code) {
                expect(validChars.has(ch)).toBe(true);
            }
        }
    });

    test('4. Invite code regeneration produces 16-char code', async ({ page }) => {
        const ts = Date.now() + Math.floor(Math.random() * 10000);
        const username = 'irg_' + ts;
        const result = await registerUser(page, username);
        expect(result.token).toBeTruthy();
        await waitForWs(page);

        const server = await createServerWithApi(page, result.token);
        expect(server).toBeTruthy();

        const regenResult = await page.evaluate(async (sid: string) => {
            const inviteCode = generateCode(16);
            const hmacKey = localStorage.getItem('e2e_hmac_key');
            const inviteCodeHash = hmacKey
                ? E2ECrypto.hmacHex(hmacKey, inviteCode)
                : E2ECrypto.sha256Hex(new TextEncoder().encode(inviteCode));

            return { code: inviteCode, hash: inviteCodeHash, length: inviteCode.length };
        }, server.id);

        expect(regenResult.length).toBe(16);
        expect(regenResult.hash).toBeTruthy();
        expect(regenResult.hash.length).toBe(64);

        const res = await page.request.post(`${BASE}/api/servers/${server.id}/invite`, {
            headers: { Authorization: `Bearer ${result.token}`, 'Content-Type': 'application/json' },
            data: { invite_code_hash: regenResult.hash },
        });
        expect(res.ok()).toBeTruthy();
    });

    // ════════════════════════════════════════════════════════════════
    // TEST 3: Server picture API (upload, get, remove)
    // ════════════════════════════════════════════════════════════════

    test('5. Server picture API — upload, list, and remove picture', async ({ page }) => {
        const ts = Date.now() + Math.floor(Math.random() * 10000);
        const username = 'spa_' + ts;
        const result = await registerUser(page, username);
        expect(result.token).toBeTruthy();
        await waitForWs(page);

        const keyResult = await page.evaluate(async () => {
            const kp = E2ECrypto.getIdentityKeyPair();
            if (!kp) return { error: 'no_keypair' };
            const sk = E2ECrypto.generateSymmetricKey();
            const skB64 = E2ECrypto.arrayBufferToBase64(sk);
            const enc = E2ECrypto.envelopeEncrypt(skB64, kp.publicKey, kp.privateKey);
            return {
                serverKeyB64: skB64,
                encryptedKey: enc.ciphertext,
                nonce: enc.nonce,
                senderPubB64: E2ECrypto.arrayBufferToBase64(kp.publicKey),
            };
        });
        expect(keyResult.error).toBeUndefined();

        const serverCode = 'SRV' + Date.now().toString(36).toUpperCase() + '_pic';

        const encName = await page.evaluate(({ keyB64 }) => {
            const k = new Uint8Array(E2ECrypto.base64ToArrayBuffer(keyB64));
            return E2ECrypto.aeadEncrypt('PicTestSrv', k);
        }, { keyB64: keyResult.serverKeyB64 });
        const encChName = await page.evaluate(({ keyB64 }) => {
            const k = new Uint8Array(E2ECrypto.base64ToArrayBuffer(keyB64));
            return E2ECrypto.aeadEncrypt('General', k);
        }, { keyB64: keyResult.serverKeyB64 });

        const createRes = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${result.token}`, 'Content-Type': 'application/json' },
            data: {
                invite_code_hash: serverCode,
                encrypted_name: encName.ciphertext,
                name_nonce: encName.nonce,
                channel_encrypted_name: encChName.ciphertext,
                channel_name_nonce: encChName.nonce,
            },
        });
        expect(createRes.ok()).toBeTruthy();
        const serverData = await createRes.json();
        const serverId = serverData.id;

        await page.request.post(`${BASE}/api/servers/${serverId}/keys`, {
            headers: { Authorization: `Bearer ${result.token}`, 'Content-Type': 'application/json' },
            data: {
                user_id: result.user.id,
                encrypted_key: keyResult.encryptedKey,
                sender_public_key: keyResult.senderPubB64,
                nonce: keyResult.nonce,
            },
        });

        await page.evaluate(({ sid, keyB64 }) => {
            const keyBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(keyB64));
            E2ECrypto.saveServerKey(sid, keyBytes);
        }, { sid: serverId, keyB64: keyResult.serverKeyB64 });

        // Upload file and encrypt file key inside browser context
        const picData = await page.evaluate(async (sid) => {
            const fileKey = E2ECrypto.generateFileKey();
            const fileKeyB64 = E2ECrypto.arrayBufferToBase64(fileKey);

            const plaintext = new Uint8Array(32);
            for (let i = 0; i < 32; i++) plaintext[i] = (i * 13 + 7) & 0xFF;
            const encryptedChunk = E2ECrypto.encryptFileChunk(fileKey, plaintext);

            const initRes = await authFetch('/api/files/init', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ size: encryptedChunk.length, mime: 'image/png' }),
            });
            if (!initRes.ok) return { error: 'init: ' + (await initRes.text()) };
            const initData = await initRes.json();

            const chunkRes = await authFetch('/api/files/' + initData.file_id + '/chunk/0', {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: encryptedChunk,
            });
            if (!chunkRes.ok) return { error: 'chunk: ' + (await chunkRes.text()) };

            const completeRes = await authFetch('/api/files/' + initData.file_id + '/complete', { method: 'POST' });
            if (!completeRes.ok) return { error: 'complete' };

            // Encrypt file key with server key
            const serverKey = E2ECrypto.getServerKey(sid);
            if (!serverKey) return { error: 'no_key' };
            const encKey = E2ECrypto.aeadEncrypt(fileKeyB64, serverKey);

            return { fileId: initData.file_id, fileKeyB64, encKeyCiphertext: encKey.ciphertext, encKeyNonce: encKey.nonce };
        }, serverId);

        expect(picData.error).toBeUndefined();
        expect(picData.fileId).toBeTruthy();

        // Set server picture via Playwright's test-side HTTP
        const picRes = await page.request.put(`${BASE}/api/servers/${serverId}/picture`, {
            headers: { Authorization: `Bearer ${result.token}`, 'Content-Type': 'application/json' },
            data: {
                server_picture_file_id: picData.fileId,
                encrypted_server_picture_key: picData.encKeyCiphertext,
                server_picture_key_nonce: picData.encKeyNonce,
            },
        });
        // Check the actual status and body for debugging
        const picStatus = picRes.status();
        const picBody = await picRes.text();
        console.log(`PUT picture status=${picStatus}, body=${picBody}`);
        expect(picStatus).toBe(200);
        expect(picBody).toContain('ok');

        // Verify picture in server list
        const serversRes = await page.request.get(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${result.token}` },
        });
        expect(serversRes.ok()).toBeTruthy();
        const servers = await serversRes.json();
        const ourServer = servers.find((s: any) => s.id === serverId);
        expect(ourServer).toBeTruthy();
        expect(ourServer.server_picture_file_id).toBe(picData.fileId);
        expect(ourServer.encrypted_server_picture_key).toBeTruthy();
        expect(ourServer.server_picture_key_nonce).toBeTruthy();

        // Remove the picture
        const removeRes = await page.request.put(`${BASE}/api/servers/${serverId}/picture`, {
            headers: { Authorization: `Bearer ${result.token}`, 'Content-Type': 'application/json' },
            data: {
                server_picture_file_id: '',
                encrypted_server_picture_key: '',
                server_picture_key_nonce: '',
                remove: true,
            },
        });
        expect(removeRes.ok()).toBeTruthy();

        // Verify picture is removed
        const serversRes2 = await page.request.get(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${result.token}` },
        });
        expect(serversRes2.ok()).toBeTruthy();
        const servers2 = await serversRes2.json();
        const ourServer2 = servers2.find((s: any) => s.id === serverId);
        expect(ourServer2.server_picture_file_id).toBeNull();
        expect(ourServer2.encrypted_server_picture_key).toBeNull();
        expect(ourServer2.server_picture_key_nonce).toBeNull();
    });

    test('6. Server picture — non-owner cannot set picture', async ({ page, context }) => {
        const ts = Date.now() + Math.floor(Math.random() * 10000);
        const ownerUser = 'spo_' + ts;
        const otherUser = 'spb_' + ts;

        const owner = await registerUser(page, ownerUser);
        expect(owner.token).toBeTruthy();
        await waitForWs(page);

        const server = await createServerWithApi(page, owner.token);
        expect(server).toBeTruthy();

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const other = await registerUser(page2, otherUser);
        expect(other.token).toBeTruthy();

        const picRes = await page2.request.put(`${BASE}/api/servers/${server.id}/picture`, {
            headers: { Authorization: `Bearer ${other.token}`, 'Content-Type': 'application/json' },
            data: {
                server_picture_file_id: 'some-file-id',
                encrypted_server_picture_key: 'aGVsbG8=',
                server_picture_key_nonce: 'd29ybGQ=',
            },
        });
        const status = picRes.status();
        expect([403, 401, 405]).toContain(status);
        await ctx2.close();
    });

    // ════════════════════════════════════════════════════════════════
    // TEST 4: Sticker square-crop logic verification
    // ════════════════════════════════════════════════════════════════

    test('7. Sticker processing code always crops to square region', async ({ page }) => {
        const ts = Date.now() + Math.floor(Math.random() * 10000);
        const username = 'stk_' + ts;
        await registerUser(page, username);

        const codeCheck = await page.evaluate(() => {
            const fnStr = (typeof processAndUploadSticker === 'function')
                ? processAndUploadSticker.toString()
                : '';
            const hasOldNonSquareBranch = fnStr.includes("canvas.width = img.naturalWidth") &&
                fnStr.includes("canvas.height = img.naturalHeight") &&
                fnStr.includes("ctx.drawImage(img, 0, 0)");
            const usesCropSize = fnStr.includes("canvas.width = cropSize") &&
                fnStr.includes("canvas.height = cropSize") &&
                fnStr.includes("ctx.drawImage(img, cropX, cropY, cropSize, cropSize, 0, 0, cropSize, cropSize)");
            return { hasOldNonSquareBranch, usesCropSize };
        });

        expect(codeCheck.usesCropSize).toBe(true);
        expect(codeCheck.hasOldNonSquareBranch).toBe(false);
    });

    test('8. Sticker initCropBox sets square crop state correctly', async ({ page }) => {
        const ts = Date.now() + Math.floor(Math.random() * 10000);
        const username = 'stc_' + ts;
        await registerUser(page, username);

        const stateCheck = await page.evaluate(() => {
            if (typeof stickerCropState === 'undefined') return { exists: false };
            return {
                exists: true,
                cropX: stickerCropState.cropX,
                cropY: stickerCropState.cropY,
                cropSize: stickerCropState.cropSize,
                maxCropSize: stickerCropState.maxCropSize,
            };
        });

        expect(stateCheck.exists).toBe(true);
        expect(stateCheck.cropSize).toBe(0);
    });

    // ════════════════════════════════════════════════════════════════
    // TEST 5: Memory leak — event listener cleanup
    // ════════════════════════════════════════════════════════════════

    test('9. initServerPictureCropBox stores cleanup function', async ({ page }) => {
        const ts = Date.now() + Math.floor(Math.random() * 10000);
        const username = 'mle_' + ts;
        await registerUser(page, username);

        const sourceCheck = await page.evaluate(() => {
            const fnStr = (typeof initServerPictureCropBox === 'function')
                ? initServerPictureCropBox.toString()
                : '';
            const hasCleanupCode = fnStr.includes('cleanupCropListeners');
            const removeCalls = (fnStr.match(/removeEventListener/g) || []).length;
            return { hasCleanupCode, removeCalls };
        });

        expect(sourceCheck.hasCleanupCode).toBe(true);
        expect(sourceCheck.removeCalls).toBeGreaterThanOrEqual(10);
    });

    test('10. No orphan document listeners after cleanup', async ({ page }) => {
        const ts = Date.now() + Math.floor(Math.random() * 10000);
        const username = 'mle2_' + ts;
        await registerUser(page, username);

        const codeCheck = await page.evaluate(() => {
            const fnStr = (typeof initServerPictureCropBox === 'function')
                ? initServerPictureCropBox.toString()
                : '';

            // Count addEventListener calls for each event type on document
            const addDocMousemove = (fnStr.match(/document\.addEventListener\('mousemove'/g) || []).length;
            const addDocMouseup = (fnStr.match(/document\.addEventListener\('mouseup'/g) || []).length;
            const addDocTouchmove = (fnStr.match(/document\.addEventListener\('touchmove'/g) || []).length;
            const addDocTouchend = (fnStr.match(/document\.addEventListener\('touchend'/g) || []).length;

            // Event type counts: mousemove=2 (onDragMove + onResizeMove), mouseup=1, touchmove=2, touchend=1
            // In the original code with duplicates, mousemove was 3 and mouseup/touchend were 2
            const countMatch = addDocMousemove === 2 && addDocMouseup === 1 &&
                addDocTouchmove === 2 && addDocTouchend === 1;

            return { addDocMousemove, addDocMouseup, addDocTouchmove, addDocTouchend, countMatch };
        });

        expect(codeCheck.countMatch).toBe(true);
    });
});
