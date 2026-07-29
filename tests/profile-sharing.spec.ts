import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('Profile Sharing', () => {

    test.setTimeout(120000);

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
        }));
    }

    async function becomeFriendsViaApi(page1: any, page2: any, token1: string, token2: string) {
        const code2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        expect(code2).toBeTruthy();
        const fr = await page1.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
            data: { friend_code: code2 },
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

    async function saveProfileViaEvaluate(page: any, displayName: string) {
        const result = await page.evaluate(async (dn: string) => {
            const E2E = (window as any).E2ECrypto;
            const identity = E2E.getIdentityKeyPair();
            if (!identity) return { error: 'no_identity' };
            const profileData = {
                display_name: dn, nickname: '', description: 'Desc ' + dn,
                username_color: '#ff6600', username_border_color: '#ff0000',
                profile_background_color: '#1a1a2e', friend_requests_disabled: false,
                theme_color: '#4fc3f7', theme_bg_color: '#4fc3f7', theme_mode: 'dark',
                profile_picture_file_id: null, profile_banner_file_id: null,
                profile_picture_file_key: null, profile_banner_file_key: null,
            };
            const pdk = E2E.generateProfileDataKey();
            const pj = JSON.stringify(profileData);
            const enc = E2E.encryptProfileData(pj, pdk);
            const pdkB64 = E2E.arrayBufferToBase64(pdk);
            const epdk = E2E.encodeEncryptedFileKey(pdkB64, identity.privateKey);
            if (typeof uploadConversationProfiles === 'function') {
                await uploadConversationProfiles(identity, pj);
            } else {
                console.log('DEBUG save: uploadConversationProfiles not available');
            }
            const res = await fetch('/api/profile', {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    encrypted_profile_data: enc.nonce + ':' + enc.ciphertext,
                    encrypted_profile_data_key: epdk,
                }),
            });
            if (!res.ok) return { error: 'api_fail:' + (await res.text()) };
            return { ok: true };
        }, displayName);
        expect(result.error).toBeUndefined();
        expect(result.ok).toBe(true);
        return result;
    }

    async function loadDms(page: any) {
        const result = await page.evaluate(async () => {
            if (typeof loadDmConversations !== 'function') return 'no_func';
            try {
                const directRes = await fetch('/api/dm/conversations', {
                    headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') },
                });
                const directData = await directRes.json();
                const directLen = Array.isArray(directData) ? directData.length : -1;
                const dmsBefore = (typeof dmConversations !== 'undefined' && dmConversations) ? dmConversations.length : -2;
                await loadDmConversations();
                const after = (typeof dmConversations !== 'undefined' && dmConversations) ? dmConversations.length : -3;
                return 'ok direct=' + directLen + ' before=' + dmsBefore + ' after=' + after;
            } catch (e: any) {
                return 'err:' + e.message;
            }
        });
        console.log('loadDms result:', result);
        await page.waitForTimeout(1000);
    }

    async function waitForCache(page: any, userId: string, expectedName: string, timeout = 30000) {
        await page.waitForFunction(({ uid, dn }: any) => {
            const c = (window as any).userDisplayNameCache;
            return c && c[uid] && c[uid].display_name === dn;
        }, { uid: userId, dn: expectedName }, { timeout });
    }

    async function createDmChannel(page: any, token: string, otherUserId: string) {
        const res = await page.request.post(`${BASE}/api/dm/${otherUserId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.ok()).toBeTruthy();
        return await res.json();
    }

    async function createServer(page: any, token: string, uid: string) {
        const crypto = await page.evaluate(async () => {
            const E2E = (window as any).E2ECrypto;
            const kp = E2E.getIdentityKeyPair();
            if (!kp) return { error: 'no_kp' };
            const sk = E2E.generateSymmetricKey();
            const skB64 = E2E.arrayBufferToBase64(sk);
            const enc = E2E.envelopeEncrypt(skB64, kp.publicKey, kp.privateKey);
            const encName = E2E.aeadEncrypt('TestServer', sk);
            const encCh = E2E.aeadEncrypt('general', sk);
            return {
                serverKeyB64: skB64, encryptedKey: enc.ciphertext, keyNonce: enc.nonce,
                senderPub: E2E.arrayBufferToBase64(kp.publicKey),
                encName: encName.ciphertext, nameNonce: encName.nonce,
                encCh: encCh.ciphertext, chNonce: encCh.nonce,
            };
        });
        expect(crypto.error).toBeUndefined();
        const code = 'SRV' + uid.slice(-8).toUpperCase();
        const res = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { invite_code: code, encrypted_name: crypto.encName, name_nonce: crypto.nameNonce,
                channel_encrypted_name: crypto.encCh, channel_name_nonce: crypto.chNonce },
        });
        expect(res.ok()).toBeTruthy();
        const srv = await res.json();
        await page.request.post(`${BASE}/api/servers/${srv.id}/keys`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { user_id: uid, encrypted_key: crypto.encryptedKey, sender_public_key: crypto.senderPub, nonce: crypto.keyNonce },
        });
        await page.evaluate(({ sid, skB64 }: any) => {
            const key = new Uint8Array((window as any).E2ECrypto.base64ToArrayBuffer(skB64));
            (window as any).E2ECrypto.saveServerKey(sid, key);
        }, { sid: srv.id, skB64: crypto.serverKeyB64 });
        return { serverId: srv.id, inviteCode: code };
    }

    /** Reload DMs + servers in-page without navigating */
    async function reloadConversations(page: any) {
        await page.evaluate(async () => {
            if (typeof (window as any).loadDmConversations === 'function') {
                await (window as any).loadDmConversations();
            }
            if (typeof (window as any).loadServers === 'function') {
                await (window as any).loadServers();
            }
        });
        await page.waitForTimeout(1500);
    }

    /** Simulate a page refresh by clearing in-memory caches and re-fetching */
    async function simulateRefresh(page: any) {
        await page.evaluate(() => {
            (window as any).userDisplayNameCache = {};
            (window as any).profilePicCache = {};
            (window as any).profileKeyCache = {};
            (window as any).profileUpdatedAt = {};
        });
        await reloadConversations(page);
    }

    // ═══════════════════════════════════════════════════
    // FRIEND CONNECTION TESTS
    // ═══════════════════════════════════════════════════

    test('FC1: immediate profile visible after friend+save (both users)', async ({ page, context }) => {
        const ts = Date.now();
        const u1 = 'fc1a_' + ts, u2 = 'fc1b_' + ts;
        const dn1 = 'Alice_' + ts, dn2 = 'Bob_' + ts;

        const b1 = await registerUser(page, u1);
        const ctx2 = await context.browser()!.newContext();
        const p2 = await ctx2.newPage();
        const b2 = await registerUser(p2, u2);

        await becomeFriendsViaApi(page, p2, b1.token, b2.token);

        // Load DMs in-page
        await loadDms(page);
        await loadDms(p2);

        // Both save profiles
        await saveProfileViaEvaluate(page, dn1);
        await saveProfileViaEvaluate(p2, dn2);

        // Wait for WS broadcast + fallback fetch to populate cache
        await waitForCache(page, b2.user.id, dn2);
        await waitForCache(p2, b1.user.id, dn1);

        await p2.close();
        await ctx2.close();
    });

    test('FC2: live profile update propagates without refresh', async ({ page, context }) => {
        const ts = Date.now();
        const u1 = 'fc2a_' + ts, u2 = 'fc2b_' + ts;
        const dn1 = 'Carol_' + ts, dn1b = 'CarolX_' + ts;
        const dn2 = 'Dave_' + ts;

        const b1 = await registerUser(page, u1);
        const ctx2 = await context.browser()!.newContext();
        const p2 = await ctx2.newPage();
        const b2 = await registerUser(p2, u2);

        await becomeFriendsViaApi(page, p2, b1.token, b2.token);
        await loadDms(page);
        await loadDms(p2);

        await saveProfileViaEvaluate(page, dn1);
        await saveProfileViaEvaluate(p2, dn2);
        await waitForCache(page, b2.user.id, dn2);
        await waitForCache(p2, b1.user.id, dn1);

        // Change User A's display name live
        await saveProfileViaEvaluate(page, dn1b);

        // User B should see the new name without refresh (via profile_updated WS)
        await waitForCache(p2, b1.user.id, dn1b);
        const check = await p2.evaluate((uid: string) => {
            const e = (window as any).userDisplayNameCache[uid];
            return e ? e.display_name : null;
        }, b1.user.id);
        expect(check).toBe(dn1b);

        await p2.close();
        await ctx2.close();
    });

    test('FC3: profile survives in-memory cache reset (simulated refresh)', async ({ page, context }) => {
        const ts = Date.now();
        const u1 = 'fc3a_' + ts, u2 = 'fc3b_' + ts;
        const dn1 = 'Eve_' + ts, dn2 = 'Frank_' + ts;

        const b1 = await registerUser(page, u1);
        const ctx2 = await context.browser()!.newContext();
        const p2 = await ctx2.newPage();
        const b2 = await registerUser(p2, u2);

        await becomeFriendsViaApi(page, p2, b1.token, b2.token);
        await loadDms(page);
        await loadDms(p2);

        await saveProfileViaEvaluate(page, dn1);
        await saveProfileViaEvaluate(p2, dn2);
        await waitForCache(page, b2.user.id, dn2);
        await waitForCache(p2, b1.user.id, dn1);

        // Simulate page refresh: clear in-memory caches and re-fetch from server
        await simulateRefresh(page);
        await waitForCache(page, b2.user.id, dn2);

        await simulateRefresh(p2);
        await waitForCache(p2, b1.user.id, dn1);

        await p2.close();
        await ctx2.close();
    });

    test('FC4: DM profile cache persists after conversation reload', async ({ page, context }) => {
        const ts = Date.now();
        const u1 = 'fc4a_' + ts, u2 = 'fc4b_' + ts;
        const dn1 = 'Grace_' + ts, dn2 = 'Heidi_' + ts;

        const b1 = await registerUser(page, u1);
        const ctx2 = await context.browser()!.newContext();
        const p2 = await ctx2.newPage();
        const b2 = await registerUser(p2, u2);

        await becomeFriendsViaApi(page, p2, b1.token, b2.token);
        await loadDms(page);
        await loadDms(p2);

        await saveProfileViaEvaluate(page, dn1);
        await saveProfileViaEvaluate(p2, dn2);
        await waitForCache(page, b2.user.id, dn2);
        await waitForCache(p2, b1.user.id, dn1);

        // Simulate refresh and verify cache is re-populated from DM conversations
        await simulateRefresh(p2);
        await loadDms(p2);
        await waitForCache(p2, b1.user.id, dn1);

        // Simulate refresh on page too
        await simulateRefresh(page);
        await loadDms(page);
        await waitForCache(page, b2.user.id, dn2);

        await p2.close();
        await ctx2.close();
    });

    test('FC5: profile survives simulated cookie clear + re-fetch', async ({ page, context }) => {
        const ts = Date.now();
        const u1 = 'fc5a_' + ts, u2 = 'fc5b_' + ts;
        const dn2 = 'Judy_' + ts;

        const b1 = await registerUser(page, u1);
        const ctx2 = await context.browser()!.newContext();
        const p2 = await ctx2.newPage();
        const b2 = await registerUser(p2, u2);

        await becomeFriendsViaApi(page, p2, b1.token, b2.token);
        await loadDms(page);
        await loadDms(p2);

        await saveProfileViaEvaluate(p2, dn2);
        await waitForCache(page, b2.user.id, dn2);

        // Simulate cookie clear (preserve identity keys + token)
        await page.evaluate(() => {
            const preserve = ['e2e_identity_private_', 'e2e_identity_public_', 'e2e_hmac_key', 'e2e_friend_code',
                'e2e_server_', 'e2e_encrypted_password', 'e2e_device_key', 'e2e_auth_key'];
            const saved: Record<string, string> = {};
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && preserve.some(p => k.indexOf(p) === 0)) saved[k] = localStorage.getItem(k)!;
            }
            const userStr = localStorage.getItem('user');
            if (userStr) saved._user = userStr;
            saved._token = localStorage.getItem('token') || '';
            localStorage.clear();
            for (const k in saved) {
                if (k.startsWith('_')) {
                    if (k === '_token') localStorage.setItem('token', saved[k]);
                    if (k === '_user') localStorage.setItem('user', saved[k]);
                } else {
                    localStorage.setItem(k, saved[k]);
                }
            }
        });

        // Re-fetch caches in-page (no page reload needed)
        await simulateRefresh(page);
        await waitForCache(page, b2.user.id, dn2);

        const check = await page.evaluate((uid: string) => {
            const e = (window as any).userDisplayNameCache[uid];
            return e ? e.display_name : null;
        }, b2.user.id);
        expect(check).toBe(dn2);

        await p2.close();
        await ctx2.close();
    });

    // ═══════════════════════════════════════════════════
    // SERVER TESTS
    // ═══════════════════════════════════════════════════

    test('SV1: immediate profile visible after server join (both users)', async ({ page, context }) => {
        const ts = Date.now();
        const u1 = 'sv1a_' + ts, u2 = 'sv1b_' + ts;
        const dn1 = 'Mallory_' + ts, dn2 = 'Niaj_' + ts;

        const b1 = await registerUser(page, u1);
        const ctx2 = await context.browser()!.newContext();
        const p2 = await ctx2.newPage();
        const b2 = await registerUser(p2, u2);

        // User A creates server
        const srv = await createServer(page, b1.token, b1.user.id);
        // Reload servers in-page so servers[] is populated
        await page.evaluate(async () => { if (typeof (window as any).loadServers === 'function') await (window as any).loadServers(); });
        await page.waitForTimeout(1500);

        // User B joins server
        console.log('SV1: trying to join with code=' + srv.inviteCode);
        const joinRes = await p2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${b2.token}`, 'Content-Type': 'application/json' },
            data: { code: srv.inviteCode },
        });
        console.log('SV1 join status:', joinRes.status(), joinRes.statusText());
        if (!joinRes.ok()) {
            const body = await joinRes.text();
            console.log('SV1 join failed body:', body);
        }
        expect(joinRes.ok()).toBeTruthy();
        await p2.evaluate(async () => { if (typeof (window as any).loadServers === 'function') await (window as any).loadServers(); });
        await p2.waitForTimeout(1500);

        // Both save profiles
        await saveProfileViaEvaluate(page, dn1);
        await saveProfileViaEvaluate(p2, dn2);

        // Wait for WS profile_updated + conversation profile fetch
        await waitForCache(page, b2.user.id, dn2);
        await waitForCache(p2, b1.user.id, dn1);

        await p2.close();
        await ctx2.close();
    });

    test('SV2: server profile survives cache reset (simulated refresh)', async ({ page, context }) => {
        const ts = Date.now();
        const u1 = 'sv2a_' + ts, u2 = 'sv2b_' + ts;
        const dn1 = 'Olivia_' + ts, dn2 = 'Peggy_' + ts;

        const b1 = await registerUser(page, u1);
        const ctx2 = await context.browser()!.newContext();
        const p2 = await ctx2.newPage();
        const b2 = await registerUser(p2, u2);

        const srv = await createServer(page, b1.token, b1.user.id);
        await page.evaluate(async () => { if (typeof (window as any).loadServers === 'function') await (window as any).loadServers(); });
        await page.waitForTimeout(1500);

        const joinRes = await p2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${b2.token}`, 'Content-Type': 'application/json' },
            data: { code: srv.inviteCode },
        });
        if (!joinRes.ok()) {
            console.log('SV2 join failed:', await joinRes.text());
        }
        expect(joinRes.ok()).toBeTruthy();
        await p2.evaluate(async () => { if (typeof (window as any).loadServers === 'function') await (window as any).loadServers(); });
        await p2.waitForTimeout(1500);

        await saveProfileViaEvaluate(page, dn1);
        await saveProfileViaEvaluate(p2, dn2);
        await waitForCache(page, b2.user.id, dn2);
        await waitForCache(p2, b1.user.id, dn1);

        // Simulate refresh on both pages, then re-select server to trigger member profile fetch
        await simulateRefresh(page);
        const sid = srv.serverId;
        await page.evaluate(async (sid: string) => {
            if (typeof (window as any).loadServers === 'function') await (window as any).loadServers();
            if (typeof (window as any).selectServer === 'function') await (window as any).selectServer(sid);
        }, sid);
        await waitForCache(page, b2.user.id, dn2);
        await simulateRefresh(p2);
        await p2.evaluate(async (sid: string) => {
            if (typeof (window as any).loadServers === 'function') await (window as any).loadServers();
            if (typeof (window as any).selectServer === 'function') await (window as any).selectServer(sid);
        }, sid);
        await waitForCache(p2, b1.user.id, dn1);

        await p2.close();
        await ctx2.close();
    });

    test('SV3: profile modal opens correctly for server members', async ({ page, context }) => {
        const ts = Date.now();
        const u1 = 'sv3a_' + ts, u2 = 'sv3b_' + ts;
        const dn2 = 'Sybil_' + ts;

        const b1 = await registerUser(page, u1);
        const ctx2 = await context.browser()!.newContext();
        const p2 = await ctx2.newPage();
        const b2 = await registerUser(p2, u2);

        const srv = await createServer(page, b1.token, b1.user.id);
        await page.evaluate(async () => { if (typeof (window as any).loadServers === 'function') await (window as any).loadServers(); });
        await page.waitForTimeout(1500);

        const joinRes = await p2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${b2.token}`, 'Content-Type': 'application/json' },
            data: { code: srv.inviteCode },
        });
        if (!joinRes.ok()) {
            console.log('SV3 join failed:', await joinRes.text());
        }
        expect(joinRes.ok()).toBeTruthy();
        await p2.evaluate(async () => { if (typeof (window as any).loadServers === 'function') await (window as any).loadServers(); });
        await p2.waitForTimeout(1500);

        await saveProfileViaEvaluate(p2, dn2);
        await waitForCache(page, b2.user.id, dn2);

        // Open profile modal
        await page.evaluate(async (uid: string) => {
            if (typeof (window as any).openProfileModal === 'function') {
                await (window as any).openProfileModal(uid);
            }
        }, b2.user.id);
        await page.waitForTimeout(2000);

        const modal = await page.evaluate(() => {
            const el = document.getElementById('profile-modal-display-name');
            return { text: el?.textContent || null, error: el?.textContent === 'Error loading profile' };
        });
        expect(modal.error).toBe(false);
        expect(modal.text).not.toBe('Loading...');
        expect(modal.text).not.toBe('User not found');
        expect(modal.text?.length).toBeGreaterThan(0);

        await p2.close();
        await ctx2.close();
    });
});
