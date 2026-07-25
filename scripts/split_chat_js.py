"""
Split static/chat.js into three files:
1. static/js/chat-ws.js  - WebSocket handler (connectWebSocket)
2. static/js/chat-ui.js  - UI rendering/presentation functions
3. static/chat.js        - Core logic (with extracted code removed)

This script uses precise line ranges extracted from grep output.
"""
import os

PROJECT = "X:/Documents/GitHub/E2E_Talk"
CHAT_JS = os.path.join(PROJECT, "static/chat.js")
WS_JS   = os.path.join(PROJECT, "static/js/chat-ws.js")
UI_JS   = os.path.join(PROJECT, "static/js/chat-ui.js")

# Read the full file
with open(CHAT_JS, "r", encoding="utf-8") as f:
    lines = f.readlines()

total_lines = len(lines)
print(f"chat.js: {total_lines} lines")

# ── 1. WebSocket handler: lines 4255-5028 (1-indexed) ───────────────────
# This is the single connectWebSocket function
WS_START = 4255  # 1-indexed
WS_END   = 5028  # inclusive

ws_code = lines[WS_START-1:WS_END]  # 0-indexed slice

# ── 2. UI / rendering functions ─────────────────────────────────────────
# These are the primary rendering/presentation functions.
# They reference global variables and core functions defined in chat.js.
# Safe to extract because they're only called at runtime after all scripts load.
#
# Line ranges (1-indexed, inclusive):
ui_ranges = [
    # Mention/notification rendering
    (3700, 3737),   # updateMentionsBadge, clearAllMentionItems, openMentionsInbox, closeMentionsInbox
    (3745, 3822),   # renderMentionsInbox, setupMentionsInboxEvents, initMentionsInbox
    (3842, 3901),   # updateServerBadges, updateChannelBadges, showDmContextMenu (partial)

    # Server/channel list rendering
    (5251, 5282),   # renderServerList

    # Message rendering
    (5679, 6080),   # appendMessage
    (6081, 6177),   # loadStickerPreview
    (6178, 6321),   # setupMessageActions
    (6322, 6819),   # waitForElement, handleReply/handleForward/handleEdit/handleDelete/handleEditedMessage/handleDeletedMessage
    (6820, 6985),   # showForwardModal, showForwardAllModal, loadForwardChannels, loadAllForwardChannels, executeDmForwardToChannel
    (6986, 7146),   # setupForwardModal, findForwardSenderInfo, executeForward

    # DM sidebar rendering
    (7362, 7491),   # renderDmSidebar

    # DM message rendering
    (7592, 7982),   # appendDmMessage

    # Utility/helper rendering functions
    (9216, 9300),   # hideModal, showModal, escapeAttr, getContrastGlowColor
    (9292, 9350),   # getDisplayNameTextShadow, updateExistingMessageStyles
    (9350, 9398),   # generateBorderGlowOptions, escapeJsStr

    # File/rendering functions
    (9433, 9538),   # formatFileSize, isCodeFile, isTextFile, isMarkdownFile, getCorrectMimeType, getLangFromExt, getLangColors
    (9572, 9953),   # highlightSyntax, highlightHtml, highlightJson, highlightCss, highlightKeyValue, highlightGeneric
    (9741, 9953),   # renderMarkdown, normalizeAudioMimeType
    (9962, 10013),  # getFileIcon
    (10014, 10130), # setupDragAndDrop, setupModalDragAndDrop
    (10131, 10255), # handleFileSelect, showUploadModal, renderUploadPreview, closeUploadModal
    (10390, 10459), # buildFileCardHtml, revokeBlobUrls, extractRawMessageText
    (10486, 10544), # updateGalleryState, buildMultiFileCardHtml
    (10545, 10685), # loadMediaPreview
    (10803, 11124), # openMediaViewer, viewerKeyHandler, navigateViewer, updateGalleryNav, updateZoomPosition, closeMediaViewer

    # Video/audio controls
    (11149, 11294), # setupVideoControls, updateVolumeIcon, formatTime, setupAudioControls

    # Sticker/emoji panel rendering
    (11378, 11419), # setupStickerPanel, renderPanelTab
    (11420, 11546), # renderEmojiGrid
    (11547, 11557), # insertEmojiIntoInput
    (11631, 11762), # collectEmojiRefs, collectEmojiRefsFromMsgEl, getEmojiEntry, renderEmojiText
    (11796, 11871), # renderStickerGrid, renderStickerItems
    (11872, 11933), # renderGifPanel
    (11934, 11960), # showStickerProgress, hideStickerProgress, setStickerSendingCooldown
    (11961, 12129), # sendStickerMessage (mostly rendering/sticker logic)

    # Sticker upload UI
    (12130, 12220), # renderUploadStickerPanel
    (12221, 12435), # setupStickerUploadModal, loadImageForCrop, initCropBox
    (12436, 12620), # resetStickerUpload, processAndUploadSticker

    # Forward DM rendering
    (12621, 12709), # showDmForwardModal, loadDmForwardList

    # Profile rendering
    (12852, 12911), # decryptProfilePicData, getProfilePicUrl
    (13012, 13114), # updateSidebarFooter (partial - just rendering)

    # Profile modal/rendering
    (13857, 14214), # openProfileModal, renderProfileView, getDecryptedFileUrl, linkifyText, closeProfileModal
    (14234, 14514), # openProfileEditModal, closeProfileEditModal, renderProfileEdit, updateDescriptionWordCount, updateDisplayNameCharCount, updateProfileEditPreview, renderEditGlowOptions, getColorBrightness, isLightColor

    # Banner/PFP crop rendering
    (15067, 15292), # openBannerCrop, updateBannerCropBox, updateBannerLivePreview, cancelBannerCrop
    (15354, 15536), # openPfpCrop, updatePfpCropBox, updatePfpLivePreview, cancelPfpCrop
]

