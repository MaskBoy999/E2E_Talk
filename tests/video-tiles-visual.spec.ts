import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// VISUAL verification for the camera-tile bug list.
//
// Every assertion here is checked against ACTUAL RENDERED PIXELS taken from a
// real (visible) browser window via page.screenshot() -> createImageBitmap ->
// getImageData, plus real element geometry. No "the DOM flag is set" guessing.
//
// The video source is a deterministic four-quadrant pattern so mirror /
// rotation are provable by sampling pixels:
//
//     +-----------+-----------+
//     |   RED     |  GREEN    |
//     +-----------+-----------+
//     |   WHITE   |  BLACK    |
//     +-----------+-----------+
// ---------------------------------------------------------------------------

const BASE = 'https://localhost:3443';
// Screenshots of the EXACT frames that were pixel-sampled land here (outside
// test-results/, which Playwright wipes at the start of every run) so a human
// can look at what the assertions saw. `*.png` is gitignored.
const SHOT_DIR = 'visual-evidence';

test.use({
    headless: false,
    ignoreHTTPSErrors: true,
    launchOptions: {
        args: [
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            '--ignore-certificate-errors',
        ],
    },
});

const SRC_W = 320;
const SRC_H = 240;
const SRC_ASPECT = SRC_W / SRC_H; // 1.333

type RGB = [number, number, number];
type Rect = { x: number; y: number; w: number; h: number };

// --- Media mock -------------------------------------------------------------

async function mockMedia(page: any) {
    await page.addInitScript((dims: { W: number; H: number }) => {
        const W = dims.W, H = dims.H;
        const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        function paint(ctx: CanvasRenderingContext2D, tick: number) {
            ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, W, H);
            ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, W / 2, H / 2);
            ctx.fillStyle = '#00ff00'; ctx.fillRect(W / 2, 0, W / 2, H / 2);
            ctx.fillStyle = '#ffffff'; ctx.fillRect(0, H / 2, W / 2, H / 2);
            ctx.fillStyle = '#000000'; ctx.fillRect(W / 2, H / 2, W / 2, H / 2);
            // A tiny moving marker keeps real frames flowing (an unchanged
            // canvas stops emitting frames) while staying far away from the
            // quadrant sample points (20% / 80% of the content box).
            ctx.fillStyle = '#ff00ff';
            ctx.fillRect(2 + (tick % 40), 1, 4, 3);
        }
        function makeVideoStream() {
            const canvas = document.createElement('canvas');
            canvas.width = W; canvas.height = H;
            const ctx = canvas.getContext('2d')!;
            let tick = 0;
            paint(ctx, tick);
            const stream = (canvas as any).captureStream(30);
            setInterval(() => { tick++; paint(ctx, tick); }, 33);
            (window as any).__mockVideoCanvas = canvas;
            return stream;
        }
        navigator.mediaDevices.getUserMedia = async (constraints: any) => {
            if (constraints && constraints.video) return makeVideoStream();
            if (constraints && constraints.audio) {
                const ac = new (window as any).AudioContext();
                const osc = ac.createOscillator();
                const dest = ac.createMediaStreamDestination();
                osc.connect(dest);
                osc.start();
                return dest.stream;
            }
            return origGUM(constraints);
        };
        (navigator.mediaDevices as any).getDisplayMedia = async () => {
            const s = makeVideoStream();
            const out = new MediaStream();
            s.getVideoTracks().forEach((t: any) => out.addTrack(t));
            return out;
        };
    }, { W: SRC_W, H: SRC_H });
}

// --- App helpers (mirrors tests/resolution-fps.spec.ts) ---------------------

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function waitForWs(page: any, maxRetries = 60) {
    return await page.evaluate((n: number) => new Promise((resolve) => {
        let tries = 0;
        const check = () => {
            tries++;
            const ws = (window as any).ws;
            if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) resolve(true);
            else if (tries >= n) resolve(false);
            else setTimeout(check, 200);
        };
        setTimeout(check, 500);
    }), maxRetries);
}

async function createServerWithVoiceChannel(page: any, token: string) {
    const ts = Date.now();
    const inviteCode = 'VTV' + ts + Math.floor(Math.random() * 1000);
    const prep = await page.evaluate(async ({ inviteCode }: { inviteCode: string }) => {
        const E = (window as any).E2ECrypto;
        const symKey = E.generateSymmetricKey();
        const encName = E.aeadEncrypt('VT Visual Server', symKey);
        const encCh = E.aeadEncrypt('voice', symKey);
        return {
            encrypted_name: encName.ciphertext, name_nonce: encName.nonce,
            channel_encrypted_name: encCh.ciphertext, channel_name_nonce: encCh.nonce,
            invite_code: inviteCode,
        };
    }, { inviteCode });
    const srv = await (await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            invite_code: inviteCode,
            encrypted_name: prep.encrypted_name, name_nonce: prep.name_nonce,
            channel_encrypted_name: prep.channel_encrypted_name, channel_name_nonce: prep.channel_name_nonce,
        },
    })).json();
    const serverId = srv.id;
    await page.evaluate(async ({ serverId }: { serverId: string }) => {
        const E = (window as any).E2ECrypto;
        const symKey = E.generateSymmetricKey();
        E.saveServerKey(serverId, symKey);
        const identity = E.getIdentityKeyPair();
        const myId = JSON.parse(localStorage.getItem('user') || '{}').id;
        const pubRes = await fetch('/api/identity/' + myId, { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
        const pubData = await pubRes.json();
        const pubKey = new Uint8Array(E.base64ToArrayBuffer(pubData.identity_public_key));
        const enc = E.envelopeEncrypt(symKey, pubKey, identity.privateKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: myId,
                encrypted_key: enc.ciphertext,
                sender_public_key: E.arrayBufferToBase64(identity.publicKey),
                nonce: enc.nonce,
            }),
        });
    }, { serverId });
    const ch = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { name: 'Voice', channel_type: 'voice' },
    })).json();
    expect(ch.channel_type).toBe('voice');
    return { serverId, voiceChannelId: ch.id, inviteCode };
}

