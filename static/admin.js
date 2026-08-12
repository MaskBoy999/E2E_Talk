let rawData = {
    users: [], servers: [], channels: [], messages: [], serverKeys: [], serverMembers: [],
    serverBans: [], dmChannels: [], dmMembers: [],
    dmMessages: [], friendRequests: [], friendships: [], files: [],
    adminConfig: [], pendingEvents: [], pendingNotifications: [],
    voiceSessions: [], voiceParticipants: [], userMedia: [], userKeyBlobs: [], profileDataKeys: [], sharedProfileDataKeys: [],
    auditLog: []
};

const PAGE_SIZES = [25, 50, 100];
let tabPages = {};

function getPageSize() {
    var saved = localStorage.getItem('admin_page_size');
    var n = parseInt(saved, 10);
    if (saved === 'All') return Infinity;
    if (PAGE_SIZES.indexOf(n) !== -1) return n;
    return 50;
}

function setPageSize(size) {
    localStorage.setItem('admin_page_size', String(size));
    // Reset all pages to 0
    for (var k in tabPages) tabPages[k] = 0;
    // Re-render the active tab
    var activeTab = document.querySelector('.tab-btn.active');
    if (activeTab) filterTab(activeTab.dataset.tab);
}

let autoRefreshInterval = null;
function toggleAutoRefresh() {
    const btn = document.getElementById('auto-refresh-btn');
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
        btn.textContent = 'Auto-Refresh: OFF';
        btn.style.background = '#555';
        btn.style.color = '#aaa';
        btn.style.borderColor = '#777';
    } else {
        autoRefreshInterval = setInterval(function() {
            loadAllData().then(function() {
                var activeTab = document.querySelector('.tab-btn.active');
                if (activeTab) filterTab(activeTab.dataset.tab);
            });
        }, 5000);
        btn.textContent = 'Auto-Refresh: ON';
        btn.style.background = '#2e7d32';
        btn.style.color = '#fff';
        btn.style.borderColor = '#4caf50';
    }
}
document.addEventListener('DOMContentLoaded', () => {
    const arBtn = document.getElementById('auto-refresh-btn');
    if (arBtn) arBtn.addEventListener('click', toggleAutoRefresh);

    // Clear stale HttpOnly token cookie that might interfere with admin password setup
    fetch('/api/logout', { method: 'POST' }).catch(function() {});

    // Invalidate any existing admin session so the user must re-enter the password
    invalidateAdminSession();
});

/** Clear admin auth from client sessionStorage and tell the server to invalidate the token. */
function invalidateAdminSession() {
    const currentToken = sessionStorage.getItem('admin_token');
    if (currentToken) {
        // Notify the server to remove this token from its in-memory store
        fetch('/api/admin/logout', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + currentToken }
        }).catch(function() {});
    }
    // Always clear client-side storage so the login form shows
    sessionStorage.removeItem('admin_auth');
    sessionStorage.removeItem('admin_token');
}

function paginate(data, tab) {
    var pageSize = getPageSize();
    var page = tabPages[tab] || 0;
    var total = data.length;
    var totalPages = pageSize === Infinity ? 1 : Math.ceil(total / pageSize) || 1;
    if (page >= totalPages) tabPages[tab] = totalPages - 1;
    var curPage = tabPages[tab] || 0;
    var start = curPage * (pageSize === Infinity ? total : pageSize);
    var end = pageSize === Infinity ? total : Math.min(start + pageSize, total);
    return { items: data.slice(start, end), total: total, page: curPage, totalPages: totalPages };
}

let tabTotals = {};
let tabFilteredCache = {};

function searchTab(tab) {
    tabPages[tab] = 0;
    filterTab(tab);
}

function renderPaginationControls(tab) {
    var pageSize = getPageSize();
    var p = tabPages[tab] || 0;
    var total = tabTotals[tab] || 0;
    var totalPages = pageSize === Infinity ? 1 : Math.ceil(total / pageSize) || 1;
    var container = document.getElementById(tab + '-pagination');
    if (!container) return;
    var html = '<div class="pagination-bar">';
    html += '<span class="pag-size-label">Rows:</span>';
    html += '<select class="pag-size-select" data-tab="' + tab + '">';
    PAGE_SIZES.forEach(function (s) {
        html += '<option value="' + s + '"' + (pageSize === s ? ' selected' : '') + '>' + s + '</option>';
    });
    html += '<option value="All"' + (pageSize === Infinity ? ' selected' : '') + '>All</option>';
    html += '</select>';
    html += '<button class="pag-btn" data-tab="' + tab + '" data-dir="first" ' + (p <= 0 ? 'disabled' : '') + '>&#171;</button>';
    html += '<button class="pag-btn" data-tab="' + tab + '" data-dir="prev" ' + (p <= 0 ? 'disabled' : '') + '>&#8249;</button>';
    html += '<span class="pag-info">Page ' + (p + 1) + ' of ' + totalPages + ' (' + total + ' records)</span>';
    html += '<button class="pag-btn" data-tab="' + tab + '" data-dir="next" ' + (p >= totalPages - 1 ? 'disabled' : '') + '>&#8250;</button>';
    html += '<button class="pag-btn" data-tab="' + tab + '" data-dir="last" ' + (p >= totalPages - 1 ? 'disabled' : '') + '>&#187;</button>';
    html += '</div>';
    container.innerHTML = html;
}

