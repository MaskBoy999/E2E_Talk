// Supply-chain + shell-config assertions (review findings 9 and 2). These read
// the files rather than running anything: a workflow ref is a tag that can be
// repointed at any time, and the Tauri shell's CSP is the only XSS layer the
// box's WebView has (Tauri docs: "The CSP protection is only enabled if set on
// the Tauri configuration file"). Both are exactly the kind of thing that
// silently regresses unless a test holds it.
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
const WORKFLOWS = ['.github/workflows/release.yml', '.github/workflows/android.yml'];

for (const rel of WORKFLOWS) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');

    test(`${rel}: every action is pinned to a full commit SHA`, () => {
        const uses = [...text.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]);
        expect(uses.length, 'the workflow should use at least one action').toBeGreaterThan(0);
        for (const ref of uses) {
            expect(
                ref,
                `${ref} is a moving tag — pin it to a full commit SHA (Dependabot can maintain it)`,
            ).toMatch(/@[0-9a-f]{40}$/);
        }
    });

    test(`${rel}: permissions are scoped to jobs, not the whole workflow`, () => {
        // A workflow-wide `contents: write` is inherited by every step of every
        // job, including any third-party action. The token should only exist
        // where the release/publish step actually needs it.
        const beforeJobs = text.split(/\r?\njobs:/)[0];
        expect(beforeJobs, `${rel} must not grant workflow-wide permissions`).not.toMatch(/\r?\npermissions:/);
    });
}

test('release builds publish verifiable provenance', () => {
    const text = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
    expect(text).toContain('actions/attest-build-provenance@');
    expect(text).toMatch(/id-token:\s*write/);
    expect(text).toMatch(/attestations:\s*write/);
    expect(text).toContain('subject-path:');
});

test('the Tauri shell ships a restrictive CSP', () => {
    const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    const csp: unknown = conf?.app?.security?.csp;
    expect(typeof csp, 'csp: null means the WebView has no policy at all').toBe('string');
    const text = String(csp);
    expect(text).toContain("default-src 'self'");
    expect(text).toContain("object-src 'none'");
    expect(text).toContain('ipc.localhost'); // Tauri's IPC must stay reachable
    const scriptSrc = text.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src'));
    expect(scriptSrc).toBeTruthy();
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
});

test('CI actions receive the same SHA-pinning guarantee after a re-run', () => {
    // A cheap invariant against a common regression: someone re-adding `@v4`
    // while fixing a workflow. Matches only major-version tags.
    for (const rel of WORKFLOWS) {
        const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        expect(text, `${rel} contains an unpinned @vN ref`).not.toMatch(/uses:\s*[^\s#]+@v\d+\b/);
    }
});
