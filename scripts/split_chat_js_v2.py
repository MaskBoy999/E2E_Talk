"""
Precise extraction of functions from chat.js using brace matching.
Extracts complete function bodies (not just line ranges), so chat.js
remains syntactically valid after removal.

Strategy: for each function to extract, find its matching '}' by
counting braces (skipping strings/template literals/regex), then
replace the entire function definition with a comment placeholder.
"""
import re
import os

PROJECT = "X:/Documents/GitHub/E2E_Talk"
CHAT_JS = os.path.join(PROJECT, "static/chat.js")
WS_JS   = os.path.join(PROJECT, "static/js/chat-ws.js")
UI_JS   = os.path.join(PROJECT, "static/js/chat-ui.js")

with open(CHAT_JS, "r", encoding="utf-8") as f:
    text = f.read()
    original_text = text

lines = text.split("\n")
print(f"chat.js: {len(lines)} lines")

def find_matching_brace(text, start_pos, open_brace='{', close_brace='}'):
    """Find the position of the matching close brace starting from start_pos.
    Skips characters inside strings and template literals."""
    depth = 0
    in_double = False
    in_single = False
    in_backtick = False
    in_regex = False
    i = start_pos
    
    while i < len(text):
        ch = text[i]
        next_ch = text[i+1] if i+1 < len(text) else ''
        
        # Handle string escapes
        if ch == '\\' and (in_double or in_single or in_backtick):
            i += 2
            continue
        
        # Toggle string states
        if ch == '"' and not in_single and not in_backtick and not in_regex:
            in_double = not in_double
        elif ch == "'" and not in_double and not in_backtick and not in_regex:
            in_single = not in_single
        elif ch == '`' and not in_double and not in_single and not in_regex:
            in_backtick = not in_backtick
        
        # Track regex (simplified: after = , ( ! & | ; or at start of line)
        if not in_double and not in_single and not in_backtick:
            if ch == '/' and next_ch not in ('/', '*') and not in_regex:
                # Could be regex start
                pass  # simplified
            
        if not in_double and not in_single and not in_backtick:
            if ch == open_brace:
                depth += 1
            elif ch == close_brace:
                depth -= 1
                if depth == 0:
                    return i
        i += 1
    
    return -1  # not found

def find_function_end(text, func_start):
    """Find the end position of a function declaration starting at func_start.
    func_start should be the position of 'function' keyword."""
    # Find the opening brace
    brace_pos = text.find('{', func_start)
    if brace_pos == -1:
        return -1
    return find_matching_brace(text, brace_pos)

def get_line_ranges_for_funcs(text, func_names, start_line=None, end_line=None):
    """Find all function definitions matching func_names and return their
    (start_line, end_line) 1-indexed ranges."""
    results = []
    # Pattern to match async function NAME( or function NAME(
    for name in func_names:
        pattern = re.compile(
            r'(?:async\s+)?function\s+' + re.escape(name) + r'\s*\('
        )
        for m in pattern.finditer(text):
            pos = m.start()
            # Find the matching close brace
            end_pos = find_function_end(text, pos)
            if end_pos > 0:
                start_line = text[:pos].count('\n') + 1
                end_line = text[:end_pos].count('\n') + 1
                results.append((name, start_line, end_line, pos, end_pos))
    return results

# ─── Categories ─────────────────────────────────────────────────────

# WebSocket handler functions (go to chat-ws.js)
WS_FUNCS = ['connectWebSocket']