document.addEventListener('DOMContentLoaded', () => {
    // Admin password show/hide toggle
    const adminToggleBtn = document.getElementById('toggle-admin-password');
    const adminPasswordInput = document.getElementById('admin-password');
    if (adminToggleBtn && adminPasswordInput) {
        adminToggleBtn.addEventListener('click', function () {
            const visible = adminPasswordInput.type === 'text';
            adminPasswordInput.type = visible ? 'password' : 'text';
            adminToggleBtn.innerHTML = visible ? '&#128065;' : '&#128064;';
            adminToggleBtn.classList.toggle('active', !visible);
        });
    }
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

    // Pagination button clicks (delegated)
    document.getElementById('admin-panel').addEventListener('click', function (e) {
        var btn = e.target.closest('.pag-btn');
        if (!btn) return;
        var tab = btn.dataset.tab;
        var dir = btn.dataset.dir;
        var cur = tabPages[tab] || 0;
        var total = tabTotals[tab] || 0;
        var pageSize = getPageSize();
        var totalPages = pageSize === Infinity ? 1 : Math.ceil(total / pageSize) || 1;
        if (dir === 'first') tabPages[tab] = 0;
        else if (dir === 'prev') tabPages[tab] = Math.max(0, cur - 1);
        else if (dir === 'next') tabPages[tab] = Math.min(totalPages - 1, cur + 1);
        else if (dir === 'last') tabPages[tab] = totalPages - 1;
        filterTab(tab);
    });

    // Page size selector change (delegated)
    document.getElementById('admin-panel').addEventListener('change', function (e) {
        var sel = e.target.closest('.pag-size-select');
        if (!sel) return;
        var val = sel.value;
        setPageSize(val);
    });

    document.getElementById('clear-all-btn').addEventListener('click', clearAll);
    document.getElementById('export-db-btn').addEventListener('click', showExportModal);
    document.getElementById('import-db-btn').addEventListener('click', importDB);

    // Export/Import password modal show/hide toggles
    setupPasswordToggle('toggle-export-password', 'export-password-input');
    setupPasswordToggle('toggle-export-password-confirm', 'export-password-confirm-input');
    setupPasswordToggle('toggle-import-password', 'import-password-input');

    // Export modal buttons
    document.getElementById('confirm-export-db').addEventListener('click', confirmExport);
    document.getElementById('cancel-export-db').addEventListener('click', closeExportModal);

    // Import modal buttons
    document.getElementById('confirm-import-db').addEventListener('click', confirmImport);
    document.getElementById('cancel-import-db').addEventListener('click', closeImportModal);
});

// Store pending import data between file selection and password entry
let pendingImportData = null;

function setupPasswordToggle(toggleId, inputId) {
    const toggleBtn = document.getElementById(toggleId);
    const input = document.getElementById(inputId);
    if (toggleBtn && input) {
        toggleBtn.addEventListener('click', function () {
            const visible = input.type === 'text';
            input.type = visible ? 'password' : 'text';
            toggleBtn.innerHTML = visible ? '&#128065;' : '&#128064;';
            toggleBtn.classList.toggle('active', !visible);
        });
    }
}

function showExportModal() {
    document.getElementById('export-password-input').value = '';
    document.getElementById('export-password-confirm-input').value = '';
    document.getElementById('export-password-error').style.display = 'none';
    document.getElementById('export-db-password-modal').style.display = 'flex';
}

function closeExportModal() {
    document.getElementById('export-db-password-modal').style.display = 'none';
}

function showImportModal() {
    document.getElementById('import-password-input').value = '';
    document.getElementById('import-password-error').style.display = 'none';
    document.getElementById('import-password-error').textContent = '';
    document.getElementById('import-db-password-modal').style.display = 'flex';
}

function closeImportModal() {
    document.getElementById('import-db-password-modal').style.display = 'none';
}

async function confirmExport() {
    const password = document.getElementById('export-password-input').value;
    const confirmPw = document.getElementById('export-password-confirm-input').value;
    const errorEl = document.getElementById('export-password-error');
    errorEl.style.display = 'none';

    if (password && password !== confirmPw) {
        errorEl.textContent = 'Passwords do not match.';
        errorEl.style.display = 'block';
        return;
    }

    closeExportModal();
    await doExport(password || '');
}

async function confirmImport() {
    const password = document.getElementById('import-password-input').value;
    const errorEl = document.getElementById('import-password-error');
    errorEl.style.display = 'none';

    if (!password) {
        errorEl.textContent = 'Password is required for encrypted databases.';
        errorEl.style.display = 'block';
        return;
    }

    closeImportModal();
    await doImport(pendingImportData, password);
    pendingImportData = null;
}

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

