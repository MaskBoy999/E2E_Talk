import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

function generateCode(len: number): string {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return code;
}

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(500);
    if (page.url().includes('admin')) {
        await page.fill('#admin-password', 'admin');
        await page.click('#admin-login-form button[type="submit"]');
        await page.waitForTimeout(2000);
        await page.goto(`${BASE}/login.html`);
        await page.waitForTimeout(500);
    }
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

async function becomeFriendsViaApi(page1: any, page2: any, token1: string, token2: string) {
    const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    expect(fc2).toBeTruthy();
    const fr = await page1.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        data: { friend_code: fc2 },
    });
    expect(fr.ok()).toBeTruthy();
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${token2}` },
    })).json();
    expect(Array.isArray(incoming)).toBe(true);
    expect(incoming.length).toBeGreaterThanOrEqual(1);
    const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    expect(acc.ok()).toBeTruthy();
}

// Channel send that mirrors the REAL UI sendMessage: encrypted content + encrypted_sender_username
// + encrypted_profile_snapshot (display name + colors).
async function sendServerMessageViaWs(page: any, channelId: string, serverId: string, text: string, snapshot: any) {
    return await page.evaluate(async ({ channelId, serverId, text, snapshot }) => {
        const key = E2ECrypto.getServerKey(serverId);
        if (!key) return 'no_key';
        const enc = E2ECrypto.encryptMessage(text, key);
        const payload: any = {
            type: 'message_send',
            channel_id: channelId,
            encrypted_content: enc.ciphertext,
            nonce: enc.nonce,
            message_nonce: enc.messageNonce || null,
        };
        try {
            const myUser = JSON.parse(localStorage.getItem('user') || '{}');
            if (myUser.username) {
                const encUsername = E2ECrypto.encryptSenderUsername(myUser.username, key);
                if (encUsername) {
                    payload.encrypted_sender_username = encUsername.ciphertext;
                    payload.sender_username_nonce = encUsername.nonce;
                }
            }
            if (snapshot) {
                const encSnap = E2ECrypto.encryptMessage(JSON.stringify(snapshot), key);
                payload.encrypted_profile_snapshot = encSnap.ciphertext;
                payload.profile_snapshot_nonce = encSnap.nonce;
            }
        } catch (_) {}
        ws.send(JSON.stringify(payload));
        return 'sent';
    }, { channelId, serverId, text, snapshot });
}

// DM send that mirrors the REAL UI sendDmMessage: content + encrypted_sender_username
// + encrypted_profile_snapshot encrypted with the DM shared key.
async function sendDmMessageViaWs(page: any, dmChannelId: string, otherUserId: string, text: string, snapshot: any) {
    return await page.evaluate(async ({ dmChannelId, otherUserId, text, snapshot }) => {
        const kp = E2ECrypto.getIdentityKeyPair();
        if (!kp) return 'no_identity';
        const res = await fetch('/api/identity/' + otherUserId, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
        });
        const data = await res.json();
        if (!data.identity_public_key) return 'no_pub_key';
        const otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
        const enc = E2ECrypto.encryptDm(text, dmChannelId, kp.privateKey, otherPub);
        const payload: any = {
            type: 'dm_send',
            dm_channel_id: dmChannelId,
            encrypted_content: enc.ciphertext,
            nonce: enc.nonce,
            message_nonce: enc.messageNonce || null,
        };
        try {
            const dmKey = E2ECrypto.getDmKey(dmChannelId, kp.privateKey, otherPub);
            if (dmKey) {
                const myUser = JSON.parse(localStorage.getItem('user') || '{}');
                if (myUser.username) {
                    const encUsername = E2ECrypto.encryptSenderUsername(myUser.username, dmKey);
                    if (encUsername) {
                        payload.encrypted_sender_username = encUsername.ciphertext;
                        payload.sender_username_nonce = encUsername.nonce;
                    }
                }
                if (snapshot) {
                    const encSnap = E2ECrypto.encryptDm(JSON.stringify(snapshot), dmChannelId, kp.privateKey, otherPub);
                    payload.encrypted_profile_snapshot = encSnap.ciphertext;
                    payload.profile_snapshot_nonce = encSnap.nonce;
                }
            }
        } catch (_) {}
        ws.send(JSON.stringify(payload));
        return 'sent';
    }, { dmChannelId, otherUserId, text, snapshot });
}

// Saves a colored profile via PATCH /api/profile AND uploads the conversation
// profile for the target conversation (mirrors the real UI saveProfile flow).
async function saveProfileWithConv(page: any, profileData: Record<string, string>, convType: string, convId: string) {
    return await page.evaluate(async ({ pd, convType, convId }) => {
        const logs: string[] = [];
        try {
            const identity = E2ECrypto.getIdentityKeyPair();
            if (!identity) { logs.push('no identity'); return { ok: false, logs }; }
            const profileDataKey = E2ECrypto.generateProfileDataKey();
            const profileDataJson = JSON.stringify(pd);
            const encrypted = E2ECrypto.encryptProfileData(profileDataJson, profileDataKey);
            const profileDataKeyB64 = E2ECrypto.arrayBufferToBase64(profileDataKey);
            const encryptedProfileDataKey = E2ECrypto.encodeEncryptedFileKey(profileDataKeyB64, identity.privateKey);
            const encryptedProfileData = encrypted.nonce + ':' + encrypted.ciphertext;
            const patchRes = await fetch('/api/profile', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ encrypted_profile_data: encryptedProfileData, encrypted_profile_data_key: encryptedProfileDataKey }),
            });
            logs.push('PATCH /api/profile: ' + patchRes.status);
            // Upload a conversation profile for the target conversation if we can derive the key
            let encConv: any = null;
            if (convType === 'channel') {
                const serverKey = E2ECrypto.getServerKey(convId);
                if (serverKey) encConv = E2ECrypto.aeadEncrypt(profileDataJson, serverKey);
            } else {
                const conv = (typeof dmConversations !== 'undefined' ? dmConversations : []).find((c: any) => c.dm_channel_id === convId);
                let otherPubKey: Uint8Array | null = null;
                if (conv && conv.other_public_key) {
                    otherPubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(conv.other_public_key));
                } else if (conv) {
                    try {
                        const idRes = await fetch('/api/identity/' + conv.other_user_id, {
                            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
                        });
                        const idData = await idRes.json();
                        if (idData.identity_public_key) {
                            otherPubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(idData.identity_public_key));
                        }
                    } catch (_) {}
                }
                if (otherPubKey) {
                    const dmKey = E2ECrypto.getDmKey(convId, identity.privateKey, otherPubKey);
                    encConv = E2ECrypto.aeadEncrypt(profileDataJson, dmKey);
                }
            }
            if (encConv) {
                const convRes = await fetch('/api/profile/conversation', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                    body: JSON.stringify({
                        conversation_type: convType,
                        conversation_id: convId,
                        encrypted_profile_data: encConv.ciphertext,
                        nonce: encConv.nonce,
                    }),
                });
                logs.push('PUT conv profile: ' + convRes.status);
            } else {
                logs.push('no key for conv upload');
            }
            const myId = JSON.parse(localStorage.getItem('user') || '{}').id;
            if (!userDisplayNameCache[myId]) userDisplayNameCache[myId] = {};
            if (pd.display_name) userDisplayNameCache[myId].display_name = pd.display_name;
            if (pd.username_color) userDisplayNameCache[myId].username_color = pd.username_color;
            if (pd.username_border_color) userDisplayNameCache[myId].username_border_color = pd.username_border_color;
            scheduleUserDisplayNameSave && scheduleUserDisplayNameSave();
            return { ok: true, logs };
        } catch (e: any) {
            logs.push('FATAL: ' + e.message);
            return { ok: false, logs };
        }
    }, { pd: profileData, convType, convId });
}

// Block the sender's conversation-profile uploads (PUT /api/profile/conversation)
// so the server stores NO conversation_profile_data for them. This forces colors
// to come purely from each message's encrypted_profile_snapshot — the exact
// scenario that used to drop colors when the DM REST handler serialized nonces
// as raw byte arrays.
async function blockConversationProfileUploads(page: any) {
    await page.route('**/api/profile/conversation', (route) => route.abort());
}

// PATCH /api/profile ONLY — does NOT upload a conversation profile. Mirrors a
// user who set their colors but whose conversation profile was never uploaded
// (e.g. set before the conversation existed, or blocked).
async function patchProfileOnly(page: any, profileData: Record<string, string>) {
    return await page.evaluate(async (pd) => {
        const logs: string[] = [];
        try {
            const identity = E2ECrypto.getIdentityKeyPair();
            if (!identity) { logs.push('no identity'); return { ok: false, logs }; }
            const profileDataKey = E2ECrypto.generateProfileDataKey();
            const profileDataJson = JSON.stringify(pd);
            const encrypted = E2ECrypto.encryptProfileData(profileDataJson, profileDataKey);
            const profileDataKeyB64 = E2ECrypto.arrayBufferToBase64(profileDataKey);
            const encryptedProfileDataKey = E2ECrypto.encodeEncryptedFileKey(profileDataKeyB64, identity.privateKey);
            const patchRes = await fetch('/api/profile', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ encrypted_profile_data: encrypted.nonce + ':' + encrypted.ciphertext, encrypted_profile_data_key: encryptedProfileDataKey }),
            });
            logs.push('PATCH /api/profile: ' + patchRes.status);
            const myId = JSON.parse(localStorage.getItem('user') || '{}').id;
            if (!userDisplayNameCache[myId]) userDisplayNameCache[myId] = {};
            if (pd.display_name) userDisplayNameCache[myId].display_name = pd.display_name;
            if (pd.username_color) userDisplayNameCache[myId].username_color = pd.username_color;
            if (pd.username_border_color) userDisplayNameCache[myId].username_border_color = pd.username_border_color;
            scheduleUserDisplayNameSave && scheduleUserDisplayNameSave();
            return { ok: true, logs };
        } catch (e: any) {
            logs.push('FATAL: ' + e.message);
            return { ok: false, logs };
        }
    }, profileData);
}

// NOTE: deliberately NOT async — callers must use it synchronously. An async
// version returning a Promise caused JSON.stringify(Promise) → "{}" empty
// snapshots when a caller forgot `await` (the exact bug this test catches).
function buildSnapshot(displayName: string, color: string, borderColor: string) {
    return {
        display_name: displayName,
        username_color: color,
        username_border_color: borderColor,
        nickname: null,
        description: null,
        profile_background_color: null,
        profile_picture_file_id: null,
        profile_picture_file_key: null,
    };
}

// Count rendered sender messages and check their display-name styling
async function senderStats(page: any, displayName: string, color: string) {
    return await page.evaluate(({ displayName, color }) => {
        const msgs = document.querySelectorAll('.message');
        let total = 0;
        let colored = 0;
        let correctName = 0;
        let withGlow = 0;
        msgs.forEach((m) => {
            const nameEl = m.querySelector('.display-name');
            if (!nameEl) return;
            const txt = (nameEl.textContent || '').trim();
            if (!txt) return;
            total++;
            const style = nameEl.getAttribute('style') || '';
            if (txt === displayName) correctName++;
            if (style.indexOf(color) !== -1) colored++;
            if (style.indexOf('text-shadow') !== -1) withGlow++;
        });
        return { total, correctName, colored, withGlow };
    }, { displayName, color });
}

// Assert the serialization regression guard: byte fields must be base64 strings,
// NOT raw JSON number arrays (the old DM REST handler bug).
function assertSerialization(rawMsg: any) {
    expect(rawMsg.encrypted_profile_snapshot).toBeTruthy();
    expect(rawMsg.profile_snapshot_nonce).toBeTruthy();
    expect(Array.isArray(rawMsg.profile_snapshot_nonce)).toBe(false);
    expect(typeof rawMsg.profile_snapshot_nonce).toBe('string');
    if (rawMsg.encrypted_file_key !== null && rawMsg.encrypted_file_key !== undefined) {
        expect(Array.isArray(rawMsg.encrypted_file_key)).toBe(false);
    }
    if (rawMsg.file_key_nonce !== null && rawMsg.file_key_nonce !== undefined) {
        expect(Array.isArray(rawMsg.file_key_nonce)).toBe(false);
    }
}

test.describe('Verify infinite-scroll profile color/glow rendering', () => {

    test('DM: colored sender renders on prepended messages + REST serialization guard', async ({ page, context }) => {
        test.setTimeout(300000);
        const ts = Date.now();
        const user1 = 'vpdm_a_' + ts;
        const user2 = 'vpdm_b_' + ts;
        const DISPLAY_NAME = 'DmGlowSnder';
        const COLOR = '#00ccff';

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        expect(body2.token).toBeTruthy();

        const body1 = await registerUser(page, user1);
        expect(body1.token).toBeTruthy();

        await becomeFriendsViaApi(page, page2, body1.token, body2.token);

        const convs = await (await page.request.get(`${BASE}/api/dm/conversations`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        expect(convs.length).toBeGreaterThanOrEqual(1);
        const dmId = convs[0].dm_channel_id;
        const otherUserId = convs[0].other_user_id;
        console.log('DM channel:', dmId, 'other:', otherUserId);

        // Sender (user2) saves colored profile + uploads DM conversation profile
        const saveRes = await saveProfileWithConv(page2, {
            display_name: DISPLAY_NAME,
            username_color: COLOR,
            username_border_color: 'rgba(0,0,0,0.85)',
        }, 'dm', dmId);
        console.log('Sender profile save:', JSON.stringify(saveRes.logs));
        expect(saveRes.ok).toBe(true);

        // Sender sends 60 DM messages with snapshot
        const wsOk = await waitForWs(page2);
        expect(wsOk).toBe(true);
        const snapshot = buildSnapshot(DISPLAY_NAME, COLOR, 'rgba(0,0,0,0.85)');
        const MSG_COUNT = 60;
        for (let i = 0; i < MSG_COUNT; i++) {
            const r = await sendDmMessageViaWs(page2, dmId, body1.user.id, `DmGlow msg ${i}`, snapshot);
            expect(r).toBe('sent');
            await page2.waitForTimeout(120);
        }
        await page2.waitForTimeout(3000);

        // Confirm the API has all 60 messages AND lock in the serialization fix:
        // profile_snapshot_nonce / file keys must be base64 strings, not arrays.
        const apiMsgs = await (await page.request.get(`${BASE}/api/dm/${dmId}/messages?limit=100`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        console.log(`DM API messages: ${apiMsgs.length}`);
        expect(apiMsgs.length).toBeGreaterThanOrEqual(MSG_COUNT);
        console.log('raw msg profile_snapshot_nonce type:', Array.isArray(apiMsgs[apiMsgs.length - 1].profile_snapshot_nonce) ? 'ARRAY' : typeof apiMsgs[apiMsgs.length - 1].profile_snapshot_nonce);
        assertSerialization(apiMsgs[apiMsgs.length - 1]);

        // Viewer (user1) opens the DM
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(1500);
        await page.waitForSelector('.dm-item', { timeout: 15000 });
        await page.click('.dm-item');
        await page.waitForTimeout(2000);

        let messageCount = 0;
        await expect(async () => {
            messageCount = await page.locator('.message').count();
            expect(messageCount).toBeGreaterThanOrEqual(50);
        }).toPass({ timeout: 30000 });

        const s1 = await senderStats(page, DISPLAY_NAME, COLOR);
        console.log(`DM initial batch sender stats:`, JSON.stringify(s1));
        expect(s1.correctName).toBeGreaterThanOrEqual(40);
        expect(s1.colored).toBeGreaterThanOrEqual(40);

        await page.evaluate(() => {
            const list = document.getElementById('message-list');
            if (list) list.scrollTop = 0;
        });

        await expect(async () => {
            const c = await page.locator('.message').count();
            expect(c).toBeGreaterThan(messageCount);
        }).toPass({ timeout: 30000 });

        await page.waitForTimeout(1500);
        const s2 = await senderStats(page, DISPLAY_NAME, COLOR);
        console.log(`DM after scroll sender stats:`, JSON.stringify(s2));
        expect(s2.total).toBeGreaterThanOrEqual(MSG_COUNT);
        expect(s2.correctName).toBe(s2.total);
        expect(s2.colored).toBe(s2.total);
        expect(s2.withGlow).toBe(s2.total);

        console.log('=== VERIFY DM SCROLL PROFILE COLOR/GLOW TEST PASSED ===');

        await page2.close();
        await ctx2.close();
    });

    test('channel: colored sender renders on prepended messages + serialization guard', async ({ page, context }) => {
        test.setTimeout(300000);
        const ts = Date.now();
        const ownerName = 'vpcowner_' + ts;
        const senderName = 'vpcsnder_' + ts;
        const DISPLAY_NAME = 'ChanGlowSnder';
        const COLOR = '#ff6600';

        const ownerBody = await registerUser(page, ownerName);
        expect(ownerBody.token).toBeTruthy();

        const ctxS = await context.browser()!.newContext();
        const pageS = await ctxS.newPage();
        const senderBody = await registerUser(pageS, senderName);
        expect(senderBody.token).toBeTruthy();

        // Owner creates server + key
        const inviteCode = generateCode(8);
        const srv = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${ownerBody.token}`, 'Content-Type': 'application/json' },
            data: { invite_code: inviteCode },
        });
        expect(srv.ok()).toBeTruthy();
        const server = await srv.json();
        await page.evaluate(async ({ serverId }: { serverId: string }) => {
            const serverKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, serverKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: JSON.parse(localStorage.getItem('user') || '{}').id, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: server.id });
        const chRes = await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
            headers: { Authorization: `Bearer ${ownerBody.token}` },
        });
        const channels = await chRes.json();
        const channelId = channels[0].id;
        console.log('server:', server.id, 'channel:', channelId);

        // Sender joins the server
        const joinRes = await pageS.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${senderBody.token}`, 'Content-Type': 'application/json' },
            data: { code: inviteCode },
        });
        expect(joinRes.ok()).toBeTruthy();

        // Share the server key with the sender
        await page.waitForTimeout(4000);
        await page.evaluate(async ({ serverId, jUserId, jPubKey }) => {
            const serverKey = E2ECrypto.getServerKey(serverId);
            if (!serverKey) return;
            const identity = E2ECrypto.getIdentityKeyPair();
            const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(jPubKey));
            const encrypted = E2ECrypto.envelopeEncrypt(serverKey, recipientPub, identity.privateKey);
            await fetch('/api/servers/' + serverId + '/keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: jUserId, encrypted_key: encrypted.ciphertext, sender_public_key: E2ECrypto.arrayBufferToBase64(identity.publicKey), nonce: encrypted.nonce }),
            });
        }, { serverId: server.id, jUserId: senderBody.user.id, jPubKey: await pageS.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey)) });

        let senderHasKey = false;
        for (let attempt = 0; attempt < 6; attempt++) {
            senderHasKey = await pageS.evaluate(async (serverId) => {
                if (typeof fetchAndDecryptServerKey === 'function') {
                    return await fetchAndDecryptServerKey(serverId);
                }
                return false;
            }, server.id);
            if (senderHasKey) break;
            await pageS.waitForTimeout(2000);
        }
        console.log('sender has key:', senderHasKey);
        expect(senderHasKey).toBe(true);

        // Sender saves colored profile + uploads channel conversation profile
        const saveRes = await saveProfileWithConv(pageS, {
            display_name: DISPLAY_NAME,
            username_color: COLOR,
            username_border_color: 'rgba(0,0,0,0.85)',
        }, 'channel', server.id);
        console.log('Sender profile save:', JSON.stringify(saveRes.logs));
        expect(saveRes.ok).toBe(true);

        // Sender sends 60 messages with snapshot
        const wsOk = await waitForWs(pageS);
        expect(wsOk).toBe(true);
        const snapshot = buildSnapshot(DISPLAY_NAME, COLOR, 'rgba(0,0,0,0.85)');
        const MSG_COUNT = 60;
        for (let i = 0; i < MSG_COUNT; i++) {
            const r = await sendServerMessageViaWs(pageS, channelId, server.id, `ChanGlow msg ${i}`, snapshot);
            expect(r).toBe('sent');
            await pageS.waitForTimeout(120);
        }
        await pageS.waitForTimeout(3000);

        // Confirm the API has all 60 messages AND the channel serialization is intact
        const apiMsgs = await (await page.request.get(`${BASE}/api/channels/${channelId}/messages?limit=100`, {
            headers: { Authorization: `Bearer ${ownerBody.token}` },
        })).json();
        console.log(`Channel API messages: ${apiMsgs.length}`);
        expect(apiMsgs.length).toBeGreaterThanOrEqual(MSG_COUNT);
        console.log('raw msg profile_snapshot_nonce type:', Array.isArray(apiMsgs[apiMsgs.length - 1].profile_snapshot_nonce) ? 'ARRAY' : typeof apiMsgs[apiMsgs.length - 1].profile_snapshot_nonce);
        assertSerialization(apiMsgs[apiMsgs.length - 1]);

        // Viewer (owner) opens the channel
        await page.evaluate(async () => { await loadServers(); });
        await page.waitForTimeout(2000);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 15000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(2000);

        let messageCount = 0;
        await expect(async () => {
            messageCount = await page.locator('.message').count();
            expect(messageCount).toBeGreaterThanOrEqual(50);
        }).toPass({ timeout: 30000 });

        const s1 = await senderStats(page, DISPLAY_NAME, COLOR);
        console.log(`Channel initial batch sender stats:`, JSON.stringify(s1));
        expect(s1.correctName).toBeGreaterThanOrEqual(40);
        expect(s1.colored).toBeGreaterThanOrEqual(40);

        await page.evaluate(() => {
            const list = document.getElementById('message-list');
            if (list) list.scrollTop = 0;
        });

        await expect(async () => {
            const c = await page.locator('.message').count();
            expect(c).toBeGreaterThan(messageCount);
        }).toPass({ timeout: 30000 });

        await page.waitForTimeout(1500);
        const s2 = await senderStats(page, DISPLAY_NAME, COLOR);
        console.log(`Channel after scroll sender stats:`, JSON.stringify(s2));
        expect(s2.total).toBeGreaterThanOrEqual(MSG_COUNT);
        expect(s2.correctName).toBe(s2.total);
        expect(s2.colored).toBe(s2.total);
        expect(s2.withGlow).toBe(s2.total);

        console.log('=== VERIFY CHANNEL SCROLL PROFILE COLOR/GLOW TEST PASSED ===');

        await pageS.close();
        await ctxS.close();
    });

    test('DM: snapshot-only colors render when sender has NO conversation profile (repaint via snapshot)', async ({ page, context }) => {
        test.setTimeout(300000);
        const ts = Date.now();
        const user1 = 'vpsndm_a_' + ts;
        const user2 = 'vpsndm_b_' + ts;
        const DISPLAY_NAME = 'SnapOnlyDm';
        const COLOR = '#ff22cc';

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        expect(body2.token).toBeTruthy();

        // Block conversation-profile uploads BEFORE friendship — otherwise the
        // friend_request_accepted WS event auto-uploads the sender's profile.
        await blockConversationProfileUploads(page2);

        const body1 = await registerUser(page, user1);
        expect(body1.token).toBeTruthy();

        await becomeFriendsViaApi(page, page2, body1.token, body2.token);

        const convs = await (await page.request.get(`${BASE}/api/dm/conversations`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        expect(convs.length).toBeGreaterThanOrEqual(1);
        const dmId = convs[0].dm_channel_id;
        const otherUserId = convs[0].other_user_id;
        console.log('DM snapshot-only channel:', dmId, 'other:', otherUserId);

        // Sender sets a colored profile via PATCH /api/profile ONLY — no
        // conversation profile is uploaded, so the ONLY color source is the
        // per-message encrypted_profile_snapshot.
        const saveRes = await patchProfileOnly(page2, {
            display_name: DISPLAY_NAME,
            username_color: COLOR,
            username_border_color: 'rgba(0,0,0,0.85)',
        });
        console.log('Sender PATCH-only profile:', JSON.stringify(saveRes.logs));
        expect(saveRes.ok).toBe(true);

        // Sender sends 60 DM messages with snapshot
        const wsOk = await waitForWs(page2);
        expect(wsOk).toBe(true);
        const snapshot = buildSnapshot(DISPLAY_NAME, COLOR, 'rgba(0,0,0,0.85)');
        const MSG_COUNT = 60;
        for (let i = 0; i < MSG_COUNT; i++) {
            const r = await sendDmMessageViaWs(page2, dmId, body1.user.id, `SnapOnlyDm msg ${i}`, snapshot);
            expect(r).toBe('sent');
            await page2.waitForTimeout(120);
        }
        await page2.waitForTimeout(3000);

        // PROVE the sender has NO conversation profile: raw API must return
        // snapshot fields present + conversation_profile null.
        const apiMsgs = await (await page.request.get(`${BASE}/api/dm/${dmId}/messages?limit=100`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        console.log(`DM snapshot-only API messages: ${apiMsgs.length}`);
        expect(apiMsgs.length).toBeGreaterThanOrEqual(MSG_COUNT);
        assertSerialization(apiMsgs[apiMsgs.length - 1]);
        console.log('DM snapshot-only conversation_profile:', JSON.stringify(apiMsgs[apiMsgs.length - 1].conversation_profile));
        expect(apiMsgs[apiMsgs.length - 1].conversation_profile).toBeNull();

        // Viewer (user1) opens the DM
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(1500);
        await page.waitForSelector('.dm-item', { timeout: 15000 });
        await page.click('.dm-item');
        await page.waitForTimeout(2000);

        let messageCount = 0;
        await expect(async () => {
            messageCount = await page.locator('.message').count();
            expect(messageCount).toBeGreaterThanOrEqual(50);
        }).toPass({ timeout: 30000 });

        const s1 = await senderStats(page, DISPLAY_NAME, COLOR);
        console.log(`DM snapshot-only initial batch sender stats:`, JSON.stringify(s1));
        expect(s1.correctName).toBeGreaterThanOrEqual(40);
        expect(s1.colored).toBeGreaterThanOrEqual(40);

        await page.evaluate(() => {
            const list = document.getElementById('message-list');
            if (list) list.scrollTop = 0;
        });

        await expect(async () => {
            const c = await page.locator('.message').count();
            expect(c).toBeGreaterThan(messageCount);
        }).toPass({ timeout: 30000 });

        // Wait for the async prefetch (fetchDmConversationProfile →
        // updateExistingMessageStyles) to resolve — it finds NO conversation
        // profile, so the colors that survive must come from the snapshot path.
        await page.waitForTimeout(2000);
        const s2 = await senderStats(page, DISPLAY_NAME, COLOR);
        console.log(`DM snapshot-only after scroll sender stats:`, JSON.stringify(s2));
        expect(s2.total).toBeGreaterThanOrEqual(MSG_COUNT);
        expect(s2.correctName).toBe(s2.total);
        expect(s2.colored).toBe(s2.total);
        expect(s2.withGlow).toBe(s2.total);

        console.log('=== VERIFY DM SNAPSHOT-ONLY TEST PASSED ===');

        await page2.close();
        await ctx2.close();
    });

    test('channel: snapshot-only colors render when sender has NO conversation profile', async ({ page, context }) => {
        test.setTimeout(300000);
        const ts = Date.now();
        const ownerName = 'vpsnco_' + ts;
        const senderName = 'vpsncs_' + ts;
        const DISPLAY_NAME = 'SnapOnlyChan';
        const COLOR = '#33cc22';

        const ownerBody = await registerUser(page, ownerName);
        expect(ownerBody.token).toBeTruthy();

        const ctxS = await context.browser()!.newContext();
        const pageS = await ctxS.newPage();
        const senderBody = await registerUser(pageS, senderName);
        expect(senderBody.token).toBeTruthy();

        // Block conversation-profile uploads on the sender's page BEFORE they
        // join — otherwise member_joined/server_key_rotated WS events auto-upload.
        await blockConversationProfileUploads(pageS);

        // Owner creates server + key
        const inviteCode = generateCode(8);
        const srv = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${ownerBody.token}`, 'Content-Type': 'application/json' },
            data: { invite_code: inviteCode },
        });
        expect(srv.ok()).toBeTruthy();
        const server = await srv.json();
        await page.evaluate(async ({ serverId }: { serverId: string }) => {
            const serverKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, serverKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: JSON.parse(localStorage.getItem('user') || '{}').id, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: server.id });
        const chRes = await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
            headers: { Authorization: `Bearer ${ownerBody.token}` },
        });
        const channels = await chRes.json();
        const channelId = channels[0].id;
        console.log('server:', server.id, 'channel:', channelId);

        // Sender joins the server
        const joinRes = await pageS.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${senderBody.token}`, 'Content-Type': 'application/json' },
            data: { code: inviteCode },
        });
        expect(joinRes.ok()).toBeTruthy();

        // Share the server key with the sender
        await page.waitForTimeout(4000);
        await page.evaluate(async ({ serverId, jUserId, jPubKey }) => {
            const serverKey = E2ECrypto.getServerKey(serverId);
            if (!serverKey) return;
            const identity = E2ECrypto.getIdentityKeyPair();
            const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(jPubKey));
            const encrypted = E2ECrypto.envelopeEncrypt(serverKey, recipientPub, identity.privateKey);
            await fetch('/api/servers/' + serverId + '/keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: jUserId, encrypted_key: encrypted.ciphertext, sender_public_key: E2ECrypto.arrayBufferToBase64(identity.publicKey), nonce: encrypted.nonce }),
            });
        }, { serverId: server.id, jUserId: senderBody.user.id, jPubKey: await pageS.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey)) });

        let senderHasKey = false;
        for (let attempt = 0; attempt < 6; attempt++) {
            senderHasKey = await pageS.evaluate(async (serverId) => {
                if (typeof fetchAndDecryptServerKey === 'function') {
                    return await fetchAndDecryptServerKey(serverId);
                }
                return false;
            }, server.id);
            if (senderHasKey) break;
            await pageS.waitForTimeout(2000);
        }
        console.log('sender has key:', senderHasKey);
        expect(senderHasKey).toBe(true);

        // Sender sets a colored profile via PATCH ONLY — no conversation profile
        const saveRes = await patchProfileOnly(pageS, {
            display_name: DISPLAY_NAME,
            username_color: COLOR,
            username_border_color: 'rgba(0,0,0,0.85)',
        });
        console.log('Sender PATCH-only profile:', JSON.stringify(saveRes.logs));
        expect(saveRes.ok).toBe(true);

        // Sender sends 60 messages with snapshot
        const wsOk = await waitForWs(pageS);
        expect(wsOk).toBe(true);
        const snapshot = buildSnapshot(DISPLAY_NAME, COLOR, 'rgba(0,0,0,0.85)');
        const MSG_COUNT = 60;
        for (let i = 0; i < MSG_COUNT; i++) {
            const r = await sendServerMessageViaWs(pageS, channelId, server.id, `SnapOnlyChan msg ${i}`, snapshot);
            expect(r).toBe('sent');
            await pageS.waitForTimeout(120);
        }
        await pageS.waitForTimeout(3000);

        // PROVE the sender has NO conversation profile in this channel
        const apiMsgs = await (await page.request.get(`${BASE}/api/channels/${channelId}/messages?limit=100`, {
            headers: { Authorization: `Bearer ${ownerBody.token}` },
        })).json();
        console.log(`Channel snapshot-only API messages: ${apiMsgs.length}`);
        expect(apiMsgs.length).toBeGreaterThanOrEqual(MSG_COUNT);
        assertSerialization(apiMsgs[apiMsgs.length - 1]);
        console.log('Channel snapshot-only conversation_profile:', JSON.stringify(apiMsgs[apiMsgs.length - 1].conversation_profile));
        expect(apiMsgs[apiMsgs.length - 1].conversation_profile).toBeNull();

        // Viewer (owner) opens the channel
        await page.evaluate(async () => { await loadServers(); });
        await page.waitForTimeout(2000);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 15000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(2000);

        let messageCount = 0;
        await expect(async () => {
            messageCount = await page.locator('.message').count();
            expect(messageCount).toBeGreaterThanOrEqual(50);
        }).toPass({ timeout: 30000 });

        const s1 = await senderStats(page, DISPLAY_NAME, COLOR);
        console.log(`Channel snapshot-only initial batch sender stats:`, JSON.stringify(s1));
        expect(s1.correctName).toBeGreaterThanOrEqual(40);
        expect(s1.colored).toBeGreaterThanOrEqual(40);

        await page.evaluate(() => {
            const list = document.getElementById('message-list');
            if (list) list.scrollTop = 0;
        });

        await expect(async () => {
            const c = await page.locator('.message').count();
            expect(c).toBeGreaterThan(messageCount);
        }).toPass({ timeout: 30000 });

        await page.waitForTimeout(2000);
        const s2 = await senderStats(page, DISPLAY_NAME, COLOR);
        console.log(`Channel snapshot-only after scroll sender stats:`, JSON.stringify(s2));
        expect(s2.total).toBeGreaterThanOrEqual(MSG_COUNT);
        expect(s2.correctName).toBe(s2.total);
        expect(s2.colored).toBe(s2.total);
        expect(s2.withGlow).toBe(s2.total);

        console.log('=== VERIFY CHANNEL SNAPSHOT-ONLY TEST PASSED ===');

        await pageS.close();
        await ctxS.close();
    });

});