# UI/Rendering functions (go to chat-ui.js)
UI_FUNCS = [
    'renderServerList',
    'renderDmSidebar',
    'appendMessage',
    'appendDmMessage',
    'updateMentionsBadge',
    'clearAllMentionItems',
    'openMentionsInbox',
    'closeMentionsInbox',
    'renderMentionsInbox',
    'setupMentionsInboxEvents',
    'initMentionsInbox',
    'updateServerBadges',
    'updateChannelBadges',
    'hideModal',
    'showModal',
    'escapeAttr',
    'getContrastGlowColor',
    'getDisplayNameTextShadow',
    'updateExistingMessageStyles',
    'generateBorderGlowOptions',
    'escapeJsStr',
    'formatFileSize',
    'isCodeFile',
    'isTextFile',
    'isMarkdownFile',
    'getCorrectMimeType',
    'getLangFromExt',
    'getLangColors',
    'highlightSyntax',
    'highlightHtml',
    'highlightJson',
    'highlightCss',
    'highlightKeyValue',
    'highlightGeneric',
    'renderMarkdown',
    'normalizeAudioMimeType',
    'getFileIcon',
    'setupDragAndDrop',
    'setupModalDragAndDrop',
    'handleFileSelect',
    'showUploadModal',
    'renderUploadPreview',
    'closeUploadModal',
    'buildFileCardHtml',
    'revokeBlobUrls',
    'extractRawMessageText',
    'updateGalleryState',
    'buildMultiFileCardHtml',
    'loadMediaPreview',
    'openMediaViewer',
    'viewerKeyHandler',
    'navigateViewer',
    'updateGalleryNav',
    'updateZoomPosition',
    'closeMediaViewer',
    'setupVideoControls',
    'updateVolumeIcon',
    'formatTime',
    'setupAudioControls',
    'setupStickerPanel',
    'renderPanelTab',
    'renderEmojiGrid',
    'insertEmojiIntoInput',
    'collectEmojiRefs',
    'collectEmojiRefsFromMsgEl',
    'getEmojiEntry',
    'renderEmojiText',
    'renderStickerGrid',
    'renderStickerItems',
    'renderGifPanel',
    'showStickerProgress',
    'hideStickerProgress',
    'setStickerSendingCooldown',
    'sendStickerMessage',
    'renderUploadStickerPanel',
    'setupStickerUploadModal',
    'loadImageForCrop',
    'initCropBox',
    'resetStickerUpload',
    'processAndUploadSticker',
    'showDmForwardModal',
    'loadDmForwardList',
    'decryptProfilePicData',
    'getProfilePicUrl',
    'updateSidebarFooter',
    'openProfileModal',
    'renderProfileView',
    'getDecryptedFileUrl',
    'linkifyText',
    'closeProfileModal',
    'openProfileEditModal',
    'closeProfileEditModal',
    'renderProfileEdit',
    'updateDescriptionWordCount',
    'updateDisplayNameCharCount',
    'updateProfileEditPreview',
    'renderEditGlowOptions',
    'getColorBrightness',
    'isLightColor',
    'openBannerCrop',
    'updateBannerCropBox',
    'updateBannerLivePreview',
    'cancelBannerCrop',
    'openPfpCrop',
    'updatePfpCropBox',
    'updatePfpLivePreview',
    'cancelPfpCrop',
    # Message action handlers
    'setupMessageActions',
    'waitForElement',
    'handleReply',
    'handleForward',
    'handleForwardToDm',
    'handleDmForwardToChannel',
    'handleDmForwardToDm',
    'handleEdit',
    'handleDelete',
    'handleEditedMessage',
    'handleDeletedMessage',
    'showForwardModal',
    'showForwardAllModal',
    'loadForwardChannels',
    'loadAllForwardChannels',
    'executeDmForwardToChannel',
    'setupForwardModal',
    'findForwardSenderInfo',
    'executeForward',
    'loadStickerPreview',
    'showDmContextMenu',
    'showChannelContextMenu',
    'showServerContextMenu',
    'showMentionToast',
    'flashServerIcon',
]

# Verify all functions exist
all_funcs = WS_FUNCS + UI_FUNCS
results = get_line_ranges_for_funcs(text, all_funcs)

found_names = set(r[0] for r in results)
not_found = [f for f in all_funcs if f not in found_names]
if not_found:
    print(f"\nWARNING: {len(not_found)} functions not found:")
    for f in not_found:
        print(f"  {f}")

# Separate WS, UI, and remaining
ws_results = [r for r in results if r[0] in WS_FUNCS]
ui_results = [r for r in results if r[0] in UI_FUNCS]

print(f"\nWebSocket functions found: {len(ws_results)}")
for name, s, e, _, _ in ws_results:
    print(f"  {name}: lines {s}-{e} ({e-s+1} lines)")

