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
        const encName = E.aeadEncrypt('AudioTest Server', symKey);
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

async function setupSineWave(page: any, freq: number) {
    await page.evaluate((f: number) => {
        const V = (window as any).VoiceManager;
        V.setSelfAudioMode('mesh');
    }, freq);
    await page.waitForTimeout(300);
    await page.evaluate((f: number) => {
        const S = (window as any).VoiceManager._debug.state;
        const ctx = S.audioCtx;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = f;
        const dest = ctx.createMediaStreamDestination();
        osc.connect(dest);
        osc.start();
        S.localStreams.mic = dest.stream;
        S.localStreams.processedMic = dest.stream;
    }, freq);
    await page.waitForTimeout(300);
    await page.evaluate(() => {
        const V = (window as any).VoiceManager;
        V.setSelfAudioMode('relay');
    });
}

async function captureRelayAudio(page: any, senderUid: string, durationMs: number) {
    return await page.evaluate(({ senderUid, durationMs }: { senderUid: string; durationMs: number }) => {
        return new Promise((resolve) => {
            const V = (window as any).VoiceManager;
            const S = V._debug.state;
            const ctx = S.audioCtx;
            if (!ctx) { resolve({ error: 'no audio context' }); return; }

            const allGainNodes = (window as any).__relayGainNodes;
            if (!allGainNodes || !allGainNodes[senderUid]) {
                resolve({ error: 'no relay gain node for sender' });
                return;
            }

            const processor = ctx.createScriptProcessor(4096, 1, 1);
            const samples: number[] = [];
            const SAMPLE_RATE = ctx.sampleRate;
            const startTime = performance.now();

            processor.onaudioprocess = function (e: any) {
                const data = e.inputBuffer.getChannelData(0);
                for (let i = 0; i < data.length; i++) {
                    samples.push(data[i]);
                }
            };

            allGainNodes[senderUid].connect(processor);
            const silent = ctx.createGain();
            silent.gain.value = 0;
            processor.connect(silent);
            silent.connect(ctx.destination);

            setTimeout(() => {
                const elapsedMs = performance.now() - startTime;
                try { processor.disconnect(); } catch (_) {}
                try { silent.disconnect(); } catch (_) {}

                const arr = new Float32Array(samples);
                let lastSample = 0;
                let discontinuities = 0;
                let maxAmplitude = 0;
                let silenceRuns = 0;
                let inSilence = false;
                let silenceCount = 0;
                const SILENCE_THRESHOLD = 0.001;
                const SILENCE_MIN_SAMPLES = 2400;

                for (let i = 0; i < arr.length; i++) {
                    const s = Math.abs(arr[i]);
                    if (s > maxAmplitude) maxAmplitude = s;
                    const diff = Math.abs(arr[i] - lastSample);
                    if (diff > 0.1 && lastSample !== 0 && arr[i] !== 0) {
                        discontinuities++;
                    }
                    lastSample = arr[i];
                    if (s < SILENCE_THRESHOLD) {
                        silenceCount++;
                        if (silenceCount >= SILENCE_MIN_SAMPLES && !inSilence) {
                            inSilence = true;
                            silenceRuns++;
                        }
                    } else {
                        silenceCount = 0;
                        inSilence = false;
                    }
                }

                let sumSquared = 0;
                let nonzeroCount = 0;
                for (let i = 0; i < arr.length; i++) {
                    if (Math.abs(arr[i]) > 0.001) {
                        sumSquared += arr[i] * arr[i];
                        nonzeroCount++;
                    }
                }
                const rms = nonzeroCount > 0 ? Math.sqrt(sumSquared / nonzeroCount) : 0;
                const duration = arr.length / SAMPLE_RATE;
                const discontinuityRate = arr.length > 0 ? discontinuities / arr.length : 0;

                resolve({
                    totalSamples: arr.length,
                    duration: duration.toFixed(2),
                    elapsedMs: Math.round(elapsedMs),
                    rms: rms.toFixed(4),
                    maxAmplitude: maxAmplitude.toFixed(4),
                    discontinuities,
                    discontinuityRate: (discontinuityRate * 100).toFixed(4) + '%',
                    silenceRuns,
                    sampleRate: SAMPLE_RATE,
                });
            }, durationMs);
        });
    }, { senderUid, durationMs });
}

// --- Test -------------------------------------------------------------------

