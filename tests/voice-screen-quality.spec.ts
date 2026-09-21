import { test, expect } from '@playwright/test';

// Screen-share QUALITY test. Uses a MOVING screen share (canvas redraw every
// 80ms = constant motion) and verifies, via decode health + RTCPeerConnection
// getStats, that the feed decodes normally, keeps decoding while fullscreened,
// and keeps decoding after exiting fullscreen. Also asserts the decrypt path
// is not dropping an unbounded number of frames (framesDropped stays small
// relative to framesDecoded — a bitrate/decryption problem shows up as high
// drops / no decoded growth).

// E2E_TEST_BASE_URL lets the suite run against a second, isolated server
// instance (its own DB and raised rate limits) without disturbing a dev server.
const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';

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

// MOVING screen: the canvas re-draws every 80ms with a changing frame
// (full-frame change), so the encoder continuously produces motion — the
// exact condition that used to turn into blocky artifacts / frozen tiles.
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

async function createVoiceServer(page: any, ts: number) {
    await page.click('#add-server-btn');
    await page.click('#choice-create-server');
    await page.fill('#new-server-name', 'Q_' + ts);
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

async function setupDmCall(page: any, page2: any) {
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
    await page.waitForTimeout(3000);
}

// Sample the receiver's video decode health + inbound-rtp stats.
async function sampleDecode(page2: any, uid: string, sel: string) {
    return await page2.evaluate(({ uid, sel }) => {
        const s = (window as any).VoiceManager._debug.state;
        // While fullscreened the tile lives inside .voice-fs-wrap (the app
        // moves the element, it does not re-render it) — fall back to it.
        let video = document.querySelector(sel) as HTMLVideoElement | null;
        if (!video && document.fullscreenElement) {
            video = document.querySelector('.voice-fs-wrap .remote-video-tile') as HTMLVideoElement | null;
        }
        const pc = s.peers[uid];
        let stats = { framesDecoded: 0, framesDropped: 0, packetsLost: 0 };
        return pc.getStats().then((st: any) => {
            st.forEach((r: any) => {
                if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) {
                    stats.framesDecoded = r.framesDecoded || stats.framesDecoded;
                    stats.framesDropped = r.framesDropped || stats.framesDropped;
                    stats.packetsLost = r.packetsLost || stats.packetsLost;
                }
            });
            return {
                vw: video ? video.videoWidth : 0,
                vh: video ? video.videoHeight : 0,
                t: video ? video.currentTime : 0,
                paused: video ? video.paused : true,
                stats,
            };
        });
    }, { uid, sel });
}

// Assert the feed is actually decoding: width known + time keeps advancing.
async function waitDecoding(page2: any, uid: string, sel: string, timeout = 15000) {
    await page2.waitForFunction(({ uid, sel }) => {
        const video = document.querySelector(sel) as HTMLVideoElement | null;
        return video && video.videoWidth > 0;
    }, { uid, sel }, { timeout });
}

