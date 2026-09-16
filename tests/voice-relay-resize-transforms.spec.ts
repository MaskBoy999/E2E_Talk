/**
 * Relay / resize / transform behaviour — asserted on screen, not in source text.
 *
 * Audit note: this file used to pass on the pre-fix code because three of its
 * five tests never exercised the app at all:
 *   - `setDimImportant uses kebab-case for setProperty` asserted a browser DOM
 *     API on a detached <video> the app never created;
 *   - two tests grepped `document.styleSheets` for rule *text*
 *     (`includes('voice-fs-wrap')`), which says nothing about whether the rule
 *     applies to anything, or whether the element it names exists;
 *   - a fifth test asserted `typeof VoiceManager !== 'undefined'`.
 */
import { test, expect } from '@playwright/test';
import {
    mockMedia4Color,
    registerUser,
    createVoiceServer,
    joinVoice,
    inviteAndJoin,
    newUserPage,
    openSelfCamera,
    setTransform,
    rectOf,
    selfCameraTile,
    fullscreenInfo,
    compositedContent,
    exitFullscreen,
} from './_voice-helpers';
import { frameOfViewport, classify, contentBox, pixelAt } from './_vision';

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
    const u = await registerUser(page, 'rrr_' + Date.now() + '_' + Math.floor(Math.random() * 1e4));
    const srv = await createVoiceServer(page, 'RRR_' + Date.now());
    await joinVoice(page, srv.serverId, srv.channelId);
    await openSelfCamera(page);
    return u.user.id as string;
}

