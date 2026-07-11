console.log('chat.js v4 loaded');

let ws = null;
let currentChannelId = null;
let user = null;

document.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('token');
    const userStr = localStorage.getItem('user');

    if (!token || !userStr) {
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

    connectWebSocket(token);
    loadChannels();

    const input = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');

    sendBtn.addEventListener('click', sendMessage);
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

    const hamburger = document.getElementById('hamburger');
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const closeBtn = document.getElementById('sidebar-close');

    function openSidebar() {
        sidebar.classList.add('open');
        overlay.classList.add('open');
    }
    function closeSidebar() {
        sidebar.classList.remove('open');
        overlay.classList.remove('open');
    }

    hamburger.addEventListener('click', openSidebar);
    overlay.addEventListener('click', closeSidebar);
    closeBtn.addEventListener('click', closeSidebar);

    window._closeSidebar = closeSidebar;
});

function connectWebSocket(token) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
        console.log('WebSocket connected, sending auth...');
        ws.send(JSON.stringify({ type: 'auth', token: token }));
    };

    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        console.log('WS received:', data.type);

        switch (data.type) {
            case 'auth_ok':
                console.log('Authenticated as', data.username);
                break;
            case 'auth_error':
                console.error('Auth error:', data.error);
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

    ws.onclose = (event) => {
        console.log('WebSocket disconnected, reconnecting in 3s...');
        setTimeout(() => connectWebSocket(token), 3000);
    };

    ws.onerror = (err) => {
        console.error('WebSocket error:', err);
    };
}

async function loadChannels() {
    try {
        const res = await fetch('/api/channels');
        const data = await res.json();

        const channels = Array.isArray(data) ? data : [];
        const list = document.getElementById('channel-list');
        list.innerHTML = '';

        if (channels.length === 0) {
            list.innerHTML = '<div class="channel-item" style="color:#666;cursor:default">No channels yet</div>';
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

        list.children[0].click();
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

async function loadMessages(channelId) {
    const list = document.getElementById('message-list');
    list.innerHTML = '<div class="welcome">Loading messages...</div>';

    try {
        const res = await fetch(`/api/channels/${channelId}/messages`);
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

async function sendMessage() {
    const input = document.getElementById('message-input');
    const content = input.value.trim();

    if (!content || !currentChannelId) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('WebSocket not connected, cannot send');
        return;
    }

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

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
