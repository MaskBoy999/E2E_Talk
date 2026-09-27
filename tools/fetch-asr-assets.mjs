#!/usr/bin/env node
/**
 * Vendor the bundled offline speech-recognition assets (captions).
 *
 *   node tools/fetch-asr-assets.mjs
 *
 * Downloads into static/vendor/asr/ :
 *
 *   transformers.min.js                 the @huggingface/transformers browser
 *                                       bundle (tokenizer + whisper pipeline +
 *                                       the onnxruntime-web JS glue)
 *   ort-wasm-simd-threaded.{mjs,wasm}   the wasm backend it loads at runtime
 *   config.json, preprocessor_config.json, tokenizer.json,
 *   tokenizer_config.json, generation_config.json
 *   onnx/encoder_model_quantized.onnx        ~10 MB
 *   onnx/decoder_model_merged_quantized.onnx ~31 MB
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
 * The whisper model is multilingual on purpose: the app is used in more than
 * one language, and a .en-only model would caption Romanian as gibberish.
 * quantized int8 keeps the whole thing at ~44 MB.
 *
 * Run this once after a clean checkout (the files are committed, so this is
 * normally a no-op); re-run it to bump the model.
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { get } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'static', 'vendor', 'asr');
const MODEL = 'https://huggingface.co/onnx-community/whisper-tiny/resolve/main';
const TRANSFORMERS = '@huggingface/transformers';
const ORT = 'onnxruntime-web';

const MODEL_FILES = [
  'config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'generation_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
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

mkdirSync(outDir, { recursive: true });
// The model lives in its own subdirectory: transformers.js resolves
// env.localModelPath + the model id as a path, so pipeline(task, 'whisper-tiny')
// with localModelPath '/vendor/asr/' reads /vendor/asr/whisper-tiny/... .
const modelDir = join(outDir, 'whisper-tiny');
mkdirSync(join(modelDir, 'onnx'), { recursive: true });

console.log('model files ->', modelDir);
for (const f of MODEL_FILES) {
  // Keep the repo-relative shape (`onnx/...`) so the weights land where the
  // library looks for them.
  const dest = join(modelDir, f);
  if (existsSync(dest) && statSync(dest).size > 1024) {
    console.log(`  ${dest.split(/[\\/]/).pop()} already present — skipping`);
    continue;
  }
  process.stdout.write(`  ${f}\n`);
  await fetchTo(`${MODEL}/${f}`, dest);
}

console.log('runtime packages');
const tmp = mkdtempSync(join(tmpdir(), 'asr-vendor-'));
// shell:true — npm is npm.cmd on Windows, and execFileSync cannot spawn a
// .cmd without a shell.
execFileSync('npm', ['pack', TRANSFORMERS, ORT, '--silent'], { cwd: tmp, stdio: 'inherit', shell: true });
for (const tgz of readdirSync(tmp).filter((f) => f.endsWith('.tgz'))) {
  execFileSync('tar', ['xzf', tgz], { cwd: tmp });
  const dist = join(tmp, 'package', 'dist');
  if (tgz.includes('transformers')) {
    copyFileSync(join(dist, 'transformers.min.js'), join(outDir, 'transformers.min.js'));
  } else {
    // Every wasm build ORT can ask for: the plain SIMD one, and the asyncify
    // pair it falls back to when threading is unavailable (no
    // cross-origin isolation), which is exactly our case.
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
  [modelDir, 'onnx/encoder_model_quantized.onnx'],
  [modelDir, 'onnx/decoder_model_merged_quantized.onnx'],
  [modelDir, 'tokenizer.json'],
]) {
  const p = join(...must);
  if (!existsSync(p)) throw new Error(`missing ${must[1]} after vendoring`);
  console.log(`  ${must[1]} ${(statSync(p).size / 1048576).toFixed(1)} MB`);
}
console.log('asr assets ready');
