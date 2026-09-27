import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Publishing is the part of a release that fails QUIETLY, and it did, three
// tags running: v0.2.22 shipped with binaries but no checksums, and v0.2.24
// shipped with only the two Windows bundles — which took the Arch step down
// with it, because makepkg downloads the .deb from that very release.
//
// Two causes, both pinned here:
//   1. softprops/action-gh-release cannot complete a release that already
//      exists ("already_exists", then "Resource not accessible by
//      integration ... update-a-release"). A tag push that has to be re-run
//      could therefore never finish its release.
//   2. Publishing was split over tauri-action AND softprops, so the two matrix
//      legs raced over one release object — after which a leg's assets
//      silently never uploaded while its job still went green.
//
// One publisher now: `gh release upload --clobber`, idempotent by design, and
// it runs BEFORE the Arch step that repacks the .deb it just published. These
// are text assertions on purpose — no YAML dependency, readable on any OS.

const root = process.cwd();
const read = (f: string) => readFileSync(join(root, '.github', 'workflows', f), 'utf8');
// Comments in these files explain what USED to run (that history is worth
// keeping), so assertions about what runs today ignore comment lines — which
// also means a stray mention can never satisfy a "must contain" check.
const code = (wf: string) =>
  wf
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
const WORKFLOWS: Array<[string, string]> = [
  ['release.yml', read('release.yml')],
  ['android.yml', read('android.yml')],
];

test.describe('release publishing', () => {
  test('every workflow publishes through one idempotent gh uploader', () => {
    for (const [name, raw] of WORKFLOWS) {
      const wf = code(raw);
      // The uploader that cannot re-run a release must not come back.
      expect(wf, name).not.toContain('softprops');
      expect(wf, name).toContain('gh release upload');
      // --clobber is what makes re-running a tag finish the release instead of
      // dying on assets that already exist.
      expect(wf, name).toContain('--clobber');
      // Publishing is tag-only; a manual run must stay artifact-only.
      expect(wf, name).toContain("startsWith(github.ref, 'refs/tags/')");
      // ...and it needs write access, or it fails as silently as before.
      expect(wf, name).toContain('contents: write');
      expect(wf, name).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
      // Creating a release and uploading to it work with this token; PATCHing
      // one (gh release edit, or softprops updating) does not — it comes back
      // "Resource not accessible by integration" and would fail the step that
      // carries the APK / installers, so it must never be attempted.
      expect(wf, name).not.toContain('gh release edit');
      expect(wf, name).toContain('gh release view');
    }
  });

  // v0.2.33 published TWO release objects for a single tag: one with all ten
  // assets and one empty, and /releases/latest resolved to the empty one, so
  // the public download page showed no files at all. GitHub's tag_name
  // uniqueness check is not atomic, so simultaneous creators both succeed.
  // Three were racing: tauri-action on each matrix leg (tagName/releaseBody make
  // it create a release) plus the `gh release create` fallback in the publish
  // step. Creation now happens in one dedicated job that every build leg waits
  // for, and nothing else may create.
  test('exactly one actor creates the release object', () => {
    for (const [name, raw] of WORKFLOWS) {
      const wf = code(raw);
      const creates = wf.match(/gh release create/g) ?? [];
      // tauri-action's own create is not a `gh release create` line, so the
      // keys that switch it on are asserted separately below.
      expect(creates.length, `${name} must have ${name === 'release.yml' ? 1 : 0} release creator(s)`).toBe(
        name === 'release.yml' ? 1 : 0,
      );
      // Without these tauri-action builds only — it never touches the release.
      expect(wf, name).not.toContain('tagName:');
      expect(wf, name).not.toContain('releaseBody:');
    }
    const [, wf] = WORKFLOWS[0];
    expect(wf).toContain('needs: create-release');
    // The creator must come before the job that uploads to what it creates.
    const creator = wf.indexOf('  create-release:');
    const build = wf.indexOf('  build:');
    expect(creator, 'the create-release job is missing from release.yml').toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(creator);
  });

  test('the release is published before the Arch step repacks its .deb', () => {
    const [, wf] = WORKFLOWS[0];
    const publish = wf.indexOf('- name: Publish release assets');
    const arch = wf.indexOf('- name: Build Arch package (pacman)');
    expect(publish, 'the publisher is missing from release.yml').toBeGreaterThan(-1);
    expect(arch, 'the Arch step is missing from release.yml').toBeGreaterThan(-1);
    // Order is the whole point: makepkg fetches the .deb over HTTPS from the
    // release, so publishing after it would 404 exactly as it did on v0.2.24.
    expect(publish).toBeLessThan(arch);
    const block = wf.slice(publish, arch);
    expect(block).toContain('*.deb');
    // The Linux bundles this leg built are what gets uploaded — not whatever
    // some other actor managed to attach.
    expect(block).toContain('src-tauri/target/release/bundle/');
    // A missing bundle is a loud failure, never a release without binaries.
    expect(block).toContain('::error::');
  });

  test('the Android leg attaches its APK and checksums together or not at all', () => {
    const [, wf] = WORKFLOWS[1];
    expect(wf).toContain('files=(dist/*.apk dist/SHA256SUMS-android.txt)');
    expect(wf).toContain('::error::');
  });

  test('checksum lists cover exactly the published bundles', () => {
    const [, raw] = WORKFLOWS[0];
    const start = raw.indexOf('- name: Generate checksums');
    const end = raw.indexOf('- name: Attach checksums to release');
    expect(start, 'the checksum step is missing from release.yml').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = code(raw.slice(start, end));
    // Scoped to the bundle output — never all of target/, whose cargo
    // build-script intermediates (51 .exe files) polluted the Windows list.
    expect(block).toContain('src-tauri/target/release/bundle');
    expect(block).not.toContain('find src-tauri/target -type f');
    // Every published bundle type must appear — the .rpm was missing before.
    for (const ext of ['.exe', '.msi', '.AppImage', '.deb', '.rpm']) {
      expect(block, `the checksum list must cover ${ext}`).toContain(`-name '*${ext}'`);
    }
    // The related "Verify installers were produced" guard had the same
    // whole-target glob — narrow it too, or the count can never prove a bundle
    // is missing.
    const verifyStart = raw.indexOf('- name: Verify installers were produced');
    const verifyEnd = raw.indexOf('- name: Upload installers (manual run)');
    expect(verifyStart, 'the verify step is missing').toBeGreaterThan(-1);
    expect(verifyEnd).toBeGreaterThan(verifyStart);
    const verify = code(raw.slice(verifyStart, verifyEnd));
    expect(verify).toContain('src-tauri/target/release/bundle');
    expect(verify).not.toContain('find src-tauri/target -type f');
  });
});
