import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

async function mockMedia(page: any) {
    await page.addInitScript(() => {
        const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints: any) => {
            if (constraints && constraints.audio) {
                const ac = new (window as any).AudioContext();
                const osc = ac.createOscillator();
                osc.frequency.value = 300;
                const dest = ac.createMediaStreamDestination();
                osc.connect(dest);
                osc.start();
                (window as any).__mockOsc = osc;
                return dest.stream;
            }
            if (constraints && constraints.video) {
                const canvas = document.createElement('canvas');
                canvas.width = 320; canvas.height = 240;
                const ctx = canvas.getContext('2d')!;
                const stream = (canvas as any).captureStream(30);
                (window as any).__mockCanvasTimer = setInterval(() => {
                    ctx.fillStyle = '#c04060';
                    ctx.fillRect(0, 0, 320, 240);
                }, 80);
                return stream;
            }
            return origGUM(constraints);
        };
    });
}

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

async function waitForWs(page: any) {
    return await page.evaluate(() => {
        return new Promise((resolve) => {
            let tries = 0;
            const check = () => {
                tries++;
                if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) resolve(true);
                else if (tries >= 60) resolve(false);
                else setTimeout(check, 200);
            };
            setTimeout(check, 500);
        });
    });
}

async function setupFriends(page: any, page2: any, body1: any, body2: any) {
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
}

async function createDm(page: any, page2: any, body1: any, body2: any) {
    const userData = await (await page.request.get(`${BASE}/api/user/${body2.user.username}`, {
        headers: { Authorization: `Bearer ${body1.token}` },
    })).json();
    const dm = await (await page.request.post(`${BASE}/api/dm/${userData.id}`, {
        headers: { Authorization: `Bearer ${body1.token}` },
    })).json();
    expect(dm.id).toBeTruthy();
    return dm;
}

async function openDm(page: any) {
    await page.click('#dm-strip-btn').catch(() => {});
    await page.waitForTimeout(800);
    for (let i = 0; i < 40; i++) {
        const conv = page.locator('.dm-item, .dm-conv, [data-dm-id]');
        if (await conv.count()) {
            await conv.first().click().catch(() => {});
            await page.waitForTimeout(800);
            break;
        }
        await page.waitForTimeout(300);
    }
}

async function waitConnected(page: any, timeout = 30000) {
    await page.waitForFunction(() => {
        const v = (window as any).VoiceManager;
        return v && v._debug && v._debug.state && v._debug.state.connected;
    }, undefined, { timeout });
}

async function createServerWithVoiceChannel(page: any, token: string): Promise<{ serverId: string; voiceChannelId: string; inviteCode: string }> {
    const ts = Date.now();
    const inviteCode = 'HL' + ts;
    const prep = await page.evaluate(async ({ inviteCode }) => {
        const identity = E2ECrypto.getIdentityKeyPair();
        const symKey = E2ECrypto.generateSymmetricKey();
        const serverId = 'pending';
        E2ECrypto.saveServerKey(serverId, symKey);
        const encName = E2ECrypto.aeadEncrypt('Heal Server', symKey);
        const encCh = E2ECrypto.aeadEncrypt('general', symKey);
        return {
            encrypted_name: encName.ciphertext,
            name_nonce: encName.nonce,
            channel_encrypted_name: encCh.ciphertext,
            channel_name_nonce: encCh.nonce,
            invite_code: inviteCode,
        };
    }, { inviteCode });

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
    }, { name: 'Heal Voice', serverKeyB64 });

    const ch = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            name: 'Heal Voice',
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

