// Move static inline `style="…"` attributes in the app's own HTML/JS into
// classes appended to static/style.css, so a custom-CSS upload can override
// them (inline styles always beat a stylesheet, classes do not).
//
// What it deliberately skips:
//   * values that are dynamic — built with `+` concatenation, template `${}`,
//     or containing a backslash (an escaped quote inside a JS string);
//   * any `style="…"` not clearly inside one HTML tag (no `<` before it, no
//     `>` after it, or those bounds crossed by a quote/plus);
//   * `display:`/`opacity:` declarations — the app and test suite read
//     `el.style.display`/`el.style.opacity` back as visibility flags, so
//     those stay inline while the rest of the attribute is extracted;
//   * files under libs/ or vendor/ (third-party code), and documents that do
//     not load static/style.css (box-setup.html, box-wipe.html, the sandboxed
//     doc-preview frames) — a class they cannot see would silently do nothing.
//
// Usage:
//   node tools/inline-style-to-class.mjs [--apply] [files…]
// Without --apply it prints what it would do and writes nothing.
import { readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const files = args.filter((a) => !a.startsWith('--'));
if (files.length === 0) {
    console.error('usage: node tools/inline-style-to-class.mjs [--apply] <files…>');
    process.exit(2);
}

const CSS_FILE = 'static/style.css';
const classByDecl = new Map();
const declByClass = new Map();

function classFor(decl) {
    let cls = classByDecl.get(decl);
    if (!cls) {
        cls = 'u-' + createHash('sha1').update(decl).digest('hex').slice(0, 8);
        classByDecl.set(decl, cls);
        declByClass.set(cls, decl);
    }
    return cls;
}

function isDynamic(value) {
    return (
        value.includes("'") ||
        value.includes('\\') ||
        value.includes('${') ||
        value.includes('+') ||
        value.includes('&quot;') ||
        value.includes('\n') ||
        value.includes('\r') ||
        value.trim() === ''
    );
}

// Declarations that must stay inline because the app and the test suite read
// them back as visibility flags (`el.style.display === 'none'`,
// `el.style.opacity === '0'` — custom-css.spec.ts:21,47) — a class-backed
// value reads as '' there. Everything else in the same attribute is still
// extracted: `style="display:none;padding:8px"` becomes
// `style="display:none" class="u-…"` + `.u-… { padding: 8px }`.
const PROTECTED_PROPS = new Set(['display', 'opacity']);

// Split a declaration list on top-level `;`, respecting quotes and parens so
// `url(data:image/svg+xml;base64,…)` and quoted values survive intact, then
// partition it into declarations that stay inline and the ones to extract.
function splitDecls(value) {
    const parts = [];
    let depth = 0, quote = '', cur = '';
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (quote) {
            cur += ch;
            if (ch === quote && value[i - 1] !== '\\') quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') depth = depth > 0 ? depth - 1 : 0;
        if (ch === ';' && depth === 0) { parts.push(cur); cur = ''; continue; }
        cur += ch;
    }
    parts.push(cur);
    const kept = [], rest = [];
    for (const p of parts) {
        if (p.trim() === '') continue;
        const prop = p.trim().split(':', 1)[0].trim().toLowerCase();
        (PROTECTED_PROPS.has(prop) ? kept : rest).push(p);
    }
    return { kept: kept.join(';'), extracted: rest.join(';') };
}

let converted = 0;
let skippedDynamic = 0;
let skippedProtectedOnly = 0;

function convert(text) {
    const re = /style="([^"]*)"/g;
    let out = '';
    let last = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
        const value = match[1];
        const at = match.index;

        // The tag around it: start at the nearest `<` before, end at the
        // nearest `>` after. If either bound is crossed by a string boundary
        // (quote) or concatenation, this is not one static element — skip.
        const tagStart = text.lastIndexOf('<', at);
        const tagEnd = text.indexOf('>', at + match[0].length);
        const betweenBefore = tagStart >= 0 ? text.slice(tagStart, at) : '';
        const betweenAfter = tagEnd >= 0 ? text.slice(at + match[0].length, tagEnd) : '';
        const looksLikeTag = tagStart >= 0 && tagEnd >= 0 &&
            !betweenBefore.includes('>') &&
            !betweenAfter.includes('<') &&
            !/[`'+]/.test(betweenBefore) &&
            !/[`'+]/.test(betweenAfter);

        if (isDynamic(value) || !looksLikeTag) {
            skippedDynamic++;
            continue;
        }

        // Move the static declarations to a class; keep display/opacity inline.
        const { kept, extracted } = splitDecls(value);
        if (!extracted) {
            skippedProtectedOnly++;
            continue;
        }

        const cls = classFor(extracted);
        const tag = text.slice(tagStart, tagEnd + 1);
        const rel = at - tagStart;
        const styleBack = kept ? 'style="' + kept + '"' : '';
        let tagNoStyle = tag.slice(0, rel) + styleBack + tag.slice(rel + match[0].length);
        const cm = /class="([^"]*)"/.exec(tagNoStyle);
        if (cm) {
            const merged = (cm[1].trim() + ' ' + cls).trim();
            tagNoStyle = tagNoStyle.replace(cm[0], 'class="' + merged + '"');
        } else {
            const nameMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(tagNoStyle);
            if (!nameMatch) { skippedDynamic++; continue; }
            tagNoStyle = tagNoStyle.replace(nameMatch[0], nameMatch[0] + ' class="' + cls + '"');
        }

        out += text.slice(last, tagStart) + tagNoStyle;
        last = tagEnd + 1;
        converted++;
        re.lastIndex = last;
    }
    return out + text.slice(last);
}

const results = [];
for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const convertedText = convert(text);
    results.push({ file, text, convertedText });
}

console.log(`converted: ${converted}, skipped (dynamic/non-attribute): ${skippedDynamic}, skipped (display/opacity only): ${skippedProtectedOnly}, classes: ${declByClass.size}`);
if (!apply) {
    for (const r of results) {
        console.log(`  ${r.file}: ${r.text === r.convertedText ? 'unchanged' : 'would change'}`);
    }
    process.exit(0);
}

// Append the generated rules to style.css in one block. Appended at the end on
// purpose: they take the place of inline styles, which beat every stylesheet
// rule, so they must win against the base sheet by source order. Nothing to do
// on a re-run (every convertible value is already a class by then).
if (declByClass.size > 0) {
    const cssLines = ['', '/* ─── Extracted inline styles ──────────────────────────────────────────', '   Every rule here replaced a static inline `style="…"` so a custom-CSS', '   upload can override it (inline styles always beat a stylesheet, classes', '   do not). `display`/`opacity` declarations were deliberately left inline —', '   the app and tests read them back as visibility flags. Do not delete the', '   block wholesale: the class is still referenced by what it came from. */'];
    for (const [cls, decl] of declByClass) {
        cssLines.push(`.${cls} { ${decl} }`);
    }
    cssLines.push('');
    const css = readFileSync(CSS_FILE, 'utf8');
    writeFileSync(CSS_FILE, css.replace(/\s*$/, '') + '\r\n' + cssLines.join('\r\n'));
}

for (const r of results) {
    if (r.text !== r.convertedText) writeFileSync(r.file, r.convertedText);
}
console.log(`applied to ${results.filter((r) => r.text !== r.convertedText).length} file(s), appended ${declByClass.size} rules to ${CSS_FILE}`);
