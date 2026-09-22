import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// A live video feed used to arrive BLACK and only turn into a picture after a
// while — or immediately after toggling it off and on again. The receiver's
// decrypt transform is attached a beat AFTER the sender's encoder starts, so it
// consumes the opening keyframe as opaque bytes: every delta frame that follows
// decrypts fine but cannot be decoded, and the browser's own keyframe cadence is
// low for a mostly-static picture. Toggling the feed repaired it because by then
// the transforms already existed on both sides.
//
// The fix is the re-kick: a fresh camera/screen start (and every peer created
// while a feed is live) asks our own video encoders for a keyframe right away,
// and again while the receiver is still attaching. This suite is the guard —
// the keyframe requests are counted in the page, because "the tile was black for
// a few seconds" is exactly the kind of symptom a screenshot-based test tolerates.

test.use({
    ignoreHTTPSErrors: true,
    launchOptions: {
        args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            '--ignore-certificate-errors',
        ],
    },
});

/**
 * Record every keyframe request the page posts to its E2EE worker, and make the
 * screen-share picker return the fake capture device (so the test does not
 * depend on Chrome's desktop-capture source selection).
 */
async function instrumentPage(page: any) {
    await page.addInitScript(() => {
        const w = window as any;
        w.__keyframePosts = [];
        const orig = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function (this: Worker, msg: any, ...rest: any[]) {
            try {
                if (msg && msg.type === 'generate-keyframes') w.__keyframePosts.push(Date.now());
            } catch (_) {}
            // @ts-ignore - passthrough
            return orig.call(this, msg, ...rest);
        };
        const md = navigator.mediaDevices as any;
        if (md && typeof md.getDisplayMedia === 'function') {
            md.getDisplayMedia = () => md.getUserMedia({ video: true, audio: true });
        }
    });
}

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 20000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function waitForWs(page: any, maxRetries = 60) {
    return await page.evaluate((maxRetries: number) => {
        return new Promise((resolve) => {
            let tries = 0;
            const check = () => {
                tries++;
                if (typeof (window as any).ws !== 'undefined' && (window as any).ws && (window as any).ws.readyState === WebSocket.OPEN) resolve(true);
                else if (tries >= maxRetries) resolve(false);
                else setTimeout(check, 200);
            };
            setTimeout(check, 500);
        });
    }, maxRetries);
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

/** A real mesh (E2EE) DM call — the relay path has no encoded keyframes at all. */
async function setupDmCall(page: any, page2: any, dm: any, userData: any, peerUsername: string) {
    await waitForWs(page);
    await waitForWs(page2);
    await openDm(page);
    await page.waitForFunction(() => {
        const v = (window as any).VoiceManager;
        return v && typeof v.startDmCall === 'function';
    }, undefined, { timeout: 15000 });
    await page.evaluate(({ dmId, uid, uname }) => {
        (window as any).VoiceManager.startDmCall(dmId, uid, uname);
    }, { dmId: dm.id, uid: userData.id, uname: peerUsername });
    await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });
    await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 20000 });
    await page2.click('#incoming-call-accept');
    const isConnected = (p: any) =>
        p.waitForFunction(() => {
            const v = (window as any).VoiceManager;
            return !!(v && v._debug && v._debug.state && v._debug.state.connected);
        }, undefined, { timeout: 30000 });
    await isConnected(page);
    await isConnected(page2);
    await openDm(page2);
    await page2.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });
    await page.waitForTimeout(2500);
}

/**
 * Start a feed and report when the app considered it ON, plus the keyframe
 * requests that followed. The ON timestamp is observed in the page, so the delay
 * measured against it excludes camera acquisition.
 */
async function startFeedAndWatchKicks(page: any, what: string, stateFlag: string) {
    return await page.evaluate(({ what, stateFlag }: { what: string; stateFlag: string }) => {
        const w = window as any;
        const V = w.VoiceManager;
        w.__keyframePosts.length = 0;
        let resolve: (v: any) => void = () => {};
        const p = new Promise<any>((res) => { resolve = res; });
        const result: any = { onAt: 0 };
        const check = () => {
            if (V._debug.state[stateFlag]) {
                result.onAt = Date.now();
                resolve(result);
            } else setTimeout(check, 20);
        };
        V[what]();
        check();
        return p;
    }, { what, stateFlag });
}

