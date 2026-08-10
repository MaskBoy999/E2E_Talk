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
async function startDmCall(page: any, page2: any, dm: any, partnerUid: string, partnerName: string) {
    await page.evaluate(({ dmId, uid, uname }) => { window.VoiceManager.startDmCall(dmId, uid, uname); }, { dmId: dm.id, uid: partnerUid, uname: partnerName });
    await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });
    await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 20000 });
    await page2.click('#incoming-call-accept');
    await page.waitForFunction(() => (window as any).VoiceManager._debug.state.connected, undefined, { timeout: 20000 });
    await page2.waitForFunction(() => (window as any).VoiceManager._debug.state.connected, undefined, { timeout: 20000 });
}

test('probe: programmatic DM call, watchdog OFF, does the receiver ever get video?', async ({ browser }) => {
    test.setTimeout(240000);
    const ts = Date.now();
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await mockMedia(pageA);
    await mockMedia(pageB);
    const bodyA = await registerUser(pageA, 'pfa_' + ts);
    const bodyB = await registerUser(pageB, 'pfb_' + ts);
    await waitForWs(pageA);
    await waitForWs(pageB);
    await setupFriends(pageA, pageB, bodyA, bodyB);
    const { userData, dm } = await createDm(pageA, pageB, bodyA, bodyB);
    await openDm(pageA);
    await startDmCall(pageA, pageB, dm, userData.id, bodyB.user.username);

    // Watchdog OFF entirely.
    await pageA.evaluate(() => (window as any).VoiceManager.setVideoWatchdogSecs(0));
    await pageA.evaluate(() => (window as any).VoiceManager.toggleCamera());
    await pageA.waitForFunction(() => (window as any).VoiceManager._debug.state.cameraOn, undefined, { timeout: 20000 });

    for (let i = 0; i < 8; i++) {
        await pageA.waitForTimeout(2000);
        const bIn = await pageB.evaluate((aUid) => {
            const pc = (window as any).VoiceManager._debug.state.peers[aUid];
            if (!pc) return null;
            return pc.getStats().then((stats: any) => {
                const arr: any[] = [];
                stats.forEach((r: any) => {
                    if (r.type === 'inbound-rtp' && r.kind === 'video') arr.push({ packetsReceived: r.packetsReceived, framesDecoded: r.framesDecoded });
                });
                const recvs = pc.getReceivers().filter((x: any) => x.track && x.track.kind === 'video').map((x: any) => ({ id: (x.track.id || '').slice(0, 6), transform: !!x.transform, live: x.track.readyState }));
                return { inbound: arr, recvs };
            });
        }, bodyA.user.id);
        console.log('PROBE_PF[s' + i + ']', JSON.stringify(bIn));
    }
});
