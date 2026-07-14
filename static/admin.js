let pendingDeleteAction = null;
let rawData = {
    users: [], servers: [], channels: [], messages: [], serverKeys: [], serverMembers: [],
    prekeyBundles: [], sessions: [], serverBans: [], dmChannels: [], dmMembers: [],
    dmMessages: [], dmKeys: [], friendRequests: [], friendships: [], userPublicKeys: [], files: []
};

document.addEventListener('DOMContentLoaded', () => {
    if (sessionStorage.getItem('admin_auth')) {
        showPanel();
        loadAllData();
    }

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
            sessionStorage.setItem('admin_auth', 'true');
            sessionStorage.setItem('admin_token', data.token || '');
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

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        const name = btn.dataset.name;
        if (action === 'delete-user') deleteUser(id, name);
        else if (action === 'delete-server') deleteServer(id, name);
        else if (action === 'delete-channel') deleteChannel(id, name);
    });
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
    const adminToken = sessionStorage.getItem('admin_token') || '';
    const res = await fetch(url, {
        method: method || 'GET',
        headers: adminToken ? { 'Authorization': 'Bearer ' + adminToken } : {}
    });
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

// --- Search/Filter ---
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
        case 'prekey-bundles': renderPrekeyBundles(rawData.prekeyBundles.filter(k => !q || k.user_id.toLowerCase().includes(q))); break;
        case 'sessions': renderSessions(rawData.sessions.filter(s => !q || s.our_username.toLowerCase().includes(q) || s.our_user_id.toLowerCase().includes(q) || s.their_username.toLowerCase().includes(q) || s.their_user_id.toLowerCase().includes(q))); break;
        case 'server-bans': renderServerBans(rawData.serverBans.filter(b => !q || b.server_name.toLowerCase().includes(q) || b.username.toLowerCase().includes(q) || (b.reason || '').toLowerCase().includes(q))); break;
        case 'dm-channels': renderDmChannels(rawData.dmChannels.filter(c => !q || c.id.toLowerCase().includes(q))); break;
        case 'dm-members': renderDmMembers(rawData.dmMembers.filter(m => !q || m.username.toLowerCase().includes(q) || m.user_id.toLowerCase().includes(q) || m.dm_channel_id.toLowerCase().includes(q))); break;
        case 'dm-messages': renderDmMessages(rawData.dmMessages.filter(m => !q || (m.sender_username || m.sender_id).toLowerCase().includes(q) || m.dm_channel_id.toLowerCase().includes(q) || (m.timestamp || '').toLowerCase().includes(q))); break;
        case 'dm-keys': renderDmKeys(rawData.dmKeys.filter(k => !q || k.username.toLowerCase().includes(q) || k.user_id.toLowerCase().includes(q) || k.dm_channel_id.toLowerCase().includes(q))); break;
        case 'friend-requests': renderFriendRequests(rawData.friendRequests.filter(r => !q || r.from_username.toLowerCase().includes(q) || r.to_username.toLowerCase().includes(q) || r.status.toLowerCase().includes(q))); break;
        case 'friendships': renderFriendships(rawData.friendships.filter(f => !q || f.username_1.toLowerCase().includes(q) || f.username_2.toLowerCase().includes(q))); break;
        case 'user-public-keys': renderUserPublicKeys(rawData.userPublicKeys.filter(k => !q || k.username.toLowerCase().includes(q) || k.user_id.toLowerCase().includes(q) || k.device_id.toLowerCase().includes(q))); break;
        case 'files': renderFiles(rawData.files.filter(f => !q || f.original_name.toLowerCase().includes(q) || f.uploader_username.toLowerCase().includes(q) || f.mime_type.toLowerCase().includes(q))); break;
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
        loadPrekeyBundles(),
        loadSessions(),
        loadServerBans(),
        loadDmChannels(),
        loadDmMembers(),
        loadDmMessages(),
        loadDmKeys(),
        loadFriendRequests(),
        loadFriendships(),
        loadUserPublicKeys(),
        loadFiles(),
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
            '<td><button class="btn-delete-sm" data-action="delete-user" data-id="' + escapeHtml(u.id) + '" data-name="' + escapeHtml(u.username) + '">Delete</button></td>'
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

    document.getElementById('confirm-modal').style.display = 'flex';

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
            '<td><button class="btn-delete-sm" data-action="delete-server" data-id="' + escapeHtml(s.id) + '" data-name="' + escapeHtml(s.name) + '">Delete</button></td>'
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
            '<td><button class="btn-delete-sm" data-action="delete-channel" data-id="' + escapeHtml(c.id) + '" data-name="' + escapeHtml(c.name) + '">Delete</button></td>'
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

