#!/usr/bin/env node
/**
 * audit-fix.mjs — prove a fix with before/after evidence.
 *
 * Runs the given Playwright spec(s) twice: once against the PRE-FIX code (your
 * uncommitted source changes stashed away) and once against the working tree,
 * then reports per test which of the three cases it is:
 *
 *   PROVEN    fails pre-fix, passes after   → the test actually proves the fix
 *   GUARD     passes both                   → regression guard, not a proof
 *   NEW FAIL  passed pre-fix, fails after   → the change broke something
 *   STILL BAD fails both                    → test bug or unfixed issue
 *
 * Usage:
 *   npm run audit -- tests/soundboard-live.spec.ts
 *   npm run audit -- tests/soundboard-live.spec.ts --grep "L1"
 *   npm run audit -- tests/x.spec.ts --paths static/voice.js,static/style.css
 *
 * Only *modified tracked* files under the source dirs are stashed, so the new
 * test file itself is never removed, and the stash is always restored (also on
 * Ctrl-C). Untracked files are left alone.
 */
import { execSync } from 'node:child_process';
import process from 'node:process';

const SOURCE_PREFIXES = ['static/', 'server/src/', 'server/migrations/'];

const argv = process.argv.slice(2);
const specs = [];
let grepArg = '';
let pathsArg = '';

for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--grep') grepArg = argv[++i] || '';
    else if (a.startsWith('--grep=')) grepArg = a.slice(7);
    else if (a === '--paths') pathsArg = argv[++i] || '';
    else if (a.startsWith('--paths=')) pathsArg = a.slice(8);
    else if (a.startsWith('-')) { /* ignore other playwright flags */ }
    else specs.push(a);
}

if (!specs.length) {
    console.error('usage: npm run audit -- <spec...> [--grep "name"] [--paths static/a.js,static/b.js]');
    process.exit(2);
}

const git = (cmd) => execSync(`git ${cmd}`, { encoding: 'utf8' }).trim();

function sourceChanges() {
    if (pathsArg) return pathsArg.split(',').map((p) => p.trim()).filter(Boolean);
    const modified = git('diff --name-only').split('\n').map((l) => l.trim()).filter(Boolean);
    return modified.filter((p) => SOURCE_PREFIXES.some((pre) => p.replace(/\\/g, '/').startsWith(pre)));
}

/** Run the specs and return [{ title, ok }] (flattened spec results). */
function runSpecs() {
    const args = ['playwright', 'test', ...specs, '--reporter=json'];
    if (grepArg) args.push('--grep', grepArg);
    let out = '';
    try {
        out = execSync(`npx ${args.map((a) => JSON.stringify(a)).join(' ')}`, {
            encoding: 'utf8',
            maxBuffer: 256 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch (e) {
        // A non-zero exit just means failures — the JSON report is still on stdout.
        out = (e.stdout || '').toString();
    }
    const start = out.indexOf('{');
    if (start === -1) throw new Error('no JSON report from playwright:\n' + out.slice(0, 2000));
    const report = JSON.parse(out.slice(start));

    const results = [];
    const walk = (suites, prefix) => {
        for (const s of suites || []) {
            const title = prefix ? `${prefix} › ${s.title}` : s.title;
            for (const sp of s.specs || []) {
                const ok = (sp.tests || []).every((t) => (t.results || []).every((r) => r.status === 'passed'));
                results.push({ title: `${title} › ${sp.title}`, ok });
            }
            walk(s.suites, title);
        }
    };
    walk(report.suites, '');
    return results;
}

const changes = sourceChanges();
if (!changes.length) {
    console.error('Nothing to audit: no modified tracked files under ' + SOURCE_PREFIXES.join(', '));
    process.exit(2);
}

let stashed = false;
const restore = () => {
    if (!stashed) return;
    stashed = false;
    try {
        execSync('git stash pop', { stdio: 'ignore' });
        console.log('\n↩  restored your changes (git stash pop)');
    } catch (e) {
        console.error('\n!! FAILED to restore the stash — run `git stash pop` yourself before editing!');
    }
};
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('SIGTERM', () => { restore(); process.exit(143); });
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });

console.log(`auditing ${specs.join(', ')}`);
console.log(`reverting (pre-fix): ${changes.join(', ')}\n`);

try {
    execSync(`git stash push -m "audit-fix (temporary)" -- ${changes.map((c) => JSON.stringify(c)).join(' ')}`, { stdio: 'ignore' });
    stashed = true;
    console.log('--- run 1/2: PRE-FIX (your changes stashed) ---');
    const before = runSpecs();

    restore();

    console.log('\n--- run 2/2: POST-FIX (working tree) ---');
    const after = runSpecs();

    const byTitle = new Map(before.map((t) => [t.title, t.ok]));
    const proven = [], guards = [], broke = [], stillBad = [];
    for (const t of after) {
        const wasOk = byTitle.get(t.title);
        if (wasOk === false && t.ok) proven.push(t.title);
        else if (wasOk === true && t.ok) guards.push(t.title);
        else if (wasOk === true && !t.ok) broke.push(t.title);
        else if (wasOk === false && !t.ok) stillBad.push(t.title);
    }

    const show = (label, list) => {
        console.log(`\n${label} (${list.length})`);
        list.forEach((t) => console.log('  - ' + t));
    };
    show('PROVEN — failed pre-fix, passes now', proven);
    show('GUARD — passes on both revisions (not a proof of the fix)', guards);
    show('NEW FAILURE — passed pre-fix, fails now', broke);
    show('STILL FAILING — fails on both revisions', stillBad);

    if (broke.length || stillBad.length) process.exitCode = 1;
} finally {
    restore();
}
