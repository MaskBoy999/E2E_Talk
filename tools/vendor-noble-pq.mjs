// One-off vendoring pass for @noble/post-quantum.
//
//     node tools/vendor-noble-pq.mjs
//
// jsDelivr's `+esm` bundles keep every dependency import as an absolute
// `/npm/@scope/pkg@version/…/+esm` specifier — fine when the page is served by
// jsDelivr, broken (and CSP-blocked) when the app serves the files itself.
// This script downloads the closure the two post-quantum modules need, rewrites
// every specifier to a relative sibling path, and writes the dependencies under
// static/libs/noble/ with the two entry points in static/libs/. Re-running it is
// how an upstream version bump is vendored; afterwards regenerate the checksum
// manifest (node tools/vendor-checksums.mjs) and the KAT fixture
// (node tools/gen-pq-kat.mjs), and update static/libs/noble-post-quantum.pin.json.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIBS = join(ROOT, 'static', 'libs');
const DEPS = join(LIBS, 'noble');
const CDN = 'https://cdn.jsdelivr.net';

const VERSION = '0.7.1';
const CLOSURE = {
    [`/npm/@noble/post-quantum@${VERSION}/ml-kem.js/+esm`]: 'noble-post-quantum-0.7.1-ml-kem.js',
    [`/npm/@noble/post-quantum@${VERSION}/ml-dsa.js/+esm`]: 'noble-post-quantum-0.7.1-ml-dsa.js',
};

// Local filename for a dependency module, e.g.
// `/npm/@noble/hashes@2.4.0/sha3.js/+esm` → noble-hashes-2.4.0-sha3.js
function localName(path) {
    return path
        .replace(/^\/npm\//, '')
        .replace(/\/?\+esm$/, '')
        .replace(/@/g, '-')
        .replace(/[\/:]/g, '-')
        .replace(/^-/, '');
}

const seen = new Map(); // remote path → { local, dir }
mkdirSync(DEPS, { recursive: true });
const queue = Object.keys(CLOSURE);
for (const [remote, local] of Object.entries(CLOSURE)) seen.set(remote, { local, dir: LIBS });

while (queue.length) {
    const remotePath = queue.shift();
    if (!seen.has(remotePath)) seen.set(remotePath, { local: localName(remotePath), dir: DEPS });
    const { local, dir } = seen.get(remotePath);
    const src = await (await fetch(CDN + remotePath)).text();
    // Rewrite every absolute CDN specifier to a relative sibling: entry points
    // (in static/libs) reach into ./noble/, dependencies stay inside ./.
    const prefix = dir === LIBS ? './noble/' : './';
    const rewritten = src.replace(/\/npm\/[^"']+\/\+esm/g, (spec) => {
        const specLocal = localName(spec);
        if (!seen.has(spec)) {
            seen.set(spec, { local: specLocal, dir: DEPS });
            queue.push(spec);
        }
        return prefix + (CLOSURE[spec] || specLocal);
    });
    writeFileSync(join(dir, local), rewritten);
    console.log(`${local}  <-  ${remotePath}`);
}

console.log('\nSHA-256 pins:');
for (const [remote, local] of Object.entries(CLOSURE)) {
    const bytes = readFileSync(join(LIBS, local));
    console.log(createHash('sha256').update(bytes).digest('hex') + '  ' + 'static/libs/' + local);
}
