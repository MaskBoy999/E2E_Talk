// chat-muted.js — Muted servers, channels, and DMs state management
// Extracted from chat.js as part of module split.
// Must be loaded BEFORE chat.js since chat.js references these functions.

// Muted servers, channels, and DMs (IDs stored in localStorage as JSON arrays)
var mutedServers = [];
var mutedChannels = [];
var mutedDms = [];

function loadMutedState() {
    try {
        var s = localStorage.getItem('muted_servers');
        mutedServers = s ? JSON.parse(s) : [];
        var c = localStorage.getItem('muted_channels');
        mutedChannels = c ? JSON.parse(c) : [];
        var d = localStorage.getItem('muted_dms');
        mutedDms = d ? JSON.parse(d) : [];
    } catch (e) {
        mutedServers = [];
        mutedChannels = [];
        mutedDms = [];
    }
}

function saveMutedState() {
    try {
        localStorage.setItem('muted_servers', JSON.stringify(mutedServers));
        localStorage.setItem('muted_channels', JSON.stringify(mutedChannels));
        localStorage.setItem('muted_dms', JSON.stringify(mutedDms));
    } catch (e) {}
    renderMutedList();
}

function renderMutedList() {
    var container = document.getElementById('muted-list');
    if (!container) return;
    var html = '';
    mutedServers.forEach(function (sid) {
        var sv = servers.find(function (s) { return s.id === sid; });
        var name = sv ? (sv.displayName || '[encrypted]') : sid.slice(0, 8);
        html += '<div class="muted-list-item"><span><svg class="ui-icon" width="14" height="14"><use href="#icon-volume-off"/></svg> Server: ' + escapeHtml(name) + '</span><button class="unmute-btn" data-type="server" data-id="' + sid + '">Unmute</button></div>';
    });
    mutedChannels.forEach(function (cid) {
        var chEl = document.querySelector('.channel-item[data-id="' + cid + '"]');
        var name = chEl ? chEl.dataset.name : cid.slice(0, 8);
        html += '<div class="muted-list-item"><span><svg class="ui-icon" width="14" height="14"><use href="#icon-volume-off"/></svg> Channel: #' + escapeHtml(name) + '</span><button class="unmute-btn" data-type="channel" data-id="' + cid + '">Unmute</button></div>';
    });
    mutedDms.forEach(function (did) {
        var dmConv = dmConversations.find(function (c) { return c.dm_channel_id === did; });
        var _cCache = dmConv ? userDisplayNameCache[dmConv.other_user_id] : null;
        var name = dmConv ? ((_cCache && _cCache.display_name) || dmConv.other_display_name || dmConv.other_username) : did.slice(0, 8);
        html += '<div class="muted-list-item"><span><svg class="ui-icon" width="14" height="14"><use href="#icon-volume-off"/></svg> DM: ' + escapeHtml(name) + '</span><button class="unmute-btn" data-type="dm" data-id="' + escapeAttr(did) + '">Unmute</button></div>';
    });
    if (!html) {
        container.innerHTML = '<div class="muted-empty">No muted servers or channels</div>';
    } else {
        container.innerHTML = html;
        container.querySelectorAll('.unmute-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var type = btn.dataset.type;
                var id = btn.dataset.id;
                if (type === 'server') toggleMuteServer(id);
                else if (type === 'channel') toggleMuteChannel(id, null);
                else if (type === 'dm') toggleMuteDm(id);
            });
        });
    }
}

function isMuted(serverId, channelId) {
    if (serverId && mutedServers.indexOf(serverId) !== -1) return true;
    if (channelId && mutedChannels.indexOf(channelId) !== -1) return true;
    return false;
}

function isDmMuted(dmChannelId) {
    return dmChannelId && mutedDms.indexOf(dmChannelId) !== -1;
}

function isUserMuted(userId) {
    if (!userId || mutedDms.length === 0 || !dmConversations) return false;
    for (var i = 0; i < dmConversations.length; i++) {
        var conv = dmConversations[i];
        if (conv && conv.other_user_id === userId && mutedDms.indexOf(conv.dm_channel_id) !== -1) {
            return true;
        }
    }
    return false;
}

function toggleMuteChannel(channelId) {
    var idx = mutedChannels.indexOf(channelId);
    if (idx !== -1) { mutedChannels.splice(idx, 1); }
    else { mutedChannels.push(channelId); }
    saveMutedState();
    updateChannelMutedUI();
}

function toggleMuteServer(serverId) {
    var idx = mutedServers.indexOf(serverId);
    if (idx !== -1) { mutedServers.splice(idx, 1); }
    else { mutedServers.push(serverId); }
    saveMutedState();
    updateServerMutedUI();
    updateChannelMutedUI();
}

function toggleMuteDm(dmChannelId) {
    var idx = mutedDms.indexOf(dmChannelId);
    if (idx !== -1) { mutedDms.splice(idx, 1); }
    else { mutedDms.push(dmChannelId); }
    saveMutedState();
    updateDmMutedUI();
}

function updateChannelMutedUI() {
    document.querySelectorAll('.channel-item').forEach(function (el) {
        var cid = el.dataset.id;
        if (mutedChannels.indexOf(cid) !== -1) { el.classList.add('muted'); }
        else { el.classList.remove('muted'); }
    });
}

function updateDmMutedUI() {
    document.querySelectorAll('.dm-item').forEach(function (el) {
        var did = el.dataset.dmId;
        if (did && mutedDms.indexOf(did) !== -1) { el.classList.add('muted'); }
        else { el.classList.remove('muted'); }
    });
}

function updateServerMutedUI() {
    document.querySelectorAll('.server-icon').forEach(function (el) {
        var sid = el.dataset.id;
        if (mutedServers.indexOf(sid) !== -1) { el.classList.add('muted'); }
        else { el.classList.remove('muted'); }
    });
}