async function apiFetch(url, method) {
    const adminToken = sessionStorage.getItem('admin_token') || '';
    const res = await fetch(url, {
        method: method || 'GET',
        headers: adminToken ? { 'Authorization': 'Bearer ' + adminToken } : {}
    });
    if (!res.ok) {
        // Redirect to login if unauthorized (token expired)
        if (res.status === 401) {
            sessionStorage.removeItem('admin_auth');
            sessionStorage.removeItem('admin_token');
            location.reload();
            return [];
        }
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Request failed with status ' + res.status);
    }
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
    var filtered;
    switch (tab) {
        case 'users': filtered = rawData.users.filter(u => !q || u.username.toLowerCase().includes(q) || u.id.toLowerCase().includes(q)); tabFilteredCache['users'] = filtered; renderUsers(filtered); break;
        case 'servers': filtered = rawData.servers.filter(s => !q || (s.encrypted_name || '').toLowerCase().includes(q) || s.id.toLowerCase().includes(q)); tabFilteredCache['servers'] = filtered; renderServers(filtered); break;
        case 'channels': filtered = rawData.channels.filter(c => !q || (c.encrypted_name || '').toLowerCase().includes(q) || c.server_id.toLowerCase().includes(q)); tabFilteredCache['channels'] = filtered; renderChannels(filtered); break;
        case 'messages': filtered = rawData.messages.filter(m => !q || (m.sender_username || m.sender_id).toLowerCase().includes(q) || m.channel_id.toLowerCase().includes(q) || (m.timestamp || '').toLowerCase().includes(q)); tabFilteredCache['messages'] = filtered; renderMessages(filtered); break;
        case 'server-keys': filtered = rawData.serverKeys.filter(k => !q || k.server_name.toLowerCase().includes(q) || k.user_id.toLowerCase().includes(q) || String(k.version).includes(q)); tabFilteredCache['server-keys'] = filtered; renderServerKeys(filtered); break;
        case 'server-members': filtered = rawData.serverMembers.filter(m => !q || m.username.toLowerCase().includes(q) || m.user_id.toLowerCase().includes(q) || m.server_name.toLowerCase().includes(q)); tabFilteredCache['server-members'] = filtered; renderServerMembers(filtered); break;
        case 'server-bans': filtered = rawData.serverBans.filter(b => !q || b.server_name.toLowerCase().includes(q) || b.username.toLowerCase().includes(q) || (b.reason || '').toLowerCase().includes(q)); tabFilteredCache['server-bans'] = filtered; renderServerBans(filtered); break;
        case 'dm-channels': filtered = rawData.dmChannels.filter(c => !q || c.id.toLowerCase().includes(q)); tabFilteredCache['dm-channels'] = filtered; renderDmChannels(filtered); break;
        case 'dm-members': filtered = rawData.dmMembers.filter(m => !q || m.username.toLowerCase().includes(q) || m.user_id.toLowerCase().includes(q) || m.dm_channel_id.toLowerCase().includes(q)); tabFilteredCache['dm-members'] = filtered; renderDmMembers(filtered); break;
        case 'dm-messages': filtered = rawData.dmMessages.filter(m => !q || (m.sender_username || m.sender_id).toLowerCase().includes(q) || m.dm_channel_id.toLowerCase().includes(q) || (m.timestamp || '').toLowerCase().includes(q)); tabFilteredCache['dm-messages'] = filtered; renderDmMessages(filtered); break;
        case 'friend-requests': filtered = rawData.friendRequests.filter(r => !q || r.from_username.toLowerCase().includes(q) || r.to_username.toLowerCase().includes(q) || r.status.toLowerCase().includes(q)); tabFilteredCache['friend-requests'] = filtered; renderFriendRequests(filtered); break;
        case 'friendships': filtered = rawData.friendships.filter(f => !q || f.username_1.toLowerCase().includes(q) || f.username_2.toLowerCase().includes(q)); tabFilteredCache['friendships'] = filtered; renderFriendships(filtered); break;
        case 'files': filtered = rawData.files.filter(f => !q || f.original_name.toLowerCase().includes(q) || f.uploader_username.toLowerCase().includes(q) || f.mime_type.toLowerCase().includes(q)); tabFilteredCache['files'] = filtered; renderFiles(filtered); break;
        case 'admin-config': filtered = rawData.adminConfig.filter(c => !q || c.key.toLowerCase().includes(q) || c.value.toLowerCase().includes(q)); tabFilteredCache['admin-config'] = filtered; renderAdminConfig(filtered); break;
        case 'pending-events': filtered = rawData.pendingEvents.filter(e => !q || e.user_id.toLowerCase().includes(q) || e.event_type.toLowerCase().includes(q) || e.server_id.toLowerCase().includes(q)); tabFilteredCache['pending-events'] = filtered; renderPendingEvents(filtered); break;
        case 'pending-notifications': filtered = rawData.pendingNotifications.filter(n => !q || n.user_id.toLowerCase().includes(q) || n.notification_type.toLowerCase().includes(q)); tabFilteredCache['pending-notifications'] = filtered; renderPendingNotifications(filtered); break;
        case 'voice-sessions': filtered = rawData.voiceSessions.filter(s => !q || s.id.toLowerCase().includes(q) || s.channel_id.toLowerCase().includes(q)); tabFilteredCache['voice-sessions'] = filtered; renderVoiceSessions(filtered); break;
        case 'voice-participants': filtered = rawData.voiceParticipants.filter(p => !q || p.voice_session_id.toLowerCase().includes(q) || p.user_id.toLowerCase().includes(q)); tabFilteredCache['voice-participants'] = filtered; renderVoiceParticipants(filtered); break;
        case 'user-media': filtered = rawData.userMedia.filter(m => !q || m.id.toLowerCase().includes(q) || (m.username||'').toLowerCase().includes(q) || (m.media_type||'').toLowerCase().includes(q)); tabFilteredCache['user-media'] = filtered; renderUserMedia(filtered); break;
        case 'user-key-blobs': filtered = rawData.userKeyBlobs.filter(b => !q || (b.username||'').toLowerCase().includes(q) || b.user_id.toLowerCase().includes(q)); tabFilteredCache['user-key-blobs'] = filtered; renderUserKeyBlobs(filtered); break;
        case 'profile-data-keys': filtered = rawData.profileDataKeys.filter(k => !q || (k.username||'').toLowerCase().includes(q) || k.user_id.toLowerCase().includes(q)); tabFilteredCache['profile-data-keys'] = filtered; renderProfileDataKeys(filtered); break;
        case 'shared-profile-data-keys': filtered = rawData.sharedProfileDataKeys.filter(k => !q || k.id.toLowerCase().includes(q) || (k.username||'').toLowerCase().includes(q) || (k.target_type||'').toLowerCase().includes(q) || (k.target_id||'').toLowerCase().includes(q)); tabFilteredCache['shared-profile-data-keys'] = filtered; renderSharedProfileDataKeys(filtered); break;
        case 'audit-log': filtered = rawData.auditLog.filter(a => !q || (a.action||'').toLowerCase().includes(q) || (a.target||'').toLowerCase().includes(q) || (a.ip||'').toLowerCase().includes(q) || (a.actor||'').toLowerCase().includes(q)); tabFilteredCache['audit-log'] = filtered; renderAuditLog(filtered); break;
    }
}

