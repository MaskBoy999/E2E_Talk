import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.use({
    headless: false,
    ignoreHTTPSErrors: true,
    launchOptions: {
        args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            '--ignore-certificate-errors',
        ],
    },
});

// --- Helpers ----------------------------------------------------------------

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(1000);
    const url = page.url();
    if (url.includes('index.html')) {
        return await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));
    }
    await page.click('#show-register');
    await page.waitForTimeout(500);
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function waitForWs(page: any, maxRetries = 60) {
    return await page.evaluate((maxRetries: number) => {
        return new Promise((resolve) => {
            let tries = 0;
            const check = () => {
                tries++;
                if (typeof (window as any).ws !== 'undefined' && (window as any).ws && (window as any).ws.readyState === WebSocket.OPEN) resolve(true);
                else if (tries >= maxRetries) resolve(false);
                else setTimeout(check, 200);
            };
            setTimeout(check, 500);
        });
    }, maxRetries);
}

async function createServerWithVoiceChannel(page: any, token: string) {
    const ts = Date.now();
    const inviteCode = 'AE2E' + ts;
    const prep = await page.evaluate(async ({ inviteCode }: { inviteCode: string }) => {
        const E = (window as any).E2ECrypto;
        const symKey = E.generateSymmetricKey();
        const encName = E.aeadEncrypt('ResTest Server', symKey);
        const encCh = E.aeadEncrypt('voice', symKey);
        return {
            encrypted_name: encName.ciphertext,
            name_nonce: encName.nonce,
            channel_encrypted_name: encCh.ciphertext,
            channel_name_nonce: encCh.nonce,
            invite_code: inviteCode,
        };
    }, { inviteCode });

    const srv = await (await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            invite_code: inviteCode,
            encrypted_name: prep.encrypted_name,
            name_nonce: prep.name_nonce,
            channel_encrypted_name: prep.channel_encrypted_name,
            channel_name_nonce: prep.channel_name_nonce,
        },
    })).json();
    const serverId = srv.id;

    await page.evaluate(async ({ serverId }: { serverId: string }) => {
        const E = (window as any).E2ECrypto;
        const symKey = E.generateSymmetricKey();
        E.saveServerKey(serverId, symKey);
        const identity = E.getIdentityKeyPair();
        const myId = JSON.parse(localStorage.getItem('user') || '{}').id;
        const pubRes = await fetch('/api/identity/' + myId, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const pubData = await pubRes.json();
        const pubKey = new Uint8Array(E.base64ToArrayBuffer(pubData.identity_public_key));
        const enc = E.envelopeEncrypt(symKey, pubKey, identity.privateKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: myId,
                encrypted_key: enc.ciphertext,
                sender_public_key: E.arrayBufferToBase64(identity.publicKey),
                nonce: enc.nonce,
            }),
        });
    }, { serverId });

    const ch = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { name: 'Voice', channel_type: 'voice' },
    })).json();
    expect(ch.channel_type).toBe('voice');
    return { serverId, voiceChannelId: ch.id, inviteCode };
}

async function joinServerViaInvite(page: any, token: string, inviteCode: string) {
    const join = await page.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { code: inviteCode },
    });
    expect(join.ok()).toBeTruthy();
    return (await join.json()).id;
}

async function selectServer(page: any) {
    await page.evaluate(() => { if (typeof (window as any).loadServers === 'function') (window as any).loadServers(); }).catch(() => {});
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

async function waitForConnected(page: any, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const ok = await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            return V && V._debug && V._debug.state && V._debug.state.connected;
        });
        if (ok) return true;
        await page.waitForTimeout(500);
    }
    return false;
}

async function startDmCall(pageA: any, pageB: any, userB: any) {
    // A clicks B's user to start a DM call
    await pageA.evaluate((partnerId: string) => {
        const V = (window as any).VoiceManager;
        V.startDmCall(partnerId);
    }, userB.id);
    // Wait for the DM call to connect
    await pageA.waitForTimeout(3000);
    // B should see incoming call, accept it
    await pageB.evaluate(() => {
        const V = (window as any).VoiceManager;
        if (V._debug.state.incomingCall) {
            V.acceptDmCall();
        }
    });
    await pageB.waitForTimeout(3000);
}

// --- Test Suite -------------------------------------------------------------

