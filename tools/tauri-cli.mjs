#!/usr/bin/env node
/**
 * The project's Tauri CLI entry point (`npm run tauri …`).
 *
 * tauri-action builds by running *this* script, which is why the one thing CI
 * needs and the CLI cannot know on its own lives here: where the bundles go.
 *
 * The repository's root `.cargo/config.toml` redirects cargo's target dir to
 * `<root>/.cache/e2e-target`, because the checkout filesystem on the developer's
 * machine corrupts Rust metadata. Everything in `.github/workflows/release.yml`
 * — the "Verify installers were produced" guard that fails the job when the
 * bundle is empty, the upload globs, the attestation subject, the checksum and
 * signature steps — reads `src-tauri/target/release/bundle`. That mismatch is
 * exactly how v0.2.48 built successfully on both platforms and then failed with
 * zero installers found.
 *
 * So in CI (where the filesystem is a clean ephemeral disk and the redirect does
 * nothing useful) the target dir is pinned to `src-tauri/target`; locally nothing
 * changes, and an explicit CARGO_TARGET_DIR always wins.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.env.CI && !process.env.CARGO_TARGET_DIR) {
    process.env.CARGO_TARGET_DIR = path.join(root, 'src-tauri', 'target');
}

const bin = process.env.E2E_TAURI_BIN
    || path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');

const child = spawn(bin, process.argv.slice(2), {
    stdio: 'inherit',
    env: process.env,
    // A .cmd shim on Windows has to go through the shell; the POSIX shim does not.
    shell: process.platform === 'win32',
});
child.on('error', (e) => {
    console.error(`tauri: could not run ${bin}: ${e.message}`);
    process.exit(127);
});
child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
});
