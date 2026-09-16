/**
 * Shared browser-setup helpers for the voice visual suites.
 * Extracted so each visual spec stays about *assertions*, not boilerplate.
 */
import { Page, BrowserContext, expect } from '@playwright/test';
import { contentBox, gridOf, frameOfViewport, quadrants, describe } from './_vision';

export const BASE = 'https://localhost:3443';

/** Fake camera publishes a 2x2 colour grid (TL red, TR green, BL blue, BR yellow). */
export async function mockMedia4Color(page: Page) {
    await page.addInitScript(() => {
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
                canvas.width = 320;
                canvas.height = 240;
                const ctx = canvas.getContext('2d')!;
                let frame = 0;
                function drawFrame() {
                    const w = canvas.width;
                    const h = canvas.height;
                    ctx.fillStyle = '#ff0000';
                    ctx.fillRect(0, 0, w / 2, h / 2);
                    ctx.fillStyle = '#00ff00';
                    ctx.fillRect(w / 2, 0, w / 2, h / 2);
                    ctx.fillStyle = '#0000ff';
                    ctx.fillRect(0, h / 2, w / 2, h / 2);
                    ctx.fillStyle = '#ffff00';
                    ctx.fillRect(w / 2, h / 2, w / 2, h / 2);
                    // Small dark marker so "is this even the same frame" is checkable.
                    ctx.fillStyle = '#000';
                    ctx.fillRect(w / 2 - 4, h / 2 - 4, 8, 8);
                    frame++;
                }
                drawFrame();
                (window as any).__4colorTimer = setInterval(drawFrame, 80);
                return (canvas as any).captureStream(10);
            }
            return origGUM(constraints);
        };
        (navigator.mediaDevices as any).getDisplayMedia = async () =>
            (navigator.mediaDevices as any).getUserMedia({ video: true });
    });
}

