// ======================================================================

// F3 · Threaded Replies — right-click "Reply in Thread" + thread panel

// F4 · Channel Categories — collapsible sidebar groups

// F13 · Keyboard Shortcut Customization — remappable shortcuts

// ======================================================================



(function () {

    'use strict';



    // ─── Drag auto-scroll for the channel list ────────────────────────
    // While a channel or category is being dragged the sidebar can no longer
    // be scrolled by hand, so dropping something into a category that is
    // currently off-screen would be impossible. Holding the pointer near the
    // top/bottom edge of #channel-list scrolls it for the whole drag.
    var _clistScroll = { active: false, x: 0, y: 0, raf: null };
    var CLIST_SCROLL_EDGE = 40;   // px band at each edge that triggers scrolling
    var CLIST_SCROLL_MAX = 16;    // px per frame at the very edge

    function _clistOnDragOver(e) {
        _clistScroll.x = e.clientX;
        _clistScroll.y = e.clientY;
    }

    function _clistScrollFromPoint(x, y) {
        var el = document.getElementById('channel-list');
        if (!el) return;
        var rect = el.getBoundingClientRect();
        // Only while the pointer is actually over the sidebar horizontally.
        if (x < rect.left - 24 || x > rect.right + 24) return;
        var delta = 0;
        if (y < rect.top + CLIST_SCROLL_EDGE) {
            var up = (rect.top + CLIST_SCROLL_EDGE - y) / CLIST_SCROLL_EDGE;
            delta = -Math.ceil(Math.max(0, Math.min(1, up)) * CLIST_SCROLL_MAX);
        } else if (y > rect.bottom - CLIST_SCROLL_EDGE) {
            var down = (y - (rect.bottom - CLIST_SCROLL_EDGE)) / CLIST_SCROLL_EDGE;
            delta = Math.ceil(Math.max(0, Math.min(1, down)) * CLIST_SCROLL_MAX);
        }
        if (delta) el.scrollTop = el.scrollTop + delta;
    }

    function _clistScrollTick() {
        if (!_clistScroll.active) { _clistScroll.raf = null; return; }
        _clistScrollFromPoint(_clistScroll.x, _clistScroll.y);
        _clistScroll.raf = requestAnimationFrame(_clistScrollTick);
    }

    function startChannelListAutoScroll() {
        if (_clistScroll.active) return;
        if (!document.getElementById('channel-list')) return;
        _clistScroll.active = true;
        // Capture so a child calling stopPropagation cannot hide the pointer.
        document.addEventListener('dragover', _clistOnDragOver, true);
        if (_clistScroll.raf) cancelAnimationFrame(_clistScroll.raf);
        _clistScroll.raf = requestAnimationFrame(_clistScrollTick);
    }

    function stopChannelListAutoScroll() {
        if (!_clistScroll.active) return;
        _clistScroll.active = false;
        document.removeEventListener('dragover', _clistOnDragOver, true);
        if (_clistScroll.raf) { cancelAnimationFrame(_clistScroll.raf); _clistScroll.raf = null; }
    }

    // ─── Touch drag helper for channels and categories ─────────────────
    // Mirrors setupTouchDragItem in chat.js but for the channel sidebar.
    // `el` is the drag source, `kind` is 'channel' or 'category', `getId()`
    // returns the item's ID, and `onDrop(x, y)` resolves the drop target.
    var _chDragTimerPending = false; // true while any channel/category long-press timer is ticking
    function _setupChannelTouchDrag(el, kind, getId, onDrop) {
        var LONG_PRESS = 350;
        var s = { timer: null, active: false, ghost: null, sx: 0, sy: 0, lx: 0, ly: 0 };
        el.addEventListener('touchstart', function (e) {
            var t = e.touches[0]; if (!t) return;
            var id = getId(); if (!id) return;
            el.draggable = false;
            s.sx = s.lx = t.clientX;
            s.sy = s.ly = t.clientY;
            _chDragTimerPending = true;
            s.timer = setTimeout(function () {
                _chDragTimerPending = false;
                s.timer = null;
                s.active = true;
                el.classList.add('dragging');
                if (kind === 'category') {
                    var grp = el.closest('.channel-category-group');
                    if (grp) grp.classList.add('dragging');
                }
                startChannelListAutoScroll();
                s.ghost = el.cloneNode(true);
                s.ghost.classList.add('role-drag-ghost');
                s.ghost.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;opacity:0.85;transform:scale(1.15);';
                s.ghost.style.left = (s.lx - 20) + 'px';
                s.ghost.style.top = (s.ly - 20) + 'px';
                document.body.appendChild(s.ghost);
                if (navigator.vibrate) try { navigator.vibrate(30); } catch (_) {}
            }, LONG_PRESS);
        }, { passive: false });
        // Suppress browser context menu during long-press on channel/category items
        el.addEventListener('contextmenu', function (e) {
            if (s.timer || s.active) { e.preventDefault(); }
        });
        el.addEventListener('touchmove', function (e) {
            var t = e.touches[0]; if (!t) return;
            s.lx = t.clientX; s.ly = t.clientY;
            if (s.timer) {
                if (Math.abs(t.clientX - s.sx) > 10 || Math.abs(t.clientY - s.sy) > 10) {
                    clearTimeout(s.timer); s.timer = null;
                    _chDragTimerPending = false;
                }
            }
            if (!s.active) return;
            e.preventDefault();
            if (s.ghost) {
                s.ghost.style.left = (s.lx - 20) + 'px';
                s.ghost.style.top = (s.ly - 20) + 'px';
            }
            // Auto-scroll the channel list near edges
            var cl = document.getElementById('channel-list');
            if (cl) {
                var cr = cl.getBoundingClientRect();
                var EDGE = 44, MAX = 18;
                if (s.ly < cr.top + EDGE && s.ly >= cr.top - 24) {
                    cl.scrollTop -= Math.ceil(Math.max(0, Math.min(1, (cr.top + EDGE - s.ly) / EDGE)) * MAX);
                } else if (s.ly > cr.bottom - EDGE && s.ly <= cr.bottom + 24) {
                    cl.scrollTop += Math.ceil(Math.max(0, Math.min(1, (s.ly - (cr.bottom - EDGE)) / EDGE)) * MAX);
                }
            }
            // Highlight drop target
            var hit = document.elementFromPoint(s.lx, s.ly);
            document.querySelectorAll('.drag-over-top,.drag-over-bottom,.drop-active').forEach(function (el) {
                el.classList.remove('drag-over-top', 'drag-over-bottom', 'drop-active');
                el.style.background = '';
            });
            if (!hit) return;
            var grp = hit.closest('.channel-category-group');
            var chItem = hit.closest('.channel-item[data-id]');
            if (grp && kind === 'category') {
                var rect = grp.getBoundingClientRect();
                if (s.ly < rect.top + rect.height / 2) grp.classList.add('drag-over-top');
                else grp.classList.add('drag-over-bottom');
            } else if (grp && kind === 'channel') {
                grp.style.background = 'rgba(79,195,247,0.1)';
            } else if (chItem && kind === 'channel' && chItem !== el) {
                var r2 = chItem.getBoundingClientRect();
                if (s.ly < r2.top + r2.height / 2) chItem.classList.add('drag-over-top');
                else chItem.classList.add('drag-over-bottom');
            }
        }, { passive: false });
        el.addEventListener('touchend', function (e) {
            el.draggable = true;
            _chDragTimerPending = false;
            if (s.timer) { clearTimeout(s.timer); s.timer = null; }
            if (!s.active) return;
            s.active = false;
            stopChannelListAutoScroll();
            document.querySelectorAll('.drag-over-top,.drag-over-bottom,.drop-active').forEach(function (el2) {
                el2.classList.remove('drag-over-top', 'drag-over-bottom', 'drop-active');
                el2.style.background = '';
            });
            if (s.ghost && s.ghost.parentNode) s.ghost.parentNode.removeChild(s.ghost);
            s.ghost = null;
            if (kind === 'category') {
                var grp2 = el.closest('.channel-category-group');
                if (grp2) grp2.classList.remove('dragging');
            }
            onDrop(s.lx, s.ly);
        });
        el.addEventListener('touchcancel', function () {
            el.draggable = true;
            if (s.timer) { clearTimeout(s.timer); s.timer = null; }
            if (!s.active) return;
            s.active = false;
            stopChannelListAutoScroll();
            document.querySelectorAll('.drag-over-top,.drag-over-bottom,.drop-active').forEach(function (el2) {
                el2.classList.remove('drag-over-top', 'drag-over-bottom', 'drop-active');
                el2.style.background = '';
            });
            if (s.ghost && s.ghost.parentNode) s.ghost.parentNode.removeChild(s.ghost);
            s.ghost = null;
            if (kind === 'category') {
                var grp3 = el.closest('.channel-category-group');
                if (grp3) grp3.classList.remove('dragging');
            }
        });
    }

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

            '<span class="thread-panel-title">' + icon('pin') + ' Thread</span>' +

            '<button class="thread-panel-close" id="thread-panel-close-btn">&times;</button>' +

            '</div>' +

            '<div class="thread-panel-messages" id="thread-messages"></div>' +

            '<div class="thread-panel-input-area">' +

            '<input type="text" id="thread-input" class="thread-input" placeholder="Reply to thread..." />' +

            '<button id="thread-send-btn" class="thread-send-btn">' + icon('send') + '</button>' +

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



    /**
     * Resolve a thread reply's display name, colour/glow and PFP exactly like
     * the main channel renderer does: profile snapshot first, then the current
     * conversation profile, then the encrypted username, then cached data.
     * (Previously the panel printed the first 8 chars of the sender HMAC hash.)
     */
    function threadSenderInfo(msg, channelId) {
        var uid = msg.sender_user_id || null;
        var cacheKey = uid || msg.sender_id;
        if (msg.encrypted_profile_snapshot && msg.profile_snapshot_nonce && currentServerId) {
            try {
                var snapDec = tryDecryptWithAllKeys(currentServerId, normalizeB64Field(msg.encrypted_profile_snapshot), normalizeB64Field(msg.profile_snapshot_nonce));
                if (snapDec) {
                    var snap = JSON.parse(snapDec);
                    if (snap.display_name) msg.sender_display_name = snap.display_name;
                    if (snap.username_color) msg.sender_username_color = snap.username_color;
                    if (snap.username_border_color) msg.sender_username_border_color = snap.username_border_color;
                    if (snap.profile_picture_file_id) msg.sender_profile_pic = snap.profile_picture_file_id;
                    if (snap.profile_picture_file_key && typeof userDisplayNameCache !== 'undefined') {
                        if (!userDisplayNameCache[cacheKey]) userDisplayNameCache[cacheKey] = {};
                        userDisplayNameCache[cacheKey].profile_picture_file_key = snap.profile_picture_file_key;
                        if (typeof scheduleUserDisplayNameSave === 'function') scheduleUserDisplayNameSave();
                    }
                }
            } catch (_e) {}
        }
        if (msg.conversation_profile && currentServerId) {
            try {
                var cpDec = tryDecryptWithAllKeys(currentServerId, msg.conversation_profile.encrypted_profile_data, msg.conversation_profile.nonce);
                if (cpDec) {
                    var cp = JSON.parse(cpDec);
                    if (cp.display_name) msg.sender_display_name = cp.display_name;
                    if (cp.username_color) msg.sender_username_color = cp.username_color;
                    if (cp.username_border_color) msg.sender_username_border_color = cp.username_border_color;
                    if (cp.profile_picture_file_id) msg.sender_profile_pic = cp.profile_picture_file_id;
                }
            } catch (_e) {}
        }
        if (!msg.sender_username && msg.encrypted_sender_username && msg.sender_username_nonce && currentServerId) {
            try {
                var su = tryDecryptWithAllKeysRaw(currentServerId, msg.encrypted_sender_username, msg.sender_username_nonce);
                if (su) msg.sender_username = su;
            } catch (_e) {}
        }
        var cached = (typeof userDisplayNameCache !== 'undefined' && userDisplayNameCache[cacheKey]) ? userDisplayNameCache[cacheKey] : null;
        var name = msg.sender_display_name || (cached && cached.display_name) || msg.sender_username ||
            (msg.sender_id_hash ? String(msg.sender_id_hash).substring(0, 8) : 'User');
        var pic = msg.sender_profile_pic || (cached && cached.profile_picture_file_id) || null;
        var color = msg.sender_username_color || (cached && cached.username_color) || null;
        var border = msg.sender_username_border_color || (cached && cached.username_border_color) || null;
        var picKey = (uid || msg.sender_id || '') + ':' + pic;
        return {
            userId: uid,
            name: name,
            color: color,
            borderColor: border,
            initial: (name || '?').charAt(0).toUpperCase(),
            picUrl: (pic && typeof getProfilePicUrl === 'function') ? getProfilePicUrl(pic, uid || msg.sender_id) : null,
            picKey: picKey,
        };
    }

    function threadTime(ts) {
        try { return new Date(ts).toLocaleTimeString(); } catch (_e) { return ts || ''; }
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



                var info = threadSenderInfo(msg, channelId);

                var msgDiv = document.createElement('div');

                msgDiv.className = 'thread-message';

                msgDiv.dataset.senderUserId = info.userId || '';

                var avatarHtml = info.picUrl
                    ? '<div class="avatar thread-avatar" data-profile-pic="' + escapeAttr(info.picKey) + '"><img class="avatar-img" src="' + info.picUrl + '" alt=""></div>'
                    : '<div class="avatar thread-avatar"' + (info.picKey.split(':')[1] ? ' data-profile-pic-load="' + escapeAttr(info.picKey) + '"' : '') + '>' + escapeHtml(info.initial) + '</div>';

                msgDiv.innerHTML = avatarHtml +
                    '<div class="thread-msg-body">' +
                        '<div class="thread-msg-head">' +
                            '<span class="display-name"' + (info.color ? ' style="color:' + escapeAttr(info.color) + ';text-shadow:' + escapeAttr(getDisplayNameTextShadow(info.color, info.borderColor)) + '"' : '') + '>' + escapeHtml(info.name) + '</span>' +
                            '<span class="thread-msg-time">' + threadTime(msg.timestamp) + '</span>' +
                        '</div>' +
                        '<div class="thread-msg-content">' +
                            (plaintext ? escapeHtml(plaintext) : '<span style="color:#666">[encrypted]</span>') +
                        '</div>' +
                    '</div>';

                // The PFP opens the sender's profile view, like the main chat.

                var avatarEl = msgDiv.querySelector('.thread-avatar');

                if (avatarEl && info.userId) {

                    avatarEl.style.cursor = 'pointer';

                    avatarEl.setAttribute('data-user-id', info.userId);

                    avatarEl.addEventListener('click', function () {

                        if (typeof openProfileModal === 'function') openProfileModal(info.userId);

                    });

                }

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



        // Roles: replying needs SEND_MESSAGES + REPLY_IN_THREADS in the channel.
        if (window.ServerRoles && _threadChannelId &&
            !(ServerRoles.hasInChannel(ServerRoles.bit('SEND_MESSAGES'), _threadChannelId) &&
              ServerRoles.hasInChannel(ServerRoles.bit('REPLY_IN_THREADS'), _threadChannelId))) {
            return alert('You do not have permission to reply in this thread');
        }

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

            };
            // Same encrypted sender metadata as normal messages, so thread
            // replies render with the sender's display name/colour/glow/PFP.
            if (typeof buildEncryptedSenderFields === 'function') {
                var senderFields = buildEncryptedSenderFields(serverKey);
                for (var _k in senderFields) {
                    if (Object.prototype.hasOwnProperty.call(senderFields, _k)) wsPayload[_k] = senderFields[_k];
                }
            }            var _wsConn = window._ws || ws;
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

        threadItem.innerHTML = icon('pin') + ' Reply in Thread';

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



    async function renameCategory(serverId, categoryId, newName) {

        try {

            var serverKey = E2ECrypto.getServerKey(serverId);

            if (!serverKey) return null;

            var enc = E2ECrypto.encryptMessage(newName, serverKey);

            var res = await authFetch('/api/servers/' + serverId + '/categories/' + categoryId, {

                method: 'PUT',

                headers: { 'Content-Type': 'application/json' },

                body: JSON.stringify({

                    encrypted_name: enc.ciphertext,

                    name_nonce: enc.nonce

                })

            });

            return await res.json();

        } catch (err) {

            console.error('Failed to rename category:', err);

            return null;

        }

    }



    async function renameChannelAPI(serverId, channelId, newName) {

        try {

            var serverKey = E2ECrypto.getServerKey(serverId);

            if (!serverKey) return null;

            var enc = E2ECrypto.encryptMessage(newName, serverKey);

            var res = await authFetch('/api/servers/' + serverId + '/channels/' + channelId + '/name', {

                method: 'PUT',

                headers: { 'Content-Type': 'application/json' },

                body: JSON.stringify({

                    encrypted_name: enc.ciphertext,

                    name_nonce: enc.nonce

                })

            });

            return await res.json();

        } catch (err) {

            console.error('Failed to rename channel:', err);

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

        // Drop zone: drop a channel here to remove it from any category
        list.addEventListener('drop', function (e) {
            e.preventDefault();
            stopChannelListAutoScroll();
            var channelId = e.dataTransfer.getData('text/channel-id') || e.dataTransfer.getData('text/plain');
            if (!channelId) return;
            // Check the drop wasn't inside a category group (those have their own handlers)
            if (e.target.closest && e.target.closest('.channel-category-group')) return;
            moveChannelToCategory(serverId, channelId, null);
        });
        list.addEventListener('dragover', function (e) { e.preventDefault(); });



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

            // Show all channels (text + voice) together in the same category

            var allChannels = textChannels.concat(voiceChannels);

            renderCategoryGroup(list, cat.name, catId, allChannels, serverId, isOwner, false);

        });

        // Render uncategorized channels (no category assigned)

        if (uncategorized.text.length > 0 || uncategorized.voice.length > 0) {

            var allUncat = uncategorized.text.concat(uncategorized.voice);

            renderCategoryGroup(list, 'Uncategorized', null, allUncat, serverId, isOwner, false);

        }



        // Add "+ Category" button for owners

        if (isOwner) {

            var catBtn = document.createElement('button');

            catBtn.className = 'create-channel-btn';

            catBtn.textContent = '+ Category';

            catBtn.addEventListener('click', function () {
                _showCategoryNameModal('Create Category', 'Create', function (name) {
                    var serverKey = E2ECrypto.getServerKey(serverId);
                    if (serverKey) {
                        var enc = E2ECrypto.encryptMessage(name, serverKey);
                        createCategory(serverId, enc.ciphertext, enc.nonce).then(function () {
                            loadChannels(serverId);
                        });
                    }
                });
            });

            list.appendChild(catBtn);

        }



        // Add "+ Channel" button for owners

        if (isOwner) {

            var chBtn = document.createElement('button');

            chBtn.className = 'create-channel-btn';

            chBtn.textContent = '+ Channel';

            chBtn.addEventListener('click', function () {

                // Default to the first category if available
                window._pendingChannelCategoryId = sortedCats.length > 0 ? sortedCats[0] : null;
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







        if (window.innerWidth > 768 && !currentChannelId && list.querySelector('.channel-item')) {

            list.querySelector('.channel-item').click();

        }

    }



    function renderCategoryGroup(container, name, categoryId, channels, serverId, isOwner, isVoice) {

        var group = document.createElement('div');

        group.className = 'channel-category-group';

        if (categoryId) group.setAttribute('data-category-id', categoryId);

        // Drag-drop: allow dropping channels into this category

        group.addEventListener('dragover', function (e) {
            var isCatDrag = e.dataTransfer.types.indexOf('text/category-id') !== -1;
            var isChDrag = e.dataTransfer.types.indexOf('text/channel-id') !== -1;
            if (!isCatDrag && !isChDrag) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            // For a category reorder the WHOLE group is the target, not just its
            // header: the header is a ~24px strip, so aiming "before" or "after"
            // this category was a game of precision. Top half = drop before this
            // category, bottom half = drop after it — matching what the drop
            // handler below then does.
            if (isCatDrag) {
                if (!categoryId) return;   // nothing to order against
                if (e.target === group && !group.classList.contains('drag-over-top')) {
                    group.classList.remove('drag-over-bottom');
                }
                var rect = group.getBoundingClientRect();
                var beforeThis = e.clientY < rect.top + rect.height / 2;
                document.querySelectorAll('.channel-category-group').forEach(function (g) {
                    if (g !== group) g.classList.remove('drag-over-top', 'drag-over-bottom');
                });
                group.classList.toggle('drag-over-top', beforeThis);
                group.classList.toggle('drag-over-bottom', !beforeThis);
            } else if (isChDrag) {
                group.style.background = 'rgba(79,195,247,0.1)';
            }
        });

        group.addEventListener('dragleave', function (e) {
            // Only clean up if we're truly leaving the group (not entering a child)
            if (!group.contains(e.relatedTarget)) {
                group.style.background = '';
                group.classList.remove('drag-over-top', 'drag-over-bottom');
            }
        });

        group.addEventListener('drop', function (e) {
            e.preventDefault();
            // A drop reloads the channel list, which can remove the drag source
            // before `dragend` fires — so stop scrolling right here.
            stopChannelListAutoScroll();
            group.style.background = '';
            group.classList.remove('drag-over-top', 'drag-over-bottom');
            var catId = e.dataTransfer.getData('text/category-id');
            var channelId = e.dataTransfer.getData('text/channel-id');
            if (catId && categoryId && catId !== categoryId) {
                // Reorder categories: get current order, move dragged to target position
                (async function() {
                    var groups = document.querySelectorAll('.channel-category-group[data-category-id]');
                    var ids = Array.from(groups).map(function (g) { return g.getAttribute('data-category-id'); });
                    // Remove dragged from current position
                    var fromIdx = ids.indexOf(catId);
                    if (fromIdx !== -1) ids.splice(fromIdx, 1);
                    // Determine drop position (above or below target)
                    var rect = group.getBoundingClientRect();
                    var insertIdx = ids.indexOf(categoryId);
                    if (e.clientY > rect.top + rect.height / 2) insertIdx++;
                    ids.splice(insertIdx, 0, catId);
                    await reorderCategoriesAPI(serverId, ids);
                    if (typeof window.loadChannels === 'function') window.loadChannels(serverId);
                })();
            } else if (channelId && categoryId !== undefined) {
                // Move channel to this category at the correct position
                (async function() {
                    try {
                        // Determine insertion position among existing channels in this category body
                        var chDivs = body.querySelectorAll('.channel-item[data-id]');
                        var ids = Array.from(chDivs).map(function (d) { return d.getAttribute('data-id'); });
                        // Remove dragged channel from current position if present
                        var fromIdx = ids.indexOf(channelId);
                        if (fromIdx !== -1) ids.splice(fromIdx, 1);
                        // Find insert position based on mouse Y
                        var insertIdx = ids.length; // default: append
                        for (var ci = 0; ci < chDivs.length; ci++) {
                            var chRect = chDivs[ci].getBoundingClientRect();
                            if (e.clientY < chRect.top + chRect.height / 2) {
                                insertIdx = ci;
                                break;
                            }
                        }
                        ids.splice(insertIdx, 0, channelId);
                        // Move channel to this category
                        await fetch('/api/servers/' + serverId + '/channels/' + channelId + '/category', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ category_id: categoryId })
                        });
                        // Reorder to place it at the correct position
                        await reorderChannelsAPI(serverId, ids);
                        if (typeof window.loadChannels === 'function') window.loadChannels(serverId);
                    } catch (e) { console.error('Failed to move channel:', e); }
                })();
            }
        });



        var header = document.createElement('div');

        header.className = 'channel-category-header';

        header.innerHTML = '<span class="category-chevron">▼</span> ' + escapeHtml(name);

        // Category drag-to-reorder (owner only)
        if (isOwner && categoryId) {
            // The HEADER is the drag handle, not the group.
            //
            // Marking the group draggable made the browser dispatch `dragstart`
            // on the GROUP (the draggable element is the drag source, and events
            // target it, not the child that was pressed) — so the listener below,
            // which is on the header, never ran: no `text/category-id` was ever
            // set, every drop was ignored, and dragging a category did nothing.
            // Making the header itself the drag source also keeps a channel drag
            // (the channel rows are draggable too) from being swallowed.
            header.draggable = true;
            header.addEventListener('dragstart', function (e) {
                e.stopPropagation();
                e.dataTransfer.setData('text/category-id', categoryId);
                e.dataTransfer.effectAllowed = 'move';
                setTimeout(function () { group.classList.add('dragging'); }, 0);
                startChannelListAutoScroll();
            });
            header.addEventListener('dragend', function () {
                group.classList.remove('dragging');
                stopChannelListAutoScroll();
                document.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(function (el) {
                    el.classList.remove('drag-over-top', 'drag-over-bottom');
                });
            });
            // Touch drag for category reordering on mobile
            _setupChannelTouchDrag(header, 'category', function () { return categoryId; }, function (x, y) {
                var hit = document.elementFromPoint(x, y);
                if (!hit) return;
                var targetGrp = hit.closest('.channel-category-group[data-category-id]');
                if (targetGrp && categoryId) {
                    var targetCatId = targetGrp.getAttribute('data-category-id');
                    if (targetCatId && targetCatId !== categoryId) {
                        (async function () {
                            var groups = document.querySelectorAll('.channel-category-group[data-category-id]');
                            var ids = Array.from(groups).map(function (g) { return g.getAttribute('data-category-id'); });
                            var fromIdx = ids.indexOf(categoryId);
                            if (fromIdx !== -1) ids.splice(fromIdx, 1);
                            var rect = targetGrp.getBoundingClientRect();
                            var insertIdx = ids.indexOf(targetCatId);
                            if (y > rect.top + rect.height / 2) insertIdx++;
                            ids.splice(insertIdx, 0, categoryId);
                            await reorderCategoriesAPI(serverId, ids);
                            if (typeof window.loadChannels === 'function') window.loadChannels(serverId);
                        })();
                    }
                }
            });
        }

        // Right-click context menu for category header (owner only)
        if (isOwner && categoryId) {
            header.addEventListener('contextmenu', function (e) {
                if (_chDragTimerPending) return; // suppress during long-press
                e.preventDefault();
                e.stopPropagation();
                _showCategoryContextMenu(e.clientX, e.clientY, serverId, categoryId, name, channels);
            });
        }

        // Check if any channel in this category has unread notifications, mentions, or voice activity
        var hasNotif = false;
        var hasMention = false;
        var hasVoice = false;
        channels.forEach(function (ch) {
            if (typeof unreadChannels !== 'undefined' && unreadChannels && unreadChannels.indexOf(ch.id) !== -1) hasNotif = true;
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



        // Touch-based double-tap for category header: double-tap opens
        // context menu instead of collapsing/expanding.
        var _catLastTE = 0, _catLastTETarget = null;
        header.addEventListener('touchend', function () {
            var now = Date.now();
            if (header === _catLastTETarget && (now - _catLastTE) < 150) {
                _catLastTETarget = null;
                window._doubleTapJustFired = true;
                if (isOwner && categoryId) {
                    _showCategoryContextMenu(0, 0, serverId, categoryId, name, channels);
                }
                return;
            }
            _catLastTETarget = header;
            _catLastTE = now;
        }, { passive: true });
        header.addEventListener('click', function (e) {
            if (window._doubleTapJustFired) { window._doubleTapJustFired = false; return; }
            group.classList.toggle('collapsed');
        });





        // Drop zone for drag-n-drop reorder

        header.addEventListener('dragover', function (ev) { ev.preventDefault(); });

        header.addEventListener('drop', function (ev) {
            stopChannelListAutoScroll();

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
            // Fallback for existing voice channels without encrypted names
            if (!chDisplayName) {
                chDisplayName = isVoiceCh ? 'General Voice' : '';
            }

            div.dataset.name = chDisplayName;
            div.draggable = true;
            div.addEventListener('dragstart', function (e) {
                e.dataTransfer.setData('text/channel-id', ch.id);
                e.dataTransfer.setData('text/plain', ch.id);
                e.dataTransfer.effectAllowed = 'move';
                setTimeout(function () { div.classList.add('dragging'); }, 0);
                startChannelListAutoScroll();
            });
            div.addEventListener('dragend', function () {
                div.classList.remove('dragging');
                stopChannelListAutoScroll();
                document.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(function (el) {
                    el.classList.remove('drag-over-top', 'drag-over-bottom');
                });
            });
            // Touch drag for channel reorder on mobile
            if (isOwner) {
                _setupChannelTouchDrag(div, 'channel', function () { return ch.id; }, function (x, y) {
                    var hit = document.elementFromPoint(x, y);
                    if (!hit) return;
                    var targetGrp = hit.closest('.channel-category-group');
                    if (targetGrp) {
                        var targetCatId = targetGrp.getAttribute('data-category-id') || null;
                        // Move channel to target category at the correct position
                        (async function () {
                            var chDivs = targetGrp.querySelectorAll('.channel-item[data-id]');
                            var ids = Array.from(chDivs).map(function (d) { return d.getAttribute('data-id'); });
                            var insertIdx = ids.length;
                            for (var ci = 0; ci < chDivs.length; ci++) {
                                var r = chDivs[ci].getBoundingClientRect();
                                if (y < r.top + r.height / 2) { insertIdx = ci; break; }
                            }
                            // If same category, reorder
                            if (categoryId === targetCatId) {
                                ids = ids.filter(function (id) { return id !== ch.id; });
                                ids.splice(insertIdx, 0, ch.id);
                                await reorderChannelsAPI(serverId, ids);
                            } else {
                                // Cross-category: move then reorder
                                await moveChannelToCategory(serverId, ch.id, targetCatId);
                                var freshDivs = targetGrp.querySelectorAll('.channel-item[data-id]');
                                var freshIds = Array.from(freshDivs).map(function (d) { return d.getAttribute('data-id'); });
                                freshIds = freshIds.filter(function (id) { return id !== ch.id; });
                                freshIds.splice(insertIdx, 0, ch.id);
                                await reorderChannelsAPI(serverId, freshIds);
                            }
                            if (typeof window.loadChannels === 'function') window.loadChannels(serverId);
                        })();
                    } else {
                        // Dropped outside any category — move to uncategorized
                        moveChannelToCategory(serverId, ch.id, null);
                    }
                });
            }
            // Channel drag-to-reorder within category
            div.addEventListener('dragover', function (e) {
                e.preventDefault();
                var isChDrag = e.dataTransfer.types.indexOf('text/channel-id') !== -1;
                var isCatDrag = e.dataTransfer.types.indexOf('text/category-id') !== -1;
                if (isChDrag && !isCatDrag) {
                    e.dataTransfer.dropEffect = 'move';
                    var rect = div.getBoundingClientRect();
                    var midY = rect.top + rect.height / 2;
                    // Clean indicators on siblings
                    div.classList.remove('drag-over-top', 'drag-over-bottom');
                    var siblings = body.querySelectorAll('.channel-item');
                    siblings.forEach(function (s) { s.classList.remove('drag-over-top', 'drag-over-bottom'); });
                    if (e.clientY < midY) {
                        div.classList.add('drag-over-top');
                    } else {
                        div.classList.add('drag-over-bottom');
                    }
                }
            });
            div.addEventListener('dragleave', function (e) {
                if (!div.contains(e.relatedTarget)) {
                    div.classList.remove('drag-over-top', 'drag-over-bottom');
                }
            });
            div.addEventListener('drop', function (e) {
                e.preventDefault();
                e.stopPropagation();
                stopChannelListAutoScroll();
                div.classList.remove('drag-over-top', 'drag-over-bottom');
                var draggedChId = e.dataTransfer.getData('text/channel-id');
                if (draggedChId && draggedChId !== ch.id && isOwner) {
                    // Reorder: get all channels in this body, compute new order
                    var allChDivs = body.querySelectorAll('.channel-item[data-id]');
                    var ids = Array.from(allChDivs).map(function (d) { return d.getAttribute('data-id'); });
                    var fromIdx = ids.indexOf(draggedChId);
                    var isCrossCategory = fromIdx === -1;
                    if (fromIdx !== -1) ids.splice(fromIdx, 1);
                    var toIdx = ids.indexOf(ch.id);
                    var rect = div.getBoundingClientRect();
                    if (e.clientY > rect.top + rect.height / 2) toIdx++;
                    ids.splice(toIdx, 0, draggedChId);
                    // If cross-category, move the channel to this category first
                    var doReorder = function () {
                        return reorderChannelsAPI(serverId, ids).then(function () {
                            if (typeof window.loadChannels === 'function') window.loadChannels(serverId);
                        });
                    };
                    if (isCrossCategory) {
                        moveChannelToCategory(serverId, draggedChId, categoryId).then(doReorder);
                    } else {
                        doReorder();
                    }
                }
            });

            if (isVoiceCh) {

                div.addEventListener('click', function () {

                    if (window.VoiceManager) VoiceManager.joinServerVoice(serverId, ch.id, chDisplayName);

                });            } else {
                // Double-tap detection via touchstart (instant, no delay).
                // If the same channel is tapped twice within 150 ms, show the
                // context menu instead of entering the channel.
                var _chLastTouchEnd = 0, _chLastTouchTarget = null;
                div.addEventListener('touchend', function () {
                    var now = Date.now();
                    if (div === _chLastTouchTarget && (now - _chLastTouchEnd) < 150) {
                        _chLastTouchTarget = null;
                        window._chTapPending = false;
                        window._doubleTapJustFired = true;
                        _showChannelContextMenu(0, 0, serverId, ch, chDisplayName, categoryId, isOwner);
                        return;
                    }
                    _chLastTouchTarget = div;
                    _chLastTouchEnd = now;
                    window._chTapPending = true;
                    setTimeout(function () { window._chTapPending = false; }, 200);
                }, { passive: true });
                div.addEventListener('click', function (ev) {
                    if (window._doubleTapJustFired) { window._doubleTapJustFired = false; return; }
                    if (ev.isTrusted && window.VoiceManager && window.VoiceManager.exitVoiceChannelView) {
                        try { window.VoiceManager.exitVoiceChannelView(); } catch (_) {}
                    }
                    selectChannel(ch.id, chDisplayName, div);
                });
            }



            var nameSpan = document.createElement('span');
            nameSpan.innerHTML = (isVoiceCh ? icon('volume-on') + ' ' : '# ') + chDisplayName;
            nameSpan.style.flex = '1';
            div.appendChild(nameSpan);
            // Right-click context menu for channel (all users)
            div.addEventListener('contextmenu', function (e) {
                if (_chDragTimerPending) return; // suppress during long-press
                e.preventDefault();
                e.stopPropagation();
                _showChannelContextMenu(e.clientX, e.clientY, serverId, ch, chDisplayName, categoryId, isOwner);
            });

            body.appendChild(div);

        });

    }



    async function reorderCategoriesAPI(serverId, orderedIds) {
        try {
            var res = await authFetch('/api/servers/' + serverId + '/categories/reorder', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ordered_ids: orderedIds })
            });
            return await res.json();
        } catch (err) {
            console.error('Failed to reorder categories:', err);
            return null;
        }
    }

    async function reorderChannelsAPI(serverId, orderedIds) {
        try {
            var res = await authFetch('/api/servers/' + serverId + '/channels/reorder', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ordered_ids: orderedIds })
            });
            return await res.json();
        } catch (err) {
            console.error('Failed to reorder channels:', err);
            return null;
        }
    }

    // --- Live category indicator updater ---
    // Re-evaluates notif / mention / voice dots on existing category headers
    // without a full loadChannels re-render.
    function updateCategoryIndicators() {
        var groups = document.querySelectorAll('.channel-category-group[data-category-id]');
        groups.forEach(function (group) {
            var header = group.querySelector('.channel-category-header');
            if (!header) return;
            var body = group.querySelector('.channel-category-body');
            if (!body) return;
            var channelIds = [];
            var hasVoiceChannel = false;
            body.querySelectorAll('.channel-item[data-id]').forEach(function (el) {
                channelIds.push(el.getAttribute('data-id'));
                if (el.classList.contains('channel-item-voice')) hasVoiceChannel = true;
            });
            // --- notif / mention ---
            var hasNotif = false;
            var hasMention = false;
            for (var i = 0; i < channelIds.length; i++) {
                if (typeof unreadChannels !== 'undefined' && unreadChannels && unreadChannels.indexOf(channelIds[i]) !== -1) hasNotif = true;
                if (typeof unreadMentionsByChannel !== 'undefined' && unreadMentionsByChannel[channelIds[i]]) hasMention = true;
            }
            // --- voice activity ---
            var hasVoice = false;
            if (hasVoiceChannel && typeof window.VoiceManager !== 'undefined' && VoiceManager.getServerPresence && typeof currentServerId !== 'undefined' && currentServerId) {
                var _presence = VoiceManager.getServerPresence(currentServerId);
                if (_presence && _presence.channels) {
                    for (var vi = 0; vi < _presence.channels.length; vi++) {
                        if (channelIds.indexOf(_presence.channels[vi].channel_id) !== -1 && _presence.channels[vi].members && _presence.channels[vi].members.length > 0) {
                            hasVoice = true;
                            break;
                        }
                    }
                }
            }
            header.classList.toggle('category-has-notif', hasNotif);
            header.classList.toggle('category-has-mention', hasMention);
            header.classList.toggle('category-has-voice', hasVoice);
        });
    }
    window.updateCategoryIndicators = updateCategoryIndicators;

    // --- Right-click context menus for categories and channels ---
    function _dismissContextMenu() {
        var old = document.querySelector('.channel-context-menu');
        if (old) old.remove();
    }
    document.addEventListener('click', _dismissContextMenu);
    document.addEventListener('contextmenu', function () { _dismissContextMenu(); });

    function _showContextMenu(x, y, items) {
        _dismissContextMenu();
        var menu = document.createElement('div');
        menu.className = 'channel-context-menu';
        items.forEach(function (item) {
            if (item === '---') {
                var sep = document.createElement('div');
                sep.style.cssText = 'height:1px;background:var(--border-color,#333);margin:4px 0;';
                menu.appendChild(sep);
                return;
            }
            var el = document.createElement('div');
            el.className = 'context-menu-item' + (item.danger ? ' context-menu-danger' : '') + (item.disabled ? ' disabled' : '');
            // An item may carry `icon` (a sprite name) — render the icon glyph
            // next to the label. The icon markup comes from the trusted local
            // icon() sprite helper; the LABEL is always inserted as text, never
            // as HTML, so a channel/user name in a label can't inject markup.
            if (item.icon && typeof icon === 'function') {
                el.innerHTML = icon(item.icon, item.iconSize || 14);
                var lbl = document.createElement('span');
                lbl.className = 'context-menu-label';
                lbl.textContent = item.label;
                el.appendChild(lbl);
            } else {
                el.textContent = item.label;
            }
            if (item.disabled) {
                el.style.opacity = '0.4';
                el.style.cursor = 'default';
            } else {
                el.addEventListener('click', function (e) {
                    e.stopPropagation();
                    menu.remove();
                    item.action();
                });
            }
            menu.appendChild(el);
        });
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        document.body.appendChild(menu);
        // Keep menu on screen (check all edges)
        var rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) menu.style.left = Math.max(0, x - rect.width) + 'px';
        if (rect.bottom > window.innerHeight) menu.style.top = Math.max(0, y - rect.height) + 'px';
        if (rect.left < 0) menu.style.left = '0px';
        if (rect.top < 0) menu.style.top = '0px';
    }

    function _showCategoryContextMenu(x, y, serverId, categoryId, catName, channels) {
        var canEditPerms = (typeof ServerRoles !== 'undefined' && ServerRoles.has && ServerRoles.has(ServerRoles.bit('MANAGE_ROLES')));
        var items = [
            { label: 'Rename', action: function () {
                _showCategoryNameModal('Rename Category', 'Rename', function (newName) {
                    renameCategory(serverId, categoryId, newName).then(function () {
                        if (typeof window.loadChannels === 'function') window.loadChannels(serverId);
                    });
                }, catName);
            }},
            { label: 'Add Channel', action: function () {
                window._pendingChannelCategoryId = categoryId;
                var modal = document.getElementById('create-channel-modal');
                if (modal) {
                    modal.style.display = 'flex';
                    var nameInput = document.getElementById('new-channel-name');
                    if (nameInput) { nameInput.value = ''; nameInput.focus(); }
                }
            }},
            { label: 'Mute All Channels', action: function () {
                channels.forEach(function (ch) {
                    if (ch.channel_type !== 'voice') {
                        if (typeof toggleMuteChannel === 'function') toggleMuteChannel(ch.id, serverId);
                    }
                });
            }},
            { label: 'Mark All as Read', action: function () {
                channels.forEach(function (ch) {
                    if (typeof clearUnreadChannelMentions === 'function') clearUnreadChannelMentions(ch.id);
                });
            }},
            '---',
            { label: 'Edit Permissions', action: function () {
                if (typeof window.openChannelPermissionsModal === 'function') {
                    window.openChannelPermissionsModal('category', categoryId, catName);
                }
            }},
            { label: 'Delete', danger: true, action: async function () {
                var chCount = channels.length;
                var msg = 'Delete category "' + catName + '"?';
                if (chCount > 0) {
                    msg += '\n\nThis will permanently delete ' + chCount + ' channel' + (chCount > 1 ? 's' : '') + ' and ALL messages inside them.';
                }
                msg += '\n\nThis cannot be undone.';
                if (!(await uiConfirm(msg))) return;
                deleteCategory(serverId, categoryId).then(function (result) {
                    if (result && result.ok) {
                        loadChannels(serverId);
                    } else if (result && result.error) {
                        alert(result.error);
                    }
                });
            }}
        ];
        _showContextMenu(x, y, items);
    }

    function _showChannelContextMenu(x, y, serverId, ch, chDisplayName, categoryId, isOwner) {
        var items = [];
        // Owner-only actions
        if (isOwner) {
            items.push({ label: 'Rename', action: function () {
                _showChannelRenameModal(chDisplayName, function (newName) {
                    renameChannelAPI(serverId, ch.id, newName).then(function () {
                        if (typeof window.loadChannels === 'function') window.loadChannels(serverId);
                    });
                });
            }});
        }
        // Mute toggle (all users)
        var isMuted = typeof mutedChannels !== 'undefined' && mutedChannels.indexOf(ch.id) !== -1;
        items.push({ label: isMuted ? 'Unmute #' + chDisplayName : 'Mute #' + chDisplayName, action: function () {
            if (typeof toggleMuteChannel === 'function') toggleMuteChannel(ch.id, serverId);
        }});
        // Clear notifications (all users)
        var unreadCount = (typeof unreadMentionsByChannel !== 'undefined' && unreadMentionsByChannel[ch.id]) ? unreadMentionsByChannel[ch.id].count : 0;
        items.push({ label: unreadCount > 0 ? 'Clear notifications (' + unreadCount + ')' : 'No notifications', action: function () {
            if (typeof clearUnreadChannelMentions === 'function') clearUnreadChannelMentions(ch.id);
        }});
        // Edit Permissions (owner or MANAGE_ROLES)
        var canEditPerms = (typeof ServerRoles !== 'undefined' && ServerRoles.has && ServerRoles.has(ServerRoles.bit('MANAGE_ROLES')));
        if (isOwner || canEditPerms) {
            items.push({ label: 'Edit Permissions', action: function () {
                if (typeof window.openChannelPermissionsModal === 'function') {
                    window.openChannelPermissionsModal('channel', ch.id, chDisplayName);
                }
            }});
        }
        // Owner-only: delete
        if (isOwner) {
            items.push('---');
            items.push({ label: 'Delete', danger: true, action: async function () {
                var msg = 'Delete channel "' + chDisplayName + '"?';
                msg += '\n\nThis will permanently delete ALL messages inside it.';
                msg += '\n\nThis cannot be undone.';
                if (!(await uiConfirm(msg))) return;
                deleteChannel(ch.id, ch.name);
            }});
        }
        _showContextMenu(x, y, items);
    }

    // --- In-page modals for rename / create (no browser prompts) ---
    function _showCategoryNameModal(title, buttonText, onConfirm, defaultValue) {
        var modal = document.getElementById('category-name-modal');
        var titleEl = document.getElementById('category-name-modal-title');
        var input = document.getElementById('category-name-input');
        var confirmBtn = document.getElementById('category-name-confirm');
        var cancelBtn = document.getElementById('category-name-cancel');
        if (!modal || !input || !confirmBtn || !cancelBtn) return;
        titleEl.textContent = title || 'Category Name';
        confirmBtn.textContent = buttonText || 'Create';
        input.value = defaultValue || '';
        modal.style.display = 'flex';
        setTimeout(function () { input.focus(); input.select(); }, 50);
        var committed = false;
        function commit() {
            if (committed) return;
            committed = true;
            var val = input.value.trim();
            modal.style.display = 'none';
            if (val) onConfirm(val);
        }
        function cancel() {
            if (committed) return;
            committed = true;
            modal.style.display = 'none';
        }
        confirmBtn.onclick = commit;
        cancelBtn.onclick = cancel;
        input.onkeydown = function (e) {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') cancel();
        };
    }

    function _showChannelRenameModal(currentName, onConfirm) {
        var modal = document.getElementById('channel-rename-modal');
        var input = document.getElementById('channel-rename-input');
        var confirmBtn = document.getElementById('channel-rename-confirm');
        var cancelBtn = document.getElementById('channel-rename-cancel');
        if (!modal || !input || !confirmBtn || !cancelBtn) return;
        input.value = currentName || '';
        modal.style.display = 'flex';
        setTimeout(function () { input.focus(); input.select(); }, 50);
        var committed = false;
        function commit() {
            if (committed) return;
            committed = true;
            var val = input.value.trim();
            modal.style.display = 'none';
            if (val && val !== currentName) onConfirm(val);
        }
        function cancel() {
            if (committed) return;
            committed = true;
            modal.style.display = 'none';
        }
        confirmBtn.onclick = commit;
        cancelBtn.onclick = cancel;
        input.onkeydown = function (e) {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') cancel();
        };
    }

    // --- Mobile double-tap: context menu (keeps drag-and-drop working) ---
    var _lastTapTarget = null;
    var _lastTapTime = 0;
    var DOUBLE_TAP_MS = 350;
    var isTouchDevice = ('ontouchstart' in window || navigator.maxTouchPoints > 0);

    if (isTouchDevice) {
        document.getElementById('channel-list').addEventListener('touchend', function(e) {
            var chDiv = e.target.closest('.channel-item[data-id]');
            var catHeader = e.target.closest('.channel-category-header');
            var target = chDiv || catHeader;
            if (!target) { _lastTapTarget = null; return; }
            var now = Date.now();
            if (target === _lastTapTarget && (now - _lastTapTime) < DOUBLE_TAP_MS) {
                e.preventDefault();
                e.stopPropagation();
                var touch = e.changedTouches ? e.changedTouches[0] : null;
                var cx = touch ? touch.clientX : 0;
                var cy = touch ? touch.clientY : 0;
                if (chDiv) {
                    var chId = chDiv.getAttribute('data-id');
                    var chName = chDiv.getAttribute('data-name') || '';
                    var isCat = chDiv.closest('.channel-category-group');
                    var catId = isCat ? isCat.getAttribute('data-category-id') : null;
                    var fakeCh = { id: chId, channel_type: chDiv.getAttribute('data-type') || 'text' };
                    if (typeof _showChannelContextMenu === 'function') {
                        _showChannelContextMenu(cx, cy, '', fakeCh, chName, catId, false);
                    }
                } else if (catHeader) {
                    var group = catHeader.closest('.channel-category-group');
                    if (group) {
                        var catIdVal = group.getAttribute('data-category-id');
                        var catChannels = [];
                        group.querySelectorAll('.channel-item[data-id]').forEach(function(el) {
                            catChannels.push({ id: el.getAttribute('data-id'), channel_type: el.getAttribute('data-type') || 'text' });
                        });
                        var catNameVal = catHeader.textContent.trim();
                        if (typeof _showCategoryContextMenu === 'function') {
                            _showCategoryContextMenu(cx, cy, '', catIdVal, catNameVal, catChannels);
                        }
                    }
                }
                _lastTapTarget = null;
            } else {
                _lastTapTarget = target;
                _lastTapTime = now;
            }
        });

        document.getElementById('server-list').addEventListener('touchend', function(e) {
            var svIcon = e.target.closest('.server-icon');
            if (!svIcon) return;
            var now = Date.now();
            if (svIcon === _lastTapTarget && (now - _lastTapTime) < DOUBLE_TAP_MS) {
                e.preventDefault();
                e.stopPropagation();
                var touch = e.changedTouches ? e.changedTouches[0] : null;
                if (touch && typeof showServerContextMenu === 'function') {
                    var fakeEvt = { clientX: touch.clientX, clientY: touch.clientY, preventDefault: function(){}, stopPropagation: function(){} };
                    showServerContextMenu(fakeEvt, svIcon.dataset.id, svIcon.title);
                }
                _lastTapTarget = null;
            } else {
                _lastTapTarget = svIcon;
                _lastTapTime = now;
            }
        });

        // DM items: double-tap opens DM context menu
        document.getElementById('channel-list').addEventListener('touchend', function(e) {
            var dmItem = e.target.closest('.dm-item[data-dm-id]');
            if (!dmItem) return;
            var now = Date.now();
            if (dmItem === _lastTapTarget && (now - _lastTapTime) < DOUBLE_TAP_MS) {
                e.preventDefault();
                e.stopPropagation();
                var touch = e.changedTouches ? e.changedTouches[0] : null;
                if (touch && typeof showDmContextMenu === 'function') {
                    var fakeEvt = { clientX: touch.clientX, clientY: touch.clientY, preventDefault: function(){}, stopPropagation: function(){} };
                    showDmContextMenu(fakeEvt, dmItem.dataset.dmId, dmItem.dataset.username || 'user');
                }
                _lastTapTarget = null;
            } else {
                _lastTapTarget = dmItem;
                _lastTapTime = now;
            }
        });

        // DM strip button: double-tap opens DM strip context menu
        (function() {
            var dmBtn = document.getElementById('dm-strip-btn');
            if (!dmBtn) return;
            var _dmLastTap = 0;
            dmBtn.addEventListener('touchend', function(e) {
                var now = Date.now();
                if (now - _dmLastTap < DOUBLE_TAP_MS) {
                    e.preventDefault();
                    var touch = e.changedTouches ? e.changedTouches[0] : null;
                    if (touch && typeof showDmStripContextMenu === 'function') {
                        var fakeEvt = { clientX: touch.clientX, clientY: touch.clientY, preventDefault: function(){}, stopPropagation: function(){} };
                        showDmStripContextMenu(fakeEvt);
                    }
                    _dmLastTap = 0;
                } else {
                    _dmLastTap = now;
                }
            });
        })();

        // Mentions strip button: double-tap opens mentions context menu
        (function() {
            var mtBtn = document.getElementById('mentions-strip-btn');
            if (!mtBtn) return;
            var _mtLastTap = 0;
            mtBtn.addEventListener('touchend', function(e) {
                var now = Date.now();
                if (now - _mtLastTap < DOUBLE_TAP_MS) {
                    e.preventDefault();
                    var touch = e.changedTouches ? e.changedTouches[0] : null;
                    if (touch) {
                        // The button already has a contextmenu handler — fire it synthetically
                        var fakeEvt = new MouseEvent('contextmenu', {
                            clientX: touch.clientX,
                            clientY: touch.clientY,
                            bubbles: true,
                            cancelable: true
                        });
                        mtBtn.dispatchEvent(fakeEvt);
                    }
                    _mtLastTap = 0;
                } else {
                    _mtLastTap = now;
                }
            });
        })();
    }

    // Expose category API

    window.showContextMenu = _showContextMenu;
    window.dismissContextMenu = _dismissContextMenu;

    window.loadCategories = loadCategories;

    window.renderChannelsWithCategories = renderChannelsWithCategories;
    window.decryptCategoryName = decryptCategoryName;

    window.moveChannelToCategory = moveChannelToCategory;

    window.deleteCategory = deleteCategory;

    window.renameCategory = renameCategory;

    window.renameChannelAPI = renameChannelAPI;

    window.reorderCategoriesAPI = reorderCategoriesAPI;

    window.reorderChannelsAPI = reorderChannelsAPI;



    // ─── F13: Keyboard Shortcut Customization ─────────────────────────

    var DEFAULT_SHORTCUTS = {

        'toggle_streamer_mode': { key: 's', shift: true, ctrl: true, label: 'Toggle Streamer Mode' },

        'toggle_media_previews': { key: 'm', shift: true, ctrl: true, label: 'Toggle Media Previews' },

        'search': { key: 'k', shift: true, ctrl: true, label: 'Search' },

        'toggle_sidebar': { key: 'b', shift: true, ctrl: true, label: 'Toggle Sidebar' },

        'nav_prev_channel': { key: 'ArrowUp', shift: true, ctrl: true, label: 'Previous Channel' },

        'nav_next_channel': { key: 'ArrowDown', shift: true, ctrl: true, label: 'Next Channel' },

        'nav_prev_server': { key: 'ArrowLeft', shift: true, ctrl: true, label: 'Previous Server' },

        'nav_next_server': { key: 'ArrowRight', shift: true, ctrl: true, label: 'Next Server' },

        'focus_composer': { key: '/', shift: false, ctrl: false, label: 'Focus Message Composer' },

        'toggle_upload': { key: 'u', shift: false, ctrl: false, label: 'Open Upload' },

        'toggle_emoji_picker': { key: 'e', shift: true, ctrl: false, label: 'Toggle Emoji Picker' }

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

    }    function _globalShortcutHandler(e) {

        // Don't intercept when typing in inputs (except for Esc)

        var tag = e.target.tagName;

        var inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;


        Object.keys(DEFAULT_SHORTCUTS).forEach(function (action) {

            var s = getShortcut(action);

            if (!s) return;

            // Single-key shortcuts (no ctrl/shift required) only fire when NOT in input

            var needsModifier = s.ctrl || s.shift;

            if (inInput && !needsModifier) return;


            if (e.ctrlKey === !!s.ctrl && e.shiftKey === !!s.shift && e.key && e.key.toLowerCase() === s.key.toLowerCase()) {

                e.preventDefault();

                executeShortcut(action);

            }

        });

    }



    function executeShortcut(action) {

        function _showToast(msg) {
            var old = document.querySelector('.streamer-toast');
            if (old) old.remove();
            var t = document.createElement('div');
            t.className = 'streamer-toast';
            t.innerHTML = msg;
            t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:99999;background:rgba(0,0,0,0.85);color:#fff;padding:8px 18px;border-radius:8px;font-size:13px;font-weight:600;pointer-events:none;transition:opacity 0.3s;';
            document.body.appendChild(t);
            setTimeout(function () { t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 350); }, 1500);
        }

        switch (action) {

            case 'toggle_streamer_mode':

                var st = document.getElementById('streamer-mode-toggle');

                if (st) {

                    st.checked = !st.checked;

                    localStorage.setItem('streamerMode', st.checked);

                    if (typeof applyStreamerMode === 'function') applyStreamerMode(st.checked);

                    _showToast(st.checked ? icon('live') + ' Streamer Mode ON' : icon('check') + ' Streamer Mode OFF');

                }

                break;

            case 'toggle_media_previews':

                var cb = document.getElementById('auto-load-previews');

                if (cb) {

                    cb.checked = !cb.checked;

                    localStorage.setItem('autoLoadPreviews', cb.checked);

                    if (currentServerId && currentChannelId && typeof loadMessages === 'function') loadMessages(currentChannelId);

                    else if (currentDmChannelId && typeof loadDmMessages === 'function') loadDmMessages(currentDmChannelId);

                    _showToast(cb.checked ? icon('check') + ' Media Previews ON' : icon('close') + ' Media Previews OFF');

                }

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


            // --- F13: New navigation shortcuts ---

            case 'nav_prev_channel':

            case 'nav_next_channel':

                navigateChannelNav(action === 'nav_next_channel' ? 1 : -1);

                break;


            case 'nav_prev_server':

            case 'nav_next_server':

                navigateServerNav(action === 'nav_next_server' ? 1 : -1);

                break;
            case 'focus_composer':

                var msgInput = document.getElementById('message-input');

                if (msgInput) { msgInput.focus(); msgInput.disabled = false; }

                break;



            case 'toggle_upload':
                var attachBtn = document.getElementById('attach-btn');

                if (attachBtn) attachBtn.click();

                break;

            case 'toggle_emoji_picker':

                var emojiBtn = document.getElementById('sticker-btn');

                if (emojiBtn) emojiBtn.click();

                break;

        }

    }


    // ─── Navigation helpers ───────────────────────────────────────────

    function navigateChannelNav(dir) {

        var channels = document.querySelectorAll('.channel-list-item');

        if (!channels.length) return;

        var idx = -1;

        for (var i = 0; i < channels.length; i++) {

            if (channels[i].classList.contains('active')) { idx = i; break; }

        }

        var next = idx + dir;

        if (next < 0) next = channels.length - 1;

        if (next >= channels.length) next = 0;

        channels[next].click();

    }


    function navigateServerNav(dir) {

        var icons = document.querySelectorAll('.server-icon:not(.add-server)');

        if (!icons.length) return;

        var idx = -1;

        for (var i = 0; i < icons.length; i++) {

            if (icons[i].classList.contains('active')) { idx = i; break; }

        }

        var next = idx + dir;

        if (next < 0) next = icons.length - 1;

        if (next >= icons.length) next = 0;

        icons[next].click();

    }


    function editOwnLastMessage() {

        var messages = document.querySelectorAll('.message[data-sender]');

        var selfId = (typeof getSelfId === 'function') ? getSelfId() : null;

        for (var i = messages.length - 1; i >= 0; i--) {

            var msg = messages[i];

            if (selfId && msg.getAttribute('data-sender') === selfId) {

                var editBtn = msg.querySelector('[data-action="edit"]');

                if (editBtn) editBtn.click();

                return;

            }

        }

    }


    function replyToLastMessage() {

        var messages = document.querySelectorAll('.message[data-mid]');

        if (!messages.length) return;

        var last = messages[messages.length - 1];

        var mid = last.getAttribute('data-mid');

        var sender = last.getAttribute('data-sender');

        if (!mid || !sender) return;

        var displayName = '';

        try {

            var cache = (typeof userDisplayNameCache !== 'undefined') ? userDisplayNameCache[sender] : null;

            displayName = cache ? (cache.display_name || cache.username || '') : '';

        } catch (_) {}

        showReplyBar(mid, displayName);

    }


    function showReplyBar(messageId, senderName) {

        var bar = document.getElementById('reply-bar');

        if (!bar) return;

        var msgEl = document.querySelector('[data-mid="' + messageId + '"]');

        var preview = msgEl ? (msgEl.querySelector('.message-text') || {}).textContent || '' : '';

        preview = preview.substring(0, 120);

        bar.innerHTML = '<span class="reply-bar-text">Replying to <strong>' + (senderName || 'message') + '</strong>: ' + preview + '</span>' +

            '<button class="reply-bar-close" onclick="document.getElementById(\'reply-bar\').style.display=\'none\'">&times;</button>';

        bar.style.display = 'flex';

        bar.setAttribute('data-reply-to', messageId);

        var msgInput = document.getElementById('message-input');

        if (msgInput) { msgInput.focus(); msgInput.disabled = false; }

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

    // ── Built-in theme presets ──
    var _defaultCssCache = null;
    function fetchDefaultCss() {
        // Always fetch fresh style.css so the textarea reflects any CSS updates
        return fetch('/style.css?v=' + Date.now()).then(function(r) { return r.text(); }).then(function(css) {
            _defaultCssCache = css || '/* Could not load style.css */';
            return _defaultCssCache;
        }).catch(function() {
            return _defaultCssCache || '/* Could not load style.css */';
        });
    }

    var BUILTIN_THEMES = {
        'default': null, // loaded via fetchDefaultCss()

        'performance': [
            '/* ⚡ Performance Theme */',
            '* { animation: none !important; transition: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }',
            '.sidebar, .server-strip, .chat-header, .chat-body, .chat-input, .main, .members-panel, .modal-content, .settings-panel, .context-menu {',
            '    box-shadow: none !important; text-shadow: none !important; background-image: none !important;',
            '}',
            'body { background: #1a1a1a !important; }',
            '.sidebar { background: #1e1e1e !important; }',
            '.server-strip { background: #161616 !important; }',
            '.chat-header { background: #1e1e1e !important; border-bottom-color: #333 !important; }',
            '.chat-body { background: #1a1a1a !important; }',
            '.chat-input { background: #222 !important; }',
            '.members-panel { background: #1e1e1e !important; }',
            '.message { border-left-color: transparent !important; }',
            '.modal-content { background: #1e1e1e !important; }',
            '.settings-panel { background: #1e1e1e !important; }',
            '.context-menu { background: #222 !important; }',
            '.btn, button { box-shadow: none !important; }',
            '.channel-item:hover, .server-icon:hover, .dm-item:hover { background: rgba(255,255,255,0.05) !important; transform: none !important; }'
        ].join('\n'),

        'premium': [
            '/* ✨ Premium Glassmorphism Theme */',
            '.sidebar, .server-strip, .chat-header, .members-panel, .modal-content, .settings-panel, .context-menu {',
            '    backdrop-filter: blur(20px) saturate(1.4); -webkit-backdrop-filter: blur(20px) saturate(1.4);',
            '    background: color-mix(in srgb, var(--bg-secondary, #16213e) 60%, transparent) !important;',
            '    border-color: rgba(255,255,255,0.08) !important;',
            '}',
            '.chat-body { backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }',
            '.chat-input { backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }',
            '.message { transform: translateY(0); transition: transform 0.15s ease, box-shadow 0.15s ease !important; }',
            '.message:hover { transform: translateY(-1px); box-shadow: 0 2px 12px rgba(0,0,0,0.2); }',
            '.chat-input:focus-within { box-shadow: 0 0 0 2px var(--accent, #4fc3f7), 0 0 16px rgba(79,195,247,0.2); }',
            '.server-icon:hover { box-shadow: 0 0 16px rgba(79,195,247,0.4); }',
            '.modal-content { border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 8px 40px rgba(0,0,0,0.5); }',
            '::-webkit-scrollbar { width: 6px; }',
            '::-webkit-scrollbar-track { background: transparent; }',
            '::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }',
            '::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }',
            '.channel-item:hover, .dm-item:hover { background: rgba(255,255,255,0.05); transform: translateX(2px); }',
            'button, .btn { transition: all 0.15s ease !important; }',
            'button:hover, .btn:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }'
        ].join('\n'),

        'highcontrast': [
            '/* ⭐ High Contrast WCAG AAA Theme */',
            ':root { --bg-primary: #000000; --bg-secondary: #111111; --bg-border: #ffffff; --accent: #ffff00; --accent-hover: #e6e600; --text-primary: #ffffff; --text-muted: #cccccc; --danger: #ff4444; --success: #44ff44; }',
            'body { background: #000000 !important; color: #ffffff !important; animation: none !important; transition: none !important; }',
            '* { animation: none !important; transition: none !important; }',
            '.sidebar { background: #111111 !important; border-right: 2px solid #ffffff !important; }',
            '.server-strip { background: #000000 !important; border-right: 2px solid #ffffff !important; }',
            '.chat-header { background: #111111 !important; border-bottom: 2px solid #ffffff !important; }',
            '.chat-body { background: #000000 !important; }',
            '.chat-input { background: #111111 !important; border: 2px solid #ffffff !important; color: #ffffff !important; }',
            '.members-panel { background: #111111 !important; border-left: 2px solid #ffffff !important; }',
            '.message { border-left: 2px solid #ffffff !important; color: #ffffff !important; }',
            '.server-icon { border: 2px solid #ffffff !important; background: #000000 !important; color: #ffffff !important; }',
            '.server-icon:hover, .server-icon.active { background: #ffffff !important; color: #000000 !important; }',
            '.channel-item { color: #ffffff !important; border: 1px solid transparent !important; }',
            '.channel-item:hover { background: rgba(255,255,255,0.1) !important; border-color: #ffffff !important; }',
            '.dm-item { color: #ffffff !important; border: 1px solid transparent !important; }',
            '.dm-item:hover { background: rgba(255,255,255,0.1) !important; border-color: #ffffff !important; }',
            '.modal-content { background: #111111 !important; border: 2px solid #ffffff !important; color: #ffffff !important; }',
            'input, textarea, select { background: #000000 !important; color: #ffffff !important; border: 2px solid #ffffff !important; }',
            'input:focus, textarea:focus, select:focus { outline: 3px solid #ffff00 !important; outline-offset: 2px; }',
            'button, .btn { border: 2px solid #ffffff !important; color: #ffffff !important; }',
            'button:hover, .btn:hover { background: #ffffff !important; color: #000000 !important; }',
            'a { color: #ffff00 !important; text-decoration: underline !important; }',
            '*:focus-visible { outline: 3px solid #ffff00 !important; outline-offset: 2px; }'
        ].join('\n')
    };

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

    // ── CSS Export/Import with optional password encryption ──
    var _cssExportNoPw = false;
    var _cssPendingImport = null;
    var _cssPwMode = 'export'; // 'export' | 'import-enc' | 'import-plain'

    function cssPwShow(title, mode) {
        var modal = document.getElementById('css-pw-modal');
        if (!modal) return;
        _cssPwMode = mode;
        var isExport = mode === 'export';
        var isPlain = mode === 'import-plain';
        var needPw = isExport ? !_cssExportNoPw : !isPlain;
        var titleEl = document.getElementById('css-pw-title');
        var hintEl = document.getElementById('css-pw-hint');
        var fieldsEl = document.getElementById('css-pw-fields');
        var confirmWrap = document.getElementById('css-pw-confirm-wrap');
        var nopwWrap = document.getElementById('css-pw-nopw-wrap');
        var nopwCb = document.getElementById('css-pw-nopw');
        var nopwNote = document.getElementById('css-pw-nopw-note');
        var errorEl = document.getElementById('css-pw-error');
        var pwInput = document.getElementById('css-pw-input');
        var confirmInput = document.getElementById('css-pw-confirm-input');
        if (titleEl) titleEl.textContent = title;
        if (hintEl) {
            hintEl.textContent = isPlain
                ? 'This backup has no password — it is not encrypted. Anyone with the file can read your CSS.'
                : (isExport
                    ? (_cssExportNoPw
                        ? 'No password will be used — the backup is saved unencrypted.'
                        : 'The backup is encrypted on your device with the password below. Keep it safe — you will need it to import.')
                    : 'Enter the password that was used to encrypt this backup.');
        }
        if (fieldsEl) fieldsEl.style.display = needPw ? '' : 'none';
        if (confirmWrap) confirmWrap.style.display = (isExport && !_cssExportNoPw) ? '' : 'none';
        if (nopwWrap) nopwWrap.style.display = isExport ? '' : 'none';
        if (nopwCb) nopwCb.checked = _cssExportNoPw;
        if (nopwNote) nopwNote.style.display = isPlain ? '' : 'none';
        if (errorEl) errorEl.style.display = 'none';
        if (pwInput) pwInput.value = '';
        if (confirmInput) confirmInput.value = '';
        modal.style.display = 'flex';
        if (needPw && pwInput) pwInput.focus();
    }

    function cssPwHide() {
        var modal = document.getElementById('css-pw-modal');
        if (modal) modal.style.display = 'none';
        _cssPendingImport = null;
    }

    function downloadCssFile(fileData) {
        var blob = new Blob([JSON.stringify(fileData)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'e2e_css_' + new Date().toISOString().slice(0, 10) + '.e2ecss';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // ── F14: E2E encryption helpers for CSS slots ──
    function _getCssEncKey() {
        var kp = (window.E2ECrypto && E2ECrypto.getIdentityKeyPair) ? E2ECrypto.getIdentityKeyPair() : null;
        return kp ? kp.privateKey : null;
    }
    function _encryptCss(cssPlaintext) {
        var key = _getCssEncKey();
        if (!key) {
            // Fallback: base64 encode (no encryption available)
            return { encrypted_css: btoa(unescape(encodeURIComponent(cssPlaintext))), nonce: '' };
        }
        var enc = E2ECrypto.aeadEncrypt(cssPlaintext, key);
        return { encrypted_css: enc.ciphertext, nonce: enc.nonce };
    }
    function _decryptCss(encryptedCss, nonce) {
        if (!encryptedCss) return '';
        var key = _getCssEncKey();
        if (!key || !nonce) {
            // Fallback: treat as base64
            try { return decodeURIComponent(escape(atob(encryptedCss))); } catch (_) { return ''; }
        }
        try {
            var pt = E2ECrypto.aeadDecrypt(encryptedCss, key, nonce);
            if (!pt) return '';
            return (typeof pt === 'string') ? pt : new TextDecoder().decode(pt);
        } catch (_) {
            // Legacy base64 fallback
            try { return decodeURIComponent(escape(atob(encryptedCss))); } catch (_) { return ''; }
        }
    }

    function buildCssPayload() {
        // Build payload from the currently visible textarea
        var ta = document.getElementById('custom-css-textarea');
        return { css: ta ? ta.value : '' };
    }

    function applyCssPayload(payload) {
        if (!payload || !payload.css) return Promise.resolve(false);
        var enc = _encryptCss(payload.css);
        // Save to the active slot (or slot 1 if none active)
        var targetSlot = 1;
        return fetchCssSlots().then(function (data) {
            targetSlot = data.active_slot > 0 ? data.active_slot : 1;
            return authFetch('/api/user-css/slot/' + targetSlot, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(enc)
            });
        }).then(function () {
            invalidateCssSlotCache();
            return authFetch('/api/user-css/active', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active_slot: targetSlot })
            });
        }).then(function () {
            applyCustomCss(payload.css);
            return true;
        }).catch(function () { return false; });
    }

    // ── CSS modal event wiring (once at load) ──
    (function _wireCssPwModal() {
        // Wait for DOM
        function init() {
            var nopwCb = document.getElementById('css-pw-nopw');
            if (nopwCb) {
                nopwCb.addEventListener('change', function () {
                    _cssExportNoPw = nopwCb.checked;
                    if (_cssPwMode === 'export') cssPwShow('Export CSS', 'export');
                });
            }
            var modal = document.getElementById('css-pw-modal');
            if (modal) {
                modal.addEventListener('click', function (e) {
                    if (e.target === modal) cssPwHide();
                });
            }
            var cancelBtn = document.getElementById('css-pw-cancel-btn');
            if (cancelBtn) cancelBtn.addEventListener('click', cssPwHide);
            var confirmBtn = document.getElementById('css-pw-confirm-btn');
            if (confirmBtn) {
                confirmBtn.addEventListener('click', function () {
                    var pwInput = document.getElementById('css-pw-input');
                    var confirmInput = document.getElementById('css-pw-confirm-input');
                    var errorEl = document.getElementById('css-pw-error');
                    var pw = pwInput ? pwInput.value : '';
                    // ── Import: no-password backup ──
                    if (_cssPendingImport && _cssPwMode === 'import-plain') {
                        try {
                            applyCssPayload(_cssPendingImport.payload).then(function (ok) {
                                if (ok) {
                                    cssPwHide();
                                    showToast('CSS imported');
                                    invalidateCssSlotCache();
                                    if (typeof renderCustomCssSettings === 'function') {
                                        var container = document.getElementById('custom-css-editor-container');
                                        if (container) renderCustomCssSettings(container);
                                    }
                                } else {
                                    if (errorEl) { errorEl.textContent = 'Backup file is not supported.'; errorEl.style.display = ''; }
                                }
                            });
                        } catch (_) {
                            if (errorEl) { errorEl.textContent = 'Backup file is corrupted.'; errorEl.style.display = ''; }
                        }
                        return;
                    }
                    // ── Import: encrypted backup ──
                    if (_cssPendingImport) {
                        if (!pw) {
                            if (errorEl) { errorEl.textContent = 'Enter the password.'; errorEl.style.display = ''; }
                            return;
                        }
                        var decrypted = E2ECrypto.decryptWithPassword(
                            _cssPendingImport.encrypted_private_key, pw,
                            _cssPendingImport.salt, _cssPendingImport.nonce);
                        if (!decrypted) {
                            if (errorEl) { errorEl.textContent = 'Wrong password — could not decrypt this backup.'; errorEl.style.display = ''; }
                            return;
                        }
                        try {
                            applyCssPayload(JSON.parse(decrypted)).then(function (ok) {
                                if (ok) {
                                    cssPwHide();
                                    showToast('CSS imported');
                                    invalidateCssSlotCache();
                                    if (typeof renderCustomCssSettings === 'function') {
                                        var container = document.getElementById('custom-css-editor-container');
                                        if (container) renderCustomCssSettings(container);
                                    }
                                } else {
                                    if (errorEl) { errorEl.textContent = 'Backup file is not supported.'; errorEl.style.display = ''; }
                                }
                            });
                        } catch (_) {
                            if (errorEl) { errorEl.textContent = 'Backup file is corrupted.'; errorEl.style.display = ''; }
                        }
                        return;
                    }
                    // ── Export without a password ──
                    if (_cssExportNoPw) {
                        try {
                            downloadCssFile({ app: 'e2e_chat', kind: 'custom_css', v: 1, payload: buildCssPayload() });
                            cssPwHide();
                            showToast('CSS exported (no password)');
                        } catch (e) {
                            if (errorEl) { errorEl.textContent = 'Export failed: ' + e.message; errorEl.style.display = ''; }
                        }
                        return;
                    }
                    // ── Export with a password ──
                    if (!pw) {
                        if (errorEl) { errorEl.textContent = 'Enter a password.'; errorEl.style.display = ''; }
                        return;
                    }
                    var confirmPw = confirmInput ? confirmInput.value : '';
                    if (pw.length < 4) {
                        if (errorEl) { errorEl.textContent = 'Password must be at least 4 characters.'; errorEl.style.display = ''; }
                        return;
                    }
                    if (pw !== confirmPw) {
                        if (errorEl) { errorEl.textContent = 'Passwords do not match.'; errorEl.style.display = ''; }
                        return;
                    }
                    try {
                        var enc = E2ECrypto.encryptWithPassword(JSON.stringify(buildCssPayload()), pw);
                        downloadCssFile({ app: 'e2e_chat', kind: 'custom_css', v: 1, salt: enc.salt, nonce: enc.nonce, encrypted_private_key: enc.encrypted_private_key });
                        cssPwHide();
                        showToast('CSS exported');
                    } catch (e) {
                        if (errorEl) { errorEl.textContent = 'Export failed: ' + e.message; errorEl.style.display = ''; }
                    }
                });
            }
        }
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    })();

    // ── F14: CSS Settings (2 server-side encrypted slots + default) ────

    var _cssSlotsCache = null; // { slot1: {encrypted_css, nonce}, slot2: {...}, active_slot }

    function fetchCssSlots() {
        if (_cssSlotsCache) return Promise.resolve(_cssSlotsCache);
        return authFetch('/api/user-css/slots').then(function (r) { return r.json(); }).then(function (data) {
            _cssSlotsCache = data;
            return data;
        }).catch(function () {
            _cssSlotsCache = { slot1: { encrypted_css: '' }, slot2: { encrypted_css: '' }, active_slot: 0 };
            return _cssSlotsCache;
        });
    }

    function invalidateCssSlotCache() { _cssSlotsCache = null; }

    function renderCustomCssSettings(container) {
        container.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)"><div style="display:inline-block;width:28px;height:28px;border:3px solid #444;border-top-color:var(--accent,#4fc3f7);border-radius:50%;animation:css-spin .6s linear infinite"></div><div style="margin-top:8px;font-size:13px">Loading CSS settings\u2026</div><style>@keyframes css-spin{to{transform:rotate(360deg)}}</style></div>';

        fetchCssSlots().then(function (slotsData) {
            var activeSlot = slotsData.active_slot || 0;
            var slot1Has = !!(slotsData.slot1 && slotsData.slot1.encrypted_css);
            var slot2Has = !!(slotsData.slot2 && slotsData.slot2.encrypted_css);

            var html = '<div class="custom-css-settings-inner">';

            // ── Slot Selector ──
            html += '<div style="margin-bottom:16px">';
            html += '<h3 style="color:var(--text-primary);margin:0 0 8px;font-size:14px">CSS Source</h3>';
            html += '<p style="color:var(--text-muted);font-size:12px;margin:0 0 12px">Choose which stylesheet to use. Custom CSS is encrypted and stored on the server.</p>';
            html += '<div style="display:flex;gap:8px;flex-wrap:wrap">';

            var slots = [
                { id: 0, label: 'Default', desc: 'App default stylesheet', hasContent: true, color: '#666' },
                { id: 1, label: 'Slot 1', desc: slot1Has ? icon('check-circle') + ' Saved custom CSS' : 'Empty slot', hasContent: slot1Has, color: '#4fc3f7' },
                { id: 2, label: 'Slot 2', desc: slot2Has ? icon('check-circle') + ' Saved custom CSS' : 'Empty slot', hasContent: slot2Has, color: '#7c4dff' }
            ];

            slots.forEach(function (s) {
                var active = activeSlot === s.id;
                var opacity = (!active && !s.hasContent) ? '0.5' : '1';
                html += '<div data-css-slot="' + s.id + '" style="cursor:pointer;padding:10px 16px;border-radius:8px;border:2px solid ' + (active ? s.color : '#333') + ';background:' + (active ? s.color + '22' : '#1a1a2e') + ';min-width:120px;text-align:center;opacity:' + opacity + ';transition:all .2s">';
                html += '<div style="color:' + (active ? s.color : '#ccc') + ';font-weight:600;font-size:13px;margin-bottom:4px">' + s.label + '</div>';
                html += '<div style="color:#888;font-size:10px">' + s.desc + '</div>';
                html += '</div>';
            });

            html += '</div></div>';

            // ── Textarea ──
            var isEditing = localStorage.getItem('css_editing_slot');
            var displayCss = '';
            var textareaReadonly = true;

            var loadSlotAsync = false;
            if (isEditing && parseInt(isEditing) === activeSlot) {
                textareaReadonly = false;
                displayCss = localStorage.getItem('css_draft_' + isEditing) || '';
            } else if (activeSlot === 0) {
                displayCss = '';
            } else if (slotsData['slot' + activeSlot] && slotsData['slot' + activeSlot].encrypted_css) {
                // Decode async — show placeholder while loading
                loadSlotAsync = true;
                displayCss = '/* Loading slot CSS\u2026 */';
            } else {
                displayCss = '/* Empty slot */';
            }

            html += '<textarea id="custom-css-textarea" style="width:100%;min-height:120px;max-height:600px;background:#0f0f23;border:1px solid #444;border-radius:8px;padding:12px;color:#d4d4d4;font-family:monospace;font-size:13px;resize:vertical;outline:none;overflow-y:auto"' + (textareaReadonly ? ' readonly placeholder="Select a source above"' : ' placeholder="/* Your custom CSS here */"') + '>';
            html += (displayCss || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            html += '</textarea>';

            // Auto-size
            setTimeout(function () {
                var ta = document.getElementById('custom-css-textarea');
                if (ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 600) + 'px'; }
            }, 0);

            // Load CSS async (default or slot)
            if (activeSlot === 0 && !isEditing) {
                setTimeout(function () {
                    fetchDefaultCss().then(function (css) {
                        var ta = document.getElementById('custom-css-textarea');
                        if (ta) {
                            ta.value = css;
                            ta.style.height = 'auto';
                            ta.style.height = Math.min(ta.scrollHeight, 600) + 'px';
                        }
                    });
                }, 0);
            } else if (loadSlotAsync) {
                setTimeout(function () {
                    _applyServerSlot(activeSlot);
                    var slotData = slotsData['slot' + activeSlot];
                    if (slotData && slotData.encrypted_css) {
                        try {
                            var decoded = _decryptCss(slotData.encrypted_css, slotData.nonce);
                            var ta = document.getElementById('custom-css-textarea');
                            if (ta) {
                                ta.value = decoded;
                                ta.style.height = 'auto';
                                ta.style.height = Math.min(ta.scrollHeight, 600) + 'px';
                            }
                        } catch (_) {}
                    }
                }, 0);
            }

            // ── Action Buttons ──
            html += '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">';

            if (isEditing && parseInt(isEditing) === activeSlot) {
                html += '<button id="css-save-slot" style="padding:10px 20px;border-radius:8px;border:none;background:linear-gradient(135deg,#4fc3f7,#29b6f6);color:#fff;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s;box-shadow:0 2px 8px rgba(79,195,247,0.3)">' + icon('check') + ' Save & Apply</button>';
                html += '<button id="css-preview" style="padding:10px 20px;border-radius:8px;border:2px solid #4fc3f7;background:transparent;color:#4fc3f7;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s">' + icon('eye') + ' Preview</button>';
                html += '<button id="css-import-file" style="padding:10px 20px;border-radius:8px;border:2px solid #666;background:rgba(255,255,255,0.05);color:#ccc;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s">' + icon('upload') + ' Import .css</button>';
                html += '<button id="css-cancel-edit" style="padding:10px 20px;border-radius:8px;border:2px solid #888;background:rgba(255,255,255,0.05);color:#ccc;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s">' + icon('close') + ' Cancel</button>';
                html += '<button id="css-clear-slot" style="padding:10px 20px;border-radius:8px;border:2px solid #f44336;background:rgba(244,67,54,0.1);color:#f44336;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s">' + icon('trash') + ' Clear Slot</button>';
            } else if (activeSlot > 0) {
                html += '<button id="css-copy" style="padding:10px 20px;border-radius:8px;border:none;background:linear-gradient(135deg,#4fc3f7,#29b6f6);color:#fff;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s;box-shadow:0 2px 8px rgba(79,195,247,0.3)">' + icon('copy') + ' Copy CSS</button>';
                html += '<button id="css-edit-slot" style="padding:10px 20px;border-radius:8px;border:2px solid #e0e0e0;background:rgba(224,224,224,0.1);color:#e0e0e0;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s">' + icon('edit') + ' Edit</button>';
                html += '<button id="css-export" style="padding:10px 20px;border-radius:8px;border:2px solid #7c4dff;background:rgba(124,77,255,0.1);color:#b388ff;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s">' + icon('download') + ' Export</button>';
                html += '<button id="css-import-backup" style="padding:10px 20px;border-radius:8px;border:2px solid #7c4dff;background:rgba(124,77,255,0.1);color:#b388ff;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s">' + icon('upload') + ' Import Backup</button>';
            } else {
                html += '<button id="css-copy" style="padding:10px 20px;border-radius:8px;border:none;background:linear-gradient(135deg,#4fc3f7,#29b6f6);color:#fff;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s;box-shadow:0 2px 8px rgba(79,195,247,0.3)">' + icon('copy') + ' Copy CSS</button>';
                html += '<button id="css-refresh" style="padding:10px 20px;border-radius:8px;border:2px solid #4fc3f7;background:transparent;color:#4fc3f7;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s">' + icon('refresh') + ' Refresh</button>';
            }

            html += '</div>';
            html += '<input type="file" id="css-import-backup-input" accept=".e2ecss,.json,application/json" style="display:none">';
            html += '<input type="file" id="css-import-file-input" accept=".css" style="display:none">';
            html += '</div>';

            container.innerHTML = html;

            // ── Wire up event listeners ──

            // Slot clicks
            container.querySelectorAll('[data-css-slot]').forEach(function (el) {
                el.addEventListener('click', function () {
                    var slotId = parseInt(el.getAttribute('data-css-slot'));
                    invalidateCssSlotCache();
                    localStorage.removeItem('css_editing_slot');
                    localStorage.removeItem('css_draft_1');
                    localStorage.removeItem('css_draft_2');
                    authFetch('/api/user-css/active', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ active_slot: slotId })
                    }).then(function () {
                        if (slotId > 0) {
                            applyCustomCss('');
                            _applyServerSlot(slotId);
                        } else {
                            applyCustomCss('');
                        }
                        renderCustomCssSettings(container);
                    });
                });
            });

            // Save to slot
            var saveBtn = document.getElementById('css-save-slot');
            if (saveBtn) {
                saveBtn.addEventListener('click', function () {
                    var ta = document.getElementById('custom-css-textarea');
                    var css = ta ? ta.value : '';
                    saveBtn.textContent = '\u23f3 Saving\u2026';
                    saveBtn.disabled = true;
                    var enc = _encryptCss(css);
                    authFetch('/api/user-css/slot/' + activeSlot, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(enc)
                    }).then(function () {
                        localStorage.removeItem('css_editing_slot');
                        localStorage.removeItem('css_draft_' + activeSlot);
                        invalidateCssSlotCache();
                        applyCustomCss(css);
                        saveBtn.textContent = '\u2705 Saved!';
                        setTimeout(function () { renderCustomCssSettings(container); }, 800);
                    }).catch(function () {
                        saveBtn.textContent = '\u274c Error';
                        saveBtn.disabled = false;
                        setTimeout(function () { saveBtn.textContent = '\ud83d\udcbe Save & Apply'; saveBtn.disabled = false; }, 1500);
                    });
                });
            }

            // Preview
            var previewBtn = document.getElementById('css-preview');
            if (previewBtn) {
                previewBtn.addEventListener('click', function () {
                    var ta = document.getElementById('custom-css-textarea');
                    if (ta) applyCustomCss(ta.value);
                    previewBtn.textContent = '\ud83d\udc41\ufe0f Applied!';
                    setTimeout(function () { previewBtn.textContent = '\ud83d\udc41\ufe0f Preview'; }, 1200);
                });
            }

            // Import .css file into textarea
            var importFileBtn = document.getElementById('css-import-file');
            if (importFileBtn) {
                importFileBtn.addEventListener('click', function () {
                    document.getElementById('css-import-file-input').click();
                });
            }
            var importFileInput = document.getElementById('css-import-file-input');
            if (importFileInput) {
                importFileInput.addEventListener('change', function (e) {
                    var file = e.target.files[0];
                    if (!file) return;
                    var reader = new FileReader();
                    reader.onload = function (ev) {
                        var ta = document.getElementById('custom-css-textarea');
                        if (ta) {
                            ta.value = ev.target.result;
                            ta.style.height = 'auto';
                            ta.style.height = Math.min(ta.scrollHeight, 600) + 'px';
                        }
                    };
                    reader.readAsText(file);
                    importFileInput.value = '';
                });
            }

            // Cancel edit
            var cancelBtn = document.getElementById('css-cancel-edit');
            if (cancelBtn) {
                cancelBtn.addEventListener('click', function () {
                    localStorage.removeItem('css_editing_slot');
                    localStorage.removeItem('css_draft_1');
                    localStorage.removeItem('css_draft_2');
                    renderCustomCssSettings(container);
                });
            }

            // Clear slot
            var clearBtn = document.getElementById('css-clear-slot');
            if (clearBtn) {
                clearBtn.addEventListener('click', async function () {
                    if (!(await uiConfirm('Clear this CSS slot?'))) return;
                    authFetch('/api/user-css/slot/' + activeSlot, { method: 'DELETE' }).then(function () {
                        invalidateCssSlotCache();
                        localStorage.removeItem('css_editing_slot');
                        localStorage.removeItem('css_draft_' + activeSlot);
                        applyCustomCss('');
                        renderCustomCssSettings(container);
                        showToast('Slot cleared');
                    });
                });
            }

            // Copy
            var copyBtn = document.getElementById('css-copy');
            if (copyBtn) {
                copyBtn.addEventListener('click', function () {
                    var ta = document.getElementById('custom-css-textarea');
                    if (ta) {
                        copyToClipboard(ta.value).then(function (ok) {
                            if (ok) {
                                copyBtn.innerHTML = icon('check') + ' Copied!';
                                setTimeout(function () { copyBtn.innerHTML = icon('copy') + ' Copy CSS'; }, 2000);
                            }
                        });
                    }
                });
            }

            // Refresh (re-fetch style.css for Default slot)
            var refreshBtn = document.getElementById('css-refresh');
            if (refreshBtn) {
                refreshBtn.addEventListener('click', function () {
                    invalidateCssSlotCache();
                    refreshBtn.textContent = '\u23f3 Loading\u2026';
                    refreshBtn.disabled = true;
                    fetchDefaultCss().then(function (css) {
                        var ta = document.getElementById('custom-css-textarea');
                        if (ta) {
                            ta.value = css;
                            ta.style.height = 'auto';
                            ta.style.height = Math.min(ta.scrollHeight, 600) + 'px';
                        }
                        refreshBtn.textContent = '\u2705 Refreshed!';
                        setTimeout(function () { refreshBtn.textContent = '\ud83d\udd04 Refresh'; refreshBtn.disabled = false; }, 1500);
                    });
                });
            }

            // Edit slot button
            var editBtn = document.getElementById('css-edit-slot');
            if (editBtn) {
                editBtn.addEventListener('click', function () {
                    localStorage.setItem('css_editing_slot', activeSlot);
                    renderCustomCssSettings(container);
                });
            }

            // Export (triggers password modal for optional encryption)
            var exportBtn = document.getElementById('css-export');
            if (exportBtn) {
                exportBtn.addEventListener('click', function () {
                    _cssExportNoPw = false;
                    cssPwShow('Export CSS', 'export');
                });
            }

            // Import backup (triggers password modal for encrypted or plaintext)
            var importBtn = document.getElementById('css-import-backup');
            if (importBtn) {
                importBtn.addEventListener('click', function () {
                    document.getElementById('css-import-backup-input').click();
                });
            }
            var importInput = document.getElementById('css-import-backup-input');
            if (importInput) {
                importInput.addEventListener('change', function (e) {
                    var file = e.target.files[0];
                    if (!file) return;
                    var reader = new FileReader();
                    reader.onload = function (ev) {
                        try {
                            var parsed = JSON.parse(ev.target.result);
                            if (!parsed || parsed.app !== 'e2e_chat' || parsed.kind !== 'custom_css') {
                                showToast('Not a valid CSS backup file');
                                return;
                            }
                            if (parsed.salt && parsed.nonce && parsed.encrypted_private_key) {
                                _cssPendingImport = parsed;
                                cssPwShow('Import CSS', 'import-enc');
                            } else if (parsed.payload) {
                                _cssPendingImport = parsed;
                                cssPwShow('Import CSS', 'import-plain');
                            } else {
                                showToast('Not a valid CSS backup file');
                            }
                        } catch (_) {
                            showToast('Could not read backup file');
                        }
                    };
                    reader.readAsText(file);
                    importInput.value = '';
                });
            }

        });
    }

    // Apply CSS from a server-side slot (decode base64)
    function _applyServerSlot(slotId) {
        fetchCssSlots().then(function (data) {
            var slot = slotId === 1 ? data.slot1 : data.slot2;
            if (!slot || !slot.encrypted_css) { applyCustomCss(''); return; }
            try {
                var css = _decryptCss(slot.encrypted_css, slot.nonce);
                applyCustomCss(css);
            } catch (_) {
                applyCustomCss('/* Could not decode CSS */');
            }
        });
    }

    // Auto-load active slot CSS on page load
    function _loadActiveSlotCss() {
        fetchCssSlots().then(function (data) {
            if (data.active_slot > 0) _applyServerSlot(data.active_slot);
        });
    }
    window.renderCustomCssSettings = renderCustomCssSettings;
    window.applyCustomCss = applyCustomCss;
    window.invalidateCssSlotCache = invalidateCssSlotCache;

})();
