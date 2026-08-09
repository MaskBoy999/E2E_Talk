import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

async function waitForWs(page: any, maxRetries = 60) {
    return await page.evaluate((maxRetries) => {
        return new Promise((resolve) => {
            let tries = 0;
            const check = () => {
                tries++;
                if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
                    resolve(true);
                } else if (tries >= maxRetries) {
                    resolve(false);
                } else {
                    setTimeout(check, 200);
                }
            };
            setTimeout(check, 500);
        });
    }, maxRetries);
}

// Mocked media: camera (video), mic (audio), and screen share (video + audio).
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
                ctx.fillStyle = '#2a2a4a';
                ctx.fillRect(0, 0, 320, 240);
                ctx.fillStyle = '#fff';
                ctx.font = '24px sans-serif';
                ctx.fillText('STATIC SCREEN', 20, 120);
                // Capture the canvas into a REAL static stream: draw once, then
                // only re-draw every 5s (like a mostly-static tab).
                const stream = (canvas as any).captureStream(30);
                if ((window as any).__staticScreen) {
                    (window as any).__mockCanvasTimer = setInterval(() => {
                        ctx.fillStyle = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
                        ctx.fillRect(0, 0, 320, 240);
                        ctx.fillStyle = '#fff';
                        ctx.font = '24px sans-serif';
                        ctx.fillText('STATIC SCREEN', 20, 120);
                    }, 8000);
                } else {
                    let i = 0;
                    (window as any).__mockCanvasTimer = setInterval(() => {
                        ctx.fillStyle = `rgb(${(i * 40) % 255},100,150)`;
                        ctx.fillRect(0, 0, 320, 240);
                        ctx.fillStyle = '#fff';
                        ctx.fillText(String(i++), 10, 20);
                    }, 80);
                }
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
        // STATIC screen: the canvas draws ONCE and never changes — like a real
        // static tab/window. The encoder sends few frames after the initial
        // keyframe, so a re-created <video> element must wait for the next
        // keyframe before showing anything (the "lost video" hypothesis).
        (window as any).__staticScreen = true;
    });
}

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(500);
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

