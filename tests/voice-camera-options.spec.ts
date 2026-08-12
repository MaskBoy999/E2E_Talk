import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// Mocked media: getUserMedia returns an oscillator mic + a canvas camera whose
// track supports torch (flash). getDisplayMedia returns BOTH video and audio
// (tab/system audio) so screen-share audio can be exercised.
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
                const stream = (canvas as any).captureStream(10);
                const track = stream.getVideoTracks()[0];
                // Pretend the camera supports torch so the flash button shows
                // and applyConstraints succeeds (canvas tracks can't torch).
                try {
                    Object.defineProperty(track, 'getCapabilities', {
                        value: () => ({ torch: true }),
                        configurable: true,
                    });
                    Object.defineProperty(track, 'applyConstraints', {
                        value: () => Promise.resolve(),
                        configurable: true,
                    });
                } catch (_) {}
                return stream;
            }
            return origGUM(constraints);
        };
        (navigator.mediaDevices as any).getDisplayMedia = async (constraints: any) => {
            // Screen share with audio: combine the canvas video + oscillator
            // audio into one stream (a real getDisplayMedia stream).
            const vStream = await (navigator.mediaDevices as any).getUserMedia({ video: true });
            const aStream = await (navigator.mediaDevices as any).getUserMedia({ audio: true });
            const out = new MediaStream();
            vStream.getTracks().forEach((t: any) => out.addTrack(t));
            aStream.getTracks().forEach((t: any) => out.addTrack(t));
            return out;
        };
    });
}

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function waitForWs(page: any) {
    return await page.evaluate(() => {
        return new Promise((resolve) => {
            let tries = 0;
            const check = () => {
                tries++;
                if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) resolve(true);
                else if (tries >= 60) resolve(false);
                else setTimeout(check, 200);
            };
            setTimeout(check, 500);
        });
    });
}