// --- Prekey Bundles ---
async function loadPrekeyBundles() {
    try {
        const rows = await apiFetch('/api/admin/prekey-bundles');
        rawData.prekeyBundles = Array.isArray(rows) ? rows : [];
        renderPrekeyBundles(rawData.prekeyBundles);
    } catch (err) {
        rawData.prekeyBundles = [];
        renderPrekeyBundles([]);
    }
}
function renderPrekeyBundles(rows) {
    updateCount('prekey-bundles-count', rows.length);
    renderTable('prekey-bundle-list', 6,
        rows.map(r =>
            '<td class="id-cell" title="' + escapeHtml(r.user_id) + '">' + escapeHtml(truncate(r.user_id, 12)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.identity_key_public, 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.signed_prekey_public, 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.signed_prekey_signature, 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.one_time_prekey_public || '', 30)) + '</td>' +
            '<td>' + (r.one_time_prekey_id || '') + '</td>'
        ),
        'No prekey bundles'
    );
}

// --- Sessions ---
async function loadSessions() {
    try {
        const rows = await apiFetch('/api/admin/sessions');
        rawData.sessions = Array.isArray(rows) ? rows : [];
        renderSessions(rawData.sessions);
    } catch (err) {
        rawData.sessions = [];
        renderSessions([]);
    }
}
function renderSessions(rows) {
    updateCount('sessions-count', rows.length);
    renderTable('session-list', 4,
        rows.map(r =>
            '<td>' + escapeHtml(r.our_username) + ' <span class="id-cell" title="' + escapeHtml(r.our_user_id) + '">(' + escapeHtml(truncate(r.our_user_id, 8)) + ')</span></td>' +
            '<td>' + escapeHtml(r.their_username) + ' <span class="id-cell" title="' + escapeHtml(r.their_user_id) + '">(' + escapeHtml(truncate(r.their_user_id, 8)) + ')</span></td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.session_data, 40)) + '</td>' +
            '<td>' + r.ratchet_counter + '</td>'
        ),
        'No sessions'
    );
}

// --- Server Bans ---
async function loadServerBans() {
    try {
        const rows = await apiFetch('/api/admin/server-bans');
        rawData.serverBans = Array.isArray(rows) ? rows : [];
        renderServerBans(rawData.serverBans);
    } catch (err) {
        rawData.serverBans = [];
        renderServerBans([]);
    }
}
function renderServerBans(rows) {
    updateCount('server-bans-count', rows.length);
    renderTable('server-ban-list', 4,
        rows.map(r =>
            '<td>' + escapeHtml(r.server_name) + '</td>' +
            '<td>' + escapeHtml(r.username) + '</td>' +
            '<td>' + escapeHtml(r.reason || '') + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at) + '</td>'
        ),
        'No server bans'
    );
}

// --- DM Channels ---
async function loadDmChannels() {
    try {
        const rows = await apiFetch('/api/admin/dm-channels');
        rawData.dmChannels = Array.isArray(rows) ? rows : [];
        renderDmChannels(rawData.dmChannels);
    } catch (err) {
        rawData.dmChannels = [];
        renderDmChannels([]);
    }
}
function renderDmChannels(rows) {
    updateCount('dm-channels-count', rows.length);
    renderTable('dm-channel-list', 2,
        rows.map(r =>
            '<td class="id-cell" title="' + escapeHtml(r.id) + '">' + escapeHtml(truncate(r.id, 16)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at) + '</td>'
        ),
        'No DM channels'
    );
}

// --- DM Members ---
async function loadDmMembers() {
    try {
        const rows = await apiFetch('/api/admin/dm-members');
        rawData.dmMembers = Array.isArray(rows) ? rows : [];
        renderDmMembers(rawData.dmMembers);
    } catch (err) {
        rawData.dmMembers = [];
        renderDmMembers([]);
    }
}
function renderDmMembers(rows) {
    updateCount('dm-members-count', rows.length);
    renderTable('dm-member-list', 4,
        rows.map(r =>
            '<td class="id-cell" title="' + escapeHtml(r.dm_channel_id) + '">' + escapeHtml(truncate(r.dm_channel_id, 12)) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(r.user_id) + '">' + escapeHtml(truncate(r.user_id, 12)) + '</td>' +
            '<td>' + escapeHtml(r.username) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at) + '</td>'
        ),
        'No DM members'
    );
}

// --- DM Messages ---
async function loadDmMessages() {
    try {
        const rows = await apiFetch('/api/admin/dm-messages');
        rawData.dmMessages = Array.isArray(rows) ? rows : [];
        renderDmMessages(rawData.dmMessages);
    } catch (err) {
        rawData.dmMessages = [];
        renderDmMessages([]);
    }
}
function renderDmMessages(rows) {
    updateCount('dm-messages-count', rows.length, ' records (max 500)');
    renderTable('dm-message-list', 5,
        rows.map(m =>
            '<td>' + escapeHtml(m.sender_username || m.sender_id) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(m.dm_channel_id) + '">' + escapeHtml(truncate(m.dm_channel_id, 12)) + '</td>' +
            '<td class="blob-cell" title="Click to expand">' + escapeHtml(truncate(m.encrypted_content, 50)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.nonce, 30)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(m.timestamp) + '</td>'
        ),
        'No DM messages'
    );
}

