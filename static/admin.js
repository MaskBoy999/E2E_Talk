let pendingDeleteAction = null;

document.addEventListener('DOMContentLoaded', () => {
    if (sessionStorage.getItem('admin_auth')) {
        showPanel();
        loadAllData();
    }

    document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const password = document.getElementById('admin-password').value;
        try {
            const res = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });
            const data = await res.json();
            if (!res.ok) { showError(data.error || 'Wrong password'); return; }
            sessionStorage.setItem('admin_auth', 'true');
            showPanel();
            loadAllData();
        } catch (err) { showError('Server is not running'); }
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
});

function showError(msg) {
    const errDiv = document.getElementById('error-message');
    errDiv.textContent = msg;
    errDiv.style.display = 'block';
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

async function loadAllData() {
    await Promise.all([
        loadUsers(),
        loadServers(),
        loadChannels(),
        loadMessages(),
        loadServerKeys(),
        loadServerMembers(),
    ]);
}

// --- Users ---
async function loadUsers() {
    try {
        const users = await apiFetch('/api/admin/users');
        document.getElementById('users-count').textContent = Array.isArray(users) ? users.length + ' records' : '';
        renderTable('user-list', 3,
            users.map(u =>
                '<td>' + escapeHtml(u.username) + '</td>' +
                '<td class="id-cell" title="' + escapeHtml(u.id) + '">' + escapeHtml(truncate(u.id, 12)) + '</td>' +
                '<td><button class="btn-delete-sm" onclick="deleteUser(\'' + u.id + '\', \'' + escapeHtml(u.username) + '\')">Delete</button></td>'
            ),
            'No users'
        );
    } catch (err) {
        renderTable('user-list', 3, [], 'Failed to load');
    }
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
        document.getElementById('servers-count').textContent = Array.isArray(servers) ? servers.length + ' records' : '';
        renderTable('server-list', 5,
            servers.map(s =>
                '<td>' + escapeHtml(s.name) + '</td>' +
                '<td class="id-cell" title="' + escapeHtml(s.id) + '">' + escapeHtml(truncate(s.id, 12)) + '</td>' +
                '<td class="id-cell" title="' + escapeHtml(s.owner_id) + '">' + escapeHtml(truncate(s.owner_id, 12)) + '</td>' +
                '<td class="id-cell">' + escapeHtml(s.invite_code) + '</td>' +
                '<td><button class="btn-delete-sm" onclick="deleteServer(\'' + s.id + '\', \'' + escapeHtml(s.name) + '\')">Delete</button></td>'
            ),
            'No servers'
        );
    } catch (err) {
        renderTable('server-list', 5, [], 'Failed to load');
    }
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
        document.getElementById('channels-count').textContent = Array.isArray(channels) ? channels.length + ' records' : '';
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
    } catch (err) {
        renderTable('channel-list', 5, [], 'Failed to load');
    }
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
        document.getElementById('messages-count').textContent = Array.isArray(messages) ? messages.length + ' records (max 500)' : '';
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
    } catch (err) {
        renderTable('message-list', 5, [], 'Failed to load');
    }
}

// --- Server Keys ---
async function loadServerKeys() {
    try {
        const keys = await apiFetch('/api/admin/server-keys');
        document.getElementById('server-keys-count').textContent = Array.isArray(keys) ? keys.length + ' records' : '';
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
    } catch (err) {
        renderTable('server-key-list', 6, [], 'Failed to load');
    }
}

// --- Server Members ---
async function loadServerMembers() {
    try {
        const members = await apiFetch('/api/admin/server-members');
        document.getElementById('server-members-count').textContent = Array.isArray(members) ? members.length + ' records' : '';
        renderTable('server-member-list', 4,
            members.map(m =>
                '<td>' + escapeHtml(m.username) + '</td>' +
                '<td class="id-cell" title="' + escapeHtml(m.user_id) + '">' + escapeHtml(truncate(m.user_id, 12)) + '</td>' +
                '<td>' + escapeHtml(m.server_name) + '</td>' +
                '<td class="id-cell" title="' + escapeHtml(m.server_id) + '">' + escapeHtml(truncate(m.server_id, 12)) + '</td>'
            ),
            'No members'
        );
    } catch (err) {
        renderTable('server-member-list', 4, [], 'Failed to load');
    }
}
