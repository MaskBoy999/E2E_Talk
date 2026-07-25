"""
Redo the extraction with proper handling of template literal interpolations.
The key fix: when inside a backtick string `${` starts a nested JS expression,
so braces inside interpolations MUST be counted.
"""
import re, os

PROJECT = "X:/Documents/GitHub/E2E_Talk"
CHAT_JS = os.path.join(PROJECT, "static/chat.js")

# Read original from git
import subprocess
result = subprocess.run(
    ["git", "show", "HEAD:static/chat.js"],
    capture_output=True, cwd=PROJECT, encoding='utf-8'
)
text = result.stdout

if not text:
    print("ERROR: Could not read original chat.js from git")
    exit(1)

lines = text.split("\n")
print(f"Original chat.js: {len(lines)} lines")

def find_matching_brace(text, start_pos):
    """
    Find matching close brace with awareness of:
    - Single/double quotes
    - Template literals (backticks) with ${...} interpolations
    - Single-line (//) and multi-line (/* */) comments
    """
    depth = 0
    i = start_pos
    in_dq = False
    in_sq = False
    in_bt = False           # in backtick string
    bt_depth = 0            # nested interpolation depth
    
    while i < len(text):
        ch = text[i]
        nc = text[i+1] if i+1 < len(text) else ''
        
        if ch == '\\' and (in_dq or in_sq or in_bt):
            i += 2
            continue
        
        # String toggles - only if not in a deeper context
        if not (in_bt and bt_depth > 0):
            if ch == '"' and not in_sq and not in_bt:
                in_dq = not in_dq
            elif ch == "'" and not in_dq and not in_bt:
                in_sq = not in_sq
            elif ch == '`' and not in_dq and not in_sq:
                if in_bt:
                    # If we're in a template literal interpolation (${...}), 
                    # closing backtick ends the template
                    if bt_depth == 0:
                        in_bt = False
                    # If inside interpolation, backtick is part of the expression
                else:
                    in_bt = True
                    bt_depth = 0
        else:
            # Inside template literal, backtick is just a character
            pass
        
        # Handle ${ that starts interpolation in template literals
        if in_bt and not in_dq and not in_sq:
            if ch == '$' and nc == '{':
                bt_depth += 1
                i += 2
                continue
            elif ch == '}' and bt_depth > 0:
                bt_depth -= 1
                i += 1
                continue
            elif ch == '`' and bt_depth == 0:
                in_bt = False
        
        # Comments
        if not in_dq and not in_sq and not in_bt:
            if ch == '/' and nc == '/':
                while i < len(text) and text[i] != '\n':
                    i += 1
            elif ch == '/' and nc == '*':
                i += 2
                while i < len(text):
                    if text[i] == '*' and i+1 < len(text) and text[i+1] == '/':
                        i += 1
                        break
                    i += 1
        
        # Brace counting - only when not in string context
        if not in_dq and not in_sq:
            in_expr = in_bt and bt_depth > 0
            if not in_bt or in_expr:
                if ch == '{':
                    depth += 1
                elif ch == '}':
                    depth -= 1
                    if depth == 0:
                        return i
        
        i += 1
    return -1

def find_function(text, func_name):
    """Find function by name, return (start, end, start_line, end_line, func_text) or None."""
    kw = r'async\s+' if 'async' in text else r''
    pattern = re.compile(r'(?:async\s+)?function\s+' + re.escape(func_name) + r'\s*\(')
    m = pattern.search(text)
    if not m:
        return None
    
    start = m.start()
    brace = text.find('{', start)
    if brace == -1:
        return None
    end = find_matching_brace(text, brace)
    if end == -1:
        return None
    
    start_line = text[:start].count('\n') + 1
    end_line = text[:end].count('\n') + 1
    func_text = text[start:end+1]
    return (start, end, start_line, end_line, func_text)

def merge_ranges_unordered(ranges):
    """Merge overlapping/adjacent ranges. ranges is list of (start, end, sl, el, text) or similar tuples with start/end at indices 0,1."""
    if not ranges:
        return []
    sorted_r = sorted(ranges, key=lambda x: x[0])
    merged = [sorted_r[0]]
    for r in sorted_r[1:]:
        last = merged[-1]
        if r[0] <= last[1] + 1:
            merged[-1] = (last[0], max(last[1], r[1]), last[2], r[4], last[4])
        else:
            merged.append(r)
    return merged

# ─── Functions to extract ──────────────────────────────────────────

WS_NAMES = ['connectWebSocket']

UI_NAMES = [
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
]

# ─── Extract functions ────────────────────────────────────────────

print("\n--- Extracting WebSocket functions ---")
ws_funcs = []
for name in WS_NAMES:
    r = find_function(text, name)
    if r:
        ws_funcs.append(r)
        print(f"  {name}: lines {r[2]}-{r[3]} ({r[3]-r[2]+1} lines)")
    else:
        print(f"  WARNING: {name} not found")

