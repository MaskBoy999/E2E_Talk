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
                let i = 0;
                const stream = (canvas as any).captureStream(30);
                (window as any).__mockCanvasTimer = setInterval(() => {
                    ctx.fillStyle = `rgb(${(i * 40) % 255},100,150)`;
                    ctx.fillRect(0, 0, 320, 240);
                    ctx.fillStyle = '#fff';
                    ctx.fillText(String(i++), 10, 20);
                }, 80);
                return stream;
            }
            return origGUM(constraints);
        };
        (navigator.mediaDevices as any).getDisplayMedia = async (constraints: any) => {
            const vStream = await (navigator.mediaDevices as any).getUserMedia({ video: true });
            const aStream = await (navigator.mediaDevices as any).getUserMedia({ audio: true });
            const out = new MediaStream();
            vStream.getTracks().forEach((t: any) => out.addTrack(t));
            aStream.getTracks().forEach((t: any) => out.addTrack(t));
            return out;
        };
        (window as any).__enableVoiceAudioDebug = true;
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
    await page.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
        data: { friend_code: fc2 },
    });
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${body2.token}` },
    })).json();
    await page2.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
}

async function createDm(page: any, page2: any, body1: any, body2: any) {
    const userData = await (await page.request.get(`${BASE}/api/user/${body2.user.username}`, {
        headers: { Authorization: `Bearer ${body1.token}` },
    })).json();
    const dm = await (await page.request.post(`${BASE}/api/dm/${userData.id}`, {
        headers: { Authorization: `Bearer ${body1.token}` },
    })).json();
    return { userData, dm };
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

async function startDmCall(page: any, page2: any, dm: any, partnerUid: string, partnerName: string) {
    await page.evaluate(({ dmId, uid, uname }) => {
        window.VoiceManager.startDmCall(dmId, uid, uname);
    }, { dmId: dm.id, uid: partnerUid, uname: partnerName });
    await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });
    await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 20000 });
    await page2.click('#incoming-call-accept');
    await page.waitForFunction(() => (window as any).VoiceManager._debug.state.connected, undefined, { timeout: 20000 });
    await page2.waitForFunction(() => (window as any).VoiceManager._debug.state.connected, undefined, { timeout: 20000 });
}

test.describe('receiver-side watchdog', () => {
    test('DM call: a remote camera that decodes 0 frames while the sender encodes is auto-healed (renegotiation + chip)', async ({ browser }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        await mockMedia(pageA);
        await mockMedia(pageB);
        const bodyA = await registerUser(pageA, 'rw1_' + ts);
        const bodyB = await registerUser(pageB, 'rw2_' + ts);
        await setupFriends(pageA, pageB, bodyA, bodyB);
        const { userData, dm } = await createDm(pageA, pageB, bodyA, bodyB);
        await waitForWs(pageA);
        await waitForWs(pageB);
        await openDm(pageA);
        await startDmCall(pageA, pageB, dm, userData.id, bodyB.user.username);

        // B turns camera on; A must receive and decode it normally first.
        await pageB.evaluate(() => (window as any).VoiceManager.toggleCamera());
        await pageB.waitForFunction(() => (window as any).VoiceManager._debug.state.cameraOn, undefined, { timeout: 20000 });
        await pageA.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            const uid = Object.keys(s.peers || {})[0];
            return uid && s.remoteStreams[uid] && s.remoteStreams[uid].camera;
        }, undefined, { timeout: 30000 });
        await pageA.waitForTimeout(4000);
        // Sanity: A's inbound video decodes frames.
        const healthy = await pageA.evaluate((bUid) => {
            const s = (window as any).VoiceManager._debug.state;
            const pc = s.peers[bUid];
            return pc.getStats().then((stats: any) => {
                let decoded = 0;
                stats.forEach((r: any) => {
                    if (r.type === 'inbound-rtp' && r.kind === 'video') decoded += r.framesDecoded || 0;
                });
                return decoded;
            });
        }, bodyB.user.id);
        expect(healthy).toBeGreaterThan(0);

        // Simulate the receiver-side black feed: inbound video reports 0 frames
        // decoded (packets DO arrive — a decrypt/decode failure), while our own
        // outbound keeps encoding. The RECEIVER-side watchdog must fire.
        const armed = await pageA.evaluate((bUid) => {
            const s = (window as any).VoiceManager._debug.state;
            const pc = s.peers[bUid];
            if (!pc || !pc._videoWatchTimer) return null;
            const origNeg = pc.onnegotiationneeded;
            (window as any).__negFires = 0;
            pc.onnegotiationneeded = function (...args: any[]) {
                (window as any).__negFires++;
                return origNeg.apply(pc, args);
            };
            const origSend = (window as any).VoiceManager._debug.state.send;
            (window as any).__stateSent = 0;
            // Count sendVoiceState broadcasts (the gate re-sync signal).
            const vm = (window as any).VoiceManager;
            const dbg = vm._debug;
            const origSendState = dbg.state.sendVoiceState || null;
            (window as any).__stateSent = 0;
            (window as any).__origGetStats = pc.getStats;
            pc.getStats = function () {
                return Promise.resolve([
                    // Our outbound video still encodes (sender side is fine)
                    { type: 'outbound-rtp', kind: 'video', framesEncoded: 500 },
                    { type: 'outbound-rtp', kind: 'audio', framesEncoded: 900 },
                    // The REMOTE camera: packets arrive but nothing decodes
                    { type: 'inbound-rtp', kind: 'video', framesDecoded: 0, packetsReceived: 200 },
                    // Remote audio healthy (must NOT trip the audio check alone)
                    { type: 'inbound-rtp', kind: 'audio', framesDecoded: 0, packetsReceived: 400 },
                ]);
            };
            return { ok: true };
        }, bodyB.user.id);
        expect(armed).toBeTruthy();

        // Watchdog fires a renegotiation by itself (~2 checks × 4s).
        await pageA.waitForFunction(() => (window as any).__negFires >= 1, undefined, { timeout: 25000 });
        // And shows the Reconnecting toast.
        await pageA.waitForFunction(() => {
            const t = document.getElementById('voice-reconnect-toast');
            return t && (t as HTMLElement).style.display === 'flex';
        }, undefined, { timeout: 20000 });

        // Restore real getStats so media continues normally.
        await pageA.evaluate((bUid) => {
            const s = (window as any).VoiceManager._debug.state;
            const pc = s.peers[bUid];
            if (pc && (window as any).__origGetStats) pc.getStats = (window as any).__origGetStats;
        }, bodyB.user.id);

        // The renegotiation completes and inbound video decodes again.
        await pageA.waitForFunction((bUid) => {
            const s = (window as any).VoiceManager._debug.state;
            const pc = s.peers[bUid];
            return pc && (pc.signalingState === 'stable' || pc.connectionState === 'connected');
        }, bodyB.user.id, { timeout: 25000 });
        await pageA.waitForTimeout(6000);
        const decodedAfter = await pageA.evaluate((bUid) => {
            const s = (window as any).VoiceManager._debug.state;
            const pc = s.peers[bUid];
            return pc.getStats().then((stats: any) => {
                let decoded = 0;
                stats.forEach((r: any) => {
                    if (r.type === 'inbound-rtp' && r.kind === 'video') decoded += r.framesDecoded || 0;
                });
                return decoded;
            });
        }, bodyB.user.id);
        expect(decodedAfter).toBeGreaterThan(0);

        await ctxA.close().catch(() => {});
        await ctxB.close().catch(() => {});
    });

    test('DM call: a live remote audio feed with 0 packets is flagged by the audio side of the watchdog and healed', async ({ browser }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        await mockMedia(pageA);
        await mockMedia(pageB);
        const bodyA = await registerUser(pageA, 'ra1_' + ts);
        const bodyB = await registerUser(pageB, 'ra2_' + ts);
        await setupFriends(pageA, pageB, bodyA, bodyB);
        const { userData, dm } = await createDm(pageA, pageB, bodyA, bodyB);
        await waitForWs(pageA);
        await waitForWs(pageB);
        await openDm(pageA);
        await startDmCall(pageA, pageB, dm, userData.id, bodyB.user.username);
        await pageA.waitForTimeout(3000);

        // Audio is flowing normally first.
        const audioOk = await pageA.evaluate((bUid) => {
            const s = (window as any).VoiceManager._debug.state;
            const pc = s.peers[bUid];
            return pc.getStats().then((stats: any) => {
                let pkts = 0;
                stats.forEach((r: any) => {
                    if (r.type === 'inbound-rtp' && r.kind === 'audio') pkts += r.packetsReceived || 0;
                });
                return pkts;
            });
        }, bodyB.user.id);
        expect(audioOk).toBeGreaterThan(0);

        // Kill the inbound audio: 0 packets + 0 decoded. The audio side of the
        // watchdog must fire and heal.
        const armed = await pageA.evaluate((bUid) => {
            const s = (window as any).VoiceManager._debug.state;
            const pc = s.peers[bUid];
            if (!pc || !pc._videoWatchTimer) return null;
            const origNeg = pc.onnegotiationneeded;
            (window as any).__negFires = 0;
            pc.onnegotiationneeded = function (...args: any[]) {
                (window as any).__negFires++;
                return origNeg.apply(pc, args);
            };
            (window as any).__origGetStats = pc.getStats;
            pc.getStats = function () {
                return Promise.resolve([
                    { type: 'outbound-rtp', kind: 'audio', framesEncoded: 900 },
                    // Remote audio: NOTHING arrives (the one-way gap signature)
                    { type: 'inbound-rtp', kind: 'audio', framesDecoded: 0, packetsReceived: 0 },
                ]);
            };
            return { ok: true };
        }, bodyB.user.id);
        expect(armed).toBeTruthy();

        await pageA.waitForFunction(() => (window as any).__negFires >= 1, undefined, { timeout: 25000 });
        await pageA.waitForFunction(() => {
            const t = document.getElementById('voice-reconnect-toast');
            return t && (t as HTMLElement).style.display === 'flex';
        }, undefined, { timeout: 20000 });

        await pageA.evaluate((bUid) => {
            const s = (window as any).VoiceManager._debug.state;
            const pc = s.peers[bUid];
            if (pc && (window as any).__origGetStats) pc.getStats = (window as any).__origGetStats;
        }, bodyB.user.id);
        await pageA.waitForTimeout(6000);
        const audioAfter = await pageA.evaluate((bUid) => {
            const s = (window as any).VoiceManager._debug.state;
            const pc = s.peers[bUid];
            return pc.getStats().then((stats: any) => {
                let pkts = 0;
                stats.forEach((r: any) => {
                    if (r.type === 'inbound-rtp' && r.kind === 'audio') pkts += r.packetsReceived || 0;
                });
                return pkts;
            });
        }, bodyB.user.id);
        expect(audioAfter).toBeGreaterThan(0);

        await ctxA.close().catch(() => {});
        await ctxB.close().catch(() => {});
    });
});
