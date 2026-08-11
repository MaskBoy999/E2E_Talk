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
                return dest.stream;
            }
            if (constraints && constraints.video) {
                const canvas = document.createElement('canvas');
                canvas.width = 320; canvas.height = 240;
                const ctx = canvas.getContext('2d')!;
                let i = 0;
                setInterval(() => {
                    ctx.fillStyle = `rgb(${(i * 40) % 255},100,150)`;
                    ctx.fillRect(0, 0, 320, 240);
                    ctx.fillStyle = '#fff';
                    ctx.fillText(String(i++), 10, 20);
                }, 80);
                return (canvas as any).captureStream(10);
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

// Visible feed buttons (display != none) on B's DM call view, keyed by feed.
async function visibleButtons(page2: any, aUid: string) {
    return await page2.evaluate((uid) => {
        const btns = Array.from(document.querySelectorAll('.dm-call-tile .voice-feed-load-btn, .dm-call-tile .voice-feed-unload-btn'));
        return btns
            .filter((b) => (b as HTMLElement).style.display !== 'none')
            .map((b) => ({
                feed: b.getAttribute('data-feed'),
                cls: b.className.includes('voice-feed-load-btn') ? 'load' : 'unload',
                display: (b as HTMLElement).style.display,
                rect: (() => { const r = b.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; })(),
            }));
    }, aUid);
}

test('DM call: turning camera/screen OFF hides its Load/Unload buttons — no overlap with the remaining feed', async ({ page, context }) => {
    test.setTimeout(240000);
    const ts = Date.now();
    const user1 = 'vbtn1_' + ts;
    const user2 = 'vbtn2_' + ts;

    const ctx2 = await context.browser()!.newContext();
    const page2 = await ctx2.newPage();
    await mockMedia(page);
    await mockMedia(page2);
    const body2 = await registerUser(page2, user2);
    const body1 = await registerUser(page, user1);

    await setupFriends(page, page2, body1, body2);
    const { userData, dm } = await createDm(page, page2, body1, body2);

    await waitForWs(page);
    await waitForWs(page2);
    await openDm(page);

    await page.waitForFunction(() => {
        const v = window.VoiceManager;
        return v && typeof v.startDmCall === 'function';
    }, undefined, { timeout: 15000 });
    await page.evaluate(({ dmId, uid, uname }) => {
        window.VoiceManager.startDmCall(dmId, uid, uname);
    }, { dmId: dm.id, uid: userData.id, uname: user2 });
    await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });
    await page2.waitForFunction(() => {
        const v = window.VoiceManager as any;
        return v && v._debug && v._debug.state && v._debug.state.incomingCall !== null;
    }, undefined, { timeout: 20000 });
    await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 10000 });
    await page2.click('#incoming-call-accept');
    await page.waitForFunction(() => {
        const v = window.VoiceManager;
        return v && v._debug && v._debug.state && v._debug.state.connected;
    }, undefined, { timeout: 20000 });
    await page2.waitForFunction(() => {
        const v = window.VoiceManager;
        return v && v._debug && v._debug.state && v._debug.state.connected;
    }, undefined, { timeout: 20000 });
    const aUid = body1.user.id;
    await page2.waitForFunction((uid) => {
        const s = (window.VoiceManager as any)._debug.state;
        return !!s.peers[uid];
    }, aUid, { timeout: 15000 });

    // A: camera + screen ON. B sees both tiles with BOTH unload buttons.
    await page.evaluate(() => (window.VoiceManager as any).toggleCamera());
    await page.waitForFunction(() => {
        const s = (window.VoiceManager as any)._debug.state;
        return s.cameraOn;
    }, undefined, { timeout: 15000 });
    await page.evaluate(() => (window.VoiceManager as any).toggleScreen());
    await page.waitForFunction(() => {
        const s = (window.VoiceManager as any)._debug.state;
        return s.screenOn;
    }, undefined, { timeout: 15000 });
    await page2.waitForFunction((uid) => {
        const s = (window.VoiceManager as any)._debug.state;
        const rs = s.remoteStreams[uid];
        return rs && rs.camera && rs.screen;
    }, aUid, { timeout: 25000 });
    // Loaded feeds show their Unload button
    await page2.waitForFunction((uid) => {
        const sel = `.dm-call-tile .voice-feed-unload-btn[data-feed="${uid}:screen"]`;
        const b = document.querySelector(sel) as HTMLElement | null;
        return b && b.style.display !== 'none';
    }, aUid, { timeout: 10000 });

    let btns = await visibleButtons(page2, aUid);
    console.log('BOTH-ON unload buttons:', JSON.stringify(btns.map((b: any) => b.feed)));
    expect(btns.filter((b: any) => b.cls === 'unload').length).toBe(2);

    // ---- A turns the SCREEN OFF -> B's screen tile hides, its buttons must disappear ----
    await page.evaluate(() => (window.VoiceManager as any).toggleScreen());
    await page.waitForFunction(() => {
        const s = (window.VoiceManager as any)._debug.state;
        return !s.screenOn;
    }, undefined, { timeout: 15000 });
    // B's screen tile becomes hidden (voice_state round trip)
    await page2.waitForFunction((uid) => {
        const v = document.querySelector(`.dm-call-tile video[data-kind="screen"][data-uid="${uid}"]`);
        return v && (v as HTMLElement).style.display === 'none';
    }, aUid, { timeout: 15000 });

    // Give the button re-evaluation a beat (attach runs on re-render/feed change)
    await page2.waitForTimeout(600);
    btns = await visibleButtons(page2, aUid);
    console.log('SCREEN-OFF visible buttons:', JSON.stringify(btns));
    const screenFeeds = btns.filter((b: any) => String(b.feed).endsWith(':screen'));
    expect(screenFeeds.length).toBe(0); // no stale screen button
    const camBtns = btns.filter((b: any) => String(b.feed).endsWith(':camera'));
    expect(camBtns.length).toBe(1);     // camera's unload still there
    // The remaining button is not overlapping anything: exactly one visible button
    expect(btns.length).toBe(1);

    // ---- Manual-load ON: camera OFF (it is still on from the phase above),
    // screen OFF -> nothing to hold; then A turns the SCREEN back on -> only
    // the screen is held behind a Load button (no camera button at all). ----
    await page2.evaluate(() => (window.VoiceManager as any).setManualVideoLoad(true));
    // Camera is ON right now -> turn it OFF.
    await page.evaluate(() => (window.VoiceManager as any).toggleCamera());
    await page.waitForFunction(() => {
        const s = (window.VoiceManager as any)._debug.state;
        return !s.cameraOn;
    }, undefined, { timeout: 15000 });
    // Screen is OFF right now -> turn it ON (held behind Load on B).
    await page.evaluate(() => (window.VoiceManager as any).toggleScreen());
    await page.waitForFunction(() => {
        const s = (window.VoiceManager as any)._debug.state;
        return s.screenOn;
    }, undefined, { timeout: 15000 });
    await page2.waitForFunction((uid) => {
        const sel = `.dm-call-tile .voice-feed-load-btn[data-feed="${uid}:screen"]`;
        const b = document.querySelector(sel) as HTMLElement | null;
        return b && b.style.display !== 'none';
    }, aUid, { timeout: 15000 });
    await page2.waitForTimeout(600);
    btns = await visibleButtons(page2, aUid);
    console.log('CAM-OFF/SCR-HELD visible buttons:', JSON.stringify(btns));
    // Only the screen's Load button is visible — the camera has NO button.
    expect(btns.length).toBe(1);
    expect(String(btns[0].feed).endsWith(':screen')).toBe(true);
    expect(btns[0].cls).toBe('load');

    // ---- Turn the CAMERA back ON -> both held, both Load buttons visible,
    // side by side without overlap. ----
    await page.evaluate(() => (window.VoiceManager as any).toggleCamera());
    await page.waitForFunction(() => {
        const s = (window.VoiceManager as any)._debug.state;
        return s.cameraOn;
    }, undefined, { timeout: 15000 });
    await page2.waitForFunction((uid) => {
        const sel = `.dm-call-tile .voice-feed-load-btn[data-feed="${uid}:camera"]`;
        const b = document.querySelector(sel) as HTMLElement | null;
        return b && b.style.display !== 'none';
    }, aUid, { timeout: 15000 });
    await page2.waitForTimeout(500);
    btns = await visibleButtons(page2, aUid);
    console.log('BOTH-HELD visible buttons:', JSON.stringify(btns));
    expect(btns.filter((b: any) => b.cls === 'load').length).toBe(2);

    // ---- A turns the CAMERA OFF again -> camera's Load button goes away ----
    await page.evaluate(() => (window.VoiceManager as any).toggleCamera());
    await page.waitForFunction(() => {
        const s = (window.VoiceManager as any)._debug.state;
        return !s.cameraOn;
    }, undefined, { timeout: 15000 });
    await page2.waitForFunction((uid) => {
        const v = document.querySelector(`.dm-call-tile video[data-kind="camera"][data-uid="${uid}"]`);
        return v && (v as HTMLElement).style.display === 'none';
    }, aUid, { timeout: 15000 });
    await page2.waitForTimeout(600);
    btns = await visibleButtons(page2, aUid);
    console.log('CAMERA-OFF visible buttons:', JSON.stringify(btns));
    const camFeeds = btns.filter((b: any) => String(b.feed).endsWith(':camera'));
    expect(camFeeds.length).toBe(0);
    expect(btns.filter((b: any) => String(b.feed).endsWith(':screen')).length).toBe(1);
    expect(btns.length).toBe(1);
    await ctx2.close();
});