print(f"\n--- Extracting UI functions ---")
ui_funcs = []
for name in UI_NAMES:
    r = find_function(text, name)
    if r:
        ui_funcs.append(r)
    else:
        print(f"  WARNING: {name} not found")
print(f"  Found: {len(ui_funcs)}/{len(UI_NAMES)}")

# Merge overlapping ranges
ws_merged = merge_ranges_unordered(ws_funcs)
ui_merged = merge_ranges_unordered(ui_funcs)

print(f"\n  WS merged ranges: {len(ws_merged)}")
print(f"  UI merged ranges: {len(ui_merged)}")

# ─── Build extracted code ──────────────────────────────────────────

ws_code_parts = []
for r in ws_merged:
    ws_code_parts.append(text[r[0]:r[1]+1])
ws_code = '\n\n'.join(ws_code_parts)

ui_code_parts = []
for r in ui_merged:
    ui_code_parts.append(text[r[0]:r[1]+1])
ui_code = '\n\n'.join(ui_code_parts)

# ─── Remove from chat.js ──────────────────────────────────────────

all_ranges = list(ws_merged) + list(ui_merged)
all_ranges.sort(key=lambda x: x[0], reverse=True)

new_text = text
for r in all_ranges:
    new_text = new_text[:r[0]] + new_text[r[1]+1:]

# ─── Write files ──────────────────────────────────────────────────

os.makedirs(os.path.join(PROJECT, "static/js"), exist_ok=True)

WS_JS = os.path.join(PROJECT, "static/js/chat-ws.js")
UI_JS = os.path.join(PROJECT, "static/js/chat-ui.js")
CHAT_JS_OUT = os.path.join(PROJECT, "static/chat.js")

with open(WS_JS, 'w', encoding='utf-8') as f:
    f.write('// === WebSocket Handler (extracted from chat.js) ===\n')
    f.write('// Loaded before chat.js. All functions are global, called at runtime.\n\n')
    f.write(ws_code)
    if not ws_code.endswith('\n'):
        f.write('\n')

with open(UI_JS, 'w', encoding='utf-8') as f:
    f.write('// === UI / Rendering Functions (extracted from chat.js) ===\n')
    f.write('// Loaded before chat.js. All functions are global, called at runtime.\n\n')
    f.write(ui_code)
    if not ui_code.endswith('\n'):
        f.write('\n')

with open(CHAT_JS_OUT, 'w', encoding='utf-8') as f:
    f.write(new_text)
    if not new_text.endswith('\n'):
        f.write('\n')

# ─── Verify ────────────────────────────────────────────────────────

new_lines = new_text.count('\n')
ws_lines = len(ws_code.split('\n'))
ui_lines = len(ui_code.split('\n'))

print(f"\n=== Statistics ===")
print(f"  Original: {len(lines)} lines")
print(f"  chat.js:  {new_lines} lines")
print(f"  chat-ws.js: {ws_lines} lines")
print(f"  chat-ui.js: {ui_lines} lines")

# Quick brace check on output files
def check_braces(content, label):
    """Quick brace balance check."""
    stack = []
    in_dq = in_sq = in_bt = False
    for i, ch in enumerate(content):
        if ch == '\\' and (in_dq or in_sq or in_bt):
            continue
        if ch == '"' and not in_sq and not in_bt: in_dq = not in_dq
        elif ch == "'" and not in_dq and not in_bt: in_sq = not in_sq
        elif ch == '`' and not in_dq and not in_sq: in_bt = not in_bt
        if not in_dq and not in_sq and not in_bt:
            if ch == '{': stack.append(i)
            elif ch == '}':
                if not stack: print(f"  {label}: extra }} at pos {i}")
                else: stack.pop()
    if stack:
        print(f"  {label}: {len(stack)} unclosed braces")
        for pos in stack[:5]:
            line_no = content[:pos].count('\n') + 1
            print(f"    line {line_no}")
    else:
        print(f"  {label}: braces balanced")

check_braces(new_text, "chat.js")
check_braces(ws_code, "chat-ws.js")
check_braces(ui_code, "chat-ui.js")

# Update index.html
INDEX = os.path.join(PROJECT, "static/index.html")
with open(INDEX, 'r', encoding='utf-8') as f:
    html = f.read()

old_tag = '<script src="chat.js'
new_tags = '<script src="js/chat-ws.js?v=1"></script>\n    <script src="js/chat-ui.js?v=1"></script>\n    <script src="chat.js'

if old_tag in html:
    html = html.replace(old_tag, new_tags)
    with open(INDEX, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"\n  Updated index.html")
else:
    print(f"\n  WARNING: Could not find script tag in index.html")

print("\nDone!")
