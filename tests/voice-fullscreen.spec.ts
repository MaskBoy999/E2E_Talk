import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

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
    const encName = await page.evaluate(async () => {
        const serverId = document.querySelector('.server-icon[data-id]')!.getAttribute('data-id');
        const k = E2ECrypto.base64ToArrayBuffer(localStorage.getItem('e2e_server_' + serverId));
        return E2ECrypto.aeadEncrypt('General', new Uint8Array(k));
    });
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
// dispatch fullscreenchange.
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
    test('fullscreened tile survives voice_members re-render (server room)', async ({ page, context }) => {
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

        // B opens popup and fullscreens A's camera tile (stubbed native fullscreen)
        await stubFullscreen(page2);
        await page2.evaluate(() => { (window as any).VoiceManager.toggleServerPopup(); });
        await page2.waitForSelector('.voice-member-row[data-uid="' + u1.user.id + '"] .voice-video-cam', { timeout: 10000 });
        await page2.click('.voice-member-row[data-uid="' + u1.user.id + '"] .voice-video-cam');
        await page2.waitForTimeout(400);
        const entered = await page2.evaluate(() => ({
            isFs: !!(window as any).__fsEl,
            cls: (window as any).__fsEl ? (window as any).__fsEl.className : null,
            connected: (window as any).__fsEl ? (window as any).__fsEl.isConnected : false,
        }));
        console.log('FULLSCREEN ENTERED:', JSON.stringify(entered));
        expect(entered.isFs).toBe(true);
        expect(entered.cls).toContain('voice-video-cam');
        expect(entered.connected).toBe(true);

        // Capture the element identity + a frame src BEFORE the re-render
        const before = await page2.evaluate(() => {
            const el = (window as any).__fsEl;
            return { src: el ? el.getAttribute('src') : null };
        });

        // Force a voice_members broadcast: owner force-mutes B -> server re-broadcasts
        // the member list -> B's renderMembers() runs. Previously this destroyed the
        // fullscreened element (frozen on exit).
        const bId = u2.user.id;
        await page.evaluate(() => { (window as any).VoiceManager.toggleServerPopup(); });
        await page.waitForSelector(`.voice-member-row[data-uid="${bId}"] .voice-owner-btn[data-a="mute"]`, { timeout: 10000 });
        await page.click(`.voice-member-row[data-uid="${bId}"] .voice-owner-btn[data-a="mute"]`);
        await page.waitForTimeout(1500);

        const after2 = await page2.evaluate(() => {
            const el = (window as any).__fsEl;
            return {
                isFs: !!el,
                connected: el ? el.isConnected : false,
                src: el ? el.getAttribute('src') : null,
                inDom: el ? !!document.getElementById('voice-popup-members')!.contains(el) : false,
            };
        });
        console.log('AFTER RE-RENDER:', JSON.stringify(after2));
        expect(after2.isFs).toBe(true);
        expect(after2.connected).toBe(true);
        expect(after2.inDom).toBe(true);
        // The same element keeps receiving new frames (not frozen)
        expect(after2.src).not.toBe(before.src);

        // Exit fullscreen -> tile must still be live (fresh src keeps updating)
        await page2.evaluate(() => { (document as any).exitFullscreen(); });
        await page2.waitForTimeout(800);
        const afterExit = await page2.evaluate((uid) => {
            const img = document.querySelector('.voice-member-row[data-uid="' + uid + '"] .voice-video-cam');
            return {
                fsCleared: !(window as any).__fsEl,
                imgExists: !!img,
                src: img ? img.getAttribute('src') : null,
            };
        }, u1.user.id);
        console.log('AFTER EXIT:', JSON.stringify(afterExit));
        expect(afterExit.fsCleared).toBe(true);
        expect(afterExit.imgExists).toBe(true);

        // Frames still flow into the tile after exit (not frozen)
        const s1 = afterExit.src;
        await page2.waitForTimeout(1000);
        const s2 = await page2.evaluate((uid) => {
            const img = document.querySelector('.voice-member-row[data-uid="' + uid + '"] .voice-video-cam');
            return img ? img.getAttribute('src') : null;
        }, u1.user.id);
        console.log('SRC AFTER EXIT:', s1 ? 'len' + s1.length : null, '->', s2 ? 'len' + s2.length : null);
        expect(s2).not.toBe(s1);

        console.log('P1 ERRORS:', JSON.stringify(errors));
        console.log('P2 ERRORS:', JSON.stringify(errors2));
    });

    test('DM call: per-frame tile updates do not wipe the fullscreened tile', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
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

        // Open DM view on both, start a call
        await page.click('#dm-strip-btn');
        await page.waitForSelector('.dm-item', { timeout: 15000 });
        await page.click('.dm-item');
        await page.waitForSelector('#dm-call-btn', { timeout: 10000 });
        await page2.click('#dm-strip-btn');
        await page2.waitForSelector('.dm-item', { timeout: 15000 });
        await page2.click('.dm-item');
        await page2.waitForSelector('#dm-call-btn', { timeout: 10000 });

        await page.click('#dm-call-btn');
        await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 10000 });
        await page2.waitForSelector('#call-mini-bar', { state: 'visible', timeout: 10000 });
        await page2.waitForTimeout(500);
        await page2.click('#dm-call-btn');
        await page2.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 10000 });

        // A turns camera ON -> B sees A's video in the DM panel
        await page.click('#dm-call-camera-btn');
        await page.waitForTimeout(2000);
        await page2.waitForSelector('#dm-call-body .dm-call-tile img', { timeout: 10000 });
        await page2.waitForTimeout(500);

        // B fullscreens A's camera img
        await stubFullscreen(page2);
        const aUid = u1.user.id;
        await page2.evaluate((uid) => {
            const imgs = Array.from(document.querySelectorAll('#dm-call-body .dm-call-tile img'));
            const target = imgs.find((i: any) => i.getAttribute('data-uid') === uid && i.getAttribute('data-stream') === 'camera') || imgs[0];
            (target as any).click();
        }, aUid);
        await page2.waitForTimeout(400);
        const entered = await page2.evaluate(() => ({
            isFs: !!(window as any).__fsEl,
            cls: (window as any).__fsEl ? (window as any).__fsEl.className : null,
            connected: (window as any).__fsEl ? (window as any).__fsEl.isConnected : false,
        }));
        console.log('DM FULLSCREEN ENTERED:', JSON.stringify(entered));
        expect(entered.isFs).toBe(true);
        expect(entered.connected).toBe(true);

        // Wait >1s of per-frame video updates. Previously EVERY voice_video frame
        // called renderMembers() -> innerHTML wipe -> fullscreened element detached
        // (frozen on exit). Now the tile is patched in place.
        const before = await page2.evaluate(() => ({
            src: (window as any).__fsEl.getAttribute('src'),
        }));
        await page2.waitForTimeout(1500);
        const after = await page2.evaluate(() => {
            const el = (window as any).__fsEl;
            return {
                isFs: !!el,
                connected: el ? el.isConnected : false,
                src: el ? el.getAttribute('src') : null,
                tileCount: document.querySelectorAll('#dm-call-body .dm-call-tile').length,
            };
        });
        console.log('DM AFTER FRAMES:', JSON.stringify(after));
        expect(after.isFs).toBe(true);
        expect(after.connected).toBe(true);
        expect(after.tileCount).toBeGreaterThanOrEqual(2);
        expect(after.src).not.toBe(before.src); // still receiving new frames

        // Exit -> tile stays live
        await page2.evaluate(() => { (document as any).exitFullscreen(); });
        await page2.waitForTimeout(800);
        const afterExit = await page2.evaluate(() => ({
            fsCleared: !(window as any).__fsEl,
            imgCount: document.querySelectorAll('#dm-call-body .dm-call-tile img').length,
        }));
        console.log('DM AFTER EXIT:', JSON.stringify(afterExit));
        expect(afterExit.fsCleared).toBe(true);
        expect(afterExit.imgCount).toBeGreaterThanOrEqual(1);

        console.log('P1 ERRORS:', JSON.stringify(errors));
        console.log('P2 ERRORS:', JSON.stringify(errors2));
    });
});
