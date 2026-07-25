/**
 * Split chat.js into chat-ws.js and chat-ui.js using Node.js.
 * Instead of parsing JavaScript ourselves, we use a simple strategy:
 * 1. Read chat.js
 * 2. Find the exact byte positions of each function
 * 3. Extract and create the new files
 * 4. Remove the function bodies from chat.js
 */
const fs = require('fs');
const path = require('path');

const PROJECT = 'X:/Documents/GitHub/E2E_Talk';
const CHAT_JS = path.join(PROJECT, 'static/chat.js');
const WS_JS = path.join(PROJECT, 'static/js/chat-ws.js');
const UI_JS = path.join(PROJECT, 'static/js/chat-ui.js');
const INDEX = path.join(PROJECT, 'static/index.html');

const code = fs.readFileSync(CHAT_JS, 'utf-8');
const lines = code.split('\n');
console.log(`chat.js: ${lines.length} lines`);

/**
 * Find the matching closing brace at position `openBracePos`.
 * This is done by simple character walking with string awareness.
 * No regex detection needed — we just track string contexts.
 */
function findCloseBrace(str, openBracePos) {
    let depth = 0;
    let i = openBracePos;
    let inDq = false, inSq = false, inBt = false;
    let btDepth = 0;

    while (i < str.length) {
        const ch = str[i];
        const nc = str[i + 1] || '';

        // Escape sequence inside string
        if (ch === '\\' && (inDq || inSq || inBt)) {
            i += 2;
            continue;
        }

        // String toggles — only when not in template literal interpolation
        if (!(inBt && btDepth > 0)) {
            if (ch === '"' && !inSq && !inBt) { inDq = !inDq; }
            else if (ch === "'" && !inDq && !inBt) { inSq = !inSq; }
            else if (ch === '`' && !inDq && !inSq) {
                if (inBt && btDepth === 0) inBt = false;
                else if (!inBt) { inBt = true; btDepth = 0; }
            }
        }

        // Template literal interpolation ${...}
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
                    if (str[i] === '*' && (str[i+1] || '') === '/') { i++; break; }
                    i++;
                }
            }
        }

        // Brace counting
        if (!inDq && !inSq && !(inBt && btDepth === 0)) {
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) return i;
            }
        }

        i++;
    }
    return -1;
}

/**
 * Find a function declaration by name, return its boundaries.
 */
function findFunction(str, name) {
    const pattern = new RegExp('(?:async\\s+)?function\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(');
    const m = pattern.exec(str);
    if (!m) return null;

    const start = m.index;
    const brace = str.indexOf('{', start);
    if (brace < 0) return null;

    const end = findCloseBrace(str, brace);
    if (end < 0) return null;

    const startLine = str.slice(0, start).split('\n').length;
    const endLine = str.slice(0, end).split('\n').length;

    return { start, end, text: str.slice(start, end + 1), startLine, endLine };
}

// ─── Functions to extract ────────────────────────────────────────

const WS_NAMES = ['connectWebSocket'];

