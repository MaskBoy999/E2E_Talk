/**
 * Preview sizing + fullscreen right-click, asserted from REAL layout.
 *
 * User reports covered here:
 *  1. "there should be a maximum size in the preview that keeps the perspective
 *     of the original video (camera or share) while resizing it to fit nicely in
 *     the max size taken from the space designated to the user row" — the tile's
 *     LAYOUT box must match the picture's ratio inside the row's space (a
 *     portrait phone camera used to sit in a wrong-shaped box that object-fit
 *     letterboxed, i.e. a big black area).
 *  2. "the reset view button looks to be in the wrong place because it overlaps
 *     our camera or screen share" — with free room beside the feed the chip must
 *     sit NEXT TO the picture, not on it.
 *  3. "I can't access the right click options (rotate, mirror, volume) while in
 *     voice channel fullscreen" — right-clicking the black area around a
 *     letterboxed fullscreen picture must still open the feed menu.
 */
import { test, expect } from '@playwright/test';
import { registerUser, createVoiceServer, joinVoice, selfCameraTile } from './_voice-helpers';

test.use({
    headless: false,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
    launchOptions: {
        args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            '--ignore-certificate-errors',
        ],
    },
});

// A PORTRAIT phone-style camera: 240×426 (9:16-ish). Landscape 4:3 (the other
// helper) never exercised the letterboxing this suite is about.
const SRC_W = 240;
const SRC_H = 426;

async function mockPortraitMedia(page: any) {
    await page.addInitScript(({ w, h }: { w: number; h: number }) => {
        const origGUM = (navigator.mediaDevices as any).getUserMedia.bind(navigator.mediaDevices);
        (navigator.mediaDevices as any).getUserMedia = async (constraints: any) => {
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
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d')!;
                function draw() {
                    ctx.fillStyle = '#ff0000';
                    ctx.fillRect(0, 0, canvas.width / 2, canvas.height / 2);
                    ctx.fillStyle = '#00ff00';
                    ctx.fillRect(canvas.width / 2, 0, canvas.width / 2, canvas.height / 2);
                    ctx.fillStyle = '#0000ff';
                    ctx.fillRect(0, canvas.height / 2, canvas.width / 2, canvas.height / 2);
                    ctx.fillStyle = '#ffff00';
                    ctx.fillRect(canvas.width / 2, canvas.height / 2, canvas.width / 2, canvas.height / 2);
                }
                draw();
                setInterval(draw, 100);
                return (canvas as any).captureStream(10);
            }
            return origGUM(constraints);
        };
        (navigator.mediaDevices as any).getDisplayMedia = async () =>
            (navigator.mediaDevices as any).getUserMedia({ video: true });
    }, { w: SRC_W, h: SRC_H });
}

async function portraitSelfCamera(page: any) {
    await mockPortraitMedia(page);
    const u = await registerUser(page, 'tft_' + Date.now() + '_' + Math.floor(Math.random() * 1e4));
    const srv = await createVoiceServer(page, 'TFT_' + Date.now());
    await joinVoice(page, srv.serverId, srv.channelId);
    await page.click('#voice-bar-camera');
    await page.waitForTimeout(2500);
    await page.evaluate(() => (window as any).VoiceManager.toggleServerPopup());
    await page.waitForTimeout(800);
    return u.user.id as string;
}

const BASE = 'https://localhost:3443';

