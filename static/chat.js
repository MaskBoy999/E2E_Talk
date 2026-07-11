console.log('chat.js v5 loaded - server system');

let ws = null;
let currentChannelId = null;
let currentServerId = null;
let user = null;
let servers = [];
let isOwner = false;
let currentInviteCode = null;

const token = () => localStorage.getItem('token');
const authFetch = (url, opts = {}) => {
    opts.headers = { ...(opts.headers || {}), 'Authorization': 'Bearer ' + token() };
    return fetch(url, opts);
};

document.addEventListener('DOMContentLoaded', () => {
    const t = token();
    const userStr = localStorage.getItem('user');

    if (!t || !userStr) {
        window.location.href = 'login.html';
        return;
    }

    user = JSON.parse(userStr);
    document.getElementById('current-user').textContent = user.username;

    document.getElementById('logout-btn').addEventListener('click', () => {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        if (ws) ws.close();
        window.location.href = 'login.html';
    });

    connectWebSocket(t);
    loadServers();

    document.getElementById('send-btn').addEventListener('click', sendMessage);
    document.getElementById('message-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

    // Mobile sidebar
    const hamburger = document.getElementById('hamburger');
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const closeBtn = document.getElementById('sidebar-close');

    function openSidebar() {
        sidebar.classList.add('open');
        overlay.classList.add('open');
        // Close members panel if open
        if (membersPanelOpen) {
            membersPanelOpen = false;
            document.getElementById('members-panel').classList.remove('open');
        }
    }
    function closeSidebar() {
        sidebar.classList.remove('open');
        overlay.classList.remove('open');
    }

    hamburger.addEventListener('click', openSidebar);
    overlay.addEventListener('click', closeSidebar);
    closeBtn.addEventListener('click', closeSidebar);
    window._openSidebar = openSidebar;
    window._closeSidebar = closeSidebar;

    // Click outside members panel closes it
    document.addEventListener('click', (e) => {
        if (!membersPanelOpen) return;
        const panel = document.getElementById('members-panel');
        const toggle = document.getElementById('members-toggle');
        if (panel.contains(e.target) || toggle.contains(e.target)) return;
        membersPanelOpen = false;
        panel.classList.remove('open');
    });

    // Click outside sidebar closes it (mobile)
    document.addEventListener('click', (e) => {
        if (!sidebar.classList.contains('open')) return;
        if (sidebar.contains(e.target) || hamburger.contains(e.target)) return;
        closeSidebar();
    });

    // Add server button
    document.getElementById('add-server-btn').addEventListener('click', () => {
        showAddServerMenu();
    });

    // Create server modal
    document.getElementById('cancel-create-server').addEventListener('click', () => hideModal('create-server-modal'));
    document.getElementById('confirm-create-server').addEventListener('click', createServer);
    document.getElementById('new-server-name').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') createServer();
    });

    // Join server modal
    document.getElementById('cancel-join-server').addEventListener('click', () => hideModal('join-server-modal'));
    document.getElementById('confirm-join-server').addEventListener('click', joinServer);
    document.getElementById('invite-code-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') joinServer();
    });

    // Invite modal
    document.getElementById('close-invite').addEventListener('click', () => hideModal('invite-modal'));
    document.getElementById('invite-btn').addEventListener('click', showInviteModal);
    document.getElementById('regenerate-invite').addEventListener('click', regenerateInvite);

    // Create channel modal
    document.getElementById('cancel-create-channel').addEventListener('click', () => hideModal('create-channel-modal'));
    document.getElementById('confirm-create-channel').addEventListener('click', createChannel);
    document.getElementById('new-channel-name').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') createChannel();
    });

    // Members panel toggle
    document.getElementById('members-toggle').addEventListener('click', toggleMembers);
    document.getElementById('members-close').addEventListener('click', toggleMembers);

    // Initialize members panel state
    document.getElementById('members-panel').classList.toggle('open', membersPanelOpen);
});

// --- WebSocket ---

function connectWebSocket(t) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'auth', token: t }));
    };

    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);

        switch (data.type) {
            case 'auth_ok':
                break;
            case 'auth_error':
                localStorage.removeItem('token');
                localStorage.removeItem('user');
                window.location.href = 'login.html';
                break;
            case 'message_new':
                if (data.channel_id === currentChannelId && data.message) {
                    await appendMessage(data.message);
                }
                break;
            case 'pong':
                break;
        }
    };

    ws.onclose = () => {
        setTimeout(() => connectWebSocket(t), 3000);
    };
}

// --- Servers ---

async function loadServers() {
    try {
        const res = await authFetch('/api/servers');
        servers = await res.json();
        if (!Array.isArray(servers)) servers = [];
        renderServerList();
        if (servers.length > 0) {
            selectServer(servers[0].id);
        } else {
            document.getElementById('server-name').textContent = 'No servers yet';
            document.getElementById('channel-list').innerHTML = '<div class="channel-item" style="color:#666;cursor:default">Create or join a server</div>';
        }
    } catch (err) {
        console.error('Failed to load servers:', err);
    }
}