test.describe('relay, resize and transforms (on-screen behaviour)', () => {

    test('turning the camera on puts a real picture on screen, and off removes it', async ({ page }) => {
        test.setTimeout(180000);
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));

        await mockMedia4Color(page);
        const u = await registerUser(page, 'cam_' + Date.now());
        const srv = await createVoiceServer(page, 'CAM_' + Date.now());
        await joinVoice(page, srv.serverId, srv.channelId);
        await openSelfCamera(page);

        const sel = selfCameraTile(u.user.id);
        const on = await compositedContent(page, sel);
        console.log('camera ON picture:', on.names);
        // More than "a DOM node exists": the element must actually paint a picture.
        expect(on.box.width).toBeGreaterThan(20);
        expect(on.box.height).toBeGreaterThan(20);

        await page.evaluate(() => window.VoiceManager.toggleServerPopup());
        await page.waitForTimeout(500);
        await page.click('#voice-bar-camera');
        await page.waitForTimeout(2500);

        // Nothing saturated may be left where the picture was.
        const rect = await rectOf(page, sel);
        const frame = await frameOfViewport(page);
        const stillThere = rect ? contentBox(frame, rect) : null;
        const middle = rect
            ? pixelAt(frame, rect.x + rect.width / 2, rect.y + rect.height / 2)
            : { r: 0, g: 0, b: 0 };
        console.log('after camera OFF, residual content box:', JSON.stringify(stillThere), 'middle pixel:', JSON.stringify(middle));
        expect(stillThere).toBeNull();

        expect(errors.filter((e) => !e.includes('WebSocket'))).toHaveLength(0);
    });

    test('a transform applied to a tile is still on screen after a window resize', async ({ page }) => {
        test.setTimeout(180000);
        const uid = await selfCameraUp(page);
        const sel = selfCameraTile(uid);

        await setTransform(page, uid, 'camera', 'mirror', true);
        const before = (await compositedContent(page, sel)).names;
        console.log('mirrored before resize:', before);

        // Resize the window: layout is recomputed and tiles are re-laid out.
        await page.setViewportSize({ width: 960, height: 700 });
        await page.waitForTimeout(1200);

        const after = await compositedContent(page, sel);
        console.log('mirrored after resize:', after.names);
        expect(after.names).toBe(before);

        // The picture must still be the whole 4-colour frame, not a cropped slice.
        const corners = after.quads;
        const present = [corners.tl, corners.tr, corners.bl, corners.br].map(classify);
        expect(present).toContain('red');
        expect(present).toContain('green');
        expect(after.box.width).toBeGreaterThan(20);
        expect(after.box.height).toBeGreaterThan(20);
        // And still inside its member row.
        const row = await rectOf(page, `.voice-member-row[data-uid="${uid}"] .voice-member-media`);
        expect(row).not.toBeNull();
        expect(after.box.height).toBeLessThanOrEqual(row!.height + 2);

        await setTransform(page, uid, 'camera', 'reset');
    });

    test('a received camera tile is fullscreenable and PiP is actually requested for it', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));

        await mockMedia4Color(page);
        const u1 = await registerUser(page, 'rr1_' + ts);
        const srv = await createVoiceServer(page, 'RR1_' + ts);
        const { ctx: ctx2, page: page2, u: u2 } = await newUserPage(context, 'rr2_' + ts);
        page2.on('pageerror', (e) => errors.push('P2:' + e.message));
        await inviteAndJoin(page, page2, srv, u2);

        // User 2 turns the camera on; user 1 receives it.
        await page2.click('#voice-bar-camera');
        await page2.waitForTimeout(3000);
        await page.evaluate(() => window.VoiceManager.toggleServerPopup());
        await page.waitForTimeout(800);

        const otherSel = `.voice-member-row[data-uid="${u2.user.id}"] .remote-video-tile[data-kind="camera"]`;
        const received = await compositedContent(page, otherSel);
        console.log('received picture:', received.names);
        expect(received.box.width).toBeGreaterThan(20);

        // On the receiver, PiP must really pop the picture out (bug: it did nothing).
        await page.evaluate(() => {
            const w = window as any;
            w.__pipCalls = [];
            const orig = HTMLVideoElement.prototype.requestPictureInPicture;
            HTMLVideoElement.prototype.requestPictureInPicture = function (this: HTMLVideoElement) {
                (w.__pipCalls as any[]).push({ cls: this.className, hasSrc: !!this.srcObject });
                return typeof orig === 'function' ? orig.apply(this) : Promise.reject(new Error('unsupported'));
            };
        });
        await page.click('#voice-popup-pip');
        await page.waitForTimeout(3000);

        const pip = await page.evaluate(() => {
            const w = window as any;
            const el = document.pictureInPictureElement as HTMLVideoElement | null;
            const canvas = w._pipCanvas as HTMLCanvasElement | null;
            let lit = -1;
            const source = el || canvas;
            if (source) {
                try {
                    const c = document.createElement('canvas');
                    c.width = (source as any).videoWidth || (source as any).width || 160;
                    c.height = (source as any).videoHeight || (source as any).height || 120;
                    const ctx = c.getContext('2d')!;
                    ctx.drawImage(source as any, 0, 0, c.width, c.height);
                    const d = ctx.getImageData(0, 0, c.width, c.height).data;
                    lit = 0;
                    for (let i = 0; i < d.length; i += 4) {
                        if (d[i] > 120 || d[i + 1] > 120 || d[i + 2] > 120) lit++;
                    }
                } catch (e) {
                    lit = -2;
                }
            }
            return { calls: w.__pipCalls, pipElement: !!el, hasCanvas: !!canvas, lit };
        });
        console.log('receiver PiP:', JSON.stringify(pip));
        expect(pip.calls.length).toBeGreaterThan(0);
        // The popped-out surface must hold a picture, not a blank frame.
        expect(pip.lit).toBeGreaterThan(0);

        await page.click('#voice-popup-pip').catch(() => {});
        await page.waitForTimeout(500);
        expect(errors.filter((e) => !e.includes('WebSocket'))).toHaveLength(0);
        await ctx2.close();
        void u1;
    });

    test('turning a member camera off leaves no ghost picture for the other user', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        await mockMedia4Color(page);
        const u1 = await registerUser(page, 'g1_' + ts);
        const srv = await createVoiceServer(page, 'G1_' + ts);
        const { ctx: ctx2, page: page2, u: u2 } = await newUserPage(context, 'g2_' + ts);
        await inviteAndJoin(page, page2, srv, u2);

        await page2.click('#voice-bar-camera');
        await page2.waitForTimeout(3000);
        await page.evaluate(() => window.VoiceManager.toggleServerPopup());
        await page.waitForTimeout(800);

        const otherSel = `.voice-member-row[data-uid="${u2.user.id}"] .remote-video-tile[data-kind="camera"]`;
        const on = await compositedContent(page, otherSel);
        expect(on.box.width).toBeGreaterThan(20);

        // User 2 turns the camera off — the picture must disappear for user 1.
        await page2.click('#voice-bar-camera');
        await page2.waitForTimeout(3500);

        const rect = await rectOf(page, otherSel);
        const frame = await frameOfViewport(page);
        const residual = rect ? contentBox(frame, rect) : null;
        console.log('ghost check — residual content:', JSON.stringify(residual));
        expect(residual).toBeNull();

        await ctx2.close();
        void u1;
    });

    test('fullscreen still works after closing and reopening the popup', async ({ page }) => {
        test.setTimeout(180000);
        const uid = await selfCameraUp(page);
        const sel = selfCameraTile(uid);

        await page.click(sel);
        await page.waitForTimeout(1200);
        expect((await fullscreenInfo(page)).hasFullscreenElement).toBe(true);

        // The user exits with a click on the picture (not a keystroke).
        const vp = page.viewportSize()!;
        await page.mouse.click(vp.width / 2, vp.height / 2);
        await page.waitForTimeout(700);
        expect((await fullscreenInfo(page)).hasFullscreenElement).toBe(false);

        // Close and reopen the popup, then fullscreen again: the tile is a new
        // element by then, which is where "the second tile does nothing" showed up.
        await page.evaluate(() => window.VoiceManager.toggleServerPopup());
        await page.waitForTimeout(700);
        await page.evaluate(() => window.VoiceManager.toggleServerPopup());
        await page.waitForTimeout(1200);

        await page.click(sel);
        await page.waitForTimeout(1400);
        const fs = await fullscreenInfo(page);
        console.log('fullscreen after popup round-trip:', JSON.stringify(fs));
        expect(fs.hasFullscreenElement).toBe(true);
        await exitFullscreen(page);
    });
});