async function joinServerViaInvite(page: any, token: string, inviteCode: string) {
    const join = await page.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { code: inviteCode },
    });
    expect(join.ok()).toBeTruthy();
    return (await join.json()).id;
}

async function selectServer(page: any) {
    await page.evaluate(() => { if (typeof (window as any).loadServers === 'function') (window as any).loadServers(); }).catch(() => {});
    await page.waitForTimeout(600);
    for (let i = 0; i < 30; i++) {
        const el = page.locator('.server-icon[data-id]').first();
        if (await el.count()) {
            await el.click().catch(() => {});
            await page.waitForTimeout(600);
            return true;
        }
        await page.waitForTimeout(300);
    }
    return false;
}

async function clickVoiceChannel(page: any, channelId: string) {
    for (let i = 0; i < 40; i++) {
        const el = page.locator(`.channel-item[data-id="${channelId}"]`);
        if (await el.count()) {
            await el.click();
            await page.waitForTimeout(500);
            return true;
        }
        await page.waitForTimeout(300);
    }
    return false;
}

async function waitForConnected(page: any, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const ok = await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            return !!(V && V._debug && V._debug.state && V._debug.state.connected);
        });
        if (ok) return true;
        await page.waitForTimeout(400);
    }
    return false;
}

// --- Pixel / geometry helpers ----------------------------------------------

async function rectOf(page: any, selector: string): Promise<Rect | null> {
    return await page.evaluate((sel: string) => {
        const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
        const el = els.find(e => e.offsetParent !== null || document.fullscreenElement === e || !!e.closest('.voice-fs-wrap'));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
    }, selector);
}

function contentBox(rect: Rect, srcAspect: number) {
    const boxAspect = rect.w / Math.max(1, rect.h);
    let cw: number, ch: number;
    if (srcAspect > boxAspect) { cw = rect.w; ch = rect.w / srcAspect; }
    else { ch = rect.h; cw = rect.h * srcAspect; }
    return { cw, ch, x: rect.x + (rect.w - cw) / 2, y: rect.y + (rect.h - ch) / 2 };
}

/** Sample the four quadrant centres of the VISIBLE video content. */
function quadrantPoints(rect: Rect, srcAspect: number) {
    const c = contentBox(rect, srcAspect);
    const cx = c.x + c.cw / 2;
    const cy = c.y + c.ch / 2;
    // Horizontal ±0.3 (20% / 80% across) and vertical ±0.12 (38% / 62%
    // down): staying in the middle band keeps the samples clear of the
    // "Reset view" chip, which is absolutely positioned over the BOTTOM of the
    // tile (~75%+ of its height) and would otherwise read as black.
    return {
        content: c,
        TL: { x: cx - c.cw * 0.3, y: cy - c.ch * 0.12 },
        TR: { x: cx + c.cw * 0.3, y: cy - c.ch * 0.12 },
        BL: { x: cx - c.cw * 0.3, y: cy + c.ch * 0.12 },
        BR: { x: cx + c.cw * 0.3, y: cy + c.ch * 0.12 },
    };
}

/** Screenshot the live page, then decode it IN THE PAGE and read pixels.
 *  When shotName is given the exact sampled frame is also saved for humans. */
async function samplePixels(page: any, pts: { x: number; y: number }[], shotName?: string): Promise<RGB[]> {
    const buf = await page.screenshot();
    if (shotName) writeShot(buf, shotName);
    const b64 = buf.toString('base64');
    return await page.evaluate(async ({ b64, pts }: any) => {
        // Decode the PNG in-page WITHOUT fetch(): the app ships a strict CSP
        // that blocks data: fetches.
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const bmp: any = await (window as any).createImageBitmap(new Blob([arr], { type: 'image/png' }));
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(bmp, 0, 0);
        return pts.map((p: any) => {
            const x = Math.max(0, Math.min(bmp.width - 1, Math.round(p.x)));
            const y = Math.max(0, Math.min(bmp.height - 1, Math.round(p.y)));
            const d = ctx.getImageData(x, y, 1, 1).data;
            return [d[0], d[1], d[2]];
        });
    }, { b64, pts });
}

function classify(c: RGB): string {
    const [r, g, b] = c;
    if (r > 140 && g < 110 && b < 110) return 'red';
    if (g > 140 && r < 110 && b < 110) return 'green';
    if (r > 190 && g > 190 && b > 190) return 'white';
    if (r < 70 && g < 70 && b < 70) return 'black';
    if (b > 140 && r < 110 && g < 110) return 'blue';
    if (r > 140 && b > 140 && g < 110) return 'magenta';
    return `other(${r},${g},${b})`;
}

