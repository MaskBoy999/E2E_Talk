console.log('chat.js v7 loaded - hashed codes + true E2E encryption');

function generateCode(len) {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return code;
}

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
let unreadDms = {};
let pendingFriendRequests = 0;

const token = () => localStorage.getItem('token');
const authFetch = (url, opts = {}) => {
    opts.headers = { ...(opts.headers || {}), 'Authorization': 'Bearer ' + token() };
    return fetch(url, opts);
};

// The modern Clipboard API is restricted to HTTPS (or localhost). It also
// needs to be called directly from a click, so each copy button uses this
// helper to let the browser request access and to support plain HTTP locally.
async function copyToClipboard(text) {
    if (!text) return false;

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }

        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        if (copied) return true;
        throw new Error('Clipboard copy was rejected');
    } catch (error) {
        console.error('Clipboard copy failed:', error);
        alert('Clipboard access was blocked. Allow clipboard permission for this site, or open the app over HTTPS (or localhost) and try again.');
        return false;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const t = token();
    const userStr = localStorage.getItem('user');

    if (!t || !userStr) {
        window.location.href = 'login.html';
        return;
    }

    user = JSON.parse(userStr);
    document.getElementById('current-user').textContent = user.username;

    // A missing key means this browser has not been linked to this account.
    // Never generate a replacement on login: doing that makes prior messages
    // permanently unreadable and can overwrite another account's identity.
    if (!E2ECrypto.getIdentityKeyPair()) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        alert('This device is not linked to this account. Sign in with Connect with Local Key to import the account identity.');
        window.location.href = 'login.html';
        return;
    }

    // Settings modal
    const settingsBtn = document.getElementById('settings-btn');
    const settingsModal = document.getElementById('settings-modal');
    settingsBtn.addEventListener('click', () => { settingsModal.style.display = 'flex'; });
    document.getElementById('close-settings').addEventListener('click', () => { settingsModal.style.display = 'none'; });

    // Tab switching
    settingsModal.querySelectorAll('.settings-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            settingsModal.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
            settingsModal.querySelectorAll('.settings-panel').forEach(p => p.style.display = 'none');
            tab.classList.add('active');
            document.getElementById(tab.dataset.tab).style.display = 'block';
        });
    });

    // Identity key display in settings
    const kp = E2ECrypto.getIdentityKeyPair();
    if (kp) {
        const keyB64 = E2ECrypto.arrayBufferToBase64(kp.privateKey);
        const keyValue = document.getElementById('identity-key-value');
        keyValue.textContent = '••••••••••••••••';
        let keyVisible = false;
        document.getElementById('toggle-key-btn').addEventListener('click', () => {
            if (!keyVisible && !confirm('Anyone who sees this key can read all your messages. Continue?')) return;
            keyVisible = !keyVisible;
            keyValue.textContent = keyVisible ? keyB64 : '••••••••••••••••';
        });
        document.getElementById('copy-key-btn').addEventListener('click', () => {
            copyToClipboard(keyB64).then((copied) => {
                if (!copied) return;
                const btn = document.getElementById('copy-key-btn');
                btn.textContent = '✓';
                setTimeout(() => { btn.innerHTML = '&#128203;'; }, 1500);
            });
        });

        // QR Code generation for key transfer
        const showQrBtn = document.getElementById('show-qr-btn');
        const qrContainer = document.getElementById('qr-code-container');
        const qrCanvas = document.getElementById('qr-code-canvas');
        const hideQrBtn = document.getElementById('hide-qr-btn');

        if (showQrBtn) {
            showQrBtn.addEventListener('click', () => {
                if (!confirm('Anyone who photographs this QR code gains full control of your account. Continue?')) return;
                qrContainer.style.display = 'block';
                qrCanvas.innerHTML = '';
                try {
                    const qr = qrcode(0, 'M');
                    qr.addData(keyB64);
                    qr.make();
                    qrCanvas.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 4, alt: 'Identity key QR code', title: 'Scan to import identity key' });
                } catch (e) {
                    console.error('QR generation failed:', e);
                    qrCanvas.innerHTML = '<p style="color:#f44336">Failed to generate QR code</p>';
                }
            });
        }

        if (hideQrBtn) {
            hideQrBtn.addEventListener('click', () => {
                qrContainer.style.display = 'none';
            });
        }

        // Export QR as PNG
        const exportQrBtn = document.getElementById('export-qr-btn');
        if (exportQrBtn) {
            exportQrBtn.addEventListener('click', () => {
                const svgEl = qrCanvas.querySelector('svg');
                if (!svgEl) return;
                const svgData = new XMLSerializer().serializeToString(svgEl);
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                const img = new Image();
                img.onload = () => {
                    canvas.width = img.width;
                    canvas.height = img.height;
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(img, 0, 0);
                    const link = document.createElement('a');
                    link.download = 'e2e-chat-local-key-qr.png';
                    link.href = canvas.toDataURL('image/png');
                    link.click();
                };
                img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
            });
        }
    }

    // Delete account
    document.getElementById('delete-account-btn').addEventListener('click', async () => {
        if (!confirm('Are you sure you want to delete your account? This cannot be undone.')) return;
        if (!confirm('Really? All your messages, servers, and keys will be permanently lost.')) return;
        try {
            const res = await authFetch('/api/me', { method: 'DELETE' });
            if (res.ok) {
                localStorage.clear();
                if (ws) ws.close();
                window.location.href = 'login.html';
            } else {
                const err = await res.json();
                alert(err.error || 'Failed to delete account');
            }
        } catch (e) {
            alert('Failed to delete account');
        }
    });

    document.getElementById('logout-btn').addEventListener('click', () => {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        if (ws) ws.close();
        window.location.href = 'login.html';
    });

    connectWebSocket(t);
    loadServers();
    loadFriendRequestBadge();

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

    // Server choice modal buttons
    document.getElementById('cancel-server-choice').addEventListener('click', () => hideModal('server-choice-modal'));
    document.getElementById('choice-create-server').addEventListener('click', () => {
        hideModal('server-choice-modal');
        document.getElementById('create-server-modal').style.display = 'flex';
        document.getElementById('new-server-name').value = '';
        document.getElementById('new-server-name').focus();
    });
    document.getElementById('choice-join-server').addEventListener('click', () => {
        hideModal('server-choice-modal');
        document.getElementById('join-server-modal').style.display = 'flex';
        document.getElementById('invite-code-input').value = '';
        document.getElementById('invite-code-input').focus();
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

    // Toggle visibility for invite code input
    const toggleInviteCodeVis = document.getElementById('toggle-invite-code-visibility');
    const inviteCodeInput = document.getElementById('invite-code-input');
    if (toggleInviteCodeVis && inviteCodeInput) {
        let inviteCodeVisible = false;
        toggleInviteCodeVis.addEventListener('click', () => {
            inviteCodeVisible = !inviteCodeVisible;
            inviteCodeInput.type = inviteCodeVisible ? 'text' : 'password';
            toggleInviteCodeVis.innerHTML = inviteCodeVisible ? '&#128064;' : '&#128065;';
        });
    }

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

    // Friend listeners
    document.getElementById('cancel-add-friend').addEventListener('click', () => hideModal('add-friend-modal'));
    document.getElementById('confirm-add-friend').addEventListener('click', sendFriendRequest);
    document.getElementById('friend-code-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendFriendRequest();
    });
    document.getElementById('close-friend-requests').addEventListener('click', () => hideModal('friend-requests-modal'));

    // Toggle visibility for friend code input
    const toggleFriendCodeVis = document.getElementById('toggle-friend-code-visibility');
    const friendCodeInput = document.getElementById('friend-code-input');
    if (toggleFriendCodeVis && friendCodeInput) {
        let friendCodeVisible = false;
        toggleFriendCodeVis.addEventListener('click', () => {
            friendCodeVisible = !friendCodeVisible;
            friendCodeInput.type = friendCodeVisible ? 'text' : 'password';
            toggleFriendCodeVis.innerHTML = friendCodeVisible ? '&#128064;' : '&#128065;';
        });
    }

    // Import QR for friend code
    const friendImportQrBtn = document.getElementById('friend-import-qr-btn');
    const friendQrFileInput = document.getElementById('friend-qr-file-input');
    if (friendImportQrBtn && friendQrFileInput) {
        friendImportQrBtn.addEventListener('click', () => friendQrFileInput.click());
        friendQrFileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const decoded = await decodeQrFromFile(file);
                if (decoded) {
                    const input = document.getElementById('friend-code-input');
                    input.type = 'password';
                    input.value = decoded;
                } else {
                    alert('Could not read QR code from image.');
                }
            } catch (err) {
                alert('Error reading QR code: ' + err.message);
            }
            friendQrFileInput.value = '';
        });
    }

    // Import QR for join server
    const joinImportQrBtn = document.getElementById('join-import-qr-btn');
    const joinQrFileInput = document.getElementById('join-qr-file-input');
    if (joinImportQrBtn && joinQrFileInput) {
        joinImportQrBtn.addEventListener('click', () => joinQrFileInput.click());
        joinQrFileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const decoded = await decodeQrFromFile(file);
                if (decoded) {
                    const input = document.getElementById('invite-code-input');
                    input.type = 'password';
                    input.value = decoded;
                } else {
                    alert('Could not read QR code from image.');
                }
            } catch (err) {
                alert('Error reading QR code: ' + err.message);
            }
            joinQrFileInput.value = '';
        });
    }

    document.getElementById('members-panel').classList.toggle('open', membersPanelOpen);

    // No polling needed — WebSocket handles all live updates
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
                                otherPubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(d.identity_public_key));
                            } catch (_) {}
                        }
                        await appendDmMessage(data.message, kp, otherPubKey);
                    } else {
                        // Message is for a different DM channel - mark as unread
                        unreadDms[data.dm_channel_id] = (unreadDms[data.dm_channel_id] || 0) + 1;
                        updateDmStripBadge();
                        if (viewMode === 'dms') renderDmSidebar();
                    }
                    if (viewMode === 'dms') loadDmConversations();
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
                    if (isOwner) await uploadServerKeyForUser(data.server_id, data.user_id);
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
            case 'channel_created':
            case 'channel_deleted':
                if (data.server_id && data.server_id === currentServerId) {
                    await loadChannels(data.server_id);
                }
                break;
            case 'pong':
                break;
            case 'friend_request_received':
                loadFriendRequestBadge();
                break;
            case 'friend_request_accepted':
                if (viewMode === 'dms') loadDmConversations();
                break;
            case 'friend_removed':
                if (viewMode === 'dms') loadDmConversations();
                if (data.by_user_id && currentDmOtherUser && data.by_user_id === currentDmOtherUser.id) {
                    currentDmChannelId = null;
                    currentDmOtherUser = null;
                    document.getElementById('channel-name').textContent = 'Select a conversation';
                    document.getElementById('message-input').disabled = true;
                    document.getElementById('send-btn').disabled = true;
                    document.getElementById('message-list').innerHTML = '<div class="welcome">Select a conversation to start chatting</div>';
                }
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

        if (servers.length > 0 && !currentServerId) {
            selectServer(servers[0].id);
        } else if (servers.length === 0) {
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
    viewMode = 'servers';
    currentDmChannelId = null;
    currentDmOtherUser = null;
    currentServerId = serverId;
    currentChannelId = null;
    document.getElementById('dm-strip-btn').classList.remove('active');

    const server = servers.find(s => s.id === serverId);
    isOwner = server && server.is_owner;
    currentInviteCode = isOwner ? localStorage.getItem('e2e_invite_' + serverId) : null;

    document.getElementById('server-name').textContent = server ? server.name : '';
    document.getElementById('channel-name').textContent = 'Select a channel';
    document.getElementById('message-list').innerHTML = '<div class="welcome">Select a channel to start chatting</div>';
    document.getElementById('message-input').disabled = true;
    document.getElementById('send-btn').disabled = true;
    document.getElementById('invite-btn').style.display = isOwner ? '' : 'none';
    document.getElementById('server-settings-btn').style.display = isOwner ? '' : 'none';
    document.getElementById('members-toggle').style.display = '';

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

        if (window.innerWidth > 768 && !currentChannelId) {
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

    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
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
    document.getElementById('members-toggle').style.display = 'none';
    document.getElementById('members-panel').classList.remove('open');
    membersPanelOpen = false;
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
    loadMyFriendCode();
}

function renderDmSidebar() {
    const container = document.getElementById('channel-list');
    let html = '<div class="dm-header">';
    html += '<div class="identity-key-box" style="margin-bottom:10px">';
    html += '<span class="key-value" id="my-friend-code">••••••••••••••••</span>';
    html += '<button class="key-action-btn" id="toggle-friend-code-btn" title="Show/Hide">&#128065;</button>';
    html += '<button class="key-action-btn" id="copy-friend-code-btn" title="Copy">&#128203;</button>';
    html += '<button class="key-action-btn" id="friend-qr-btn" title="Show QR Code">&#128247;</button>';
    html += '</div>';
    html += '<div id="friend-qr-container" class="qr-code-container" style="display:none;margin-top:10px;margin-bottom:10px;">';
    html += '<div id="friend-qr-canvas" class="qr-code-canvas"></div>';
    html += '<p class="qr-warning">⚠️ This shows your friend code. Only show to trusted people.</p>';
    html += '<div class="qr-actions">';
    html += '<button id="hide-friend-qr-btn" class="key-action-btn">Hide QR Code</button>';
    html += '<button id="export-friend-qr-btn" class="key-action-btn qr-export-btn">⬇ Export QR</button>';
    html += '</div>';
    html += '</div>';
    html += '<div class="dm-actions">';
    html += '<button class="dm-action-btn" id="add-friend-btn">+ Add Friend</button>';
    html += '<button class="dm-action-btn friend-requests-btn" id="friend-requests-btn">Requests <span id="friend-request-badge" class="inline-badge" style="display:' + (pendingFriendRequests > 0 ? 'block' : 'none') + '"></span></button>';
    html += '</div></div>';
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
                    c.dm_channel_id, kp.privateKey,
                    c.other_public_key ? new Uint8Array(E2ECrypto.base64ToArrayBuffer(c.other_public_key)) : null
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
            '</div>' +
            (unreadDms[c.dm_channel_id] ? '<span class="badge"></span>' : '') +
            '</div>';
    }
    html += '</div>';
    container.innerHTML = html;

    document.getElementById('add-friend-btn').addEventListener('click', () => {
        document.getElementById('friend-code-input').value = '';
        document.getElementById('add-friend-error').style.display = 'none';
        showModal('add-friend-modal');
    });
    document.getElementById('friend-requests-btn').addEventListener('click', async () => {
        await loadFriendRequests();
        showModal('friend-requests-modal');
    });
}

