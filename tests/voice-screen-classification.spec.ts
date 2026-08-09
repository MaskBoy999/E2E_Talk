import { test, expect } from '@playwright/test';

// Verifies the track-classification fix: a screen share must land in the
// receiver's `screen` slot (and the camera in `camera`) regardless of the
// order the feeds are started or the order the voice_state broadcast vs the
// WebRTC track arrive. The definitive check: the receiver's remote stream
// track ids must match the sender's LOCAL track ids (track ids survive the
// SDP msid round-trip), so we assert on the ids, not on tile visibility.

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
                // Moving screen: full-frame redraw every 80ms (high motion).
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
    // Let the peer connect + E2EE key land.
    await page.waitForTimeout(3000);
}

// Read A's local camera/screen track ids (as known to its own VoiceManager).
async function senderTrackIds(page: any) {
    return await page.evaluate(() => {
        const s = (window as any).VoiceManager._debug.state;
        return {
            camera: s.localStreams.camera && s.localStreams.camera.getVideoTracks()[0]
                ? s.localStreams.camera.getVideoTracks()[0].id : null,
            screen: s.localStreams.screen && s.localStreams.screen.getVideoTracks()[0]
                ? s.localStreams.screen.getVideoTracks()[0].id : null,
        };
    });
}

// Read B's remote stream track ids for the given uid, plus the member record.
async function receiverSlotIds(page2: any, uid: string) {
    return await page2.evaluate((uid) => {
        const s = (window as any).VoiceManager._debug.state;
        const rs = s.remoteStreams[uid] || {};
        return {
            camera: rs.camera && rs.camera.getVideoTracks()[0] ? rs.camera.getVideoTracks()[0].id : null,
            screen: rs.screen && rs.screen.getVideoTracks()[0] ? rs.screen.getVideoTracks()[0].id : null,
            pending: rs._pending ? rs._pending.map((t: any) => t.id) : [],
            memberCameraId: (s.members[uid] || {}).camera_track_id || null,
            memberScreenId: (s.members[uid] || {}).screen_track_id || null,
            memberCamera: !!(s.members[uid] || {}).camera,
            memberScreen: !!(s.members[uid] || {}).screen,
        };
    }, uid);
}