/** Assert the four rendered quadrants of a tile match an expected layout. */
async function expectQuadrants(page: any, selector: string, srcAspect: number, expected: { TL: string; TR: string; BL: string; BR: string }, shotName: string) {
    const rect = await rectOf(page, selector);
    expect(rect, `tile not rendered: ${selector}`).not.toBeNull();
    const pts = quadrantPoints(rect!, srcAspect);
    const [tl, tr, bl, br] = await samplePixels(page, [pts.TL, pts.TR, pts.BL, pts.BR], shotName);
    console.log(`[pixels] ${shotName} TL=${tl} TR=${tr} BL=${bl} BR=${br}`);
    const got = { TL: classify(tl), TR: classify(tr), BL: classify(bl), BR: classify(br) };
    expect(got).toEqual(expected);
    return got;
}

function writeShot(buf: Buffer, name: string) {
    try {
        if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
        fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), buf);
    } catch (_) { /* screenshots are for humans; never fail a test on them */ }
}

async function saveShot(page: any, name: string) {
    try { writeShot(await page.screenshot(), name); } catch (_) { /* ignore */ }
}

// --- Room setup -------------------------------------------------------------

async function setupVoicePair(browser: any, tag: string) {
    const ctxA = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    const pageA = await ctxA.newPage();
    await mockMedia(pageA);
    const uA = await registerUser(pageA, 'vt_a_' + tag);
    await pageA.goto(`${BASE}/index.html`);
    await waitForWs(pageA);
    const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(pageA, uA.token);

    const ctxB = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    const pageB = await ctxB.newPage();
    await mockMedia(pageB);
    const uB = await registerUser(pageB, 'vt_b_' + tag);
    await joinServerViaInvite(pageB, uB.token, inviteCode);
    await pageB.goto(`${BASE}/index.html`);
    await waitForWs(pageB);

    await selectServer(pageA);
    await clickVoiceChannel(pageA, voiceChannelId);
    await waitForConnected(pageA);
    await selectServer(pageB);
    await clickVoiceChannel(pageB, voiceChannelId);
    await waitForConnected(pageB);
    return { ctxA, pageA, uA, ctxB, pageB, uB, serverId, voiceChannelId };
}

/** Start A's camera in relay mode and open B's voice-channel view. */
async function startRelayCamera(pair: any) {
    const aUid = pair.uA.user.id;
    await pair.pageA.evaluate(() => { (window as any).VoiceManager.setSelfVideoMode('relay'); });
    await pair.pageA.evaluate(() => {
        const V = (window as any).VoiceManager;
        if (!V._debug.state.cameraOn) V.toggleCamera();
    });
    await pair.pageA.waitForFunction(() => (window as any).VoiceManager._debug.state.cameraOn, undefined, { timeout: 30000 });
    await pair.pageB.evaluate(() => (window as any).VoiceManager.navigateToVoiceChannel());
    await pair.pageB.waitForSelector(`img.relay-video[data-uid="${aUid}"][data-kind="camera"]`, { timeout: 45000 });
    // Let a few frames land and the layout settle.
    await pair.pageB.waitForTimeout(1500);
    return aUid;
}

// The app legitimately renders the same feed in TWO surfaces (the server
// voice-popup member row and the DM call tile). Tests scope to the surface
// they are looking at; "which one is visible" is exactly what the app must
// resolve internally (pickVisibleTile / injectRelayTile).
function relaySel(uid: string, kind: string) {
    return `#voice-popup-members img.relay-video[data-uid="${uid}"][data-kind="${kind}"]`;
}

async function closePair(pair: any) {
    await pair.ctxB.close().catch(() => {});
    await pair.ctxA.close().catch(() => {});
}

// ===========================================================================
// Tests
// ===========================================================================

