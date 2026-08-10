import { test, expect } from '@playwright/test';
const BASE = 'https://localhost:3443';

test('probe: what does the watchdog see', async ({ browser }) => {
    test.setTimeout(120000);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.addInitScript(() => {
        (window as any).__enableVoiceAudioDebug = true;
    });
    await pageB.addInitScript(() => {
        (window as any).__enableVoiceAudioDebug = true;
    });
    const register = async (page: any, username: string) => {
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        return await page.evaluate(() => ({ token: localStorage.getItem('token'), user: JSON.parse(localStorage.getItem('user') || '{}') }));
    };
    const waitWs = (page: any) => page.evaluate(() => new Promise((res) => { let t = 0; const c = () => { t++; if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) res(true); else if (t >= 60) res(false); else setTimeout(c, 200); }; setTimeout(c, 500); }));
    const friends = async (p1: any, p2: any, b1: any, b2: any) => {
        const fc2 = await p2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        await p1.request.post(`${BASE}/api/friends/request`, { headers: { Authorization: `Bearer ${b1.token}`, 'Content-Type': 'application/json' }, data: { friend_code: fc2 } });
        const incoming = await (await p2.request.get(`${BASE}/api/friends/requests/incoming`, { headers: { Authorization: `Bearer ${b2.token}` } })).json();
        await p2.request.post(`${BASE}/api/friends/requests/accept`, { headers: { Authorization: `Bearer ${b2.token}`, 'Content-Type': 'application/json' }, data: { request_id: incoming[0].id } });
    };
    const ts = Date.now();
    const b1 = await register(pageA, 'wp1_' + ts);
    const b2 = await register(pageB, 'wp2_' + ts);
    await friends(pageA, pageB, b1, b2);
    const userData = await (await pageA.request.get(`${BASE}/api/user/${b2.user.username}`, { headers: { Authorization: `Bearer ${b1.token}` } })).json();
    const dm = await (await pageA.request.post(`${BASE}/api/dm/${userData.id}`, { headers: { Authorization: `Bearer ${b1.token}` } })).json();
    await waitWs(pageA); await waitWs(pageB);
    await pageA.click('#dm-strip-btn').catch(() => {});
    await pageA.waitForTimeout(800);
    for (let i = 0; i < 40; i++) {
        const conv = pageA.locator('.dm-item, .dm-conv, [data-dm-id]');
        if (await conv.count()) { await conv.first().click().catch(() => {}); await pageA.waitForTimeout(800); break; }
        await pageA.waitForTimeout(300);
    }
    await pageA.evaluate(({ dmId, uid, uname }) => { window.VoiceManager.startDmCall(dmId, uid, uname); }, { dmId: dm.id, uid: userData.id, uname: b2.user.username });
    await pageA.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });
    await pageB.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 20000 });
    await pageB.click('#incoming-call-accept');
    await pageA.waitForFunction(() => (window as any).VoiceManager._debug.state.connected, undefined, { timeout: 20000 });
    await pageA.waitForTimeout(5000);

    // Arm the stub + instrument
    const info = await pageA.evaluate((bUid) => {
        const s = (window as any).VoiceManager._debug.state;
        const pc = s.peers[bUid];
        if (!pc) return { err: 'no peer' };
        const threshold = pc._videoWatchThreshold;
        const timerAlive = !!pc._videoWatchTimer;
        const recvs = pc.getReceivers().map((r: any) => ({ kind: r.track && r.track.kind, state: r.track && r.track.readyState, t: !!r.transform }));
        // Patch getStats to log what the watchdog asks
        (window as any).__calls = [];
        const orig = pc.getStats;
        pc.getStats = function () {
            return Promise.resolve([
                { type: 'outbound-rtp', kind: 'video', framesEncoded: 500 },
                { type: 'outbound-rtp', kind: 'audio', framesEncoded: 900 },
                { type: 'inbound-rtp', kind: 'video', framesDecoded: 0, packetsReceived: 200 },
                { type: 'inbound-rtp', kind: 'audio', framesDecoded: 0, packetsReceived: 400 },
            ]);
        };
        return { threshold, timerAlive, recvs, hasVideoWatch: 'videoWatchCount' in pc };
    }, b2.user.id);
    console.log('PROBE[info]', JSON.stringify(info));

    await pageA.waitForTimeout(13000);
    const after = await pageA.evaluate((bUid) => {
        const s = (window as any).VoiceManager._debug.state;
        const pc = s.peers[bUid];
        return {
            count: pc._videoWatchCount,
            threshold: pc._videoWatchThreshold,
            sig: pc.signalingState,
            conn: pc.connectionState,
            toast: (() => { const t = document.getElementById('voice-reconnect-toast'); return t ? t.style.display : 'no-el'; })(),
        };
    }, b2.user.id);
    console.log('PROBE[after 13s]', JSON.stringify(after));
    expect(true).toBe(true);
});
