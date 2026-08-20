// ======================================================================

// F3 · Threaded Replies — right-click "Reply in Thread" + thread panel

// F4 · Channel Categories — collapsible sidebar groups

// F13 · Keyboard Shortcut Customization — remappable shortcuts

// ======================================================================



(function () {

    'use strict';



    // ─── F3: Thread Panel ─────────────────────────────────────────────

    var _threadPanelOpen = false;

    var _threadParentId = null;

    var _threadChannelId = null;



    /**

     * Open the thread panel for a given parent message.

     * Fetches replies from the server and renders them in a side panel.

     */

    function openThreadPanel(parentMessageId, channelId) {

        if (_threadPanelOpen && _threadParentId === parentMessageId) {

            closeThreadPanel();

            return;

        }

        _threadPanelOpen = true;

        _threadParentId = parentMessageId;

        _threadChannelId = channelId;



        // Create or reuse thread panel container

        var panel = document.getElementById('thread-panel');

        if (!panel) {

            panel = document.createElement('div');

            panel.id = 'thread-panel';

            panel.className = 'thread-panel';

            var appEl = document.querySelector('.app') || document.body;
            appEl.appendChild(panel);

        }



        panel.innerHTML = '<div class="thread-panel-header">' +

            '<span class="thread-panel-title">🧵 Thread</span>' +

            '<button class="thread-panel-close" id="thread-panel-close-btn">&times;</button>' +

            '</div>' +

            '<div class="thread-panel-messages" id="thread-messages"></div>' +

            '<div class="thread-panel-input-area">' +

            '<input type="text" id="thread-input" class="thread-input" placeholder="Reply to thread..." />' +

            '<button id="thread-send-btn" class="thread-send-btn">➤</button>' +

            '</div>';



        panel.style.display = 'flex';



        document.getElementById('thread-panel-close-btn').addEventListener('click', closeThreadPanel);



        // Thread send

        var threadInput = document.getElementById('thread-input');

        var threadSendBtn = document.getElementById('thread-send-btn');

        threadSendBtn.addEventListener('click', sendThreadReply);

        threadInput.addEventListener('keydown', function (e) {

            if (e.key === 'Enter' && !e.shiftKey) {

                e.preventDefault();

                sendThreadReply();

            }

        });



        // Fetch thread replies

        loadThreadMessages(parentMessageId, channelId);

    }



    function closeThreadPanel() {

        _threadPanelOpen = false;

        _threadParentId = null;

        var panel = document.getElementById('thread-panel');

        if (panel) panel.style.display = 'none';

    }



    async function loadThreadMessages(parentId, channelId) {

        var container = document.getElementById('thread-messages');

        if (!container) return;

        container.innerHTML = '<div class="thread-loading">Loading replies...</div>';



        try {

            var res = await authFetch('/api/channels/' + channelId + '/thread/' + parentId);

            if (!res.ok) throw new Error('Failed to load thread');

            var messages = await res.json();

            container.innerHTML = '';



            if (!messages || messages.length === 0) {

                container.innerHTML = '<div class="thread-empty">No replies yet. Start a conversation!</div>';

                return;

            }



            var serverKey = typeof E2ECrypto !== 'undefined' && E2ECrypto.getServerKey ? E2ECrypto.getServerKey(currentServerId) : null;

            var allKeys = typeof E2ECrypto !== 'undefined' && E2ECrypto.getAllServerKeys ? E2ECrypto.getAllServerKeys(currentServerId) || [] : [];



            for (var i = 0; i < messages.length; i++) {

                var msg = messages[i];

                var plaintext = null;

                if (serverKey) {

                    plaintext = E2ECrypto.decryptMessage(msg.encrypted_content, msg.nonce, serverKey);

                }

                if (!plaintext && allKeys.length > 0) {

                    for (var k = 0; k < allKeys.length; k++) {

                        plaintext = E2ECrypto.decryptMessage(msg.encrypted_content, msg.nonce, allKeys[k]);

                        if (plaintext) break;

                    }

                }



                var msgDiv = document.createElement('div');

                msgDiv.className = 'thread-message';

                msgDiv.innerHTML = '<div class="thread-msg-sender">' +

                    (msg.sender_id_hash || 'User').substring(0, 8) +

                    '</div><div class="thread-msg-content">' +

                    (plaintext ? escapeHtml(plaintext) : '<span style="color:#666">[encrypted]</span>') +

                    '</div><div class="thread-msg-time">' + formatTime(msg.timestamp) + '</div>';

                container.appendChild(msgDiv);

            }

            container.scrollTop = container.scrollHeight;

        } catch (err) {

            console.error('Failed to load thread:', err);

            container.innerHTML = '<div class="thread-error">Failed to load replies</div>';

        }

    }



    async function sendThreadReply() {

        var input = document.getElementById('thread-input');

        if (!input || !input.value.trim() || !_threadParentId) return;



        var text = input.value.trim();

        input.value = '';



        var serverKey = E2ECrypto.getServerKey(currentServerId);

        if (!serverKey) return alert('Cannot encrypt message — no server key');



        var encrypted = E2ECrypto.encryptMessage(text, serverKey);

        var searchTokens = generateSearchTokens(text, currentServerId);



        try {

            var wsPayload = {                type: 'message_send',
                channel_id: _threadChannelId,
                encrypted_content: encrypted.ciphertext,
                nonce: encrypted.nonce,
                search_tokens: searchTokens,
                thread_parent_id: _threadParentId

            };            var _wsConn = window._ws || ws;
            if (_wsConn && _wsConn.readyState === WebSocket.OPEN) {
                _wsConn.send(JSON.stringify(wsPayload));

            }

            // Reload thread after a short delay to let the WS broadcast arrive
            setTimeout(function() {
                loadThreadMessages(_threadParentId, _threadChannelId);
            }, 500);

        } catch (err) {

            console.error('Failed to send thread reply:', err);

        }

    }



    // Add "Reply in Thread" to message context menu

    var _origShowMessageContextMenu = window.showMessageContextMenu;

    function addThreadOptionToContextMenu(e, messageId, channelId, isDm) {

        // Call original if exists

        if (_origShowMessageContextMenu) {

            _origShowMessageContextMenu(e, messageId, channelId, isDm);

        }



        // Add thread option to the context menu

        var menu = document.querySelector('.channel-context-menu');

        if (!menu || isDm) return;



        var threadItem = document.createElement('div');

        threadItem.className = 'context-menu-item';

        threadItem.textContent = '🧵 Reply in Thread';

        threadItem.addEventListener('click', function () {

            menu.remove();

            openThreadPanel(messageId, channelId || currentChannelId);

        });

        // Insert as first item

        menu.insertBefore(threadItem, menu.firstChild);

    }



    // Hook into message context menu

    if (typeof window.showMessageContextMenu !== 'undefined') {

        window._origShowMessageContextMenu = window.showMessageContextMenu;

        window.showMessageContextMenu = addThreadOptionToContextMenu;

    }



    // Expose thread API globally

    window.openThreadPanel = openThreadPanel;

    window.closeThreadPanel = closeThreadPanel;

    // Expose thread panel state for WS handler in chat.js
    Object.defineProperty(window, '_threadPanelOpen', { get: function() { return _threadPanelOpen; } });
    Object.defineProperty(window, '_threadParentId', { get: function() { return _threadParentId; } });
    window._loadThreadMessages = loadThreadMessages;



    // ─── F3: Thread reply counts on messages ──────────────────────────

    // (Thread reply counts are rendered server-side in list_messages response)



    // ─── F4: Channel Categories ───────────────────────────────────────

    var _categories = [];



    async function loadCategories(serverId) {

        try {

            var res = await authFetch('/api/servers/' + serverId + '/categories');

            if (!res.ok) return [];

            _categories = await res.json();

            return _categories;

        } catch (err) {

            console.error('Failed to load categories:', err);

            return [];

        }

    }



    async function createCategory(serverId, encryptedName, nameNonce) {

        try {

            var res = await authFetch('/api/servers/' + serverId + '/categories', {

                method: 'POST',

                headers: { 'Content-Type': 'application/json' },

                body: JSON.stringify({

                    encrypted_name: encryptedName || null,

                    name_nonce: nameNonce || null,

                    position: _categories.length

                })

            });

            return await res.json();

        } catch (err) {

            console.error('Failed to create category:', err);

            return null;

        }

    }



    async function deleteCategory(serverId, categoryId) {

        try {

            var res = await authFetch('/api/servers/' + serverId + '/categories/' + categoryId, {

                method: 'DELETE'

            });

            return await res.json();

        } catch (err) {

            console.error('Failed to delete category:', err);

            return null;

        }

    }



    async function moveChannelToCategory(serverId, channelId, categoryId) {

        try {

            var res = await authFetch('/api/servers/' + serverId + '/channels/' + channelId + '/category', {

                method: 'PUT',

                headers: { 'Content-Type': 'application/json' },

                body: JSON.stringify({ category_id: categoryId || null })

            });

            return await res.json();

        } catch (err) {

            console.error('Failed to move channel:', err);

            return null;

        }

    }



    function decryptCategoryName(cat) {

        if (!cat.encrypted_name || !cat.name_nonce) {
            // Default names for unencrypted categories
            if (cat.position === 0) return 'Text Channels';
            if (cat.position === 1) return 'Voice Channels';
            return 'Category ' + (cat.position + 1);
        }

        try {

            var serverKey = E2ECrypto.getServerKey ? E2ECrypto.getServerKey(cat.server_id) : null;

            if (!serverKey) return 'Category';

            return E2ECrypto.decryptMessage(cat.encrypted_name, cat.name_nonce, serverKey) || 'Category';

        } catch (_) {

            return 'Category';

        }

    }



    /**

     * Render channels grouped by categories in the sidebar.

     * Uncategorized channels go into a default "Text Channels" / "Voice Channels" group.

     */

    function renderChannelsWithCategories(channels, serverId, isOwner) {

        var list = document.getElementById('channel-list');

        if (!list) return;

        list.innerHTML = '';



        if (!channels || channels.length === 0) {

            list.innerHTML = '<div class="channel-item" style="color:#666;cursor:default">No channels yet</div>';

            return;

        }



        // Decrypt category names

        var catMap = {};

        _categories.forEach(function (cat) {

            var name = decryptCategoryName(cat);

            catMap[cat.id] = { name: name || 'Category', id: cat.id, position: cat.position };

        });



        // Group channels

        var uncategorized = { text: [], voice: [] };

        var grouped = {};



        channels.forEach(function (ch) {

            if (ch.category_id && catMap[ch.category_id]) {

                if (!grouped[ch.category_id]) grouped[ch.category_id] = { text: [], voice: [] };

                if (ch.channel_type === 'voice') grouped[ch.category_id].voice.push(ch);

                else grouped[ch.category_id].text.push(ch);

            } else {

                if (ch.channel_type === 'voice') uncategorized.voice.push(ch);

                else uncategorized.text.push(ch);

            }

        });



        // Render ALL categories (sorted by position), even empty ones

        var sortedCats = Object.keys(catMap).sort(function (a, b) {

            return (catMap[a] ? catMap[a].position : 0) - (catMap[b] ? catMap[b].position : 0);

        });

        sortedCats.forEach(function (catId) {

            var cat = catMap[catId];

            var textChannels = grouped[catId] ? grouped[catId].text : [];

            var voiceChannels = grouped[catId] ? grouped[catId].voice : [];

            // Show text channels in the category

            renderCategoryGroup(list, cat.name, catId, textChannels, serverId, isOwner, false);

            // Show voice channels in a sub-group

            if (voiceChannels.length > 0) {

                renderCategoryGroup(list, cat.name + ' (Voice)', catId, voiceChannels, serverId, isOwner, true);

            }

        });

        // Render uncategorized channels (no category assigned)

        if (uncategorized.text.length > 0) {

            renderCategoryGroup(list, 'Uncategorized', null, uncategorized.text, serverId, isOwner, false);

        }

        if (uncategorized.voice.length > 0) {

            renderCategoryGroup(list, 'Uncategorized (Voice)', null, uncategorized.voice, serverId, isOwner, true);

        }



        // Add "+ Category" button for owners

        if (isOwner) {

            var catBtn = document.createElement('button');

            catBtn.className = 'create-channel-btn';

            catBtn.textContent = '+ Category';

            catBtn.addEventListener('click', function () {

                var name = prompt('Category name:');

                if (!name) return;

                // Encrypt the category name with the server key

                var serverKey = E2ECrypto.getServerKey(serverId);

                if (serverKey) {

                    var enc = E2ECrypto.encryptMessage(name, serverKey);

                    createCategory(serverId, enc.ciphertext, enc.nonce).then(function () {

                        loadChannels(serverId);

                    });

                }

            });

            list.appendChild(catBtn);

        }



        // Add "+ Channel" button for owners

        if (isOwner) {

            var chBtn = document.createElement('button');

            chBtn.className = 'create-channel-btn';

            chBtn.textContent = '+ Channel';

            chBtn.addEventListener('click', function () {

                document.getElementById('create-channel-modal').style.display = 'flex';

                document.getElementById('new-channel-name').value = '';

                document.getElementById('new-channel-name').focus();

            });

            list.appendChild(chBtn);

        }



        // Render voice member chips

        if (window.VoiceManager) {

            try { VoiceManager.onChannelsRendered && VoiceManager.onChannelsRendered(); } catch (_) {}

        }



        updateChannelBadges();

        updateChannelMutedUI();



        // Context menu on each channel

        list.querySelectorAll('.channel-item').forEach(function (ch) {

            ch.addEventListener('contextmenu', function (ev) {

                ev.preventDefault();

                showChannelContextMenu(ev, ch.dataset.id, ch.dataset.name);

            });

        });



        if (window.innerWidth > 768 && !currentChannelId && list.querySelector('.channel-item')) {

            list.querySelector('.channel-item').click();

        }

    }



    function renderCategoryGroup(container, name, categoryId, channels, serverId, isOwner, isVoice) {

        var group = document.createElement('div');

        group.className = 'channel-category-group';

        if (categoryId) group.setAttribute('data-category-id', categoryId);

        // Drag-drop: allow dropping channels into this category

        group.addEventListener('dragover', function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; group.style.background = 'rgba(79,195,247,0.1)'; });

        group.addEventListener('dragleave', function () { group.style.background = ''; });

        group.addEventListener('drop', function (e) {
            e.preventDefault();
            group.style.background = '';
            var channelId = e.dataTransfer.getData('text/channel-id');
            if (channelId && categoryId !== undefined) {
                // Move channel to this category
                (async function() {
                    try {
                        var token = localStorage.getItem('auth_token');
                        await fetch('/api/servers/' + serverId + '/channels/' + channelId + '/category', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                            body: JSON.stringify({ category_id: categoryId })
                        });
                        await loadCategories(serverId);
                        // Re-render via the loadChannels callback
                        if (typeof window.loadChannels === 'function') window.loadChannels(serverId);
                    } catch (e) { console.error('Failed to move channel:', e); }
                })();
            }
        });



        var header = document.createElement('div');

        header.className = 'channel-category-header';

        header.innerHTML = '<span class="category-chevron">▼</span> ' + escapeHtml(name);



        // Check if any channel in this category has unread notifications, mentions, or voice activity
        var hasNotif = false;
        var hasMention = false;
        var hasVoice = false;
        channels.forEach(function (ch) {
            if (unreadChannels && unreadChannels.indexOf(ch.id) !== -1) hasNotif = true;
            // F4 mention indicator: check if any channel in this category has unread mentions
            if (typeof unreadMentionsByChannel !== 'undefined' && unreadMentionsByChannel[ch.id]) hasMention = true;
        });
        // F4 voice indicator: check if any voice channel in this category has participants
        if (typeof window.VoiceManager !== 'undefined' && VoiceManager.getServerPresence && serverId) {
            var _presence = VoiceManager.getServerPresence(serverId);
            if (_presence && _presence.channels) {
                channels.forEach(function (ch) {
                    if (ch.channel_type === 'voice') {
                        for (var vi = 0; vi < _presence.channels.length; vi++) {
                            if (_presence.channels[vi].channel_id === ch.id && _presence.channels[vi].members && _presence.channels[vi].members.length > 0) {
                                hasVoice = true;
                                break;
                            }
                        }
                    }
                });
            }
        }
        if (hasNotif) header.classList.add('category-has-notif');
        if (hasMention) header.classList.add('category-has-mention');
        if (hasVoice) header.classList.add('category-has-voice');



        var body = document.createElement('div');

        body.className = 'channel-category-body';



        // Click to collapse/expand

        header.addEventListener('click', function () {

            group.classList.toggle('collapsed');

        });



        // Drop zone for drag-n-drop reorder

        header.addEventListener('dragover', function (ev) { ev.preventDefault(); });

        header.addEventListener('drop', function (ev) {

            ev.preventDefault();

            var chId = ev.dataTransfer.getData('text/plain');

            if (chId && isOwner) {

                moveChannelToCategory(serverId, chId, categoryId);

            }

        });



        group.appendChild(header);

        group.appendChild(body);

        container.appendChild(group);



        // Render each channel

        channels.forEach(function (ch) {

            var div = document.createElement('div');

            var isVoiceCh = ch.channel_type === 'voice';

            div.className = 'channel-item' + (isVoiceCh ? ' channel-item-voice' : '');

            div.dataset.id = ch.id;

            div.dataset.type = isVoiceCh ? 'voice' : 'text';

            div.draggable = true;

            div.addEventListener('dragstart', function (ev) {

                ev.dataTransfer.setData('text/plain', ch.id);

            });



            // Decrypt channel name

            var chDisplayName = '';

            if (ch.encrypted_name && ch.name_nonce) {

                try {

                    chDisplayName = tryDecryptWithAllKeys(serverId, ch.encrypted_name, ch.name_nonce);

                    if (!chDisplayName) {

                        var oldName = decryptWithOldKey(serverId, ch.encrypted_name, ch.name_nonce);

                        if (oldName) chDisplayName = oldName;

                    }

                } catch (_) {}

            }

            div.dataset.name = chDisplayName;
            div.draggable = true;
            div.addEventListener('dragstart', function (e) {
                e.dataTransfer.setData('text/channel-id', ch.id);
                e.dataTransfer.effectAllowed = 'move';
            });



            if (isVoiceCh) {

                div.addEventListener('click', function () {

                    if (window.VoiceManager) VoiceManager.joinServerVoice(serverId, ch.id, chDisplayName);

                });

            } else {

                div.addEventListener('click', function (ev) {

                    if (ev.isTrusted && window.VoiceManager && window.VoiceManager.exitVoiceChannelView) {

                        try { window.VoiceManager.exitVoiceChannelView(); } catch (_) {}

                    }

                    selectChannel(ch.id, chDisplayName, div);

                });

            }



            var nameSpan = document.createElement('span');

            nameSpan.textContent = (isVoiceCh ? '🔊 ' : '# ') + chDisplayName;

            nameSpan.style.flex = '1';

            div.appendChild(nameSpan);



            if (isOwner) {

                var delBtn = document.createElement('button');

                delBtn.className = 'btn-delete-channel';

                delBtn.textContent = '×';

                delBtn.title = 'Delete channel';

                delBtn.addEventListener('click', function (ev) {

                    ev.stopPropagation();

                    deleteChannel(ch.id, ch.name);

                });

                div.appendChild(delBtn);

            }

            body.appendChild(div);

        });

    }



    // Expose category API

    window.loadCategories = loadCategories;

    window.renderChannelsWithCategories = renderChannelsWithCategories;

    window.moveChannelToCategory = moveChannelToCategory;

    window.deleteCategory = deleteCategory;



    // ─── F13: Keyboard Shortcut Customization ─────────────────────────

    var DEFAULT_SHORTCUTS = {

        'toggle_streamer_mode': { key: 's', shift: true, ctrl: true, label: 'Toggle Streamer Mode' },

        'toggle_media_previews': { key: 'm', shift: true, ctrl: true, label: 'Toggle Media Previews' },

        'search': { key: 'k', shift: true, ctrl: true, label: 'Search' },

        'toggle_sidebar': { key: 'b', shift: true, ctrl: true, label: 'Toggle Sidebar' }

    };



    function loadShortcuts() {

        try {

            var saved = localStorage.getItem('custom_shortcuts');

            if (saved) return JSON.parse(saved);

        } catch (_) {}

        return {};

    }



    function saveShortcuts(shortcuts) {

        localStorage.setItem('custom_shortcuts', JSON.stringify(shortcuts));

    }



    function getShortcut(action) {

        var custom = loadShortcuts();

        return custom[action] || DEFAULT_SHORTCUTS[action] || null;

    }



    function renderShortcutSettings(container) {

        var custom = loadShortcuts();

        var html = '<div class="shortcut-settings">';

        html += '<h3 style="color:#e0e0e0;margin:16px 0 8px">Keyboard Shortcuts</h3>';

        html += '<p style="color:#888;font-size:12px;margin-bottom:12px">Click a shortcut to remap it. Press the new key combination to set it.</p>';



        Object.keys(DEFAULT_SHORTCUTS).forEach(function (action) {

            var def = DEFAULT_SHORTCUTS[action];

            var current = custom[action] || def;

            var display = (current.ctrl ? 'Ctrl+' : '') + (current.shift ? 'Shift+' : '') + (current.key ? current.key.toUpperCase() : '');



            html += '<div class="shortcut-row">';

            html += '<span class="shortcut-label">' + def.label + '</span>';

            html += '<button class="shortcut-btn" data-action="' + action + '" id="shortcut-btn-' + action + '">';

            html += display;

            html += '</button>';

            html += '<button class="shortcut-reset" data-action="' + action + '" title="Reset to default">↺</button>';

            html += '</div>';

        });



        html += '</div>';

        container.innerHTML = html;



        // Bind events

        container.querySelectorAll('.shortcut-btn').forEach(function (btn) {

            btn.addEventListener('click', function () {

                var action = btn.dataset.action;

                btn.textContent = 'Press keys...';

                btn.classList.add('shortcut-recording');



                function onKey(e) {

                    e.preventDefault();

                    e.stopPropagation();

                    if (['Control', 'Shift', 'Alt', 'Meta'].indexOf(e.key) !== -1) return;



                    var combo = {

                        key: e.key.toLowerCase(),

                        shift: e.shiftKey,

                        ctrl: e.ctrlKey,

                        label: DEFAULT_SHORTCUTS[action].label

                    };



                    var shortcuts = loadShortcuts();

                    shortcuts[action] = combo;

                    saveShortcuts(shortcuts);



                    var display = (combo.ctrl ? 'Ctrl+' : '') + (combo.shift ? 'Shift+' : '') + combo.key.toUpperCase();

                    btn.textContent = display;

                    btn.classList.remove('shortcut-recording');

                    document.removeEventListener('keydown', onKey, true);



                    // Rebind shortcuts

                    bindAllShortcuts();

                }

                document.addEventListener('keydown', onKey, true);

            });

        });



        container.querySelectorAll('.shortcut-reset').forEach(function (btn) {

            btn.addEventListener('click', function () {

                var action = btn.dataset.action;

                var shortcuts = loadShortcuts();

                delete shortcuts[action];

                saveShortcuts(shortcuts);

                renderShortcutSettings(container);

                bindAllShortcuts();

            });

        });

    }



    // Bind all shortcuts to document

    function bindAllShortcuts() {

        // Remove old listeners by replacing the keydown handler

        document.removeEventListener('keydown', _globalShortcutHandler, true);

        document.addEventListener('keydown', _globalShortcutHandler, true);

    }



    function _globalShortcutHandler(e) {

        if (!e.ctrlKey && !e.shiftKey) return;

        // Don't intercept when typing in inputs

        var tag = e.target.tagName;

        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;



        Object.keys(DEFAULT_SHORTCUTS).forEach(function (action) {

            var s = getShortcut(action);

            if (!s) return;

            if (e.ctrlKey === s.ctrl && e.shiftKey === s.shift && e.key && e.key.toLowerCase() === s.key) {

                e.preventDefault();

                executeShortcut(action);

            }

        });

    }



    function executeShortcut(action) {

        switch (action) {

            case 'toggle_streamer_mode':

                var st = document.getElementById('streamer-mode-toggle');

                if (st) { st.click(); }

                break;

            case 'toggle_media_previews':

                var cb = document.getElementById('auto-load-previews');

                if (cb) { cb.click(); }

                break;

            case 'search':

                if (currentServerId && currentChannelId) {

                    openSearchPanel({ type: 'channel', channelId: currentChannelId, serverId: currentServerId });

                } else if (currentDmChannelId) {

                    openSearchPanel({ type: 'dm', channelId: currentDmChannelId });

                }

                break;

            case 'toggle_sidebar':

                var sidebar = document.getElementById('sidebar');

                if (sidebar) sidebar.classList.toggle('open');

                break;

        }

    }



    // Initialize shortcuts

    bindAllShortcuts();



    // Expose

    window.renderShortcutSettings = renderShortcutSettings;

    window.getShortcut = getShortcut;



    // ─── Helpers ──────────────────────────────────────────────────────

    function generateSearchTokens(text, serverId) {
        var keys = (typeof E2ECrypto !== 'undefined' && E2ECrypto.getAllServerKeys) ? E2ECrypto.getAllServerKeys(serverId) || [] : [];
        if (keys.length === 0) return [];
        return (typeof E2ECrypto !== 'undefined' && E2ECrypto.searchTokensForText) ? E2ECrypto.searchTokensForText(text, keys) : [];
    }

    function escapeHtml(text) {

        var div = document.createElement('div');

        div.textContent = text;

        return div.innerHTML;

    }



    function formatTime(ts) {

        if (!ts) return '';

        try {

            var d = new Date(ts);

            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        } catch (_) { return ''; }

    }



    // Expose thread reply count for message rendering

    window.getThreadReplyCount = function (messageData) {

        return (messageData && messageData.thread_reply_count) || 0;

    };



    // ─── F14: Custom CSS ─────────────────────────────────────────────

    var _customCssStyleEl = null;



    function applyCustomCss(cssText) {

        if (_customCssStyleEl) _customCssStyleEl.remove();

        if (!cssText || cssText.trim() === '') return;

        _customCssStyleEl = document.createElement('style');

        _customCssStyleEl.id = 'custom-user-css';

        _customCssStyleEl.textContent = cssText;

        document.head.appendChild(_customCssStyleEl);

    }



    function loadLocalCustomCss() {
        return localStorage.getItem('custom_css_text') || '';
    }



        function renderCustomCssSettings(container) {

        var useAccount = localStorage.getItem('custom_css_use_account') === 'true';

        var localCss = localStorage.getItem('custom_css_text') || '';

        var currentTheme = localStorage.getItem('custom_css_preset') || 'default';



        var html = '<div class="custom-css-settings-inner">';



        // ── Preset selector ──

        html += '<div style="margin-bottom:16px">';

        html += '<h3 style="color:var(--text-primary);margin:0 0 8px;font-size:14px">Theme Presets</h3>';

        html += '<div id="css-preset-selector" style="display:flex;gap:8px;flex-wrap:wrap">';



        var presetMeta = [
            { id: 'default',      label: 'Default',       desc: 'Original look',                          color: '#666' },
            { id: 'performance',  label: '\u26a1 Performance', desc: 'No blur/animation \u2014 fast on low-end GPUs', color: '#4caf50' },
            { id: 'premium',      label: '\u2728 Premium',    desc: 'Glassmorphism & smooth animations',            color: '#7c4dff' },
            { id: 'highcontrast', label: '\u2b50 High Contrast', desc: 'WCAG AAA accessibility',                       color: '#ffff00' }
        ]

        presetMeta.forEach(function (p) {

            var active = currentTheme === p.id;

            html += '<div data-preset="' + p.id + '" style="cursor:pointer;padding:10px 16px;border-radius:8px;border:2px solid ' + (active ? p.color : '#333') + ';background:' + (active ? p.color + '22' : '#1a1a2e') + ';min-width:120px;text-align:center">';

            html += '<div style="color:' + (active ? p.color : '#ccc') + ';font-weight:600;font-size:13px;margin-bottom:4px">' + p.label + '</div>';

            html += '<div style="color:#888;font-size:10px">' + p.desc + '</div>';

            html += '</div>';

        });

        html += '</div></div>';



        // ── Sync toggle ──

        html += '<div style="margin-bottom:12px">';

        html += '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;color:#ccc;font-size:13px">';

        html += '<input type="checkbox" id="css-use-account" ' + (useAccount ? 'checked' : '') + ' style="accent-color:#569cd6">';

        html += 'Use account CSS (synced across devices)';

        html += '</label>';

        html += '<p style="color:#888;font-size:11px;margin:4px 0 0 24px">When off, uses per-device local CSS only</p>';

        html += '</div>';



        // ── Textarea ──

        html += '<textarea id="custom-css-textarea" style="width:100%;height:300px;background:#0f0f23;border:1px solid #444;border-radius:8px;padding:12px;color:#d4d4d4;font-family:monospace;font-size:13px;resize:vertical;outline:none" placeholder="/* Your custom CSS here */">';

        html += (localCss || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        html += '</textarea>';



        // ── Action buttons ──

        html += '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">';

        html += '<button id="css-save-local" style="padding:10px 20px;border-radius:8px;border:none;background:linear-gradient(135deg,#4fc3f7,#29b6f6);color:#fff;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s;box-shadow:0 2px 8px rgba(79,195,247,0.3)">💾 Save Local</button>';

        html += '<button id="css-save-account" style="padding:10px 20px;border-radius:8px;border:none;background:linear-gradient(135deg,#7c4dff,#651fff);color:#fff;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s;box-shadow:0 2px 8px rgba(124,77,255,0.3)">☁️ Save to Account</button>';

        html += '<button id="css-preview" style="padding:10px 20px;border-radius:8px;border:2px solid #4fc3f7;background:transparent;color:#4fc3f7;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s">👁️ Preview</button>';

        html += '<button id="css-reset" style="padding:10px 20px;border-radius:8px;border:2px solid #f44336;background:rgba(244,67,54,0.1);color:#f44336;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s">🔄 Reset to Default</button>';

        html += '<button id="css-import" style="padding:10px 20px;border-radius:8px;border:2px solid #666;background:rgba(255,255,255,0.05);color:#ccc;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s">📁 Import .css</button>';

        html += '</div>';

        html += '<input type="file" id="css-import-input" accept=".css" style="display:none">';

        html += '</div>';

        container.innerHTML = html;



        // ── Preset click handlers ──

        var presetEls = container.querySelectorAll('[data-preset]');

        Array.from(presetEls).forEach(function (el) {

            el.addEventListener('click', function () {                var presetId = el.getAttribute('data-preset');
                var css = BUILTIN_THEMES[presetId] || '';
                if (presetId === 'default') {
                    localStorage.removeItem('custom_css_preset');
                } else {
                    localStorage.setItem('custom_css_preset', presetId);
                }
                localStorage.setItem('custom_css_text', css);

                applyCustomCss(css);

                // Update textarea

                var ta = document.getElementById('custom-css-textarea');

                if (ta) ta.value = css;

                // Update active border

                Array.from(presetEls).forEach(function (pe) {

                    var pid = pe.getAttribute('data-preset');

                    var meta = presetMeta.find(function (m) { return m.id === pid; });

                    var isActive = pid === presetId;

                    pe.style.borderColor = isActive ? (meta ? meta.color : '#666') : '#333';

                    pe.style.background = isActive ? (meta ? meta.color + '22' : '#1a1a2e') : '#1a1a2e';

                    pe.querySelector('div').style.color = isActive ? (meta ? meta.color : '#ccc') : '#ccc';

                });

                showToast('Theme applied: ' + (presetId === 'default' ? 'Default' : presetId === 'performance' ? 'Performance' : 'Premium'));

            });

        });



        // ── Account CSS toggle ──

        document.getElementById('css-use-account').addEventListener('change', function (e) {

            localStorage.setItem('custom_css_use_account', e.target.checked);

            if (e.target.checked && typeof myUserId !== 'undefined' && myUserId) {

                fetchAccountCustomCss(myUserId).then(function (css) { if (css) applyCustomCss(css); });

            } else {

                applyCustomCss(localStorage.getItem('custom_css_text') || '');

            }

        });



        // ── Save Local ──

        document.getElementById('css-save-local').addEventListener('click', function () {

            var css = document.getElementById('custom-css-textarea').value;

            localStorage.setItem('custom_css_text', css);

            localStorage.removeItem('custom_css_preset');

            if (localStorage.getItem('custom_css_use_account') !== 'true') applyCustomCss(css);

            showToast('CSS saved locally');

        });



        // ── Save to Account ──

        document.getElementById('css-save-account').addEventListener('click', function () {

            var css = document.getElementById('custom-css-textarea').value;

            saveAccountCustomCss(css).then(function () { showToast('CSS saved to account'); });

        });



        // ── Preview ──

        document.getElementById('css-preview').addEventListener('click', function () {

            applyCustomCss(document.getElementById('custom-css-textarea').value);

            showToast('CSS preview applied');

        });



        // ── Reset to Default ──

        document.getElementById('css-reset').addEventListener('click', function () {

            localStorage.removeItem('custom_css_text');

            localStorage.removeItem('custom_css_use_account');

            localStorage.removeItem('custom_css_preset');

            deleteAccountCustomCss();

            applyCustomCss('');

            var ta = document.getElementById('custom-css-textarea');

            if (ta) ta.value = '';

            var cb = document.getElementById('css-use-account');

            if (cb) cb.checked = false;

            // Reset preset selector to default

            Array.from(presetEls).forEach(function (pe) {

                var pid = pe.getAttribute('data-preset');

                var meta = presetMeta.find(function (m) { return m.id === pid; });

                var isActive = pid === 'default';

                pe.style.borderColor = isActive ? (meta ? meta.color : '#666') : '#333';

                pe.style.background = isActive ? '#6663' : '#1a1a2e';

                pe.querySelector('div').style.color = isActive ? '#666' : '#ccc';

            });

            showToast('Reset to default theme');

        });



        // ── Import ──

        document.getElementById('css-import').addEventListener('click', function () {

            document.getElementById('css-import-input').click();

        });

        document.getElementById('css-import-input').addEventListener('change', function (e) {

            var file = e.target.files[0];

            if (!file) return;

            var reader = new FileReader();

            reader.onload = function (ev) {

                document.getElementById('custom-css-textarea').value = ev.target.result;

                localStorage.removeItem('custom_css_preset');

                showToast('CSS file imported - click Save to apply');

            };

            reader.readAsText(file);

        });

    }



    window.renderCustomCssSettings = renderCustomCssSettings;

    window.applyCustomCss = applyCustomCss;



})();

        function renderCustomCssSettings(container) {

        var localCss = localStorage.getItem('custom_css_text') || '';
        var currentTheme = localStorage.getItem('custom_css_preset') || 'default';
        var isCustomMode = localStorage.getItem('custom_css_mode') === 'custom';

        var html = '<div class="custom-css-settings-inner">';

        // Theme Presets
        html += '<div style="margin-bottom:16px">';
        html += '<h3 style="color:var(--text-primary);margin:0 0 8px;font-size:14px">Theme Presets</h3>';
        html += '<div id="css-preset-selector" style="display:flex;gap:8px;flex-wrap:wrap">';

        var presetMeta = [
            { id: 'default',      label: 'Default',       desc: 'Original look',                          color: '#666' },
            { id: 'performance',  label: '\u26a1 Performance', desc: 'No blur/animation \u2014 fast on low-end GPUs', color: '#4caf50' },
            { id: 'premium',      label: '\u2728 Premium',    desc: 'Glassmorphism & smooth animations',            color: '#7c4dff' },
            { id: 'highcontrast', label: '\u2b50 High Contrast', desc: 'WCAG AAA accessibility',                       color: '#ffff00' }
        ];

        presetMeta.forEach(function (p) {
            var active = !isCustomMode && currentTheme === p.id;
            html += '<div data-preset="' + p.id + '" style="cursor:pointer;padding:10px 16px;border-radius:8px;border:2px solid ' + (active ? p.color : '#333') + ';background:' + (active ? p.color + '22' : '#1a1a2e') + ';min-width:120px;text-align:center">';
            html += '<div style="color:' + (active ? p.color : '#ccc') + ';font-weight:600;font-size:13px;margin-bottom:4px">' + p.label + '</div>';
            html += '<div style="color:#888;font-size:10px">' + p.desc + '</div>';
            html += '</div>';
        });

        // Custom CSS button
        html += '<div data-preset="custom" style="cursor:pointer;padding:10px 16px;border-radius:8px;border:2px solid ' + (isCustomMode ? '#e0e0e0' : '#333') + ';background:' + (isCustomMode ? 'rgba(224,224,224,0.1)' : '#1a1a2e') + ';min-width:120px;text-align:center">';
        html += '<div style="color:' + (isCustomMode ? '#e0e0e0' : '#ccc') + ';font-weight:600;font-size:13px;margin-bottom:4px">\u270f\ufe0f Custom</div>';
        html += '<div style="color:#888;font-size:10px">Write your own CSS</div>';
        html += '</div>';

        html += '</div></div>';

        // Textarea
        var displayCss = '';
        if (isCustomMode) {
            displayCss = localCss;
        } else if (BUILTIN_THEMES[currentTheme]) {
            var themeVal = BUILTIN_THEMES[currentTheme];
            displayCss = typeof themeVal === 'string' ? themeVal : '';
        } else {
            displayCss = localCss;
        }

        if (isCustomMode) {
            html += '<textarea id="custom-css-textarea" style="width:100%;height:300px;background:#0f0f23;border:1px solid #444;border-radius:8px;padding:12px;color:#d4d4d4;font-family:monospace;font-size:13px;resize:vertical;outline:none" placeholder="/* Your custom CSS here */">';
            html += (displayCss || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            html += '</textarea>';
        } else {
            html += '<textarea id="custom-css-textarea" readonly style="width:100%;height:300px;background:#0a0a1a;border:1px solid #333;border-radius:8px;padding:12px;color:#888;font-family:monospace;font-size:13px;resize:vertical;outline:none;cursor:default" placeholder="Select a preset to view its CSS">';
            html += (displayCss || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            html += '</textarea>';
        }

        // Action buttons
        html += '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">';

        if (!isCustomMode) {
            html += '<button id="css-copy" style="padding:10px 20px;border-radius:8px;border:none;background:linear-gradient(135deg,#4fc3f7,#29b6f6);color:#fff;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s;box-shadow:0 2px 8px rgba(79,195,247,0.3)">\U0001f4cb Copy CSS</button>';
            html += '<button id="css-apply-preset" style="padding:10px 20px;border-radius:8px;border:none;background:linear-gradient(135deg,#4caf50,#388e3c);color:#fff;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s;box-shadow:0 2px 8px rgba(76,175,80,0.3)">\u2705 Apply Preset</button>';
        } else {
            html += '<button id="css-save-local" style="padding:10px 20px;border-radius:8px;border:none;background:linear-gradient(135deg,#4fc3f7,#29b6f6);color:#fff;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s;box-shadow:0 2px 8px rgba(79,195,247,0.3)">\U0001f4be Save & Apply</button>';
            html += '<button id="css-preview" style="padding:10px 20px;border-radius:8px;border:2px solid #4fc3f7;background:transparent;color:#4fc3f7;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s">\U0001f441\ufe0f Preview</button>';
        }

        html += '<button id="css-reset" style="padding:10px 20px;border-radius:8px;border:2px solid #f44336;background:rgba(244,67,54,0.1);color:#f44336;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s">\U0001f504 Reset to Default</button>';
        html += '<button id="css-import" style="padding:10px 20px;border-radius:8px;border:2px solid #666;background:rgba(255,255,255,0.05);color:#ccc;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s">\U0001f4c1 Import .css</button>';

        html += '</div>';
        html += '<input type="file" id="css-import-input" accept=".css" style="display:none">';
        html += '</div>';

        container.innerHTML = html;

        // Preset click handlers
        var presetEls = container.querySelectorAll('[data-preset]');
        Array.from(presetEls).forEach(function (el) {
            el.addEventListener('click', function () {
                var presetId = el.getAttribute('data-preset');
                if (presetId === 'custom') {
                    localStorage.setItem('custom_css_mode', 'custom');
                    renderCustomCssSettings(container);
                    return;
                }
                var css = BUILTIN_THEMES[presetId] || '';
                var cssStr = typeof css === 'string' ? css : '';
                localStorage.setItem('custom_css_preset', presetId);
                localStorage.removeItem('custom_css_mode');
                localStorage.setItem('custom_css_text', cssStr);
                applyCustomCss(cssStr);
                renderCustomCssSettings(container);
                showToast('Theme applied: ' + presetId);
            });
        });

        // Copy CSS
        var copyBtn = document.getElementById('css-copy');
        if (copyBtn) {
            copyBtn.addEventListener('click', function () {
                var ta = document.getElementById('custom-css-textarea');
                if (ta) {
                    navigator.clipboard.writeText(ta.value).then(function () {
                        showToast('CSS copied to clipboard');
                        copyBtn.textContent = '\u2705 Copied!';
                        setTimeout(function () { copyBtn.textContent = '\U0001f4cb Copy CSS'; }, 2000);
                    });
                }
            });
        }

        // Apply Preset
        var applyBtn = document.getElementById('css-apply-preset');
        if (applyBtn) {
            applyBtn.addEventListener('click', function () {
                var ta = document.getElementById('custom-css-textarea');
                if (ta) {
                    localStorage.setItem('custom_css_text', ta.value);
                    localStorage.removeItem('custom_css_mode');
                    applyCustomCss(ta.value);
                    showToast('Preset applied');
                }
            });
        }

        // Save Local (custom mode)
        var saveBtn = document.getElementById('css-save-local');
        if (saveBtn) {
            saveBtn.addEventListener('click', function () {
                var css = document.getElementById('custom-css-textarea').value;
                localStorage.setItem('custom_css_text', css);
                localStorage.removeItem('custom_css_preset');
                localStorage.removeItem('custom_css_mode');
                applyCustomCss(css);
                showToast('Custom CSS saved & applied');
            });
        }

        // Preview (custom mode)
        var previewBtn = document.getElementById('css-preview');
        if (previewBtn) {
            previewBtn.addEventListener('click', function () {
                applyCustomCss(document.getElementById('custom-css-textarea').value);
                showToast('CSS preview applied');
            });
        }

        // Reset to Default
        document.getElementById('css-reset').addEventListener('click', function () {
            localStorage.removeItem('custom_css_text');
            localStorage.removeItem('custom_css_preset');
            localStorage.removeItem('custom_css_mode');
            applyCustomCss('');
            renderCustomCssSettings(container);
            showToast('Reset to default theme');
        });

        // Import
        document.getElementById('css-import').addEventListener('click', function () {
            document.getElementById('css-import-input').click();
        });
        document.getElementById('css-import-input').addEventListener('change', function (e) {
            var file = e.target.files[0];
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function (ev) {
                localStorage.setItem('custom_css_text', ev.target.result);
                localStorage.setItem('custom_css_mode', 'custom');
                localStorage.removeItem('custom_css_preset');
                renderCustomCssSettings(container);
                showToast('CSS file imported \u2014 click Save & Apply');
            };
            reader.readAsText(file);
        });

    }