test.describe('camera tile visuals (real pixels)', () => {

    test('T1 relay tile: one visible tile only, mirror renders in real pixels', async ({ browser }) => {
        test.setTimeout(240000);
        const pair = await setupVoicePair(browser, Date.now().toString(36));
        try {
            const aUid = await startRelayCamera(pair);

            // Bug 12: relay <img> and hidden mesh <video> shared the same
            // [data-uid][data-kind]. Exactly ONE must be visible to the user.
            const dupInfo = await pair.pageB.evaluate((uid: string) => {
                const q = (s: string) => Array.from(document.querySelectorAll(s)) as HTMLElement[];
                const pop = '#voice-popup-members ';
                return {
                    imgs: q(`${pop}img.relay-video[data-uid="${uid}"][data-kind="camera"]`).map(e => ({ visible: !!e.offsetParent, relayHidden: e.getAttribute('data-relay-hidden') })),
                    vids: q(`${pop}video.remote-video-tile[data-uid="${uid}"][data-kind="camera"]`).map(e => ({ visible: !!e.offsetParent, relayHidden: e.getAttribute('data-relay-hidden') })),
                    // Cross-surface: however many containers hold this feed, the
                    // USER must only ever see ONE of them.
                    visibleAnywhere: q('img.relay-video, video.remote-video-tile').filter(e => e.dataset.uid === uid && e.dataset.kind === 'camera' && !!e.offsetParent).length,
                };
            }, aUid);
            console.log('[T1] dupInfo', JSON.stringify(dupInfo));
            // USER-VISIBLE invariant: however many nodes carry this feed, the
            // user must only ever see ONE of them (a relay <img> must not sit
            // next to a second visible mesh <video> for the same feed).
            const visibleCount = dupInfo.imgs.filter(i => i.visible).length + dupInfo.vids.filter(v => v.visible).length;
            expect(visibleCount, 'exactly one visible tile for a relay feed').toBe(1);
            expect(dupInfo.visibleAnywhere, 'one visible node for this feed in the whole page').toBe(1);
            expect(dupInfo.imgs.filter(i => i.visible).length, 'a relay tile is visible').toBe(1);

            // Identity layout
            await expectQuadrants(pair.pageB, relaySel(aUid, 'camera'), SRC_ASPECT,
                { TL: 'red', TR: 'green', BL: 'white', BR: 'black' }, 'T1-identity');

            // Mirror (right-click → View → Mirror, via the app's own code path)
            await pair.pageB.evaluate((uid: string) => {
                (window as any).VoiceManager._debug.setTileTransform(uid, 'camera', 'mirror', true);
            }, aUid);
            await pair.pageB.waitForTimeout(400);
            await expectQuadrants(pair.pageB, relaySel(aUid, 'camera'), SRC_ASPECT,
                { TL: 'green', TR: 'red', BL: 'black', BR: 'white' }, 'T1-mirrored');
        } finally {
            await closePair(pair);
        }
    });

    test('T2 fullscreen: transform visible, ONE click exits, and it can re-enter', async ({ browser }) => {
        test.setTimeout(240000);
        const pair = await setupVoicePair(browser, Date.now().toString(36));
        try {
            const aUid = await startRelayCamera(pair);
            const sel = relaySel(aUid, 'camera');
            await pair.pageB.evaluate((uid: string) => {
                (window as any).VoiceManager._debug.setTileTransform(uid, 'camera', 'mirror', true);
            }, aUid);
            await pair.pageB.waitForTimeout(300);

            // Enter fullscreen with a real click (user activation)
            await pair.pageB.locator(sel).click();
            await pair.pageB.waitForFunction(() => !!document.fullscreenElement, undefined, { timeout: 10000 });
            await pair.pageB.waitForTimeout(700);

            const fsState = await pair.pageB.evaluate((s: string) => {
                const e = document.fullscreenElement as HTMLElement | null;
                const tile = document.querySelector(s) as HTMLElement | null;
                const r = e ? e.getBoundingClientRect() : null;
                return {
                    tag: e ? e.tagName : null,
                    // The fullscreen element must be the WRAPPER div: Chrome's
                    // fullscreen UA stylesheet forces transform:none on the
                    // fullscreen element, so the tile itself is never used.
                    isWrap: !!e && e.classList.contains('voice-fs-wrap'),
                    containsTile: !!(e && tile && e.contains(tile)),
                    tileTransform: tile ? getComputedStyle(tile).transform : null,
                    w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0,
                    vw: window.innerWidth, vh: window.innerHeight,
                };
            }, sel);
            console.log('[T2] fsState', JSON.stringify(fsState));

            // ---------- USER-VISIBLE CHECK 1 (bug 1) ----------
            // What the user SEES on screen in fullscreen must be the mirrored
            // feed. (Chrome's fullscreen UA stylesheet forces transform:none on
            // the fullscreen element, so fullscreening the tile directly showed
            // the RAW, untransformed video.)
            await expectQuadrants(pair.pageB, sel, SRC_ASPECT,
                { TL: 'green', TR: 'red', BL: 'black', BR: 'white' }, 'T2-fullscreen-mirrored');

            // ---------- USER-VISIBLE CHECK 2 (bug 13) ----------
            // A single click in fullscreen must EXIT — not exit and re-enter
            // (the old `exitFullscreen().then(() => toggleFullscreen(el))`
            // branch bounced straight back in, so only Escape worked and phone
            // users were trapped).
            await pair.pageB.locator(sel).click();
            await pair.pageB.waitForTimeout(900);
            const stillFs = await pair.pageB.evaluate(() => !!document.fullscreenElement);
            expect(stillFs, 'clicking inside fullscreen must leave fullscreen').toBe(false);
            // ...and the tile must be back in its row, visible
            const backVisible = await pair.pageB.evaluate((uid: string) => {
                const e = document.querySelector(`img.relay-video[data-uid="${uid}"][data-kind="camera"]`) as HTMLElement | null;
                return !!e && !!e.offsetParent && !!e.closest('.voice-member-media');
            }, aUid);
            expect(backVisible, 'tile returns to its member row after exiting fullscreen').toBe(true);

            // ---------- USER-VISIBLE CHECK 3 (bug 5) ----------
            // Entering fullscreen AGAIN must work (a stale guard used to make
            // the second attempt a no-op).
            await pair.pageB.locator(sel).click();
            await pair.pageB.waitForFunction(() => !!document.fullscreenElement, undefined, { timeout: 10000 });
            const reEntered = await pair.pageB.evaluate((s: string) => {
                const e = document.fullscreenElement as HTMLElement | null;
                const tile = document.querySelector(s) as HTMLElement | null;
                return !!(e && tile && e.contains(tile));
            }, sel);
            expect(reEntered, 'second fullscreen entry works').toBeTruthy();
            await pair.pageB.evaluate(() => document.exitFullscreen());
            await pair.pageB.waitForTimeout(700);
            // Implementation note (informational): with the fix the fullscreen
            // element is the .voice-fs-wrap DIV that holds the tile, which is
            // what keeps the transform renderable. A fullscreen element that is
            // the tile itself cannot show mirror/rotation on Chrome.
            console.log('[T2] fullscreen-element holds tile =', fsState.containsTile, ', tile transform =', fsState.tileTransform);
            expect(fsState.containsTile, 'tile is inside the fullscreen element').toBe(true);
        } finally {
            await closePair(pair);
        }
    });

    test('T2b fullscreen: ONE click exits (no bounce-back) and the tile returns home', async ({ browser }) => {
        test.setTimeout(240000);
        const pair = await setupVoicePair(browser, Date.now().toString(36));
        try {
            const aUid = await startRelayCamera(pair);
            const sel = relaySel(aUid, 'camera');

            await pair.pageB.locator(sel).click();
            await pair.pageB.waitForFunction(() => !!document.fullscreenElement, undefined, { timeout: 10000 });
            await pair.pageB.waitForTimeout(800);
            expect(await pair.pageB.evaluate(() => !!document.fullscreenElement)).toBe(true);

            // ONE click must exit and STAY out (the old code exited and
            // immediately re-entered, so users had to press Escape).
            await pair.pageB.locator(sel).click();
            await pair.pageB.waitForTimeout(1200);
            const afterClick = await pair.pageB.evaluate((uid: string) => {
                const e = document.querySelector(`img.relay-video[data-uid="${uid}"][data-kind="camera"]`) as HTMLElement | null;
                return {
                    fullscreen: !!document.fullscreenElement,
                    inRow: !!e && !!e.closest('.voice-member-media'),
                    visible: !!e && !!e.offsetParent,
                    transform: e ? getComputedStyle(e).transform : null,
                };
            }, aUid);
            console.log('[T2b] after click', JSON.stringify(afterClick));
            expect(afterClick.fullscreen, 'one click leaves fullscreen').toBe(false);
            expect(afterClick.inRow, 'tile is back in its member row').toBe(true);
            expect(afterClick.visible, 'tile is visible again').toBe(true);
            await saveShot(pair.pageB, 'T2b-after-exit');

            // Entering fullscreen again must still work.
            await pair.pageB.locator(sel).click();
            await pair.pageB.waitForFunction(() => !!document.fullscreenElement, undefined, { timeout: 10000 });
            expect(await pair.pageB.evaluate(() => !!document.fullscreenElement)).toBe(true);
            await pair.pageB.evaluate(() => document.exitFullscreen());
        } finally {
            await closePair(pair);
        }
    });

    test('T3 Picture-in-Picture: canvas pipeline draws real frames and cleans up', async ({ browser }) => {
        test.setTimeout(240000);
        const pair = await setupVoicePair(browser, Date.now().toString(36));
        try {
            const aUid = await startRelayCamera(pair);
            await pair.pageB.evaluate((uid: string) => {
                (window as any).VoiceManager._debug.setTileTransform(uid, 'camera', 'mirror', true);
            }, aUid);
            await pair.pageB.waitForTimeout(300);
            await pair.pageB.evaluate(() => (window as any).VoiceManager.navigateToVoiceChannel());
            await pair.pageB.waitForTimeout(500);

            const pipEnabled = await pair.pageB.evaluate(() => document.pictureInPictureEnabled);
            test.skip(!pipEnabled, 'Picture-in-Picture is not available in this browser build');

            // Real click on the PiP control (user activation required).
            const pipBtn = pair.pageB.locator('#voice-popup-pip');
            await expect(pipBtn).toHaveCount(1);
            pair.pageB.on('console', (m: any) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[T3 page]', m.text().slice(0, 200)); });
            const btnVisible = await pipBtn.isVisible();
            console.log('[T3] pip button visible =', btnVisible);
            await pipBtn.click();
            let pipOk = true;
            try {
                await pair.pageB.waitForFunction(() => !!document.pictureInPictureElement, undefined, { timeout: 15000 });
            } catch (_) { pipOk = false; }
            if (!pipOk) {
                const diag = await pair.pageB.evaluate(() => ({
                    pipEnabled: document.pictureInPictureEnabled,
                    pipEl: !!document.pictureInPictureElement,
                    hasCanvas: !!(window as any)._pipCanvas,
                    frames: (window as any)._pipFramesDrawn || 0,
                    lastError: (window as any)._pipLastError || null,
                    hiddenVideos: (document.querySelectorAll('video[style*="9999px"]') || []).length,
                    toast: (document.querySelector('.toast, .app-toast, #toast') as HTMLElement | null)?.textContent || null,
                }));
                console.log('[T3] diag', JSON.stringify(diag));
            }
            expect(pipOk, 'PiP window opened from the relay tile').toBe(true);
            await pair.pageB.waitForTimeout(1200);

            // Bug 2/3: the canvas must actually be drawing (not blank).
            const canvasInfo = await pair.pageB.evaluate(() => {
                const c = (window as any)._pipCanvas as HTMLCanvasElement | null;
                if (!c) return { present: false };
                const ctx = c.getContext('2d')!;
                const px = (fx: number, fy: number) => {
                    const d = ctx.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data;
                    return [d[0], d[1], d[2]];
                };
                return {
                    present: true,
                    w: c.width, h: c.height,
                    frames: (window as any)._pipFramesDrawn || 0,
                    lastError: (window as any)._pipLastError || null,
                    TL: px(0.2, 0.2), TR: px(0.8, 0.2), BL: px(0.2, 0.8), BR: px(0.8, 0.8),
                };
            });
            expect(canvasInfo.present, 'PiP compositing canvas exists').toBe(true);
            expect(canvasInfo.frames, 'draw loop must render frames').toBeGreaterThan(5);
            expect(canvasInfo.lastError).toBeNull();
            // Mirror is applied INSIDE the canvas pipeline, so the composited
            // frame must show the mirrored layout.
            const layout = {
                TL: classify(canvasInfo.TL as RGB), TR: classify(canvasInfo.TR as RGB),
                BL: classify(canvasInfo.BL as RGB), BR: classify(canvasInfo.BR as RGB),
            };
            expect(layout).toEqual({ TL: 'green', TR: 'red', BL: 'black', BR: 'white' });
            await saveShot(pair.pageB, 'T3-pip-active');

            // Bug 9: exiting PiP must release the canvas + hidden <video>.
            await pipBtn.click();
            await pair.pageB.waitForTimeout(900);
            const after = await pair.pageB.evaluate(() => ({
                pipEl: !!document.pictureInPictureElement,
                canvas: !!(window as any)._pipCanvas,
                stray: (document.querySelectorAll('video[style*="-9999px"], video[style*="9999px"]') || []).length,
            }));
            expect(after.pipEl).toBe(false);
            expect(after.canvas, 'canvas released on exit').toBe(false);
            expect(after.stray, 'hidden PiP <video> removed on exit').toBe(0);
        } finally {
            await closePair(pair);
        }
    });

    test('T4 tile geometry: never bigger than its row, and survives a fullscreen round-trip', async ({ browser }) => {
        test.setTimeout(240000);
        const pair = await setupVoicePair(browser, Date.now().toString(36));
        try {
            const aUid = await startRelayCamera(pair);
            const sel = relaySel(aUid, 'camera');

            const measure = async () => await pair.pageB.evaluate((uid: string) => {
                const img = document.querySelector(`#voice-popup-members img.relay-video[data-uid="${uid}"][data-kind="camera"]`) as HTMLElement | null;
                const box = img ? img.closest('.voice-member-media') as HTMLElement | null : null;
                if (!img || !box) return null;
                const a = img.getBoundingClientRect(), b = box.getBoundingClientRect();
                return {
                    img: { w: Math.round(a.width), h: Math.round(a.height), top: Math.round(a.top), bottom: Math.round(a.bottom), left: Math.round(a.left), right: Math.round(a.right) },
                    box: { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) },
                    inline: img.getAttribute('style') || '',
                };
            }, aUid);

            // Bug 4: the camera tile must fit inside its media row (96px tall).
            const before = await measure();
            expect(before).not.toBeNull();
            expect(before!.box.h).toBeLessThanOrEqual(100);
            expect(before!.img.h, 'tile height must not exceed the 96px row').toBeLessThanOrEqual(before!.box.h + 1);
            expect(before!.img.w, 'tile width must not exceed its media box').toBeLessThanOrEqual(before!.box.w + 1);
            expect(before!.img.left).toBeGreaterThanOrEqual(before!.box.left - 1);
            expect(before!.img.right).toBeLessThanOrEqual(before!.box.right + 1);

            // Round-trip fullscreen: stale inline dims used to survive it and
            // leave the tile oversized / cropped (bugs 4 + 7).
            await pair.pageB.locator(sel).click();
            await pair.pageB.waitForFunction(() => !!document.fullscreenElement, undefined, { timeout: 10000 });
            await pair.pageB.waitForTimeout(500);
            await pair.pageB.locator(sel).click();
            await pair.pageB.waitForFunction(() => !document.fullscreenElement, undefined, { timeout: 10000 });
            await pair.pageB.waitForTimeout(800);

            const after = await measure();
            expect(after).not.toBeNull();
            expect(after!.img.h, 'tile height after fullscreen must still fit the row').toBeLessThanOrEqual(after!.box.h + 1);
            expect(after!.img.w).toBeLessThanOrEqual(after!.box.w + 1);
            expect(Math.abs(after!.img.h - before!.img.h), 'tile size unchanged by a fullscreen round-trip').toBeLessThanOrEqual(2);
            expect(Math.abs(after!.img.w - before!.img.w)).toBeLessThanOrEqual(2);
            await saveShot(pair.pageB, 'T4-after-fullscreen');
        } finally {
            await closePair(pair);
        }
    });

    test('T5 transforms survive a voice-popup re-render (close/reopen, member update)', async ({ browser }) => {
        test.setTimeout(240000);
        const pair = await setupVoicePair(browser, Date.now().toString(36));
        try {
            const aUid = await startRelayCamera(pair);
            const sel = relaySel(aUid, 'camera');
            await pair.pageB.evaluate((uid: string) => {
                (window as any).VoiceManager._debug.setTileTransform(uid, 'camera', 'mirror', true);
            }, aUid);
            await pair.pageB.waitForTimeout(400);
            await expectQuadrants(pair.pageB, sel, SRC_ASPECT, { TL: 'green', TR: 'red', BL: 'black', BR: 'white' }, 'T5-before-rerender');

            // Force a full tile rebuild the way the app does it (renderPopup()
            // destroys every tile and re-injects relay frames).
            await pair.pageB.evaluate((uid: string) => {
                (window as any).VoiceManager._debug.setMemberSpeaking(uid, true);
            }, aUid);
            await pair.pageB.waitForTimeout(1200);
            await pair.pageB.evaluate((uid: string) => {
                (window as any).VoiceManager._debug.setMemberSpeaking(uid, false);
            }, aUid);
            await pair.pageB.waitForTimeout(1200);

            const state = await pair.pageB.evaluate((uid: string) => {
                const S = (window as any).VoiceManager._debug.state;
                const img = document.querySelector(`#voice-popup-members img.relay-video[data-uid="${uid}"][data-kind="camera"]`) as HTMLElement | null;
                const box = img ? img.closest('.voice-member-media') as HTMLElement | null : null;
                const a = img ? img.getBoundingClientRect() : null;
                const b = box ? box.getBoundingClientRect() : null;
                return {
                    transform: img ? getComputedStyle(img).transform : null,
                    tileTransform: S.tileTransforms[uid + ':camera'] || null,
                    chip: !!document.querySelector('.voice-tile-reset-view'),
                    imgH: a ? Math.round(a.height) : 0,
                    boxH: b ? Math.round(b.height) : 0,
                    imgW: a ? Math.round(a.width) : 0,
                    boxW: b ? Math.round(b.width) : 0,
                };
            }, aUid);
            expect(state.tileTransform, 'per-viewer transform state kept').toEqual({ mirror: true, rot: 0 });
            expect(state.transform, 'mirror must be applied to the rebuilt tile').not.toBe('none');
            expect(state.imgH).toBeLessThanOrEqual(state.boxH + 1);
            expect(state.imgW).toBeLessThanOrEqual(state.boxW + 1);
            expect(state.chip, 'reset-view chip restored').toBe(true);
            await expectQuadrants(pair.pageB, sel, SRC_ASPECT, { TL: 'green', TR: 'red', BL: 'black', BR: 'white' }, 'T5-after-rerender');
        } finally {
            await closePair(pair);
        }
    });

    test('T6 two tiles: fullscreen each in turn without freezing the other', async ({ browser }) => {
        test.setTimeout(300000);
        const pair = await setupVoicePair(browser, Date.now().toString(36));
        try {
            // Camera + screen share from A (both relay) → two tiles on B.
            await pair.pageA.evaluate(() => { (window as any).VoiceManager.setSelfVideoMode('relay'); });
            await pair.pageA.evaluate(() => {
                const V = (window as any).VoiceManager;
                if (!V._debug.state.cameraOn) V.toggleCamera();
                if (!V._debug.state.screenOn) V.toggleScreen();
            });
            await pair.pageA.waitForFunction(() => {
                const s = (window as any).VoiceManager._debug.state;
                return s.cameraOn && s.screenOn;
            }, undefined, { timeout: 45000 });
            const aUid = pair.uA.user.id;
            await pair.pageB.evaluate(() => (window as any).VoiceManager.navigateToVoiceChannel());
            await pair.pageB.waitForSelector(`img.relay-video[data-uid="${aUid}"][data-kind="camera"]`, { timeout: 45000 });
            await pair.pageB.waitForSelector(`img.relay-video[data-uid="${aUid}"][data-kind="screen"]`, { timeout: 45000 });
            await pair.pageB.waitForTimeout(1500);

            const camSel = relaySel(aUid, 'camera');
            const scrSel = relaySel(aUid, 'screen');

            for (const [name, sel] of [['camera', camSel], ['screen', scrSel]] as const) {
                await pair.pageB.locator(sel).click();
                await pair.pageB.waitForFunction(() => !!document.fullscreenElement, undefined, { timeout: 10000 });
                await pair.pageB.waitForTimeout(600);
                const isRight = await pair.pageB.evaluate((s: string) => {
                    const e = document.fullscreenElement as HTMLElement | null;
                    const want = document.querySelector(s) as HTMLElement | null;
                    return !!(e && want && e.contains(want));
                }, sel);
                expect(isRight, `${name} tile is the fullscreen element`).toBe(true);
                await saveShot(pair.pageB, `T6-fullscreen-${name}`);

                await pair.pageB.locator(sel).click();
                await pair.pageB.waitForFunction(() => !document.fullscreenElement, undefined, { timeout: 10000 });
                await pair.pageB.waitForTimeout(700);

                // Bug 11: after exiting, BOTH tiles must be back, visible, in
                // their rows, and still receiving frames.
                const both = await pair.pageB.evaluate((uid: string) => {
                    const out: any = {};
                    for (const k of ['camera', 'screen']) {
                        const e = document.querySelector(`#voice-popup-members img.relay-video[data-uid="${uid}"][data-kind="${k}"]`) as HTMLElement | null;
                        out[k] = { exists: !!e, visible: !!e && !!e.offsetParent, inRow: !!e && !!e.closest('.voice-member-media'), src: !!(e && e.src) };
                    }
                    out.wraps = document.querySelectorAll('.voice-fs-wrap').length;
                    return out;
                }, aUid);
                expect(both.wraps, 'no leftover fullscreen wrapper').toBe(0);
                for (const k of ['camera', 'screen'] as const) {
                    expect(both[k].exists, `${k} tile exists`).toBe(true);
                    expect(both[k].visible, `${k} tile visible`).toBe(true);
                    expect(both[k].inRow, `${k} tile back in its row`).toBe(true);
                    expect(both[k].src, `${k} tile still has a frame`).toBe(true);
                }
            }
            await saveShot(pair.pageB, 'T6-both-tiles-back');
        } finally {
            await closePair(pair);
        }
    });

    test('T7 relay FPS: full rate even when the sending window is not focused', async ({ browser }) => {
        test.setTimeout(240000);
        const pair = await setupVoicePair(browser, Date.now().toString(36));
        try {
            const aUid = await startRelayCamera(pair);
            // Focus B so A's window is unfocused — the state that used to drop
            // the capture loop to ~1fps (Chrome clamps setTimeout to 1s).
            await pair.pageB.bringToFront();
            await pair.pageB.waitForTimeout(600);
            const aFocused = await pair.pageA.evaluate(() => document.hasFocus());

            const t0 = Date.now();
            const s0 = await pair.pageA.evaluate(() => {
                const S = (window as any).VoiceManager._debug.state;
                return (S._relayStats && S._relayStats.camera && S._relayStats.camera.sent) || 0;
            });
            await pair.pageB.waitForTimeout(3000);
            const s1 = await pair.pageA.evaluate(() => {
                const S = (window as any).VoiceManager._debug.state;
                return (S._relayStats && S._relayStats.camera && S._relayStats.camera.sent) || 0;
            });
            const seconds = (Date.now() - t0) / 1000;
            const fps = (s1 - s0) / seconds;
            console.log(`[T7] sender fps=${fps.toFixed(1)} (A focused=${aFocused})`);

            // PRIMARY (user-visible): the RECEIVER must keep getting fresh
            // frames. A ~1fps relay shows up here no matter what the sender's
            // internal counters say.
            const recv = await pair.pageB.evaluate(async (uid: string) => {
                const img = document.querySelector(`#voice-popup-members img.relay-video[data-uid="${uid}"][data-kind="camera"]`) as HTMLImageElement | null;
                if (!img) return { frames: 0 };
                let frames = 0;
                let last = img.src;
                const start = Date.now();
                while (Date.now() - start < 2000) {
                    await new Promise(r => setTimeout(r, 50));
                    if (img.src !== last) { frames++; last = img.src; }
                }
                return { frames };
            }, aUid);
            console.log(`[T7] receiver frames in 2s = ${recv.frames}`);
            expect(recv.frames, 'receiver must see fresh relay frames (> 2fps)').toBeGreaterThan(4);
            // SECONDARY (diagnostic): the sender loop must not be clamped either.
            // Only meaningful on builds that expose the counter.
            const hasCounter = await pair.pageA.evaluate(() => { const S = (window as any).VoiceManager._debug.state; return !!(S._relayStats && S._relayStats.camera); });
            if (hasCounter) expect(fps, 'relay capture must not fall back to ~1fps').toBeGreaterThan(6);
        } finally {
            await closePair(pair);
        }
    });

    test('T8 mobile: rotated tile + reset-view chip stay inside the tile and viewport', async ({ browser }) => {
        test.setTimeout(240000);
        const ctxA = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 780 } });
        const pageA = await ctxA.newPage();
        await mockMedia(pageA);
        const uA = await registerUser(pageA, 'vt_m_a_' + Date.now().toString(36));
        await pageA.goto(`${BASE}/index.html`);
        await waitForWs(pageA);
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(pageA, uA.token);

        const ctxB = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 780 } });
        const pageB = await ctxB.newPage();
        await mockMedia(pageB);
        const uB = await registerUser(pageB, 'vt_m_b_' + Date.now().toString(36));
        await joinServerViaInvite(pageB, uB.token, inviteCode);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);

        try {
            await selectServer(pageA);
            await clickVoiceChannel(pageA, voiceChannelId);
            await waitForConnected(pageA);
            await selectServer(pageB);
            await clickVoiceChannel(pageB, voiceChannelId);
            await waitForConnected(pageB);

            const aUid = uA.user.id;
            await pageA.evaluate(() => { (window as any).VoiceManager.setSelfVideoMode('relay'); });
            await pageA.evaluate(() => {
                const V = (window as any).VoiceManager;
                if (!V._debug.state.cameraOn) V.toggleCamera();
            });
            await pageB.evaluate(() => (window as any).VoiceManager.navigateToVoiceChannel());
            await pageB.waitForSelector(`img.relay-video[data-uid="${aUid}"][data-kind="camera"]`, { timeout: 45000 });
            await pageB.waitForTimeout(1200);

            await pageB.evaluate((uid: string) => {
                (window as any).VoiceManager._debug.setTileTransform(uid, 'camera', 'rot', 90);
            }, aUid);
            await pageB.waitForTimeout(900);

            // Bug 10: the reset chip must be fully inside the tile AND on screen.
            const geo = await pageB.evaluate((uid: string) => {
                const chip = document.querySelector('#voice-popup-members .voice-tile-reset-view') as HTMLElement | null;
                const img = document.querySelector(`#voice-popup-members img.relay-video[data-uid="${uid}"][data-kind="camera"]`) as HTMLElement | null;
                if (!chip || !img) return null;
                const c = chip.getBoundingClientRect();
                const t = img.getBoundingClientRect();
                return {
                    chip: { l: c.left, r: c.right, t: c.top, b: c.bottom, w: c.width, h: c.height },
                    tile: { l: t.left, r: t.right, t: t.top, b: t.bottom, w: t.width, h: t.height },
                    vw: window.innerWidth, vh: window.innerHeight,
                };
            }, aUid);
            expect(geo).not.toBeNull();
            expect(geo!.chip.l, 'chip left inside viewport').toBeGreaterThanOrEqual(-1);
            expect(geo!.chip.r, 'chip right inside viewport').toBeLessThanOrEqual(geo!.vw + 1);
            expect(geo!.chip.t).toBeGreaterThanOrEqual(-1);
            expect(geo!.chip.b).toBeLessThanOrEqual(geo!.vh + 1);
            // The chip may overhang a very narrow tile by its own width only if
            // the tile is narrower than the chip — it must be clamped to the
            // tile's left edge in that case.
            expect(geo!.chip.l, 'chip not clamped outside the tile').toBeGreaterThanOrEqual(geo!.tile.l - 1);
            expect(geo!.chip.r).toBeLessThanOrEqual(Math.max(geo!.tile.r, geo!.tile.l + geo!.chip.w) + 1);
            await saveShot(pageB, 'T8-mobile-rotated-chip');
        } finally {
            await ctxB.close().catch(() => {});
            await ctxA.close().catch(() => {});
        }
    });
});
