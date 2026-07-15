console.log('chat.js v13 loaded - grouped files + inline audio');

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
let isUploading = false;
let selectedFiles = [];
let currentFileIndex = 0;

const token = () => localStorage.getItem('token');
const authFetch = (url, opts = {}) => {
    opts.headers = { ...(opts.headers || {}), 'Authorization': 'Bearer ' + token() };
    return fetch(url, opts);
};

// JWT helpers
function decodeJwtPayload(t) {
    try {
        const base64Url = t.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        return JSON.parse(jsonPayload);
    } catch (_) { return null; }
}

function getTokenExpiresAt(t) {
    const payload = decodeJwtPayload(t);
    return payload && payload.exp ? payload.exp * 1000 : null;
}

function checkTokenExpiry() {
    const t = token();
    if (!t) return;
    const expiresAt = getTokenExpiresAt(t);
    if (!expiresAt) return;
    if (Date.now() >= expiresAt) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.href = 'login.html';
        return;
    }
    const msLeft = expiresAt - Date.now();
    const delay = Math.min(Math.max(msLeft - 5000, 0), 2147483647);
    setTimeout(() => {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.href = 'login.html';
    }, delay);
}

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
    checkTokenExpiry();

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

    // Security tab - session countdown
    function updateSessionCountdown() {
        const countdownEl = document.getElementById('session-countdown');
        if (!countdownEl) return;
        const expiresAt = getTokenExpiresAt(token());
        if (!expiresAt) { countdownEl.textContent = 'Unknown'; return; }
        const msLeft = expiresAt - Date.now();
        if (msLeft <= 0) { countdownEl.textContent = 'Expired'; return; }
        const days = Math.floor(msLeft / 86400000);
        const hours = Math.floor((msLeft % 86400000) / 3600000);
        const minutes = Math.floor((msLeft % 3600000) / 60000);
        countdownEl.textContent = days + 'd ' + hours + 'h ' + minutes + 'm';
    }
    updateSessionCountdown();
    setInterval(updateSessionCountdown, 60000);

    // Re-auth button
    const reauthBtn = document.getElementById('reauth-btn');
    const reauthSection = document.getElementById('reauth-section');
    const reauthConfirmBtn = document.getElementById('reauth-confirm-btn');
    const reauthError = document.getElementById('reauth-error');

    if (reauthBtn) {
        reauthBtn.addEventListener('click', () => {
            reauthSection.style.display = reauthSection.style.display === 'none' ? 'block' : 'none';
            reauthError.style.display = 'none';
        });
    }

    if (reauthConfirmBtn) {
        reauthConfirmBtn.addEventListener('click', async () => {
            const password = document.getElementById('reauth-password').value;
            if (!password) { reauthError.textContent = 'Enter your password'; reauthError.style.display = 'block'; return; }
            try {
                const res = await fetch('/api/reauth', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token()
                    },
                    body: JSON.stringify({ password })
                });
                const data = await res.json();
                if (!res.ok) {
                    reauthError.textContent = data.error || 'Re-authentication failed';
                    reauthError.style.display = 'block';
                    return;
                }
                localStorage.setItem('token', data.token);
                localStorage.setItem('user', JSON.stringify(data.user));
                reauthSection.style.display = 'none';
                document.getElementById('reauth-password').value = '';
                updateSessionCountdown();
                alert('Session extended by 30 days');
            } catch (e) {
                reauthError.textContent = 'Server is not running';
                reauthError.style.display = 'block';
            }
        });
    }

    connectWebSocket(t);
    setupMessageActions();
    setupForwardModal();
    loadServers();
    loadFriendRequestBadge();

    document.getElementById('send-btn').addEventListener('click', sendMessage);
    document.getElementById('message-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

    // File upload
    document.getElementById('attach-btn').addEventListener('click', () => {
        if (!currentChannelId && !currentDmChannelId) return;
        document.getElementById('file-input').click();
    });
    document.getElementById('file-input').addEventListener('change', handleFileSelect);
    document.getElementById('cancel-upload').addEventListener('click', closeUploadModal);

    // Drag and drop support for file uploads
    setupDragAndDrop();
    document.getElementById('confirm-upload').addEventListener('click', startFileUpload);

    // "Add More Files" button in upload modal
    document.getElementById('add-more-files').addEventListener('click', () => {
        document.getElementById('add-more-file-input').click();
    });
    document.getElementById('add-more-file-input').addEventListener('change', (e) => {
        const newFiles = Array.from(e.target.files);
        if (newFiles.length === 0) return;
        const oversized = newFiles.find(f => f.size > 1024 * 1024 * 1024);
        if (oversized) {
            alert('File too large: ' + oversized.name + '. Maximum file size is 1 GB.');
            e.target.value = '';
            return;
        }
        selectedFiles = selectedFiles.concat(newFiles);
        renderUploadPreview();
        document.getElementById('confirm-upload').textContent = selectedFiles.length > 1 ? 'Upload All (' + selectedFiles.length + ')' : 'Upload';
        e.target.value = '';
    });
    document.getElementById('media-viewer-close').addEventListener('click', closeMediaViewer);
    document.getElementById('media-viewer-backdrop').addEventListener('click', closeMediaViewer);

    // Event delegation for file download buttons
    document.getElementById('message-list').addEventListener('click', (e) => {
        const dlBtn = e.target.closest('.file-download-btn');
        if (dlBtn) {
            const card = dlBtn.closest('.file-card, .audio-file-card');
            if (card) {
                downloadFileById(
                    card.dataset.fileId,
                    card.dataset.fileKey,
                    card.dataset.fileName,
                    card.dataset.fileMime,
                    parseInt(card.dataset.fileSize, 10) || 0
                );
            }
        }
    });

    // Event delegation for multi-file gallery navigation
    document.getElementById('message-list').addEventListener('click', (e) => {
        const navBtn = e.target.closest('.msg-gallery-btn');
        if (navBtn) {
            const gallery = navBtn.closest('.msg-file-gallery');
            if (!gallery) return;
            const dir = parseInt(navBtn.dataset.dir);
            let idx = parseInt(gallery.dataset.index);
            const total = parseInt(gallery.dataset.total);
            idx = Math.max(0, Math.min(total - 1, idx + dir));
            gallery.dataset.index = idx;
            // Update active item
            gallery.querySelectorAll('.msg-gallery-item').forEach(item => {
                const isTarget = parseInt(item.dataset.idx) === idx;
                item.classList.toggle('active', isTarget);
                item.style.display = isTarget ? '' : 'none';
            });
            // Update strip
            gallery.querySelectorAll('.msg-gallery-strip-item').forEach(item => {
                item.classList.toggle('active', parseInt(item.dataset.idx) === idx);
            });
            // Update counter
            const counter = gallery.querySelector('.msg-gallery-counter');
            if (counter) counter.textContent = (idx + 1) + ' / ' + total;
            // Update prev/next disabled state
            const prev = gallery.querySelector('.msg-gallery-prev');
            const next = gallery.querySelector('.msg-gallery-next');
            if (prev) prev.disabled = idx === 0;
            if (next) next.disabled = idx === total - 1;
        }
        // Click on strip item
        const stripItem = e.target.closest('.msg-gallery-strip-item');
        if (stripItem) {
            const gallery = stripItem.closest('.msg-file-gallery');
            if (!gallery) return;
            const idx = parseInt(stripItem.dataset.idx);
            gallery.dataset.index = idx;
            updateGalleryState(gallery, idx);
        }
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

    // Event delegation for member action buttons (kick/ban/unban)
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const userId = btn.dataset.userId;
        const username = btn.dataset.username;
        if (action === 'kick') kickMember(userId, username);
        else if (action === 'ban') banMember(userId, username);
        else if (action === 'unban') unbanUser(userId, username);
    });

    // Prevent browser from opening dropped files globally
    document.addEventListener('dragover', (e) => { e.preventDefault(); });
    document.addEventListener('drop', (e) => { e.preventDefault(); });
    
    // Setup drag-and-drop for the upload modal
    setupModalDragAndDrop();

    // No polling needed — WebSocket handles all live updates
});

// --- WebSocket ---

function connectWebSocket(t) {
    const isSecure = window.location.protocol === 'https:';
    if (!isSecure && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
        console.warn('WARNING: WebSocket running over unencrypted ws://. Use HTTPS for secure connections.');
    }
    const protocol = isSecure ? 'wss:' : 'ws:';
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
            case 'message_edited':
                if (data.channel_id === currentChannelId && data.message) {
                    handleEditedMessage(data.message, 'channel');
                }
                break;
            case 'message_deleted':
                if (data.channel_id === currentChannelId && data.message_id) {
                    handleDeletedMessage(data.message_id);
                }
                break;
            case 'dm_edited':
                if (data.dm_channel_id === currentDmChannelId && data.message) {
                    handleEditedMessage(data.message, 'dm');
                }
                break;
            case 'dm_deleted':
                if (data.dm_channel_id === currentDmChannelId && data.message_id) {
                    handleDeletedMessage(data.message_id);
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
    // Clean up old blob URLs when switching channels
    revokeBlobUrls();
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
    if (msg.id) div.setAttribute('data-message-id', msg.id);
    if (msg.sender_id) div.setAttribute('data-sender-id', msg.sender_id);

    const myUserId = localStorage.getItem('user') ? JSON.parse(localStorage.getItem('user')).id : '';
    const isOwn = msg.sender_id === myUserId;

    const initial = (msg.sender_username || '?').charAt(0).toUpperCase();
    let time = '';
    try {
        time = new Date(msg.timestamp).toLocaleTimeString();
    } catch (e) {
        time = msg.timestamp || '';
    }

    let textContent = '';
    let fileData = null;
    let filesData = null;
    let replyTo = null;
    let forwardData = null;
    let gifData = null;
    let stickerData = null;
    if (msg.encrypted_content && msg.nonce && currentChannelId && currentServerId) {
        try {
            textContent = E2ECrypto.decrypt(msg.encrypted_content, msg.nonce, currentChannelId, currentServerId, msg.message_nonce);
            try {
                const parsed = JSON.parse(textContent);
                if (parsed && parsed.type === 'files' && Array.isArray(parsed.files)) {
                    filesData = parsed.files;
                    textContent = '';
                } else if (parsed && parsed.type === 'file') {
                    fileData = parsed;
                    textContent = '';
                } else if (parsed && parsed.type === 'gif') {
                    gifData = parsed;
                    textContent = '';
                } else if (parsed && parsed.type === 'sticker') {
                    stickerData = parsed;
                    textContent = '';
                } else if (parsed && parsed.type === 'forward') {
                    forwardData = parsed;
                    textContent = '';
                }
                if (parsed && parsed.reply_to) {
                    replyTo = parsed.reply_to;
                }
            } catch (_) {}
        } catch (e) {
            console.warn('Decrypt failed:', e);
            textContent = '[encrypted message - unable to decrypt]';
        }
    }

    let contentHtml = '';
    if (replyTo) {
        contentHtml += '<div class="reply-quote" data-reply-to="' + escapeHtml(replyTo.message_id || '') + '">' +
            '<span class="reply-author">@' + escapeHtml(replyTo.author || 'unknown') + '</span> ' +
            '<span class="reply-preview">' + escapeHtml(replyTo.preview || '') + '</span>' +
            '</div>';
    }
    if (forwardData) {
        contentHtml += '<div class="forward-label">Forwarded from <strong>#' + escapeHtml(forwardData.source_channel_name || 'unknown') + '</strong> in <strong>' + escapeHtml(forwardData.source_server_name || 'unknown') + '</strong></div>';
        if (forwardData.preview_content && forwardData.preview_nonce && currentServerId) {
            try {
                const previewText = E2ECrypto.decrypt(forwardData.preview_content, forwardData.preview_nonce, forwardData.source_channel_id, forwardData.source_server_id, forwardData.preview_message_nonce);
                contentHtml += '<div class="forward-preview"><div class="text">' + escapeHtml(previewText) + '</div></div>';
            } catch (_) {
                contentHtml += '<div class="forward-preview forward-unavailable">Preview unavailable</div>';
            }
        } else {
            contentHtml += '<div class="forward-preview forward-unavailable">Preview unavailable</div>';
        }
    } else if (gifData) {
        contentHtml += '<div class="gif-message"><img src="' + escapeHtml(gifData.url) + '" alt="' + escapeHtml(gifData.alt || 'GIF') + '" loading="lazy" style="max-width:300px;max-height:300px;border-radius:8px"></div>';
    } else if (stickerData) {
        contentHtml += '<div class="sticker-message"></div>';
    } else if (filesData) {
        contentHtml += buildMultiFileCardHtml(filesData);
    } else if (fileData) {
        contentHtml += buildFileCardHtml(fileData);
    } else if (textContent) {
        contentHtml += '<div class="text">' + escapeHtml(textContent) + '</div>';
    }

    const editedLabel = msg.edited_at ? '<span class="edited-label">(edited)</span>' : '';

    const actionsHtml = '<div class="message-actions">' +
        '<button class="msg-action-btn" data-action="reply" title="Reply">&#x21A9;</button>' +
        '<button class="msg-action-btn" data-action="forward" title="Forward">&#x21AA;</button>' +
        (isOwn ? '<button class="msg-action-btn" data-action="edit" title="Edit">&#x270E;</button>' : '') +
        (isOwn ? '<button class="msg-action-btn" data-action="delete" title="Delete">&#x2715;</button>' : '') +
        '</div>';

    div.innerHTML =
        '<div class="avatar">' + initial + '</div>' +
        '<div class="content">' +
            '<div class="header">' +
                '<span class="username">' + escapeHtml(msg.sender_username || 'unknown') + '</span>' +
                '<span class="time">' + time + editedLabel + '</span>' +
            '</div>' +
            contentHtml +
        '</div>' +
        actionsHtml;

    // Load media preview if applicable
    if (filesData) {
        div.querySelectorAll('.file-preview').forEach((container, idx) => {
            if (filesData[idx] && filesData[idx].file_key) {
                loadMediaPreview(container, filesData[idx]);
            }
        });
    } else if (fileData && fileData.file_key) {
        loadMediaPreview(div.querySelector('.file-preview'), fileData);
    } else if (stickerData && stickerData.file_id && stickerData.file_key) {
        const stickerContainer = div.querySelector('.sticker-message');
        if (stickerContainer) {
            loadStickerPreview(stickerContainer, stickerData);
        }
    }

    // Reply quote click → scroll to original
    const replyQuote = div.querySelector('.reply-quote');
    if (replyQuote) {
        replyQuote.addEventListener('click', () => {
            const targetId = replyQuote.getAttribute('data-reply-to');
            if (targetId) {
                const target = list.querySelector('[data-message-id="' + targetId + '"]');
                if (target) {
                    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    target.classList.add('flash-highlight');
                    setTimeout(() => target.classList.remove('flash-highlight'), 1500);
                }
            }
        });
    }

    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
}

async function loadStickerPreview(container, stickerData) {
    try {
        const response = await authFetch('/api/files/' + stickerData.file_id + '/download');
        if (!response.ok) throw new Error('Download failed');
        const encryptedChunks = await response.arrayBuffer();
        const fileKeyBytes = E2ECrypto.base64ToArrayBuffer(stickerData.file_key);
        const decrypted = E2ECrypto.decryptFileChunk(fileKeyBytes, new Uint8Array(encryptedChunks));
        const blob = new Blob([decrypted], { type: stickerData.mime_type || 'image/png' });
        const url = URL.createObjectURL(blob);
        const img = document.createElement('img');
        img.src = url;
        img.alt = stickerData.sticker_name || 'Sticker';
        img.style.maxWidth = '192px';
        img.style.maxHeight = '192px';
        img.style.borderRadius = '8px';
        container.appendChild(img);
    } catch (e) {
        container.textContent = '[sticker unavailable]';
    }
}

// --- Message Actions ---

let pendingReply = null;
let pendingForward = null;

function setupMessageActions() {
    const list = document.getElementById('message-list');
    list.addEventListener('click', (e) => {
        const btn = e.target.closest('.msg-action-btn');
        if (!btn) return;
        const msgDiv = btn.closest('.message');
        if (!msgDiv) return;
        const messageId = msgDiv.getAttribute('data-message-id');
        const senderId = msgDiv.getAttribute('data-sender-id');
        const action = btn.getAttribute('data-action');

        if (action === 'reply') {
            handleReply(messageId, msgDiv);
        } else if (action === 'forward') {
            handleForward(messageId, msgDiv);
        } else if (action === 'edit') {
            handleEdit(messageId, msgDiv);
        } else if (action === 'delete') {
            handleDelete(messageId, msgDiv);
        }
    });
}

function handleReply(messageId, msgDiv) {
    const username = msgDiv.querySelector('.username')?.textContent || 'unknown';
    const textEl = msgDiv.querySelector('.text');
    const preview = textEl ? textEl.textContent.substring(0, 80) : '';
    pendingReply = { message_id: messageId, author: username, preview: preview };
    const replyBar = document.getElementById('reply-bar');
    if (replyBar) {
        replyBar.innerHTML = 'Replying to <strong>@' + escapeHtml(username) + '</strong>: ' + escapeHtml(preview) + ' <button id="cancel-reply" style="margin-left:8px;background:none;border:none;color:#aaa;cursor:pointer">&#x2715;</button>';
        replyBar.style.display = 'flex';
        document.getElementById('cancel-reply')?.addEventListener('click', () => {
            pendingReply = null;
            replyBar.style.display = 'none';
        });
    }
    document.getElementById('message-input')?.focus();
}

function handleForward(messageId, msgDiv) {
    pendingForward = { messageId, msgDiv };
    showForwardModal();
}

function handleEdit(messageId, msgDiv) {
    const textEl = msgDiv.querySelector('.text');
    if (!textEl) return;
    const originalText = textEl.textContent;
    const contentEl = msgDiv.querySelector('.content');
    if (!contentEl) return;

    const headerEl = contentEl.querySelector('.header');
    const textarea = document.createElement('textarea');
    textarea.className = 'edit-textarea';
    textarea.value = originalText;
    textarea.style.cssText = 'width:100%;min-height:60px;background:#2d2d2d;color:#d4d4d4;border:1px solid #569cd6;border-radius:4px;padding:8px;font-family:inherit;resize:vertical';

    const btnRow = document.createElement('div');
    btnRow.className = 'edit-buttons';
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:6px';
    btnRow.innerHTML = '<button class="edit-save-btn" style="background:#569cd6;color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer">Save</button>' +
        '<button class="edit-cancel-btn" style="background:#666;color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer">Cancel</button>';

    // Remove old text and actions
    const oldText = contentEl.querySelector('.text');
    const oldReply = contentEl.querySelector('.reply-quote');
    const oldForward = contentEl.querySelector('.forward-label');
    const actionsEl = msgDiv.querySelector('.message-actions');
    if (oldText) oldText.style.display = 'none';
    if (oldReply) oldReply.style.display = 'none';
    if (oldForward) oldForward.style.display = 'none';
    if (actionsEl) actionsEl.style.display = 'none';

    contentEl.appendChild(textarea);
    contentEl.appendChild(btnRow);
    textarea.focus();

    btnRow.querySelector('.edit-save-btn').addEventListener('click', async () => {
        const newText = textarea.value.trim();
        if (!newText || !currentChannelId || !currentServerId) return;
        try {
            const encrypted = E2ECrypto.encrypt(newText, currentChannelId, currentServerId);
            ws.send(JSON.stringify({
                type: 'message_edit',
                message_id: messageId,
                encrypted_content: encrypted.ciphertext,
                nonce: encrypted.nonce,
                message_nonce: encrypted.messageNonce || null,
            }));
        } catch (e) {
            console.error('Edit encrypt failed:', e);
        }
        textarea.remove();
        btnRow.remove();
        if (actionsEl) actionsEl.style.display = '';
    });

    btnRow.querySelector('.edit-cancel-btn').addEventListener('click', () => {
        textarea.remove();
        btnRow.remove();
        if (oldText) oldText.style.display = '';
        if (oldReply) oldReply.style.display = '';
        if (oldForward) oldForward.style.display = '';
        if (actionsEl) actionsEl.style.display = '';
    });
}

function handleDelete(messageId, msgDiv) {
    if (!confirm('Delete this message?')) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (viewMode === 'dms') {
        ws.send(JSON.stringify({ type: 'dm_delete', message_id: messageId }));
    } else {
        ws.send(JSON.stringify({ type: 'message_delete', message_id: messageId }));
    }
}

function handleEditedMessage(msg, mode) {
    const list = document.getElementById('message-list');
    const existing = list.querySelector('[data-message-id="' + msg.id + '"]');
    if (!existing) return;

    const textEl = existing.querySelector('.text');
    if (textEl && msg.encrypted_content && msg.nonce) {
        try {
            let decrypted;
            if (mode === 'dm' && currentDmChannelId && currentDmOtherUser) {
                const kp = E2ECrypto.getIdentityKeyPair();
                let otherPubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(currentDmOtherUser.identity_public_key || ''));
                decrypted = E2ECrypto.decryptDm(msg.encrypted_content, msg.nonce, currentDmChannelId, kp.privateKey, otherPubKey, msg.message_nonce);
            } else if (currentChannelId && currentServerId) {
                decrypted = E2ECrypto.decrypt(msg.encrypted_content, msg.nonce, currentChannelId, currentServerId, msg.message_nonce);
            }
            if (decrypted) textEl.textContent = decrypted;
        } catch (_) {}
    }

    const timeEl = existing.querySelector('.time');
    if (timeEl && !timeEl.querySelector('.edited-label')) {
        timeEl.insertAdjacentHTML('beforeend', ' <span class="edited-label">(edited)</span>');
    }
}