test.describe('a fresh video feed is visible immediately', () => {
    test('starting a camera or a screen share re-kicks a keyframe from every video sender', async ({ page, context }) => {
        test.setTimeout(300000);
        const ts = Date.now();

        await instrumentPage(page);

        const uA = await registerUser(page, 'ffA_' + ts);
        await waitForWs(page);

        const ctxB = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        await instrumentPage(pageB);
        const uB = await registerUser(pageB, 'ffB_' + ts);
        await waitForWs(pageB);

        // Friends + a DM, then a full call.
        const fcB = await pageB.evaluate(() => localStorage.getItem('e2e_friend_code'));
        const fr = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${uA.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: fcB },
        });
        expect(fr.ok()).toBeTruthy();
        const incoming = await (await pageB.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${uB.token}` },
        })).json();
        await pageB.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${uB.token}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        const userDataB = await (await page.request.get(`${BASE}/api/user/${uB.user.username}`, {
            headers: { Authorization: `Bearer ${uA.token}` },
        })).json();
        const dm = await (await page.request.post(`${BASE}/api/dm/${userDataB.id}`, {
            headers: { Authorization: `Bearer ${uA.token}` },
        })).json();
        expect(dm.id).toBeTruthy();
        await page.goto(`${BASE}/index.html`);
        await pageB.goto(`${BASE}/index.html`);

        await setupDmCall(page, pageB, dm, userDataB, uB.user.username);

        // ── Phase 0: audio only. Nothing video is being sent, so the kick must
        // not fire — otherwise it would be noise on every peer creation.
        await page.evaluate(() => { (window as any).__keyframePosts.length = 0; });
        await page.waitForTimeout(3000);
        expect(await page.evaluate(() => (window as any).__keyframePosts.length), 'no video sender: no keyframe spam').toBe(0);

        // ── Phase 1: camera, first time in this call.
        const cam = await startFeedAndWatchKicks(page, 'toggleCamera', 'cameraOn');
        await page.waitForTimeout(1600);
        const camPosts: number[] = await page.evaluate(() => (window as any).__keyframePosts.slice());
        expect(camPosts.length, 'camera start re-kicks a keyframe').toBeGreaterThanOrEqual(2);
        // ...and it starts immediately, not after the 2.5s periodic timer.
        expect(cam.onAt, 'camera flagged on').toBeGreaterThan(0);
        expect(camPosts[0] - cam.onAt, 'the first kick is immediate').toBeLessThan(600);

        // ── Phase 2: the receiving side actually paints, and paints quickly.
        const decoded = await pageB.evaluate(async (since: number) => {
            const V = (window as any).VoiceManager;
            const S = V._debug.state;
            const uid = Object.keys(S.peers || {})[0];
            if (!uid) return { ms: -1, frames: 0 };
            const pc = S.peers[uid];
            const deadline = Date.now() + 8000;
            while (Date.now() < deadline) {
                const stats = await pc.getStats();
                let frames = 0;
                stats.forEach((r: any) => {
                    if (r.type === 'inbound-rtp' && r.kind === 'video') frames += r.framesDecoded || 0;
                });
                if (frames > 0) return { ms: Date.now() - since, frames };
                await new Promise((r) => setTimeout(r, 100));
            }
            return { ms: -1, frames: 0 };
        }, camPosts[0]);
        console.log('FIRST-FRAME latency (ms) from the keyframe kick to a decoded frame on the peer:', JSON.stringify(decoded));
        expect(decoded.frames, 'the peer decodes camera frames').toBeGreaterThan(0);
        // Not a tight bound — the renegotiation itself takes time on a loaded
        // box. It is here so a regression back to "black for many seconds" fails.
        expect(decoded.ms, 'the first frame arrives without waiting out the periodic keyframe').toBeLessThan(5000);

        await page.evaluate(() => (window as any).VoiceManager.toggleCamera());
        await page.waitForTimeout(1500);

        // ── Phase 3: a screen share re-kicks on its own, separate feed.
        const scr = await startFeedAndWatchKicks(page, 'toggleScreen', 'screenOn');
        await page.waitForTimeout(1600);
        const scrPosts: number[] = await page.evaluate(() => (window as any).__keyframePosts.slice());
        expect(scrPosts.length, 'screen share start re-kicks a keyframe').toBeGreaterThanOrEqual(2);
        expect(scrPosts[0] - scr.onAt, 'the screen-share kick is immediate too').toBeLessThan(600);

        await ctxB.close().catch(() => {});
    });
});
