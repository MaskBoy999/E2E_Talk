"""
Pragmatic split: extract connectWebSocket into chat-ws.js and a safe subset
of UI functions into chat-ui.js. For each UI function, validate that the
brace matching produces a valid result before extracting.
"""
import re, os

CHAT_JS = "X:/Documents/GitHub/E2E_Talk/static/chat.js"
WS_JS   = "X:/Documents/GitHub/E2E_Talk/static/js/chat-ws.js"
UI_JS   = "X:/Documents/GitHub/E2E_Talk/static/js/chat-ui.js"
INDEX   = "X:/Documents/GitHub/E2E_Talk/static/index.html"

with open(CHAT_JS, "r", encoding="utf-8") as f:
    text = f.read()
    lines = text.split("\n")

print(f"chat.js: {len(lines)} lines")

# ─── Brace matcher (with template literal interpolation support) ───

def find_end(text, start_pos):
    """Find matching close brace with string/comment/template interpolation awareness."""
    depth = 0
    i = start_pos
    in_dq = in_sq = in_bt = False
    bt_interp = 0
    
    while i < len(text):
        ch = text[i]
        nc = text[i+1] if i+1 < len(text) else ''
        
        if ch == '\\' and (in_dq or in_sq or in_bt):
            i += 2
            continue
        
        if not (in_bt and bt_interp > 0):
            if ch == '"' and not in_sq and not in_bt:
                in_dq = not in_dq
            elif ch == "'" and not in_dq and not in_bt:
                in_sq = not in_sq
            elif ch == '`' and not in_dq and not in_sq:
                in_bt = not in_bt if bt_interp == 0 else True
        
        if in_bt and not in_dq and not in_sq:
            if ch == '$' and nc == '{':
                bt_interp += 1
                i += 2
                continue
            elif ch == '}' and bt_interp > 0:
                bt_interp -= 1
                i += 1
                continue
        
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
        
        if not in_dq and not in_sq:
            if not in_bt or bt_interp > 0:
                if ch == '{': depth += 1
                elif ch == '}':
                    depth -= 1
                    if depth == 0:
                        return i
        i += 1
    return -1

def try_extract(text, name):
    """Try to extract a function by name. Returns (start, end, text) or None."""
    kw = r'(?:async\s+)?'
    pattern = re.compile(kw + r'function\s+' + re.escape(name) + r'\s*\(')
    m = pattern.search(text)
    if not m:
        return None
    
    start = m.start()
    brace = text.find('{', start)
    if brace == -1:
        return None
    
    end = find_end(text, brace)
    if end == -1:
        return None
    
    sl = text[:start].count('\n') + 1
    el = text[:end].count('\n') + 1
    
    # Validation: the extracted text should end with '}'
    func_text = text[start:end+1]
    if not func_text.rstrip().endswith('}'):
        print(f"  VALIDATION FAILED: {name} (no trailing '}}')")
        return None
    
    # Validation: count braces in extracted text
    open_count = func_text.count('{')
    close_count = func_text.count('}')
    if open_count != close_count:
        print(f"  VALIDATION FAILED: {name} ({open_count} opening vs {close_count} closing braces)")
        return None
    
    return (start, end, func_text, sl, el)

# ─── 1. Extract WebSocket handler ─────────────────────────────────

print("\n--- WebSocket ---")
ws_r = try_extract(text, 'connectWebSocket')
if ws_r:
    print(f"  connectWebSocket: lines {ws_r[3]}-{ws_r[4]} ({ws_r[4]-ws_r[3]+1} lines)")
    ws_funcs = [ws_r]
else:
    print("  FAILED: connectWebSocket could not be extracted")
    ws_funcs = []

# ─── 2. Extract safe UI functions ─────────────────────────────────

UI_NAMES = [
    'renderServerList', 'renderDmSidebar',
    'updateMentionsBadge', 'clearAllMentionItems', 'openMentionsInbox', 'closeMentionsInbox',
    'renderMentionsInbox', 'setupMentionsInboxEvents', 'initMentionsInbox',
    'updateServerBadges', 'updateChannelBadges',
    'hideModal', 'showModal',
    'getDisplayNameTextShadow', 'updateExistingMessageStyles', 'generateBorderGlowOptions',
    'formatFileSize', 'isCodeFile', 'isTextFile', 'isMarkdownFile', 'getCorrectMimeType',
    'getLangFromExt', 'getLangColors',
    'normalizeAudioMimeType', 'getFileIcon',
    'setupDragAndDrop', 'setupModalDragAndDrop', 'handleFileSelect',
    'showUploadModal', 'renderUploadPreview', 'closeUploadModal',
    'buildFileCardHtml', 'revokeBlobUrls', 'extractRawMessageText',
    'updateGalleryState', 'buildMultiFileCardHtml',
    'viewerKeyHandler', 'navigateViewer', 'updateGalleryNav', 'updateZoomPosition', 'closeMediaViewer',
    'updateVolumeIcon', 'formatTime',
    'renderPanelTab', 'insertEmojiIntoInput',
    'getEmojiEntry', 'renderStickerGrid',
    'showStickerProgress', 'hideStickerProgress', 'setStickerSendingCooldown',
    'showDmForwardModal',
    'decryptProfilePicData', 'getProfilePicUrl', 'updateSidebarFooter',
    'openProfileEditModal', 'closeProfileEditModal',
    'updateDescriptionWordCount', 'updateDisplayNameCharCount', 'renderEditGlowOptions',
    'getColorBrightness', 'isLightColor',
    'updateBannerCropBox', 'updateBannerLivePreview', 'cancelBannerCrop',
    'updatePfpCropBox', 'updatePfpLivePreview', 'cancelPfpCrop',
    'waitForElement', 'handleForward', 'handleForwardToDm', 'handleDmForwardToChannel',
    'handleDmForwardToDm', 'handleDelete', 'handleDeletedMessage',
    'showForwardModal', 'showForwardAllModal',
    'findForwardSenderInfo',
    'showDmContextMenu', 'showChannelContextMenu', 'showServerContextMenu',
    'showMentionToast', 'flashServerIcon',
    'linkifyText', 'closeProfileModal',
    'escapeAttr', 'escapeJsStr',
    'setupStickerPanel', 'renderEmojiGrid', 'setupStickerUploadModal',
    'resetStickerUpload', 'loadDmForwardList',
    'setupAudioControls', 'setupVideoControls',
    'collectEmojiRefs', 'collectEmojiRefsFromMsgEl',
    'renderStickerItems', 'renderGifPanel',
    'loadStickerPreview',
    'loadImageForCrop', 'initCropBox',
    'loadForwardChannels', 'loadAllForwardChannels',
    'executeDmForwardToChannel', 'setupForwardModal', 'executeForward',
    'getContrastGlowColor',
    'renderEmojiText',
    'getDecryptedFileUrl',
]

