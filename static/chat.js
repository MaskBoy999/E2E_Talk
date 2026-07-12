console.log('chat.js v6 loaded - true E2E encryption');

let ws = null;
let currentChannelId = null;
let currentServerId = null;
let user = null;
let servers = [];
let isOwner = false;
let currentInviteCode = null;
let viewMode = 'servers';
let currentDmChannelId = null;
let currentDmOtherUser = null;
let dmConversations = [];

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

    // Ensure identity keypair exists
    if (!E2ECrypto.getIdentityKeyPair()) {
        const kp = E2ECrypto.x25519GenerateKeyPair();
        E2ECrypto.saveIdentityKeyPair(kp);
    }

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

    document.addEventListener('click', (e) => {
        if (!membersPanelOpen) return;
        const panel = document.getElementById('members-panel');
        const toggle = document.getElementById('members-toggle');
        if (panel.contains(e.target) || toggle.contains(e.target)) return;
        membersPanelOpen = false;
        panel.classList.remove('open');
    });

    document.addEventListener('click', (e) => {
        if (!sidebar.classList.contains('open')) return;
        if (sidebar.contains(e.target) || hamburger.contains(e.target)) return;
        closeSidebar();
    });

    document.getElementById('add-server-btn').addEventListener('click', () => {
        showAddServerMenu();
    });

    document.getElementById('cancel-create-server').addEventListener('click', () => hideModal('create-server-modal'));
    document.getElementById('confirm-create-server').addEventListener('click', createServer);
    document.getElementById('new-server-name').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') createServer();
    });

    document.getElementById('cancel-join-server').addEventListener('click', () => hideModal('join-server-modal'));
    document.getElementById('confirm-join-server').addEventListener('click', joinServer);
    document.getElementById('invite-code-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') joinServer();
    });

    document.getElementById('close-invite').addEventListener('click', () => hideModal('invite-modal'));
    document.getElementById('invite-btn').addEventListener('click', showInviteModal);
    document.getElementById('regenerate-invite').addEventListener('click', regenerateInvite);

    document.getElementById('cancel-create-channel').addEventListener('click', () => hideModal('create-channel-modal'));
    document.getElementById('confirm-create-channel').addEventListener('click', createChannel);
    document.getElementById('new-channel-name').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') createChannel();
    });

    document.getElementById('members-toggle').addEventListener('click', toggleMembers);
    document.getElementById('members-close').addEventListener('click', toggleMembers);
    document.getElementById('leave-server-btn').addEventListener('click', leaveServer);
    document.getElementById('server-settings-btn').addEventListener('click', openServerSettings);
    document.getElementById('close-server-settings').addEventListener('click', () => {
        document.getElementById('server-settings-modal').style.display = 'none';
    });

    // DM listeners
    document.getElementById('dm-strip-btn').addEventListener('click', enterDmView);
    document.getElementById('cancel-dm-search').addEventListener('click', () => hideModal('dm-search-modal'));
    document.getElementById('confirm-dm-search').addEventListener('click', startDmByUsername);
    document.getElementById('dm-username-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') startDmByUsername();
    });

    document.getElementById('members-panel').classList.toggle('open', membersPanelOpen);

    // Polling intervals for auto-refresh
    setInterval(() => {
        if (viewMode === 'servers') loadServers();
    }, 5000);

    setInterval(() => {
        if (currentServerId && viewMode === 'servers') {
            loadChannels(currentServerId);
            loadMembers(currentServerId);
        }
    }, 5000);

    setInterval(() => {
        if (currentChannelId && viewMode === 'servers') {
            loadMessages(currentChannelId);
        }
    }, 5000);
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
            case 'ping':
                ws.send(JSON.stringify({ type: 'pong' }));
                break;
            case 'message_new':
                if (data.channel_id === currentChannelId && data.message) {
                    await appendMessage(data.message);
                }
                break;
            case 'dm_new':
                if (data.dm_channel_id && data.message) {
                    if (data.dm_channel_id === currentDmChannelId) {
                        const kp = E2ECrypto.getIdentityKeyPair();
                        let otherPubKey = '';
                        if (currentDmOtherUser) {
                            try {
                                const res = await authFetch('/api/identity/' + currentDmOtherUser.id);
                                const d = await res.json();
                                otherPubKey = d.identity_public_key;
                            } catch (_) {}
                        }
                        await appendDmMessage(data.message, kp, otherPubKey);
                    }
                    loadDmConversations();
                }
                break;
            case 'server_key_rotated':
                if (data.server_id) {
                    await fetchAndDecryptServerKey(data.server_id);
                    if (data.server_id === currentServerId && currentChannelId) {
                        await loadMessages(currentChannelId);
                    }
                }
                break;
            case 'member_joined':
                if (data.server_id && data.user_id) {
                    // Owner auto-uploads encrypted server key for new member
                    await uploadServerKeyForUser(data.server_id, data.user_id);
                    // Auto-refresh member list for everyone viewing this server
                    if (data.server_id === currentServerId) {
                        await loadMembers(data.server_id);
                    }
                }
                break;
            case 'member_kicked':
            case 'member_banned':
            case 'member_left':
                if (data.server_id) {
                    if (isOwner && data.server_id === currentServerId) {
                        await rotateServerKey(data.server_id);
                    }
                    if (data.server_id === currentServerId) {
                        await loadMembers(data.server_id);
                    }
                    if (data.user_id === user.id && data.server_id === currentServerId) {
                        currentServerId = null;
                        currentChannelId = null;
                        document.getElementById('server-name').textContent = '';
                        document.getElementById('channel-list').innerHTML = '<div class="channel-item" style="color:#666;cursor:default">Select a server</div>';
                        document.getElementById('channel-name').textContent = 'Select a channel';
                        document.getElementById('message-list').innerHTML = '<div class="welcome">Select a server and channel to start chatting</div>';
                        document.getElementById('message-input').disabled = true;
                        document.getElementById('send-btn').disabled = true;
                        await loadServers();
                    }
                }
                break;
            case 'server_deleted':
                if (data.server_id) {
                    if (data.server_id === currentServerId) {
                        currentServerId = null;
                        currentChannelId = null;
                        document.getElementById('server-name').textContent = '';
                        document.getElementById('channel-list').innerHTML = '<div class="channel-item" style="color:#666;cursor:default">Select a server</div>';
                        document.getElementById('channel-name').textContent = 'Select a channel';
                        document.getElementById('message-list').innerHTML = '<div class="welcome">This server has been deleted</div>';
                        document.getElementById('message-input').disabled = true;
                        document.getElementById('send-btn').disabled = true;
                    }
                    await loadServers();
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

// --- E2E Key Management ---

async function fetchAndDecryptServerKey(serverId) {
    try {
        const res = await authFetch(`/api/servers/${serverId}/keys`);
        if (!res.ok) return false;
        const keys = await res.json();
        if (!Array.isArray(keys) || keys.length === 0) return false;

        const identity = E2ECrypto.getIdentityKeyPair();
        if (!identity) return false;

        for (const entry of keys) {
            try {
                const serverKey = E2ECrypto.envelopeDecryptRaw(
                    entry.encrypted_key,
                    entry.nonce,
                    entry.sender_public_key,
                    identity.privateKey
                );
                E2ECrypto.saveServerKey(serverId, serverKey);
                return true;
            } catch (e) {
                continue;
            }
        }
        return false;
    } catch (err) {
        console.error('Failed to fetch server key:', err);
        return false;
    }
}

async function rotateServerKey(serverId) {
    const identity = E2ECrypto.getIdentityKeyPair();
    if (!identity) return false;

    // Generate a new server key
    const newKey = E2ECrypto.generateServerKey();
    E2ECrypto.saveServerKey(serverId, newKey);

    // Get all members of the server
    const membersRes = await authFetch(`/api/servers/${serverId}/members`);
    if (!membersRes.ok) return false;
    const members = await membersRes.json();
    if (!Array.isArray(members) || members.length === 0) return false;

    // Upload encrypted key for each member
    for (const member of members) {
        try {
            const recipientRes = await authFetch(`/api/identity/${member.id}`);
            if (!recipientRes.ok) continue;
            const recipientData = await recipientRes.json();
            if (!recipientData.identity_public_key) continue;
            const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(recipientData.identity_public_key));
            const encrypted = E2ECrypto.envelopeEncryptRaw(newKey, recipientPub);
            await authFetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: member.id,
                    encrypted_key: encrypted.ciphertext,
                    sender_public_key: encrypted.ephemeralPublicKey,
                    nonce: encrypted.nonce,
                }),
            });
        } catch (e) {
            console.error('Failed to upload rotated key for member', member.id, e);
        }
    }

    return true;
}

