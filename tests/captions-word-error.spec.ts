// Word error rate for the two bundled whisper models, on recordings whose
// transcripts are known.
//
// Settings → Live Captions offers whisper-tiny (the default) and whisper-base,
// described as "more accurate". That claim was asserted in the UI copy and
// reasoned about from the models' sizes, never *measured*. This spec measures it.
//
// TWO CONDITIONS, both deliberate:
//
//   1. `hello-captions.wav` — one slow, clean SAPI sentence (4.7 s, 13 words).
//      The control, and a deliberately easy task: the first run of this spec
//      scored both models at 0.0 % on it, which answers "does the small model
//      handle clean careful speech" and does *not* answer "is the big one worth
//      twice the time".
//   2. `wer-sentence-1..6.wav` — six sentences, two voices, a faster pace, each
//      with broadband noise at 8 dB SNR (73 words total), written by
//      `tools/make-wer-fixture.mjs` next to `wer-suite.txt`, which holds the
//      reference the generator actually spoke (index-aligned, so it cannot
//      drift). Harder in the three ways that matter to whisper: less context per
//      word, more words (so one word is 1.4 points of WER instead of 7.7 and
//      cannot flip the ranking), and noise.
//
// ONE FILE PER SENTENCE, because that is how captions consume audio in a call: a
// window is committed at the pause that ends an utterance. Scoring a single
// 20-second concatenation was tried first and produced a measurement of our own
// display limit — the panel shows at most `MAX_TEXT` characters per line, so
// both models "lost" everything past the cap (34 of 37 errors were deletions at
// the end of the transcript) and the difference between them was partly the
// difference in how fast they filled the line.
//
// Every measurement is printed and attached as `word-error-rate.json`, so a
// change to either model can be compared run to run. Measured on this machine
// at the committed 8 dB: whisper-tiny 14/73 words wrong (19.2 %) against
// whisper-base 9/73 (12.3 %) — base ahead by 6.8 points, which is the claim
// Settings makes, now checked rather than asserted. At 15 dB the same suite had
// them tied at 5.5 %, so the SNR is part of the measurement, not a detail.
//
// WHY THE ASSERTIONS ARE STRUCTURAL: the failure this test is here to catch is
// the model switch not taking effect, a model returning garbage, the fixture
// quietly becoming too easy to compare anything, or base coming out clearly
// worse — not a one-word difference, which is noise at this size.
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';
const FIXTURES = join(__dirname, 'fixtures');

/** What `hello-captions.wav` says. Exact, because SAPI was given this string. */
const CONTROL_REFERENCE = 'hello this is a test of offline speech recognition in the desktop app';
const CONTROL_FIXTURE = 'hello-captions.wav';

interface Condition {
    name: string;
    fixture: string;
    reference: string;
    /** The control is too short to rank two models on; it is reported only. */
    ranked: boolean;
}

