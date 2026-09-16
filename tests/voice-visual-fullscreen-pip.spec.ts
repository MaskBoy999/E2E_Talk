/**
 * Fullscreen + PiP + transforms, asserted against COMPOSITED SCREEN PIXELS.
 *
 * Rewritten after an audit: the previous version of this file passed on the
 * pre-fix code, because it asserted `tile.style.transform === 'scaleX(-1) ...'`
 * and stubbed `requestFullscreen` to reject (so it only ever exercised the CSS
 * fallback). Neither sees what the user sees. Chrome's UA stylesheet forces
 * `transform: none !important` on the element it fullscreens, so with the old
 * code the inline declaration was present (`style.transform` = the expected
 * string) while the computed transform was `none` and the on-screen picture was
 * NOT mirrored. These tests read the picture instead.
 */
import { test, expect } from '@playwright/test';
import {
    mockMedia4Color,
    registerUser,
    createVoiceServer,
    joinVoice,
    openSelfCamera,
    setTransform,
    selfCameraTile,
    fullscreenInfo,
    compositedContent,
    compositedFullscreenContent,
    exitFullscreen,
} from './_voice-helpers';
import { flipGridH, matchRatio, diffRatio, gridToString, classify } from './_vision';

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
            '--enable-features=SharedArrayBuffer',
        ],
    },
});

async function selfCameraUp(page: any) {
    await mockMedia4Color(page);
    const u = await registerUser(page, 'vfs_' + Date.now() + '_' + Math.floor(Math.random() * 1e4));
    const srv = await createVoiceServer(page, 'VFS_' + Date.now());
    await joinVoice(page, srv.serverId, srv.channelId);
    await openSelfCamera(page);
    return u.user.id as string;
}

/** What the browser is actually applying to the element the user is looking at. */
async function computedTransformOfSubject(page: any) {
    return page.evaluate(() => {
        const wrapTile = document.querySelector('.voice-fs-wrap .remote-video-tile[data-kind="camera"]');
        const target = (wrapTile || document.fullscreenElement) as HTMLElement | null;
        return target ? getComputedStyle(target).transform : null;
    });
}

