"""
Reliable extraction of functions from chat.js:
1. Extract connectWebSocket (lines 4383-5112) -> chat-ws.js
2. Extract key UI/rendering functions -> chat-ui.js  
3. Remove extracted functions from chat.js
4. Update index.html to load new files

Uses simple brace matching with string/comment awareness.
"""
import re, os, shutil

PROJECT = "X:/Documents/GitHub/E2E_Talk"
CHAT_JS = os.path.join(PROJECT, "static/chat.js")
WS_JS   = os.path.join(PROJECT, "static/js/chat-ws.js")
UI_JS   = os.path.join(PROJECT, "static/js/chat-ui.js")
INDEX   = os.path.join(PROJECT, "static/index.html")

with open(CHAT_JS, "r", encoding="utf-8") as f:
    text = f.read()
    lines = text.split("\n")

print(f"chat.js: {len(lines)} lines")

def find_matching_brace(text, start_pos):
    """Find the matching closing brace, skipping strings and comments."""
    depth = 0
    i = start_pos
    in_dq = False
    in_sq = False
    in_bt = False
    
    while i < len(text):
        ch = text[i]
        nc = text[i+1] if i+1 < len(text) else ''
        
        if ch == '\\' and (in_dq or in_sq or in_bt):
            i += 2
            continue
        if ch == '"' and not in_sq and not in_bt:
            in_dq = not in_dq
        elif ch == "'" and not in_dq and not in_bt:
            in_sq = not in_sq
        elif ch == '`' and not in_dq and not in_sq:
            in_bt = not in_bt
        elif not (in_dq or in_sq or in_bt):
            if ch == '/' and nc == '/':
                # Single line comment
                while i < len(text) and text[i] != '\n':
                    i += 1
            elif ch == '/' and nc == '*':
                # Multi-line comment
                i += 2
                while i < len(text):
                    if text[i] == '*' and i+1 < len(text) and text[i+1] == '/':
                        i += 1
                        break
                    i += 1
            elif ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    return i
        i += 1
    return -1

def extract_function(text, func_name, is_async=False):
    """Find a function by name and return (start_pos, end_pos, func_text) or None."""
    kw = r'async\s+' if is_async else r''
    pattern = re.compile(kw + r'function\s+' + re.escape(func_name) + r'\s*\(')
    m = pattern.search(text)
    if not m:
        return None
    
    start = m.start()
    # Find opening brace
    brace = text.find('{', start)
    if brace == -1:
        return None
    end = find_matching_brace(text, brace)
    if end == -1:
        return None
    
    start_line = text[:start].count('\n') + 1
    end_line = text[:end].count('\n') + 1
    func_text = text[start:end+1]
    return (start, end, func_text, start_line, end_line)

def find_function_boundaries(text, func_names):
    """Find all functions, try async first then sync."""
    results = []
    for name in func_names:
        r = extract_function(text, name, is_async=True)
        if r is None:
            r = extract_function(text, name, is_async=False)
        if r:
            results.append(r)
        else:
            print(f"  WARNING: Could not find function '{name}'")
    return results

def merge_ranges(ranges):
    """Merge overlapping ranges. ranges is list of (start, end, func_text, sl, el)."""
    if not ranges:
        return []
    sorted_r = sorted(ranges, key=lambda x: x[0])
    merged = [sorted_r[0]]
    for r in sorted_r[1:]:
        last = merged[-1]
        if r[0] <= last[1] + 1:
            # Merge: keep the wider range
            new_start = min(last[0], r[0])
            new_end = max(last[1], r[1])
            merged[-1] = (new_start, new_end, last[2], last[3], max(last[4], r[4]))
        else:
            merged.append(r)
    return merged

# ─── Group functions by category ──────────────────────────────────

WS_NAMES = [
    'connectWebSocket',
]

