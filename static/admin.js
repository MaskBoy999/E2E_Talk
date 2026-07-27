let rawData = {
    users: [], servers: [], channels: [], messages: [], serverKeys: [], serverMembers: [],
    prekeyBundles: [], sessions: [], serverBans: [], dmChannels: [], dmMembers: [],
    dmMessages: [], dmKeys: [], friendRequests: [], friendships: [], userPublicKeys: [], files: [],
    userStickers: [], userKeyEscrow: [], notificationSounds: [],
    adminConfig: [], userDeviceEscrow: []
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

const csvColumns = {
    'users': { headers: ['Username', 'User ID', 'Created', 'Display Name', 'Identity Pub Key', 'PFP File ID', 'PFP File Key', 'Banner File ID', 'Banner File Key', 'Friend Req Disabled', 'Profile Data', 'FC Hash'], map: (r) => [r.username, r.id, r.created_at || '', r.display_name || '', r.identity_public_key || '', r.profile_picture_file_id || '', r.profile_picture_file_key || '', r.profile_banner_file_id || '', r.profile_banner_file_key || '', String(r.friend_requests_disabled != null ? r.friend_requests_disabled : ''), r.encrypted_profile_data || '', r.friend_code_hash || ''] },
    'servers': { headers: ['Encrypted Name', 'Server ID', 'Owner ID', 'Created', 'Invite Code Hash', 'Joins Disabled'], map: (r) => [r.encrypted_name || '(encrypted)', r.id, r.owner_id, r.created_at || '', r.invite_code_hash || '', r.joins_disabled ? 'Yes' : 'No'] },
    'channels': { headers: ['Encrypted Name', 'Channel ID', 'Server ID', 'Type', 'Position', 'Created'], map: (r) => [r.encrypted_name || '(encrypted)', r.id, r.server_id, r.type, String(r.position != null ? r.position : ''), r.created_at || ''] },
    'messages': { headers: ['Sender', 'Sender ID', 'Channel ID', 'Encrypted Content', 'Nonce', 'Timestamp', 'Message ID', 'Edited At', 'Msg Nonce', 'Msg Sig', 'Profile Key', 'Profile Key Nonce', 'Banner Key', 'Banner Key Nonce'], map: (r) => [r.sender_username || r.sender_id, r.sender_id || '', r.channel_id, r.encrypted_content, r.nonce, r.timestamp, r.id || '', r.edited_at || '', r.message_nonce || '', r.message_signature || '', r.encrypted_profile_key || '', r.profile_key_nonce || '', r.encrypted_banner_key || '', r.banner_key_nonce || ''] },
    'server-keys': { headers: ['Server', 'Server ID', 'User ID', 'Encrypted Key', 'Sender Public Key', 'Nonce', 'Version', 'Device ID', 'Created'], map: (r) => [r.server_name, r.server_id || '', r.user_id, r.encrypted_key, r.sender_public_key, r.nonce, String(r.version), r.device_id || '', r.created_at || ''] },
    'server-members': { headers: ['Username', 'User ID', 'Server', 'Server ID', 'Role', 'Joined At'], map: (r) => [r.username, r.user_id, r.server_name, r.server_id, r.role || '', r.joined_at || ''] },
    'prekey-bundles': { headers: ['User ID', 'Identity Key', 'Signed Prekey', 'Signature', 'OT Prekey', 'OT ID', 'Created'], map: (r) => [r.user_id, r.identity_key_public, r.signed_prekey_public, r.signed_prekey_signature, r.one_time_prekey_public || '', r.one_time_prekey_id != null ? String(r.one_time_prekey_id) : '', r.created_at || ''] },
    'sessions': { headers: ['Our User', 'Our User ID', 'Their User', 'Their User ID', 'Session Data', 'Ratchet #', 'Created'], map: (r) => [r.our_username, r.our_user_id, r.their_username, r.their_user_id, r.session_data, String(r.ratchet_counter), r.created_at || ''] },
    'server-bans': { headers: ['Server', 'Server ID', 'Username', 'User ID', 'Reason', 'Created At'], map: (r) => [r.server_name, r.server_id || '', r.username, r.user_id || '', r.reason || '', r.created_at] },
    'dm-channels': { headers: ['Channel ID', 'Created At'], map: (r) => [r.id, r.created_at] },
    'dm-members': { headers: ['DM Channel ID', 'User ID', 'Username', 'Created At'], map: (r) => [r.dm_channel_id, r.user_id, r.username, r.created_at] },
    'dm-messages': { headers: ['Sender', 'Sender ID', 'DM Channel ID', 'Encrypted Content', 'Nonce', 'Timestamp', 'Message ID', 'Edited At', 'Msg Nonce', 'Msg Sig', 'Profile Key', 'Profile Key Nonce', 'Banner Key', 'Banner Key Nonce'], map: (r) => [r.sender_username || r.sender_id, r.sender_id || '', r.dm_channel_id, r.encrypted_content, r.nonce, r.timestamp, r.id || '', r.edited_at || '', r.message_nonce || '', r.message_signature || '', r.encrypted_profile_key || '', r.profile_key_nonce || '', r.encrypted_banner_key || '', r.banner_key_nonce || ''] },
    'dm-keys': { headers: ['DM Channel ID', 'User ID', 'Username', 'Encrypted Key', 'Sender Pub Key', 'Nonce', 'Device ID', 'Created'], map: (r) => [r.dm_channel_id, r.user_id, r.username, r.encrypted_key, r.sender_public_key, r.nonce, r.device_id || '', r.created_at || ''] },
    'friend-requests': { headers: ['From', 'From User ID', 'To', 'To User ID', 'Status', 'Created At', 'Responded At'], map: (r) => [r.from_username, r.from_user_id, r.to_username, r.to_user_id, r.status, r.created_at, r.responded_at || ''] },
    'friendships': { headers: ['User 1', 'User 1 ID', 'User 2', 'User 2 ID', 'Created At'], map: (r) => [r.username_1, r.user_id_1, r.username_2, r.user_id_2, r.created_at] },
    'user-public-keys': { headers: ['Username', 'User ID', 'Device ID', 'Device Name', 'Identity Key', 'Signed Prekey', 'Signed Prekey Sig', 'Last Active', 'Created'], map: (r) => [r.username, r.user_id, r.device_id, r.device_name || '', r.identity_key, r.signed_prekey || '', r.signed_prekey_signature || '', r.last_active_at || '', r.created_at || ''] },
    'files': { headers: ['Filename', 'Uploader', 'Uploader ID', 'MIME Type', 'Size', 'Server ID', 'Channel ID', 'Chunks', 'Complete', 'Created'], map: (r) => [r.original_name, r.uploader_username, r.uploader_id || '', r.mime_type, String(r.file_size), r.server_id || '', r.channel_id || '', String(r.chunk_count != null ? r.chunk_count : ''), r.upload_complete ? 'Yes' : 'No', r.created_at] },
    'user-stickers': { headers: ['Username', 'Sticker Name', 'File ID', 'MIME', 'Created', 'Enc File Key', 'File Key Nonce'], map: (r) => [r.username, r.sticker_name || '(unnamed)', r.file_id, r.mime_type || '', r.created_at || '', r.encrypted_file_key || '', r.file_key_nonce || ''] },
    'user-key-escrow': { headers: ['Username', 'User ID', 'Created', 'Updated', 'Has Key', 'Encrypted Private Key', 'Salt', 'Nonce'], map: (r) => [r.username, r.user_id, r.created_at || '', r.updated_at || '', r.has_key ? 'Yes' : 'No', r.encrypted_private_key || '', r.salt || '', r.nonce || ''] },
    'notification-sounds': { headers: ['Username', 'User ID', 'File Name', 'Encrypted Sound', 'Nonce', 'Sender Public Key', 'Created', 'Updated'], map: (r) => [r.username, r.user_id, r.file_name || '', r.encrypted_sound, r.nonce, r.sender_public_key, r.created_at || '', r.updated_at || ''] },
    'admin-config': { headers: ['Key', 'Value'], map: (r) => [r.key, r.value] },
    'user-device-escrow': { headers: ['Username', 'User ID', 'Device ID', 'Encrypted Private Key', 'Salt', 'Nonce', 'Created', 'Updated'], map: (r) => [r.username, r.user_id, r.device_id || '', r.encrypted_private_key || '', r.salt || '', r.nonce || '', r.created_at || '', r.updated_at || ''] },
};

function csvEscape(val) {
    var s = String(val == null ? '' : val);
    if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1) {
        s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

function exportCSV(tab) {
    var data = tabFilteredCache[tab] || [];
    if (data.length === 0) { alert('No data to export'); return; }
    var colDef = csvColumns[tab];
    if (!colDef) { alert('No CSV mapping for this tab'); return; }
    var rows = [colDef.headers.map(csvEscape).join(',')];
    data.forEach(function (item) {
        rows.push(colDef.map(item).map(csvEscape).join(','));
    });
    var csv = rows.join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = tab + '-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
}

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

    // CSV export button clicks (delegated)
    document.getElementById('admin-panel').addEventListener('click', function (e) {
        var csvBtn = e.target.closest('.csv-export-btn');
        if (csvBtn) { exportCSV(csvBtn.dataset.tab); return; }
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
    document.getElementById('reset-factory-btn').addEventListener('click', resetToFactory);

    // Decrypt names key input
    var decryptKeyInput = document.getElementById('admin-decrypt-key');
    var decryptKeyBtn = document.getElementById('admin-decrypt-apply');
    if (decryptKeyBtn && decryptKeyInput) {
        // Restore saved key
        var savedKey = sessionStorage.getItem('admin_decrypt_key');
        if (savedKey) decryptKeyInput.value = savedKey;
        decryptKeyBtn.addEventListener('click', function () {
            var key = decryptKeyInput.value.trim();
            if (key) {
                sessionStorage.setItem('admin_decrypt_key', key);
                decryptKeyInput.style.borderColor = '#4caf50';
                // Re-render active tab to decrypt names
                var activeTab = document.querySelector('.tab-btn.active');
                if (activeTab) {
                    filterTab(activeTab.dataset.tab);
                }
            } else {
                sessionStorage.removeItem('admin_decrypt_key');
                decryptKeyInput.style.borderColor = '';
                adminDecryptedNames = {};
                var activeTab = document.querySelector('.tab-btn.active');
                if (activeTab) filterTab(activeTab.dataset.tab);
            }
        });
        decryptKeyInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') decryptKeyBtn.click();
        });
    }
    // Clear decrypt cache button
    var clearDecryptBtn = document.getElementById('admin-decrypt-clear');
    if (clearDecryptBtn) {
        clearDecryptBtn.addEventListener('click', function () {
            adminDecryptedNames = {};
            var keyInput = document.getElementById('admin-decrypt-key');
            keyInput.style.borderColor = '';
            var activeTab = document.querySelector('.tab-btn.active');
            if (activeTab) filterTab(activeTab.dataset.tab);
        });
    }

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

// Admin E2EE decryption helper — decrypts AES-256-GCM ciphertext with a raw key
// encrypted_b64: base64-encoded ciphertext
// nonce_b64: base64-encoded 12-byte nonce
// key_b64: base64-encoded 32-byte AES key
async function adminDecryptName(encrypted_b64, nonce_b64, key_b64) {
    if (!encrypted_b64 || !nonce_b64 || !key_b64) return null;
    try {
        var keyBytes = Uint8Array.from(atob(key_b64), function(c) { return c.charCodeAt(0); });
        var nonce = Uint8Array.from(atob(nonce_b64), function(c) { return c.charCodeAt(0); });
        var data = Uint8Array.from(atob(encrypted_b64), function(c) { return c.charCodeAt(0); });
        var cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
        var plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, cryptoKey, data);
        return new TextDecoder().decode(plain);
    } catch (e) {
        return null;
    }
}

// Cached decrypted names: serverId/channelId -> name string
var adminDecryptedNames = {};

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
        case 'servers': filtered = rawData.servers.filter(s => !q || (s.encrypted_name || '').toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || (adminDecryptedNames['svr_' + s.id] || '').toLowerCase().includes(q)); tabFilteredCache['servers'] = filtered; renderServers(filtered); break;
        case 'channels': filtered = rawData.channels.filter(c => !q || (c.encrypted_name || '').toLowerCase().includes(q) || c.server_id.toLowerCase().includes(q) || (adminDecryptedNames['ch_' + c.id] || '').toLowerCase().includes(q)); tabFilteredCache['channels'] = filtered; renderChannels(filtered); break;
        case 'messages': filtered = rawData.messages.filter(m => !q || (m.sender_username || m.sender_id).toLowerCase().includes(q) || m.channel_id.toLowerCase().includes(q) || (m.timestamp || '').toLowerCase().includes(q)); tabFilteredCache['messages'] = filtered; renderMessages(filtered); break;
        case 'server-keys': filtered = rawData.serverKeys.filter(k => !q || k.server_name.toLowerCase().includes(q) || k.user_id.toLowerCase().includes(q) || String(k.version).includes(q)); tabFilteredCache['server-keys'] = filtered; renderServerKeys(filtered); break;
        case 'server-members': filtered = rawData.serverMembers.filter(m => !q || m.username.toLowerCase().includes(q) || m.user_id.toLowerCase().includes(q) || m.server_name.toLowerCase().includes(q)); tabFilteredCache['server-members'] = filtered; renderServerMembers(filtered); break;
        case 'prekey-bundles': filtered = rawData.prekeyBundles.filter(k => !q || k.user_id.toLowerCase().includes(q)); tabFilteredCache['prekey-bundles'] = filtered; renderPrekeyBundles(filtered); break;
        case 'sessions': filtered = rawData.sessions.filter(s => !q || s.our_username.toLowerCase().includes(q) || s.our_user_id.toLowerCase().includes(q) || s.their_username.toLowerCase().includes(q) || s.their_user_id.toLowerCase().includes(q)); tabFilteredCache['sessions'] = filtered; renderSessions(filtered); break;
        case 'server-bans': filtered = rawData.serverBans.filter(b => !q || b.server_name.toLowerCase().includes(q) || b.username.toLowerCase().includes(q) || (b.reason || '').toLowerCase().includes(q)); tabFilteredCache['server-bans'] = filtered; renderServerBans(filtered); break;
        case 'dm-channels': filtered = rawData.dmChannels.filter(c => !q || c.id.toLowerCase().includes(q)); tabFilteredCache['dm-channels'] = filtered; renderDmChannels(filtered); break;
        case 'dm-members': filtered = rawData.dmMembers.filter(m => !q || m.username.toLowerCase().includes(q) || m.user_id.toLowerCase().includes(q) || m.dm_channel_id.toLowerCase().includes(q)); tabFilteredCache['dm-members'] = filtered; renderDmMembers(filtered); break;
        case 'dm-messages': filtered = rawData.dmMessages.filter(m => !q || (m.sender_username || m.sender_id).toLowerCase().includes(q) || m.dm_channel_id.toLowerCase().includes(q) || (m.timestamp || '').toLowerCase().includes(q)); tabFilteredCache['dm-messages'] = filtered; renderDmMessages(filtered); break;
        case 'dm-keys': filtered = rawData.dmKeys.filter(k => !q || k.username.toLowerCase().includes(q) || k.user_id.toLowerCase().includes(q) || k.dm_channel_id.toLowerCase().includes(q)); tabFilteredCache['dm-keys'] = filtered; renderDmKeys(filtered); break;
        case 'friend-requests': filtered = rawData.friendRequests.filter(r => !q || r.from_username.toLowerCase().includes(q) || r.to_username.toLowerCase().includes(q) || r.status.toLowerCase().includes(q)); tabFilteredCache['friend-requests'] = filtered; renderFriendRequests(filtered); break;
        case 'friendships': filtered = rawData.friendships.filter(f => !q || f.username_1.toLowerCase().includes(q) || f.username_2.toLowerCase().includes(q)); tabFilteredCache['friendships'] = filtered; renderFriendships(filtered); break;
        case 'user-public-keys': filtered = rawData.userPublicKeys.filter(k => !q || k.username.toLowerCase().includes(q) || k.user_id.toLowerCase().includes(q) || k.device_id.toLowerCase().includes(q) || (k.device_name || '').toLowerCase().includes(q)); tabFilteredCache['user-public-keys'] = filtered; renderUserPublicKeys(filtered); break;
        case 'files': filtered = rawData.files.filter(f => !q || f.original_name.toLowerCase().includes(q) || f.uploader_username.toLowerCase().includes(q) || f.mime_type.toLowerCase().includes(q)); tabFilteredCache['files'] = filtered; renderFiles(filtered); break;
        case 'user-stickers': filtered = rawData.userStickers.filter(s => !q || s.username.toLowerCase().includes(q) || (s.sticker_name || '').toLowerCase().includes(q)); tabFilteredCache['user-stickers'] = filtered; renderUserStickers(filtered); break;
        case 'user-key-escrow': filtered = rawData.userKeyEscrow.filter(e => !q || e.username.toLowerCase().includes(q) || e.user_id.toLowerCase().includes(q)); tabFilteredCache['user-key-escrow'] = filtered; renderUserKeyEscrow(filtered); break;
        case 'notification-sounds': filtered = rawData.notificationSounds.filter(n => !q || n.username.toLowerCase().includes(q) || n.user_id.toLowerCase().includes(q)); tabFilteredCache['notification-sounds'] = filtered; renderNotificationSounds(filtered); break;
        case 'admin-config': filtered = rawData.adminConfig.filter(c => !q || c.key.toLowerCase().includes(q) || c.value.toLowerCase().includes(q)); tabFilteredCache['admin-config'] = filtered; renderAdminConfig(filtered); break;
        case 'user-device-escrow': filtered = rawData.userDeviceEscrow.filter(e => !q || e.username.toLowerCase().includes(q) || e.user_id.toLowerCase().includes(q) || e.device_id.toLowerCase().includes(q)); tabFilteredCache['user-device-escrow'] = filtered; renderUserDeviceEscrow(filtered); break;
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
        loadUserStickers(),
        loadUserKeyEscrow(),
        loadNotificationSounds(),
        loadAdminConfig(),
        loadUserDeviceEscrow(),
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
    tabTotals['users'] = users.length;
    const p = paginate(users, 'users');
    updateCount('users-count', p.total);
    renderTable('user-list', 17,
        p.items.map(u =>
            '<td>' + escapeHtml(u.username) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(u.id) + '">' + escapeHtml(truncate(u.id, 12)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(u.created_at || '') + '</td>' +
            '<td>' + escapeHtml(u.display_name || '') + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(u.identity_public_key || '', 20)) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(u.profile_picture_file_id || '', 12)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(u.profile_picture_file_key || '', 20)) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(u.profile_banner_file_id || '', 12)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(u.profile_banner_file_key || '', 20)) + '</td>' +
            // description, nickname, username_color, username_border_color, profile_background_color removed — all in encrypted_profile_data
            '<td>' + (u.friend_requests_disabled ? 'Yes' : 'No') + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(u.encrypted_profile_data || '', 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(u.friend_code_hash || '', 20)) + '</td>'
        ),
        'No users'
    );
    renderPaginationControls('users');
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

