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
    return await page.evaluate(() => ({ token: localStorage.getItem('token'), user: JSON.parse(localStorage.getItem('user') || '{}') }));
}
async function waitForWs(page: any) {
    return await page.evaluate(() => new Promise((res) => { let t = 0; const c = () => { t++; if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) res(true); else if (t >= 60) res(false); else setTimeout(c, 200); }; setTimeout(c, 500); }));
}
async function setupFriends(page: any, page2: any, body1: any, body2: any) {
    const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    await page.request.post(`${BASE}/api/friends/request`, { headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' }, data: { friend_code: fc2 } });
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, { headers: { Authorization: `Bearer ${body2.token}` } })).json();
    await page2.request.post(`${BASE}/api/friends/requests/accept`, { headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' }, data: { request_id: incoming[0].id } });
}
async function createDm(page: any, page2: any, body1: any, body2: any) {
    const userData = await (await page.request.get(`${BASE}/api/user/${body2.user.username}`, { headers: { Authorization: `Bearer ${body1.token}` } })).json();
    const dm = await (await page.request.post(`${BASE}/api/dm/${userData.id}`, { headers: { Authorization: `Bearer ${body1.token}` } })).json();
    return { userData, dm };
}
async function openDm(page: any) {
    await page.click('#dm-strip-btn').catch(() => {});
    await page.waitForTimeout(800);
    for (let i = 0; i < 40; i++) {
        const conv = page.locator('.dm-item, .dm-conv, [data-dm-id]');
        if (await conv.count()) { await conv.first().click().catch(() => {}); await page.waitForTimeout(800); break; }
        await page.waitForTimeout(300);
    }
}
async function startDmCall(page: any, page2: any, dm: any, partnerUid: string, partnerName: string) {
    await page.evaluate(({ dmId, uid, uname }) => { window.VoiceManager.startDmCall(dmId, uid, uname); }, { dmId: dm.id, uid: partnerUid, uname: partnerName });
    await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });
    await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 20000 });
    await page2.click('#incoming-call-accept');
    await page.waitForFunction(() => (window as any).VoiceManager._debug.state.connected, undefined, { timeout: 20000 });
    await page2.waitForFunction(() => (window as any).VoiceManager._debug.state.connected, undefined, { timeout: 20000 });
}
async function waitEncodedVideoSenders(page: any, uid: string, count: number, timeout = 45000) {
    await page.waitForFunction(({ uid, count }) => {
        const s = (window as any).VoiceManager._debug.state;
        const pc = s.peers[uid];
        if (!pc) return false;
        return pc.getStats().then((stats: any) => {
            let encoded = 0;
            stats.forEach((r: any) => { if (r.type === 'outbound-rtp' && r.kind === 'video' && (r.framesEncoded || 0) > 0) encoded++; });
            return encoded >= count;
        });
    }, { uid, count }, { timeout });
}
test('probe 3: why does the chip stay visible', async ({ browser }) => {
    test.setTimeout(240000);
    const ts = Date.now();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await mockMedia(page);
    await mockMedia(page2);
    const body2 = await registerUser(page2, 'wdp2_' + ts);
    const body1 = await registerUser(page, 'wdp1_' + ts);
    await setupFriends(page, page2, body1, body2);
    const { userData, dm } = await createDm(page, page2, body1, body2);
    await waitForWs(page);
    await waitForWs(page2);
    await openDm(page);
    await startDmCall(page, page2, dm, userData.id, body2.user.username);
    await page.evaluate(() => (window as any).VoiceManager.setVideoWatchdogSecs(0)); // WATCHDOG OFF — isolate the camera-on renegotiation itself
    await page.evaluate(() => (window as any).VoiceManager.toggleCamera());
    await page.waitForFunction(() => (window as any).VoiceManager._debug.state.cameraOn, undefined, { timeout: 20000 });
    await waitEncodedVideoSenders(page, body2.user.id, 1, 45000);
    // BASELINE: video flows before the mock/watchdog? Wait 2 watchdog windows.
    await page.waitForTimeout(9000);
    const base = await page.evaluate((bUid) => {
        const pc = (window as any).VoiceManager._debug.state.peers[bUid];
        const el = document.querySelector('.remote-video-tile video, .dm-call-tile video, video[playsinline]');
        return { watch: pc ? pc.__lastWatch : null, elReady: el ? (el as any).readyState : -1 };
    }, body2.user.id);
    console.log('PROBE3[baseline]', JSON.stringify(base));
    const sendRecv = await page.evaluate((bUid) => {
        const V = (window as any).VoiceManager._debug.state;
        const pc = V.peers[bUid];
        return pc.getStats().then((stats: any) => {
            let out: any = null;
            stats.forEach((r: any) => {
                if (r.type === 'outbound-rtp' && r.kind === 'video') out = { framesEncoded: r.framesEncoded, packetsSent: r.packetsSent, bytesSent: r.bytesSent, ss: r.ssrc, trackId: r.trackId };
            });
            return out;
        });
    }, body2.user.id);
    const recvStats = await page2.evaluate((aUid) => {
        const V = (window as any).VoiceManager._debug.state;
        const pc = V.peers[aUid];
        return pc.getStats().then((stats: any) => {
            const arr: any[] = [];
            stats.forEach((r: any) => {
                if (r.type === 'inbound-rtp' && r.kind === 'video') arr.push({ ss: r.ssrc, packetsReceived: r.packetsReceived, framesDecoded: r.framesDecoded, bytesReceived: r.bytesReceived, trackId: r.trackId, mediaType: r.mediaType });
            });
            return arr;
        });
    }, body1.user.id);
    const remoteStreamsB = await page2.evaluate((aUid) => {
        const V = (window as any).VoiceManager._debug.state;
        return { cam: !!(V.remoteStreams && V.remoteStreams[aUid] && V.remoteStreams[aUid].camera), keys: V.remoteStreams && V.remoteStreams[aUid] ? Object.keys(V.remoteStreams[aUid]) : [] };
    }, body1.user.id);
    console.log('PROBE3[sender-out]', JSON.stringify(sendRecv));
    console.log('PROBE3[recv-in]', JSON.stringify(recvStats));
    console.log('PROBE3[recv-remoteStreams]', JSON.stringify(remoteStreamsB));
    const sdpDump = await page.evaluate((bUid) => {
        const V = (window as any).VoiceManager._debug.state;
        const pc = V.peers[bUid];
        if (!pc || !pc.localDescription) return null;
        const sdp = pc.localDescription.sdp;
        const mlines: any[] = [];
        let cur: any = null;
        for (const ln of sdp.split('\n')) {
            if (ln.startsWith('m=')) { cur = { line: ln, dir: '', mids: [], ext: [] }; mlines.push(cur); }
            else if (cur) {
                if (ln.startsWith('a=mid:')) cur.mids.push(ln);
                else if (ln.startsWith('a=send') || ln.startsWith('a=recv')) cur.dir = ln;
                else if (ln.indexOf('encrypt') > -1) cur.ext.push(ln);
            }
        }
        return { sdp: mlines, remote: pc.remoteDescription ? (() => { const r: any[] = []; let rc: any = null; for (const ln of pc.remoteDescription.sdp.split('\n')) { if (ln.startsWith('m=')) { rc = { line: ln, dir: '', mids: [] }; r.push(rc); } else if (rc) { if (ln.startsWith('a=mid:')) rc.mids.push(ln); else if (ln.startsWith('a=send') || ln.startsWith('a=recv')) rc.dir = ln; } } return r; })() : null };
    }, body2.user.id);
    console.log('PROBE3[sdpA-local]', JSON.stringify(sdpDump));
    const sdpDumpB = await page2.evaluate((aUid) => {
        const V = (window as any).VoiceManager._debug.state;
        const pc = V.peers[aUid];
        if (!pc || !pc.localDescription) return null;
        const sdp = pc.localDescription.sdp;
        const mlines: any[] = [];
        let cur: any = null;
        for (const ln of sdp.split('\n')) {
            if (ln.startsWith('m=')) { cur = { line: ln, dir: '', mids: [] }; mlines.push(cur); }
            else if (cur) { if (ln.startsWith('a=mid:')) cur.mids.push(ln); else if (ln.startsWith('a=send') || ln.startsWith('a=recv')) cur.dir = ln; }
        }
        return { sdp: mlines, remote: pc.remoteDescription ? (() => { const r: any[] = []; let rc: any = null; for (const ln of pc.remoteDescription.sdp.split('\n')) { if (ln.startsWith('m=')) { rc = { line: ln, dir: '', mids: [] }; r.push(rc); } else if (rc) { if (ln.startsWith('a=mid:')) rc.mids.push(ln); else if (ln.startsWith('a=send') || ln.startsWith('a=recv')) rc.dir = ln; } } return r; })() : null };
    }, body1.user.id);
    console.log('PROBE3[sdpB-local]', JSON.stringify(sdpDumpB));

    const armed = await page.evaluate((bUid) => {
        const s = (window as any).VoiceManager._debug.state;
        const pc = s.peers[bUid];
        const cam = pc.getSenders().find((snd: any) => snd.track && snd.track.kind === 'video');
        const camId = cam.track.id;
        const origNeg = pc.onnegotiationneeded;
        (window as any).__negFires = 0;
        pc.onnegotiationneeded = function (...args: any[]) { (window as any).__negFires++; return origNeg.apply(pc, args); };
        (window as any).__origGetStats = pc.getStats;
        pc.getStats = function () {
            return Promise.resolve([
                { type: 'outbound-rtp', kind: 'video', trackId: camId, framesEncoded: 0 },
                { type: 'outbound-rtp', kind: 'audio', trackId: 'mic-audio-fake', framesEncoded: 500 },
                { type: 'inbound-rtp', kind: 'audio', framesDecoded: 0, packetsReceived: 400 },
            ]);
        };
        return true;
    }, body2.user.id);
    expect(armed).toBeTruthy();

    await page.waitForFunction(() => (window as any).__negFires >= 1, undefined, { timeout: 15000 });
    await page.waitForFunction(() => {
        const t = document.getElementById('voice-reconnect-toast');
        return t && (t as HTMLElement).style.display === 'flex';
    }, undefined, { timeout: 15000 });

    // Restore real getStats
    await page.evaluate(() => {
        const s = (window as any).VoiceManager._debug.state;
        const uid = Object.keys(s.peers)[0];
        const pc = s.peers[uid];
        if (pc && (window as any).__origGetStats) pc.getStats = (window as any).__origGetStats;
    });
    await waitEncodedVideoSenders(page, body2.user.id, 1, 45000);

    // Sample toast + counters over the next 20s
    for (let i = 0; i < 10; i++) {
        await page.waitForTimeout(2000);
        const snap = await page.evaluate((bUid) => {
            const s = (window as any).VoiceManager._debug.state;
            const pc = s.peers[bUid];
            const t = document.getElementById('voice-reconnect-toast');
            return {
                neg: (window as any).__negFires,
                count: pc ? pc._videoWatchCount : -1,
                thresh: pc ? pc._videoWatchThreshold : -1,
                sig: pc ? pc.signalingState : '?',
                conn: pc ? pc.connectionState : '?',
                toast: t ? t.style.display : 'no-el',
                watch: pc ? pc.__lastWatch : null,
            };
        }, body2.user.id);
        console.log('PROBE3[sample]', JSON.stringify(snap));
    }
    expect(true).toBe(true);
});
