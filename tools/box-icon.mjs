#!/usr/bin/env node
/**
 * One source icon → every platform.
 *
 * WHY THIS EXISTS
 *
 * The desktop app and the Android app shipped *different* artwork: `icons/icon.png`
 * was a filled blue chat bubble while the launcher icon on the phone was the
 * green line-art mark, which existed only as rasterised mipmaps inside
 * `src-tauri/gen/android/` — a directory that is gitignored and regenerated, so
 * the one icon nobody could rebuild was the one users actually saw on their home
 * screen. Anything generated there is also at the mercy of `tauri android init`,
 * which regenerates the Android icons from `bundle.icon`.
 *
 * So: one committed source of truth,
 *
 *     src-tauri/icons/source/box-icon.png
 *
 * and everything else is derived from it by `npm run icon`. To change the app
 * icon, replace that one file (square PNG, 1024×1024 ideally — 192×192 is what
 * the current mobile art could offer, and the CLI scales from it) and run the
 * script. Both the desktop bundle (`bundle.icon` → `icons/icon.png`, `icon.ico`)
 * and the Android launcher mipmaps come out of the same file, so they cannot
 * drift apart again.
 *
 * The heavy lifting is the pinned `tauri icon` command (`@tauri-apps/cli`, the
 * same version CI uses), which is why this is a thin wrapper rather than its own
 * PNG resizer: generating the full desktop set (ico/icns/png) by hand is exactly
 * the kind of thing that quietly produces a broken `.ico`.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'src-tauri/icons/source/box-icon.png');
const ICONS = join(root, 'src-tauri/icons');
const ANDROID_RES = join(root, 'src-tauri/gen/android/app/src/main/res');

if (!existsSync(SOURCE)) {
    console.error(
        `No icon source at ${SOURCE}.\n` +
            'Put a square PNG there (the single source of truth for every platform) and run this again.'
    );
    process.exit(1);
}

// Generate into a scratch directory first: `tauri icon` always emits the desktop
// set *and* android/ios subdirectories, and we only want the desktop files in
// src-tauri/icons (the mobile ones belong in the generated project, which is
// gitignored and rebuilt by CI).
const scratch = mkdtempSync(join(tmpdir(), 'box-icon-'));
try {
    console.log(`Generating icons from ${SOURCE} …`);
    execFileSync('npx', ['tauri', 'icon', SOURCE, '-o', scratch], {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });

    // ── Desktop ──────────────────────────────────────────────────────────
    // `bundle.icon` in tauri.conf.json points at icons/icon.png and
    // icons/icon.ico; the rest of the desktop set is what Tauri's bundlers pick
    // from (and what Windows/macOS want at each size).
    mkdirSync(ICONS, { recursive: true });
    for (const entry of readdirSync(scratch)) {
        if (entry === 'android' || entry === 'ios') continue;
        cpSync(join(scratch, entry), join(ICONS, entry));
        console.log(`  icons/${entry}`);
    }

    // ── Android ──────────────────────────────────────────────────────────
    // Only when the generated project happens to exist locally: it is gitignored
    // and recreated by `tauri android init`, so this is a convenience for local
    // builds (and keeps the phone's launcher icon identical to the desktop's
    // until the next init, which now derives them from the same source too).
    const androidScratch = join(scratch, 'android');
    if (existsSync(ANDROID_RES) && existsSync(androidScratch)) {
        for (const entry of readdirSync(androidScratch)) {
            const from = join(androidScratch, entry);
            const to = join(ANDROID_RES, entry);
            cpSync(from, to, { recursive: true });
        }
        console.log('  gen/android/app/src/main/res/mipmap-*');
    }
    console.log('Done — desktop and mobile icons now come from the same file.');
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
