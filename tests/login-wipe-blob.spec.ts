import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

async function registerUser(page: any, username: string, password = 'password123') {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', password);
    await page.fill('#register-confirm-password', password);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 20000 });
    await page.waitForTimeout(2000);
}

test.describe('Login page wipes ALL client data when not logged in', () => {
    test('stale keys, settings, and IndexedDB audio cache are wiped on login page load', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now().toString().slice(-6);
        await registerUser(page, 'wipe1_' + ts);

        // Create a realistic set of leftover data (identity keys, settings,
        // invite codes, ringtone name, unread markers, theme, volume...).
        await page.evaluate(() => {
            localStorage.setItem('theme_color', '#ff00ff');
            localStorage.setItem('theme_bg_color', '#123456');
            localStorage.setItem('voice_settings', JSON.stringify({ noiseSuppressionMode: 'rnnoise' }));
            localStorage.setItem('ringtone_name', 'stale-ring.wav');
            localStorage.setItem('mention_unread_dms', '{"u1":3}');
            localStorage.setItem('muted_dms', '["dm1"]');
            localStorage.setItem('e2e_invite_server123', 'ABCDEFGH');
            localStorage.setItem('e2e_server_old_key_xyz', 'stale-server-key');
            // Fake an IndexedDB audio cache row (ringtone blob).
            const req = indexedDB.open('e2e_notif_sound', 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
            };
            req.onsuccess = () => {
                const db = req.result;
                const tx = db.transaction('kv', 'readwrite');
                tx.objectStore('kv').put('stale-audio', 'ringtone_url');
            };
        });
        await page.waitForTimeout(500);

        // Simulate session expiry WITHOUT pressing "Clear All Data".
        await page.evaluate(() => {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
        });

        // Arrive at the login page while NOT logged in → everything wiped.
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#login-username', { timeout: 15000 });

        const leftovers = await page.evaluate(async () => {
            const keys: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k) keys.push(k);
            }
            // IndexedDB: check the audio cache DB is gone / empty.
            let idbCount = -1;
            try {
                const dbs = await indexedDB.databases();
                idbCount = dbs.filter(d => d.name === 'e2e_notif_sound').length;
            } catch (_) { idbCount = -1; }
            return { keys, idbCount, sessionKeys: sessionStorage.length };
        });
        expect(leftovers.keys.length).toBe(0);
        expect(leftovers.sessionKeys).toBe(0);
        if (leftovers.idbCount !== -1) {
            expect(leftovers.idbCount).toBe(0);
        }

        // And the account can STILL log in afterwards (wipe didn't break auth).
        await page.fill('#login-username', 'wipe1_' + ts);
        await page.fill('#login-password', 'password123');
        await page.click('#login-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 20000 });
    });
});

