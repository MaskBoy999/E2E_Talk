import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// A real *server key* is `e2e_server_<uuid>`. The bundle also carries the
// shared local app state — `e2e_server_groups_<uid>` (folders) and
// `e2e_server_group_assignments_<uid>` — which a fresh registration writes as
// empty defaults. Those are per-account SETTINGS, not server keys, so a plain
// `startsWith('e2e_server_')` would count them and make these assertions
// meaningless (bundle v4 added that shared state).
const SERVER_KEY_RE = /^e2e_server_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

test.describe('Key Blob Recovery After Cookie Clear', () => {

    async function registerUser(page: any, username: string, password = 'password123') {
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', password);
        await page.fill('#register-confirm-password', password);
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        return await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
            friendCode: localStorage.getItem('e2e_friend_code'),
        }));
    }

    async function becomeFriends(page1: any, page2: any, token1: string, token2: string) {
        const friendCode2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        const fr = await page1.request.post(`${BASE}/api/friends/request`, {
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
    }

    async function createServerViaApi(page: any, token: string, name: string, uid: string) {
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

        // Upload raw server key (the server stores it as-is in the DB)
        const uploadRes = await page.request.post(`${BASE}/api/servers/${server.id}/keys`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: {
                user_id: JSON.parse(await page.evaluate(() => localStorage.getItem('user') || '{}')).id,
                encrypted_key: keyResult.serverKeyB64,
                sender_public_key: '',
                nonce: '',
            },
        });
        if (!uploadRes.ok()) {
            const envRes = await page.request.post(`${BASE}/api/servers/${server.id}/keys`, {
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                data: {
                    user_id: JSON.parse(await page.evaluate(() => localStorage.getItem('user') || '{}')).id,
                    encrypted_key: keyResult.encryptedKey,
                    sender_public_key: keyResult.senderPubB64,
                    nonce: keyResult.nonce,
                },
            });
            expect(envRes.ok()).toBeTruthy();
        }

        // Store server key in localStorage (mimics saveServerKey() + scheduleKeyBlobSave())
        await page.evaluate(({ sid, keyB64 }) => {
            const keyBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(keyB64));
            E2ECrypto.saveServerKey(sid, keyBytes);
            if (typeof scheduleKeyBlobSave === 'function') {
                scheduleKeyBlobSave();
            }
        }, { sid: server.id, keyB64: keyResult.serverKeyB64 });

        return { serverId: server.id, serverKeyB64: keyResult.serverKeyB64, inviteCode: code };
    }

    async function createDmViaApi(page1: any, token1: string, user2Id: string) {
        const dm = await page1.request.post(`${BASE}/api/dm/${user2Id}`, {
            headers: { Authorization: `Bearer ${token1}` },
        });
        expect(dm.ok()).toBeTruthy();
        return await dm.json();
    }

    // ──────────────────────────────────────────────────────────────────
    // TEST 1: Identity keys recovered from blob after full wipe
    // ──────────────────────────────────────────────────────────────────
    test('1. identity keys recovered from blob after full localStorage wipe', async ({ page }) => {
        const ts = Date.now();
        const user1 = 'blobident1_' + ts;
        await registerUser(page, user1);
        const originalPrivKey = await page.evaluate(() =>
            E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().privateKey)
        );
        expect(originalPrivKey).toBeTruthy();

        await page.evaluate(() => { localStorage.clear(); });
        await page.goto(`${BASE}/login.html`);
        await page.fill('#login-username', user1);
        await page.fill('#login-password', 'password123');
        await page.click('#login-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });

        const restoredKey = await page.evaluate(() =>
            E2ECrypto.getIdentityKeyPair() ?
                E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().privateKey) :
                null
        );
        expect(restoredKey).toBe(originalPrivKey);
    });

    // ──────────────────────────────────────────────────────────────────
    // TEST 2: Friend code recovered from blob after full wipe
    // ──────────────────────────────────────────────────────────────────
    test('2. friend code recovered from blob after full localStorage wipe', async ({ page }) => {
        const ts = Date.now();
        const user1 = 'blobfc1_' + ts;
        await registerUser(page, user1);
        const originalFC = await page.evaluate(() => localStorage.getItem('e2e_friend_code'));
        expect(originalFC).toBeTruthy();

        await page.evaluate(() => { localStorage.clear(); });
        await page.goto(`${BASE}/login.html`);
        await page.fill('#login-username', user1);
        await page.fill('#login-password', 'password123');
        await page.click('#login-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });

        const restoredFC = await page.evaluate(() => localStorage.getItem('e2e_friend_code'));
        expect(restoredFC).toBe(originalFC);
    });

    // ──────────────────────────────────────────────────────────────────
    // TEST 3: Server key fetchable after full localStorage wipe
    // ──────────────────────────────────────────────────────────────────
    test('3. server key fetchable after full localStorage wipe', async ({ page }) => {
        const ts = Date.now();
        const uid = 'blobsv1_' + ts;
        await registerUser(page, uid);
        const token = await page.evaluate(() => localStorage.getItem('token'));

        const { serverId, serverKeyB64 } = await createServerViaApi(page, token, 'TestServer', uid);
        await page.waitForTimeout(6000);

        const hasKeyBefore = await page.evaluate((sid) => !!localStorage.getItem('e2e_server_' + sid), serverId);
        expect(hasKeyBefore).toBe(true);

        await page.evaluate(() => { localStorage.clear(); });
        await page.goto(`${BASE}/login.html`);
        await page.fill('#login-username', uid);
        await page.fill('#login-password', 'password123');
        await page.click('#login-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await page.waitForTimeout(6000);

        const hasServerKey = await page.evaluate((sid) => !!localStorage.getItem('e2e_server_' + sid), serverId);
        console.log('Server key after re-login:', hasServerKey, 'for serverId:', serverId);
        expect(hasServerKey).toBe(true);

        const storedKeyB64 = await page.evaluate((sid) => {
            const sk = E2ECrypto.getServerKey(sid);
            return sk ? E2ECrypto.arrayBufferToBase64(sk) : null;
        }, serverId);
        expect(storedKeyB64).toBe(serverKeyB64);
    });

    // ──────────────────────────────────────────────────────────────────
    // TEST 4: DM messages decryptable after full localStorage wipe
    // ──────────────────────────────────────────────────────────────────
    test('4. DM messages decryptable after full localStorage wipe', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'blobdm1_' + ts;
        const user2 = 'blobdm2_' + ts;

        const body1 = await registerUser(page, user1);
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        await becomeFriends(page, page2, body1.token, body2.token);

        const dmChannel = await createDmViaApi(page, body1.token, body2.user.id);
        const dmChannelId = dmChannel.id;

        const sendResult = await page.evaluate(async ({ dmChannelId, otherUserId, msg }) => {
            for (let i = 0; i < 50; i++) {
                if (ws && ws.readyState === WebSocket.OPEN) break;
                await new Promise(r => setTimeout(r, 100));
            }
            const kp = E2ECrypto.getIdentityKeyPair();
            if (!kp) return 'no_identity_key';
            const res = await fetch('/api/identity/' + otherUserId, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
            });
            const data = await res.json();
            const otherPubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
            const encrypted = E2ECrypto.encryptDm(msg, dmChannelId, kp.privateKey, otherPubKey);
            ws.send(JSON.stringify({
                type: 'dm_send',
                dm_channel_id: dmChannelId,
                encrypted_content: encrypted.ciphertext,
                nonce: encrypted.nonce,
                message_nonce: null,
            }));
            return 'sent';
        }, { dmChannelId, otherUserId: body2.user.id, msg: 'Hello after blob clear!' });
        expect(sendResult).toBe('sent');
        await page.waitForTimeout(3000);

        await page.evaluate(() => { localStorage.clear(); });
        await page.goto(`${BASE}/login.html`);
        await page.fill('#login-username', user1);
        await page.fill('#login-password', 'password123');
        await page.click('#login-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await page.waitForTimeout(5000);

        const newToken = await page.evaluate(() => localStorage.getItem('token'));
        const msgsAfter = await page.request.get(`${BASE}/api/dm/${dmChannelId}/messages`, {
            headers: { Authorization: `Bearer ${newToken}` },
        });
        const msgsAfterJson = await msgsAfter.json();
        expect(Array.isArray(msgsAfterJson)).toBe(true);
        expect(msgsAfterJson.length).toBeGreaterThanOrEqual(1);

        const canDecrypt = await page.evaluate(({ msgs2, dmId, otherUserId }) => {
            const kp = E2ECrypto.getIdentityKeyPair();
            if (!kp) return 'no_identity_key';
            return fetch('/api/identity/' + otherUserId, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
            }).then(r => r.json()).then(data => {
                const otherPubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
                try {
                    const decrypted = E2ECrypto.decryptDm(msgs2[0].encrypted_content, msgs2[0].nonce, dmId, kp.privateKey, otherPubKey);
                    return decrypted || 'decrypt_returned_null';
                } catch (e) {
                    return 'decrypt_error: ' + e.message;
                }
            }).catch(e => 'fetch_error: ' + e.message);
        }, { msgs2: msgsAfterJson, dmId: dmChannelId, otherUserId: body2.user.id });
        console.log('DM decryption after wipe:', canDecrypt);
        expect(canDecrypt).toContain('Hello after blob clear');

        await page2.close();
        await ctx2.close();
    });

    // ──────────────────────────────────────────────────────────────────
    // TEST 5: Inspect blob contents after full setup
    // ──────────────────────────────────────────────────────────────────
    test('5. inspect blob contents after full setup', async ({ page, context }) => {
        const ts = Date.now();
        const uid = 'blobinspect1_' + ts;
        const user2 = 'blobinspect2_' + ts;

        const body1 = await registerUser(page, uid);
        const token1 = await page.evaluate(() => localStorage.getItem('token'));

        await createServerViaApi(page, token1, 'InspectServer', uid);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        await becomeFriends(page, page2, body1.token, body2.token);

        // Set up profile_data_key in profile_key_cache
        await page.evaluate(() => {
            const pdKey = E2ECrypto.generateProfileDataKey();
            const pdKeyB64 = E2ECrypto.arrayBufferToBase64(pdKey);
            const uid2 = JSON.parse(localStorage.getItem('user') || '{}').id;
            if (uid2) {
                const cache = JSON.parse(localStorage.getItem('profile_key_cache') || '{}');
                cache[uid2 + ':profile_data_key'] = pdKeyB64;
                localStorage.setItem('profile_key_cache', JSON.stringify(cache));
                if (typeof scheduleProfileKeySave === 'function') {
                    scheduleProfileKeySave();
                }
            }
        });

        await page.waitForTimeout(8000);

        const blobRes = await page.request.get(`${BASE}/api/key-blob`, {
            headers: { Authorization: `Bearer ${token1}` },
        });
        expect(blobRes.ok()).toBeTruthy();
        const blobData = await blobRes.json();

        const blobContents = await page.evaluate(async ({ encryptedBlob, salt, nonce }) => {
            // 5.6: the vault owns the at-rest password now, so read it the way
            // the app does (session memory → vault ticket → legacy bootstrap)
            // instead of unwrapping the deleted e2e_encrypted_password blob.
            const password = (typeof loadDecryptedPassword === 'function') ? loadDecryptedPassword() : null;
            if (!password) return JSON.stringify({ error: 'missing_password_or_device_key' });
            const bundle = E2ECrypto.decryptKeyBundle(encryptedBlob, password, salt, nonce);
            if (!bundle) return JSON.stringify({ error: 'cannot_decrypt_bundle' });
            return JSON.stringify(bundle);
        }, { encryptedBlob: blobData.encrypted_blob, salt: blobData.salt, nonce: blobData.nonce });

        console.log('=== BLOB CONTENTS (full setup) ===');
        console.log(blobContents);
        const parsed = JSON.parse(blobContents);
        const keys = Object.keys(parsed);

        const hasIdentityKey = keys.some(k => k.startsWith('e2e_identity_private_'));
        const hasHmac = parsed['e2e_hmac_key'] !== undefined;
        const hasFriendCode = parsed['e2e_friend_code'] !== undefined;
        const hasServerKey = keys.some(k => SERVER_KEY_RE.test(k));
        const hasProfileCache = parsed['profile_key_cache'] !== undefined;

        console.log('=== BLOB KEY INVENTORY ===');
        console.log('Identity keys:', hasIdentityKey ? 'YES' : 'MISSING');
        console.log('HMAC key:', hasHmac ? 'YES' : 'MISSING');
        console.log('Friend code:', hasFriendCode ? 'YES' : 'MISSING');
        console.log('Server keys:', hasServerKey ? 'YES' : 'MISSING');
        console.log('Profile key cache:', hasProfileCache ? 'YES' : 'MISSING');

        expect(hasIdentityKey).toBe(true);
        expect(hasHmac).toBe(true);
        expect(hasFriendCode).toBe(true);

        if (!hasServerKey) console.log('WARNING: SERVER KEY NOT IN BLOB');
        if (!hasProfileCache) console.log('WARNING: PROFILE KEY CACHE NOT IN BLOB');

        await page2.close();
        await ctx2.close();
    });

    // ──────────────────────────────────────────────────────────────────
    // TEST 6: Registration blob baseline
    // ──────────────────────────────────────────────────────────────────
    test('6. registration blob contents (baseline)', async ({ page }) => {
        const ts = Date.now();
        const user1 = 'blobreg_' + ts;
        await registerUser(page, user1);

        await page.waitForTimeout(2000);

        const token = await page.evaluate(() => localStorage.getItem('token'));
        const blobRes = await page.request.get(`${BASE}/api/key-blob`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(blobRes.ok()).toBeTruthy();
        const blobData = await blobRes.json();

        const blobContents = await page.evaluate(async ({ encryptedBlob, salt, nonce }) => {
            // 5.6: read the password the way the app does — the vault deleted
            // the at-rest bootstrap blob this used to unwrap.
            const password = (typeof loadDecryptedPassword === 'function') ? loadDecryptedPassword() : null;
            if (!password) return JSON.stringify({ error: 'missing' });
            const bundle = E2ECrypto.decryptKeyBundle(encryptedBlob, password, salt, nonce);
            return JSON.stringify(bundle);
        }, { encryptedBlob: blobData.encrypted_blob, salt: blobData.salt, nonce: blobData.nonce });

        console.log('=== REGISTRATION BLOB ===');
        console.log(blobContents);
        const parsed = JSON.parse(blobContents);
        const keys = Object.keys(parsed);
        console.log('Keys in blob:', keys);

        expect(parsed['e2e_hmac_key']).toBeTruthy();
        expect(parsed['e2e_friend_code']).toBeTruthy();
        expect(keys.some(k => k.startsWith('e2e_identity_private_'))).toBe(true);
        expect(keys.some(k => SERVER_KEY_RE.test(k))).toBe(false);
    });

    // ──────────────────────────────────────────────────────────────────
    // TEST 7: Clear All Data preserves identity + server keys (by raw key check)
    // ──────────────────────────────────────────────────────────────────
    test('7. Clear All Data preserves identity + server keys, re-login works', async ({ page }) => {
        const ts = Date.now();
        const uid = 'clearalltest1_' + ts;
        await registerUser(page, uid);
        const token = await page.evaluate(() => localStorage.getItem('token'));

        const { serverId, serverKeyB64 } = await createServerViaApi(page, token, 'ClearDataTest', uid);
        await page.waitForTimeout(6000);

        // Manually save blob (bypassing saveKeyBlobToServer's silent failures)
        const blobSaved = await page.evaluate(async () => {
            // 5.6: the vault owns the at-rest password now — one source of
            // truth for tests and app alike.
            const password = (typeof loadDecryptedPassword === 'function') ? loadDecryptedPassword() : null;
            if (!password) return 'missing_creds';
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

        // Simulate Clear All Data (preserveIdentity=true)
        await page.evaluate(() => {
            const preservedKeys = {};
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && (k.indexOf('e2e_identity_private_') === 0 ||
                    k.indexOf('e2e_identity_public_') === 0 ||
                    k === 'profile_key_cache' ||
                    k === 'e2e_hmac_key' ||
                    k.indexOf('e2e_server_') === 0)) {
                    preservedKeys[k] = localStorage.getItem(k);
                }
            }
            localStorage.clear();
            for (const k2 in preservedKeys) {
                localStorage.setItem(k2, preservedKeys[k2]);
            }
        });

        // Check raw localStorage keys (getIdentityKeyPair won't work because 'user' is not preserved)
        const privKeyCount = await page.evaluate(() => {
            let count = 0;
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.indexOf('e2e_identity_private_') === 0) count++;
            }
            return count;
        });
        expect(privKeyCount).toBeGreaterThan(0);

        const hasServerKey = await page.evaluate((sid) => !!localStorage.getItem('e2e_server_' + sid), serverId);
        expect(hasServerKey).toBe(true);

        const hasHmac = await page.evaluate(() => !!localStorage.getItem('e2e_hmac_key'));
        expect(hasHmac).toBe(true);

        const hasToken = await page.evaluate(() => localStorage.getItem('token'));
        expect(hasToken).toBeNull();

        // Re-login
        await page.goto(`${BASE}/login.html`);
        await page.fill('#login-username', uid);
        await page.fill('#login-password', 'password123');
        await page.click('#login-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await page.waitForTimeout(5000);

        // After login, the blob should have restored identity keys + server key
        const hasKeyAfter = await page.evaluate((sid) => !!localStorage.getItem('e2e_server_' + sid), serverId);
        console.log('Server key after Clear All Data + re-login:', hasKeyAfter);
        expect(hasKeyAfter).toBe(true);

        const keyAfterB64 = await page.evaluate((sid) => {
            const sk = E2ECrypto.getServerKey(sid);
            return sk ? E2ECrypto.arrayBufferToBase64(sk) : null;
        }, serverId);
        expect(keyAfterB64).toBe(serverKeyB64);
    });

    // ──────────────────────────────────────────────────────────────────
    // TEST 8: Does saveKeyBlobToServer() actually work through the
    // debounced path? This is the critical diagnostic test.
    // ──────────────────────────────────────────────────────────────────
    test('8. DIAGNOSTIC: verify saveKeyBlobToServer() saves server keys via debounced path', async ({ page }) => {
        const ts = Date.now();
        const uid = 'blobdiag_' + ts;
        await registerUser(page, uid);
        const token = await page.evaluate(() => localStorage.getItem('token'));

        // Create server (triggers scheduleKeyBlobSave with 3s debounce)
        const { serverId } = await createServerViaApi(page, token, 'DiagServer', uid);

        // Wait for the debounce to fire (3s) + network
        await page.waitForTimeout(6000);

        // Fetch blob and inspect
        const blobRes = await page.request.get(`${BASE}/api/key-blob`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(blobRes.ok()).toBeTruthy();
        const blobData = await blobRes.json();

        const blobContents = await page.evaluate(async ({ encryptedBlob, salt, nonce }) => {
            // 5.6: read the password the way the app does — the vault deleted
            // the at-rest bootstrap blob this used to unwrap.
            const password = (typeof loadDecryptedPassword === 'function') ? loadDecryptedPassword() : null;
            if (!password) return JSON.stringify({ error: 'missing_creds' });
            const bundle = E2ECrypto.decryptKeyBundle(encryptedBlob, password, salt, nonce);
            if (!bundle) return JSON.stringify({ error: 'cannot_decrypt' });
            return JSON.stringify(bundle);
        }, { encryptedBlob: blobData.encrypted_blob, salt: blobData.salt, nonce: blobData.nonce });

        console.log('=== DIAGNOSTIC: Blob after createServer (debounced save) ===');
        console.log(blobContents);
        const parsed = JSON.parse(blobContents);
        const keys = Object.keys(parsed);
        const hasServerKey = keys.some(k => SERVER_KEY_RE.test(k));

        console.log('Server key in blob via debounced path:', hasServerKey ? 'YES' : 'NO');
        console.log('All keys:', keys);

        // This is the KEY assertion: did the debounced saveKeyBlobToServer() 
        // actually save the server key to the blob?
        if (!hasServerKey) {
            console.log('CRITICAL: saveKeyBlobToServer() did NOT save the server key!');
            console.log('The blob only contains what was saved at registration.');
        }
        // We don't assert here — this is a diagnostic test that reports findings
        // The PASS/FAIL tells us whether the saveKeyBlobToServer path works
        expect(hasServerKey).toBe(true);
    });
});
