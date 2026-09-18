// ======================================================================
// Server roles & permissions
//
// Roles are the ONLY way permissions are granted server-side, and every member
// holds at most one role. The @everyone role (is_everyone) applies to all
// members and is the fallback for members without a role. The server owner
// implicitly holds every permission and can never be restricted, kicked or
// banned — so the owner is not a role, it is the top of the hierarchy.
//
// The permission bits mirror server/src/db.rs (PERM_*). Bits are enforced
// server-side; this module only uses them to hide/disable UI.
// ======================================================================
(function () {
    'use strict';

    var PERMS = [
        { key: 'VIEW_CHANNEL', bit: 1 << 0, label: 'View channels', desc: 'See channels and read their messages.', tier: 'general' },
        { key: 'SEND_MESSAGES', bit: 1 << 1, label: 'Send messages', desc: 'Post messages in text channels.', tier: 'general' },
        { key: 'ADD_REACTIONS', bit: 1 << 2, label: 'Add reactions', desc: 'React to messages with emojis.', tier: 'general' },
        { key: 'REPLY_IN_THREADS', bit: 1 << 3, label: 'Reply in threads', desc: 'Reply inside message threads.', tier: 'general' },
        { key: 'ATTACH_FILES', bit: 1 << 4, label: 'Attach files', desc: 'Upload files, images and media.', tier: 'general' },
        { key: 'CREATE_POLLS', bit: 1 << 5, label: 'Create polls', desc: 'Start polls in a channel.', tier: 'general' },
        { key: 'CONNECT_VOICE', bit: 1 << 13, label: 'Connect to voice', desc: 'Join voice channels.', tier: 'voice' },
        { key: 'SPEAK', bit: 1 << 14, label: 'Speak', desc: 'Transmit microphone audio in voice.', tier: 'voice' },
        { key: 'USE_SOUNDBOARD', bit: 1 << 18, label: 'Use soundboard', desc: 'Play soundboard clips in voice.', tier: 'voice' },
        { key: 'CREATE_ROLES', bit: 1 << 19, label: 'Create roles', desc: 'Create new roles ranked below your own.', tier: 'management' },
        { key: 'INVITE_MEMBERS', bit: 1 << 20, label: 'Invite members', desc: 'Generate and share server invite links.', tier: 'management' },
        { key: 'EDIT_ROLES', bit: 1 << 21, label: 'Edit roles', desc: 'Edit roles ranked below your own (name, color, permissions).', tier: 'management' },
        { key: 'PIN_MESSAGES', bit: 1 << 6, label: 'Pin messages', desc: 'Pin and unpin messages (owner ability).', tier: 'moderation' },
        { key: 'MANAGE_MESSAGES', bit: 1 << 7, label: 'Manage messages', desc: "Delete other members' messages (owner ability).", tier: 'moderation' },
        { key: 'KICK_MEMBERS', bit: 1 << 8, label: 'Kick members', desc: 'Remove members from the server (owner ability).', tier: 'moderation' },
        { key: 'BAN_MEMBERS', bit: 1 << 9, label: 'Ban members', desc: 'Ban/unban members (owner ability).', tier: 'moderation' },
        { key: 'MUTE_MEMBERS', bit: 1 << 15, label: 'Mute members', desc: 'Server-mute/deafen others in voice (owner ability).', tier: 'moderation' },
        { key: 'MOVE_MEMBERS', bit: 1 << 16, label: 'Move members', desc: 'Disconnect members from voice (owner ability).', tier: 'moderation' },
        { key: 'MANAGE_SOUNDBOARD', bit: 1 << 17, label: 'Manage soundboard', desc: "Mute/disable other users' soundboard (owner ability).", tier: 'moderation' },
        { key: 'MANAGE_CHANNELS', bit: 1 << 10, label: 'Manage channels', desc: 'Create, rename, reorder and delete channels and categories (owner ability).', tier: 'management' },
        { key: 'MANAGE_SERVER', bit: 1 << 11, label: 'Manage server', desc: 'Rename the server, change its picture, invite and join settings (owner ability).', tier: 'management' },
        { key: 'MANAGE_ROLES', bit: 1 << 12, label: 'Manage roles', desc: 'Full control over all roles (owner ability).', tier: 'management' }
    ];

    var TIERS = [
        { id: 'general', label: 'General (on by default)' },
        { id: 'voice', label: 'Voice' },
        { id: 'moderation', label: 'Moderation' },
        { id: 'management', label: 'Management' }
    ];

    var ALL_BITS = PERMS.reduce(function (a, p) { return a | p.bit; }, 0);

    var state = {
        serverId: null,
        roles: [],
        myPermissions: 0,
        myRoleId: null,
        myPosition: 0,
        isOwner: false,
        channelPermissions: {},
        selectedRoleId: null,
        overwriteTarget: null
    };

    var SERVER_LEVEL_MANAGE_BITS = bit('MANAGE_ROLES') | bit('MANAGE_SERVER') | bit('BAN_MEMBERS') | bit('MANAGE_CHANNELS');

    function bit(key) {
        for (var i = 0; i < PERMS.length; i++) {
            if (PERMS[i].key === key) return PERMS[i].bit;
        }
        return 0;
    }

    function authHeaders() {
        // The app stores the session token as 'token' (auth_token is the legacy
        // key used by a few older tests).
        var t = localStorage.getItem('token') || localStorage.getItem('auth_token') || '';
        return { 'Authorization': 'Bearer ' + t };
    }

    function api(path, opts) {
        opts = opts || {};
        opts.headers = Object.assign({ 'Content-Type': 'application/json' }, authHeaders(), opts.headers || {});
        return fetch(path, opts);
    }

    // ─── Data ────────────────────────────────────────────────────────────

    async function load(serverId) {
        state.serverId = serverId;
        try {
            var res = await api('/api/servers/' + serverId + '/roles');
            if (!res.ok) return state;
            var data = await res.json();
            state.roles = data.roles || [];
            state.myPermissions = data.my_permissions || 0;
            state.myRoleId = data.my_role_id || null;
            state.myPosition = data.my_position || 0;
            state.isOwner = !!data.is_owner;
        } catch (_) { /* offline / no permission: leave previous state */ }
        return state;
    }

    async function loadMyPermissions(serverId) {
        try {
            var res = await api('/api/servers/' + serverId + '/my-permissions');
            if (!res.ok) return;
            var data = await res.json();
            if (serverId !== currentServerId) return;
            state.serverId = serverId;
            state.myPermissions = data.permissions || 0;
            state.isOwner = !!data.is_owner;
            state.channelPermissions = data.channels || {};
        } catch (_) {}
    }

    function has(bitVal) {
        if (state.isOwner) return true;
        if (state.serverId !== currentServerId) return true;
        return (state.myPermissions & bitVal) === bitVal;
    }

    function hasInChannel(bitVal, channelId) {
        if (state.isOwner) return true;
        if (!channelId) return has(bitVal);
        if (state.serverId !== currentServerId) return true;
        var p = state.channelPermissions[channelId];
        if (p === undefined) return has(bitVal);
        return (p & bitVal) === bitVal;
    }

    function roleById(id) {
        for (var i = 0; i < state.roles.length; i++) if (state.roles[i].id === id) return state.roles[i];
        return null;
    }

    // ─── Member list representation ──────────────────────────────────────

    /**
     * Colored circle for a member's role, with the role name as tooltip.
     * The role color is purely for permissions/identification — it never changes
     * the display name color (that stays a per-user profile setting).
     */
    function roleCircleHtml(member) {
        var color = member.role_color;
        var name = member.role_name;
        if (!name) {
            if (member.role === 'owner') { name = 'Owner'; color = 'var(--accent)'; }
            else { name = '@everyone'; color = '#99aab5'; }
        }
        if (!color) color = '#99aab5';
        return '<span class="role-circle" data-role-name="' + escapeAttr(name) + '" title="' + escapeAttr(name) + '" style="background:' + escapeAttr(color) + '"></span>';
    }

    // ─── Settings UI ─────────────────────────────────────────────────────

    function canManage(role) {
        return !!role && role.can_manage === true;
    }

    // ─── Tier model ──────────────────────────────────────────────────────
    // A "tier" is the set of roles sharing the same `position`. Higher
    // position = stronger rank, @everyone is always position 0 and lives
    // outside the tier list. Every tier edit (arrow buttons and drag-and-drop)
    // recomputes the whole tier order and renumbers only the tiers the caller
    // is allowed to manage, so positions stay evenly spaced and never run out
    // of integer gaps between neighbours.

    var _roleDragPayload = null;   // { roleId } | { tierPos } while dragging
    var _roleDragEndedAt = 0;      // suppresses the tap that ends a touch drag

    /** Ordered tiers, strongest first, built from the current role list. */
    function buildTiers() {
        var map = {};
        var order = [];
        state.roles.forEach(function (r) {
            if (r.is_everyone) return;
            if (!map[r.position]) { map[r.position] = []; order.push(r.position); }
            map[r.position].push(r);
        });
        order.sort(function (a, b) { return b - a; });
        return order.map(function (p) { return { pos: p, roles: map[p].slice() }; });
    }

    function cloneTiers(tiers) {
        return tiers.map(function (t) { return { pos: t.pos, roles: t.roles.slice() }; });
    }

    /** Positions to persist so the given tier order survives a round trip. */
    function computeTierPositionUpdates(tiers) {
        var managed = tiers.filter(function (t) {
            return t.roles.length > 0 && canManage(t.roles[0]);
        });
        if (!managed.length) return [];
        var count = managed.length;
        var base, step;
        if (state.isOwner || state.myPosition > 100000) {
            base = count * 10;
            step = 10;
        } else {
            // Managed roles must stay strictly below the caller's own rank.
            var highest = state.myPosition - 1;
            step = Math.max(1, Math.floor((highest + 1) / (count + 1)));
            base = highest;
        }
        var updates = [];
        managed.forEach(function (t, i) {
            var pos = base - (i * step);
            t.roles.forEach(function (r) {
                if (r.position !== pos) updates.push({ id: r.id, position: pos });
            });
        });
        return updates;
    }

    /** Persist a fully-computed tier layout (empty tiers are dropped). */
    async function applyTiers(tiers) {
        var ordered = tiers.filter(function (t) { return t.roles.length > 0; });
        var updates = computeTierPositionUpdates(ordered);
        if (!updates.length) { renderRoleList(); return; }
        var res = await api('/api/servers/' + state.serverId + '/roles/reorder', {
            method: 'PUT',
            body: JSON.stringify({ ordered_ids: updates })
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) { alert(data.error || 'Failed to reorder roles'); return; }
        await load(state.serverId);
        renderRoleList();
        renderEditor();
    }

    function tierIndexFor(tiers, role) {
        for (var i = 0; i < tiers.length; i++) {
            if (tiers[i].roles.indexOf(role) !== -1) return i;
        }
        return -1;
    }

    /**
     * Commit a drag-and-drop. `payload` is { roleId } (one role) or
     * { tierPos } (a whole tier). `targetPos` is the tier the pointer is over
     * (null = the trailing zone) and `mode` is 'join' | 'above' | 'below'.
     */
    async function dropRolePayload(payload, targetPos, mode) {
        _stopRoleAutoScroll();   // belt-and-braces: the drop ends any scrolling
        var tiers = buildTiers();
        var moving = [];
        if (payload && payload.roleId) {
            var r = roleById(payload.roleId);
            if (!r || r.is_everyone || !canManage(r)) return;
            moving = [r];
        } else if (payload && payload.tierPos !== undefined && payload.tierPos !== null) {
            var src = -1;
            tiers.forEach(function (t, i) { if (t.pos === payload.tierPos) src = i; });
            if (src < 0) return;
            moving = tiers[src].roles.slice();
            if (!moving.length || !canManage(moving[0])) return;
        } else {
            return;
        }
        var movingIds = moving.map(function (r) { return r.id; });

        var anchorIdx;
        if (targetPos === null || targetPos === undefined) {
            anchorIdx = tiers.length;
            mode = 'below';
        } else {
            anchorIdx = -1;
            tiers.forEach(function (t, i) { if (t.pos === targetPos) anchorIdx = i; });
            if (anchorIdx < 0) anchorIdx = tiers.length;
        }
        var insertIdx = (mode === 'join') ? anchorIdx : (mode === 'below' ? anchorIdx + 1 : anchorIdx);

        // Remove the dragged roles, dropping any tier they emptied.
        var out = [];
        for (var i = 0; i < tiers.length; i++) {
            var kept = tiers[i].roles.filter(function (r) { return movingIds.indexOf(r.id) === -1; });
            if (kept.length === 0) { if (i < insertIdx) insertIdx--; continue; }
            out.push({ pos: tiers[i].pos, roles: kept });
        }
        if (insertIdx < 0) insertIdx = 0;
        if (insertIdx > out.length) insertIdx = out.length;
        if (mode === 'join' && out[insertIdx]) {
            out[insertIdx] = { pos: out[insertIdx].pos, roles: out[insertIdx].roles.concat(moving) };
        } else {
            out.splice(insertIdx, 0, { pos: null, roles: moving.slice() });
        }
        await applyTiers(out);
    }

    // ─── Drag helpers ────────────────────────────────────────────────────

    function _isRoleDrag(e) {
        var types = e.dataTransfer && e.dataTransfer.types;
        if (!types) return false;
        return types.indexOf('text/role-id') !== -1 || types.indexOf('text/tier-pos') !== -1;
    }

    function _readRoleDragPayload(e) {
        var rid = e.dataTransfer.getData('text/role-id');
        if (rid) return { roleId: rid };
        var tp = e.dataTransfer.getData('text/tier-pos');
        if (tp !== '' && tp !== null && tp !== undefined) {
            var n = parseInt(tp, 10);
            if (!isNaN(n)) return { tierPos: n };
        }
        return _roleDragPayload;
    }

    var DROP_MARKER_CLASSES = ['drop-join', 'drop-above', 'drop-below', 'drop-active'];

    /** Enlarges the insertion strips while a drag is in flight. */
    function _setRoleDragging(on) {
        var list = document.getElementById('roles-list');
        if (list) list.classList.toggle('role-dragging', !!on);
    }

    function _clearRoleDropMarkers(except) {
        var nodes = document.querySelectorAll('.role-tier-group, .role-drop-gap');
        Array.prototype.forEach.call(nodes, function (el) {
            if (el === except) return;
            DROP_MARKER_CLASSES.forEach(function (c) { el.classList.remove(c); });
        });
    }

    function _markRoleDrop(el, mode) {
        _clearRoleDropMarkers(el);
        DROP_MARKER_CLASSES.forEach(function (c) { el.classList.remove(c); });
        el.classList.add('drop-' + mode);
    }

    // ─── Drag auto-scroll ────────────────────────────────────────────────
    // The roles list is a short scroll container (max-height 190px). While a
    // drag is in flight, holding the pointer near its top or bottom edge
    // scrolls it, so a role can be dropped into a tier that is out of view.
    var _roleAutoScroll = { active: false, container: null, y: 0, raf: null };
    var ROLE_SCROLL_EDGE = 34;    // px band at each edge that triggers scrolling
    var ROLE_SCROLL_MAX = 16;     // px per frame at the very edge

    function _onRoleDragOverCapture(e) { _roleAutoScroll.y = e.clientY; }

    function _roleAutoScrollTick() {
        var st = _roleAutoScroll;
        if (!st.active) { st.raf = null; return; }
        var el = st.container;
        if (el) {
            var rect = el.getBoundingClientRect();
            var delta = 0;
            if (st.y < rect.top + ROLE_SCROLL_EDGE) {
                var up = (rect.top + ROLE_SCROLL_EDGE - st.y) / ROLE_SCROLL_EDGE;
                delta = -Math.ceil(Math.max(0, Math.min(1, up)) * ROLE_SCROLL_MAX);
            } else if (st.y > rect.bottom - ROLE_SCROLL_EDGE) {
                var down = (st.y - (rect.bottom - ROLE_SCROLL_EDGE)) / ROLE_SCROLL_EDGE;
                delta = Math.ceil(Math.max(0, Math.min(1, down)) * ROLE_SCROLL_MAX);
            }
            if (delta) el.scrollTop = el.scrollTop + delta;
        }
        st.raf = requestAnimationFrame(_roleAutoScrollTick);
    }

    function _startRoleAutoScroll(container) {
        if (_roleAutoScroll.active || !container) return;
        _roleAutoScroll.active = true;
        _roleAutoScroll.container = container;
        // Capture phase so a child calling stopPropagation cannot hide the pointer.
        document.addEventListener('dragover', _onRoleDragOverCapture, true);
        if (_roleAutoScroll.raf) cancelAnimationFrame(_roleAutoScroll.raf);
        _roleAutoScroll.raf = requestAnimationFrame(_roleAutoScrollTick);
    }

    function _stopRoleAutoScroll() {
        if (!_roleAutoScroll.active) return;
        _roleAutoScroll.active = false;
        document.removeEventListener('dragover', _onRoleDragOverCapture, true);
        if (_roleAutoScroll.raf) { cancelAnimationFrame(_roleAutoScroll.raf); _roleAutoScroll.raf = null; }
        _roleAutoScroll.container = null;
    }

    /**
     * Force the browser's drag image to be a snapshot of `el`.
     *
     * Chromium picks its own image for a drag source, and when the source sits
     * inside a scroll container it can end up snapshotting the whole list — so
     * dragging one role looks like dragging everything. Setting an explicit
     * image keeps the feedback honest.
     */
    function _setRoleDragImage(e, el, maxHeight) {
        try {
            var rect = el.getBoundingClientRect();
            var img = el.cloneNode(true);
            img.classList.add('role-drag-image');
            img.style.width = rect.width + 'px';
            if (maxHeight) img.style.maxHeight = maxHeight + 'px';
            document.body.appendChild(img);
            e.dataTransfer.setDragImage(img, e.clientX - rect.left, e.clientY - rect.top);
            // The browser snapshots synchronously; drop the clone on the next tick.
            setTimeout(function () {
                if (img.parentNode) img.parentNode.removeChild(img);
            }, 0);
        } catch (_) { /* no setDragImage support — the default image is fine */ }
    }

    /** Desktop HTML5 drag source for a single role row. */
    function _wireRoleRowDrag(row, role, enabled) {
        if (!enabled || !canManage(role)) return;
        row.draggable = true;
        row.addEventListener('dragstart', function (e) {
            e.stopPropagation();
            e.dataTransfer.setData('text/role-id', role.id);
            e.dataTransfer.effectAllowed = 'move';
            _roleDragPayload = { roleId: role.id };
            _setRoleDragImage(e, row);
            row.classList.add('dragging');
            _setRoleDragging(true);
            _startRoleAutoScroll(row.closest('.roles-list'));
        });
        row.addEventListener('dragend', function () {
            row.classList.remove('dragging');
            _roleDragPayload = null;
            _setRoleDragging(false);
            _stopRoleAutoScroll();
            _clearRoleDropMarkers();
        });
        _wireRoleRowTouchDrag(row, role);
    }

    /**
     * Touch drag for phones: long-press to pick the row up, then the page stops
     * scrolling and a fixed ghost follows the finger. A small movement before
     * the long-press fires cancels the pick-up so normal scrolling still works.
     */
    function _wireRoleRowTouchDrag(row, role) {
        if (!('ontouchstart' in window)) return;
        var d = { timer: null, active: false, ghost: null, sx: 0, sy: 0, lx: 0, ly: 0 };
        function stop() {
            if (d.timer) { clearTimeout(d.timer); d.timer = null; }
            if (d.ghost && d.ghost.parentNode) d.ghost.parentNode.removeChild(d.ghost);
            d.ghost = null;
            d.active = false;
            row.classList.remove('dragging');
            _roleDragPayload = null;
            _setRoleDragging(false);
            _stopRoleAutoScroll();
            _clearRoleDropMarkers();
        }
        row.addEventListener('touchstart', function (e) {
            if (e.touches.length !== 1) return;
            var t = e.touches[0];
            d.sx = d.lx = t.clientX;
            d.sy = d.ly = t.clientY;
            d.timer = setTimeout(function () {
                d.timer = null;
                d.active = true;
                row.classList.add('dragging');
                _roleDragPayload = { roleId: role.id };
                _setRoleDragging(true);
                _startRoleAutoScroll(row.closest('.roles-list'));
                var ghost = row.cloneNode(true);
                ghost.classList.add('role-drag-ghost');
                ghost.style.left = (d.lx - 70) + 'px';
                ghost.style.top = (d.ly - 16) + 'px';
                document.body.appendChild(ghost);
                d.ghost = ghost;
                if (navigator.vibrate) { try { navigator.vibrate(20); } catch (_) {} }
            }, 320);
        }, { passive: true });
        row.addEventListener('touchmove', function (e) {
            var t = e.touches[0];
            if (!t) return;
            d.lx = t.clientX; d.ly = t.clientY;
            _roleAutoScroll.y = t.clientY;   // drives the auto-scroll loop
            if (!d.active) {
                if (d.timer && (Math.abs(t.clientX - d.sx) > 10 || Math.abs(t.clientY - d.sy) > 10)) {
                    clearTimeout(d.timer);
                    d.timer = null;
                }
                return;
            }
            e.preventDefault();
            if (d.ghost) {
                d.ghost.style.left = (t.clientX - 70) + 'px';
                d.ghost.style.top = (t.clientY - 16) + 'px';
                d.ghost.style.display = 'none';
            }
            var hit = document.elementFromPoint(t.clientX, t.clientY);
            if (d.ghost) d.ghost.style.display = '';
            var gap = hit && hit.closest ? hit.closest('.role-drop-gap') : null;
            var group = hit && hit.closest ? hit.closest('.role-tier-group[data-managed="1"]') : null;
            if (gap) _markRoleDrop(gap, 'active');
            else if (group) _markRoleDrop(group, 'join');
            else _clearRoleDropMarkers();
        }, { passive: false });
        row.addEventListener('touchend', function (e) {
            if (d.timer) { clearTimeout(d.timer); d.timer = null; }
            if (!d.active) return;
            var t = e.changedTouches[0];
            d.active = false;
            row.classList.remove('dragging');
            if (d.ghost && d.ghost.parentNode) d.ghost.parentNode.removeChild(d.ghost);
            d.ghost = null;
            _roleDragPayload = null;
            _setRoleDragging(false);
            _stopRoleAutoScroll();
            _clearRoleDropMarkers();
            if (!t) return;
            var hit = document.elementFromPoint(t.clientX, t.clientY);
            var gap = hit && hit.closest ? hit.closest('.role-drop-gap') : null;
            var group = hit && hit.closest ? hit.closest('.role-tier-group[data-managed="1"]') : null;
            _roleDragEndedAt = Date.now();
            if (gap) {
                if (gap.classList.contains('role-drop-gap-tail')) dropRolePayload({ roleId: role.id }, null, 'below');
                else dropRolePayload({ roleId: role.id }, parseInt(gap.dataset.tierPos, 10), 'above');
            } else if (group) {
                dropRolePayload({ roleId: role.id }, parseInt(group.dataset.tierPos, 10), 'join');
            }
        }, { passive: true });
        row.addEventListener('touchcancel', stop, { passive: true });
    }

    function renderRoleList() {
        var list = document.getElementById('roles-list');
        if (!list) return;
        list.innerHTML = '';
        if (state.roles.length === 0) {
            list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:6px 0">No roles</div>';
            var btn = document.getElementById('create-role-btn');
            if (btn) {
                var canCreate = (has(bit('CREATE_ROLES')) || has(bit('MANAGE_ROLES'))) && state.myPosition > 0;
                btn.style.display = canCreate ? '' : 'none';
            }
            return;
        }
        var canDrag = (has(bit('MANAGE_ROLES')) || state.isOwner);
        var tiers = buildTiers();
        // Owner tier 0 entry (if current user is the owner).
        if (state.isOwner) {
            var ownerRow = document.createElement('div');
            ownerRow.className = 'role-tier-group role-tier-owner';
            var owInner = document.createElement('div');
            owInner.className = 'role-row';
            owInner.innerHTML =
                '<span class="role-tier-badge" style="background:var(--accent);color:#fff">0</span>' +
                '<span class="role-dot" style="background:var(--accent)"></span>' +
                '<span class="role-row-name" style="font-weight:600">Owner</span>' +
                '<span class="role-badge" style="background:var(--accent);color:#fff;border-color:var(--accent)">you</span>';
            ownerRow.appendChild(owInner);
            list.appendChild(ownerRow);
        }
        // Tier boxes. A tier is the set of roles sharing a rank — a lone role
        // still gets its own outlined box. Drop zones mirror the server
        // grouping UX: top third = new tier above, bottom third = new tier
        // below, middle = join that tier.
        tiers.forEach(function (tier, tierIdx) {
            var tierManaged = tier.roles.length > 0 && canManage(tier.roles[0]);

            // Strip above the tier: drop here to create a NEW tier at this rank.
            if (canDrag && tierManaged) {
                var insert = document.createElement('div');
                insert.className = 'role-drop-gap';
                insert.dataset.tierPos = String(tier.pos);
                insert.innerHTML = '<span></span>';
                insert.addEventListener('dragover', function (e) {
                    if (!_isRoleDrag(e)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'move';
                    _markRoleDrop(insert, 'active');
                });
                insert.addEventListener('dragleave', function () {
                    DROP_MARKER_CLASSES.forEach(function (c) { insert.classList.remove(c); });
                });
                insert.addEventListener('drop', function (e) {
                    if (!_isRoleDrag(e)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    var payload = _readRoleDragPayload(e);
                    _clearRoleDropMarkers();
                    if (payload) dropRolePayload(payload, tier.pos, 'above');
                });
                list.appendChild(insert);
            }

            var group = document.createElement('div');
            group.className = 'role-tier-group';
            group.dataset.tierPos = String(tier.pos);
            group.dataset.tierIndex = String(tierIdx);
            group.dataset.managed = tierManaged ? '1' : '0';

            var lbl = document.createElement('div');
            lbl.className = 'role-tier-label';
            lbl.textContent = 'Tier ' + (tierIdx + 1);
            if (canDrag && tierManaged) {
                lbl.draggable = true;
                lbl.title = 'Drag to move the whole tier';
                lbl.addEventListener('dragstart', function (e) {
                    e.stopPropagation();
                    e.dataTransfer.setData('text/tier-pos', String(tier.pos));
                    e.dataTransfer.effectAllowed = 'move';
                    _roleDragPayload = { tierPos: tier.pos };
                    // Snapshot the whole tier (capped) so it is obvious that every
                    // role in it is moving together.
                    _setRoleDragImage(e, group, 150);
                    group.classList.add('dragging');
                    _startRoleAutoScroll(group.closest('.roles-list'));
                });
                lbl.addEventListener('dragend', function () {
                    group.classList.remove('dragging');
                    _roleDragPayload = null;
                    _setRoleDragging(false);
                    _stopRoleAutoScroll();
                    _clearRoleDropMarkers();
                });
            }
            group.appendChild(lbl);

            tier.roles.forEach(function (role) {
                var row = document.createElement('div');
                row.className = 'role-row' + (role.id === state.selectedRoleId ? ' selected' : '');
                row.dataset.roleId = role.id;
                row.dataset.tierPos = String(role.position);
                var color = role.color || '#99aab5';
                row.innerHTML =
                    '<span class="role-tier-badge">' + (tierIdx + 1) + '</span>' +
                    '<span class="role-dot" style="background:' + escapeAttr(color) + '"></span>' +
                    '<span class="role-row-name">' + escapeHtml(decryptRoleName(role)) + '</span>' +
                    (!canManage(role) ? '<span class="role-badge muted" title="Ranked at or above your role">locked</span>' : '');
                row.addEventListener('click', function () {
                    if (Date.now() - _roleDragEndedAt < 400) return;   // the tap that ended a drag
                    selectRole(role.id);
                });
                _wireRoleRowDrag(row, role, canDrag && tierManaged);
                group.appendChild(row);
            });

            // The tier box itself is the "join this tier" target.
            if (canDrag && tierManaged) {
                group.addEventListener('dragover', function (e) {
                    if (!_isRoleDrag(e)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'move';
                    _markRoleDrop(group, 'join');
                });
                group.addEventListener('dragleave', function (e) {
                    if (e.target === group) DROP_MARKER_CLASSES.forEach(function (c) { group.classList.remove(c); });
                });
                group.addEventListener('drop', function (e) {
                    if (!_isRoleDrag(e)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    var payload = _readRoleDragPayload(e);
                    _clearRoleDropMarkers();
                    if (payload) dropRolePayload(payload, tier.pos, 'join');
                });
            }
            list.appendChild(group);
        });

        // Trailing strip: dropping here creates the weakest tier.
        if (canDrag) {
            var tail = document.createElement('div');
            tail.className = 'role-drop-gap role-drop-gap-tail';
            tail.innerHTML = '<span></span>';
            tail.addEventListener('dragover', function (e) {
                if (!_isRoleDrag(e)) return;
                e.preventDefault();
                e.stopPropagation();
                _markRoleDrop(tail, 'active');
            });
            tail.addEventListener('dragleave', function () {
                DROP_MARKER_CLASSES.forEach(function (c) { tail.classList.remove(c); });
            });
            tail.addEventListener('drop', function (e) {
                if (!_isRoleDrag(e)) return;
                e.preventDefault();
                e.stopPropagation();
                var payload = _readRoleDragPayload(e);
                _clearRoleDropMarkers();
                if (payload) dropRolePayload(payload, null, 'below');
            });
            list.appendChild(tail);
        }

        // @everyone always sits at the very bottom, outside any tier box.
        var everyoneRole = null;
        state.roles.forEach(function (r) { if (r.is_everyone) everyoneRole = r; });
        if (everyoneRole) {
            var everyoneRow = document.createElement('div');
            everyoneRow.className = 'role-row role-everyone-row';
            everyoneRow.dataset.roleId = everyoneRole.id;
            everyoneRow.innerHTML =
                '<span class="role-tier-badge" style="visibility:hidden">-</span>' +
                '<span class="role-dot" style="background:#99aab5"></span>' +
                '<span class="role-row-name">@everyone</span>' +
                '<span class="role-badge">everyone</span>';
            everyoneRow.addEventListener('click', function () { selectRole(everyoneRole.id); });
            list.appendChild(everyoneRow);
        }
        var btn = document.getElementById('create-role-btn');
        if (btn) {
            var canCreate = (has(bit('CREATE_ROLES')) || has(bit('MANAGE_ROLES'))) && state.myPosition > 0;
            btn.style.display = canCreate ? '' : 'none';
            btn.title = canCreate ? '' : 'You need Create Roles (or Manage Roles) and a role ranked high enough';
        }
    }

    function selectRole(roleId) {
        state.selectedRoleId = roleId;
        state.overwriteTarget = null;
        renderRoleList();
        renderEditor();
    }

    function renderEditor() {
        var editor = document.getElementById('role-editor');
        if (!editor) return;
        var role = roleById(state.selectedRoleId);
        if (!role) { editor.style.display = 'none'; return; }
        editor.style.display = '';
        var editable = canManage(role) && (has(bit('EDIT_ROLES')) || has(bit('MANAGE_ROLES')));

        var nameInput = document.getElementById('role-name-input');
        var colorInput = document.getElementById('role-color-input');
        var master = document.getElementById('role-all-perms');
        nameInput.value = decryptRoleName(role);
        nameInput.disabled = !editable;
        colorInput.value = (role.color && /^#[0-9a-f]{6}$/i.test(role.color)) ? role.color : '#99aab5';
        colorInput.disabled = !editable || role.is_everyone;

        // Permission checkboxes, grouped by tier.
        var box = document.getElementById('role-perm-boxes');
        box.innerHTML = '';
        TIERS.forEach(function (tier) {
            var group = document.createElement('div');
            group.className = 'role-perm-group';
            group.innerHTML = '<div class="role-perm-tier">' + escapeHtml(tier.label) + '</div>';
            PERMS.filter(function (p) { return p.tier === tier.id; }).forEach(function (p) {
                var on = (role.permissions & p.bit) === p.bit;
                var label = document.createElement('label');
                label.className = 'role-perm-toggle';
                label.setAttribute('data-perm-key', p.key);
                label.innerHTML =
                    '<input type="checkbox" data-perm-bit="' + p.bit + '"' + (on ? ' checked' : '') + (editable ? '' : ' disabled') + '>' +
                    '<span class="role-perm-label" title="' + escapeAttr(p.desc) + '">' + escapeHtml(p.label) + '</span>';
                group.appendChild(label);
            });
            box.appendChild(group);
        });
        var total = parseInt(master.getAttribute('data-total') || '0', 10);
        if (master) {
            master.checked = total > 0 && role.permissions === total;
            master.disabled = !editable;
        }
        var del = document.getElementById('delete-role-btn');
        if (del) {
            del.style.display = (editable && !role.is_everyone) ? '' : 'none';
        }
        var save = document.getElementById('save-role-btn');
        if (save) save.style.display = editable ? '' : 'none';
        var cancel = document.getElementById('cancel-role-btn');
        if (cancel) cancel.style.display = '';

        renderOverwriteEditor(role, editable);
    }

    function renderOverwriteEditor(role, editable) {
        var sel = document.getElementById('role-overwrite-target');
        var box = document.getElementById('role-overwrite-boxes');
        if (!sel || !box) return;
        var channels = (window._serverChannelsForRoles || []);
        var categories = (window._serverCategoriesForRoles || []);
        var current = sel.value;
        sel.innerHTML = '<option value="" disabled selected hidden>— no override —</option>';
        if (categories.length) {
            var og = document.createElement('optgroup');
            og.label = 'Categories';
            categories.forEach(function (c) {
                var o = document.createElement('option');
                o.value = 'category:' + c.id;
                o.textContent = c.name || 'Category';
                og.appendChild(o);
            });
            sel.appendChild(og);
        }
        var og2 = document.createElement('optgroup');
        og2.label = 'Channels';
        channels.forEach(function (c) {
            var o = document.createElement('option');
            o.value = 'channel:' + c.id;
            o.textContent = (c.channel_type === 'voice' ? '\uD83D\uDD0A ' : '# ') + (c.name || 'channel');
            og2.appendChild(o);
        });
        sel.appendChild(og2);
        sel.disabled = !editable;
        if (current && sel.querySelector('option[value="' + current + '"]')) sel.value = current;

        var target = sel.value || state.overwriteTarget || '';
        state.overwriteTarget = target;
        var ow = null;
        if (target) {
            var parts = target.split(':');
            ow = (role.overwrites || []).filter(function (o) {
                return o.target_type === parts[0] && o.target_id === parts[1];
            })[0] || null;
        }
        box.innerHTML = '';
        PERMS.forEach(function (p) {
            var value = 'inherit';
            if (ow) {
                if (ow.deny & p.bit) value = 'deny';
                else if (ow.allow & p.bit) value = 'allow';
            }
            var row = document.createElement('div');
            row.className = 'role-ow-row';
            row.setAttribute('data-ow-key', p.key);
            row.innerHTML =
                '<span class="role-ow-label" title="' + escapeAttr(p.desc) + '">' + escapeHtml(p.label) + '</span>' +
                '<select data-ow-bit="' + p.bit + '"' + (editable ? '' : ' disabled') + '>' +
                '<option value="inherit"' + (value === 'inherit' ? ' selected' : '') + '>Inherit</option>' +
                '<option value="allow"' + (value === 'allow' ? ' selected' : '') + '>Allow</option>' +
                '<option value="deny"' + (value === 'deny' ? ' selected' : '') + '>Deny</option>' +
                '</select>';
            box.appendChild(row);
        });
        var hint = document.getElementById('role-overwrite-hint');
        if (hint) {
            hint.textContent = target
                ? 'Overrides apply to this ' + target.split(':')[0] + ' only. Deny always wins over Allow at the same level.'
                : 'Pick a category or channel to override this role\u2019s permissions for it.';
        }
        var saveOw = document.getElementById('save-role-overwrite-btn');
        var cancelOw = document.getElementById('cancel-role-overwrite-btn');
        if (saveOw) saveOw.style.display = (editable && target) ? '' : 'none';
        if (cancelOw) cancelOw.style.display = (editable && target) ? '' : 'none';
    }

    function readRolePerms() {
        var total = 0;
        document.querySelectorAll('#role-perm-boxes input[data-perm-bit]').forEach(function (cb) {
            if (cb.checked) total |= parseInt(cb.getAttribute('data-perm-bit'), 10);
        });
        return total;
    }

    function readOverwrite() {
        var allow = 0, deny = 0;
        document.querySelectorAll('#role-overwrite-boxes select[data-ow-bit]').forEach(function (s) {
            var b = parseInt(s.getAttribute('data-ow-bit'), 10);
            if (s.value === 'allow') allow |= b;
            else if (s.value === 'deny') deny |= b;
        });
        return { allow: allow, deny: deny };
    }

    /** Encrypt a role name with the server key, returning { encrypted_name, name_nonce } (base64). */
    function encryptRoleName(name, serverId) {
        try {
            var key = window.E2ECrypto && window.E2ECrypto.getServerKey(serverId || state.serverId);
            if (!key) return {};
            var enc = window.E2ECrypto.encryptMessage(name, key);
            return { encrypted_name: enc.ciphertext, name_nonce: enc.nonce };
        } catch (_) { return {}; }
    }

    /** Decrypt a role name if encrypted_name and name_nonce are present. */
    function decryptRoleName(role, serverId) {
        if (!role.encrypted_name || !role.name_nonce) return role.name;
        try {
            var key = window.E2ECrypto && window.E2ECrypto.getServerKey(serverId || state.serverId);
            if (!key) return role.name;
            var dec = window.E2ECrypto.decryptMessage(role.encrypted_name, role.name_nonce, key);
            return dec || role.name;
        } catch (_) { return role.name; }
    }

    async function saveRole() {
        var role = roleById(state.selectedRoleId);
        if (!role) return;
        var name = document.getElementById('role-name-input').value.trim();
        var color = document.getElementById('role-color-input').value;
        var perms = readRolePerms();
        var enc = encryptRoleName(name);
        var res = await api('/api/servers/' + state.serverId + '/roles/' + role.id, {
            method: 'PUT',
            body: JSON.stringify(Object.assign({ name: name, color: color, permissions: perms }, enc))
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) { alert(data.error || 'Failed to save role'); return; }
        state.selectedRoleId = null;
        await load(state.serverId);
        renderRoleList();
        renderEditor();
        if (typeof window.refreshMemberRoleCircles === 'function') window.refreshMemberRoleCircles();
    }

    async function saveOverwrite() {
        var role = roleById(state.selectedRoleId);
        var target = state.overwriteTarget;
        if (!role || !target) return;
        var parts = target.split(':');
        var bits = readOverwrite();
        var res = await api('/api/servers/' + state.serverId + '/roles/' + role.id + '/overwrite', {
            method: 'PUT',
            body: JSON.stringify({ target_type: parts[0], target_id: parts[1], allow: bits.allow, deny: bits.deny })
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) { alert(data.error || 'Failed to save override'); return; }
        await load(state.serverId);
        renderOverwriteEditor(roleById(state.selectedRoleId), true);
    }

    async function createRole() {
        var enc = encryptRoleName('New Role');
        // New roles start as their own tier below the weakest existing one.
        var minPos = Infinity;
        state.roles.forEach(function (r) {
            if (!r.is_everyone && r.position < minPos) minPos = r.position;
        });
        var newPos = isFinite(minPos) ? minPos - 10 : 10;
        var res = await api('/api/servers/' + state.serverId + '/roles', {
            method: 'POST',
            body: JSON.stringify(Object.assign({ name: 'New Role', color: '#4fc3f7', permissions: 0, position: newPos }, enc))
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) { alert(data.error || 'Failed to create role'); return; }
        await load(state.serverId);
        // Normalise positions (even spacing, no collisions with @everyone at 0).
        var updates = computeTierPositionUpdates(buildTiers());
        if (updates.length) {
            await api('/api/servers/' + state.serverId + '/roles/reorder', {
                method: 'PUT',
                body: JSON.stringify({ ordered_ids: updates })
            });
            await load(state.serverId);
        }
        selectRole(data.id);
    }

    async function deleteRole() {
        var role = roleById(state.selectedRoleId);
        if (!role || !confirm('Delete role "' + decryptRoleName(role) + '"? Members with it fall back to @everyone.')) return;
        var res = await api('/api/servers/' + state.serverId + '/roles/' + role.id, { method: 'DELETE' });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) { alert(data.error || 'Failed to delete role'); return; }
        state.selectedRoleId = null;
        await load(state.serverId);
        renderRoleList();
        renderEditor();
    }

    /**
     * Arrow buttons. UP/DOWN move the selected role one tier towards
     * stronger/weaker:
     *   - a role that shares its tier peels off into its own new tier, so it
     *     can be moved OUT of a tier;
     *   - a role that is alone in its tier merges into the neighbouring tier,
     *     so it can be moved INTO a tier.
     * Both directions therefore work without a modifier key.
     */
    async function moveRole(delta) {
        var role = roleById(state.selectedRoleId);
        if (!role || role.is_everyone || !canManage(role)) return;
        var tiers = buildTiers();
        var idx = tierIndexFor(tiers, role);
        if (idx < 0) return;

        var newTiers = cloneTiers(tiers);
        var shared = newTiers[idx].roles.length > 1;
        newTiers[idx].roles = newTiers[idx].roles.filter(function (r) { return r.id !== role.id; });
        var target = delta > 0 ? idx - 1 : idx + 1;   // towards stronger / weaker

        if (shared) {
            // Move OUT into its own tier, placed on the side we are heading.
            var insertAt = delta > 0 ? idx : idx + 1;
            newTiers.splice(insertAt, 0, { pos: null, roles: [role] });
        } else if (target >= 0 && target < newTiers.length) {
            // Move IN to the neighbouring tier. Never merge into a tier that
            // sits at or above our own rank — we could not manage it then.
            if (!canManage(newTiers[target].roles[0])) return;
            newTiers[target].roles.push(role);
        } else if (delta > 0) {
            newTiers.unshift({ pos: null, roles: [role] });   // new strongest tier
        } else {
            newTiers.push({ pos: null, roles: [role] });      // new weakest tier
        }
        await applyTiers(newTiers);
    }

    /** Temporary alias kept for any older callers. */
    async function moveRoleToPosition(roleId, targetPos) {
        await dropRolePayload({ roleId: roleId }, targetPos, 'join');
    }

    /** Batch reorder multiple roles at once. */
    async function batchReorderRolePositions(updates) {
        var res = await api('/api/servers/' + state.serverId + '/roles/reorder', {
            method: 'PUT',
            body: JSON.stringify({ ordered_ids: updates })
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) { alert(data.error || 'Failed to reorder roles'); return; }
        await load(state.serverId);
        renderRoleList();
        renderEditor();
    }

    /** Wire up the roles section inside the server-settings modal. */
    function initSettingsUI() {
        var master = document.getElementById('role-all-perms');
        if (master) {
            master.setAttribute('data-total', String(ALL_BITS));
            master.addEventListener('change', function () {
                var on = master.checked;
                document.querySelectorAll('#role-perm-boxes input[data-perm-bit]').forEach(function (cb) {
                    cb.checked = on;
                });
            });
        }
        var createBtn = document.getElementById('create-role-btn');
        if (createBtn) createBtn.addEventListener('click', createRole);
        var saveBtn = document.getElementById('save-role-btn');
        if (saveBtn) saveBtn.addEventListener('click', saveRole);
        var delBtn = document.getElementById('delete-role-btn');
        if (delBtn) delBtn.addEventListener('click', deleteRole);
        var cancelBtn = document.getElementById('cancel-role-btn');
        if (cancelBtn) cancelBtn.addEventListener('click', function () {
            state.selectedRoleId = null;
            state.overwriteTarget = null;
            renderRoleList();
            renderEditor();
        });
        var upBtn = document.getElementById('role-move-up');
        if (upBtn) upBtn.addEventListener('click', function () { moveRole(1); });
        var downBtn = document.getElementById('role-move-down');
        if (downBtn) downBtn.addEventListener('click', function () { moveRole(-1); });
        var target = document.getElementById('role-overwrite-target');
        if (target) {
            target.addEventListener('change', function () {
                state.overwriteTarget = target.value;
                renderOverwriteEditor(roleById(state.selectedRoleId), canManage(roleById(state.selectedRoleId)) && (has(bit('EDIT_ROLES')) || has(bit('MANAGE_ROLES'))));
            });
        }
        var saveOw = document.getElementById('save-role-overwrite-btn');
        if (saveOw) saveOw.addEventListener('click', saveOverwrite);
        var cancelOw = document.getElementById('cancel-role-overwrite-btn');
        if (cancelOw) cancelOw.addEventListener('click', function () {
            state.overwriteTarget = null;
            if (target) target.value = '';
            renderOverwriteEditor(roleById(state.selectedRoleId), canManage(roleById(state.selectedRoleId)) && has(bit('MANAGE_ROLES')));
        });
    }

    // ─── Assign role to a member ─────────────────────────────────────────

    /** Roles the current user may hand out (strictly below their own role). */
    function assignableRoles() {
        return state.roles.filter(function (r) {
            return !r.is_everyone && r.position < state.myPosition;
        });
    }

    async function assignRole(targetUserId, roleId) {
        var res = await api('/api/servers/' + state.serverId + '/member-role/' + targetUserId, {
            method: 'PUT',
            body: JSON.stringify({ role_id: roleId })
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) { alert(data.error || 'Failed to assign role'); return false; }
        return true;
    }

    /**
     * Right-click menu for a member: pick the member's single role. Hidden for
     * the owner, for yourself, and for members ranked at or above you.
     */
    function memberContextMenuItems(member) {
        if (!has(bit('MANAGE_ROLES')) || !member) return [];
        if (member.role === 'owner') return [];
        if (user && member.id === user.id) return [];
        if (!(state.myPosition > (member.role_position || 0))) return [];
        var items = [{ label: '\u2014 Role \u2014', disabled: true }];
        var roles = assignableRoles();
        if (roles.length === 0) return [];
        items.push({
            label: 'No role (@everyone)',
            action: function () { assignRole(member.id, null).then(function (ok) { if (ok) loadMembers(currentServerId); }); }
        });
        roles.forEach(function (r) {
            items.push({
                label: (state.myRoleId === r.id ? '\u2713 ' : '') + decryptRoleName(r),
                action: function () { assignRole(member.id, r.id).then(function (ok) { if (ok) loadMembers(currentServerId); }); }
            });
        });
        return items;
    }

    // ─── Channel/Category Permissions Modal ──────────────────────────
    // Standalone modal for editing role overwrites on a specific channel or
    // category, opened from the right-click context menu.

    function openChannelPermissionsModal(targetType, targetId, targetName) {
        if (!state.serverId) return;
        var modal = document.getElementById('channel-perm-modal');
        if (!modal) return;
        var titleEl = document.getElementById('channel-perm-modal-title');
        var roleSelect = document.getElementById('channel-perm-role-select');
        var boxes = document.getElementById('channel-perm-boxes');
        var hint = document.getElementById('channel-perm-hint');
        if (titleEl) titleEl.textContent = 'Edit Permissions — ' + (targetName || targetId);
        if (!roleSelect || !boxes) return;

        // Populate role dropdown
        roleSelect.innerHTML = '';
        state.roles.forEach(function (r) {
            var opt = document.createElement('option');
            opt.value = r.id;
            opt.textContent = decryptRoleName(r) + (r.is_everyone ? ' (@everyone)' : '') + (r.color ? ' ●' : '');
            opt.style.color = r.color || '';
            roleSelect.appendChild(opt);
        });

        function renderPermBoxes() {
            var roleId = roleSelect.value;
            var role = roleById(roleId);
            if (!role) { boxes.innerHTML = '<div style="color:var(--text-muted);padding:8px">No role selected</div>'; return; }
            var ow = null;
            if (role.overwrites) {
                ow = role.overwrites.filter(function (o) {
                    return o.target_type === targetType && o.target_id === targetId;
                })[0] || null;
            }
            boxes.innerHTML = '';
            TIERS.forEach(function (tier) {
                var group = document.createElement('div');
                group.style.marginBottom = '10px';
                group.innerHTML = '<div style="color:var(--text-muted);font-size:11px;font-weight:600;text-transform:uppercase;margin-bottom:4px;letter-spacing:0.5px">' + escapeHtml(tier.label) + '</div>';
                PERMS.filter(function (p) { return p.tier === tier.id; }).forEach(function (p) {
                    var value = 'inherit';
                    if (ow) {
                        if (ow.deny & p.bit) value = 'deny';
                        else if (ow.allow & p.bit) value = 'allow';
                    }
                    var row = document.createElement('div');
                    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:4px 6px;border-radius:4px;font-size:12px;color:var(--text-primary)';
                    row.innerHTML =
                        '<span title="' + escapeAttr(p.desc) + '">' + escapeHtml(p.label) + '</span>' +
                        '<select data-ow-bit="' + p.bit + '" style="background:var(--bg-tertiary,#2c2f33);color:var(--text-primary);border:1px solid var(--border-color,#333);border-radius:4px;padding:2px 4px;font-size:11px;min-width:80px">' +
                        '<option value="inherit"' + (value === 'inherit' ? ' selected' : '') + '>Inherit</option>' +
                        '<option value="allow"' + (value === 'allow' ? ' selected' : '') + '>Allow</option>' +
                        '<option value="deny"' + (value === 'deny' ? ' selected' : '') + '>Deny</option>' +
                        '</select>';
                    group.appendChild(row);
                });
                boxes.appendChild(group);
            });
            if (hint) hint.textContent = 'Overrides apply to this ' + targetType + ' only. Deny always wins over Allow at the same level.';
        }

        roleSelect.addEventListener('change', renderPermBoxes);
        renderPermBoxes();
        modal.style.display = 'flex';

        function closeModal() { modal.style.display = 'none'; }
        document.getElementById('channel-perm-modal-close').onclick = closeModal;
        document.getElementById('channel-perm-cancel').onclick = closeModal;
        // Close on Escape key
        function onEsc(e) { if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', onEsc); } }
        document.addEventListener('keydown', onEsc);
        // Close on backdrop click
        modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
        document.getElementById('channel-perm-save').onclick = async function () {
            var roleId = roleSelect.value;
            if (!roleId) return;
            var allow = 0, deny = 0;
            boxes.querySelectorAll('select[data-ow-bit]').forEach(function (s) {
                var b = parseInt(s.getAttribute('data-ow-bit'), 10);
                if (s.value === 'allow') allow |= b;
                else if (s.value === 'deny') deny |= b;
            });
            var res = await api('/api/servers/' + state.serverId + '/roles/' + roleId + '/overwrite', {
                method: 'PUT',
                body: JSON.stringify({ target_type: targetType, target_id: targetId, allow: allow, deny: deny })
            });
            var data = await res.json().catch(function () { return {}; });
            if (!res.ok) { alert(data.error || 'Failed to save permissions'); return; }
            await load(state.serverId);
            modal.style.display = 'none';
        };
    }

    window.openChannelPermissionsModal = openChannelPermissionsModal;

    window.ServerPerms = { PERMS: PERMS, bits: PERMS.reduce(function (o, p) { o[p.key] = p.bit; return o; }, {}), ALL: ALL_BITS };
    window.ServerRoles = {
        state: state,
        load: load,
        loadMyPermissions: loadMyPermissions,
        has: has,
        hasInChannel: hasInChannel,
        bit: bit,
        roleById: roleById,
        roleCircleHtml: roleCircleHtml,
        renderRoleList: renderRoleList,
        renderEditor: renderEditor,
        renderOverwriteEditor: renderOverwriteEditor,
        selectRole: selectRole,
        initSettingsUI: initSettingsUI,
        assignableRoles: assignableRoles,
        assignRole: assignRole,
        memberContextMenuItems: memberContextMenuItems,
        canManage: canManage
    };
})();