async function selectDmChannel(dmChannelId, otherUserId, otherUsername, element) {
    currentDmChannelId = dmChannelId;
    currentDmOtherUser = { id: otherUserId, username: otherUsername };
    currentChannelId = null;
    currentServerId = null;

    document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
    if (element) element.classList.add('active');

    document.getElementById('channel-name').innerHTML = escapeHtml(otherUsername) +
        ' <button class="btn-unfriend" onclick="unfriend(\'' + escapeHtml(otherUserId) + '\', \'' + escapeHtml(otherUsername) + '\')" title="Unfriend">Unfriend</button>';
    document.getElementById('message-input').disabled = false;
    document.getElementById('send-btn').disabled = false;

    // Clear unread badge for this DM channel
    delete unreadDms[dmChannelId];
    updateDmStripBadge();
    renderDmSidebar();

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
        const otherPublicKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(otherUserData.identity_public_key));

        for (const msg of messages) {
            await appendDmMessage(msg, kp, otherPublicKey);
        }
    } catch (err) {
        console.error('Failed to load DM messages:', err);
        list.innerHTML = '<div class="welcome" style="color:#f44336">Failed to load messages</div>';
    }
}

function appendDmMessage(msg, kp, otherPublicKey) {
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
            const dmId = msg.dm_channel_id || currentDmChannelId;
            textContent = E2ECrypto.decryptDm(msg.encrypted_content, msg.nonce, dmId, kp.privateKey, otherPublicKey);
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

    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
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
        otherPublicKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
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

async function unfriend(otherUserId, otherUsername) {
    if (!confirm('Unfriend ' + otherUsername + '? The DM conversation and all messages will be deleted.')) return;
    try {
        const res = await authFetch('/api/friends/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: otherUserId }),
        });
        if (res.ok) {
            currentDmChannelId = null;
            currentDmOtherUser = null;
            document.getElementById('channel-name').textContent = 'Select a conversation';
            document.getElementById('message-input').disabled = true;
            document.getElementById('send-btn').disabled = true;
            document.getElementById('message-list').innerHTML = '<div class="welcome">Select a conversation to start chatting</div>';
            await loadDmConversations();
        } else {
            const err = await res.json();
            alert(err.error || 'Failed to unfriend');
        }
    } catch (err) {
        console.error('Unfriend failed:', err);
    }
}