async function waitForWs(page: any, maxRetries = 60) {
    return await page.evaluate((maxRetries) => {
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

test.describe('Preview fits the picture, chip stays off it, fullscreen menu works', () => {

    test('DM call self strip: portrait camera is not letterboxed inside a 240x150 box', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        await mockPortraitMedia(page);
        const u1 = await registerUser(page, 'tf1_' + ts);
        const ctx2 = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const page2 = await ctx2.newPage();
        await mockPortraitMedia(page2);
        const u2 = await registerUser(page2, 'tf2_' + ts);

        const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        const fr = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${u1.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: fc2 },
        });
        expect(fr.ok()).toBeTruthy();
        const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${u2.token}` },
        })).json();
        await page2.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${u2.token}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        const other = await (await page.request.get(`${BASE}/api/user/${u2.user.username}`, {
            headers: { Authorization: `Bearer ${u1.token}` },
        })).json();
        const dm = await (await page.request.post(`${BASE}/api/dm/${other.id}`, {
            headers: { Authorization: `Bearer ${u1.token}` },
        })).json();
        await waitForWs(page);
        await waitForWs(page2);

        await page.evaluate(({ dmId, uid, uname }) => {
            (window as any).VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: other.id, uname: u2.user.username });
        await page2.waitForSelector('#incoming-call-accept:visible', { timeout: 25000 });
        await page2.click('#incoming-call-accept');
        await page.waitForTimeout(2500);

        await page.evaluate(() => (window as any).VoiceManager.toggleCamera());
        await page.waitForFunction(() => (window as any).VoiceManager.getState().cameraOn, undefined, { timeout: 15000 });
        await page.waitForTimeout(2500);

        const geom = await page.evaluate(() => {
            const v = document.querySelector('#dm-call-self video.voice-self-video[data-kind="camera"]') as HTMLVideoElement | null;
            const wrap = document.getElementById('dm-call-self') as HTMLElement | null;
            if (!v || !wrap) return null;
            const r = v.getBoundingClientRect();
            const w = wrap.getBoundingClientRect();
            return {
                tile: { w: r.width, h: r.height },
                strip: { w: w.width, h: w.height },
                src: { w: v.videoWidth, h: v.videoHeight },
                maxW: parseFloat(getComputedStyle(v).maxWidth),
                maxH: parseFloat(getComputedStyle(v).maxHeight),
            };
        });
        console.log('DM SELF STRIP GEOMETRY:', JSON.stringify(geom));
        expect(geom).not.toBeNull();
        expect(geom!.src.w).toBeGreaterThan(0);
        // Box shape == picture shape (the old 240x150 box letterboxed a 9:16
        // phone camera into a mostly-black rectangle).
        const boxRatio = geom!.tile.w / geom!.tile.h;
        expect(Math.abs(boxRatio - geom!.src.w / geom!.src.h)).toBeLessThan(0.08);
        // ...and still bounded by the strip's designated space.
        expect(geom!.tile.h).toBeLessThanOrEqual(150 + 1.5);
        expect(geom!.tile.w).toBeLessThanOrEqual(geom!.strip.w + 1.5);

        await page2.close();
        await ctx2.close();
    });

    test('portrait camera: tile box keeps the source ratio inside the row space', async ({ page }) => {
        test.setTimeout(180000);
        const uid = await portraitSelfCamera(page);
        const sel = selfCameraTile(uid);

        const geom = await page.evaluate((uid) => {
            const row = document.querySelector(`.voice-member-row[data-uid="${uid}"]`) as HTMLElement;
            const media = row.querySelector('.voice-member-media') as HTMLElement;
            const tile = row.querySelector('.remote-video-tile[data-kind="camera"]') as HTMLVideoElement;
            const t = tile.getBoundingClientRect();
            const m = media.getBoundingClientRect();
            return {
                tile: { w: t.width, h: t.height },
                media: { w: m.width, h: m.height },
                src: { w: tile.videoWidth, h: tile.videoHeight },
                rowH: parseFloat(getComputedStyle(media).height),
            };
        }, uid);
        console.log('GEOMETRY:', JSON.stringify(geom));

        expect(geom.src.w).toBeGreaterThan(0);
        // The box must BE the picture's shape — no black letterbox inside it.
        const boxRatio = geom.tile.w / geom.tile.h;
        const srcRatio = geom.src.w / geom.src.h;
        expect(Math.abs(boxRatio - srcRatio)).toBeLessThan(0.08);
        // ...and it must fit the space the member row designates for it.
        expect(geom.tile.h).toBeLessThanOrEqual(geom.media.h + 1.5);
        expect(geom.tile.w).toBeLessThanOrEqual(geom.media.w + 1.5);
        expect(geom.tile.h).toBeLessThanOrEqual(geom.rowH + 1.5);
        // A portrait feed is taller than wide in its own box.
        expect(geom.tile.h).toBeGreaterThan(geom.tile.w);
    });

    test('reset-view chip sits beside the feed instead of on top of it', async ({ page }) => {
        test.setTimeout(180000);
        const uid = await portraitSelfCamera(page);
        const sel = selfCameraTile(uid);

        // Mirror our own camera through the real menu so the chip appears.
        await page.click(sel, { button: 'right' });
        const mirror = page.locator('#volume-menu .volume-menu-view-btn', { hasText: 'Mirror' });
        await expect(mirror.first()).toBeVisible({ timeout: 10000 });
        await mirror.first().click();
        // The menu closes so the effect is actually visible.
        await page.waitForSelector('#volume-menu', { state: 'hidden', timeout: 5000 });
        const mirrored = await page.evaluate((s) => {
            const v = document.querySelector(s) as HTMLElement;
            return v ? v.style.transform : null;
        }, sel);
        expect(mirrored).toContain('scaleX(-1)');

        await page.waitForSelector('.voice-tile-reset-view', { state: 'visible', timeout: 10000 });
        const geom = await page.evaluate((uid) => {
            const chip = document.querySelector('.voice-tile-reset-view') as HTMLElement;
            const tile = document.querySelector(`.voice-member-row[data-uid="${uid}"] .remote-video-tile[data-kind="camera"]`) as HTMLElement;
            const c = chip.getBoundingClientRect();
            const t = tile.getBoundingClientRect();
            const overlapX = Math.min(c.right, t.right) - Math.max(c.left, t.left);
            const overlapY = Math.min(c.bottom, t.bottom) - Math.max(c.top, t.top);
            return {
                chip: { x: c.x, y: c.y, w: c.width, h: c.height },
                tile: { x: t.x, y: t.y, w: t.width, h: t.height },
                overlapsFeed: overlapX > 1 && overlapY > 1,
                classes: chip.className,
            };
        }, uid);
        console.log('CHIP GEOMETRY:', JSON.stringify(geom));
        expect(geom.tile.w).toBeGreaterThan(2);
        expect(geom.overlapsFeed).toBe(false);

        // One click still resets the view.
        await page.click('.voice-tile-reset-view');
        await page.waitForTimeout(400);
        const after = await page.evaluate((s) => {
            const v = document.querySelector(s) as HTMLElement;
            return v ? v.style.transform : null;
        }, sel);
        expect(after === null || after === '').toBe(true);
    });

    test('fullscreen: right-clicking the black area still opens the feed menu', async ({ page }) => {
        test.setTimeout(180000);
        const uid = await portraitSelfCamera(page);
        const sel = selfCameraTile(uid);

        await page.click(sel);
        await page.waitForTimeout(1500);
        const fs = await page.evaluate(() => {
            const wrap = document.querySelector('.voice-fs-wrap') as HTMLElement | null;
            const tile = wrap ? (wrap.querySelector('.remote-video-tile') as HTMLElement) : null;
            return { hasWrap: !!wrap, native: !!document.fullscreenElement, tile: tile ? tile.getBoundingClientRect().toJSON() : null };
        });
        console.log('FULLSCREEN:', JSON.stringify(fs));
        expect(fs.hasWrap).toBe(true);

        // The picture is portrait, so the sides of the screen are the wrapper's
        // black area — this is what users actually right-click.
        const vp = page.viewportSize()!;
        const x = fs.tile && fs.tile.x > 40 ? fs.tile.x / 2 : 12;   // left black band
        await page.mouse.click(x, vp.height / 2, { button: 'right' });
        await page.waitForTimeout(500);
        const menu = await page.evaluate(() => {
            const m = document.getElementById('volume-menu') as HTMLElement | null;
            if (!m) return null;
            const fsEl = document.fullscreenElement as HTMLElement | null;
            return {
                display: getComputedStyle(m).display,
                text: m.innerText,
                inFullscreenElement: fsEl ? fsEl.contains(m) : false,
                viewButtons: m.querySelectorAll('.volume-menu-view-btn').length,
            };
        });
        console.log('FULLSCREEN BLACK-AREA MENU:', JSON.stringify(menu));
        expect(menu).not.toBeNull();
        expect(menu!.display).not.toBe('none');
        expect(menu!.viewButtons).toBeGreaterThanOrEqual(4);   // mirror / 90 / 90 / reset
    });
});