# Collect all UI line ranges, sort by start, and merge overlapping/adjacent
ui_ranges.sort()
merged = []
for start, end in ui_ranges:
    if not merged:
        merged.append([start, end])
    else:
        last = merged[-1]
        if start <= last[1] + 1:
            last[1] = max(last[1], end)
        else:
            merged.append([start, end])

print(f"\nUI ranges to extract ({len(merged)} merged blocks):")
for s, e in merged:
    print(f"  {s:5d} - {e:5d}  ({e-s+1:4d} lines)  |  {lines[s-1].strip()[:80]}")

# Collect UI code from all merged ranges
ui_code = []
for start, end in merged:
    ui_code.append(f"// === Extracted from chat.js lines {start}-{end} ===\n")
    ui_code.extend(lines[start-1:end])
    ui_code.append("\n")

# ── 3. Write output files ──────────────────────────────────────────────

os.makedirs(os.path.join(PROJECT, "static/js"), exist_ok=True)

# Write chat-ws.js
with open(WS_JS, "w", encoding="utf-8") as f:
    f.write("// === WebSocket Handler (extracted from chat.js) ===\n")
    f.write("// This file is loaded before chat.js. Functions reference globals defined in chat.js.\n")
    f.write(f"// Extracted lines 4255-5028\n\n")
    f.writelines(ws_code)

print(f"\nWritten: {WS_JS} ({len(ws_code)} lines)")

# Write chat-ui.js
with open(UI_JS, "w", encoding="utf-8") as f:
    f.write("// === UI / Rendering Functions (extracted from chat.js) ===\n")
    f.write("// This file is loaded before chat.js. Functions reference globals defined in chat.js.\n")
    f.write("// Only called at runtime after all scripts load, so cross-script references work.\n\n")
    f.writelines(ui_code)

total_ui_lines = sum(len(l) for l in ui_code)
print(f"Written: {UI_JS} (estimated {total_ui_lines} chars)")

# ── 4. Remove extracted code from chat.js ──────────────────────────────
# We remove from bottom to top so line numbers don't shift

removed_lines_set = set()
# Mark WS handler lines
for i in range(WS_START - 1, WS_END):
    removed_lines_set.add(i)
# Mark all UI lines
for start, end in merged:
    for i in range(start - 1, end):
        removed_lines_set.add(i)

# Build new chat.js excluding removed lines
new_chat_lines = []
removed_count = 0
for i, line in enumerate(lines):
    if i not in removed_lines_set:
        new_chat_lines.append(line)
    else:
        removed_count += 1

new_chat_path = os.path.join(PROJECT, "static/chat.js")
with open(new_chat_path, "w", encoding="utf-8") as f:
    f.writelines(new_chat_lines)

print(f"\nchat.js updated: {total_lines} → {len(new_chat_lines)} lines ({total_lines - len(new_chat_lines)} removed)")
print(f"  WS handler lines:    {WS_END - WS_START + 1}")
print(f"  UI rendering lines:  {removed_count - (WS_END - WS_START + 1)}")

# ── 5. Verify file sizes ───────────────────────────────────────────────
print(f"\nFinal file sizes:")
for path, label in [(CHAT_JS, "chat.js"), (WS_JS, "chat-ws.js"), (UI_JS, "chat-ui.js")]:
    sz = os.path.getsize(path)
    with open(path, "r", encoding="utf-8") as f:
        lc = len(f.readlines())
    print(f"  {label:20s} {sz:8d} bytes, {lc:5d} lines")