function getDecryptKey() {
    return sessionStorage.getItem('admin_decrypt_key') || '';
}

function renderServers(servers) {
    tabTotals['servers'] = servers.length;
    const p = paginate(servers, 'servers');
    updateCount('servers-count', p.total);
    var decryptKey = getDecryptKey();
    renderTable('server-list', 6,
        p.items.map(s => {
            var nameHtml;
            if (decryptKey && s.encrypted_name && s.name_nonce && adminDecryptedNames['svr_' + s.id]) {
                nameHtml = escapeHtml(adminDecryptedNames['svr_' + s.id]);
            } else if (decryptKey && s.encrypted_name && s.name_nonce) {
                // Try to decrypt asynchronously; show blob for now
                adminDecryptName(s.encrypted_name, s.name_nonce, decryptKey).then(function(dec) {
                    if (dec) {
                        adminDecryptedNames['svr_' + s.id] = dec;
                        filterTab('servers'); // re-render with decrypted name
                    }
                });
                nameHtml = '<span class="blob-cell">' + escapeHtml(truncate(s.encrypted_name, 30)) + '</span> <span class="decrypt-spinner" style="color:#888;font-size:10px;">&#8987;</span>';
            } else if (s.encrypted_name) {
                nameHtml = '<span class="blob-cell">' + escapeHtml(truncate(s.encrypted_name, 30)) + '</span>';
            } else {
                nameHtml = '<span class="empty-state">(no name)</span>';
            }
            return '<td>' + nameHtml + '</td>' +
                '<td class="id-cell" title="' + escapeHtml(s.id) + '">' + escapeHtml(truncate(s.id, 12)) + '</td>' +
                '<td class="id-cell" title="' + escapeHtml(s.owner_id) + '">' + escapeHtml(truncate(s.owner_id, 12)) + '</td>' +
                '<td class="ts-cell">' + escapeHtml(s.created_at || '') + '</td>' +
                '<td class="blob-cell">' + escapeHtml(truncate(s.invite_code_hash || '', 20)) + '</td>' +
                '<td>' + (s.joins_disabled ? 'Yes' : 'No') + '</td>';
        }),
        'No servers'
    );
    renderPaginationControls('servers');
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
    tabTotals['channels'] = channels.length;
    const p = paginate(channels, 'channels');
    updateCount('channels-count', p.total);
    var decryptKey = getDecryptKey();
    renderTable('channel-list', 6,
        p.items.map(c => {
            var nameHtml;
            if (decryptKey && c.encrypted_name && c.name_nonce && adminDecryptedNames['ch_' + c.id]) {
                nameHtml = escapeHtml(adminDecryptedNames['ch_' + c.id]);
            } else if (decryptKey && c.encrypted_name && c.name_nonce) {
                adminDecryptName(c.encrypted_name, c.name_nonce, decryptKey).then(function(dec) {
                    if (dec) {
                        adminDecryptedNames['ch_' + c.id] = dec;
                        filterTab('channels');
                    }
                });
                nameHtml = '<span class="blob-cell">' + escapeHtml(truncate(c.encrypted_name, 30)) + '</span> <span class="decrypt-spinner" style="color:#888;font-size:10px;">&#8987;</span>';
            } else if (c.encrypted_name) {
                nameHtml = '<span class="blob-cell">' + escapeHtml(truncate(c.encrypted_name, 30)) + '</span>';
            } else {
                nameHtml = '<span class="empty-state">(no name)</span>';
            }
            return '<td>' + nameHtml + '</td>' +
                '<td class="id-cell" title="' + escapeHtml(c.id) + '">' + escapeHtml(truncate(c.id, 12)) + '</td>' +
                '<td class="id-cell" title="' + escapeHtml(c.server_id) + '">' + escapeHtml(truncate(c.server_id, 12)) + '</td>' +
                '<td>' + escapeHtml(c.type) + '</td>' +
                '<td>' + (c.position != null ? c.position : '') + '</td>' +
                '<td class="ts-cell">' + escapeHtml(c.created_at || '') + '</td>';
        }),
        'No channels'
    );
    renderPaginationControls('channels');
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
    tabTotals['messages'] = messages.length;
    const p = paginate(messages, 'messages');
    updateCount('messages-count', p.total, ' records');
    renderTable('message-list', 13,
        p.items.map(m =>
            '<td>' + escapeHtml(m.sender_username || m.sender_id) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(m.channel_id) + '">' + escapeHtml(truncate(m.channel_id, 12)) + '</td>' +
            '<td class="blob-cell" title="Click to expand">' + escapeHtml(truncate(m.encrypted_content, 60)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.nonce, 30)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(m.timestamp) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(m.id || '', 12)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(m.edited_at || '') + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.message_nonce || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.message_signature || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.encrypted_profile_key || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.profile_key_nonce || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.encrypted_banner_key || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.banner_key_nonce || '', 20)) + '</td>'
        ),
        'No messages'
    );
    renderPaginationControls('messages');
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
    tabTotals['prekey-bundles'] = rows.length;
    const p = paginate(rows, 'prekey-bundles');
    updateCount('prekey-bundles-count', p.total);
    renderTable('prekey-bundle-list', 7,
        p.items.map(r =>
            '<td class="id-cell" title="' + escapeHtml(r.user_id) + '">' + escapeHtml(truncate(r.user_id, 12)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.identity_key_public, 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.signed_prekey_public, 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.signed_prekey_signature, 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.one_time_prekey_public || '', 30)) + '</td>' +
            '<td>' + (r.one_time_prekey_id || '') + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at || '') + '</td>'
        ),
        'No prekey bundles'
    );
    renderPaginationControls('prekey-bundles');
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
    tabTotals['sessions'] = rows.length;
    const p = paginate(rows, 'sessions');
    updateCount('sessions-count', p.total);
    renderTable('session-list', 5,
        p.items.map(r =>
            '<td>' + escapeHtml(r.our_username) + ' <span class="id-cell" title="' + escapeHtml(r.our_user_id) + '">(' + escapeHtml(truncate(r.our_user_id, 8)) + ')</span></td>' +
            '<td>' + escapeHtml(r.their_username) + ' <span class="id-cell" title="' + escapeHtml(r.their_user_id) + '">(' + escapeHtml(truncate(r.their_user_id, 8)) + ')</span></td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.session_data, 40)) + '</td>' +
            '<td>' + r.ratchet_counter + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at || '') + '</td>'
        ),
        'No sessions'
    );
    renderPaginationControls('sessions');
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
    tabTotals['dm-messages'] = rows.length;
    const p = paginate(rows, 'dm-messages');
    updateCount('dm-messages-count', p.total, ' records');
    renderTable('dm-message-list', 13,
        p.items.map(m =>
            '<td>' + escapeHtml(m.sender_username || m.sender_id) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(m.dm_channel_id) + '">' + escapeHtml(truncate(m.dm_channel_id, 12)) + '</td>' +
            '<td class="blob-cell" title="Click to expand">' + escapeHtml(truncate(m.encrypted_content, 50)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.nonce, 30)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(m.timestamp) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(m.id || '', 12)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(m.edited_at || '') + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.message_nonce || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.message_signature || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.encrypted_profile_key || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.profile_key_nonce || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.encrypted_banner_key || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.banner_key_nonce || '', 20)) + '</td>'
        ),
        'No DM messages'
    );
    renderPaginationControls('dm-messages');
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
    tabTotals['dm-keys'] = rows.length;
    const p = paginate(rows, 'dm-keys');
    updateCount('dm-keys-count', p.total);
    renderTable('dm-key-list', 8,
        p.items.map(r =>
            '<td class="id-cell" title="' + escapeHtml(r.dm_channel_id) + '">' + escapeHtml(truncate(r.dm_channel_id, 12)) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(r.user_id) + '">' + escapeHtml(truncate(r.user_id, 12)) + '</td>' +
            '<td>' + escapeHtml(r.username) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.encrypted_key, 40)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.sender_public_key, 40)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.nonce, 30)) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.device_id || '', 12)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at || '') + '</td>'
        ),
        'No DM keys'
    );
    renderPaginationControls('dm-keys');
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
    tabTotals['user-public-keys'] = rows.length;
    const p = paginate(rows, 'user-public-keys');
    updateCount('user-public-keys-count', p.total);
    renderTable('user-public-key-list', 9,
        p.items.map(r =>
            '<td>' + escapeHtml(r.username) + ' <span class="id-cell">(' + escapeHtml(truncate(r.user_id, 8)) + ')</span></td>' +
            '<td class="id-cell" title="' + escapeHtml(r.device_id) + '">' + escapeHtml(truncate(r.device_id, 12)) + '</td>' +
            '<td>' + escapeHtml(r.device_name || '') + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.identity_key, 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.signed_prekey || '', 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.signed_prekey_signature || '', 30)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.last_active_at || '') + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at || '') + '</td>'
        ),
        'No user devices'
    );
    renderPaginationControls('user-public-keys');
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
    tabTotals['files'] = rows.length;
    const p = paginate(rows, 'files');
    updateCount('files-count', p.total);
    renderTable('file-list', 10,
        p.items.map(r => {
            const size = r.file_size > 1048576 ? (r.file_size / 1048576).toFixed(1) + ' MB' :
                         r.file_size > 1024 ? (r.file_size / 1024).toFixed(1) + ' KB' : r.file_size + ' B';
            return '<td>' + escapeHtml(r.original_name) + '</td>' +
            '<td>' + escapeHtml(r.uploader_username) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.uploader_id || '', 12)) + '</td>' +
            '<td>' + escapeHtml(r.mime_type) + '</td>' +
            '<td>' + size + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.server_id || '-', 10)) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.channel_id || '-', 10)) + '</td>' +
            '<td>' + (r.chunk_count != null ? r.chunk_count : '') + '</td>' +
            '<td>' + (r.upload_complete ? 'Yes' : 'No') + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at) + '</td>';
        }),
        'No files'
    );
    renderPaginationControls('files');
}