const UI_NAMES = [
    'renderServerList', 'renderDmSidebar', 'appendMessage', 'appendDmMessage',
    'updateMentionsBadge', 'clearAllMentionItems', 'openMentionsInbox', 'closeMentionsInbox',
    'renderMentionsInbox', 'setupMentionsInboxEvents', 'initMentionsInbox',
    'updateServerBadges', 'updateChannelBadges',
    'hideModal', 'showModal', 'escapeAttr', 'getContrastGlowColor',
    'getDisplayNameTextShadow', 'updateExistingMessageStyles', 'generateBorderGlowOptions', 'escapeJsStr',
    'formatFileSize', 'isCodeFile', 'isTextFile', 'isMarkdownFile', 'getCorrectMimeType',
    'getLangFromExt', 'getLangColors',
    'highlightSyntax', 'highlightHtml', 'highlightJson', 'highlightCss', 'highlightKeyValue', 'highlightGeneric',
    'renderMarkdown', 'normalizeAudioMimeType', 'getFileIcon',
    'setupDragAndDrop', 'setupModalDragAndDrop', 'handleFileSelect',
    'showUploadModal', 'renderUploadPreview', 'closeUploadModal',
    'buildFileCardHtml', 'revokeBlobUrls', 'extractRawMessageText',
    'updateGalleryState', 'buildMultiFileCardHtml', 'loadMediaPreview',
    'openMediaViewer', 'viewerKeyHandler', 'navigateViewer', 'updateGalleryNav', 'updateZoomPosition', 'closeMediaViewer',
    'setupVideoControls', 'updateVolumeIcon', 'formatTime', 'setupAudioControls',
    'setupStickerPanel', 'renderPanelTab', 'renderEmojiGrid', 'insertEmojiIntoInput',
    'collectEmojiRefs', 'collectEmojiRefsFromMsgEl', 'getEmojiEntry', 'renderEmojiText',
    'renderStickerGrid', 'renderStickerItems', 'renderGifPanel',
    'showStickerProgress', 'hideStickerProgress', 'setStickerSendingCooldown', 'sendStickerMessage',
    'renderUploadStickerPanel', 'setupStickerUploadModal', 'loadImageForCrop', 'initCropBox',
    'resetStickerUpload', 'processAndUploadSticker',
    'showDmForwardModal', 'loadDmForwardList',
    'decryptProfilePicData', 'getProfilePicUrl', 'updateSidebarFooter',
    'openProfileModal', 'renderProfileView', 'getDecryptedFileUrl', 'linkifyText', 'closeProfileModal',
    'openProfileEditModal', 'closeProfileEditModal', 'renderProfileEdit',
    'updateDescriptionWordCount', 'updateDisplayNameCharCount', 'updateProfileEditPreview',
    'renderEditGlowOptions', 'getColorBrightness', 'isLightColor',
    'openBannerCrop', 'updateBannerCropBox', 'updateBannerLivePreview', 'cancelBannerCrop',
    'openPfpCrop', 'updatePfpCropBox', 'updatePfpLivePreview', 'cancelPfpCrop',
    'setupMessageActions', 'waitForElement', 'handleReply', 'handleForward',
    'handleForwardToDm', 'handleDmForwardToChannel', 'handleDmForwardToDm',
    'handleEdit', 'handleDelete', 'handleEditedMessage', 'handleDeletedMessage',
    'showForwardModal', 'showForwardAllModal', 'loadForwardChannels', 'loadAllForwardChannels',
    'executeDmForwardToChannel', 'setupForwardModal', 'findForwardSenderInfo', 'executeForward',
    'loadStickerPreview', 'showDmContextMenu', 'showChannelContextMenu', 'showServerContextMenu',
    'showMentionToast', 'flashServerIcon',
];

// ─── Find all functions ──────────────────────────────────────────

console.log('\n--- WebSocket ---');
const wsFuncs = [];
for (const name of WS_NAMES) {
    const r = findFunction(code, name);
    if (r) {
        wsFuncs.push(r);
        console.log(`  ${name}: lines ${r.startLine}-${r.endLine} (${r.endLine - r.startLine + 1} lines)`);
    } else {
        console.log(`  WARNING: ${name} not found`);
    }
}

console.log('\n--- UI Functions ---');
const uiFuncs = [];
for (const name of UI_NAMES) {
    const r = findFunction(code, name);
    if (r) {
        uiFuncs.push(r);
    } else {
        console.log(`  SKIPPED: ${name} (not found)`);
    }
}
console.log(`  Found: ${uiFuncs.length}/${UI_NAMES.length}`);

// Sort by position and merge overlapping
function mergeRanges(arr) {
    if (arr.length === 0) return [];
    const sorted = [...arr].sort((a, b) => a.start - b.start);
    const merged = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        const last = merged[merged.length - 1];
        if (sorted[i].start <= last.end + 1) {
            last.end = Math.max(last.end, sorted[i].end);
            last.endLine = Math.max(last.endLine, sorted[i].endLine);
            last.text = code.slice(last.start, last.end + 1);
        } else {
            merged.push(sorted[i]);
        }
    }
    return merged;
}