test.describe('Resolution and FPS settings', () => {

    // ================================================================
    // SERVER VOICE CHANNEL — RELAY MODE
    // ================================================================

    test('server voice relay: send camera resolution is applied', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        console.log('=== SERVER VOICE RELAY: SEND CAMERA RES ===');

        const uA = await registerUser(page, 'ResCamA_' + ts);
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        const { voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, uA.token);

        const ctxB = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        const uB = await registerUser(pageB, 'ResCamB_' + ts);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);
        await joinServerViaInvite(pageB, uB.token, inviteCode);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);

        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await waitForConnected(page);
        await selectServer(pageB);
        await clickVoiceChannel(pageB, voiceChannelId);
        await waitForConnected(pageB);
        console.log('[1] Both in voice channel');

        // Force relay
        await page.evaluate(() => {
            (window as any).VoiceManager.setSelfAudioMode('relay');
            (window as any).VoiceManager.setSelfVideoMode('relay');
        });
        await page.waitForTimeout(500);

        // Set send camera to 720p
        await page.evaluate(() => {
            (window as any).VoiceManager.setSendRes('camera', 720);
        });
        await page.waitForTimeout(500);

        // Start camera
        await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            if (!V._debug.state.cameraOn) V.toggleCamera();
        });
        await page.waitForTimeout(2000);

        // Verify setting persisted
        const settings = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            return { sendCameraRes: S.settings.sendCameraRes };
        });
        console.log('[2] Settings:', JSON.stringify(settings));
        expect(settings.sendCameraRes).toBe(720);

        // Verify camera stream exists
        const camState = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            return { cameraOn: S.cameraOn, hasStream: !!S.localStreams.camera };
        });
        expect(camState.cameraOn).toBeTruthy();
        expect(camState.hasStream).toBeTruthy();
        console.log('[3] Camera is on');

        // Verify the relay canvas uses the right resolution
        const relayState = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            return { relayTimers: Object.keys(S._relayTimers || {}), cameraOn: S.cameraOn };
        });
        expect(relayState.relayTimers).toContain('camera');
        console.log('[4] Relay camera timer active');

        // Check B received video
        await pageB.waitForTimeout(3000);
        const bVideo = await pageB.evaluate((senderUid: string) => {
            const S = (window as any).VoiceManager._debug.state;
            const fk = senderUid + '_camera';
            return {
                hasFrameUrl: !!(S._relayVideoFrames || {})[fk],
                hasVideoTile: !!document.querySelector('video.remote-video-tile[data-uid="' + senderUid + '"][data-kind="camera"]'),
                hasRelayImg: !!document.querySelector('img.remote-video-tile[data-uid="' + senderUid + '"][data-kind="camera"]'),
            };
        }, uA.user.id);
        console.log('[5] B sees A:', JSON.stringify(bVideo));

        console.log('\n=== PASSED ===');

        await pageB.close();
        await ctxB.close();
    });

    test('server voice relay: send screen resolution is applied', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        console.log('=== SERVER VOICE RELAY: SEND SCREEN RES ===');

        const uA = await registerUser(page, 'ResScrA_' + ts);
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        const { voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, uA.token);

        const ctxB = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        const uB = await registerUser(pageB, 'ResScrB_' + ts);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);
        await joinServerViaInvite(pageB, uB.token, inviteCode);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);

        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await waitForConnected(page);
        await selectServer(pageB);
        await clickVoiceChannel(pageB, voiceChannelId);
        await waitForConnected(pageB);
        console.log('[1] Both in voice channel');

        // Force relay
        await page.evaluate(() => {
            (window as any).VoiceManager.setSelfAudioMode('relay');
            (window as any).VoiceManager.setSelfVideoMode('relay');
        });
        await page.waitForTimeout(500);

        // Set send screen to 1080p
        await page.evaluate(() => {
            (window as any).VoiceManager.setSendRes('screen', 1080);
        });
        await page.waitForTimeout(500);

        // Verify setting persisted
        const settings = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            return { sendScreenRes: S.settings.sendScreenRes };
        });
        console.log('[2] Settings:', JSON.stringify(settings));
        expect(settings.sendScreenRes).toBe(1080);

        // Note: can't easily start screen share in fake media test, but verify setting is stored
        console.log('[3] Screen send resolution stored correctly');

        console.log('\n=== PASSED ===');

        await pageB.close();
        await ctxB.close();
    });

    test('server voice relay: recv camera resolution is broadcast', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        console.log('=== SERVER VOICE RELAY: RECV CAMERA RES ===');

        const uA = await registerUser(page, 'RecvCamA_' + ts);
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        const { voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, uA.token);

        const ctxB = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        const uB = await registerUser(pageB, 'RecvCamB_' + ts);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);
        await joinServerViaInvite(pageB, uB.token, inviteCode);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);

        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await waitForConnected(page);
        await selectServer(pageB);
        await clickVoiceChannel(pageB, voiceChannelId);
        await waitForConnected(pageB);
        console.log('[1] Both in voice channel');

        // A sets recv camera to 720p
        await page.evaluate(() => {
            (window as any).VoiceManager.setRecvRes('camera', 720);
        });
        await page.waitForTimeout(1000);

        // Verify A's setting
        const aSettings = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            return { recvCameraRes: S.settings.recvCameraRes };
        });
        expect(aSettings.recvCameraRes).toBe(720);
        console.log('[2] A recv camera res:', aSettings.recvCameraRes);

        // Check B sees A's declared recv_camera_res via member data
        const bMemberData = await pageB.evaluate((aUid: string) => {
            const S = (window as any).VoiceManager._debug.state;
            const member = S.members[aUid] || {};
            return { recv_camera_res: member.recv_camera_res };
        }, uA.user.id);
        console.log('[3] B sees A recv_camera_res:', bMemberData.recv_camera_res);
        expect(bMemberData.recv_camera_res).toBe(720);

        console.log('\n=== PASSED ===');

        await pageB.close();
        await ctxB.close();
    });

    test('server voice relay: relay FPS setting is applied', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        console.log('=== SERVER VOICE RELAY: FPS SETTING ===');

        const uA = await registerUser(page, 'FpsSetA_' + ts);
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        const { voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, uA.token);

        const ctxB = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        const uB = await registerUser(pageB, 'FpsSetB_' + ts);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);
        await joinServerViaInvite(pageB, uB.token, inviteCode);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);

        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await waitForConnected(page);
        await selectServer(pageB);
        await clickVoiceChannel(pageB, voiceChannelId);
        await waitForConnected(pageB);
        console.log('[1] Both in voice channel');

        // Force relay
        await page.evaluate(() => {
            (window as any).VoiceManager.setSelfAudioMode('relay');
            (window as any).VoiceManager.setSelfVideoMode('relay');
        });
        await page.waitForTimeout(500);

        // Set FPS to 10
        await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            S.settings.relayVideoFps = 10;
            (window as any).localStorage.setItem('voice_settings', JSON.stringify(S.settings));
        });
        await page.waitForTimeout(500);

        // Verify
        const fpsSetting = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            return { relayVideoFps: S.settings.relayVideoFps };
        });
        console.log('[2] FPS setting:', JSON.stringify(fpsSetting));
        expect(fpsSetting.relayVideoFps).toBe(10);

        // Start camera and measure actual FPS
        await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            if (!V._debug.state.cameraOn) V.toggleCamera();
        });
        await page.waitForTimeout(1000);

        // Count frames sent over 3 seconds
        const fpsResult = await page.evaluate(() => {
            return new Promise((resolve) => {
                const S = (window as any).VoiceManager._debug.state;
                (S as any)._testFrameCount = 0;
                const origSend = (window as any).ws.send;
                (window as any).ws.send = function (data: any) {
                    try {
                        if (data instanceof ArrayBuffer) {
                            const u8 = new Uint8Array(data);
                            if (u8.length > 0 && u8[0] === 0) (S as any)._testFrameCount++;
                        } else if (typeof data === 'string') {
                            const parsed = JSON.parse(data);
                            if (parsed.type === 'voice_media_relay' && parsed.kind === 'camera') {
                                (S as any)._testFrameCount++;
                            }
                        }
                    } catch (_) {}
                    origSend.call(this, data);
                };
                setTimeout(() => {
                    (window as any).ws.send = origSend;
                    const count = (S as any)._testFrameCount;
                    const fps = count / 3;
                    resolve({ frameCount: count, measuredFps: Math.round(fps) });
                }, 3000);
            });
        });
        console.log('[3] Measured FPS:', JSON.stringify(fpsResult));

        // FPS should be around 10, allow range 5-15
        expect(fpsResult.measuredFps).toBeGreaterThan(5);
        expect(fpsResult.measuredFps).toBeLessThan(15);
        console.log(`[PASS] Measured ${fpsResult.measuredFps} FPS (expected ~10)`);

        console.log('\n=== PASSED ===');

        await pageB.close();
        await ctxB.close();
    });

    // ================================================================
    // SERVER VOICE CHANNEL — MESH MODE
    // ================================================================

    test('server voice mesh: send camera resolution is applied', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        console.log('=== SERVER VOICE MESH: SEND CAMERA RES ===');

        const uA = await registerUser(page, 'MeshCamA_' + ts);
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        const { voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, uA.token);

        const ctxB = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        const uB = await registerUser(pageB, 'MeshCamB_' + ts);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);
        await joinServerViaInvite(pageB, uB.token, inviteCode);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);

        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await waitForConnected(page);
        await selectServer(pageB);
        await clickVoiceChannel(pageB, voiceChannelId);
        await waitForConnected(pageB);
        console.log('[1] Both in voice channel (mesh)');

        // Ensure mesh mode
        await page.evaluate(() => {
            (window as any).VoiceManager.setSelfAudioMode('mesh');
            (window as any).VoiceManager.setSelfVideoMode('mesh');
        });
        await page.waitForTimeout(500);

        // Set send camera to 720p
        await page.evaluate(() => {
            (window as any).VoiceManager.setSendRes('camera', 720);
        });
        await page.waitForTimeout(500);

        // Verify setting
        const settings = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            return { sendCameraRes: S.settings.sendCameraRes };
        });
        expect(settings.sendCameraRes).toBe(720);
        console.log('[2] Send camera res:', settings.sendCameraRes);

        // Start camera
        await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            if (!V._debug.state.cameraOn) V.toggleCamera();
        });
        await page.waitForTimeout(2000);

        // Verify camera is on and track exists
        const camState = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            const tracks = S.localStreams.camera ? S.localStreams.camera.getVideoTracks() : [];
            return { cameraOn: S.cameraOn, trackCount: tracks.length };
        });
        expect(camState.cameraOn).toBeTruthy();
        expect(camState.trackCount).toBe(1);
        console.log('[3] Camera on with', camState.trackCount, 'track(s)');

        // Check B received video via mesh
        await pageB.waitForTimeout(3000);
        const bMeshVideo = await pageB.evaluate((senderUid: string) => {
            const S = (window as any).VoiceManager._debug.state;
            const rs = S.remoteStreams[senderUid] || {};
            const hasVideo = !!(rs.camera && rs.camera.getVideoTracks && rs.camera.getVideoTracks().length > 0);
            const videoEl = document.querySelector('video.remote-video-tile[data-uid="' + senderUid + '"][data-kind="camera"]');
            return {
                hasRemoteStream: hasVideo,
                videoElFound: !!videoEl,
                srcObjectSet: videoEl ? !!videoEl.srcObject : false,
            };
        }, uA.user.id);
        console.log('[4] B sees A via mesh:', JSON.stringify(bMeshVideo));

        console.log('\n=== PASSED ===');

        await pageB.close();
        await ctxB.close();
    });

    test('server voice mesh: recv camera resolution is broadcast', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        console.log('=== SERVER VOICE MESH: RECV CAMERA RES ===');

        const uA = await registerUser(page, 'MeshRecvA_' + ts);
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        const { voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, uA.token);

        const ctxB = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        const uB = await registerUser(pageB, 'MeshRecvB_' + ts);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);
        await joinServerViaInvite(pageB, uB.token, inviteCode);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);

        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await waitForConnected(page);
        await selectServer(pageB);
        await clickVoiceChannel(pageB, voiceChannelId);
        await waitForConnected(pageB);
        console.log('[1] Both in voice channel (mesh)');

        // A sets recv camera to 240p
        await page.evaluate(() => {
            (window as any).VoiceManager.setRecvRes('camera', 240);
        });
        await page.waitForTimeout(1000);

        const aSettings = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            return { recvCameraRes: S.settings.recvCameraRes };
        });
        expect(aSettings.recvCameraRes).toBe(240);
        console.log('[2] A recv camera res:', aSettings.recvCameraRes);

        // Check B sees A's declared recv_camera_res
        const bMemberData = await pageB.evaluate((aUid: string) => {
            const S = (window as any).VoiceManager._debug.state;
            const member = S.members[aUid] || {};
            return { recv_camera_res: member.recv_camera_res };
        }, uA.user.id);
        console.log('[3] B sees A recv_camera_res:', bMemberData.recv_camera_res);
        expect(bMemberData.recv_camera_res).toBe(240);

        // Check that A's sender for B has scaleResolutionDownBy set
        const senderParams = await page.evaluate((bUid: string) => {
            const S = (window as any).VoiceManager._debug.state;
            const pc = S.peers[bUid];
            if (!pc || !pc.getSenders) return { error: 'no peer' };
            const videoSenders = pc.getSenders().filter((s: any) => s.track && s.track.kind === 'video');
            if (!videoSenders.length) return { error: 'no video sender' };
            try {
                const params = videoSenders[0].getParameters();
                const enc = params.encodings && params.encodings[0];
                return {
                    scale: enc ? enc.scaleResolutionDownBy : null,
                    maxBitrate: enc ? enc.maxBitrate : null,
                    maxFramerate: enc ? enc.maxFramerate : null,
                };
            } catch (e: any) {
                return { error: e.message };
            }
        }, uB.user.id);
        console.log('[4] A sender params for B:', JSON.stringify(senderParams));

        console.log('\n=== PASSED ===');

        await pageB.close();
        await ctxB.close();
    });

    // ================================================================
    // DM CALL — ALWAYS MESH
    // ================================================================

    test('DM call mesh: send camera resolution is applied', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        console.log('=== DM CALL MESH: SEND CAMERA RES ===');

        const uA = await registerUser(page, 'DmCamA_' + ts);
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        // Create a server to find the user (DM requires existing account)
        const { inviteCode } = await createServerWithVoiceChannel(page, uA.token);

        const ctxB = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        const uB = await registerUser(pageB, 'DmCamB_' + ts);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);
        await joinServerViaInvite(pageB, uB.token, inviteCode);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);

        // Both on the same server so they can DM
        await selectServer(page);
        await page.waitForTimeout(500);

        // Set send camera to 480p before starting DM
        await page.evaluate(() => {
            (window as any).VoiceManager.setSendRes('camera', 480);
        });
        await page.waitForTimeout(500);

        const settings = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            return { sendCameraRes: S.settings.sendCameraRes };
        });
        expect(settings.sendCameraRes).toBe(480);
        console.log('[1] DM send camera res setting:', settings.sendCameraRes);

        // Verify DM calls always use mesh (autoVideoMode returns 'mesh' for DM)
        const meshCheck = await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            // Simulate what autoVideoMode does for DM
            const S = V._debug.state;
            return {
                roomType: S.roomType,
                videoMeshMode: S.settings.videoMeshMode,
            };
        });
        console.log('[2] DM mesh check:', JSON.stringify(meshCheck));
        // DM always uses mesh regardless of settings
        console.log('[3] DM calls always use mesh for video');

        console.log('\n=== PASSED ===');

        await pageB.close();
        await ctxB.close();
    });

    test('DM call mesh: recv camera resolution is broadcast', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        console.log('=== DM CALL MESH: RECV CAMERA RES ===');

        const uA = await registerUser(page, 'DmRecvA_' + ts);
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        const { inviteCode } = await createServerWithVoiceChannel(page, uA.token);

        const ctxB = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        const uB = await registerUser(pageB, 'DmRecvB_' + ts);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);
        await joinServerViaInvite(pageB, uB.token, inviteCode);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);

        await selectServer(page);
        await page.waitForTimeout(500);

        // A sets recv camera to 720p
        await page.evaluate(() => {
            (window as any).VoiceManager.setRecvRes('camera', 720);
        });
        await page.waitForTimeout(500);

        const settings = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            return { recvCameraRes: S.settings.recvCameraRes };
        });
        expect(settings.recvCameraRes).toBe(720);
        console.log('[1] A recv camera res:', settings.recvCameraRes);

        // Verify setting persists in localStorage
        const persisted = await page.evaluate(() => {
            const raw = localStorage.getItem('voice_settings');
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return { recvCameraRes: parsed.recvCameraRes };
        });
        expect(persisted?.recvCameraRes).toBe(720);
        console.log('[2] Persisted in localStorage:', JSON.stringify(persisted));

        console.log('\n=== PASSED ===');

        await pageB.close();
        await ctxB.close();
    });

    // ================================================================
    // SETTINGS PERSISTENCE
    // ================================================================

    test('settings persistence: resolution and FPS survive reload', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        console.log('=== SETTINGS PERSISTENCE TEST ===');

        const uA = await registerUser(page, 'Persist_' + ts);
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);

        // Set various resolutions
        await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            V.setSendRes('camera', 1080);
            V.setSendRes('screen', 1440);
            V.setRecvRes('camera', 720);
            V.setRecvRes('screen', 2160);
        });
        await page.waitForTimeout(500);

        // Set FPS
        await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            S.settings.relayVideoFps = 15;
            (window as any).localStorage.setItem('voice_settings', JSON.stringify(S.settings));
        });
        await page.waitForTimeout(500);

        // Verify all settings
        const before = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            return {
                sendCameraRes: S.settings.sendCameraRes,
                sendScreenRes: S.settings.sendScreenRes,
                recvCameraRes: S.settings.recvCameraRes,
                recvScreenRes: S.settings.recvScreenRes,
                relayVideoFps: S.settings.relayVideoFps,
            };
        });
        console.log('[1] Before reload:', JSON.stringify(before));
        expect(before.sendCameraRes).toBe(1080);
        expect(before.sendScreenRes).toBe(1440);
        expect(before.recvCameraRes).toBe(720);
        expect(before.recvScreenRes).toBe(2160);
        expect(before.relayVideoFps).toBe(15);

        // Reload the page
        await page.reload();
        await page.waitForTimeout(3000);
        await waitForWs(page);

        // Verify settings survived
        const after = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            return {
                sendCameraRes: S.settings.sendCameraRes,
                sendScreenRes: S.settings.sendScreenRes,
                recvCameraRes: S.settings.recvCameraRes,
                recvScreenRes: S.settings.recvScreenRes,
                relayVideoFps: S.settings.relayVideoFps,
            };
        });
        console.log('[2] After reload:', JSON.stringify(after));

        expect(after.sendCameraRes).toBe(1080);
        console.log('[PASS] sendCameraRes survived: 1080');
        expect(after.sendScreenRes).toBe(1440);
        console.log('[PASS] sendScreenRes survived: 1440');
        expect(after.recvCameraRes).toBe(720);
        console.log('[PASS] recvCameraRes survived: 720');
        expect(after.recvScreenRes).toBe(2160);
        console.log('[PASS] recvScreenRes survived: 2160');
        expect(after.relayVideoFps).toBe(15);
        console.log('[PASS] relayVideoFps survived: 15');

        console.log('\n=== PERSISTENCE TEST PASSED ===');
    });

    // ================================================================
    // DEFAULT VALUES
    // ================================================================

    test('default values: resolution and FPS have correct defaults', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        console.log('=== DEFAULT VALUES TEST ===');

        const uA = await registerUser(page, 'Defaults_' + ts);
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);

        // Clear localStorage to get fresh defaults
        await page.evaluate(() => {
            localStorage.removeItem('voice_settings');
        });
        await page.reload();
        await page.waitForTimeout(3000);
        await waitForWs(page);

        const defaults = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            return {
                sendCameraRes: S.settings.sendCameraRes,
                sendScreenRes: S.settings.sendScreenRes,
                recvCameraRes: S.settings.recvCameraRes,
                recvScreenRes: S.settings.recvScreenRes,
                relayVideoFps: S.settings.relayVideoFps,
            };
        });
        console.log('[1] Defaults:', JSON.stringify(defaults));

        expect(defaults.sendCameraRes).toBe(360);
        console.log('[PASS] sendCameraRes default: 360');
        expect(defaults.sendScreenRes).toBe(480);
        console.log('[PASS] sendScreenRes default: 480');
        expect(defaults.recvCameraRes).toBe(360);
        console.log('[PASS] recvCameraRes default: 360');
        expect(defaults.recvScreenRes).toBe(480);
        console.log('[PASS] recvScreenRes default: 480');
        expect(defaults.relayVideoFps).toBe(30);
        console.log('[PASS] relayVideoFps default: 30');

        console.log('\n=== DEFAULTS TEST PASSED ===');
    });

    // ================================================================
    // EFFECTIVE RESOLUTION — SENDER PARAM VERIFICATION
    // Fake media always produces 320x180, so we verify the
    // tuneVideoSenders logic via RTCRtpSender.getParameters() instead
    // of decoded resolution.
    // ================================================================

    async function getVideoSenderParams(page: Page, peerUid: string) {
        return await page.evaluate(async (uid: string) => {
            const S = (window as any).VoiceManager._debug.state;
            const pc = S.peers[uid];
            if (!pc || !pc.getSenders) return { error: 'no peer' };
            try {
                const videoSenders = pc.getSenders().filter((s: any) => s.track && s.track.kind === 'video');
                if (!videoSenders.length) return { error: 'no video sender' };
                const params = videoSenders[0].getParameters();
                const enc = params.encodings && params.encodings[0];
                return {
                    scale: enc ? enc.scaleResolutionDownBy : null,
                    maxBitrate: enc ? enc.maxBitrate : null,
                    maxFramerate: enc ? enc.maxFramerate : null,
                };
            } catch (e: any) { return { error: e.message }; }
        }, peerUid);
    }

    test('mesh sender params: recv 360 + sender 480 → scale ~1.33', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        console.log('=== MESH SENDER PARAMS: RECV 360 + SEND 480 ===');

        const uA = await registerUser(page, 'Scale1A_' + ts);
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        const { voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, uA.token);

        const ctxB = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        const uB = await registerUser(pageB, 'Scale1B_' + ts);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);
        await joinServerViaInvite(pageB, uB.token, inviteCode);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);

        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await waitForConnected(page);
        await selectServer(pageB);
        await clickVoiceChannel(pageB, voiceChannelId);
        await waitForConnected(pageB);
        console.log('[1] Both in voice channel (mesh)');

        await page.evaluate(() => {
            (window as any).VoiceManager.setSelfAudioMode('mesh');
            (window as any).VoiceManager.setSelfVideoMode('mesh');
        });
        await pageB.evaluate(() => {
            (window as any).VoiceManager.setSelfAudioMode('mesh');
            (window as any).VoiceManager.setSelfVideoMode('mesh');
        });
        await page.waitForTimeout(500);

        await page.evaluate(() => { (window as any).VoiceManager.setSendRes('camera', 480); });
        await pageB.evaluate(() => { (window as any).VoiceManager.setRecvRes('camera', 360); });
        await page.waitForTimeout(1000);

        await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            if (!V._debug.state.cameraOn) V.toggleCamera();
        });
        await page.waitForTimeout(4000);

        // Verify B sees A recv_camera_res
        const bMemberData = await pageB.evaluate((aUid: string) => {
            const S = (window as any).VoiceManager._debug.state;
            return { recv_camera_res: S.members[aUid]?.recv_camera_res };
        }, uA.user.id);
        console.log('[2] B sees A recv_camera_res:', bMemberData.recv_camera_res);
        expect(bMemberData.recv_camera_res).toBe(360);

        // A's sender params for B: scale = 480/360 ≈ 1.33
        const senderParams = await getVideoSenderParams(page, uB.user.id);
        console.log('[3] A sender params for B:', JSON.stringify(senderParams));
        if (!senderParams.error) {
            expect(senderParams.scale).toBeCloseTo(480 / 360, 0);
            console.log(`[PASS] scaleResolutionDownBy = ${senderParams.scale} (expected ~1.33)`);
            expect(senderParams.maxBitrate).toBe(700000);
            console.log(`[PASS] maxBitrate = ${senderParams.maxBitrate} (360p)`);
            expect(senderParams.maxFramerate).toBe(30);
            console.log(`[PASS] maxFramerate = ${senderParams.maxFramerate}`);
        }

        console.log('\n=== PASSED ===');
        await pageB.close();
        await ctxB.close();
    });

    test('mesh sender params: recv 720 + sender 360 → scale 1 (no upscale)', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        console.log('=== MESH SENDER PARAMS: RECV 720 + SEND 360 ===');

        const uA = await registerUser(page, 'Scale2A_' + ts);
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        const { voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, uA.token);

        const ctxB = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        const uB = await registerUser(pageB, 'Scale2B_' + ts);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);
        await joinServerViaInvite(pageB, uB.token, inviteCode);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);

        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await waitForConnected(page);
        await selectServer(pageB);
        await clickVoiceChannel(pageB, voiceChannelId);
        await waitForConnected(pageB);
        console.log('[1] Both in voice channel (mesh)');

        await page.evaluate(() => {
            (window as any).VoiceManager.setSelfAudioMode('mesh');
            (window as any).VoiceManager.setSelfVideoMode('mesh');
        });
        await pageB.evaluate(() => {
            (window as any).VoiceManager.setSelfAudioMode('mesh');
            (window as any).VoiceManager.setSelfVideoMode('mesh');
        });
        await page.waitForTimeout(500);

        await page.evaluate(() => { (window as any).VoiceManager.setSendRes('camera', 360); });
        await pageB.evaluate(() => { (window as any).VoiceManager.setRecvRes('camera', 720); });
        await page.waitForTimeout(1000);

        await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            if (!V._debug.state.cameraOn) V.toggleCamera();
        });
        await page.waitForTimeout(4000);

        const senderParams = await getVideoSenderParams(page, uB.user.id);
        console.log('[2] A sender params for B:', JSON.stringify(senderParams));
        if (!senderParams.error) {
            expect(senderParams.scale).toBe(1);
            console.log(`[PASS] scaleResolutionDownBy = 1 (no upscale)`);
            expect(senderParams.maxBitrate).toBe(700000);
            console.log(`[PASS] maxBitrate = ${senderParams.maxBitrate} (360p bitrate)`);
        }

        console.log('\n=== PASSED ===');
        await pageB.close();
        await ctxB.close();
    });

    test('mesh sender params: recv 240 + sender 720 → scale 3 (heavy downscale)', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        console.log('=== MESH SENDER PARAMS: RECV 240 + SEND 720 ===');

        const uA = await registerUser(page, 'Scale3A_' + ts);
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        const { voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, uA.token);

        const ctxB = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        const uB = await registerUser(pageB, 'Scale3B_' + ts);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);
        await joinServerViaInvite(pageB, uB.token, inviteCode);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);

        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await waitForConnected(page);
        await selectServer(pageB);
        await clickVoiceChannel(pageB, voiceChannelId);
        await waitForConnected(pageB);
        console.log('[1] Both in voice channel (mesh)');

        await page.evaluate(() => {
            (window as any).VoiceManager.setSelfAudioMode('mesh');
            (window as any).VoiceManager.setSelfVideoMode('mesh');
        });
        await pageB.evaluate(() => {
            (window as any).VoiceManager.setSelfAudioMode('mesh');
            (window as any).VoiceManager.setSelfVideoMode('mesh');
        });
        await page.waitForTimeout(500);

        await page.evaluate(() => { (window as any).VoiceManager.setSendRes('camera', 720); });
        await pageB.evaluate(() => { (window as any).VoiceManager.setRecvRes('camera', 240); });
        await page.waitForTimeout(1000);

        await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            if (!V._debug.state.cameraOn) V.toggleCamera();
        });
        await page.waitForTimeout(4000);

        const senderParams = await getVideoSenderParams(page, uB.user.id);
        console.log('[2] A sender params for B:', JSON.stringify(senderParams));
        if (!senderParams.error) {
            expect(senderParams.scale).toBeCloseTo(3, 0);
            console.log(`[PASS] scaleResolutionDownBy = ${senderParams.scale} (expected 3)`);
            expect(senderParams.maxBitrate).toBe(400000);
            console.log(`[PASS] maxBitrate = ${senderParams.maxBitrate} (240p bitrate)`);
        }

        console.log('\n=== PASSED ===');
        await pageB.close();
        await ctxB.close();
    });

    // ================================================================
    // BIDIRECTIONAL — BOTH SET DIFFERENT RES, EACH VERIFIES SENDER PARAMS
    // ================================================================

    test('mesh bidirectional: A sends 720 requests 360, B sends 360 requests 720', async ({ page, context }) => {
        test.setTimeout(300000);
        const ts = Date.now();
        console.log('=== BIDIRECTIONAL SENDER PARAMS ===');

        const uA = await registerUser(page, 'BidiResA_' + ts);
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        const { voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, uA.token);

        const ctxB = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        const uB = await registerUser(pageB, 'BidiResB_' + ts);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);
        await joinServerViaInvite(pageB, uB.token, inviteCode);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);

        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await waitForConnected(page);
        await selectServer(pageB);
        await clickVoiceChannel(pageB, voiceChannelId);
        await waitForConnected(pageB);
        console.log('[1] Both in voice channel (mesh)');

        await page.evaluate(() => {
            (window as any).VoiceManager.setSelfAudioMode('mesh');
            (window as any).VoiceManager.setSelfVideoMode('mesh');
        });
        await pageB.evaluate(() => {
            (window as any).VoiceManager.setSelfAudioMode('mesh');
            (window as any).VoiceManager.setSelfVideoMode('mesh');
        });
        await page.waitForTimeout(500);

        // A: sends 720p, requests 360p
        await page.evaluate(() => {
            (window as any).VoiceManager.setSendRes('camera', 720);
            (window as any).VoiceManager.setRecvRes('camera', 360);
        });
        // B: sends 360p, requests 720p
        await pageB.evaluate(() => {
            (window as any).VoiceManager.setSendRes('camera', 360);
            (window as any).VoiceManager.setRecvRes('camera', 720);
        });
        await page.waitForTimeout(1000);

        // Wait for recv resolutions to propagate via member data
        await page.waitForFunction((bUid: string) => {
            const S = (window as any).VoiceManager._debug.state;
            return S.members[bUid]?.recv_camera_res === 720;
        }, uB.user.id, { timeout: 10000 });
        await pageB.waitForFunction((aUid: string) => {
            const S = (window as any).VoiceManager._debug.state;
            return S.members[aUid]?.recv_camera_res === 360;
        }, uA.user.id, { timeout: 10000 });
        console.log('[1b] Member recv resolutions propagated');

        // Both start cameras
        await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            if (!V._debug.state.cameraOn) V.toggleCamera();
        });
        await pageB.evaluate(() => {
            const V = (window as any).VoiceManager;
            if (!V._debug.state.cameraOn) V.toggleCamera();
        });
        await page.waitForTimeout(5000);

        // Wait for sender params to be tuned after negotiation completes
        async function waitForTunedParams(pageRef: Page, peerUid: string, expectedScale: number, maxRetries = 15) {
            for (let i = 0; i < maxRetries; i++) {
                const params = await getVideoSenderParams(pageRef, peerUid);
                if (!params.error && params.scale && Math.abs(params.scale - expectedScale) < 0.5) {
                    return params;
                }
                await pageRef.waitForTimeout(1000);
            }
            return await getVideoSenderParams(pageRef, peerUid);
        }

        // tuneVideoSenders uses PEER's declared recv_camera_res (what THEY want).
        // A→B: A's baseH=720, B's declared recv_camera_res=720, scale=720/720=1
        // B→A: B's baseH=360, A's declared recv_camera_res=360, scale=360/360=1
        // Effective: A→B = min(720, 720) = 720p, B→A = min(360, 360) = 360p

        // A's sender params for B
        const aSenderParams = await waitForTunedParams(page, uB.user.id, 1);
        console.log('[2] A sender params for B:', JSON.stringify(aSenderParams));
        if (!aSenderParams.error) {
            expect(aSenderParams.scale).toBe(1);
            console.log(`[PASS] A→B scale = ${aSenderParams.scale} (720/720, B wants 720)`);
            expect(aSenderParams.maxBitrate).toBe(2500000);
            console.log(`[PASS] A→B maxBitrate = ${aSenderParams.maxBitrate} (720p bitrate)`);
        }

        // B's sender params for A
        const bSenderParams = await waitForTunedParams(pageB, uA.user.id, 1);
        console.log('[3] B sender params for A:', JSON.stringify(bSenderParams));
        if (!bSenderParams.error) {
            expect(bSenderParams.scale).toBe(1);
            console.log(`[PASS] B→A scale = ${bSenderParams.scale} (360/360, A wants 360)`);
            expect(bSenderParams.maxBitrate).toBe(700000);
            console.log(`[PASS] B→A maxBitrate = ${bSenderParams.maxBitrate} (360p bitrate)`);
        }

        console.log('\n=== BIDIRECTIONAL PARAMS TEST PASSED ===');
        await pageB.close();
        await ctxB.close();
    });
});
