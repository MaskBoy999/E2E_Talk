import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// App-level "in a real call" constant-tone stop test.
//
// Feeds a 10-second constant 440 Hz tone into Chrome's FAKE microphone via
// --use-file-for-fake-audio-capture, then runs the app's REAL DM call with
// E2EE ON. On the callee we:
//   1. poll inbound-rtp getStats — concealedSamples / jitterBufferEmittedCount
//      is WebRTC's packet-loss-concealment ("stops") metric;
//   2. MediaRecord the received remote stream and analyze the decoded PCM for
//      near-silent windows (real audible stops) and RMS CV ("highs and lows").
//
// Noise suppression is forced to 'off' (localStorage) so RNNoise's speech VAD
// does not gate a constant tone — this isolates the transport + E2EE decrypt
// path, which is exactly what the user's theory is about.

const BASE = 'https://localhost:3443';
// 30s tone so it can never end mid-recording.
const WAV_PATH = path.join(os.tmpdir(), 'voice-const-tone-30s.wav');

// --- Generate a 30s constant-tone WAV (48 kHz, 16-bit PCM mono) -----------
function writeToneWav(filePath: string, seconds = 30, rate = 48000, freq = 440, amp = 0.25) {
    const n = Math.floor(seconds * rate);
    const dataSize = n * 2;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);            // PCM
    buf.writeUInt16LE(1, 22);            // mono
    buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate * 2, 28);     // byte rate
    buf.writeUInt16LE(2, 32);            // block align
    buf.writeUInt16LE(16, 34);           // bits per sample
    buf.write('data', 36);
    buf.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < n; i++) {
        const s = Math.sin((2 * Math.PI * freq * i) / rate) * amp;
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), 44 + i * 2);
    }
    fs.writeFileSync(filePath, buf);
}
writeToneWav(WAV_PATH);

test.use({
    headless: false,
    launchOptions: {
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            `--use-file-for-fake-audio-capture=${WAV_PATH}`,
        ],
    },
});

// --- Helpers (same flow as voice-audio-appoff.spec.ts) ----------------------
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

// Record `seconds` of a given MediaStream + dump inbound stats from the peer.
async function captureStream(page: any, seconds = 8, kind: 'remote' | 'mic' = 'remote') {
    return await page.evaluate(async ({ seconds, kind }) => {
        // @ts-ignore
        const V = window.VoiceManager;
        const S = V._debug.state;
        let stream: MediaStream | null = null;
        let stats: any = {};
        if (kind === 'remote') {
            const uids = Object.keys(S.remoteStreams || {});
            stream = uids.length && S.remoteStreams[uids[0]] && S.remoteStreams[uids[0]].audio;
            if (!stream) return { error: 'no remote audio stream', uids };
            // Inbound stats.
            const pc = S.peers && S.peers[uids[0]];
            if (pc) {
                const report = await pc.getStats();
                report.forEach((s: any) => {
                    if (s.type === 'inbound-rtp' && s.kind === 'audio') {
                        stats.packetsReceived = s.packetsReceived;
                        stats.totalSamplesReceived = s.totalSamplesReceived;
                        stats.totalSamplesDuration = s.totalSamplesDuration;
                        stats.concealedSamples = s.concealedSamples;
                        stats.jitterBufferEmittedCount = s.jitterBufferEmittedCount;
                        stats.packetsLost = s.packetsLost;
                        stats.totalAudioEnergy = s.totalAudioEnergy;
                    }
                });
            }
        } else {
            stream = S.localStreams && S.localStreams.mic;
            if (!stream) return { error: 'no local mic stream' };
        }

        // The app already plays remote streams via <audio> elements, which
        // drives Chrome's decoder on this machine — the recorder taps the
        // same track. For the local mic, record the raw track directly.
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

        // PCM analysis.
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
                };
                try { decCtx.close(); } catch (_) {}
            } catch (err: any) {
                analysis.decodeError = String(err);
            }
        }
        return { stats, analysis };
    }, { seconds, kind });
}

test('real DM call: constant-tone fake mic has no stops (E2EE ON)', async ({ browser }) => {
    test.setTimeout(180000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();

    // Force NS off + echo cancellation OFF BEFORE the app loads. NS off so
    // RNNoise's speech VAD can't gate the constant tone; EC off so Chrome's
    // AEC doesn't cancel the mic because the caller is also PLAYING the same
    // 440 Hz tone through its speakers (the loopback test proved the decrypt
    // path itself is clean — this isolates the app's transport end to end).
    for (const p of [page, page2]) {
        await p.addInitScript(() => {
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

    const body1 = await registerUser(page, 'ct1_' + Date.now().toString().slice(-6));
    const body2 = await registerUser(page2, 'ct2_' + Date.now().toString().slice(-6));
    await waitForWs(page);
    await waitForWs(page2);
    await setupFriends(page, page2, body1, body2);
    await createDm(page, page2, body1, body2);
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
    await page.waitForTimeout(4000); // let the call connect + audio flow

    // Capture BOTH ends: the caller's own mic track (send side) and the
    // callee's received stream (receive side). NOTE: the send-side capture
    // records the raw S.localStreams.mic track, which equals the SENT track
    // only because this test forces noiseSuppressionMode 'off' (RNNoise
    // would otherwise send S.localStreams.processedMic instead).
    const [sendSide, recvSide] = await Promise.all([
        captureStream(page, 5, 'mic'),
        captureStream(page2, 5, 'remote'),
    ]);
    console.log('=====APP CONST-TONE CALL (send vs receive)=====\n' + JSON.stringify({ sendSide, recvSide }, null, 2));

    if (sendSide.error) expect(sendSide.error, sendSide.error).toBeUndefined();
    if (recvSide.error) expect(recvSide.error, recvSide.error).toBeUndefined();
    if (sendSide.error || recvSide.error) return;

    // The fake-mic WAV tone must be a clean constant tone on BOTH sides.
    for (const [label, result] of [['send', sendSide], ['receive', recvSide]] as const) {
        expect(result.analysis.duration, `${label} duration`).toBeGreaterThan(3);
        expect(result.analysis.bytes, `${label} bytes`).toBeGreaterThan(1000);
        expect(result.analysis.silentPct, `${label} silent%`).toBeLessThan(2);
        expect(result.analysis.maxSilentRun, `${label} maxSilentRun`).toBeLessThan(25);
        expect(result.analysis.rmsCV, `${label} rmsCV`).toBeLessThan(0.3);
    }
    // WebRTC concealment tiny on the receive side.
    const emitted = recvSide.stats.jitterBufferEmittedCount || 0;
    const concealed = recvSide.stats.concealedSamples || 0;
    if (emitted > 0) {
        expect(concealed / emitted).toBeLessThan(0.02);
    }
    expect(recvSide.stats.packetsLost || 0).toBeLessThan(5);
    await ctx.close();
    await ctx2.close();
});