test.describe('screen/camera track classification', () => {
    test('screen first, then camera: each feed lands in the right slot', async ({ context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const ctx1 = await context.browser()!.newContext();
        const page = await ctx1.newPage();
        await mockMedia(page);
        const u1 = await registerUser(page, 'cls1_' + ts);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page2);
        const u2 = await registerUser(page2, 'cls2_' + ts);

        await becomeFriends(page, page2, u1.token, u2.token);
        await waitForWs(page);
        await waitForWs(page2);
        await setupDmCall(page, page2);
        const aUid = u1.user.id;

        // 1. SCREEN ONLY first (the classic race: the track can arrive before
        // the screen:true broadcast).
        await page.click('#dm-call-screen');
        await page.waitForTimeout(2500);

        await page2.waitForFunction((uid) => {
            const s = (window as any).VoiceManager._debug.state;
            const rs = s.remoteStreams[uid];
            return rs && rs.screen && rs.screen.getVideoTracks().length > 0;
        }, aUid, { timeout: 20000 });

        const ids1 = await senderTrackIds(page);
        const slots1 = await receiverSlotIds(page2, aUid);
        console.log('SCREEN-ONLY SENDER:', JSON.stringify(ids1));
        console.log('SCREEN-ONLY RECEIVER:', JSON.stringify(slots1));
        expect(ids1.screen).toBeTruthy();
        // The screen track must sit in the SCREEN slot, matching the sender's id.
        expect(slots1.screen).toBe(ids1.screen);
        // Nothing may be parked in the pending queue — ids resolved.
        expect(slots1.pending).toEqual([]);
        // And nothing in the camera slot.
        expect(slots1.camera).toBeNull();

        // The screen tile decodes.
        await page2.waitForFunction((uid) => {
            const video = document.querySelector(`#dm-call-body .remote-video-tile[data-uid="${uid}"][data-kind="screen"]`) as HTMLVideoElement | null;
            return video && video.videoWidth > 0;
        }, aUid, { timeout: 15000 });

        // 2. Now the camera too — camera must land in the camera slot and the
        // screen must STAY in the screen slot (no swap).
        await page.click('#dm-call-camera');
        await page.waitForTimeout(2500);

        await page2.waitForFunction((uid) => {
            const s = (window as any).VoiceManager._debug.state;
            const rs = s.remoteStreams[uid];
            return rs && rs.camera && rs.camera.getVideoTracks().length > 0 &&
                rs.screen && rs.screen.getVideoTracks().length > 0;
        }, aUid, { timeout: 20000 });

        const ids2 = await senderTrackIds(page);
        const slots2 = await receiverSlotIds(page2, aUid);
        console.log('BOTH SENDER:', JSON.stringify(ids2));
        console.log('BOTH RECEIVER:', JSON.stringify(slots2));
        expect(ids2.camera).toBeTruthy();
        expect(ids2.screen).toBeTruthy();
        expect(ids2.camera).not.toBe(ids2.screen);
        expect(slots2.camera).toBe(ids2.camera);
        expect(slots2.screen).toBe(ids2.screen);
        expect(slots2.pending).toEqual([]);

        // Both tiles decode.
        await page2.waitForFunction((uid) => {
            const v1 = document.querySelector(`#dm-call-body .remote-video-tile[data-uid="${uid}"][data-kind="camera"]`) as HTMLVideoElement | null;
            const v2 = document.querySelector(`#dm-call-body .remote-video-tile[data-uid="${uid}"][data-kind="screen"]`) as HTMLVideoElement | null;
            return v1 && v1.videoWidth > 0 && v2 && v2.videoWidth > 0;
        }, aUid, { timeout: 15000 });
    });

    test('camera first, then screen: each feed lands in the right slot', async ({ context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const ctx1 = await context.browser()!.newContext();
        const page = await ctx1.newPage();
        await mockMedia(page);
        const u1 = await registerUser(page, 'cls3_' + ts);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page2);
        const u2 = await registerUser(page2, 'cls4_' + ts);

        await becomeFriends(page, page2, u1.token, u2.token);
        await waitForWs(page);
        await waitForWs(page2);
        await setupDmCall(page, page2);
        const aUid = u1.user.id;

        // Camera first.
        await page.click('#dm-call-camera');
        await page.waitForTimeout(2500);
        await page2.waitForFunction((uid) => {
            const s = (window as any).VoiceManager._debug.state;
            const rs = s.remoteStreams[uid];
            return rs && rs.camera && rs.camera.getVideoTracks().length > 0;
        }, aUid, { timeout: 20000 });
        const ids1 = await senderTrackIds(page);
        const slots1 = await receiverSlotIds(page2, aUid);
        console.log('CAMERA-ONLY SENDER:', JSON.stringify(ids1));
        console.log('CAMERA-ONLY RECEIVER:', JSON.stringify(slots1));
        expect(slots1.camera).toBe(ids1.camera);
        expect(slots1.screen).toBeNull();
        expect(slots1.pending).toEqual([]);

        // Then screen.
        await page.click('#dm-call-screen');
        await page.waitForTimeout(2500);
        await page2.waitForFunction((uid) => {
            const s = (window as any).VoiceManager._debug.state;
            const rs = s.remoteStreams[uid];
            return rs && rs.screen && rs.screen.getVideoTracks().length > 0;
        }, aUid, { timeout: 20000 });
        const ids2 = await senderTrackIds(page);
        const slots2 = await receiverSlotIds(page2, aUid);
        console.log('BOTH(2) SENDER:', JSON.stringify(ids2));
        console.log('BOTH(2) RECEIVER:', JSON.stringify(slots2));
        expect(slots2.camera).toBe(ids2.camera);
        expect(slots2.screen).toBe(ids2.screen);
        expect(slots2.pending).toEqual([]);

        // Both tiles decode.
        await page2.waitForFunction((uid) => {
            const v1 = document.querySelector(`#dm-call-body .remote-video-tile[data-uid="${uid}"][data-kind="camera"]`) as HTMLVideoElement | null;
            const v2 = document.querySelector(`#dm-call-body .remote-video-tile[data-uid="${uid}"][data-kind="screen"]`) as HTMLVideoElement | null;
            return v1 && v1.videoWidth > 0 && v2 && v2.videoWidth > 0;
        }, aUid, { timeout: 15000 });
    });
});
