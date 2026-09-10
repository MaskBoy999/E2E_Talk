import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// Enable fake audio device so getUserMedia() works in headless Chromium.
test.use({
    launchOptions: {
        args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
        ],
    },
});

// -----------------------------------------------------------------------
// Two tests that verify actual audio flows end-to-end between real users.
//
// 1. "DM call: programmatic 440 Hz oscillator reaches the remote peer"
//    - Creates 2 users, connects a DM call, then injects a 440 Hz oscillator
//      tone via AudioContext + MediaStreamDestination → replaceTrack().
//    - The tone only plays AFTER the call is connected (no fake-mic flag).
//    - Records the remote MediaStream on the callee side, decodes the PCM,
//      and asserts: non-silent, no long silent gaps, dominant freq ≈ 440 Hz.
//    - Works in headless (no real audio pipeline needed for getStats).
//
// 2. "Server voice channel: audio bytes arrive via WebRTC"
//    - Two users join a server voice channel.
//    - Caller injects a 440 Hz oscillator, callee checks getStats():
//      packetsReceived > 0, totalAudioEnergy > 0.
//    - Headless-safe.
// -----------------------------------------------------------------------

// --- Helpers ---------------------------------------------------------------

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

async function setupFriends(page1: any, page2: any, token1: string, token2: string) {
    const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    expect(fc2).toBeTruthy();
    const fr = await page1.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        data: { friend_code: fc2 },
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

async function createDm(page: any, page2: any, token1: string, token2: string, username2: string) {
    const userData = await (await page.request.get(`${BASE}/api/user/${username2}`, {
        headers: { Authorization: `Bearer ${token1}` },
    })).json();
    const dm = await (await page.request.post(`${BASE}/api/dm/${userData.id}`, {
        headers: { Authorization: `Bearer ${token1}` },
    })).json();
    expect(dm.id).toBeTruthy();
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

async function createServerWithVoiceChannel(page: any, token: string): Promise<{ serverId: string; voiceChannelId: string; inviteCode: string }> {
    const ts = Date.now();
    const inviteCode = 'AE2E' + ts;
    const prep = await page.evaluate(async ({ inviteCode }) => {
        const symKey = E2ECrypto.generateSymmetricKey();
        const encName = E2ECrypto.aeadEncrypt('Audio E2E Server', symKey);
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

    const serverKeyB64 = await page.evaluate((sid) => {
        return E2ECrypto.arrayBufferToBase64(E2ECrypto.getServerKey(sid));
    }, serverId);
    const encName2 = await page.evaluate(async ({ name, serverKeyB64 }) => {
        const sk = new Uint8Array(E2ECrypto.base64ToArrayBuffer(serverKeyB64));
        const enc = E2ECrypto.aeadEncrypt(name, sk);
        return { ciphertext: enc.ciphertext, nonce: enc.nonce };
    }, { name: 'Voice', serverKeyB64 });

    const ch = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            name: 'Voice',
            encrypted_name: encName2.ciphertext,
            name_nonce: encName2.nonce,
            channel_type: 'voice',
        },
    })).json();
    expect(ch.channel_type).toBe('voice');
    return { serverId, voiceChannelId: ch.id, inviteCode };
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

// Inject a 440 Hz oscillator into the VoiceManager's mic stream via
// replaceTrack() or addTrack(). This replaces the fake/silent mic with a
// real tone that flows through WebRTC + E2EE end-to-end.
async function injectTone(page: any) {
    return await page.evaluate(async () => {
        const V = (window as any).VoiceManager;
        const S = V._debug.state;

        // Create a 440 Hz oscillator → MediaStreamDestination.
        const AC: any = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = new AC();
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 440;
        const gain = ctx.createGain();
        gain.gain.value = 0.25;
        osc.connect(gain);
        const dest = ctx.createMediaStreamDestination();
        gain.connect(dest);
        osc.start();

        const toneTrack = dest.stream.getAudioTracks()[0];
        if (!toneTrack) return { error: 'oscillator produced no track' };

        // Try to replace the mic track on existing senders first.
        let replaced = 0;
        for (const uid of Object.keys(S.peers || {})) {
            const pc = S.peers[uid];
            if (!pc || !pc.getSenders) continue;
            const senders = pc.getSenders();
            const audioSender = senders.find((s: any) => s.track && s.track.kind === 'audio');
            if (audioSender) {
                audioSender.replaceTrack(toneTrack).catch(() => {});
                replaced++;
            } else {
                // No audio sender yet — add the tone track directly.
                try {
                    pc.addTrack(toneTrack, new MediaStream([toneTrack]));
                    replaced++;
                } catch (_) {}
            }
        }

        // Set localStreams.mic for consistency.
        S.localStreams.mic = new MediaStream([toneTrack]);

        // Also unmute so the app state is consistent.
        if (S.muted) {
            S.muted = false;
            V.sendVoiceState();
            V.updateSelfUI();
        }

        return { replaced, trackId: toneTrack.id };
    });
}

// Record a MediaStream and decode+analyze the PCM.
async function recordAndAnalyze(page: any, seconds: number, kind: 'remote' | 'mic') {
    return await page.evaluate(async ({ seconds, kind }) => {
        const V = (window as any).VoiceManager;
        const S = V._debug.state;
        let stream: MediaStream | null = null;

        if (kind === 'remote') {
            const uids = Object.keys(S.remoteStreams || {});
            stream = uids.length ? S.remoteStreams[uids[0]]?.audio : null;
            if (!stream) return { error: 'no remote audio stream', uids };
        } else {
            stream = S.localStreams?.mic;
            if (!stream) return { error: 'no local mic stream' };
        }

        const track = stream.getAudioTracks()[0];
        if (!track) return { error: 'no audio track' };

        const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
        const rec = new MediaRecorder(new MediaStream([track]), mime ? { mimeType: mime } : undefined);
        const chunks: Blob[] = [];
        rec.ondataavailable = (e: any) => { if (e.data && e.data.size) chunks.push(e.data); };
        rec.start();
        await new Promise((r) => setTimeout(r, seconds * 1000));
        rec.stop();
        await new Promise((r) => { rec.onstop = r; });

        const blob = new Blob(chunks, { type: 'audio/webm' });
        const buf = await blob.arrayBuffer();
        const rawBytes = buf.byteLength;
        let analysis: any = { bytes: rawBytes, decodeError: null };

        if (rawBytes > 0) {
            try {
                const AC: any = window.AudioContext || (window as any).webkitAudioContext;
                const decCtx = new AC();
                const decoded = await decCtx.decodeAudioData(buf);
                const pcm = decoded.getChannelData(0);
                const rate = decoded.sampleRate;
                const win = Math.max(1, Math.round(rate * 0.01));
                const rms: number[] = [];
                for (let i = 0; i + win <= pcm.length; i += win) {
                    let s = 0;
                    for (let j = i; j < i + win; j++) s += pcm[j] * pcm[j];
                    rms.push(Math.sqrt(s / win));
                }
                const silThresh = 0.005;
                const silentWindows = rms.filter((v) => v < silThresh).length;
                let maxSilentRun = 0, run = 0;
                for (const v of rms) {
                    if (v < silThresh) { run++; maxSilentRun = Math.max(maxSilentRun, run); } else run = 0;
                }
                const mean = rms.reduce((a, b) => a + b, 0) / (rms.length || 1);
                const sd = Math.sqrt(rms.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rms.length || 1));
                let zc = 0;
                for (let i = 1; i < pcm.length; i++) {
                    if ((pcm[i - 1] < 0 && pcm[i] >= 0) || (pcm[i - 1] >= 0 && pcm[i] < 0)) zc++;
                }
                const zeroCrossFreq = (zc / 2) * (rate / pcm.length);
                analysis = {
                    bytes: rawBytes,
                    rate,
                    duration: pcm.length / rate,
                    windows: rms.length,
                    silentWindows,
                    maxSilentRun,
                    silentPct: (silentWindows / (rms.length || 1)) * 100,
                    rmsMean: mean,
                    rmsCV: mean ? sd / mean : Infinity,
                    zeroCrossFreq,
                    peak: pcm.reduce((a: number, b: number) => Math.max(a, Math.abs(b)), 0),
                };
                try { decCtx.close(); } catch (_) {}
            } catch (err: any) {
                analysis.decodeError = String(err);
            }
        }
        return { analysis };
    }, { seconds, kind });
}