// --- DM Keys ---
async function loadDmKeys() {
    try {
        const rows = await apiFetch('/api/admin/dm-keys');
        rawData.dmKeys = Array.isArray(rows) ? rows : [];
        renderDmKeys(rawData.dmKeys);
    } catch (err) {
        rawData.dmKeys = [];
        renderDmKeys([]);
    }
}
function renderDmKeys(rows) {
    updateCount('dm-keys-count', rows.length);
    renderTable('dm-key-list', 6,
        rows.map(r =>
            '<td class="id-cell" title="' + escapeHtml(r.dm_channel_id) + '">' + escapeHtml(truncate(r.dm_channel_id, 12)) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(r.user_id) + '">' + escapeHtml(truncate(r.user_id, 12)) + '</td>' +
            '<td>' + escapeHtml(r.username) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.encrypted_key, 40)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.sender_public_key, 40)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.nonce, 30)) + '</td>'
        ),
        'No DM keys'
    );
}

// --- Friend Requests ---
async function loadFriendRequests() {
    try {
        const rows = await apiFetch('/api/admin/friend-requests');
        rawData.friendRequests = Array.isArray(rows) ? rows : [];
        renderFriendRequests(rawData.friendRequests);
    } catch (err) {
        rawData.friendRequests = [];
        renderFriendRequests([]);
    }
}
function renderFriendRequests(rows) {
    updateCount('friend-requests-count', rows.length);
    renderTable('friend-request-list', 4,
        rows.map(r =>
            '<td>' + escapeHtml(r.from_username) + ' <span class="id-cell">(' + escapeHtml(truncate(r.from_user_id, 8)) + ')</span></td>' +
            '<td>' + escapeHtml(r.to_username) + ' <span class="id-cell">(' + escapeHtml(truncate(r.to_user_id, 8)) + ')</span></td>' +
            '<td>' + escapeHtml(r.status) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at) + '</td>'
        ),
        'No friend requests'
    );
}

// --- Friendships ---
async function loadFriendships() {
    try {
        const rows = await apiFetch('/api/admin/friendships');
        rawData.friendships = Array.isArray(rows) ? rows : [];
        renderFriendships(rawData.friendships);
    } catch (err) {
        rawData.friendships = [];
        renderFriendships([]);
    }
}
function renderFriendships(rows) {
    updateCount('friendships-count', rows.length);
    renderTable('friendship-list', 3,
        rows.map(r =>
            '<td>' + escapeHtml(r.username_1) + ' <span class="id-cell">(' + escapeHtml(truncate(r.user_id_1, 8)) + ')</span></td>' +
            '<td>' + escapeHtml(r.username_2) + ' <span class="id-cell">(' + escapeHtml(truncate(r.user_id_2, 8)) + ')</span></td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at) + '</td>'
        ),
        'No friendships'
    );
}

// --- User Public Keys ---
async function loadUserPublicKeys() {
    try {
        const rows = await apiFetch('/api/admin/user-public-keys');
        rawData.userPublicKeys = Array.isArray(rows) ? rows : [];
        renderUserPublicKeys(rawData.userPublicKeys);
    } catch (err) {
        rawData.userPublicKeys = [];
        renderUserPublicKeys([]);
    }
}
function renderUserPublicKeys(rows) {
    updateCount('user-public-keys-count', rows.length);
    renderTable('user-public-key-list', 6,
        rows.map(r =>
            '<td>' + escapeHtml(r.username) + ' <span class="id-cell">(' + escapeHtml(truncate(r.user_id, 8)) + ')</span></td>' +
            '<td>' + escapeHtml(r.device_id) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.identity_key, 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.signed_prekey, 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.one_time_prekey || '', 30)) + '</td>' +
            '<td>' + (r.one_time_prekey_id || '') + '</td>'
        ),
        'No user public keys'
    );
}

// --- Files ---
async function loadFiles() {
    try {
        const rows = await apiFetch('/api/admin/files');
        rawData.files = Array.isArray(rows) ? rows : [];
        renderFiles(rawData.files);
    } catch (err) {
        rawData.files = [];
        renderFiles([]);
    }
}
function renderFiles(rows) {
    updateCount('files-count', rows.length);
    renderTable('file-list', 7,
        rows.map(r => {
            const size = r.file_size > 1048576 ? (r.file_size / 1048576).toFixed(1) + ' MB' :
                         r.file_size > 1024 ? (r.file_size / 1024).toFixed(1) + ' KB' : r.file_size + ' B';
            return '<td>' + escapeHtml(r.original_name) + '</td>' +
            '<td>' + escapeHtml(r.uploader_username) + '</td>' +
            '<td>' + escapeHtml(r.mime_type) + '</td>' +
            '<td>' + size + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.server_id || '-', 10)) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.channel_id || '-', 10)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at) + '</td>';
        }),
        'No files'
    );
}

async function clearAll() {
    if (!confirm('Are you sure you want to delete ALL data?')) return;
    if (!confirm('This will permanently remove all users, servers, channels, messages, and keys. This cannot be undone. Continue?')) return;
    try {
        const adminToken = sessionStorage.getItem('admin_token') || '';
        const res = await fetch('/api/admin/clear', {
            method: 'POST',
            headers: adminToken ? { 'Authorization': 'Bearer ' + adminToken } : {}
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Clear failed');
        await loadAllData();
    } catch (err) {
        alert('Clear failed: ' + err.message);
    }
}
