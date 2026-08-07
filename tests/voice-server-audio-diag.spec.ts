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

test.describe('Server voice channel audio diagnostic', () => {

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
        const prep = await page.evaluate(async ({ serverId, inviteCode }) => {
            const identity = E2ECrypto.getIdentityKeyPair();
            const symKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, symKey);
            const encName = E2ECrypto.aeadEncrypt('Diag Server', symKey);
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
        }, { name: 'Diag Voice', serverKeyB64 });

        const ch = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: {
                name: 'Diag Voice',
                encrypted_name: encName2.ciphertext,
                name_nonce: encName2.nonce,
                channel_type: 'voice',
            },
        })).json();
        expect(ch.channel_type).toBe('voice');
        return { serverId, voiceChannelId: ch.id, inviteCode };
    }

    async function joinServer(page2: any, token2: string, inviteCode: string) {
        const join = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
            data: { code: inviteCode },
        });
        expect(join.ok()).toBeTruthy();
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

    async function dumpState(pageRef: any, label: string) {
        return await pageRef.evaluate((label) => {
            const v = (window as any).VoiceManager;
            const dbg = v._debug && v._debug.state ? v._debug.state : v.getState();
            const peers: any = {};
            Object.keys(dbg.peers || {}).forEach((uid) => {
                const pc: any = dbg.peers[uid];
                if (!pc || typeof pc.getSenders !== 'function') return;
                peers[uid] = {
                    cs: pc.connectionState,
                    is: pc.iceConnectionState,
                    senders: pc.getSenders().map((x: any) => x.track ? x.track.kind : 'null'),
                    receivers: pc.getReceivers().map((x: any) => x.track ? x.track.kind : 'null'),
                    hasSendTransform: pc.getSenders().some((x: any) => x.track && !!x.transform),
                    hasRecvTransform: pc.getReceivers().some((x: any) => x.track && !!x.transform),
                };
            });
            const audioEls = Object.keys(dbg.remoteAudioEls || {}).map((uid) => {
                const els = dbg.remoteAudioEls[uid] || [];
                return { uid, count: els.length, playing: els.filter((e: any) => !e.paused).length };
            });
            return {
                label,
                roomType: dbg.roomType,
                connected: dbg.connected,
                key: dbg.roomKeyB64 ? dbg.roomKeyB64.slice(0, 12) + '…' : null,
                mic: !!(dbg.localStreams && dbg.localStreams.mic),
                muted: dbg.muted,
                deafened: dbg.deafened,
                members: Object.keys(dbg.members || {}),
                peers,
                audioEls,
                remoteAudio: Object.keys(dbg.remoteStreams || {}).filter((u) => dbg.remoteStreams[u] && dbg.remoteStreams[u].audio).length,
                pendingRecv: (dbg._pendingRecvTransforms || []).length,
            };
        }, label);
    }

    async function collectSendStats(pageRef: any) {
        await pageRef.evaluate(() => {
            const v = (window as any).VoiceManager;
            const st = v._debug && v._debug.state ? v._debug.state : v.getState();
            Object.keys(st.peers || {}).forEach((uid) => {
                const pc: any = st.peers[uid];
                if (!pc || typeof pc.getStats !== 'function') return;
                pc.getStats().then((stats: any) => {
                    let audioSent = 0, audioRecv = 0;
                    stats.forEach((x: any) => {
                        if (x.type === 'outbound-rtp' && x.kind === 'audio') audioSent = x.packetsSent;
                        if (x.type === 'inbound-rtp' && x.kind === 'audio') audioRecv = x.packetsReceived;
                    });
                    (window as any).__diagStats = (window as any).__diagStats || {};
                    (window as any).__diagStats[uid] = { audioSent, audioRecv };
                });
            });
        });
        await pageRef.waitForTimeout(3000);
        return await pageRef.evaluate(() => (window as any).__diagStats || {});
    }

    test('simultaneous join: full audio transport', async ({ page, context }) => {
        test.setTimeout(180000);
        const user1 = 'diag_a_' + Date.now();
        const user2 = 'diag_b_' + Date.now();
        const body1 = await registerUser(page, user1);
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        await joinServer(page2, body2.token, inviteCode);

        await page.goto(`${BASE}/index.html`);
        await page2.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2500);
        await page2.waitForTimeout(2500);
        await waitForWs(page);
        await waitForWs(page2);

        expect(await selectServer(page)).toBe(true);
        expect(await selectServer(page2)).toBe(true);
        expect(await clickVoiceChannel(page, voiceChannelId)).toBe(true);
        expect(await clickVoiceChannel(page2, voiceChannelId)).toBe(true);
        await page.waitForTimeout(1500);
        await page2.waitForTimeout(1500);

        await page.waitForFunction(() => {
            const v = (window as any).VoiceManager;
            return v && v.getState && v.getState().connected;
        }, undefined, { timeout: 15000 });
        await page2.waitForFunction(() => {
            const v = (window as any).VoiceManager;
            return v && v.getState && v.getState().connected;
        }, undefined, { timeout: 15000 });
        await page.waitForTimeout(4000);

        const d1 = await dumpState(page, 'PAGE1');
        const d2 = await dumpState(page2, 'PAGE2');
        const stats = await collectSendStats(page);
        console.log('DIAG1:', JSON.stringify(d1));
        console.log('DIAG2:', JSON.stringify(d2));
        console.log('STATS1:', JSON.stringify(stats));

        expect(d1.key).toBeTruthy();
        expect(d2.key).toBeTruthy();
        expect(d1.key).toBe(d2.key);
        expect(d1.mic).toBe(true);
        expect(d2.mic).toBe(true);
        const d1PeerUid = Object.keys(d1.peers)[0];
        const d2PeerUid = Object.keys(d2.peers)[0];
        expect(d1PeerUid).toBeTruthy();
        expect(d2PeerUid).toBeTruthy();
        expect(d1.peers[d1PeerUid].cs).toBe('connected');
        expect(d2.peers[d2PeerUid].cs).toBe('connected');
        expect(d1.peers[d1PeerUid].senders).toContain('audio');
        expect(d1.peers[d1PeerUid].receivers).toContain('audio');
        expect(d1.peers[d1PeerUid].hasSendTransform).toBe(true);
        expect(d1.peers[d1PeerUid].hasRecvTransform).toBe(true);
        expect(d1.remoteAudio).toBe(1);
        expect(d2.remoteAudio).toBe(1);
        expect(d1.audioEls.some((r: any) => r.count > 0 && r.playing > 0)).toBe(true);
        expect(d2.audioEls.some((r: any) => r.count > 0 && r.playing > 0)).toBe(true);
        expect(d1.pendingRecv).toBe(0);
        expect(d2.pendingRecv).toBe(0);
        const s1 = stats[d1PeerUid] || {};
        expect((s1.audioSent || 0) > 0).toBe(true);

        await page2.close();
        await ctx2.close();
    });

    test('staggered join: A joins, B joins 5s later', async ({ page, context }) => {
        test.setTimeout(180000);
        const user1 = 'stg_a_' + Date.now();
        const user2 = 'stg_b_' + Date.now();
        const body1 = await registerUser(page, user1);
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        await joinServer(page2, body2.token, inviteCode);

        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2500);
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(2500);
        await waitForWs(page);
        await waitForWs(page2);

        expect(await selectServer(page)).toBe(true);
        expect(await clickVoiceChannel(page, voiceChannelId)).toBe(true);
        await page.waitForFunction(() => {
            const v = (window as any).VoiceManager;
            return v && v.getState && v.getState().connected;
        }, undefined, { timeout: 15000 });
        await page.waitForTimeout(2000);

        await page.waitForTimeout(5000);
        expect(await selectServer(page2)).toBe(true);
        expect(await clickVoiceChannel(page2, voiceChannelId)).toBe(true);
        await page2.waitForFunction(() => {
            const v = (window as any).VoiceManager;
            return v && v.getState && v.getState().connected;
        }, undefined, { timeout: 15000 });
        await page.waitForTimeout(6000);

        const a1 = await dumpState(page, 'A');
        const b1 = await dumpState(page2, 'B');
        const stats = await collectSendStats(page);
        console.log('STAG_A:', JSON.stringify(a1));
        console.log('STAG_B:', JSON.stringify(b1));
        console.log('STAG_STATS_A:', JSON.stringify(stats));

        const aPeer = Object.keys(a1.peers)[0];
        expect(aPeer).toBeTruthy();
        expect(a1.peers[aPeer].cs).toBe('connected');
        expect(a1.peers[aPeer].senders).toContain('audio');
        expect(a1.peers[aPeer].receivers).toContain('audio');
        expect(a1.remoteAudio).toBe(1);
        expect(a1.audioEls.some((r: any) => r.playing > 0)).toBe(true);
        const bPeer = Object.keys(b1.peers)[0];
        expect(bPeer).toBeTruthy();
        expect(b1.peers[bPeer].cs).toBe('connected');
        expect(b1.remoteAudio).toBe(1);
        expect(b1.audioEls.some((r: any) => r.playing > 0)).toBe(true);
        const s1 = stats[aPeer] || {};
        expect((s1.audioSent || 0) > 0).toBe(true);

        await page2.close();
        await ctx2.close();
    });

    test('3-member mesh: every pair connects with matching keys and audio', async ({ page, context }) => {
        test.setTimeout(240000);
        const user1 = 'mesh_a_' + Date.now();
        const user2 = 'mesh_b_' + Date.now();
        const user3 = 'mesh_c_' + Date.now();
        const body1 = await registerUser(page, user1);
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        await joinServer(page2, body2.token, inviteCode);

        const ctx3 = await context.browser()!.newContext();
        const page3 = await ctx3.newPage();
        const body3 = await registerUser(page3, user3);
        await joinServer(page3, body3.token, inviteCode);

        await page.goto(`${BASE}/index.html`);
        await page2.goto(`${BASE}/index.html`);
        await page3.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2500);
        await page2.waitForTimeout(2500);
        await page3.waitForTimeout(2500);
        await waitForWs(page);
        await waitForWs(page2);
        await waitForWs(page3);

        for (const p of [page, page2, page3]) {
            expect(await selectServer(p)).toBe(true);
            expect(await clickVoiceChannel(p, voiceChannelId)).toBe(true);
        }
        await page.waitForTimeout(2000);
        await page2.waitForTimeout(2000);
        await page3.waitForTimeout(2000);

        for (const p of [page, page2, page3]) {
            await p.waitForFunction(() => {
                const v = (window as any).VoiceManager;
                return v && v.getState && v.getState().connected;
            }, undefined, { timeout: 15000 });
        }
        await page.waitForTimeout(5000);

        const states: any[] = [];
        states.push(await dumpState(page, 'MESH_A'));
        states.push(await dumpState(page2, 'MESH_B'));
        states.push(await dumpState(page3, 'MESH_C'));
        states.forEach((s) => console.log(JSON.stringify(s)));

        // Every member must have peers to BOTH others, all connected, same key
        const keys = states.map((s) => s.key).filter(Boolean);
        expect(keys.length).toBe(3);
        expect(new Set(keys).size).toBe(1); // all three agree on the room key
        states.forEach((s) => {
            expect(Object.keys(s.peers).length).toBe(2);
            Object.values(s.peers).forEach((p: any) => {
                expect(p.cs).toBe('connected');
                expect(p.senders).toContain('audio');
                expect(p.receivers).toContain('audio');
                expect(p.hasSendTransform).toBe(true);
                expect(p.hasRecvTransform).toBe(true);
            });
            expect(s.remoteAudio).toBe(2);
            expect(s.audioEls.filter((r: any) => r.playing > 0).length).toBe(2);
            expect(s.pendingRecv).toBe(0);
        });

        await page2.close();
        await ctx2.close();
        await page3.close();
        await ctx3.close();
    });

    test('4-member mesh: every user hears every other user', async ({ page, context }) => {
        test.setTimeout(300000);
        const users = ['m4a_' + Date.now(), 'm4b_' + Date.now(), 'm4c_' + Date.now(), 'm4d_' + Date.now()];
        const body1 = await registerUser(page, users[0]);
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);

        const pages: any[] = [page];
        const contexts: any[] = [];
        const bodies: any[] = [body1];
        for (let i = 1; i < 4; i++) {
            const ctx = await context.browser()!.newContext();
            contexts.push(ctx);
            const p = await ctx.newPage();
            const b = await registerUser(p, users[i]);
            await joinServer(p, b.token, inviteCode);
            pages.push(p);
            bodies.push(b);
        }

        for (let i = 0; i < 4; i++) {
            await pages[i].goto(`${BASE}/index.html`);
            await pages[i].waitForTimeout(2500);
            await waitForWs(pages[i]);
        }

        for (let i = 0; i < 4; i++) {
            expect(await selectServer(pages[i])).toBe(true);
            expect(await clickVoiceChannel(pages[i], voiceChannelId)).toBe(true);
        }
        await page.waitForTimeout(2000);
        await pages[1].waitForTimeout(2000);
        await pages[2].waitForTimeout(2000);
        await pages[3].waitForTimeout(2000);

        for (let i = 0; i < 4; i++) {
            await pages[i].waitForFunction(() => {
                const v = (window as any).VoiceManager;
                return v && v.getState && v.getState().connected;
            }, undefined, { timeout: 15000 });
        }
        await page.waitForTimeout(6000);

        const states: any[] = [];
        for (let i = 0; i < 4; i++) {
            states.push(await dumpState(pages[i], 'M4_' + ['A', 'B', 'C', 'D'][i]));
        }
        states.forEach((s) => console.log(JSON.stringify(s)));

        // 1. All four agree on the SAME room key (else one-sided E2EE = silence)
        const keys = states.map((s) => s.key).filter(Boolean);
        expect(keys.length).toBe(4);
        expect(new Set(keys).size).toBe(1);

        // 2. Every member has peers to the OTHER THREE, all connected, with
        //    audio senders+receivers and E2EE transforms on both sides.
        states.forEach((s) => {
            expect(Object.keys(s.peers).length).toBe(3);
            Object.values(s.peers).forEach((p: any) => {
                expect(p.cs).toBe('connected');
                expect(p.senders).toContain('audio');
                expect(p.receivers).toContain('audio');
                expect(p.hasSendTransform).toBe(true);
                expect(p.hasRecvTransform).toBe(true);
            });
        });

        // 3. Every member HEARS the other three: 3 remote audio streams + 3
        //    playing <audio> elements (a paused/missing element = no sound).
        states.forEach((s) => {
            expect(s.remoteAudio).toBe(3);
            const playingEls = s.audioEls.filter((r: any) => r.count > 0 && r.playing > 0);
            expect(playingEls.length).toBe(3);
            expect(s.pendingRecv).toBe(0);
        });

        // 4. Audio RTP actually flows from each member to all three others
        //    (sender-side packet counters prove real audio, not just media).
        for (let i = 0; i < 4; i++) {
            const stats = await collectSendStats(pages[i]);
            const ownUid = bodies[i].user.id;
            Object.keys(stats).forEach((peerUid) => {
                expect(peerUid).not.toBe(ownUid);
                expect((stats[peerUid].audioSent || 0) > 0).toBe(true);
                expect((stats[peerUid].audioRecv || 0) > 0).toBe(true);
            });
        }

        for (let i = 1; i < 4; i++) {
            await pages[i].close();
            await contexts[i - 1].close();
        }
    });
});