function enterServerView() {
    viewMode = 'servers';
    currentDmChannelId = null;
    currentDmOtherUser = null;
    currentChannelId = null;
    currentServerId = null;
    document.getElementById('dm-strip-btn').classList.remove('active');
    document.getElementById('server-name').textContent = 'Select a server';
    document.getElementById('channel-name').textContent = 'Select a channel';
    document.getElementById('message-list').innerHTML = '<div class="welcome">Select a server and channel to start chatting</div>';
    document.getElementById('message-input').disabled = true;
    document.getElementById('send-btn').disabled = true;
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
        leaveBtn.style.display = '';

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
    const server = servers.find(s => s.id === currentServerId);
    const msg = isOwner
        ? 'Delete this server permanently? All channels, messages, and members will be removed. This cannot be undone.'
        : 'Leave this server? You will lose access to all channels and messages.';
    if (!confirm(msg)) return;
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
    document.getElementById('server-choice-modal').style.display = 'flex';
}

async function createServer() {
    const name = document.getElementById('new-server-name').value.trim();
    if (!name) return;

    try {
        // Generate invite code client-side, send only the hash
        const inviteCode = generateCode(8);
        const inviteCodeHash = E2ECrypto.sha256Hex(inviteCode);

        const res = await authFetch('/api/servers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, invite_code_hash: inviteCodeHash }),
        });

        if (res.ok) {
            const serverData = await res.json();
            localStorage.setItem('e2e_invite_' + serverData.id, inviteCode);

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
    const display = document.getElementById('invite-code-display');
    display.textContent = '••••••••••••••••';
    display.dataset.value = currentInviteCode;
    display.dataset.visible = '0';

    // Hide QR container when opening
    const inviteQrContainer = document.getElementById('invite-qr-container');
    if (inviteQrContainer) inviteQrContainer.style.display = 'none';

    const toggleBtn = document.getElementById('toggle-invite-btn');
    const copyBtn = document.getElementById('copy-invite-btn');
    const qrBtn = document.getElementById('invite-qr-btn');

    toggleBtn.onclick = () => {
        const vis = display.dataset.visible === '1';
        display.dataset.visible = vis ? '0' : '1';
        display.textContent = vis ? '••••••••••••••••' : display.dataset.value;
    };
    copyBtn.onclick = () => {
        copyToClipboard(display.dataset.value).then((copied) => {
            if (!copied) return;
            copyBtn.textContent = '✓';
            setTimeout(() => { copyBtn.innerHTML = '&#128203;'; }, 1500);
        });
    };

    // QR Code for invite code
    if (qrBtn) {
        qrBtn.onclick = () => {
            if (!confirm('Anyone who photographs this QR code can join this server. Continue?')) return;
            inviteQrContainer.style.display = 'block';
            const inviteQrCanvas = document.getElementById('invite-qr-canvas');
            inviteQrCanvas.innerHTML = '';
            try {
                const qr = qrcode(0, 'M');
                qr.addData(currentInviteCode);
                qr.make();
                inviteQrCanvas.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 4, alt: 'Invite code QR code', title: 'Scan to join server' });
            } catch (e) {
                console.error('QR generation failed:', e);
                inviteQrCanvas.innerHTML = '<p style="color:#f44336">Failed to generate QR code</p>';
            }
        };
    }

    // Hide invite QR button
    const hideInviteQrBtn = document.getElementById('hide-invite-qr-btn');
    if (hideInviteQrBtn) {
        hideInviteQrBtn.onclick = () => {
            inviteQrContainer.style.display = 'none';
        };
    }

    // Export invite QR as PNG
    const exportInviteQrBtn = document.getElementById('export-invite-qr-btn');
    if (exportInviteQrBtn) {
        exportInviteQrBtn.onclick = () => {
            const svgEl = document.getElementById('invite-qr-canvas').querySelector('svg');
            if (!svgEl) return;
            const svgData = new XMLSerializer().serializeToString(svgEl);
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const img = new Image();
            img.onload = () => {
                canvas.width = img.width;
                canvas.height = img.height;
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0);
                const link = document.createElement('a');
                link.download = 'e2e-chat-invite-code-qr.png';
                link.href = canvas.toDataURL('image/png');
                link.click();
            };
            img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
        };
    }

    document.getElementById('invite-modal').style.display = 'flex';
}

