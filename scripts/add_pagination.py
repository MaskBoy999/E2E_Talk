import re

with open('static/chat.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Step 1: Add pagination state variables after lastDmMessageInfo
old = 'let lastDmMessageInfo = { senderId: null, dmChannelId: null, time: 0 };\n\n// Emoji cache: name -> { file_id, file_key, mime_type }'

new = 'let lastDmMessageInfo = { senderId: null, dmChannelId: null, time: 0 };\n\n// Pagination state for infinite scroll\nlet _messagePageData = null; // { channelId, oldestTimestamp }\nlet _dmMessagePageData = null; // { dmChannelId, oldestTimestamp }\nlet _isLoadingOlder = false; // Prevents duplicate fetches\nlet _hasMoreMessages = true; // Set to false when server returns fewer than limit\n\n// Emoji cache: name -> { file_id, file_key, mime_type }'

content = content.replace(old, new)

# Step 2: Modify loadMessages to support before param
# Add pagination tracking after messages are loaded
old2 = "        list.innerHTML = '';\n\n        if (!Array.isArray(messages) || messages.length === 0) {\n            list.innerHTML = '<div class=\"welcome\">No messages yet. Say hello!</div>';\n            return;\n        }\n\n        for (const msg of messages) {\n            await appendMessage(msg);\n        }"

new2 = "        list.innerHTML = '';\n\n        if (!Array.isArray(messages) || messages.length === 0) {\n            list.innerHTML = '<div class=\"welcome\">No messages yet. Say hello!</div>';\n            _hasMoreMessages = false;\n            return;\n        }\n\n        for (const msg of messages) {\n            await appendMessage(msg);\n        }\n        // Track pagination state\n        if (messages.length > 0) {\n            var oldest = messages[messages.length - 1].timestamp;\n            _messagePageData = { channelId: channelId, oldestTimestamp: oldest };\n            _hasMoreMessages = messages.length >= 50;\n        }"

content = content.replace(old2, new2)

# Step 3: Modify loadDmMessages to support before param
old3 = "        list.innerHTML = '';\n\n        if (!Array.isArray(messages) || messages.length === 0) {\n            list.innerHTML = '<div class=\"welcome\">No messages yet. Say hello!</div>';\n            return;\n        }\n\n        const kp = E2ECrypto.getIdentityKeyPair();"

new3 = "        list.innerHTML = '';\n\n        if (!Array.isArray(messages) || messages.length === 0) {\n            list.innerHTML = '<div class=\"welcome\">No messages yet. Say hello!</div>';\n            _hasMoreMessages = false;\n            return;\n        }\n        // Track pagination state\n        if (messages.length > 0) {\n            var oldest = messages[messages.length - 1].timestamp;\n            _dmMessagePageData = { dmChannelId: dmChannelId, oldestTimestamp: oldest };\n            _hasMoreMessages = messages.length >= 50;\n        }\n\n        const kp = E2ECrypto.getIdentityKeyPair();"

content = content.replace(old3, new3)

# Step 4: Add scroll-to-top detection and loadOlderMessages function
# Find a good spot to add it - right after the loadMessages function ends and before appendMessage
old4 = "}\n\nasync function appendMessage(msg) {\n    const list = document.getElementById('message-list');"

new4 = """}

// Infinite scroll: load older messages when user scrolls to top of message list
async function loadOlderMessages() {
    if (_isLoadingOlder || !_hasMoreMessages) return;
    const list = document.getElementById('message-list');
    if (!list || list.children.length === 0) return;
    _isLoadingOlder = true;

    // Show loading indicator at the top
    var indicator = document.createElement('div');
    indicator.className = 'loading-older';
    indicator.style.cssText = 'text-align:center;padding:16px;color:var(--text-muted);font-size:13px;';
    indicator.textContent = '⏳ Loading older messages...';
    list.insertBefore(indicator, list.firstChild);

    try {
        var beforeTs = null;
        var url = null;
        if (currentChannelId && _messagePageData) {
            beforeTs = _messagePageData.oldestTimestamp;
            var serverId = currentServerId;
            // Fetch older messages with ?limit=50&before=<timestamp>
            url = '/api/channels/' + encodeURIComponent(currentChannelId) + '/messages?limit=50&before=' + encodeURIComponent(beforeTs);
        } else if (currentDmChannelId && _dmMessagePageData) {
            beforeTs = _dmMessagePageData.oldestTimestamp;
            url = '/api/dm/' + encodeURIComponent(currentDmChannelId) + '/messages?limit=50&before=' + encodeURIComponent(beforeTs);
        }

        if (!url) {
            _isLoadingOlder = false;
            if (indicator.parentNode) indicator.remove();
            _hasMoreMessages = false;
            return;
        }

        const res = await authFetch(url);
        const olderMessages = await res.json();

        // Remove loading indicator
        if (indicator.parentNode) indicator.remove();

        if (!Array.isArray(olderMessages) || olderMessages.length === 0) {
            _hasMoreMessages = false;
            _isLoadingOlder = false;
            return;
        }

        // Prepend older messages (they come in ASC order from server)
        for (var i = olderMessages.length - 1; i >= 0; i--) {
            var dummyDiv = document.createElement('div');
            if (currentChannelId) {
                await appendMessage(olderMessages[i]);
            } else {
                var kp = E2ECrypto.getIdentityKeyPair();
                var otherPubKey = null;
                try {
                    var otherUserRes = await authFetch('/api/identity/' + currentDmOtherUser);
                    if (otherUserRes.ok) {
                        var otherUserData = await otherUserRes.json();
                        if (otherUserData.identity_public_key) {
                            otherPubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(otherUserData.identity_public_key));
                        }
                    }
                } catch (_) {}
                await appendDmMessage(olderMessages[i], kp, otherPubKey);
            }
        }

        // Update oldest timestamp for next pagination
        if (olderMessages.length > 0) {
            var newOldest = olderMessages[olderMessages.length - 1].timestamp;
            if (currentChannelId && _messagePageData) {
                _messagePageData.oldestTimestamp = newOldest;
            } else if (currentDmChannelId && _dmMessagePageData) {
                _dmMessagePageData.oldestTimestamp = newOldest;
            }
            _hasMoreMessages = olderMessages.length >= 50;
        } else {
            _hasMoreMessages = false;
        }
    } catch (err) {
        console.error('Failed to load older messages:', err);
        if (indicator.parentNode) indicator.remove();
        // Show error indicator briefly
        var errDiv = document.createElement('div');
        errDiv.style.cssText = 'text-align:center;padding:8px;color:#f44336;font-size:12px;';
        errDiv.textContent = 'Failed to load older messages';
        list.insertBefore(errDiv, list.firstChild);
        setTimeout(function() { if (errDiv.parentNode) errDiv.remove(); }, 3000);
    }
    _isLoadingOlder = false;
}

// Scroll-to-top handler for infinite scroll
var _scrollHandlerAttached = false;
function attachScrollToTopHandler() {
    if (_scrollHandlerAttached) return;
    var list = document.getElementById('message-list');
    if (!list) return;
    list.addEventListener('scroll', function() {
        // When the user scrolls within 50px of the top, load older messages
        if (list.scrollTop < 50 && !_isLoadingOlder && _hasMoreMessages) {
            // Remember the current scroll height so we can restore position after prepending
            var prevScrollHeight = list.scrollHeight;
            loadOlderMessages().then(function() {
                // Try to keep the user's scroll position by adjusting for new content above
                var newScrollHeight = list.scrollHeight;
                var addedHeight = newScrollHeight - prevScrollHeight;
                if (addedHeight > 0) {
                    list.scrollTop = addedHeight;
                }
            });
        }
    }, { passive: true });
    _scrollHandlerAttached = true;
}

async function appendMessage(msg) {
    const list = document.getElementById('message-list');"""

content = content.replace(old4, new4)

# Step 5: Call attachScrollToTopHandler after loading messages in loadMessages and loadDmMessages
# Add to loadMessages - after the prefetch profile loop
old5 = "            if (srvKey) {\n                for (var sid in srvUncached) {\n                    fetchServerConversationProfile(sid, currentServerId, srvKey);\n                }\n            }\n        }\n    } catch (err) {\n        console.error('Failed to load messages:', err);\n        list.innerHTML = '<div class=\"welcome\" style=\"color:#f44336\">Failed to load messages</div>';\n    }\n}"

new5 = "            if (srvKey) {\n                for (var sid in srvUncached) {\n                    fetchServerConversationProfile(sid, currentServerId, srvKey);\n                }\n            }\n        }\n        // Attach infinite scroll handler\n        attachScrollToTopHandler();\n    } catch (err) {\n        console.error('Failed to load messages:', err);\n        list.innerHTML = '<div class=\"welcome\" style=\"color:#f44336\">Failed to load messages</div>';\n    }\n}"

content = content.replace(old5, new5)

# Add to loadDmMessages - after the prefetch profile loop
old6 = "        for (var sid in uncachedSenders) {\n            fetchDmConversationProfile(sid, dmChannelId);\n        }\n    } catch (err) {\n        console.error('Failed to load DM messages:', err);"

new6 = "        for (var sid in uncachedSenders) {\n            fetchDmConversationProfile(sid, dmChannelId);\n        }\n        // Attach infinite scroll handler\n        attachScrollToTopHandler();\n    } catch (err) {\n        console.error('Failed to load DM messages:', err);"

content = content.replace(old6, new6)

with open('static/chat.js', 'w', encoding='utf-8') as f:
    f.write(content)

print('Done: added pagination to chat.js')
