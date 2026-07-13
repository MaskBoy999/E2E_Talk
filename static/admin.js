let pendingDeleteAction = null;
let rawData = { users: [], servers: [], channels: [], messages: [], serverKeys: [], serverMembers: [],
                bans: [], dmChannels: [], dmMessages: [], dmKeys: [], friendRequests: [],
                friendships: [], prekeyBundles: [], sessions: [], userPublicKeys: [] };

document.addEventListener('DOMContentLoaded', () => {
    // Always require password — no session persistence

    document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const password = document.getElementById('admin-password').value;
        const btn = document.getElementById('admin-login-btn');
        btn.disabled = true;
        btn.textContent = 'Connecting...';
        try {
            const res = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });
            const data = await res.json();
            if (!res.ok) {
                if (data.setup_required) {
                    showError('No admin password set. Enter a new password to set it.');
                    document.getElementById('admin-password').value = '';
                    document.getElementById('admin-password').placeholder = 'Choose a password';
                    document.getElementById('admin-login-subtitle').textContent = 'Set admin password (first time)';
                    btn.textContent = 'Set Password';
                    btn.disabled = false;
                    return;
                }
                showError(data.error || 'Wrong password');
                btn.disabled = false;
                btn.textContent = 'Access Panel';
                return;
            }
            if (data.setup_complete) {
                document.getElementById('admin-login-subtitle').textContent = 'Enter admin password';
                document.getElementById('admin-password').placeholder = 'Admin password';
                btn.textContent = 'Access Panel';
                document.getElementById('admin-password').value = '';
                showError('Password set! Now login with it.');
                document.getElementById('error-message').style.color = '#4caf50';
                btn.disabled = false;
                return;
            }
            showPanel();
            loadAllData();
        } catch (err) {
            showError('Server is not running');
            btn.disabled = false;
            btn.textContent = 'Access Panel';
        }
    });

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        });
    });

    document.getElementById('confirm-cancel').addEventListener('click', closeModal);
    document.getElementById('confirm-modal').addEventListener('click', (e) => {
        if (e.target === document.getElementById('confirm-modal')) closeModal();
    });
    document.getElementById('confirm-delete').addEventListener('click', executeDelete);

    document.getElementById('clear-all-btn').addEventListener('click', clearAll);
});

function showError(msg) {
    const errDiv = document.getElementById('error-message');
    errDiv.textContent = msg;
    errDiv.style.display = 'block';
    errDiv.style.color = '';
}

function showPanel() {
    document.getElementById('admin-login').style.display = 'none';
    document.getElementById('admin-panel').style.display = 'block';
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.substring(0, len) + '...' : str;
}

function openModal(title, message, warning, action) {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').innerHTML = message;
    document.getElementById('confirm-warning').textContent = warning || '';
    document.getElementById('cascade-stats').style.display = 'none';
    pendingDeleteAction = action;
    document.getElementById('confirm-modal').style.display = 'flex';
}

function closeModal() {
    pendingDeleteAction = null;
    document.getElementById('confirm-modal').style.display = 'none';
}

async function executeDelete() {
    if (!pendingDeleteAction) return;
    const btn = document.getElementById('confirm-delete');
    const btnText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Deleting...';
    try {
        await pendingDeleteAction();
        closeModal();
        await loadAllData();
    } catch (err) {
        alert('Delete failed: ' + err.message);
        closeModal();
    } finally {
        btn.disabled = false;
        btn.textContent = btnText;
    }
}

async function apiFetch(url, method) {
    const res = await fetch(url, { method: method || 'GET' });
    return res.json();
}

function renderTable(tbodyId, cols, rows, emptyMsg) {
    const tbody = document.getElementById(tbodyId);
    if (!rows || rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="' + cols + '" class="empty-state">' + (emptyMsg || 'No data') + '</td></tr>';
        return;
    }
    tbody.innerHTML = '';
    rows.forEach(row => {
        const tr = document.createElement('tr');
        tr.innerHTML = row;
        tbody.appendChild(tr);
    });
}