async function uploadServerKeyForUser(serverId, targetUserId) {
    const identity = E2ECrypto.getIdentityKeyPair();
    if (!identity) return false;

    const recipientRes = await authFetch(`/api/identity/${targetUserId}`);
    if (!recipientRes.ok) return false;
    const recipientData = await recipientRes.json();
    const recipientPubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(recipientData.identity_public_key));

    const serverKey = E2ECrypto.getServerKey(serverId);
    if (!serverKey) return false;

    const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, recipientPubKey);

    const uploadRes = await authFetch(`/api/servers/${serverId}/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            user_id: targetUserId,
            encrypted_key: encrypted.ciphertext,
            sender_public_key: encrypted.ephemeralPublicKey,
            nonce: encrypted.nonce,
        }),
    });
    return uploadRes.ok;
}

// --- Servers ---

async function loadServers() {
    try {
        const res = await authFetch('/api/servers');
        servers = await res.json();
        if (!Array.isArray(servers)) servers = [];
        renderServerList();

        // Fetch server keys for all servers we're missing keys for
        for (const s of servers) {
            if (!E2ECrypto.getServerKey(s.id)) {
                await fetchAndDecryptServerKey(s.id);
            }
        }

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
    document.getElementById('server-settings-btn').style.display = isOwner ? '' : 'none';

    // Ensure we have the server key
    if (!E2ECrypto.getServerKey(serverId)) {
        const ok = await fetchAndDecryptServerKey(serverId);
        if (!ok) {
            if (isOwner) {
                document.getElementById('channel-list').innerHTML = '<div class="channel-item" style="color:#f44336;cursor:default">Cannot decrypt server key. <a href="#" id="regenerate-server-key-btn" style="color:#4fc3f7;text-decoration:underline">Regenerate server key</a></div>';
                document.getElementById('regenerate-server-key-btn').addEventListener('click', async (e) => {
                    e.preventDefault();
                    document.getElementById('channel-list').innerHTML = '<div class="channel-item" style="color:#666;cursor:default">Regenerating server key...</div>';
                    const ok2 = await rotateServerKey(serverId);
                    if (ok2) {
                        await loadChannels(serverId);
                        loadMembers(serverId);
                    } else {
                        document.getElementById('channel-list').innerHTML = '<div class="channel-item" style="color:#f44336;cursor:default">Failed to regenerate server key</div>';
                    }
                });
            } else {
                document.getElementById('channel-list').innerHTML = '<div class="channel-item" style="color:#f44336;cursor:default">Cannot decrypt server key</div>';
            }
            return;
        }
    }

    renderServerList();
    await loadChannels(serverId);
    loadMembers(serverId);

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
            div.dataset.id = ch.id;
            div.dataset.name = ch.name;
            div.addEventListener('click', () => selectChannel(ch.id, ch.name, div));
            const nameSpan = document.createElement('span');
            nameSpan.textContent = `# ${ch.name}`;
            nameSpan.style.flex = '1';
            div.appendChild(nameSpan);
            if (isOwner) {
                const delBtn = document.createElement('button');
                delBtn.className = 'btn-delete-channel';
                delBtn.textContent = '\u00d7';
                delBtn.title = 'Delete channel';
                delBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    deleteChannel(ch.id, ch.name);
                });
                div.appendChild(delBtn);
            }
            list.appendChild(div);
        });

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
    if (msg.encrypted_content && msg.nonce && currentChannelId && currentServerId) {
        try {
            textContent = E2ECrypto.decrypt(msg.encrypted_content, msg.nonce, currentChannelId, currentServerId);
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

async function sendMessage() {
    if (viewMode === 'dms') { sendDmMessage(); return; }
    const input = document.getElementById('message-input');
    const content = input.value.trim();

    if (!content || !currentChannelId || !currentServerId) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    if (!E2ECrypto.getServerKey(currentServerId)) {
        console.error('No server key available');
        return;
    }

    var encrypted;
    try {
        encrypted = E2ECrypto.encrypt(content, currentChannelId, currentServerId);
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

// --- DM View ---

function enterDmView() {
    viewMode = 'dms';
    currentChannelId = null;
    currentServerId = null;
    document.getElementById('dm-strip-btn').classList.add('active');
    document.querySelectorAll('.server-icon:not(.add-server):not(.dm-strip-btn)').forEach(el => el.classList.remove('active'));
    document.getElementById('server-name').textContent = 'Direct Messages';
    document.getElementById('invite-btn').style.display = 'none';
    document.getElementById('server-settings-btn').style.display = 'none';
    document.getElementById('channel-name').textContent = 'Select a conversation';
    document.getElementById('message-input').disabled = true;
    document.getElementById('send-btn').disabled = true;
    document.getElementById('message-list').innerHTML = '<div class="welcome">Select a conversation to start chatting</div>';
    loadDmConversations();
}

async function loadDmConversations() {
    try {
        const res = await authFetch('/api/dm/conversations');
        if (!res.ok) {
            dmConversations = [];
        } else {
            dmConversations = await res.json();
        }
    } catch (e) {
        dmConversations = [];
    }
    renderDmSidebar();
}

function renderDmSidebar() {
    const container = document.getElementById('channel-list');
    let html = '<button class="create-dm-btn" id="new-dm-btn">+ New Message</button>';
    html += '<div class="channel-list dm-list" id="dm-list">';
    if (dmConversations.length === 0) {
        html += '<div style="color:#666;padding:12px;font-size:13px">No conversations yet</div>';
    }
    for (const c of dmConversations) {
        const initial = (c.other_username || '?').charAt(0).toUpperCase();
        let preview = '';
        if (c.last_message) {
            try {
                const kp = E2ECrypto.getIdentityKeyPair();
                preview = E2ECrypto.decryptDm(
                    c.last_message.encrypted_content, c.last_message.nonce,
                    c.dm_channel_id, kp.privateKey, c.other_public_key || ''
                );
                preview = preview.substring(0, 40);
            } catch (e) {
                preview = '[encrypted]';
            }
        }
        html += '<div class="channel-item dm-item" onclick="selectDmChannel(\'' + c.dm_channel_id + '\', \'' +
            escapeHtml(c.other_user_id) + '\', \'' + escapeHtml(c.other_username) + '\', this)">' +
            '<div class="dm-avatar">' + initial + '</div>' +
            '<div class="dm-info">' +
                '<div class="dm-name">' + escapeHtml(c.other_username) + '</div>' +
                '<div class="dm-preview">' + escapeHtml(preview) + '</div>' +
            '</div></div>';
    }
    html += '</div>';
    container.innerHTML = html;

    document.getElementById('new-dm-btn').addEventListener('click', () => {
        document.getElementById('dm-username-input').value = '';
        document.getElementById('dm-search-error').style.display = 'none';
        showModal('dm-search-modal');
    });
}

async function selectDmChannel(dmChannelId, otherUserId, otherUsername, element) {
    currentDmChannelId = dmChannelId;
    currentDmOtherUser = { id: otherUserId, username: otherUsername };
    currentChannelId = null;
    currentServerId = null;

    document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
    if (element) element.classList.add('active');

    document.getElementById('channel-name').textContent = otherUsername;
    document.getElementById('message-input').disabled = false;
    document.getElementById('send-btn').disabled = false;

    await loadDmMessages(dmChannelId, otherUserId);

    if (window._closeSidebar) window._closeSidebar();
}

async function loadDmMessages(dmChannelId, otherUserId) {
    const list = document.getElementById('message-list');
    list.innerHTML = '<div class="welcome">Loading messages...</div>';

    try {
        const res = await authFetch('/api/dm/' + dmChannelId + '/messages');
        const messages = await res.json();
        list.innerHTML = '';

        if (!Array.isArray(messages) || messages.length === 0) {
            list.innerHTML = '<div class="welcome">No messages yet. Say hello!</div>';
            return;
        }

        const kp = E2ECrypto.getIdentityKeyPair();
        const otherUserRes = await authFetch('/api/identity/' + otherUserId);
        const otherUserData = await otherUserRes.json();
        const otherPublicKey = otherUserData.identity_public_key;

        for (const msg of messages) {
            await appendDmMessage(msg, kp, otherPublicKey);
        }
    } catch (err) {
        console.error('Failed to load DM messages:', err);
        list.innerHTML = '<div class="welcome" style="color:#f44336">Failed to load messages</div>';
    }
}

async function appendDmMessage(msg, kp, otherPublicKey) {
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
    if (msg.encrypted_content && msg.nonce && kp && otherPublicKey) {
        try {
            textContent = E2ECrypto.decryptDm(msg.encrypted_content, msg.nonce, msg.dm_channel_id, kp.privateKey, otherPublicKey);
        } catch (e) {
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

async function sendDmMessage() {
    const input = document.getElementById('message-input');
    const content = input.value.trim();

    if (!content || !currentDmChannelId || !currentDmOtherUser) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const kp = E2ECrypto.getIdentityKeyPair();
    if (!kp) return;

    let otherPublicKey;
    try {
        const res = await authFetch('/api/identity/' + currentDmOtherUser.id);
        const data = await res.json();
        otherPublicKey = data.identity_public_key;
    } catch (e) {
        console.error('Failed to fetch other user key:', e);
        return;
    }

    var encrypted;
    try {
        encrypted = E2ECrypto.encryptDm(content, currentDmChannelId, kp.privateKey, otherPublicKey);
    } catch (e) {
        console.error('DM encryption failed:', e);
        return;
    }

    ws.send(JSON.stringify({
        type: 'dm_send',
        dm_channel_id: currentDmChannelId,
        encrypted_content: encrypted.ciphertext,
        nonce: encrypted.nonce,
    }));

    input.value = '';
}

async function startDmByUsername() {
    const username = document.getElementById('dm-username-input').value.trim();
    if (!username) return;

    const errDiv = document.getElementById('dm-search-error');
    errDiv.style.display = 'none';

    try {
        const res = await authFetch('/api/user/' + encodeURIComponent(username));
        if (!res.ok) {
            errDiv.textContent = 'User not found';
            errDiv.style.display = 'block';
            return;
        }
        const userData = await res.json();
        const targetUserId = userData.id;

        if (targetUserId === user.id) {
            errDiv.textContent = 'Cannot DM yourself';
            errDiv.style.display = 'block';
            return;
        }

        const dmRes = await authFetch('/api/dm/' + targetUserId, { method: 'POST' });
        const dmChannel = await dmRes.json();

        hideModal('dm-search-modal');
        await loadDmConversations();
        await selectDmChannel(dmChannel.id, targetUserId, username, null);
    } catch (e) {
        errDiv.textContent = 'Failed to start DM';
        errDiv.style.display = 'block';
    }
}

function enterServerView() {
    viewMode = 'servers';
    currentDmChannelId = null;
    currentDmOtherUser = null;
    document.getElementById('dm-strip-btn').classList.remove('active');
    document.getElementById('server-name').textContent = 'Select a server';
    loadServers();
}

// --- Members ---

let membersPanelOpen = window.innerWidth > 768;

function toggleMembers() {
    const panel = document.getElementById('members-panel');
    membersPanelOpen = !membersPanelOpen;
    panel.classList.toggle('open', membersPanelOpen);
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

        const leaveBtn = document.getElementById('leave-server-btn');
        leaveBtn.style.display = isOwner ? 'none' : '';

        members.forEach(m => {
            const div = document.createElement('div');
            div.className = 'member-item';
            const initial = (m.username || '?').charAt(0).toUpperCase();
            const isMemberOwner = m.role === 'owner';
            let actionBtns = '';
            if (isOwner && !isMemberOwner && m.id !== user.id) {
                actionBtns =
                    '<button class="btn-kick" onclick="kickMember(\'' + m.id + '\', \'' + escapeHtml(m.username) + '\')" title="Kick">&#10005;</button>' +
                    '<button class="btn-ban" onclick="banMember(\'' + m.id + '\', \'' + escapeHtml(m.username) + '\')" title="Ban">&#9888;</button>';
            }
            div.innerHTML =
                '<div class="member-avatar' + (isMemberOwner ? ' owner' : '') + '">' + initial + '</div>' +
                '<div>' +
                    '<div class="member-name">' + escapeHtml(m.username) + '</div>' +
                    (isMemberOwner ? '<div class="member-role">Owner</div>' : '') +
                '</div>' +
                '<div class="member-actions">' + actionBtns + '</div>';
            list.appendChild(div);
        });
    } catch (err) {
        console.error('Failed to load members:', err);
    }
}

async function kickMember(targetUserId, username) {
    if (!confirm('Kick ' + username + ' from this server? A new server key will be generated.')) return;
    try {
        const res = await authFetch(`/api/servers/${currentServerId}/members/kick`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: targetUserId }),
        });
        if (res.ok) {
            await loadMembers(currentServerId);
        } else {
            const err = await res.json();
            alert(err.error || 'Failed to kick member');
        }
    } catch (err) {
        console.error('Kick failed:', err);
    }
}

async function banMember(targetUserId, username) {
    if (!confirm('Ban ' + username + ' from this server? They will be removed and unable to rejoin.')) return;
    try {
        const res = await authFetch(`/api/servers/${currentServerId}/members/ban`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: targetUserId }),
        });
        if (res.ok) {
            await loadMembers(currentServerId);
        } else {
            const err = await res.json();
            alert(err.error || 'Failed to ban member');
        }
    } catch (err) {
        console.error('Ban failed:', err);
    }
}

