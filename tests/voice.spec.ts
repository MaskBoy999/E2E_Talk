import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('Voice channels & DM calls', () => {

    async function registerUser(page: any, username: string) {
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
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

    async function createServerWithVoiceChannel(page: any, token: string): Promise<{ serverId: string; voiceChannelId: string; inviteCode: string }> {
        const ts = Date.now();
        const inviteCode = 'VC' + ts;
        // Encrypt the server name + default channel name with a fresh key (mirrors chat.js)
        const prep = await page.evaluate(async ({ serverId, inviteCode }) => {
            const identity = E2ECrypto.getIdentityKeyPair();
            const symKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, symKey);
            const encName = E2ECrypto.aeadEncrypt('Voice Test Server', symKey);
            const encCh = E2ECrypto.aeadEncrypt('general', symKey);
            return {
                encrypted_name: encName.ciphertext,
                name_nonce: encName.nonce,
                channel_encrypted_name: encCh.ciphertext,
                channel_name_nonce: encCh.nonce,
                invite_code: inviteCode,
            };
        }, { serverId: 'pending', inviteCode });

        const srv = await (await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: {
                invite_code: inviteCode,
                encrypted_name: prep.encrypted_name,
                name_nonce: prep.name_nonce,
                channel_encrypted_name: prep.channel_encrypted_name,
                channel_name_nonce: prep.channel_name_nonce,
            },
        })).json();
        const serverId = srv.id;
        // Re-save the server key under the real server id (the prep ran with a placeholder)
        await page.evaluate(async ({ serverId }) => {
            const symKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, symKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const myId = JSON.parse(localStorage.getItem('user') || '{}').id;
            const pubRes = await fetch('/api/identity/' + myId, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const pubData = await pubRes.json();
            const pubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(pubData.identity_public_key));
            const enc = E2ECrypto.envelopeEncrypt(symKey, pubKey, identity.privateKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: myId,
                    encrypted_key: enc.ciphertext,
                    sender_public_key: E2ECrypto.arrayBufferToBase64(identity.publicKey),
                    nonce: enc.nonce,
                }),
            });
        }, { serverId });

        // Create a voice channel (encrypted name)
        const serverKeyB64 = await page.evaluate((sid) => {
            const sk = E2ECrypto.getServerKey(sid);
            return E2ECrypto.arrayBufferToBase64(sk);
        }, serverId);
        const encName2 = await page.evaluate(async ({ name, serverKeyB64 }) => {
            const sk = new Uint8Array(E2ECrypto.base64ToArrayBuffer(serverKeyB64));
            const enc = E2ECrypto.aeadEncrypt(name, sk);
            return { ciphertext: enc.ciphertext, nonce: enc.nonce };
        }, { name: 'General Voice', serverKeyB64 });

        const ch = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: {
                name: 'General Voice',
                encrypted_name: encName2.ciphertext,
                name_nonce: encName2.nonce,
                channel_type: 'voice',
            },
        })).json();
        expect(ch.channel_type).toBe('voice');
        // Save the raw invite code for the owner (mirrors chat.js createServer)
        await page.evaluate(({ serverId, inviteCode }) => {
            localStorage.setItem('e2e_invite_' + serverId, inviteCode);
        }, { serverId, inviteCode });
        return { serverId, voiceChannelId: ch.id, inviteCode };
    }

    async function joinServer(page2: any, token2: string, inviteCode: string) {
        // The server salts & hashes the raw code itself (mirrors chat.js's joinServer)
        const join = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
            data: { code: inviteCode },
        });
        expect(join.ok()).toBeTruthy();
    }

    async function selectServer(page: any) {
        // The server was created via API, so refresh the UI server list first
        await page.evaluate(() => {
            if (typeof loadServers === 'function') loadServers();
        }).catch(() => {});
        // Switch to the server view and click the first server icon
        await page.click('#dm-strip-btn').catch(() => {});
        await page.waitForTimeout(800);
        for (let i = 0; i < 30; i++) {
            const count = await page.locator('.server-icon:not(.add-server):not(.dm-strip-btn)').count();
            if (count > 0) {
                await page.locator('.server-icon:not(.add-server):not(.dm-strip-btn)').first().click().catch(() => {});
                await page.waitForTimeout(600);
                return true;
            }
            await page.waitForTimeout(300);
        }
        return false;
    }

    async function clickVoiceChannel(page: any, channelId: string) {
        for (let i = 0; i < 40; i++) {
            const el = page.locator(`.channel-item[data-id="${channelId}"]`);
            if (await el.count()) {
                await el.click();
                await page.waitForTimeout(600);
                return true;
            }
            await page.waitForTimeout(300);
        }
        return false;
    }

    test('server voice channel: join, members, mute/deafen, owner controls', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'voice1_' + ts;
        const user2 = 'voice2_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        expect(body1.token).toBeTruthy();
        expect(body2.token).toBeTruthy();

        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);

        // User2 joins via the raw invite code (server salts & hashes it on lookup)
        await joinServer(page2, body2.token, inviteCode);

        // Upload server key for user2 (owner shares it)
        await page.evaluate(async ({ serverId, user2Id }) => {
            const identity = E2ECrypto.getIdentityKeyPair();
            const symKey = E2ECrypto.getServerKey(serverId);
            const pubRes = await fetch('/api/identity/' + user2Id, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const pubData = await pubRes.json();
            const u2Pub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(pubData.identity_public_key));
            const enc = E2ECrypto.envelopeEncrypt(symKey, u2Pub, identity.privateKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: user2Id,
                    encrypted_key: enc.ciphertext,
                    sender_public_key: E2ECrypto.arrayBufferToBase64(identity.publicKey),
                    nonce: enc.nonce,
                }),
            });
        }, { serverId, user2Id: body2.user.id });

        // Wait for WS on both pages, select the server, and join the voice channel
        const ws1 = await waitForWs(page);
        const ws2 = await waitForWs(page2);
        expect(ws1).toBeTruthy();
        expect(ws2).toBeTruthy();

        expect(await selectServer(page)).toBe(true);
        expect(await selectServer(page2)).toBe(true);

        expect(await clickVoiceChannel(page, voiceChannelId)).toBe(true);
        expect(await clickVoiceChannel(page2, voiceChannelId)).toBe(true);

        // User1 (owner) should be connected; members should include both users
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && Object.keys(v._debug.state.members).length >= 1;
        }, undefined, { timeout: 15000 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && Object.keys(v._debug.state.members).length >= 2;
        }, undefined, { timeout: 15000 });

        // Owner force-mutes user2 → user2 cannot unmute
        await page.evaluate(({ uid }) => {
            window.VoiceManager.ownerControl('mute', uid);
        }, { uid: body2.user.id });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug.state.forceMuted === true;
        }, undefined, { timeout: 10000 });

        // User2 tries to unmute → stays muted
        await page2.evaluate(() => window.VoiceManager.toggleMute());
        await page2.waitForTimeout(800);
        const stillMuted = await page2.evaluate(() => window.VoiceManager._debug.state.muted);
        expect(stillMuted).toBe(true);

        // Owner unmutes → user2 can toggle mute again
        await page.evaluate(({ uid }) => {
            window.VoiceManager.ownerControl('unmute', uid);
        }, { uid: body2.user.id });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug.state.forceMuted === false;
        }, undefined, { timeout: 10000 });

        // Owner kicks user2 → user2 disconnects
        await page.evaluate(({ uid }) => {
            window.VoiceManager.ownerControl('kick', uid);
        }, { uid: body2.user.id });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() === false;
        }, undefined, { timeout: 10000 });

        // User2 can rejoin
        expect(await clickVoiceChannel(page2, voiceChannelId)).toBe(true);
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected();
        }, undefined, { timeout: 15000 });
    });

    test('signaling E2EE: SDP/ICE relayed encrypted, both sides derive the subkey', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'sig1_' + ts;
        const user2 = 'sig2_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);

        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);
        await joinServer(page2, body2.token, inviteCode);

        // Upload server key for user2 (owner shares it)
        await page.evaluate(async ({ serverId, user2Id }) => {
            const identity = E2ECrypto.getIdentityKeyPair();
            const symKey = E2ECrypto.getServerKey(serverId);
            const pubRes = await fetch('/api/identity/' + user2Id, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const pubData = await pubRes.json();
            const u2Pub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(pubData.identity_public_key));
            const enc = E2ECrypto.envelopeEncrypt(symKey, u2Pub, identity.privateKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: user2Id,
                    encrypted_key: enc.ciphertext,
                    sender_public_key: E2ECrypto.arrayBufferToBase64(identity.publicKey),
                    nonce: enc.nonce,
                }),
            });
        }, { serverId, user2Id: body2.user.id });

        expect(await waitForWs(page)).toBeTruthy();
        expect(await waitForWs(page2)).toBeTruthy();
        expect(await selectServer(page)).toBe(true);
        expect(await selectServer(page2)).toBe(true);
        expect(await clickVoiceChannel(page, voiceChannelId)).toBe(true);
        expect(await clickVoiceChannel(page2, voiceChannelId)).toBe(true);

        // Both sides derive the signaling subkey
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug && v._debug.getSigKey();
        }, undefined, { timeout: 15000 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug && v._debug.getSigKey();
        }, undefined, { timeout: 15000 });

        // Encrypt/decrypt roundtrip on the caller side proves the key works
        const rt = await page.evaluate(() => {
            const d = window.VoiceManager._debug;
            const enc = d.encryptSignalPayload({ type: 'offer', sdp: 'SECRET-SDP-DATA' });
            if (!enc || !enc.e || !enc.n) return { ok: false, why: 'encrypt returned no ciphertext' };
            if (JSON.stringify(enc).indexOf('SECRET-SDP-DATA') !== -1) return { ok: false, why: 'plaintext leaked into ciphertext' };
            const dec = d.decryptSignalPayload(enc);
            if (!dec || dec.sdp !== 'SECRET-SDP-DATA') return { ok: false, why: 'decrypt mismatch' };
            return { ok: true };
        });
        expect(rt.ok).toBe(true);

        // End-to-end: user1 sends an encrypted probe → server relays → user2 decrypts it
        const sent = await page.evaluate(({ uid }) => window.VoiceManager._debug.sendSignalProbe(uid), { uid: body2.user.id });
        expect(sent).toBe(true);
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug && v._debug.state.sigRecvEncrypted > 0;
        }, undefined, { timeout: 10000 });
        // And user1 saw its own signal go out encrypted
        const sentCount = await page.evaluate(() => window.VoiceManager._debug.state.sigSentEncrypted);
        expect(sentCount).toBeGreaterThan(0);
    });

    test('DM call: ring, accept, end', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'dmc1_' + ts;
        const user2 = 'dmc2_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);

        // Become friends via friend code API
        const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        const fr = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: fc2 },
        });
        expect(fr.ok()).toBeTruthy();
        const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        })).json();
        const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        expect(acc.ok()).toBeTruthy();

        // Create DM channel
        const userData = await (await page.request.get(`${BASE}/api/user/${user2}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        const dm = await (await page.request.post(`${BASE}/api/dm/${userData.id}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        expect(dm.id).toBeTruthy();

        await waitForWs(page);
        await waitForWs(page2);

        // User1 opens the DM and starts a call
        await page.click('#dm-strip-btn').catch(() => {});
        await page.waitForTimeout(800);
        // Click the DM conversation
        for (let i = 0; i < 40; i++) {
            const conv = page.locator('.dm-item, .dm-conv, [data-dm-id]');
            if (await conv.count()) {
                await conv.first().click().catch(() => {});
                await page.waitForTimeout(800);
                break;
            }
            await page.waitForTimeout(300);
        }

        // Start the DM call via VoiceManager (the header button is injected by voice.js)
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && typeof v.startDmCall === 'function' && document.querySelector('.dm-call-btns');
        }, undefined, { timeout: 15000 });

        // Caller starts the call
        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: user2 });

        // Callee (page2) receives the ring
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug.state.incomingCall !== null;
        }, undefined, { timeout: 15000 });
        expect(await page2.locator('#incoming-call-bar').isVisible().catch(() => false)).toBeTruthy();

        // Callee accepts
        await page2.evaluate(() => window.VoiceManager.acceptDmCall());

        // Both sides connected
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && v.isInDmCall();
        }, undefined, { timeout: 15000 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && v.isInDmCall();
        }, undefined, { timeout: 15000 });

        // Caller leaves the call → callee does NOT get disconnected; they flip
        // to the waiting state so the caller can rejoin (Discord-style). Then
        // the callee leaves to fully tear the call down.
        await page.evaluate(() => window.VoiceManager.endDmCall());
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isInDmCall() && v.isCallWaiting();
        }, undefined, { timeout: 10000 });
        await page2.evaluate(() => window.VoiceManager.endDmCall());
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && !v.isInDmCall();
        }, undefined, { timeout: 10000 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && !v.isInDmCall();
        }, undefined, { timeout: 10000 });
    });

    test('voice presence: non-participant sees members + speaking glow in the channel list', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'vpres1_' + ts;
        const user2 = 'vpres2_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        expect(body1.token).toBeTruthy();
        expect(body2.token).toBeTruthy();

        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);
        await joinServer(page2, body2.token, inviteCode);

        // Share the server key with user2 (owner encrypts for them)
        await page.evaluate(async ({ serverId, user2Id }) => {
            const identity = E2ECrypto.getIdentityKeyPair();
            const symKey = E2ECrypto.getServerKey(serverId);
            const pubRes = await fetch('/api/identity/' + user2Id, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const pubData = await pubRes.json();
            const u2Pub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(pubData.identity_public_key));
            const enc = E2ECrypto.envelopeEncrypt(symKey, u2Pub, identity.privateKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: user2Id,
                    encrypted_key: enc.ciphertext,
                    sender_public_key: E2ECrypto.arrayBufferToBase64(identity.publicKey),
                    nonce: enc.nonce,
                }),
            });
        }, { serverId, user2Id: body2.user.id });

        const ws1 = await waitForWs(page);
        const ws2 = await waitForWs(page2);
        expect(ws1).toBeTruthy();
        expect(ws2).toBeTruthy();

        expect(await selectServer(page)).toBe(true);
        expect(await selectServer(page2)).toBe(true);

        // User1 (owner) joins the voice channel. User2 stays OUT of the room.
        expect(await clickVoiceChannel(page, voiceChannelId)).toBe(true);
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected();
        }, undefined, { timeout: 15000 });

        // User2 (non-participant) receives the server-wide presence snapshot and
        // sees user1's member row under the voice channel with the display name.
        await page2.waitForFunction(({ uid }) => {
            const v = window.VoiceManager;
            const pres = v && v._debug && v._debug.getServerPresence ? v._debug.getServerPresence() : null;
            if (!pres) return false;
            const any = Object.keys(pres).some((sid) => {
                const p = pres[sid];
                return p && p.channels && p.channels.some((c) => c.members && c.members.some((m) => m.user_id === uid));
            });
            return any;
        }, { uid: body1.user.id }, { timeout: 15000 });

        // The channel-list DOM shows the member row (name visible)
        await page2.waitForFunction(({ uid }) => {
            const row = document.querySelector('.voice-chip-row[data-uid="' + uid + '"]');
            return !!row && row.querySelector('.voice-chip-name');
        }, { uid: body1.user.id }, { timeout: 10000 });

        // User1 starts talking (real server path: voice_state -> presence
        // broadcast). forceSpeaking also force-unmutes, since headless has no
        // mic and joining auto-muted user1.
        await page.evaluate(() => window.VoiceManager._debug.forceSpeaking(true));

        // User2's row lights up with the speaking glow
        await page2.waitForFunction(({ uid }) => {
            const row = document.querySelector('.voice-chip-row[data-uid="' + uid + '"]');
            return !!row && row.classList.contains('speaking');
        }, { uid: body1.user.id }, { timeout: 10000 });

        // Stop talking -> glow disappears on user2's side
        await page.evaluate(() => window.VoiceManager._debug.forceSpeaking(false));
        await page2.waitForFunction(({ uid }) => {
            const row = document.querySelector('.voice-chip-row[data-uid="' + uid + '"]');
            return !!row && !row.classList.contains('speaking');
        }, { uid: body1.user.id }, { timeout: 10000 });
    });
});