export async function registerUser(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(500);
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 20000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

export async function createVoiceServer(page: Page, tag: string) {
    await page.click('#add-server-btn');
    await page.click('#choice-create-server');
    await page.fill('#new-server-name', tag);
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 15000 });
    const serverId = await page.evaluate(
        () => document.querySelector('.server-icon[data-id]')!.getAttribute('data-id')!
    );
    const token = await page.evaluate(() => localStorage.getItem('token'));
    const encName = await page.evaluate(async (name: string) => {
        const sid = document.querySelector('.server-icon[data-id]')!.getAttribute('data-id')!;
        const k = E2ECrypto.base64ToArrayBuffer(localStorage.getItem('e2e_server_' + sid)!);
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

export async function joinVoice(page: Page, serverId: string, channelId: string) {
    await page.click(`.server-icon[data-id="${serverId}"]`);
    await page.waitForSelector(`.channel-item[data-id="${channelId}"]`, { timeout: 15000 });
    await page.click(`.channel-item[data-id="${channelId}"]`);
    await page.waitForSelector('#voice-bar', { timeout: 15000 });
}

export async function inviteAndJoin(page1: Page, page2: Page, srv: any, u2: any) {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from({ length: 16 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
    await page1.request.post(`${BASE}/api/servers/${srv.serverId}/invite`, {
        headers: { Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' },
        data: { invite_code: code },
    });
    await page2.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${u2.token}`, 'Content-Type': 'application/json' },
        data: { code },
    });
    await page2.reload();
    await page2.waitForSelector('#settings-btn', { state: 'visible', timeout: 20000 });
    await joinVoice(page1, srv.serverId, srv.channelId);
    await joinVoice(page2, srv.serverId, srv.channelId);
    await page1.waitForTimeout(2500);
}

export async function newUserPage(context: BrowserContext, prefix: string) {
    const ctx = await context.browser()!.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 800 },
    });
    const page = await ctx.newPage();
    await mockMedia4Color(page);
    const u = await registerUser(page, prefix + '_' + Date.now() + '_' + Math.floor(Math.random() * 1e4));
    return { ctx, page, u };
}

/** Self-view + popup open, camera on. */
export async function openSelfCamera(page: Page) {
    await page.click('#voice-bar-camera');
    await page.waitForTimeout(2500);
    await page.evaluate(() => (window as any).VoiceManager.toggleServerPopup());
    await page.waitForTimeout(600);
}

export async function setTransform(page: Page, uid: string, kind: string, what: string, value: any) {
    await page.evaluate(
        ({ uid, kind, what, value }) =>
            (window as any).VoiceManager._debug.setTileTransform(uid, kind, what, value),
        { uid, kind, what, value }
    );
    await page.waitForTimeout(450);
}

/** Hide the transient on-tile hint chips (they overlay the picture, which is the subject). */
export async function hideTileOverlays(page: Page) {
    await page.evaluate(() => {
        document
            .querySelectorAll<HTMLElement>('.voice-tile-reset-view, .voice-tile-hint, .voice-tile-badge')
            .forEach((el) => {
                el.style.display = 'none';
            });
    });
}

/**
 * What the user sees inside `selector`, right now: the on-screen content box of
 * the picture plus a classified colour grid sampled from it.
 */
export async function compositedContent(page: Page, selector: string, n = 4) {
    await hideTileOverlays(page);
    const rect = await rectOf(page, selector);
    if (!rect || rect.width < 8 || rect.height < 8) {
        throw new Error(`element not visible on screen: ${selector}`);
    }
    const frame = await frameOfViewport(page);
    const box = contentBox(frame, rect);
    if (!box) throw new Error(`no camera picture visible on screen inside ${selector}`);
    // Everything below is derived from this ONE frame: the app re-renders tiles
    // (which recreates the hint chip over the picture), so a second screenshot
    // could sample a different render than the box was measured on.
    const quads = quadrants(frame, box);
    return { rect, box, grid: gridOf(frame, box, n), quads, names: describe(quads) };
}

/**
 * The element the user is looking at while fullscreen: the CSS wrapper's tile
 * when the app uses that path, otherwise whatever the browser fullscreened.
 */
export async function fullscreenSampleRect(page: Page) {
    return page.evaluate(() => {
        const wrapTile = document.querySelector('.voice-fs-wrap .remote-video-tile[data-kind="camera"]');
        const target = (wrapTile || document.fullscreenElement) as HTMLElement | null;
        if (!target) return null;
        const r = target.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
}

export async function compositedFullscreenContent(page: Page, n = 4) {
    await hideTileOverlays(page);
    const rect = await fullscreenSampleRect(page);
    if (!rect) throw new Error('nothing is fullscreen');
    const frame = await frameOfViewport(page);
    const box = contentBox(frame, rect);
    if (!box) throw new Error('fullscreen shows no camera picture');
    const quads = quadrants(frame, box);
    return { rect, box, grid: gridOf(frame, box, n), quads, names: describe(quads) };
}

/** Leave fullscreen deterministically (browser-level, no user gesture needed). */
export async function exitFullscreen(page: Page) {
    await page.evaluate(() => {
        if (document.fullscreenElement) {
            (document as any).exitFullscreen();
        }
    });
    await page.waitForTimeout(600);
}

export async function rectOf(page: Page, selector: string) {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, selector);
}

export function selfCameraTile(uid: string) {
    return `.voice-member-row[data-uid="${uid}"] .remote-video-tile[data-kind="camera"]`;
}

export async function fullscreenInfo(page: Page) {
    return page.evaluate(() => {
        const fs = document.fullscreenElement as HTMLElement | null;
        const wrap = document.querySelector('.voice-fs-wrap') as HTMLElement | null;
        const inWrap = wrap ? (wrap.querySelector('.remote-video-tile') as HTMLElement | null) : null;
        const target = inWrap || fs;
        let styleTransform = null;
        let computedTransform = null;
        if (target) {
            styleTransform = target.style ? target.style.transform : null;
            computedTransform = getComputedStyle(target).transform;
        }
        return {
            hasFullscreenElement: !!fs,
            fullscreenTag: fs ? fs.tagName : null,
            fullscreenClass: fs ? fs.className : null,
            hasWrap: !!wrap,
            transformTargetTag: target ? target.tagName : null,
            transformTargetClass: target ? target.className : null,
            styleTransform,
            computedTransform,
        };
    });
}
