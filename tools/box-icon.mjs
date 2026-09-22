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
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'src-tauri/icons/source/box-icon.png');
const ICONS = join(root, 'src-tauri/icons');
const ANDROID_RES = join(root, 'src-tauri/gen/android/app/src/main/res');
const WEB_ICONS = join(root, 'static/icons');

// The app's own background colour (the one the source artwork sits on). Only
// used for the maskable icon, where the artwork has to be inset.
const ICON_BG = '#0d0d1a';

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
    // ── Web / PWA ────────────────────────────────────────────────────────
    // Everything the browser can see: the tab icon, the home-screen icon, the
    // browser-notification icon and the push badge. All of it is rasterised
    // here from the same source, because a web app icon has to be a PNG — the
    // manifest used to declare an SVG, which Chrome and Android ignore for
    // installs, so the installed app fell back to a generic placeholder.
    await writeWebIcons();

    console.log('Done — desktop, mobile and web icons now come from the same file.');
} finally {
    rmSync(scratch, { recursive: true, force: true });
}

/**
 * Write the browser-visible icon set. `canvas` is already a project dependency
 * (it is what the icon pipeline uses elsewhere), and it is only ever needed
 * here — which is why it is imported lazily, so `npm run icon` still works in
 * an install that skipped native modules.
 */
async function writeWebIcons() {
    const { loadImage, createCanvas } = await import('canvas');
    const src = await loadImage(SOURCE);
    mkdirSync(WEB_ICONS, { recursive: true });

    const sized = (size, inset = 0) => {
        const c = createCanvas(size, size);
        const ctx = c.getContext('2d');
        if (inset > 0) {
            ctx.fillStyle = ICON_BG;
            ctx.fillRect(0, 0, size, size);
        }
        const inner = size - inset * 2;
        ctx.drawImage(src, inset, inset, inner, inner);
        return c.toBuffer('image/png');
    };

    for (const size of [192, 512]) {
        writeFileSync(join(WEB_ICONS, `icon-${size}.png`), sized(size));
        console.log(`  static/icons/icon-${size}.png`);
    }

    // iOS ignores the web manifest and uses this one for the home screen.
    writeFileSync(join(WEB_ICONS, 'apple-touch-icon.png'), sized(180));
    console.log('  static/icons/apple-touch-icon.png');

    // Maskable: the launcher may crop up to 20% off every edge, so the artwork
    // is drawn at 80% with the margin filled by the app's own background.
    writeFileSync(join(WEB_ICONS, 'icon-maskable-512.png'), sized(512, Math.round(512 * 0.1)));
    console.log('  static/icons/icon-maskable-512.png');

    // Notification badge: Chrome and Android paint it as a white silhouette on
    // the system colour, so the bright artwork is kept and the dark background
    // dropped — a full-colour bitmap comes out as a solid blob.
    const badge = createCanvas(96, 96);
    const bctx = badge.getContext('2d');
    bctx.drawImage(src, 0, 0, 96, 96);
    const data = bctx.getImageData(0, 0, 96, 96);
    for (let i = 0; i < data.data.length; i += 4) {
        const lum = (data.data[i] + data.data[i + 1] + data.data[i + 2]) / 3;
        // Soft ramp instead of a hard cut, so the ring outlines stay smooth.
        const a = Math.max(0, Math.min(1, (lum - 40) / 70));
        data.data[i] = 255;
        data.data[i + 1] = 255;
        data.data[i + 2] = 255;
        data.data[i + 3] = Math.round(255 * a);
    }
    bctx.putImageData(data, 0, 0);
    writeFileSync(join(WEB_ICONS, 'badge-96.png'), badge.toBuffer('image/png'));
    console.log('  static/icons/badge-96.png');

    // `favicon.ico` is what a browser asks for when a page has no <link rel=icon>
    // — and a hand-rolled .ico is exactly the kind of thing that quietly comes
    // out broken, so the one the desktop bundler just produced is copied.
    cpSync(join(ICONS, 'icon.ico'), join(root, 'static/favicon.ico'));
    console.log('  static/favicon.ico');
}