async function leaveServer() {
    if (!confirm('Leave this server? You will lose access to all channels and messages.')) return;
    try {
        const res = await authFetch(`/api/servers/${currentServerId}/leave`, {
            method: 'POST',
        });
        const data = await res.json();
        if (res.ok) {
            currentServerId = null;
            currentChannelId = null;
            document.getElementById('server-name').textContent = '';
            document.getElementById('channel-list').innerHTML = '<div class="channel-item" style="color:#666;cursor:default">Select a server</div>';
            document.getElementById('channel-name').textContent = 'Select a channel';
            document.getElementById('message-list').innerHTML = '<div class="welcome">' +
                (data.server_deleted ? 'Server has been deleted' : 'Select a server and channel to start chatting') + '</div>';
            document.getElementById('message-input').disabled = true;
            document.getElementById('send-btn').disabled = true;
            await loadServers();
        } else {
            alert(data.error || 'Failed to leave server');
        }
    } catch (err) {
        console.error('Leave server failed:', err);
    }
}

async function deleteChannel(channelId, channelName) {
    if (!confirm('Delete channel #' + channelName + '? All messages will be lost.')) return;
    try {
        const res = await authFetch(`/api/channels/${channelId}`, {
            method: 'DELETE',
        });
        if (res.ok) {
            if (currentChannelId === channelId) {
                currentChannelId = null;
                document.getElementById('channel-name').textContent = 'Select a channel';
                document.getElementById('message-list').innerHTML = '<div class="welcome">Select a channel to start chatting</div>';
                document.getElementById('message-input').disabled = true;
                document.getElementById('send-btn').disabled = true;
            }
            await loadChannels(currentServerId);
        } else {
            const err = await res.json();
            alert(err.error || 'Failed to delete channel');
        }
    } catch (err) {
        console.error('Delete channel failed:', err);
    }
}