// --- User Stickers ---
async function loadUserStickers() {
    try {
        const rows = await apiFetch('/api/admin/user-stickers');
        rawData.userStickers = Array.isArray(rows) ? rows : [];
        renderUserStickers(rawData.userStickers);
    } catch (err) {
        rawData.userStickers = [];
        renderUserStickers([]);
    }
}
function renderUserStickers(rows) {
    tabTotals['user-stickers'] = rows.length;
    const p = paginate(rows, 'user-stickers');
    updateCount('user-stickers-count', p.total);
    renderTable('user-sticker-list', 7,
        p.items.map(r =>
            '<td>' + escapeHtml(r.username) + '</td>' +
            '<td>' + escapeHtml(r.sticker_name || '(unnamed)') + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.file_id, 12)) + '</td>' +
            '<td>' + escapeHtml(r.mime_type || '') + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at || '') + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.encrypted_file_key || '', 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.file_key_nonce || '', 30)) + '</td>'
        ),
        'No user stickers'
    );
    renderPaginationControls('user-stickers');
}

// --- Server Stickers (removed — table dropped in migration 035) ---

// --- User Key Escrow ---
async function loadUserKeyEscrow() {
    try {
        const rows = await apiFetch('/api/admin/user-key-escrow');
        rawData.userKeyEscrow = Array.isArray(rows) ? rows : [];
        renderUserKeyEscrow(rawData.userKeyEscrow);
    } catch (err) {
        rawData.userKeyEscrow = [];
        renderUserKeyEscrow([]);
    }
}
function renderUserKeyEscrow(rows) {
    tabTotals['user-key-escrow'] = rows.length;
    const p = paginate(rows, 'user-key-escrow');
    updateCount('user-key-escrow-count', p.total);
    renderTable('user-key-escrow-list', 8,
        p.items.map(r =>
            '<td>' + escapeHtml(r.username) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.user_id, 12)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at || '') + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.updated_at || '') + '</td>' +
            '<td>' + (r.has_key ? 'Yes' : 'No') + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.encrypted_private_key || '', 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.salt || '', 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.nonce || '', 30)) + '</td>'
        ),
        'No key escrow records'
    );
    renderPaginationControls('user-key-escrow');
}