function updateCount(id, count, suffix) {
    document.getElementById(id).textContent = count + (suffix || ' records');
}

function statusBadge(status) {
    const cls = status === 'pending' ? 'status-pending' : status === 'accepted' ? 'status-accepted' : 'status-declined';
    return '<span class="status-badge ' + cls + '">' + escapeHtml(status) + '</span>';
}

function filterTab(tab) {
    const input = document.getElementById('search-' + tab);
    const q = input ? input.value.toLowerCase() : '';
    switch (tab) {
        case 'users': renderUsers(rawData.users.filter(u => !q || u.username.toLowerCase().includes(q) || u.id.toLowerCase().includes(q))); break;
        case 'servers': renderServers(rawData.servers.filter(s => !q || s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))); break;
        case 'channels': renderChannels(rawData.channels.filter(c => !q || c.name.toLowerCase().includes(q) || c.server_id.toLowerCase().includes(q))); break;
        case 'messages': renderMessages(rawData.messages.filter(m => !q || (m.sender_username || m.sender_id).toLowerCase().includes(q) || m.channel_id.toLowerCase().includes(q) || (m.timestamp || '').toLowerCase().includes(q))); break;
        case 'server-keys': renderServerKeys(rawData.serverKeys.filter(k => !q || k.server_name.toLowerCase().includes(q) || k.user_id.toLowerCase().includes(q) || String(k.version).includes(q))); break;
        case 'server-members': renderServerMembers(rawData.serverMembers.filter(m => !q || m.username.toLowerCase().includes(q) || m.user_id.toLowerCase().includes(q) || m.server_name.toLowerCase().includes(q))); break;
        case 'bans': renderBans(rawData.bans.filter(b => !q || b.server_name.toLowerCase().includes(q) || b.username.toLowerCase().includes(q) || b.server_id.toLowerCase().includes(q) || b.user_id.toLowerCase().includes(q))); break;
        case 'dm-channels': renderDmChannels(rawData.dmChannels.filter(c => !q || c.id.toLowerCase().includes(q))); break;
        case 'dm-messages': renderDmMessages(rawData.dmMessages.filter(m => !q || (m.sender_username || m.sender_id).toLowerCase().includes(q) || m.dm_channel_id.toLowerCase().includes(q) || (m.timestamp || '').toLowerCase().includes(q))); break;
        case 'dm-keys': renderDmKeys(rawData.dmKeys.filter(k => !q || k.dm_channel_id.toLowerCase().includes(q) || k.user_id.toLowerCase().includes(q))); break;
        case 'friend-requests': renderFriendRequests(rawData.friendRequests.filter(r => !q || r.from_username.toLowerCase().includes(q) || r.to_username.toLowerCase().includes(q) || r.status.toLowerCase().includes(q))); break;
        case 'friendships': renderFriendships(rawData.friendships.filter(f => !q || f.username_a.toLowerCase().includes(q) || f.username_b.toLowerCase().includes(q) || f.user_id_a.toLowerCase().includes(q) || f.user_id_b.toLowerCase().includes(q))); break;
        case 'prekey-bundles': renderPrekeyBundles(rawData.prekeyBundles.filter(p => !q || p.user_id.toLowerCase().includes(q))); break;
        case 'sessions': renderSessions(rawData.sessions.filter(s => !q || s.our_user_id.toLowerCase().includes(q) || s.their_user_id.toLowerCase().includes(q))); break;
        case 'user-keys': renderUserPublicKeys(rawData.userPublicKeys.filter(k => !q || k.user_id.toLowerCase().includes(q))); break;
    }
}

async function loadAllData() {
    await Promise.all([
        loadUsers(),
        loadServers(),
        loadChannels(),
        loadMessages(),
        loadServerKeys(),
        loadServerMembers(),
        loadBans(),
        loadDmChannels(),
        loadDmMessages(),
        loadDmKeys(),
        loadFriendRequests(),
        loadFriendships(),
        loadPrekeyBundles(),
        loadSessions(),
        loadUserPublicKeys(),
    ]);
}