function renderServerList() {
    const list = document.getElementById('server-list');
    list.innerHTML = '';

    servers.forEach(s => {
        const div = document.createElement('div');
        div.className = 'server-icon' + (s.id === currentServerId ? ' active' : '');
        div.textContent = s.name.charAt(0).toUpperCase();
        div.title = s.name;
        div.dataset.id = s.id;
        div.addEventListener('click', () => selectServer(s.id));
        list.appendChild(div);
    });
}

async function selectServer(serverId) {
    currentServerId = serverId;
    currentChannelId = null;

    const server = servers.find(s => s.id === serverId);
    isOwner = server && server.is_owner;
    currentInviteCode = server ? server.invite_code : null;

    document.getElementById('server-name').textContent = server ? server.name : '';
    document.getElementById('invite-btn').style.display = isOwner ? '' : 'none';

    renderServerList();
    await loadChannels(serverId);
    loadMembers(serverId);

    // On mobile, auto-open sidebar when tapping a server
    if (window.innerWidth <= 768 && window._openSidebar) {
        window._openSidebar();
    } else if (window._closeSidebar) {
        window._closeSidebar();
    }
}

// --- Channels ---

async function loadChannels(serverId) {
    try {
        const res = await authFetch(`/api/servers/${serverId}/channels`);
        const channels = await res.json();
        const list = document.getElementById('channel-list');
        list.innerHTML = '';

        if (!Array.isArray(channels) || channels.length === 0) {
            list.innerHTML = '<div class="channel-item" style="color:#666;cursor:default">No channels yet</div>';
            document.getElementById('channel-name').textContent = 'Select a channel';
            document.getElementById('message-input').disabled = true;
            document.getElementById('send-btn').disabled = true;
            return;
        }

        channels.forEach(ch => {
            const div = document.createElement('div');
            div.className = 'channel-item';
            div.textContent = `# ${ch.name}`;
            div.dataset.id = ch.id;
            div.dataset.name = ch.name;
            div.addEventListener('click', () => selectChannel(ch.id, ch.name, div));
            list.appendChild(div);
        });

        // Add create channel button inside the scrollable list (owner only)
        if (isOwner) {
            const btn = document.createElement('button');
            btn.className = 'create-channel-btn';
            btn.textContent = '+ Channel';
            btn.addEventListener('click', () => {
                document.getElementById('create-channel-modal').style.display = 'flex';
                document.getElementById('new-channel-name').value = '';
                document.getElementById('new-channel-name').focus();
            });
            list.appendChild(btn);
        }

        // Auto-select first channel on desktop; on mobile, user taps to select
        if (window.innerWidth > 768) {
            list.children[0].click();
        }
    } catch (err) {
        console.error('Failed to load channels:', err);
    }
}

async function selectChannel(channelId, channelName, element) {
    currentChannelId = channelId;

    document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
    element.classList.add('active');

    document.getElementById('channel-name').textContent = `# ${channelName}`;
    document.getElementById('message-input').disabled = false;
    document.getElementById('send-btn').disabled = false;

    await loadMessages(channelId);

    if (window._closeSidebar) window._closeSidebar();
}

// --- Messages ---

async function loadMessages(channelId) {
    const list = document.getElementById('message-list');
    list.innerHTML = '<div class="welcome">Loading messages...</div>';

    try {
        const res = await authFetch(`/api/channels/${channelId}/messages`);
        const messages = await res.json();

        list.innerHTML = '';

        if (!Array.isArray(messages) || messages.length === 0) {
            list.innerHTML = '<div class="welcome">No messages yet. Say hello!</div>';
            return;
        }

        for (const msg of messages) {
            await appendMessage(msg);
        }
    } catch (err) {
        console.error('Failed to load messages:', err);
        list.innerHTML = '<div class="welcome" style="color:#f44336">Failed to load messages</div>';
    }
}

async function appendMessage(msg) {
    const list = document.getElementById('message-list');
    const div = document.createElement('div');
    div.className = 'message';

    const initial = (msg.sender_username || '?').charAt(0).toUpperCase();
    let time = '';
    try {
        time = new Date(msg.timestamp).toLocaleTimeString();
    } catch (e) {
        time = msg.timestamp || '';
    }

    let textContent = '';
    if (msg.encrypted_content && msg.nonce && currentChannelId) {
        try {
            textContent = E2ECrypto.decrypt(msg.encrypted_content, msg.nonce, currentChannelId);
        } catch (e) {
            console.warn('Decrypt failed:', e);
            textContent = '[encrypted message - unable to decrypt]';
        }
    }

    div.innerHTML =
        '<div class="avatar">' + initial + '</div>' +
        '<div class="content">' +
            '<div class="header">' +
                '<span class="username">' + escapeHtml(msg.sender_username || 'unknown') + '</span>' +
                '<span class="time">' + time + '</span>' +
            '</div>' +
            '<div class="text">' + escapeHtml(textContent) + '</div>' +
        '</div>';

    list.prepend(div);
    list.scrollTop = 0;
}

