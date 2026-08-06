import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolation probe: is the periodic silence injected by Chrome's fake WAV-file
// capture device + getUserMedia constraints, BEFORE any app code runs?
// Records the raw getUserMedia track directly (no app, no E2EE, no WebRTC).

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

async function recordRawMic(page: any, seconds = 5, constraints: any) {
    return await page.evaluate(async ({ seconds, constraints }) => {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        const track = stream.getAudioTracks()[0];
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
    }, { seconds, constraints });
}

test('raw fake-WAV mic track with app constraints', async ({ browser }) => {
    test.setTimeout(60000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    // The app's exact constraints for NS off: echoCancellation true, AGC true,
    // noiseSuppression false.
    const withAppConstraints = await recordRawMic(page, 5, {
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
        video: false,
    });
    // Bare constraints: nothing at all.
    const bare = await recordRawMic(page, 5, { audio: true, video: false });
    console.log('=====FAKE MIC PROBE=====\n' + JSON.stringify({ withAppConstraints, bare }, null, 2));

    expect(withAppConstraints.duration).toBeGreaterThan(3);
    expect(bare.duration).toBeGreaterThan(3);
    await ctx.close();
});