async function regenerateInvite() {
    if (!currentServerId) return;
    if (!confirm('Regenerate invite code? The old code will stop working immediately.')) return;

    try {
        const inviteCode = generateCode(8);
        const inviteCodeHash = E2ECrypto.sha256Hex(inviteCode);

        const res = await authFetch(`/api/servers/${currentServerId}/invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ invite_code_hash: inviteCodeHash }),
        });

        if (res.ok) {
            currentInviteCode = inviteCode;
            localStorage.setItem('e2e_invite_' + currentServerId, inviteCode);
            const display = document.getElementById('invite-code-display');
            display.dataset.value = inviteCode;
            display.dataset.visible = '0';
            display.textContent = '••••••••••••••••';
            // Hide QR container since the code changed
            const inviteQrContainer = document.getElementById('invite-qr-container');
            if (inviteQrContainer) inviteQrContainer.style.display = 'none';
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

// --- Friends ---

let myFriendCode = '';

async function loadMyFriendCode() {
    try {
        myFriendCode = localStorage.getItem('e2e_friend_code') || '';
        const el = document.getElementById('my-friend-code');
        if (el) {
            el.textContent = '••••••••••••••••';
            el.dataset.value = myFriendCode || '';
            el.dataset.visible = '0';
        }
        const toggleBtn = document.getElementById('toggle-friend-code-btn');
        const copyBtn = document.getElementById('copy-friend-code-btn');
        const qrBtn = document.getElementById('friend-qr-btn');
        const friendQrContainer = document.getElementById('friend-qr-container');
        if (toggleBtn && copyBtn && el) {
            toggleBtn.onclick = () => {
                const vis = el.dataset.visible === '1';
                el.dataset.visible = vis ? '0' : '1';
                el.textContent = vis ? '••••••••••••••••' : (el.dataset.value || '(none - re-register)');
            };
            copyBtn.onclick = () => {
                if (!el.dataset.value) return;
                copyToClipboard(el.dataset.value).then((copied) => {
                    if (!copied) return;
                    copyBtn.textContent = '✓';
                    setTimeout(() => { copyBtn.innerHTML = '&#128203;'; }, 1500);
                });
            };
            // QR Code for friend code
            if (qrBtn && friendQrContainer) {
                qrBtn.onclick = () => {
                    if (!el.dataset.value) {
                        alert('No friend code available. Please re-register.');
                        return;
                    }
                    if (!confirm('Anyone who photographs this QR code can send you a friend request. Continue?')) return;
                    friendQrContainer.style.display = 'block';
                    const friendQrCanvas = document.getElementById('friend-qr-canvas');
                    friendQrCanvas.innerHTML = '';
                    try {
                        const qr = qrcode(0, 'M');
                        qr.addData(el.dataset.value);
                        qr.make();
                        friendQrCanvas.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 4, alt: 'Friend code QR code', title: 'Scan to add as friend' });
                    } catch (e) {
                        console.error('QR generation failed:', e);
                        friendQrCanvas.innerHTML = '<p style="color:#f44336">Failed to generate QR code</p>';
                    }
                };
            }
            // Hide friend QR
            const hideFriendQrBtn = document.getElementById('hide-friend-qr-btn');
            if (hideFriendQrBtn) {
                hideFriendQrBtn.onclick = () => {
                    friendQrContainer.style.display = 'none';
                };
            }
            // Export friend QR as PNG
            const exportFriendQrBtn = document.getElementById('export-friend-qr-btn');
            if (exportFriendQrBtn) {
                exportFriendQrBtn.onclick = () => {
                    const svgEl = document.getElementById('friend-qr-canvas').querySelector('svg');
                    if (!svgEl) return;
                    const svgData = new XMLSerializer().serializeToString(svgEl);
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    const img = new Image();
                    img.onload = () => {
                        canvas.width = img.width;
                        canvas.height = img.height;
                        ctx.fillStyle = '#ffffff';
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        ctx.drawImage(img, 0, 0);
                        const link = document.createElement('a');
                        link.download = 'e2e-chat-friend-code-qr.png';
                        link.href = canvas.toDataURL('image/png');
                        link.click();
                    };
                    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
                };
            }
        }
    } catch (_) {}
    loadFriendRequestBadge();
}

async function loadFriendRequestBadge() {
    try {
        const res = await authFetch('/api/friends/requests/incoming');
        if (res.ok) {
            const requests = await res.json();
            pendingFriendRequests = Array.isArray(requests) ? requests.length : 0;
            const badge = document.getElementById('friend-request-badge');
            if (badge) {
                badge.style.display = pendingFriendRequests > 0 ? 'block' : 'none';
            }
            updateDmStripBadge();
        }
    } catch (_) {}
}

function updateDmStripBadge() {
    const badge = document.getElementById('dm-strip-badge');
    if (!badge) return;
    const hasNotifications = Object.keys(unreadDms).length > 0 || pendingFriendRequests > 0;
    badge.style.display = hasNotifications ? '' : 'none';
}

async function sendFriendRequest() {
    const code = document.getElementById('friend-code-input').value.trim().toUpperCase();
    if (!code) return;
    const errDiv = document.getElementById('add-friend-error');
    errDiv.style.display = 'none';
    try {
        const res = await authFetch('/api/friends/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ friend_code: code }),
        });
        const data = await res.json();
        if (res.ok) {
            hideModal('add-friend-modal');
            loadFriendRequestBadge();
        } else {
            errDiv.textContent = data.error || 'Failed to send request';
            errDiv.style.display = 'block';
        }
    } catch (_) {
        errDiv.textContent = 'Server error';
        errDiv.style.display = 'block';
    }
}

let cachedFriendRequests = [];

async function loadFriendRequests() {
    const list = document.getElementById('friend-requests-list');
    try {
        const res = await authFetch('/api/friends/requests/incoming');
        if (res.ok) {
            cachedFriendRequests = await res.json();
        } else {
            cachedFriendRequests = [];
        }
    } catch (_) {
        cachedFriendRequests = [];
    }
    if (!Array.isArray(cachedFriendRequests) || cachedFriendRequests.length === 0) {
        list.innerHTML = '<div style="color:#666;padding:16px;text-align:center">No incoming friend requests</div>';
        return;
    }
    let html = '';
    for (const r of cachedFriendRequests) {
        html += '<div class="friend-request-item">' +
            '<span class="friend-request-name">' + escapeHtml(r.from_username) + '</span>' +
            '<div class="friend-request-actions">' +
            '<button class="btn-accept" data-rid="' + r.id + '">Accept</button>' +
            '<button class="btn-decline" data-rid="' + r.id + '">Decline</button>' +
            '</div></div>';
    }
    list.innerHTML = html;
    list.querySelectorAll('.btn-accept').forEach(btn => {
        btn.addEventListener('click', () => acceptFriendRequest(btn.dataset.rid));
    });
    list.querySelectorAll('.btn-decline').forEach(btn => {
        btn.addEventListener('click', () => declineFriendRequest(btn.dataset.rid));
    });
}

async function acceptFriendRequest(requestId) {
    try {
        const res = await authFetch('/api/friends/requests/accept', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ request_id: requestId }),
        });
        if (res.ok) {
            await loadFriendRequests();
            loadFriendRequestBadge();
            if (viewMode === 'dms') loadDmConversations();
        }
    } catch (_) {}
}

async function declineFriendRequest(requestId) {
    try {
        const res = await authFetch('/api/friends/requests/decline', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ request_id: requestId }),
        });
        if (res.ok) {
            await loadFriendRequests();
            loadFriendRequestBadge();
        }
    } catch (_) {}
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

// --- QR Code Decode Helper ---
async function decodeQrFromFile(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);
            if (typeof jsQR !== 'undefined') {
                const code = jsQR(imageData.data, imageData.width, imageData.height);
                resolve(code ? code.data : null);
            } else if ('BarcodeDetector' in window) {
                const detector = new BarcodeDetector({ formats: ['qr_code'] });
                detector.detect(canvas).then(barcodes => {
                    resolve(barcodes.length > 0 ? barcodes[0].rawValue : null);
                }).catch(() => resolve(null));
            } else {
                reject(new Error('QR code scanning not supported in this browser'));
            }
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image'));
        };
        img.src = url;
    });
}