print(f"\nUI functions found: {len(ui_results)}")
for name, s, e, _, _ in ui_results:
    print(f"  {name}: lines {s}-{e} ({e-s+1} lines)")

# ─── Build extraction maps ──────────────────────────────────────────
# Collect all line ranges to extract (as sorted, non-overlapping ranges)
def build_intervals(results):
    """Build sorted, non-overlapping intervals from function results.
    Returns list of (start_line, end_line) 1-indexed, sorted by start."""
    intervals = []
    for name, s, e, _, _ in results:
        intervals.append((s, e))
    intervals.sort()
    # Merge overlapping
    merged = []
    for s, e in intervals:
        if not merged:
            merged.append([s, e])
        else:
            last = merged[-1]
            if s <= last[1] + 1:
                last[1] = max(last[1], e)
            else:
                merged.append([s, e])
    return [(s, e) for s, e in merged]

ws_intervals = build_intervals(ws_results)
ui_intervals = build_intervals(ui_results)

print(f"\nWS intervals: {len(ws_intervals)}")
for s, e in ws_intervals:
    print(f"  {s}-{e} ({e-s+1} lines)")

print(f"\nUI intervals: {len(ui_intervals)}")
for s, e in ui_intervals:
    print(f"  {s}-{e} ({e-s+1} lines)")

# ─── Extract code ───────────────────────────────────────────────────

lines_list = original_text.split('\n')

# Extract WS code
all_ws_text_parts = []
for s, e in ws_intervals:
    # 1-indexed to 0-indexed
    part = '\n'.join(lines_list[s-1:e])
    all_ws_text_parts.append(part)
ws_code = '\n\n'.join(all_ws_text_parts)

# Extract UI code
all_ui_text_parts = []
for s, e in ui_intervals:
    part = '\n'.join(lines_list[s-1:e])
    all_ui_text_parts.append(part)
ui_code = '\n\n'.join(all_ui_text_parts)

# ─── Remove extracted code from chat.js ────────────────────────────
# Build set of line indices (0-indexed) to remove
all_remove = set()
for name, s, e, _, _ in ws_results:
    for i in range(s-1, e):
        all_remove.add(i)
for name, s, e, _, _ in ui_results:
    for i in range(s-1, e):
        all_remove.add(i)

new_lines = []
for i, line in enumerate(lines_list):
    if i not in all_remove:
        new_lines.append(line)
    else:
        # Add a blank line to preserve rough structure
        new_lines.append('')  # empty line placeholder

# ─── Write output files ────────────────────────────────────────────

os.makedirs(os.path.join(PROJECT, "static/js"), exist_ok=True)

# chat-ws.js
with open(WS_JS, 'w', encoding='utf-8') as f:
    f.write('// === WebSocket Handler (extracted from chat.js) ===\n')
    f.write('// Loaded before chat.js. All functions are global and called at runtime.\n\n')
    f.write(ws_code)
    if not ws_code.endswith('\n'):
        f.write('\n')
print(f"\nWritten: {WS_JS}")

# chat-ui.js
with open(UI_JS, 'w', encoding='utf-8') as f:
    f.write('// === UI / Rendering Functions (extracted from chat.js) ===\n')
    f.write('// Loaded before chat.js. All functions are global and called at runtime.\n\n')
    f.write(ui_code)
    if not ui_code.endswith('\n'):
        f.write('\n')
print(f"Written: {UI_JS}")

# chat.js (modified)
with open(CHAT_JS, 'w', encoding='utf-8') as f:
    f.write('\n'.join(new_lines))
print(f"Written: {CHAT_JS}")

# Statistics
n_removed = len(all_remove)
print(f"\nStatistics:")
print(f"  Original chat.js:  {len(lines_list)} lines")
print(f"  New chat.js:       {len(new_lines)} lines")
print(f"  Removed:           {n_removed} function-definition lines")
print(f"  chat-ws.js:        {len(ws_code.split(chr(10)))} lines")
print(f"  chat-ui.js:        {len(ui_code.split(chr(10)))} lines")
print(f"  Total extracted:   {len(ws_code.split(chr(10))) + len(ui_code.split(chr(10)))} lines")
