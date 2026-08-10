import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// Mocked media: oscillator mic + canvas camera. Records the VIDEO constraints
// so tests can assert the capture resolution the app requested.
async function mockMedia(page: any) {
    await page.addInitScript(() => {
        const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        (window as any).__lastVideoConstraints = null;
        (window as any).__gumCalls = [];
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
                (window as any).__lastVideoConstraints = constraints.video;
                (window as any).__gumCalls.push(JSON.parse(JSON.stringify(constraints.video)));
                const canvas = document.createElement('canvas');
                canvas.width = 640; canvas.height = 360;
                const ctx = canvas.getContext('2d')!;
                let i = 0;
                (window as any).__mockCanvasTimer = setInterval(() => {
                    ctx.fillStyle = `rgb(${(i * 40) % 255},100,150)`;
                    ctx.fillRect(0, 0, 640, 360);
                    ctx.fillStyle = '#fff';
                    ctx.fillText(String(i++), 10, 20);
                }, 80);
                const stream = (canvas as any).captureStream(10);
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
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
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

// Full DM call: A calls B, B accepts, both connected.
async function setupDmCall(page: any, page2: any, body1: any, body2: any, dm: any, userData: any) {
    await waitForWs(page);
    await waitForWs(page2);
    await openDm(page);
    await page.waitForFunction(() => {
        const v = (window as any).VoiceManager;
        return v && typeof v.startDmCall === 'function';
    }, undefined, { timeout: 15000 });
    await page.evaluate(({ dmId, uid, uname }) => {
        (window as any).VoiceManager.startDmCall(dmId, uid, uname);
    }, { dmId: dm.id, uid: userData.id, uname: body2.user.username });
    await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });
    await page2.waitForFunction(() => {
        const v = (window as any).VoiceManager as any;
        return v && v._debug && v._debug.state && v._debug.state.incomingCall !== null;
    }, undefined, { timeout: 20000 });
    await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 10000 });
    await page2.click('#incoming-call-accept');
    await page.waitForFunction(() => {
        const v = (window as any).VoiceManager;
        return v && v._debug && v._debug.state && v._debug.state.connected;
    }, undefined, { timeout: 20000 });
    await page2.waitForFunction(() => {
        const v = (window as any).VoiceManager;
        return v && v._debug && v._debug.state && v._debug.state.connected;
    }, undefined, { timeout: 20000 });
    // Make sure B is in the DM view so its call panel renders the partner tiles.
    await openDm(page2);
    await page2.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });
    // A's uid on B's page is body1.user.id.
    await page2.waitForFunction((uid) => {
        const s = (window.VoiceManager as any)._debug.state;
        return !!s.peers[uid];
    }, body1.user.id, { timeout: 15000 });
    await page2.waitForFunction((uid) => {
        const s = (window.VoiceManager as any)._debug.state;
        return !!(s.remoteStreams[uid] && s.remoteStreams[uid].audio);
    }, body1.user.id, { timeout: 20000 });
}

test('video quality settings persist and defaults are low', async ({ page }) => {
    const ts = Date.now();
    await mockMedia(page);
    await registerUser(page, 'vq1_' + ts);

    // Defaults: low send + receive for both sources; manual load OFF (defaults
    // live in memory until the first save — assert via the live state).
    const defaults = await page.evaluate(() => {
        const s = (window.VoiceManager as any)._debug.state;
        return {
            sendCameraRes: s.settings.sendCameraRes,
            sendScreenRes: s.settings.sendScreenRes,
            recvCameraRes: s.settings.recvCameraRes,
            recvScreenRes: s.settings.recvScreenRes,
            manualVideoLoad: s.settings.manualVideoLoad,
        };
    });
    expect(defaults.sendCameraRes).toBe(360);
    expect(defaults.sendScreenRes).toBe(480);
    expect(defaults.recvCameraRes).toBe(360);
    expect(defaults.recvScreenRes).toBe(480);
    expect(defaults.manualVideoLoad).toBeFalsy();

    // Change through the Settings → Voice UI.
    await page.click('#settings-btn');
    await page.click('.settings-tab[data-tab="voice-settings"]');
    await page.locator('#voice-send-camera-res').selectOption('720');
    await page.locator('#voice-recv-screen-res').selectOption('144');
    await page.locator('#voice-manual-video-load').check();
    await page.waitForTimeout(300);

    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('voice_settings') || '{}'));
    expect(saved.sendCameraRes).toBe(720);
    expect(saved.recvScreenRes).toBe(144);
    expect(saved.manualVideoLoad).toBe(true);

    // Reload → settings restored.
    await page.reload();
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
    await page.click('#settings-btn');
    await page.click('.settings-tab[data-tab="voice-settings"]');
    await expect(page.locator('#voice-send-camera-res')).toHaveValue('720');
    await expect(page.locator('#voice-recv-screen-res')).toHaveValue('144');
    await expect(page.locator('#voice-manual-video-load')).toBeChecked();
});

