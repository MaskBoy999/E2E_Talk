// The bundled on-device speech models, checked as *shipped assets*.
//
// Live captions decode with whisper, running in wasm from files the server next
// to the app serves out of `static/vendor/asr/`. Nothing about that is checked
// by running a model: a release can be missing a directory, a file, or a MIME
// type and still "build". What breaks then is captioning, on the machine of
// whoever installed the new version, with no obvious link back to packaging.
//
// This matters specifically today because the second model (whisper-base, ~76 MB
// of weights next to whisper-tiny's ~42 MB) was added, and because the server
// sends `X-Content-Type-Options: nosniff` — so a file served as the wrong type
// is not sniffed into working, it is refused.
//
// So for every runtime file and every file of both models this asserts:
//   1. it is served (200) from the app's own origin;
//   2. the bytes are the real file (Content-Length matches what is on disk);
//   3. the MIME type is one the browser will actually accept, given nosniff.
//
// …and that the worker which reads them names both models and never reaches for
// anything off-origin (the vendoring that replaced the old CDN, applied to the
// ASR path).
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { join } from 'node:path';

const PORT = Number(process.env.E2E_TEST_PORT || 3443);
const STATIC_ASR = join(__dirname, '..', 'static', 'vendor', 'asr');

/** Headers only: the models are tens of megabytes, so the body is dropped. */
function head(pathname: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
        const r = https.request(
            { host: 'localhost', port: PORT, method: 'GET', path: pathname, rejectUnauthorized: false },
            (res) => {
                resolve({ status: res.statusCode || 0, headers: res.headers });
                res.destroy();
            },
        );
        r.on('error', reject);
        r.end();
    });
}

function get(pathname: string): Promise<{ status: number; data: string }> {
    return new Promise((resolve, reject) => {
        const r = https.request(
            { host: 'localhost', port: PORT, method: 'GET', path: pathname, rejectUnauthorized: false },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => resolve({ status: res.statusCode || 0, data }));
            },
        );
        r.on('error', reject);
        r.end();
    });
}

/** The wasm runtime the worker loads, and the two model graph directories. */
const RUNTIME = [
    'transformers.min.js',
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.wasm',
    'ort-wasm-simd-threaded.jsep.mjs',
    'ort-wasm-simd-threaded.jsep.wasm',
    'ort-wasm-simd-threaded.jspi.mjs',
    'ort-wasm-simd-threaded.jspi.wasm',
];

const MODEL_FILES = [
    'config.json',
    'generation_config.json',
    'preprocessor_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/encoder_model_quantized.onnx',
    'onnx/decoder_model_merged_quantized.onnx',
];

const MODELS = ['whisper-tiny', 'whisper-base'];

/** What the browser needs for each extension, under `nosniff`. */
function expectedMime(path: string): string {
    if (path.endsWith('.json')) return 'application/json';
    if (path.endsWith('.mjs') || path.endsWith('.js')) return 'application/javascript';
    if (path.endsWith('.wasm')) return 'application/wasm';
    // The ONNX graphs have no registered type; octet-stream is what fetch() wants.
    return 'application/octet-stream';
}

test.describe('bundled ASR assets', () => {
    test('both whisper models and the wasm runtime are served, with usable types', async () => {
        const rels = [...RUNTIME, ...MODELS.flatMap((m) => MODEL_FILES.map((f) => `${m}/${f}`))];
        expect(rels.length, 'sanity: runtime plus both models').toBe(RUNTIME.length + MODELS.length * MODEL_FILES.length);

        const problems: string[] = [];
        for (const rel of rels) {
            const onDisk = join(STATIC_ASR, rel);
            expect(fs.existsSync(onDisk), `${rel} must be in the repository (it has to ship)`).toBe(true);
            const size = fs.statSync(onDisk).size;
            // Every model file is a real payload, not an empty placeholder that
            // would fail only at the first decode.
            expect(size, `${rel} is suspiciously small`).toBeGreaterThan(100);

            const res = await head(`/vendor/asr/${rel}`);
            if (res.status !== 200) { problems.push(`${rel}: HTTP ${res.status}`); continue; }
            const len = Number(res.headers['content-length']);
            if (len !== size) problems.push(`${rel}: served ${len} bytes, expected ${size}`);
            const want = expectedMime(rel);
            const got = String(res.headers['content-type'] || '');
            if (!got.includes(want)) problems.push(`${rel}: content-type "${got}" will be refused under nosniff (want ${want})`);
        }
        expect(problems, `bundled caption assets are broken:\n${problems.join('\n')}`).toEqual([]);

        // Discriminating: a path that does not exist must 404, so the 200s above
        // are a real file server and not a catch-all.
        const missing = await head('/vendor/asr/whisper-base/onnx/not-a-model.onnx');
        expect(missing.status).toBe(404);
    });

    test('the worker is served locally, names both models, and reaches for no other origin', async () => {
        const r = await get('/captions-asr-worker.js');
        expect(r.status).toBe(200);

        // Both bundled models are named, because that is the whole point of the
        // second one being vendored.
        expect(r.data).toContain('whisper-tiny');
        expect(r.data).toContain('whisper-base');
        // Every read is pinned to the app's own /vendor/asr/ tree.
        expect(r.data).toContain("localModelPath = '/vendor/asr/'");
        expect(r.data).toContain("wasmPaths = '/vendor/asr/'");
        // No off-origin reference at all: the models cannot silently become a
        // CDN download at runtime, which is what made the app need the network.
        expect(r.data, 'the ASR path must not name any external origin').not.toMatch(/https?:\/\//);
    });
});
