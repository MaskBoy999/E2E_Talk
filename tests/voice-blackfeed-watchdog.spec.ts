import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// Mocked media: getUserMedia returns an oscillator mic + a canvas camera.
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

// Count outbound video senders with framesEncoded > 0 for the peer `uid` on
// `page` (real getStats). `expectAtLeast` waits until the count reaches it.
async function encodedVideoSenders(page: any, uid: string) {
    return await page.evaluate((uid) => {
        const s = (window as any).VoiceManager._debug.state;
        const pc = s.peers[uid];
        if (!pc) return 0;
        return pc.getStats().then((stats: any) => {
            let encoded = 0;
            stats.forEach((r: any) => {
                if (r.type === 'outbound-rtp' && r.kind === 'video' && (r.framesEncoded || 0) > 0) encoded++;
            });
            return encoded;
        });
    }, uid);
}

async function waitEncodedVideoSenders(page: any, uid: string, count: number, timeout = 45000) {
    await page.waitForFunction(({ uid, count }) => {
        const s = (window as any).VoiceManager._debug.state;
        const pc = s.peers[uid];
        if (!pc) return false;
        return pc.getStats().then((stats: any) => {
            let encoded = 0;
            stats.forEach((r: any) => {
                if (r.type === 'outbound-rtp' && r.kind === 'video' && (r.framesEncoded || 0) > 0) encoded++;
            });
            return encoded >= count;
        });
    }, { uid, count }, { timeout });
}

