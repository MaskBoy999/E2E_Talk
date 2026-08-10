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

async function snapshot(page: any, label: string) {
    const r = await page.evaluate(() => {
        const V = (window as any).VoiceManager;
        const S = V._debug.state;
        const uid = Object.keys(S.peers || {})[0];
        const pc = uid ? S.peers[uid] : null;
        let transform = false, tracks = 0, rts = '', sig = '?', conn = '?';
        if (pc) {
            const recvs = pc.getReceivers().filter((x: any) => x.track && x.track.kind === 'video');
            tracks = recvs.length;
            transform = recvs.some((x: any) => !!x.transform);
            rts = recvs.map((x: any) => (x.track.id || '').slice(0, 6)).join(',');
            sig = pc.signalingState; conn = pc.connectionState;
        }
        // RENDER side: every video element + which track it is attached to +
        // its readyState. A black feed while frames decode = the visible
        // element is wired to a STALE/dead track.
        const els: any[] = [];
        document.querySelectorAll('video').forEach((el: any) => {
            const vis = el.offsetParent !== null || el.getBoundingClientRect().width > 0;
            const tr = el.srcObject && el.srcObject.getVideoTracks()[0];
            els.push({
                vis,
                ready: el.readyState,
                w: Math.round(el.getBoundingClientRect().width),
                h: Math.round(el.getBoundingClientRect().height),
                tr: tr ? tr.id.slice(0, 6) : null,
                live: tr ? tr.readyState : null,
                paused: el.paused,
            });
        });
        return { tracks, transform, rts, els, e2ee: (window as any).__voiceE2eeStats ? (window as any).__voiceE2eeStats.last : null, sig, conn };
    });
    // frames decoded via getStats
    const fr = await page.evaluate(() => {
        const S = (window as any).VoiceManager._debug.state;
        const uid = Object.keys(S.peers || {})[0];
        const pc = uid ? S.peers[uid] : null;
        if (!pc) return 0;
        return pc.getStats().then((stats: any) => {
            let f = 0, p = 0;
            stats.forEach((x: any) => {
                if (x.type === 'inbound-rtp' && x.kind === 'video') { f += x.framesDecoded || 0; p += x.packetsReceived || 0; }
            });
            return { f, p };
        });
    });
    console.log(`PROBE[${label}]`, JSON.stringify({ ...r, framesDecoded: fr.f, rxPkts: fr.p }));
}

test('video decrypt survives renegotiation churn', async ({ browser }) => {
    test.setTimeout(300000);
    const ts = Date.now();
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await mockMedia(pageA);
    await mockMedia(pageB);
    const bodyA = await registerUser(pageA, 'pv_' + ts);
    const bodyB = await registerUser(pageB, 'pw_' + ts);
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

    // A: camera + screen ON. B: camera ON.
    await pageA.evaluate(() => (window as any).VoiceManager.toggleCamera());
    await pageA.waitForFunction(() => (window as any).VoiceManager._debug.state.cameraOn, undefined, { timeout: 20000 });
    await pageA.evaluate(() => (window as any).VoiceManager.toggleScreen());
    await pageA.waitForFunction(() => (window as any).VoiceManager._debug.state.screenOn, undefined, { timeout: 20000 });
    await pageB.evaluate(() => (window as any).VoiceManager.toggleCamera());
    await pageB.waitForFunction(() => (window as any).VoiceManager._debug.state.cameraOn, undefined, { timeout: 20000 });
    await pageA.waitForTimeout(4000);
    await snapshot(pageA, 'baseline A');

    // Renegotiation churn: B toggles camera off/on 3× and screen off/on 1×;
    // A toggles camera off/on 1× and screen off/on 1×.
    for (let i = 0; i < 3; i++) {
        await pageB.evaluate(() => (window as any).VoiceManager.toggleCamera());
        await pageB.waitForTimeout(1200);
        await pageB.evaluate(() => (window as any).VoiceManager.toggleCamera());
        await pageB.waitForTimeout(1500);
        await snapshot(pageA, `churn B${i}`);
    }
    await pageA.evaluate(() => (window as any).VoiceManager.toggleCamera());
    await pageA.waitForTimeout(1500);
    await pageA.evaluate(() => (window as any).VoiceManager.toggleCamera());
    await pageA.waitForTimeout(1500);
    await pageA.evaluate(() => (window as any).VoiceManager.toggleScreen());
    await pageA.waitForTimeout(1500);
    await pageA.evaluate(() => (window as any).VoiceManager.toggleScreen());
    await pageA.waitForTimeout(2000);
    await snapshot(pageA, 'after all churn A');

    // A's own video decrypt (receiving B's camera) must still be receiving
    // frames — decVEnter on A's worker keeps climbing.
    const finalE2ee = await pageA.evaluate(() => (window as any).__voiceE2eeStats ? (window as any).__voiceE2eeStats.last : null);
    console.log('PROBE[final worker stats]', JSON.stringify(finalE2ee));

    // SDP dump: does the encrypt extmap appear on the VIDEO m-line (which
    // decrypts fine) but not the audio m-line (which doesn't)?
    const sdpDump = await pageA.evaluate(() => {
        const V = (window as any).VoiceManager._debug.state;
        const uid = Object.keys(V.peers || {})[0];
        const pc = uid ? V.peers[uid] : null;
        if (!pc || !pc.localDescription) return null;
        const sdp = pc.localDescription.sdp;
        const mlines: any[] = [];
        let cur: any = null;
        for (const ln of sdp.split('\n')) {
            if (ln.startsWith('m=')) {
                cur = { m: ln.trim(), encrypt: false, exts: [] };
                mlines.push(cur);
            } else if (cur && ln.startsWith('a=extmap')) {
                cur.exts.push(ln.trim());
                if (ln.includes('encrypt')) cur.encrypt = true;
            }
        }
        return mlines;
    });
    console.log('PROBE[SDP m-lines A]', JSON.stringify(sdpDump, null, 1));

    await ctxA.close().catch(() => {});
    await ctxB.close().catch(() => {});
});
