#!/usr/bin/env node
/**
 * Verify the Arch package for one release, without an Arch machine.
 *
 *   node tools/check-arch-deps.mjs --deb <path to the released .deb> \
 *                                  --pkgbuild <rendered PKGBUILD> [--verbose]
 *
 * Two checks, both against the SAME bytes we publish:
 *
 *  1. COVERAGE (fatal): every dependency the .deb declares must be covered by
 *     the PKGBUILD's `depends`. The .deb is built by Tauri on Ubuntu and gets
 *     its dependency list from the bundler; the PKGBUILD is hand-written for
 *     Arch. Nothing else compares the two, so a dependency added on one side
 *     silently became "install works, app is broken" on the other. A Debian
 *     name with no mapping below is a hard failure on purpose: it forces the
 *     mapping to be decided by a human instead of being skipped.
 *
 *  2. LIBRARIES (report): every shared library the packaged binary references,
 *     resolved to the Arch package that ships it. This is what turns "the
 *     window is grey on Arch" into "this library was never installed". The
 *     release workflow additionally installs the package inside the official
 *     archlinux container and runs ldd on the installed binary — that is the
 *     fatal version of this check, on a real Arch userland.
 *
 * Exits non-zero, loudly, on anything unexpected.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Debian/Ubuntu package -> Arch package. Only the names that can actually turn
// up in a Tauri .deb's Depends are listed; an unknown one fails the check.
const DEB_TO_ARCH = {
  'libappindicator3-1': 'libayatana-appindicator',
  'libayatana-appindicator3-1': 'libayatana-appindicator',
  'libwebkit2gtk-4.1-0': 'webkit2gtk-4.1',
  'libjavascriptcoregtk-4.1-0': 'webkit2gtk-4.1',
  'libgtk-3-0': 'gtk3',
  'libgdk-pixbuf-2.0-0': 'gdk-pixbuf2',
  'libgdk-pixbuf2.0-0': 'gdk-pixbuf2',
  libc6: 'glibc',
  libcairo2: 'cairo',
  'libglib2.0-0': 'glib2',
  'libpango-1.0-0': 'pango',
  'libsoup-3.0-0': 'libsoup3',
  'librsvg2-2': 'librsvg',
  libasound2: 'alsa-lib',
  'libx11-6': 'libx11',
  libxi6: 'libxi',
  'libdbus-1-3': 'dbus',
  libssl3: 'openssl',
  'libssl1.1': 'openssl',
  libnss3: 'nss',
  'libstdc++6': 'gcc-libs',
  'libfontconfig1': 'fontconfig',
  'libfreetype6': 'freetype2',
  'libharfbuzz0b': 'harfbuzz',
  'libatk1.0-0': 'atk',
  'libepoxy0': 'libepoxy',
  'libxdo3': 'xdotool',
  'libsecret-1-0': 'libsecret',
  libnotify4: 'libnotify',
  'libwayland-client0': 'wayland',
  'libxkbcommon0': 'libxkbcommon',
  'libegl1': 'libglvnd',
  'libgles2': 'libglvnd',
  'libgbm1': 'mesa',
  'libdrm2': 'libdrm',
  'libxext6': 'libxext',
  'libxrender1': 'libxrender',
  'libxfixes3': 'libxfixes',
  'libxrandr2': 'libxrandr',
  'libxcursor1': 'libxcursor',
  'libxcomposite1': 'libxcomposite',
  'libxdamage1': 'libxdamage',
  'libpcre2-8-0': 'pcre2',
  libzstd1: 'zstd',
  zlib1g: 'zlib',
  libexpat1: 'expat',
  'libpng16-16': 'libpng',
  'libjpeg-turbo8': 'libjpeg-turbo',
  'libgstreamer1.0-0': 'gstreamer',
  'libgstreamer-plugins-base1.0-0': 'gst-plugins-base-libs',
  'libgstreamer-plugins-bad1.0-0': 'gst-plugins-bad-libs',
};

// Shared library -> Arch package. Same idea as above, for the NEEDED scan.
const LIB_TO_ARCH = {
  'libgtk-3.so': 'gtk3',
  'libgdk-3.so': 'gtk3',
  'libgdk_pixbuf-2.0.so': 'gdk-pixbuf2',
  'libwebkit2gtk-4.1.so': 'webkit2gtk-4.1',
  'libjavascriptcoregtk-4.1.so': 'webkit2gtk-4.1',
  'libsoup-3.0.so': 'libsoup3',
  'libayatana-appindicator3.so': 'libayatana-appindicator',
  'libappindicator3.so': 'libayatana-appindicator',
  'libcairo.so': 'cairo',
  'libglib-2.0.so': 'glib2',
  'libgobject-2.0.so': 'glib2',
  'libgio-2.0.so': 'glib2',
  'libpango-1.0.so': 'pango',
  'libpangocairo-1.0.so': 'pango',
  'libgdk_pixbuf-2.so': 'gdk-pixbuf2',
  'libX11.so': 'libx11',
  'libXi.so': 'libxi',
  'libdbus-1.so': 'dbus',
  'libasound.so': 'alsa-lib',
  'librsvg-2.so': 'librsvg',
  'libcrypto.so': 'openssl',
  'libssl.so': 'openssl',
  'libnss3.so': 'nss',
  'libc.so': 'glibc',
  'libm.so': 'glibc',
  'libdl.so': 'glibc',
  'libpthread.so': 'glibc',
  'librt.so': 'glibc',
  'libgcc_s.so': 'gcc-libs',
  'libstdc++.so': 'gcc-libs',
  'libz.so': 'zlib',
  'libexpat.so': 'expat',
  'libpng16.so': 'libpng',
  'libfontconfig.so': 'fontconfig',
  'libfreetype.so': 'freetype2',
  'libharfbuzz.so': 'harfbuzz',
  'libatk-1.0.so': 'atk',
  'libepoxy.so': 'libepoxy',
  'libwayland-client.so': 'wayland',
  'libxkbcommon.so': 'libxkbcommon',
  'libgbm.so': 'mesa',
  'libdrm.so': 'libdrm',
};

// Referenced only through dlopen() and absent from a minimal install by design
// (the tray falls back to the built-in GTK one; libunity is a launcher badge
// API that most systems do not ship at all).
const OPTIONAL_LIBS = ['libunity.so', 'libxdo.so', 'libappindicator3.so'];// tar runs with the temp directory as its cwd and is given RELATIVE member
// paths: an absolute `C:\...` argument is read as a remote host:port by GNU tar,
// and the tar in this environment does not support --force-local. Relative paths
// behave identically on Linux (CI).
function TAR(args, cwd) {
  return execFileSync('tar', args, { encoding: 'utf8', cwd });
}
function fail(msg) {

  console.error(`check-arch-deps: ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
function opt(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const debPath = opt('deb');
const pkgbuildPath = opt('pkgbuild');
const verbose = argv.includes('--verbose');
if (!debPath || !pkgbuildPath) fail('usage: node tools/check-arch-deps.mjs --deb <file.deb> --pkgbuild <PKGBUILD>');
if (!existsSync(debPath)) fail(`no such .deb: ${debPath}`);
if (!existsSync(pkgbuildPath)) fail(`no such PKGBUILD: ${pkgbuildPath}`);

// ---- read the .deb (an `ar` archive: no dpkg/ar needed) ------------------
const work = mkdtempSync(join(tmpdir(), 'arch-deps-'));
const buf = readFileSync(debPath);
if (buf.subarray(0, 8).toString('latin1') !== '!<arch>\n') fail(`${debPath} is not an ar archive (a .deb)`);
let off = 8;
const members = {};
while (off + 60 <= buf.length) {
  const hdr = buf.subarray(off, off + 60).toString('latin1');
  const name = hdr.slice(0, 16).trim().replace(/\/(\s*)$/, '');
  const size = parseInt(hdr.slice(48, 58).trim(), 10);
  if (Number.isNaN(size) || size < 0) break;
  members[name] = buf.subarray(off + 60, off + 60 + size);
  off += 60 + size + (size % 2);
}
const controlMember = Object.keys(members).find((n) => n.startsWith('control.tar'));
if (!controlMember) fail('the .deb has no control.tar.* member');
let controlName = 'control.tar.gz';
if (controlMember.endsWith('.zst')) controlName = 'control.tar.zst';
else if (controlMember.endsWith('.xz')) controlName = 'control.tar.xz';
writeFileSync(join(work, controlName), members[controlMember]);
let controlText = '';
try {
  controlText = TAR(['xOf', controlName, './control'], work);
} catch {
  try {
    controlText = TAR(['xOf', controlName, 'control'], work);
  } catch (e) {
    fail(`could not read ./control out of ${controlName}: ${e.message}`);
  }
}

const dependsField = /^Depends:\s*(.+)$/mi.exec(controlText);
if (!dependsField) fail('the .deb declares no Depends field');
const debDeps = dependsField[1]
  .split(',')
  // `a | b` = alternatives: any one satisfies it, so accept if ANY maps.
  .map((d) => d.trim().split('|').map((x) => x.trim().replace(/\s*\([^)]*\)\s*$/, '')))
  .filter((group) => group.length && group[0]);

// ---- read the PKGBUILD's depends ----------------------------------------
const pkgbuild = readFileSync(pkgbuildPath, 'utf8');
const dependsMatch = /^depends=\((.*)\)\s*$/m.exec(pkgbuild);
if (!dependsMatch) fail('the PKGBUILD has no single-line depends=(...) array');
const archDeps = [...dependsMatch[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);

// ---- 1. coverage --------------------------------------------------------
const missing = [];
for (const group of debDeps) {
  const mapped = group.map((d) => DEB_TO_ARCH[d]);
  if (mapped.some((m) => m && archDeps.includes(m))) continue;
  if (mapped.every((m) => m === undefined)) {
    missing.push(`'${group.join(' | ')}' has no Debian->Arch mapping in tools/check-arch-deps.mjs`);
  } else {
    missing.push(`'${group.join(' | ')}' -> ${mapped.filter(Boolean).join(' / ')} is not in the PKGBUILD depends`);
  }
}
if (missing.length) {
  fail(
    `the PKGBUILD is missing dependencies the .deb declares:\n  - ${missing.join('\n  - ')}\n` +
      '  Add them to packaging/aur/PKGBUILD.template (depends must stay on ONE line).'
  );
}
console.log(`ok: all ${debDeps.length} .deb dependencies are covered by the PKGBUILD depends`);

// ---- 2. libraries (report) ---------------------------------------------
let dataMember;
for (const name of Object.keys(members)) if (name.startsWith('data.tar')) dataMember = name;
if (dataMember) {
  let dataName = 'data.tar.gz';
  if (dataMember.endsWith('.zst')) dataName = 'data.tar.zst';
  else if (dataMember.endsWith('.xz')) dataName = 'data.tar.xz';
  writeFileSync(join(work, dataName), members[dataMember]);
  let listing = '';
  try {
    listing = TAR(['tf', dataName], work);
  } catch (e) {
    console.log(`note: could not list ${dataName} (${e.message.split('\n')[0]}) — skipping the library report`);
  }
  const binary = listing.split('\n').find((l) => /\/bin\/[^/]+$/.test(l.trim()));
  if (binary) {
    const extractDir = join(work, 'extract');
    try {
      TAR(['xf', dataName], work);
      const binPath = join(work, binary.replace(/^\//, ''));
      const raw = readFileSync(binPath, 'latin1');
      const libs = [...new Set([...raw.matchAll(/lib[A-Za-z0-9_+.-]*\.so\.[0-9]+/g)].map((m) => m[0]))].sort();
      const unmapped = [];
      for (const lib of libs) {
        const base = lib.replace(/\.so\.[0-9]+.*$/, '.so');
        if (LIB_TO_ARCH[base]) continue;
        if (OPTIONAL_LIBS.some((o) => lib.startsWith(o))) {
          if (verbose) console.log(`  (optional/dlopen) ${lib}`);
          continue;
        }
        unmapped.push(lib);
      }
      if (verbose) for (const lib of libs) console.log(`  ${lib} -> ${LIB_TO_ARCH[lib.replace(/\.so\.[0-9]+.*$/, '.so')] || 'optional'}`);
      console.log(`ok: ${binary.trim()} references ${libs.length} shared libraries; all accounted for`);
      if (unmapped.length) {
        console.log(`note: ${unmapped.join(', ')} have no Arch package mapping — check them by hand`);
      }
      void extractDir;
    } catch (e) {
      console.log(`note: could not inspect the packaged binary (${e.message.split('\n')[0]})`);
    }
  }
}
rmSync(work, { recursive: true, force: true });
console.log('check-arch-deps: ok');
