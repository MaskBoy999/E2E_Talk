import { test } from '@playwright/test';

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

test('probe: does the callee EVER receive video packets in a DM call?', async ({ browser }) => {
    test.setTimeout(240000);
    const ts = Date.now();
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await mockMedia(pageA);
    await mockMedia(pageB);
    const bodyA = await registerUser(pageA, 'pva_' + ts);
    const bodyB = await registerUser(pageB, 'pvb_' + ts);
    await waitForWs(pageA);
    await waitForWs(pageB);
    await setupFriends(pageA, pageB, bodyA, bodyB);
    const { userData, dm } = await createDm(pageA, pageB, bodyA, bodyB);
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

    // A: camera ON.
    await pageA.evaluate(() => (window as any).VoiceManager.toggleCamera());
    await pageA.waitForFunction(() => (window as any).VoiceManager._debug.state.cameraOn, undefined, { timeout: 20000 });
    await pageA.waitForTimeout(3000);

    // Sample sender packetsSent + receiver packetsReceived every 2s.
    for (let i = 0; i < 8; i++) {
        await pageA.waitForTimeout(2000);
        const aOut = await pageA.evaluate((bUid) => {
            const pc = (window as any).VoiceManager._debug.state.peers[bUid];
            if (!pc) return null;
            return pc.getStats().then((stats: any) => {
                let out: any = null;
                stats.forEach((r: any) => {
                    if (r.type === 'outbound-rtp' && r.kind === 'video') {
                        out = { framesEncoded: r.framesEncoded, packetsSent: r.packetsSent, bytes: r.bytesSent, ssrc: r.ssrc };
                    }
                });
                return out;
            });
        }, bodyB.user.id);
        const bIn = await pageB.evaluate((aUid) => {
            const pc = (window as any).VoiceManager._debug.state.peers[aUid];
            if (!pc) return null;
            return pc.getStats().then((stats: any) => {
                const arr: any[] = [];
                stats.forEach((r: any) => {
                    if (r.type === 'inbound-rtp' && r.kind === 'video') {
                        arr.push({ ssrc: r.ssrc, packetsReceived: r.packetsReceived, framesDecoded: r.framesDecoded, bytes: r.bytesReceived, nack: r.nackCount });
                    }
                });
                const recvs = pc.getReceivers().filter((x: any) => x.track && x.track.kind === 'video').map((x: any) => ({ id: x.track.id, transform: !!x.transform, live: x.track.readyState }));
                return { inbound: arr, recvs };
            });
        }, bodyA.user.id);
        const tile = await pageB.evaluate(() => {
            const els = Array.from(document.querySelectorAll('video'));
            return els.map((v: any) => ({ ready: v.readyState, w: v.videoWidth, h: v.videoHeight, paused: v.paused, src: (v.srcObject ? 'obj' : v.src) }));
        });
        console.log('PROBE_RV[sample' + i + ']', JSON.stringify({ aOut, bIn, tile }));
    }
});
