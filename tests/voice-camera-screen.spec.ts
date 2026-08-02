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

test.describe('voice camera + screen share (side-by-side, fullscreen, frame clearing, force release)', () => {
    test('camera and screen run side by side; screen off keeps camera full width; deafen release restores audio', async ({ page, context }) => {
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

        // Instrument B: count voice_video frames per stream kind
        await page2.evaluate(() => {
            const vm = (window as any).VoiceManager;
            if (!vm) return;
            const orig = vm.handleServerMessage.bind(vm);
            (window as any).__voiceCounts = { camera: 0, screen: 0 };
            vm.handleServerMessage = function (data: any) {
                if (data && data.type === 'voice_video') {
                    (window as any).__voiceCounts[data.stream || 'camera']++;
                }
                return orig(data);
            };
        });

        // A: camera ON, then screen ON — both must be active at the same time
        await page.click('#voice-bar-camera');
        await page.waitForTimeout(1200);
        await page.click('#voice-bar-screen');
        await page.waitForTimeout(2000);

        const aBoth = await page.evaluate(() => ({
            camBtn: document.getElementById('voice-bar-camera')!.classList.contains('active'),
            scrBtn: document.getElementById('voice-bar-screen')!.classList.contains('active'),
        }));
        console.log('A BOTH:', JSON.stringify(aBoth));
        expect(aBoth.camBtn).toBe(true);
        expect(aBoth.scrBtn).toBe(true);

        // Open B's popup — B must see A's camera AND screen frames streaming
        await page2.click(`.channel-item[data-id="${srv.channelId}"]`);
        await page2.waitForSelector('#voice-popup', { state: 'visible', timeout: 10000 });
        await page2.waitForTimeout(2000);

        const bCounts1 = await page2.evaluate(() => (window as any).__voiceCounts || {});
        console.log('B COUNTS (cam+screen):', JSON.stringify(bCounts1));
        expect(bCounts1.camera).toBeGreaterThan(3);
        expect(bCounts1.screen).toBeGreaterThan(3);

        // No "video…" waiting text may stack above the live image (it must be
        // replaced, never appended).
        const noStuckWaiting = await page2.evaluate(() => {
            const tiles = document.querySelectorAll('#voice-popup-members .voice-video-tile');
            let bad = 0;
            tiles.forEach((t: any) => {
                if (t.querySelector('.voice-video-waiting') && t.querySelector('img')) bad++;
            });
            return bad;
        });
        expect(noStuckWaiting).toBe(0);

        // B's tile for A must show screen + camera SIDE BY SIDE (no pip overlay),
        // and each img must be clickable (fullscreen-bound).
        const aUid = u1.user.id;
        const bTileTransition = await page2.evaluate((uid) => {
            const row = document.querySelector(`.voice-member-row[data-uid="${uid}"]`);
            if (!row) return null;
            const tile = row.querySelector('.voice-video-tile');
            if (!tile) return null;
            const imgs = Array.from(tile.querySelectorAll('img'));
            return {
                imgClasses: imgs.map((i: any) => i.className),
                imgCount: imgs.length,
                hasScreen: imgs.some((i: any) => i.className.includes('voice-video-screen')),
                hasCam: imgs.some((i: any) => i.className.includes('voice-video-cam')),
                hasPip: imgs.some((i: any) => i.className.includes('pip')),
                fullscreenBound: imgs.every((i: any) => (i as any).__fsBound === true),
            };
        }, aUid);
        console.log('B TILE (cam+screen):', JSON.stringify(bTileTransition));
        expect(bTileTransition).not.toBeNull();
        expect(bTileTransition.imgCount).toBe(2); // screen + camera side by side
        expect(bTileTransition.hasScreen).toBe(true);
        expect(bTileTransition.hasCam).toBe(true);
        expect(bTileTransition.hasPip).toBe(false); // never a pip overlay
        expect(bTileTransition.fullscreenBound).toBe(true);

        // Clicking B's view of A's camera must request fullscreen on that img.
        // (Headless Chromium accepts requestFullscreen() but never enters
        // fullscreen state, so intercept the API to assert the click wiring.)
        await page2.evaluate(() => {
            const orig = Element.prototype.requestFullscreen || function () {};
            (window as any).__fsRequests = [];
            Element.prototype.requestFullscreen = function () {
                (window as any).__fsRequests.push({ tag: this.tagName, cls: this.className || '', src: (this as any).src ? (this as any).src.slice(0, 40) : '' });
                return Promise.resolve();
            };
            (window as any).__origFs = orig;
        });
        // Wait a beat so the per-frame tile rebuild settles, then click the camera img.
        await page2.waitForTimeout(500);
        await page2.click(`.voice-member-row[data-uid="${aUid}"] .voice-video-cam`);
        await page2.waitForTimeout(400);
        const fsRequests = await page2.evaluate(() => (window as any).__fsRequests || []);
        console.log('FULLSCREEN REQUESTS:', JSON.stringify(fsRequests));
        expect(fsRequests.length).toBeGreaterThan(0);
        const fsTarget = fsRequests[0];
        expect(fsTarget.tag).toBe('IMG');
        expect(fsTarget.cls).toContain('voice-video-cam');
        await page2.evaluate(() => {
            Element.prototype.requestFullscreen = (window as any).__origFs;
        });

        // ---- Bug: turning OFF the screen share while camera is still ON must
        // keep the self camera FULL-WIDTH (no stuck pip layout on the reused
        // <video> element), and B must drop to camera-only. ----
        await page.click('#voice-bar-screen');
        await page.waitForTimeout(1500);

        const aAfterScreenOff = await page.evaluate(() => ({
            camBtn: document.getElementById('voice-bar-camera')!.classList.contains('active'),
            scrBtn: document.getElementById('voice-bar-screen')!.classList.contains('active'),
        }));
        console.log('A AFTER SCREEN OFF:', JSON.stringify(aAfterScreenOff));
        expect(aAfterScreenOff.camBtn).toBe(true);
        expect(aAfterScreenOff.scrBtn).toBe(false);

        // A's own self-preview: exactly ONE video, no pip class, full box width.
        // The self preview lives inside the (hidden) popup, so open A's popup
        // to measure it, then close it again.
        await page.evaluate(() => { (window as any).VoiceManager.toggleServerPopup(); });
        await page.waitForTimeout(500);
        const aSelfAfterScreenOff = await page.evaluate(() => {
            const box = document.querySelector('.voice-self-videos');
            if (!box) return null;
            const vids = Array.from(box.querySelectorAll('video'));
            const boxW = box.getBoundingClientRect().width;
            const vw = vids.length ? vids[0].getBoundingClientRect().width : 0;
            return {
                childCount: box.children.length,
                vidCount: vids.length,
                anyPipClass: vids.some((v: any) => v.className.includes('pip')),
                boxW, vw,
                fullWidth: boxW > 0 && vw >= boxW * 0.8,
            };
        });
        await page.evaluate(() => { (window as any).VoiceManager.toggleServerPopup(); });
        console.log('A SELF after screen off:', JSON.stringify(aSelfAfterScreenOff));
        expect(aSelfAfterScreenOff).not.toBeNull();
        expect(aSelfAfterScreenOff.vidCount).toBe(1);
        expect(aSelfAfterScreenOff.anyPipClass).toBe(false);
        expect(aSelfAfterScreenOff.fullWidth).toBe(true);

        // B's tile must now be camera-only (no stale screen img beside it).
        const bTileAfterScreenOff = await page2.evaluate((uid) => {
            const row = document.querySelector(`.voice-member-row[data-uid="${uid}"]`);
            if (!row) return null;
            const tile = row.querySelector('.voice-video-tile');
            if (!tile) return null;
            const imgs = Array.from(tile.querySelectorAll('img'));
            return {
                imgCount: imgs.length,
                hasScreen: imgs.some((i: any) => i.className.includes('voice-video-screen')),
                hasCam: imgs.some((i: any) => i.className.includes('voice-video-cam')),
                fullWidthOnlyChild: imgs.length === 1 && imgs[0].className.includes('voice-video-cam'),
            };
        }, aUid);
        console.log('B TILE after A screen off:', JSON.stringify(bTileAfterScreenOff));
        expect(bTileAfterScreenOff).not.toBeNull();
        expect(bTileAfterScreenOff.imgCount).toBe(1);
        expect(bTileAfterScreenOff.hasScreen).toBe(false);
        expect(bTileAfterScreenOff.hasCam).toBe(true);

        // A turns the camera back ON alongside the screen (both on again).
        await page.click('#voice-bar-screen');
        await page.waitForTimeout(1500);
        const bBothAgain = await page2.evaluate((uid) => {
            const row = document.querySelector(`.voice-member-row[data-uid="${uid}"]`);
            if (!row) return null;
            const tile = row.querySelector('.voice-video-tile');
            if (!tile) return null;
            return Array.from(tile.querySelectorAll('img')).length;
        }, aUid);
        console.log('B TILE imgs (both on again):', JSON.stringify(bBothAgain));
        expect(bBothAgain).toBe(2);

        // A turns camera OFF — the last frame must NOT linger. Screen tile stays.
        await page.click('#voice-bar-camera');
        await page.waitForTimeout(1500);

        const aAfter = await page.evaluate(() => ({
            camBtn: document.getElementById('voice-bar-camera')!.classList.contains('active'),
            scrBtn: document.getElementById('voice-bar-screen')!.classList.contains('active'),
        }));
        expect(aAfter.camBtn).toBe(false);
        expect(aAfter.scrBtn).toBe(true);

        // The stale camera frame must be gone: no camera img left behind when the
        // screen tile remains (side-by-side keeps just the screen now).
        const staleCam = await page2.evaluate(() => {
            const imgs = Array.from(document.querySelectorAll('#voice-popup-members .voice-video-tile img'));
            return imgs.some((i: any) => i.className.includes('voice-video-cam'));
        });
        expect(staleCam).toBe(false);

        // Screen frames still flowing after camera off
        const bCounts2 = await page2.evaluate(() => (window as any).__voiceCounts || {});
        console.log('B COUNTS after cam off:', JSON.stringify(bCounts2));
        expect(bCounts2.screen).toBeGreaterThan(bCounts1.screen);

        // B deafens THEMSELVES (normal deafen) — they must STILL see A's screen.
        // B's popup is open, so use the popup's deafen button (the floating bar
        // hides while the popup is open).
        await page2.click('#vp-deafen-btn');
        await page.waitForTimeout(1200);
        const camBefore = (await page2.evaluate(() => (window as any).__voiceCounts || {})).screen;
        await page.waitForTimeout(1200);
        const camAfter = (await page2.evaluate(() => (window as any).__voiceCounts || {})).screen;
        console.log('B sees screen while deafened:', camBefore, '->', camAfter);
        expect(camAfter).toBeGreaterThan(camBefore);

        // A force-mutes B (owner control) — indicator must appear on A's row for B
        // and B's own row must show the lock.
        const bId = u2.user.id;
        await page.evaluate(() => { (window as any).VoiceManager.toggleServerPopup(); });
        await page.waitForSelector(`.voice-member-row[data-uid="${bId}"] .voice-owner-btn[data-a="mute"]`, { timeout: 10000 });
        await page.click(`.voice-member-row[data-uid="${bId}"] .voice-owner-btn[data-a="mute"]`);
        await page.waitForTimeout(1500);

        const ownerInd = await page.evaluate((bId2) => {
            const row = document.querySelector(`.voice-member-row[data-uid="${bId2}"]`);
            if (!row) return null;
            const muteBtn = row.querySelector('.voice-owner-btn[data-a="mute"]');
            return {
                rowClass: row.className,
                icon: (row.querySelector('.voice-member-icon') || {}).textContent,
                muteBtnActive: muteBtn ? muteBtn.classList.contains('active') : null,
                muteBtnText: muteBtn ? muteBtn.textContent : null,
            };
        }, bId);
        console.log('OWNER INDICATOR:', JSON.stringify(ownerInd));
        expect(ownerInd).not.toBeNull();
        expect(ownerInd.rowClass).toContain('force-locked');
        expect(ownerInd.icon).toContain('🔒');
        expect(ownerInd.muteBtnActive).toBe(true);
        expect(ownerInd.muteBtnText).toBe('🔇');

        // B's own client must reflect the force-mute (selfState) + see the lock
        const victimInd = await page2.evaluate(() => {
            const myRow = document.querySelector('.voice-member-row .voice-member-you')?.closest('.voice-member-row');
            const iconEl = document.querySelector('.voice-member-icon');
            return {
                selfLocked: !!(myRow && myRow.className.includes('force-locked')),
                anyLockIcon: !!(iconEl && iconEl.textContent && iconEl.textContent.includes('🔒')),
            };
        });
        console.log('VICTIM INDICATOR:', JSON.stringify(victimInd));
        expect(victimInd.selfLocked).toBe(true);

        // Force-muted B must STILL see A's video (server no longer drops video
        // for muted/deafened recipients).
        const sBefore = (await page2.evaluate(() => (window as any).__voiceCounts || {})).screen;
        await page.waitForTimeout(1200);
        const sAfter = (await page2.evaluate(() => (window as any).__voiceCounts || {})).screen;
        console.log('B sees screen while force-muted:', sBefore, '->', sAfter);
        expect(sAfter).toBeGreaterThan(sBefore);

        // ---- Bug: "why can I not hear sound". Owner force-DEAFENS B, then
        // lifts it. B's selfState must flip deafened true → false, and B's mic
        // must be (re)started so they can talk again. ----
        await page.click(`.voice-member-row[data-uid="${bId}"] .voice-owner-btn[data-a="deafen"]`);
        await page.waitForTimeout(1500);
        const bDeafened = await page2.evaluate(() => (window as any).VoiceManager._debugState());
        console.log('B STATE after force-deafen:', JSON.stringify(bDeafened));
        expect(bDeafened.deafened).toBe(true);
        expect(bDeafened.forceDeafened).toBe(true);

        await page.click(`.voice-member-row[data-uid="${bId}"] .voice-owner-btn[data-a="deafen"]`);
        await page.waitForTimeout(1500);
        const bReleased = await page2.evaluate(() => (window as any).VoiceManager._debugState());
        console.log('B STATE after owner undeafen:', JSON.stringify(bReleased));
        expect(bReleased.deafened).toBe(false);
        expect(bReleased.forceDeafened).toBe(false);
        expect(bReleased.forceMuted).toBe(false); // implied mute lifted too
        expect(bReleased.muted).toBe(false);
        expect(bReleased.micStream).toBe(true);   // capture running again → can talk/hear

        console.log('P1 ERRORS:', JSON.stringify(errors));
        console.log('P2 ERRORS:', JSON.stringify(errors2));
    });
});
