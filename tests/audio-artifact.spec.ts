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
    // Check if already logged in
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
        const encName = E2ECrypto.aeadEncrypt('AudioTest Server', symKey);
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

// --- Test -------------------------------------------------------------------

test.describe('Audio relay quality (visible browsers)', () => {

    test('sine wave through relay: detect clicks/gaps/discontinuities', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();

        console.log('=== AUDIO ARTIFACT TEST ===');

        // --- User A: create server ---
        const uA = await registerUser(page, 'ArtA_' + ts);
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        const { voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, uA.token);

        // --- User B: join (same pattern as relay-debug which works) ---
        const ctxB = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        pageB.on('pageerror', (err) => console.log(`[B-ERR] ${err.message}`));
        const uB = await registerUser(pageB, 'ArtB_' + ts);
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

        // Force both to relay mode
        await page.evaluate(() => { (window as any).VoiceManager.setSelfAudioMode('relay'); });
        await pageB.evaluate(() => { (window as any).VoiceManager.setSelfAudioMode('relay'); });
        await page.waitForTimeout(1000);

        // Unmute both
        const stateA = await page.evaluate(() => (window as any).VoiceManager._debug.state);
        if (stateA.muted) await page.evaluate(() => { (window as any).VoiceManager.toggleMute(); });
        const stateB = await pageB.evaluate(() => (window as any).VoiceManager._debug.state);
        if (stateB.muted) await pageB.evaluate(() => { (window as any).VoiceManager.toggleMute(); });
        console.log('[2] Both on relay, unmuted');

        // --- SENDER (User A): Replace mic with a 440Hz sine wave ---
        console.log('[3] Sender: generating 440Hz sine wave...');
        // Stop relay, replace stream, restart relay
        await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            V.setSelfAudioMode('mesh');
        });
        await page.waitForTimeout(500);

        // Replace mic stream with sine wave and verify it has audio
        const sineCheck = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            const ctx = S.audioCtx;
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = 440;
            const dest = ctx.createMediaStreamDestination();
            osc.connect(dest);
            osc.start();
            S.localStreams.mic = dest.stream;
            S.localStreams.processedMic = dest.stream;
            // Verify the stream has an active audio track
            const tracks = dest.stream.getAudioTracks();
            return {
                trackCount: tracks.length,
                trackKind: tracks.map((t: any) => t.kind),
                trackEnabled: tracks.map((t: any) => t.enabled),
                trackReadyState: tracks.map((t: any) => t.readyState),
            };
        });
        console.log('[3] Sine stream check:', JSON.stringify(sineCheck));

        // Restart relay
        await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            V.setSelfAudioMode('relay');
        });
        await page.waitForTimeout(1000);

        // Verify relay is actually sending by checking a counter
        const sendCheck = await page.evaluate(() => {
            return new Promise((resolve) => {
                let sent = 0;
                const origSend = (window as any).ws.send;
                (window as any).ws.send = function(data: any) {
                    try {
                        const parsed = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data);
                        if (parsed.type === 'voice_media_relay' && parsed.kind === 'audio') sent++;
                    } catch(_) {}
                    origSend.call(this, data);
                };
                setTimeout(() => {
                    (window as any).ws.send = origSend;
                    resolve({ audioFramesSent: sent });
                }, 3000);
            });
        });
        console.log('[3] Send check:', JSON.stringify(sendCheck));
        console.log('[3] Sine wave streaming via relay');

        // --- RECEIVER (User B): Capture output and analyze for artifacts ---
        console.log('[4] Receiver: capturing audio output for 5 seconds...');

        // Diagnose sender first
        const senderDiag = await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            const S = V._debug.state;
            return {
                audioMode: S._lastAudioMode,
                muted: S.muted,
                hasMic: !!S.localStreams.mic,
                micTracks: S.localStreams.mic ? S.localStreams.mic.getTracks().length : 0,
                hasProcessedMic: !!S.localStreams.processedMic,
                audioRelayTimer: true,
                relayTimers: Object.keys(S._relayTimers || {}),
            };
        });
        console.log('[4] Sender diagnostics:', JSON.stringify(senderDiag));

        // Diagnose receiver
        const diag = await pageB.evaluate(() => {
            return new Promise((resolve) => {
                const V = (window as any).VoiceManager;
                const S = V._debug.state;
                let framesReceived = 0;
                const origHandle = (window as any)._origHandleRelayedAudio || null;

                // Count relay audio frames for 2 seconds
                const origFn = V._debug.state._handleRelayedAudioFrame;
                // Monkey-patch to count frames
                const checkInterval = setInterval(() => {
                    // Check if relay audio queue has data
                    const queues = (V._debug.state._relayAudioQueues) || {};
                    let queued = 0;
                    for (const uid in queues) {
                        queued += (queues[uid].queue || []).length;
                    }
                    framesReceived = queued;
                }, 200);

                setTimeout(() => {
                    clearInterval(checkInterval);
                    const queues = (V._debug.state._relayAudioQueues) || {};
                    let totalQueued = 0;
                    for (const uid in queues) {
                        totalQueued += (queues[uid].queue || []).length;
                    }
                    resolve({
                        audioMode: S._lastAudioMode,
                        hasAudioCtx: !!S.audioCtx,
                        audioCtxState: S.audioCtx ? S.audioCtx.state : null,
                        relayQueues: Object.keys(queues).length,
                        queuedFrames: totalQueued,
                    });
                }, 2000);
            });
        });
        console.log('[4] Receiver diagnostics:', JSON.stringify(diag));

        const analysisResult = await pageB.evaluate((senderUid: string) => {
            return new Promise((resolve) => {
                const V = (window as any).VoiceManager;
                const S = V._debug.state;
                const ctx = S.audioCtx;
                if (!ctx) { resolve({ error: 'no audio context' }); return; }

                const processor = ctx.createScriptProcessor(4096, 1, 1);
                const samples = [];
                const SAMPLE_RATE = ctx.sampleRate;
                let frameCount = 0;
                let lastSample = 0;
                let discontinuities = 0;
                let maxAmplitude = 0;
                let silenceRuns = 0;
                let inSilence = false;
                let silenceCount = 0;
                const SILENCE_THRESHOLD = 0.001;
                const SILENCE_MIN_SAMPLES = 2400; // 50ms at 48kHz

                processor.onaudioprocess = function (e) {
                    const data = e.inputBuffer.getChannelData(0);
                    for (let i = 0; i < data.length; i++) {
                        const s = Math.abs(data[i]);
                        if (s > maxAmplitude) maxAmplitude = s;
                        const diff = Math.abs(data[i] - lastSample);
                        if (diff > 0.1 && lastSample !== 0 && data[i] !== 0) {
                            discontinuities++;
                        }
                        lastSample = data[i];
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
                        samples.push(data[i]);
                    }
                    frameCount++;
                };

                // Access the relay gain node for the sender and tap its output
                // gain → processor (gain's output goes INTO processor's input)
                const allGainNodes = (window as any).__relayGainNodes;
                let connected = false;
                if (allGainNodes && allGainNodes[senderUid]) {
                    allGainNodes[senderUid].connect(processor);
                    connected = true;
                }
                // Connect processor output to a silent gain to avoid echo
                const silent = ctx.createGain();
                silent.gain.value = 0;
                processor.connect(silent);
                silent.connect(ctx.destination);

                setTimeout(() => {
                    try { processor.disconnect(); } catch(_) {}
                    try { silent.disconnect(); } catch(_) {}
                    const totalSamples = samples.length;
                    const duration = totalSamples / SAMPLE_RATE;
                    let sumSquared = 0;
                    let nonzeroCount = 0;
                    for (let i = 0; i < samples.length; i++) {
                        if (Math.abs(samples[i]) > 0.001) {
                            sumSquared += samples[i] * samples[i];
                            nonzeroCount++;
                        }
                    }
                    const rms = nonzeroCount > 0 ? Math.sqrt(sumSquared / nonzeroCount) : 0;
                    const discontinuityRate = totalSamples > 0 ? discontinuities / totalSamples : 0;
                    resolve({
                        totalSamples,
                        duration: duration.toFixed(2),
                        rms: rms.toFixed(4),
                        maxAmplitude: maxAmplitude.toFixed(4),
                        discontinuities,
                        discontinuityRate: (discontinuityRate * 100).toFixed(4) + '%',
                        silenceRuns,
                        frameCount,
                        sampleRate: SAMPLE_RATE,
                        connected,
                    });
                }, 5000);
            });
        }, uA.user.id);

        console.log('[5] Analysis result:', JSON.stringify(analysisResult, null, 2));

        // --- Assertions ---
        expect(analysisResult.error).toBeUndefined();
        expect(analysisResult.totalSamples).toBeGreaterThan(0);
        console.log(`[PASS] Captured ${(analysisResult as any).duration}s of audio (${(analysisResult as any).totalSamples} samples)`);

        // RMS should be > 0 (sine wave has energy)
        expect(parseFloat((analysisResult as any).rms)).toBeGreaterThan(0.01);
        console.log(`[PASS] RMS amplitude: ${(analysisResult as any).rms} (sine wave detected)`);

        // Discontinuity rate should be very low (<0.5%)
        const discRate = parseFloat((analysisResult as any).discontinuityRate);
        expect(discRate).toBeLessThan(0.5);
        console.log(`[PASS] Discontinuity rate: ${(analysisResult as any).discontinuityRate} (< 0.5%)`);

        // Silence runs should be minimal (<10 for 5 seconds of continuous sine)
        expect((analysisResult as any).silenceRuns).toBeLessThan(10);
        console.log(`[PASS] Silence gaps: ${(analysisResult as any).silenceRuns} (< 10)`);

        console.log('\n=== AUDIO ARTIFACT TEST PASSED ===');
        console.log('The sine wave survived the relay pipeline with minimal artifacts');
        console.log('If you hear clean audio in the browser windows, relay is working correctly');

        await pageB.close();
        await ctxB.close();
    });

    test('sine wave through mesh: detect clicks/gaps/discontinuities', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();

        console.log('=== MESH AUDIO ARTIFACT TEST ===');

        const uA = await registerUser(page, 'MeshA_' + ts);
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        const { voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, uA.token);

        const ctxB = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        pageB.on('pageerror', (err) => console.log(`[B-ERR] ${err.message}`));
        const uB = await registerUser(pageB, 'MeshB_' + ts);
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

        await page.evaluate(() => { (window as any).VoiceManager.setSelfAudioMode('mesh'); });
        await pageB.evaluate(() => { (window as any).VoiceManager.setSelfAudioMode('mesh'); });
        await page.waitForTimeout(1000);

        const stateA = await page.evaluate(() => (window as any).VoiceManager._debug.state);
        if (stateA.muted) await page.evaluate(() => { (window as any).VoiceManager.toggleMute(); });
        const stateB = await pageB.evaluate(() => (window as any).VoiceManager._debug.state);
        if (stateB.muted) await pageB.evaluate(() => { (window as any).VoiceManager.toggleMute(); });
        console.log('[2] Both on mesh, unmuted');

        console.log('[3] Sender: generating 440Hz sine wave...');
        await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            const ctx = S.audioCtx;
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = 440;
            const dest = ctx.createMediaStreamDestination();
            osc.connect(dest);
            osc.start();
            S.localStreams.mic = dest.stream;
            S.localStreams.processedMic = dest.stream;
        });
        await page.waitForTimeout(500);

        // Force WebRTC to re-send with the new track
        await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            V.setSelfAudioMode('relay');
        });
        await page.waitForTimeout(500);
        await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            V.setSelfAudioMode('mesh');
        });
        await page.waitForTimeout(3000);
        console.log('[3] Sine wave streaming via mesh');

        // Check if B has remote audio elements for A
        const meshDiag = await pageB.evaluate((senderUid: string) => {
            const V = (window as any).VoiceManager;
            const S = V._debug.state;
            const els = S.remoteAudioEls[senderUid] || [];
            return {
                audioMode: S._lastAudioMode,
                remoteAudioElCount: els.length,
                hasSrcObject: els.map((el: any) => !!el.srcObject),
                paused: els.map((el: any) => el.paused),
                hasRemoteStream: !!(S.remoteStreams[senderUid] && S.remoteStreams[senderUid].audio),
            };
        }, uA.user.id);
        console.log('[4] Receiver mesh diagnostics:', JSON.stringify(meshDiag));

        // Capture audio from the <audio> element via captureStream + MediaStreamSource
        const analysisResult = await pageB.evaluate((senderUid: string) => {
            return new Promise((resolve) => {
                const V = (window as any).VoiceManager;
                const S = V._debug.state;
                const ctx = S.audioCtx;
                if (!ctx) { resolve({ error: 'no audio context' }); return; }

                const els = S.remoteAudioEls[senderUid] || [];
                if (!els.length) { resolve({ error: 'no remote audio elements' }); return; }

                const audioEl = els[0];
                if (!audioEl.srcObject) { resolve({ error: 'no srcObject on audio element' }); return; }

                const stream = audioEl.srcObject;
                const audioTracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
                if (!audioTracks.length) { resolve({ error: 'no audio tracks in stream' }); return; }

                const source = ctx.createMediaStreamSource(new MediaStream(audioTracks));
                const processor = ctx.createScriptProcessor(4096, 1, 1);
                const samples = [];
                const SAMPLE_RATE = ctx.sampleRate;
                let frameCount = 0;
                let lastSample = 0;
                let discontinuities = 0;
                let maxAmplitude = 0;
                let silenceRuns = 0;
                let inSilence = false;
                let silenceCount = 0;
                const SILENCE_THRESHOLD = 0.001;
                const SILENCE_MIN_SAMPLES = 2400;

                processor.onaudioprocess = function (e) {
                    const data = e.inputBuffer.getChannelData(0);
                    for (let i = 0; i < data.length; i++) {
                        const s = Math.abs(data[i]);
                        if (s > maxAmplitude) maxAmplitude = s;
                        const diff = Math.abs(data[i] - lastSample);
                        if (diff > 0.1 && lastSample !== 0 && data[i] !== 0) {
                            discontinuities++;
                        }
                        lastSample = data[i];
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
                        samples.push(data[i]);
                    }
                    frameCount++;
                };

                source.connect(processor);
                const silent = ctx.createGain();
                silent.gain.value = 0;
                processor.connect(silent);
                silent.connect(ctx.destination);

                setTimeout(() => {
                    try { processor.disconnect(); } catch(_) {}
                    try { source.disconnect(); } catch(_) {}
                    try { silent.disconnect(); } catch(_) {}
                    const totalSamples = samples.length;
                    const duration = totalSamples / SAMPLE_RATE;
                    let sumSquared = 0;
                    let nonzeroCount = 0;
                    for (let i = 0; i < samples.length; i++) {
                        if (Math.abs(samples[i]) > 0.001) {
                            sumSquared += samples[i] * samples[i];
                            nonzeroCount++;
                        }
                    }
                    const rms = nonzeroCount > 0 ? Math.sqrt(sumSquared / nonzeroCount) : 0;
                    const discontinuityRate = totalSamples > 0 ? discontinuities / totalSamples : 0;
                    resolve({
                        totalSamples,
                        duration: duration.toFixed(2),
                        rms: rms.toFixed(4),
                        maxAmplitude: maxAmplitude.toFixed(4),
                        discontinuities,
                        discontinuityRate: (discontinuityRate * 100).toFixed(4) + '%',
                        silenceRuns,
                        frameCount,
                        sampleRate: SAMPLE_RATE,
                    });
                }, 5000);
            });
        }, uA.user.id);

        console.log('[5] Analysis result:', JSON.stringify(analysisResult, null, 2));

        expect(analysisResult.error).toBeUndefined();
        expect(analysisResult.totalSamples).toBeGreaterThan(0);
        console.log(`[PASS] Captured ${(analysisResult as any).duration}s of mesh audio (${(analysisResult as any).totalSamples} samples)`);

        expect(parseFloat((analysisResult as any).rms)).toBeGreaterThan(0.01);
        console.log(`[PASS] RMS amplitude: ${(analysisResult as any).rms} (sine wave detected via mesh)`);

        const discRate = parseFloat((analysisResult as any).discontinuityRate);
        expect(discRate).toBeLessThan(0.5);
        console.log(`[PASS] Discontinuity rate: ${(analysisResult as any).discontinuityRate} (< 0.5%)`);

        expect((analysisResult as any).silenceRuns).toBeLessThan(10);
        console.log(`[PASS] Silence gaps: ${(analysisResult as any).silenceRuns} (< 10)`);

        console.log('\n=== MESH AUDIO ARTIFACT TEST PASSED ===');

        await pageB.close();
        await ctxB.close();
    });
});
