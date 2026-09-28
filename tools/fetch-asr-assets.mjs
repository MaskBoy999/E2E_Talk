#!/usr/bin/env node
/**
 * Vendor the bundled offline speech-recognition assets (captions).
 *
 *   node tools/fetch-asr-assets.mjs                      # every model
 *   node tools/fetch-asr-assets.mjs --models whisper-base # one of them
 *
 * Downloads into static/vendor/asr/ :
 *
 *   transformers.min.js                 the @huggingface/transformers browser
 *                                       bundle (tokenizer + whisper pipeline +
 *                                       the onnxruntime-web JS glue)
 *   ort-wasm-simd-threaded.{mjs,wasm}   the wasm backend it loads at runtime,
 *                                       the threaded build (see the note on
 *                                       cross-origin isolation at the bottom)
 *   <model>/config.json, preprocessor_config.json, tokenizer.json,
 *   tokenizer_config.json, generation_config.json
 *   <model>/onnx/encoder_model_quantized.onnx
 *   <model>/onnx/decoder_model_merged_quantized.onnx
 *
 * Two models are vendored because accuracy and latency trade off against each
 * other and only the user can make that call per machine:
 *
 *   whisper-tiny  ~44 MB  the default: keeps up with a call on a CPU
 *   whisper-base  ~80 MB  markedly fewer wrong words, roughly twice the work
 *
 * Settings → Live Captions picks between them (`captions_model`), and the
 * worker resolves the id as a directory under /vendor/asr/.
 *
 * The ONNX weights live in the model's `onnx/` SUBDIRECTORY, because that is
 * where transformers.js resolves them (the community `onnx-community/*` repos
 * put the quantized exports there). Writing them one level up as well only
 * doubles the size of the vendored tree for files nothing ever requests.
 *
 * WHY THIS IS DOWNLOADED AND NOT FETCHED AT RUNTIME:
 * captions transcribe DECRYPTED call audio, so nothing may leave the device.
 * A CDN script tag or a remote model fetch would both hand a third party the
 * code path that touches that audio, and the app's own CSP (connect-src 'self')
 * would not allow it anyway. Everything here is served by the user's own server
 * out of static/, which is the only origin the webview can reach.
 *
 * The whisper models are multilingual on purpose: the app is used in more than
 * one language, and a .en-only model would caption Romanian as gibberish.
 * quantized int8 is what keeps the sizes above.
 *
 * Run this once after a clean checkout (the files are committed, so this is
 * normally a no-op); re-run it to bump a model.
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { get } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'static', 'vendor', 'asr');
const TRANSFORMERS = '@huggingface/transformers';
const ORT = 'onnxruntime-web';

const HF = 'https://huggingface.co';
const MODEL_FILES = [
  'config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'generation_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];
// The directories under static/vendor/asr/ are the model ids the worker asks
// for, so they must match `MODELS` in static/captions-asr-worker.js.
const MODELS = [
  { id: 'whisper-tiny', repo: 'onnx-community/whisper-tiny' },
  { id: 'whisper-base', repo: 'onnx-community/whisper-base' },
];

function fetchTo(url, dest) {
  return new Promise((resolve, reject) => {
    get(url, { headers: { 'user-agent': 'e2e-chat-asr-vendor' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        // HuggingFace hands back a RELATIVE Location for resolve/main URLs.
        return fetchTo(new URL(res.headers.location, url).toString(), dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${url} -> HTTP ${res.statusCode}`));
      }
      const total = Number(res.headers['content-length'] || 0);
      const file = createWriteStream(dest);
      let seen = 0;
      res.on('data', (c) => {
        seen += c.length;
        if (total) {
          const pct = Math.round((seen / total) * 100);
          if (pct % 20 === 0) process.stdout.write(`\r  ${dest.split(/[\\/]/).pop()} ${pct}%`);
        }
      });
      res.pipe(file);
      file.on('finish', () => { file.close(() => resolve(dest)); });
      file.on('error', reject);
    }).on('error', reject);
  });
}

/** `--models a,b` limits the run (used by CI and by a targeted re-vendor). */
function wanted() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--models');
  if (i === -1 || !argv[i + 1]) return MODELS;
  const want = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
  const picked = MODELS.filter((m) => want.includes(m.id));
  if (picked.length !== want.length) {
    throw new Error(`--models takes vendored model ids (${MODELS.map((m) => m.id).join(', ')})`);
  }
  return picked;
}