test('send resolution applied at capture; per-receiver scale + matching bitrate', async ({ page, context }) => {
    test.setTimeout(240000);
    const ts = Date.now();
    const user1 = 'vq2_' + ts;
    const user2 = 'vq3_' + ts;

    const ctx2 = await context.browser()!.newContext();
    const page2 = await ctx2.newPage();
    await mockMedia(page);
    await mockMedia(page2);
    const body2 = await registerUser(page2, user2);
    const body1 = await registerUser(page, user1);
    await setupFriends(page, page2, body1, body2);
    const { userData, dm } = await createDm(page, page2, body1, body2);
    await setupDmCall(page, page2, body1, body2, dm, userData);

    // A sends camera at 1080p; B wants to RECEIVE it at 240p.
    await page.evaluate(() => (window.VoiceManager as any).setSendRes('camera', 1080));
    await page2.evaluate(() => (window.VoiceManager as any).setRecvRes('camera', 240));

    // The recv preference travels in voice_state and lands on A's member state.
    await page.waitForFunction((bUid) => {
        const s = (window.VoiceManager as any)._debug.state;
        return s.members[bUid] && s.members[bUid].recv_camera_res === 240;
    }, body2.user.id, { timeout: 15000 });

    // A turns the camera on (captured at 1080p per the send setting).
    await page.evaluate(() => (window.VoiceManager as any).toggleCamera());
    await page.waitForFunction(() => {
        const s = (window.VoiceManager as any)._debug.state;
        return s.cameraOn;
    }, undefined, { timeout: 15000 });

    // The capture was requested at the configured send resolution.
    const capConstraints = await page.evaluate(() => (window as any).__lastVideoConstraints);
    expect(capConstraints).toBeTruthy();
    expect(capConstraints.height && (capConstraints.height.ideal === 1080 || capConstraints.height.max === 1080)).toBe(true);

    // A's camera sender to B is scaled down to B's receive res (1080/240 = 4.5)
    // with a matching bitrate (240p → 400 kbps).
    const senderParams = await page.evaluate((bUid) => {
        const s = (window.VoiceManager as any)._debug.state;
        const pc = s.peers[bUid];
        if (!pc) return null;
        for (const sender of pc.getSenders()) {
            if (sender.track && sender.track.kind === 'video') {
                const p = sender.getParameters();
                return p && p.encodings && p.encodings[0] ? {
                    scale: p.encodings[0].scaleResolutionDownBy,
                    maxBitrate: p.encodings[0].maxBitrate,
                    maxFramerate: p.encodings[0].maxFramerate,
                    degradationPreference: p.degradationPreference,
                } : null;
            }
        }
        return null;
    }, body2.user.id);
    expect(senderParams).toBeTruthy();
    expect(senderParams.scale).toBeGreaterThanOrEqual(4);
    expect(senderParams.maxBitrate).toBe(400000);
    expect(senderParams.maxFramerate).toBe(30);
    expect(senderParams.degradationPreference).toBe('balanced');

    await ctx2.close();
});

