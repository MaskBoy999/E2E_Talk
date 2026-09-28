#!/usr/bin/env node
/**
 * Generate the speech fixture the word-error-rate spec measures against.
 *
 *   node tools/make-wer-fixture.mjs                  # the committed configuration
 *   node tools/make-wer-fixture.mjs --snr 15 --rate 1 # an easier one, to experiment
 *
 * Writes, into tests/fixtures/ :
 *
 *   wer-sentence-1..6.wav   one spoken sentence each, at a quicker-than-default
 *                           pace, alternating between two voices, each with
 *                           deterministic broadband noise mixed in
 *   wer-suite.txt           the reference transcript, one sentence per line,
 *                           index-aligned with the WAVs — generated from the
 *                           same array that was spoken, so it cannot drift
 *
 * ONE FILE PER SENTENCE, not one concatenated file, because that is how captions
 * actually consume audio in a call: a window is committed at the pause that ends
 * an utterance. Concatenating them into a single 20-second window was tried
 * first and produced meaningless numbers — the captions panel shows at most
 * `MAX_TEXT` characters per line, so both models "lost" everything past the cap
 * and the ranking measured our own line limit rather than the decoders.
 *
 * WHY THIS EXISTS. `tests/captions-word-error.spec.ts` reports word error rate
 * for the two bundled whisper models, and the first fixture it used
 * (`hello-captions.wav`, one slow clean SAPI sentence) turned out to be too easy
 * to separate them: both models scored 0.0 %. A measurement that cannot tell the
 * two options apart does not answer "is whisper-base worth twice the time", so
 * this fixture is deliberately harder in the three ways that matter to whisper:
 *
 *   * PACE — synthesized at a faster rate, so each word has less acoustic
 *     context around it (the failure mode the model size is supposed to fix);
 *   * BREADTH — ~75 words across six varied sentences instead of 13, so one word
 *     is worth ~1.3 points of WER rather than 7.7, and a single coin-flip word
 *     cannot flip the ranking;
 *   * NOISE — broadband noise mixed at a fixed signal-to-noise ratio, computed
 *     from the speech's own RMS and seeded from a constant, so the fixture is
 *     byte-identical every time it is generated.
 *
 * The committed ratio is **8 dB**, and it is 8 because it was measured: at 15 dB
 * the two models both scored 5.5 % on this suite — a tie, and the same "cannot
 * separate them" result the easy fixture gave. At 8 dB they separate (whisper-tiny
 * 19.2 % against whisper-base 12.3 %), which is what the spec exists to show. More
 * noise than that starts scoring the channel rather than the models.
 *
 * Two voices alternate, which is closer to a call than one narrator.
 *
 * Everything here is synthesis and arithmetic on this machine: no third-party
 * audio, no network, nothing to attribute. Windows-only (System.Speech), which
 * is where the existing fixture came from too; the WAV and its transcript are
 * committed, so nobody needs to run this to run the tests.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'tests', 'fixtures');

/** argv: --snr <dB>, --rate <SAPI -10..10>, --gap <ms>, --out <name> */
function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1 || !process.argv[i + 1]) return fallback;
  return process.argv[i + 1];
}

const RATE = Number(arg('rate', 2));
const SNR_DB = Number(arg('snr', 8));
const OUT = arg('out', 'wer-sentence');

/** Short `segment` (seconds) trims the synthesized tail; SAPI pads each file. */
const TRIM_TAIL_SECONDS = Number(arg('trim', 0.12));

// Spoken verbatim, in this order, alternating voices. Words that a small model
// tends to lose (multi-syllable, similar-sounding, or only clear from context)
// are deliberately present — but these are ordinary sentences, not tongue
// twisters: the point is a fair listening task, not an impossible one.
const SEGMENTS = [
  { voice: 'Microsoft David Desktop', text: 'We should schedule the meeting for Thursday afternoon at half past three.' },
  { voice: 'Microsoft Zira Desktop', text: 'Their new apartment is bigger than the one they rented last year.' },
  { voice: 'Microsoft David Desktop', text: 'Please remember to bring the charger and the blue notebook tomorrow.' },
  { voice: 'Microsoft Zira Desktop', text: 'The weather forecast says it might rain heavily later this evening.' },
  { voice: 'Microsoft David Desktop', text: 'I think the recipe needs a little more salt and a lot less sugar.' },
  { voice: 'Microsoft Zira Desktop', text: 'The quick brown fox jumps over the lazy dog near the river bank.' },
];

// ── WAV reading ──────────────────────────────────────────────────────────
// SAPI writes a WAV with a `LIST`/`INFO` chunk before (and sometimes after) the
// data, so the format cannot be assumed to start at byte 44: walk the chunks.