async function openServerSettings() {
    if (!currentServerId || !isOwner) return;
    document.getElementById('server-settings-modal').style.display = 'flex';
    await loadBannedUsers();
}

async function loadBannedUsers() {
    const list = document.getElementById('banned-users-list');
    list.innerHTML = '<div style="color:#666;padding:10px">Loading...</div>';
    try {
        const res = await authFetch(`/api/servers/${currentServerId}/bans`);
        if (!res.ok) {
            list.innerHTML = '<div style="color:#666;padding:10px">Failed to load</div>';
            return;
        }
        const bans = await res.json();
        if (!Array.isArray(bans) || bans.length === 0) {
            list.innerHTML = '<div style="color:#666;padding:10px">No banned users</div>';
            return;
        }
        list.innerHTML = '';
        bans.forEach(b => {
            const div = document.createElement('div');
            div.className = 'banned-item';
            div.innerHTML =
                '<span>' + escapeHtml(b.username) + '</span>' +
                '<button class="btn-unban" onclick="unbanUser(\'' + b.id + '\', \'' + escapeHtml(b.username) + '\')">Unban</button>';
            list.appendChild(div);
        });
    } catch (err) {
        list.innerHTML = '<div style="color:#f44336;padding:10px">Error loading bans</div>';
    }
}