test.describe('black-feed watchdog', () => {

    test('DM call: a swallowed video m-line (zero-frame live sender, audio still encoding) is renegotiated by the watchdog with NO user action', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, 'wds2_' + ts);
        const body1 = await registerUser(page, 'wds1_' + ts);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await waitForWs(page);
        await waitForWs(page2);
        await openDm(page);
        await startDmCall(page, page2, dm, userData.id, body2.user.username);

        // A turns the camera on and it MUST be encoding normally first.
        await page.evaluate(() => (window as any).VoiceManager.toggleCamera());
        await page.waitForFunction(() => (window as any).VoiceManager._debug.state.cameraOn, undefined, { timeout: 20000 });
        await waitEncodedVideoSenders(page, body2.user.id, 1, 45000);

        // Simulate the swallowed-m-line condition deterministically: the camera
        // sender stays LIVE but its outbound-rtp reports 0 framesEncoded, while
        // the audio sender keeps encoding. This is exactly the state the OLD
        // aggregate watchdog missed (anyEncoded=true from the audio) — the
        // per-sender watchdog must detect the dead VIDEO sender on its own.
        const armed = await page.evaluate((bUid) => {
            const s = (window as any).VoiceManager._debug.state;
            const pc = s.peers[bUid];
            if (!pc) return null;
            const cam = pc.getSenders().find((snd: any) => snd.track && snd.track.kind === 'video');
            if (!cam) return null;
            if (!pc._videoWatchTimer) return null;
            const camId = cam.track.id;
            // Count watchdog-driven renegotiations.
            const origNeg = pc.onnegotiationneeded;
            (window as any).__negFires = 0;
            pc.onnegotiationneeded = function (...args: any[]) {
                (window as any).__negFires++;
                return origNeg.apply(pc, args);
            };
            // Stub getStats: camera video = 0 frames, audio = encoding.
            (window as any).__origGetStats = pc.getStats;
            pc.getStats = function () {
                return Promise.resolve([
                    { type: 'outbound-rtp', kind: 'video', trackId: camId, framesEncoded: 0 },
                    { type: 'outbound-rtp', kind: 'audio', trackId: 'mic-audio-fake', framesEncoded: 500 },
                ]);
            };
            return { camId, negFires: 0 };
        }, body2.user.id);
        expect(armed).toBeTruthy();

        // The watchdog must fire a renegotiation BY ITSELF (~2 checks × 4s).
        await page.waitForFunction(() => (window as any).__negFires >= 1, undefined, { timeout: 25000 });
        const firesAtFire = await page.evaluate(() => (window as any).__negFires);
        expect(firesAtFire).toBeGreaterThanOrEqual(1);

        // The watchdog also surfaced the "Reconnecting video…" toast so the
        // user understands the brief freeze. (__negFires also counts NATURAL
        // renegotiations like ICE restarts, so wait for the toast itself — the
        // watchdog's unique side effect — rather than assuming the first
        // onnegotiationneeded was watchdog-driven.)
        await page.waitForFunction(() => {
            const t = document.getElementById('voice-reconnect-toast');
            return t && (t as HTMLElement).style.display === 'flex';
        }, undefined, { timeout: 20000 });

        // Restore the real getStats so the next check sees normal encoding.
        await page.evaluate(() => {
            const s = (window as any).VoiceManager._debug.state;
            const uid = Object.keys(s.peers)[0];
            const pc = s.peers[uid];
            if (pc && (window as any).__origGetStats) {
                pc.getStats = (window as any).__origGetStats;
            }
        });

        // The renegotiation must COMPLETE (signalingState back to stable) and
        // the camera must encode again — all without toggling the camera.
        await page.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            const uid = Object.keys(s.peers)[0];
            const pc = s.peers[uid];
            return pc && (pc.signalingState === 'stable' || pc.connectionState === 'connected');
        }, undefined, { timeout: 20000 });
        await waitEncodedVideoSenders(page, body2.user.id, 1, 45000);

        // And the peer stayed healthy for B (media still flows after the
        // watchdog-triggered renegotiation).
        await page2.waitForFunction((aUid) => {
            const s = (window as any).VoiceManager._debug.state;
            return s.peers[aUid] && s.remoteStreams[aUid] && s.remoteStreams[aUid].camera;
        }, body1.user.id, { timeout: 20000 });

        await ctx2.close();
    });

    test('DM call: camera + screen share BOTH on — both video senders end up encoding (neither stuck black)', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, 'wdb2_' + ts);
        const body1 = await registerUser(page, 'wdb1_' + ts);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await waitForWs(page);
        await waitForWs(page2);
        await openDm(page);
        await startDmCall(page, page2, dm, userData.id, body2.user.username);

        // Both on at (roughly) the same time — the glare/rollback race window.
        await page.evaluate(() => {
            (window as any).VoiceManager.toggleCamera();
            setTimeout(() => (window as any).VoiceManager.toggleScreen(), 150);
        });
        await page.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.cameraOn && s.screenOn;
        }, undefined, { timeout: 20000 });

        // If the race swallowed one m-line, the per-sender watchdog re-adds it
        // within ~8-16s — so BOTH video senders must be encoding within 45s.
        await waitEncodedVideoSenders(page, body2.user.id, 2, 45000);

        // Both feeds actually reach B.
        await page2.waitForFunction((aUid) => {
            const s = (window as any).VoiceManager._debug.state;
            const rs = s.remoteStreams[aUid];
            return rs && rs.camera && rs.screen;
        }, body1.user.id, { timeout: 30000 });

        await ctx2.close();
    });

    test('DM call: watchdog interval is configurable — 4s fires faster and shows the Reconnecting video chip', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, 'wdc2_' + ts);
        const body1 = await registerUser(page, 'wdc1_' + ts);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await waitForWs(page);
        await waitForWs(page2);
        await openDm(page);
        await startDmCall(page, page2, dm, userData.id, body2.user.username);

        // Default is 8s; make it 4s (one 4s check) and confirm persistence.
        const def = await page.evaluate(() => (window as any).VoiceManager.getState().settings.videoWatchdogSecs);
        expect(def).toBe(8);
        await page.evaluate(() => (window as any).VoiceManager.setVideoWatchdogSecs(4));
        const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('voice_settings') || '{}').videoWatchdogSecs);
        expect(persisted).toBe(4);

        await page.evaluate(() => (window as any).VoiceManager.toggleCamera());
        await page.waitForFunction(() => (window as any).VoiceManager._debug.state.cameraOn, undefined, { timeout: 20000 });
        await waitEncodedVideoSenders(page, body2.user.id, 1, 45000);

        // Simulate the zero-frame condition; with a 4s window the watchdog
        // fires after a SINGLE check (~4s), faster than the 8s default.
        const armed = await page.evaluate((bUid) => {
            const s = (window as any).VoiceManager._debug.state;
            const pc = s.peers[bUid];
            if (!pc) return null;
            const cam = pc.getSenders().find((snd: any) => snd.track && snd.track.kind === 'video');
            if (!cam || !pc._videoWatchTimer || pc._videoWatchThreshold !== 1) return null;
            const camId = cam.track.id;
            const origNeg = pc.onnegotiationneeded;
            (window as any).__negFires = 0;
            pc.onnegotiationneeded = function (...args: any[]) {
                (window as any).__negFires++;
                return origNeg.apply(pc, args);
            };
            (window as any).__origGetStats = pc.getStats;
            pc.getStats = function () {
                return Promise.resolve([
                    { type: 'outbound-rtp', kind: 'video', trackId: camId, framesEncoded: 0 },
                    { type: 'outbound-rtp', kind: 'audio', trackId: 'mic-audio-fake', framesEncoded: 500 },
                ]);
            };
            return true;
        }, body2.user.id);
        expect(armed).toBeTruthy();

        // Fires on its own within ~4-8s and shows the chip. Wait for the toast
        // directly (the watchdog's unique side effect) rather than __negFires,
        // which also counts natural renegotiations.
        await page.waitForFunction(() => (window as any).__negFires >= 1, undefined, { timeout: 15000 });
        await page.waitForFunction(() => {
            const t = document.getElementById('voice-reconnect-toast');
            return t && (t as HTMLElement).style.display === 'flex';
        }, undefined, { timeout: 15000 });

        // Restore; the chip auto-hides ~6s after the LAST show. The watchdog
        // may legitimately fire once or twice more while the mock encoder
        // resumes after the renegotiation (re-showing the chip) — so first
        // wait for the camera to encode again, THEN the chip must hide.
        await page.evaluate(() => {
            const s = (window as any).VoiceManager._debug.state;
            const uid = Object.keys(s.peers)[0];
            const pc = s.peers[uid];
            if (pc && (window as any).__origGetStats) pc.getStats = (window as any).__origGetStats;
        });
        await waitEncodedVideoSenders(page, body2.user.id, 1, 45000);
        // DEBUG: dump the watchdog's last computation + progress map after restore.
        for (let i = 0; i < 6; i++) {
            await page.waitForTimeout(2000);
            const d = await page.evaluate(() => {
                const s = (window as any).VoiceManager._debug.state;
                const uid = Object.keys(s.peers)[0];
                const pc = s.peers[uid];
                const chip = document.getElementById('voice-reconnect-toast');
                return { watch: pc ? pc.__lastWatch : null, prog: pc ? pc._recvProgress : null, neg: (window as any).__negFires, toast: chip ? chip.style.display : 'no-el' };
            });
            console.log('WD_DBG[s' + i + ']', JSON.stringify(d));
        }
        await page.waitForFunction(() => {
            const chip = document.getElementById('voice-reconnect-toast');
            return !chip || (chip as HTMLElement).style.display === 'none';
        }, undefined, { timeout: 25000 });

        await ctx2.close();
    });

    test('DM call: watchdog disabled (0s) never renegotiates, no chip', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, 'wdz2_' + ts);
        const body1 = await registerUser(page, 'wdz1_' + ts);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await waitForWs(page);
        await waitForWs(page2);
        await openDm(page);
        await startDmCall(page, page2, dm, userData.id, body2.user.username);

        await page.evaluate(() => (window as any).VoiceManager.toggleCamera());
        await page.waitForFunction(() => (window as any).VoiceManager._debug.state.cameraOn, undefined, { timeout: 20000 });
        await waitEncodedVideoSenders(page, body2.user.id, 1, 45000);

        // Disable the watchdog and confirm the threshold is 0.
        await page.evaluate(() => (window as any).VoiceManager.setVideoWatchdogSecs(0));
        const armed = await page.evaluate((bUid) => {
            const s = (window as any).VoiceManager._debug.state;
            const pc = s.peers[bUid];
            if (!pc) return null;
            if (pc._videoWatchThreshold !== 0) return null;
            const cam = pc.getSenders().find((snd: any) => snd.track && snd.track.kind === 'video');
            if (!cam) return null;
            const camId = cam.track.id;
            const origNeg = pc.onnegotiationneeded;
            (window as any).__negFires = 0;
            pc.onnegotiationneeded = function (...args: any[]) {
                (window as any).__negFires++;
                return origNeg.apply(pc, args);
            };
            (window as any).__origGetStats = pc.getStats;
            pc.getStats = function () {
                return Promise.resolve([
                    { type: 'outbound-rtp', kind: 'video', trackId: camId, framesEncoded: 0 },
                    { type: 'outbound-rtp', kind: 'audio', trackId: 'mic-audio-fake', framesEncoded: 500 },
                ]);
            };
            return true;
        }, body2.user.id);
        expect(armed).toBeTruthy();

        // Let two full check intervals pass (~9s) — the watchdog must stay
        // silent (never accumulate a zero-frame count) and the chip must never
        // appear. Note: __negFires is NOT asserted here — other mechanisms
        // (e.g. the stuck-peer ICE watchdog) can renegotiate naturally; the
        // video watchdog's discriminator is _videoWatchCount, which must stay 0.
        await page.waitForTimeout(9500);
        const state = await page.evaluate(() => {
            const s = (window as any).VoiceManager._debug.state;
            const uid = Object.keys(s.peers)[0];
            const pc = s.peers[uid];
            return {
                videoWatchCount: pc ? pc._videoWatchCount || 0 : -1,
                chip: (() => {
                    const t = document.getElementById('voice-reconnect-toast');
                    return !!t && (t as HTMLElement).style.display === 'flex';
                })(),
            };
        });
        expect(state.videoWatchCount).toBe(0);
        expect(state.chip).toBe(false);

        // Restore getStats.
        await page.evaluate(() => {
            const s = (window as any).VoiceManager._debug.state;
            const uid = Object.keys(s.peers)[0];
            const pc = s.peers[uid];
            if (pc && (window as any).__origGetStats) pc.getStats = (window as any).__origGetStats;
        });
        await ctx2.close();
    });
});