function handleDeletedMessage(messageId) {
    const list = document.getElementById('message-list');
    const existing = list.querySelector('[data-message-id="' + messageId + '"]');
    if (existing) existing.remove();
}

function showForwardModal() {
    const modal = document.getElementById('forward-modal');
    if (modal) {
        modal.style.display = 'flex';
        loadForwardChannels();
    }
}

async function loadForwardChannels() {
    const list = document.getElementById('forward-channel-list');
    if (!list) return;
    list.innerHTML = '<div style="color:#888">Loading...</div>';
    try {
        const res = await authFetch('/api/servers');
        const servers = await res.json();
        let html = '';
        for (const server of servers) {
            const chRes = await authFetch('/api/servers/' + server.id + '/channels');
            const channels = await chRes.json();
            html += '<div class="forward-server"><div class="forward-server-name">' + escapeHtml(server.name) + '</div>';
            for (const ch of channels) {
                html += '<div class="forward-channel-item" data-server-id="' + server.id + '" data-server-name="' + escapeHtml(server.name) + '" data-channel-id="' + ch.id + '" data-channel-name="' + escapeHtml(ch.name) + '">' + escapeHtml(ch.name) + '</div>';
            }
            html += '</div>';
        }
        list.innerHTML = html || '<div style="color:#888">No servers found</div>';
    } catch (e) {
        list.innerHTML = '<div style="color:#888">Failed to load</div>';
    }
}

function setupForwardModal() {
    const modal = document.getElementById('forward-modal');
    if (!modal) return;
    modal.addEventListener('click', (e) => {
        if (e.target === modal || e.target.id === 'cancel-forward') {
            modal.style.display = 'none';
            pendingForward = null;
        }
    });
    const list = document.getElementById('forward-channel-list');
    if (list) {
        list.addEventListener('click', (e) => {
            const item = e.target.closest('.forward-channel-item');
            if (!item) return;
            const targetServerId = item.getAttribute('data-server-id');
            const targetServerName = item.getAttribute('data-server-name');
            const targetChannelId = item.getAttribute('data-channel-id');
            const targetChannelName = item.getAttribute('data-channel-name');
            executeForward(targetServerId, targetServerName, targetChannelId, targetChannelName);
            modal.style.display = 'none';
            pendingForward = null;
        });
    }
}

async function executeForward(targetServerId, targetServerName, targetChannelId, targetChannelName) {
    if (!pendingForward || !ws || ws.readyState !== WebSocket.OPEN) return;
    const msgDiv = pendingForward.msgDiv;
    const messageId = pendingForward.messageId;

    const senderUsername = msgDiv.querySelector('.username')?.textContent || 'unknown';
    const textEl = msgDiv.querySelector('.text');
    const originalText = textEl ? textEl.textContent : '';

    let previewText = originalText.substring(0, 80);
    if (msgDiv.querySelector('.gif-message')) previewText = 'GIF';
    if (msgDiv.querySelector('.sticker-message')) previewText = 'Sticker';
    if (msgDiv.querySelector('.file-card')) previewText = 'File attachment';

    try {
        const previewEncrypted = E2ECrypto.encrypt(previewText, targetChannelId, targetServerId);
        const sourceChannelId = currentChannelId;

        const forwardPayload = {
            type: 'forward',
            source_server_id: currentServerId,
            source_channel_id: sourceChannelId,
            source_message_id: messageId,
            source_server_name: document.getElementById('server-name')?.textContent || 'Server',
            source_channel_name: document.getElementById('channel-name')?.textContent || 'channel',
            sender_username: senderUsername,
            timestamp: msgDiv.querySelector('.time')?.textContent || '',
            preview_content: previewEncrypted.ciphertext,
            preview_nonce: previewEncrypted.nonce,
            preview_message_nonce: previewEncrypted.messageNonce || null,
        };

        const encrypted = E2ECrypto.encrypt(JSON.stringify(forwardPayload), targetChannelId, targetServerId);
        ws.send(JSON.stringify({
            type: 'message_send',
            channel_id: targetChannelId,
            encrypted_content: encrypted.ciphertext,
            nonce: encrypted.nonce,
            message_nonce: encrypted.messageNonce || null,
        }));
    } catch (e) {
        console.error('Forward failed:', e);
    }
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

    let plaintext = content;
    if (pendingReply) {
        plaintext = JSON.stringify({ type: 'text', text: content, reply_to: pendingReply });
    }

    var encrypted;
    try {
        encrypted = E2ECrypto.encrypt(plaintext, currentChannelId, currentServerId);
    } catch (e) {
        console.error('Encryption failed:', e);
        return;
    }

    ws.send(JSON.stringify({
        type: 'message_send',
        channel_id: currentChannelId,
        encrypted_content: encrypted.ciphertext,
        nonce: encrypted.nonce,
        message_nonce: encrypted.messageNonce || null,
    }));

    input.value = '';
    pendingReply = null;
    const replyBar = document.getElementById('reply-bar');
    if (replyBar) replyBar.style.display = 'none';
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
                const decrypted = E2ECrypto.decryptDm(
                    c.last_message.encrypted_content, c.last_message.nonce,
                    c.dm_channel_id, kp.privateKey,
                    c.other_public_key ? new Uint8Array(E2ECrypto.base64ToArrayBuffer(c.other_public_key)) : null,
                    c.last_message.message_nonce
                );
                try {
                    const parsed = JSON.parse(decrypted);
                    if (parsed && parsed.type === 'files' && Array.isArray(parsed.files)) {
                        preview = parsed.files.length + ' files';
                    } else if (parsed && parsed.type === 'file') {
                        preview = getFileIcon(parsed.mime_type) + ' ' + (parsed.filename || 'File');
                    } else {
                        preview = decrypted.substring(0, 40);
                    }
                } catch (_) {
                    preview = decrypted.substring(0, 40);
                }
            } catch (e) {
                preview = '[encrypted]';
            }
        }
        html += '<div class="channel-item dm-item" data-dm-id="' + c.dm_channel_id + '" data-user-id="' + escapeAttr(c.other_user_id) + '" data-username="' + escapeAttr(c.other_username) + '">' +
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

    // Event delegation for DM items
    document.querySelectorAll('.dm-item[data-dm-id]').forEach(item => {
        item.addEventListener('click', () => {
            selectDmChannel(item.dataset.dmId, item.dataset.userId, item.dataset.username, item);
        });
    });

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

    document.getElementById('channel-name').innerHTML = '<span>' + escapeHtml(otherUsername) + '</span>' +
        ' <button class="btn-unfriend" id="unfriend-btn" title="Unfriend">Unfriend</button>';
    document.getElementById('message-input').disabled = false;
    document.getElementById('send-btn').disabled = false;

    document.getElementById('unfriend-btn').addEventListener('click', () => unfriend(otherUserId, otherUsername));
    
    // Clear unread badge for this DM channel
    delete unreadDms[dmChannelId];
    updateDmStripBadge();
    await loadDmMessages(dmChannelId, otherUserId);
    renderDmSidebar();

    if (window._closeSidebar) window._closeSidebar();
}

