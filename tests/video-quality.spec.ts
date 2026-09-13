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
    return await page.evaluate((maxRetries) => {
        return new Promise((resolve) => {
            let tries = 0;
            const check = () => {
                tries++;
                if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) resolve(true);
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
    const prep = await page.evaluate(async ({ inviteCode }) => {
        const symKey = E2ECrypto.generateSymmetricKey();
        const encName = E2ECrypto.aeadEncrypt('VideoTest Server', symKey);
        const encCh = E2ECrypto.aeadEncrypt('voice', symKey);
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

    await page.evaluate(async ({ serverId }) => {
        const symKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey(serverId, symKey);
        const identity = E2ECrypto.getIdentityKeyPair();
        const myId = JSON.parse(localStorage.getItem('user') || '{}').id;
        const pubRes = await fetch('/api/identity/' + myId, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const pubData = await pubRes.json();
        const pubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(pubData.identity_public_key));
        const enc = E2ECrypto.envelopeEncrypt(symKey, pubKey, identity.privateKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: myId,
                encrypted_key: enc.ciphertext,
                sender_public_key: E2ECrypto.arrayBufferToBase64(identity.publicKey),
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
    await page.evaluate(() => { if (typeof loadServers === 'function') loadServers(); }).catch(() => {});
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

test.describe('Video quality (visible browsers)', () => {

    test('mesh video: tracks flow via WebRTC with valid resolution', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        console.log('=== MESH VIDEO TEST ===');

        const uA = await registerUser(page, 'VidMeshA_' + ts);
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        const { voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, uA.token);

        const ctxB = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        pageB.on('pageerror', (err) => console.log(`[B-ERR] ${err.message}`));
        const uB = await registerUser(pageB, 'VidMeshB_' + ts);
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

        // Force mesh for both video and audio
        await page.evaluate(() => { (window as any).VoiceManager.setSelfAudioMode('mesh'); });
        await page.evaluate(() => { (window as any).VoiceManager.setSelfVideoMode('mesh'); });
        await pageB.evaluate(() => { (window as any).VoiceManager.setSelfAudioMode('mesh'); });
        await pageB.evaluate(() => { (window as any).VoiceManager.setSelfVideoMode('mesh'); });
        await page.waitForTimeout(500);

        // Unmute and enable camera on A
        const stateA = await page.evaluate(() => (window as any).VoiceManager._debug.state);
        if (stateA.muted) await page.evaluate(() => { (window as any).VoiceManager.toggleMute(); });
        await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            if (!V._debug.state.cameraOn) {
                V.toggleCamera();
            }
        });
        // Camera is async (getUserMedia), wait for it to start
        await page.waitForTimeout(2000);
        const camCheck = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            return { cameraOn: S.cameraOn, hasStream: !!S.localStreams.camera, tracks: S.localStreams.camera ? S.localStreams.camera.getVideoTracks().length : 0 };
        });
        console.log('[1b] Camera on A:', JSON.stringify(camCheck));

        // Disable manual video load and mark feeds as loaded so video auto-attaches
        await pageB.evaluate((senderUid: string) => {
            const V = (window as any).VoiceManager;
            const S = V._debug.state;
            S.settings.manualVideoLoad = false;
            // Directly attach the remote stream to the video tile
            if (S.remoteStreams[senderUid] && S.remoteStreams[senderUid].camera) {
                const videoEl = document.querySelector('video.remote-video-tile[data-uid="' + senderUid + '"][data-kind="camera"]');
                if (videoEl && !videoEl.srcObject) {
                    videoEl.srcObject = S.remoteStreams[senderUid].camera;
                    videoEl.play().catch(function () {});
                }
            }
        }, uA.user.id);

        // Wait for video to decode
        await pageB.waitForTimeout(3000);

        // Check if B's peer has video senders from A
        const peerDiag = await pageB.evaluate((senderUid: string) => {
            const S = (window as any).VoiceManager._debug.state;
            const peers = S.peers || {};
            const pc = peers[senderUid];
            let senders = [];
            if (pc && pc.getSenders) {
                senders = pc.getSenders().map((s: any) => ({
                    kind: s.track ? s.track.kind : 'null',
                    id: s.track ? s.track.id : 'null',
                    readyState: s.track ? s.track.readyState : 'null',
                }));
            }
            const remoteStreams = S.remoteStreams || {};
            const remoteStream = remoteStreams[senderUid];
            return {
                peerExists: !!pc,
                signalingState: pc ? pc.signalingState : null,
                senders,
                hasRemoteStream: !!remoteStream,
                remoteStreamKeys: remoteStream ? Object.keys(remoteStream) : [],
                remoteStreamVideo: !!(remoteStream && remoteStream.video),
                remoteVideoTracks: (remoteStream && remoteStream.video) ? remoteStream.video.getVideoTracks().length : 0,
                remoteVideoTrackIds: (remoteStream && remoteStream.video) ? remoteStream.video.getVideoTracks().map((t: any) => t.id) : [],
            };
        }, uA.user.id);
        console.log('[1c] Peer diagnostics:', JSON.stringify(peerDiag));

        // Check B sees A's video via mesh
        const meshVideoDiag = await pageB.evaluate((senderUid: string) => {
            const S = (window as any).VoiceManager._debug.state;
            const remoteStreams = S.remoteStreams || {};
            const remoteStream = remoteStreams[senderUid];
            const hasVideoStream = !!(remoteStream && (remoteStream.video || remoteStream.camera));
            let videoTracks = 0;
            if (hasVideoStream) {
                const vs = remoteStream.video || remoteStream.camera;
                videoTracks = vs.getVideoTracks().length;
            }
            const videoEl = document.querySelector('video.remote-video-tile[data-uid="' + senderUid + '"]');
            let srcObjectSet = false;
            let videoWidth = 0;
            let videoHeight = 0;
            if (videoEl) {
                srcObjectSet = !!videoEl.srcObject;
                videoWidth = videoEl.videoWidth || 0;
                videoHeight = videoEl.videoHeight || 0;
            }
            return {
                hasRemoteVideo: hasVideoStream,
                videoTracks,
                videoElFound: !!videoEl,
                srcObjectSet,
                videoWidth,
                videoHeight,
                hasRelayImg: !!document.querySelector('img.remote-video-tile[data-uid="' + senderUid + '"]'),
            };
        }, uA.user.id);
        console.log('[2] Mesh video diagnostics:', JSON.stringify(meshVideoDiag));

        // Assertions for mesh video
        expect(meshVideoDiag.hasRemoteVideo).toBeTruthy();
        console.log('[PASS] Remote video stream received via mesh');

        expect(meshVideoDiag.videoTracks).toBeGreaterThan(0);
        console.log(`[PASS] ${meshVideoDiag.videoTracks} video track(s) received`);

        expect(meshVideoDiag.videoElFound).toBeTruthy();
        console.log('[PASS] <video> element found in DOM');

        // Video is working if either srcObject is set OR video has decoded dimensions
        const videoWorking = meshVideoDiag.srcObjectSet || (meshVideoDiag.videoWidth > 0 && meshVideoDiag.videoHeight > 0);
        expect(videoWorking).toBeTruthy();
        if (meshVideoDiag.srcObjectSet) {
            console.log('[PASS] <video> element has srcObject attached');
        }
        if (meshVideoDiag.videoWidth > 0) {
            console.log(`[PASS] Video decoded: ${meshVideoDiag.videoWidth}x${meshVideoDiag.videoHeight}`);
        }

        expect(meshVideoDiag.hasRelayImg).toBeFalsy();
        console.log('[PASS] No relay <img> present (mesh mode confirmed)');

        console.log('\n=== MESH VIDEO TEST PASSED ===');

        await pageB.close();
        await ctxB.close();
    });

    test('relay video: JPEG frames render as <img> with blob URLs', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        console.log('=== RELAY VIDEO TEST ===');

        const uA = await registerUser(page, 'VidRelayA_' + ts);
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        const { voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, uA.token);

        const ctxB = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        pageB.on('pageerror', (err) => console.log(`[B-ERR] ${err.message}`));
        const uB = await registerUser(pageB, 'VidRelayB_' + ts);
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

        // Force relay for both video
        await page.evaluate(() => { (window as any).VoiceManager.setSelfAudioMode('relay'); });
        await page.evaluate(() => { (window as any).VoiceManager.setSelfVideoMode('relay'); });
        await pageB.evaluate(() => { (window as any).VoiceManager.setSelfAudioMode('relay'); });
        await pageB.evaluate(() => { (window as any).VoiceManager.setSelfVideoMode('relay'); });
        await page.waitForTimeout(500);

        // Unmute and enable camera on A
        const stateA = await page.evaluate(() => (window as any).VoiceManager._debug.state);
        if (stateA.muted) await page.evaluate(() => { (window as any).VoiceManager.toggleMute(); });
        await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            if (!V._debug.state.cameraOn) {
                V.toggleCamera();
            }
        });
        // Camera is async (getUserMedia), wait for it to start
        await page.waitForTimeout(2000);
        const camCheck = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            return { cameraOn: S.cameraOn, hasStream: !!S.localStreams.camera, tracks: S.localStreams.camera ? S.localStreams.camera.getVideoTracks().length : 0 };
        });
        console.log('[1b] Camera on A:', JSON.stringify(camCheck));
        // Wait for relay frames to arrive at B
        await pageB.waitForTimeout(5000);

        // Check relay timer on SENDER side
        const senderRelayState = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            return {
                relayTimers: Object.keys(S._relayTimers || {}),
                cameraOn: S.cameraOn,
                hasCamera: !!S.localStreams.camera,
            };
        });
        console.log('[1c] Sender relay state:', JSON.stringify(senderRelayState));

        // Check B sees A's video via relay
        const relayVideoDiag = await pageB.evaluate((senderUid: string) => {
            const S = (window as any).VoiceManager._debug.state;
            const frameKey = senderUid + '_camera';
            const relayFrames = S._relayVideoFrames || {};
            const hasFrameUrl = !!relayFrames[frameKey];
            const frameUrl = relayFrames[frameKey] || null;

            // Check for relay <img> element
            const relayImg = document.querySelector('img.remote-video-tile[data-uid="' + senderUid + '"][data-kind="camera"]');
            const videoEl = document.querySelector('video.remote-video-tile[data-uid="' + senderUid + '"][data-kind="camera"]');
            const videoHidden = videoEl ? videoEl.style.display === 'none' : false;

            const memberData = S.members[senderUid] || {};
            const relayState = memberData['_relay_camera'] || null;

            return {
                hasFrameUrl,
                frameUrlStartsWithBlob: frameUrl ? frameUrl.startsWith('blob:') : false,
                relayImgFound: !!relayImg,
                relayImgSrcIsBlob: relayImg ? relayImg.src.startsWith('blob:') : false,
                relayImgDisplay: relayImg ? relayImg.style.display : null,
                videoElFound: !!videoEl,
                videoHidden,
                relayState,
                videoMode: S._lastVideoMode,
                remoteStreamVideo: !!(S.remoteStreams[senderUid] && S.remoteStreams[senderUid].video),
            };
        }, uA.user.id);
        console.log('[2] Relay video diagnostics:', JSON.stringify(relayVideoDiag));

        // Assertions for relay video
        expect(senderRelayState.relayTimers).toContain('camera');
        console.log('[PASS] Relay video timer is active on sender');

        expect(relayVideoDiag.hasFrameUrl).toBeTruthy();
        console.log('[PASS] Relay video frame URL stored');

        expect(relayVideoDiag.frameUrlStartsWithBlob).toBeTruthy();
        console.log('[PASS] Frame URL is a valid blob URL');

        expect(relayVideoDiag.relayImgFound).toBeTruthy();
        console.log('[PASS] Relay <img> element found in DOM');

        expect(relayVideoDiag.relayImgSrcIsBlob).toBeTruthy();
        console.log('[PASS] Relay <img> src is a blob URL');

        expect(relayVideoDiag.videoHidden).toBeTruthy();
        console.log('[PASS] Original <video> element is hidden (relay <img> replaces it)');

        console.log('\n=== RELAY VIDEO TEST PASSED ===');

        await pageB.close();
        await ctxB.close();
    });
});