print(f"\n--- UI Functions (testing {len(UI_NAMES)}) ---")
ui_funcs = []
for name in UI_NAMES:
    r = try_extract(text, name)
    if r:
        ui_funcs.append(r)
        print(f"  OK: {name} (lines {r[3]}-{r[4]}, {r[4]-r[3]+1} lines)")
    else:
        print(f"  SKIP: {name} (extraction failed)")

print(f"\n  Extracted: {len(ui_funcs)}/{len(UI_NAMES)}")

# ─── 3. Merge overlapping ranges ──────────────────────────────────

def merge(ranges):
    if not ranges:
        return []
    sorted_r = sorted(ranges, key=lambda x: x[0])
    merged = [sorted_r[0]]
    for r in sorted_r[1:]:
        last = merged[-1]
        if r[0] <= last[1] + 1:
            merged[-1] = (last[0], max(last[1], r[1]), last[2], last[3], max(last[4], r[4]))
        else:
            merged.append(r)
    return merged

ui_merged = merge(ui_funcs)
ws_merged = merge(ws_funcs)

print(f"\n  WS merged: {len(ws_merged)} range(s)")
print(f"  UI merged: {len(ui_merged)} range(s)")

# ─── 4. Extract code ──────────────────────────────────────────────

# Build WS code
ws_parts = [text[r[0]:r[1]+1] for r in ws_merged]
ws_code = '\n\n'.join(ws_parts)

# Build UI code
ui_parts = [text[r[0]:r[1]+1] for r in ui_merged]
ui_code = '\n\n'.join(ui_parts)

# ─── 5. Remove from chat.js ──────────────────────────────────────

all_ranges = list(ws_merged) + list(ui_merged)
all_ranges.sort(key=lambda x: x[0], reverse=True)

new_text = text
for r in all_ranges:
    new_text = new_text[:r[0]] + new_text[r[1]+1:]

new_text = re.sub(r'\n{3,}', '\n\n', new_text)

# ─── 6. Write files ──────────────────────────────────────────────

os.makedirs(os.path.dirname(WS_JS), exist_ok=True)

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

with open(CHAT_JS, 'w', encoding='utf-8') as f:
    f.write(new_text)
    if not new_text.endswith('\n'):
        f.write('\n')

# ─── 7. Statistics ────────────────────────────────────────────────

new_line_count = new_text.count('\n')
ws_line_count = ws_code.count('\n')
ui_line_count = ui_code.count('\n')

print(f"\n=== Results ===")
print(f"  chat.js:    {len(lines):>6} -> {new_line_count:>6} lines (removed {len(lines)-new_line_count})")
print(f"  chat-ws.js: {ws_line_count:>6} lines")
print(f"  chat-ui.js: {ui_line_count:>6} lines")

# Verify syntax
import subprocess
all_ok = True
for path, label in [(WS_JS, "chat-ws.js"), (UI_JS, "chat-ui.js"), (CHAT_JS, "chat.js")]:
    r = subprocess.run(['node', '-c', path], capture_output=True, text=True)
    ok = r.returncode == 0
    print(f"  {label}: {'OK' if ok else 'FAIL - ' + (r.stderr.split(chr(10))[-2] if r.stderr else '?')}")
    if not ok:
        all_ok = False

# Update index.html
if all_ok:
    with open(INDEX, 'r', encoding='utf-8') as f:
        html = f.read()
    
    old_tag = '<script src="chat.js'
    new_tags = '<script src="js/chat-ws.js?v=1"></script>\n    <script src="js/chat-ui.js?v=1"></script>\n    <script src="chat.js'
    
    if old_tag in html:
        html = html.replace(old_tag, new_tags)
        with open(INDEX, 'w', encoding='utf-8') as f:
            f.write(html)
        print(f"\n  index.html: Updated")
    else:
        print(f"\n  index.html: WARNING - script tag not found")
else:
    print(f"\n  index.html: NOT updated (syntax errors exist)")

print("\nDone!")