async function loadDmMessages(dmChannelId, otherUserId) {
    // Clean up old blob URLs when switching DM channels
    revokeBlobUrls();
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

        // TOFU key verification
        const verification = E2ECrypto.verifyKeyForUser(otherUserId, otherUserData.identity_public_key);
        if (!verification.trusted) {
            const banner = document.createElement('div');
            banner.className = 'message system';
            banner.style.cssText = 'background:#ff9800;color:#fff;padding:10px;border-radius:6px;margin:10px 0;text-align:center';
            banner.innerHTML = '⚠ <b>Key Changed!</b> The identity key for this user has changed since you last communicated. ' +
                '<button onclick="if(confirm(\'Trust the new key?\')){E2ECrypto.trustCurrentKey(\'' + otherUserId + '\',\'' + otherUserData.identity_public_key + '\');this.parentElement.remove();}" ' +
                'style="margin-left:8px;background:#fff;color:#e65100;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-weight:bold">Trust New Key</button>';
            list.appendChild(banner);
        } else if (verification.newKey) {
            console.log('TOFU: First time seeing key for user', otherUserId, '- stored for future verification');
        }

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
    let fileData = null;
    let filesData = null;
    if (msg.encrypted_content && msg.nonce && kp && otherPublicKey) {
        try {
            const dmId = msg.dm_channel_id || currentDmChannelId;
            textContent = E2ECrypto.decryptDm(msg.encrypted_content, msg.nonce, dmId, kp.privateKey, otherPublicKey, msg.message_nonce);
            // Check if it's a file message
            try {
                const parsed = JSON.parse(textContent);
                if (parsed && parsed.type === 'files' && Array.isArray(parsed.files)) {
                    filesData = parsed.files;
                    textContent = '';
                } else if (parsed && parsed.type === 'file') {
                    fileData = parsed;
                    textContent = '';
                }
            } catch (_) {}
        } catch (e) {
            textContent = '[encrypted message - unable to decrypt]';
        }
    }

    let contentHtml = '';
    if (filesData) {
        contentHtml = buildMultiFileCardHtml(filesData);
    } else if (fileData) {
        contentHtml = buildFileCardHtml(fileData);
    } else {
        contentHtml = '<div class="text">' + escapeHtml(textContent) + '</div>';
    }

    div.innerHTML =
        '<div class="avatar">' + initial + '</div>' +
        '<div class="content">' +
            '<div class="header">' +
                '<span class="username">' + escapeHtml(msg.sender_username || 'unknown') + '</span>' +
                '<span class="time">' + time + '</span>' +
            '</div>' +
            contentHtml +
        '</div>';

    // Load media preview if applicable
    if (filesData) {
        div.querySelectorAll('.file-preview').forEach((container, idx) => {
            if (filesData[idx] && filesData[idx].file_key) {
                loadMediaPreview(container, filesData[idx]);
            }
        });
    } else if (fileData && fileData.file_key) {
        loadMediaPreview(div.querySelector('.file-preview'), fileData);
    }

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

    let plaintext = content;
    if (pendingReply) {
        plaintext = JSON.stringify({ type: 'text', text: content, reply_to: pendingReply });
    }

    var encrypted;
    try {
        encrypted = E2ECrypto.encryptDm(plaintext, currentDmChannelId, kp.privateKey, otherPublicKey);
    } catch (e) {
        console.error('DM encryption failed:', e);
        return;
    }

    ws.send(JSON.stringify({
        type: 'dm_send',
        dm_channel_id: currentDmChannelId,
        encrypted_content: encrypted.ciphertext,
        nonce: encrypted.nonce,
        message_nonce: encrypted.messageNonce || null,
    }));

    input.value = '';
    pendingReply = null;
    const replyBar = document.getElementById('reply-bar');
    if (replyBar) replyBar.style.display = 'none';
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
                    '<button class="btn-kick" data-action="kick" data-user-id="' + escapeAttr(m.id) + '" data-username="' + escapeAttr(m.username) + '" title="Kick">&#10005;</button>' +
                    '<button class="btn-ban" data-action="ban" data-user-id="' + escapeAttr(m.id) + '" data-username="' + escapeAttr(m.username) + '" title="Ban">&#9888;</button>';
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
                '<button class="btn-unban" data-action="unban" data-user-id="' + escapeAttr(b.id) + '" data-username="' + escapeAttr(b.username) + '">Unban</button>';
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
function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
}
function escapeJsStr(str) {
    if (!str) return '';
    return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
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

// ===== File Sharing =====

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function isCodeFile(filename, mime) {
    if (mime === 'application/javascript' || mime === 'application/json' || mime === 'application/xml') return true;
    if (mime === 'text/x-python' || mime === 'text/x-c' || mime === 'text/x-c++' || mime === 'text/x-java' || mime === 'text/x-rust' || mime === 'text/x-go' || mime === 'text/x-shellscript' || mime === 'text/x-sql') return true;
    if (mime === 'text/html' || mime === 'text/css' || mime === 'text/markdown') return true;
    if (!filename) return false;
    const ext = filename.split('.').pop().toLowerCase();
    return ['js','ts','jsx','tsx','py','cpp','c','h','hpp','java','rs','go','sh','sql','html','css','json','xml','rb','php','swift','kt','cs','lua','pl','r','m','mm','yaml','yml','toml','ini','cfg','conf','md'].includes(ext);
}

function isTextFile(filename, mime) {
    if (mime && mime.startsWith('text/')) return true;
    if (mime === 'application/json' || mime === 'application/javascript' || mime === 'application/xml') return true;
    if (!filename) return false;
    const ext = filename.split('.').pop().toLowerCase();
    const textExts = ['txt','js','ts','jsx','tsx','py','cpp','c','h','hpp','java','rs','go','sh','sql','html','css','json','xml','rb','php','swift','kt','cs','lua','pl','r','m','mm','yaml','yml','toml','ini','cfg','conf','md','mdx','csv','log','env','svg','dockerfile','makefile'];
    return textExts.includes(ext);
}

function isMarkdownFile(filename, mime) {
    if (mime === 'text/markdown' || mime === 'text/x-markdown') return true;
    if (!filename) return false;
    const ext = filename.split('.').pop().toLowerCase();
    return ext === 'md' || ext === 'mdx' || ext === 'markdown';
}

function getCorrectMimeType(filename, browserMime) {
    if (!filename) return browserMime || 'application/octet-stream';
    const ext = filename.split('.').pop().toLowerCase();
    const mimeMap = {
        'js': 'application/javascript', 'mjs': 'application/javascript', 'jsx': 'application/javascript',
        'ts': 'application/typescript', 'tsx': 'application/typescript',
        'py': 'text/x-python', 'pyw': 'text/x-python',
        'c': 'text/x-c', 'h': 'text/x-c',
        'cpp': 'text/x-c++', 'cxx': 'text/x-c++', 'cc': 'text/x-c++', 'hpp': 'text/x-c++',
        'java': 'text/x-java',
        'rs': 'text/x-rust',
        'go': 'text/x-go',
        'sh': 'text/x-shellscript', 'bash': 'text/x-shellscript', 'zsh': 'text/x-shellscript',
        'sql': 'text/x-sql',
        'html': 'text/html', 'htm': 'text/html',
        'css': 'text/css',
        'json': 'application/json',
        'xml': 'application/xml',
        'rb': 'text/x-ruby',
        'php': 'text/x-php',
        'swift': 'text/x-swift',
        'kt': 'text/x-kotlin',
        'cs': 'text/x-csharp',
        'lua': 'text/x-lua',
        'pl': 'text/x-perl',
        'r': 'text/x-r',
        'm': 'text/x-objectivec', 'mm': 'text/x-objectivec',
        'yaml': 'text/yaml', 'yml': 'text/yaml',
        'toml': 'text/x-toml',
        'ini': 'text/plain', 'cfg': 'text/plain', 'conf': 'text/plain',
        'txt': 'text/plain',
        'md': 'text/markdown', 'mdx': 'text/markdown', 'markdown': 'text/markdown',
        'svg': 'image/svg+xml',
        'csv': 'text/csv',
        'log': 'text/plain',
        'env': 'text/plain',
        'dockerfile': 'text/x-dockerfile',
        'makefile': 'text/x-makefile',
    };
    return mimeMap[ext] || browserMime || 'application/octet-stream';
}

function getLangFromExt(ext) {
    const map = {
        'js': 'javascript', 'mjs': 'javascript', 'jsx': 'javascript', 'ts': 'typescript', 'tsx': 'typescript',
        'py': 'python', 'pyw': 'python',
        'c': 'c', 'h': 'c',
        'cpp': 'cpp', 'cxx': 'cpp', 'cc': 'cpp', 'hpp': 'cpp',
        'java': 'java',
        'rs': 'rust',
        'go': 'go',
        'sh': 'shell', 'bash': 'shell', 'zsh': 'shell',
        'sql': 'sql',
        'html': 'html', 'htm': 'html',
        'css': 'css',
        'json': 'json',
        'xml': 'xml',
        'rb': 'ruby',
        'php': 'php',
        'swift': 'swift',
        'kt': 'kotlin',
        'cs': 'csharp',
        'lua': 'lua',
        'pl': 'perl',
        'r': 'r',
        'm': 'objectivec', 'mm': 'objectivec',
        'yaml': 'yaml', 'yml': 'yaml',
        'toml': 'toml',
        'md': 'markdown', 'mdx': 'markdown',
        'dockerfile': 'dockerfile',
    };
    return map[ext] || 'generic';
}

function getLangColors(lang) {
    const themes = {
        javascript: { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', function: '#61afef', type: '#e5c07b', operator: '#56b6c2', tag: '#e06c75', attr: '#d19a66', punctuation: '#abb2bf', constant: '#d19a66', parameter: '#e06c75', property: '#e06c75', regex: '#98c379' },
        typescript: { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', function: '#61afef', type: '#e5c07b', operator: '#56b6c2', tag: '#e06c75', attr: '#d19a66', punctuation: '#abb2bf', constant: '#d19a66', parameter: '#e06c75', property: '#e06c75', regex: '#98c379' },
        python:     { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', function: '#61afef', type: '#e5c07b', decorator: '#e5c07b', builtin: '#e5c07b', punctuation: '#abb2bf', constant: '#d19a66', parameter: '#e06c75', property: '#e06c75', self: '#e06c75', magic: '#56b6c2' },
        c:          { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', function: '#61afef', type: '#e5c07b', preprocessor: '#c678dd', punctuation: '#abb2bf', constant: '#d19a66', parameter: '#e06c75', macro: '#e5c07b' },
        cpp:        { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', function: '#61afef', type: '#e5c07b', preprocessor: '#c678dd', punctuation: '#abb2bf', constant: '#d19a66', parameter: '#e06c75', macro: '#e5c07b', namespace: '#e5c07b' },
        java:       { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', function: '#61afef', type: '#e5c07b', annotation: '#e5c07b', punctuation: '#abb2bf', constant: '#d19a66', parameter: '#e06c75', static: '#e5c07b' },
        rust:       { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', function: '#61afef', type: '#e5c07b', macro: '#61afef', punctuation: '#abb2bf', constant: '#d19a66', parameter: '#e06c75', lifetime: '#e06c75', attribute: '#e5c07b' },
        go:         { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', function: '#61afef', type: '#e5c07b', punctuation: '#abb2bf', constant: '#d19a66', parameter: '#e06c75', builtin: '#e5c07b', format: '#56b6c2' },
        shell:      { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', function: '#61afef', variable: '#e06c75', punctuation: '#abb2bf', constant: '#d19a66', flag: '#d19a66', operator: '#56b6c2' },
        sql:        { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', function: '#61afef', type: '#e5c07b', punctuation: '#abb2bf', constant: '#d19a66', operator: '#56b6c2', table: '#e5c07b' },
        html:       { tag: '#e06c75', attr: '#d19a66', string: '#98c379', comment: '#5c6370', punctuation: '#abb2bf', entity: '#56b6c2', attribute: '#d19a66' },
        css:        { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', property: '#e06c75', function: '#61afef', punctuation: '#abb2bf', selector: '#e06c75', unit: '#d19a66', constant: '#d19a66', important: '#e06c75' },
        json:       { key: '#e06c75', string: '#98c379', number: '#d19a66', boolean: '#c678dd', null: '#c678dd', punctuation: '#abb2bf' },
        xml:        { tag: '#e06c75', attr: '#d19a66', string: '#98c379', comment: '#5c6370', punctuation: '#abb2bf', entity: '#56b6c2', cdata: '#5c6370' },
        ruby:       { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', function: '#61afef', symbol: '#d19a66', punctuation: '#abb2bf', constant: '#e5c07b', instance: '#e06c75', regex: '#98c379' },
        php:        { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', function: '#61afef', variable: '#e06c75', punctuation: '#abb2bf', constant: '#d19a66', tag: '#e06c75', attribute: '#d19a66' },
        swift:      { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', function: '#61afef', type: '#e5c07b', punctuation: '#abb2bf', constant: '#d19a66', parameter: '#e06c75', attribute: '#e5c07b', interpolation: '#56b6c2' },
        kotlin:     { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', function: '#61afef', type: '#e5c07b', annotation: '#e5c07b', punctuation: '#abb2bf', constant: '#d19a66', parameter: '#e06c75', property: '#e06c75' },
        csharp:     { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', function: '#61afef', type: '#e5c07b', punctuation: '#abb2bf', constant: '#d19a66', parameter: '#e06c75', attribute: '#e5c07b', delegate: '#61afef' },
        lua:        { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', function: '#61afef', punctuation: '#abb2bf', constant: '#d19a66', global: '#e06c75', field: '#e06c75', builtin: '#e5c07b' },
        perl:       { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', function: '#61afef', variable: '#e06c75', punctuation: '#abb2bf', constant: '#d19a66', regex: '#98c379', operator: '#56b6c2', sigil: '#e06c75' },
        r:          { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', function: '#61afef', punctuation: '#abb2bf', constant: '#d19a66', logical: '#56b6c2', operator: '#56b6c2', NA: '#d19a66' },
        objectivec: { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', function: '#61afef', type: '#e5c07b', punctuation: '#abb2bf', constant: '#d19a66', parameter: '#e06c75', method: '#61afef', property: '#e06c75' },
        yaml:       { key: '#e06c75', string: '#98c379', number: '#d19a66', comment: '#5c6370', boolean: '#c678dd', punctuation: '#abb2bf', anchor: '#56b6c2', alias: '#56b6c2', tag: '#e5c07b' },
        toml:       { key: '#e06c75', string: '#98c379', number: '#d19a66', comment: '#5c6370', boolean: '#c678dd', punctuation: '#abb2bf', datetime: '#56b6c2' },
        dockerfile: { keyword: '#c678dd', string: '#98c379', comment: '#5c6370', punctuation: '#abb2bf', instruction: '#e06c75', flag: '#d19a66' },
        generic:    { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', function: '#61afef', punctuation: '#abb2bf', constant: '#d19a66' },
    };
    return themes[lang] || themes.generic;
}

function highlightSyntax(text, filename, mime) {
    const ext = filename ? filename.split('.').pop().toLowerCase() : '';
    const lang = getLangFromExt(ext);
    const c = getLangColors(lang);

    const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    if (lang === 'html' || lang === 'xml') {
        return highlightHtml(escaped, c);
    }
    if (lang === 'json') {
        return highlightJson(escaped, c);
    }
    if (lang === 'css') {
        return highlightCss(escaped, c);
    }
    if (lang === 'yaml' || lang === 'toml') {
        return highlightKeyValue(escaped, c);
    }

    return highlightGeneric(escaped, lang, c);
}

function highlightHtml(text, c) {
    let result = text;
    result = result.replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span style="color:' + c.comment + ';font-style:italic">$1</span>');
    result = result.replace(/(&lt;!\[CDATA\[[\s\S]*?\]\]&gt;)/g, '<span style="color:' + (c.cdata || c.comment) + '">$1</span>');
    result = result.replace(/(&lt;\/?)([\w:-]+)/g, '$1<span style="color:' + c.tag + '">$2</span>');
    result = result.replace(/\s([\w:-]+)(=)/g, ' <span style="color:' + (c.attribute || c.attr) + '">$1</span>$2');
    result = result.replace(/(=)(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|"[^"]*?"|'[^']*?')/g, '$1<span style="color:' + c.string + '">$2</span>');
    result = result.replace(/(&amp;#\d+;|&amp;#x[\da-f]+;|&amp;\w+;)/g, '<span style="color:' + (c.entity || c.constant) + '">$1</span>');
    return result;
}

function highlightJson(text, c) {
    let result = text;
    result = result.replace(/(&quot;[^&]*?&quot;|"[^"]*?")\s*:/g, '<span style="color:' + c.key + '">$1</span>:');
    result = result.replace(/:\s*(&quot;[^&]*?&quot;|"[^"]*?")/g, ': <span style="color:' + c.string + '">$1</span>');
    result = result.replace(/:\s*(\d+\.?\d*)/g, ': <span style="color:' + c.number + '">$1</span>');
    result = result.replace(/:\s*(true|false)/g, ': <span style="color:' + c.boolean + '">$1</span>');
    result = result.replace(/:\s*(null)/g, ': <span style="color:' + c.null + '">$1</span>');
    return result;
}

function highlightCss(text, c) {
    let result = text;
    result = result.replace(/(\/\*[\s\S]*?\*\/)/g, '<span style="color:' + c.comment + ';font-style:italic">$1</span>');
    result = result.replace(/(!important)/g, '<span style="color:' + (c.important || '#e06c75') + ';font-weight:bold">$1</span>');
    result = result.replace(/([\.\#][\w-]+)(\s*\{)/g, '<span style="color:' + (c.selector || c.tag) + '">$1</span>$2');
    result = result.replace(/([\w-]+)\s*:/g, '<span style="color:' + c.property + '">$1</span>:');
    result = result.replace(/:\s*([^;{}\n]+)/g, ': <span style="color:' + c.string + '">$1</span>');
    result = result.replace(/(\d+\.?\d*(?:px|em|rem|%|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pt|pc|s|ms|deg|rad|grad|turn|fr)?)/g, '<span style="color:' + (c.unit || c.number) + '">$1</span>');
    result = result.replace(/([+#>*~,.]+)/g, '<span style="color:' + (c.operator || '#56b6c2') + '">$1</span>');
    return result;
}

function highlightKeyValue(text, c) {
    let result = text;
    result = result.replace(/(#.*$)/gm, '<span style="color:' + c.comment + ';font-style:italic">$1</span>');
    result = result.replace(/(&amp;[\w-]+)/g, '<span style="color:' + (c.anchor || '#56b6c2') + '">$1</span>');
    result = result.replace(/(\*[\w-]+)/g, '<span style="color:' + (c.alias || '#56b6c2') + '">$1</span>');
    result = result.replace(/^([\w.-]+)(\s*[:=])/gm, '<span style="color:' + c.key + '">$1</span>$2');
    result = result.replace(/(&lt;[\w.-]+&gt;|!![\w.-]+)/g, '<span style="color:' + (c.tag || c.type) + '">$1</span>');
    result = result.replace(/(&quot;[^&]*?&quot;|"[^"]*?"|'[^']*?')/g, '<span style="color:' + c.string + '">$1</span>');
    result = result.replace(/\b(\d+\.?\d*)\b/g, '<span style="color:' + c.number + '">$1</span>');
    result = result.replace(/\b(true|false|null|none|~|inf|-inf|nan)\b/gi, '<span style="color:' + c.boolean + '">$1</span>');
    result = result.replace(/(~~[\w-]+)/g, '<span style="color:' + (c.merge || c.boolean) + '">$1</span>');
    return result;
}

function highlightGeneric(text, lang, c) {
    const lines = text.split('\n');
    const result = [];

    const kwMap = {
        javascript: /\b(function|return|if|else|elif|for|while|do|switch|case|break|continue|class|extends|super|new|this|const|let|var|import|from|export|default|async|await|try|catch|throw|finally|typeof|instanceof|in|of|true|false|null|undefined|void|delete|yield|with|debugger)\b/g,
        typescript: /\b(function|return|if|else|elif|for|while|do|switch|case|break|continue|class|extends|super|new|this|const|let|var|import|from|export|default|async|await|try|catch|throw|finally|typeof|instanceof|in|of|true|false|null|undefined|void|type|interface|enum|implements|readonly|private|public|protected|abstract|as|keyof|never|unknown|any|asserts|infer|is|module|declare|namespace)\b/g,
        python:     /\b(def|return|if|elif|else|for|while|break|continue|class|import|from|as|try|except|finally|raise|with|yield|lambda|pass|True|False|None|and|or|not|is|in|global|nonlocal|del|assert|print|async|await|staticmethod|classmethod|property|super)\b/g,
        c:          /\b(if|else|for|while|do|switch|case|break|continue|return|typedef|struct|enum|union|const|static|extern|register|volatile|auto|inline|restrict|sizeof|NULL|true|false|void|int|char|float|double|long|short|unsigned|signed|size_t|FILE|printf|scanf|malloc|free|memcpy|memset)\b/g,
        cpp:        /\b(if|else|for|while|do|switch|case|break|continue|return|class|struct|enum|union|namespace|using|template|typename|public|private|protected|virtual|override|const|static|extern|volatile|mutable|auto|inline|constexpr|noexcept|decltype|new|delete|nullptr|true|false|void|int|char|float|double|long|short|unsigned|signed|bool|string|vector|map|set|pair|shared_ptr|unique_ptr|make_shared|make_unique|std|cout|cin|endl|include|define|ifdef|ifndef|endif|pragma)\b/g,
        java:       /\b(if|else|for|while|do|switch|case|break|continue|return|class|interface|enum|extends|implements|public|private|protected|static|final|abstract|synchronized|volatile|transient|native|new|this|super|true|false|null|void|int|char|float|double|long|short|byte|boolean|String|System|out|println|import|package|throws|try|catch|finally|instanceof|assert|default|sealed|permits|var|record|yield)\b/g,
        rust:       /\b(fn|let|mut|if|else|for|while|loop|match|return|break|continue|struct|enum|impl|trait|pub|use|mod|crate|self|super|where|as|ref|move|async|await|dyn|type|const|static|unsafe|extern|true|false|Some|None|Ok|Err|Self|String|Vec|Option|Result|Box|Rc|Arc|println|print|format|macro_rules)\b/g,
        go:         /\b(func|return|if|else|for|range|switch|case|break|continue|package|import|type|struct|interface|map|chan|go|defer|select|var|const|true|false|null|iota|nil|make|len|cap|append|copy|delete|new|panic|recover|error|fmt|Println|Printf|Print|Sprintf|Errorf|strings|strconv|math|os|io|http|json)\b/g,
        shell:      /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|local|export|source|alias|unalias|echo|printf|read|shift|set|unset|eval|exec|test|true|false|grep|sed|awk|find|sort|uniq|wc|head|tail|cat|cp|mv|rm|mkdir|chmod|chown|curl|wget|sudo|apt|yum|dnf|pip|npm|git|docker)\b/g,
        sql:        /\b(SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|INDEX|VIEW|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|NOT|IN|LIKE|BETWEEN|IS|NULL|AS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|DISTINCT|COUNT|SUM|AVG|MIN|MAX|UNION|ALL|EXISTS|CASE|WHEN|THEN|ELSE|END|PRIMARY|KEY|FOREIGN|REFERENCES|CONSTRAINT|DEFAULT|CHECK|UNIQUE|INT|INTEGER|VARCHAR|TEXT|BOOLEAN|DATE|TIMESTAMP|FLOAT|DOUBLE|DECIMAL)\b/gi,
        php:        /\b(function|return|if|else|elseif|for|foreach|while|do|switch|case|break|continue|class|extends|new|this|public|private|protected|static|const|var|echo|print|include|require|require_once|include_once|try|catch|finally|throw|true|false|null|void|int|float|string|bool|array|function|abstract|interface|trait|implements|namespace|use|as|global|yield|match|fn|readonly|enum|attribute)\b/g,
        ruby:       /\b(def|end|if|elsif|else|unless|while|until|for|do|break|next|redo|retry|return|class|module|include|extend|require|require_relative|self|true|false|nil|and|or|not|in|is_a?|puts|print|raise|begin|rescue|ensure|lambda|proc|yield|attr_accessor|attr_reader|attr_writer|private|protected|public|super|yield|then|when|case|def|undef|alias)\b/g,
        swift:      /\b(func|return|if|else|for|while|repeat|switch|case|break|continue|class|struct|enum|protocol|extension|import|public|private|internal|fileprivate|open|static|var|let|mutating|true|false|nil|self|Self|super|init|deinit|print|guard|defer|as|is|in|where|try|catch|throw|throws|async|await|actor|some|any|typealias|associatedtype|package)\b/g,
        kotlin:     /\b(fun|return|if|else|for|while|do|when|break|continue|class|interface|object|enum|data|sealed|abstract|open|internal|private|protected|public|override|var|val|lateinit|by|lazy|companion|object|true|false|null|this|super|is|as|in|!in|!is|typealias|suspend|crossinline|noinline|reified|it|println|listOf|mapOf|setOf|arrayOf|mutableListOf|mutableMapOf|mutableSetOf|with|run|apply|also|let|takeIf|takeUnless)\b/g,
        csharp:     /\b(function|return|if|else|for|foreach|while|do|switch|case|break|continue|class|struct|enum|interface|namespace|using|public|private|protected|internal|static|readonly|const|new|this|base|true|false|null|void|int|float|double|decimal|string|bool|object|var|dynamic|async|await|yield|lock|try|catch|finally|throw|checked|unchecked|params|out|ref|in|is|as|where|select|from|group|orderby|join|let|into|aggregate)\b/g,
        lua:        /\b(function|end|if|then|else|elseif|for|while|do|repeat|until|break|return|local|true|false|nil|and|or|not|in|select|pcall|xpcall|require|print|pairs|ipairs|next|type|tostring|tonumber|error|assert|loadstring|load|setmetatable|getmetatable|string|table|math|io|os|coroutine|rawget|rawset|rawequal|rawlen|dofile|loadfile|setfenv|getfenv)\b/g,
        perl:       /\b(sub|return|if|elsif|else|for|foreach|while|do|last|next|redo|break|continue|my|our|local|state|package|use|require|no|BEGIN|END|die|warn|print|say|open|close|read|write|seek|tell|eof|exists|delete|keys|values|each|push|pop|shift|unshift|splice|split|join|grep|map|sort|reverse|abs|int|exp|log|sqrt|sin|cos|rand|srand|length|substr|index|rindex|sprintf|printf|uc|lc| ucfirst|chomp|chop|chdir|chmod|chown|unlink|glob|system|exec|fork|wait|pipe|socket|bind|listen|accept|connect|send|recv|select)\b/g,
        r:          /\b(function|return|if|else|for|while|repeat|break|next|library|require|source|c|list|matrix|data\.frame|TRUE|FALSE|NA|NULL|Inf|NaN|print|cat|paste|paste0|nchar|substr|grep|grepl|sub|gsub|strsplit|sprintf|format|round|floor|ceiling|abs|sqrt|log|exp|sin|cos|tan|min|max|sum|mean|median|sd|var|length|seq|rep|which|any|all|is\.na|is\.null|is\.numeric|is\.character|as\.numeric|as\.character|as\.integer|as\.logical|class|typeof|str|head|tail|View|read\.csv|write\.csv|read\.table|write\.table|list\.files|dir\.create|file\.exists|file\.remove|install\.packages|installed\.packages|help|example)\b/g,
        objectivec: /\b(if|else|for|while|do|switch|case|break|continue|return|typedef|struct|enum|union|const|static|extern|volatile|auto|inline|sizeof|nil|NULL|true|false|YES|NO|self|super|class|public|private|protected|interface|implementation|protocol|selector|id|instancetype|void|int|char|float|double|long|short|unsigned|signed|BOOL|NSInteger|NSUInteger|CGFloat|NSString|NSArray|NSDictionary|NSNumber|NSLog|malloc|free|alloc|init|retain|release|autorelease|dealloc|@interface|@implementation|@end|@protocol|@selector|@property|@synthesize|@dynamic|@autoreleasepool|@try|@catch|@finally|@throw|@try)\b/g,
        dockerfile: /\b(FROM|RUN|CMD|COPY|ADD|ENTRYPOINT|ENV|ARG|EXPOSE|VOLUME|WORKDIR|USER|LABEL|STOPSIGNAL|HEALTHCHECK|SHELL|ONBUILD|AS)\b/g,
    };

    const kw = kwMap[lang] || kwMap.javascript;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];

        if (lang === 'c' || lang === 'cpp' || lang === 'java') {
            line = line.replace(/(#\s*\w+)/g, '<span style="color:' + c.preprocessor + '">$1</span>');
        }

        line = line.replace(/(\/\/.*$)/gm, '<span style="color:' + c.comment + ';font-style:italic">$1</span>');
        line = line.replace(/(\/\*[\s\S]*?\*\/)/g, '<span style="color:' + c.comment + ';font-style:italic">$1</span>');

        if (lang === 'python' || lang === 'shell' || lang === 'ruby' || lang === 'perl' || lang === 'r') {
            line = line.replace(/(#.*$)/gm, '<span style="color:' + c.comment + ';font-style:italic">$1</span>');
        }

        if (lang === 'python') {
            line = line.replace(/(@[\w.]+)/g, '<span style="color:' + c.decorator + ';font-style:italic">$1</span>');
            line = line.replace(/\b(self|cls)\b/g, '<span style="color:' + (c.self || c.parameter) + ';font-style:italic">$1</span>');
            line = line.replace(/(__(?:init|name|main|str__|repr__|enter__|exit__|call__|getitem__|setitem__|delitem__|len__|iter__|next__|eq__|ne__|lt__|le__|gt__|ge__|hash__|bool__|add__|sub__|mul__|truediv__|floordiv__|mod__|pow__|and__|or__|xor__|invert__|lshift__|rshift__|abs__|ceil__|floor__|round__|min__|max__|sum__|reversed__|sorted__|enumerate__|zip__|map__|filter__|type__|bases__|mro__|subclasses__|doc__|module__|dict__|class__|annotations__|qualname__|init_subclass__|set_name__|class_getitem__|copy__|deepcopy__|reduce__|getstate__|setstate__|sizeof__| subclasshook__)__)/g, '<span style="color:' + (c.magic || c.function) + ';font-style:italic">$1</span>');
        }

        if (lang === 'rust') {
            line = line.replace(/(r#?\w*"[^"]*"#?|r"[^"]*")/g, '<span style="color:' + c.string + '">$1</span>');
            line = line.replace(/('#?\w+)/g, '<span style="color:' + (c.lifetime || c.type) + ';font-style:italic">$1</span>');
            line = line.replace(/(#\[.*?\])/g, '<span style="color:' + (c.attribute || c.decorator) + ';font-style:italic">$1</span>');
            line = line.replace(/\b([a-z_]\w*)!/g, '<span style="color:' + (c.macro || c.function) + '">$1</span>!');
        }

        if (lang === 'go') {
            line = line.replace(/(&quot;[^&]*?&quot;|"[^"]*?")/g, function(m) {
                if (m.includes('%')) return '<span style="color:' + (c.format || c.string) + '">$1</span>';
                return '<span style="color:' + c.string + '">$1</span>';
            });
        }

        if (lang === 'shell') {
            line = line.replace(/(\$[\w{][\w}]*|\$\{[^}]+\})/g, '<span style="color:' + (c.variable || c.parameter) + '">$1</span>');
        }

        if (lang === 'ruby') {
            line = line.replace(/(:[\w!?]+)/g, '<span style="color:' + (c.symbol || c.constant) + '">$1</span>');
            line = line.replace(/(@@?[\w]+)/g, '<span style="color:' + (c.instance || c.parameter) + '">$1</span>');
        }

        if (lang === 'perl') {
            line = line.replace(/([\$@%][\w]+)/g, '<span style="color:' + (c.sigil || c.variable) + '">$1</span>');
        }

        line = line.replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, '<span style="color:' + c.string + '">$1</span>');

        line = line.replace(/\b([A-Z][A-Z_0-9]{2,})\b/g, '<span style="color:' + (c.constant || c.number) + '">$1</span>');

        line = line.replace(kw, '<span style="color:' + c.keyword + '">$1</span>');

        line = line.replace(/\b(\d+\.?\d*(?:e[+-]?\d+)?(?:f|l|u|ll|ull)?)\b/gi, '<span style="color:' + c.number + '">$1</span>');

        line = line.replace(/\b([a-zA-Z_]\w*)\s*\(/g, '<span style="color:' + c.function + '">$1</span>(');

        line = line.replace(/\.([a-zA-Z_]\w*)\b(?!\s*\()/g, '.<span style="color:' + (c.property || c.attr) + '">$1</span>');

        line = line.replace(/([+\-*/%=!<>&|^~?:]+)/g, '<span style="color:' + (c.operator || '#56b6c2') + '">$1</span>');

        result.push(line);
    }

    return result.join('\n');
}

function renderMarkdown(text) {
    const s = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    let html = '';

    const lines = s.split('\n');
    let inCodeBlock = false;
    let codeBlockLang = '';
    let codeBlockContent = '';
    let inTable = false;
    let tableRows = [];
    let inBlockquote = false;
    let blockquoteContent = '';
    let inList = false;
    let listItems = [];
    let listOrdered = false;
    let footnoteRefs = {};
    let footnoteDefIdx = 0;

    function closeBlockquote() {
        if (inBlockquote && blockquoteContent) {
            html += '<div style="border-left:3px solid #569cd6;padding:8px 12px;color:#aaa;margin:8px 0;background:rgba(86,156,214,0.06);border-radius:0 4px 4px 0">' + blockquoteContent + '</div>';
            blockquoteContent = '';
        }
        inBlockquote = false;
    }

    function closeList() {
        if (inList && listItems.length > 0) {
            listItems.forEach((item, idx) => {
                const check = item.checked !== null ? '<input type="checkbox" disabled' + (item.checked ? ' checked' : '') + ' style="margin-right:6px;vertical-align:middle">' : '';
                const num = listOrdered ? '<span style="color:#888;margin-right:6px;min-width:20px;display:inline-block">' + (idx + 1) + '.</span>' : '';
                const bullet = !listOrdered && item.checked === null ? '<span style="color:#569cd6;margin-right:6px">•</span>' : '';
                const prefix = check || num || bullet;
                const indent = item.indent ? 'padding-left:' + (item.indent * 20) + 'px' : 'padding-left:4px';
                html += '<div style="' + indent + ';margin:3px 0;line-height:1.6">' + prefix + inlineFormat(item.text) + '</div>';
            });
            listItems = [];
        }
        inList = false;
        listOrdered = false;
    }

    function closeTable() {
        if (inTable && tableRows.length > 0) {
            const alignments = [];
            if (tableRows.length > 1) {
                const sepCells = tableRows[1].cells;
                sepCells.forEach(cell => {
                    const trimmed = cell.trim();
                    if (trimmed.startsWith(':') && trimmed.endsWith(':')) alignments.push('center');
                    else if (trimmed.endsWith(':')) alignments.push('right');
                    else alignments.push('left');
                });
            }
            html += '<div style="overflow-x:auto;margin:8px 0"><table style="border-collapse:collapse;width:100%;font-size:13px">';
            tableRows.forEach((row, rIdx) => {
                if (rIdx === 1) return;
                html += '<tr>';
                row.cells.forEach((cell, cIdx) => {
                    const tag = rIdx === 0 ? 'th' : 'td';
                    const align = alignments[cIdx] || 'left';
                    const border = rIdx === 0 ? 'border-bottom:2px solid #3d3d3d;font-weight:600' : 'border-bottom:1px solid #2d2d2d';
                    const bg = rIdx === 0 ? 'background:#252526' : (rIdx % 2 === 0 ? 'background:#1e1e1e' : 'background:#252526');
                    html += '<' + tag + ' style="padding:6px 12px;text-align:' + align + ';' + border + ';' + bg + ';color:#d4d4d4">' + inlineFormat(cell.trim()) + '</' + tag + '>';
                });
                html += '</tr>';
            });
            html += '</table></div>';
            tableRows = [];
        }
        inTable = false;
    }

    function inlineFormat(t) {
        t = t.replace(/\*\*(.+?)\*\*/g, '<strong style="color:#e0e0e0">$1</strong>');
        t = t.replace(/\*(.+?)\*/g, '<em style="color:#d0d0d0">$1</em>');
        t = t.replace(/~~(.+?)~~/g, '<del style="color:#888">$1</del>');
        t = t.replace(/==(.+?)==/g, '<mark style="background:#5a4a18;color:#e0e0e0;padding:1px 4px;border-radius:2px">$1</mark>');
        t = t.replace(/`(.+?)`/g, '<code style="background:#2d2d2d;padding:2px 6px;border-radius:3px;font-family:monospace;color:#e06c75;font-size:12px">$1</code>');
        t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#569cd6;text-decoration:none;border-bottom:1px solid #569cd666" target="_blank" rel="noopener">$1</a>');
        t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:4px;margin:4px 0">');
        t = t.replace(/H~2~O/g, 'H<sub style="font-size:0.8em">2</sub>O');
        t = t.replace(/~(.+?)~/g, '<sub style="font-size:0.8em">$1</sub>');
        t = t.replace(/\^(.+?)\^/g, '<sup style="font-size:0.8em">$1</sup>');
        t = t.replace(/:([\w+-]+):/g, function(m) {
            const emojis = { 'smile': '😄', 'heart': '❤️', 'thumbsup': '👍', 'rocket': '🚀', 'fire': '🔥', 'check': '✅', 'warning': '⚠️', 'info': 'ℹ️', 'star': '⭐', 'bug': '🐛', 'sparkles': '✨', 'tada': '🎉', 'wave': '👋', 'eyes': '👀', 'clap': '👏', 'think': '🤔', 'muscle': '💪', 'pray': '🙏', 'rainbow': '🌈', 'party': '🎉', 'white_check_mark': '✅', 'x': '❌', 'heavy_check_mark': '✔️', 'memo': '📝', 'pushpin': '📌', 'bulb': '💡', 'zap': '⚡', 'book': '📚', 'wrench': '🔧', 'gear': '⚙️', 'hammer': '🔨', 'lock': '🔒', 'key': '🔑', 'package': '📦', 'robot': '🤖', 'alien': '👽', 'ghost': '👻', 'skull': '💀', 'poop': '💩', 'clown': '🤡', 'sunglasses': '😎', 'nerd': '🤓', 'thinking': '🤔', 'shushing': '🤫', 'money': '💰', 'crown': '👑', 'gem': '💎', 'trophy': '🏆', 'medal': '🥇', 'soccer': '⚽', 'basketball': '🏀', 'baseball': '⚾', 'football': '🏈', 'tennis': '🎾', 'video_game': '🎮', 'joystick': '🕹️', 'dart': '🎯', 'art': '🎨', 'camera': '📷', 'video': 'VIDEO', 'microphone': '🎤', 'headphones': '🎧', 'guitar': '🎸', 'piano': '🎹', 'trumpet': '🎺', 'violin': '🎻', 'drum': '🥁', 'coffee': '☕', 'pizza': '🍕', 'hamburger': '🍔', 'fries': '🍟', 'taco': '🌮', 'sushi': '🍣', 'cookie': '🍪', 'cake': '🎂', 'pie': '🥧', 'icecream': '🍦', 'candy': '🍬', 'lollipop': '🍭', 'apple': '🍎', 'banana': '🍌', 'grapes': '🍇', 'watermelon': '🍉', 'orange': '🍊', 'lemon': '🍋', 'strawberry': '🍓', 'peach': '🍑', 'coconut': '🥥', 'avocado': '🥑', 'carrot': '🥕', 'corn': '🌽', 'broccoli': '🥦', 'hotdog': '🌭', 'pretzel': '🥨', 'bread': '🍞', 'cheese': '🧀', 'egg': '🥚', 'bacon': '🥓', 'steak': '🥩', 'poultry': '🍗', 'seafood': '🦞', 'crab': '🦀', 'shrimp': '🦐', 'octopus': '🐙', 'fish': '🐟', 'dolphin': '🐬', 'whale': '🐳', 'shark': '🦈', 'crocodile': '🐊', 'snake': '🐍', 'lizard': '🦎', 'turtle': '🐢', 'frog': '🐸', 'monkey': '🐒', 'gorilla': '🦍', 'dog': '🐕', 'cat': '🐈', 'mouse': '🐁', 'rabbit': '🐇', 'hamster': '🐹', 'bear': '🐻', 'panda': '🐼', 'tiger': '🐯', 'lion': '🦁', 'cow': '🐄', 'pig': '🐷', 'chicken': '🐔', 'penguin': '🐧', 'bird': '🐦', 'eagle': '🦅', 'duck': '🦆', 'owl': '🦉', 'bat': '🦇', 'butterfly': '🦋', 'bee': '🐝', 'ladybug': '🐞', 'ant': '🐜', 'spider': '🕷️', 'scorpion': '🦂', 'snail': '🐌', 'worm': '🐛', 'flower': '🌸', 'rose': '🌹', 'tulip': '🌷', 'sunflower': '🌻', 'tree': '🌳', 'palm': '🌴', 'cactus': '🌵', 'mushroom': '🍄', 'leaf': '🍃', 'seedling': '🌱', 'earth': '🌍', 'moon': '🌙', 'sun': '☀️', 'star': '⭐', 'comet': '☄️', 'cloud': '☁️', 'storm': '⛈️', 'rain': '🌧️', 'snow': '❄️', 'wind': '💨', 'tornado': '🌪️', 'fire': '🔥', 'droplet': '💧', 'ocean': '🌊', 'diamond': '💎', 'crystal': '🔮', ' magnet': '🧲', 'battery': '🔋', 'bulb': '💡', 'wire': '🔌', 'computer': '💻', 'laptop': '💻', 'desktop': '🖥️', 'phone': '📱', 'tablet': '📟', 'keyboard': '⌨️', 'mouse': '🖱️', 'floppy': '💾', 'cd': '💿', 'dvd': '📀', 'camera': '📷', 'tv': '📺', 'radio': '📻', 'satellite': '📡', 'telescope': '🔭', 'microscope': '🔬', 'test_tube': '🧪', 'dna': '🧬', 'pill': '💊', 'syringe': '💉', 'thermometer': '🌡️', 'stethoscope': '🩺', 'mortar': '⚗️', 'rocket': '🚀', 'airplane': '✈️', 'helicopter': '🚁', 'boat': '⛵', 'ship': '🚢', 'car': '🚗', 'truck': '🚚', 'bus': '🚌', 'ambulance': '🚑', 'fire': '🚒', 'police': '🚔', 'taxi': '🚕', 'bicycle': '🚲', 'motorcycle': '🏍️', 'train': '🚂', 'subway': '🚇', 'ticket': '🎫', 'compass': '🧭', 'map': '🗺️', 'pin': '📍', 'flag': '🚩', 'anchor': '⚓', 'chain': '🔗', 'lock': '🔒', 'unlock': '🔓', 'key': '🔑', 'shield': '🛡️', 'sword': '⚔️', 'crossed_swords': '⚔️', 'wand': '🪄', 'crystal_ball': '🔮', 'mystery': '🔮', 'speech': '💬', 'thought': '💭', 'envelope': '✉️', 'email': '📧', 'inbox': '📥', 'outbox': '📤', 'package': '📦', 'mailbox': '📫', 'bell': '🔔', 'no_bell': '🔕', 'heart': '❤️', 'broken_heart': '💔', 'sparkling_heart': '💖', 'grow_heart': '💗', 'blue_heart': '💙', 'green_heart': '💚', 'purple_heart': '💜', 'black_heart': '🖤', 'white_heart': '🤍', 'brown_heart': '🤎', 'orange_heart': '🧡', 'yellow_heart': '💛', '100': '💯', 'infinity': '♾️', 'check_mark': '✔️', 'x_mark': '❌', 'warning': '⚠️', 'no_entry': '🚫', 'prohibited': '禁止', 'question': '❓', 'exclamation': '❗', 'bangbang': '‼️', 'interrobang': '⁉️', 'recycle': '♻️', 'atom': '⚛️', 'wheelchair': '♿', 'globe': '🌐', 'atom_symbol': '⚛️', 'fleur_de_lis': '⚜️', 'radioactive': '☢️', 'biohazard': '☣️', 'trident': '🔱', 'name_badge': '📛', 'beginner': '🔰', 'o': '⭕', 'white_check': '✅', 'cyclone': '🌀', 'sparkle': '❇️', 'maggie': '✳️', 'eight_spoked': '✳️', 'vs': '🆚', 'up': '🆙', 'cool': '🆒', 'new': '🆕', 'free': '🆓', 'koko': '🈁', 'sa': '🈂️', 'u7121': '🈚', 'u6307': '🈯', 'u7981': '🈲', 'u7533': '🈸', 'u5408': '🈴', 'u7a7a': '🈳', 'congratulations': '㊗️', 'secret': '㊙️', 'u55b6': '🈺', 'u6e80': '🈵', 'elevator': '🛗', 'wheelchair2': '♿', 'men_room': '🚹', 'women_room': '🚺', 'restroom': '🚻', 'baby_symbol': '🚼', 'wc': '🚾', 'passport': '🛂', 'baggage': '🛅', 'left_luggage': '🛅', 'customs': '🛃', 'mantelpiece': '🗝️', 'old_key': '🗝️', 'couch': '🛋️', 'bed': '🛏️', 'sleeping': '🛌', 'teddy': '🧸', 'framed': '🖼️', 'mirror': '🪞', 'shower': '🚿', 'bathtub': '🛁', 'toothbrush': '🪥', 'toilet': '🚽', 'plunger': '🪠', 'shampoo': '🧴', 'sponge': '🧽', 'lotion': '🧴', 'ring': '💍', 'lipstick': '💄', 'purse': '👛', 'handbag': '👜', 'briefcase': '💼', 'backpack': '🎒', 'shoe': '👞', 'sandal': '👡', 'boot': '👢', 'hat': '👒', 'top_hat': '🎩', 'cap': '🧢', 'crown': '👑', 'scarf': '🧣', 'gloves': '🧤', 'coat': '🧥', 'dress': '👗', 'kimono': '👘', 'bikini': '👙', 'womans_clothes': '👚', 'pocket': '👛', 'folded': '🧎', 'open_hands': '👐', 'raised_hands': '🙌', 'clap': '👏', 'handshake': '🤝', 'pray': '🙏', 'writing': '✍️', 'nail': '💅', 'selfie': '🤳', 'muscle': '💪', 'leg': '🦵', 'foot': '🦶', 'ear': '👂', 'nose': '👃', 'brain': '🧠', 'eyes': '👀', 'eye': '👁️', 'tongue': '👅', 'lips': '👄', 'kiss': '💋', 'love_letter': '💌', 'cupid': '💘', 'gift_heart': '💝', 'revolving_hearts': '💞', 'two_hearts': '💕', 'heartbeat': '💓', 'pulse': '💗', 'sparkling_heart': '💖', 'gift': '🎁', 'balloon': '🎈', 'confetti': '🎊', 'tada': '🎉', 'wind_chime': '🎐', 'izakaya': '🏮', 'red_envelope': '🧧', 'ribbon': '🎀', 'reminder': '🔖', 'tickets': '🎟️', 'military': '🎖️', 'medal_sports': '🏅', 'medal_first': '🥇', 'medal_second': '🥈', 'medal_third': '🥉', 'soccer_ball': '⚽', 'baseball': '⚾', 'golf': '⛳', 'ice_hockey': '🏒', 'ski': '🎿', 'cricket': '🏏', 'volleyball': '🏐', 'rugby': '🏉', 'tennis': '🎾', 'ping_pong': '🏓', 'badminton': '🏸', 'hockey': '🏒', 'goal': '🥅', 'ice_skate': '⛸️', 'fishing': '🎣', 'mask': '🎭', 'art': '🎨', 'clapper': '🎬', 'microphone': '🎤', 'headphones': '🎧', 'musical_score': '🎼', 'musical_keyboard': '🎹', 'drum': '🥁', 'saxophone': '🎷', 'trumpet': '🎺', 'guitar': '🎸', 'violin': '🎻', 'video_game': '🎮', 'slot_machine': '🎰', 'dice': '🎲', 'puzzle': '🧩', 'teddy_bear': '🧸', 'framed_picture': '🖼️', 'thread': '🧵', 'yarn': '🧶', 'scissors': '✂️', 'knife': '🔪', 'dagger': '🗡️', 'crossed_swords': '⚔️', 'shield': '🛡️', 'smoking': '🚬', 'coffin': '⚰️', 'funeral': '⚱️', 'memento': '🗿', 'placard': '🪧', ' identification': '🪪', 'oil': '🛢️', 'bowl': '🥣', 'cup_straw': '🥤', 'chopsticks': '🥢', 'fork_knife': '🍽️', 'spoon': '🥄', 'cooking': '🍳', 'popcorn': '🍿', 'salt': '🧂', 'can': '🥫', 'bento': '🍱', 'rice': '🍙', 'onigiri': '🍙', 'dango': '🍡', 'crab': '🦀', 'lobster': '🦞', 'shrimp': '🦐', 'squid': '🦑', 'fried': '🍟', 'donut': '🍩', 'cookie': '🍪', 'chocolate': '🍫', 'candy': '🍬', 'lollipop': '🍭', 'custard': '🍮', 'honey': '🍯', 'baby_bottle': '🍼', 'milk': '🥛', 'coffee2': '☕', 'tea': '🍵', 'sake': '🍶', 'champagne': '🍾', 'wine': '🍷', 'cocktail': '🍸', 'tropical': '🍹', 'beer': '🍺', 'beers': '🍻', 'clinking': '🥂', 'whisky': '🥃', 'ice_cube': '🧊', 'spoon_straw': '🥄', 'bottle': '🫗', 'cup': '🫖', 'mate': '🧉', 'ice': '🧊', 'chopsticks2': '🥢', 'bowl2': '🍜', 'plate_cutlery': '🍽️', 'fork': '🍴', 'spoon2': '🥄', 'knife2': '🔪', 'amphora': '🏺', 'world_map': '🗺️', 'moyai': '🗿', 'nazar': '🧿', 'ocarina': '🪈', 'diya': '🪔', 'card': '💳', 'atm': '🏧', 'receipt': '🧾', 'abacus': '🧮', 'abacus2': '🧮', 'chart': '📈', 'bar_chart': '📊', 'clipboard': '📋', 'pushpin': '📌', 'round_pushpin': '📍', 'paperclip': '📎', 'scissors2': '✂️', 'triangular_ruler': '📐', 'straight_ruler': '📏', 'bookmark': '🔖', 'label': '🏷️', 'envelope2': '✉️', 'email2': '📧', 'incoming': '📥', 'outgoing': '📤', 'package2': '📦', 'mailbox_closed': '📪', 'mailbox_open': '📬', 'newspaper': '📰', 'rolled_up': '🗞️', 'bookmark_tabs': '📑', 'page_facing_up': '📄', 'page_with_curl': '📃', 'receipt': '🧾', 'ledger': '📒', 'notebook': '📓', 'closed_book': '📕', 'green_book': '📗', 'blue_book': '📘', 'orange_book': '📙', 'books': '📚', 'notebook_with_decorative': '📔', 'bookmark2': '🔖', 'money_with_wings': '💸', 'dollar': '💵', 'yen': '💴', 'euro': '💶', 'pound': '💷', 'coin': '🪙', 'yen2': '💰', 'wallet': '👛', 'purse2': '👛', 'credit_card': '💳', 'handbag2': '👜', 'briefcase2': '💼', 'receipt2': '🧾', 'chart2': '📈', 'chart_down': '📉', 'bar_chart2': '📊', 'pie_chart': '🥧', 'boxing': '🥊', 'martial': '🥋', 'running_shoe': '👟', 'ski2': '🎿', 'sled': '🛷', 'curling_stone': '🥌', 'trophy': '🏆', 'gold': '🥇', 'silver': '🥈', 'bronze': '🥉', 'medal2': '🏅', 'medal3': '🎖️', 'rosette': '🏵️', 'ribbon2': '🎀', 'reminder_ribbon': 'reminder_ribbon', 'ticket2': '🎟️', 'tickets2': '🎟️', 'admission': '🎫', 'pass': '🎫', 'passport2': '🛂', 'baggage_claim': '🛅', 'left_luggage2': '🛅', 'customs2': '🛃', 'warning2': '⚠️', 'children_crossing': '🚸', 'construction': '🚧', 'no_entry2': '🚫', 'no_bicycles': '🚳', 'no_smoking': '🚭', 'do_not': '🚯', 'no_pedestrians': '🚷', 'no_mobile': '📵', 'underage': '🔞', 'radioactive2': '☢️', 'biohazard2': '☣️', 'arrow_up': '⬆️', 'arrow_down': '⬇️', 'arrow_left': '⬅️', 'arrow_right': '➡️', 'arrow_upper_right': '↗️', 'arrow_lower_right': '↘️', 'arrow_lower_left': '↙️', 'arrow_upper_left': '↖️', 'arrow_up_down': '↕️', 'left_right': '↔️', 'arrow_right_hook': '↪️', 'leftwards_arrow': '↩️', 'arrow_heading_up': '⤴️', 'arrow_heading_down': '⤵️', 'arrow_clockwise': '🔄', 'arrow_counterclockwise': '🔃', 'arrow_back': '🔙', 'arrow_end': '🔚', 'arrow_on': '🔛', 'arrow_top': '🔝', 'soon': '🔜', 'arrow_doubles': '➿', 'arrow_doubles2': '➿', 'arrow_doubles3': '➿', 'arrow_doubles4': '➿', 'arrow_doubles5': '➿', 'arrow_doubles6': '➿', 'arrow_doubles7': '➿', 'arrow_doubles8': '➿' };
            const key = m.slice(1, -1);
            return emojis[key] || m;
        });
        return t;
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (inCodeBlock) {
            if (line.trim() === '```') {
                const langAttr = codeBlockLang ? ' data-lang="' + codeBlockLang + '"' : '';
                html += '<div style="position:relative;margin:8px 0"><pre style="background:#1e1e1e;border:1px solid #3d3d3d;border-radius:6px;padding:12px;margin:0;overflow-x:auto;font-family:monospace;font-size:13px;color:#d4d4d4;line-height:1.5"' + langAttr + '><code>' + codeBlockContent + '</code></pre></div>';
                codeBlockContent = '';
                codeBlockLang = '';
                inCodeBlock = false;
            } else {
                codeBlockContent += (codeBlockContent ? '\n' : '') + line;
            }
            continue;
        }

        if (line.trim().startsWith('```')) {
            closeBlockquote();
            closeList();
            closeTable();
            inCodeBlock = true;
            codeBlockLang = line.trim().slice(3).trim();
            codeBlockContent = '';
            continue;
        }

        if (line.match(/^\|(.+)\|$/)) {
            closeBlockquote();
            closeList();
            if (!inTable) {
                inTable = true;
                tableRows = [];
            }
            const cells = line.trim().slice(1, -1).split('|');
            tableRows.push({ cells: cells });
            continue;
        } else {
            closeTable();
        }

        if (line.match(/^>\s/)) {
            closeList();
            const content = line.replace(/^>\s*/, '');
            inBlockquote = true;
            blockquoteContent += (blockquoteContent ? '<br>' : '') + inlineFormat(content);
            continue;
        } else {
            closeBlockquote();
        }

        const taskMatch = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)/);
        if (taskMatch) {
            closeTable();
            if (!inList) { inList = true; listOrdered = false; listItems = []; }
            const indent = taskMatch[1].length;
            const checked = taskMatch[2] !== ' ';
            listItems.push({ text: taskMatch[3], checked: checked, indent: Math.floor(indent / 2) });
            continue;
        }

        const bulletMatch = line.match(/^(\s*)[-*+]\s+(.*)/);
        if (bulletMatch) {
            closeTable();
            if (!inList) { inList = true; listOrdered = false; listItems = []; }
            const indent = bulletMatch[1].length;
            listItems.push({ text: bulletMatch[2], checked: null, indent: Math.floor(indent / 2) });
            continue;
        }

        const orderedMatch = line.match(/^(\s*)\d+\.\s+(.*)/);
        if (orderedMatch) {
            closeTable();
            if (!inList || !listOrdered) {
                closeList();
                inList = true;
                listOrdered = true;
                listItems = [];
            }
            const indent = orderedMatch[1].length;
            listItems.push({ text: orderedMatch[2], checked: null, indent: Math.floor(indent / 2) });
            continue;
        }

        closeList();

        if (line.match(/^#{1,6}\s/)) {
            const level = line.match(/^(#{1,6})\s/)[1].length;
            const content = line.replace(/^#{1,6}\s+/, '');
            const sizes = { 1: '22px', 2: '19px', 3: '16px', 4: '15px', 5: '14px', 6: '13px' };
            const weights = { 1: '700', 2: '600', 3: '600', 4: '500', 5: '500', 6: '500' };
            const margins = { 1: '16px 0 8px', 2: '14px 0 6px', 3: '12px 0 6px', 4: '10px 0 4px', 5: '8px 0 4px', 6: '6px 0 4px' };
            html += '<h' + level + ' style="color:#e0e0e0;margin:' + margins[level] + ';font-size:' + sizes[level] + ';font-weight:' + weights[level] + '">' + inlineFormat(content) + '</h' + level + '>';
            continue;
        }

        if (line.match(/^(-{3,}|\*{3,}|_{3,})$/)) {
            closeTable();
            html += '<hr style="border:none;border-top:1px solid #3d3d3d;margin:12px 0">';
            continue;
        }

        if (line.trim() === '') {
            closeList();
            closeBlockquote();
            continue;
        }

        html += '<div style="margin:4px 0;line-height:1.6">' + inlineFormat(line) + '</div>';
    }

    closeBlockquote();
    closeList();
    closeTable();

    return html;
}

function normalizeAudioMimeType(mime) {
    if (!mime) return 'audio/mpeg';
    const m = mime.toLowerCase().trim();
    // audio/mp3 is non-standard, Chrome needs audio/mpeg
    if (m === 'audio/mp3' || m === 'audio/mpeg3') return 'audio/mpeg';
    return mime;
}

function getFileIcon(mimeType, filename) {
    if (!mimeType) return '📄';
    if (mimeType.startsWith('image/')) return '🖼️';
    if (mimeType.startsWith('video/')) return '🎬';
    if (mimeType.startsWith('audio/')) return '🎵';
    if (mimeType.includes('pdf')) return '📕';
    if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar') || mimeType.includes('gzip')) return '📦';
    if (mimeType.includes('word') || mimeType.includes('document')) return '📝';
    if (mimeType.includes('sheet') || mimeType.includes('excel')) return '📊';
    if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return '📽️';

    const ext = filename ? filename.split('.').pop().toLowerCase() : '';
    const iconMap = {
        'js': '🟨', 'mjs': '🟨', 'jsx': '⚛️',
        'ts': '🔷', 'tsx': '⚛️',
        'py': '🐍', 'pyw': '🐍',
        'c': '©️', 'h': '©️',
        'cpp': '➕', 'cxx': '➕', 'cc': '➕', 'hpp': '➕',
        'java': '☕',
        'rs': '🦀',
        'go': '🐹',
        'sh': '🖥️', 'bash': '🖥️', 'zsh': '🖥️',
        'sql': '🗃️',
        'html': '🌐', 'htm': '🌐',
        'css': '🎨',
        'json': '📋',
        'xml': '📋',
        'rb': '💎',
        'php': '🐘',
        'swift': '🐦',
        'kt': '🟣',
        'cs': '🟩',
        'lua': '🌙',
        'pl': '🐪',
        'r': '📈',
        'm': '🍎', 'mm': '🍎',
        'yaml': '⚙️', 'yml': '⚙️',
        'toml': '⚙️',
        'md': '📖', 'mdx': '📖', 'markdown': '📖',
        'txt': '📄', 'log': '📄',
        'csv': '📊',
        'svg': '🎨',
        'dockerfile': '🐳', 'docker-compose': '🐳',
        'env': '🔒',
        'ini': '⚙️', 'cfg': '⚙️', 'conf': '⚙️',
    };
    return iconMap[ext] || '📄';
}

// ===== Drag and Drop =====
let dragCounter = 0;

function setupDragAndDrop() {
    const mainEl = document.querySelector('.main');
    const overlay = document.getElementById('drop-zone-overlay');
    if (!mainEl || !overlay) return;

    mainEl.addEventListener('dragenter', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter++;
        if ((currentChannelId || currentDmChannelId) && !isUploading) {
            overlay.classList.add('active');
        }
    });

    mainEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
    });

    mainEl.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            overlay.classList.remove('active');
        }
    });

    mainEl.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter = 0;
        overlay.classList.remove('active');

        if (!currentChannelId && !currentDmChannelId) return;
        if (isUploading) return;
        // If modal is open, let modal handle the drop
        if (document.getElementById('upload-modal').style.display === 'flex') return;

        const files = Array.from(e.dataTransfer.files);
        if (files.length === 0) return;

        const oversized = files.find(f => f.size > 1024 * 1024 * 1024);
        if (oversized) {
            alert('File too large: ' + oversized.name + '. Maximum file size is 1 GB.');
            return;
        }

        selectedFiles = files;
        currentFileIndex = 0;
        showUploadModal();
    });
}

function setupModalDragAndDrop() {
    const modal = document.getElementById('upload-modal');
    const overlay = document.getElementById('modal-drop-overlay');
    if (!modal || !overlay) return;

    let modalDragCounter = 0;

    modal.addEventListener('dragenter', (e) => {
        e.preventDefault();
        e.stopPropagation();
        modalDragCounter++;
        if (isUploading) return;
        overlay.classList.add('active');
    });

    modal.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
    });

    modal.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        modalDragCounter--;
        if (modalDragCounter <= 0) {
            modalDragCounter = 0;
            overlay.classList.remove('active');
        }
    });

    modal.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        modalDragCounter = 0;
        overlay.classList.remove('active');

        if (isUploading) return;

        const files = Array.from(e.dataTransfer.files);
        if (files.length === 0) return;

        const oversized = files.find(f => f.size > 1024 * 1024 * 1024);
        if (oversized) {
            alert('File too large: ' + oversized.name + '. Maximum file size is 1 GB.');
            return;
        }

        // Append dropped files to existing selection
        selectedFiles = selectedFiles.concat(files);
        currentFileIndex = 0;
        renderUploadPreview();
        
        // Update confirm button text
        const confirmBtn = document.getElementById('confirm-upload');
        if (confirmBtn) {
            confirmBtn.textContent = selectedFiles.length > 1 ? 'Upload All (' + selectedFiles.length + ')' : 'Upload';
        }
    });
}

function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    const oversized = files.find(f => f.size > 1024 * 1024 * 1024);
    if (oversized) {
        alert('File too large: ' + oversized.name + '. Maximum file size is 1 GB.');
        e.target.value = '';
        return;
    }
    selectedFiles = files;
    currentFileIndex = 0;
    showUploadModal();
    e.target.value = '';
}

function showUploadModal() {
    const modal = document.getElementById('upload-modal');
    const info = document.getElementById('upload-file-info');
    const preview = document.getElementById('upload-preview');
    const progressContainer = document.getElementById('upload-progress-container');
    const errorEl = document.getElementById('upload-error');
    const confirmBtn = document.getElementById('confirm-upload');

    progressContainer.style.display = 'none';
    errorEl.style.display = 'none';
    confirmBtn.disabled = false;
    confirmBtn.textContent = selectedFiles.length > 1 ? 'Upload All (' + selectedFiles.length + ')' : 'Upload';

    renderUploadPreview();
    modal.style.display = 'flex';
}

function renderUploadPreview() {
    const info = document.getElementById('upload-file-info');
    const preview = document.getElementById('upload-preview');
    if (!preview) return;

    // Clean up old gallery nav
    const oldGallery = document.querySelector('.upload-gallery');
    if (oldGallery) oldGallery.remove();

    // Revoke old URLs
    preview.querySelectorAll('img, video, audio').forEach(el => {
        if (el.src && el.src.startsWith('blob:')) URL.revokeObjectURL(el.src);
    });
    preview.innerHTML = '';

    if (selectedFiles.length === 0) return;
    const file = selectedFiles[currentFileIndex];

    // Build info + file list
    let fileListHtml = '';
    if (selectedFiles.length > 1) {
        fileListHtml = '<div class="upload-file-list">';
        selectedFiles.forEach((f, idx) => {
            const active = idx === currentFileIndex ? ' active' : '';
            fileListHtml += '<div class="upload-file-item' + active + '" data-idx="' + idx + '">' +
                '<span class="ufi-icon">' + getFileIcon(f.type) + '</span>' +
                '<span class="ufi-name">' + escapeHtml(f.name) + '</span>' +
                '<button class="ufi-remove" data-idx="' + idx + '">&times;</button>' +
                '</div>';
        });
        fileListHtml += '</div>';
    }

    info.innerHTML = '<div class="ufi-name">' + escapeHtml(file.name) + '</div>' +
        '<div class="ufi-meta">' + formatFileSize(file.size) + ' • ' + escapeHtml(file.type || 'Unknown') +
        (selectedFiles.length > 1 ? ' • File ' + (currentFileIndex + 1) + ' of ' + selectedFiles.length : '') + '</div>' +
        fileListHtml;

    // Gallery nav
    if (selectedFiles.length > 1) {
        const navHtml = '<div class="upload-gallery">' +
            '<button class="gallery-nav-btn" id="gallery-prev" ' + (currentFileIndex === 0 ? 'disabled' : '') + '>&#8249;</button>' +
            '<span class="gallery-counter">' + (currentFileIndex + 1) + ' / ' + selectedFiles.length + '</span>' +
            '<button class="gallery-nav-btn" id="gallery-next" ' + (currentFileIndex === selectedFiles.length - 1 ? 'disabled' : '') + '>&#8250;</button>' +
            '</div>';
        preview.insertAdjacentHTML('beforebegin', navHtml);
        document.getElementById('gallery-prev').addEventListener('click', () => { if (currentFileIndex > 0) { currentFileIndex--; renderUploadPreview(); } });
        document.getElementById('gallery-next').addEventListener('click', () => { if (currentFileIndex < selectedFiles.length - 1) { currentFileIndex++; renderUploadPreview(); } });
    }

    // File list click/removal
    info.querySelectorAll('.upload-file-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.closest('.ufi-remove')) return;
            currentFileIndex = parseInt(item.dataset.idx);
            renderUploadPreview();
        });
    });
    info.querySelectorAll('.ufi-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx);
            selectedFiles.splice(idx, 1);
            if (currentFileIndex >= selectedFiles.length) currentFileIndex = Math.max(0, selectedFiles.length - 1);
            if (selectedFiles.length === 0) { closeUploadModal(); return; }
            renderUploadPreview();
            document.getElementById('confirm-upload').textContent = selectedFiles.length > 1 ? 'Upload All (' + selectedFiles.length + ')' : 'Upload';
        });
    });

    // Preview current file
    if (file.type && file.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        preview.appendChild(img);
    } else if (file.type && file.type.startsWith('video/')) {
        const video = document.createElement('video');
        video.src = URL.createObjectURL(file);
        video.controls = true;
        video.style.maxWidth = '100%';
        video.style.maxHeight = '200px';
        video.style.borderRadius = '8px';
        preview.appendChild(video);
    } else if (file.type && file.type.startsWith('audio/')) {
        const audio = document.createElement('audio');
        audio.src = URL.createObjectURL(file);
        audio.controls = true;
        audio.preload = 'metadata';
        audio.style.width = '100%';
        preview.appendChild(audio);
    }
}

function closeUploadModal() {
    const modal = document.getElementById('upload-modal');
    const previewEl = document.getElementById('upload-preview');
    if (previewEl) {
        previewEl.querySelectorAll('img, video, audio').forEach(el => {
            if (el.src && el.src.startsWith('blob:')) URL.revokeObjectURL(el.src);
        });
        previewEl.innerHTML = '';
    }
    // Also clean up the gallery nav
    const galleryNav = document.querySelector('.upload-gallery');
    if (galleryNav) galleryNav.remove();
    modal.style.display = 'none';
    selectedFiles = [];
    currentFileIndex = 0;
    isUploading = false;
    const addMoreInput = document.getElementById('add-more-file-input');
    if (addMoreInput) addMoreInput.value = '';
    const addMoreBtn = document.getElementById('add-more-files');
    if (addMoreBtn) addMoreBtn.style.display = '';
}

async function uploadFileToServer(file) {
    const fileKey = E2ECrypto.generateFileKey();
    const fileKeyB64 = E2ECrypto.arrayBufferToBase64(fileKey);

    const initRes = await authFetch('/api/files/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ size: file.size, mime: getCorrectMimeType(file.name, file.type) || 'application/octet-stream' })
    });
    if (!initRes.ok) {
        const err = await initRes.json();
        throw new Error(err.error || 'Failed to initialize upload');
    }
    const { file_id } = await initRes.json();

    const CHUNK_SIZE = 64 * 1024;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunkData = new Uint8Array(await file.slice(start, end).arrayBuffer());
        const encryptedChunk = E2ECrypto.encryptFileChunk(fileKey, chunkData);
        const chunkRes = await authFetch('/api/files/' + file_id + '/chunk/' + i, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: encryptedChunk
        });
        if (!chunkRes.ok) throw new Error('Failed to upload chunk ' + (i + 1));
    }

    const completeRes = await authFetch('/api/files/' + file_id + '/complete', { method: 'POST' });
    if (!completeRes.ok) throw new Error('Failed to finalize upload');

    return {
        type: 'file', file_id, filename: file.name,
        mime_type: getCorrectMimeType(file.name, file.type) || 'application/octet-stream',
        file_size: file.size, file_key: fileKeyB64
    };
}

async function startFileUpload() {
    if (selectedFiles.length === 0 || isUploading) return;
    const isDm = viewMode === 'dms';
    if (!isDm && !currentChannelId) return;
    if (isDm && !currentDmChannelId) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    isUploading = true;
    const confirmBtn = document.getElementById('confirm-upload');
    const progressContainer = document.getElementById('upload-progress-container');
    const progressFill = document.getElementById('upload-progress-fill');
    const progressText = document.getElementById('upload-progress-text');
    const errorEl = document.getElementById('upload-error');

    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Uploading...';
    progressContainer.style.display = 'block';
    errorEl.style.display = 'none';
    const addMoreBtn = document.getElementById('add-more-files');
    if (addMoreBtn) addMoreBtn.style.display = 'none';

    const totalFiles = selectedFiles.length;
    let uploadedFiles = 0;
    const filePayloads = [];

    try {
        for (const file of selectedFiles) {
            progressText.textContent = 'File ' + (uploadedFiles + 1) + '/' + totalFiles + ': ' + file.name;
            progressFill.style.width = Math.round(((uploadedFiles) / totalFiles) * 100) + '%';
            const payload = await uploadFileToServer(file);
            filePayloads.push(payload);
            uploadedFiles++;
            progressFill.style.width = Math.round((uploadedFiles / totalFiles) * 100) + '%';
        }

        // Build single message payload (grouped files)
        const messagePayload = filePayloads.length === 1
            ? JSON.stringify(filePayloads[0])
            : JSON.stringify({ type: 'files', files: filePayloads });

        // Send one encrypted message with all files
        if (isDm) {
            const kp = E2ECrypto.getIdentityKeyPair();
            let otherPublicKey;
            try {
                const res = await authFetch('/api/identity/' + currentDmOtherUser.id);
                const data = await res.json();
                otherPublicKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
            } catch (e) {
                throw new Error('Failed to fetch recipient key');
            }
            const encrypted = E2ECrypto.encryptDm(messagePayload, currentDmChannelId, kp.privateKey, otherPublicKey);
            ws.send(JSON.stringify({ type: 'dm_send', dm_channel_id: currentDmChannelId, encrypted_content: encrypted.ciphertext, nonce: encrypted.nonce, message_nonce: encrypted.messageNonce || null }));
        } else {
            const encrypted = E2ECrypto.encrypt(messagePayload, currentChannelId, currentServerId);
            ws.send(JSON.stringify({ type: 'message_send', channel_id: currentChannelId, encrypted_content: encrypted.ciphertext, nonce: encrypted.nonce, message_nonce: encrypted.messageNonce || null }));
        }

        closeUploadModal();
    } catch (err) {
        console.error('File upload failed:', err);
        errorEl.textContent = err.message || 'Upload failed';
        errorEl.style.display = 'block';
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Retry';
    }
}

function buildFileCardHtml(fileData) {
    const isImage = fileData.mime_type && fileData.mime_type.startsWith('image/');
    const isVideo = fileData.mime_type && fileData.mime_type.startsWith('video/');
    const isText = isTextFile(fileData.filename, fileData.mime_type);
    const isAudio = !isText && fileData.mime_type && fileData.mime_type.startsWith('audio/');
    const icon = getFileIcon(fileData.mime_type, fileData.filename);

    // Audio: render as a full-width player (same as upload modal), not crammed inside a file-card
    if (isAudio) {
        return '<div class="audio-file-card" ' +
            'data-file-id="' + escapeAttr(fileData.file_id) + '" ' +
            'data-file-key="' + escapeAttr(fileData.file_key) + '" ' +
            'data-file-name="' + escapeAttr(fileData.filename) + '" ' +
            'data-file-mime="' + escapeAttr(fileData.mime_type) + '" ' +
            'data-file-size="' + fileData.file_size + '">' +
            '<div class="audio-file-header">' +
                '<span class="audio-file-icon">🎵</span>' +
                '<span class="audio-file-name">' + escapeHtml(fileData.filename) + '</span>' +
                '<span class="audio-file-meta">' + formatFileSize(fileData.file_size) + '</span>' +
                '<button class="file-download-btn audio-download-btn" title="Download">⬇</button>' +
            '</div>' +
            '<div class="file-preview" ' +
                'data-file-id="' + escapeAttr(fileData.file_id) + '" ' +
                'data-mime="' + escapeAttr(fileData.mime_type) + '" ' +
                'data-key="' + escapeAttr(fileData.file_key) + '" ' +
                'data-filename="' + escapeAttr(fileData.filename) + '" ' +
                'data-size="' + fileData.file_size + '"></div>' +
        '</div>';
    }

    let previewContainer = '';
    if (isImage || isVideo || isText) {
        previewContainer = '<div class="file-preview" ' +
            'data-file-id="' + escapeAttr(fileData.file_id) + '" ' +
            'data-mime="' + escapeAttr(fileData.mime_type) + '" ' +
            'data-key="' + escapeAttr(fileData.file_key) + '" ' +
            'data-filename="' + escapeAttr(fileData.filename) + '" ' +
            'data-size="' + fileData.file_size + '"></div>';
    }

    // Use data attributes instead of inline onclick to prevent XSS
    // escapeAttr escapes double quotes to prevent data-attribute injection
    return '<div class="file-card" ' +
        'data-file-id="' + escapeAttr(fileData.file_id) + '" ' +
        'data-file-key="' + escapeAttr(fileData.file_key) + '" ' +
        'data-file-name="' + escapeAttr(fileData.filename) + '" ' +
        'data-file-mime="' + escapeAttr(fileData.mime_type) + '" ' +
        'data-file-size="' + fileData.file_size + '">' +
        '<button class="file-download-btn" title="Download">⬇</button>' +
        '<div class="file-details">' +
            '<div class="file-name">' + icon + ' ' + escapeHtml(fileData.filename) + '</div>' +
            '<div class="file-meta">' + formatFileSize(fileData.file_size) + (fileData.mime_type ? ' • ' + escapeHtml(fileData.mime_type) : '') + '</div>' +
            previewContainer +
        '</div>' +
    '</div>';
}

let blobUrls = []; // Track blob URLs for cleanup

function revokeBlobUrls() {
    for (const u of blobUrls) { try { URL.revokeObjectURL(u); } catch (_) {} }
    blobUrls = [];
}



// ===== Gallery State Helper =====
function updateGalleryState(gallery, idx) {
    gallery.dataset.index = idx;
    gallery.querySelectorAll('.msg-gallery-item').forEach(item => {
        const isTarget = parseInt(item.dataset.idx) === idx;
        item.classList.toggle('active', isTarget);
        item.style.display = isTarget ? '' : 'none';
    });
    gallery.querySelectorAll('.msg-gallery-strip-item').forEach(item => {
        item.classList.toggle('active', parseInt(item.dataset.idx) === idx);
    });
    const counter = gallery.querySelector('.msg-gallery-counter');
    if (counter) counter.textContent = (idx + 1) + ' / ' + gallery.dataset.total;
    const prev = gallery.querySelector('.msg-gallery-prev');
    const next = gallery.querySelector('.msg-gallery-next');
    if (prev) prev.disabled = idx === 0;
    if (next) next.disabled = idx === parseInt(gallery.dataset.total) - 1;
}

// ===== Multi-File Gallery in Messages =====
function buildMultiFileCardHtml(files) {
    if (!files || files.length === 0) return '';
    if (files.length === 1) return buildFileCardHtml(files[0]);

    const galleryId = 'gallery-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
    let html = '<div class="msg-file-gallery" id="' + galleryId + '" data-index="0" data-total="' + files.length + '">';

    // Navigation arrows
    html += '<div class="msg-gallery-nav">';
    html += '<button class="msg-gallery-btn msg-gallery-prev" data-dir="-1" disabled>&#8249;</button>';
    html += '<span class="msg-gallery-counter">1 / ' + files.length + '</span>';
    html += '<button class="msg-gallery-btn msg-gallery-next" data-dir="1">&#8250;</button>';
    html += '</div>';

    // File items container - only one visible at a time
    html += '<div class="msg-gallery-items">';
    files.forEach((f, idx) => {
        const activeClass = idx === 0 ? ' active' : '';
        const display = idx === 0 ? '' : ' style="display:none"';
        html += '<div class="msg-gallery-item' + activeClass + '" data-idx="' + idx + '"' + display + '>';
        html += buildFileCardHtml(f);
        html += '</div>';
    });
    html += '</div>';

    // File list strip
    html += '<div class="msg-gallery-strip">';
    files.forEach((f, idx) => {
        const icon = getFileIcon(f.mime_type, f.filename);
        html += '<div class="msg-gallery-strip-item' + (idx === 0 ? ' active' : '') + '" data-idx="' + idx + '" title="' + escapeHtml(f.filename) + '">';
        html += '<span class="msg-strip-icon">' + icon + '</span>';
        html += '<span class="msg-strip-name">' + escapeHtml(f.filename) + '</span>';
        html += '</div>';
    });
    html += '</div>';

    html += '</div>';
    return html;
}

async function loadMediaPreview(container, fileData) {
    if (!container) return;
    const isImage = fileData.mime_type && fileData.mime_type.startsWith('image/');
    const isVideo = fileData.mime_type && fileData.mime_type.startsWith('video/');
    const isText = isTextFile(fileData.filename, fileData.mime_type);
    const isAudio = !isText && fileData.mime_type && fileData.mime_type.startsWith('audio/');
    if (!isImage && !isVideo && !isAudio && !isText) return;

    // Show loading indicator
    container.innerHTML = '<div class="file-loading">Loading preview...</div>';

    try {
        const blob = await downloadAndDecryptFile(fileData.file_id, fileData.file_key, fileData.mime_type, fileData.file_size);
        const url = URL.createObjectURL(blob);
        blobUrls.push(url);
        container.innerHTML = '';

        if (isImage) {
            const img = document.createElement('img');
            img.src = url;
            img.loading = 'lazy';
            img.alt = fileData.filename;
            img.addEventListener('click', () => {
                const parentMsg = container.closest('.message');
                const allPreviews = parentMsg ? parentMsg.querySelectorAll('.file-preview') : [container];
                const gallery = [];
                allPreviews.forEach(p => {
                    const mime = p.dataset.mime || '';
                    if (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/')) {
                        const mediaEl = p.querySelector('img, video, audio');
                        if (mediaEl && mediaEl.src) {
                            const t = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'audio';
                            gallery.push({ url: mediaEl.src, type: t, fileData: { file_id: p.dataset.fileId, file_key: p.dataset.key, mime_type: mime, filename: p.dataset.filename, file_size: parseInt(p.dataset.size || '0') } });
                        }
                    } else if (isTextFile(p.dataset.filename, mime)) {
                        const textEl = p.querySelector('.text-preview');
                        if (textEl && p.dataset.fullText) {
                            gallery.push({ url: null, type: 'text', fileData: { file_id: p.dataset.fileId, file_key: p.dataset.key, mime_type: mime, filename: p.dataset.filename, file_size: parseInt(p.dataset.size || '0') }, fullText: p.dataset.fullText });
                        }
                    }
                });
                openMediaViewer(url, 'image', fileData, gallery.length > 0 ? gallery : [{url, type: 'image', fileData}]);
            });
            container.appendChild(img);
        } else if (isVideo) {
            const video = document.createElement('video');
            video.src = url;
            video.preload = 'metadata';
            video.playsInline = true;
            video.muted = true;
            video.addEventListener('click', () => {
                const parentMsg = container.closest('.message');
                const allPreviews = parentMsg ? parentMsg.querySelectorAll('.file-preview') : [container];
                const gallery = [];
                allPreviews.forEach(p => {
                    const mime = p.dataset.mime || '';
                    if (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/')) {
                        const mediaEl = p.querySelector('img, video, audio');
                        if (mediaEl && mediaEl.src) {
                            const t = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'audio';
                            gallery.push({ url: mediaEl.src, type: t, fileData: { file_id: p.dataset.fileId, file_key: p.dataset.key, mime_type: mime, filename: p.dataset.filename, file_size: parseInt(p.dataset.size || '0') } });
                        }
                    } else if (isTextFile(p.dataset.filename, mime)) {
                        const textEl = p.querySelector('.text-preview');
                        if (textEl && p.dataset.fullText) {
                            gallery.push({ url: null, type: 'text', fileData: { file_id: p.dataset.fileId, file_key: p.dataset.key, mime_type: mime, filename: p.dataset.filename, file_size: parseInt(p.dataset.size || '0') }, fullText: p.dataset.fullText });
                        }
                    }
                });
                openMediaViewer(url, 'video', fileData, gallery.length > 0 ? gallery : [{url, type: 'video', fileData}]);
            });
            const playOverlay = document.createElement('div');
            playOverlay.className = 'video-play-overlay';
            playOverlay.textContent = '▶';
            container.appendChild(video);
            container.appendChild(playOverlay);
        } else if (isAudio) {
            const audio = document.createElement('audio');
            audio.controls = true;
            audio.preload = 'metadata';
            audio.src = url;
            audio.style.width = '100%';
            audio.onerror = () => {
                console.warn('Audio preview failed:', blob.type, blob.size, 'file:', fileData.filename);
                container.innerHTML = '<span style="font-size:24px">🎵</span><span style="color:var(--text-muted);font-size:13px">Audio preview unavailable</span>';
            };
            container.appendChild(audio);
        } else if (isText) {
            try {
                if (fileData.file_size > 512 * 1024) {
                    container.innerHTML = '<div class="file-type-icon">📄</div>';
                    return;
                }
                const text = await blob.text();
                const preview = text.substring(0, 2048);
                const pre = document.createElement('pre');
                pre.className = 'text-preview';
                pre.textContent = preview;
                container.appendChild(pre);

                // Fullscreen button overlay
                const fsBtn = document.createElement('button');
                fsBtn.className = 'text-fullscreen-btn';
                fsBtn.innerHTML = '&#x26F6;';
                fsBtn.title = 'View full text';
                fsBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const parentMsg = container.closest('.message');
                    const allPreviews = parentMsg ? parentMsg.querySelectorAll('.file-preview') : [container];
                    const gallery = [];
                    allPreviews.forEach(p => {
                        const mime = p.dataset.mime || '';
                        if (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/')) {
                            const mediaEl = p.querySelector('img, video, audio');
                            if (mediaEl && mediaEl.src) {
                                const t = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'audio';
                                gallery.push({ url: mediaEl.src, type: t, fileData: { file_id: p.dataset.fileId, file_key: p.dataset.key, mime_type: mime, filename: p.dataset.filename, file_size: parseInt(p.dataset.size || '0') } });
                            }
                        } else if (isTextFile(p.dataset.filename, mime)) {
                            if (p.dataset.fullText) {
                                gallery.push({ url: null, type: 'text', fileData: { file_id: p.dataset.fileId, file_key: p.dataset.key, mime_type: mime, filename: p.dataset.filename, file_size: parseInt(p.dataset.size || '0') }, fullText: p.dataset.fullText });
                            }
                        }
                    });
                    container.dataset.fullText = text;
                    openMediaViewer(null, 'text', { ...fileData, fullText: text }, gallery.length > 0 ? gallery : [{ url: null, type: 'text', fileData: { ...fileData }, fullText: text }]);
                });
                container.appendChild(fsBtn);

                // Store full text for gallery access
                container.dataset.fullText = text;
            } catch (_) {
                container.innerHTML = '<div class="file-type-icon">📄</div>';
            }
        }
    } catch (e) {
        console.warn('Failed to load media preview:', e);
        container.innerHTML = '<div class="file-type-icon">' + (isImage ? '🖼️' : isVideo ? '🎬' : isAudio ? '🎵' : '📄') + '</div>';
    }
}

async function downloadAndDecryptFile(fileId, fileKeyB64, mimeType, fileSize) {
    const fileKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(fileKeyB64));

    const res = await authFetch('/api/files/' + fileId + '/download');
    if (!res.ok) throw new Error('Failed to download file');

    const data = new Uint8Array(await res.arrayBuffer());
    if (data.length === 0) throw new Error('Empty file data');

    // Each chunk: [24-byte nonce] + [ciphertext] + [16-byte Poly1305 tag]
    // Plaintext chunk = 64KB. Encrypted = 64KB + 16 tag. With nonce prefix = 64KB + 40.
    const CHUNK_PLAINTEXT = 65536;
    const CHUNK_ENCRYPTED_FULL = CHUNK_PLAINTEXT + 16 + 24; // 65576
    const totalChunks = fileSize ? Math.ceil(fileSize / CHUNK_PLAINTEXT) : Math.ceil(data.length / CHUNK_ENCRYPTED_FULL);

    const decryptedChunks = [];
    for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_ENCRYPTED_FULL;
        let chunkData;
        if (i < totalChunks - 1) {
            chunkData = data.slice(start, start + CHUNK_ENCRYPTED_FULL);
        } else {
            chunkData = data.slice(start);
        }
        if (chunkData.length < 40) throw new Error('Encrypted chunk too short');
        const decrypted = E2ECrypto.decryptFileChunk(fileKey, chunkData);
        decryptedChunks.push(decrypted);
    }

    let totalLength = 0;
    for (const c of decryptedChunks) totalLength += c.length;
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of decryptedChunks) {
        result.set(c, offset);
        offset += c.length;
    }

    const normalizedMime = mimeType && mimeType.startsWith('audio/') ? normalizeAudioMimeType(mimeType) : (mimeType || 'application/octet-stream');
    return new Blob([result], { type: normalizedMime });
}

async function downloadFileById(fileId, fileKeyB64, filename, mimeType, fileSize) {
    try {
        const blob = await downloadAndDecryptFile(fileId, fileKeyB64, mimeType, fileSize);
        const url = URL.createObjectURL(blob);
        blobUrls.push(url);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => {
            URL.revokeObjectURL(url);
            blobUrls = blobUrls.filter(u => u !== url);
        }, 5000);
    } catch (e) {
        console.error('Download failed:', e);
        alert('Failed to download file: ' + e.message);
    }
}

// ===== Fullscreen Media Viewer =====

let viewerZoomed = false;
let viewerMediaItems = []; // gallery items: [{url, type, fileData}]
let viewerCurrentIndex = 0;

function openMediaViewer(url, type, fileData, galleryItems) {
    const viewer = document.getElementById('media-viewer');
    const content = document.getElementById('media-viewer-content');
    const controls = document.getElementById('video-controls');

    content.innerHTML = '';
    viewerZoomed = false;

    // Gallery support
    if (galleryItems && galleryItems.length > 0) {
        viewerMediaItems = galleryItems;
        viewerCurrentIndex = galleryItems.findIndex(item => item.url === url);
        if (viewerCurrentIndex === -1) viewerCurrentIndex = 0;
    } else {
        viewerMediaItems = [];
        viewerCurrentIndex = 0;
    }

    // Remove old nav arrows
    content.parentElement.querySelectorAll('.gallery-nav-btn-viewer').forEach(b => b.remove());

    if (type === 'image') {
        controls.style.display = 'none';
        const img = document.createElement('img');
        img.src = url;
        img.draggable = false;

        // Desktop: mouse events for 2x zoom
        img.addEventListener('mousedown', (e) => {
            e.preventDefault();
            if (!viewerZoomed) {
                viewerZoomed = true;
                img.classList.add('zoomed');
                updateZoomPosition(img, e);
            } else {
                viewerZoomed = false;
                img.classList.remove('zoomed');
                img.style.transform = '';
            }
        });

        img.addEventListener('mousemove', (e) => {
            if (viewerZoomed) updateZoomPosition(img, e);
        });

        // Mobile: touch events for 2x zoom
        let touchStartTime = 0;
        img.addEventListener('touchstart', (e) => {
            touchStartTime = Date.now();
        }, { passive: true });

        img.addEventListener('touchend', (e) => {
            const elapsed = Date.now() - touchStartTime;
            if (elapsed < 300) {
                if (!viewerZoomed) {
                    viewerZoomed = true;
                    img.classList.add('zoomed');
                    const touch = e.changedTouches[0];
                    updateZoomPosition(img, { clientX: touch.clientX, clientY: touch.clientY });
                } else {
                    viewerZoomed = false;
                    img.classList.remove('zoomed');
                    img.style.transform = '';
                }
            }
        }, { passive: true });

        img.addEventListener('touchmove', (e) => {
            if (viewerZoomed && e.touches.length === 1) {
                const touch = e.touches[0];
                updateZoomPosition(img, { clientX: touch.clientX, clientY: touch.clientY });
            }
        }, { passive: true });

        content.appendChild(img);
    } else if (type === 'video') {
        const video = document.createElement('video');
        video.src = url;
        video.controls = false;
        video.playsInline = true;
        content.appendChild(video);

        controls.style.display = 'flex';
        document.getElementById('audio-controls').style.display = 'none';
        setupVideoControls(video);
    } else if (type === 'audio') {
        const audio = document.createElement('audio');
        // Show audio icon and filename in content area
        const audioInfo = document.createElement('div');
        audioInfo.style.cssText = 'text-align:center;color:#fff;padding:40px 20px;max-width:400px';
        const audioFilename = (fileData && fileData.filename) ? escapeHtml(fileData.filename) : 'Audio';
        audioInfo.innerHTML = '<div style="font-size:64px;margin-bottom:16px">&#127925;</div>' +
            '<div style="font-size:16px;margin-bottom:20px;word-break:break-all;opacity:0.9">' + audioFilename + '</div>';
        content.appendChild(audioInfo);
        audio.src = url;
        audio.controls = false;
        audio.style.cssText = 'visibility:hidden;position:absolute;height:0;overflow:hidden';
        content.appendChild(audio);

        controls.style.display = 'none';
        const audioControls = document.getElementById('audio-controls');
        audioControls.style.display = 'flex';
        setupAudioControls(audio);
    } else if (type === 'text') {
        controls.style.display = 'none';
        document.getElementById('audio-controls').style.display = 'none';

        const fullText = (fileData && fileData.fullText) ? fileData.fullText : '';
        const filename = (fileData && fileData.filename) ? fileData.filename : '';
        const mime = (fileData && fileData.mime_type) ? fileData.mime_type : '';
        const isMd = isMarkdownFile(filename, mime);
        const isCode = !isMd && isCodeFile(filename, mime);

        const wrapper = document.createElement('div');
        wrapper.className = 'text-viewer-wrapper';

        const header = document.createElement('div');
        header.className = 'text-viewer-header';
        header.innerHTML = '<span class="text-viewer-icon">' + (isMd ? '📝' : '📄') + '</span><span class="text-viewer-filename">' + escapeHtml(filename) + '</span><span class="text-viewer-meta">' + formatFileSize(fullText.length) + '</span>';
        wrapper.appendChild(header);

        const codeEl = document.createElement('div');
        codeEl.className = 'text-viewer-content';
        if (isMd) {
            codeEl.innerHTML = renderMarkdown(fullText);
        } else if (isCode) {
            codeEl.innerHTML = highlightSyntax(fullText, filename, mime);
        } else {
            codeEl.textContent = fullText;
        }
        wrapper.appendChild(codeEl);

        content.appendChild(wrapper);
    }

    // Gallery navigation arrows
    if (viewerMediaItems.length > 1) {
        const parent = document.getElementById('media-viewer');
        parent.querySelectorAll('.gallery-nav-btn-viewer').forEach(b => b.remove());

        const prevBtn = document.createElement('button');
        prevBtn.className = 'gallery-nav-btn-viewer gallery-nav-prev';
        prevBtn.innerHTML = '&#8249;';
        prevBtn.title = 'Previous';
        prevBtn.style.cssText = 'position:absolute;left:12px;top:50%;transform:translateY(-50%);z-index:10002;width:48px;height:48px;background:rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.2);border-radius:50%;color:#fff;font-size:28px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s';
        if (viewerCurrentIndex === 0) { prevBtn.classList.add('disabled'); }
        prevBtn.addEventListener('click', (e) => { e.stopPropagation(); navigateViewer(-1); });
        parent.appendChild(prevBtn);

        const nextBtn = document.createElement('button');
        nextBtn.className = 'gallery-nav-btn-viewer gallery-nav-next';
        nextBtn.innerHTML = '&#8250;';
        nextBtn.title = 'Next';
        nextBtn.style.cssText = 'position:absolute;right:12px;top:50%;transform:translateY(-50%);z-index:10002;width:48px;height:48px;background:rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.2);border-radius:50%;color:#fff;font-size:28px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s';
        if (viewerCurrentIndex === viewerMediaItems.length - 1) { nextBtn.classList.add('disabled'); }
        nextBtn.addEventListener('click', (e) => { e.stopPropagation(); navigateViewer(1); });
        parent.appendChild(nextBtn);

        // Counter badge
        const counter = document.createElement('div');
        counter.className = 'gallery-nav-btn-viewer gallery-counter-viewer';
        counter.textContent = (viewerCurrentIndex + 1) + ' / ' + viewerMediaItems.length;
        counter.style.cssText = 'position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:10002;background:rgba(0,0,0,0.6);color:#fff;padding:4px 12px;border-radius:12px;font-size:13px;pointer-events:none';
        parent.appendChild(counter);
    }

    // Keyboard navigation for gallery
    document.removeEventListener('keydown', viewerKeyHandler);
    if (viewerMediaItems.length > 1) {
        document.addEventListener('keydown', viewerKeyHandler);
    }

    viewer.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function viewerKeyHandler(e) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); navigateViewer(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); navigateViewer(1); }
    else if (e.key === 'Escape') { closeMediaViewer(); }
}

function navigateViewer(direction) {
    if (viewerMediaItems.length === 0) return;
    const newIndex = viewerCurrentIndex + direction;
    if (newIndex < 0 || newIndex >= viewerMediaItems.length) return;
    viewerCurrentIndex = newIndex;
    const item = viewerMediaItems[newIndex];

    const viewer = document.getElementById('media-viewer');
    const content = document.getElementById('media-viewer-content');
    const videoControls = document.getElementById('video-controls');
    const audioControls = document.getElementById('audio-controls');

    // Pause any playing media
    const oldVideo = content.querySelector('video');
    const oldAudio = content.querySelector('audio');
    if (oldVideo) { oldVideo.pause(); oldVideo.src = ''; }
    if (oldAudio) { oldAudio.pause(); oldAudio.src = ''; }

    viewerZoomed = false;
    content.innerHTML = '';

    if (item.type === 'image') {
        videoControls.style.display = 'none';
        audioControls.style.display = 'none';
        const img = document.createElement('img');
        img.src = item.url;
        img.draggable = false;
        img.onerror = () => { content.innerHTML = '<div style="color:#fff;text-align:center;padding:40px">Failed to load image</div>'; };
        img.addEventListener('mousedown', (e) => {
            e.preventDefault();
            if (!viewerZoomed) {
                viewerZoomed = true;
                img.classList.add('zoomed');
                updateZoomPosition(img, e);
            } else {
                viewerZoomed = false;
                img.classList.remove('zoomed');
                img.style.transform = '';
            }
        });
        img.addEventListener('mousemove', (e) => {
            if (viewerZoomed) updateZoomPosition(img, e);
        });
        content.appendChild(img);
    } else if (item.type === 'video') {
        const video = document.createElement('video');
        video.src = item.url;
        video.controls = false;
        video.playsInline = true;
        video.onerror = () => { content.innerHTML = '<div style="color:#fff;text-align:center;padding:40px">Failed to load video</div>'; };
        content.appendChild(video);
        videoControls.style.display = 'flex';
        audioControls.style.display = 'none';
        setupVideoControls(video);
    } else if (item.type === 'audio') {
        const audio = document.createElement('audio');
        audio.src = item.url;
        audio.controls = false;
        audio.onerror = () => { content.innerHTML = '<div style="color:#fff;text-align:center;padding:40px">Failed to load audio</div>'; };
        content.appendChild(audio);
        videoControls.style.display = 'none';
        audioControls.style.display = 'flex';
        setupAudioControls(audio);
    } else if (item.type === 'text') {
        videoControls.style.display = 'none';
        audioControls.style.display = 'none';

        const fullText = item.fullText || '';
        const fileData = item.fileData || {};
        const filename = fileData.filename || '';
        const mime = fileData.mime_type || '';
        const isMd = isMarkdownFile(filename, mime);
        const isCode = !isMd && isCodeFile(filename, mime);

        const wrapper = document.createElement('div');
        wrapper.className = 'text-viewer-wrapper';

        const header = document.createElement('div');
        header.className = 'text-viewer-header';
        header.innerHTML = '<span class="text-viewer-icon">' + (isMd ? '📝' : '📄') + '</span><span class="text-viewer-filename">' + escapeHtml(filename) + '</span><span class="text-viewer-meta">' + formatFileSize(fullText.length) + '</span>';
        wrapper.appendChild(header);

        const codeEl = document.createElement('div');
        codeEl.className = 'text-viewer-content';
        if (isMd) {
            codeEl.innerHTML = renderMarkdown(fullText);
        } else if (isCode) {
            codeEl.innerHTML = highlightSyntax(fullText, filename, mime);
        } else {
            codeEl.textContent = fullText;
        }
        wrapper.appendChild(codeEl);

        content.appendChild(wrapper);
    }

    // Update gallery arrows and counter
    updateGalleryNav();
}

function updateGalleryNav() {
    const contentEl = document.getElementById('media-viewer-content');
    const parent = contentEl.parentElement;
    parent.querySelectorAll('.gallery-nav-btn-viewer').forEach(b => b.remove());

    if (viewerMediaItems.length <= 1) return;

    const prevBtn = document.createElement('button');
    prevBtn.className = 'gallery-nav-btn-viewer gallery-nav-prev';
    prevBtn.innerHTML = '&#8249;';
    prevBtn.title = 'Previous';
    prevBtn.style.cssText = 'position:absolute;left:12px;top:50%;transform:translateY(-50%);z-index:10002;width:48px;height:48px;background:rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.2);border-radius:50%;color:#fff;font-size:28px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s';
    if (viewerCurrentIndex === 0) { prevBtn.classList.add('disabled'); }
    prevBtn.addEventListener('click', (e) => { e.stopPropagation(); navigateViewer(-1); });
    parent.appendChild(prevBtn);

    const nextBtn = document.createElement('button');
    nextBtn.className = 'gallery-nav-btn-viewer gallery-nav-next';
    nextBtn.innerHTML = '&#8250;';
    nextBtn.title = 'Next';
    nextBtn.style.cssText = 'position:absolute;right:12px;top:50%;transform:translateY(-50%);z-index:10002;width:48px;height:48px;background:rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.2);border-radius:50%;color:#fff;font-size:28px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s';
    if (viewerCurrentIndex === viewerMediaItems.length - 1) { nextBtn.classList.add('disabled'); }
    nextBtn.addEventListener('click', (e) => { e.stopPropagation(); navigateViewer(1); });
    parent.appendChild(nextBtn);

    const counter = document.createElement('div');
    counter.className = 'gallery-nav-btn-viewer gallery-counter-viewer';
    counter.textContent = (viewerCurrentIndex + 1) + ' / ' + viewerMediaItems.length;
    counter.style.cssText = 'position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:10002;background:rgba(0,0,0,0.6);color:#fff;padding:4px 12px;border-radius:12px;font-size:13px;pointer-events:none';
    parent.appendChild(counter);
}

function updateZoomPosition(img, e) {
    const rect = img.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    img.style.transform = 'scale(2)';
    img.style.transformOrigin = x + '% ' + y + '%';
}

function closeMediaViewer() {
    const viewer = document.getElementById('media-viewer');
    const content = document.getElementById('media-viewer-content');
    const video = content.querySelector('video');
    if (video) {
        video.pause();
        // Do NOT revoke - shared with inline preview
        video.src = '';
    }
    const img = content.querySelector('img');
    // Do NOT revoke - shared with inline preview
    content.innerHTML = '';
    viewer.style.display = 'none';
    document.body.style.overflow = '';
    viewerZoomed = false;
    document.getElementById('video-controls').style.display = 'none';
    document.getElementById('audio-controls').style.display = 'none';
    viewer.classList.remove('cinema-mode', 'cinema-hide');
    // Remove keyboard listener
    document.removeEventListener('keydown', viewerKeyHandler);
    viewerMediaItems = [];
    viewerCurrentIndex = 0;
}

function setupVideoControls(video) {
    // Clone controls to remove old event listeners
    const controls = document.getElementById('video-controls');
    const freshControls = controls.cloneNode(true);
    controls.parentNode.replaceChild(freshControls, controls);

    const playPauseBtn = document.getElementById('vc-play-pause');
    const seekInput = document.getElementById('vc-seek');
    const timeDisplay = document.getElementById('vc-time');
    const fullscreenBtn = document.getElementById('vc-fullscreen');
    const playedBar = document.getElementById('vc-played');
    const bufferedBar = document.getElementById('vc-buffered');
    const volumeSlider = document.getElementById('vc-volume');
    const muteBtn = document.getElementById('vc-mute');

    playPauseBtn.innerHTML = '▶';

    playPauseBtn.onclick = () => {
        if (video.paused) { video.play(); } else { video.pause(); }
    };

    video.onclick = (e) => {
        e.stopPropagation();
        startCinemaTimer();
        if (video.paused) { video.play(); } else { video.pause(); }
    };

    video.addEventListener('play', () => { playPauseBtn.innerHTML = '⏸'; });
    video.addEventListener('pause', () => { playPauseBtn.innerHTML = '▶'; });

    video.addEventListener('timeupdate', () => {
        if (!video.duration) return;
        const pct = (video.currentTime / video.duration) * 1000;
        seekInput.value = pct;
        playedBar.style.width = (pct / 10) + '%';
        timeDisplay.textContent = formatTime(video.currentTime) + ' / ' + formatTime(video.duration);
    });

    video.addEventListener('progress', () => {
        if (!video.duration || !video.buffered.length) return;
        const buffEnd = video.buffered.end(video.buffered.length - 1);
        bufferedBar.style.width = (buffEnd / video.duration * 100) + '%';
    });

    seekInput.addEventListener('input', () => {
        if (video.duration) {
            video.currentTime = (seekInput.value / 1000) * video.duration;
        }
    });

    // Volume control
    if (volumeSlider) {
        volumeSlider.value = video.volume * 100;
        volumeSlider.addEventListener('input', () => {
            video.volume = volumeSlider.value / 100;
            video.muted = false;
            updateVolumeIcon(muteBtn, video.volume);
        });
    }

    if (muteBtn) {
        muteBtn.onclick = () => {
            video.muted = !video.muted;
            updateVolumeIcon(muteBtn, video.muted ? 0 : video.volume);
        };
    }

    video.addEventListener('volumechange', () => {
        if (volumeSlider) volumeSlider.value = video.muted ? 0 : video.volume * 100;
        updateVolumeIcon(muteBtn, video.muted ? 0 : video.volume);
    });

    fullscreenBtn.onclick = () => {
        const viewer = document.getElementById('media-viewer');
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            if (document.exitFullscreen) document.exitFullscreen();
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        } else {
            if (viewer.requestFullscreen) viewer.requestFullscreen();
            else if (viewer.webkitRequestFullscreen) viewer.webkitRequestFullscreen();
        }
    };

    // Cinema mode: auto-hide UI in fullscreen
    let cinemaTimer = null;
    const viewer = document.getElementById('media-viewer');
    function startCinemaTimer() {
        clearTimeout(cinemaTimer);
        viewer.classList.remove('cinema-hide');
        cinemaTimer = setTimeout(() => {
            if (document.fullscreenElement || document.webkitFullscreenElement) {
                viewer.classList.add('cinema-hide');
            }
        }, 3000);
    }
    function cinemaClickHandler(e) {
        if (e.target.closest('.video-controls') || e.target.closest('.audio-controls') || e.target.closest('.gallery-nav-btn-viewer') || e.target.closest('.media-viewer-close') || e.target.closest('.gallery-counter-viewer') || e.target.tagName === 'VIDEO') return;
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            if (document.exitFullscreen) document.exitFullscreen();
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        }
        startCinemaTimer();
    }
    if (window._cinemaFullscreenHandler) {
        document.removeEventListener('fullscreenchange', window._cinemaFullscreenHandler);
        document.removeEventListener('webkitfullscreenchange', window._cinemaFullscreenHandler);
    }
    function onFullscreenChange() {
        const isFs = document.fullscreenElement || document.webkitFullscreenElement;
        if (isFs) {
            viewer.classList.add('cinema-mode');
            viewer.addEventListener('mousemove', startCinemaTimer);
            viewer.addEventListener('click', cinemaClickHandler);
            startCinemaTimer();
        } else {
            viewer.classList.remove('cinema-mode');
            viewer.classList.remove('cinema-hide');
            clearTimeout(cinemaTimer);
            viewer.removeEventListener('mousemove', startCinemaTimer);
            viewer.removeEventListener('click', cinemaClickHandler);
        }
    }
    window._cinemaFullscreenHandler = onFullscreenChange;
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
}

function updateVolumeIcon(btn, volume) {
    if (!btn) return;
    if (volume === 0 || volume === undefined) {
        btn.innerHTML = '&#128263;'; // muted
    } else if (volume < 0.5) {
        btn.innerHTML = '&#128265;'; // low
    } else {
        btn.innerHTML = '&#128266;'; // high
    }
}

function formatTime(seconds) {
    if (!isFinite(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
}

// ===== Audio Controls (inline, no fullscreen) =====
function setupAudioControls(audio) {
    const controls = document.getElementById('audio-controls');
    const freshControls = controls.cloneNode(true);
    controls.parentNode.replaceChild(freshControls, controls);

    const playPauseBtn = document.getElementById('ac-play-pause');
    const seekInput = document.getElementById('ac-seek');
    const timeDisplay = document.getElementById('ac-time');
    const playedBar = document.getElementById('ac-played');
    const bufferedBar = document.getElementById('ac-buffered');
    const volumeSlider = document.getElementById('ac-volume');
    const muteBtn = document.getElementById('ac-mute');

    playPauseBtn.innerHTML = '▶';

    playPauseBtn.onclick = () => {
        if (audio.paused) { audio.play(); } else { audio.pause(); }
    };

    audio.addEventListener('play', () => { playPauseBtn.innerHTML = '⏸'; });
    audio.addEventListener('pause', () => { playPauseBtn.innerHTML = '▶'; });

    audio.addEventListener('timeupdate', () => {
        if (!audio.duration) return;
        const pct = (audio.currentTime / audio.duration) * 1000;
        seekInput.value = pct;
        playedBar.style.width = (pct / 10) + '%';
        timeDisplay.textContent = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration);
    });

    audio.addEventListener('progress', () => {
        if (!audio.duration || !audio.buffered.length) return;
        const buffEnd = audio.buffered.end(audio.buffered.length - 1);
        bufferedBar.style.width = (buffEnd / audio.duration * 100) + '%';
    });

    seekInput.addEventListener('input', () => {
        if (audio.duration) {
            audio.currentTime = (seekInput.value / 1000) * audio.duration;
        }
    });

    // Volume control
    if (volumeSlider) {
        volumeSlider.value = audio.volume * 100;
        volumeSlider.addEventListener('input', () => {
            audio.volume = volumeSlider.value / 100;
            audio.muted = false;
            updateVolumeIcon(muteBtn, audio.volume);
        });
    }

    if (muteBtn) {
        muteBtn.onclick = () => {
            audio.muted = !audio.muted;
            updateVolumeIcon(muteBtn, audio.muted ? 0 : audio.volume);
        };
    }

    audio.addEventListener('volumechange', () => {
        if (volumeSlider) volumeSlider.value = audio.muted ? 0 : audio.volume * 100;
        updateVolumeIcon(muteBtn, audio.muted ? 0 : audio.volume);
    });
}
