/**
 * Extract remaining UI/rendering functions from chat.js into chat-ui.js.
 * Uses robust brace-matching with proper handling of:
 * - Template literal interpolations (${...})
 * - Regex literals (simplified — just count braces inside them)
 * - All string types and comments
 * 
 * Strategy: read the ORIGINAL chat.js from git HEAD, extract functions,
 * then update the current chat.js and chat-ui.js files.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const PROJECT = 'X:/Documents/GitHub/E2E_Talk';
const CHAT_JS = path.join(PROJECT, 'static/chat.js');
const UI_JS = path.join(PROJECT, 'static/js/chat-ui.js');

// Read original from git
let originalCode;
try {
    originalCode = execSync('git show HEAD:static/chat.js', { cwd: PROJECT, encoding: 'utf-8' });
} catch (e) {
    console.error('Failed to read original chat.js from git. Using current file instead.');
    originalCode = fs.readFileSync(CHAT_JS, 'utf-8');
}

const lines = originalCode.split('\n');
console.log(`Original chat.js (git HEAD): ${lines.length} lines`);

// ─── Robust brace-finding function ───────────────────────────────

function findCloseBrace(str, openPos) {
    let depth = 0;
    let i = openPos;
    let inDq = false, inSq = false, inBt = false;
    let btDepth = 0;
    let prevChar = '';

    while (i < str.length) {
        const ch = str[i];
        const nc = str[i + 1] || '';

        // Escape inside string
        if (ch === '\\' && (inDq || inSq || inBt)) {
            i += 2;
            prevChar = ch;
            continue;
        }

        // String toggles
        if (!(inBt && btDepth > 0)) {
            if (ch === '"' && !inSq && !inBt) { inDq = !inDq; }
            else if (ch === "'" && !inDq && !inBt) { inSq = !inSq; }
            else if (ch === '`' && !inDq && !inSq) {
                if (inBt && btDepth === 0) inBt = false;
                else if (!inBt) { inBt = true; btDepth = 0; }
            }
        }

        // Template literal interpolation
        if (inBt && !inDq && !inSq) {
            if (ch === '$' && nc === '{') { btDepth++; i += 2; continue; }
            else if (ch === '}' && btDepth > 0) { btDepth--; i++; continue; }
            else if (ch === '`' && btDepth === 0) inBt = false;
        }

        // Comments
        if (!inDq && !inSq && !inBt) {
            if (ch === '/' && nc === '/') {
                while (i < str.length && str[i] !== '\n') i++;
            } else if (ch === '/' && nc === '*') {
                i += 2;
                while (i < str.length) {
                    if (str[i] === '*' && (str[i + 1] || '') === '/') { i++; break; }
                    i++;
                }
            }
        }

        // Brace counting (tracked when not in string, or in template interpolation)
        if (!inDq && !inSq && !(inBt && btDepth === 0)) {
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) return i;
            }
        }

        prevChar = ch;
        i++;
    }
    return -1;
}

function findFunction(code, name) {
    const pattern = new RegExp('function\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(');
    const m = pattern.exec(code);
    if (!m) return null;

    const start = m.index;
    const brace = code.indexOf('{', start);
    if (brace < 0) return null;

    const end = findCloseBrace(code, brace);
    if (end < 0) return null;

    const startLine = code.slice(0, start).split('\n').length;
    const endLine = code.slice(0, end).split('\n').length;
    const funcText = code.slice(start, end + 1);

    // Validate: extract text must end with }
    if (!funcText.trim().endsWith('}')) {
        console.log(`  VALIDATION FAILED: ${name} (no trailing })`);
        return null;
    }

    // Count braces in extracted text
    const openCount = (funcText.match(/{/g) || []).length;
    const closeCount = (funcText.match(/}/g) || []).length;
    if (openCount !== closeCount) {
        console.log(`  VALIDATION FAILED: ${name} (${openCount} open vs ${closeCount} close)`);
        return null;
    }

    return { start, end, text: funcText, startLine, endLine };
}

// ─── Remaining UI functions to extract ───────────────────────────

const REMAINING_UI = [
    // Message/forward actions
    'appendMessage',
    'setupMessageActions',
    'handleReply', 
    'handleEdit',
    'handleEditedMessage',
    'appendDmMessage',
    'sendMessage',
    'sendDmMessage',
    'sendStickerMessage',
    'executeDmForward',
    
    // Profile rendering
    'openProfileModal',
    'renderProfileView',
    'renderProfileEdit',
    'updateProfileEditPreview',
    'renderBorderGlowOptions',
    'uploadConversationProfiles',
    'uploadCurrentProfileToConversations',
    
    // Highlight and markdown
    'escapeAttr',
    'escapeHtml',
    'highlightSyntax',
    'highlightHtml',
    'highlightJson',
    'highlightCss',
    'highlightKeyValue',
    'highlightGeneric',
    'renderMarkdown',
    
    // Media
    'loadMediaPreview',
    'openMediaViewer',
    
    // Sticker
    'renderUploadStickerPanel',
    'processAndUploadSticker',
    
    // Profile edit
    'setupProfileCropModal',
    'openProfileCrop',
    'initProfileCropBox',
    'processAndUploadProfilePic',
    'removeProfilePic',
    'saveUsernameColor',
    'saveBorderGlowColor',
    'setupProfileSettings',
    'saveProfile',
    
    // Crop functions
    'openBannerCrop',
    'processBannerCrop',
    'openPfpCrop',
    'processPfpCrop',
    'uploadBannerImage',
    
    // Other UI functions
    'loadUserStickers',
    'loadEmojiCache',
    'loadEmojiBlob',
    'decodeQrFromFile',
    'uploadFileToServer',
    'startFileUpload',
    'loadMyProfile',
    'updateProfileSettingsUI',
    'saveDisplayName',
];

// ─── Find all functions ──────────────────────────────────────────

console.log(`\nSearching for ${REMAINING_UI.length} remaining UI functions...`);
const results = [];
const notFound = [];

for (const name of REMAINING_UI) {
    const r = findFunction(originalCode, name);
    if (r) {
        results.push(r);
    } else {
        notFound.push(name);
    }
}

console.log(`\nFound: ${results.length}/${REMAINING_UI.length}`);
if (notFound.length > 0) {
    console.log(`Not found: ${notFound.join(', ')}`);
}

// Print results sorted by position
results.sort((a, b) => a.start - b.start);
console.log('\n--- Functions found (sorted by position) ---');
let totalLines = 0;
for (const r of results) {
    const nLines = r.endLine - r.startLine + 1;
    totalLines += nLines;
    const name = originalCode.slice(r.start, r.start + 60).split('(')[0].replace('function ', '').trim();
    console.log(`  ${name}: lines ${r.startLine}-${r.endLine} (${nLines} lines)`);
}
console.log(`\nTotal: ${results.length} functions, ~${totalLines} lines`);

// Merge overlapping ranges
const merged = [];
for (const r of results) {
    if (merged.length === 0) {
        merged.push({ ...r });
    } else {
        const last = merged[merged.length - 1];
        if (r.start <= last.end + 1) {
            last.end = Math.max(last.end, r.end);
            last.endLine = Math.max(last.endLine, r.endLine);
            last.text = originalCode.slice(last.start, last.end + 1);
        } else {
            merged.push({ ...r });
        }
    }
}

console.log(`\nMerged into ${merged.length} contiguous ranges:`);
let mergedLines = 0;
for (const m of merged) {
    const mLines = m.endLine - m.startLine + 1;
    mergedLines += mLines;
    console.log(`  lines ${m.startLine}-${m.endLine} (${mLines} lines)`);
}

// ─── Build extracted code ────────────────────────────────────────

const uiParts = merged.map(m => originalCode.slice(m.start, m.end + 1));
const newUiCode = uiParts.join('\n\n');

// ─── Remove from chat.js (current file, not original) ────────────

// We need to apply the removal to the CURRENT chat.js, not the original
// The current chat.js has already had some functions removed.
// We need to find each function in the CURRENT chat.js and remove it.

let currentCode = fs.readFileSync(CHAT_JS, 'utf-8');
const removedFunctions = [];

// Remove from end to start to preserve positions
const sortedResults = [...results].sort((a, b) => b.start - a.start);

// For each function, we need to find it in the CURRENT file (not original)
// since positions differ between original and current due to prior extractions
for (const origR of sortedResults) {
    const origName = originalCode.slice(origR.start, origR.start + 80).split('(')[0].replace('function ', '').trim();
    
    // Find this function in the current code
    const fn = findFunction(currentCode, origName);
    if (fn) {
        removedFunctions.push({ name: origName, lines: fn.endLine - fn.startLine + 1 });
        currentCode = currentCode.slice(0, fn.start) + currentCode.slice(fn.end + 1);
    } else {
        console.log(`  WARNING: Could not find '${origName}' in current chat.js (already removed?)`);
    }
}

// Remove excessive blank lines
currentCode = currentCode.replace(/\n{3,}/g, '\n\n');

// ─── Read existing chat-ui.js and append new functions ───────────

let existingUiCode = fs.readFileSync(UI_JS, 'utf-8');

// Append new functions at the end
const appendedCode = existingUiCode.trimEnd() + '\n\n// === Additional UI functions (extracted from chat.js) ===\n\n' + newUiCode + '\n';

// ─── Write files ─────────────────────────────────────────────────

fs.writeFileSync(CHAT_JS, currentCode, 'utf-8');
fs.writeFileSync(UI_JS, appendedCode, 'utf-8');

// ─── Statistics ──────────────────────────────────────────────────

const chatLines = currentCode.split('\n').length;
const uiLines = appendedCode.split('\n').length;

console.log(`\n=== Results ===`);
console.log(`  chat.js:    ${chatLines} lines`);
console.log(`  chat-ui.js: ${uiLines} lines`);
console.log(`  Extracted ${removedFunctions.length} functions (${removedFunctions.reduce((s, r) => s + r.lines, 0)} lines)`);

// Verify syntax
for (const file of [CHAT_JS, UI_JS]) {
    try {
        execSync(`node -c "${file}"`, { stdio: 'pipe' });
        console.log(`  ${path.basename(file)}: OK`);
    } catch (e) {
        const stderr = e.stderr?.toString() || '';
        const match = stderr.match(/static\\(?:js\\)?chat[^:]+:(\d+)/);
        const lineInfo = match ? ` at line ${match[1]}` : '';
        console.log(`  ${path.basename(file)}: FAIL${lineInfo}`);
        // Show context around error
        if (match) {
            const errLine = parseInt(match[1]);
            const fContent = fs.readFileSync(file, 'utf-8').split('\n');
            console.log(`    Context: ${fContent[errLine - 1]?.trim().substring(0, 100)}`);
        }
    }
}
