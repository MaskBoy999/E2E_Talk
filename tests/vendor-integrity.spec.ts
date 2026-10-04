// Vendored-code integrity (the second half of finding 9).
//
// The app ships its parsers and loaders rather than loading them from a CDN —
// `static/libs/*` (docx-preview, SheetJS, PDF.js, PapaParse, JSZip, pdf-lib)
// and `static/vendor/*` (the QR reader, the ASR stack and its ONNX Runtime
// wasm). They execute in the origin that holds the key chain, so the question
// this test answers is the one a reviewer asks: *is the file that shipped the
// file that was reviewed?*
//
// `tools/vendor-checksums.json` records a SHA-256 for every executable vendored
// file, and `node tools/vendor-checksums.mjs` regenerates it. A file that is
// added, removed or modified without regenerating the manifest fails here — a
// silent swap is exactly the supply-chain failure mode finding 9 describes.
//
// This is a repo-level tripwire, not a runtime protection: it says nothing
// about the moment the page loads the file. That layer is the CSP (finding 2)
// plus the fact that no vendored file is fetched from a third-party origin.
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'tools', 'vendor-checksums.json');

type Manifest = Record<string, string>;

function sha256(rel: string): string {
    return createHash('sha256').update(readFileSync(path.join(ROOT, rel))).digest('hex');
}

test.describe('vendored code is hash-pinned', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;

    test('the manifest covers the executables it claims to', () => {
        expect(Object.keys(manifest).length, 'an empty manifest proves nothing').toBeGreaterThan(5);
        for (const rel of Object.keys(manifest)) {
            expect(rel, 'manifest keys are repo-relative POSIX paths').toMatch(/^static\/(libs|vendor)\/.+\.(js|mjs|wasm)$/);
        }
        // The parsers the review named are in there, not just any file.
        for (const named of ['static/libs/docx-preview.min.js', 'static/libs/xlsx.full.min.js', 'static/libs/pdf.min.js']) {
            expect(Object.keys(manifest), `${named} must be pinned`).toContain(named);
        }
    });

    test('every pinned file still hashes to the reviewed value', () => {
        for (const [rel, expected] of Object.entries(manifest)) {
            expect(sha256(rel), `${rel} changed — if that upgrade was intended, regenerate with: node tools/vendor-checksums.mjs`)
                .toBe(expected);
        }
    });
});