async function loadTabData(endpoint, dataKey, renderFn) {
    try {
        const rows = await apiFetch(endpoint);
        rawData[dataKey] = Array.isArray(rows) ? rows : [];
        renderFn(rawData[dataKey]);
    } catch (err) {
        rawData[dataKey] = [];
        renderFn([]);
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
        loadServerBans(),
        loadDmChannels(),
        loadDmMembers(),
        loadDmMessages(),
        loadFriendRequests(),
        loadFriendships(),
        loadFiles(),
        loadAdminConfig(),
        loadPendingEvents(),
        loadPendingNotifications(),
        loadVoiceSessions(),
        loadVoiceParticipants(),
        loadUserMedia(),
        loadUserKeyBlobs(),
        loadProfileDataKeys(),
        loadSharedProfileDataKeys(),
        loadAuditLog(),
    ]);
}

// --- Users ---
async function loadUsers() { await loadTabData("/api/admin/users", "users", renderUsers); }

function renderUsers(users) {
    tabTotals['users'] = users.length;
    const p = paginate(users, 'users');
    updateCount('users-count', p.total);
    renderTable('user-list', 14,
        p.items.map(u =>
            '<td>' + escapeHtml(u.username) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(u.id) + '">' + escapeHtml(truncate(u.id, 12)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(u.created_at || '') + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(u.identity_public_key || '', 20)) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(u.profile_picture_file_id || '', 12)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(u.profile_picture_file_key || '', 20)) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(u.profile_banner_file_id || '', 12)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(u.profile_banner_file_key || '', 20)) + '</td>' +
            '<td>' + (u.friend_requests_disabled ? 'Yes' : 'No') + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(u.encrypted_profile_data || '', 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(u.friend_code_hash || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(u.encrypted_hash_key || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(u.hash_key_salt || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(u.hash_key_nonce || '', 20)) + '</td>'
        ),
        'No users'
    );
    renderPaginationControls('users');
}

// --- Servers ---
async function loadServers() { await loadTabData("/api/admin/servers", "servers", renderServers); }

function renderServers(servers) {
    tabTotals['servers'] = servers.length;
    const p = paginate(servers, 'servers');
    updateCount('servers-count', p.total);
    renderTable('server-list', 12,
        p.items.map(s => {
            var nameHtml = s.encrypted_name
                ? '<span class="blob-cell">' + escapeHtml(truncate(s.encrypted_name, 30)) + '</span>'
                : '<span class="empty-state">(no name)</span>';
            return '<td>' + nameHtml + '</td>' +
                '<td class="id-cell" title="' + escapeHtml(s.id) + '">' + escapeHtml(truncate(s.id, 12)) + '</td>' +
                '<td class="id-cell" title="' + escapeHtml(s.owner_id) + '">' + escapeHtml(truncate(s.owner_id, 12)) + '</td>' +
                '<td class="ts-cell">' + escapeHtml(s.created_at || '') + '</td>' +
                '<td class="blob-cell">' + escapeHtml(truncate(s.invite_code_hash || '', 20)) + '</td>' +
                '<td>' + (s.joins_disabled ? 'Yes' : 'No') + '</td>' +
                '<td class="blob-cell">' + escapeHtml(truncate(s.encrypted_name || '', 20)) + '</td>' +
                '<td class="blob-cell">' + escapeHtml(truncate(s.name_nonce || '', 20)) + '</td>' +
                '<td class="id-cell">' + escapeHtml(truncate(s.server_picture_file_id || '', 12)) + '</td>' +
                '<td class="blob-cell">' + escapeHtml(truncate(s.server_picture_file_id_hash || '', 20)) + '</td>' +
                '<td class="blob-cell">' + escapeHtml(truncate(s.encrypted_server_picture_key || '', 20)) + '</td>' +
                '<td class="blob-cell">' + escapeHtml(truncate(s.server_picture_key_nonce || '', 20)) + '</td>';
        }),
        'No servers'
    );
    renderPaginationControls('servers');
}

// --- Channels ---
async function loadChannels() { await loadTabData("/api/admin/channels", "channels", renderChannels); }

function renderChannels(channels) {
    tabTotals['channels'] = channels.length;
    const p = paginate(channels, 'channels');
    updateCount('channels-count', p.total);
    renderTable('channel-list', 8,
        p.items.map(c => {
            var nameHtml = c.encrypted_name
                ? '<span class="blob-cell">' + escapeHtml(truncate(c.encrypted_name, 30)) + '</span>'
                : '<span class="empty-state">(no name)</span>';
            return '<td>' + nameHtml + '</td>' +
                '<td class="id-cell" title="' + escapeHtml(c.id) + '">' + escapeHtml(truncate(c.id, 12)) + '</td>' +
                '<td class="id-cell" title="' + escapeHtml(c.server_id) + '">' + escapeHtml(truncate(c.server_id, 12)) + '</td>' +
                '<td>' + escapeHtml(c.type) + '</td>' +
                '<td>' + (c.position != null ? c.position : '') + '</td>' +
                '<td class="ts-cell">' + escapeHtml(c.created_at || '') + '</td>' +
                '<td class="blob-cell">' + escapeHtml(truncate(c.encrypted_name || '', 20)) + '</td>' +
                '<td class="blob-cell">' + escapeHtml(truncate(c.name_nonce || '', 20)) + '</td>';
        }),
        'No channels'
    );
    renderPaginationControls('channels');
}

// --- Messages ---
async function loadMessages() { await loadTabData("/api/admin/messages", "messages", renderMessages); }

function renderMessages(messages) {
    tabTotals['messages'] = messages.length;
    const p = paginate(messages, 'messages');
    updateCount('messages-count', p.total, ' records');
    renderTable('message-list', 12,
        p.items.map(m =>
            '<td>' + escapeHtml(m.sender_username || m.sender_id) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(m.channel_id) + '">' + escapeHtml(truncate(m.channel_id, 12)) + '</td>' +
            '<td class="blob-cell" title="Click to expand">' + escapeHtml(truncate(m.encrypted_content, 60)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.nonce, 30)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(m.timestamp) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(m.id || '', 12)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(m.edited_at || '') + '</td>' +
            '<td>' + (m.key_version != null ? m.key_version : '') + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.sender_id_hash || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.encrypted_profile_snapshot || '', 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.encrypted_file_key || '', 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.file_key_nonce || '', 30)) + '</td>'
        ),
        'No messages'
    );
    renderPaginationControls('messages');
}

