#!/usr/bin/env node
/**
 * Vendor the QR *scanner* that index.html used to load from a public CDN.
 *
 *   node tools/fetch-qr-assets.mjs
 *
 * Writes static/vendor/jsqr/jsQR.js (the browser bundle, loaded as a classic
 * script, exposing the global `jsQR`).
 *
 * WHY THIS IS VENDORED AND NOT LINKED
 *
 * index.html loaded jsQR and qrcode-generator from cdn.jsdelivr.net, with SRI
 * attributes. SRI is a real protection against a *changed* file, but it is not a
 * protection against the CDN being in the critical path at all: a third-party
 * origin in `script-src` is a party that can serve code into an origin which
 * holds decrypted messages, keys and the session token, and it also means the
 * app cannot start without the internet reaching a vendor that has nothing to do
 * with the product. The app's whole posture is "nothing leaves your server", so
 * the scripts now ship with it and the CSP names no external origin.
 *
 * (qrcode-generator turned out not to need vendoring: static/qrcode.js already
 * IS that library — same Kazuhiko Arase implementation, same `qrcode(0,'M')` /
 * `addData` / `make` / `createSvgTag({cellSize, margin})` API — so its CDN tag
 * was deleted rather than replaced. Verified by generating a code with both and
 * comparing the output: 25 modules at cellSize 3 + margin 4 → 83px either way.)
 *
 * The download is verified against the **SRI value the HTML carried**, i.e. the
 * SHA-384 that every browser already refused to execute without. That is a
 * better anchor than "the file we happened to download": a mismatch means the
 * CDN is serving something other than what the app has been running, and this
 * script then refuses to write anything at all.
 *
 * Re-run it to bump the version — change VERSION and EXPECTED_SRI together.
 */
import { createHash } from 'node:crypto';
import { get } from 'node:https';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.4.0';
const URL_ = `https://cdn.jsdelivr.net/npm/jsqr@${VERSION}/dist/jsQR.js`;
/** sha384 of that exact file — the integrity attribute index.html used to carry. */
const EXPECTED_SRI = 'sha384-b5Ya4Bq3qCyz39m2ISh+4DxjAIljdeFwK/BsXLuj9gugaNwAcj/ia15fxNZL9Nlx';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'static', 'vendor', 'jsqr');

function fetch(url, depth = 0) {
    return new Promise((resolve, reject) => {
        if (depth > 5) return reject(new Error('too many redirects'));
        get(url, { headers: { 'user-agent': 'e2e-chat-qr-vendor' } }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                res.resume();
                return fetch(new URL(res.headers.location, url).toString(), depth + 1).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`${url} -> HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
    });
}

const body = await fetch(URL_);
const sri = 'sha384-' + createHash('sha384').update(body).digest('base64');
const sha256 = createHash('sha256').update(body).digest('hex');

if (sri !== EXPECTED_SRI) {
    console.error(`refusing to vendor: ${URL_}`);
    console.error(`  expected ${EXPECTED_SRI}`);
    console.error(`  got      ${sri}`);
    process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'jsQR.js');
writeFileSync(out, body);

console.log(`vendored jsQR ${VERSION} -> static/vendor/jsqr/jsQR.js`);
console.log(`  bytes  ${body.length}`);
console.log(`  sha384 ${sri}  (matches the SRI index.html carried)`);
console.log(`  sha256 ${sha256}`);
