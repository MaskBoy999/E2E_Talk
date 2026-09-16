/**
 * Visual verification of voice tiles — against COMPOSITED SCREEN PIXELS.
 *
 * Audit note: this file used to pass on the pre-fix code. It asserted
 * `tile.style.transform` (an inline declaration can be present and still have no
 * visual effect) and wrapped its pixel checks in `if (!error) { ... }`, so a
 * missing tile or a failed draw silently counted as a pass. It also "verified"
 * mirroring by mirroring the canvas itself in the test, i.e. asserting its own
 * code rather than the app's.
 *
 * Every assertion below now reads the picture the user actually sees, or the
 * on-screen geometry of the element, and there is no conditional escape hatch.
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
import { classify } from './_vision';

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
    const u = await registerUser(page, 'vsc_' + Date.now() + '_' + Math.floor(Math.random() * 1e4));
    const srv = await createVoiceServer(page, 'VSC_' + Date.now());
    await joinVoice(page, srv.serverId, srv.channelId);
    await openSelfCamera(page);
    return u.user.id as string;
}

async function popupOpen(page: any): Promise<boolean> {
    return page.evaluate(() => !!window.VoiceManager._debug.state.popupOpen);
}

async function togglePopup(page: any) {
    await page.evaluate(() => window.VoiceManager.toggleServerPopup());
    await page.waitForTimeout(700);
}

test.describe('Visual verification (composited pixels)', () => {

    test('camera tile keeps its picture and fits its row across a fullscreen round-trip', async ({ page }) => {
        test.setTimeout(180000);
        const uid = await selfCameraUp(page);
        const sel = selfCameraTile(uid);
        const rowSel = `.voice-member-row[data-uid="${uid}"] .voice-member-media`;

        // 1. Baseline geometry + picture.
        const before = {
            tile: await rectOf(page, sel),
            media: await rectOf(page, rowSel),
        };
        const beforeContent = await compositedContent(page, sel);
        console.log('BEFORE tile:', JSON.stringify(before.tile), 'media:', JSON.stringify(before.media));
        console.log('BEFORE picture:', beforeContent.names);

        // 2. Fullscreen round-trip (stale inline sizes used to survive this).
        await page.click(sel);
        await page.waitForTimeout(1200);
        expect((await fullscreenInfo(page)).hasFullscreenElement).toBe(true);
        await exitFullscreen(page);

        // 3. Close and reopen the popup (the tile is re-created).
        if (await popupOpen(page)) await togglePopup(page);
        await page.waitForTimeout(400);
        await togglePopup(page);
        await page.waitForTimeout(1200);

        const after = {
            tile: await rectOf(page, sel),
            media: await rectOf(page, rowSel),
        };
        console.log('AFTER tile:', JSON.stringify(after.tile), 'media:', JSON.stringify(after.media));

        expect(after.tile).not.toBeNull();
        expect(after.media).not.toBeNull();
        // The picture may not spill out of the row / media column.
        expect(after.tile!.height).toBeLessThanOrEqual(after.media!.height + 2);
        expect(after.tile!.width).toBeLessThanOrEqual(after.media!.width + 2);
        // ...nor grow beyond the sizes it had before the round-trip.
        expect(after.tile!.height).toBeLessThanOrEqual((before.tile?.height ?? 0) + 2);

        // And it must still show the whole 4-colour picture (not a cropped slice).
        const afterContent = await compositedContent(page, sel);
        const corners = afterContent.quads;
        console.log('AFTER picture:', afterContent.names);
        expect(classify(corners.tl)).toBe('red');
        expect(classify(corners.tr)).toBe('green');
        expect(classify(corners.bl)).toBe('blue');
        expect(classify(corners.br)).toBe('yellow');
    });

    test('transform survives closing and reopening the popup', async ({ page }) => {
        test.setTimeout(180000);
        const uid = await selfCameraUp(page);
        const sel = selfCameraTile(uid);

        await setTransform(page, uid, 'camera', 'mirror', true);
        await setTransform(page, uid, 'camera', 'rot', 90);
        const beforeClose = await compositedContent(page, sel);
        const beforeNames = beforeClose.names;
        console.log('BEFORE close picture:', beforeNames);

        if (await popupOpen(page)) await togglePopup(page);
        await page.waitForTimeout(400);
        await togglePopup(page);
        await page.waitForTimeout(1400);

        const afterOpen = await compositedContent(page, sel);
        const afterNames = afterOpen.names;
        console.log('AFTER reopen picture:', afterNames);

        // Re-opening must not silently reset what the user set.
        expect(afterNames).toBe(beforeNames);
        // Nor may the picture be cropped/scaled by a stale inline size.
        expect(afterOpen.box.width).toBeGreaterThan(20);
        expect(afterOpen.box.height).toBeGreaterThan(20);

        await setTransform(page, uid, 'camera', 'reset');
    });

    test('a received camera tile can be fullscreened, and exiting leaves both pictures intact', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));

        await mockMedia4Color(page);
        const u1 = await registerUser(page, 'vsf1_' + ts);
        const srv = await createVoiceServer(page, 'VSF_' + ts);
        const { ctx: ctx2, page: page2, u: u2 } = await newUserPage(context, 'vsf2_' + ts);
        page2.on('pageerror', (e) => errors.push('P2:' + e.message));
        await inviteAndJoin(page, page2, srv, u2);

        await page.click('#voice-bar-camera');
        await page.waitForTimeout(2500);
        await page2.click('#voice-bar-camera');
        await page2.waitForTimeout(2500);
        await togglePopup(page);

        const otherSel = `.voice-member-row[data-uid="${u2.user.id}"] .remote-video-tile[data-kind="camera"]`;
        const selfSel = `.voice-member-row[data-uid="${u1.user.id}"] .remote-video-tile[data-kind="camera"]`;

        const otherPicture = await compositedContent(page, otherSel);
        console.log('receiver picture of user2:', otherPicture.names);
        expect(otherPicture.box.width).toBeGreaterThan(20);

        // Fullscreen the OTHER member's tile (the reported bug: only the first tile worked).
        await page.click(otherSel);
        await page.waitForTimeout(1500);
        const fs1 = await page.evaluate(() => {
            const wrap = document.querySelector('.voice-fs-wrap');
            const target = (wrap ? wrap.querySelector('[data-uid]') : document.fullscreenElement) as HTMLElement | null;
            return {
                fullscreen: !!document.fullscreenElement,
                uid: target ? (target.closest('[data-uid]') as HTMLElement | null)?.dataset.uid || target.dataset.uid : null,
            };
        });
        console.log('fullscreen after clicking the received tile:', JSON.stringify(fs1));
        expect(fs1.fullscreen).toBe(true);
        expect(fs1.uid).toBe(u2.user.id);

        await exitFullscreen(page);
        expect((await fullscreenInfo(page)).hasFullscreenElement).toBe(false);

        // Neither tile may be left frozen or blank after the round-trip.
        const otherAfter = await compositedContent(page, otherSel);
        expect(otherAfter.box.width).toBeGreaterThan(20);
        const selfAfter = await compositedContent(page, selfSel);
        console.log('self picture after exit:', selfAfter.names);
        expect(selfAfter.box.width).toBeGreaterThan(20);

        // And the self tile must also be fullscreenable.
        await page.click(selfSel);
        await page.waitForTimeout(1500);
        const fs2 = await page.evaluate(() => ({
            fullscreen: !!document.fullscreenElement,
            uid: (() => {
                const wrap = document.querySelector('.voice-fs-wrap');
                const target = (wrap ? wrap.querySelector('[data-uid]') : document.fullscreenElement) as HTMLElement | null;
                return target ? (target.closest('[data-uid]') as HTMLElement | null)?.dataset.uid || target.dataset.uid : null;
            })(),
        }));
        console.log('fullscreen after clicking own tile:', JSON.stringify(fs2));
        expect(fs2.fullscreen).toBe(true);
        expect(fs2.uid).toBe(u1.user.id);
        await exitFullscreen(page);

        expect(errors.filter((e) => !e.includes('WebSocket'))).toHaveLength(0);
        await ctx2.close();
    });

    test('on a phone the reset-view control stays inside the rotated tile', async ({ page }) => {
        test.setTimeout(180000);
        const uid = await selfCameraUp(page);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(800);

        const sel = selfCameraTile(uid);
        await setTransform(page, uid, 'camera', 'rot', 90);
        await page.waitForTimeout(500);

        const tile = await rectOf(page, sel);
        const chip = await rectOf(page, '.voice-tile-reset-view');
        console.log('mobile tile:', JSON.stringify(tile), 'chip:', JSON.stringify(chip));

        expect(tile).not.toBeNull();
        expect(chip).not.toBeNull();

        // User-visible symptom: the control hangs off the tile / off the screen.
        expect(chip!.x).toBeGreaterThanOrEqual(tile!.x - 1);
        expect(chip!.y).toBeGreaterThanOrEqual(tile!.y - 1);
        expect(chip!.x + chip!.width).toBeLessThanOrEqual(tile!.x + tile!.width + 1);
        expect(chip!.y + chip!.height).toBeLessThanOrEqual(tile!.y + tile!.height + 1);
        expect(chip!.x).toBeGreaterThanOrEqual(-1);
        expect(chip!.x + chip!.width).toBeLessThanOrEqual(390 + 1);

        await setTransform(page, uid, 'camera', 'reset');
    });

    test('harness sanity: an unmirrored tile really shows the 4-colour picture', async ({ page }) => {
        test.setTimeout(120000);
        const uid = await selfCameraUp(page);
        const sel = selfCameraTile(uid);

        const content = await compositedContent(page, sel);
        const corners = content.quads;
        console.log('sanity picture:', content.names);
        // No `if (!error)` guard any more: if the tile is blank this must fail.
        expect(classify(corners.tl)).toBe('red');
        expect(classify(corners.tr)).toBe('green');
        expect(classify(corners.bl)).toBe('blue');
        expect(classify(corners.br)).toBe('yellow');
    });
});