// --- Server Keys ---
async function loadServerKeys() { await loadTabData("/api/admin/server-keys", "serverKeys", renderServerKeys); }

function renderServerKeys(keys) {
    tabTotals['server-keys'] = keys.length;
    const p = paginate(keys, 'server-keys');
    updateCount('server-keys-count', p.total);
    renderTable('server-key-list', 8,
        p.items.map(k =>
            '<td>' + escapeHtml(k.server_name) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(k.user_id) + '">' + escapeHtml(truncate(k.user_id, 12)) + '</td>' +
            '<td class="blob-cell" title="Click to expand">' + escapeHtml(truncate(k.encrypted_key, 40)) + '</td>' +
            '<td class="blob-cell" title="Click to expand">' + escapeHtml(truncate(k.sender_public_key, 40)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(k.nonce, 30)) + '</td>' +
            '<td>' + k.version + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(k.device_id || '', 12)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(k.created_at || '') + '</td>'
        ),
        'No server keys'
    );
    renderPaginationControls('server-keys');
}

// --- Server Members ---
async function loadServerMembers() { await loadTabData("/api/admin/server-members", "serverMembers", renderServerMembers); }

function renderServerMembers(members) {
    tabTotals['server-members'] = members.length;
    const p = paginate(members, 'server-members');
    updateCount('server-members-count', p.total);
    renderTable('server-member-list', 6,
        p.items.map(m =>
            '<td>' + escapeHtml(m.username) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(m.user_id) + '">' + escapeHtml(truncate(m.user_id, 12)) + '</td>' +
            '<td>' + escapeHtml(m.server_name) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(m.server_id) + '">' + escapeHtml(truncate(m.server_id, 12)) + '</td>' +
            '<td>' + escapeHtml(m.role || 'member') + '</td>' +
            '<td class="ts-cell">' + escapeHtml(m.joined_at || '') + '</td>'
        ),
        'No members'
    );
    renderPaginationControls('server-members');
}

// --- Server Bans ---
async function loadServerBans() { await loadTabData("/api/admin/server-bans", "serverBans", renderServerBans); }
function renderServerBans(rows) {
    tabTotals['server-bans'] = rows.length;
    const p = paginate(rows, 'server-bans');
    updateCount('server-bans-count', p.total);
    renderTable('server-ban-list', 6,
        p.items.map(r =>
            '<td>' + escapeHtml(r.server_name) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(r.server_id) + '">' + escapeHtml(truncate(r.server_id, 12)) + '</td>' +
            '<td>' + escapeHtml(r.username) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(r.user_id) + '">' + escapeHtml(truncate(r.user_id || '', 12)) + '</td>' +
            '<td>' + escapeHtml(r.reason || '') + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at) + '</td>'
        ),
        'No server bans'
    );
    renderPaginationControls('server-bans');
}

// --- DM Channels ---
async function loadDmChannels() { await loadTabData("/api/admin/dm-channels", "dmChannels", renderDmChannels); }
function renderDmChannels(rows) {
    tabTotals['dm-channels'] = rows.length;
    const p = paginate(rows, 'dm-channels');
    updateCount('dm-channels-count', p.total);
    renderTable('dm-channel-list', 2,
        p.items.map(r =>
            '<td class="id-cell" title="' + escapeHtml(r.id) + '">' + escapeHtml(truncate(r.id, 16)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at) + '</td>'
        ),
        'No DM channels'
    );
    renderPaginationControls('dm-channels');
}

// --- DM Members ---
async function loadDmMembers() { await loadTabData("/api/admin/dm-members", "dmMembers", renderDmMembers); }
function renderDmMembers(rows) {
    tabTotals['dm-members'] = rows.length;
    const p = paginate(rows, 'dm-members');
    updateCount('dm-members-count', p.total);
    renderTable('dm-member-list', 4,
        p.items.map(r =>
            '<td class="id-cell" title="' + escapeHtml(r.dm_channel_id) + '">' + escapeHtml(truncate(r.dm_channel_id, 12)) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(r.user_id) + '">' + escapeHtml(truncate(r.user_id, 12)) + '</td>' +
            '<td>' + escapeHtml(r.username) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at) + '</td>'
        ),
        'No DM members'
    );
    renderPaginationControls('dm-members');
}