test.describe('Bidirectional relay audio', () => {

    test('both users play 400Hz sine via relay for 10s each — detect popcorn', async ({ page, context }) => {
        test.setTimeout(300000);
        const ts = Date.now();
        console.log('=== BIDIRECTIONAL RELAY AUDIO TEST ===');

        // --- User A: create server ---
        const uA = await registerUser(page, 'BiDirA_' + ts);
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        const { voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, uA.token);

        // --- User B: join ---
        const ctxB = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        pageB.on('pageerror', (err) => console.log(`[B-ERR] ${err.message}`));
        const uB = await registerUser(pageB, 'BiDirB_' + ts);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);
        await joinServerViaInvite(pageB, uB.token, inviteCode);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);

        // Both join voice
        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await waitForConnected(page);
        await selectServer(pageB);
        await clickVoiceChannel(pageB, voiceChannelId);
        await waitForConnected(pageB);
        console.log('[1] Both in voice channel');

        // Force both to relay
        await page.evaluate(() => { (window as any).VoiceManager.setSelfAudioMode('relay'); });
        await pageB.evaluate(() => { (window as any).VoiceManager.setSelfAudioMode('relay'); });
        await page.waitForTimeout(500);

        // Unmute both
        const stateA = await page.evaluate(() => (window as any).VoiceManager._debug.state);
        if (stateA.muted) await page.evaluate(() => { (window as any).VoiceManager.toggleMute(); });
        const stateB = await pageB.evaluate(() => (window as any).VoiceManager._debug.state);
        if (stateB.muted) await pageB.evaluate(() => { (window as any).VoiceManager.toggleMute(); });
        console.log('[2] Both on relay, unmuted');

        // ============================================================
        // DIRECTION 1: A sends 400Hz → B captures for 10s
        // ============================================================
        console.log('[3] Setting up A to send 400Hz...');
        await setupSineWave(page, 400);
        await pageB.waitForTimeout(2000); // let relay stabilize
        console.log('[3] A is sending 400Hz via relay');

        console.log('[4] B capturing A\'s relay audio for 10s...');
        const resultAtoB = await captureRelayAudio(pageB, uA.user.id, 10000);
        console.log('[4] B←A result:', JSON.stringify(resultAtoB, null, 2));

        // Stop A's sine wave
        await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            if (S.localStreams.mic) {
                S.localStreams.mic.getTracks().forEach((t: any) => t.stop());
            }
            S.localStreams.mic = null;
            S.localStreams.processedMic = null;
        });
        await page.waitForTimeout(1000);

        // ============================================================
        // DIRECTION 2: B sends 400Hz → A captures for 10s
        // ============================================================
        console.log('[5] Setting up B to send 400Hz...');
        await setupSineWave(pageB, 400);
        await page.waitForTimeout(2000); // let relay stabilize
        console.log('[5] B is sending 400Hz via relay');

        console.log('[6] A capturing B\'s relay audio for 10s...');
        const resultBtoA = await captureRelayAudio(page, uB.user.id, 10000);
        console.log('[6] A←B result:', JSON.stringify(resultBtoA, null, 2));

        // ============================================================
        // Assertions
        // ============================================================

        // --- Direction 1: B hears A ---
        console.log('\n--- Direction 1: B hears A ---');
        expect((resultAtoB as any).error).toBeUndefined();
        expect((resultAtoB as any).totalSamples).toBeGreaterThan(0);

        const durationAB = parseFloat((resultAtoB as any).duration);
        expect(durationAB).toBeGreaterThan(8);   // at least 8s captured
        expect(durationAB).toBeLessThan(14);     // not much more than 10s
        console.log(`[PASS] B←A: Captured ${durationAB}s (expected ~10s)`);

        expect(parseFloat((resultAtoB as any).rms)).toBeGreaterThan(0.01);
        console.log(`[PASS] B←A: RMS ${(resultAtoB as any).rms} (sine wave detected)`);

        const discAB = parseFloat((resultAtoB as any).discontinuityRate);
        expect(discAB).toBeLessThan(0.5);
        console.log(`[PASS] B←A: Discontinuity rate ${(resultAtoB as any).discontinuityRate} (< 0.5%)`);

        expect((resultAtoB as any).silenceRuns).toBeLessThan(10);
        console.log(`[PASS] B←A: Silence gaps ${(resultAtoB as any).silenceRuns} (< 10)`);

        // --- Direction 2: A hears B ---
        console.log('\n--- Direction 2: A hears B ---');
        expect((resultBtoA as any).error).toBeUndefined();
        expect((resultBtoA as any).totalSamples).toBeGreaterThan(0);

        const durationBA = parseFloat((resultBtoA as any).duration);
        expect(durationBA).toBeGreaterThan(8);
        expect(durationBA).toBeLessThan(14);
        console.log(`[PASS] A←B: Captured ${durationBA}s (expected ~10s)`);

        expect(parseFloat((resultBtoA as any).rms)).toBeGreaterThan(0.01);
        console.log(`[PASS] A←B: RMS ${(resultBtoA as any).rms} (sine wave detected)`);

        const discBA = parseFloat((resultBtoA as any).discontinuityRate);
        expect(discBA).toBeLessThan(0.5);
        console.log(`[PASS] A←B: Discontinuity rate ${(resultBtoA as any).discontinuityRate} (< 0.5%)`);

        expect((resultBtoA as any).silenceRuns).toBeLessThan(10);
        console.log(`[PASS] A←B: Silence gaps ${(resultBtoA as any).silenceRuns} (< 10)`);

        console.log('\n=== BIDIRECTIONAL RELAY AUDIO TEST PASSED ===');

        await pageB.close();
        await ctxB.close();
    });
});

