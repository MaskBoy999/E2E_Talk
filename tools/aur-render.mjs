#!/usr/bin/env node
/**
 * Render the AUR package for one release.
 *
 *   node tools/aur-render.mjs --pkgver 0.2.21 --sha256 <64 hex> --outdir <dir>
 *
 * Writes three files into --outdir:
 *
 *   PKGBUILD              packaging/aur/PKGBUILD.template with @PKGVER@ and
 *                         @SHA256@ filled from this release.
 *   .SRCINFO              the machine-readable digest of that PKGBUILD. The
 *                         AUR rejects any push whose .SRCINFO does not match
 *                         its PKGBUILD, and the only official way to produce
 *                         one is `makepkg --printsrcinfo` — an Arch tool that
 *                         does not exist on the Ubuntu release runners. So it
 *                         is derived here FROM the rendered PKGBUILD itself:
 *                         one source of truth, two outputs, no drift possible.
 *   e2e-chat-bin.install  copied verbatim (referenced by `install=`).
 *
 * Exits non-zero, loudly, on anything unexpected — a missing header field, an
 * unknown placeholder, a checksum that is not 64 hex chars, an install file
 * that does not match pkgname. A push to the AUR made from bad input is
 * strictly worse than no push at all, because the next release is what would
 * overwrite it.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const templateDir = join(root, 'packaging', 'aur');
const ALLOWED_PLACEHOLDERS = new Set(['@PKGVER@', '@SHA256@']);
// Emitted to .SRCINFO in this order (mirrors makepkg's own ordering). Fields
// not listed here are parsed but never published.
const SRCINFO_FIELDS = [
  'pkgdesc', 'pkgver', 'pkgrel', 'url', 'install', 'arch', 'license',
  'depends', 'options', 'noextract', 'source_x86_64', 'sha256sums_x86_64',
];
const REQUIRED_FIELDS = [
  'pkgname', 'pkgver', 'pkgrel', 'pkgdesc', 'arch', 'url', 'license',
  'depends', 'install', 'options', 'noextract', 'source_x86_64',
  'sha256sums_x86_64',
];

function fail(msg) {
  console.error(`aur-render: ${msg}`);
  process.exit(1);
}

// ---- arguments ----------------------------------------------------------
const argv = process.argv.slice(2);
function opt(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const pkgver = opt('pkgver');
const sha256Raw = opt('sha256');
const outdir = opt('outdir');
if (!pkgver || !sha256Raw || !outdir) {
  fail('usage: node tools/aur-render.mjs --pkgver <ver> --sha256 <64 hex> --outdir <dir>');
}
if (!/^[0-9][0-9A-Za-z.+-]*$/.test(pkgver)) {
  fail(`--pkgver '${pkgver}' is not a version number`);
}
if (!/^[0-9a-f]{64}$/i.test(sha256Raw)) {
  fail('--sha256 must be 64 hex characters (the .deb\'s hash from SHA256SUMS-linux-x64.txt)');
}
const sha256 = sha256Raw.toLowerCase();

// ---- render the template ------------------------------------------------
const template = readFileSync(join(templateDir, 'PKGBUILD.template'), 'utf8');
for (const token of template.match(/@[A-Za-z_]+@/g) ?? []) {
  if (!ALLOWED_PLACEHOLDERS.has(token)) {
    fail(`unknown placeholder ${token} in PKGBUILD.template (allowed: ${[...ALLOWED_PLACEHOLDERS].join(', ')})`);
  }
}
const pkgbuild = template
  .replaceAll('@PKGVER@', pkgver)
  .replaceAll('@SHA256@', sha256);

// ---- parse the header (everything before the first function) -----------
// A PKGBUILD is bash, but the header this template generates is a flat list
// of single-line assignments, so a line-wise parse is enough — and it keeps
// .SRCINFO provably derived from the PKGBUILD rather than hand-maintained
// next to it. Multi-line arrays are rejected instead of silently truncated.
function parseHeader(text) {
  const fields = {};
  for (const line of text.split('\n')) {
    if (/^[a-z0-9_]+\(\)\s*\{/.test(line)) break; // package() ends the header
    const m = line.match(/^([a-z0-9_]+)=(.*)$/);
    if (!m) continue; // comments and blanks
    const [, key, rawValue] = m;
    const value = rawValue.trim();
    if (value.startsWith('(') && !value.endsWith(')')) {
      fail(`header field '${key}' spans multiple lines — keep every array on one line (see the note at the top of PKGBUILD.template)`);
    }
    fields[key] = value.startsWith('(')
      ? [...value.matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2])
      : [value.replace(/^(['"])([\s\S]*)\1$/, '$2')];
  }
  return fields;
}
const fields = parseHeader(pkgbuild);

for (const key of REQUIRED_FIELDS) {
  if (!fields[key] || fields[key].length === 0) {
    fail(`PKGBUILD header is missing '${key}'`);
  }
}
if (fields.pkgver[0] !== pkgver) fail('pkgver field does not match --pkgver');
if (fields.sha256sums_x86_64[0] !== sha256) fail('sha256sums_x86_64 does not match --sha256');
const sourceUrl = fields.source_x86_64.join(' ');
if (!sourceUrl.includes(`/v${pkgver}/`)) fail(`source is not pinned to v${pkgver}: ${sourceUrl}`);
if (!fields.depends.includes('webkit2gtk-4.1')) {
  fail('webkit2gtk-4.1 must stay in depends — the app cannot run without the Tauri webview');
}
const install = fields.install[0];
if (install !== `${fields.pkgname[0]}.install`) {
  fail(`install= is '${install}' but pkgname is '${fields.pkgname[0]}' (expected '${fields.pkgname[0]}.install')`);
}
if (!existsSync(join(templateDir, install))) fail(`install scriptlet '${install}' not found in packaging/aur/`);

// ---- .SRCINFO -----------------------------------------------------------
// A PKGBUILD is bash; a couple of values reference other variables. Only the
// handful this package actually uses are expanded — deliberately not a bash
// evaluator, just enough to publish literal values.
function expand(v) {
  return v
    .replaceAll('${pkgver}', pkgver)
    .replaceAll('$pkgver', pkgver)
    .replaceAll('${pkgname}', fields.pkgname[0])
    .replaceAll('$pkgname', fields.pkgname[0]);
}
function toSrcinfo() {
  const lines = [`pkgbase = ${fields.pkgname[0]}`];
  for (const key of SRCINFO_FIELDS) {
    for (const v of fields[key] ?? []) lines.push(`\t${key} = ${expand(v)}`);
  }
  lines.push('', `pkgname = ${fields.pkgname[0]}`);
  return `${lines.join('\n')}\n`;
}

// ---- write everything ---------------------------------------------------
mkdirSync(outdir, { recursive: true });
writeFileSync(join(outdir, 'PKGBUILD'), pkgbuild);
writeFileSync(join(outdir, '.SRCINFO'), toSrcinfo());
copyFileSync(join(templateDir, install), join(outdir, install));

console.log(`aur-render: ${fields.pkgname[0]} ${pkgver} -> ${outdir}`);
console.log(`  PKGBUILD  ${fields.source_x86_64[0]}`);
console.log(`  sha256    ${sha256}`);
console.log(`  files     PKGBUILD, .SRCINFO, ${install}`);