// --- DM Messages ---
async function loadDmMessages() { await loadTabData("/api/admin/dm-messages", "dmMessages", renderDmMessages); }
function renderDmMessages(rows) {
    tabTotals['dm-messages'] = rows.length;
    const p = paginate(rows, 'dm-messages');
    updateCount('dm-messages-count', p.total, ' records');
    renderTable('dm-message-list', 11,
        p.items.map(m =>
            '<td>' + escapeHtml(m.sender_username || m.sender_id) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(m.dm_channel_id) + '">' + escapeHtml(truncate(m.dm_channel_id, 12)) + '</td>' +
            '<td class="blob-cell" title="Click to expand">' + escapeHtml(truncate(m.encrypted_content, 50)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.nonce, 30)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(m.timestamp) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(m.id || '', 12)) + '</td>' +
            '<td>' + (m.key_version != null ? m.key_version : '') + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.sender_id_hash || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.encrypted_profile_snapshot || '', 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.encrypted_file_key || '', 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.file_key_nonce || '', 30)) + '</td>'
        ),
        'No DM messages'
    );
    renderPaginationControls('dm-messages');
}

// --- Friend Requests ---
async function loadFriendRequests() { await loadTabData("/api/admin/friend-requests", "friendRequests", renderFriendRequests); }
function renderFriendRequests(rows) {
    tabTotals['friend-requests'] = rows.length;
    const p = paginate(rows, 'friend-requests');
    updateCount('friend-requests-count', p.total);
    renderTable('friend-request-list', 5,
        p.items.map(r =>
            '<td>' + escapeHtml(r.from_username) + ' <span class="id-cell">(' + escapeHtml(truncate(r.from_user_id, 8)) + ')</span></td>' +
            '<td>' + escapeHtml(r.to_username) + ' <span class="id-cell">(' + escapeHtml(truncate(r.to_user_id, 8)) + ')</span></td>' +
            '<td>' + escapeHtml(r.status) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.responded_at || '') + '</td>'
        ),
        'No friend requests'
    );
    renderPaginationControls('friend-requests');
}

// --- Friendships ---
async function loadFriendships() { await loadTabData("/api/admin/friendships", "friendships", renderFriendships); }
function renderFriendships(rows) {
    tabTotals['friendships'] = rows.length;
    const p = paginate(rows, 'friendships');
    updateCount('friendships-count', p.total);
    renderTable('friendship-list', 3,
        p.items.map(r =>
            '<td>' + escapeHtml(r.username_1) + ' <span class="id-cell">(' + escapeHtml(truncate(r.user_id_1, 8)) + ')</span></td>' +
            '<td>' + escapeHtml(r.username_2) + ' <span class="id-cell">(' + escapeHtml(truncate(r.user_id_2, 8)) + ')</span></td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at) + '</td>'
        ),
        'No friendships'
    );
    renderPaginationControls('friendships');
}

// --- Files ---
async function loadFiles() { await loadTabData("/api/admin/files", "files", renderFiles); }
function renderFiles(rows) {
    tabTotals['files'] = rows.length;
    const p = paginate(rows, 'files');
    updateCount('files-count', p.total);
    renderTable('file-list', 10,
        p.items.map(r => {
            const size = r.file_size > 1048576 ? (r.file_size / 1048576).toFixed(1) + ' MB' :
                         r.file_size > 1024 ? (r.file_size / 1024).toFixed(1) + ' KB' : r.file_size + ' B';
            return '<td class="id-cell">' + escapeHtml(truncate(r.original_name, 16)) + '</td>' +
            '<td>' + escapeHtml(r.uploader_username) + '</td>' +
            '<td>' + escapeHtml(r.mime_type) + '</td>' +
            '<td>' + size + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.file_id_hash || '', 20)) + '</td>' +
            '<td>' + (r.chunk_count != null ? r.chunk_count : '') + '</td>' +
            '<td>' + (r.upload_complete ? 'Yes' : 'No') + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.encrypted_mime_type || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.mime_nonce || '', 20)) + '</td>';
        }),
        'No files'
    );
    renderPaginationControls('files');
}

// --- Admin Config ---
async function loadAdminConfig() { await loadTabData("/api/admin/admin-config", "adminConfig", renderAdminConfig); }
function renderAdminConfig(rows) {
    tabTotals['admin-config'] = rows.length;
    const p = paginate(rows, 'admin-config');
    updateCount('admin-config-count', p.total);
    renderTable('admin-config-list', 2,
        p.items.map(r =>
            '<td>' + escapeHtml(r.key) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.value, 60)) + '</td>'
        ),
        'No config entries'
    );
    renderPaginationControls('admin-config');
}

// --- Pending Events ---
async function loadPendingEvents() { await loadTabData("/api/admin/pending-events", "pendingEvents", renderPendingEvents); }
function renderPendingEvents(rows) {
    tabTotals['pending-events'] = rows.length;
    const p = paginate(rows, 'pending-events');
    updateCount('pending-events-count', p.total);
    renderTable('pending-event-list', 5,
        p.items.map(r =>
            '<td>' + escapeHtml(r.id) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.user_id, 12)) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.server_id, 12)) + '</td>' +
            '<td>' + escapeHtml(r.event_type) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.affected_user_id, 12)) + '</td>'
        ),
        'No pending events'
    );
    renderPaginationControls('pending-events');
}

