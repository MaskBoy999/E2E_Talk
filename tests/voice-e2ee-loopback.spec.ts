import { test, expect } from '@playwright/test';

// Decisive isolation test for the "stops with highs and lows" audio bug.
//
// Hypothesis under test (user's theory): by the time a received frame is
// decrypted, the next one has arrived and is waiting, so the decrypt path
// (e2ee-worker.js: serialized `await crypto.subtle.decrypt` per frame)
// occasionally starves the WebRTC jitter buffer → periodic dropouts.
//
// Setup: two RTCPeerConnections in the SAME page, connected back-to-back
// with manual SDP/ICE exchange (loopback = ~zero network jitter). A constant
// 440 Hz tone is generated with an oscillator and fed through the REAL
// /e2ee-worker.js encrypt transform on the sender and decrypt transform on
// the receiver. We then:
//   1. read receiver-side getStats (concealedSamples, jitterBufferEmittedCount,
//      packetsLost, jitterBufferDelay) — concealed samples are the WebRTC
//      packet-loss-concealment synthesis, i.e. the audible "stops".
//   2. MediaRecord the received track and analyze the decoded PCM for
//      near-silent windows (stops) and RMS coefficient of variation
//      ("highs and lows" — a constant tone has near-constant RMS).
// The same run WITHOUT any transform (E2EE off) is the control. If E2EE-on
// shows materially more concealment/stops than the control, the decrypt
// path is the cause; if both are equally clean, the bug lives elsewhere
// (RNNoise worklet, app audio element handling, etc.).

const BASE = 'https://localhost:3443';

test.use({
    headless: false,
    launchOptions: {
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
        ],
    },
});

// Runs the full loopback in-page and returns stats + PCM analysis.
async function runLoopback(page: any, useE2EE: boolean, seconds = 10) {
    return await page.evaluate(async ({ useE2EE, seconds }) => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

        // 1) Constant tone source (440 Hz, well inside Opus' happy range).
        const AC: any = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = new AC();
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 440;
        const gain = ctx.createGain();
        gain.gain.value = 0.25; // ~ -12 dBFS, no clipping, no Opus limiting
        const dest = ctx.createMediaStreamDestination();
        osc.connect(gain);
        gain.connect(dest);
        osc.start();

        const toneTrack = dest.stream.getAudioTracks()[0];

        // 2) Back-to-back peer connections (host candidates only — loopback).
        const pc1: any = new RTCPeerConnection({ iceServers: [] });
        const pc2: any = new RTCPeerConnection({ iceServers: [] });
        pc1.onicecandidate = (e: any) => { if (e.candidate) pc2.addIceCandidate(e.candidate).catch(() => {}); };
        pc2.onicecandidate = (e: any) => { if (e.candidate) pc1.addIceCandidate(e.candidate).catch(() => {}); };

        let recvTrack: MediaStreamTrack | null = null;
        pc2.ontrack = (e: any) => { recvTrack = e.track; };

        pc1.addTrack(toneTrack, new MediaStream([toneTrack]));

        const worker = useE2EE ? new Worker('/e2ee-worker.js') : null;
        const keyBytes = new Uint8Array(32);
        crypto.getRandomValues(keyBytes);
        const keyB64 = btoa(String.fromCharCode(...keyBytes));

        if (useE2EE && worker) {
            pc1.getSenders()[0].transform = new (window as any).RTCRtpScriptTransform(worker, { operation: 'encrypt', key: keyB64 });
        }

        // 3) Manual signaling.
        const offer = await pc1.createOffer();
        await pc1.setLocalDescription(offer);
        await pc2.setRemoteDescription(offer);
        if (useE2EE && worker) {
            // Attach decrypt BEFORE the answer so no frame ever plays plaintext.
            pc2.getReceivers().forEach((r: any) => {
                r.transform = new (window as any).RTCRtpScriptTransform(worker, { operation: 'decrypt', key: keyB64 });
            });
        }
        const answer = await pc2.createAnswer();
        await pc2.setLocalDescription(answer);
        await pc1.setRemoteDescription(answer);

        // 4) Wait for the connection to come up.
        const connected = await new Promise<boolean>((resolve) => {
            const t0 = Date.now();
            const iv = setInterval(() => {
                if (pc2.connectionState === 'connected' || pc2.connectionState === 'completed') {
                    clearInterval(iv);
                    resolve(true);
                } else if (Date.now() - t0 > 15000) {
                    clearInterval(iv);
                    resolve(false);
                }
            }, 100);
        });

        if (!connected) {
            return { error: 'loopback did not connect', connectionState: pc2.connectionState };
        }

        // 4b) IMPORTANT: Chrome on this machine only starts decoding the
        // received track when an <audio> element plays it (a bare
        // MediaRecorder/MediaStream sink leaves the jitter buffer at 0
        // emitted samples — the exact quirk documented in voice.js). Drive
        // the decoder exactly like the app does, then record the SAME track.
        const el = document.createElement('audio');
        el.autoplay = true;
        el.style.display = 'none';
        document.body.appendChild(el);
        if (recvTrack) {
            el.srcObject = new MediaStream([recvTrack]);
            try { await el.play(); } catch (_) {}
        }

        // Let a little audio flow, then record ~`seconds` of the received track.
        await sleep(1500);
        const recStream = new MediaStream(recvTrack ? [recvTrack] : []);
        const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
        const rec = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
        const chunks: Blob[] = [];
        rec.ondataavailable = (e: any) => { if (e.data && e.data.size) chunks.push(e.data); };
        rec.start();
        await sleep(seconds * 1000);
        rec.stop();
        await new Promise((r) => { rec.onstop = r; });

        // 5) Receiver-side stats — poll 5x so we can see the jitter buffer
        // EMITTED count GROW over time (a stall shows a flat line).
        const growth: number[] = [];
        for (let k = 0; k < 5; k++) {
            await sleep(1000);
            const r2 = await pc2.getStats();
            r2.forEach((s: any) => {
                if (s.type === 'inbound-rtp' && s.kind === 'audio') {
                    growth.push(s.jitterBufferEmittedCount || 0);
                }
            });
        }
        const report = await pc2.getStats();
        const stats: any = { emittedGrowth: growth };
        report.forEach((s: any) => {
            if (s.type === 'inbound-rtp' && s.kind === 'audio') {
                stats.packetsReceived = s.packetsReceived;
                stats.totalSamplesReceived = s.totalSamplesReceived;
                stats.totalSamplesDuration = s.totalSamplesDuration;
                stats.concealedSamples = s.concealedSamples;
                stats.jitterBufferEmittedCount = s.jitterBufferEmittedCount;
                stats.packetsLost = s.packetsLost;
                stats.jitterBufferDelay = s.jitterBufferDelay;
                stats.jitterBufferTargetDelay = s.jitterBufferTargetDelay;
                stats.totalAudioEnergy = s.totalAudioEnergy;
            }
            if (s.type === 'outbound-rtp' && s.kind === 'audio') {
                stats.sentPackets = s.packetsSent;
                stats.sentSamples = s.totalSamplesSent;
            }
        });

        try { el.remove(); } catch (_) {}

        // 6) Decode the recorded audio and analyze for stops / level wobble.
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const buf = await blob.arrayBuffer();
        const rawBytes = buf.byteLength; // decodeAudioData DETACHES the buffer — capture size first
        let analysis: any = { bytes: rawBytes, decodeError: null };
        if (rawBytes > 0) {
            try {
                const decCtx = new AC();
                const decoded = await decCtx.decodeAudioData(buf);
                const pcm = decoded.getChannelData(0);
                const rate = decoded.sampleRate;
                const win = Math.max(1, Math.round(rate * 0.01)); // 10 ms windows
                const rms: number[] = [];
                for (let i = 0; i + win <= pcm.length; i += win) {
                    let s = 0;
                    for (let j = i; j < i + win; j++) s += pcm[j] * pcm[j];
                    rms.push(Math.sqrt(s / win));
                }
                const silThresh = 0.005; // RMS below ~ -46 dBFS = "silent"
                const silentWindows = rms.filter((v) => v < silThresh).length;
                let maxSilentRun = 0, run = 0;
                for (const v of rms) {
                    if (v < silThresh) { run++; maxSilentRun = Math.max(maxSilentRun, run); } else run = 0;
                }
                const mean = rms.reduce((a, b) => a + b, 0) / (rms.length || 1);
                const sd = Math.sqrt(rms.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rms.length || 1));
                analysis = {
                    bytes: rawBytes,
                    rate,
                    duration: pcm.length / rate,
                    windows: rms.length,
                    silentWindows,
                    maxSilentRun,        // longest contiguous silent run in 10ms units — real stops
                    silentPct: (silentWindows / (rms.length || 1)) * 100,
                    rmsMean: mean,
                    rmsCV: mean ? sd / mean : Infinity, // 0 = perfectly constant level
                };
                try { decCtx.close(); } catch (_) {}
            } catch (err: any) {
                analysis.decodeError = String(err);
            }
        }
        try { ctx.close(); } catch (_) {}

        return { stats, analysis };
    }, { useE2EE, seconds });
}

