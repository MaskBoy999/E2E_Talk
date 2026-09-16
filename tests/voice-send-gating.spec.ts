import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// Mocked media: getUserMedia returns an oscillator mic + a canvas camera.
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
                return stream;
            }
            return origGUM(constraints);
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

async function startDmCall(page: any, page2: any, dm: any, partnerUid: string, partnerName: string) {
    await page.waitForFunction(() => {
        const v = window.VoiceManager;
        return v && typeof v.startDmCall === 'function';
    }, undefined, { timeout: 15000 });
    await page.evaluate(({ dmId, uid, uname }) => {
        window.VoiceManager.startDmCall(dmId, uid, uname);
    }, { dmId: dm.id, uid: partnerUid, uname: partnerName });
    await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });
    await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 20000 });
    await page2.click('#incoming-call-accept');
    await page.waitForFunction(() => {
        const v = window.VoiceManager;
        return v && v._debug && v._debug.state && v._debug.state.connected;
    }, undefined, { timeout: 20000 });
    await page2.waitForFunction(() => {
        const v = window.VoiceManager;
        return v && v._debug && v._debug.state && v._debug.state.connected;
    }, undefined, { timeout: 20000 });
}

async function selectServer(page: any) {
    await page.evaluate(() => {
        if (typeof loadServers === 'function') loadServers();
    }).catch(() => {});
    await page.click('#dm-strip-btn').catch(() => {});
    await page.waitForTimeout(800);
    for (let i = 0; i < 30; i++) {
        const count = await page.locator('.server-icon:not(.add-server):not(.dm-strip-btn)').count();
        if (count > 0) {
            await page.locator('.server-icon:not(.add-server):not(.dm-strip-btn)').first().click().catch(() => {});
            await page.waitForTimeout(600);
            return true;
        }
        await page.waitForTimeout(300);
    }
    return false;
}

async function clickVoiceChannel(page: any, channelId: string) {
    for (let i = 0; i < 40; i++) {
        const el = page.locator(`.channel-item[data-id="${channelId}"]`);
        if (await el.count()) {
            await el.click();
            await page.waitForTimeout(600);
            return true;
        }
        await page.waitForTimeout(300);
    }
    return false;
}

// Wait until the sender's peer to `uid` has a video/audio sender in the given
// gated state. `kind` is 'video' or 'audio'; `gated` true = track is held
// (replaceTrack(null)).
async function waitSenderGate(page: any, uid: string, kind: string, gated: boolean) {
    try {
        await page.waitForFunction(({ uid, kind, gated }) => {
            const gates = (window as any).VoiceManager._debug.senderGates(uid) || [];
            return gates.some((g: any) => g.kind === kind && g.gated === gated);
        }, { uid, kind, gated }, { timeout: 20000 });
    } catch (e: any) {
        const dump = await page.evaluate((uid) => {
            const s = (window as any).VoiceManager._debug.state;
            const m = s.members[uid];
            return {
                connected: s.connected,
                peers: Object.keys(s.peers || {}),
                gates: (window as any).VoiceManager._debug.senderGates(uid),
                memberState: m ? {
                    manual_video_load: m.manual_video_load,
                    loaded_feeds: m.loaded_feeds,
                    unloaded_feeds: m.unloaded_feeds,
                    deafened: m.deafened,
                } : null,
                localStreams: {
                    mic: !!s.localStreams.mic,
                    camera: !!s.localStreams.camera,
                    screen: !!s.localStreams.screen,
                },
            };
        }, uid);
        console.log('=====SENDERGATE TIMEOUT DUMP (kind=' + kind + ', gated=' + gated + ')=====\n' + JSON.stringify(dump, null, 2));
        throw e;
    }
}

