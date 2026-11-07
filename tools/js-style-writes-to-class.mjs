// Phase 2 of the inline-style migration. Phase 1 (tools/inline-style-to-class.mjs)
// moved static `style="…"` attributes into `.u-*` classes; this moves static
// literal JS property writes — `el.style.color = '#f44336'` — into the same
// kind of class, so a custom-CSS upload can override them (inline styles always
// beat a stylesheet, classes do not).
//
// What it deliberately skips, and why (each shows up in the dry-run report):
//   * display/opacity — the app and the test suite read them back as visibility
//     flags (`el.style.display === 'none'`, custom-css.spec.ts:21,47);
//   * geometry (width/height/left/top/transform/transformOrigin/objectPosition)
//     — read back with parseInt/parseFloat for drag, crop and view math;
//   * zIndex/backgroundImage/backgroundPosition — asserted against
//     `el.style.…` by tests (app-background.spec.ts, voice-sb-mobile.spec.ts);
//   * cssText/setProperty/setAttribute('style') — whole-attribute writes that
//     cannot be split into per-property classes without changing reset
//     semantics; left to the existing inline-style path;
//   * non-literal values (concatenation, template literals, variables);
//   * a property on an element expression that also receives a *dynamic* write
//     of the same property anywhere in the scanned files — the remaining inline
//     style would win over any class, so converting the literal half would make
//     the dynamic half come out on top;
//   * an element expression whose `className` is assigned in the same file (that
//     wipes the class) or that gets a cssText/setAttribute('style') write (a
//     cssText write used to clear earlier inline styles and no longer clears
//     classes);
//   * an element expression used in more than one scanned file — aliasing cannot
//     be ruled out statically;
//   * any file whose page does not load static/style.css (box-setup.js,
//     box-wipe.js, the sandboxed doc-preview scripts, the test fixture runner).
//
// Two writes of the same property can end up on the same element through two
// names (`grp.style.background` and `group.style.background` in the same
// handler), so a converted site never relies on being the only writer:
//   * it first clears the inline value (`el.style.color = ''`) whenever some
//     write of that property in the file stays inline — the original assignment
//     overwrote that value anyway — then removes the file's other classes for
//     the property (with classes on the element the stylesheet order decides,
//     not the call order) and adds its own;
//   * a `= ''` reset becomes clear-inline + remove, so a class added through an
//     alias cannot survive the reset (that is the stuck-highlight bug).
// Everything is emitted as one comma expression so a braceless
// `if (x) el.style.color = '…'` body stays a single statement.
//
// Usage:
//   node tools/js-style-writes-to-class.mjs [--apply] [--json report.json] <files…>
// Without --apply it prints what it would do and writes nothing.
import { readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const jsonAt = args.indexOf('--json');
const jsonFile = jsonAt >= 0 ? args[jsonAt + 1] : null;
const files = args.filter((a, i) => !a.startsWith('--') && !(jsonAt >= 0 && i === jsonAt + 1));
if (files.length === 0) {
    console.error('usage: node tools/js-style-writes-to-class.mjs [--apply] [--json report.json] <files…>');
    process.exit(2);
}

// Resolved against the repo, not the shell's cwd, so it does not matter where
// the tool is invoked from.
const CSS_FILE = fileURLToPath(new URL('../static/style.css', import.meta.url));

// Properties that must keep using the inline style attribute — the app or the
// test suite reads them back (`el.style.x`) and a class-backed value reads ''.
const PROTECTED_PROPS = new Set([
    'display',
    'opacity',
    'width',
    'height',
    'left',
    'top',
    'transform',
    'transformOrigin',
    'objectPosition',
    'zIndex',
    'backgroundImage',
    'backgroundPosition',
]);

const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';
const STEP = `(?:\\s*\\.\\s*${IDENT}|\\s*\\[[^\\]\\n]{1,120}\\])`;
const LHS = `${IDENT}(?:${STEP})*(?:\\s*\\([^()\\n]{0,160}\\))?`;
const WRITE_RE = new RegExp(`(${LHS})\\s*\\.\\s*style\\s*\\.\\s*(${IDENT})\\s*(\\+?=)`, 'g');
const CLASSNAME_RE = new RegExp(`(${LHS})\\s*\\.\\s*className\\s*=`, 'g');
const SETATTR_RE = new RegExp(`(${LHS})\\s*\\.\\s*setAttribute\\s*\\(\\s*['"]style['"]`, 'g');

// Normalised element expression, so `el .style` and `el.style` count as one.
const norm = (s) => s.replace(/\s+/g, '');
const key = (lhs, prop) => `${norm(lhs)}\u0000${prop}`;
const fileProp = (file, prop) => `${file}\u0000${prop}`;

function classFor(prop, value) {
    const decl = `${prop.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}:${value}`;
    return { cls: 'u-' + createHash('sha1').update(decl).digest('hex').slice(0, 8), decl };
}

// A plain quoted string literal, nothing else. `null` means "not a literal"
// (the write is dynamic and must stay inline).
function readLiteral(text, at) {
    let i = at;
    while (i < text.length && /\s/.test(text[i])) i++;
    const quote = text[i];
    if (quote !== "'" && quote !== '"') return null;
    let j = i + 1;
    while (j < text.length) {
        const ch = text[j];
        if (ch === '\\') return null; // escaped quote etc. — treat as dynamic
        if (ch === '\n' || ch === '\r') return null;
        if (ch === quote) break;
        j++;
    }
    if (j >= text.length) return null;
    let k = j + 1;
    while (text[k] === ' ' || text[k] === '\t') k++;
    const after = text[k];
    if (after === '+' || after === '.') return null; // concatenation / chain
    return { value: text.slice(i + 1, j), end: j + 1 };
}

// The statement's own value may itself be another style assignment
// (`a.style.x = b.style.y = 'v'`) — converting only the inner half would drop
// the outer element's value, so both stay inline.
function inChainedStyleWrite(text, at) {
    return /\.style\.[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*$/.test(text.slice(Math.max(0, at - 160), at));
}

const scans = new Map();  // file -> { text, writes, className, setAttr }
const inventory = new Map(); // prop -> { total, literal, dynamicValue, chained, protectedLiteral }
const globalish = new Set(); // identifiers that could be the same object in two files
const keptInline = new Set(); // fileProp(file, prop) with a write that stays inline
const BARE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const lhsFiles = new Map(); // normalised LHS -> Set(file)

function recordLhs(lhs, file) {
    const k = norm(lhs);
    if (!lhsFiles.has(k)) lhsFiles.set(k, new Set());
    lhsFiles.get(k).add(file);
    return k;
}

for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const scan = { text, writes: [], className: new Set(), setAttr: new Set() };
    // A bare identifier is only ambiguous across files when it can be seen from
    // another file: declared at top level (classic scripts share that scope) or
    // hung off window/globalThis/self. Function-local names collide harmlessly.
    for (const g of text.matchAll(/^(?:var|let|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gm)) globalish.add(g[1]);
    for (const g of text.matchAll(/(?:window|globalThis|self)\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)) globalish.add(g[1]);
    let m;
    WRITE_RE.lastIndex = 0;
    while ((m = WRITE_RE.exec(text)) !== null) {
        const lhs = m[1];
        const prop = m[2];
        const op = m[3];
        const lhsKey = recordLhs(lhs, file);
        const inv = inventory.get(prop) || { total: 0, literal: 0, dynamicValue: 0, chained: 0, protectedLiteral: 0 };
        inventory.set(prop, inv);
        inv.total++;
        if (prop === 'cssText' || op === '+=') {
            keptInline.add(fileProp(file, prop));
            continue;
        }
        const lit = readLiteral(text, WRITE_RE.lastIndex);
        if (lit === null) { inv.dynamicValue++; keptInline.add(fileProp(file, prop)); continue; }
        if (inChainedStyleWrite(text, m.index)) { inv.chained++; keptInline.add(fileProp(file, prop)); continue; }
        if (PROTECTED_PROPS.has(prop)) inv.protectedLiteral++;
        inv.literal++;
        scan.writes.push({ start: m.index, end: lit.end, lhs, prop, value: lit.value, lhsKey });
    }
    CLASSNAME_RE.lastIndex = 0;
    while ((m = CLASSNAME_RE.exec(text)) !== null) scan.className.add(norm(m[1]));
    SETATTR_RE.lastIndex = 0;
    while ((m = SETATTR_RE.exec(text)) !== null) scan.setAttr.add(norm(m[1]));
    scans.set(file, scan);
}

// Properties written literally per file, so a remove-then-add site can list
// every class of that property the file could have put on the element.
const fileProps = new Map(); // fileProp(file, prop) -> Set(value)
for (const [file, scan] of scans) {
    for (const w of scan.writes) {
        if (w.value === '') continue;
        if (!fileProps.has(fileProp(file, w.prop))) fileProps.set(fileProp(file, w.prop), new Set());
        fileProps.get(fileProp(file, w.prop)).add(w.value);
    }
}

const reasons = new Map();
const skippedSites = [];
const note = (r) => reasons.set(r, (reasons.get(r) || 0) + 1);
const skip = (r, w) => { note(r); skippedSites.push({ file: w.file, lhs: w.lhs, prop: w.prop, value: w.value ?? '<dynamic>', reason: r }); };
const planned = [];
const rules = new Map();
const filePropAdds = new Set(); // fileProp(file, prop) with at least one converted add

// Pass 1 — the literal adds.
const addWrites = [];
for (const [file, scan] of scans) {
    for (const w of scan.writes) {
        w.file = file;
        if (w.value === '') continue;
        let reason = null;
        if (PROTECTED_PROPS.has(w.prop)) reason = `protected prop: ${w.prop}`;
        else if (scan.className.has(norm(w.lhs))) reason = `element's className is reassigned (${w.prop})`;
        else if (scan.setAttr.has(norm(w.lhs))) reason = `setAttribute('style') on the element (${w.prop})`;
        else if ((lhsFiles.get(norm(w.lhs)) || new Set()).size > 1 &&
            (!BARE.test(norm(w.lhs)) || globalish.has(norm(w.lhs)))) reason = `element expression used in several files (${w.prop})`;
        if (reason) {
            skip(reason, w);
            // A kept-inline write may target the same element as a converted one
            // through another name; every converted add/reset for the property
            // then clears the inline value first.
            keptInline.add(fileProp(file, w.prop));
            continue;
        }
        addWrites.push(w);
        filePropAdds.add(fileProp(file, w.prop));
    }
}

// Pass 2 — resets. A reset is how a class added elsewhere (possibly through an
// alias) gets cleared, so it converts whenever the file has a converted add for
// that property — the clear-inline half keeps the inline side of the reset too.
const resetWrites = [];
for (const [file, scan] of scans) {
    for (const w of scan.writes) {
        if (w.value !== '') continue;
        if (PROTECTED_PROPS.has(w.prop)) { skip(`protected prop: ${w.prop}`, w); continue; }
        if (!filePropAdds.has(fileProp(file, w.prop))) { skip(`reset of a property never set literally (${w.prop})`, w); continue; }
        resetWrites.push(w);
    }
}

const removeFor = (file, prop) => {
    const family = [...(fileProps.get(fileProp(file, prop)) || [])].map((v) => `'${classFor(prop, v).cls}'`);
    return { call: `${family.length ? `.classList.remove(${family.join(', ')})` : ''}`, count: family.length };
};

for (const w of addWrites) {
    const file = w.file;
    const { cls, decl } = classFor(w.prop, w.value);
    rules.set(cls, decl);
    const { call, count } = removeFor(file, w.prop);
    const clear = keptInline.has(fileProp(file, w.prop)) ? `${w.lhs}.style.${w.prop} = '', ` : '';
    const body = count > 1 || scanHasReset(scans.get(file), w) ? `${w.lhs}${call}, ` : '';
    planned.push({
        file, start: w.start, end: w.end, prop: w.prop, value: w.value, cls,
        text: `${clear}${body}${w.lhs}.classList.add('${cls}')`,
    });
}

for (const w of resetWrites) {
    const { call } = removeFor(w.file, w.prop);
    planned.push({
        file: w.file, start: w.start, end: w.end, prop: w.prop, value: '',
        text: `${w.lhs}.style.${w.prop} = ''${call ? ', ' + w.lhs + call : ''}`,
    });
}

function scanHasReset(scan, w) {
    return scan.writes.some((o) => o.value === '' && o.prop === w.prop && o.lhsKey === w.lhsKey);
}

const byProp = new Map();
for (const p of planned) byProp.set(p.prop, (byProp.get(p.prop) || 0) + 1);

const report = {
    files: files.length,
    converted: planned.length,
    classes: rules.size,
    byProp: Object.fromEntries([...byProp].sort((a, b) => b[1] - a[1])),
    skipped: Object.fromEntries([...reasons].sort((a, b) => b[1] - a[1])),
    skippedSites,
    inventory: Object.fromEntries(
        [...inventory].sort((a, b) => b[1].total - a[1].total).map(([prop, v]) => [prop, v]),
    ),
    sites: planned.map((p) => ({
        file: p.file, prop: p.prop, value: p.value,
        from: scans.get(p.file).text.slice(p.start, p.end),
        to: p.text,
    })),
};
if (jsonFile) writeFileSync(jsonFile, JSON.stringify(report, null, 2));
else if (!apply) console.log(JSON.stringify({ ...report, sites: undefined, skippedSites: undefined }, null, 2));

if (!apply) {
    console.log(`dry run: ${planned.length} write(s) would convert, ${rules.size} class(es)`);
    for (const p of planned) console.log(`  ${p.file}  ${p.prop}: ${p.value === '' ? '<reset>' : p.value}`);
    process.exit(0);
}

// Rewrite each file back-to-front so offsets stay valid.
const byFile = new Map();
for (const p of planned) {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file).push(p);
}
let changed = 0;
for (const [file, sites] of byFile) {
    const scan = scans.get(file);
    let out = scan.text;
    for (const s of [...sites].sort((a, b) => b.start - a.start)) {
        out = out.slice(0, s.start) + s.text + out.slice(s.end);
    }
    if (out !== scan.text) { writeFileSync(file, out); changed++; }
}

// Merge the generated rules with every previously extracted block into one
// deduplicated block at the end of style.css. All blocks live at the end of the
// file, so everything from the first marker on is rewritten.
if (rules.size > 0) {
    let css = readFileSync(CSS_FILE, 'utf8');
    const marker = css.indexOf('/* ─── Extracted inline styles');
    if (marker < 0) throw new Error(`no extracted-style block found in ${CSS_FILE}`);
    // Keep the existing rules in file order (deduplicated) and append this run's
    // rules after them. Order matters: a JS write ran after the markup its
    // element came from, so its class must win by source order over a phase-1
    // class on the same element.
    const seen = new Set();
    const kept = [];
    const ruleRe = /^\.(u-[0-9a-f]{8}) \{ (.*) \}$/gm;
    let m;
    while ((m = ruleRe.exec(css.slice(marker))) !== null) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        kept.push(`.${m[1]} { ${m[2]} }`);
    }
    const added = [...rules.entries()]
        .filter(([cls]) => !seen.has(cls))
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([cls, decl]) => `.${cls} { ${decl} }`);
    const block = [
        '/* ─── Extracted inline styles ──────────────────────────────────────────',
        '   Every rule here replaced a static inline `style="…"` (phase 1: attributes,',
        '   tools/inline-style-to-class.mjs) or a static literal `el.style.x = "…"`',
        '   write (phase 2: tools/js-style-writes-to-class.mjs) so a custom-CSS',
        '   upload can override it — inline styles always beat a stylesheet, classes',
        '   do not. `display`/`opacity` and the read-back geometry properties were',
        '   deliberately left inline; the app and tests read them as flags and',
        '   numbers. Do not delete a rule wholesale: a class is still referenced by',
        '   the element it came from. */',
        ...kept,
        ...(added.length ? [
            '',
            '/* Phase 2 — static literal `el.style.x = "…"` writes',
            '   (tools/js-style-writes-to-class.mjs). Deliberately after the phase-1',
            '   rules: a JS write beats a `style="…"` attribute already in the markup,',
            '   so its class has to win by source order. */',
            ...added,
        ] : []),
        '',
    ].join('\r\n');
    writeFileSync(CSS_FILE, css.slice(0, marker).replace(/\s*$/, '') + '\r\n' + block);
}
console.log(`applied: ${changed} file(s), ${planned.length} write site(s), ${rules.size} new class rule(s)`);