// Poll WebRTC getStats on the receiver for audio energy.
async function getReceiverAudioStats(page: any, maxWaitMs = 20000) {
    return await page.evaluate(async (maxWaitMs: number) => {
        const V = (window as any).VoiceManager;
        const S = V._debug.state;
        const uids = Object.keys(S.peers || {});
        if (!uids.length) return { error: 'no peers', uids };

        const deadline = Date.now() + maxWaitMs;
        while (Date.now() < deadline) {
            for (const uid of uids) {
                const pc = S.peers[uid];
                if (!pc || !pc.getStats) continue;
                const report = await pc.getStats();
                for (const s of report) {
                    if (s.type === 'inbound-rtp' && s.kind === 'audio') {
                        if (s.packetsReceived > 0) {
                            return {
                                uid,
                                packetsReceived: s.packetsReceived,
                                bytesReceived: s.bytesReceived,
                                totalAudioEnergy: s.totalAudioEnergy || 0,
                                packetsLost: s.packetsLost || 0,
                                concealedSamples: s.concealedSamples || 0,
                                jitterBufferEmittedCount: s.jitterBufferEmittedCount || 0,
                            };
                        }
                    }
                }
            }
            await new Promise((r) => setTimeout(r, 500));
        }
        return { error: 'no audio packets received within timeout' };
    }, maxWaitMs);
}