test('manual video load: per-feed Load buttons, independent, right-click intact', async ({ page, context }) => {
    test.setTimeout(240000);
    const ts = Date.now();
    const user1 = 'vq4_' + ts;
    const user2 = 'vq5_' + ts;

    const ctx2 = await context.browser()!.newContext();
    const page2 = await ctx2.newPage();
    await mockMedia(page);
    await mockMedia(page2);
    const body2 = await registerUser(page2, user2);
    const body1 = await registerUser(page, user1);
    await setupFriends(page, page2, body1, body2);
    const { userData, dm } = await createDm(page, page2, body1, body2);
    await setupDmCall(page, page2, body1, body2, dm, userData);

    const aUid = body1.user.id;

    // B turns manual video load ON, then A turns the camera on.
    await page2.evaluate(() => (window.VoiceManager as any).setManualVideoLoad(true));
    await page.evaluate(() => (window.VoiceManager as any).toggleCamera());
    await page.waitForFunction(() => {
        const s = (window.VoiceManager as any)._debug.state;
        return s.cameraOn;
    }, undefined, { timeout: 15000 });

    // B's camera tile for A appears but is HELD: no srcObject, Load button
    // shown. (Scope to the DM panel — the voice popup rows also render tiles
    // but they're hidden during a DM call.)
    await page2.waitForSelector('.dm-call-tile .remote-video-tile[data-kind="camera"][data-uid="' + aUid + '"]', { timeout: 20000 });
    await page2.waitForFunction((uid) => {
        const v = document.querySelector('.dm-call-tile .remote-video-tile[data-kind="camera"][data-uid="' + uid + '"]');
        const btn = document.querySelector('.dm-call-tile .voice-feed-load-btn[data-feed="' + uid + ':camera"]');
        const r = btn ? btn.getBoundingClientRect() : null;
        return v && !v.srcObject && btn && r && r.width > 10 && r.height > 10;
    }, aUid, { timeout: 20000 });

    // Right-click on the HELD feed still opens the volume menu.
    await page2.click('.dm-call-tile .voice-feed-load-btn[data-feed="' + aUid + ':camera"]', { button: 'right' });
    await page2.waitForSelector('#volume-menu', { state: 'visible', timeout: 10000 });
    await page2.evaluate(() => {
        const m = document.getElementById('volume-menu');
        if (m) m.style.display = 'none';
    });

    // Click Load → the feed attaches.
    await page2.click('.dm-call-tile .voice-feed-load-btn[data-feed="' + aUid + ':camera"]');
    await page2.waitForFunction((uid) => {
        const v = document.querySelector('.dm-call-tile .remote-video-tile[data-kind="camera"][data-uid="' + uid + '"]');
        return v && !!v.srcObject;
    }, aUid, { timeout: 20000 });

    // A starts a SCREEN share: B gets a SEPARATE Load button for it, and the
    // already-loaded camera feed stays loaded (per-feed independence).
    await page.evaluate(() => (window.VoiceManager as any).toggleScreen());
    await page.waitForFunction(() => {
        const s = (window.VoiceManager as any)._debug.state;
        return s.screenOn;
    }, undefined, { timeout: 15000 });
    await page2.waitForFunction((uid) => {
        const btn = document.querySelector('.dm-call-tile .voice-feed-load-btn[data-feed="' + uid + ':screen"]');
        const r = btn ? btn.getBoundingClientRect() : null;
        return btn && r && r.width > 10 && r.height > 10;
    }, aUid, { timeout: 20000 });
    const independence = await page2.evaluate((uid) => {
        const camV = document.querySelector('.dm-call-tile .remote-video-tile[data-kind="camera"][data-uid="' + uid + '"]');
        const scrV = document.querySelector('.dm-call-tile .remote-video-tile[data-kind="screen"][data-uid="' + uid + '"]');
        const scrBtn = document.querySelector('.dm-call-tile .voice-feed-load-btn[data-feed="' + uid + ':screen"]');
        // Each Load button must sit OVER its own tile, not between the two.
        function centerIn(el: any) {
            if (!el) return false;
            const b = el.getBoundingClientRect();
            const t = el.parentElement.querySelector('.remote-video-tile[data-kind="' + (el.getAttribute('data-feed') || '').split(':')[1] + '"]');
            if (!t) return false;
            const tr = t.getBoundingClientRect();
            const cx = b.x + b.width / 2;
            const cy = b.y + b.height / 2;
            return cx >= tr.x && cx <= tr.x + tr.width && cy >= tr.y && cy <= tr.y + tr.height;
        }
        return {
            cameraLoaded: !!(camV && camV.srcObject),
            screenHeld: !!(scrV && !scrV.srcObject && scrBtn && scrBtn.getBoundingClientRect().width > 10),
            screenBtnOverScreenTile: centerIn(scrBtn),
        };
    }, aUid);
    expect(independence.cameraLoaded).toBe(true);
    expect(independence.screenHeld).toBe(true);
    // The screen's Load button sits over the screen tile — NOT between the two
    // tiles (the camera one is loaded so only the screen button exists here).
    expect(independence.screenBtnOverScreenTile).toBe(true);

    // Loading the camera did NOT auto-load the screen; load the screen now.
    await page2.click('.dm-call-tile .voice-feed-load-btn[data-feed="' + aUid + ':screen"]');
    await page2.waitForFunction((uid) => {
        const v = document.querySelector('.dm-call-tile .remote-video-tile[data-kind="screen"][data-uid="' + uid + '"]');
        return v && !!v.srcObject;
    }, aUid, { timeout: 20000 });

    await ctx2.close();
});