// --- Pending Notifications ---
async function loadPendingNotifications() { await loadTabData("/api/admin/pending-notifications", "pendingNotifications", renderPendingNotifications); }
function renderPendingNotifications(rows) {
    tabTotals['pending-notifications'] = rows.length;
    const p = paginate(rows, 'pending-notifications');
    updateCount('pending-notifications-count', p.total);
    renderTable('pending-notification-list', 4,
        p.items.map(r =>
            '<td>' + escapeHtml(r.id) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.user_id, 12)) + '</td>' +
            '<td>' + escapeHtml(r.notification_type) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.payload, 60)) + '</td>'
        ),
        'No pending notifications'
    );
    renderPaginationControls('pending-notifications');
}

// --- Voice Sessions ---
async function loadVoiceSessions() { await loadTabData("/api/admin/voice-sessions", "voiceSessions", renderVoiceSessions); }
function renderVoiceSessions(rows) {
    tabTotals['voice-sessions'] = rows.length;
    const p = paginate(rows, 'voice-sessions');
    updateCount('voice-sessions-count', p.total);
    renderTable('voice-session-list', 4,
        p.items.map(r =>
            '<td class="id-cell">' + escapeHtml(truncate(r.id, 12)) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.channel_id, 12)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.started_at || '') + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.ended_at || '') + '</td>'
        ),
        'No voice sessions'
    );
    renderPaginationControls('voice-sessions');
}

// --- Voice Participants ---
async function loadVoiceParticipants() { await loadTabData("/api/admin/voice-participants", "voiceParticipants", renderVoiceParticipants); }
function renderVoiceParticipants(rows) {
    tabTotals['voice-participants'] = rows.length;
    const p = paginate(rows, 'voice-participants');
    updateCount('voice-participants-count', p.total);
    renderTable('voice-participant-list', 8,
        p.items.map(r =>
            '<td class="id-cell">' + escapeHtml(truncate(r.voice_session_id, 12)) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.user_id, 12)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.joined_at || '') + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.left_at || '') + '</td>' +
            '<td>' + (r.is_muted ? 'Yes' : 'No') + '</td>' +
            '<td>' + (r.is_deafened ? 'Yes' : 'No') + '</td>' +
            '<td>' + (r.is_camera_on ? 'Yes' : 'No') + '</td>' +
            '<td>' + (r.is_screen_sharing ? 'Yes' : 'No') + '</td>'
        ),
        'No voice participants'
    );
    renderPaginationControls('voice-participants');
}

// --- User Media ---
async function loadUserMedia() { await loadTabData("/api/admin/user-media", "userMedia", renderUserMedia); }
function renderUserMedia(rows) {
    tabTotals['user-media'] = rows.length;
    const p = paginate(rows, 'user-media');
    updateCount('user-media-count', p.total);
    renderTable('user-media-list', 8,
        p.items.map(r =>
            '<td class="id-cell">' + escapeHtml(truncate(r.id, 12)) + '</td>' +
            '<td>' + escapeHtml(r.username || '') + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.file_id, 12)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.encrypted_file_key || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.eph_pub || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.nonce || '', 20)) + '</td>' +
            '<td>' + escapeHtml(r.media_type || '') + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at || '') + '</td>'
        ),
        'No user media'
    );
    renderPaginationControls('user-media');
}

// --- User Key Blobs ---
async function loadUserKeyBlobs() { await loadTabData("/api/admin/user-key-blobs", "userKeyBlobs", renderUserKeyBlobs); }
function renderUserKeyBlobs(rows) {
    tabTotals['user-key-blobs'] = rows.length;
    const p = paginate(rows, 'user-key-blobs');
    updateCount('user-key-blobs-count', p.total);
    renderTable('user-key-blob-list', 5,
        p.items.map(r =>
            '<td>' + escapeHtml(r.username || '') + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.user_id, 12)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.encrypted_blob, 40)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.salt, 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.nonce, 20)) + '</td>'
        ),
        'No key blobs'
    );
    renderPaginationControls('user-key-blobs');
}

// --- Profile Data Keys ---
async function loadProfileDataKeys() { await loadTabData("/api/admin/profile-data-keys", "profileDataKeys", renderProfileDataKeys); }
function renderProfileDataKeys(rows) {
    tabTotals['profile-data-keys'] = rows.length;
    const p = paginate(rows, 'profile-data-keys');
    updateCount('profile-data-keys-count', p.total);
    renderTable('profile-data-key-list', 4,
        p.items.map(r =>
            '<td>' + escapeHtml(r.username || '') + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.user_id, 12)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.encrypted_key, 40)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.nonce, 20)) + '</td>'
        ),
        'No profile data keys'
    );
    renderPaginationControls('profile-data-keys');
}

// --- Shared Profile Data Keys ---
async function loadSharedProfileDataKeys() { await loadTabData("/api/admin/shared-profile-data-keys", "sharedProfileDataKeys", renderSharedProfileDataKeys); }
function renderSharedProfileDataKeys(rows) {
    tabTotals['shared-profile-data-keys'] = rows.length;
    const p = paginate(rows, 'shared-profile-data-keys');
    updateCount('shared-profile-data-keys-count', p.total);
    renderTable('shared-profile-data-key-list', 6,
        p.items.map(r =>
            '<td class="id-cell">' + escapeHtml(truncate(r.id, 12)) + '</td>' +
            '<td>' + escapeHtml(r.username || '') + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.owner_user_id, 12)) + '</td>' +
            '<td>' + escapeHtml(r.target_type || '') + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.target_id, 12)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.encrypted_key, 40)) + '</td>'
        ),
        'No shared profile data keys'
    );
    renderPaginationControls('shared-profile-data-keys');
}