// --- Users ---
async function loadUsers() {
    try {
        const users = await apiFetch('/api/admin/users');
        rawData.users = Array.isArray(users) ? users : [];
        renderUsers(rawData.users);
    } catch (err) {
        rawData.users = [];
        renderUsers([]);
    }
}

function renderUsers(users) {
    updateCount('users-count', users.length);
    renderTable('user-list', 3,
        users.map(u =>
            '<td>' + escapeHtml(u.username) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(u.id) + '">' + escapeHtml(truncate(u.id, 12)) + '</td>' +
            '<td><button class="btn-delete-sm" onclick="deleteUser(\'' + u.id + '\', \'' + escapeHtml(u.username) + '\')">Delete</button></td>'
        ),
        'No users'
    );
}

async function deleteUser(userId, username) {
    document.getElementById('confirm-title').textContent = 'Delete User: ' + username;
    document.getElementById('confirm-message').innerHTML =
        'Are you sure you want to delete <strong>' + escapeHtml(username) + '</strong>?';
    document.getElementById('confirm-warning').textContent = 'This will permanently remove their account and ALL associated data.';
    document.getElementById('cascade-stats').style.display = 'none';

    try {
        const stats = await apiFetch('/api/admin/users/' + userId + '/stats');
        const statsDiv = document.getElementById('cascade-stats');
        let html = 'This will cascade-delete: ';
        html += '<span class="stat">' + stats.messages + ' messages</span>';
        html += '<span class="stat">' + stats.memberships + ' memberships</span>';
        html += '<span class="stat">' + stats.server_keys + ' server keys</span>';
        if (stats.owned_servers > 0) {
            html += '<span class="stat"><strong>' + stats.owned_servers + ' owned servers (deleted!)</strong></span>';
        }
        statsDiv.innerHTML = html;
        statsDiv.style.display = 'block';
    } catch (e) {}

    document.getElementById('confirm-modal').style.display = 'flex';
    pendingDeleteAction = async () => {
        const res = await apiFetch('/api/admin/users/' + userId, 'DELETE');
        if (!res.ok && res.error) throw new Error(res.error);
    };
}

// --- Servers ---
async function loadServers() {
    try {
        const servers = await apiFetch('/api/admin/servers');
        rawData.servers = Array.isArray(servers) ? servers : [];
        renderServers(rawData.servers);
    } catch (err) {
        rawData.servers = [];
        renderServers([]);
    }
}

function renderServers(servers) {
    updateCount('servers-count', servers.length);
    renderTable('server-list', 4,
        servers.map(s =>
            '<td>' + escapeHtml(s.name) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(s.id) + '">' + escapeHtml(truncate(s.id, 12)) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(s.owner_id) + '">' + escapeHtml(truncate(s.owner_id, 12)) + '</td>' +
            '<td><button class="btn-delete-sm" onclick="deleteServer(\'' + s.id + '\', \'' + escapeHtml(s.name) + '\')">Delete</button></td>'
        ),
        'No servers'
    );
}

function deleteServer(serverId, name) {
    openModal(
        'Delete Server: ' + name,
        'Are you sure you want to delete server <strong>' + escapeHtml(name) + '</strong>?',
        'This will permanently delete all channels, messages, server keys, and memberships for this server.',
        async () => {
            const res = await apiFetch('/api/admin/servers/' + serverId, 'DELETE');
            if (!res.ok && res.error) throw new Error(res.error);
        }
    );
}

// --- Channels ---
async function loadChannels() {
    try {
        const channels = await apiFetch('/api/admin/channels');
        rawData.channels = Array.isArray(channels) ? channels : [];
        renderChannels(rawData.channels);
    } catch (err) {
        rawData.channels = [];
        renderChannels([]);
    }
}