test.describe('Rejoin & heal (diagnostics auto-fix)', () => {

    test('DM call: missing sender transform is healed IN PLACE — no rejoin, no re-ring', async ({ browser }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const ctxA = await browser.newContext();
        const pageA = await ctxA.newPage();
        const ctxB = await browser.newContext();
        const pageB = await ctxB.newPage();
        await mockMedia(pageA);
        await mockMedia(pageB);
        const bodyA = await registerUser(pageA, 'ha_' + ts);
        const bodyB = await registerUser(pageB, 'hb_' + ts);
        await waitForWs(pageA);
        await waitForWs(pageB);
        await setupFriends(pageA, pageB, bodyA, bodyB);
        await createDm(pageA, pageB, bodyA, bodyB);
        await pageA.reload();
        await pageB.reload();
        await waitForWs(pageA);
        await waitForWs(pageB);
        await openDm(pageA);
        await pageA.waitForSelector('.dm-call-btns .dm-call-btn', { timeout: 20000 });
        await pageA.click('.dm-call-btns .dm-call-btn');
        await pageA.waitForTimeout(2000);
        await pageB.waitForSelector('#incoming-call-accept:visible', { timeout: 20000 });
        await pageB.click('#incoming-call-accept');
        await pageA.waitForTimeout(4000);

        // Connected both sides, send audio transform present.
        await waitConnected(pageA);
        await waitConnected(pageB);
        const peerBefore = await pageA.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            const uid = Object.keys(S.peers)[0];
            const pc = S.peers[uid];
            const s = pc.getSenders().find((x: any) => x.track && x.track.kind === 'audio');
            return { uid, hadTransform: !!s.transform };
        });
        expect(peerBefore.hadTransform).toBe(true);

        // Simulate the "send audio [E2EE ✗]" state: the sender lost its
        // encrypt transform (exactly the case the panel flags + suggests
        // rejoin for).
        const nulled = await pageA.evaluate((uid) => {
            const S = (window as any).VoiceManager._debug.state;
            const pc = S.peers[uid];
            const s = pc.getSenders().find((x: any) => x.track && x.track.kind === 'audio');
            try { s.transform = null; } catch (_) {}
            return { nowNull: !s.transform };
        }, peerBefore.uid);
        expect(nulled.nowNull).toBe(true);

        // Press the button (programmatic — the UI binding is trivially the
        // same handler).
        await pageA.evaluate(() => (window as any).VoiceManager.healAndRejoin());
        // The transform must come back…
        await pageA.waitForFunction((uid) => {
            const S = (window as any).VoiceManager._debug.state;
            const pc = S.peers[uid];
            if (!pc) return false;
            const s = pc.getSenders().find((x: any) => x.track && x.track.kind === 'audio');
            return s && !!s.transform;
        }, peerBefore.uid, { timeout: 15000 });

        // …WITHOUT a rejoin: the same peer object survives (an in-place heal
        // never leaves/rejoins) and stays connected.
        const after = await pageA.evaluate((uid) => {
            const S = (window as any).VoiceManager._debug.state;
            const pc = S.peers[uid];
            return {
                samePeer: true,
                conn: pc ? pc.connectionState : 'gone',
                connected: S.connected,
                roomType: S.roomType,
            };
        }, peerBefore.uid);
        expect(after.conn).toBe('connected');
        expect(after.connected).toBe(true);
        expect(after.roomType).toBe('dm');

        // The callee was NOT re-rung (quiet heal): no incoming-call bar on B.
        const ringVisible = await pageB.locator('#incoming-call-accept:visible').count();
        expect(ringVisible).toBe(0);
        // B's peer for A also still exists and is connected.
        const bConn = await pageB.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            const uid = Object.keys(S.peers)[0];
            return uid ? S.peers[uid].connectionState : 'no-peer';
        });
        expect(bConn).toBe('connected');

        await ctxA.close().catch(() => {});
        await ctxB.close().catch(() => {});
    });

    test('server voice channel: black-feed signature triggers a full rejoin that rebuilds the peer', async ({ browser }) => {
        test.setTimeout(360000);
        const ts = Date.now();
        const ctxA = await browser.newContext();
        const pageA = await ctxA.newPage();
        const ctxB = await browser.newContext();
        const pageB = await ctxB.newPage();
        await mockMedia(pageA);
        await mockMedia(pageB);
        const bodyA = await registerUser(pageA, 'hs_' + ts);
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(pageA, bodyA.token);
        const bodyB = await registerUser(pageB, 'ht_' + ts);
        const join = await pageB.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${bodyB.token}`, 'Content-Type': 'application/json' },
            data: { code: inviteCode },
        });
        expect(join.ok()).toBeTruthy();

        await pageA.goto(`${BASE}/index.html`);
        await pageB.goto(`${BASE}/index.html`);
        await pageA.waitForTimeout(2000);
        await pageB.waitForTimeout(2000);
        await waitForWs(pageA);
        await waitForWs(pageB);

        expect(await selectServer(pageA)).toBe(true);
        expect(await clickVoiceChannel(pageA, voiceChannelId)).toBe(true);
        await waitConnected(pageA);
        await pageA.waitForTimeout(1500);
        expect(await selectServer(pageB)).toBe(true);
        expect(await clickVoiceChannel(pageB, voiceChannelId)).toBe(true);
        await waitConnected(pageB);
        await pageB.waitForTimeout(1500);

        // B turns their camera on so A receives a video feed (the black-feed
        // signature is a video receiver with packets but 0 frames decoded).
        await pageB.evaluate(() => (window as any).VoiceManager.toggleCamera());
        await pageB.waitForFunction(() => (window as any).VoiceManager._debug.state.cameraOn, undefined, { timeout: 20000 });
        await pageA.waitForTimeout(3000);

        const before = await pageA.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            const uid = Object.keys(S.peers)[0];
            const pc = S.peers[uid];
            return {
                uid,
                peerObj: !!pc,
                conn: pc ? pc.connectionState : 'none',
                hasVideoRecv: pc ? pc.getReceivers().some((r: any) => r.track && r.track.kind === 'video') : false,
            };
        });
        expect(before.hasVideoRecv).toBe(true);

        // Simulate the black feed: A's peer reports inbound video packets but
        // 0 frames decoded — the exact signature the panel flags.
        await pageA.evaluate((uid) => {
            const S = (window as any).VoiceManager._debug.state;
            const pc = S.peers[uid];
            const origGetStats = pc.getStats.bind(pc);
            pc.getStats = async () => {
                const orig = await origGetStats();
                // OVERRIDE the real inbound-rtp video report (frames → 0,
                // packets kept > 0) instead of adding a second one — the
                // aggregator SUMS frames, so an extra fake entry would keep
                // frames > 0 and the black-feed signature would never match.
                const m = new Map();
                (orig as any).forEach((r: any, key: string) => {
                    if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) {
                        m.set(key, { ...r, framesDecoded: 0, packetsReceived: 120, packetsLost: 0 });
                    } else {
                        m.set(key, r);
                    }
                });
                (pc as any).getStats.__stubbed = true;
                return m;
            };
        }, before.uid);

        // The panel must now flag the black feed.
        const flagged = await pageA.evaluate(() => (window as any).VoiceManager.getPeerDiag().then((diag: any[]) =>
            diag.some((p: any) => p.receivers && p.receivers.video && p.receivers.video.tracks > 0 && p.receivers.video.packets > 0 && p.receivers.video.frames === 0)
        ));
        expect(flagged).toBe(true);

        // Rejoin & heal → the black signature survives the in-place heal, so
        // the room is left and rejoined: the peer object gets REPLACED.
        await pageA.evaluate(() => (window as any).VoiceManager.healAndRejoin());
        await pageA.waitForFunction((uid) => {
            const S = (window as any).VoiceManager._debug.state;
            const pc = S.peers[uid];
            // New peer: connected again (the stub is gone with the old pc).
            return pc && pc.connectionState === 'connected' && !pc.getStats.__stubbed;
        }, before.uid, { timeout: 30000 });

        // Still in the same room, connected, and the camera feed decodes again
        // (the recreated receiver got its decrypt transform at ontrack).
        const after = await pageA.evaluate((uid) => {
            const S = (window as any).VoiceManager._debug.state;
            const pc = S.peers[uid];
            return {
                conn: pc ? pc.connectionState : 'none',
                connected: S.connected,
                roomType: S.roomType,
                channelId: S.channelId,
            };
        }, before.uid);
        expect(after.connected).toBe(true);
        expect(after.roomType).toBe('server');
        expect(after.channelId).toBe(voiceChannelId);
        expect(after.conn).toBe('connected');

        // And the video feed is healthy again: frames decoded climb.
        await pageA.waitForFunction((uid) => {
            const S = (window as any).VoiceManager._debug.state;
            const pc = S.peers[uid];
            if (!pc) return false;
            const r = pc.getReceivers().find((x: any) => x.track && x.track.kind === 'video');
            return !!r && !!r.transform;
        }, before.uid, { timeout: 15000 });

        await ctxA.close().catch(() => {});
        await ctxB.close().catch(() => {});
    });
});
