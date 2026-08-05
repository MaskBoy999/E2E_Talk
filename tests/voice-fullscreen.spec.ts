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
                (window as any).__mockCanvasTimer = setInterval(() => {
                    ctx.fillStyle = `rgb(${(i * 40) % 255},100,150)`;
                    ctx.fillRect(0, 0, 320, 240);
                    ctx.fillStyle = '#fff';
                    ctx.fillText(String(i++), 10, 20);
                }, 80);
                return (canvas as any).captureStream(10);
            }
            return origGUM(constraints);
        };
        (navigator.mediaDevices as any).getDisplayMedia = async (constraints: any) => {
            return (navigator.mediaDevices as any).getUserMedia({ video: true });
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
    await page.fill('#new-server-name', 'FS_' + ts);
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

// Fake native fullscreen so headless Chromium exercises the fullscreen-preservation
// paths: entering sets document.fullscreenElement, leaving clears it, and both
// dispatch fullscreenchange. The app wraps the tile in .voice-fs-wrap before
// requesting fullscreen, so __fsEl is the wrapper containing the tile.
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

test.describe('voice fullscreen freeze fixes', () => {
    test('fullscreened tile survives a re-render (server room)', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push('P1: ' + err.message));
        await mockMedia(page);
        const u1 = await registerUser(page, 'fs1_' + ts);
        const srv = await createVoiceServer(page, ts);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const errors2: string[] = [];
        page2.on('pageerror', (err) => errors2.push('P2: ' + err.message));
        await mockMedia(page2);
        const u2 = await registerUser(page2, 'fs2_' + ts);

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

        // A turns camera ON so B has a tile to fullscreen
        await page.click('#voice-bar-camera');
        await page.waitForTimeout(1500);

        // B opens the popup and fullscreens A's camera tile (stubbed fullscreen)
        await stubFullscreen(page2);
        await page2.evaluate(() => { (window as any).VoiceManager.toggleServerPopup(); });
        await page2.waitForSelector(`.voice-member-row[data-uid="${u1.user.id}"] .remote-video-tile[data-kind="camera"]`, { timeout: 10000 });
        await page2.click(`.voice-member-row[data-uid="${u1.user.id}"] .remote-video-tile[data-kind="camera"]`);
        await page2.waitForTimeout(400);
        const entered = await page2.evaluate(() => {
            const wrap = (window as any).__fsEl;
            return {
                isFs: !!wrap,
                wrapCls: wrap ? wrap.className : null,
                hasTile: wrap ? !!wrap.querySelector('.remote-video-tile') : false,
                tileConnected: wrap && wrap.querySelector('.remote-video-tile') ? wrap.querySelector('.remote-video-tile').isConnected : false,
            };
        });
        console.log('FULLSCREEN ENTERED:', JSON.stringify(entered));
        expect(entered.isFs).toBe(true);
        expect(entered.wrapCls).toContain('voice-fs-wrap');
        expect(entered.hasTile).toBe(true);
        expect(entered.tileConnected).toBe(true);

        // Force a re-render of the popup member list (a voice_members broadcast
        // path). Previously this destroyed the fullscreened element (frozen on
        // exit). setMemberSpeaking triggers renderPopup without any media.
        const bId = u2.user.id;
        await page2.evaluate(({ uid }) => {
            window.VoiceManager._debug.setMemberSpeaking(uid, true);
        }, { uid: bId });
        await page2.waitForTimeout(800);

        const afterReRender = await page2.evaluate(() => {
            const wrap = (window as any).__fsEl;
            const tile = wrap ? wrap.querySelector('.remote-video-tile') : null;
            return {
                isFs: !!wrap,
                hasTile: !!tile,
                tileConnected: tile ? tile.isConnected : false,
                inBody: wrap ? !!document.body.contains(wrap) : false,
            };
        });
        console.log('AFTER RE-RENDER:', JSON.stringify(afterReRender));
        expect(afterReRender.isFs).toBe(true);
        expect(afterReRender.hasTile).toBe(true);
        expect(afterReRender.tileConnected).toBe(true);
        expect(afterReRender.inBody).toBe(true);

        // Exit fullscreen -> wrapper removed, tile re-created back in the popup
        await page2.evaluate(() => { (document as any).exitFullscreen(); });
        await page2.waitForTimeout(800);
        const afterExit = await page2.evaluate((uid) => {
            const video = document.querySelector(`.voice-member-row[data-uid="${uid}"] .remote-video-tile[data-kind="camera"]`);
            return {
                fsCleared: !(window as any).__fsEl,
                wrapGone: !document.querySelector('.voice-fs-wrap'),
                tileExists: !!video,
                tileVisible: video ? video.style.display !== 'none' : false,
            };
        }, u1.user.id);
        console.log('AFTER EXIT:', JSON.stringify(afterExit));
        expect(afterExit.fsCleared).toBe(true);
        expect(afterExit.wrapGone).toBe(true);
        expect(afterExit.tileExists).toBe(true);
        expect(afterExit.tileVisible).toBe(true);

        console.log('P1 ERRORS:', JSON.stringify(errors));
        console.log('P2 ERRORS:', JSON.stringify(errors2));
    });

    test('DM call: media re-renders do not wipe the fullscreened tile', async ({ context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        // Fresh context for P1 too — the shared `page` fixture carries over an
        // active voice room from the previous test, delaying ring delivery.
        const ctx1 = await context.browser()!.newContext();
        const page = await ctx1.newPage();
        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push('P1: ' + err.message));
        await mockMedia(page);
        const u1 = await registerUser(page, 'fsd1_' + ts);
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const errors2: string[] = [];
        page2.on('pageerror', (err) => errors2.push('P2: ' + err.message));
        await mockMedia(page2);
        const u2 = await registerUser(page2, 'fsd2_' + ts);
        await becomeFriends(page, page2, u1.token, u2.token);
        // The ring is sent once over the WS and never re-delivered — both sides
        // must be connected BEFORE the call starts or P2 misses it forever.
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
        // Wait for the ring state first (bar visibility is flaky under load)
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug.state.incomingCall !== null;
        }, undefined, { timeout: 20000 });
        await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 15000 });
        await page2.click('#incoming-call-accept');
        await page2.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 10000 });

        // A turns camera ON -> B sees A's video tile in the DM panel
        await page.click('#dm-call-camera');
        await page.waitForTimeout(2000);
        await page2.waitForSelector(`#dm-call-body .remote-video-tile[data-kind="camera"]`, { timeout: 10000 });
        await page2.waitForTimeout(500);

        // B fullscreens A's camera video
        await stubFullscreen(page2);
        const aUid = u1.user.id;
        await page2.click(`#dm-call-body .remote-video-tile[data-uid="${aUid}"][data-kind="camera"]`);
        await page2.waitForTimeout(400);
        const entered = await page2.evaluate(() => {
            const wrap = (window as any).__fsEl;
            return {
                isFs: !!wrap,
                hasTile: wrap ? !!wrap.querySelector('.remote-video-tile') : false,
            };
        });
        console.log('DM FULLSCREEN ENTERED:', JSON.stringify(entered));
        expect(entered.isFs).toBe(true);
        expect(entered.hasTile).toBe(true);

        // Trigger DM-panel re-renders (member state churn) — the fullscreened
        // tile must survive inside its wrapper.
        await page2.evaluate(({ uid }) => {
            window.VoiceManager._debug.setMemberSpeaking(uid, true);
        }, { uid: aUid });
        await page2.waitForTimeout(800);
        const after = await page2.evaluate(() => {
            const wrap = (window as any).__fsEl;
            const tile = wrap ? wrap.querySelector('.remote-video-tile') : null;
            return {
                isFs: !!wrap,
                tileConnected: tile ? tile.isConnected : false,
                tileCount: document.querySelectorAll('#dm-call-body .dm-call-tile').length,
            };
        });
        console.log('DM AFTER FRAMES:', JSON.stringify(after));
        expect(after.isFs).toBe(true);
        expect(after.tileConnected).toBe(true);
        expect(after.tileCount).toBeGreaterThanOrEqual(1);

        // Exit -> wrapper gone, tile re-created in the panel
        await page2.evaluate(() => { (document as any).exitFullscreen(); });
        await page2.waitForTimeout(800);
        const afterExit = await page2.evaluate(() => ({
            fsCleared: !(window as any).__fsEl,
            wrapGone: !document.querySelector('.voice-fs-wrap'),
            tileCount: document.querySelectorAll('#dm-call-body .remote-video-tile').length,
        }));
        console.log('DM AFTER EXIT:', JSON.stringify(afterExit));
        expect(afterExit.fsCleared).toBe(true);
        expect(afterExit.wrapGone).toBe(true);
        expect(afterExit.tileCount).toBeGreaterThanOrEqual(1);

        console.log('P1 ERRORS:', JSON.stringify(errors));
        console.log('P2 ERRORS:', JSON.stringify(errors2));
    });
});