function renderChannels(channels) {
    updateCount('channels-count', channels.length);
    renderTable('channel-list', 5,
        channels.map(c =>
            '<td>' + escapeHtml(c.name) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(c.id) + '">' + escapeHtml(truncate(c.id, 12)) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(c.server_id) + '">' + escapeHtml(truncate(c.server_id, 12)) + '</td>' +
            '<td>' + escapeHtml(c.type) + '</td>' +
            '<td><button class="btn-delete-sm" onclick="deleteChannel(\'' + c.id + '\', \'' + escapeHtml(c.name) + '\')">Delete</button></td>'
        ),
        'No channels'
    );
}

function deleteChannel(channelId, name) {
    openModal(
        'Delete Channel: #' + name,
        'Are you sure you want to delete channel <strong>#' + escapeHtml(name) + '</strong>?',
        'This will permanently delete all messages in this channel.',
        async () => {
            const res = await apiFetch('/api/admin/channels/' + channelId, 'DELETE');
            if (!res.ok && res.error) throw new Error(res.error);
        }
    );
}

// --- Messages ---
async function loadMessages() {
    try {
        const messages = await apiFetch('/api/admin/messages');
        rawData.messages = Array.isArray(messages) ? messages : [];
        renderMessages(rawData.messages);
    } catch (err) {
        rawData.messages = [];
        renderMessages([]);
    }
}

function renderMessages(messages) {
    updateCount('messages-count', messages.length, ' records (max 500)');
    renderTable('message-list', 5,
        messages.map(m =>
            '<td>' + escapeHtml(m.sender_username || m.sender_id) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(m.channel_id) + '">' + escapeHtml(truncate(m.channel_id, 12)) + '</td>' +
            '<td class="blob-cell" title="Click to expand">' + escapeHtml(truncate(m.encrypted_content, 60)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.nonce, 30)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(m.timestamp) + '</td>'
        ),
        'No messages'
    );
}

// --- Server Keys ---
async function loadServerKeys() {
    try {
        const keys = await apiFetch('/api/admin/server-keys');
        rawData.serverKeys = Array.isArray(keys) ? keys : [];
        renderServerKeys(rawData.serverKeys);
    } catch (err) {
        rawData.serverKeys = [];
        renderServerKeys([]);
    }
}

function renderServerKeys(keys) {
    updateCount('server-keys-count', keys.length);
    renderTable('server-key-list', 6,
        keys.map(k =>
            '<td>' + escapeHtml(k.server_name) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(k.user_id) + '">' + escapeHtml(truncate(k.user_id, 12)) + '</td>' +
            '<td class="blob-cell" title="Click to expand">' + escapeHtml(truncate(k.encrypted_key, 40)) + '</td>' +
            '<td class="blob-cell" title="Click to expand">' + escapeHtml(truncate(k.sender_public_key, 40)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(k.nonce, 30)) + '</td>' +
            '<td>' + k.version + '</td>'
        ),
        'No server keys'
    );
}

// --- Server Members ---
async function loadServerMembers() {
    try {
        const members = await apiFetch('/api/admin/server-members');
        rawData.serverMembers = Array.isArray(members) ? members : [];
        renderServerMembers(rawData.serverMembers);
    } catch (err) {
        rawData.serverMembers = [];
        renderServerMembers([]);
    }
}

function renderServerMembers(members) {
    updateCount('server-members-count', members.length);
    renderTable('server-member-list', 4,
        members.map(m =>
            '<td>' + escapeHtml(m.username) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(m.user_id) + '">' + escapeHtml(truncate(m.user_id, 12)) + '</td>' +
            '<td>' + escapeHtml(m.server_name) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(m.server_id) + '">' + escapeHtml(truncate(m.server_id, 12)) + '</td>'
        ),
        'No members'
    );
}

// --- Bans ---
async function loadBans() {
    try {
        const bans = await apiFetch('/api/admin/bans');
        rawData.bans = Array.isArray(bans) ? bans : [];
        renderBans(rawData.bans);
    } catch (err) {
        rawData.bans = [];
        renderBans([]);
    }
}

