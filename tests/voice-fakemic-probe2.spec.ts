import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Discriminate two hypotheses for the periodic 67%-silent mic track seen in
// the app-level const-tone call test:
//   (A) the app's AudioContext consumption of the mic track (micGain node +
//       speaking-detection analyser) gates/starves the raw track, OR
//   (B) two pages in the same browser sharing Chrome's --use-file-for-fake-
//       audio-capture device chops each page's stream.
// Probe 1: single page, getUserMedia -> replicate the app's exact consumption
//          (createMediaStreamSource -> micGain dead-end + analyser polled via
//          setInterval) while recording the RAW track.
// Probe 2: two pages, each just getUserMedia + record (no app code).

const BASE = 'https://localhost:3443';
const WAV_PATH = path.join(os.tmpdir(), 'voice-const-tone-10s.wav');

function writeToneWav(filePath: string, seconds = 10, rate = 48000, freq = 440, amp = 0.25) {
    const n = Math.floor(seconds * rate);
    const dataSize = n * 2;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
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

async function recordRawMic(page: any, seconds = 5, constraints: any, consumeWithAudioContext = false) {
    return await page.evaluate(async ({ seconds, constraints, consumeWithAudioContext }) => {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        const track = stream.getAudioTracks()[0];

        // Replicate the app's mic consumption exactly: a media-stream source
        // into a dead-end gain node PLUS a polled analyser.
        let analyser: any = null;
        let pollIv: any = null;
        if (consumeWithAudioContext) {
            const AC: any = window.AudioContext || (window as any).webkitAudioContext;
            const ctx = new AC();
            const src = ctx.createMediaStreamSource(stream);
            const deadGain = ctx.createGain();
            deadGain.gain.value = 1;
            src.connect(deadGain); // dead end, like S.micGain
            analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            src.connect(analyser);
            const buf = new Uint8Array(analyser.fftSize);
            pollIv = setInterval(() => {
                try { analyser.getByteTimeDomainData(buf); } catch (_) {}
            }, 120);
        }

        const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
        const rec = new MediaRecorder(new MediaStream([track]), mime ? { mimeType: mime } : undefined);
        const chunks: Blob[] = [];
        rec.ondataavailable = (e: any) => { if (e.data && e.data.size) chunks.push(e.data); };
        rec.start();
        await new Promise((r) => setTimeout(r, seconds * 1000));
        rec.stop();
        await new Promise((r) => { rec.onstop = r; });
        if (pollIv) clearInterval(pollIv);

        const blob = new Blob(chunks, { type: 'audio/webm' });
        const buf2 = await blob.arrayBuffer();
        const rawBytes = buf2.byteLength;
        let analysis: any = { bytes: rawBytes, decodeError: null };
        if (rawBytes > 0) {
            try {
                const AC: any = window.AudioContext || (window as any).webkitAudioContext;
                const decCtx = new AC();
                const decoded = await decCtx.decodeAudioData(buf2);
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
        stream.getTracks().forEach((t) => t.stop());
        return analysis;
    }, { seconds, constraints, consumeWithAudioContext });
}

test('probe A: app-style AudioContext consumption of raw mic', async ({ browser }) => {
    test.setTimeout(60000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    const a = await recordRawMic(page, 5, { audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true }, video: false }, true);
    console.log('=====PROBE A (app consumption)=====\n' + JSON.stringify(a, null, 2));
    expect(a.silentPct).toBeLessThan(5);
    await ctx.close();
});

test('probe B: two pages sharing the fake WAV device', async ({ browser }) => {
    test.setTimeout(60000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
    await page2.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page2.waitForTimeout(800);
    const constraints = { audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true }, video: false };
    const [r1, r2] = await Promise.all([
        recordRawMic(page, 5, constraints, false),
        recordRawMic(page2, 5, constraints, false),
    ]);
    console.log('=====PROBE B (two pages, same device)=====\n' + JSON.stringify({ page1: r1, page2: r2 }, null, 2));
    expect(r1.silentPct).toBeLessThan(5);
    expect(r2.silentPct).toBeLessThan(5);
    await ctx.close();
    await ctx2.close();
});