for (const e2ee of ['off', 'on'] as const) {
    test(`constant-tone loopback: E2EE ${e2ee.toUpperCase()} has no stops`, async ({ browser }) => {
        test.setTimeout(120000);
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);

        const result = await runLoopback(page, e2ee === 'on', 10);
        console.log(`=====LOOPBACK E2EE=${e2ee}=====\n` + JSON.stringify(result, null, 2));

        if (result.error) {
            expect(result.error, result.error).toBeUndefined();
            return;
        }
        // Audio must have flowed at all.
        expect(result.analysis.duration).toBeGreaterThan(5);
        expect(result.analysis.bytes).toBeGreaterThan(1000);
        // A constant tone must not have long stops: < 1% silent windows and
        // no contiguous silent run longer than 25 windows (250 ms).
        expect(result.analysis.silentPct).toBeLessThan(1);
        expect(result.analysis.maxSilentRun).toBeLessThan(25);
        // Level wobble ("highs and lows"): a constant tone has RMS CV ~0.
        expect(result.analysis.rmsCV).toBeLessThan(0.25);
        // WebRTC concealment should be a tiny fraction of emitted audio.
        const emitted = result.stats.jitterBufferEmittedCount || 0;
        const concealed = result.stats.concealedSamples || 0;
        if (emitted > 0) {
            expect(concealed / emitted).toBeLessThan(0.02);
        }
        expect(result.stats.totalSamplesReceived || 0).toBeGreaterThan(100000);
        // The jitter buffer must EMIT continuously — a stall shows a flat line
        // in emittedGrowth (the "stops" mechanism). Each poll is ~1s apart,
        // so emitted must strictly grow.
        const growth = result.stats.emittedGrowth || [];
        expect(growth.length).toBeGreaterThanOrEqual(3);
        for (let i = 1; i < growth.length; i++) {
            expect(growth[i], `emittedGrowth[${i}] stalled`).toBeGreaterThan(growth[i - 1]);
        }
        await ctx.close();
    });
}
