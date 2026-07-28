import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

function uid(base: string): string {
    return `${base}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
}

async function registerUser(page: any, username: string, password = 'password123') {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', password);
    await page.fill('#register-confirm-password', password);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForTimeout(2000);
    return page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function createServerViaApi(page: any, token: string, name: string, uid: string) {
    const hmacKey = await page.evaluate(() => localStorage.getItem('e2e_hmac_key'));
    const code = 'TEST' + uid.slice(-6).toUpperCase();

    const keyResult = await page.evaluate(async () => {
        const identityKp = E2ECrypto.getIdentityKeyPair();
        if (!identityKp) return { error: 'no_identity_key' };
        const serverKey = E2ECrypto.generateSymmetricKey();
        const serverKeyB64 = E2ECrypto.arrayBufferToBase64(serverKey);
        const enc = E2ECrypto.envelopeEncrypt(serverKeyB64, identityKp.publicKey, identityKp.privateKey);
        return {
            serverKeyB64,
            encryptedKey: enc.ciphertext,
            nonce: enc.nonce,
            senderPubB64: E2ECrypto.arrayBufferToBase64(identityKp.publicKey),
        };
    });
    expect(keyResult.error).toBeUndefined();

    const encName = await page.evaluate(({ name, keyB64 }) => {
        const k = new Uint8Array(E2ECrypto.base64ToArrayBuffer(keyB64));
        return E2ECrypto.aeadEncrypt(name, k);
    }, { name, keyB64: keyResult.serverKeyB64 });
    const encChName = await page.evaluate(({ keyB64 }) => {
        const k = new Uint8Array(E2ECrypto.base64ToArrayBuffer(keyB64));
        return E2ECrypto.aeadEncrypt('general', k);
    }, { keyB64: keyResult.serverKeyB64 });

    const res = await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            invite_code: code,
            encrypted_name: encName.ciphertext,
            name_nonce: encName.nonce,
            channel_encrypted_name: encChName.ciphertext,
            channel_name_nonce: encChName.nonce,
        },
    });
    expect(res.ok()).toBeTruthy();
    const server = await res.json();

    const uploadRes = await page.request.post(`${BASE}/api/servers/${server.id}/keys`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            user_id: JSON.parse(await page.evaluate(() => localStorage.getItem('user') || '{}')).id,
            encrypted_key: keyResult.encryptedKey,
            sender_public_key: keyResult.senderPubB64,
            nonce: keyResult.nonce,
        },
    });
    expect(uploadRes.ok()).toBeTruthy();

    // Store server key in localStorage
    await page.evaluate(({ sid, keyB64 }) => {
        const keyBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(keyB64));
        E2ECrypto.saveServerKey(sid, keyBytes);
    }, { sid: server.id, keyB64: keyResult.serverKeyB64 });

    return { serverId: server.id, serverKeyB64: keyResult.serverKeyB64, inviteCode: code };
}

/**
 * Registration — clear localStorage — login — verify ALL keys restored
 *
 * Tests that the new client-side password hashing flow (auth.js) correctly:
 * 1. Generates hash_key, encrypts it with password, sends HMAC-hashed password
 * 2. Saves a complete key blob to the server during registration
 * 3. Restores ALL keys from the blob after full localStorage wipe + login
 * 4. The restored keys are bit-for-bit identical to originals
 */
test.describe('Auth Flow — Client-Side Password Hashing', () => {

    test('1. register → clear → login: identity keys fully restored', async ({ page }) => {
        const username = uid('auth_id');
        const password = 'testpass789';

        await registerUser(page, username, password);

        // Snapshot all critical keys BEFORE clearing
        const before = await page.evaluate((uid: string) => {
            const kp = E2ECrypto.getIdentityKeyPair(uid);
            if (!kp) return { error: 'no_identity_keypair' };
            const keys: Record<string, string | null> = {};
            keys.privB64 = E2ECrypto.arrayBufferToBase64(kp.privateKey);
            keys.pubB64 = E2ECrypto.arrayBufferToBase64(kp.publicKey);
            keys.e2e_auth_key = localStorage.getItem('e2e_auth_key');
            keys.e2e_hmac_key = localStorage.getItem('e2e_hmac_key');
            keys.e2e_friend_code = localStorage.getItem('e2e_friend_code');
            keys.e2e_encrypted_password = localStorage.getItem('e2e_encrypted_password');
            keys.token = localStorage.getItem('token');
            keys.user = localStorage.getItem('user');
            return keys;
        }, JSON.parse(await page.evaluate(() => localStorage.getItem('user') || '{}')).id);
        expect(before.error).toBeUndefined();
        expect(before.privB64).toBeTruthy();
        expect(before.pubB64).toBeTruthy();
        expect(before.e2e_auth_key).toBeTruthy();
        expect(before.e2e_hmac_key).toBeTruthy();
        expect(before.e2e_friend_code).toBeTruthy();
        expect(before.e2e_encrypted_password).toBeTruthy();

        // Clear everything
        await page.evaluate(() => { localStorage.clear(); });

        // Login again with same password
        await page.goto(`${BASE}/login.html`);
        await page.fill('#login-username', username);
        await page.fill('#login-password', password);
        await page.click('#login-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await page.waitForTimeout(3000);

        // Snapshot keys AFTER login
        const after = await page.evaluate((uid: string) => {
            const kp = E2ECrypto.getIdentityKeyPair(uid);
            if (!kp) return { error: 'no_identity_keypair_after' };
            const keys: Record<string, string | null> = {};
            keys.privB64 = E2ECrypto.arrayBufferToBase64(kp.privateKey);
            keys.pubB64 = E2ECrypto.arrayBufferToBase64(kp.publicKey);
            keys.e2e_auth_key = localStorage.getItem('e2e_auth_key');
            keys.e2e_hmac_key = localStorage.getItem('e2e_hmac_key');
            keys.e2e_friend_code = localStorage.getItem('e2e_friend_code');
            keys.e2e_encrypted_password = localStorage.getItem('e2e_encrypted_password');
            keys.token = localStorage.getItem('token');
            keys.user = localStorage.getItem('user');
            return keys;
        }, JSON.parse(before.user!).id);

        expect(after.error).toBeUndefined();
        // Identity keys must match exactly (they're the same account)
        expect(after.privB64).toBe(before.privB64);
        expect(after.pubB64).toBe(before.pubB64);
        // HMAC key must match (server-generated, recovered from blob)
        expect(after.e2e_hmac_key).toBe(before.e2e_hmac_key);
        // Friend code must match
        expect(after.e2e_friend_code).toBe(before.e2e_friend_code);
        // Auth key (hash_key cache) must match — recovered from blob
        expect(after.e2e_auth_key).toBe(before.e2e_auth_key);
        // Encrypted password must be present
        expect(after.e2e_encrypted_password).toBeTruthy();
        // Token must be new (fresh login)
        expect(after.token).toBeTruthy();
        expect(after.token).not.toBe(before.token);
        // User object must be present
        expect(after.user).toBeTruthy();
    });

    test('2. register + server → clear → login: server key restored', async ({ page }) => {
        const username = uid('auth_srv');
        const password = 'testpass456';

        await registerUser(page, username, password);
        const token = await page.evaluate(() => localStorage.getItem('token'));

        // Create a server (this also stores the server key in localStorage + blob)
        const { serverId, serverKeyB64 } = await createServerViaApi(page, token, 'AuthSrvTest', username);
        // Force an immediate blob save instead of waiting for debounced scheduleKeyBlobSave
        const blobSaved = await page.evaluate(async () => {
            const encPw = localStorage.getItem('e2e_encrypted_password');
            const devKeyStr = localStorage.getItem('e2e_device_key');
            if (!encPw || !devKeyStr) return 'missing_creds';
            const dk = new Uint8Array(E2ECrypto.base64ToArrayBuffer(devKeyStr));
            const pwB64 = E2ECrypto.decodeEncryptedFileKey(encPw, dk);
            if (!pwB64) return 'cannot_decode_pw';
            const password = atob(pwB64);
            const bundle = E2ECrypto.buildKeyBundle();
            const enc = E2ECrypto.encryptKeyBundle(bundle, password);
            const res = await fetch('/api/key-blob', {
                method: 'PUT',
                headers: {
                    'Authorization': 'Bearer ' + localStorage.getItem('token'),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    encrypted_blob: enc.encrypted_private_key,
                    salt: enc.salt,
                    nonce: enc.nonce,
                })
            });
            return res.ok ? 'saved_ok' : 'http_failed';
        });
        expect(blobSaved).toBe('saved_ok');

        // Snapshot server key using raw localStorage value (avoids any getServerKey encoding issues)
        const beforeSrvKeyRaw = await page.evaluate((sid: string) =>
            localStorage.getItem('e2e_server_' + sid)
        , serverId);
        expect(beforeSrvKeyRaw).toBeTruthy();
        // Verify the raw localStorage value decodes to the original key
        const decodedKeyB64 = await page.evaluate((raw: string) => {
            const bytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(raw));
            return E2ECrypto.arrayBufferToBase64(bytes);
        }, beforeSrvKeyRaw!);
        expect(decodedKeyB64).toBe(serverKeyB64);

        // Clear everything
        await page.evaluate(() => { localStorage.clear(); });

        // Login
        await page.goto(`${BASE}/login.html`);
        await page.fill('#login-username', username);
        await page.fill('#login-password', password);
        await page.click('#login-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await page.waitForTimeout(5000);

        // Check raw localStorage value for server key after restore
        const afterSrvKeyRaw = await page.evaluate((sid: string) =>
            localStorage.getItem('e2e_server_' + sid)
        , serverId);
        expect(afterSrvKeyRaw).toBe(beforeSrvKeyRaw);
    });

    test('3. register + profile keys → clear → login: profile key cache restored', async ({ page }) => {
        const username = uid('auth_prof');
        const password = 'testpass789';

        await registerUser(page, username, password);

        // Create a profile_key_cache entry (simulates what happens after profile sync)
        await page.evaluate(() => {
            const cache: Record<string, string> = {};
            const dummyKey = E2ECrypto.arrayBufferToBase64(E2ECrypto.randomBytes(32));
            const uid = JSON.parse(localStorage.getItem('user') || '{}').id;
            cache[uid + ':profile_data_key'] = dummyKey;
            localStorage.setItem('profile_key_cache', JSON.stringify(cache));
        });
        // Force immediate blob save
        const blobSaved = await page.evaluate(async () => {
            const encPw = localStorage.getItem('e2e_encrypted_password');
            const devKeyStr = localStorage.getItem('e2e_device_key');
            if (!encPw || !devKeyStr) return 'missing_creds';
            const dk = new Uint8Array(E2ECrypto.base64ToArrayBuffer(devKeyStr));
            const pwB64 = E2ECrypto.decodeEncryptedFileKey(encPw, dk);
            if (!pwB64) return 'cannot_decode_pw';
            const password = atob(pwB64);
            const bundle = E2ECrypto.buildKeyBundle();
            const enc = E2ECrypto.encryptKeyBundle(bundle, password);
            const res = await fetch('/api/key-blob', {
                method: 'PUT',
                headers: {
                    'Authorization': 'Bearer ' + localStorage.getItem('token'),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    encrypted_blob: enc.encrypted_private_key,
                    salt: enc.salt,
                    nonce: enc.nonce,
                })
            });
            return res.ok ? 'saved_ok' : 'http_failed';
        });
        expect(blobSaved).toBe('saved_ok');

        const beforeCache = await page.evaluate(() =>
            localStorage.getItem('profile_key_cache')
        );
        expect(beforeCache).toBeTruthy();

        const beforeAuthKey = await page.evaluate(() =>
            localStorage.getItem('e2e_auth_key')
        );
        expect(beforeAuthKey).toBeTruthy();

        // Clear everything
        await page.evaluate(() => { localStorage.clear(); });

        // Login
        await page.goto(`${BASE}/login.html`);
        await page.fill('#login-username', username);
        await page.fill('#login-password', password);
        await page.click('#login-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await page.waitForTimeout(3000);

        const afterCache = await page.evaluate(() =>
            localStorage.getItem('profile_key_cache')
        );
        expect(afterCache).toBe(beforeCache);

        const afterAuthKey = await page.evaluate(() =>
            localStorage.getItem('e2e_auth_key')
        );
        expect(afterAuthKey).toBe(beforeAuthKey);
    });

    test('4. register → clear → wrong password fails gracefully', async ({ page }) => {
        const username = uid('auth_wrong');
        const password = 'correctpass123';

        await registerUser(page, username, password);

        // Clear everything
        await page.evaluate(() => { localStorage.clear(); });

        await page.goto(`${BASE}/login.html`);
        await page.fill('#login-username', username);
        await page.fill('#login-password', 'wrongpassword');
        await page.click('#login-form button[type="submit"]');

        // Wait for the async login handler to process the wrong password and render error
        await page.waitForSelector('#error-message:not(:empty)', { timeout: 10000 });

        // Should still be on login page
        expect(page.url()).toContain('login.html');

        // Error message should be visible with text
        const errorText = await page.textContent('#error-message');
        expect(errorText).toBeTruthy();
        expect(errorText!.length).toBeGreaterThan(0);
    });

    test('5. register + DM → clear → login: DM channel & messages accessible', async ({ page, context }) => {
        test.setTimeout(120000); // DM flow involves 2 registrations + WS + polling
        const username1 = uid('auth_dm1');
        const username2 = uid('auth_dm2');
        const password = 'testpass999';

        // We'll use a shared cleanup for the second page/context
        let page2: any = null;
        let ctx2: any = null;
        try {
            // Register user 1
            const body1 = await registerUser(page, username1, password);
            const token1 = await page.evaluate(() => localStorage.getItem('token'));

            // Register user 2 in a separate page
            ctx2 = await context.browser()!.newContext();
            page2 = await ctx2.newPage();
            const body2 = await registerUser(page2, username2, password);
            const token2 = await page2.evaluate(() => localStorage.getItem('token'));

            // Become friends via API
            const friendCode2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
            const fr = await page.request.post(`${BASE}/api/friends/request`, {
                headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
                data: { friend_code: friendCode2 },
            });
            expect(fr.ok()).toBeTruthy();

            const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
                headers: { Authorization: `Bearer ${token2}` },
            })).json();
            expect(Array.isArray(incoming)).toBe(true);
            expect(incoming.length).toBe(1);

            const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
                headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
                data: { request_id: incoming[0].id },
            });
            expect(acc.ok()).toBeTruthy();
            await page.waitForTimeout(2000);

            // Create DM channel
            const dmRes = await page.request.post(`${BASE}/api/dm/${body2.user.id}`, {
                headers: { Authorization: `Bearer ${token1}` },
            });
            expect(dmRes.ok()).toBeTruthy();
            const dmChannel = await dmRes.json();
            const dmChannelId = dmChannel.id;
            expect(dmChannelId).toBeTruthy();
            await page.waitForTimeout(1000);

            // Send a DM message via WS
            const sendResult = await page.evaluate(async ({ dmChannelId, otherUserId, msg }) => {
                // Wait for WS to be connected
                for (let i = 0; i < 100; i++) {
                    if (ws && ws.readyState === WebSocket.OPEN) break;
                    await new Promise(r => setTimeout(r, 100));
                }
                if (!ws || ws.readyState !== WebSocket.OPEN) return 'ws_not_open';
                const kp = E2ECrypto.getIdentityKeyPair();
                if (!kp) return 'no_identity_key';
                const res = await fetch('/api/identity/' + otherUserId, {
                    headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
                });
                const data = await res.json();
                if (!data.identity_public_key) return 'no_other_pub_key';
                const otherPubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
                const encrypted = E2ECrypto.encryptDm(msg, dmChannelId, kp.privateKey, otherPubKey);
                ws.send(JSON.stringify({
                    type: 'dm_send',
                    dm_channel_id: dmChannelId,
                    encrypted_content: encrypted.ciphertext,
                    nonce: encrypted.nonce,
                }));
                return 'sent';
            }, { dmChannelId, otherUserId: body2.user.id, msg: 'Hello after DM!' });
            expect(sendResult).toBe('sent');

            // Wait for message to be persisted by polling the API
            let msgCount = 0;
            for (let i = 0; i < 20; i++) {
                await new Promise(r => setTimeout(r, 500));
                const checkRes = await page.request.get(`${BASE}/api/dm/${dmChannelId}/messages`, {
                    headers: { Authorization: `Bearer ${token1}` },
                });
                if (checkRes.ok) {
                    const checkMsgs = await checkRes.json();
                    if (Array.isArray(checkMsgs) && checkMsgs.length >= 1) {
                        msgCount = checkMsgs.length;
                        break;
                    }
                }
            }
            expect(msgCount).toBeGreaterThanOrEqual(1);

            // Save blob to ensure key recovery works
            const blobSaved = await page.evaluate(async () => {
                const encPw = localStorage.getItem('e2e_encrypted_password');
                const devKeyStr = localStorage.getItem('e2e_device_key');
                if (!encPw || !devKeyStr) return 'missing_creds';
                const dk = new Uint8Array(E2ECrypto.base64ToArrayBuffer(devKeyStr));
                const pwB64 = E2ECrypto.decodeEncryptedFileKey(encPw, dk);
                if (!pwB64) return 'cannot_decode_pw';
                const pw = atob(pwB64);
                const bundle = E2ECrypto.buildKeyBundle();
                const enc = E2ECrypto.encryptKeyBundle(bundle, pw);
                const res = await fetch('/api/key-blob', {
                    method: 'PUT',
                    headers: {
                        'Authorization': 'Bearer ' + localStorage.getItem('token'),
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        encrypted_blob: enc.encrypted_private_key,
                        salt: enc.salt,
                        nonce: enc.nonce,
                    })
                });
                return res.ok ? 'saved_ok' : 'http_failed';
            });
            expect(blobSaved).toBe('saved_ok');

            // Clear user1's localStorage
            await page.evaluate(() => { localStorage.clear(); });

            // Login again as user1
            await page.goto(`${BASE}/login.html`);
            await page.fill('#login-username', username1);
            await page.fill('#login-password', password);
            await page.click('#login-form button[type="submit"]');
            await page.waitForURL('**/index.html', { timeout: 15000 });
            await page.waitForTimeout(5000);

            // Verify identity key restored
            const user1Id = body1.user.id;
            const hasIdentity = await page.evaluate((uid: string) => {
                const kp = E2ECrypto.getIdentityKeyPair(uid);
                return kp ? true : false;
            }, user1Id);
            expect(hasIdentity).toBe(true);

            // Verify HMAC key restored
            const hmacAfter = await page.evaluate(() => localStorage.getItem('e2e_hmac_key'));
            expect(hmacAfter).toBeTruthy();

            // Verify friend code restored
            const fcAfter = await page.evaluate(() => localStorage.getItem('e2e_friend_code'));
            expect(fcAfter).toBeTruthy();

            // Verify we can fetch DM messages
            const newToken = await page.evaluate(() => localStorage.getItem('token'));
            const msgsRes = await page.request.get(`${BASE}/api/dm/${dmChannelId}/messages`, {
                headers: { Authorization: `Bearer ${newToken}` },
            });
            expect(msgsRes.ok()).toBeTruthy();
            const msgs = await msgsRes.json();
            expect(Array.isArray(msgs)).toBe(true);
            expect(msgs.length).toBeGreaterThanOrEqual(1);

            // Verify we can decrypt the message
            const canDecrypt = await page.evaluate(async ({ msgs2, dmId, otherUserId }) => {
                const kp = E2ECrypto.getIdentityKeyPair();
                if (!kp) return 'no_identity_key';
                try {
                    const otherRes = await fetch('/api/identity/' + otherUserId, {
                        headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
                    });
                    const otherData = await otherRes.json();
                    if (!otherData.identity_public_key) return 'no_other_pub_key';
                    const otherPubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(otherData.identity_public_key));
                    const decrypted = E2ECrypto.decryptDm(msgs2[0].encrypted_content, msgs2[0].nonce, dmId, kp.privateKey, otherPubKey);
                    return decrypted || 'decrypt_returned_null';
                } catch (e: any) {
                    return 'error: ' + e.message;
                }
            }, { msgs2: msgs, dmId: dmChannelId, otherUserId: body2.user.id });
            expect(canDecrypt).toContain('Hello after DM!');
        } finally {
            if (page2) await page2.close().catch(() => {});
            if (ctx2) await ctx2.close().catch(() => {});
        }
    });

    test('6. auth-params endpoint returns valid encrypted hash_key (no plaintext leak)', async ({ page }) => {
        const username = uid('auth_params');
        const password = 'testpass111';

        // Register
        await registerUser(page, username, password);
        const token = await page.evaluate(() => localStorage.getItem('token'));

        // Fetch auth-params endpoint
        const paramsRes = await page.request.get(`${BASE}/api/auth-params/${encodeURIComponent(username)}`);
        expect(paramsRes.ok()).toBeTruthy();
        const params = await paramsRes.json();

        // Verify encrypted_hash_key is present
        expect(params.encrypted_hash_key).toBeTruthy();
        expect(params.hash_key_salt).toBeTruthy();
        expect(params.hash_key_nonce).toBeTruthy();

        // Verify it's an encrypted blob (base64), NOT a plaintext 32-byte key
        expect(params.encrypted_hash_key.length).toBeGreaterThan(40);
        expect(params.hash_key_salt.length).toBeGreaterThan(20);
        expect(params.hash_key_nonce.length).toBeGreaterThan(20);

        // Verify the hash_key can be decrypted with the password
        const decryptedKey = await page.evaluate(({ encKey, salt, nonce, pw }) => {
            return E2ECrypto.decryptWithPassword(encKey, pw, salt, nonce);
        }, { encKey: params.encrypted_hash_key, salt: params.hash_key_salt, nonce: params.hash_key_nonce, pw: password });
        expect(decryptedKey).toBeTruthy();
        expect(decryptedKey.length).toBeGreaterThan(40); // base64 of 32 bytes = 44 chars

        // Verify the server does NOT return password hash or hash_key fields in /api/me
        const meRes = await page.request.get(`${BASE}/api/me`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(meRes.ok()).toBeTruthy();
        const meData = await meRes.json();
        expect(meData.password_hash).toBeUndefined();
        expect(meData.encrypted_hash_key).toBeUndefined();
        expect(meData.hash_key_salt).toBeUndefined();
        expect(meData.hash_key_nonce).toBeUndefined();
    });

    test('7. reauth uses same hashed-password flow (computeHashedPasswordGlobal)', async ({ page }) => {
        const username = uid('auth_reauth');
        const password = 'reauthpass123';

        await registerUser(page, username, password);

        // Verify computeHashedPasswordGlobal exists and is callable
        const funcExists = await page.evaluate(() =>
            typeof computeHashedPasswordGlobal === 'function'
        );
        expect(funcExists).toBe(true);

        // Cache the e2e_auth_key so we know the hash_key is available
        const authKeyBefore = await page.evaluate(() =>
            localStorage.getItem('e2e_auth_key')
        );
        expect(authKeyBefore).toBeTruthy();

        // Verify computeHashedPasswordGlobal produces a valid 64-char hex hash
        const computedHash = await page.evaluate(async (pw: string) => {
            try {
                return await computeHashedPasswordGlobal(pw);
            } catch (e: any) {
                return null;
            }
        }, password);
        expect(computedHash).toBeTruthy();
        expect(computedHash!.length).toBe(64); // SHA-256 hex = 64 chars

        // Verify a wrong password either throws or produces a different hash
        const wrongHash = await page.evaluate(async (pw: string) => {
            try {
                return await computeHashedPasswordGlobal(pw);
            } catch (_) {
                return null;
            }
        }, 'wrongpassword');
        if (wrongHash) {
            expect(wrongHash).not.toBe(computedHash);
        }

        // Now test the full reauth API call using the HMAC hash
        const token = await page.evaluate(() => localStorage.getItem('token'));
        const reauthRes = await page.request.post(`${BASE}/api/reauth`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            data: { password: computedHash },
        });
        expect(reauthRes.ok()).toBeTruthy();
        const reauthData = await reauthRes.json();
        expect(reauthData.token).toBeTruthy();

        // Verify the new token works
        const meRes = await page.request.get(`${BASE}/api/me`, {
            headers: { Authorization: `Bearer ${reauthData.token}` },
        });
        expect(meRes.ok()).toBeTruthy();
        const meData = await meRes.json();
        expect(meData.username).toBe(username);
    });
});