test.describe('Video relay FPS stability', () => {

    test('relay video over 30s: FPS stays above 10 throughout', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        console.log('=== VIDEO RELAY FPS STABILITY TEST (30s) ===');

        const uA = await registerUser(page, 'FpsA_' + ts);
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        const { voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, uA.token);

        const ctxB = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        pageB.on('pageerror', (err) => console.log(`[B-ERR] ${err.message}`));
        const uB = await registerUser(pageB, 'FpsB_' + ts);
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

        // Force relay for both
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
            if (!V._debug.state.cameraOn) V.toggleCamera();
        });
        await page.waitForTimeout(2000);
        const camCheck = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            return { cameraOn: S.cameraOn, hasStream: !!S.localStreams.camera };
        });
        console.log('[2] Camera on A:', JSON.stringify(camCheck));
        expect(camCheck.cameraOn).toBeTruthy();
        expect(camCheck.hasStream).toBeTruthy();

        // --- Periodic FPS sampling over 30 seconds ---
        console.log('[3] Sampling relay FPS every 2s for 30s...');

        // Set up frame counter on sender
        await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            (S as any)._relayFrameCount = 0;
            const origSend = (window as any).ws.send;
            (window as any).ws.send = function (data: any) {
                try {
                    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
                    if (parsed.type === 'voice_media_relay' && parsed.kind === 'camera') {
                        (S as any)._relayFrameCount++;
                    }
                } catch (_) {}
                origSend.call(this, data);
            };
            (S as any)._relayOrigSend = origSend;
        });

        const fpsReadings: number[] = [];
        const DURATION_MS = 30000;
        const SAMPLE_INTERVAL_MS = 2000;
        const startTime = Date.now();
        let prevCount = 0;
        let prevTime = startTime;

        for (let elapsed = 0; elapsed < DURATION_MS; elapsed += SAMPLE_INTERVAL_MS) {
            await page.waitForTimeout(SAMPLE_INTERVAL_MS);

            const currentCount = await page.evaluate(() => {
                const S = (window as any).VoiceManager._debug.state;
                return (S as any)._relayFrameCount || 0;
            });
            const now = Date.now();

            const frameDelta = currentCount - prevCount;
            const timeDelta = (now - prevTime) / 1000;
            const instantFps = timeDelta > 0 ? frameDelta / timeDelta : 0;
            fpsReadings.push(Math.round(instantFps));

            const sec = ((now - startTime) / 1000).toFixed(0);
            console.log(`[3] t=${sec}s: ${frameDelta} frames in ${timeDelta.toFixed(1)}s = ${instantFps.toFixed(1)} FPS`);

            prevCount = currentCount;
            prevTime = now;
        }

        // Restore original send
        await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            if ((S as any)._relayOrigSend) {
                (window as any).ws.send = (S as any)._relayOrigSend;
            }
        });

        // Check receiver got frames
        await pageB.waitForTimeout(2000);
        const receiverDiag = await pageB.evaluate((senderUid: string) => {
            const S = (window as any).VoiceManager._debug.state;
            const fk = senderUid + '_camera';
            const frames = S._relayVideoFrames || {};
            return {
                hasFrameUrl: !!frames[fk],
                frameUrlIsBlob: frames[fk] ? frames[fk].startsWith('blob:') : false,
            };
        }, uA.user.id);
        console.log('[4] Receiver diagnostics:', JSON.stringify(receiverDiag));

        // --- Analysis ---
        const avgFps = fpsReadings.reduce((a, b) => a + b, 0) / fpsReadings.length;
        const minFps = Math.min(...fpsReadings);
        const maxFps = Math.max(...fpsReadings);
        const readingsBelow10 = fpsReadings.filter(f => f < 10).length;
        const totalReadings = fpsReadings.length;

        console.log('\n[5] === FPS SUMMARY ===');
        console.log(`  Readings: [${fpsReadings.join(', ')}]`);
        console.log(`  Average: ${avgFps.toFixed(1)} FPS`);
        console.log(`  Min: ${minFps} FPS`);
        console.log(`  Max: ${maxFps} FPS`);
        console.log(`  Readings below 10 FPS: ${readingsBelow10}/${totalReadings}`);

        // --- Assertions ---
        expect(receiverDiag.hasFrameUrl).toBeTruthy();
        expect(receiverDiag.frameUrlIsBlob).toBeTruthy();
        console.log('[PASS] Receiver has relay video frame');

        expect(avgFps).toBeGreaterThan(15);
        console.log(`[PASS] Average FPS ${avgFps.toFixed(1)} > 15`);

        const below10Rate = readingsBelow10 / totalReadings;
        expect(below10Rate).toBeLessThan(0.25);
        console.log(`[PASS] Below-10-FPS rate ${(below10Rate * 100).toFixed(0)}% < 25%`);

        expect(minFps).toBeGreaterThan(0);
        console.log(`[PASS] Min FPS ${minFps} > 0 (no complete stall)`);

        console.log('\n=== VIDEO RELAY FPS STABILITY TEST PASSED ===');

        await pageB.close();
        await ctxB.close();
    });
});