async function unbanUser(targetUserId, username) {
    if (!confirm('Unban ' + username + '? They will be able to rejoin with an invite code.')) return;
    try {
        const res = await authFetch(`/api/servers/${currentServerId}/members/unban/${targetUserId}`, {
            method: 'POST',
        });
        if (res.ok) {
            await loadBannedUsers();
        } else {
            const err = await res.json();
            alert(err.error || 'Failed to unban');
        }
    } catch (err) {
        console.error('Unban failed:', err);
    }
}

// --- Server Actions ---

function showAddServerMenu() {
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
            const serverData = await res.json();

            const serverKey = E2ECrypto.generateServerKey();
            E2ECrypto.saveServerKey(serverData.id, serverKey);

            const identity = E2ECrypto.getIdentityKeyPair();
            if (identity) {
                const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
                const keyRes = await authFetch(`/api/servers/${serverData.id}/keys`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        user_id: user.id,
                        encrypted_key: encrypted.ciphertext,
                        sender_public_key: encrypted.ephemeralPublicKey,
                        nonce: encrypted.nonce,
                    }),
                });
                if (!keyRes.ok) {
                    console.error('Server key upload failed');
                }
            }

            hideModal('create-server-modal');
            await loadServers();
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
            const serverData = await res.json();
            hideModal('join-server-modal');
            await loadServers();

            // Retry fetching the server key (owner may need to upload it first)
            for (let attempt = 0; attempt < 5; attempt++) {
                const ok = await fetchAndDecryptServerKey(serverData.id);
                if (ok) break;
                await new Promise(r => setTimeout(r, 1000));
            }

            selectServer(serverData.id);
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
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
}

function showModal(id) {
    const el = document.getElementById(id);
    if (el) {
        el.style.display = 'flex';
    }
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
