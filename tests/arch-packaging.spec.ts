import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The Arch package is built in CI from packaging/aur/PKGBUILD.template
// (rendered by tools/aur-render.mjs) inside an archlinux container, and
// attached to the release for `pacman -U`. The dangerous failures are silent
// ones: a source URL that no longer names the asset Tauri actually publishes
// (every Arch user hits a 404), a .SRCINFO that drifts from its PKGBUILD, or
// a workflow gate wired wrong — and especially any push to the AUR, which
// needs an account this project does not have and would fail every release.
// All checkable without Arch, so they are checked here — on any OS, in
// milliseconds, with a fake version.

const ROOT = process.cwd();
const FAKE_VER = '9.9.9';
const FAKE_SHA = 'ab'.repeat(32); // 64 hex chars, as sha256sum emits
const PKGNAME = 'e2e-chat-bin';

function render(extraArgs: string[] = []) {
  const out = mkdtempSync(join(tmpdir(), 'aur-render-'));
  const res = spawnSync(
    'node',
    ['tools/aur-render.mjs', '--pkgver', FAKE_VER, '--sha256', FAKE_SHA, '--outdir', out, ...extraArgs],
    { cwd: ROOT, encoding: 'utf8' },
  );
  return { out, res };
}

test.describe('Arch packaging', () => {
  test('renders a PKGBUILD pinned to this release and the real .deb name', () => {
    const { out, res } = render();
    try {
      expect(res.status, res.stderr).toBe(0);
      const pkg = readFileSync(join(out, 'PKGBUILD'), 'utf8');

      expect(pkg).toContain(`pkgname=${PKGNAME}`);
      expect(pkg).toContain(`pkgver=${FAKE_VER}`);
      // The asset name is what Tauri publishes — verified by hand against the
      // v0.2.21 release: E2E.Chat_0.2.21_amd64.deb.
      expect(pkg).toContain(
        `/releases/download/v${FAKE_VER}/E2E.Chat_${FAKE_VER}_amd64.deb`,
      );
      expect(pkg).toContain(FAKE_SHA);
      // Both placeholders substituted everywhere, including comments.
      expect(pkg).not.toContain('@PKGVER@');
      expect(pkg).not.toContain('@SHA256@');
      // Runtime deps that the app cannot do without.
      expect(pkg).toContain('webkit2gtk-4.1'); // the Tauri webview
      expect(pkg).toContain('libayatana-appindicator'); // the tray icon
      // The .install scriptlet referenced by install= must travel with it.
      expect(existsSync(join(out, `${PKGNAME}.install`))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test('.SRCINFO mirrors the PKGBUILD — the AUR rejects any drift', () => {
    const { out, res } = render();
    try {
      expect(res.status, res.stderr).toBe(0);
      const src = readFileSync(join(out, '.SRCINFO'), 'utf8');

      expect(src.startsWith(`pkgbase = ${PKGNAME}\n`)).toBe(true);
      expect(src.trimEnd().endsWith(`pkgname = ${PKGNAME}`)).toBe(true);
      expect(src).toContain(`\tpkgver = ${FAKE_VER}`);
      expect(src).toContain(`\tsha256sums_x86_64 = ${FAKE_SHA}`);
      expect(src).toContain(
        `\tsource_x86_64 = https://github.com/MaskBoy999/E2E_Talk/releases/download/v${FAKE_VER}/E2E.Chat_${FAKE_VER}_amd64.deb`,
      );
      expect(src).toContain('\tdepends = webkit2gtk-4.1');
      expect(src).toContain(`\tinstall = ${PKGNAME}.install`);
      // Fully expanded: no bash variables, no placeholders — the AUR parses
      // .SRCINFO as data, not as bash.
      expect(src).not.toContain('$');
      expect(src).not.toContain('@PKGVER@');
      expect(src).not.toContain('@SHA256@');
      // Between the unindented `pkgbase` header and the unindented `pkgname`
      // trailer, every line is a tab-indented `key = value` field.
      const lines = src.split('\n');
      const trailer = lines.lastIndexOf(`pkgname = ${PKGNAME}`);
      expect(trailer).toBeGreaterThan(1);
      for (const line of lines.slice(1, trailer).filter(Boolean)) {
        expect(line, line).toMatch(/^\t[a-z0-9_]+ = .+$/);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test('refuses bad input rather than publishing an unverifiable package', () => {
    const out = mkdtempSync(join(tmpdir(), 'aur-render-'));
    try {
      const badSha = spawnSync(
        'node',
        ['tools/aur-render.mjs', '--pkgver', FAKE_VER, '--sha256', 'nothex', '--outdir', out],
        { cwd: ROOT, encoding: 'utf8' },
      );
      expect(badSha.status).not.toBe(0);
      expect(badSha.stderr).toContain('64 hex');

      const badVer = spawnSync(
        'node',
        ['tools/aur-render.mjs', '--pkgver', '../evil', '--sha256', FAKE_SHA, '--outdir', out],
        { cwd: ROOT, encoding: 'utf8' },
      );
      expect(badVer.status).not.toBe(0);
      expect(badVer.stderr).toContain('pkgver');

      const noArgs = spawnSync('node', ['tools/aur-render.mjs'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      expect(noArgs.status).not.toBe(0);
      expect(noArgs.stderr).toContain('usage');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test('the release workflow builds the pacman package on tag pushes, never the AUR', () => {
    const wf = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');

    const start = wf.indexOf('- name: Build Arch package (pacman)');
    expect(start, 'Arch build step missing from release.yml').toBeGreaterThan(-1);
    const next = wf.indexOf('- name:', start + 10);
    const block = wf.slice(start, next === -1 ? undefined : next);

    // Tag pushes only, Linux leg only (that is where the .deb lives), and the
    // build must happen in an Arch container — GitHub has no Arch runner —
    // with makepkg producing the artifact and pacman itself reading it back.
    expect(block).toContain("startsWith(github.ref, 'refs/tags/')");
    expect(block).toContain('ubuntu-22.04');
    expect(block).toContain('archlinux:base-devel');
    expect(block).toContain('makepkg');
    expect(block).toContain('pacman -Qp'); // CI reads the artifact back…
    expect(block).toContain('PKGVER'); // …and asserts it matches the tag

    // No AUR account exists: nothing may push there — a reintroduced push
    // step would fail every release on the missing key.
    expect(wf).not.toContain('aur.archlinux.org');
    expect(wf).not.toContain('AUR_SSH_KEY');
    expect(wf).not.toContain('yay -S');

    // The package joins the checksum list users verify, is attached to the
    // release, and the release notes name the install command.
    expect(wf).toContain("-name '*.pkg.tar.zst'");
    expect(wf).toContain('dist/*.pkg.tar.zst');
    expect(wf).toContain('pacman -U');
  });

  test('the repo ships the LICENSE file the AUR guidelines require', () => {
    // The AUR submission guidelines ask the upstream repo to carry a license
    // file, and package.json has always declared ISC — the three must agree,
    // or the package would advertise a license nothing backs (and a
    // placeholder like <holder> would slip straight onto the AUR page).
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const license = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
    expect(pkg.license).toBe('ISC');
    expect(license).toContain('ISC License');
    expect(license).toContain('Copyright (c) 2026 Dorcu Eduard-Daniel');
    expect(license).toContain('Permission to use, copy, modify, and/or distribute');
    expect(license).not.toMatch(/<holder>|YOUR NAME|TODO/i);
  });
});