// --- Send ---

// --- Members ---

let membersPanelOpen = window.innerWidth > 768;

function toggleMembers() {
    const panel = document.getElementById('members-panel');
    membersPanelOpen = !membersPanelOpen;
    panel.classList.toggle('open', membersPanelOpen);
    // Close sidebar if open on mobile
    if (membersPanelOpen && window.innerWidth <= 768) {
        window._closeSidebar();
    }
}

async function loadMembers(serverId) {
    try {
        const res = await authFetch(`/api/servers/${serverId}/members`);
        const members = await res.json();
        const list = document.getElementById('member-list');
        list.innerHTML = '';

        if (!Array.isArray(members) || members.length === 0) return;

        members.forEach(m => {
            const div = document.createElement('div');
            div.className = 'member-item';
            const initial = (m.username || '?').charAt(0).toUpperCase();
            const isOwner = m.role === 'owner';
            div.innerHTML =
                '<div class="member-avatar' + (isOwner ? ' owner' : '') + '">' + initial + '</div>' +
                '<div>' +
                    '<div class="member-name">' + escapeHtml(m.username) + '</div>' +
                    (isOwner ? '<div class="member-role">Owner</div>' : '') +
                '</div>';
            list.appendChild(div);
        });
    } catch (err) {
        console.error('Failed to load members:', err);
    }
}

// --- Send ---

async function sendMessage() {
    const input = document.getElementById('message-input');
    const content = input.value.trim();

    if (!content || !currentChannelId) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    var encrypted;
    try {
        encrypted = E2ECrypto.encrypt(content, currentChannelId);
    } catch (e) {
        console.error('Encryption failed:', e);
        return;
    }

    ws.send(JSON.stringify({
        type: 'message_send',
        channel_id: currentChannelId,
        encrypted_content: encrypted.ciphertext,
        nonce: encrypted.nonce,
    }));

    input.value = '';
}

// --- Server Actions ---

function showAddServerMenu() {
    // Show a simple choice: create or join
    const choice = confirm('Click OK to CREATE a new server\nClick Cancel to JOIN with an invite code');
    if (choice) {
        document.getElementById('create-server-modal').style.display = 'flex';
        document.getElementById('new-server-name').value = '';
        document.getElementById('new-server-name').focus();
    } else {
        document.getElementById('join-server-modal').style.display = 'flex';
        document.getElementById('invite-code-input').value = '';
        document.getElementById('invite-code-input').focus();
    }
}

async function createServer() {
    const name = document.getElementById('new-server-name').value.trim();
    if (!name) return;

    try {
        const res = await authFetch('/api/servers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });

        if (res.ok) {
            hideModal('create-server-modal');
            await loadServers();
            // Auto-select the new server
            if (servers.length > 0) {
                selectServer(servers[servers.length - 1].id);
            }
        } else {
            const err = await res.json();
            alert(err.error || 'Failed to create server');
        }
    } catch (err) {
        console.error('Create server failed:', err);
    }
}

async function joinServer() {
    const code = document.getElementById('invite-code-input').value.trim();
    if (!code) return;

    try {
        const res = await authFetch('/api/invites/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
        });

        if (res.ok) {
            hideModal('join-server-modal');
            await loadServers();
            const server = await res.json();
            selectServer(server.id);
        } else {
            const err = await res.json();
            alert(err.error || 'Invalid invite code');
        }
    } catch (err) {
        console.error('Join server failed:', err);
    }
}

async function showInviteModal() {
    if (!currentServerId || !currentInviteCode) return;
    document.getElementById('invite-code-display').textContent = currentInviteCode;
    document.getElementById('invite-modal').style.display = 'flex';
}

async function regenerateInvite() {
    if (!currentServerId) return;
    if (!confirm('Regenerate invite code? The old code will stop working immediately.')) return;

    try {
        const res = await authFetch(`/api/servers/${currentServerId}/invite`, {
            method: 'POST',
        });

        if (res.ok) {
            const data = await res.json();
            currentInviteCode = data.code;
            document.getElementById('invite-code-display').textContent = data.code;
            // Update cached server data
            const server = servers.find(s => s.id === currentServerId);
            if (server) server.invite_code = data.code;
        } else {
            const err = await res.json();
            alert(err.error || 'Failed to regenerate invite');
        }
    } catch (err) {
        console.error('Regenerate invite failed:', err);
    }
}

async function createChannel() {
    const name = document.getElementById('new-channel-name').value.trim();
    if (!name || !currentServerId) return;

    try {
        const res = await authFetch(`/api/servers/${currentServerId}/channels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });

        if (res.ok) {
            hideModal('create-channel-modal');
            await loadChannels(currentServerId);
        } else {
            const err = await res.json();
            alert(err.error || 'Failed to create channel');
        }
    } catch (err) {
        console.error('Create channel failed:', err);
    }
}

// --- Helpers ---

function hideModal(id) {
    document.getElementById(id).style.display = 'none';
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