function loadConditions(): Condition[] {
    // The suite's transcript is written by the same script that spoke it.
    const lines = readFileSync(join(FIXTURES, 'wer-suite.txt'), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    expect(lines.length, 'wer-suite.txt must hold one reference per sentence WAV').toBe(6);
    return [
        { name: 'control: clean, slow, 1 sentence', fixture: CONTROL_FIXTURE, reference: CONTROL_REFERENCE, ranked: false },
        ...lines.map((reference, i) => ({
            name: `hard ${i + 1}: faster + 8 dB noise`,
            fixture: `wer-sentence-${i + 1}.wav`,
            reference,
            ranked: true,
        })),
    ];
}

/** Two words of slack on a 73-word reference. */
const WORD_ERROR_TOLERANCE = 0.05;

const MODELS = ['tiny', 'base'] as const;
type ModelName = (typeof MODELS)[number];

function uniq(base: string) {
    return `${base}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'testpass1234');
    await page.fill('#register-confirm-password', 'testpass1234');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 20000 });
}

/** Words as a decoder's output should be judged: case and punctuation are not errors. */
function words(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9'\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean);
}

interface Wer {
    refWords: number;
    substitutions: number;
    deletions: number;
    insertions: number;
    hits: number;
    errors: number;
    wer: number;
}

/** Levenshtein alignment over words, with the edit operations counted. */
function wordErrorRate(reference: string, hypothesis: string): Wer {
    const r = words(reference);
    const h = words(hypothesis);
    const d: number[][] = [];
    for (let i = 0; i <= r.length; i++) d.push(new Array(h.length + 1).fill(0));
    for (let i = 0; i <= r.length; i++) d[i][0] = i;
    for (let j = 0; j <= h.length; j++) d[0][j] = j;
    for (let i = 1; i <= r.length; i++) {
        for (let j = 1; j <= h.length; j++) {
            const cost = r[i - 1] === h[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        }
    }
    let sub = 0, del = 0, ins = 0, hit = 0;
    let i = r.length, j = h.length;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1)) {
            if (r[i - 1] === h[j - 1]) hit++; else sub++;
            i--; j--;
        } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
            del++; i--;
        } else {
            ins++; j--;
        }
    }
    return { refWords: r.length, substitutions: sub, deletions: del, insertions: ins, hits: hit, errors: sub + del + ins, wer: r.length ? (sub + del + ins) / r.length : (h.length ? 1 : 0) };
}

/**
 * Decode every fixture once, 16 kHz mono, and keep them in the page.
 *
 * Stashed on `window` rather than passed per measurement: both models must get
 * byte-identical audio, and re-serialising a minute of floats per call would add
 * seconds of noise to timings that get compared.
 */
async function loadFixtures(page: Page, conditions: Condition[]) {
    for (const c of conditions) {
        const b64 = readFileSync(join(FIXTURES, c.fixture)).toString('base64');
        const info = await page.evaluate(async ({ b64, name }: { b64: string; name: string }) => {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const ctx = new AudioContext({ sampleRate: 16000 });
            const buf = await ctx.decodeAudioData(bytes.buffer);
            await ctx.close();
            const w = window as any;
            w.__werAudio = w.__werAudio || {};
            w.__werAudio[name] = { data: Array.from(buf.getChannelData(0)), rate: buf.sampleRate };
            return { name, samples: buf.length, rate: buf.sampleRate };
        }, { b64, name: c.fixture });
        expect(info.samples, `${c.fixture} must decode to audio`).toBeGreaterThan(8000);
    }
}

interface Measurement {
    model: ModelName;
    condition: string;
    text: string;
    ms: number;
    engine: string;
    threads: number;
    loadedModel: string;
    error?: string;
}

/**
 * Run one model over one fixture and return what it wrote.
 *
 * The whole run happens inside one `page.evaluate`, so the elapsed time has no
 * round-trip in it and the polling (100 ms) is the only overhead. `stop()` first
 * drops the previous run's lines — captions are never carried across a run.
 */
async function measure(page: Page, model: ModelName, condition: Condition): Promise<Measurement> {
    return page.evaluate(async ({ model, fixture }) => {
        const C = (window as any).__captions;
        const pcm = (window as any).__werAudio[fixture];
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const NOT_READY = 300000, DECODE_LIMIT = 300000;

        C.stop();
        C.setModel(model);
        C.start();
        const readyBy = Date.now() + NOT_READY;
        while (Date.now() < readyBy && C.modelState().state !== 'ready') await sleep(200);
        if (C.modelState().state !== 'ready') {
            return { model, condition: fixture, text: '', ms: 0, engine: '', threads: 0, loadedModel: '', error: 'the model never became ready: ' + (C.modelState().error || 'unknown') };
        }
        const t0 = performance.now();
        // The transcribe request carries the model, so a worker still holding the
        // previous one rebuilds for this one before decoding.
        if (!C._feedForTest('wer-' + model + '-' + fixture, 'Fixture', new Float32Array(pcm.data), pcm.rate)) {
            return { model, condition: fixture, text: '', ms: 0, engine: '', threads: 0, loadedModel: '', error: 'the worker refused the window' };
        }
        let text = '';
        while (performance.now() - t0 < DECODE_LIMIT) {
            const lines = C.lines().filter((l: any) => l.who === 'Fixture');
            const last = lines[lines.length - 1];
            if (last && last.final) { text = last.text; break; }
            await sleep(100);
        }
        const st = C.modelState();
        return { model, condition: fixture, text, ms: Math.round(performance.now() - t0), engine: st.engine, threads: st.threads, loadedModel: st.model };
    }, { model, fixture: condition.fixture });
}

test.describe('captions word error rate', () => {
    test('both bundled models decode known recordings, and the WER is reported', async ({ page }, testInfo) => {
        test.setTimeout(900000);
        await register(page, uniq('wer'));
        const conditions = loadConditions();
        await loadFixtures(page, conditions);

        // Models in the outer loop: the worker is rebuilt once per model, not
        // once per sentence.
        const results: Array<Measurement & { wer: Wer; reference: string; ranked: boolean; name: string }> = [];
        for (const model of MODELS) {
            for (const condition of conditions) {
                const r = await measure(page, model, condition);
                expect(r.error, `whisper-${model} must decode ${condition.fixture}: ${r.error || ''}`).toBeFalsy();
                expect(r.text, `whisper-${model} must produce a transcript for ${condition.fixture}`).toBeTruthy();
                // The worker says which model it built, so "the model switch did
                // nothing" cannot pass as a measurement of the other model.
                expect(r.loadedModel, `the worker must be running whisper-${model}`).toBe(`whisper-${model}`);
                const wer = wordErrorRate(condition.reference, r.text);
                results.push({ ...r, wer, reference: condition.reference, ranked: condition.ranked, name: condition.name });
                console.log(
                    `WER whisper-${model} [${condition.name}] ${condition.fixture}: ${(wer.wer * 100).toFixed(1)}% ` +
                    `(${wer.substitutions} sub, ${wer.deletions} del, ${wer.insertions} ins over ${wer.refWords} words) ` +
                    `in ${(r.ms / 1000).toFixed(1)}s on ${r.engine} x${r.threads}`,
                );
                console.log(`  reference: "${condition.reference}"`);
                console.log(`  heard:     "${r.text}"`);
            }
        }

        /** Errors over words, summed across the ranked (hard) conditions. */
        function aggregate(model: ModelName) {
            const rs = results.filter((r) => r.model === model && r.ranked);
            const refWords = rs.reduce((n, r) => n + r.wer.refWords, 0);
            const errors = rs.reduce((n, r) => n + r.wer.errors, 0);
            return { refWords, errors, wer: refWords ? errors / refWords : 0 };
        }
        const tiny = aggregate('tiny');
        const base = aggregate('base');
        const delta = tiny.wer - base.wer; // positive = base is better
        const controlTiny = results.find((r) => r.model === 'tiny' && !r.ranked)!;
        const controlBase = results.find((r) => r.model === 'base' && !r.ranked)!;

        console.log(
            `SUMMARY control [${CONTROL_FIXTURE}] whisper-tiny ${(controlTiny.wer.wer * 100).toFixed(1)}% vs whisper-base ` +
            `${(controlBase.wer.wer * 100).toFixed(1)}% over ${controlTiny.wer.refWords} words — too few to rank the two models`,
        );
        console.log(
            `SUMMARY hard [6 sentences, faster + 8 dB noise] whisper-tiny ${tiny.errors}/${tiny.refWords} words wrong ` +
            `(${(tiny.wer * 100).toFixed(1)}%) vs whisper-base ${base.errors}/${base.refWords} (${(base.wer * 100).toFixed(1)}%) → ` +
            `${delta > 0 ? 'base is better' : delta < 0 ? 'TINY IS BETTER' : 'identical'} by ${(Math.abs(delta) * 100).toFixed(1)} points`,
        );

        await testInfo.attach('word-error-rate.json', {
            body: JSON.stringify({ control: CONTROL_FIXTURE, summary: { tiny, base, deltaPoints: delta * 100 }, results }, null, 2),
            contentType: 'application/json',
        });

        // Both models decode real speech without falling apart…
        for (const r of results) {
            expect(r.wer.wer, `whisper-${r.model} must not return garbage for ${r.fixture ?? r.condition}`).toBeLessThan(0.8);
        }
        // …and the hard fixture has to actually be harder, or the measurement
        // above measures nothing. If both models turn out perfect on it, the
        // fixture needs regenerating (`node tools/make-wer-fixture.mjs --snr 8`),
        // not a looser assertion here.
        expect(
            Math.max(tiny.wer, base.wer),
            'the faster/noisy sentences must cost at least one model some accuracy — otherwise they cannot compare them',
        ).toBeGreaterThan(Math.max(controlTiny.wer.wer, controlBase.wer.wer));
        // The claim, on the condition that can rank them: base must not be worse
        // than tiny. A better-than-tiny result is reported rather than required —
        // see the tolerance note at the top.
        expect(
            base.wer,
            `whisper-base (${(base.wer * 100).toFixed(1)}%, ${base.errors}/${base.refWords}) must not be worse than whisper-tiny ` +
            `(${(tiny.wer * 100).toFixed(1)}%, ${tiny.errors}/${tiny.refWords}) by more than ${(WORD_ERROR_TOLERANCE * 100).toFixed(0)} points`,
        ).toBeLessThanOrEqual(tiny.wer + WORD_ERROR_TOLERANCE);
    });
});