mkdirSync(outDir, { recursive: true });

const models = wanted();
for (const model of models) {
  // The model lives in its own subdirectory: transformers.js resolves
  // env.localModelPath + the model id as a path, so pipeline(task, 'whisper-base')
  // with localModelPath '/vendor/asr/' reads /vendor/asr/whisper-base/... .
  const modelDir = join(outDir, model.id);
  mkdirSync(join(modelDir, 'onnx'), { recursive: true });
  console.log(`${model.id} ->`, modelDir);
  for (const f of MODEL_FILES) {
    // Keep the repo-relative shape (`onnx/...`) so the weights land where the
    // library looks for them.
    const dest = join(modelDir, f);
    if (existsSync(dest) && statSync(dest).size > 1024) {
      console.log(`  ${dest.split(/[\\/]/).pop()} already present — skipping`);
      continue;
    }
    process.stdout.write(`  ${f}\n`);
    await fetchTo(`${HF}/${model.repo}/resolve/main/${f}`, dest);
  }
}

// `--skip-runtime` is for adding a model to a tree that already has the bundles
// (the wasm builds are ~70 MB of npm package to download for files that are
// byte-identical to the ones already on disk).
const skipRuntime = process.argv.includes('--skip-runtime');
if (skipRuntime) {
  if (!existsSync(join(outDir, 'transformers.min.js')) || !existsSync(join(outDir, 'ort-wasm-simd-threaded.wasm'))) {
    throw new Error('--skip-runtime, but the runtime bundles are not vendored yet');
  }
  console.log('runtime packages skipped (--skip-runtime)');
}
const tmp = skipRuntime ? null : mkdtempSync(join(tmpdir(), 'asr-vendor-'));
if (tmp) console.log('runtime packages');
// shell:true — npm is npm.cmd on Windows, and execFileSync cannot spawn a
// .cmd without a shell.
if (tmp) execFileSync('npm', ['pack', TRANSFORMERS, ORT, '--silent'], { cwd: tmp, stdio: 'inherit', shell: true });
for (const tgz of (tmp ? readdirSync(tmp) : []).filter((f) => f.endsWith('.tgz'))) {
  execFileSync('tar', ['xzf', tgz], { cwd: tmp });
  const dist = join(tmp, 'package', 'dist');
  if (tgz.includes('transformers')) {
    copyFileSync(join(dist, 'transformers.min.js'), join(outDir, 'transformers.min.js'));
  } else {
    // Every wasm build ORT can ask for: the threaded one (used when the page is
    // cross-origin isolated, which the app's own headers make it) and the
    // asyncify pair it falls back to when threading is unavailable.
    for (const f of readdirSync(dist)) {
      if (/^ort-wasm.*\.(mjs|js|wasm)$/.test(f)) copyFileSync(join(dist, f), join(outDir, f));
    }
  }
  rmSync(join(tmp, 'package'), { recursive: true, force: true });
}

// The vendored bundles are copied VERBATIM. `static/vendor/**` is listed in
// .github/secret_scanning.yml precisely so that stays true: this minified
// third-party file contains identifiers that are shaped like API keys, and
// rewriting them would make the vendored tree differ from the npm package it
// came from for no benefit.

// Sanity: the whisper pipeline cannot start without these.
for (const must of [
  [outDir, 'transformers.min.js'],
  [outDir, 'ort-wasm-simd-threaded.wasm'],
  ...models.flatMap((m) => [
    [outDir, m.id, 'onnx/encoder_model_quantized.onnx'],
    [outDir, m.id, 'onnx/decoder_model_merged_quantized.onnx'],
    [outDir, m.id, 'tokenizer.json'],
  ]),
]) {
  const p = join(...must);
  if (!existsSync(p)) throw new Error(`missing ${must.slice(1).join('/')} after vendoring`);
  console.log(`  ${must.slice(1).join('/')} ${(statSync(p).size / 1048576).toFixed(1)} MB`);
}
console.log('asr assets ready');