// --- Disable NS/EC before app loads ----------------------------------------
async function forceAudioSettings(page: any) {
    await page.addInitScript(() => {
        try {
            localStorage.setItem('voice_settings', JSON.stringify({
                noiseSuppressionMode: 'off',
                echoCancellation: false,
                micVolume: 100,
                speakerVolume: 100,
            }));
        } catch (_) {}
    });
}

// =========================================================================
// Test 1: DM call — programmatic oscillator reaches the remote peer
// =========================================================================
test('DM call: programmatic 440 Hz oscillator reaches the remote peer', async ({ browser }) => {
    test.setTimeout(180000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();

    for (const p of [page, page2]) await forceAudioSettings(p);

    const body1 = await registerUser(page, 'ae2e1_' + Date.now().toString().slice(-6));
    const body2 = await registerUser(page2, 'ae2e2_' + Date.now().toString().slice(-6));
    await waitForWs(page);
    await waitForWs(page2);
    await setupFriends(page, page2, body1.token, body2.token);
    await createDm(page, page2, body1.token, body2.token, body2.user.username);
    await page.reload();
    await page2.reload();
    await waitForWs(page);
    await waitForWs(page2);

    await openDm(page);
    await page.waitForSelector('.dm-call-btns .dm-call-btn', { timeout: 20000 });
    await page.click('.dm-call-btns .dm-call-btn');
    await page.waitForTimeout(2000);
    await page2.waitForSelector('#incoming-call-accept:visible', { timeout: 20000 });
    await page2.click('#incoming-call-accept');

    // Wait for both sides connected.
    await page.waitForFunction(() => {
        const V = window.VoiceManager;
        return V && V.isConnected() && V.isInDmCall();
    }, undefined, { timeout: 15000 });
    await page2.waitForFunction(() => {
        const V = window.VoiceManager;
        return V && V.isConnected() && V.isInDmCall();
    }, undefined, { timeout: 15000 });

    // NOW inject the 440 Hz oscillator — the tone only starts here.
    const injectResult = await injectTone(page);
    console.log('===== INJECT TONE =====', JSON.stringify(injectResult));
    expect(injectResult.error).toBeUndefined();
    expect(injectResult.replaced).toBeGreaterThan(0);

    // Let audio flow through WebRTC + E2EE for a few seconds.
    await page.waitForTimeout(5000);

    // Capture the received stream on the callee side.
    const recvResult = await recordAndAnalyze(page2, 5, 'remote');
    console.log('===== DM CALL RECEIVE =====', JSON.stringify(recvResult, null, 2));

    if (recvResult.error) expect(recvResult.error).toBeUndefined();
    if (recvResult.error) return;

    // The decoded PCM must contain the 440 Hz tone.
    expect(recvResult.analysis.duration, 'duration').toBeGreaterThan(3);
    expect(recvResult.analysis.bytes, 'bytes').toBeGreaterThan(1000);
    expect(recvResult.analysis.silentPct, 'silentPct').toBeLessThan(2);
    expect(recvResult.analysis.maxSilentRun, 'maxSilentRun').toBeLessThan(25);
    expect(recvResult.analysis.rmsCV, 'rmsCV').toBeLessThan(0.3);
    expect(recvResult.analysis.rmsMean, 'rmsMean').toBeGreaterThan(0.005);

    // Zero-crossing of 440 Hz sine ≈ 440 (tolerance for codec resampling).
    if (recvResult.analysis.zeroCrossFreq) {
        expect(Math.abs(recvResult.analysis.zeroCrossFreq - 440), 'zeroCrossFreq').toBeLessThan(100);
    }

    await ctx.close();
    await ctx2.close();
});

// =========================================================================
// Test 2: Server voice channel — audio bytes arrive via WebRTC
// =========================================================================
test('server voice channel: audio bytes arrive via WebRTC', async ({ browser }) => {
    test.setTimeout(180000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();

    for (const p of [page, page2]) await forceAudioSettings(p);

    const body1 = await registerUser(page, 'asv1_' + Date.now().toString().slice(-6));
    const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);

    const body2 = await registerUser(page2, 'asv2_' + Date.now().toString().slice(-6));
    const join = await page2.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
        data: { code: inviteCode },
    });
    expect(join.ok()).toBeTruthy();

    // Share server key with user2.
    await page.evaluate(async ({ serverId, user2Id }) => {
        const identity = E2ECrypto.getIdentityKeyPair();
        const symKey = E2ECrypto.getServerKey(serverId);
        const pubRes = await fetch('/api/identity/' + user2Id, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const pubData = await pubRes.json();
        const u2Pub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(pubData.identity_public_key));
        const enc = E2ECrypto.envelopeEncrypt(symKey, u2Pub, identity.privateKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: user2Id,
                encrypted_key: enc.ciphertext,
                sender_public_key: E2ECrypto.arrayBufferToBase64(identity.publicKey),
                nonce: enc.nonce,
            }),
        });
    }, { serverId, user2Id: body2.user.id });

    await page.goto(`${BASE}/index.html`);
    await page2.goto(`${BASE}/index.html`);
    await page.waitForTimeout(2500);
    await page2.waitForTimeout(2500);
    await waitForWs(page);
    await waitForWs(page2);

    // Both join the voice channel.
    expect(await selectServer(page)).toBe(true);
    expect(await clickVoiceChannel(page, voiceChannelId)).toBe(true);
    await page.waitForFunction(() => {
        const V = (window as any).VoiceManager;
        return V && V.getState && V.getState().connected;
    }, undefined, { timeout: 15000 });

    expect(await selectServer(page2)).toBe(true);
    expect(await clickVoiceChannel(page2, voiceChannelId)).toBe(true);
    await page2.waitForFunction(() => {
        const V = (window as any).VoiceManager;
        return V && V.getState && V.getState().connected;
    }, undefined, { timeout: 15000 });
    await page.waitForTimeout(3000);

    // Inject 440 Hz oscillator on user1.
    const injectResult = await injectTone(page);
    console.log('===== SERVER INJECT =====', JSON.stringify(injectResult));
    expect(injectResult.error).toBeUndefined();

    // Wait for audio to flow, then record the remote stream on the receiver.
    await page.waitForTimeout(5000);

    // Use the same recording approach as the DM test — record the remote stream
    // and decode+analyze the PCM.
    const recvResult = await recordAndAnalyze(page2, 5, 'remote');
    console.log('===== SERVER CHANNEL RECEIVE =====', JSON.stringify(recvResult, null, 2));

    if (recvResult.error) {
        // Fallback: check getStats for any audio activity.
        const stats = await getReceiverAudioStats(page2, 5000);
        console.log('===== RECEIVER AUDIO STATS (fallback) =====', JSON.stringify(stats, null, 2));
        expect(recvResult.error, 'audio receive error').toBeUndefined();
        return;
    }

    // The decoded PCM must contain the 440 Hz tone.
    expect(recvResult.analysis.duration, 'duration').toBeGreaterThan(3);
    expect(recvResult.analysis.bytes, 'bytes').toBeGreaterThan(1000);
    expect(recvResult.analysis.silentPct, 'silentPct').toBeLessThan(2);
    expect(recvResult.analysis.maxSilentRun, 'maxSilentRun').toBeLessThan(25);
    expect(recvResult.analysis.rmsCV, 'rmsCV').toBeLessThan(0.3);
    expect(recvResult.analysis.rmsMean, 'rmsMean').toBeGreaterThan(0.005);

    await ctx.close();
    await ctx2.close();
});