// --- Notification Sounds ---
async function loadNotificationSounds() {
    try {
        const rows = await apiFetch('/api/admin/notification-sounds');
        rawData.notificationSounds = Array.isArray(rows) ? rows : [];
        renderNotificationSounds(rawData.notificationSounds);
    } catch (err) {
        rawData.notificationSounds = [];
        renderNotificationSounds([]);
    }
}
function renderNotificationSounds(rows) {
    tabTotals['notification-sounds'] = rows.length;
    const p = paginate(rows, 'notification-sounds');
    updateCount('notification-sounds-count', p.total);
    renderTable('notification-sound-list', 8,
        p.items.map(r =>
            '<td>' + escapeHtml(r.username) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.user_id, 12)) + '</td>' +
            '<td>' + escapeHtml(r.file_name || '') + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.encrypted_sound, 40)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.nonce, 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.sender_public_key, 30)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at || '') + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.updated_at || '') + '</td>'
        ),
        'No notification sounds'
    );
    renderPaginationControls('notification-sounds');
}

// --- Admin Config ---
async function loadAdminConfig() {
    try {
        const rows = await apiFetch('/api/admin/admin-config');
        rawData.adminConfig = Array.isArray(rows) ? rows : [];
        renderAdminConfig(rawData.adminConfig);
    } catch (err) {
        rawData.adminConfig = [];
        renderAdminConfig([]);
    }
}
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