test.describe('screen share decode health (moving content)', () => {
    test('DM: decodes normally, through fullscreen, and after exiting fullscreen', async ({ context }) => {
        test.setTimeout(300000);
        const ts = Date.now();
        const ctx1 = await context.browser()!.newContext();
        const page = await ctx1.newPage();
        await mockMedia(page);
        const u1 = await registerUser(page, 'qdm1_' + ts);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page2);
        const u2 = await registerUser(page2, 'qdm2_' + ts);

        await becomeFriends(page, page2, u1.token, u2.token);
        await waitForWs(page);
        await waitForWs(page2);
        await setupDmCall(page, page2);
        const aUid = u1.user.id;
        const sel = `#dm-call-body .remote-video-tile[data-uid="${aUid}"][data-kind="screen"]`;

        // A: camera + moving screen on.
        await page.click('#dm-call-camera');
        await page.waitForTimeout(1500);
        await page.click('#dm-call-screen');
        await page.waitForTimeout(3500);

        await page2.waitForFunction((uid) => {
            const s = (window as any).VoiceManager._debug.state;
            const rs = s.remoteStreams[uid];
            return rs && rs.screen && rs.screen.getVideoTracks().length > 0;
        }, aUid, { timeout: 20000 });
        await waitDecoding(page2, aUid, sel);

        // 1. NORMAL playback — decode health + stats over a 2.5s window.
        const a1 = await sampleDecode(page2, aUid, sel);
        await page2.waitForTimeout(2500);
        const a2 = await sampleDecode(page2, aUid, sel);
        console.log('NORMAL:', JSON.stringify({ a1, a2 }));
        expect(a1.vw).toBeGreaterThan(0);
        expect(a2.t).toBeGreaterThan(a1.t);          // time is advancing
        const decDelta = a2.stats.framesDecoded - a1.stats.framesDecoded;
        const dropDelta = a2.stats.framesDropped - a1.stats.framesDropped;
        expect(decDelta).toBeGreaterThan(0);         // frames are decoding
        expect(dropDelta).toBeLessThanOrEqual(Math.max(5, Math.floor(decDelta * 0.5))); // not dropping most frames

        // 2. FULLSCREEN (real native) — still decoding while fullscreened.
        await page2.click(sel);
        await page2.waitForFunction(() => !!document.fullscreenElement, undefined, { timeout: 5000 });
        await page2.waitForTimeout(1500);
        const fs1 = await sampleDecode(page2, aUid, sel);
        await page2.waitForTimeout(2000);
        const fs2 = await sampleDecode(page2, aUid, sel);
        console.log('FULLSCREEN:', JSON.stringify({ fs1, fs2 }));
        expect(fs1.vw).toBeGreaterThan(0);
        expect(fs2.t).toBeGreaterThan(fs1.t);
        expect(fs2.stats.framesDecoded).toBeGreaterThanOrEqual(fs1.stats.framesDecoded);

        // 3. EXIT fullscreen by clicking the fullscreened tile — still decoding.
        await page2.evaluate(() => {
            const wrap = document.querySelector('.voice-fs-wrap');
            const tile = wrap && wrap.querySelector('.remote-video-tile') as HTMLVideoElement | null;
            if (tile) tile.click();
        });
        await page2.waitForFunction(() => !document.fullscreenElement, undefined, { timeout: 5000 });
        await page2.waitForTimeout(1500);
        const x1 = await sampleDecode(page2, aUid, sel);
        await page2.waitForTimeout(2000);
        const x2 = await sampleDecode(page2, aUid, sel);
        console.log('AFTER EXIT:', JSON.stringify({ x1, x2 }));
        expect(x1.vw).toBeGreaterThan(0);
        expect(x2.t).toBeGreaterThan(x1.t);          // time advancing after exit
        expect(x2.stats.framesDecoded).toBeGreaterThanOrEqual(x1.stats.framesDecoded);
        expect(x2.stats.framesDecoded).toBeGreaterThan(fs2.stats.framesDecoded); // still growing overall
    });

    test('server voice channel: decodes normally, through fullscreen, and after exiting fullscreen', async ({ context }) => {
        test.setTimeout(300000);
        const ts = Date.now();
        const ctx1 = await context.browser()!.newContext();
        const page = await ctx1.newPage();
        await mockMedia(page);
        const u1 = await registerUser(page, 'qsrv1_' + ts);
        const srv = await createVoiceServer(page, ts);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page2);
        const u2 = await registerUser(page2, 'qsrv2_' + ts);

        // B joins the server via invite code.
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

        // Both join the voice channel.
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

        // A: camera + moving screen on.
        await page.click('#voice-bar-camera');
        await page.waitForTimeout(1500);
        await page.click('#voice-bar-screen');
        await page.waitForTimeout(3500);

        const aUid = u1.user.id;
        // B opens the voice-channel view so the member tiles exist.
        await page2.evaluate(() => { (window as any).VoiceManager.toggleServerPopup(); });
        const sel = `.voice-member-row[data-uid="${aUid}"] .remote-video-tile[data-kind="screen"]`;
        await page2.waitForFunction((uid) => {
            const s = (window as any).VoiceManager._debug.state;
            const rs = s.remoteStreams[uid];
            return rs && rs.screen && rs.screen.getVideoTracks().length > 0;
        }, aUid, { timeout: 20000 });
        await waitDecoding(page2, aUid, sel);

        // 1. NORMAL playback — stats window.
        const a1 = await sampleDecode(page2, aUid, sel);
        await page2.waitForTimeout(2500);
        const a2 = await sampleDecode(page2, aUid, sel);
        console.log('SRV NORMAL:', JSON.stringify({ a1, a2 }));
        expect(a1.vw).toBeGreaterThan(0);
        expect(a2.t).toBeGreaterThan(a1.t);
        const decDelta = a2.stats.framesDecoded - a1.stats.framesDecoded;
        const dropDelta = a2.stats.framesDropped - a1.stats.framesDropped;
        expect(decDelta).toBeGreaterThan(0);
        expect(dropDelta).toBeLessThanOrEqual(Math.max(5, Math.floor(decDelta * 0.5)));

        // 2. FULLSCREEN — still decoding.
        await page2.click(sel);
        await page2.waitForFunction(() => !!document.fullscreenElement, undefined, { timeout: 5000 });
        await page2.waitForTimeout(1500);
        const fs1 = await sampleDecode(page2, aUid, sel);
        await page2.waitForTimeout(2000);
        const fs2 = await sampleDecode(page2, aUid, sel);
        console.log('SRV FULLSCREEN:', JSON.stringify({ fs1, fs2 }));
        expect(fs1.vw).toBeGreaterThan(0);
        expect(fs2.t).toBeGreaterThan(fs1.t);

        // 3. EXIT fullscreen by clicking — still decoding.
        await page2.evaluate(() => {
            const wrap = document.querySelector('.voice-fs-wrap');
            const tile = wrap && wrap.querySelector('.remote-video-tile') as HTMLVideoElement | null;
            if (tile) tile.click();
        });
        await page2.waitForFunction(() => !document.fullscreenElement, undefined, { timeout: 5000 });
        await page2.waitForTimeout(1500);
        const x1 = await sampleDecode(page2, aUid, sel);
        await page2.waitForTimeout(2000);
        const x2 = await sampleDecode(page2, aUid, sel);
        console.log('SRV AFTER EXIT:', JSON.stringify({ x1, x2 }));
        expect(x1.vw).toBeGreaterThan(0);
        expect(x2.t).toBeGreaterThan(x1.t);
        expect(x2.stats.framesDecoded).toBeGreaterThan(fs2.stats.framesDecoded);
    });
});
