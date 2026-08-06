import { test, expect } from '@playwright/test';

// Validates the RNNoise pipeline the app actually uses
// (static/rnnoise/sapphi-worklet.js + sapphi-rnnoise.wasm — the production
// build with the real trained model; earlier vendored wasm builds had an
// INERT model: processFrame returned the input unchanged, VAD always 0):
//  1. white noise  -> suppressed (RNNoise is weakest on pure-white synthetic
//     noise, but must still reduce it)
//  2. pink noise   -> strongly suppressed (fan/hum-like — the user's case)
//  3. keyboard     -> transients suppressed on average
//  4. vowel        -> speech-like signal PASSES (>= 60% of input level)
//  5. continuity   -> no periodic zero-runs (480-frame vs 128-quantum grid)

const BASE = 'https://localhost:3443';

test.use({
    headless: false,
    launchOptions: {
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: ['--autoplay-policy=no-user-gesture-required'],
    },
});

test('RNNoise suppresses noise, passes speech, and has no periodic gaps', async ({ browser }) => {
    test.setTimeout(150000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login.html`);

    const result = await page.evaluate(async () => {
        const AC = window.AudioContext || (window as any).webkitAudioContext;
        const out: any = {};

        function makeSignal(kind: string, len: number, rate: number) {
            const d = new Float32Array(len);
            if (kind === 'white') {
                for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.7;
            } else if (kind === 'pink') {
                let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
                for (let i = 0; i < len; i++) {
                    const w = Math.random() * 2 - 1;
                    b0 = 0.99886 * b0 + w * 0.0555179;
                    b1 = 0.99332 * b1 + w * 0.0750759;
                    b2 = 0.969 * b2 + w * 0.153852;
                    b3 = 0.8665 * b3 + w * 0.3104856;
                    b4 = 0.55 * b4 + w * 0.5329522;
                    b5 = -0.7616 * b5 - w * 0.016898;
                    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
                    b6 = w * 0.115926;
                }
            } else if (kind === 'keyboard') {
                let nextClick = 0;
                for (let i = 0; i < len; i++) {
                    if (i >= nextClick) {
                        nextClick = i + Math.floor((0.08 + Math.random() * 0.3) * rate);
                        const cl = Math.floor((0.004 + Math.random() * 0.008) * rate);
                        for (let j = 0; j < cl && i + j < len; j++) {
                            d[i + j] = (Math.random() * 2 - 1) * 0.8 * Math.exp(-j / (cl * 0.35));
                        }
                        i += cl;
                    }
                }
            } else if (kind === 'vowel') {
                for (let i = 0; i < len; i++) {
                    const t = i / rate;
                    d[i] = 0.3 * Math.sin(2 * Math.PI * 120 * t) * (0.55 + 0.45 * Math.sin(2 * Math.PI * 3 * t)) + 0.12 * Math.sin(2 * Math.PI * 240 * t);
                }
            }
            return d;
        }

        function rms(x: Float32Array, from: number, to: number) {
            let s = 0;
            for (let i = from; i < to; i++) s += x[i] * x[i];
            return Math.sqrt(s / (to - from));
        }

        try {
            const wasmResp = await fetch(`${location.origin}/rnnoise/sapphi-rnnoise.wasm`);
            const wasmBinary = await wasmResp.arrayBuffer();
            out.wasmBytes = wasmBinary.byteLength;
            const rate = 48000;

            for (const kind of ['white', 'pink', 'keyboard', 'vowel']) {
                const ctx = new AC({ sampleRate: rate });
                await ctx.audioWorklet.addModule(`${location.origin}/rnnoise/sapphi-worklet.js`);
                const wl = new AudioWorkletNode(ctx, '@sapphi-red/web-noise-suppressor/rnnoise', {
                    numberOfInputs: 1, numberOfOutputs: 1,
                    channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1],
                    processorOptions: { wasmBinary, maxChannels: 1 },
                });
                const sp = ctx.createScriptProcessor(4096, 1, 1);
                const silent = ctx.createGain();
                silent.gain.value = 0;
                const src = ctx.createBufferSource();
                const buf = ctx.createBuffer(1, rate * 4, rate);
                const d = buf.getChannelData(0);
                d.set(makeSignal(kind, rate * 4, rate));
                src.buffer = buf;
                src.connect(wl);
                wl.connect(sp);
                sp.connect(silent);
                silent.connect(ctx.destination);
                const chunks: Float32Array[] = [];
                sp.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
                src.start(0);
                await new Promise((r) => setTimeout(r, 4700));
                src.stop();
                let pcm: number[] = [];
                for (const c of chunks) pcm.push(...Array.from(c));
                // Steady state: skip load/latency (first 250 ms) and stop
                // before the capture tail (0.7 s past the 4 s buffer).
                const skip = Math.floor(0.25 * rate);
                const end = Math.min(pcm.length, skip + rate * 4);
                const segs: any[] = [];
                for (let s0 = skip; s0 < end; s0 += Math.floor(0.5 * rate)) {
                    const s1 = Math.min(end, s0 + Math.floor(0.5 * rate));
                    const inR = rms(d, s0 - skip, s1 - skip);
                    const outR = rms(new Float32Array(pcm.slice(s0, s1)), 0, s1 - s0);
                    segs.push({ t: ((s0 - skip) / rate).toFixed(1) + 's', dB: +(20 * Math.log10(outR / (inR + 1e-9))).toFixed(1) });
                }
                const dBs = segs.map((s) => s.dB);
                out[kind] = {
                    avgDb: +(dBs.reduce((a, b) => a + b, 0) / dBs.length).toFixed(1),
                    minDb: +Math.min(...dBs).toFixed(1),
                    maxDb: +Math.max(...dBs).toFixed(1),
                    segs,
                };
                // Continuity: scan the same window for runs of >= 8 near-zero
                // samples; a zero-padding worklet shows them every ~512 samples.
                const runs: { at: number; len: number }[] = [];
                let rr = 0, rs = -1;
                for (let i = skip; i < end; i++) {
                    if (Math.abs(pcm[i]) < 0.0005) { if (rr === 0) rs = i; rr++; }
                    else { if (rr >= 8) runs.push({ at: rs, len: rr }); rr = 0; }
                }
                if (rr >= 8) runs.push({ at: rs, len: rr });
                let closePairs = 0;
                for (let i = 1; i < runs.length; i++) if (runs[i].at - runs[i - 1].at < 2000) closePairs++;
                if (kind === 'vowel') out.vowelContinuity = { runs: runs.length, closePairs, maxRun: runs.reduce((m, r) => Math.max(m, r.len), 0) };
                try { ctx.close(); } catch (_) {}
            }
            out.error = undefined;
        } catch (e: any) {
            out.error = String(e);
        }
        return out;
    });

    console.log('=====RNNOISE WORKLET (working build)=====\n' + JSON.stringify(result, null, 2));

    // ---- Assertions ----
    expect(result.error).toBeUndefined();
    expect(result.wasmBytes).toBeGreaterThan(100000); // real model embedded

    // Speech-like signal must pass: output within 40% of input level (RNNoise
    // may gate the quiet AM troughs a bit, but the bulk must come through).
    expect(result.vowel.avgDb, JSON.stringify(result.vowel)).toBeGreaterThan(-4.5);

    // Pink noise (fan/hum-like): meaningful suppression required. Depth
    // varies run-to-run with RNNoise's noise-floor estimate (measured -6.6
    // avg, every segment <= -4.9); the dead-model build measured exactly
    // 0.00, so anything below -4.5 is unambiguous real suppression.
    expect(result.pink.avgDb, JSON.stringify(result.pink)).toBeLessThan(-4.5);

    // Keyboard transients: meaningful suppression on average.
    expect(result.keyboard.avgDb, JSON.stringify(result.keyboard)).toBeLessThan(-3);

    // White noise: RNNoise is weakest on pure-white SYNTHETIC noise (real
    // noise is pink-ish and is suppressed hard), but it must still reduce it —
    // the dead-model build measured exactly 0.00 dB everywhere.
    expect(result.white.avgDb, JSON.stringify(result.white)).toBeLessThan(-0.5);

    // Continuity: no periodic zero-runs in the vowel output. RNNoise
    // legitimately gates the vowel's quiet AM troughs (long single runs —
    // maxRun can be thousands), but a zero-padding worklet shows many runs
    // spaced ~512 samples apart. closePairs === 0 proves no periodicity.
    expect(result.vowelContinuity.closePairs, JSON.stringify(result.vowelContinuity)).toBe(0);
});