async function becomeFriends(page1: any, page2: any, token1: string, token2: string) {
    const friendCode2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    expect(friendCode2).toBeTruthy();
    const fr = await page1.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        data: { friend_code: friendCode2 },
    });
    expect(fr.ok()).toBeTruthy();
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${token2}` },
    })).json();
    const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    expect(acc.ok()).toBeTruthy();
}

async function stubFullscreen(page: any) {
    await page.evaluate(() => {
        (window as any).__fsEl = null;
        Element.prototype.requestFullscreen = function () {
            (window as any).__fsEl = this;
            document.dispatchEvent(new Event('fullscreenchange'));
            return Promise.resolve();
        };
        (document as any).exitFullscreen = function () {
            (window as any).__fsEl = null;
            document.dispatchEvent(new Event('fullscreenchange'));
            return Promise.resolve();
        };
        Object.defineProperty(document, 'fullscreenElement', {
            configurable: true,
            get() { return (window as any).__fsEl; },
        });
    });
}

async function createVoiceServer(page: any, ts: number) {
    await page.click('#add-server-btn');
    await page.click('#choice-create-server');
    await page.fill('#new-server-name', 'FSR_' + ts);
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 10000 });
    const serverId = await page.evaluate(() => document.querySelector('.server-icon[data-id]')!.getAttribute('data-id'));
    const token = await page.evaluate(() => localStorage.getItem('token'));
    const encName = await page.evaluate(async (name) => {
        const k = E2ECrypto.base64ToArrayBuffer(localStorage.getItem('e2e_server_' + document.querySelector('.server-icon[data-id]')!.getAttribute('data-id')));
        return E2ECrypto.aeadEncrypt(name, new Uint8Array(k));
    }, 'General');
    const createCh = await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { encrypted_name: encName.ciphertext, name_nonce: encName.nonce, channel_type: 'voice' },
    });
    expect(createCh.ok()).toBeTruthy();
    const chJson = await createCh.json();
    return { serverId, channelId: chJson.id, token };
}

test.describe('screen share + volume + fullscreen exit repro', () => {
    test('DM: screen video survives fullscreen exit after a volume change', async ({ context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const ctx1 = await context.browser()!.newContext();
        const page = await ctx1.newPage();
        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push('P1: ' + err.message));
        await mockMedia(page);
        const u1 = await registerUser(page, 'fsr1_' + ts);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const errors2: string[] = [];
        page2.on('pageerror', (err) => errors2.push('P2: ' + err.message));
        await mockMedia(page2);
        const u2 = await registerUser(page2, 'fsr2_' + ts);

        await becomeFriends(page, page2, u1.token, u2.token);
        await waitForWs(page);
        await waitForWs(page2);

        // Open DM view on both, start the call
        await page.click('#dm-strip-btn');
        await page.waitForSelector('.dm-item', { timeout: 15000 });
        await page.click('.dm-item');
        await page.waitForSelector('.dm-call-btns .dm-call-btn', { timeout: 10000 });
        await page2.click('#dm-strip-btn');
        await page2.waitForSelector('.dm-item', { timeout: 15000 });
        await page2.click('.dm-item');
        await page2.waitForSelector('.dm-call-btns .dm-call-btn', { timeout: 10000 });

        await page.click('.dm-call-btns .dm-call-btn');
        await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 10000 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug.state.incomingCall !== null;
        }, undefined, { timeout: 20000 });
        await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 15000 });
        await page2.click('#incoming-call-accept');
        await page2.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 10000 });

        // A turns camera ON and screen share ON (with audio) -> B sees both
        // tiles side by side (the exact layout the user runs)
        await page.click('#dm-call-camera');
        await page.waitForTimeout(1500);
        await page.click('#dm-call-screen');
        await page.waitForTimeout(2500);
        const aUid = u1.user.id;
        await page2.waitForSelector(`#dm-call-body .remote-video-tile[data-kind="screen"]`, { timeout: 15000 });
        await page2.waitForFunction((uid) => {
            const s = (window as any).VoiceManager._debug.state;
            const rs = s.remoteStreams[uid];
            return rs && rs.screen && rs.screen.getVideoTracks().length > 0 &&
                rs.screenAudio && rs.screenAudio.getAudioTracks().length > 0;
        }, aUid, { timeout: 20000 });

        // B right-clicks the SCREEN tile and changes its volume to 250%
        const screenTile = page2.locator(`#dm-call-body .remote-video-tile[data-uid="${aUid}"][data-kind="screen"]`);
        await screenTile.click({ button: 'right' });
        await page2.waitForSelector('#volume-menu', { state: 'visible', timeout: 10000 });
        await page2.evaluate(() => {
            const slider = document.querySelector('#volume-menu .volume-menu-slider') as HTMLInputElement;
            slider.value = '250';
            slider.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const savedVol = await page2.evaluate((uid) => localStorage.getItem('voice_screen_volume_' + uid), aUid);
        expect(savedVol).toBe('250');

        // Close the volume menu so it doesn't intercept the tile click
        await page2.evaluate(() => {
            const m = document.getElementById('volume-menu');
            if (m) m.style.display = 'none';
        });

        // Sanity: the static screen tile DID decode before fullscreen
        await page2.waitForFunction((uid) => {
            const video = document.querySelector(`#dm-call-body .remote-video-tile[data-uid="${uid}"][data-kind="screen"]`) as HTMLVideoElement | null;
            return video && video.videoWidth > 0;
        }, aUid, { timeout: 15000 }).catch(() => {});
        const preFs = await page2.evaluate((uid) => {
            const video = document.querySelector(`#dm-call-body .remote-video-tile[data-uid="${uid}"][data-kind="screen"]`) as HTMLVideoElement | null;
            return { vw: video ? video.videoWidth : 0, t: video ? video.currentTime : 0 };
        }, aUid);
        console.log('PRE-FS FRAMES:', JSON.stringify(preFs));

        // B fullscreens the screen tile — REAL native fullscreen (works in
        // headless Chromium: the promise resolves and fullscreenElement is set
        // after a tick).
        await page2.click(`#dm-call-body .remote-video-tile[data-uid="${aUid}"][data-kind="screen"]`);
        await page2.waitForFunction(() => !!document.fullscreenElement, undefined, { timeout: 5000 });
        await page2.waitForTimeout(400);
        const entered = await page2.evaluate(() => {
            const wrap = document.querySelector('.voice-fs-wrap');
            const tile = wrap ? wrap.querySelector('.remote-video-tile') : null;
            return {
                isFs: !!document.fullscreenElement,
                hasTile: !!tile,
                tileSrcSet: tile ? !!tile.srcObject : false,
            };
        });
        console.log('FS ENTERED:', JSON.stringify(entered));
        expect(entered.isFs).toBe(true);
        expect(entered.hasTile).toBe(true);
        expect(entered.tileSrcSet).toBe(true);

        // Exit fullscreen BY CLICKING the fullscreened video (the user's real
        // gesture — the click handler runs toggleFullscreen -> restoreFromFsWrap)
        await page2.evaluate(() => {
            const wrap = document.querySelector('.voice-fs-wrap');
            const tile = wrap && wrap.querySelector('.remote-video-tile') as HTMLVideoElement | null;
            if (tile) tile.click();
        });
        await page2.waitForFunction(() => !document.fullscreenElement, undefined, { timeout: 5000 });
        await page2.waitForTimeout(1200);
        const afterExit = await page2.evaluate((uid) => {
            const video = document.querySelector(`#dm-call-body .remote-video-tile[data-uid="${uid}"][data-kind="screen"]`) as HTMLVideoElement | null;
            const rs = (window as any).VoiceManager._debug.state.remoteStreams[uid];
            return {
                fsCleared: !document.fullscreenElement,
                wrapGone: !document.querySelector('.voice-fs-wrap'),
                tileExists: !!video,
                tileVisible: video ? video.style.display !== 'none' : false,
                tileSrcSet: video ? !!video.srcObject : false,
                tileSrcTrackLive: video && video.srcObject ? video.srcObject.getVideoTracks().some((t: any) => t.readyState === 'live') : false,
                streamHasScreen: !!(rs && rs.screen),
                streamScreenTrackLive: rs && rs.screen ? rs.screen.getVideoTracks().some((t: any) => t.readyState === 'live') : false,
                screenAudioEls: Object.keys((window as any).VoiceManager._debug.state.remoteScreenAudioEls || {}),
            };
        }, aUid);
        console.log('FS AFTER EXIT:', JSON.stringify(afterExit));
        expect(afterExit.fsCleared).toBe(true);
        expect(afterExit.wrapGone).toBe(true);
        expect(afterExit.tileExists).toBe(true);
        expect(afterExit.tileVisible).toBe(true);
        expect(afterExit.tileSrcSet).toBe(true);
        expect(afterExit.tileSrcTrackLive).toBe(true);
        expect(afterExit.streamHasScreen).toBe(true);
        expect(afterExit.streamScreenTrackLive).toBe(true);

        // And video actually decodes frames (not a black tile) — with the
        // SAME element preserved the last decoded frame + decoder state
        // survive the fullscreen exit even for a STATIC screen share.
        // 30s (not 15s): the static mock only redraws every 8s, and under
        // concurrent-test load a recreated decoder waits for the next draw;
        // a genuinely broken tile (never decodes) still fails this wait.
        await page2.waitForFunction((uid) => {
            const video = document.querySelector(`#dm-call-body .remote-video-tile[data-uid="${uid}"][data-kind="screen"]`) as HTMLVideoElement | null;
            return video && video.videoWidth > 0;
        }, aUid, { timeout: 30000 });
        const frames = await page2.evaluate((uid) => {
            const video = document.querySelector(`#dm-call-body .remote-video-tile[data-uid="${uid}"][data-kind="screen"]`) as HTMLVideoElement | null;
            return { vw: video ? video.videoWidth : 0, t: video ? video.currentTime : 0, paused: video ? video.paused : true };
        }, aUid);
        console.log('FRAMES:', JSON.stringify(frames));
        expect(frames.vw).toBeGreaterThan(0);

        console.log('P1 ERRORS:', JSON.stringify(errors));
        console.log('P2 ERRORS:', JSON.stringify(errors2));
    });

    test('server voice: screen video survives fullscreen exit after a volume change', async ({ context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const ctx1 = await context.browser()!.newContext();
        const page = await ctx1.newPage();
        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push('P1: ' + err.message));
        await mockMedia(page);
        const u1 = await registerUser(page, 'vfs1_' + ts);
        const srv = await createVoiceServer(page, ts);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const errors2: string[] = [];
        page2.on('pageerror', (err) => errors2.push('P2: ' + err.message));
        await mockMedia(page2);
        const u2 = await registerUser(page2, 'vfs2_' + ts);

        // B joins the server via invite code
        const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const code = Array.from({ length: 16 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
        await page.request.post(`${BASE}/api/servers/${srv.serverId}/invite`, {
            headers: { Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' },
            data: { invite_code: code },
        });
        await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${u2.token}`, 'Content-Type': 'application/json' },
            data: { code },
        });

        // Both join the voice channel
        await page.click(`.server-icon[data-id="${srv.serverId}"]`);
        await page.waitForSelector(`.channel-item[data-id="${srv.channelId}"]`, { timeout: 10000 });
        await page.click(`.channel-item[data-id="${srv.channelId}"]`);
        await page.waitForSelector('#voice-bar', { timeout: 10000 });

        await page2.reload();
        await page2.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await page2.click('.server-icon[data-id="' + srv.serverId + '"]');
        await page2.waitForSelector(`.channel-item[data-id="${srv.channelId}"]`, { timeout: 10000 });
        await page2.click(`.channel-item[data-id="${srv.channelId}"]`);
        await page2.waitForSelector('#voice-bar', { timeout: 10000 });
        await page.waitForTimeout(2500);

        // A turns screen share ON
        await page.click('#voice-bar-screen');
        await page.waitForTimeout(2500);
        const aUid = u1.user.id;
        // B opens the popup and sees A's screen tile
        await page2.evaluate(() => { (window as any).VoiceManager.toggleServerPopup(); });
        await page2.waitForSelector(`.voice-member-row[data-uid="${aUid}"] .remote-video-tile[data-kind="screen"]`, { timeout: 15000 });
        await page2.waitForFunction((uid) => {
            const s = (window as any).VoiceManager._debug.state;
            const rs = s.remoteStreams[uid];
            return rs && rs.screen && rs.screen.getVideoTracks().length > 0 &&
                rs.screenAudio && rs.screenAudio.getAudioTracks().length > 0;
        }, aUid, { timeout: 20000 });

        // B right-clicks A's SCREEN tile and changes its volume to 250%
        const screenTile = page2.locator(`.voice-member-row[data-uid="${aUid}"] .remote-video-tile[data-kind="screen"]`);
        await screenTile.click({ button: 'right' });
        await page2.waitForSelector('#volume-menu', { state: 'visible', timeout: 10000 });
        await page2.evaluate(() => {
            const slider = document.querySelector('#volume-menu .volume-menu-slider') as HTMLInputElement;
            slider.value = '250';
            slider.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const savedVol = await page2.evaluate((uid) => localStorage.getItem('voice_screen_volume_' + uid), aUid);
        expect(savedVol).toBe('250');

        // Close the volume menu so it doesn't intercept the tile click
        await page2.evaluate(() => {
            const m = document.getElementById('volume-menu');
            if (m) m.style.display = 'none';
        });

        // B fullscreens the screen tile — REAL native fullscreen
        await page2.click(`.voice-member-row[data-uid="${aUid}"] .remote-video-tile[data-kind="screen"]`);
        await page2.waitForFunction(() => !!document.fullscreenElement, undefined, { timeout: 5000 });
        await page2.waitForTimeout(400);
        const entered = await page2.evaluate(() => {
            const wrap = document.querySelector('.voice-fs-wrap');
            const tile = wrap ? wrap.querySelector('.remote-video-tile') : null;
            return {
                isFs: !!document.fullscreenElement,
                hasTile: !!tile,
                tileSrcSet: tile ? !!tile.srcObject : false,
            };
        });
        console.log('SRV FS ENTERED:', JSON.stringify(entered));
        expect(entered.isFs).toBe(true);
        expect(entered.hasTile).toBe(true);
        expect(entered.tileSrcSet).toBe(true);

        // Exit fullscreen BY CLICKING the fullscreened tile (user's gesture)
        await page2.evaluate(() => {
            const wrap = document.querySelector('.voice-fs-wrap');
            const tile = wrap && wrap.querySelector('.remote-video-tile') as HTMLVideoElement | null;
            if (tile) tile.click();
        });
        await page2.waitForFunction(() => !document.fullscreenElement, undefined, { timeout: 5000 });
        await page2.waitForTimeout(1200);
        const afterExit = await page2.evaluate((uid) => {
            const video = document.querySelector(`.voice-member-row[data-uid="${uid}"] .remote-video-tile[data-kind="screen"]`) as HTMLVideoElement | null;
            const rs = (window as any).VoiceManager._debug.state.remoteStreams[uid];
            return {
                fsCleared: !(window as any).__fsEl,
                wrapGone: !document.querySelector('.voice-fs-wrap'),
                tileExists: !!video,
                tileVisible: video ? video.style.display !== 'none' : false,
                tileSrcSet: video ? !!video.srcObject : false,
                tileSrcTrackLive: video && video.srcObject ? video.srcObject.getVideoTracks().some((t: any) => t.readyState === 'live') : false,
                streamHasScreen: !!(rs && rs.screen),
                streamScreenTrackLive: rs && rs.screen ? rs.screen.getVideoTracks().some((t: any) => t.readyState === 'live') : false,
            };
        }, aUid);
        console.log('SRV FS AFTER EXIT:', JSON.stringify(afterExit));
        expect(afterExit.fsCleared).toBe(true);
        expect(afterExit.wrapGone).toBe(true);
        expect(afterExit.tileExists).toBe(true);
        expect(afterExit.tileVisible).toBe(true);
        expect(afterExit.tileSrcSet).toBe(true);
        expect(afterExit.tileSrcTrackLive).toBe(true);
        expect(afterExit.streamHasScreen).toBe(true);
        expect(afterExit.streamScreenTrackLive).toBe(true);

        console.log('P1 ERRORS:', JSON.stringify(errors));
        console.log('P2 ERRORS:', JSON.stringify(errors2));
    });
});
