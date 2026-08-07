import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.use({
    launchOptions: {
        args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
        ],
    },
});

test.describe('Server voice: late server key (one-sided E2EE)', () => {

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
        const inviteCode = 'LK' + ts;
        const prep = await page.evaluate(async ({ serverId, inviteCode }) => {
            const identity = E2ECrypto.getIdentityKeyPair();
            const symKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, symKey);
            const encName = E2ECrypto.aeadEncrypt('LateKey Server', symKey);
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

        const serverKeyB64 = await page.evaluate((sid) => {
            const sk = E2ECrypto.getServerKey(sid);
            return E2ECrypto.arrayBufferToBase64(sk);
        }, serverId);
        const encName2 = await page.evaluate(async ({ name, serverKeyB64 }) => {
            const sk = new Uint8Array(E2ECrypto.base64ToArrayBuffer(serverKeyB64));
            const enc = E2ECrypto.aeadEncrypt(name, sk);
            return { ciphertext: enc.ciphertext, nonce: enc.nonce };
        }, { name: 'LateKey Voice', serverKeyB64 });

        const ch = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: {
                name: 'LateKey Voice',
                encrypted_name: encName2.ciphertext,
                name_nonce: encName2.nonce,
                channel_type: 'voice',
            },
        })).json();
        expect(ch.channel_type).toBe('voice');
        return { serverId, voiceChannelId: ch.id, inviteCode };
    }

    async function selectServer(page: any) {
        await page.evaluate(() => {
            if (typeof loadServers === 'function') loadServers();
        }).catch(() => {});
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

    test('B joins voice before its server key is fetched, key arrives later → audio still connects', async ({ page, context }) => {
        test.setTimeout(180000);
        const user1 = 'lka_' + Date.now();
        const user2 = 'lkb_' + Date.now();
        const body1 = await registerUser(page, user1);
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);

        // B joins the server via API but its SERVER KEY is NOT fetched yet
        // (simulate a device that just joined: the e2e_server_<id> key is
        // missing from localStorage when the user enters the voice channel).
        const join = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { code: inviteCode },
        });
        expect(join.ok()).toBeTruthy();

        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2500);
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(2500);
        await waitForWs(page);
        await waitForWs(page2);

        // Let B render the server UI normally (channel list visible), THEN
        // strip its server key and hold the key-fetch endpoint — so B can
        // click the voice channel while genuinely lacking the key.
        expect(await selectServer(page2)).toBe(true);
        await page2.waitForSelector(`.channel-item[data-id="${voiceChannelId}"]`, { timeout: 10000 });

        await page2.evaluate((sid) => {
            localStorage.removeItem('e2e_server_' + sid);
            localStorage.removeItem('e2e_server_history_' + sid);
        }, serverId);
        // Hold B's key fetch for ~10s (real network latency) instead of
        // aborting: the server UI stays rendered while the key is in flight,
        // so B clicks the voice channel BEFORE the key lands.
        let releaseKeys = false;
        await page2.route(`${BASE}/api/servers/*/keys*`, async (route) => {
            if (releaseKeys) { await route.continue(); return; }
            await new Promise((r) => setTimeout(r, 10000));
            if (releaseKeys) { await route.continue(); return; }
            await route.continue();
        });
        const release = () => { releaseKeys = true; };

        // A joins first (has key)
        expect(await selectServer(page)).toBe(true);
        expect(await clickVoiceChannel(page, voiceChannelId)).toBe(true);
        await page.waitForFunction(() => {
            const v = (window as any).VoiceManager;
            return v && v.getState && v.getState().connected;
        }, undefined, { timeout: 15000 });
        await page.waitForTimeout(2000);

        // B joins WITHOUT the key
        expect(await clickVoiceChannel(page2, voiceChannelId)).toBe(true);
        await page2.waitForFunction(() => {
            const v = (window as any).VoiceManager;
            return v && v.getState && v.getState().connected;
        }, undefined, { timeout: 15000 });

        // PROVE B genuinely joined keyless: connected, but roomKeyB64 still
        // null (the safety net hasn't fired yet because the key is absent).
        const joinedKeyless = await page2.evaluate(() => {
            const v = (window as any).VoiceManager;
            const s = v.getState();
            return { connected: s.connected, key: s.roomKeyB64 || null };
        });
        expect(joinedKeyless.connected).toBe(true);
        expect(joinedKeyless.key).toBeNull();

        // NOW release B's key fetch (as the WS key_needed handshake would)
        release();
        await page2.waitForTimeout(1000);
        // Use the app's OWN key-fetch path (as the WS key_needed handshake
        // would) — it tries every key version with the right fallbacks.
        const fetchResult = await page2.evaluate(async (sid) => {
            if (typeof fetchAndDecryptServerKey !== 'function') return { ok: false, err: 'no fn' };
            const ok = await fetchAndDecryptServerKey(sid);
            return { ok, keyNow: !!localStorage.getItem('e2e_server_' + sid) };
        }, serverId);
        expect(fetchResult.ok).toBe(true);
        expect(fetchResult.keyNow).toBe(true);

        // Give the app time to recover: after the key arrives, the safety net
        // poll must re-derive the room key and apply E2EE to the peer.
        await page.waitForTimeout(6000);

        const dbg = (pageRef: any, label: string) => pageRef.evaluate((label) => {
            const v = (window as any).VoiceManager;
            const dbg = v._debug && v._debug.state ? v._debug.state : v.getState();
            const peers: any = {};
            Object.keys(dbg.peers || {}).forEach((uid) => {
                const pc: any = dbg.peers[uid];
                if (!pc || typeof pc.getSenders !== 'function') return;
                peers[uid] = {
                    cs: pc.connectionState,
                    key: dbg.roomKeyB64 ? dbg.roomKeyB64.slice(0, 8) + '…' : null,
                    senders: pc.getSenders().map((x: any) => x.track ? x.track.kind : 'null'),
                    hasSendTransform: pc.getSenders().some((x: any) => x.track && !!x.transform),
                    hasRecvTransform: pc.getReceivers().some((x: any) => x.track && !!x.transform),
                };
            });
            return {
                label, connected: dbg.connected, key: dbg.roomKeyB64 ? dbg.roomKeyB64.slice(0, 8) + '…' : null,
                pendingRecv: (dbg._pendingRecvTransforms || []).length,
                peers,
                remoteAudio: Object.keys(dbg.remoteStreams || {}).filter((u) => dbg.remoteStreams[u] && dbg.remoteStreams[u].audio).length,
            };
        }, label);

        const a1 = await dbg(page, 'A');
        const b1 = await dbg(page2, 'B');
        console.log('LATEKEY_A:', JSON.stringify(a1));
        console.log('LATEKEY_B:', JSON.stringify(b1));

        // Both sides must end up with the SAME room key, connected peers, and
        // E2EE transforms applied — otherwise one-sided E2EE = silence.
        expect(a1.key).toBeTruthy();
        expect(b1.key).toBeTruthy();
        expect(a1.key).toBe(b1.key);
        const aPeerUid = Object.keys(a1.peers)[0];
        const bPeerUid = Object.keys(b1.peers)[0];
        expect(a1.peers[aPeerUid].cs).toBe('connected');
        expect(b1.peers[bPeerUid].cs).toBe('connected');
        expect(a1.peers[aPeerUid].hasSendTransform).toBe(true);
        expect(a1.peers[aPeerUid].hasRecvTransform).toBe(true);
        expect(b1.peers[bPeerUid].hasSendTransform).toBe(true);
        expect(b1.peers[bPeerUid].hasRecvTransform).toBe(true);
        expect(a1.remoteAudio).toBe(1);
        expect(b1.remoteAudio).toBe(1);

        await page2.close();
        await ctx2.close();
    });
});
