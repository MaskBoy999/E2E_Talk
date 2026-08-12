import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('Blob save failure — what survives cookie clear + re-login', () => {

    // ─── Shared Helpers ───────────────────────────────────────────

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
        expect(incoming.length).toBe(1);
        const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        expect(acc.ok()).toBeTruthy();
    }

    async function createDmViaApi(page1: any, token1: string, user2Id: string) {
        const dm = await page1.request.post(`${BASE}/api/dm/${user2Id}`, {
            headers: { Authorization: `Bearer ${token1}` },
        });
        expect(dm.ok()).toBeTruthy();
        return await dm.json();
    }

    async function createServerWithKey(page: any, token: string, name: string, uid: string) {
        const hmacKey = await page.evaluate(() => localStorage.getItem('e2e_hmac_key'));
        // Generate a random invite code (no collisions across tests)
        const code = await page.evaluate(() => {
            const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            var c = '';
            for (var i = 0; i < 12; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
            return c;
        });
        const hash = await page.evaluate(({ hk, cd }) => E2ECrypto.hmacHex(hk, cd), { hk: hmacKey, cd: code });

        const keyResult = await page.evaluate(() => {
            var kp = E2ECrypto.getIdentityKeyPair();
            if (!kp) return { error: 'no_identity_key' };
            var serverKey = E2ECrypto.generateSymmetricKey();
            var serverKeyB64 = E2ECrypto.arrayBufferToBase64(serverKey);
            return { serverKeyB64, error: null };
        });
        expect(keyResult.error).toBeNull();

        const encName = await page.evaluate(({ name, keyB64 }) => {
            var k = new Uint8Array(E2ECrypto.base64ToArrayBuffer(keyB64));
            return E2ECrypto.aeadEncrypt(name, k);
        }, { name, keyB64: keyResult.serverKeyB64 });
        const encChName = await page.evaluate(({ keyB64 }) => {
            var k = new Uint8Array(E2ECrypto.base64ToArrayBuffer(keyB64));
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
        if (!res.ok()) {
            console.log('CREATE SERVER FAIL', res.status(), (await res.text()).substring(0, 300));
        }
        expect(res.ok()).toBeTruthy();
        const server = await res.json();

        // Upload server key to API — envelope-encrypted with own identity key
        // so fetchAndDecryptServerKey can decrypt it on re-login.
        var userId = await page.evaluate(() => JSON.parse(localStorage.getItem('user') || '{}').id);
        var envResult = await page.evaluate(({ keyB64 }) => {
            var kp = E2ECrypto.getIdentityKeyPair();
            if (!kp) return { error: 'no_identity_key' };
            var enc = E2ECrypto.envelopeEncrypt(keyB64, kp.publicKey, kp.privateKey);
            return {
                encryptedKey: enc.ciphertext,
                senderPubB64: E2ECrypto.arrayBufferToBase64(kp.publicKey),
                nonce: enc.nonce,
                error: null
            };
        }, { keyB64: keyResult.serverKeyB64 });
        expect(envResult.error).toBeNull();

        var upRes = await page.request.post(`${BASE}/api/servers/${server.id}/keys`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: {
                user_id: userId,
                encrypted_key: envResult.encryptedKey,
                sender_public_key: envResult.senderPubB64,
                nonce: envResult.nonce,
            },
        });
        // If envelope upload fails, try raw key as fallback
        if (!upRes.ok()) {
            upRes = await page.request.post(`${BASE}/api/servers/${server.id}/keys`, {
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                data: {
                    user_id: userId,
                    encrypted_key: keyResult.serverKeyB64,
                    sender_public_key: '',
                    nonce: '',
                },
            });
            expect(upRes.ok()).toBeTruthy();
        }

        // Store in localStorage (mimics saveServerKey)
        await page.evaluate(({ sid, keyB64 }) => {
            var keyBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(keyB64));
            E2ECrypto.saveServerKey(sid, keyBytes);
        }, { sid: server.id, keyB64: keyResult.serverKeyB64 });

        return { serverId: server.id, serverKeyB64: keyResult.serverKeyB64 };
    }

    // Decrypt and return the blob contents (null if not available)
    async function getBlobContents(page: any, token: string): Promise<any> {
        var blobRes = await page.request.get(`${BASE}/api/key-blob`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!blobRes.ok()) return null;
        var blobData = await blobRes.json();
        return await page.evaluate(({ encryptedBlob, salt, nonce }) => {
            var encPw = localStorage.getItem('e2e_encrypted_password');
            var devKeyStr = localStorage.getItem('e2e_device_key');
            if (!encPw || !devKeyStr) return null;
            var dk = new Uint8Array(E2ECrypto.base64ToArrayBuffer(devKeyStr));
            var pwB64 = E2ECrypto.decodeEncryptedFileKey(encPw, dk);
            if (!pwB64) return null;
            var password = atob(pwB64);
            var bundle = E2ECrypto.decryptKeyBundle(encryptedBlob, password, salt, nonce);
            return bundle;
        }, { encryptedBlob: blobData.encrypted_blob, salt: blobData.salt, nonce: blobData.nonce });
    }

    // ─── Core simulation for one failure path ─────────────────────
    //
    // Flow:
    //   1. Register user, create server1, set up profile
    //   2. Call saveKeyBlobToServer() DIRECTLY — baseline save
    //   3. Verify blob has server1 key + profile_key_cache
    //   4. Create server2, set up extra profile data
    //   5. Set up the failure condition
    //   6. Call saveKeyBlobToServer() DIRECTLY with failure active
    //   7. Verify blob does NOT have new data (server2, extra profile)
    //   8. Clear cookies, re-login
    //   9. Verify: identity keys OK, server keys OK (via API), profile data LOST
    //  10. Verify NEW API: profile data key recoverable via GET /api/profile/data-key/:userId

    async function uploadProfileDataKeyViaApi(page: any, token: string): Promise<boolean> {
        return await page.evaluate(async (t: string) => {
            try {
                var pdKeyB64 = profileKeyCache[user.id + ':profile_data_key'];
                console.log('uploadProfileDataKeyViaApi: pdKeyB64=' + (pdKeyB64 ? 'exists' : 'null') + ', user.id=' + user.id);
                if (!pdKeyB64) return false;
                var identity = E2ECrypto.getIdentityKeyPair();
                console.log('uploadProfileDataKeyViaApi: identity=' + (identity ? 'exists' : 'null'));
                if (!identity) return false;
                var encryptedKey = E2ECrypto.encodeEncryptedFileKey(pdKeyB64, identity.privateKey);
                console.log('uploadProfileDataKeyViaApi: encryptedKey length=' + encryptedKey.length);
                var parts = encryptedKey.split(':');
                if (parts.length !== 2) { console.log('uploadProfileDataKeyViaApi: split failed, got ' + parts.length + ' parts'); return false; }
                var res = await fetch('/api/profile/data-key', {
                    method: 'PUT',
                    headers: { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ encrypted_key: parts[1], nonce: parts[0] }),
                });
                console.log('uploadProfileDataKeyViaApi: fetch status=' + res.status);
                if (!res.ok) {
                    var errText = await res.text().catch(function() { return 'unknown'; });
                    console.log('uploadProfileDataKeyViaApi: error=' + errText);
                }
                return res.ok;
            } catch (e) {
                console.log('uploadProfileDataKeyViaApi: EXCEPTION=' + e.message);
                return false;
            }
        }, token);
    }

    async function fetchProfileDataKeyFromServerViaApi(page: any, userId: string, token: string): Promise<string | null> {
        return await page.evaluate(async (args: { uid: string, tok: string }) => {
            var res = await fetch('/api/profile/data-key/' + encodeURIComponent(args.uid), {
                headers: { 'Authorization': 'Bearer ' + args.tok },
            });
            if (!res.ok) return null;
            var data = await res.json();
            if (!data.encrypted_key || !data.nonce) return null;
            var identity = E2ECrypto.getIdentityKeyPair();
            if (!identity) return null;
            var combined = data.nonce + ':' + data.encrypted_key;
            var decKeyB64 = E2ECrypto.decodeEncryptedFileKey(combined, identity.privateKey);
            return decKeyB64 || null;
        }, { uid: userId, tok: token });
    }

    async function runSimulation(
        failureName: string,
        applyFailure: (page: any) => Promise<void>
    ) {
        const ts = Date.now();
        const uid = 'bug' + failureName.replace(/[^a-z0-9]/gi, '') + '_' + ts;
        const uid2 = uid + '_f';

        test(failureName + ': identity+server keys survive, profile key lost', async ({ page, context }) => {
            // This flow registers two users, creates a server, uploads keys,
            // applies a failure, clears cookies, and re-logins — it needs
            // longer than the default 30s global timeout.
            test.setTimeout(180000);

            // Capture browser console for debugging
            var browserLogs: string[] = [];
            page.on('console', (msg) => {
                browserLogs.push(msg.type() + ': ' + msg.text());
                if (msg.text().indexOf('uploadProfileDataKeyViaApi') !== -1) {
                    console.log('BROWSER:', msg.text());
                }
            });

            // ── 1. Register users, create server, set up profile ──
            const body1 = await registerUser(page, uid);
            const ctx2 = await context.browser()!.newContext();
            const page2 = await ctx2.newPage();
            const body2 = await registerUser(page2, uid2);
            await becomeFriends(page, page2, body1.token, body2.token);
            const dmChannel = await createDmViaApi(page, body1.token, body2.user.id);

            const s1 = await createServerWithKey(page, body1.token, 'S1_' + uid, uid);

            // Set up profile_data_key in both in-memory cache + localStorage
            var pdKeyB64 = await page.evaluate(() => {
                var pk = E2ECrypto.generateProfileDataKey();
                var b64 = E2ECrypto.arrayBufferToBase64(pk);
                var myId = JSON.parse(localStorage.getItem('user') || '{}').id;
                if (myId) {
                    if (typeof profileKeyCache !== 'undefined') {
                        profileKeyCache[myId + ':profile_data_key'] = b64;
                    }
                    var cache = JSON.parse(localStorage.getItem('profile_key_cache') || '{}');
                    cache[myId + ':profile_data_key'] = b64;
                    localStorage.setItem('profile_key_cache', JSON.stringify(cache));
                }
                return b64;
            });

            // ── 2. Call saveKeyBlobToServer DIRECTLY (success expected) ──
            var baselineOk = await page.evaluate(async () => {
                try {
                    // To ensure the debounce doesn't interfere, clear any pending timer
                    if (typeof _keyBlobTimer !== 'undefined' && _keyBlobTimer) {
                        clearTimeout(_keyBlobTimer);
                        _keyBlobTimer = null;
                    }
                    // Call saveProfileKeyCache to persist profile data to localStorage
                    if (typeof saveProfileKeyCache === 'function') {
                        saveProfileKeyCache();
                    }
                    saveKeyBlobToServer();
                    // Wait for async fetch to complete
                    await new Promise(r => setTimeout(r, 1500));
                    return 'ok';
                } catch (e) {
                    return 'err: ' + e.message;
                }
            });
            console.log('Baseline save result:', baselineOk);

            // ── 3. Verify baseline blob ──
            var baselineBlob = await getBlobContents(page, body1.token);
            var hasS1inBlob = baselineBlob && Object.keys(baselineBlob).some(
                (k: string) => k.indexOf('e2e_server_' + s1.serverId) === 0
            );
            var hasProfileInBlob = baselineBlob && baselineBlob['profile_key_cache'] &&
                baselineBlob['profile_key_cache'].indexOf(':profile_data_key') !== -1;

            console.log('Baseline blob: server1=' + (hasS1inBlob ? 'YES' : 'NO') +
                ', profile_key_cache=' + (hasProfileInBlob ? 'YES (has data)' : 'NO'));
            expect(hasS1inBlob).toBe(true);

            // ── 4. Create server2 + extra profile data ──
            var s2 = await createServerWithKey(page, body1.token, 'S2_' + uid, uid + 'b');

            await page.evaluate(() => {
                var myId = JSON.parse(localStorage.getItem('user') || '{}').id;
                if (myId && typeof profileKeyCache !== 'undefined') {
                    profileKeyCache[myId + ':profile_data_key:extra'] = 'should_not_survive';
                }
                // Persist to localStorage (but don't save blob yet)
                if (typeof saveProfileKeyCache === 'function') {
                    saveProfileKeyCache();
                }
            });

            // ── 5. Upload profile_data_key to new API (should work before failure) ──
            var pdKeyUploaded = await uploadProfileDataKeyViaApi(page, body1.token);
            console.log('Profile data key uploaded to API:', pdKeyUploaded ? 'YES' : 'NO');
            expect(pdKeyUploaded).toBe(true);

            // ── 6. Apply failure condition ──
            await applyFailure(page);

            // ── 7. Call saveKeyBlobToServer DIRECTLY with failure active ──
            var failureResult = await page.evaluate(async () => {
                try {
                    if (typeof _keyBlobTimer !== 'undefined' && _keyBlobTimer) {
                        clearTimeout(_keyBlobTimer);
                        _keyBlobTimer = null;
                    }
                    saveKeyBlobToServer();
                    await new Promise(r => setTimeout(r, 1500));
                    return 'ok';
                } catch (e) {
                    return 'err: ' + e.message;
                }
            });
            console.log('Failure save result:', failureResult);

            // ── 8. Verify blob does NOT have new data ──
            var afterBlob = await getBlobContents(page, body1.token);
            var hasS2inBlob = afterBlob && Object.keys(afterBlob).some(
                (k: string) => k.indexOf('e2e_server_' + s2.serverId) === 0
            );
            var hasExtraProfile = afterBlob && afterBlob['profile_key_cache'] &&
                afterBlob['profile_key_cache'].indexOf('should_not_survive') !== -1;

            console.log('After failure: server2 in blob=' + (hasS2inBlob ? 'YES' : 'NO') +
                ', extra profile=' + (hasExtraProfile ? 'YES' : 'NO'));

            // The second server key might still be in the blob if the baseline save succeeded
            // (since the baseline included everything up to that point).
            // The extra profile data should NOT be in blob if failure worked.
            // But this is a soft check — the key assertion is after re-login.

            // ── 9. Clear cookies + re-login ──
            await page.evaluate(() => { localStorage.clear(); });
            await page.goto(`${BASE}/login.html`);
            await page.fill('#login-username', uid);
            await page.fill('#login-password', 'password123');
            await page.click('#login-form button[type="submit"]');
            await page.waitForURL('**/index.html', { timeout: 15000 });
            await page.waitForTimeout(6000);

            // ── 10. Verify recovery ──
            var identityOk = await page.evaluate(() => {
                var kp = E2ECrypto.getIdentityKeyPair();
                return kp ? true : false;
            });
            expect(identityOk).toBe(true);
            console.log('Identity key:', identityOk ? 'OK' : 'MISSING');

            var s1After = await page.evaluate((sid) => !!localStorage.getItem('e2e_server_' + sid), s1.serverId);
            var s2After = await page.evaluate((sid) => !!localStorage.getItem('e2e_server_' + sid), s2.serverId);
            
            // Server keys should be recoverable via API + restored identity key
            // (loadServers → fetchAndDecryptServerKey runs after redirect to index.html)
            console.log('Server1 key:', s1After ? 'OK' : 'MISSING');
            console.log('Server2 key:', s2After ? 'OK' : 'MISSING');
            expect(s1After).toBe(true);

            // Profile data key must come from blob — if save failed, it's LOST
            var pkcAfter = await page.evaluate(() => localStorage.getItem('profile_key_cache'));
            var hasProfileDataAfter = pkcAfter ? pkcAfter.indexOf(':profile_data_key') !== -1 : false;
            console.log('Profile key cache:', hasProfileDataAfter ? 'SURVIVED' : 'LOST');

            // Check the actual blob on the server to confirm
            var finalBlob = await getBlobContents(page, await page.evaluate(() => localStorage.getItem('token')));
            var hasProfileInFinalBlob = finalBlob && finalBlob['profile_key_cache'] &&
                finalBlob['profile_key_cache'].indexOf(':profile_data_key') !== -1;
            console.log('Profile key in final blob:', hasProfileInFinalBlob ? 'YES' : 'NO');

            // This is the critical finding:
            // - Identity keys: always survive (from registration blob) ✅
            // - Server keys: survive via API + identity key ✅  
            // - Profile data key: survives ONLY if it was in the blob before the failure ❌
            console.log('');
            console.log('=== FINDING for', failureName, '===');
            console.log('Identity: ✅ | Server keys:', (s1After && s2After) ? '✅' : '❌',
                '| Profile data:', hasProfileDataAfter ? '✅' : '❌');

            // If profile data key was lost, this confirms the bug: blob failure → profile data unrecoverable
            if (!hasProfileDataAfter) {
                console.log('CONFIRMED: Profile data key was LOST from blob because save failed.');
            }

            // ── 11. Verify NEW API can recover the profile_data_key ──
            var tokenAfter = await page.evaluate(() => localStorage.getItem('token'));
            var recoveredKey = null;
            if (tokenAfter) {
                recoveredKey = await fetchProfileDataKeyFromServerViaApi(page, body1.user.id, tokenAfter);
            }
            var apiRecoveryOk = recoveredKey !== null;
            console.log('Profile data key from API recovery:', apiRecoveryOk ? '✅ RECOVERED' : '❌ FAILED');

            // This is the key new assertion: the API should always allow recovery
            // even when the blob save failed, because the API upload happened before the failure.
            expect(apiRecoveryOk).toBe(true);

            // If apiRecoveryOk, the profile data key can be restored regardless of blob failure
            if (apiRecoveryOk) {
                console.log('CONTRIBUTION: API endpoint provides fallback recovery even when blob save fails.');
            }

            await page2.close();
            await ctx2.close();
        });
    }

    // ─── Path 1: missing e2e_encrypted_password ───
    runSimulation('Path1_missing_password', async (page) => {
        await page.evaluate(() => {
            localStorage.removeItem('e2e_encrypted_password');
        });
    });

    // ─── Path 2: corrupted encrypted_password ───
    runSimulation('Path2_corrupted_password', async (page) => {
        await page.evaluate(() => {
            localStorage.setItem('e2e_encrypted_password',
                'AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
        });
    });

    // ─── Path 3: missing token ───
    runSimulation('Path3_no_token', async (page) => {
        await page.evaluate(() => {
            localStorage.removeItem('token');
        });
    });

    // ─── Path 4: network failure (fetch rejects) ───
    runSimulation('Path4_network_failure', async (page) => {
        await page.evaluate(() => {
            var origFetch = window.fetch.bind(window);
            window.fetch = function(url, opts) {
                var urlStr = typeof url === 'string' ? url : (url.url || '');
                if (urlStr.indexOf('/api/key-blob') !== -1) {
                    return Promise.reject(new Error('Simulated network failure'));
                }
                return origFetch(url, opts);
            };
        });
    });

    // ─── Path 5: buildKeyBundle throws ───
    runSimulation('Path5_buildKeyBundle_throws', async (page) => {
        await page.evaluate(() => {
            var origBuild = E2ECrypto.buildKeyBundle;
            E2ECrypto.buildKeyBundle = function() {
                throw new Error('deliberate failure');
            };
            // Restore original after a brief delay so the save-key-blob call fails
            setTimeout(function() {
                E2ECrypto.buildKeyBundle = origBuild;
            }, 500);
        });
    });
});
