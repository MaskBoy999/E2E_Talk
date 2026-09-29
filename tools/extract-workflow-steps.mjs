// Pull the `run: |` script out of each named step in a GitHub workflow, so it
// can be checked as BASH instead of as YAML.
//
// Why this exists: a workflow's shell only runs after a tag is pushed, and a
// syntax error in it is invisible until then — the job dies with a bare exit
// code (job logs need authentication even on this public repo) and the release
// it was supposed to publish is left half-built. `bash -n` on the extracted
// script catches that class of mistake before the tag is ever pushed, and the
// same extraction lets a script be EXECUTED against a fake `gh`
// (tools/release-workflow-sim.sh) rather than only read.
//
// Usage: node tools/extract-workflow-steps.mjs <workflow> <outdir> [name-fragment...]
// Prints one line per step written: `<step name> -> <file> (<n> lines)`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [wfPath, outDir, ...want] = process.argv.slice(2);
if (!wfPath || !outDir) {
  console.error('usage: node tools/extract-workflow-steps.mjs <workflow> <outdir> [name-fragment...]');
  process.exit(2);
}

const lines = readFileSync(wfPath, 'utf8').split('\n');
const indentOf = (line) => line.length - line.trimStart().length;
mkdirSync(outDir, { recursive: true });

let written = 0;
for (let i = 0; i < lines.length; i++) {
  const named = /^\s*-\s*name:\s*(.+?)\s*$/.exec(lines[i]);
  if (!named) continue;
  const name = named[1];
  if (want.length && !want.some((w) => name.includes(w))) continue;

  // The step's own `run: |` — never one belonging to the step below it — along
  // with any `shell:` it declares. A pwsh/cmd script is not bash and must not
  // be handed to `bash -n`: PowerShell parses `[Convert]::FromBase64String(...)`
  // as a syntax error, which would make this check cry wolf on a healthy
  // workflow. Steps without a `shell:` default to bash on the Linux runners
  // every bash-shaped step here runs on, so those are included.
  const stepIndent = indentOf(lines[i]);
  let runAt = -1;
  let shell = null;
  for (let j = i + 1; j < lines.length; j++) {
    if (indentOf(lines[j]) <= stepIndent && /^\s*-\s*name:/.test(lines[j])) break;
    const declared = /^\s*shell:\s*(\S+)/.exec(lines[j]);
    if (declared) shell = declared[1];
    if (/^\s*run:\s*\|/.test(lines[j])) {
      runAt = j;
      break;
    }
  }
  if (runAt === -1) continue;
  if (shell && shell !== 'bash') {
    console.log(`skipping ${name} (shell: ${shell}, not bash)`);
    continue;
  }

  const body = [];
  let bodyIndent = null;
  for (let j = runAt + 1; j < lines.length; j++) {
    const line = lines[j];
    const blank = line.trim() === '';
    if (!blank && bodyIndent === null) bodyIndent = indentOf(line);
    if (!blank && indentOf(line) < (bodyIndent ?? Infinity)) break;
    body.push(line);
  }

  const script = body.map((l) => l.slice(bodyIndent ?? 0)).join('\n');
  const file = join(outDir, `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.sh`);
  writeFileSync(file, `${script}\n`);
  console.log(`${name} -> ${file} (${script.split('\n').length} lines)`);
  written += 1;
}

if (written === 0) {
  console.error(`no "run: |" steps matched in ${wfPath} (wanted: ${want.join(', ') || 'any'})`);
  process.exit(1);
}