test.describe('User-visible: fullscreen + PiP + transforms', () => {

    test('mirror is visible in real fullscreen, not just written to style', async ({ page }) => {
        test.setTimeout(180000);
        const uid = await selfCameraUp(page);
        const sel = selfCameraTile(uid);

        const base = await compositedContent(page, sel);
        console.log('BASELINE grid:', gridToString(base.grid));

        // Control: in the normal (non-fullscreen) view the mirror is visible.
        await setTransform(page, uid, 'camera', 'mirror', true);
        const normalMirror = await compositedContent(page, sel);
        console.log('NORMAL-MIRROR grid:', gridToString(normalMirror.grid));
        expect(matchRatio(normalMirror.grid, flipGridH(base.grid))).toBeGreaterThanOrEqual(0.7);

        // The reported bug: in fullscreen the user sees the untransformed feed.
        await page.click(sel);
        await page.waitForTimeout(1500);
        const fs = await fullscreenInfo(page);
        console.log('FULLSCREEN info:', JSON.stringify(fs));
        expect(fs.hasFullscreenElement).toBe(true);

        const fsContent = await compositedFullscreenContent(page);
        console.log('FULLSCREEN grid:', gridToString(fsContent.grid));
        // The user's test: does the fullscreen picture look mirrored?
        expect(matchRatio(fsContent.grid, flipGridH(base.grid))).toBeGreaterThanOrEqual(0.7);

        const fsTransform = await computedTransformOfSubject(page);
        console.log('FULLSCREEN computed transform of the element being watched:', fsTransform);
        expect(fsTransform).not.toBe('none');

        await exitFullscreen(page);
        await setTransform(page, uid, 'camera', 'reset');
    });

    test('rotation visibly changes the picture in fullscreen', async ({ page }) => {
        test.setTimeout(180000);
        const uid = await selfCameraUp(page);
        const sel = selfCameraTile(uid);

        const base = await compositedContent(page, sel);

        await setTransform(page, uid, 'camera', 'rot', 90);
        const normalRot = await compositedContent(page, sel);
        console.log('NORMAL-ROT grid:', gridToString(normalRot.grid), 'baseline:', gridToString(base.grid));
        expect(diffRatio(normalRot.grid, base.grid)).toBeGreaterThanOrEqual(0.3);

        await page.click(sel);
        await page.waitForTimeout(1500);
        const fs = await fullscreenInfo(page);
        expect(fs.hasFullscreenElement).toBe(true);

        const fsGrid = (await compositedFullscreenContent(page)).grid;
        console.log('FULLSCREEN-ROT grid:', gridToString(fsGrid));
        // A user who rotated the tile expects a rotated picture, not the original.
        expect(diffRatio(fsGrid, base.grid)).toBeGreaterThanOrEqual(0.3);

        const fsTransform = await computedTransformOfSubject(page);
        console.log('FULLSCREEN computed transform (rotated):', fsTransform);
        expect(fsTransform).not.toBe('none');

        await exitFullscreen(page);
        await setTransform(page, uid, 'camera', 'reset');
    });

    test('one click leaves fullscreen and does not bounce straight back in', async ({ page }) => {
        test.setTimeout(180000);
        const uid = await selfCameraUp(page);
        const sel = selfCameraTile(uid);
        const vp = page.viewportSize()!;

        await page.click(sel);
        await page.waitForTimeout(1200);
        expect((await fullscreenInfo(page)).hasFullscreenElement).toBe(true);

        // A single click inside the fullscreen picture must exit...
        await page.mouse.click(vp.width / 2, vp.height / 2);
        await page.waitForTimeout(400);
        expect((await fullscreenInfo(page)).hasFullscreenElement).toBe(false);
        // ...and it must stay exited (the old bug re-entered immediately).
        await page.waitForTimeout(1000);
        expect((await fullscreenInfo(page)).hasFullscreenElement).toBe(false);

        // And it must still be possible to go back in.
        await page.click(sel);
        await page.waitForTimeout(1200);
        expect((await fullscreenInfo(page)).hasFullscreenElement).toBe(true);
        await exitFullscreen(page);
    });

    test('PiP is handed the transformed picture, not a blank/raw one', async ({ page }) => {
        test.setTimeout(180000);
        const uid = await selfCameraUp(page);
        const sel = selfCameraTile(uid);

        const base = await compositedContent(page, sel);

        await setTransform(page, uid, 'camera', 'mirror', true);

        // Instrument (do NOT stub) the PiP request so we can see which element
        // the browser is asked to pop out, then sample its picture.
        await page.evaluate(() => {
            const w = window as any;
            w.__pipCalls = [];
            const orig = HTMLVideoElement.prototype.requestPictureInPicture;
            HTMLVideoElement.prototype.requestPictureInPicture = function (this: HTMLVideoElement) {
                (w.__pipCalls as any[]).push({
                    cls: this.className,
                    hasSrc: !!this.srcObject,
                    videoW: this.videoWidth,
                    videoH: this.videoHeight,
                });
                return typeof orig === 'function' ? orig.apply(this) : Promise.reject(new Error('unsupported'));
            };
        });

        // The PiP button opens a picker of every live feed — choose the feed
        // to pop out (this test only has the self camera).
        await page.click('#voice-popup-pip');
        await page.waitForSelector('#voice-pip-menu button', { timeout: 5000 });
        await page.click('#voice-pip-menu button');
        await page.waitForTimeout(3000);

        const result = await page.evaluate(() => {
            const w = window as any;
            const pip = document.pictureInPictureElement as HTMLVideoElement | null;
            const canvas = w._pipCanvas as HTMLCanvasElement | null;
            const hiddenVideo = Array.from(document.querySelectorAll('video')).find(
                (v) => v !== pip && v.srcObject && (v.className || '').indexOf('pip') !== -1
            ) as HTMLVideoElement | undefined;
            const source = pip || hiddenVideo || null;

            function sampleFrom(el: any) {
                const c = document.createElement('canvas');
                if (el instanceof HTMLCanvasElement) {
                    c.width = el.width;
                    c.height = el.height;
                } else {
                    c.width = el.videoWidth || 160;
                    c.height = el.videoHeight || 120;
                }
                const ctx = c.getContext('2d')!;
                ctx.drawImage(el, 0, 0, c.width, c.height);
                const d = ctx.getImageData(0, 0, c.width, c.height).data;
                let lit = 0;
                for (let i = 0; i < d.length; i += 4) {
                    if (d[i] > 120 || d[i + 1] > 120 || d[i + 2] > 120) lit++;
                }
                function px(fx: number, fy: number) {
                    const x = Math.floor(c.width * fx - 0.5);
                    const y = Math.floor(c.height * fy - 0.5);
                    const i = (y * c.width + x) * 4;
                    return { r: d[i], g: d[i + 1], b: d[i + 2] };
                }
                return { lit, total: c.width * c.height, image: { tl: px(0.25, 0.25), tr: px(0.75, 0.25), bl: px(0.25, 0.75), br: px(0.75, 0.75) } };
            }

            let picture: any = null;
            let error: string | null = null;
            if (canvas) {
                try { picture = sampleFrom(canvas); } catch (e: any) { error = String(e); }
            } else if (source) {
                try { picture = sampleFrom(source); } catch (e: any) { error = String(e); }
            }
            return {
                calls: w.__pipCalls,
                pipElement: !!pip,
                hasCanvas: !!canvas,
                picture,
                error,
            };
        });

        console.log('PiP RESULT:', JSON.stringify(result));
        expect(result.calls.length).toBeGreaterThan(0);
        expect(result.error).toBeNull();
        expect(result.picture).toBeTruthy();
        // The popped-out picture must actually contain video, not a blank frame.
        expect(result.picture.lit / result.picture.total).toBeGreaterThan(0.05);

        // ...and it must be the MIRRORED picture the user applied.
        const img = result.picture.image;
        const pipQuad = {
            tl: classify(img.tl),
            tr: classify(img.tr),
            bl: classify(img.bl),
            br: classify(img.br),
        };
        const baseCorner = { tl: base.grid[0][0], tr: base.grid[0][3], bl: base.grid[3][0], br: base.grid[3][3] };
        console.log('PiP quadrants:', JSON.stringify(pipQuad), 'baseline corners:', JSON.stringify(baseCorner));
        // Mirrored means the left and right columns swap.
        expect(pipQuad.tr).toBe(baseCorner.tl);
        expect(pipQuad.tl).toBe(baseCorner.tr);

        await page.click('#voice-popup-pip');
        await page.waitForTimeout(600);
    });
});
