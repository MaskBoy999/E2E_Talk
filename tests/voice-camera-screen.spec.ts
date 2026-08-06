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
                (window as any).__mockOsc = osc;
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

async function createVoiceServer(page: any, ts: number) {
    await page.click('#add-server-btn');
    await page.click('#choice-create-server');
    await page.fill('#new-server-name', 'AV_' + ts);
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

test.describe('voice camera + screen share (side-by-side tiles, fullscreen wiring, force release)', () => {
    test('camera and screen run side by side; screen off keeps camera; deafen release restores audio', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push('P1: ' + err.message));
        await mockMedia(page);
        const u1 = await registerUser(page, 'cs1_' + ts);
        const srv = await createVoiceServer(page, ts);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const errors2: string[] = [];
        page2.on('pageerror', (err) => errors2.push('P2: ' + err.message));
        await mockMedia(page2);
        const u2 = await registerUser(page2, 'cs2_' + ts);

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

        // both join the voice channel
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

        // A: camera ON, then screen ON — both must be active at the same time
        await page.click('#voice-bar-camera');
        await page.waitForTimeout(1200);
        await page.click('#voice-bar-screen');
        await page.waitForTimeout(2000);

        const aBoth = await page.evaluate(() => {
            const s = (window as any).VoiceManager.getState();
            return {
                camBtn: document.getElementById('voice-bar-camera')!.classList.contains('active'),
                scrBtn: document.getElementById('voice-bar-screen')!.classList.contains('active'),
                cameraOn: s.cameraOn,
                screenOn: s.screenOn,
            };
        });
        console.log('A BOTH:', JSON.stringify(aBoth));
        expect(aBoth.camBtn).toBe(true);
        expect(aBoth.scrBtn).toBe(true);
        expect(aBoth.cameraOn).toBe(true);
        expect(aBoth.screenOn).toBe(true);

        // Open B's popup — B must see A's camera AND screen tiles SIDE BY SIDE
        // (two <video class="remote-video-tile">, no pip overlay).
        await page2.click(`.channel-item[data-id="${srv.channelId}"]`);
        await page2.waitForSelector('#voice-popup', { state: 'visible', timeout: 10000 });
        await page2.waitForTimeout(2000);

        const aUid = u1.user.id;
        const bTile = await page2.evaluate((uid) => {
            const row = document.querySelector(`.voice-member-row[data-uid="${uid}"]`);
            if (!row) return null;
            const media = row.querySelector('.voice-member-media');
            if (!media) return null;
            const vids = Array.from(media.querySelectorAll('video.remote-video-tile'));
            return {
                vidCount: vids.length,
                hasCamera: !!media.querySelector('video[data-kind="camera"]'),
                hasScreen: !!media.querySelector('video[data-kind="screen"]'),
                cameraDisplay: media.querySelector('video[data-kind="camera"]') ? (media.querySelector('video[data-kind="camera"]') as any).style.display : null,
                screenDisplay: media.querySelector('video[data-kind="screen"]') ? (media.querySelector('video[data-kind="screen"]') as any).style.display : null,
                anyPip: !!media.querySelector('.voice-video-pip, .pip'),
            };
        }, aUid);
        console.log('B TILE (cam+screen):', JSON.stringify(bTile));
        expect(bTile).not.toBeNull();
        expect(bTile.vidCount).toBe(2);
        expect(bTile.hasCamera).toBe(true);
        expect(bTile.hasScreen).toBe(true);
        expect(bTile.cameraDisplay).toBe('block');
        expect(bTile.screenDisplay).toBe('block');
        expect(bTile.anyPip).toBe(false);

        // Clicking B's view of A's camera must request fullscreen on the tile's
        // wrapper (.voice-fs-wrap). (Headless Chromium accepts the request but
        // never enters fullscreen, so intercept the API to assert the wiring.)
        await page2.evaluate(() => {
            (window as any).__fsRequests = [];
            const orig = Element.prototype.requestFullscreen || function () {};
            Element.prototype.requestFullscreen = function () {
                (window as any).__fsRequests.push({ tag: this.tagName, cls: this.className || '' });
                return Promise.resolve();
            };
            (window as any).__origFs = orig;
        });
        await page2.waitForTimeout(500);
        await page2.click(`.voice-member-row[data-uid="${aUid}"] video[data-kind="camera"]`);
        await page2.waitForTimeout(400);
        const fsRequests = await page2.evaluate(() => (window as any).__fsRequests || []);
        console.log('FULLSCREEN REQUESTS:', JSON.stringify(fsRequests));
        expect(fsRequests.length).toBeGreaterThan(0);
        const fsTarget = fsRequests[0];
        expect(fsTarget.cls).toContain('voice-fs-wrap');
        await page2.evaluate(() => {
            Element.prototype.requestFullscreen = (window as any).__origFs;
        });

        // ---- Bug: turning OFF the screen share while camera is still ON must
        // keep the camera tile full-width (no stuck pip layout) ----
        await page.click('#voice-bar-screen');
        await page.waitForTimeout(1500);

        const aAfterScreenOff = await page.evaluate(() => {
            const s = (window as any).VoiceManager.getState();
            return {
                camBtn: document.getElementById('voice-bar-camera')!.classList.contains('active'),
                scrBtn: document.getElementById('voice-bar-screen')!.classList.contains('active'),
                cameraOn: s.cameraOn,
                screenOn: s.screenOn,
            };
        });
        console.log('A AFTER SCREEN OFF:', JSON.stringify(aAfterScreenOff));
        expect(aAfterScreenOff.camBtn).toBe(true);
        expect(aAfterScreenOff.scrBtn).toBe(false);
        expect(aAfterScreenOff.cameraOn).toBe(true);
        expect(aAfterScreenOff.screenOn).toBe(false);

        // B's tile for A must now be camera-only (screen hidden), still side-by-side layout
        const bTileAfterScreenOff = await page2.evaluate((uid) => {
            const row = document.querySelector(`.voice-member-row[data-uid="${uid}"]`);
            if (!row) return null;
            const media = row.querySelector('.voice-member-media');
            if (!media) return null;
            return {
                vidCount: media.querySelectorAll('video.remote-video-tile').length,
                cameraDisplay: media.querySelector('video[data-kind="camera"]') ? (media.querySelector('video[data-kind="camera"]') as any).style.display : null,
                screenDisplay: media.querySelector('video[data-kind="screen"]') ? (media.querySelector('video[data-kind="screen"]') as any).style.display : null,
            };
        }, aUid);
        console.log('B TILE after A screen off:', JSON.stringify(bTileAfterScreenOff));
        expect(bTileAfterScreenOff).not.toBeNull();
        expect(bTileAfterScreenOff.cameraDisplay).toBe('block');
        expect(bTileAfterScreenOff.screenDisplay).toBe('none');

        // ---- Bug: turning camera OFF must not leave a stale last frame or
        // kill the screen share. Re-enable the screen first (it was turned off
        // in the previous step), then turn the camera off and verify the screen
        // share survives independent of the camera. ----
        await page.click('#voice-bar-screen');
        await page.waitForTimeout(1500);
        await page.click('#voice-bar-camera');
        await page.waitForTimeout(1500);
        const aAfterCamOff = await page.evaluate(() => {
            const s = (window as any).VoiceManager.getState();
            return { cameraOn: s.cameraOn, screenOn: s.screenOn };
        });
        expect(aAfterCamOff.cameraOn).toBe(false);
        expect(aAfterCamOff.screenOn).toBe(true);
        const bTileAfterCamOff = await page2.evaluate((uid) => {
            const row = document.querySelector(`.voice-member-row[data-uid="${uid}"]`);
            if (!row) return null;
            const media = row.querySelector('.voice-member-media');
            if (!media) return null;
            return {
                cameraDisplay: media.querySelector('video[data-kind="camera"]') ? (media.querySelector('video[data-kind="camera"]') as any).style.display : null,
                screenDisplay: media.querySelector('video[data-kind="screen"]') ? (media.querySelector('video[data-kind="screen"]') as any).style.display : null,
            };
        }, aUid);
        console.log('B TILE after cam off:', JSON.stringify(bTileAfterCamOff));
        expect(bTileAfterCamOff.cameraDisplay).toBe('none'); // stale frame cleared
        expect(bTileAfterCamOff.screenDisplay).toBe('block');

        // B deafens THEMSELVES (normal deafen) — they must STILL see A's screen
        // (their own deafen only mutes their output, not incoming video).
        await page2.click('#voice-popup-deafen');
        await page.waitForTimeout(1200);
        const bDeafenedState = await page2.evaluate(() => {
            const s = (window as any).VoiceManager.getState();
            return { deafened: s.deafened };
        });
        expect(bDeafenedState.deafened).toBe(true);
        const bSeesScreenWhileDeaf = await page2.evaluate((uid) => {
            const media = document.querySelector(`.voice-member-row[data-uid="${uid}"] .voice-member-media`);
            if (!media) return false;
            const v = media.querySelector('video[data-kind="screen"]');
            return v ? v.style.display === 'block' : false;
        }, aUid);
        expect(bSeesScreenWhileDeaf).toBe(true);

        // ---- Owner control: A force-mutes B -> B's client reflects the lock,
        // and B still sees A's video (mute only stops B's outgoing audio). ----
        const bId = u2.user.id;
        await page.evaluate(({ uid }) => {
            window.VoiceManager.ownerControl('mute', uid);
        }, { uid: bId });
        await page2.waitForFunction(() => {
            const v = (window as any).VoiceManager;
            return v && v.getState().forceMuted === true;
        }, undefined, { timeout: 10000 });
        const victimState = await page2.evaluate(() => {
            const s = (window as any).VoiceManager.getState();
            return { forceMuted: s.forceMuted, muted: s.muted };
        });
        console.log('VICTIM FORCE-MUTED:', JSON.stringify(victimState));
        expect(victimState.forceMuted).toBe(true);

        // Owner's popup row for B shows the locked badge (the owner's popup may
        // be closed at this point — the badge still renders in the DOM).
        await page.waitForSelector(`.voice-member-row[data-uid="${bId}"] .vm-badge.locked`, { state: 'attached', timeout: 10000 });

        // Force-muted B must STILL see A's screen tile (mute is outgoing-only)
        const bSeesWhileMuted = await page2.evaluate((uid) => {
            const media = document.querySelector(`.voice-member-row[data-uid="${uid}"] .voice-member-media`);
            if (!media) return false;
            const v = media.querySelector('video[data-kind="screen"]');
            return v ? v.style.display === 'block' : false;
        }, aUid);
        expect(bSeesWhileMuted).toBe(true);

        // ---- Bug: "why can I not hear sound". Owner force-DEAFENS B, then
        // lifts it. B's state must flip deafened true -> false, and B's mic
        // must be (re)started so they can talk again. ----
        await page.evaluate(({ uid }) => {
            window.VoiceManager.ownerControl('deafen', uid);
        }, { uid: bId });
        await page2.waitForFunction(() => {
            const v = (window as any).VoiceManager;
            const s = v && v.getState();
            return s && s.forceDeafened === true;
        }, undefined, { timeout: 10000 });
        const bDeafened = await page2.evaluate(() => {
            const s = (window as any).VoiceManager.getState();
            return { deafened: s.deafened, forceDeafened: s.forceDeafened };
        });
        console.log('B STATE after force-deafen:', JSON.stringify(bDeafened));
        expect(bDeafened.deafened).toBe(true);
        expect(bDeafened.forceDeafened).toBe(true);

        await page.evaluate(({ uid }) => {
            window.VoiceManager.ownerControl('undeafen', uid);
        }, { uid: bId });
        await page2.waitForFunction(() => {
            const v = (window as any).VoiceManager;
            const s = v && v.getState();
            return s && s.forceDeafened === false && s.deafened === false;
        }, undefined, { timeout: 10000 });
        const bAfterUndeafen = await page2.evaluate(() => {
            const s = (window as any).VoiceManager.getState();
            return { deafened: s.deafened, forceDeafened: s.forceDeafened, forceMuted: s.forceMuted };
        });
        console.log('B STATE after owner undeafen:', JSON.stringify(bAfterUndeafen));
        // Deafen semantics: deafen implies mute, so undeafen alone does NOT
        // lift an earlier force-mute — B stays force-muted until unmuted.
        expect(bAfterUndeafen.deafened).toBe(false);
        expect(bAfterUndeafen.forceDeafened).toBe(false);
        expect(bAfterUndeafen.forceMuted).toBe(true);

        // Owner fully releases B (unmute) — B's mic restarts so they can talk.
        await page.evaluate(({ uid }) => {
            window.VoiceManager.ownerControl('unmute', uid);
        }, { uid: bId });
        await page2.waitForFunction(() => {
            const v = (window as any).VoiceManager;
            const s = v && v.getState();
            return s && s.forceMuted === false && s.muted === false;
        }, undefined, { timeout: 10000 });
        await page2.waitForFunction(() => {
            const v = (window as any).VoiceManager;
            const s = v && v.getState();
            return !!(s.localStreams && s.localStreams.mic);
        }, undefined, { timeout: 10000 });
        const bReleased = await page2.evaluate(() => {
            const s = (window as any).VoiceManager.getState();
            return { forceMuted: s.forceMuted, muted: s.muted, micStream: !!(s.localStreams && s.localStreams.mic) };
        });
        console.log('B STATE after owner unmute:', JSON.stringify(bReleased));
        expect(bReleased.forceMuted).toBe(false);
        expect(bReleased.muted).toBe(false);
        expect(bReleased.micStream).toBe(true);   // capture running again -> can talk/hear

        console.log('P1 ERRORS:', JSON.stringify(errors));
        console.log('P2 ERRORS:', JSON.stringify(errors2));
    });
});
