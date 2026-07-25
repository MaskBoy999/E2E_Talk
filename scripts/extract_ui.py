"""
Extract UI/rendering functions from chat.js into static/js/chat-ui.js.
Uses the same brace-matching approach that successfully extracted connectWebSocket.
"""
import re, os, subprocess

CHAT_JS = "X:/Documents/GitHub/E2E_Talk/static/chat.js"
UI_JS   = "X:/Documents/GitHub/E2E_Talk/static/js/chat-ui.js"
INDEX   = "X:/Documents/GitHub/E2E_Talk/static/index.html"

with open(CHAT_JS, "r", encoding="utf-8") as f:
    text = f.read()

lines = text.split("\n")
print(f"chat.js: {len(lines)} lines")

# Brace-finding function (same as in extract_ws.py, proven to work)
def find_function_end(text, start_pos):
    """Find matching close brace from start_pos (position of '{')."""
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

def extract_function(text, func_name):
    """Extract a function. Returns (start, end, func_text, start_line, end_line) or None."""
    kw = r'(?:async\s+)?'
    pattern = re.compile(kw + r'function\s+' + re.escape(func_name) + r'\s*\(')
    m = pattern.search(text)
    if not m:
        return None
    
    start = m.start()
    brace = text.find('{', start)
    if brace == -1:
        return None
    end = find_function_end(text, brace)
    if end == -1:
        return None
    
    start_line = text[:start].count('\n') + 1
    end_line = text[:end].count('\n') + 1
    func_text = text[start:end+1]
    return (start, end, func_text, start_line, end_line)

# ─── UI functions to extract ──────────────────────────────────────

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

# ─── Find and extract functions ───────────────────────────────────

results = []
for name in UI_NAMES:
    r = extract_function(text, name)
    if r:
        results.append(r)
    else:
        print(f"  SKIPPED: {name} (could not find)")

print(f"\nFound: {len(results)}/{len(UI_NAMES)}")

# Sort by position and merge overlapping ranges
results.sort(key=lambda x: x[0])
merged = [results[0]]
for r in results[1:]:
    last = merged[-1]
    if r[0] <= last[1] + 1:
        # Merge: keep wider range
        merged[-1] = (last[0], max(last[1], r[1]), last[2], last[3], max(last[4], r[4]))
    else:
        merged.append(r)

print(f"Merged into {len(merged)} contiguous ranges")

# ─── Extract and remove ──────────────────────────────────────────

# Collect UI code
ui_parts = []
for r in merged:
    ui_parts.append(text[r[0]:r[1]+1])
ui_code = '\n\n'.join(ui_parts)

# Remove from chat.js (from end to start to preserve positions)
new_text = text
for r in sorted(merged, key=lambda x: x[1], reverse=True):
    new_text = new_text[:r[0]] + new_text[r[1]+1:]

new_text = re.sub(r'\n{3,}', '\n\n', new_text)

# Write files
os.makedirs(os.path.dirname(UI_JS), exist_ok=True)

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

# Statistics
new_line_count = new_text.count('\n')
ui_line_count = ui_code.count('\n')
print(f"\n=== Statistics ===")
print(f"  chat.js:  {len(lines)} -> {new_line_count} lines ({len(lines) - new_line_count} removed)")
print(f"  chat-ui.js: {ui_line_count} lines")

# Verify JS syntax
print(f"\n--- Syntax check ---")
for path, label in [(UI_JS, "chat-ui.js"), (CHAT_JS, "chat.js")]:
    result = subprocess.run(['node', '-c', path], capture_output=True, text=True)
    ok = result.returncode == 0
    print(f"  {label}: {'OK' if ok else 'FAIL - ' + result.stderr.split(chr(10))[-2].strip()}")

# Update index.html
with open(INDEX, 'r', encoding='utf-8') as f:
    html = f.read()

old_tag = '<script src="js/chat-ws.js'
new_tags = '<script src="js/chat-ws.js?v=1"></script>\n    <script src="js/chat-ui.js?v=1"></script>\n    <script src="chat.js'

# Find the line after chat-ws.js and before chat.js
# Current: <script src="js/chat-ws.js?v=1"></script>\n    <script src="chat.js">
# Want:    <script src="js/chat-ws.js?v=1"></script>\n    <script src="js/chat-ui.js?v=1"></script>\n    <script src="chat.js">

old_pattern = r'(<script src="js/chat-ws\.js\?v=1">\s*</script>)\s*\n\s*(<script src="chat\.js)'
replacement = r'\1\n    <script src="js/chat-ui.js?v=1"></script>\n    \2'

new_html = re.sub(old_pattern, replacement, html)

if new_html != html:
    with open(INDEX, 'w', encoding='utf-8') as f:
        f.write(new_html)
    print(f"\n  index.html: Updated (added chat-ui.js between chat-ws and chat)")
else:
    # Try direct string replacement
    current_chunk = '<script src="js/chat-ws.js?v=1"></script>'
    target_chunk = '<script src="js/chat-ws.js?v=1"></script>\n    <script src="js/chat-ui.js?v=1"></script>'
    if current_chunk in html:
        html = html.replace(current_chunk, target_chunk)
        with open(INDEX, 'w', encoding='utf-8') as f:
            f.write(html)
        print(f"\n  index.html: Updated via direct replacement")
    else:
        print(f"\n  index.html: WARNING - could not find chat-ws.js tag")

print("\nDone!")
