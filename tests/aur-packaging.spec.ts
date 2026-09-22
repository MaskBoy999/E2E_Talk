import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The AUR package is rendered by tools/aur-render.mjs from
// packaging/aur/PKGBUILD.template. The dangerous failures are silent ones:
// a .SRCINFO that no longer matches its PKGBUILD (the AUR rejects the push),
// a source URL that no longer names the asset Tauri actually publishes (every
// Arch user hits a 404), or a workflow gate wired so the step either never
// runs or runs without the secret. All three are checkable without Arch, so
// they are checked here — on any OS, in milliseconds, with a fake version.

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

test.describe('AUR packaging', () => {
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

  test('the release workflow publishes the AUR package on tag pushes only', () => {
    const wf = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');

    const start = wf.indexOf('- name: Publish PKGBUILD to the AUR');
    expect(start, 'AUR publish step missing from release.yml').toBeGreaterThan(-1);
    const next = wf.indexOf('- name:', start + 10);
    const block = wf.slice(start, next === -1 ? undefined : next);

    // Tag pushes only, Linux leg only (that is where the .deb lives), and
    // skipped until the secret exists — a step `if:` cannot read `secrets`,
    // so the key must be surfaced as job env first (the WINDOWS_CERTIFICATE
    // trick).
    expect(block).toContain("startsWith(github.ref, 'refs/tags/')");
    expect(block).toContain('ubuntu-22.04');
    expect(block).toContain("env.AUR_SSH_KEY != ''");
    expect(wf).toContain('AUR_SSH_KEY: ${{ secrets.AUR_SSH_KEY }}');
    // The hash comes from the checksum file users verify, not a fresh sum.
    expect(block).toContain('SHA256SUMS-linux-x64.txt');
    // …and the lookup tolerates the fact that the checksum file names the deb
    // with a SPACE ("E2E Chat_…", written from the on-disk basename) while the
    // asset/PKGBUILD URL uses dots — `$2 == f` alone matches nothing and would
    // abort every publish.
    expect(block).toMatch(/i=3; i<=NF/);
    // And the release notes tell Arch users how to install.
    expect(wf).toContain('yay -S e2e-chat-bin');
  });
});