test.describe('Key blob includes ALL key types + versioning + recovery', () => {
    test('blob contains auth_key, invite codes, server keys, file keys, friend code; v=2; no "v" leak on restore', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now().toString().slice(-6);
        const username = 'blob2_' + ts;
        await registerUser(page, username);

        const bundleInfo = await page.evaluate(async () => {
            // Simulate all key kinds that should be recoverable.
            localStorage.setItem('e2e_auth_key', 'auth-key-b64');
            localStorage.setItem('e2e_invite_server1', 'INVITE123');
            localStorage.setItem('e2e_identity_private_u1', 'priv');
            localStorage.setItem('e2e_identity_public_u1', 'pub');
            localStorage.setItem('e2e_server_srv1', 'srvkey');
            localStorage.setItem('e2e_server_history_srv1', 'hist');
            localStorage.setItem('e2e_file_key_f1', 'filekey');
            localStorage.setItem('fkc_friend_code_key', 'fkc');
            localStorage.setItem('profile_key_cache', '{}');
            localStorage.setItem('e2e_hmac_key', 'hmac');
            localStorage.setItem('e2e_friend_code', 'FRIEND123');

            const bundle = E2ECrypto.buildKeyBundle();
            const keys = Object.keys(bundle).filter(k => k !== 'v');
            return {
                version: bundle.v,
                keys,
                hasAuthKey: keys.indexOf('e2e_auth_key') !== -1,
                hasInvite: keys.indexOf('e2e_invite_server1') !== -1,
                hasServer: keys.indexOf('e2e_server_srv1') !== -1,
                hasServerHistory: keys.indexOf('e2e_server_history_srv1') !== -1,
                hasFileKey: keys.indexOf('e2e_file_key_f1') !== -1,
                hasFkc: keys.indexOf('fkc_friend_code_key') !== -1,
                hasIdentity: keys.indexOf('e2e_identity_private_u1') !== -1,
                hasProfileCache: keys.indexOf('profile_key_cache') !== -1,
                hasHmac: keys.indexOf('e2e_hmac_key') !== -1,
                hasFriendCode: keys.indexOf('e2e_friend_code') !== -1,
                hasSettings: keys.indexOf('voice_settings') !== -1,
                hasTheme: keys.indexOf('theme_color') !== -1,
            };
        });

        expect(bundleInfo.version).toBe(2);
        expect(bundleInfo.hasAuthKey).toBe(true);
        expect(bundleInfo.hasInvite).toBe(true);
        expect(bundleInfo.hasServer).toBe(true);
        expect(bundleInfo.hasServerHistory).toBe(true);
        expect(bundleInfo.hasFileKey).toBe(true);
        expect(bundleInfo.hasFkc).toBe(true);
        expect(bundleInfo.hasIdentity).toBe(true);
        expect(bundleInfo.hasProfileCache).toBe(true);
        expect(bundleInfo.hasHmac).toBe(true);
        expect(bundleInfo.hasFriendCode).toBe(true);
        // Non-key settings must NOT be in the bundle.
        expect(bundleInfo.hasSettings).toBe(false);
        expect(bundleInfo.hasTheme).toBe(false);

        // restoreKeyBundle must restore keys but NOT write a stray 'v' key.
        const afterRestore = await page.evaluate(() => {
            const bundle = { v: 2, 'e2e_auth_key': 'restored-auth', 'e2e_server_srv1': 'restored-srv' };
            localStorage.clear();
            E2ECrypto.restoreKeyBundle(bundle);
            const keys: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k) keys.push(k);
            }
            return {
                keys,
                hasVLeak: keys.indexOf('v') !== -1,
                auth: localStorage.getItem('e2e_auth_key'),
                srv: localStorage.getItem('e2e_server_srv1'),
            };
        });
        expect(afterRestore.hasVLeak).toBe(false);
        expect(afterRestore.auth).toBe('restored-auth');
        expect(afterRestore.srv).toBe('restored-srv');
    });

    test('full recovery: wipe + login restores identity, server key, auth_key, friend code from blob', async ({ page }) => {
        test.setTimeout(150000);
        const ts = Date.now().toString().slice(-6);
        const username = 'blob3_' + ts;
        const password = 'password123';
        await registerUser(page, username, password);

        // Create a server (persists server keys) + save an auth_key.
        const serverId = await page.evaluate(async (ts: number) => {
            const channelKey = E2ECrypto.generateSymmetricKey();
            const encName = E2ECrypto.aeadEncrypt('BlobSrv_' + ts, channelKey);
            const encChName = E2ECrypto.aeadEncrypt('General', channelKey);
            let hmacKey = localStorage.getItem('e2e_hmac_key');
            if (!hmacKey) {
                hmacKey = E2ECrypto.arrayBufferToBase64(E2ECrypto.randomBytes(32));
                localStorage.setItem('e2e_hmac_key', hmacKey);
            }
            const inviteCode = 'ABCDEFGH';
            const inviteCodeHash = E2ECrypto.hmacHex(hmacKey, inviteCode);
            const token = localStorage.getItem('token');
            const res = await fetch('/api/servers', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'x',
                    invite_code: inviteCode,
                    encrypted_name: encName.ciphertext,
                    name_nonce: encName.nonce,
                    channel_encrypted_name: encChName.ciphertext,
                    channel_name_nonce: encChName.nonce,
                    invite_code: inviteCode,
                }),
            });
            if (!res.ok) return { error: await res.text(), status: res.status };
            const data = await res.json();
            if (!data.id) return { error: 'no id in response', body: JSON.stringify(data).substring(0, 300) };
            console.log('SERVER CREATED', data.id);
            localStorage.setItem('e2e_invite_' + data.id, inviteCode);
            E2ECrypto.saveServerKey(data.id, channelKey);
            localStorage.setItem('e2e_auth_key', 'my-auth-key');
            localStorage.setItem('e2e_friend_code', 'FRIEND' + ts);
            return data.id;
        }, ts);
        console.log('SERVERID', JSON.stringify(serverId));
        expect(serverId).toBeTruthy();

        // Save the blob.
        const saveOk = await page.evaluate(async (pw: string) => {
            const bundle = E2ECrypto.buildKeyBundle();
            const enc = E2ECrypto.encryptKeyBundle(bundle, pw);
            const t = localStorage.getItem('token');
            const res = await fetch('/api/key-blob', {
                method: 'PUT',
                headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    encrypted_blob: enc.encrypted_private_key,
                    salt: enc.salt,
                    nonce: enc.nonce,
                }),
            });
            return res.ok;
        }, password);
        expect(saveOk).toBe(true);

        // Wipe EVERYTHING (the way the login-page wipe would), then log back in.
        await page.evaluate(() => localStorage.clear());
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#login-username', { timeout: 15000 });
        await page.fill('#login-username', username);
        await page.fill('#login-password', password);
        await page.click('#login-form button[type="submit"]');
        try {
            await page.waitForURL('**/index.html', { timeout: 20000 });
        } catch (e) {
            const hasToken = await page.evaluate(() => !!localStorage.getItem('token'));
            if (hasToken) {
                await page.goto(`${BASE}/index.html`);
            } else {
                throw e;
            }
        }
        await page.waitForTimeout(4000);

        // Identity + server key + auth key + friend code all restored.
        const restored = await page.evaluate((sid: string) => {
            const keys: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k) keys.push(k);
            }
            return {
                identity: !!E2ECrypto.getIdentityKeyPair(),
                serverKey: !!E2ECrypto.getServerKey(sid),
                authKey: localStorage.getItem('e2e_auth_key'),
                friendCode: localStorage.getItem('e2e_friend_code'),
                invite: localStorage.getItem('e2e_invite_' + sid),
                allKeys: keys,
                srvKeys: keys.filter(k => k.indexOf('e2e_server') === 0),
                invKeys: keys.filter(k => k.indexOf('e2e_invite') === 0),
            };
        }, serverId);
        console.log('RESTORED', JSON.stringify(restored));
        expect(restored.identity).toBe(true);
        expect(restored.serverKey).toBe(true);
        // auth_key + friend_code are re-derived from the SERVER during login
        // (auth-params / friend-code backup), not taken verbatim from the blob,
        // so they must simply exist.
        expect(restored.authKey).toBeTruthy();
        expect(restored.friendCode).toBeTruthy();
        // invite code comes from the blob (no server re-fetch) -> exact match.
        expect(restored.invite).toBe('ABCDEFGH');
    });

    test('stale blob (old version, missing new keys) is AUTO-REBUILT with the complete key set on login', async ({ page }) => {
        test.setTimeout(150000);
        const ts = Date.now().toString().slice(-6);
        const username = 'blob4_' + ts;
        const password = 'password123';
        await registerUser(page, username, password);

        // Put real keys in localStorage, then REPLACE the server blob with a
        // deliberately stale v1 bundle that lacks the newer key types
        // (e2e_auth_key, e2e_invite_*) — exactly what an old client would
        // have saved before those keys were added to the bundle.
        const stalePutOk = await page.evaluate(async (pw: string) => {
            // Ensure the current build's keys exist so the rebuilt blob can
            // include them (auth_key is set during registration).
            localStorage.setItem('e2e_auth_key', 'my-auth-key');
            localStorage.setItem('e2e_invite_stale1', 'STALEINV');
            // Craft the OLD bundle: v=1 and only the identity key.
            const kp = E2ECrypto.getIdentityKeyPair();
            const oldBundle: any = { v: 1 };
            const suffix = JSON.parse(localStorage.getItem('user') || '{}').id;
            if (suffix && kp) {
                oldBundle['e2e_identity_private_' + suffix] = localStorage.getItem('e2e_identity_private_' + suffix);
                oldBundle['e2e_identity_public_' + suffix] = localStorage.getItem('e2e_identity_public_' + suffix);
            }
            const enc = E2ECrypto.encryptKeyBundle(oldBundle, pw);
            const t = localStorage.getItem('token');
            const res = await fetch('/api/key-blob', {
                method: 'PUT',
                headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    encrypted_blob: enc.encrypted_private_key,
                    salt: enc.salt,
                    nonce: enc.nonce,
                }),
            });
            return res.ok;
        }, password);
        expect(stalePutOk).toBe(true);

        // Verify the server really holds the stale v1 blob right now.
        const staleCheck = await page.evaluate(async (pw: string) => {
            const t = localStorage.getItem('token');
            const res = await fetch('/api/key-blob', { headers: { Authorization: `Bearer ${t}` } });
            const data = await res.json();
            const bundle = E2ECrypto.decryptKeyBundle(data.encrypted_blob, pw, data.salt, data.nonce);
            return { ok: !!bundle, version: bundle ? bundle.v : -1, hasAuthKey: bundle ? !!bundle['e2e_auth_key'] : false };
        }, password);
        expect(staleCheck.ok).toBe(true);
        expect(staleCheck.version).toBe(1);
        expect(staleCheck.hasAuthKey).toBe(false);

        // Wipe everything, then log back in. The login flow restores the stale
        // blob, detects the older bundle version, and the unconditional re-save
        // at the end of login rebuilds it with the COMPLETE key set (v2 +
        // e2e_auth_key + e2e_invite_* + everything else currently present).
        await page.evaluate(() => localStorage.clear());
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#login-username', { timeout: 15000 });
        await page.fill('#login-username', username);
        await page.fill('#login-password', password);
        await page.click('#login-form button[type="submit"]');
        try {
            await page.waitForURL('**/index.html', { timeout: 20000 });
        } catch (e) {
            const hasToken = await page.evaluate(() => !!localStorage.getItem('token'));
            if (hasToken) {
                await page.goto(`${BASE}/index.html`);
            } else {
                throw e;
            }
        }
        // Wait for the blob re-save (debounced in the login handler) to land.
        await page.waitForTimeout(5000);

        // Fetch + decrypt the NEW blob: the stale v1 blob must be rebuilt to
        // v2 WITH the newer key types it lacked (e2e_auth_key), plus everything
        // else that's recoverable (identity, profile cache — re-derived or
        // restored during login). e2e_invite_stale1 was never persisted
        // server-side, so it is correctly NOT expected back after the wipe.
        const rebuilt = await page.evaluate(async (pw: string) => {
            const t = localStorage.getItem('token');
            const res = await fetch('/api/key-blob', { headers: { Authorization: `Bearer ${t}` } });
            const data = await res.json();
            const bundle = E2ECrypto.decryptKeyBundle(data.encrypted_blob, pw, data.salt, data.nonce);
            if (!bundle) return { ok: false, err: 'decrypt failed' };
            const keys = Object.keys(bundle);
            return {
                ok: true,
                version: bundle.v,
                hasAuthKey: keys.indexOf('e2e_auth_key') !== -1,
                hasIdentity: keys.some(k => k.indexOf('e2e_identity_private_') === 0),
                hasProfileCache: keys.indexOf('profile_key_cache') !== -1,
            };
        }, password);
        expect(rebuilt.ok).toBe(true);
        // The auto-update: version bumped from 1 -> 2 and the newer key type
        // (e2e_auth_key) that the stale blob was missing is now in the bundle.
        expect(rebuilt.version).toBe(2);
        expect(rebuilt.hasAuthKey).toBe(true);
        expect(rebuilt.hasIdentity).toBe(true);
        expect(rebuilt.hasProfileCache).toBe(true);
    });
});