// --- User Device Escrow ---
async function loadUserDeviceEscrow() {
    try {
        const rows = await apiFetch('/api/admin/user-device-escrow');
        rawData.userDeviceEscrow = Array.isArray(rows) ? rows : [];
        renderUserDeviceEscrow(rawData.userDeviceEscrow);
    } catch (err) {
        rawData.userDeviceEscrow = [];
        renderUserDeviceEscrow([]);
    }
}
function renderUserDeviceEscrow(rows) {
    tabTotals['user-device-escrow'] = rows.length;
    const p = paginate(rows, 'user-device-escrow');
    updateCount('user-device-escrow-count', p.total);
    renderTable('user-device-escrow-list', 8,
        p.items.map(r =>
            '<td>' + escapeHtml(r.username) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.user_id, 12)) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.device_id || '', 12)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.encrypted_private_key || '', 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.salt || '', 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.nonce || '', 30)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at || '') + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.updated_at || '') + '</td>'
        ),
        'No device escrow records'
    );
    renderPaginationControls('user-device-escrow');
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

async function resetToFactory() {
    if (!confirm('Reset to factory defaults?')) return;
    if (!confirm('This will permanently wipe ALL data (users, servers, channels, messages, keys, files) and sign you out. The server will return to its fresh-install state, requiring a new admin password setup. Continue?')) return;
    try {
        const adminToken = sessionStorage.getItem('admin_token') || '';
        const res = await fetch('/api/admin/clear', {
            method: 'POST',
            headers: adminToken ? { 'Authorization': 'Bearer ' + adminToken } : {}
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Reset failed');
        // Clear admin auth from session storage
        sessionStorage.removeItem('admin_auth');
        sessionStorage.removeItem('admin_token');
        // Redirect to login page (admin panel will re-enter setup mode)
        window.location.href = 'login.html';
    } catch (err) {
        alert('Reset failed: ' + err.message);
    }
}
