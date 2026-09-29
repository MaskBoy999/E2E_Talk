import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
// The extracted run blocks are checked with bash itself, so make sure bash is
// there (Linux CI and Git Bash on Windows; skipped rather than failed on a
// host without it).
const hasBash = spawnSync('bash', ['-c', 'true']).status === 0;
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
      expect(wf, name).toContain('gh release view');
      // `gh release edit` is no longer banned outright, but android.yml still
      // has no business editing a release — see the draft tests below for the
      // one thing release.yml may do with it, and why.
      if (name === 'android.yml') expect(wf, name).not.toContain('gh release edit');
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
      // Count INVOCATIONS, not mentions: the step also echoes gh's own message
      // back as a warning, and "gh release create for v... failed" inside a
      // quoted string is not a second creator. A real call is a line that
      // begins with the command.
      const creates = wf.match(/^\s*gh release create\b/gm) ?? [];
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
    // The creator runs `gh`, and gh resolves the repository from the git
    // remote: a job with no checkout is not inside a repository at all, so
    // every `gh release` call in it fails. That is exactly how v0.2.34's first
    // attempt died — "Create release" was the only failing step while the
    // build legs (which do check out) are where gh has always worked.
    const creatorJob = wf.slice(creator, build);
    expect(creatorJob, 'the release creator must check the repository out').toContain(
      'uses: actions/checkout',
    );
    // Belt and braces: the repo is named outright, so the call is correct even
    // without a checkout to resolve it from.
    expect(creatorJob, 'the creator should name the repository explicitly').toContain('-R "$repo"');
  });

  // v0.2.35's release object was created and immediately became a DRAFT, and a
  // draft is invisible to anonymous readers: /releases/latest skips it, the
  // download page lists nothing, and its own assets 404 — which is how the
  // Linux leg died, with makepkg unable to fetch the .deb that leg had just
  // uploaded ("curl: (22) The requested URL returned error: 404"). GitHub does
  // that to the release of a just-deleted tag, ASYNCHRONOUSLY and by design
  // (cli/cli#8458) — and moving a tag is this repo's normal recovery after a
  // failed release run, so it is not a one-off. The workflow therefore has to
  // publish the draft itself.
  //
  // Note what the `gh release edit` here is and is not. It is `--draft=false`
  // and nothing else: that call was PROVEN against this repository when the
  // stuck v0.2.35 release was published by hand. Rewriting notes/title/target is
  // still the thing that came back "Resource not accessible by integration",
  // so the assertion below pins the only form allowed.
  test('a draft release is published, at both ends of the window before the Arch download', () => {
    const [, raw] = WORKFLOWS[0];
    const createJob = raw.slice(raw.indexOf('  create-release:'), raw.indexOf('  build:'));
    const publishAt = raw.indexOf('- name: Publish release assets');
    const archAt = raw.indexOf('- name: Build Arch package (pacman)');
    expect(publishAt, 'the publisher is missing from release.yml').toBeGreaterThan(-1);
    expect(archAt).toBeGreaterThan(publishAt);
    const publish = raw.slice(publishAt, archAt);

    // Both ends, because they are minutes apart: a gate in the create job
    // cannot see a forced-draft that lands while the installers are building,
    // and that is exactly the window the Arch step downloads in.
    for (const [where, block] of [
      ['create-release', createJob],
      ['Publish release assets', publish],
    ] as const) {
      expect(block, `${where} must ask whether the release is a draft`).toContain(
        '--json isDraft --jq .isDraft',
      );
      // Retried with a re-read: forcing a draft is asynchronous, so one check
      // can race the very event it is looking for.
      expect(block, `${where} must retry publishing the draft`).toMatch(/for attempt in \$\(seq 1 6\)/);
      // Loud when it cannot: a release nobody can download must not look green.
      expect(block, `${where} must annotate a release left as a draft`).toContain('::error::');
      expect(block, `${where} must name the root cause`).toContain('cli/cli#8458');
      // ...and never a moment before the step that downloads from the release.
      if (where === 'Publish release assets') expect(publishAt).toBeLessThan(archAt);
    }

    const edits = code(raw).match(/gh release edit[^\n]*/g) ?? [];
    expect(edits.length, 'both gates should publish the draft').toBeGreaterThanOrEqual(2);
    for (const line of edits) {
      expect(line, 'publishing a draft is the only edit allowed').toContain('--draft=false');
      for (const forbidden of ['--notes', '--title', '--target', '--draft=true']) {
        expect(line, `renaming or annotating the release is not allowed: ${line}`).not.toContain(forbidden);
      }
    }
  });

  test('a failed release creation explains itself, and the read-back retries', () => {
    const [, wf] = WORKFLOWS[0];
    const creatorJob = wf.slice(wf.indexOf('  create-release:'), wf.indexOf('  build:'));

    // gh's message is the only explanation available: job logs need
    // authentication even on a public repo, so a bare failure here is
    // "Process completed with exit code 1" and nothing else. That is all the
    // v0.2.35 tag produced — while leaving behind a release with no assets,
    // because `build` needs this job and never started.
    expect(creatorJob, 'the create must keep gh stderr').toContain('create-release.err');
    expect(creatorJob, 'the failure must be annotated, not just an exit code').toMatch(/::error::/);
    // And the release is read back with retries before the legs may upload to
    // it: a view issued in the same breath as a create can be a moment behind
    // it, and one un-retried check is what the v0.2.35 failure looks like.
    expect(creatorJob, 'the read-back must retry').toMatch(/for _ in \$\(seq 1 10\)/);
    expect(creatorJob, 'the read-back must report its own failure').toContain('read-back.err');
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

  // These steps do not run until a tag is pushed, and a shell syntax error in
  // one of them fails the job with a bare exit code (job logs need
  // authentication even on this public repo) at the exact moment a release is
  // half-published. Parsing every run block with bash beforehand turns that
  // into a red test on the commit that introduced it.
  test('every run block parses as bash before a tag ever executes it', () => {
    const out = mkdtempSync(join(tmpdir(), 'wf-steps-'));
    try {
      const res = spawnSync(
        'node',
        ['tools/extract-workflow-steps.mjs', '.github/workflows/release.yml', out],
        { cwd: root, encoding: 'utf8' },
      );
      expect(res.status, `the extractor failed: ${res.stderr}`).toBe(0);
      const scripts = readdirSync(out).filter((f) => f.endsWith('.sh'));
      // The two pwsh steps are skipped by the extractor, so this is the count
      // of BASH steps — and it must not silently collapse to zero if the
      // extractor stops recognising them.
      expect(scripts.length, 'release.yml should have bash steps').toBeGreaterThan(3);
      expect(res.stdout).toContain('skipping Import Windows code signing certificate');

      if (!hasBash) {
        test.skip(true, 'bash is not available on this host');
        return;
      }
      for (const name of scripts) {
        const scriptPath = join(out, name);
        // GitHub expands `${{ ... }}` before bash sees it; a literal one here
        // is not something bash can be expected to parse.
        const script = readFileSync(scriptPath, 'utf8').replace(/\$\{\{[^}]*\}\}/g, 'EXPR');
        writeFileSync(scriptPath, script);
        const check = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
        expect(check.status, `bash -n rejected ${name}:\n${check.stderr}`).toBe(0);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  // Reading the YAML cannot tell you what these two steps DO when gh
  // misbehaves, and every release failure so far has been gh misbehaving: a 502
  // on a create that had already succeeded, and a release forced back to draft
  // afterwards. tools/release-workflow-sim.sh executes both scripts against a
  // fake gh and asserts the retry, the single-create rule and the
  // publish-the-draft gate — including the loud failure when a draft cannot be
  // published.
  test('the create and publish scripts survive gh failing under them', () => {
    if (!hasBash) {
      test.skip(true, 'bash is not available on this host');
      return;
    }
    const res = spawnSync('bash', ['tools/release-workflow-sim.sh'], { cwd: root, encoding: 'utf8' });
    const report = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    expect(res.status, report).toBe(0);
    const passed = Number(/passed=(\d+)/.exec(report)?.[1] ?? 0);
    expect(passed, `the simulation ran too few checks:\n${report}`).toBeGreaterThanOrEqual(15);
    expect(report).toContain('failed=0');
  });
});