async function clearAll() {
    if (!confirm('Are you sure you want to wipe ALL data?')) return;
    if (!confirm('This will permanently delete ALL users, servers, channels, messages, keys, and files. The server will return to its fresh-install state, requiring a new admin password setup. This cannot be undone. Continue?')) return;
    try {
        const adminToken = sessionStorage.getItem('admin_token') || '';
        const res = await fetch('/api/admin/clear', {
            method: 'POST',
            headers: adminToken ? { 'Authorization': 'Bearer ' + adminToken } : {}
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Wipe failed');
        // Clear admin auth from session storage
        sessionStorage.removeItem('admin_auth');
        sessionStorage.removeItem('admin_token');
        // Redirect to login page — server already reset setup_complete to false
        window.location.href = 'login.html';
    } catch (err) {
        alert('Wipe failed: ' + err.message);
    }
}

// Derive AES-256-GCM key from password+salt using SHA-256
async function deriveAESKey(password, salt) {
    const enc = new TextEncoder();
    const material = salt ? password + ':' + salt : password;
    const pwHash = await crypto.subtle.digest('SHA-256', enc.encode(material));
    return await crypto.subtle.importKey('raw', pwHash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function doExport(password) {
    try {
        const adminToken = sessionStorage.getItem('admin_token') || '';
        const res = await fetch('/api/admin/export-db', {
            headers: adminToken ? { 'Authorization': 'Bearer ' + adminToken } : {}
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Export failed');
        }
        const blob = await res.blob();
        const data = await blob.arrayBuffer();
        let finalBlob;
        if (password) {
            // Encrypt with password + random salt
            const saltBytes = crypto.getRandomValues(new Uint8Array(16));
            const salt = Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('');
            const key = await deriveAESKey(password, salt);
            const nonce = crypto.getRandomValues(new Uint8Array(12));
            const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, data);
            // Format: magic byte 0x01 + salt (16) + nonce (12) + ciphertext
            const combined = new Uint8Array(1 + 16 + 12 + encrypted.byteLength);
            combined[0] = 0x01;
            combined.set(saltBytes, 1);
            combined.set(nonce, 17);
            combined.set(new Uint8Array(encrypted), 29);
            finalBlob = new Blob([combined], { type: 'application/octet-stream' });
        } else {
            // Unencrypted: magic byte 0x00 + raw data
            const combined = new Uint8Array(1 + data.byteLength);
            combined[0] = 0x00;
            combined.set(new Uint8Array(data), 1);
            finalBlob = new Blob([combined], { type: 'application/octet-stream' });
        }
        const url = URL.createObjectURL(finalBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'e2e_chat_' + new Date().toISOString().slice(0, 10) + '.dbpack';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (err) {
        alert('Export failed: ' + err.message);
    }
}

async function doImport(buffer, password) {
    try {
        const saltBytes = new Uint8Array(buffer, 1, 16);
        const salt = Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        const key = await deriveAESKey(password, salt);
        const nonce = new Uint8Array(buffer, 17, 12);
        const ciphertext = new Uint8Array(buffer, 29);
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext);

        const adminToken = sessionStorage.getItem('admin_token') || '';
        const res = await fetch('/api/admin/import-db', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + adminToken,
                'Content-Type': 'application/octet-stream'
            },
            body: decrypted
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Import failed');
        alert('Database imported successfully! You will need to re-login.');
        sessionStorage.removeItem('admin_auth');
        sessionStorage.removeItem('admin_token');
        window.location.reload();
    } catch (err) {
        alert('Import failed: ' + err.message);
    }
}

async function importDB() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.dbpack,.db,.sqlite,.sqlite3';
    input.onchange = async function(e) {
        const file = e.target.files[0];
        if (!file) return;
        if (!confirm('Importing a new database will REPLACE all current data. The server will reconnect. Continue?')) return;
        try {
            const buffer = await file.arrayBuffer();
            if (buffer.byteLength < 1) {
                alert('Empty file.');
                return;
            }
            const magic = new Uint8Array(buffer, 0, 1)[0];
            if (magic === 0x01) {
                // Encrypted: salt(16) + nonce(12) + ciphertext
                if (buffer.byteLength < 29) {
                    alert('Corrupted encrypted file.');
                    return;
                }
                // Store buffer and show password modal
                pendingImportData = buffer;
                showImportModal();
            } else {
                // Unencrypted: upload directly
                const decrypted = buffer.slice(1);
                const adminToken = sessionStorage.getItem('admin_token') || '';
                const res = await fetch('/api/admin/import-db', {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Bearer ' + adminToken,
                        'Content-Type': 'application/octet-stream'
                    },
                    body: decrypted
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Import failed');
                alert('Database imported successfully! You will need to re-login.');
                sessionStorage.removeItem('admin_auth');
                sessionStorage.removeItem('admin_token');
                window.location.reload();
            }
        } catch (err) {
            alert('Import failed: ' + err.message);
        }
    };
    input.click();
}

// --- Audit Log (G4) ---
async function loadAuditLog() { await loadTabData("/api/admin/audit-log", "auditLog", renderAuditLog); }

function renderAuditLog(rows) {
    tabTotals['audit-log'] = rows.length;
    const p = paginate(rows, 'audit-log');
    updateCount('audit-log-count', p.total);
    renderTable('audit-log-list', 5,
        p.items.map(a =>
            '<td class="ts-cell">' + escapeHtml(a.timestamp || '') + '</td>' +
            '<td>' + escapeHtml(a.actor || '') + '</td>' +
            '<td>' + escapeHtml(a.action || '') + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(a.target || '') + '">' + escapeHtml(truncate(a.target || '', 24)) + '</td>' +
            '<td>' + escapeHtml(a.ip || '') + '</td>'
        ),
        'No admin actions logged yet');
    renderPaginationControls('audit-log');
}