function readWav(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path} is not a RIFF/WAVE file`);
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  if (!format || !data) throw new Error(`${path} has no fmt/data chunk`);
  if (format.bitsPerSample !== 16 || format.channels !== 1) {
    throw new Error(`expected 16-bit mono, got ${format.bitsPerSample}-bit x${format.channels}`);
  }
  const samples = new Float32Array(data.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  return { samples, sampleRate: format.sampleRate };
}

function writeWav(path, samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);          // PCM fmt chunk size
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(1, 22);           // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);           // block align
  header.writeUInt16LE(16, 34);          // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (samples.length || 1));
}

// ── synthesis (Windows only) ─────────────────────────────────────────────

function synthesize() {
  const work = mkdtempSync(join(tmpdir(), 'wer-fixture-'));
  const listPath = join(work, 'segments.json');
  const psPath = join(work, 'speak.ps1');
  writeFileSync(listPath, JSON.stringify(SEGMENTS.map((s) => ({ voice: s.voice, text: s.text, rate: RATE }))));
  // A script file rather than an inline command: the sentences contain quotes
  // and commas, and passing them through the shell mangles them.
  writeFileSync(psPath, [
    'param([string]$ListPath, [string]$OutDir)',
    'Add-Type -AssemblyName System.Speech',
    '$items = Get-Content -Raw -Path $ListPath | ConvertFrom-Json',
    '$i = 0',
    'foreach ($it in $items) {',
    '  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '  $s.SelectVoice($it.voice)',
    '  $s.Rate = [int]$it.rate',
    '  $path = Join-Path $OutDir ("seg{0}.wav" -f $i)',
    '  $s.SetOutputToWaveFile($path)',
    '  $s.Speak($it.text)',
    '  $s.Dispose()',
    '  $i++',
    '}',
  ].join('\n'));
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath, '-ListPath', listPath, '-OutDir', work], {
    stdio: 'inherit',
  });
  return {
    work,
    parts: SEGMENTS.map((_, i) => join(work, `seg${i}.wav`)),
  };
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// ── concatenation, noise, output ─────────────────────────────────────────

mkdirSync(fixtures, { recursive: true });
console.log(`synthesizing ${SEGMENTS.length} sentences at rate ${RATE}`);
const { work, parts } = synthesize();
for (const p of parts) {
  if (!existsSync(p)) throw new Error(`PowerShell did not write ${p}`);
}

const first = readWav(parts[0]);
const sampleRate = first.sampleRate;
const trim = Math.round(TRIM_TAIL_SECONDS * sampleRate);
// Deterministic broadband noise (a plain LCG: the same bytes on every run), so
// the committed fixture is reproducible rather than "roughly noisy".
let seed = 987654321;
let totalWords = 0;

SEGMENTS.forEach((segment, index) => {
  const { samples } = readWav(parts[index]);
  // SAPI pads the end of every file with silence; that tail is not part of the
  // sentence and would otherwise be scored as a gap.
  const speech = samples.length > trim ? samples.subarray(0, samples.length - trim) : samples;
  const speechRms = rms(speech);
  const noiseRms = speechRms / Math.pow(10, SNR_DB / 20);
  const out = new Float32Array(speech.length);
  for (let i = 0; i < speech.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const white = seed / 0x3fffffff - 1;            // uniform in [-1, 1)
    out[i] = speech[i] + white * noiseRms * 1.732;   // 1.732: uniform RMS → unit RMS
  }
  // Bring the peak down if speech plus noise clipped; measured, not assumed.
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0.95) {
    const scale = 0.95 / peak;
    for (let i = 0; i < out.length; i++) out[i] *= scale;
    console.log(`  ${OUT}-${index + 1}: peak ${peak.toFixed(3)} → scaled by ${scale.toFixed(3)}`);
  }
  const wavPath = join(fixtures, `${OUT}-${index + 1}.wav`);
  writeWav(wavPath, out, sampleRate);
  const words = segment.text.split(/\s+/).filter(Boolean).length;
  totalWords += words;
  console.log(
    `  ${OUT}-${index + 1}.wav  ${(statSync(wavPath).size / 1024).toFixed(0)} KB  ` +
    `${(out.length / sampleRate).toFixed(1)} s  ${words} words  (${segment.voice.split(' ')[1]}, rate ${RATE}, noise RMS ${noiseRms.toFixed(4)})`,
  );
});

const txtPath = join(fixtures, 'wer-suite.txt');
writeFileSync(txtPath, SEGMENTS.map((s) => s.text).join('\n') + '\n');
console.log(`${txtPath}  ${SEGMENTS.length} sentences, ${totalWords} reference words, nominal SNR ${SNR_DB} dB`);
cleanup(work);