UI_NAMES = [
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

# ─── Find all functions ────────────────────────────────────────────

print("\n--- WebSocket functions ---")
ws_results = find_function_boundaries(text, WS_NAMES)
for r in ws_results:
    print(f"  {WS_NAMES[ws_results.index(r)]}: lines {r[3]}-{r[4]} ({r[4]-r[3]+1} lines)")

print(f"\n--- UI functions ---")
ui_results = find_function_boundaries(text, UI_NAMES)
print(f"  Found: {len(ui_results)}/{len(UI_NAMES)}")
for r in ui_results:
    name_idx = ui_results.index(r)
    name = UI_NAMES[name_idx] if name_idx < len(UI_NAMES) else '?'
    print(f"  {name}: lines {r[3]}-{r[4]} ({r[4]-r[3]+1} lines)")

# Merge overlapping ranges within each category
ws_merged = merge_ranges(ws_results)
ui_merged = merge_ranges(ui_results)

print(f"\nMerged WS ranges: {len(ws_merged)}")
print(f"Merged UI ranges: {len(ui_merged)}")

# ─── Extract code ──────────────────────────────────────────────────

# Build extracted text for each file
ws_parts = []
for start, end, _, sl, el in ws_merged:
    ws_parts.append(text[start:end+1])
ws_code = '\n\n'.join(ws_parts)

ui_parts = []
for start, end, _, sl, el in ui_merged:
    ui_parts.append(text[start:end+1])
ui_code = '\n\n'.join(ui_parts)

# ─── Remove from chat.js ──────────────────────────────────────────
# Build set of all character positions to remove
all_ranges = list(ws_merged) + list(ui_merged)
all_ranges.sort(key=lambda x: x[0])

# Remove from end to keep positions valid
new_text = text
for start, end, _, _, _ in sorted(all_ranges, key=lambda x: x[1], reverse=True):
    new_text = new_text[:start] + new_text[end+1:]

# ─── Write files ──────────────────────────────────────────────────

os.makedirs(os.path.join(PROJECT, "static/js"), exist_ok=True)

with open(WS_JS, 'w', encoding='utf-8') as f:
    f.write('// === WebSocket Handler (extracted from chat.js) ===\n')
    f.write('// Loaded before chat.js. All functions are global and called at runtime.\n\n')
    f.write(ws_code)
    if not ws_code.endswith('\n'):
        f.write('\n')

with open(UI_JS, 'w', encoding='utf-8') as f:
    f.write('// === UI / Rendering Functions (extracted from chat.js) ===\n')
    f.write('// Loaded before chat.js. All functions are global and called at runtime.\n\n')
    f.write(ui_code)
    if not ui_code.endswith('\n'):
        f.write('\n')

with open(CHAT_JS, 'w', encoding='utf-8') as f:
    f.write(new_text)
    if not new_text.endswith('\n'):
        f.write('\n')

# ─── Stats ─────────────────────────────────────────────────────────

new_lines = new_text.count('\n')
print(f"\n=== Statistics ===")
print(f"  Original chat.js: {len(lines)} lines")
print(f"  New chat.js:      {new_lines} lines")
print(f"  chat-ws.js:      {len(ws_code.split(chr(10)))} lines (WS functions)")
print(f"  chat-ui.js:      {len(ui_code.split(chr(10)))} lines (UI functions)")

# ─── Update index.html ────────────────────────────────────────────

with open(INDEX, 'r', encoding='utf-8') as f:
    html = f.read()

# Add chat-ws.js and chat-ui.js before chat.js
old_script = '<script src="chat.js'
new_scripts = '<script src="js/chat-ws.js?v=1"></script>\n    <script src="js/chat-ui.js?v=1"></script>\n    <script src="chat.js'

if old_script in html:
    html = html.replace(old_script, new_scripts)
    with open(INDEX, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"\n  Updated {INDEX}")
else:
    print(f"\n  WARNING: Could not find '{old_script}' in index.html")

print("\nDone!")