function renderBans(bans) {
    updateCount('bans-count', bans.length);
    renderTable('ban-list', 6,
        bans.map(b =>
            '<td>' + escapeHtml(b.server_name) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(b.server_id) + '">' + escapeHtml(truncate(b.server_id, 12)) + '</td>' +
            '<td>' + escapeHtml(b.username) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(b.user_id) + '">' + escapeHtml(truncate(b.user_id, 12)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(b.banned_at) + '</td>' +
            '<td><button class="btn-delete-sm" onclick="adminDeleteBan(\'' + b.server_id + '\', \'' + b.user_id + '\')">Del</button></td>'
        ),
        'No bans'
    );
}

function adminDeleteBan(serverId, userId) {
    openModal('Delete Ban', 'Remove this ban? User will be able to rejoin with invite.', '',
        async () => {
            const res = await fetch('/api/admin/bans/' + serverId + '/' + userId, { method: 'DELETE' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Delete failed');
        }
    );
}

// --- DM Channels ---
async function loadDmChannels() {
    try {
        const channels = await apiFetch('/api/admin/dm-channels');
        rawData.dmChannels = Array.isArray(channels) ? channels : [];
        renderDmChannels(rawData.dmChannels);
    } catch (err) {
        rawData.dmChannels = [];
        renderDmChannels([]);
    }
}

function renderDmChannels(channels) {
    updateCount('dm-channels-count', channels.length);
    renderTable('dm-channel-list', 3,
        channels.map(c =>
            '<td class="id-cell" title="' + escapeHtml(c.id) + '">' + escapeHtml(truncate(c.id, 16)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(c.created_at) + '</td>' +
            '<td><button class="btn-delete-sm" onclick="adminDeleteDmChannel(\'' + c.id + '\')">Del</button></td>'
        ),
        'No DM channels'
    );
}

function adminDeleteDmChannel(channelId) {
    openModal('Delete DM Channel', 'Delete this DM channel and all its messages/keys?', 'This cannot be undone.',
        async () => {
            const res = await fetch('/api/admin/dm-channels/' + channelId, { method: 'DELETE' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Delete failed');
        }
    );
}

// --- DM Messages ---
async function loadDmMessages() {
    try {
        const msgs = await apiFetch('/api/admin/dm-messages');
        rawData.dmMessages = Array.isArray(msgs) ? msgs : [];
        renderDmMessages(rawData.dmMessages);
    } catch (err) {
        rawData.dmMessages = [];
        renderDmMessages([]);
    }
}

function renderDmMessages(msgs) {
    updateCount('dm-messages-count', msgs.length, ' records (max 500)');
    renderTable('dm-message-list', 6,
        msgs.map(m =>
            '<td>' + escapeHtml(m.sender_username || m.sender_id) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(m.dm_channel_id) + '">' + escapeHtml(truncate(m.dm_channel_id, 12)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.encrypted_content, 60)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.nonce, 30)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(m.timestamp) + '</td>' +
            '<td><button class="btn-delete-sm" onclick="adminDeleteDmMessage(\'' + m.id + '\')">Del</button></td>'
        ),
        'No DM messages'
    );
}

function adminDeleteDmMessage(msgId) {
    openModal('Delete DM Message', 'Delete this DM message?', 'This cannot be undone.',
        async () => {
            const res = await fetch('/api/admin/dm-messages/' + msgId, { method: 'DELETE' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Delete failed');
        }
    );
}

// --- DM Keys ---
async function loadDmKeys() {
    try {
        const keys = await apiFetch('/api/admin/dm-keys');
        rawData.dmKeys = Array.isArray(keys) ? keys : [];
        renderDmKeys(rawData.dmKeys);
    } catch (err) {
        rawData.dmKeys = [];
        renderDmKeys([]);
    }
}

function renderDmKeys(keys) {
    updateCount('dm-keys-count', keys.length);
    renderTable('dm-key-list', 6,
        keys.map(k =>
            '<td class="id-cell" title="' + escapeHtml(k.dm_channel_id) + '">' + escapeHtml(truncate(k.dm_channel_id, 12)) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(k.user_id) + '">' + escapeHtml(truncate(k.user_id, 12)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(k.encrypted_key, 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(k.sender_public_key, 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(k.nonce, 20)) + '</td>' +
            '<td><button class="btn-delete-sm" onclick="adminDeleteDmKey(\'' + k.dm_channel_id + '\', \'' + k.user_id + '\')">Del</button></td>'
        ),
        'No DM keys'
    );
}

function adminDeleteDmKey(dmChannelId, userId) {
    openModal('Delete DM Key', 'Delete this DM key entry?', 'This cannot be undone.',
        async () => {
            const res = await fetch('/api/admin/dm-keys/' + dmChannelId + '/' + userId, { method: 'DELETE' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Delete failed');
        }
    );
}

// --- Friend Requests ---
async function loadFriendRequests() {
    try {
        const reqs = await apiFetch('/api/admin/friend-requests');
        rawData.friendRequests = Array.isArray(reqs) ? reqs : [];
        renderFriendRequests(rawData.friendRequests);
    } catch (err) {
        rawData.friendRequests = [];
        renderFriendRequests([]);
    }
}

function renderFriendRequests(reqs) {
    updateCount('friend-requests-count', reqs.length);
    renderTable('friend-request-list', 7,
        reqs.map(r =>
            '<td>' + escapeHtml(r.from_username) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(r.from_user_id) + '">' + escapeHtml(truncate(r.from_user_id, 10)) + '</td>' +
            '<td>' + escapeHtml(r.to_username) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(r.to_user_id) + '">' + escapeHtml(truncate(r.to_user_id, 10)) + '</td>' +
            '<td>' + statusBadge(r.status) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at) + '</td>' +
            '<td><button class="btn-delete-sm" onclick="adminDeleteFriendRequest(\'' + r.id + '\')">Del</button></td>'
        ),
        'No friend requests'
    );
}

function adminDeleteFriendRequest(reqId) {
    openModal('Delete Friend Request', 'Delete this friend request entry?', '',
        async () => {
            const res = await fetch('/api/admin/friend-requests/' + reqId, { method: 'DELETE' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Delete failed');
        }
    );
}

// --- Friendships ---
async function loadFriendships() {
    try {
        const friends = await apiFetch('/api/admin/friendships');
        rawData.friendships = Array.isArray(friends) ? friends : [];
        renderFriendships(rawData.friendships);
    } catch (err) {
        rawData.friendships = [];
        renderFriendships([]);
    }
}

function renderFriendships(friends) {
    updateCount('friendships-count', friends.length);
    renderTable('friendship-list', 6,
        friends.map(f =>
            '<td>' + escapeHtml(f.username_a) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(f.user_id_a) + '">' + escapeHtml(truncate(f.user_id_a, 10)) + '</td>' +
            '<td>' + escapeHtml(f.username_b) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(f.user_id_b) + '">' + escapeHtml(truncate(f.user_id_b, 10)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(f.created_at) + '</td>' +
            '<td><button class="btn-delete-sm" onclick="adminDeleteFriendship(\'' + f.user_id_a + '\', \'' + f.user_id_b + '\')">Del</button></td>'
        ),
        'No friendships'
    );
}

function adminDeleteFriendship(userIdA, userIdB) {
    openModal('Delete Friendship', 'Remove this friendship link?', '',
        async () => {
            const res = await fetch('/api/admin/friendships/' + userIdA + '/' + userIdB, { method: 'DELETE' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Delete failed');
        }
    );
}

// --- Prekey Bundles ---
async function loadPrekeyBundles() {
    try {
        const bundles = await apiFetch('/api/admin/prekey-bundles');
        rawData.prekeyBundles = Array.isArray(bundles) ? bundles : [];
        renderPrekeyBundles(rawData.prekeyBundles);
    } catch (err) {
        rawData.prekeyBundles = [];
        renderPrekeyBundles([]);
    }
}

function renderPrekeyBundles(bundles) {
    updateCount('prekey-bundles-count', bundles.length);
    renderTable('prekey-bundle-list', 7,
        bundles.map(b =>
            '<td class="id-cell" title="' + escapeHtml(b.user_id) + '">' + escapeHtml(truncate(b.user_id, 10)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(b.identity_key_public, 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(b.signed_prekey_public, 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(b.signed_prekey_signature, 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(b.one_time_prekey_public || '', 20)) + '</td>' +
            '<td>' + (b.one_time_prekey_id !== null && b.one_time_prekey_id !== undefined ? b.one_time_prekey_id : '-') + '</td>' +
            '<td><button class="btn-delete-sm" onclick="adminDeletePrekeyBundle(\'' + b.user_id + '\')">Del</button></td>'
        ),
        'No prekey bundles'
    );
}

function adminDeletePrekeyBundle(userId) {
    openModal('Delete Prekey Bundle', 'Delete prekey bundle for this user?', 'They will need to re-upload.',
        async () => {
            const res = await fetch('/api/admin/prekey-bundles/' + userId, { method: 'DELETE' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Delete failed');
        }
    );
}

// --- Sessions ---
async function loadSessions() {
    try {
        const sessions = await apiFetch('/api/admin/sessions');
        rawData.sessions = Array.isArray(sessions) ? sessions : [];
        renderSessions(rawData.sessions);
    } catch (err) {
        rawData.sessions = [];
        renderSessions([]);
    }
}

function renderSessions(sessions) {
    updateCount('sessions-count', sessions.length);
    renderTable('session-list', 4,
        sessions.map(s =>
            '<td class="id-cell" title="' + escapeHtml(s.our_user_id) + '">' + escapeHtml(truncate(s.our_user_id, 12)) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(s.their_user_id) + '">' + escapeHtml(truncate(s.their_user_id, 12)) + '</td>' +
            '<td>' + s.ratchet_counter + '</td>' +
            '<td><button class="btn-delete-sm" onclick="adminDeleteSession(\'' + s.our_user_id + '\', \'' + s.their_user_id + '\')">Del</button></td>'
        ),
        'No sessions'
    );
}

function adminDeleteSession(ourId, theirId) {
    openModal('Delete Session', 'Delete this Signal session?', 'May disrupt E2EE until re-keying.',
        async () => {
            const res = await fetch('/api/admin/sessions/' + ourId + '/' + theirId, { method: 'DELETE' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Delete failed');
        }
    );
}

// --- User Public Keys (multi-device) ---
async function loadUserPublicKeys() {
    try {
        const keys = await apiFetch('/api/admin/user-keys');
        rawData.userPublicKeys = Array.isArray(keys) ? keys : [];
        renderUserPublicKeys(rawData.userPublicKeys);
    } catch (err) {
        rawData.userPublicKeys = [];
        renderUserPublicKeys([]);
    }
}

function renderUserPublicKeys(keys) {
    updateCount('user-keys-count', keys.length);
    renderTable('user-key-list', 5,
        keys.map(k =>
            '<td class="id-cell" title="' + escapeHtml(k.id) + '">' + escapeHtml(truncate(k.id, 10)) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(k.user_id) + '">' + escapeHtml(truncate(k.user_id, 12)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(k.public_key, 40)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(k.created_at) + '</td>' +
            '<td><button class="btn-delete-sm" onclick="adminDeleteUserPublicKey(\'' + k.id + '\')">Del</button></td>'
        ),
        'No user public keys'
    );
}

function adminDeleteUserPublicKey(keyId) {
    openModal('Delete Device Key', 'Delete this device public key?', 'The device may need to re-link.',
        async () => {
            const res = await fetch('/api/admin/user-keys/' + keyId, { method: 'DELETE' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Delete failed');
        }
    );
}

async function clearAll() {
    if (!confirm('Are you sure you want to delete ALL data?')) return;
    if (!confirm('This will permanently remove all users, servers, channels, messages, and keys. This cannot be undone. Continue?')) return;
    try {
        const res = await fetch('/api/admin/clear', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Clear failed');
        await loadAllData();
    } catch (err) {
        alert('Clear failed: ' + err.message);
    }
}
