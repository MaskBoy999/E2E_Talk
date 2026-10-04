// Regenerate the vendored-code hash manifest (finding 9's "hash-pin the
// vendored JS" half).
//
//     node tools/vendor-checksums.mjs
//
// The manifest (tools/vendor-checksums.json) records the SHA-256 of every
// executable vendored file: static/libs/*.js (the document parsers) and every
// .js/.mjs/.wasm under static/vendor/ (the ASR/QR bundles, including the
// ONNX Runtime wasm). tests/vendor-integrity.spec.ts recomputes them, so a
// silently modified or swapped parser/loader fails CI instead of shipping.
//
// Deliberately NOT hashed: the model/data files under static/vendor/asr
// (whisper-*.onnx, tokenizer.json, …). They are data, not code, and they are
// 200 MB — they would make every test run hash a quarter of a gigabyte to say
// nothing about what executes in the page.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'tools', 'vendor-checksums.json');

/** Directories to walk, and which extensions count as executable code. */
const ROOTS = ['static/libs', 'static/vendor'];
const CODE_EXTENSIONS = ['.js', '.mjs', '.wasm'];

function walk(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else out.push(full);
    }
    return out;
}

const files = ROOTS.flatMap((rel) => walk(join(ROOT, rel)))
    .filter((f) => CODE_EXTENSIONS.some((ext) => f.endsWith(ext)))
    .map((f) => relative(ROOT, f).split(sep).join('/'))
    .sort();

const manifest = {};
for (const rel of files) {
    manifest[rel] = createHash('sha256').update(readFileSync(join(ROOT, rel))).digest('hex');
}

writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${Object.keys(manifest).length} hashes to ${relative(ROOT, MANIFEST)}`);