test.describe('per-receiver send gating + rotated-tile sizing', () => {

    test('DM call: manual-load gates the sender; Load/Unload buttons flip it both ways', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'vsg1_' + ts;
        const user2 = 'vsg2_' + ts;
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
        await startDmCall(page, page2, dm, userData.id, user2);

        // A turns the camera on; B's view auto-attaches (manual load off).
        await page.evaluate(() => (window as any).VoiceManager.toggleCamera());
        await page.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.cameraOn;
        }, undefined, { timeout: 15000 });
        // A must actually have a live video sender to B first.
        await page.waitForFunction((uid) => {
            const gates = (window as any).VoiceManager._debug.senderGates(uid) || [];
            return gates.some((g: any) => g.kind === 'video');
        }, body2.user.id, { timeout: 20000 });

        // B enables manual video load → A must STOP sending the camera to B.
        await page2.evaluate(() => (window as any).VoiceManager.setManualVideoLoad(true));
        await waitSenderGate(page, body2.user.id, 'video', true);

        // B's tile is held behind a Load button.
        await page2.waitForSelector('.dm-call-tile .voice-feed-load-btn', { state: 'visible', timeout: 10000 });

        // B clicks Load → A RESUMES sending.
        await page2.click('.dm-call-tile .voice-feed-load-btn');
        await waitSenderGate(page, body2.user.id, 'video', false);

        // The Unload button now floats over the loaded tile (top-right).
        const unloadBtn = page2.locator('.dm-call-tile .voice-feed-unload-btn');
        await unloadBtn.waitFor({ state: 'visible', timeout: 10000 });
        const tile = page2.locator('.dm-call-tile video[data-kind="camera"]');
        const btnBox = await unloadBtn.boundingBox();
        const tileBox = await tile.boundingBox();
        expect(btnBox && tileBox).toBeTruthy();
        // Top-right of the tile: button's right edge near the tile's right edge.
        expect(btnBox!.x + btnBox!.width).toBeLessThanOrEqual(tileBox!.x + tileBox!.width + 2);
        expect(btnBox!.y).toBeGreaterThanOrEqual(tileBox!.y - 2);

        // B clicks Unload → A gates again, and the Load button returns.
        await unloadBtn.click();
        await waitSenderGate(page, body2.user.id, 'video', true);
        await page2.waitForSelector('.dm-call-tile .voice-feed-load-btn', { state: 'visible', timeout: 10000 });

        // Load one more time → ungated again (recovery loop works).
        await page2.click('.dm-call-tile .voice-feed-load-btn');
        await waitSenderGate(page, body2.user.id, 'video', false);

        // Unload, then DISABLE manual load → the feed auto-loads again (the
        // toggle is the escape hatch for feeds unloaded earlier) — no stale
        // black feed left behind.
        await page2.locator('.dm-call-tile .voice-feed-unload-btn').click();
        await waitSenderGate(page, body2.user.id, 'video', true);
        await page2.evaluate(() => (window as any).VoiceManager.setManualVideoLoad(false));
        await waitSenderGate(page, body2.user.id, 'video', false);
        await page2.waitForFunction(() => !document.querySelector('.dm-call-tile .voice-feed-load-btn'));
        await ctx2.close();
    });

    test('DM call: deafening B makes A stop sending audio to B; undeafen resumes', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'vsga1_' + ts;
        const user2 = 'vsga2_' + ts;
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
        await startDmCall(page, page2, dm, userData.id, user2);

        // A's mic is on and reaching B (audio sender exists, not gated).
        await waitSenderGate(page, body2.user.id, 'audio', false);

        // B deafens → A must stop sending audio to B (wasted bitrate).
        await page2.evaluate(() => (window as any).VoiceManager.toggleDeafen());
        await page2.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.deafened === true;
        }, undefined, { timeout: 10000 });
        await waitSenderGate(page, body2.user.id, 'audio', true);

        // B undeafens → A resumes sending audio.
        await page2.evaluate(() => (window as any).VoiceManager.toggleDeafen());
        await page2.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.deafened === false;
        }, undefined, { timeout: 10000 });
        await waitSenderGate(page, body2.user.id, 'audio', false);
        await ctx2.close();
    });

    test('DM call: rotating the camera swaps the tile dimensions so it fits (no overflow)', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'vsgr1_' + ts;
        const user2 = 'vsgr2_' + ts;
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
        await startDmCall(page, page2, dm, userData.id, user2);
        const aUid = body1.user.id;

        // A's camera renders in B's DM tile with real layout (and decoded
        // metadata, so the fullscreen math below reads the true source ratio).
        await page.evaluate(() => (window as any).VoiceManager.toggleCamera());
        await page2.waitForFunction((uid) => {
            const v = document.querySelector('.dm-call-tile video[data-kind="camera"][data-uid="' + uid + '"]') as HTMLVideoElement | null;
            return !!v && v.offsetWidth > 0 && v.videoWidth > 0 && v.videoHeight > 0;
        }, aUid, { timeout: 20000 });

        // Rotate 90° → the tile must swap its layout dims (inline px) so the
        // rotated content fits instead of overflowing the tile container.
        await page2.evaluate((uid) => (window as any).VoiceManager._debug.setTileTransform(uid, 'camera', 'rot', 90), aUid);
        await page2.waitForFunction((uid) => {
            const v = document.querySelector('.dm-call-tile video[data-kind="camera"][data-uid="' + uid + '"]');
            if (!v) return false;
            const st = (v as HTMLElement).style;
            return st.transform.indexOf('rotate(90deg)') !== -1 &&
                st.width.endsWith('px') && st.height.endsWith('px') && st.maxWidth === 'none';
        }, aUid, { timeout: 10000 });

        // The swapped box must stay within the tile's media container
        // (rotated content no longer spills over the bottom).
        const fits = await page2.evaluate((uid) => {
            const v = document.querySelector('.dm-call-tile video[data-kind="camera"][data-uid="' + uid + '"]') as HTMLElement;
            const media = v.closest('.dm-call-tile-media') as HTMLElement;
            if (!v || !media) return false;
            const vb = v.getBoundingClientRect();
            const mb = media.getBoundingClientRect();
            return vb.top >= mb.top - 1 && vb.bottom <= mb.bottom + 1 && vb.left >= mb.left - 1 && vb.right <= mb.right + 1;
        }, aUid);
        expect(fits).toBe(true);

        // Reset → inline dims and transform are cleared (CSS-driven layout back).
        await page2.evaluate((uid) => (window as any).VoiceManager._debug.setTileTransform(uid, 'camera', 'reset', 0), aUid);
        const cleared = await page2.evaluate((uid) => {
            const v = document.querySelector('.dm-call-tile video[data-kind="camera"][data-uid="' + uid + '"]') as HTMLElement;
            return v ? (v.style.transform === '' && v.style.width === '' && v.style.height === '') : false;
        }, aUid);
        expect(cleared).toBe(true);

        // Fullscreen: moving the rotated tile into a .voice-fs-wrap must swap
        // the dims to the WRAP's (screen) dimensions with !important — the
        // rotated content then fills the screen instead of staying a wide
        // rectangle cut off at the top and bottom.
        const fsInfo = await page2.evaluate((uid) => {
            const v = document.querySelector('.dm-call-tile video[data-kind="camera"][data-uid="' + uid + '"]') as HTMLElement;
            if (!v) return null;
            const wrap = document.createElement('div');
            wrap.className = 'voice-fs-wrap';
            wrap.appendChild(v);
            document.body.appendChild(wrap);
            (window as any).VoiceManager._debug.setTileTransform(uid, 'camera', 'rot', 90);
            const st = v.style;
            const res = {
                width: st.width,
                height: st.height,
                wImportant: st.getPropertyPriority('width'),
                hImportant: st.getPropertyPriority('height'),
                transform: st.transform,
                fw: wrap.clientWidth,
                fh: wrap.clientHeight,
                vw: v.videoWidth,
                vh: v.videoHeight,
            };
            // Put it back into the DM tile and restore tile-mode dims.
            const media = document.querySelector('.dm-call-tile-media') as HTMLElement;
            if (media) media.appendChild(v);
            (window as any).VoiceManager._debug.setTileTransform(uid, 'camera', 'rot', 90);
            wrap.remove();
            return res;
        }, aUid);
        expect(fsInfo).toBeTruthy();
        expect(fsInfo!.fw).toBeGreaterThan(0);
        expect(fsInfo!.vw).toBeGreaterThan(0);
        // Contain-fit with the SOURCE ratio preserved. A 90°-rotated element
        // paints its layout box transposed, so the LAYOUT keeps the feed's own
        // aspect (here 4:3) while the rotated VISUAL box fits both screen
        // axes. The previous expectation (layout = the screen's transposed
        // dims, e.g. 720×1280 for a 4:3 feed) asserted the stretched
        // rendering this fix removes — width was forced to one screen axis
        // while height followed the other, ignoring the camera's proportions.
        const evw = fsInfo!.vh;   // visual width after 90° rotation
        const evh = fsInfo!.vw;   // visual height after 90° rotation
        const s = Math.min(fsInfo!.fw / evw, fsInfo!.fh / evh);
        const expLayW = Math.round(evh * s);   // layout = visual transposed
        const expLayH = Math.round(evw * s);
        expect(fsInfo!.width).toBe(expLayW + 'px');
        expect(fsInfo!.height).toBe(expLayH + 'px');
        // Ratio preserved (the actual bug: it wasn't).
        const layRatio = expLayW / expLayH;
        const srcRatio = fsInfo!.vw / fsInfo!.vh;
        expect(Math.abs(layRatio - srcRatio)).toBeLessThan(0.02);
        // Rotated visual (the layout transposed) fits inside the screen…
        expect(expLayH).toBeLessThanOrEqual(fsInfo!.fw + 1);
        expect(expLayW).toBeLessThanOrEqual(fsInfo!.fh + 1);
        // …and contain touches the limiting axis: the VISUAL box (the layout
        // transposed) reaches the shorter screen dimension.
        const visW = expLayH, visH = expLayW;
        expect(Math.max(visW, visH) + 2).toBeGreaterThanOrEqual(Math.min(fsInfo!.fw, fsInfo!.fh));
        expect(fsInfo!.wImportant).toBe('important');
        expect(fsInfo!.hImportant).toBe('important');
        expect(fsInfo!.transform).toContain('rotate(90deg)');
        await ctx2.close();
    });

    test('server voice channel: manual-load gates A\'s camera sender to B; Load resumes it', async ({ browser }) => {
        test.setTimeout(240000);
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const ctx2 = await browser.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);

        const ts = Date.now().toString().slice(-6);
        const body1 = await registerUser(page, 'vsgs1_' + ts);
        const serverId = await page.evaluate(async () => {
            const sid = 'srv-' + Date.now();
            const identity = E2ECrypto.getIdentityKeyPair();
            const symKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(sid, symKey);
            const encName = E2ECrypto.aeadEncrypt('Gate Server', symKey);
            const encCh = E2ECrypto.aeadEncrypt('general', symKey);
            const prep = {
                encrypted_name: encName.ciphertext,
                name_nonce: encName.nonce,
                channel_encrypted_name: encCh.ciphertext,
                channel_name_nonce: encCh.nonce,
                invite_code: 'GT' + Date.now(),
            };
            const srv = await (await fetch('/api/servers', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' },
                body: JSON.stringify(prep),
            })).json();
            E2ECrypto.saveServerKey(srv.id, symKey);
            const myId = JSON.parse(localStorage.getItem('user') || '{}').id;
            const pubRes = await fetch('/api/identity/' + myId, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const pubData = await pubRes.json();
            const pubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(pubData.identity_public_key));
            const enc = E2ECrypto.envelopeEncrypt(symKey, pubKey, identity.privateKey);
            await fetch('/api/servers/' + srv.id + '/keys', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: myId,
                    encrypted_key: enc.ciphertext,
                    sender_public_key: E2ECrypto.arrayBufferToBase64(identity.publicKey),
                    nonce: enc.nonce,
                }),
            });
            const encV = E2ECrypto.aeadEncrypt('Gate Voice', symKey);
            const ch = await (await fetch('/api/servers/' + srv.id + '/channels', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'Gate Voice',
                    encrypted_name: encV.ciphertext,
                    name_nonce: encV.nonce,
                    channel_type: 'voice',
                }),
            })).json();
            return { serverId: srv.id, voiceChannelId: ch.id, inviteCode: prep.invite_code, key: E2ECrypto.arrayBufferToBase64(symKey) };
        });

        const body2 = await registerUser(page2, 'vsgs2_' + ts);
        const join = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { code: serverId.inviteCode },
        });
        expect(join.ok()).toBeTruthy();

        await page.goto(`${BASE}/index.html`);
        await page2.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2000);
        await page2.waitForTimeout(2000);
        await waitForWs(page);
        await waitForWs(page2);

        // A joins the voice channel, camera on.
        await selectServer(page);
        await clickVoiceChannel(page, serverId.voiceChannelId);
        await page.waitForFunction(() => {
            const v = (window as any).VoiceManager;
            return v && v.getState && v.getState().connected;
        }, undefined, { timeout: 15000 });
        await page.evaluate(() => (window as any).VoiceManager.toggleCamera());
        await page.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.cameraOn;
        }, undefined, { timeout: 15000 });

        // B joins; enables manual load → A's camera sender to B must gate.
        await selectServer(page2);
        await clickVoiceChannel(page2, serverId.voiceChannelId);
        await page2.waitForFunction(() => {
            const v = (window as any).VoiceManager;
            return v && v.getState && v.getState().connected;
        }, undefined, { timeout: 15000 });
        // Navigate into the voice channel view (click the voice channel again
        // to toggle the popup) so the member rows with video tiles are visible.
        await page2.waitForTimeout(1500);
        await clickVoiceChannel(page2, serverId.voiceChannelId);
        await page2.waitForFunction(() => {
            var p = document.getElementById('voice-popup');
            return p && p.style.display === 'flex';
        }, undefined, { timeout: 10000 });
        // Wait for A's camera stream to arrive at B (the video m-line must
        // complete negotiation before the Load button can be displayed).
        var aUid = body1.user.id;
        await page2.waitForFunction((aUid) => {
            const s = (window as any).VoiceManager._debug.state;
            return s.remoteStreams[aUid] && s.remoteStreams[aUid].camera;
        }, aUid, { timeout: 20000 });
        await page2.evaluate(() => (window as any).VoiceManager.setManualVideoLoad(true));
        await waitSenderGate(page, body2.user.id, 'video', true);

        // B's voice-channel row holds A's camera behind a Load button.
        await page2.waitForSelector('.voice-member-media .voice-feed-load-btn', { state: 'visible', timeout: 15000 });
        await page2.click('.voice-member-media .voice-feed-load-btn');
        await waitSenderGate(page, body2.user.id, 'video', false);

        // Unload button over the loaded tile; click → gated again.
        const unloadBtn = page2.locator('.voice-member-media .voice-feed-unload-btn');
        await unloadBtn.waitFor({ state: 'visible', timeout: 10000 });
        await unloadBtn.click();
        await waitSenderGate(page, body2.user.id, 'video', true);
        await page2.waitForSelector('.voice-member-media .voice-feed-load-btn', { state: 'visible', timeout: 10000 });

        await ctx.close();
        await ctx2.close();
    });
});