async function setupFriends(page: any, page2: any, body1: any, body2: any) {
    const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    const fr = await page.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
        data: { friend_code: fc2 },
    });
    expect(fr.ok()).toBeTruthy();
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${body2.token}` },
    })).json();
    const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    expect(acc.ok()).toBeTruthy();
}

async function createDm(page: any, page2: any, body1: any, body2: any) {
    const userData = await (await page.request.get(`${BASE}/api/user/${body2.user.username}`, {
        headers: { Authorization: `Bearer ${body1.token}` },
    })).json();
    const dm = await (await page.request.post(`${BASE}/api/dm/${userData.id}`, {
        headers: { Authorization: `Bearer ${body1.token}` },
    })).json();
    expect(dm.id).toBeTruthy();
    return { userData, dm };
}

async function openDm(page: any) {
    await page.click('#dm-strip-btn').catch(() => {});
    await page.waitForTimeout(800);
    for (let i = 0; i < 40; i++) {
        const conv = page.locator('.dm-item, .dm-conv, [data-dm-id]');
        if (await conv.count()) {
            await conv.first().click().catch(() => {});
            await page.waitForTimeout(800);
            break;
        }
        await page.waitForTimeout(300);
    }
}

test.describe('camera options + screen audio volume + resize minimum', () => {

    test('camera flip/mirror/flash in a DM call; screen audio reaches the partner with its own volume', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'vco1_' + ts;
        const user2 = 'vco2_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);

        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);

        await waitForWs(page);
        await waitForWs(page2);
        await openDm(page);

        // A calls B, B accepts
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && typeof v.startDmCall === 'function';
        }, undefined, { timeout: 15000 });
        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: user2 });
        await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });
        // B receives the ring, then accepts with the REAL button
        await page2.waitForFunction(() => {
            const v = window.VoiceManager as any;
            return v && v._debug && v._debug.state && v._debug.state.incomingCall !== null;
        }, undefined, { timeout: 20000 });
        await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 10000 });
        await page2.click('#incoming-call-accept');
        // Wait until both are connected
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug && v._debug.state && v._debug.state.connected;
        }, undefined, { timeout: 20000 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug && v._debug.state && v._debug.state.connected;
        }, undefined, { timeout: 20000 });
        // NOTE: on B's page the remote streams / peers are keyed by A's uid
        // (body1.user.id) — userData.id is the PARTNER id (B's own) and would
        // look up the wrong key.
        const aUid = body1.user.id;
        // Give the staggered peer creation a moment, then verify B has a peer
        await page2.waitForFunction((uid) => {
            const s = (window.VoiceManager as any)._debug.state;
            return !!s.peers[uid];
        }, aUid, { timeout: 15000 });
        // And A's media reaches B (mic at least)
        await page2.waitForFunction((uid) => {
            const s = (window.VoiceManager as any)._debug.state;
            return !!(s.remoteStreams[uid] && s.remoteStreams[uid].audio);
        }, aUid, { timeout: 20000 });

        // ---- 1. Camera on + flip + mirror + flash ----
        await page.evaluate(() => (window.VoiceManager as any).toggleCamera());
        await page.waitForFunction(() => {
            const s = (window.VoiceManager as any)._debug.state;
            return s.cameraOn;
        }, undefined, { timeout: 15000 });

        // Flip: facing switches user -> environment, camera stays on
        await page.evaluate(() => (window.VoiceManager as any).flipCamera());
        await page.waitForFunction(() => {
            const s = (window.VoiceManager as any)._debug.state;
            return s.cameraOn && s.cameraFacing === 'environment';
        }, undefined, { timeout: 15000 });

        // Mirror now lives in the right-click menu (moved out of the ⋮
        // dropdown). Right-click OUR OWN camera in the DM self strip: the menu
        // shows the View section (mirror/rotate/reset) and NO volume meter.
        const selfCam = page.locator('#dm-call-self video.voice-self-video[data-kind="camera"]');
        await selfCam.waitFor({ state: 'visible', timeout: 15000 });
        await selfCam.click({ button: 'right' });
        await page.waitForSelector('#volume-menu', { state: 'visible', timeout: 10000 });
        const selfHeader = await page.evaluate(() => {
            const m = document.getElementById('volume-menu')!;
            return m.querySelector('.volume-menu-header')!.textContent;
        });
        expect(selfHeader).toContain('Your camera');
        // Our own tiles never get a volume meter — only other people's feeds do.
        const selfHasVol = await page.evaluate(() => !!document.querySelector('#volume-menu .volume-menu-slider'));
        expect(selfHasVol).toBe(false);
        // View section present: mirror it (find the button by text to dodge
        // the unicode arrow).
        await page.evaluate(() => {
            const btns = document.querySelectorAll('#volume-menu .volume-menu-view-btn');
            for (const b of btns) {
                if (b.textContent && b.textContent.indexOf('Mirror') !== -1) {
                    (b as HTMLButtonElement).click();
                    break;
                }
            }
        });
        await page.waitForFunction(() => {
            const v = document.querySelector('#dm-call-self video.voice-self-video[data-kind="camera"]') as HTMLElement | null;
            return !!v && (v.style.transform || '').indexOf('scaleX(-1)') !== -1;
        }, undefined, { timeout: 10000 });
        // And the OUTGOING stream is never flipped (mirror is preview-only —
        // it's a per-viewer render transform, nothing is sent).
        const mirrorPersisted = await page.evaluate(() =>
            JSON.parse(localStorage.getItem('voice_settings') || '{}').mirrorCamera === undefined);
        expect(mirrorPersisted).toBe(true);
        // Close the menu with an outside click.
        await page.mouse.click(5, 5);
        await page.waitForSelector('#volume-menu', { state: 'hidden', timeout: 5000 });

        // The "Reset view" hint chip floats over the mirrored tile, and one
        // click restores the feed.
        await page.waitForSelector('#dm-call-self .voice-tile-reset-view', { state: 'visible', timeout: 10000 });
        await page.click('#dm-call-self .voice-tile-reset-view');
        await page.waitForFunction(() => {
            const v = document.querySelector('#dm-call-self video.voice-self-video[data-kind="camera"]') as HTMLElement | null;
            return !v || (v.style.transform || '') === '';
        }, undefined, { timeout: 10000 });
        await page.waitForSelector('#dm-call-self .voice-tile-reset-view', { state: 'detached', timeout: 10000 });

        // Flash: torch toggles on (mocked capability + applyConstraints)
        await page.evaluate(() => (window.VoiceManager as any).toggleCameraFlash());
        await page.waitForFunction(() => {
            const s = (window.VoiceManager as any)._debug.state;
            return s.cameraFlash === true;
        }, undefined, { timeout: 10000 });

        // ---- 2. Screen share with audio reaches B ----
        await page.evaluate(() => (window.VoiceManager as any).toggleScreen());
        await page.waitForFunction(() => {
            const s = (window.VoiceManager as any)._debug.state;
            return s.screenOn;
        }, undefined, { timeout: 15000 });

        // B must receive BOTH the mic audio and the screen audio
        await page2.waitForFunction((uid) => {
            const s = (window.VoiceManager as any)._debug.state;
            const rs = s.remoteStreams[uid];
            return rs && rs.audio && rs.screenAudio &&
                rs.screenAudio.getAudioTracks().length > 0;
        }, aUid, { timeout: 25000 });
        const bState = await page2.evaluate((uid) => {
            const s = (window.VoiceManager as any)._debug.state;
            return {
                hasScreenAudioEls: !!(s.remoteScreenAudioEls[uid] || []).length,
                screenAudioStreams: !!(s.remoteStreams[uid] || {}).screenAudio,
            };
        }, aUid);
        expect(bState.screenAudioStreams).toBe(true);

        // ---- 2b. Right-click OUR OWN screen share -> View section, NO volume
        // meter (you never hear your own share; only others' shares get one). ----
        const selfScreen = page.locator('#dm-call-self video.voice-self-video[data-kind="screen"]');
        await selfScreen.waitFor({ state: 'visible', timeout: 15000 });
        await selfScreen.click({ button: 'right' });
        await page.waitForSelector('#volume-menu', { state: 'visible', timeout: 10000 });
        const selfScreenHeader = await page.evaluate(() => {
            const m = document.getElementById('volume-menu')!;
            return m.querySelector('.volume-menu-header')!.textContent;
        });
        expect(selfScreenHeader).toContain('Your screen share');
        const selfScreenHasVol = await page.evaluate(() => !!document.querySelector('#volume-menu .volume-menu-slider'));
        expect(selfScreenHasVol).toBe(false);
        // View section still there (rotate right, then back) — and it works.
        await page.evaluate(() => {
            const btns = document.querySelectorAll('#volume-menu .volume-menu-view-btn');
            for (const b of btns) {
                if (b.textContent && b.textContent.indexOf('90°') !== -1 && b.textContent.indexOf('⟳') !== -1) {
                    (b as HTMLButtonElement).click();
                    break;
                }
            }
        });
        await page.waitForFunction(() => {
            const v = document.querySelector('#dm-call-self video.voice-self-video[data-kind="screen"]') as HTMLElement | null;
            return !!v && (v.style.transform || '').indexOf('rotate(90deg)') !== -1;
        }, undefined, { timeout: 10000 });
        // The Reset view chip appears over the rotated screen too.
        await page.waitForSelector('#dm-call-self .voice-tile-reset-view', { state: 'visible', timeout: 10000 });
        await page.mouse.click(5, 5);
        await page.waitForSelector('#volume-menu', { state: 'hidden', timeout: 5000 });

        // ---- 2c. Rotating OUR OWN CAMERA must not overlap the screen tile
        // either — it gets the same rotation-slot treatment as everyone
        // else's tiles (this was the self-strip gap). ----
        const selfCam2 = page.locator('#dm-call-self video.voice-self-video[data-kind="camera"]');
        await selfCam2.waitFor({ state: 'visible', timeout: 15000 });
        await selfCam2.click({ button: 'right' });
        await page.waitForSelector('#volume-menu', { state: 'visible', timeout: 10000 });
        await page.evaluate(() => {
            const btns = document.querySelectorAll('#volume-menu .volume-menu-view-btn');
            for (const b of btns) {
                if (b.textContent && b.textContent.indexOf('90°') !== -1 && b.textContent.indexOf('⟳') !== -1) {
                    (b as HTMLButtonElement).click();
                    break;
                }
            }
        });
        await page.waitForFunction(() => {
            const v = document.querySelector('#dm-call-self video.voice-self-video[data-kind="camera"]') as HTMLElement | null;
            return !!v && (v.style.transform || '').indexOf('rotate(90deg)') !== -1;
        }, undefined, { timeout: 10000 });
        await page.mouse.click(5, 5);
        await page.waitForSelector('#volume-menu', { state: 'hidden', timeout: 5000 });
        // The camera is inside a rotation slot that reserves its rotated
        // footprint, so it no longer overlaps the sibling screen tile.
        const selfOverlap = await page.evaluate(() => {
            const cam = document.querySelector('#dm-call-self video.voice-self-video[data-kind="camera"]') as HTMLElement | null;
            const scr = document.querySelector('#dm-call-self video.voice-self-video[data-kind="screen"]') as HTMLElement | null;
            if (!cam || !scr) return { ok: false, reason: 'missing videos' };
            const camSlot = cam.closest('.voice-tile-slot') as HTMLElement | null;
            const scrSlot = scr.closest('.voice-tile-slot') as HTMLElement | null;
            const cr = (camSlot || cam).getBoundingClientRect();
            const sr = (scrSlot || scr).getBoundingClientRect();
            const intersects = !(cr.right <= sr.left || sr.right <= cr.left || cr.bottom <= sr.top || sr.bottom <= cr.top);
            return { ok: true, intersects, camSlot: !!camSlot, scrSlot: !!scrSlot };
        });
        expect(selfOverlap.ok).toBe(true);
        expect(selfOverlap.camSlot).toBe(true);
        expect(selfOverlap.intersects).toBe(false);

        // ---- 3. Right-click B's view of A's SCREEN tile -> "Screen share" volume menu ----
        const screenTile = page2.locator('.dm-call-tile video[data-kind="screen"]');
        await screenTile.waitFor({ state: 'visible', timeout: 15000 });
        await screenTile.click({ button: 'right' });
        await page2.waitForSelector('#volume-menu', { state: 'visible', timeout: 10000 });
        const menuHeader = await page2.evaluate(() => {
            const m = document.getElementById('volume-menu')!;
            return m.querySelector('.volume-menu-header')!.textContent;
        });
        expect(menuHeader).toContain('Screen share');
        // Move the slider to 250%
        await page2.evaluate(() => {
            const slider = document.querySelector('#volume-menu .volume-menu-slider') as HTMLInputElement;
            slider.value = '250';
            slider.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const screenVol = await page2.evaluate((uid) => localStorage.getItem('voice_screen_volume_' + uid), aUid);
        expect(screenVol).toBe('250');
        // And the label updated
        const labelVal = await page2.evaluate(() =>
            document.getElementById('volume-menu-value')!.textContent);
        expect(labelVal).toBe('250%');
    });

    test('camera options dropdown + white-screen flash fallback (no torch)', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'vcod1_' + ts;
        const user2 = 'vcod2_' + ts;

        // No-torch camera mock: getUserMedia returns a canvas stream whose
        // track does NOT expose torch — the selfie-camera case.
        const noTorchMock = (p: any) => p.addInitScript(() => {
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
                    ctx.fillStyle = '#225588';
                    ctx.fillRect(0, 0, 320, 240);
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

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await noTorchMock(page);
        await noTorchMock(page2);
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);

        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await waitForWs(page);
        await waitForWs(page2);
        await openDm(page);

        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && typeof v.startDmCall === 'function';
        }, undefined, { timeout: 15000 });
        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: user2 });
        await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager as any;
            return v && v._debug && v._debug.state && v._debug.state.incomingCall !== null;
        }, undefined, { timeout: 20000 });
        await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 10000 });
        await page2.click('#incoming-call-accept');
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug && v._debug.state && v._debug.state.connected;
        }, undefined, { timeout: 20000 });

        // Camera ON (no torch on this track)
        await page.evaluate(() => (window.VoiceManager as any).toggleCamera());
        await page.waitForFunction(() => {
            const s = (window.VoiceManager as any)._debug.state;
            return s.cameraOn;
        }, undefined, { timeout: 15000 });

        // ---- Dropdown: open via the DM control row's ⋮ button ----
        // Mirror was moved to the right-click menu — the dropdown now holds
        // only Flip and Flash.
        await page.click('#dm-call-cam-opt');
        await page.waitForSelector('#voice-cam-opt-menu', { state: 'visible', timeout: 10000 });
        const opts = await page.evaluate(() =>
            ['cam-opt-flip', 'cam-opt-mirror', 'cam-opt-flash'].map(id => {
                const b = document.getElementById(id);
                return b ? b.textContent!.trim() : null;
            }));
        expect(opts[0]).toContain('Flip');
        expect(opts[1]).toBeNull();   // mirror removed from the dropdown
        expect(opts[2]).toContain('Flash');

        // Reopen -> Flash. NO torch -> white overlay shows, menu closes
        await page.click('#dm-call-cam-opt');
        await page.waitForSelector('#voice-cam-opt-menu', { state: 'visible', timeout: 10000 });
        await page.click('#cam-opt-flash');
        await page.waitForFunction(() => {
            const s = (window.VoiceManager as any)._debug.state;
            return s.cameraFlash === true;
        }, undefined, { timeout: 10000 });
        const overlayShown = await page.evaluate(() => {
            const ov = document.getElementById('camera-flash-overlay');
            return ov ? getComputedStyle(ov).display !== 'none' : false;
        });
        expect(overlayShown).toBe(true);
        await page.waitForSelector('#voice-cam-opt-menu', { state: 'hidden', timeout: 5000 });

        // The white overlay has a button to turn the flash off
        await page.click('#camera-flash-off');
        await page.waitForFunction(() => {
            const s = (window.VoiceManager as any)._debug.state;
            return s.cameraFlash === false;
        }, undefined, { timeout: 10000 });
        const overlayHidden = await page.evaluate(() => {
            const ov = document.getElementById('camera-flash-overlay');
            return ov ? getComputedStyle(ov).display === 'none' : true;
        });
        expect(overlayHidden).toBe(true);

        // Menu closes on an OUTSIDE click
        await page.click('#dm-call-cam-opt');
        await page.waitForSelector('#voice-cam-opt-menu', { state: 'visible', timeout: 10000 });
        await page.click('#dm-call-mute');
        await page.waitForSelector('#voice-cam-opt-menu', { state: 'hidden', timeout: 5000 });

        // Turning the camera OFF must never leave the overlay up
        await page.evaluate(() => (window.VoiceManager as any).setCameraFlashOn(true));
        await page.waitForFunction(() => {
            const s = (window.VoiceManager as any)._debug.state;
            return s.cameraFlash === true;
        }, undefined, { timeout: 10000 });
        await page.evaluate(() => (window.VoiceManager as any).toggleCamera());
        await page.waitForFunction(() => {
            const s = (window.VoiceManager as any)._debug.state;
            return !s.cameraOn;
        }, undefined, { timeout: 15000 });
        const overlayAfterOff = await page.evaluate(() => {
            const ov = document.getElementById('camera-flash-overlay');
            return ov ? getComputedStyle(ov).display === 'none' : true;
        });
        expect(overlayAfterOff).toBe(true);
    });

    test('DM panel resize clamps to the 240px minimum', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'vcr1_' + ts;
        const user2 = 'vcr2_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);

        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await waitForWs(page);
        await waitForWs(page2);
        await openDm(page);

        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && typeof v.startDmCall === 'function';
        }, undefined, { timeout: 15000 });
        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: user2 });
        await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });

        const handle = page.locator('#dm-call-resize');
        await handle.waitFor({ state: 'visible', timeout: 10000 });
        const box = await handle.boundingBox();
        expect(box).toBeTruthy();
        // Drag UP way past the minimum — the height must clamp at 240px
        await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
        await page.mouse.down();
        await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 - 600, { steps: 10 });
        await page.mouse.up();
        await page.waitForTimeout(300);

        const height = await page.evaluate(() => document.getElementById('dm-call-panel')!.offsetHeight);
        expect(height).toBe(240);
    });
});