const wsMerged = mergeRanges(wsFuncs);
const uiMerged = mergeRanges(uiFuncs);

console.log(`\nWS merged: ${wsMerged.length} ranges, UI merged: ${uiMerged.length} ranges`);

// ─── Build extracted code ─────────────────────────────────────────

const wsCode = wsMerged.map(r => r.text).join('\n\n');
const uiCode = uiMerged.map(r => r.text).join('\n\n');

// ─── Remove from chat.js (from end to start) ─────────────────────

let newCode = code;
const allRanges = [...wsMerged, ...uiMerged].sort((a, b) => b.start - a.start);

for (const r of allRanges) {
    newCode = newCode.slice(0, r.start) + newCode.slice(r.end + 1);
}

// Remove excessive blank lines
newCode = newCode.replace(/\n{3,}/g, '\n\n');

// ─── Write output files ──────────────────────────────────────────

const dir = path.dirname(WS_JS);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

fs.writeFileSync(WS_JS, '// === WebSocket Handler (extracted from chat.js) ===\n' +
    '// Loaded before chat.js. All functions are global, called at runtime.\n\n' +
    wsCode + '\n', 'utf-8');

fs.writeFileSync(UI_JS, '// === UI / Rendering Functions (extracted from chat.js) ===\n' +
    '// Loaded before chat.js. All functions are global, called at runtime.\n\n' +
    uiCode + '\n', 'utf-8');

fs.writeFileSync(CHAT_JS, newCode, 'utf-8');

// ─── Verify syntax ────────────────────────────────────────────────

function checkSyntax(file) {
    try {
        require('child_process').execSync(`node -c "${file}"`, { stdio: 'pipe' });
        return true;
    } catch (e) {
        return false;
    }
}

const wsOk = checkSyntax(WS_JS);
const uiOk = checkSyntax(UI_JS);
const chatOk = checkSyntax(CHAT_JS);

console.log(`\n=== Results ===`);
console.log(`  chat.js:   ${newCode.split('\n').length} lines (was ${lines.length})`);
console.log(`  chat-ws.js: ${wsCode.split('\n').length} lines`);
console.log(`  chat-ui.js: ${uiCode.split('\n').length} lines`);
console.log(`\n=== Syntax Check ===`);
console.log(`  chat-ws.js: ${wsOk ? 'OK' : 'FAIL'}`);
console.log(`  chat-ui.js: ${uiOk ? 'OK' : 'FAIL'}`);
console.log(`  chat.js:    ${chatOk ? 'OK' : 'FAIL'}`);

if (!wsOk || !uiOk || !chatOk) {
    // If chat-ui.js fails, try syntax check on its specific lines
    if (!uiOk) {
        try {
            const result = require('child_process').execSync(
                `node -e "require('child_process').execSync('node -c ${UI_JS}', {stdio:'inherit'})"`,
                { encoding: 'utf-8' }
            );
        } catch (e) {
            // Extract the error line
            const stderr = e.stderr || '';
            const match = stderr.match(/static\\js\\chat-ui\.js:(\d+)/);
            if (match) {
                const errLine = parseInt(match[1]);
                const uiLines = uiCode.split('\n');
                console.log(`\n  Error at line ${errLine} in chat-ui.js:`);
                for (let i = Math.max(0, errLine - 3); i < Math.min(uiLines.length, errLine + 2); i++) {
                    console.log(`    ${i+1}: ${uiLines[i].substring(0, 100)}`);
                }
            }
        }
    }
}

// Update index.html
let html = fs.readFileSync(INDEX, 'utf-8');

// Add chat-ws.js and chat-ui.js before chat.js
const oldScript = '<script src="chat.js';
const newScripts = '<script src="js/chat-ws.js?v=1"></script>\n    <script src="js/chat-ui.js?v=1"></script>\n    <script src="chat.js';

if (html.includes(oldScript)) {
    html = html.replace(oldScript, newScripts);
    fs.writeFileSync(INDEX, html, 'utf-8');
    console.log(`\n  index.html: Updated`);
} else {
    console.log(`\n  index.html: WARNING - chat.js script tag not found`);
}
