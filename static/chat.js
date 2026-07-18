    console.log('chat.js v26 loaded - proportional contrast glow');

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
let isSendingSticker = false;
let selectedFiles = [];
let currentServerMemberList = [];
let unreadMentionsByServer = {}; // serverId -> count
let unreadMentionsByChannel = {}; // channelId -> { count, message_id }

// Chronological mention inbox: [{ id, serverId, channelId, dmChannelId, messageId, senderUsername, channelName, serverName, type: 'mention'|'reply'|'dm', time }]
let mentionItems = [];

// Muted servers, channels, and DMs (IDs stored in localStorage as JSON arrays)
var mutedServers = [];
var mutedChannels = [];
var mutedDms = [];

function loadMutedState() {
    try {
        var s = localStorage.getItem('muted_servers');
        mutedServers = s ? JSON.parse(s) : [];
        var c = localStorage.getItem('muted_channels');
        mutedChannels = c ? JSON.parse(c) : [];
        var d = localStorage.getItem('muted_dms');
        mutedDms = d ? JSON.parse(d) : [];
    } catch (e) {
        mutedServers = [];
        mutedChannels = [];
        mutedDms = [];
    }
}

function saveMutedState() {
    try {
        localStorage.setItem('muted_servers', JSON.stringify(mutedServers));
        localStorage.setItem('muted_channels', JSON.stringify(mutedChannels));
        localStorage.setItem('muted_dms', JSON.stringify(mutedDms));
    } catch (e) {}
    renderMutedList();
}

function renderMutedList() {
    var container = document.getElementById('muted-list');
    if (!container) return;
    var html = '';
    // Muted servers
    mutedServers.forEach(function (sid) {
        var sv = servers.find(function (s) { return s.id === sid; });
        var name = sv ? sv.name : sid.slice(0, 8);
        html += '<div class="muted-list-item"><span>🔇 Server: ' + escapeHtml(name) + '</span><button class="unmute-btn" data-type="server" data-id="' + sid + '">Unmute</button></div>';
    });
    // Muted channels
    mutedChannels.forEach(function (cid) {
        var chEl = document.querySelector('.channel-item[data-id="' + cid + '"]');
        var name = chEl ? chEl.dataset.name : cid.slice(0, 8);
        html += '<div class="muted-list-item"><span>🔇 Channel: #' + escapeHtml(name) + '</span><button class="unmute-btn" data-type="channel" data-id="' + cid + '">Unmute</button></div>';
    });
    // Muted DMs
    mutedDms.forEach(function (did) {
        var dmConv = dmConversations.find(function (c) { return c.dm_channel_id === did; });
        var name = dmConv ? (dmConv.other_display_name || dmConv.other_username) : did.slice(0, 8);
        html += '<div class="muted-list-item"><span>🔇 DM: ' + escapeHtml(name) + '</span><button class="unmute-btn" data-type="dm" data-id="' + escapeAttr(did) + '">Unmute</button></div>';
    });
    if (!html) {
        container.innerHTML = '<div class="muted-empty">No muted servers or channels</div>';
    } else {
        container.innerHTML = html;
        // Wire unmute buttons
        container.querySelectorAll('.unmute-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var type = btn.dataset.type;
                var id = btn.dataset.id;
                if (type === 'server') toggleMuteServer(id);
                else if (type === 'channel') toggleMuteChannel(id, null);
                else if (type === 'dm') toggleMuteDm(id);
            });
        });
    }
}

function isMuted(serverId, channelId) {
    if (serverId && mutedServers.indexOf(serverId) !== -1) return true;
    if (channelId && mutedChannels.indexOf(channelId) !== -1) return true;
    return false;
}

function isDmMuted(dmChannelId) {
    return dmChannelId && mutedDms.indexOf(dmChannelId) !== -1;
}

// Check if a user (by ID) has their DM muted — used to suppress
// server notifications (mentions, replies) from that user too.
function isUserMuted(userId) {
    if (!userId || mutedDms.length === 0 || !dmConversations) return false;
    for (var i = 0; i < dmConversations.length; i++) {
        var conv = dmConversations[i];
        if (conv && conv.other_user_id === userId && mutedDms.indexOf(conv.dm_channel_id) !== -1) {
            return true;
        }
    }
    return false;
}

function toggleMuteChannel(channelId) {
    var idx = mutedChannels.indexOf(channelId);
    if (idx !== -1) {
        mutedChannels.splice(idx, 1);
    } else {
        mutedChannels.push(channelId);
    }
    saveMutedState();
    updateChannelMutedUI();
}

function toggleMuteServer(serverId) {
    var idx = mutedServers.indexOf(serverId);
    if (idx !== -1) {
        mutedServers.splice(idx, 1);
    } else {
        mutedServers.push(serverId);
    }
    saveMutedState();
    updateServerMutedUI();
    updateChannelMutedUI();
}

function toggleMuteDm(dmChannelId) {
    var idx = mutedDms.indexOf(dmChannelId);
    if (idx !== -1) {
        mutedDms.splice(idx, 1);
    } else {
        mutedDms.push(dmChannelId);
    }
    saveMutedState();
    updateDmMutedUI();
}

function updateChannelMutedUI() {
    document.querySelectorAll('.channel-item').forEach(function (el) {
        var cid = el.dataset.id;
        if (mutedChannels.indexOf(cid) !== -1) {
            el.classList.add('muted');
        } else {
            el.classList.remove('muted');
        }
    });
}

function updateDmMutedUI() {
    document.querySelectorAll('.dm-item').forEach(function (el) {
        var did = el.dataset.dmId;
        if (did && mutedDms.indexOf(did) !== -1) {
            el.classList.add('muted');
        } else {
            el.classList.remove('muted');
        }
    });
}

function updateServerMutedUI() {
    document.querySelectorAll('.server-icon').forEach(function (el) {
        var sid = el.dataset.id;
        if (mutedServers.indexOf(sid) !== -1) {
            el.classList.add('muted');
        } else {
            el.classList.remove('muted');
        }
    });
}

// Message grouping: track last message for 2-minute coalescing
let lastMessageInfo = { senderId: null, channelId: null, time: 0 };
let lastDmMessageInfo = { senderId: null, dmChannelId: null, time: 0 };

// Emoji cache: name -> { file_id, file_key, mime_type }
let emojiCache = null;
let emojiBlobCache = {}; // name -> blob URL
let currentFileIndex = 0;    // Profile cache: file_id -> blob URL
let profilePicCache = {};
let myProfile = null; // { display_name, profile_picture_file_id }

// Cache for user display names, profile pics, and colors
let userDisplayNameCache = {}; // user_id -> { display_name, profile_picture_file_id, username_color }

// Local file key cache (file_id → base64 file_key) for sticker previews
const fileKeyCache = {
    _prefix: 'fkc_',
    get(fileId) { return localStorage.getItem(this._prefix + fileId); },
    set(fileId, keyB64) { if (fileId && keyB64) localStorage.setItem(this._prefix + fileId, keyB64); },
    getAll() {
        const result = {};
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(this._prefix)) result[k.slice(this._prefix.length)] = localStorage.getItem(k);
        }
        return result;
    }
};

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
    document.getElementById("current-user").textContent = user.username;
    updateSidebarFooter();

    // A missing key means this browser has not been linked to this account.
    // Never generate a replacement on login: doing that makes prior messages
    // permanently unreadable and can overwrite another account's identity.
    // Settings modal
    const settingsBtn = document.getElementById('settings-btn');
    const settingsModal = document.getElementById('settings-modal');
    settingsBtn.addEventListener('click', () => { 
        settingsModal.style.display = 'flex';
        loadMyProfile();
        loadDmConversations();
    });
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

    // Auto-load previews setting
    const autoLoadCheckbox = document.getElementById('auto-load-previews');
    if (autoLoadCheckbox) {
        autoLoadCheckbox.checked = localStorage.getItem('autoLoadPreviews') !== 'false';
        autoLoadCheckbox.addEventListener('change', () => {
            localStorage.setItem('autoLoadPreviews', autoLoadCheckbox.checked);
        });
    }

    // Notification sound upload
    var notifSoundInput = document.getElementById('notif-sound-input');
    var notifSoundUploadBtn = document.getElementById('notif-sound-upload-btn');
    var notifSoundResetBtn = document.getElementById('notif-sound-reset-btn');
    var notifSoundTestBtn = document.getElementById('notif-sound-test-btn');
    var notifSoundStatus = document.getElementById('notif-sound-status');
    var notifSoundFileName = document.getElementById('notif-sound-file-name');

    if (notifSoundUploadBtn && notifSoundInput) {
        // Show current file name if one is saved
        var savedName = localStorage.getItem('notification_sound_name');
        if (savedName && notifSoundFileName) {
            notifSoundFileName.textContent = savedName;
            notifSoundFileName.style.display = '';
        }

        notifSoundUploadBtn.addEventListener('click', function () {
            notifSoundInput.click();
        });

        notifSoundInput.addEventListener('change', function (e) {
            var file = e.target.files[0];
            if (!file) return;
            if (!file.type.startsWith('audio/')) {
                if (notifSoundStatus) { notifSoundStatus.textContent = 'Please select an audio file (MP3, WAV, etc.)'; notifSoundStatus.style.color = '#f44336'; }
                return;
            }
            if (file.size > 50 * 1024 * 1024) {
                if (notifSoundStatus) { notifSoundStatus.textContent = 'File too large (max 50 MB). Try a shorter or lower-quality audio file.'; notifSoundStatus.style.color = '#f44336'; }
                return;
            }
            var reader = new FileReader();
            reader.onload = function (ev) {
                try {
                    var dataUrl = ev.target.result;
                    saveNotifSoundData(dataUrl, file.name, 'Custom sound saved!');
                    syncNotificationSoundToServer(file);
                } catch (err) {
                    if (notifSoundStatus) { notifSoundStatus.textContent = 'Failed to save sound. IndexedDB may be unavailable.'; notifSoundStatus.style.color = '#f44336'; }
                }
            };
            reader.readAsDataURL(file);
            e.target.value = '';
        });
    }

    if (notifSoundResetBtn) {
        notifSoundResetBtn.addEventListener('click', function () {
            _notifCachedUrl = null;
            _idbNotifDel('url').catch(function() {});
            _idbNotifDel('name').catch(function() {});
            localStorage.removeItem('notification_sound_url');
            localStorage.removeItem('notification_sound_name');
            if (notifSoundFileName) { notifSoundFileName.style.display = 'none'; notifSoundFileName.textContent = ''; }
            if (notifSoundStatus) { notifSoundStatus.textContent = 'Reset to default sound'; notifSoundStatus.style.color = '#4caf50'; }
            setTimeout(function () { if (notifSoundStatus) notifSoundStatus.textContent = ''; }, 3000);
            // Delete from server too
            authFetch('/api/notification-sound', { method: 'DELETE' }).catch(function () {});
        });
    }

    var notifSoundStopBtn = document.getElementById('notif-sound-stop-btn');

    if (notifSoundTestBtn) {
        notifSoundTestBtn.addEventListener('click', function () {
            if (notifSoundStatus) { notifSoundStatus.textContent = 'Playing...'; notifSoundStatus.style.color = 'var(--text-muted)'; }
            playNotificationSound(true);
            setTimeout(function () { if (notifSoundStatus && notifSoundStatus.textContent === 'Playing...') notifSoundStatus.textContent = ''; }, _notifCurrentDuration > 0 ? _notifCurrentDuration * 1000 + 500 : 2500);
        });
    }

    if (notifSoundStopBtn) {
        notifSoundStopBtn.addEventListener('click', function () {
            stopNotificationSound();
            if (notifSoundStatus) { notifSoundStatus.textContent = 'Stopped'; notifSoundStatus.style.color = '#ff9800'; }
            setTimeout(function () { if (notifSoundStatus) notifSoundStatus.textContent = ''; }, 2000);
        });
    }

    // Record from microphone
    var notifRecordBtn = document.getElementById('notif-sound-record-btn');
    var notifRecordingDiv = document.getElementById('notif-sound-recording');
    var notifRecordStopBtn = document.getElementById('notif-record-stop-btn');
    var notifRecordCancelBtn = document.getElementById('notif-record-cancel-btn');
    var notifRecordTimer = document.getElementById('notif-record-timer');

    function showNotifRecording(show) {
        if (notifRecordBtn) notifRecordBtn.style.display = show ? 'none' : '';
        if (notifRecordingDiv) notifRecordingDiv.style.display = show ? '' : 'none';
    }

    function updateNotifRecordTimer() {
        if (!_notifRecordStartTime) return;
        var elapsed = Math.floor((Date.now() - _notifRecordStartTime) / 1000);
        var m = Math.floor(elapsed / 60);
        var s = elapsed % 60;
        if (notifRecordTimer) notifRecordTimer.textContent = m + ':' + (s < 10 ? '0' : '') + s;
    }

    function cleanupNotifRecording() {
        if (_notifRecordTimer) { clearInterval(_notifRecordTimer); _notifRecordTimer = null; }
        if (_notifMediaStream) { _notifMediaStream.getTracks().forEach(function(t) { t.stop(); }); _notifMediaStream = null; }
        _notifMediaRecorder = null;
        _notifRecordChunks = [];
        showNotifRecording(false);
    }

    function saveNotifSoundData(dataUrl, fileName, statusMsg) {
        _notifCachedUrl = dataUrl;
        _idbNotifPut('url', dataUrl);
        _idbNotifPut('name', fileName);
        localStorage.setItem('notification_sound_name', fileName);
        localStorage.removeItem('notification_sound_url');
        if (notifSoundFileName) { notifSoundFileName.textContent = fileName; notifSoundFileName.style.display = ''; }
        if (notifSoundStatus) { notifSoundStatus.textContent = statusMsg; notifSoundStatus.style.color = '#4caf50'; }
        setTimeout(function () { if (notifSoundStatus) notifSoundStatus.textContent = ''; }, 3000);
    }

    function saveRecordedAudio(blob) {
        var fileName = 'Recording.webm';
        var file = new File([blob], fileName, { type: 'audio/webm' });
        var reader = new FileReader();
        reader.onload = function (ev) {
            try {
                saveNotifSoundData(ev.target.result, fileName, 'Recording saved as notification sound!');
                syncNotificationSoundToServer(file);
            } catch (err) {
                if (notifSoundStatus) { notifSoundStatus.textContent = 'Failed to save recording.'; notifSoundStatus.style.color = '#f44336'; }
            }
        };
        reader.readAsDataURL(blob);
    }

    if (notifRecordBtn) {
        notifRecordBtn.addEventListener('click', function () {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
                if (notifSoundStatus) { notifSoundStatus.textContent = 'Recording not supported in this browser.'; notifSoundStatus.style.color = '#f44336'; }
                return;
            }
            navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
                _notifMediaStream = stream;
                _notifRecordChunks = [];
                var mimeType = 'audio/webm;codecs=opus';
                if (!MediaRecorder.isTypeSupported(mimeType)) {
                    mimeType = 'audio/webm';
                    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = '';
                }
                _notifMediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType: mimeType } : {});
                _notifMediaRecorder.ondataavailable = function (e) {
                    if (e.data && e.data.size > 0) _notifRecordChunks.push(e.data);
                };
                _notifMediaRecorder.onstop = function () {
                    var blob = new Blob(_notifRecordChunks, { type: 'audio/webm' });
                    saveRecordedAudio(blob);
                    cleanupNotifRecording();
                };
                _notifMediaRecorder.onerror = function () {
                    if (notifSoundStatus) { notifSoundStatus.textContent = 'Recording error occurred.'; notifSoundStatus.style.color = '#f44336'; }
                    cleanupNotifRecording();
                };
                _notifMediaRecorder.start();
                _notifRecordStartTime = Date.now();
                showNotifRecording(true);
                updateNotifRecordTimer();
                _notifRecordTimer = setInterval(updateNotifRecordTimer, 200);
                if (notifSoundStatus) notifSoundStatus.textContent = '';
            }).catch(function (err) {
                if (notifSoundStatus) { notifSoundStatus.textContent = 'Microphone access denied. ' + err.message; notifSoundStatus.style.color = '#f44336'; }
            });
        });
    }

    if (notifRecordStopBtn) {
        notifRecordStopBtn.addEventListener('click', function () {
            if (_notifMediaRecorder && _notifMediaRecorder.state !== 'inactive') {
                _notifMediaRecorder.stop();
            }
        });
    }

    if (notifRecordCancelBtn) {
        notifRecordCancelBtn.addEventListener('click', function () {
            if (_notifMediaRecorder && _notifMediaRecorder.state !== 'inactive') {
                _notifMediaRecorder.ondataavailable = null;
                _notifMediaRecorder.onstop = null;
                _notifMediaRecorder.stop();
            }
            cleanupNotifRecording();
            if (notifSoundStatus) { notifSoundStatus.textContent = 'Recording cancelled'; notifSoundStatus.style.color = 'var(--text-muted)'; }
            setTimeout(function () { if (notifSoundStatus) notifSoundStatus.textContent = ''; }, 2000);
        });
    }

    // Volume slider
    var volumeSlider = document.getElementById('notif-volume-slider');
    var volumeLabel = document.getElementById('notif-volume-label');
    if (volumeSlider && volumeLabel) {
        var savedVol = localStorage.getItem('notif_volume');
        if (savedVol !== null) {
            volumeSlider.value = savedVol;
            volumeLabel.textContent = savedVol + '%';
        }
        volumeSlider.addEventListener('input', function () {
            var val = parseInt(volumeSlider.value, 10);
            volumeLabel.textContent = val + '%';
            localStorage.setItem('notif_volume', val);
        });
    }

    // Background-only toggle
    var bgCheckbox = document.getElementById('notif-background-only');
    if (bgCheckbox) {
        bgCheckbox.checked = localStorage.getItem('notif_background_only') === 'true';
        bgCheckbox.addEventListener('change', function () {
            localStorage.setItem('notif_background_only', bgCheckbox.checked);
        });
    }

    // Delete account
    // Clear all client-side data (localStorage, sessionStorage, non-HttpOnly cookies).
    // HttpOnly cookies can only be cleared by the server (see /api/logout GET).
    function clearAllClientData() {
        localStorage.clear();
        try { sessionStorage.clear(); } catch (_) {}
        document.cookie.split(';').forEach(function(c) {
            document.cookie = c.replace(/^ +/, '').replace(/=.*/, '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/');
        });
    }

    // Call the server-side logout endpoint to clear the HttpOnly cookie
    async function serverLogout() {
        try {
            await fetch('/api/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token() } });
        } catch (_) {}
    }

    document.getElementById('delete-account-btn').addEventListener('click', async () => {
        if (!confirm('Are you sure you want to delete your account? This cannot be undone.')) return;
        if (!confirm('Really? All your messages, servers, and keys will be permanently lost.')) return;
        try {
            const res = await authFetch('/api/me', { method: 'DELETE' });
            if (res.ok) {
                clearAllClientData();
                if (ws) ws.close();
                // The server clears the HttpOnly cookie in the delete_me response,
                // so we can redirect directly to login without the /api/logout roundtrip.
                window.location.href = '/login.html';
            } else {
                const err = await res.json();
                alert(err.error || 'Failed to delete account');
            }
        } catch (e) {
            alert('Failed to delete account');
        }
    });

    // Logout is handled in settings (Clear All Data / Sign Out)

    // Clear all data button in settings — robust logout + wipe sequence
    document.getElementById('clear-all-data-btn').addEventListener('click', async () => {
        if (!confirm('This will clear ALL local data (logins, keys, settings) and sign you out. Continue?')) return;
        // 1. Close websocket first so no more messages arrive
        if (ws) { try { ws.close(); } catch (_) {} ws = null; }
        // 2. Call server logout to clear HttpOnly cookie (while token is still present)
        await serverLogout();
        // 3. Clear all client-side data
        clearAllClientData();
        // 4. Redirect directly to login page since the server already cleared the cookie
        window.location.href = '/login.html';
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
    setupStickerPanel();
    loadMutedState();
    loadServers();
    loadFriendRequestBadge();
    loadEmojiCache(); // Load custom emojis
    loadMyProfile(); // Load own profile for sidebar footer
    requestNotificationPermission();
    setupMentionAutocomplete();
    initMentionsInbox();
    // Restore muted UI after servers/channels render
    setTimeout(function () {
        updateServerMutedUI();
        updateChannelMutedUI();
    }, 500);
    // Restore notification sound from server (syncs across devices)
    restoreNotificationSoundFromServer();

    // Settings open profile button
    var settingsOpenProfileBtn = document.getElementById('settings-open-profile-btn');
    if (settingsOpenProfileBtn) {
        settingsOpenProfileBtn.addEventListener('click', function() {
            document.getElementById('settings-modal').style.display = 'none';
            if (user) openProfileModal(user.id);
        });
    }
    // Settings avatar click -> open profile
    var settingsAvatar = document.getElementById('settings-profile-avatar');
    if (settingsAvatar) {
        settingsAvatar.addEventListener('click', function() {
            document.getElementById('settings-modal').style.display = 'none';
            if (user) openProfileModal(user.id);
        });
    }
    
    // Profile edit modal handlers
    var profileEditModal = document.getElementById('profile-edit-modal');
    if (profileEditModal) {
        document.getElementById('profile-edit-modal-close').addEventListener('click', closeProfileEditModal);
        profileEditModal.addEventListener('click', function (e) {
            if (e.target === profileEditModal) closeProfileEditModal();
        });
        // Edit save button
        document.getElementById('profile-edit-save-btn').addEventListener('click', saveProfile);
        // Banner upload
        document.getElementById('profile-banner-upload-btn').addEventListener('click', function () {
            document.getElementById('profile-banner-file-input').click();
        });
        document.getElementById('profile-banner-file-input').addEventListener('change', function (e) {
            var file = e.target.files[0];
            if (file) openBannerCrop(file);
            e.target.value = '';
        });
        document.getElementById('profile-banner-remove-btn').addEventListener('click', function () {
            profileBannerFileId = null;
            profileBannerFileKey = null;
            // Restore original banner from current profile in edit preview
            var editBanner = document.getElementById('profile-edit-banner-img');
            if (editBanner && profileOriginalData) {
                var origBannerId = profileOriginalData.data.profile_banner_file_id;
                var origBannerKey = profileOriginalData.data.profile_banner_file_key || null;
                if (origBannerId) {
                    getDecryptedFileUrl(origBannerId, origBannerKey, function(url) {
                        editBanner.style.backgroundImage = url ? 'url(' + url + ')' : '';
                    });
                } else {
                    editBanner.style.backgroundImage = '';
                }
            } else if (editBanner) {
                editBanner.style.backgroundImage = '';
            }
            document.getElementById('profile-banner-remove-btn').style.display = 'none';
        });
        // Avatar upload
        document.getElementById('profile-avatar-upload-btn').addEventListener('click', function () {
            document.getElementById('profile-avatar-file-input').click();
        });
        document.getElementById('profile-avatar-file-input').addEventListener('change', function (e) {
            var file = e.target.files[0];
            if (file) openPfpCrop(file);
            e.target.value = '';
        });
        document.getElementById('profile-avatar-remove-btn').addEventListener('click', function () {
            profilePfpFileId = null;
            profilePfpFileKey = null;
            var avatarEl = document.getElementById('profile-edit-avatar');
            // Restore original PFP from current profile in edit preview
            if (profileOriginalData) {
                var origPicId = profileOriginalData.data.profile_picture_file_id;
                var origPicKey = profileOriginalData.data.profile_picture_file_key || null;
                var dn = document.getElementById('profile-edit-display-name').value || 'U';
                if (origPicId) {
                    getDecryptedFileUrl(origPicId, origPicKey, function(url) {
                        if (url) {
                            avatarEl.innerHTML = '<img src="' + url + '" alt="Avatar">';
                        } else {
                            avatarEl.innerHTML = '<div style="font-size:36px;color:#1a1a2e;font-weight:700;">' + escapeHtml(dn.charAt(0).toUpperCase()) + '</div>';
                        }
                    });
                } else {
                    avatarEl.innerHTML = '<div style="font-size:36px;color:#1a1a2e;font-weight:700;">' + escapeHtml(dn.charAt(0).toUpperCase()) + '</div>';
                }
            } else {
                avatarEl.innerHTML = '<div style="font-size:36px;color:#1a1a2e;font-weight:700;">' + escapeHtml((document.getElementById('profile-edit-display-name').value || 'U').charAt(0).toUpperCase()) + '</div>';
            }
            document.getElementById('profile-avatar-remove-btn').style.display = 'none';
        });
        // Banner crop confirm/cancel
        document.getElementById('profile-banner-crop-cancel').addEventListener('click', cancelBannerCrop);
        document.getElementById('profile-banner-crop-confirm').addEventListener('click', processBannerCrop);
        // PFP crop confirm/cancel
        document.getElementById('profile-pfp-crop-cancel').addEventListener('click', cancelPfpCrop);
        document.getElementById('profile-pfp-crop-confirm').addEventListener('click', processPfpCrop);
        // Edit color picker
        document.getElementById('profile-edit-color').addEventListener('input', function () {
            var color = this.value;
            document.getElementById('profile-edit-color-preview').style.color = color;
            var dnPreview = document.getElementById('profile-edit-display-name-preview');
            if (dnPreview) dnPreview.style.color = color;
            renderEditGlowOptions(color);
        });
        // Edit bg color picker
        document.getElementById('profile-edit-bg-color').addEventListener('input', function () {
            var color = this.value;
            document.getElementById('profile-edit-bg-preview').style.background = color;
            var card = document.querySelector('#profile-edit-modal .profile-edit-preview-card');
            if (card) card.style.background = color;
            // Make edit avatar border match background color
            var editAvatarEl = document.getElementById('profile-edit-avatar');
            if (editAvatarEl) {
                editAvatarEl.style.borderColor = color || '#16213e';
            }
        });
        // Description word count
        document.getElementById('profile-edit-description').addEventListener('input', function () {
            updateDescriptionWordCount();
        });
        // Live preview inputs
        var dnInput = document.getElementById('profile-edit-display-name');
        var dnPreview = document.getElementById('profile-edit-display-name-preview');
        if (dnInput && dnPreview) {
            dnInput.addEventListener('input', function() {
                dnPreview.textContent = this.value || (profileOriginalData && (profileOriginalData.data.display_name || profileOriginalData.data.username || 'Unknown'));
            });
        }
        var nnInput = document.getElementById('profile-edit-nickname');
        var nnPreview = document.getElementById('profile-edit-nickname-preview');
        if (nnInput && nnPreview) {
            nnInput.addEventListener('input', function() {
                nnPreview.textContent = this.value || '';
                nnPreview.style.display = this.value ? 'block' : 'none';
            });
        }
        var descInput = document.getElementById('profile-edit-description');
        var descPreview = document.getElementById('profile-edit-description-preview');
        if (descInput && descPreview) {
            descInput.addEventListener('input', function() {
                if (this.value) {
                    descPreview.innerHTML = linkifyText(escapeHtml(this.value));
                    descPreview.style.display = 'block';
                } else {
                    descPreview.textContent = '';
                    descPreview.style.display = 'none';
                }
            });
        }
        // Escape key to close
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && profileEditModal.style.display !== 'none') {
                closeProfileEditModal();
            }
        });
    }
    
    // Profile view modal handlers
    var profileModal = document.getElementById('profile-modal');
    if (profileModal) {
        // Close button
        document.getElementById('profile-modal-close').addEventListener('click', closeProfileModal);
        // Click backdrop to close
        profileModal.addEventListener('click', function (e) {
            if (e.target === profileModal) closeProfileModal();
        });
        // Escape key to close profile view modal
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && profileModal.style.display !== 'none' && profileModal.style.display !== '') {
                closeProfileModal();
            }
        });
        // Footer user avatar click -> open own profile
        document.getElementById('footer-user-avatar').addEventListener('click', function () {
            if (user) openProfileModal(user.id);
        });
        // Edit profile button — opens the separate edit modal
        document.getElementById('profile-edit-btn').addEventListener('click', function () {
            openProfileEditModal();
        });
        // Edit cancel button
        document.getElementById('profile-edit-cancel-btn').addEventListener('click', function () {
            closeProfileEditModal();
        });

        
        // Delegate avatar clicks to open profile for messages and members
        document.getElementById('message-list').addEventListener('click', function (e) {
            var avatar = e.target.closest('.message .avatar');
            if (avatar) {
                var msgEl = avatar.closest('.message');
                if (msgEl && msgEl.dataset.senderId) {
                    openProfileModal(msgEl.dataset.senderId);
                }
            }
        });
        document.getElementById('member-list').addEventListener('click', function (e) {
            var avatar = e.target.closest('.member-avatar');
            if (avatar) {
                var memberEl = avatar.closest('.member-item');
                if (memberEl && memberEl.dataset.userId) {
                    openProfileModal(memberEl.dataset.userId);
                }
            }
        });
        
            // Banner crop — confirm on pressing Enter
        document.addEventListener('keydown', function bannerCropEnter(e) {
            if (e.key === 'Enter' && bannerCropState && document.getElementById('profile-banner-crop-container').style.display !== 'none') {
                processBannerCrop();
            }
        });
        // PFP crop — confirm on pressing Enter
        document.addEventListener('keydown', function pfpCropEnter(e) {
            if (e.key === 'Enter' && pfpCropState && document.getElementById('profile-pfp-crop-container').style.display !== 'none') {
                processPfpCrop();
            }
        });
    }

    // Friend code password modal button handlers
    const fcCancelBtn = document.getElementById('fc-cancel-btn');
    const fcRecoverBtn = document.getElementById('fc-recover-btn');
    const fcRegenBtn = document.getElementById('fc-regenerate-btn');
    if (fcCancelBtn) fcCancelBtn.addEventListener('click', function () {
        document.getElementById('friend-code-password-modal').style.display = 'none';
    });
    if (fcRecoverBtn) fcRecoverBtn.addEventListener('click', handleFriendCodeRecover);
    if (fcRegenBtn) fcRegenBtn.addEventListener('click', function () { handleFriendCodeRegenerate(); });
    // Allow Enter key in password input to trigger recover
    const fcPasswordInput = document.getElementById('fc-password-input');
    if (fcPasswordInput) {
        fcPasswordInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleFriendCodeRecover();
            }
        });
    }

    document.getElementById('send-btn').addEventListener('click', sendMessage);
    document.getElementById('message-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Attachment popup menu
    var attachPopup = document.getElementById('attach-popup');
    var attachBtn = document.getElementById('attach-btn');
    
    function closeAttachPopup() {
        if (attachPopup) attachPopup.style.display = 'none';
    }
    
    function toggleAttachPopup() {
        if (!currentChannelId && !currentDmChannelId) return;
        if (!attachPopup) return;
        var isVisible = attachPopup.style.display !== 'none';
        closeAttachPopup();
        if (!isVisible) {
            attachPopup.style.display = 'flex';
        }
    }
    
    if (attachBtn && attachPopup) {
        attachBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            toggleAttachPopup();
        });
        
        // Popup item handlers (upload, photo, record-video — record-audio uses gesture handler below)
        attachPopup.addEventListener('click', function (e) {
            var item = e.target.closest('.attach-popup-item');
            if (!item) return;
            var action = item.dataset.action;
            closeAttachPopup();
            if (action === 'upload') {
                document.getElementById('file-input').click();
            } else if (action === 'photo') {
                openCameraCapture();
            } else if (action === 'record-video') {
                startVideoRecording();
            }
            // 'record-audio' is handled by the record-audio click handler below
        });
    }
    
    // Close popup on click outside
    document.addEventListener('click', function (e) {
        if (!attachPopup || attachPopup.style.display === 'none') return;
        var wrap = document.querySelector('.attach-wrap');
        if (wrap && !wrap.contains(e.target)) {
            closeAttachPopup();
        }
    });
    
    document.getElementById('file-input').addEventListener('change', handleFileSelect);
    document.getElementById('cancel-upload').addEventListener('click', closeUploadModal);
    
    // Camera capture via getUserMedia (opens actual camera, with timer, flash, preview)
    var _cameraCaptureStream = null;
    var _cameraCaptureFacing = 'environment';
    var _cameraCaptureModal = null;
    var _cameraCaptureVideo = null;
    var _cameraCaptureCanvas = null;
    var _cameraCaptureCtx = null;
    var _cameraCaptureTimer = 0; // seconds, 0 = instant
    var _cameraCaptureFlashOn = false;
    var _cameraCaptureCountdownEl = null;
    var _cameraCaptureCountdownTimer = null;
    var _cameraFlashTimer = null;
    var _cameraCaptureFlashEl = null;
    var _cameraCaptureFlashIntensity = 35; // 0-100, white overlay brightness percentage
    var _cameraBrightnessCtrl = null; // Floating brightness control (root-level, above overlay)
    var _cameraPhotoPreviewData = null; // { blob, url }
    var _cameraPhotoPreviewEl = null;
    var _cameraZoomLevel = 1;
    var _cameraZoomMin = 1;
    var _cameraZoomMax = 1;
    var _cameraZoomSlider = null;
    var _cameraZoomLabel = null;
    var _cameraLastPinchDist = 0;
    var _cameraWasPinching = false;
    var _cameraCaptureMirror = false; // horizontal mirror toggle for preview and photo
    var _cameraCaptureResolution = '720p';
    var _cameraCaptureResolutions = {
        '720p': { width: 1280, height: 720, label: '720p' },
        '1080p': { width: 1920, height: 1080, label: '1080p' },
        '4K': { width: 3840, height: 2160, label: '4K' }
    };
    
    function openCameraCapture() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            alert('Camera not supported in this browser.');
            return;
        }
        closeCameraCapture();
        
        // Create modal dynamically
        if (!_cameraCaptureModal) {
            _cameraCaptureModal = document.createElement('div');
            _cameraCaptureModal.className = 'modal';
            _cameraCaptureModal.style.cssText = 'display:flex;z-index:2000;background:rgba(0,0,0,0.9);';
            _cameraCaptureModal.innerHTML = '<div class="camera-capture-content" style="position:relative;width:100%;max-width:500px;margin:auto;text-align:center;">'
                + '<button class="camera-capture-close" style="position:absolute;top:10px;right:14px;background:none;border:none;color:#fff;font-size:28px;cursor:pointer;z-index:10;line-height:1;">&times;</button>'
                + '<video id="camera-capture-video" autoplay playsinline style="width:100%;max-height:60vh;border-radius:12px;object-fit:contain;background:#000;"></video>'
                + '<div class="camera-countdown" id="camera-countdown" style="display:none;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font-size:72px;font-weight:700;text-shadow:0 0 20px rgba(0,0,0,0.8);z-index:5;pointer-events:none;"></div>'
                // Timer row
                + '<div class="camera-timer-row" style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:10px;padding:0 16px;">'
                + '<span style="color:#aaa;font-size:12px;">⏱</span>'
                + '<button class="camera-timer-btn" data-timer="0" style="background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.3);border-radius:4px;color:#fff;padding:4px 10px;font-size:11px;cursor:pointer;transition:all 0.15s;">Instant</button>'
                + '<button class="camera-timer-btn" data-timer="3" style="background:transparent;border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#aaa;padding:4px 10px;font-size:11px;cursor:pointer;transition:all 0.15s;">3s</button>'
                + '<button class="camera-timer-btn" data-timer="5" style="background:transparent;border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#aaa;padding:4px 10px;font-size:11px;cursor:pointer;transition:all 0.15s;">5s</button>'
                + '<button class="camera-timer-btn" data-timer="10" style="background:transparent;border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#aaa;padding:4px 10px;font-size:11px;cursor:pointer;transition:all 0.15s;">10s</button>'
                + '<input type="number" id="camera-custom-timer" min="1" max="99" placeholder="s" style="width:40px;padding:4px;border:1px solid rgba(255,255,255,0.2);border-radius:4px;background:transparent;color:#fff;font-size:11px;text-align:center;display:none;">'
                + '</div>'
                // Resolution selector for photo
                + '<div class="camera-res-row" style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:8px;padding:0 16px;">'
                + '<span style="color:#888;font-size:11px;">📺</span>'
                + '<button class="camera-res-btn" data-res="720p" style="background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.3);border-radius:4px;color:#fff;padding:4px 10px;font-size:11px;cursor:pointer;transition:all 0.15s;font-weight:600;">720p</button>'
                + '<button class="camera-res-btn" data-res="1080p" style="background:transparent;border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#aaa;padding:4px 10px;font-size:11px;cursor:pointer;transition:all 0.15s;">1080p</button>'
                + '<button class="camera-res-btn" data-res="4K" style="background:transparent;border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#aaa;padding:4px 10px;font-size:11px;cursor:pointer;transition:all 0.15s;">4K</button>'
                + '</div>'
                + '<div class="camera-zoom-row" style="display:none;align-items:center;justify-content:center;gap:8px;margin-top:8px;padding:0 20px;">'
                + '<span style="color:#888;font-size:11px;">🔍</span>'
                + '<input type="range" id="camera-zoom-slider" min="1" max="3" step="0.1" value="1" style="flex:1;max-width:140px;height:4px;-webkit-appearance:none;appearance:none;background:#555;border-radius:2px;outline:none;cursor:pointer;">'
                + '<span id="camera-zoom-label" style="color:#aaa;font-size:11px;min-width:28px;text-align:center;">1.0×</span>'
                + '</div>'
                + '<div style="display:flex;align-items:center;justify-content:center;gap:16px;margin-top:4px;padding:0 10px;">'
                + '<button class="camera-flash-btn" style="background:rgba(255,255,255,0.15);border:none;border-radius:50%;width:42px;height:42px;aspect-ratio:1;flex-shrink:0;color:#aaa;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.15s;" title="Flash">☀️</button>'
                + '<button class="camera-mirror-btn" style="background:rgba(255,255,255,0.15);border:none;border-radius:50%;width:42px;height:42px;aspect-ratio:1;flex-shrink:0;color:#aaa;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.15s;" title="Mirror">↔</button>'
                + '<button class="camera-flip-btn" style="background:rgba(255,255,255,0.15);border:none;border-radius:50%;width:42px;height:42px;aspect-ratio:1;flex-shrink:0;color:#fff;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s;">🔄</button>'
                + '<button class="camera-capture-btn" style="background:#fff;border:none;border-radius:50%;width:56px;height:56px;aspect-ratio:1;flex-shrink:0;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 4px rgba(255,255,255,0.3);transition:transform 0.1s;"><div style="width:46px;height:46px;border-radius:50%;background:#fff;border:2px solid #333;"></div></button>'
                + '<button class="camera-cancel-btn" style="background:rgba(255,255,255,0.15);border:none;border-radius:50%;width:42px;height:42px;aspect-ratio:1;flex-shrink:0;color:#fff;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s;">✕</button>'
                + '</div></div>';
            document.body.appendChild(_cameraCaptureModal);
            _cameraCaptureVideo = _cameraCaptureModal.querySelector('#camera-capture-video');
            _cameraCaptureCountdownEl = document.getElementById('camera-countdown');
            // Create flash overlay as a SEPARATE body element (not inside modal) so position:fixed covers full viewport
            _cameraCaptureFlashEl = document.createElement('div');
            _cameraCaptureFlashEl.id = 'camera-flash-overlay';
            _cameraCaptureFlashEl.style.cssText = 'display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(255,255,255,' + (_cameraCaptureFlashIntensity / 100) + ');z-index:2003;pointer-events:none;';
            document.body.appendChild(_cameraCaptureFlashEl);
            
            // Create floating brightness control ABOVE the white overlay (root-level, higher z-index)
            _cameraBrightnessCtrl = document.createElement('div');
            _cameraBrightnessCtrl.id = 'camera-brightness-ctrl';
            _cameraBrightnessCtrl.style.cssText = 'display:none;position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2004;background:rgba(0,0,0,0.6);border-radius:10px;padding:8px 16px;align-items:center;gap:8px;';
            _cameraBrightnessCtrl.innerHTML = '<span style="color:#FFD700;font-size:14px;">💡</span>'
                + '<input type="range" id="camera-flash-intensity" min="0" max="100" step="1" value="35" style="width:120px;height:4px;-webkit-appearance:none;appearance:none;background:#555;border-radius:2px;outline:none;cursor:pointer;">'
                + '<span id="camera-flash-intensity-label" style="color:#FFD700;font-size:12px;min-width:32px;text-align:center;">35%</span>';
            document.body.appendChild(_cameraBrightnessCtrl);
            
            // Close button
            _cameraCaptureModal.querySelector('.camera-capture-close').addEventListener('click', closeCameraCapture);
            // Cancel button
            _cameraCaptureModal.querySelector('.camera-cancel-btn').addEventListener('click', closeCameraCapture);
            // Flip button
            _cameraCaptureModal.querySelector('.camera-flip-btn').addEventListener('click', function () {
                _cameraCaptureFacing = _cameraCaptureFacing === 'environment' ? 'user' : 'environment';
                startCameraCaptureStream();
            });
            // Mirror button
            _cameraCaptureModal.querySelector('.camera-mirror-btn').addEventListener('click', function () {
                _cameraCaptureMirror = !_cameraCaptureMirror;
                var btn = _cameraCaptureModal.querySelector('.camera-mirror-btn');
                btn.style.color = _cameraCaptureMirror ? '#4fc3f7' : '#aaa';
                btn.style.background = _cameraCaptureMirror ? 'rgba(79,195,247,0.25)' : 'rgba(255,255,255,0.15)';
                if (_cameraCaptureVideo) {
                    _cameraCaptureVideo.style.transform = _cameraCaptureMirror ? 'scaleX(-1)' : '';
                }
            });
            // Flash button
            _cameraCaptureModal.querySelector('.camera-flash-btn').addEventListener('click', function () {
                _cameraCaptureFlashOn = !_cameraCaptureFlashOn;
                var btn = _cameraCaptureModal.querySelector('.camera-flash-btn');
                btn.style.color = _cameraCaptureFlashOn ? '#FFD700' : '#aaa';
                btn.style.background = _cameraCaptureFlashOn ? 'rgba(255,215,0,0.25)' : 'rgba(255,255,255,0.15)';
                // Show/hide floating brightness control (root-level, above overlay)
                if (_cameraBrightnessCtrl) _cameraBrightnessCtrl.style.display = _cameraCaptureFlashOn ? 'flex' : 'none';
                // Apply torch to video track if available (back camera)
                if (_cameraCaptureStream && _cameraCaptureFacing === 'environment') {
                    var track = _cameraCaptureStream.getVideoTracks()[0];
                    if (track && track.getCapabilities && track.getCapabilities().torch) {
                        track.applyConstraints({ advanced: [{ torch: _cameraCaptureFlashOn }] }).catch(function(){});
                    }
                }
                if (_cameraCaptureFlashEl) {
                    _cameraCaptureFlashEl.style.background = 'rgba(255,255,255,' + (_cameraCaptureFlashIntensity / 100) + ')';
                }
            });
            // Resolution buttons for photo
            _cameraCaptureModal.querySelectorAll('.camera-res-btn').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    _cameraCaptureModal.querySelectorAll('.camera-res-btn').forEach(function (b) {
                        b.style.background = 'transparent';
                        b.style.color = '#aaa';
                        b.style.borderColor = 'rgba(255,255,255,0.2)';
                        b.style.fontWeight = '400';
                    });
                    var res = btn.dataset.res;
                    btn.style.background = 'rgba(255,255,255,0.2)';
                    btn.style.color = '#fff';
                    btn.style.borderColor = 'rgba(255,255,255,0.3)';
                    btn.style.fontWeight = '600';
                    if (res !== _cameraCaptureResolution) {
                        _cameraCaptureResolution = res;
                        // Restart stream with new resolution
                        if (_cameraCaptureStream) startCameraCaptureStream();
                    }
                });
            });
            // Zoom slider
            _cameraZoomSlider = document.getElementById('camera-zoom-slider');
            _cameraZoomLabel = document.getElementById('camera-zoom-label');
            if (_cameraZoomSlider) {
                _cameraZoomSlider.addEventListener('input', function () {
                    _cameraZoomLevel = parseFloat(_cameraZoomSlider.value);
                    if (_cameraZoomLabel) _cameraZoomLabel.textContent = _cameraZoomLevel.toFixed(1) + '×';
                    applyZoom();
                });
            }
            // Flash intensity slider
            var cameraFlashIntensitySlider = document.getElementById('camera-flash-intensity');
            var cameraFlashIntensityLabel = document.getElementById('camera-flash-intensity-label');
            if (cameraFlashIntensitySlider) {
                cameraFlashIntensitySlider.addEventListener('input', function () {
                    _cameraCaptureFlashIntensity = parseInt(cameraFlashIntensitySlider.value, 10);
                    if (cameraFlashIntensityLabel) cameraFlashIntensityLabel.textContent = _cameraCaptureFlashIntensity + '%';
                    if (_cameraCaptureFlashEl) {
                        _cameraCaptureFlashEl.style.background = 'rgba(255,255,255,' + (_cameraCaptureFlashIntensity / 100) + ')';
                    }
                });
            }
            // Pinch-to-zoom and tap-to-focus on video
            _cameraCaptureVideo.addEventListener('touchstart', function (e) {
                if (e.touches.length === 2) {
                    _cameraWasPinching = true;
                    _cameraLastPinchDist = Math.hypot(
                        e.touches[0].clientX - e.touches[1].clientX,
                        e.touches[0].clientY - e.touches[1].clientY
                    );
                }
            }, { passive: true });
            _cameraCaptureVideo.addEventListener('touchmove', function (e) {
                if (e.touches.length === 2 && _cameraLastPinchDist > 0) {
                    e.preventDefault();
                    var dist = Math.hypot(
                        e.touches[0].clientX - e.touches[1].clientX,
                        e.touches[0].clientY - e.touches[1].clientY
                    );
                    var scale = dist / _cameraLastPinchDist;
                    var newZoom = Math.max(_cameraZoomMin, Math.min(_cameraZoomMax, _cameraZoomLevel * scale));
                    if (Math.abs(newZoom - _cameraZoomLevel) > 0.05) {
                        _cameraZoomLevel = newZoom;
                        if (_cameraZoomSlider) _cameraZoomSlider.value = _cameraZoomLevel;
                        if (_cameraZoomLabel) _cameraZoomLabel.textContent = _cameraZoomLevel.toFixed(1) + '×';
                        applyZoom();
                    }
                    _cameraLastPinchDist = dist;
                }
            }, { passive: false });
            _cameraCaptureVideo.addEventListener('touchend', function (e) {
                // Single tap (not after pinch): set focus point
                if (e.changedTouches.length === 1 && !_cameraWasPinching) {
                    var touch = e.changedTouches[0];
                    var rect = _cameraCaptureVideo.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        var x = (touch.clientX - rect.left) / rect.width;
                        var y = (touch.clientY - rect.top) / rect.height;
                        setFocusPoint(x, y);
                    }
                }
                if (e.touches.length < 2) { _cameraLastPinchDist = 0; _cameraWasPinching = false; }
            }, { passive: true });
            _cameraCaptureVideo.addEventListener('dblclick', function (e) {
                // Double-click to reset zoom
                _cameraZoomLevel = 1;
                if (_cameraZoomSlider) _cameraZoomSlider.value = 1;
                if (_cameraZoomLabel) _cameraZoomLabel.textContent = '1.0×';
                applyZoom();
            });
            // Capture button
            _cameraCaptureModal.querySelector('.camera-capture-btn').addEventListener('click', function () {
                if (_cameraCaptureTimer > 0) {
                    startCountdown();
                } else {
                    captureCameraPhoto();
                }
            });
            // Timer buttons
            _cameraCaptureModal.querySelectorAll('.camera-timer-btn').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    _cameraCaptureModal.querySelectorAll('.camera-timer-btn').forEach(function (b) {
                        b.style.background = 'transparent';
                        b.style.color = '#aaa';
                        b.style.borderColor = 'rgba(255,255,255,0.2)';
                    });
                    var timer = parseInt(btn.dataset.timer, 10);
                    btn.style.background = 'rgba(255,255,255,0.2)';
                    btn.style.color = '#fff';
                    btn.style.borderColor = 'rgba(255,255,255,0.3)';
                    var customInput = document.getElementById('camera-custom-timer');
                    if (timer === 0) {
                        _cameraCaptureTimer = 0;
                        if (customInput) { customInput.style.display = 'none'; customInput.value = ''; }
                    } else {
                        _cameraCaptureTimer = timer;
                        if (customInput) { customInput.style.display = 'none'; customInput.value = ''; }
                    }
                });
            });
            // Custom timer input
            var customTimerInput = document.getElementById('camera-custom-timer');
            if (customTimerInput) {
                customTimerInput.addEventListener('focus', function () {
                    _cameraCaptureModal.querySelectorAll('.camera-timer-btn').forEach(function (b) {
                        b.style.background = 'transparent';
                        b.style.color = '#aaa';
                        b.style.borderColor = 'rgba(255,255,255,0.2)';
                    });
                    customTimerInput.style.display = '';
                });
                customTimerInput.addEventListener('input', function () {
                    var val = parseInt(customTimerInput.value, 10);
                    if (!isNaN(val) && val > 0) {
                        _cameraCaptureTimer = Math.min(val, 99);
                    } else {
                        _cameraCaptureTimer = 0;
                    }
                });
                customTimerInput.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        if (_cameraCaptureTimer > 0) startCountdown();
                        else captureCameraPhoto();
                    }
                });
            }
            
            // Create photo preview overlay (hidden initially)
            _cameraPhotoPreviewEl = document.createElement('div');
            _cameraPhotoPreviewEl.className = 'modal';
            _cameraPhotoPreviewEl.style.cssText = 'display:none;z-index:2001;background:rgba(0,0,0,0.95);';
            _cameraPhotoPreviewEl.innerHTML = '<div class="camera-capture-content" style="position:relative;width:100%;max-width:500px;margin:auto;text-align:center;">'
                + '<img id="camera-photo-preview-img" style="width:100%;max-height:70vh;border-radius:12px;object-fit:contain;background:#000;">'
                + '<div style="display:flex;align-items:center;justify-content:center;gap:40px;margin-top:16px;padding:0 20px;">'
                + '<button class="camera-retake-btn" style="background:rgba(255,255,255,0.15);border:none;border-radius:50%;width:48px;height:48px;aspect-ratio:1;flex-shrink:0;color:#fff;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s;">↩ Retake</button>'
                + '<button class="camera-accept-btn" style="background:#4caf50;border:none;border-radius:50%;width:64px;height:64px;aspect-ratio:1;flex-shrink:0;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 4px rgba(76,175,80,0.3);transition:transform 0.1s;"><div style="width:54px;height:54px;border-radius:50%;background:#4caf50;border:2px solid #fff;display:flex;align-items:center;justify-content:center;color:#fff;font-size:28px;">✓</div></button>'
                + '<button class="camera-cancel-btn" style="background:rgba(255,255,255,0.15);border:none;border-radius:50%;width:48px;height:48px;aspect-ratio:1;flex-shrink:0;color:#fff;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s;">✕</button>'
                + '</div></div>';
            document.body.appendChild(_cameraPhotoPreviewEl);
            
            _cameraPhotoPreviewEl.querySelector('.camera-retake-btn').addEventListener('click', function () {
                _cameraPhotoPreviewEl.style.display = 'none';
                if (_cameraPhotoPreviewData) {
                    URL.revokeObjectURL(_cameraPhotoPreviewData.url);
                    _cameraPhotoPreviewData = null;
                }
                _cameraCaptureModal.style.display = 'flex';
                startCameraCaptureStream();
            });
            _cameraPhotoPreviewEl.querySelector('.camera-accept-btn').addEventListener('click', function () {
                if (!_cameraPhotoPreviewData) return;
                var blob = _cameraPhotoPreviewData.blob;
                var url = _cameraPhotoPreviewData.url;
                _cameraPhotoPreviewEl.style.display = 'none';
                closeCameraCapture();
                var file = new File([blob], 'Photo_' + Date.now() + '.png', { type: 'image/png' });
                if (url) URL.revokeObjectURL(url);
                selectedFiles = [file];
                currentFileIndex = 0;
                showUploadModal();
            });
            _cameraPhotoPreviewEl.querySelector('.camera-cancel-btn').addEventListener('click', function () {
                _cameraPhotoPreviewEl.style.display = 'none';
                if (_cameraPhotoPreviewData) {
                    URL.revokeObjectURL(_cameraPhotoPreviewData.url);
                    _cameraPhotoPreviewData = null;
                }
                closeCameraCapture();
            });
        }
        
        _cameraCaptureModal.style.display = 'flex';
        startCameraCaptureStream();
    }
    
    function startCountdown() {
        if (!_cameraCaptureVideo) return;
        var remaining = _cameraCaptureTimer;
        _cameraCaptureCountdownEl.style.display = '';
        _cameraCaptureCountdownEl.textContent = remaining;
        if (_cameraCaptureCountdownTimer) { clearInterval(_cameraCaptureCountdownTimer); }
        _cameraCaptureCountdownTimer = setInterval(function () {
            remaining--;
            if (remaining <= 0) {
                clearInterval(_cameraCaptureCountdownTimer);
                _cameraCaptureCountdownTimer = null;
                _cameraCaptureCountdownEl.style.display = 'none';
                captureCameraPhoto();
            } else {
                _cameraCaptureCountdownEl.textContent = remaining;
            }
        }, 1000);
    }
    
    function applyZoom() {
        if (!_cameraCaptureStream) return;
        var track = _cameraCaptureStream.getVideoTracks()[0];
        if (!track || !track.getCapabilities) return;
        var caps = track.getCapabilities();
        if (!caps.zoom) return;
        var zoom = Math.max(caps.zoom.min || 1, Math.min(caps.zoom.max || 3, _cameraZoomLevel));
        track.applyConstraints({ advanced: [{ zoom: zoom }] }).catch(function(){});
    }

    function applyVideoZoom() {
        if (!_videoRecStream) return;
        var track = _videoRecStream.getVideoTracks()[0];
        if (!track || !track.getCapabilities) return;
        var caps = track.getCapabilities();
        if (!caps.zoom) return;
        var zoom = Math.max(caps.zoom.min || 1, Math.min(caps.zoom.max || 3, _videoRecZoomLevel));
        track.applyConstraints({ advanced: [{ zoom: zoom }] }).catch(function(){});
    }

    function setFocusPoint(x, y) {
        if (!_cameraCaptureStream) return;
        var track = _cameraCaptureStream.getVideoTracks()[0];
        if (!track || !track.getCapabilities) return;
        var caps = track.getCapabilities();
        var constraints = {};
        if (caps.focusMode && caps.focusMode.indexOf('single') !== -1) {
            constraints.focusMode = 'single';
        }
        if (caps.pointsOfInterest) {
            constraints.pointsOfInterest = [{ x: x, y: y }];
        }
        if (Object.keys(constraints).length > 0) {
            track.applyConstraints({ advanced: [constraints] }).catch(function(){});
        }
        // Show focus indicator briefly
        var focusEl = document.getElementById('camera-focus-indicator');
        if (!focusEl) {
            focusEl = document.createElement('div');
            focusEl.id = 'camera-focus-indicator';
            focusEl.style.cssText = 'position:absolute;width:60px;height:60px;border:2px solid #4fc3f7;border-radius:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:6;transition:opacity 0.3s;';
            _cameraCaptureModal.querySelector('.camera-capture-content').appendChild(focusEl);
        }
        // Position relative to video
        var videoRect = _cameraCaptureVideo.getBoundingClientRect();
        var contentRect = _cameraCaptureModal.querySelector('.camera-capture-content').getBoundingClientRect();
        focusEl.style.left = (videoRect.left - contentRect.left + x * videoRect.width) + 'px';
        focusEl.style.top = (videoRect.top - contentRect.top + y * videoRect.height) + 'px';
        focusEl.style.opacity = '1';
        setTimeout(function () { focusEl.style.opacity = '0'; }, 800);
    }

    function setVideoRecFocusPoint(x, y) {
        if (!_videoRecStream) return;
        var track = _videoRecStream.getVideoTracks()[0];
        if (!track || !track.getCapabilities) return;
        var caps = track.getCapabilities();
        var constraints = {};
        if (caps.focusMode && caps.focusMode.indexOf('single') !== -1) {
            constraints.focusMode = 'single';
        }
        if (caps.pointsOfInterest) {
            constraints.pointsOfInterest = [{ x: x, y: y }];
        }
        if (Object.keys(constraints).length > 0) {
            track.applyConstraints({ advanced: [constraints] }).catch(function(){});
        }
        // Show focus indicator briefly
        var focusEl = document.getElementById('video-rec-focus-indicator');
        if (!focusEl) {
            focusEl = document.createElement('div');
            focusEl.id = 'video-rec-focus-indicator';
            focusEl.style.cssText = 'position:absolute;width:60px;height:60px;border:2px solid #4fc3f7;border-radius:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:6;transition:opacity 0.3s;';
            if (_videoRecModal) {
                var container = _videoRecModal.querySelector('div');
                if (container) container.appendChild(focusEl);
            }
        }
        // Position relative to video
        var videoRect = _videoRecVideo.getBoundingClientRect();
        var contentRect = (_videoRecModal.querySelector('div') || _videoRecVideo.parentElement).getBoundingClientRect();
        focusEl.style.left = (videoRect.left - contentRect.left + x * videoRect.width) + 'px';
        focusEl.style.top = (videoRect.top - contentRect.top + y * videoRect.height) + 'px';
        focusEl.style.opacity = '1';
        setTimeout(function () { focusEl.style.opacity = '0'; }, 800);
    }

    function startCameraCaptureStream() {
        closeCameraCaptureStream();
        if (!_cameraCaptureVideo) return;
        // Reset zoom
        _cameraZoomLevel = 1;
        if (_cameraZoomSlider) { _cameraZoomSlider.value = 1; _cameraZoomSlider.min = 1; _cameraZoomSlider.max = 3; }
        if (_cameraZoomLabel) _cameraZoomLabel.textContent = '1.0×';
        var res = _cameraCaptureResolutions[_cameraCaptureResolution] || _cameraCaptureResolutions['720p'];
        navigator.mediaDevices.getUserMedia({
            video: { facingMode: _cameraCaptureFacing, width: { ideal: res.width }, height: { ideal: res.height } }
        }).then(function (stream) {
            _cameraCaptureStream = stream;
            _cameraCaptureVideo.srcObject = stream;
            _cameraCaptureVideo.play().catch(function () {});
            // Read zoom capabilities from the track
            var track = stream.getVideoTracks()[0];
            if (track && track.getCapabilities) {
                var caps = track.getCapabilities();
                var zoomRow = _cameraCaptureModal && _cameraCaptureModal.querySelector('.camera-zoom-row');
                if (caps.zoom) {
                    _cameraZoomMin = caps.zoom.min || 1;
                    _cameraZoomMax = caps.zoom.max || 3;
                    if (_cameraZoomSlider) {
                        _cameraZoomSlider.min = _cameraZoomMin;
                        _cameraZoomSlider.max = _cameraZoomMax;
                        _cameraZoomSlider.step = (caps.zoom.step !== undefined) ? caps.zoom.step : 0.1;
                    }
                    if (zoomRow) zoomRow.style.display = '';
                } else {
                    if (zoomRow) zoomRow.style.display = 'none';
                }
            }
            // If flash was on and back camera, re-enable torch
            if (_cameraCaptureFlashOn && _cameraCaptureFacing === 'environment') {
                if (track && track.getCapabilities && track.getCapabilities().torch) {
                    track.applyConstraints({ advanced: [{ torch: true }] }).catch(function(){});
                }
            }
        }).catch(function () {
            alert('Camera access denied.');
            closeCameraCapture();
        });
    }
    
    function closeCameraCaptureStream() {
        if (_cameraCaptureCountdownTimer) {
            clearInterval(_cameraCaptureCountdownTimer);
            _cameraCaptureCountdownTimer = null;
        }
        if (_cameraFlashTimer) {
            clearTimeout(_cameraFlashTimer);
            _cameraFlashTimer = null;
        }
        if (_cameraCapturePreTimer) {
            clearTimeout(_cameraCapturePreTimer);
            _cameraCapturePreTimer = null;
        }
        if (_cameraCaptureCountdownEl) _cameraCaptureCountdownEl.style.display = 'none';
        if (_cameraCaptureFlashEl) _cameraCaptureFlashEl.style.display = 'none';
        if (_cameraCaptureStream) {
            _cameraCaptureStream.getTracks().forEach(function (t) { t.stop(); });
            _cameraCaptureStream = null;
        }
        if (_cameraCaptureVideo) _cameraCaptureVideo.srcObject = null;
    }
    
    var _shutterCtx = null;

    function playShutterSound() {
        try {
            if (!_shutterCtx) {
                _shutterCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (_shutterCtx.state === 'suspended') {
                _shutterCtx.resume();
            }
            var g = _shutterCtx.createGain();
            g.connect(_shutterCtx.destination);
            // Short noise burst shaped to sound like a shutter click
            var bufferSize = _shutterCtx.sampleRate * 0.08; // 80ms
            var buf = _shutterCtx.createBuffer(1, bufferSize, _shutterCtx.sampleRate);
            var d = buf.getChannelData(0);
            for (var i = 0; i < bufferSize; i++) {
                var t = i / _shutterCtx.sampleRate;
                d[i] = (Math.random() * 2 - 1) * Math.exp(-t * 60); // noise burst with fast decay
            }
            var src = _shutterCtx.createBufferSource();
            src.buffer = buf;
            src.connect(g);
            g.gain.setValueAtTime(0.3, _shutterCtx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.001, _shutterCtx.currentTime + 0.08);
            src.start();
            // Cleanup gain after sound finishes
            setTimeout(function () { g.disconnect(); }, 200);
        } catch (e) { /* shutter sound not critical */ }
    }

    var _cameraCapturePreTimer = null; // setTimeout ID for the pre-capture flash hold
    
    function captureCameraPhoto() {
        if (!_cameraCaptureVideo || !_cameraCaptureVideo.videoWidth) return;
        playShutterSound();
        _cameraCapturePreTimer = null;
        
        // If back camera with flash, ensure the hardware torch is actively lit
        if (_cameraCaptureFlashOn && _cameraCaptureFacing === 'environment' && _cameraCaptureStream) {
            var track = _cameraCaptureStream.getVideoTracks()[0];
            if (track && track.getCapabilities && track.getCapabilities().torch) {
                track.applyConstraints({ advanced: [{ torch: true }] }).catch(function(){});
            }
        }
        
        // Shared capture: draws video frame to canvas and creates the preview blob
        function doCapture() {
            if (!_cameraCaptureCanvas) {
                _cameraCaptureCanvas = document.createElement('canvas');
                _cameraCaptureCtx = _cameraCaptureCanvas.getContext('2d');
            }
            _cameraCaptureCanvas.width = _cameraCaptureVideo.videoWidth;
            _cameraCaptureCanvas.height = _cameraCaptureVideo.videoHeight;
            // Mirror the image if mirror toggle is on (horizontally flips the captured photo)
            if (_cameraCaptureMirror) {
                _cameraCaptureCtx.translate(_cameraCaptureCanvas.width, 0);
                _cameraCaptureCtx.scale(-1, 1);
            }
            _cameraCaptureCtx.drawImage(_cameraCaptureVideo, 0, 0);
            // Reset transform if we mirrored
            if (_cameraCaptureMirror) {
                _cameraCaptureCtx.setTransform(1, 0, 0, 1, 0, 0);
            }
            _cameraCaptureCanvas.toBlob(function (blob) {
                var url = URL.createObjectURL(blob);
                _cameraPhotoPreviewData = { blob: blob, url: url };
                var previewImg = document.getElementById('camera-photo-preview-img');
                if (previewImg) previewImg.src = url;
                _cameraCaptureModal.style.display = 'none';
                
                // If flash is on: keep the camera stream (and torch) alive during
                // the post-capture flash hold so the subject stays lit. The stream
                // and overlay are cleaned up after a 1s delay.
                if (_cameraCaptureFlashOn && _cameraCaptureFlashEl) {
                    if (_cameraFlashTimer) {
                        clearTimeout(_cameraFlashTimer);
                    }
                    _cameraFlashTimer = setTimeout(function () {
                        closeCameraCaptureStream();
                        if (_cameraCaptureFlashEl) _cameraCaptureFlashEl.style.display = 'none';
                        _cameraFlashTimer = null;
                    }, 1000);
                } else {
                    // No flash: tear down immediately
                    closeCameraCaptureStream();
                    if (_cameraCaptureFlashEl) _cameraCaptureFlashEl.style.display = 'none';
                }
                
                _cameraPhotoPreviewEl.style.display = 'flex';
            }, 'image/png');
        }
        
        if (_cameraCaptureFlashOn && _cameraCaptureFlashEl) {
            // Flash on: show overlay, wait 1s for torch/exposure to settle, capture,
            // then keep flash and stream alive for 1s more after capture
            _cameraCaptureFlashEl.style.display = '';
            _cameraCapturePreTimer = setTimeout(function () {
                _cameraCapturePreTimer = null;
                if (typeof requestAnimationFrame !== 'undefined') {
                    requestAnimationFrame(doCapture);
                } else {
                    doCapture();
                }
            }, 1000);
        } else {
            // Flash off: capture immediately
            if (typeof requestAnimationFrame !== 'undefined') {
                requestAnimationFrame(doCapture);
            } else {
                doCapture();
            }
        }
    }
    
    function closeCameraCapture() {
        closeCameraCaptureStream();
        if (_cameraCaptureModal) _cameraCaptureModal.style.display = 'none';
        if (_cameraPhotoPreviewEl) _cameraPhotoPreviewEl.style.display = 'none';
        if (_cameraPhotoPreviewData) {
            URL.revokeObjectURL(_cameraPhotoPreviewData.url);
            _cameraPhotoPreviewData = null;
        }
        if (_cameraCaptureFlashEl) _cameraCaptureFlashEl.style.display = 'none';
        if (_cameraBrightnessCtrl) _cameraBrightnessCtrl.style.display = 'none';
    }
    
    // --- Video recording ---
    var _videoRecModal = null;
    var _videoRecStream = null;
    var _videoRecorder = null;
    var _videoRecChunks = [];
    var _videoRecTimer = null;
    var _videoRecStartTime = 0;
    var _videoRecVideo = null;
    var _videoRecFlashOn = false;
    var _videoRecFlashOverlay = null;
    var _videoRecFacing = 'environment';
    var _videoRecResolution = '720p';
    var _videoRecResolutions = {
        '720p': { width: 1280, height: 720, label: '720p' },
        '1080p': { width: 1920, height: 1080, label: '1080p' },
        '4K': { width: 3840, height: 2160, label: '4K' }
    };
    var _videoRecMirror = false; // horizontal mirror toggle for video preview
    var _videoRecPreviewData = null; // { blob, url }
    var _videoRecPreviewEl = null;
    var _videoRecZoomLevel = 1;
    var _videoRecZoomMin = 1;
    var _videoRecZoomMax = 1;
    var _videoRecZoomSlider = null;
    var _videoRecZoomLabel = null;
    var _videoRecMirrorOutput = false; // whether to actually mirror the recorded video/photo output
    var _videoRecCanvasStream = null;
    var _videoRecCanvasCtx = null;
    var _videoRecMirrorCanvas = null;
    var _videoRecLastPinchDist = 0;
    var _videoRecWasPinching = false;
    var _videoRecFlashIntensity = 25; // 0-100, white overlay brightness percentage
    var _videoRecMirrorRAF = null; // requestAnimationFrame handle for canvas mirror drawing
    var _videoBrightnessCtrl = null; // Floating brightness control (root-level, above overlay)
    
    function setVideoRecFlash(enable) {
        if (!_videoRecStream) return;
        var track = _videoRecStream.getVideoTracks()[0];
        var usedTorch = false;
        // Back camera: use torch
        if (_videoRecFacing === 'environment' && track && track.getCapabilities && track.getCapabilities().torch) {
            track.applyConstraints({ advanced: [{ torch: enable }] }).catch(function(){});
            usedTorch = true;
        }
        // Only show screen overlay for selfie camera or when torch is unsupported
        if (!usedTorch) {
            if (!_videoRecFlashOverlay) {
                _videoRecFlashOverlay = document.getElementById('video-rec-brightness-overlay');
            }
            if (_videoRecFlashOverlay) {
                _videoRecFlashOverlay.style.display = enable ? '' : 'none';
            }
        } else {
            if (_videoRecFlashOverlay) _videoRecFlashOverlay.style.display = 'none';
        }
    }
    
    function startVideoRecording() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
            alert('Video recording not supported in this browser.');
            return;
        }
        closeVideoRecording();
        
        // Create modal if first time
        if (!_videoRecModal) {
            _videoRecModal = document.createElement('div');
            _videoRecModal.className = 'modal';
            _videoRecModal.style.cssText = 'display:flex;z-index:2000;background:rgba(0,0,0,0.9);';
            _videoRecModal.innerHTML = '<div style="position:relative;width:100%;max-width:500px;margin:auto;text-align:center;">'
                + '<button class="video-rec-close" style="position:absolute;top:10px;right:14px;background:none;border:none;color:#fff;font-size:28px;cursor:pointer;z-index:10;line-height:1;">&times;</button>'
                + '<video id="video-rec-preview" autoplay playsinline muted style="width:100%;max-height:55vh;border-radius:12px;object-fit:contain;background:#000;"></video>'
                // Zoom row
                + '<div class="video-rec-zoom-row" style="display:none;align-items:center;justify-content:center;gap:8px;margin-top:8px;padding:0 20px;">'
                + '<span style="color:#888;font-size:11px;">🔍</span>'
                + '<input type="range" id="video-rec-zoom-slider" min="1" max="3" step="0.1" value="1" style="flex:1;max-width:140px;height:4px;-webkit-appearance:none;appearance:none;background:#555;border-radius:2px;outline:none;cursor:pointer;">'
                + '<span id="video-rec-zoom-label" style="color:#aaa;font-size:11px;min-width:28px;text-align:center;">1.0×</span>'
                + '</div>'
                // Resolution selector
                + '<div class="video-rec-res-row" style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:8px;padding:0 16px;">'
                + '<span style="color:#888;font-size:11px;">📺</span>'
                + '<button class="video-rec-res-btn" data-res="720p" style="background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.3);border-radius:4px;color:#fff;padding:4px 10px;font-size:11px;cursor:pointer;transition:all 0.15s;font-weight:600;">720p</button>'
                + '<button class="video-rec-res-btn" data-res="1080p" style="background:transparent;border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#aaa;padding:4px 10px;font-size:11px;cursor:pointer;transition:all 0.15s;">1080p</button>'
                + '<button class="video-rec-res-btn" data-res="4K" style="background:transparent;border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#aaa;padding:4px 10px;font-size:11px;cursor:pointer;transition:all 0.15s;">4K</button>'
                + '</div>'
                + '<div style="display:flex;align-items:center;justify-content:center;gap:14px;margin-top:4px;padding:0 16px;">'
                + '<span id="video-rec-timer" style="color:#fff;font-size:16px;font-weight:600;min-width:60px;font-variant-numeric:tabular-nums;">0:00</span>'
                + '<button id="video-rec-flash-btn" style="background:rgba(255,255,255,0.15);border:none;border-radius:50%;width:40px;height:40px;aspect-ratio:1;flex-shrink:0;color:#aaa;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.15s;" title="Flash">☀️</button>'
                + '<button id="video-rec-mirror-btn" style="background:rgba(255,255,255,0.15);border:none;border-radius:50%;width:40px;height:40px;aspect-ratio:1;flex-shrink:0;color:#aaa;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.15s;" title="Mirror">↔</button>'
                + '<button id="video-rec-flip-btn" style="background:rgba(255,255,255,0.15);border:none;border-radius:50%;width:40px;height:40px;aspect-ratio:1;flex-shrink:0;color:#fff;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s;" title="Flip camera">🔄</button>'
                + '<button id="video-rec-toggle-btn" style="background:#f44336;border:none;border-radius:50%;width:64px;height:64px;aspect-ratio:1;flex-shrink:0;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 4px rgba(244,67,54,0.3);transition:all 0.15s;"><div style="width:28px;height:28px;border-radius:50%;background:#fff;"></div></button>'
                + '<button id="video-rec-finish-btn" style="display:none;background:#4caf50;border:none;border-radius:50%;width:48px;height:48px;aspect-ratio:1;flex-shrink:0;cursor:pointer;align-items:center;justify-content:center;box-shadow:0 0 0 4px rgba(76,175,80,0.3);transition:all 0.15s;color:#fff;font-size:22px;">✓</button>'
                + '<button class="video-rec-cancel" style="background:rgba(255,255,255,0.15);border:none;border-radius:50%;width:40px;height:40px;aspect-ratio:1;flex-shrink:0;color:#fff;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s;">✕</button>'
                + '</div></div>';
            document.body.appendChild(_videoRecModal);
            _videoRecVideo = _videoRecModal.querySelector('#video-rec-preview');
            // Create brightness overlay as a SEPARATE body element (not inside modal) so position:fixed covers full viewport for selfie flash
            _videoRecFlashOverlay = document.createElement('div');
            _videoRecFlashOverlay.id = 'video-rec-brightness-overlay';
            _videoRecFlashOverlay.style.cssText = 'display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(255,255,255,' + (_videoRecFlashIntensity / 100) + ');z-index:2002;pointer-events:none;';
            document.body.appendChild(_videoRecFlashOverlay);
            
            // Create floating brightness control ABOVE the white overlay (root-level, higher z-index)
            _videoBrightnessCtrl = document.createElement('div');
            _videoBrightnessCtrl.id = 'video-rec-brightness-ctrl';
            _videoBrightnessCtrl.style.cssText = 'display:none;position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2003;background:rgba(0,0,0,0.6);border-radius:10px;padding:8px 16px;align-items:center;gap:8px;';
            _videoBrightnessCtrl.innerHTML = '<span style="color:#FFD700;font-size:14px;">💡</span>'
                + '<input type="range" id="video-rec-flash-intensity" min="0" max="100" step="1" value="25" style="width:120px;height:4px;-webkit-appearance:none;appearance:none;background:#555;border-radius:2px;outline:none;cursor:pointer;">'
                + '<span id="video-rec-flash-intensity-label" style="color:#FFD700;font-size:12px;min-width:32px;text-align:center;">25%</span>';
            document.body.appendChild(_videoBrightnessCtrl);
            
            // Zoom slider
            _videoRecZoomSlider = document.getElementById('video-rec-zoom-slider');
            _videoRecZoomLabel = document.getElementById('video-rec-zoom-label');
            if (_videoRecZoomSlider) {
                _videoRecZoomSlider.addEventListener('input', function () {
                    _videoRecZoomLevel = parseFloat(_videoRecZoomSlider.value);
                    if (_videoRecZoomLabel) _videoRecZoomLabel.textContent = _videoRecZoomLevel.toFixed(1) + '×';
                    applyVideoZoom();
                });
            }
            
            // Flash intensity slider
            var videoFlashIntensitySlider = document.getElementById('video-rec-flash-intensity');
            var videoFlashIntensityLabel = document.getElementById('video-rec-flash-intensity-label');
            if (videoFlashIntensitySlider) {
                videoFlashIntensitySlider.addEventListener('input', function () {
                    _videoRecFlashIntensity = parseInt(videoFlashIntensitySlider.value, 10);
                    if (videoFlashIntensityLabel) videoFlashIntensityLabel.textContent = _videoRecFlashIntensity + '%';
                    if (_videoRecFlashOverlay) {
                        _videoRecFlashOverlay.style.background = 'rgba(255,255,255,' + (_videoRecFlashIntensity / 100) + ')';
                    }
                });
            }
            
            // Pinch-to-zoom and tap-to-focus on video preview
            _videoRecVideo.addEventListener('touchstart', function (e) {
                if (e.touches.length === 2) {
                    _videoRecWasPinching = true;
                    _videoRecLastPinchDist = Math.hypot(
                        e.touches[0].clientX - e.touches[1].clientX,
                        e.touches[0].clientY - e.touches[1].clientY
                    );
                }
            }, { passive: true });
            _videoRecVideo.addEventListener('touchmove', function (e) {
                if (e.touches.length === 2 && _videoRecLastPinchDist > 0) {
                    e.preventDefault();
                    var dist = Math.hypot(
                        e.touches[0].clientX - e.touches[1].clientX,
                        e.touches[0].clientY - e.touches[1].clientY
                    );
                    var scale = dist / _videoRecLastPinchDist;
                    var newZoom = Math.max(_videoRecZoomMin, Math.min(_videoRecZoomMax, _videoRecZoomLevel * scale));
                    if (Math.abs(newZoom - _videoRecZoomLevel) > 0.05) {
                        _videoRecZoomLevel = newZoom;
                        if (_videoRecZoomSlider) _videoRecZoomSlider.value = _videoRecZoomLevel;
                        if (_videoRecZoomLabel) _videoRecZoomLabel.textContent = _videoRecZoomLevel.toFixed(1) + '×';
                        applyVideoZoom();
                    }
                    _videoRecLastPinchDist = dist;
                }
            }, { passive: false });
            _videoRecVideo.addEventListener('touchend', function (e) {
                // Single tap (not after pinch): set focus point
                if (e.changedTouches.length === 1 && !_videoRecWasPinching) {
                    var touch = e.changedTouches[0];
                    var rect = _videoRecVideo.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        var x = (touch.clientX - rect.left) / rect.width;
                        var y = (touch.clientY - rect.top) / rect.height;
                        setVideoRecFocusPoint(x, y);
                    }
                }
                if (e.touches.length < 2) { _videoRecLastPinchDist = 0; _videoRecWasPinching = false; }
            }, { passive: true });
            _videoRecVideo.addEventListener('dblclick', function (e) {
                // Double-click to reset zoom
                _videoRecZoomLevel = 1;
                if (_videoRecZoomSlider) _videoRecZoomSlider.value = 1;
                if (_videoRecZoomLabel) _videoRecZoomLabel.textContent = '1.0×';
                applyVideoZoom();
            });
            
            // Close button
            _videoRecModal.querySelector('.video-rec-close').addEventListener('click', closeVideoRecording);
            // Cancel button
            _videoRecModal.querySelector('.video-rec-cancel').addEventListener('click', closeVideoRecording);
            // Record toggle button (pause/resume)
            _videoRecModal.querySelector('#video-rec-toggle-btn').addEventListener('click', toggleVideoRecording);
            // Finish button (stops recording for real)
            _videoRecModal.querySelector('#video-rec-finish-btn').addEventListener('click', finishVideoAction);
            // Mirror button
            _videoRecModal.querySelector('#video-rec-mirror-btn').addEventListener('click', function () {
                _videoRecMirror = !_videoRecMirror;
                var btn = _videoRecModal.querySelector('#video-rec-mirror-btn');
                btn.style.color = _videoRecMirror ? '#4fc3f7' : '#aaa';
                btn.style.background = _videoRecMirror ? 'rgba(79,195,247,0.25)' : 'rgba(255,255,255,0.15)';
                if (_videoRecVideo) {
                    _videoRecVideo.style.transform = _videoRecMirror ? 'scaleX(-1)' : '';
                }
            });
            // Flash button
            _videoRecModal.querySelector('#video-rec-flash-btn').addEventListener('click', function () {
                _videoRecFlashOn = !_videoRecFlashOn;
                var btn = _videoRecModal.querySelector('#video-rec-flash-btn');
                btn.style.color = _videoRecFlashOn ? '#FFD700' : '#aaa';
                btn.style.background = _videoRecFlashOn ? 'rgba(255,215,0,0.25)' : 'rgba(255,255,255,0.15)';
                // Show/hide floating brightness control (root-level, above overlay)
                if (_videoBrightnessCtrl) _videoBrightnessCtrl.style.display = _videoRecFlashOn ? 'flex' : 'none';
                setVideoRecFlash(_videoRecFlashOn);
                if (_videoRecFlashOverlay) {
                    _videoRecFlashOverlay.style.background = 'rgba(255,255,255,' + (_videoRecFlashIntensity / 100) + ')';
                }
            });
            // Flip camera button
            _videoRecModal.querySelector('#video-rec-flip-btn').addEventListener('click', function () {
                if (_videoRecorder && _videoRecorder.state !== 'inactive') return;
                _videoRecFacing = _videoRecFacing === 'environment' ? 'user' : 'environment';
                startCameraStreamForVideo();
            });
            // Resolution buttons
            _videoRecModal.querySelectorAll('.video-rec-res-btn').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    // Don't switch resolution while recording or paused — would break the MediaRecorder
                    if (_videoRecorder && _videoRecorder.state !== 'inactive') return;
                    _videoRecModal.querySelectorAll('.video-rec-res-btn').forEach(function (b) {
                        b.style.background = 'transparent';
                        b.style.color = '#aaa';
                        b.style.borderColor = 'rgba(255,255,255,0.2)';
                        b.style.fontWeight = '400';
                    });
                    var res = btn.dataset.res;
                    btn.style.background = 'rgba(255,255,255,0.2)';
                    btn.style.color = '#fff';
                    btn.style.borderColor = 'rgba(255,255,255,0.3)';
                    btn.style.fontWeight = '600';
                    if (res !== _videoRecResolution) {
                        _videoRecResolution = res;
                        // Restart stream with new resolution
                        startCameraStreamForVideo();
                    }
                });
            });
        }
        
        // Create video preview overlay (hidden initially)
        if (!_videoRecPreviewEl) {
            _videoRecPreviewEl = document.createElement('div');
            _videoRecPreviewEl.className = 'modal';
            _videoRecPreviewEl.style.cssText = 'display:none;z-index:2002;background:rgba(0,0,0,0.95);';
            _videoRecPreviewEl.innerHTML = '<div style="position:relative;width:100%;max-width:500px;margin:auto;text-align:center;">'
                + '<video id="video-rec-preview-playback" autoplay loop playsinline muted style="width:100%;max-height:60vh;border-radius:12px;object-fit:contain;background:#000;"></video>'
                + '<div id="video-rec-preview-duration" style="color:#aaa;font-size:12px;margin-top:6px;"></div>'
                + '<div style="display:flex;align-items:center;justify-content:center;gap:40px;margin-top:16px;padding:0 20px;">'
                + '<button class="video-rec-preview-retake" style="background:rgba(255,255,255,0.15);border:none;border-radius:50%;width:48px;height:48px;aspect-ratio:1;flex-shrink:0;color:#fff;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s;">↩ Retake</button>'
                + '<button class="video-rec-preview-accept" style="background:#4caf50;border:none;border-radius:50%;width:64px;height:64px;aspect-ratio:1;flex-shrink:0;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 4px rgba(76,175,80,0.3);transition:transform 0.1s;"><div style="width:54px;height:54px;border-radius:50%;background:#4caf50;border:2px solid #fff;display:flex;align-items:center;justify-content:center;color:#fff;font-size:28px;">✓</div></button>'
                + '<button class="video-rec-preview-cancel" style="background:rgba(255,255,255,0.15);border:none;border-radius:50%;width:48px;height:48px;aspect-ratio:1;flex-shrink:0;color:#fff;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s;">✕</button>'
                + '</div></div>';
            document.body.appendChild(_videoRecPreviewEl);
            
            _videoRecPreviewEl.querySelector('.video-rec-preview-retake').addEventListener('click', function () {
                _videoRecPreviewEl.style.display = 'none';
                if (_videoRecPreviewData) {
                    URL.revokeObjectURL(_videoRecPreviewData.url);
                    _videoRecPreviewData = null;
                }
                _videoRecModal.style.display = 'flex';
                _videoRecFacing = _videoRecFacing || 'environment';
                startCameraStreamForVideo();
            });
            _videoRecPreviewEl.querySelector('.video-rec-preview-accept').addEventListener('click', function () {
                if (!_videoRecPreviewData) return;
                var blob = _videoRecPreviewData.blob;
                var url = _videoRecPreviewData.url;
                _videoRecPreviewEl.style.display = 'none';
                // Close the recording modal if it's still visible
                if (_videoRecModal) _videoRecModal.style.display = 'none';
                closeVideoRecording();
                var file = new File([blob], 'Video_' + Date.now() + '.webm', { type: 'video/webm' });
                if (url) URL.revokeObjectURL(url);
                selectedFiles = [file];
                currentFileIndex = 0;
                showUploadModal();
            });
            _videoRecPreviewEl.querySelector('.video-rec-preview-cancel').addEventListener('click', function () {
                _videoRecPreviewEl.style.display = 'none';
                if (_videoRecPreviewData) {
                    URL.revokeObjectURL(_videoRecPreviewData.url);
                    _videoRecPreviewData = null;
                }
                closeVideoRecording();
            });
        }
        
        _videoRecModal.style.display = 'flex';
        _videoRecFacing = 'environment';
        startCameraStreamForVideo();
    }
    
    function startCameraStreamForVideo() {
        closeCameraStreamForVideo();
        if (!_videoRecVideo) _videoRecVideo = document.getElementById('video-rec-preview');
        _videoRecZoomLevel = 1;
        if (_videoRecZoomSlider) { _videoRecZoomSlider.value = 1; _videoRecZoomSlider.min = 1; _videoRecZoomSlider.max = 3; }
        if (_videoRecZoomLabel) _videoRecZoomLabel.textContent = '1.0×';

        var res = _videoRecResolutions[_videoRecResolution] || _videoRecResolutions['720p'];
        navigator.mediaDevices.getUserMedia({
            video: { facingMode: _videoRecFacing, width: { ideal: res.width }, height: { ideal: res.height } },
            audio: true
        }).then(function (stream) {
            _videoRecStream = stream;
            _videoRecVideo.srcObject = stream;
            _videoRecVideo.play().catch(function () {});

            // Read zoom capabilities
            var track = stream.getVideoTracks()[0];
            if (track && track.getCapabilities) {
                var caps = track.getCapabilities();
                var zoomRow = _videoRecModal && _videoRecModal.querySelector('.video-rec-zoom-row');
                if (caps.zoom) {
                    _videoRecZoomMin = caps.zoom.min || 1;
                    _videoRecZoomMax = caps.zoom.max || 3;
                    if (_videoRecZoomSlider) {
                        _videoRecZoomSlider.min = _videoRecZoomMin;
                        _videoRecZoomSlider.max = _videoRecZoomMax;
                        _videoRecZoomSlider.step = (caps.zoom.step !== undefined) ? caps.zoom.step : 0.1;
                    }
                    if (zoomRow) zoomRow.style.display = '';
                } else {
                    if (zoomRow) zoomRow.style.display = 'none';
                }
            }
            // Re-enable flash if it was on
            if (_videoRecFlashOn) setVideoRecFlash(true);
        }).catch(function () {
            alert('Camera/microphone access denied.');
            closeVideoRecording();
        });
    }
    
    function closeCameraStreamForVideo() {
        if (_videoRecStream) {
            var track = _videoRecStream.getVideoTracks()[0];
            if (track && track.getCapabilities && track.getCapabilities().torch) {
                try { track.applyConstraints({ advanced: [{ torch: false }] }); } catch(e) {}
            }
            _videoRecStream.getTracks().forEach(function (t) { t.stop(); });
            _videoRecStream = null;
        }
        if (_videoRecVideo) _videoRecVideo.srcObject = null;
        if (_videoRecMirrorRAF) {
            cancelAnimationFrame(_videoRecMirrorRAF);
            _videoRecMirrorRAF = null;
        }
        // Clean up canvas mirror stream
        if (_videoRecCanvasStream) {
            _videoRecCanvasStream.getTracks().forEach(function (t) { t.stop(); });
            _videoRecCanvasStream = null;
        }
        _videoRecMirrorCanvas = null;
        _videoRecCanvasCtx = null;
        _videoRecMirrorOutput = false;
    }
    
    function finishVideoAction() {
        // Actually stop the recorder for real (finish the recording)
        if (_videoRecorder && _videoRecorder.state !== 'inactive') {
            // Resume first if paused so we get all chunks
            if (_videoRecorder.state === 'paused') {
                try { _videoRecorder.resume(); } catch(e) {}
            }
            _videoRecorder.stop();
        }
    }
    
    function toggleVideoRecording() {
        if (_videoRecorder && _videoRecorder.state === 'recording') {
            // Pause recording — button shows a play icon to resume
            _videoRecorder.pause();
            var btn = document.getElementById('video-rec-toggle-btn');
            if (btn) {
                btn.style.background = '#ff9800';
                btn.innerHTML = '<div style="width:0;height:0;border-left:20px solid #fff;border-top:14px solid transparent;border-bottom:14px solid transparent;margin-left:4px;"></div>';
                btn.style.boxShadow = '0 0 0 4px rgba(255,152,0,0.3)';
            }
            return;
        }
        if (_videoRecorder && _videoRecorder.state === 'paused') {
            // Resume recording — button becomes a square again
            _videoRecorder.resume();
            var btn = document.getElementById('video-rec-toggle-btn');
            if (btn) {
                btn.style.background = '#fff';
                btn.innerHTML = '<div style="width:26px;height:26px;border-radius:4px;background:#f44336;"></div>';
                btn.style.boxShadow = '0 0 0 4px rgba(255,255,255,0.3)';
            }
            return;
        }
        // Start recording
        if (!_videoRecStream) return;
        _videoRecMirrorOutput = _videoRecMirror;
        _videoRecChunks = [];
        var mimeType = 'video/webm;codecs=vp9,opus';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
            mimeType = 'video/webm';
            if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = '';
        }
        // If mirror is on, create a canvas-based mirrored stream so the recorded output is actually mirrored
        var streamToRecord = _videoRecStream;
        if (_videoRecMirror) {
            var vTrack = _videoRecStream.getVideoTracks()[0];
            // Use actual video element dimensions for the canvas, which are more reliable than getSettings()
            var width = _videoRecVideo.videoWidth || (vTrack ? vTrack.getSettings().width : 1280) || 1280;
            var height = _videoRecVideo.videoHeight || (vTrack ? vTrack.getSettings().height : 720) || 720;
            _videoRecMirrorCanvas = document.createElement('canvas');
            _videoRecMirrorCanvas.width = width;
            _videoRecMirrorCanvas.height = height;
            _videoRecCanvasCtx = _videoRecMirrorCanvas.getContext('2d');
            var audioTrack = _videoRecStream.getAudioTracks()[0];
            // Start RAF drawing loop to mirror each frame onto the canvas
            function drawMirrorFrame() {
                if (!_videoRecMirrorCanvas || !_videoRecCanvasCtx || !_videoRecVideo) {
                    _videoRecMirrorRAF = null;
                    return;
                }
                _videoRecCanvasCtx.clearRect(0, 0, width, height);
                _videoRecCanvasCtx.translate(width, 0);
                _videoRecCanvasCtx.scale(-1, 1);
                _videoRecCanvasCtx.drawImage(_videoRecVideo, 0, 0, width, height);
                _videoRecCanvasCtx.setTransform(1, 0, 0, 1, 0, 0);
                _videoRecMirrorRAF = requestAnimationFrame(drawMirrorFrame);
            }
            drawMirrorFrame();
            // Capture canvas stream and combine with audio from original stream
            var canvasStream = _videoRecMirrorCanvas.captureStream(30);
            var canvasVideoTrack = canvasStream.getVideoTracks()[0];
            if (canvasVideoTrack && audioTrack) {
                streamToRecord = new MediaStream([canvasVideoTrack, audioTrack]);
            } else if (canvasVideoTrack) {
                streamToRecord = new MediaStream([canvasVideoTrack]);
            }
            _videoRecCanvasStream = streamToRecord;
        }
        _videoRecorder = new MediaRecorder(streamToRecord, mimeType ? { mimeType: mimeType } : {});
        _videoRecorder.ondataavailable = function (e) {
            if (e.data && e.data.size > 0) _videoRecChunks.push(e.data);
        };
        _videoRecorder.onstop = function () {
            // Cancel mirror RAF if active
            if (_videoRecMirrorRAF) {
                cancelAnimationFrame(_videoRecMirrorRAF);
                _videoRecMirrorRAF = null;
            }
            var blob = new Blob(_videoRecChunks, { type: 'video/webm' });
            _videoRecChunks = [];
            finishVideoRecording(blob);
        };
        _videoRecorder.onerror = function () {
            if (_videoRecMirrorRAF) {
                cancelAnimationFrame(_videoRecMirrorRAF);
                _videoRecMirrorRAF = null;
            }
            closeVideoRecording();
            alert('Video recording error.');
        };
        _videoRecorder.start();
        _videoRecStartTime = Date.now();
        updateVideoRecTimer();
        if (_videoRecTimer) clearInterval(_videoRecTimer);
        _videoRecTimer = setInterval(updateVideoRecTimer, 200);
        // Show the finish (✓) button and hide cancel during recording
        var finishBtn = document.getElementById('video-rec-finish-btn');
        if (finishBtn) { finishBtn.style.display = 'flex'; }
        var cancelBtn = document.querySelector('.video-rec-cancel');
        if (cancelBtn) { cancelBtn.style.display = 'none'; }
        // Change button to recording state: white circle with red square inside
        var btn = document.getElementById('video-rec-toggle-btn');
        if (btn) {
            btn.style.background = '#fff';
            btn.innerHTML = '<div style="width:26px;height:26px;border-radius:4px;background:#f44336;"></div>';
            btn.style.boxShadow = '0 0 0 4px rgba(255,255,255,0.3)';
        }
    }
    
    function updateVideoRecTimer() {
        if (!_videoRecStartTime) return;
        var elapsed = Math.floor((Date.now() - _videoRecStartTime) / 1000);
        var m = Math.floor(elapsed / 60);
        var s = elapsed % 60;
        var el = document.getElementById('video-rec-timer');
        if (el) el.textContent = m + ':' + (s < 10 ? '0' : '') + s;
    }
    
    function finishVideoRecording(blob) {
        if (_videoRecTimer) { clearInterval(_videoRecTimer); _videoRecTimer = null; }
        // Reset toggle button to initial state
        var toggleBtn = document.getElementById('video-rec-toggle-btn');
        if (toggleBtn) {
            toggleBtn.style.background = '#f44336';
            toggleBtn.innerHTML = '<div style="width:28px;height:28px;border-radius:50%;background:#fff;"></div>';
            toggleBtn.style.boxShadow = '0 0 0 4px rgba(244,67,54,0.3)';
        }
        var finishBtn = document.getElementById('video-rec-finish-btn');
        if (finishBtn) finishBtn.style.display = 'none';
        var cancelBtn = document.querySelector('.video-rec-cancel');
        if (cancelBtn) cancelBtn.style.display = 'flex';
        closeCameraStreamForVideo();
        _videoRecModal.style.display = 'none';
        _videoRecorder = null;
        // Show preview instead of directly uploading
        var url = URL.createObjectURL(blob);
        _videoRecPreviewData = { blob: blob, url: url };
        var playbackVideo = document.getElementById('video-rec-preview-playback');
        if (playbackVideo) {
            playbackVideo.src = url;
            // Recorded video is already mirrored in the data (via canvas), so no CSS transform needed
            playbackVideo.style.transform = '';
            playbackVideo.play().catch(function(){});
        }
        // Show duration
        var durationEl = document.getElementById('video-rec-preview-duration');
        if (durationEl && _videoRecStartTime) {
            var elapsed = Math.floor((Date.now() - _videoRecStartTime) / 1000);
            var m = Math.floor(elapsed / 60);
            var s = elapsed % 60;
            durationEl.textContent = 'Duration: ' + m + ':' + (s < 10 ? '0' : '') + s;
        }
        _videoRecPreviewEl.style.display = 'flex';
    }
    
    function closeVideoRecording() {
        if (_videoRecTimer) { clearInterval(_videoRecTimer); _videoRecTimer = null; }
        if (_videoRecorder && _videoRecorder.state !== 'inactive') {
            _videoRecorder.ondataavailable = null;
            _videoRecorder.onstop = null;
            _videoRecorder.onerror = null;
            try { _videoRecorder.stop(); } catch(e) {}
        }
        if (_videoRecMirrorRAF) {
            cancelAnimationFrame(_videoRecMirrorRAF);
            _videoRecMirrorRAF = null;
        }
        _videoRecorder = null;
        _videoRecChunks = [];
        _videoRecFlashOn = false;
        if (_videoRecFlashOverlay) _videoRecFlashOverlay.style.display = 'none';
        if (_videoBrightnessCtrl) _videoBrightnessCtrl.style.display = 'none';
        
        if (_videoRecStream) {
            // Turn off torch before stopping
            var track = _videoRecStream.getVideoTracks()[0];
            if (track && track.getCapabilities && track.getCapabilities().torch) {
                try { track.applyConstraints({ advanced: [{ torch: false }] }); } catch(e) {}
            }
            _videoRecStream.getTracks().forEach(function (t) { t.stop(); });
            _videoRecStream = null;
        }
        if (_videoRecVideo) _videoRecVideo.srcObject = null;
        // Clean up video preview overlay
        if (_videoRecPreviewEl) _videoRecPreviewEl.style.display = 'none';
        if (_videoRecPreviewData) {
            URL.revokeObjectURL(_videoRecPreviewData.url);
            _videoRecPreviewData = null;
        }
        if (_videoRecModal) _videoRecModal.style.display = 'none';
    }
    
    // Simple click-to-record audio (bar shows Send + Cancel immediately) with live waveform
    var chatRecorder = null;
    var chatRecorderChunks = [];
    var chatRecorderStream = null;
    var chatRecordTimer = null;
    var chatRecordStartTime = 0;
    var _recordingWaveformCtx = null;
    var _recordingWaveformAnalyser = null;
    var _recordingWaveformDataArray = null;
    var _recordingWaveformDrawTimer = null;
    
    var recordingBar = document.getElementById('audio-recording-bar');
    var recordingTimer = document.getElementById('recording-bar-timer');
    var recordingSendBtn = document.getElementById('recording-bar-send');
    var recordingCancelBtn = document.getElementById('recording-bar-cancel');
    var recordingWaveformCanvas = document.getElementById('recording-waveform');
    
    function updateRecordingTimer() {
        if (!chatRecordStartTime) return;
        var elapsed = Math.floor((Date.now() - chatRecordStartTime) / 1000);
        var m = Math.floor(elapsed / 60);
        var s = elapsed % 60;
        if (recordingTimer) recordingTimer.textContent = m + ':' + (s < 10 ? '0' : '') + s;
    }
    
    function showRecordingBar(show) {
        if (recordingBar) recordingBar.style.display = show ? '' : 'none';
        if (recordingSendBtn) recordingSendBtn.style.display = show ? '' : 'none';
        if (recordingCancelBtn) recordingCancelBtn.style.display = show ? '' : 'none';
        if (recordingWaveformCanvas) {
            recordingWaveformCanvas.style.display = show ? '' : 'none';
            if (show) {
                recordingWaveformCanvas.width = recordingWaveformCanvas.offsetWidth || 120;
                recordingWaveformCanvas.height = recordingWaveformCanvas.offsetHeight || 32;
            }
        }
    }
    
    function cleanupChatRecording() {
        if (chatRecordTimer) { clearInterval(chatRecordTimer); chatRecordTimer = null; }
        if (_recordingWaveformDrawTimer) { cancelAnimationFrame(_recordingWaveformDrawTimer); _recordingWaveformDrawTimer = null; }
        if (_recordingWaveformCtx) { try { _recordingWaveformCtx.close(); } catch(e) {} _recordingWaveformCtx = null; }
        _recordingWaveformAnalyser = null;
        _recordingWaveformDataArray = null;
        if (chatRecorderStream) { chatRecorderStream.getTracks().forEach(function(t) { t.stop(); }); chatRecorderStream = null; }
        chatRecorder = null;
        chatRecorderChunks = [];
        showRecordingBar(false);
    }
    
    function cancelChatRecording() {
        if (chatRecorder && chatRecorder.state !== 'inactive') {
            chatRecorder.ondataavailable = null;
            chatRecorder.onstop = null;
            chatRecorder.stop();
        }
        cleanupChatRecording();
    }
    
    function sendChatRecording() {
        if (!chatRecorder || chatRecorder.state === 'inactive') {
            cleanupChatRecording();
            return;
        }
        chatRecorder.stop();
    }
    
    function finishChatRecording(blob) {
        cleanupChatRecording();
        var file = new File([blob], 'Recording.webm', { type: 'audio/webm' });
        selectedFiles = [file];
        currentFileIndex = 0;
        showUploadModal();
    }
    
    function drawWaveform() {
        if (!_recordingWaveformAnalyser || !recordingWaveformCanvas) {
            _recordingWaveformDrawTimer = null;
            return;
        }
        _recordingWaveformAnalyser.getByteTimeDomainData(_recordingWaveformDataArray);
        var canvas = recordingWaveformCanvas;
        var ctx = canvas.getContext('2d');
        var w = canvas.width;
        var h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        var bufferLength = _recordingWaveformDataArray.length;
        var sliceWidth = w / bufferLength;
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#4fc3f7';
        ctx.beginPath();
        var x = 0;
        for (var i = 0; i < bufferLength; i++) {
            var v = _recordingWaveformDataArray[i] / 128.0;
            var y = v * (h / 2);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
            x += sliceWidth;
        }
        ctx.stroke();
        _recordingWaveformDrawTimer = requestAnimationFrame(drawWaveform);
    }
    
    function startChatRecording() {
        if (!currentChannelId && !currentDmChannelId) return;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
            alert('Recording not supported in this browser.');
            return;
        }
        navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
            chatRecorderStream = stream;
            chatRecorderChunks = [];
            var mimeType = 'audio/webm;codecs=opus';
            if (!MediaRecorder.isTypeSupported(mimeType)) {
                mimeType = 'audio/webm';
                if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = '';
            }
            chatRecorder = new MediaRecorder(stream, mimeType ? { mimeType: mimeType } : {});
            chatRecorder.ondataavailable = function (e) {
                if (e.data && e.data.size > 0) chatRecorderChunks.push(e.data);
            };
            chatRecorder.onstop = function () {
                if (chatRecorderStream) { chatRecorderStream.getTracks().forEach(function(t) { t.stop(); }); chatRecorderStream = null; }
                var blob = new Blob(chatRecorderChunks, { type: 'audio/webm' });
                chatRecorderChunks = [];
                finishChatRecording(blob);
            };
            chatRecorder.onerror = function () {
                cleanupChatRecording();
                alert('Recording error.');
            };
            chatRecorder.start();
            chatRecordStartTime = Date.now();
            updateRecordingTimer();
            chatRecordTimer = setInterval(updateRecordingTimer, 200);
            // Setup waveform analyser
            try {
                var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                var source = audioCtx.createMediaStreamSource(stream);
                var analyser = audioCtx.createAnalyser();
                analyser.fftSize = 128;
                source.connect(analyser);
                _recordingWaveformCtx = audioCtx;
                _recordingWaveformAnalyser = analyser;
                _recordingWaveformDataArray = new Uint8Array(analyser.frequencyBinCount);
                drawWaveform();
            } catch (e) {
                // Waveform not critical
            }
            // Show bar with Send + Cancel buttons immediately
            showRecordingBar(true);
        }).catch(function () {
            alert('Microphone access denied.');
        });
    }
    
    // Click handler for record-audio
    if (attachPopup) {
        attachPopup.addEventListener('click', function (e) {
            var item = e.target.closest('.attach-popup-item[data-action="record-audio"]');
            if (!item) return;
            e.stopPropagation();
            closeAttachPopup();
            if (!currentChannelId && !currentDmChannelId) return;
            startChatRecording();
        });
    }
    
    // Wire recording bar buttons
    if (recordingSendBtn) {
        recordingSendBtn.addEventListener('click', function () {
            sendChatRecording();
        });
    }
    if (recordingCancelBtn) {
        recordingCancelBtn.addEventListener('click', function () {
            cancelChatRecording();
        });
    }

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
        // Download button for GIFs
        const gifDlBtn = e.target.closest('.gif-message .media-download-btn');
        if (gifDlBtn) {
            const url = gifDlBtn.getAttribute('data-url');
            const filename = gifDlBtn.getAttribute('data-filename') || 'sticker';
            if (url) {
                // Fetch the GIF and download as blob
                fetch(url)
                    .then(r => r.blob())
                    .then(blob => {
                        const blobUrl = URL.createObjectURL(blob);
                        downloadBlobAs(blobUrl, filename, blob.type || 'image/gif');
                        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
                    })
                    .catch(() => {
                        // Fallback: open in new tab
                        window.open(url, '_blank');
                    });
            }
        }
        // Sticker download buttons created by loadStickerPreview already have their own click handlers
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

    // ===== Click-off (backdrop) handlers for modals =====
    // Close any .modal when clicking the backdrop (the modal container itself, not .modal-content)
    function setupModalClickOff(modalId) {
        var modal = document.getElementById(modalId);
        if (!modal) return;
        modal.addEventListener('click', function (e) {
            if (e.target === modal) modal.style.display = 'none';
        });
    }
    // Apply to all relevant modals
    ['settings-modal', 'server-choice-modal', 'create-server-modal', 'join-server-modal',
     'add-friend-modal', 'server-settings-modal', 'friend-requests-modal',
     'sticker-upload-modal', 'profile-crop-modal', 'upload-modal',
     'friend-code-password-modal'].forEach(setupModalClickOff);
    // Global Escape key closes the topmost visible modal
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        // Find the first (topmost) visible modal and close it
        var modals = ['friend-code-password-modal', 'sticker-upload-modal', 'upload-modal',
                      'settings-modal', 'server-settings-modal', 'friend-requests-modal',
                      'add-friend-modal', 'join-server-modal', 'create-server-modal', 'server-choice-modal'];
        for (var i = 0; i < modals.length; i++) {
            var el = document.getElementById(modals[i]);
            if (el && el.style.display !== 'none' && el.style.display !== '') {
                el.style.display = 'none';
                break;
            }
        }
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

    // QR Scanner via Camera (with flip)
    var qrScannerStream = null;
    var qrScannerTimer = null;
    var _qrScannerFacing = 'environment';
    var _qrScannerInputEl = null;

    function openQrScanner(inputEl) {
        _qrScannerInputEl = inputEl;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { alert('Camera not supported.'); return; }
        var modal = document.getElementById('qr-scanner-modal');
        var video = document.getElementById('qr-scanner-video');
        if (!modal || !video) return;

        closeQrScanner();
        modal.style.display = 'flex';

        navigator.mediaDevices.getUserMedia({ video: { facingMode: _qrScannerFacing, width: { ideal: 640 }, height: { ideal: 640 } } }).then(function (stream) {
            qrScannerStream = stream;
            video.srcObject = stream;
            video.play().catch(function () { closeQrScanner(); alert('Camera could not start. Please try again.'); });

            var canvas = document.createElement('canvas');
            var ctx = canvas.getContext('2d');
            var scanned = false;
            var frameCount = 0;
            // Create BarcodeDetector once (if available) — wrap in try/catch
            var detector = null;
            try {
                if ('BarcodeDetector' in window) {
                    detector = new BarcodeDetector({ formats: ['qr_code'] });
                }
            } catch (e) {
                detector = null;
            }

            function scanFrame() {
                if (scanned || modal.style.display === 'none') return;
                // Bail early if no QR detection method is available
                if (typeof jsQR === 'undefined' && !detector) { closeQrScanner(); alert('QR scanning not supported in this browser.'); return; }
                if (video.readyState < 2) { qrScannerTimer = requestAnimationFrame(scanFrame); return; }
                // Throttle: only run scan every 5th frame (~12fps) to save CPU
                frameCount++;
                if (frameCount % 5 !== 0) { qrScannerTimer = requestAnimationFrame(scanFrame); return; }
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                ctx.drawImage(video, 0, 0);
                var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                var code = null;
                if (typeof jsQR !== 'undefined') {
                    code = jsQR(imageData.data, imageData.width, imageData.height);
                } else if (detector) {
                    detector.detect(canvas).then(function (barcodes) {
                        if (barcodes.length > 0 && !scanned) { scanned = true; closeQrScanner(); if (inputEl) inputEl.value = barcodes[0].rawValue; }
                    }).catch(function () {});
                    qrScannerTimer = requestAnimationFrame(scanFrame);
                    return;
                }
                if (code && !scanned) {
                    scanned = true;
                    closeQrScanner();
                    if (inputEl) { inputEl.type = 'password'; inputEl.value = code.data; }
                    return;
                }
                qrScannerTimer = requestAnimationFrame(scanFrame);
            }
            qrScannerTimer = requestAnimationFrame(scanFrame);
        }).catch(function () {
            alert('Camera access denied.');
            modal.style.display = 'none';
        });
    }

    function closeQrScanner() {
        if (qrScannerTimer) { cancelAnimationFrame(qrScannerTimer); qrScannerTimer = null; }
        if (qrScannerStream) { qrScannerStream.getTracks().forEach(function (t) { t.stop(); }); qrScannerStream = null; }
        var modal = document.getElementById('qr-scanner-modal');
        var video = document.getElementById('qr-scanner-video');
        if (video) video.srcObject = null;
        if (modal) modal.style.display = 'none';
    }

    // Wire scan buttons
    var friendScanBtn = document.getElementById('friend-scan-qr-btn');
    if (friendScanBtn) {
        friendScanBtn.addEventListener('click', function () {
            var input = document.getElementById('friend-code-input');
            if (input) openQrScanner(input);
        });
    }
    var joinScanBtn = document.getElementById('join-scan-qr-btn');
    if (joinScanBtn) {
        joinScanBtn.addEventListener('click', function () {
            var input = document.getElementById('invite-code-input');
            if (input) openQrScanner(input);
        });
    }
    var qrScannerClose = document.getElementById('qr-scanner-close');
    if (qrScannerClose) {
        qrScannerClose.addEventListener('click', closeQrScanner);
    }
    var qrScannerModal = document.getElementById('qr-scanner-modal');
    if (qrScannerModal) {
        qrScannerModal.addEventListener('click', function (e) {
            if (e.target === qrScannerModal) closeQrScanner();
        });
    }
    // QR scanner flip button
    var qrFlipBtn = document.getElementById('qr-scanner-flip');
    if (qrFlipBtn) {
        qrFlipBtn.addEventListener('click', function () {
            _qrScannerFacing = _qrScannerFacing === 'environment' ? 'user' : 'environment';
            if (_qrScannerInputEl) openQrScanner(_qrScannerInputEl);
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

// --- Notifications ---

function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

// In-memory cache for custom notification sound URL (avoids sync reads from IDB)
var _notifCachedUrl = null;

// Minimal IndexedDB helpers for storing notification sound (localStorage quota is ~5MB, not enough for audio)
function _idbNotifOpen() {
    return new Promise(function(resolve, reject) {
        var req = indexedDB.open('e2e_notif_sound', 1);
        req.onupgradeneeded = function(e) {
            var db = e.target.result;
            if (!db.objectStoreNames.contains('store')) db.createObjectStore('store');
        };
        req.onsuccess = function(e) { resolve(e.target.result); };
        req.onerror = function(e) { reject(e); };
    });
}

function _idbNotifPut(key, val) {
    return _idbNotifOpen().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx = db.transaction('store', 'readwrite');
            tx.objectStore('store').put(val, key);
            tx.oncomplete = function() { db.close(); resolve(); };
            tx.onerror = function(e) { db.close(); reject(e); };
        });
    });
}

function _idbNotifGet(key) {
    return _idbNotifOpen().then(function(db) {
        return new Promise(function(resolve, reject) {
            var req = db.transaction('store', 'readonly').objectStore('store').get(key);
            req.onsuccess = function(e) { db.close(); resolve(e.target.result); };
            req.onerror = function(e) { db.close(); reject(e); };
        });
    });
}

function _idbNotifDel(key) {
    return _idbNotifOpen().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx = db.transaction('store', 'readwrite');
            tx.objectStore('store').delete(key);
            tx.oncomplete = function() { db.close(); resolve(); };
            tx.onerror = function(e) { db.close(); reject(e); };
        });
    });
}

var _notifCtx = null;

function showNotifPlaying() {
    var stopBtn = document.getElementById('notif-sound-stop-btn');
    if (stopBtn) stopBtn.style.display = '';
    var testBtn = document.getElementById('notif-sound-test-btn');
    if (testBtn) testBtn.style.display = 'none';
    var dur = _notifCurrentDuration > 0 ? _notifCurrentDuration * 1000 : 1500;
    startNotifVisualizer(dur);
}

function stopNotificationSound() {
    if (_notifCurrentStop) {
        try { _notifCurrentStop(); } catch (e) {}
        _notifCurrentStop = null;
    }
    _notifCurrentDuration = 0;
    stopNotifVisualizer();
}

function stopNotifVisualizer() {
    if (_notifVisTimer) { clearTimeout(_notifVisTimer); _notifVisTimer = null; }
    if (_notifVisCtx) { try { _notifVisCtx.close(); } catch (e) {} _notifVisCtx = null; }
    var canvas = document.getElementById('notif-visualizer');
    if (canvas) canvas.style.display = 'none';
    var stopBtn = document.getElementById('notif-sound-stop-btn');
    if (stopBtn) stopBtn.style.display = 'none';
    var testBtn = document.getElementById('notif-sound-test-btn');
    if (testBtn) testBtn.style.display = '';
}

function playNotificationSound(force) {
    if (!force && localStorage.getItem('notif_background_only') === 'true' && !document.hidden) return;
    stopNotificationSound();
    var customSoundUrl = _notifCachedUrl || localStorage.getItem('notification_sound_url');
    if (customSoundUrl) {
        playDataUrlSound(customSoundUrl);
        return;
    }
    playDefaultChime();
}

function playDataUrlSound(dataUrl) {
    try {
        if (!_notifCtx) {
            _notifCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (_notifCtx.state === 'suspended') {
            _notifCtx.resume();
        }
        var blob = dataUrlToBlob(dataUrl);
        if (!blob) { playDefaultChime(); return; }
        var reader = new FileReader();
        reader.onload = function (e) {
            try {
                _notifCtx.decodeAudioData(e.target.result, function (buffer) {
                    try {
                        var source = _notifCtx.createBufferSource();
                        source.buffer = buffer;
                        var gain = _notifCtx.createGain();
                        gain.gain.value = getNotifVolume() * 0.5;
                        source.connect(gain);
                        gain.connect(_notifCtx.destination);
                        source.start(0);
                        _notifCurrentDuration = buffer.duration;
                        _notifCurrentStop = function () {
                            try { source.stop(); } catch (e) {}
                            try { source.disconnect(); } catch (e) {}
                            try { gain.disconnect(); } catch (e) {}
                        };
                        showNotifPlaying();
                    } catch (err) {
                        console.warn('Custom sound AudioContext play failed:', err);
                        playDefaultChime();
                    }
                }, function () {
                    console.warn('Custom sound decode failed, using default');
                    playDefaultChime();
                });
            } catch (err) {
                console.warn('Custom sound decode error:', err);
                playDefaultChime();
            }
        };
        reader.onerror = function () {
            console.warn('Custom sound blob read failed, using default');
            playDefaultChime();
        };
        reader.readAsArrayBuffer(blob);
    } catch (e) {
        console.warn('Custom sound error, using default:', e);
        playDefaultChime();
    }
}

function dataUrlToBlob(dataUrl) {
    try {
        var parts = dataUrl.split(',');
        var mimeMatch = parts[0].match(/:(.*?);/);
        if (!mimeMatch) return null;
        var mime = mimeMatch[1];
        var b64 = parts[1];
        var byteStr = atob(b64);
        var ab = new ArrayBuffer(byteStr.length);
        var ia = new Uint8Array(ab);
        for (var i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
        return new Blob([ab], { type: mime });
    } catch (e) {
        return null;
    }
}

function playDefaultChime() {
    try {
        if (!_notifCtx) {
            _notifCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (_notifCtx.state === 'suspended') {
            _notifCtx.resume();
        }
        var g = _notifCtx.createGain();
        g.connect(_notifCtx.destination);
        var vol = getNotifVolume();
        g.gain.setValueAtTime(0, _notifCtx.currentTime);
        g.gain.linearRampToValueAtTime(0.12 * vol, _notifCtx.currentTime + 0.03);
        g.gain.linearRampToValueAtTime(0.08 * vol, _notifCtx.currentTime + 0.3);
        g.gain.linearRampToValueAtTime(0, _notifCtx.currentTime + 0.6);
        var oscillators = [];
        [523, 392, 330].forEach(function (freq, i) {
            var o = _notifCtx.createOscillator();
            o.type = 'sine';
            o.frequency.value = freq;
            o.connect(g);
            var t = _notifCtx.currentTime + i * 0.18;
            o.start(t);
            o.stop(t + 0.25);
            oscillators.push(o);
        });
        _notifCurrentDuration = 0.8;
        var myStop = function () {
            try { g.gain.cancelScheduledValues(0); g.gain.setValueAtTime(0, _notifCtx.currentTime); } catch (e) {}
            oscillators.forEach(function (o) { try { o.stop(); o.disconnect(); } catch (e) {} });
            try { g.disconnect(); } catch (e) {}
        };
        _notifCurrentStop = myStop;
        showNotifPlaying();
        setTimeout(function () {
            if (_notifCurrentStop === myStop) {
                _notifCurrentStop = null;
                _notifCurrentDuration = 0;
            }
            try { g.disconnect(); } catch (e) {}
        }, 1000);
    } catch (e) {
        console.warn('Default chime playback failed:', e);
    }
}

// Waveform visualizer for notification sound test button.
// Uses AnalyserNode + probe oscillator so it works for both custom and default sounds.
var _notifVisTimer = null;
var _notifVisCtx = null;
var _notifCurrentStop = null;
var _notifCurrentDuration = 0;

// Recording state for notification sound
var _notifMediaRecorder = null;
var _notifMediaStream = null;
var _notifRecordChunks = [];
var _notifRecordTimer = null;
var _notifRecordStartTime = 0;

function getNotifVolume() {
    try {
        var v = parseInt(localStorage.getItem('notif_volume'), 10);
        if (isNaN(v)) return 0.5;
        return Math.max(0, Math.min(1, v / 100));
    } catch (e) { return 0.5; }
}

function startNotifVisualizer(durationMs) {
    var canvas = document.getElementById('notif-visualizer');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Clear any previous visualizer
    if (_notifVisTimer) { clearTimeout(_notifVisTimer); _notifVisTimer = null; }
    if (_notifVisCtx) { try { _notifVisCtx.close(); } catch (e) {} _notifVisCtx = null; }

    canvas.style.display = '';
    canvas.width = canvas.offsetWidth || 280;
    canvas.height = canvas.offsetHeight || 50;

    var duration = durationMs || 1500;

    // Create a probe oscillator to feed the analyser (no connection to destination = silent)
    var audioCtx;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        _notifVisCtx = audioCtx;
    } catch (e) { canvas.style.display = 'none'; return; }
    var analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;
    var bufferLength = analyser.frequencyBinCount;
    var dataArray = new Uint8Array(bufferLength);

    // Sweep through frequencies for a nicer visual
    var osc = audioCtx.createOscillator();
    osc.type = 'sawtooth';  // rich harmonics fill more bars
    osc.frequency.setValueAtTime(200, audioCtx.currentTime);
    osc.frequency.linearRampToValueAtTime(3000, audioCtx.currentTime + duration / 1000);
    osc.connect(analyser);
    // DO NOT connect to destination — no audible output
    osc.start();
    osc.stop(audioCtx.currentTime + duration / 1000 + 0.1);

    var startTime = Date.now();

    function draw() {
        var elapsed = Date.now() - startTime;
        if (elapsed > duration) {
            audioCtx.close();
            canvas.style.display = 'none';
            _notifVisTimer = null;
            return;
        }
        _notifVisTimer = setTimeout(draw, 50);

        analyser.getByteFrequencyData(dataArray);

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        var barWidth = Math.max(2, (canvas.width / bufferLength) - 2);
        var gap = 2;
        var fade = Math.min(1, elapsed / 200); // fade in over 200ms

        for (var i = 0; i < bufferLength; i++) {
            var pct = dataArray[i] / 255;
            var barHeight = Math.max(1, pct * canvas.height * fade);
            var hue = 140 + (1 - pct) * 120; // green → red spectrum
            ctx.fillStyle = 'hsla(' + hue + ', 80%, 55%, 0.85)';
            ctx.fillRect(i * (barWidth + gap), canvas.height - barHeight, barWidth, barHeight);
        }
    }
    draw();
}

function showBrowserNotification(title, body, onClick) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
        var notif = new Notification(title, { body, icon: '/favicon.ico' });
        if (onClick) {
            var cb = onClick;
            notif.onclick = function () {
                window.focus();
                cb();
                this.close();
            };
        }
        setTimeout(function () { notif.close(); }, 10000);
    } catch (e) {
        console.warn('Notification failed:', e);
    }
}

// --- Unread mention tracking + badge rendering ---

function trackUnreadMention(serverId, channelId, dmChannelId, messageId, senderUsername, channelName, serverName, notifType, senderId, senderProfilePic) {
    // Skip notification if the server or channel is muted
    if (isMuted(serverId, channelId)) return;
    // Skip notification if the sender's DM is muted (cross-mute)
    if (senderId && isUserMuted(senderId)) return;
    if (channelId && serverId) {
        // Server channel mention/reply
        if (channelId === currentChannelId && serverId === currentServerId) return;
        unreadMentionsByServer[serverId] = (unreadMentionsByServer[serverId] || 0) + 1;
        if (!unreadMentionsByChannel[channelId]) unreadMentionsByChannel[channelId] = { count: 0, message_id: messageId };
        unreadMentionsByChannel[channelId].count++;
        unreadMentionsByChannel[channelId].message_id = messageId;
        // Push to chronological inbox
        mentionItems.unshift({
            id: messageId + '_' + Date.now(),
            serverId: serverId,
            channelId: channelId,
            dmChannelId: null,
            messageId: messageId,
            senderUsername: senderUsername || 'Someone',
            senderId: senderId || null,
            senderProfilePic: senderProfilePic || null,
            channelName: channelName || 'a channel',
            serverName: serverName || '',
            type: notifType || 'mention',
            time: Date.now()
        });
        updateServerBadges();
        updateChannelBadges();
        updateMentionsBadge();
        saveMentionState();
    } else if (dmChannelId) {
        unreadDms[dmChannelId] = (unreadDms[dmChannelId] || 0) + 1;
        updateDmStripBadge();
        updateMentionsBadge();
        if (viewMode === 'dms') renderDmSidebar();
        saveMentionState();
    }
}

function clearUnreadChannelMentions(channelId) {
    var info = unreadMentionsByChannel[channelId];
    if (info) {
        var serverId = currentServerId;
        if (serverId && unreadMentionsByServer[serverId]) {
            unreadMentionsByServer[serverId] = Math.max(0, unreadMentionsByServer[serverId] - info.count);
            if (unreadMentionsByServer[serverId] <= 0) delete unreadMentionsByServer[serverId];
        }
        delete unreadMentionsByChannel[channelId];
        // Remove inbox items for this channel
        mentionItems = mentionItems.filter(function (item) {
            return !(item.channelId === channelId && item.serverId === serverId);
        });
        updateServerBadges();
        updateChannelBadges();
        updateMentionsBadge();
        saveMentionState();
        // Re-render inbox if it's open
        var mentionsPanel = document.getElementById('mentions-panel');
        if (mentionsPanel && mentionsPanel.style.display === 'flex') renderMentionsInbox();
    }
}

function clearUnreadDmMentions(dmChannelId) {
    if (dmChannelId && unreadDms[dmChannelId]) {
        delete unreadDms[dmChannelId];
        // Remove inbox items for this DM
        mentionItems = mentionItems.filter(function (item) {
            return item.dmChannelId !== dmChannelId;
        });
        updateDmStripBadge();
        updateMentionsBadge();
        if (viewMode === 'dms') renderDmSidebar();
        saveMentionState();
        // Re-render inbox if it's open
        var mentionsPanel = document.getElementById('mentions-panel');
        if (mentionsPanel && mentionsPanel.style.display === 'flex') renderMentionsInbox();
    }
}

// --- Notification Sound Server Sync ---
// Encrypt the sound file with the user's identity key and upload to the server
// so it syncs across devices.

async function syncNotificationSoundToServer(file) {
    try {
        var arrayBuffer = await file.arrayBuffer();
        var soundBytes = new Uint8Array(arrayBuffer);
        var identity = E2ECrypto.getIdentityKeyPair();
        if (!identity) {
            var statusEl = document.getElementById('notif-sound-status');
            if (statusEl) { statusEl.textContent = 'Encryption keys not ready, sound not synced to server'; statusEl.style.color = '#f44336'; }
            return;
        }
        var encrypted = E2ECrypto.envelopeEncryptRaw(soundBytes, identity.publicKey);
        var uploadRes = await authFetch('/api/notification-sound', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                encrypted_sound: encrypted.ciphertext,
                nonce: encrypted.nonce,
                sender_public_key: encrypted.ephemeralPublicKey,
                file_name: file.name || 'notification.mp3',
            }),
        });
        if (!uploadRes.ok) {
            var statusEl = document.getElementById('notif-sound-status');
            if (statusEl) { statusEl.textContent = 'Server sync failed, sound may not persist across refresh'; statusEl.style.color = '#f44336'; }
        }
    } catch (e) {
        console.warn('Failed to sync notification sound:', e);
    }
}

async function restoreNotificationSoundFromServer() {
    try {
        var res = await authFetch('/api/notification-sound');
        if (!res.ok) return;
        var data = await res.json();
        if (!data.encrypted_sound || !data.nonce || !data.sender_public_key) return;
        var identity = E2ECrypto.getIdentityKeyPair();
        if (!identity) return;
        var decryptedBytes = E2ECrypto.envelopeDecryptRaw(
            data.encrypted_sound,
            data.nonce,
            data.sender_public_key,
            identity.privateKey
        );
        if (!decryptedBytes || decryptedBytes.length === 0) return;
        var blob = new Blob([decryptedBytes]);
        return new Promise(function (resolve) {
            var reader = new FileReader();
            reader.onload = function (ev) {
                var dataUrl = ev.target.result;
                _notifCachedUrl = dataUrl;
                _idbNotifPut('url', dataUrl).catch(function () {});
                if (data.file_name) {
                    try { localStorage.setItem('notification_sound_name', data.file_name); } catch (e) {}
                    _idbNotifPut('name', data.file_name).catch(function () {});
                }
                try { localStorage.removeItem('notification_sound_url'); } catch (e) {}
                var fileNameEl = document.getElementById('notif-sound-file-name');
                if (fileNameEl && data.file_name) {
                    fileNameEl.textContent = data.file_name;
                    fileNameEl.style.display = '';
                }
                resolve();
            };
            reader.onerror = function () { resolve(); };
            reader.readAsDataURL(blob);
        });
    } catch (e) {
        console.warn('Failed to restore notification sound from server:', e);
    }
}

function saveMentionState() {
    try {
        localStorage.setItem('mention_unread_server', JSON.stringify(unreadMentionsByServer));
        localStorage.setItem('mention_unread_channel', JSON.stringify(unreadMentionsByChannel));
        localStorage.setItem('mention_unread_dms', JSON.stringify(unreadDms));
        localStorage.setItem('mention_items', JSON.stringify(mentionItems.slice(0, 200)));
    } catch (e) {
        // localStorage full or unavailable — silently ignore
    }
}

function restoreMentionState() {
    try {
        var s = localStorage.getItem('mention_unread_server');
        if (s) {
            var parsed = JSON.parse(s);
            // Only keep entries for servers the user is still a member of
            var serverIds = servers.map(function (sv) { return sv.id; });
            unreadMentionsByServer = {};
            for (var k in parsed) {
                if (parsed.hasOwnProperty(k) && serverIds.indexOf(k) !== -1) {
                    unreadMentionsByServer[k] = parsed[k];
                }
            }
        }
        var c = localStorage.getItem('mention_unread_channel');
        if (c) {
            unreadMentionsByChannel = JSON.parse(c);
        }
        var d = localStorage.getItem('mention_unread_dms');
        if (d) {
            unreadDms = JSON.parse(d);
        }
        var mi = localStorage.getItem('mention_items');
        if (mi) {
            var parsed = JSON.parse(mi);
            if (Array.isArray(parsed)) mentionItems = parsed;
        }
    } catch (e) {
        // Corrupted data — reset
        unreadMentionsByServer = {};
        unreadMentionsByChannel = {};
        unreadDms = {};
        mentionItems = [];
    }
}

function updateMentionsBadge() {
    var badge = document.getElementById('mentions-strip-badge');
    if (!badge) return;
    var total = 0;
    for (var sid in unreadMentionsByServer) {
        if (unreadMentionsByServer.hasOwnProperty(sid)) total += unreadMentionsByServer[sid];
    }
    badge.style.display = total > 0 ? '' : 'none';
}

function clearAllMentionItems() {
    mentionItems = [];
    unreadMentionsByServer = {};
    unreadMentionsByChannel = {};
    unreadDms = {};
    updateServerBadges();
    updateChannelBadges();
    updateDmStripBadge();
    updateMentionsBadge();
    saveMentionState();
    renderMentionsInbox();
    closeMentionsInbox();
}

function openMentionsInbox() {
    var panel = document.getElementById('mentions-panel');
    if (panel) panel.style.display = 'flex';
    var btn = document.getElementById('mentions-strip-btn');
    if (btn) btn.classList.add('active');
    renderMentionsInbox();
}

function closeMentionsInbox() {
    var panel = document.getElementById('mentions-panel');
    if (panel) panel.style.display = 'none';
    var btn = document.getElementById('mentions-strip-btn');
    if (btn) btn.classList.remove('active');
}

function renderMentionsInbox() {
    var list = document.getElementById('mentions-inbox-list');
    if (!list) return;
    if (mentionItems.length === 0) {
        list.innerHTML = '<div style="color:#888;text-align:center;padding:40px 20px;font-size:14px;">No unread notifications</div>';
        return;
    }
    var html = '';
    for (var i = 0; i < mentionItems.length; i++) {
        var item = mentionItems[i];
        var icon = '';
        var iconClass = 'mention-inbox-icon';
        if (item.type === 'mention') { icon = '@'; iconClass += ' mention'; }
        else if (item.type === 'reply') { icon = '↩'; iconClass += ' reply'; }
        else { icon = '💬'; iconClass += ' dm'; }
        var title = item.senderUsername;
        var senderAvatar = '';
        if (item.senderId && item.senderProfilePic) {
            var picCacheKey = item.senderId + ':' + item.senderProfilePic;
            if (profilePicCache[picCacheKey]) {
                senderAvatar = '<img src="' + profilePicCache[picCacheKey] + '" style="width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0;">';
            } else {
                senderAvatar = '<div data-profile-pic-load="' + picCacheKey + '" style="width:36px;height:36px;border-radius:50%;background:var(--accent);color:var(--bg-primary);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0;overflow:hidden;">' + (item.senderUsername || '?').charAt(0).toUpperCase() + '</div>';
                getProfilePicUrl(item.senderProfilePic, item.senderId);
            }
        }
        var subtitle = '';
        if (item.serverName && item.channelName) {
            subtitle = item.serverName + ' #' + item.channelName;
        } else if (item.channelName) {
            subtitle = '#' + item.channelName;
        } else if (item.dmChannelId) {
            subtitle = 'Direct message';
        }
        var timeStr = '';
        try {
            var d = new Date(item.time);
            var now = new Date();
            var diffMs = now - d;
            var diffMin = Math.floor(diffMs / 60000);
            if (diffMin < 1) timeStr = 'now';
            else if (diffMin < 60) timeStr = diffMin + 'm';
            else if (diffMin < 1440) timeStr = Math.floor(diffMin / 60) + 'h';
            else timeStr = Math.floor(diffMin / 1440) + 'd';
        } catch (_) { timeStr = ''; }
        html += '<div class="mention-inbox-item" data-server-id="' + (item.serverId || '') + '" data-channel-id="' + (item.channelId || '') + '" data-dm-channel-id="' + (item.dmChannelId || '') + '" data-message-id="' + item.messageId + '">' +
            (senderAvatar || '<div class="' + iconClass + '">' + icon + '</div>') +
            '<div class="mention-inbox-body">' +
                '<div class="mention-inbox-title">' + escapeHtml(title) + '</div>' +
                '<div class="mention-inbox-subtitle">' + (item.type === 'dm' ? 'Sent you a message' : item.type === 'reply' ? 'Replied to you in ' : 'Mentioned you in ') + (item.type === 'dm' ? '' : escapeHtml(subtitle)) + '</div>' +
            '</div>' +
            '<div class="mention-inbox-time">' + timeStr + '</div>' +
        '</div>';
    }
    list.innerHTML = html;
}

function setupMentionsInboxEvents() {
    var list = document.getElementById('mentions-inbox-list');
    if (list) {
        list.addEventListener('click', function (e) {
            var itemEl = e.target.closest('.mention-inbox-item');
            if (!itemEl) return;
            var serverId = itemEl.dataset.serverId || null;
            var channelId = itemEl.dataset.channelId || null;
            var dmChannelId = itemEl.dataset.dmChannelId || null;
            var messageId = itemEl.dataset.messageId;
            closeMentionsInbox();
            if (messageId) navigateToMessage(serverId, channelId, dmChannelId, messageId);
        });
    }
    var closeBtn = document.getElementById('close-mentions-inbox');
    if (closeBtn) closeBtn.addEventListener('click', closeMentionsInbox);
    var clearBtn = document.getElementById('clear-mentions-inbox');
    if (clearBtn) clearBtn.addEventListener('click', clearAllMentionItems);
}

// Called after DOMContentLoaded init to restore mention state and render
function initMentionsInbox() {
    var btn = document.getElementById('mentions-strip-btn');
    if (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            openMentionsInbox();
        });
    }
    setupMentionsInboxEvents();
    updateMentionsBadge();
    // Close mentions inbox when clicking outside the modal content
    var panel = document.getElementById('mentions-panel');
    if (panel) {
        panel.addEventListener('click', function (e) {
            if (e.target === panel) closeMentionsInbox();
        });
    }
}

function updateServerBadges() {
    document.querySelectorAll('.server-icon').forEach(function (el) {
        var sid = el.dataset.id;
        var count = unreadMentionsByServer[sid] || 0;
        var existing = el.querySelector('.mention-badge');
        if (count > 0) {
            if (!existing) {
                var badge = document.createElement('span');
                badge.className = 'mention-badge';
                el.appendChild(badge);
            }
        } else {
            if (existing) existing.remove();
        }
    });
}

function updateChannelBadges() {
    document.querySelectorAll('.channel-item').forEach(function (el) {
        var cid = el.dataset.id;
        var info = unreadMentionsByChannel[cid];
        var existing = el.querySelector('.mention-badge');
        if (info && info.count > 0) {
            if (!existing) {
                var badge = document.createElement('span');
                badge.className = 'mention-badge';
                el.appendChild(badge);
            }
        } else {
            if (existing) existing.remove();
        }
    });
}

// --- Channel Context Menu (Right-click to mute) ---

function showDmContextMenu(e, dmChannelId, otherUsername) {
    // Remove any existing context menu
    var existing = document.querySelector('.channel-context-menu');
    if (existing) existing.remove();

    var isMutedDm = mutedDms.indexOf(dmChannelId) !== -1;

    var menu = document.createElement('div');
    menu.className = 'channel-context-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';

    // DM mute toggle
    var muteItem = document.createElement('div');
    muteItem.className = 'context-menu-item';
    muteItem.textContent = isMutedDm ? '🔇 Unmute DM with ' + otherUsername : '🔇 Mute DM with ' + otherUsername;
    muteItem.addEventListener('click', function () {
        toggleMuteDm(dmChannelId);
        menu.remove();
    });
    menu.appendChild(muteItem);

    document.body.appendChild(menu);

    // Close on click outside
    function closeMenu(e2) {
        if (!menu.contains(e2.target)) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        }
    }
    setTimeout(function () { document.addEventListener('click', closeMenu); }, 0);
}

function showChannelContextMenu(e, channelId, channelName) {
    // Remove any existing context menu
    var existing = document.querySelector('.channel-context-menu');
    if (existing) existing.remove();

    var isMutedChannel = mutedChannels.indexOf(channelId) !== -1;
    var isMutedSrv = currentServerId ? mutedServers.indexOf(currentServerId) !== -1 : false;

    var menu = document.createElement('div');
    menu.className = 'channel-context-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';

    // Channel mute toggle
    var chItem = document.createElement('div');
    chItem.className = 'context-menu-item';
    chItem.textContent = isMutedChannel ? 'Unmute #' + channelName : 'Mute #' + channelName;
    chItem.addEventListener('click', function () {
        toggleMuteChannel(channelId, currentServerId);
        menu.remove();
    });
    menu.appendChild(chItem);

    // Server mute toggle
    if (currentServerId) {
        var sv = servers.find(function (s) { return s.id === currentServerId; });
        if (sv) {
            var svItem = document.createElement('div');
            svItem.className = 'context-menu-item';
            svItem.textContent = isMutedSrv ? 'Unmute ' + sv.name : 'Mute ' + sv.name;
            svItem.addEventListener('click', function () {
                toggleMuteServer(currentServerId);
                menu.remove();
            });
            menu.appendChild(svItem);
        }
    }

    document.body.appendChild(menu);

    // Close on click outside
    function closeMenu(e2) {
        if (!menu.contains(e2.target)) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        }
    }
    setTimeout(function () { document.addEventListener('click', closeMenu); }, 0);
}

// --- Server Context Menu (Right-click to leave/mute) ---

function showServerContextMenu(e, serverId, serverName) {
    // Remove any existing context menu
    var existing = document.querySelector('.channel-context-menu');
    if (existing) existing.remove();

    var sv = servers.find(function (s) { return s.id === serverId; });
    var isOwnerOfServer = sv && sv.is_owner === true;
    var isMutedSrv = mutedServers.indexOf(serverId) !== -1;

    var menu = document.createElement('div');
    menu.className = 'channel-context-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';

    // Leave/Delete Server
    var leaveItem = document.createElement('div');
    leaveItem.className = 'context-menu-item context-menu-danger';
    leaveItem.textContent = isOwnerOfServer ? 'Delete ' + serverName : 'Leave ' + serverName;
    leaveItem.addEventListener('click', async function () {
        menu.remove();
        var msg = isOwnerOfServer
            ? 'Delete this server permanently? All channels, messages, and members will be removed. This cannot be undone.'
            : 'Leave this server? You will lose access to all channels and messages.';
        if (!confirm(msg)) return;
        try {
            var res = await authFetch('/api/servers/' + serverId + '/leave', { method: 'POST' });
            var data = await res.json();
            if (res.ok) {
                // If this was the current server, reset the UI
                if (serverId === currentServerId) {
                    currentServerId = null;
                    currentChannelId = null;
                    document.getElementById('server-name').textContent = '';
                    document.getElementById('channel-list').innerHTML = '<div class="channel-item" style="color:#666;cursor:default">Select a server</div>';
                    document.getElementById('channel-name').textContent = 'Select a channel';
                    document.getElementById('message-list').innerHTML = '<div class="welcome">' +
                        (data.server_deleted ? 'Server has been deleted' : 'Select a server and channel to start chatting') + '</div>';
                    document.getElementById('message-input').disabled = true;
                    document.getElementById('send-btn').disabled = true;
                }
                await loadServers();
            } else {
                alert(data.error || 'Failed to leave server');
            }
        } catch (err) {
            console.error('Leave server failed:', err);
        }
    });
    menu.appendChild(leaveItem);

    // Mute/Unmute Server
    var muteItem = document.createElement('div');
    muteItem.className = 'context-menu-item';
    muteItem.textContent = isMutedSrv ? 'Unmute ' + serverName : 'Mute ' + serverName;
    muteItem.addEventListener('click', function () {
        toggleMuteServer(serverId);
        menu.remove();
    });
    menu.appendChild(muteItem);

    document.body.appendChild(menu);

    // Close on click outside
    function closeMenu(e2) {
        if (!menu.contains(e2.target)) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        }
    }
    setTimeout(function () { document.addEventListener('click', closeMenu); }, 0);
}

// --- Mention Toast + Server Icon Flash ---

var _mentionToastTimer = null;

function showMentionToast(username, serverId, channelId, messageId) {
    var toast = document.getElementById('mention-toast');
    if (!toast) return;
    // Clear any previous auto-hide timeout to avoid race conditions
    if (_mentionToastTimer) clearTimeout(_mentionToastTimer);
    toast.textContent = 'New mention from @' + (username || 'Someone');
    toast.style.display = '';
    toast.style.animation = 'mentionToastSlideIn 0.25s ease-out';
    toast.onclick = function () {
        navigateToMessage(serverId, channelId, null, messageId);
    };
    // Auto-hide after 5 seconds
    _mentionToastTimer = setTimeout(function () {
        toast.style.animation = 'mentionToastFadeOut 0.3s ease-out';
        setTimeout(function () { toast.style.display = 'none'; }, 300);
    }, 5000);
}

function flashServerIcon(serverId) {
    var icon = document.querySelector('.server-icon[data-id="' + serverId + '"]');
    if (!icon) return;
    icon.classList.remove('flash');
    // Force reflow to restart animation
    void icon.offsetWidth;
    icon.classList.add('flash');
    // Remove class after animation completes
    setTimeout(function () { icon.classList.remove('flash'); }, 700);
}

async function navigateToMessage(serverId, channelId, dmChannelId, messageId) {
    window.focus();
    if (dmChannelId) {
        enterDmView();
        await loadDmConversations();
        var conv = dmConversations.find(function (c) { return c.dm_channel_id === dmChannelId; });
        if (conv) {
            currentDmChannelId = dmChannelId;
            currentDmOtherUser = { id: conv.other_user_id, username: conv.other_username, display_name: conv.other_display_name };
            currentChannelId = null;
            currentServerId = null;
            document.querySelectorAll('.channel-item').forEach(function (el) { el.classList.remove('active'); });
            var dmEl = document.querySelector('.dm-item[data-dm-id="' + dmChannelId + '"]');
            if (dmEl) dmEl.classList.add('active');
            var dmPicUrl = conv.other_profile_picture_file_id ? getProfilePicUrl(conv.other_profile_picture_file_id, conv.other_user_id) : null;
            var dmChatHeaderPicHtml = dmPicUrl ? '<img class="dm-chat-header-pic" src="' + dmPicUrl + '" alt="">' : (conv.other_profile_picture_file_id ? '<div class="dm-chat-header-pic dm-chat-header-pic-load" data-profile-pic-load="' + conv.other_user_id + ':' + conv.other_profile_picture_file_id + '">' + (conv.other_display_name || conv.other_username || '?').charAt(0).toUpperCase() + '</div>' : '');
            document.getElementById('channel-name').innerHTML = dmChatHeaderPicHtml + '<span>' + escapeHtml(conv.other_display_name || conv.other_username) + '</span><button class="btn-unfriend" id="unfriend-btn" title="Unfriend">Unfriend</button>';
            document.getElementById('message-input').disabled = false;
            document.getElementById('send-btn').disabled = false;
            clearUnreadDmMentions(dmChannelId);
            await loadDmMessages(dmChannelId, conv.other_user_id);
            var newDmEl = document.querySelector('.dm-item[data-dm-id="' + dmChannelId + '"]');
            if (newDmEl) newDmEl.classList.add('active');
        }
        setTimeout(function () {
            var msgEl = document.querySelector('[data-message-id="' + messageId + '"]');
            if (msgEl) { msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); msgEl.classList.add('flash-highlight'); setTimeout(function () { msgEl.classList.remove('flash-highlight'); }, 1500); }
        }, 1200);
    } else if (serverId && channelId) {
        if (serverId !== currentServerId) {
            await selectServer(serverId);
        }
        clearUnreadChannelMentions(channelId);
        var chEl = document.querySelector('.channel-item[data-id="' + channelId + '"]');
        if (chEl) {
            chEl.click();
            setTimeout(function () {
                var msgEl = document.querySelector('[data-message-id="' + messageId + '"]');
                if (msgEl) { msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); msgEl.classList.add('flash-highlight'); setTimeout(function () { msgEl.classList.remove('flash-highlight'); }, 1500); }
            }, 500);
        }
    }
}

// --- Mention Support ---

function findMentionsInText(text, memberList) {
    if (!text || !memberList || memberList.length === 0) return [];
    const ids = [];
    const userId = user ? user.id : null;
    for (const m of memberList) {
        if (m.username && m.id && m.id !== userId && text.indexOf('@' + m.username) !== -1) {
            ids.push(m.id);
        }
    }
    return ids;
}

function highlightMentionsInHtml(html) {
    if (!html) return html;
    const currentUsername = user ? user.username : null;
    if (!currentUsername) return html;
    return html.replace(/@([\w]+)/g, (match, username) => {
        return '<span class="mention">' + match + '</span>';
    });
}

function setupMentionAutocomplete() {
    const input = document.getElementById('message-input');
    const container = document.createElement('div');
    container.className = 'mention-dropdown';
    container.style.display = 'none';
    input.parentNode.appendChild(container);

    let activeIndex = -1;
    let filterText = '';
    let isOpen = false;

    function getCandidateList() {
        if (viewMode === 'dms' && currentDmOtherUser) {
            return [{ username: currentDmOtherUser.username, id: currentDmOtherUser.id }];
        }
        return currentServerMemberList.filter(m => m.id !== (user ? user.id : null));
    }

    function updateDropdown() {
        const candidates = getCandidateList();
        const filtered = candidates.filter(m =>
            (m.username && m.username.toLowerCase().startsWith(filterText.toLowerCase())) ||
            (m.display_name && m.display_name.toLowerCase().startsWith(filterText.toLowerCase()))
        );
        if (filtered.length === 0 || !isOpen) {
            container.style.display = 'none';
            return;
        }
        container.style.display = 'block';
        container.innerHTML = '';
        filtered.forEach((m, idx) => {
            const item = document.createElement('div');
            item.className = 'mention-item' + (idx === activeIndex ? ' active' : '');
            const initial = (m.username || '?').charAt(0).toUpperCase();
            var mInitial = (m.username || '?').charAt(0).toUpperCase();
            var mPicUrl = m.profile_picture_file_id ? getProfilePicUrl(m.profile_picture_file_id, m.id) : null;
            item.dataset.username = m.username;
            var mAvatarHtml = mPicUrl ? '<img class="mention-item-avatar" src="' + mPicUrl + '" alt="">' : '<span class="mention-item-avatar">' + mInitial + '</span>';
            item.innerHTML = mAvatarHtml + '<span class="mention-item-name">' + escapeHtml(m.display_name || m.username) + '</span>';
            item.addEventListener('click', () => selectMention(m.username));
            item.addEventListener('mouseenter', () => { activeIndex = idx; highlightItem(); });
            container.appendChild(item);
        });
        highlightItem();
    }

    function highlightItem() {
        const items = container.querySelectorAll('.mention-item');
        items.forEach((el, idx) => el.classList.toggle('active', idx === activeIndex));
    }

    function selectMention(username) {
        const cursorPos = input.selectionStart;
        const text = input.value;
        const lastAtIndex = text.lastIndexOf('@', cursorPos - 1);
        if (lastAtIndex === -1) return;
        const before = text.substring(0, lastAtIndex);
        const after = text.substring(cursorPos);
        input.value = before + '@' + username + ' ' + after;
        const newPos = before.length + username.length + 2;
        input.setSelectionRange(newPos, newPos);
        container.style.display = 'none';
        isOpen = false;
        input.focus();
    }

    input.addEventListener('input', () => {
        const cursorPos = input.selectionStart;
        const text = input.value;
        const lastAtIndex = text.lastIndexOf('@', cursorPos - 1);
        if (lastAtIndex === -1 || (lastAtIndex > 0 && text[lastAtIndex - 1].match(/[a-zA-Z0-9_]/))) {
            container.style.display = 'none';
            isOpen = false;
            return;
        }
        const afterAt = text.substring(lastAtIndex + 1, cursorPos);
        if (afterAt.indexOf(' ') !== -1 || afterAt.indexOf('@') !== -1) {
            container.style.display = 'none';
            isOpen = false;
            return;
        }
        isOpen = true;
        filterText = afterAt;
        activeIndex = 0;
        updateDropdown();
    });

    input.addEventListener('keydown', (e) => {
        if (!isOpen || container.style.display === 'none') return;
        const items = container.querySelectorAll('.mention-item');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            activeIndex = Math.min(activeIndex + 1, items.length - 1);
            highlightItem();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            activeIndex = Math.max(activeIndex - 1, 0);
            highlightItem();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            if (activeIndex >= 0 && activeIndex < items.length) {
                e.preventDefault();
                const username = items[activeIndex].dataset.username || items[activeIndex].querySelector('.mention-item-name')?.textContent;
                if (username) selectMention(username);
            }
        } else if (e.key === 'Escape') {
            container.style.display = 'none';
            isOpen = false;
        }
    });

    input.addEventListener('blur', () => {
        setTimeout(() => { container.style.display = 'none'; isOpen = false; }, 200);
    });
}

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
                if (data.channel_id && data.message) {
                    if (data.channel_id === currentChannelId) {
                        await appendMessage(data.message);
                        // Check if the newly appended message mentions the current user
                        var msgList = document.getElementById('message-list');
                        var lastMsg = msgList ? msgList.lastElementChild : null;
                        if (lastMsg && lastMsg.classList.contains('mentioned')) {
                            // Skip toast/flash if the sender's DM is muted (cross-mute)
                            if (!isUserMuted(data.message.sender_id)) {
                                showMentionToast(data.message.sender_username, data.server_id, data.channel_id, data.message.id);
                                if (data.server_id) flashServerIcon(data.server_id);
                            }
                        }
                    } else if (data.server_id && data.message.encrypted_content) {
                        // Mention/reply notifications for other channels are handled by the
                        // server-sent 'mention_notification' and 'reply_notification' events.
                    }
                }
                break;
            case 'dm_new':
                if (data.dm_channel_id && data.message) {
                    if (data.dm_channel_id === currentDmChannelId) {
                        // Clear any unread badge when viewing the DM
                        clearUnreadDmMentions(data.dm_channel_id);
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
                        // Message is for a different DM channel
                        // Don't notify self (e.g. when forwarding a message to own DM)
                        var isOwnMessage = data.message && data.message.sender_id === user.id;
                        if (!isDmMuted(data.dm_channel_id) && !isOwnMessage) {
                            // Only track unread + notify if not muted and not own message
                            unreadDms[data.dm_channel_id] = (unreadDms[data.dm_channel_id] || 0) + 1;
                            updateDmStripBadge();
                            updateMentionsBadge();
                            saveMentionState();
                            showBrowserNotification('New DM', data.message.sender_username + ' sent you a message');
                            playNotificationSound();
                        }
                        if (viewMode === 'dms') renderDmSidebar();
                    }
                    if (viewMode === 'dms') loadDmConversations();
                }
                break;
            case 'message_edited':
                if (data.channel_id === currentChannelId && data.message) {
                    await handleEditedMessage(data.message, 'channel');
                }
                break;
            case 'message_deleted':
                if (data.channel_id === currentChannelId && data.message_id) {
                    handleDeletedMessage(data.message_id);
                }
                break;
            case 'dm_edited':
                if (data.dm_channel_id === currentDmChannelId && data.message) {
                    await handleEditedMessage(data.message, 'dm');
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
                    // Owner auto-uploads encrypted server key for new member.
                    // Check ownership from the servers list (not the isOwner global,
                    // which only reflects the currently selected server)
                    const ownedByMe = servers.some(s => s.id === data.server_id && s.is_owner);
                    if (ownedByMe) {
                        await uploadServerKeyForUser(data.server_id, data.user_id);
                    }
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
                    if (data.user_id === user.id) {
                        // This user was kicked/banned/left — remove the server from their sidebar
                        if (data.server_id === currentServerId) {
                            // Currently viewing this server — clear the view
                            currentServerId = null;
                            currentChannelId = null;
                            document.getElementById('server-name').textContent = '';
                            document.getElementById('channel-list').innerHTML = '<div class="channel-item" style="color:#666;cursor:default">Select a server</div>';
                            document.getElementById('channel-name').textContent = 'Select a channel';
                            document.getElementById('message-list').innerHTML = '<div class="welcome">Select a server and channel to start chatting</div>';
                            document.getElementById('message-input').disabled = true;
                            document.getElementById('send-btn').disabled = true;
                        }
                        // Always reload server list so the server icon disappears from the sidebar
                        await loadServers();
                    }
                }
                break;
            case 'user_deleted':
                if (data.user_id) {
                    var deletedUserId = data.user_id;
                    // Remove all messages from this user in the current channel
                    document.querySelectorAll('.message[data-sender-id="' + deletedUserId + '"]').forEach(function(el) {
                        el.remove();
                    });
                    // Remove DM conversations with this user from memory
                    dmConversations = dmConversations.filter(function(c) {
                        return c.other_user_id !== deletedUserId;
                    });
                    // If currently viewing a DM with the deleted user, clear the view
                    if (viewMode === 'dms' && currentDmOtherUser && currentDmOtherUser.id === deletedUserId) {
                        currentDmChannelId = null;
                        currentDmOtherUser = null;
                        document.getElementById('message-list').innerHTML = '<div class="welcome">This user has deleted their account</div>';
                        document.getElementById('message-input').disabled = true;
                        document.getElementById('send-btn').disabled = true;
                        document.getElementById('dm-chat-header-name').textContent = '';
                    }
                    // Also check by dmChannelId: if the current DM channel no longer exists
                    if (viewMode === 'dms' && currentDmChannelId && !dmConversations.find(function(c) { return c.dm_channel_id === currentDmChannelId; })) {
                        currentDmChannelId = null;
                        currentDmOtherUser = null;
                        document.getElementById('message-list').innerHTML = '<div class="welcome">This user has deleted their account</div>';
                        document.getElementById('message-input').disabled = true;
                        document.getElementById('send-btn').disabled = true;
                        document.getElementById('dm-chat-header-name').textContent = '';
                    }
                    // Remove from member lists
                    document.querySelectorAll('.member-item[data-user-id="' + deletedUserId + '"]').forEach(function(el) {
                        el.remove();
                    });
                    // Refresh DM list and server list
                    await loadDmConversations();
                    if (viewMode === 'dms') {
                        renderDmSidebar();
                    }
                    // Save viewMode so loadServers doesn't auto-select a server when in DM view
                    var prevViewMode = viewMode;
                    await loadServers();
                    // If we were in DM view, stay in DM view (loadServers may have auto-selected a server)
                    if (prevViewMode === 'dms' && viewMode !== 'dms') {
                        viewMode = 'dms';
                        document.getElementById('server-name').textContent = 'Direct Messages';
                        document.getElementById('invite-btn').style.display = 'none';
                        document.getElementById('server-settings-btn').style.display = 'none';
                        document.getElementById('members-toggle').style.display = 'none';
                        document.getElementById('members-panel').classList.remove('open');
                        membersPanelOpen = false;
                        // Re-render DM sidebar since loadServers may have overwritten the channel list
                        renderDmSidebar();
                    }
                    // If the current server no longer exists in the server list (deleted user was owner), clear the view
                    if (currentServerId && !servers.find(function(s) { return s.id === currentServerId; })) {
                        currentServerId = null;
                        currentChannelId = null;
                        viewMode = 'servers';
                        document.getElementById('server-name').textContent = '';
                        document.getElementById('channel-list').innerHTML = '<div class="channel-item" style="color:#666;cursor:default">Select a server</div>';
                        document.getElementById('channel-name').textContent = 'Select a channel';
                        document.getElementById('message-list').innerHTML = '<div class="welcome">Select a server and channel to start chatting</div>';
                        document.getElementById('message-input').disabled = true;
                        document.getElementById('send-btn').disabled = true;
                    }
                }
                break;
            case 'server_deleted':
                if (data.server_id) {
                    var wasInDmView = viewMode === 'dms';
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
                    // If we were in DM view before, restore it (loadServers may have auto-selected a server)
                    if (wasInDmView && viewMode !== 'dms') {
                        viewMode = 'dms';
                        document.getElementById('server-name').textContent = 'Direct Messages';
                        document.getElementById('invite-btn').style.display = 'none';
                        document.getElementById('server-settings-btn').style.display = 'none';
                        document.getElementById('members-toggle').style.display = 'none';
                        document.getElementById('members-panel').classList.remove('open');
                        membersPanelOpen = false;
                        renderDmSidebar();
                    }
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
                if (data.from_username) {
                    showBrowserNotification('Friend Request', data.from_username + ' sent you a friend request');
                    playNotificationSound();
                }
                break;
            case 'friend_request_accepted':
                if (viewMode === 'dms') loadDmConversations();
                break;
            case 'friend_removed':
                // Filter out the DM conversation with the unfriended user
                dmConversations = dmConversations.filter(function(c) {
                    return c.other_user_id !== data.by_user_id;
                });
                if (viewMode === 'dms') {
                    await loadDmConversations();
                    renderDmSidebar();
                }
                // If currently viewing the DM with the unfriended user, clear the view
                if (data.by_user_id && currentDmOtherUser && data.by_user_id === currentDmOtherUser.id) {
                    currentDmChannelId = null;
                    currentDmOtherUser = null;
                    document.getElementById('channel-name').textContent = 'Select a conversation';
                    document.getElementById('message-input').disabled = true;
                    document.getElementById('send-btn').disabled = true;
                    document.getElementById('message-list').innerHTML = '<div class="welcome">Select a conversation to start chatting</div>';
                }
                // Also check by dmChannelId: if the current DM channel no longer exists
                if (viewMode === 'dms' && currentDmChannelId && !dmConversations.find(function(c) { return c.dm_channel_id === currentDmChannelId; })) {
                    currentDmChannelId = null;
                    currentDmOtherUser = null;
                    document.getElementById('channel-name').textContent = 'Select a conversation';
                    document.getElementById('message-input').disabled = true;
                    document.getElementById('send-btn').disabled = true;
                    document.getElementById('message-list').innerHTML = '<div class="welcome">Select a conversation to start chatting</div>';
                }
                break;
            case 'profile_updated':
                if (data.user_id && data.display_name !== undefined) {
                    // Update our own profile in cache and localStorage
                    if (data.user_id === user.id) {
                        user.display_name = data.display_name;
                        user.profile_picture_file_id = data.profile_picture_file_id;
                        user.profile_picture_file_key = data.profile_picture_file_key;
                        user.username_color = data.username_color;
                        if (myProfile) {
                            myProfile.display_name = data.display_name;
                            myProfile.profile_picture_file_id = data.profile_picture_file_id;
                            myProfile.profile_picture_file_key = data.profile_picture_file_key;
                            myProfile.username_color = data.username_color;
                            myProfile.username_border_color = data.username_border_color;
                        }
                        localStorage.setItem('user', JSON.stringify(user));
                        updateSidebarFooter();
                    }

                    // Update display name cache for all users
                    if (!userDisplayNameCache[data.user_id]) userDisplayNameCache[data.user_id] = {};
                    if (data.display_name !== undefined) userDisplayNameCache[data.user_id].display_name = data.display_name;
                    if (data.profile_picture_file_id !== undefined) userDisplayNameCache[data.user_id].profile_picture_file_id = data.profile_picture_file_id;
                    if (data.username_color !== undefined) userDisplayNameCache[data.user_id].username_color = data.username_color;
                    if (data.username_border_color !== undefined) userDisplayNameCache[data.user_id].username_border_color = data.username_border_color;

                    // Invalidate profile pic cache for this user
                    for (var pk in profilePicCache) {
                        if (pk.startsWith(data.user_id + ':')) {
                            delete profilePicCache[pk];
                        }
                    }

                    // Refresh DM conversations to show updated display name/pic
                    if (viewMode === 'dms') {
                        loadDmConversations();
                    }

                    // Refresh server member list if viewing a server
                    if (currentServerId) {
                        loadMembers(currentServerId);
                    }

                    // Update existing message DOM elements instead of reloading all messages
                    updateExistingMessageStyles(data.user_id);
                }
                break;
            case 'mention_notification':
                if (data.sender_username) {
                    if (!isMuted(data.server_id, data.channel_id) && !isUserMuted(data.sender_id)) {
                        trackUnreadMention(data.server_id, data.channel_id, data.dm_channel_id, data.message_id, data.sender_username, data.channel_name, data.server_name, 'mention', data.sender_id, data.sender_profile_pic);
                        playNotificationSound();
                        var loc = data.channel_name ? '#' + data.channel_name : (data.dm_channel_id ? 'your DM' : 'a channel');
                        showBrowserNotification('Mentioned by ' + data.sender_username, 'You were mentioned in ' + (data.server_name ? data.server_name + ' ' : '') + loc, function () {
                            navigateToMessage(data.server_id, data.channel_id, data.dm_channel_id, data.message_id);
                        });
                        // Show in-app toast + flash server icon if currently viewing this channel
                        if (data.channel_id && data.channel_id === currentChannelId && data.server_id && data.server_id === currentServerId) {
                            if (!isUserMuted(data.sender_id)) {
                                showMentionToast(data.sender_username, data.server_id, data.channel_id, data.message_id);
                                flashServerIcon(data.server_id);
                            }
                        }
                    }
                }
                break;
            case 'reply_notification':
                if (data.sender_username) {
                    if (!isMuted(data.server_id, data.channel_id) && !isUserMuted(data.sender_id)) {
                        trackUnreadMention(data.server_id, data.channel_id, data.dm_channel_id, data.message_id, data.sender_username, data.channel_name, data.server_name, 'reply', data.sender_id, data.sender_profile_pic);
                        playNotificationSound();
                        var loc = data.channel_name ? '#' + data.channel_name : (data.dm_channel_id ? 'your DM' : 'a channel');
                        showBrowserNotification('Reply from ' + data.sender_username, data.sender_username + ' replied to you in ' + (data.server_name ? data.server_name + ' ' : '') + loc, function () {
                            navigateToMessage(data.server_id, data.channel_id, data.dm_channel_id, data.message_id);
                        });
                    }
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
        restoreMentionState();
        updateServerBadges();
        updateChannelBadges();
        updateDmStripBadge();
        updateMentionsBadge();

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
        div.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            showServerContextMenu(e, s.id, s.name);
        });
        list.appendChild(div);
    });
    
    updateServerBadges();
    updateServerMutedUI();
}

async function selectServer(serverId) {
    viewMode = 'servers';
    currentDmChannelId = null;
    currentDmOtherUser = null;
    currentServerId = serverId;
    currentChannelId = null;
    document.getElementById('dm-strip-btn').classList.remove('active');
    document.querySelectorAll('.dm-item').forEach(el => el.classList.remove('active'));

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
    await loadMembers(serverId);

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

        updateChannelBadges();
        updateChannelMutedUI();

        // Add context menu (right-click) to each channel
        list.querySelectorAll('.channel-item').forEach(function (ch) {
            ch.addEventListener('contextmenu', function (e) {
                e.preventDefault();
                showChannelContextMenu(e, ch.dataset.id, ch.dataset.name);
            });
        });

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

    // Clear mention badge for this channel
    clearUnreadChannelMentions(channelId);

    await loadMessages(channelId);

    if (window._closeSidebar) window._closeSidebar();
}

// --- Messages ---

async function loadMessages(channelId, aroundMessageId) {
    // Clean up old blob URLs when switching channels
    revokeBlobUrls();
    const list = document.getElementById('message-list');
    list.innerHTML = '<div class="welcome">Loading messages...</div>';

    try {
        let url = `/api/channels/${channelId}/messages`;
        if (aroundMessageId) {
            url = `/api/channels/${channelId}/messages/around/${aroundMessageId}`;
        }
        const res = await authFetch(url);
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

    // Message grouping: same sender within 2 minutes in same channel
    const msgTime = new Date(msg.timestamp).getTime();
    const isGrouped = msg.sender_id === lastMessageInfo.senderId &&
        currentChannelId === lastMessageInfo.channelId &&
        msgTime - lastMessageInfo.time < 120000;
    lastMessageInfo = { senderId: msg.sender_id, channelId: currentChannelId, time: msgTime };
    if (isGrouped) div.classList.add('grouped');

    const displayName = msg.sender_display_name || msg.sender_username || '?';
    const initial = displayName.charAt(0).toUpperCase();
    var senderPicUrl = msg.sender_profile_pic ? getProfilePicUrl(msg.sender_profile_pic, msg.sender_id) : null;
    let time = '';
    try {
        time = new Date(msg.timestamp).toLocaleTimeString();
    } catch (e) {
        time = msg.timestamp || '';
    }

    // Get username color and border color for this sender
    var senderColor = null;
    var senderBorderColor = null;
    if (msg.sender_username_color) {
        senderColor = msg.sender_username_color;
        senderBorderColor = msg.sender_border_color || null;
    } else if (userDisplayNameCache[msg.sender_id]) {
        senderColor = userDisplayNameCache[msg.sender_id].username_color;
        senderBorderColor = userDisplayNameCache[msg.sender_id].username_border_color || null;
    }

    let textContent = '';
    let fileData = null;
    let filesData = null;
    let replyTo = null;
    let forwardData = null;
    let gifData = null;
    let stickerData = null;
    let extraEmojis = null; // emoji refs embedded in message payload by sender
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
                } else if (parsed && parsed.type === 'text') {
                    textContent = parsed.text || '';
                }
                if (parsed && parsed.reply_to) {
                    replyTo = parsed.reply_to;
                }
                if (parsed && Array.isArray(parsed.emojis) && parsed.emojis.length > 0) {
                    extraEmojis = {};
                    for (const ref of parsed.emojis) {
                        if (ref.name && ref.file_id && ref.file_key) {
                            extraEmojis[ref.name] = {
                                file_id: ref.file_id,
                                file_key: ref.file_key,
                                mime_type: ref.mime_type || 'image/png',
                            };
                        }
                    }
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
            '<span class="reply-preview">' + (replyTo.preview ? renderEmojiText(replyTo.preview) : '') + '</span>' +
            '</div>';
    }
    const editedHtml = msg.edited_at ? '<span class="edited-label">(edited)</span>' : '';
    if (forwardData) {
        div.classList.add('forwarded');
        var fwdFileId = forwardData.sender_profile_pic_file_id || forwardData.sender_profile_pic || '';
        var fwdUserId = forwardData.sender_id || forwardData.source_server_id || '';
        var fwdSenderPicUrl = fwdFileId && fwdUserId ? getProfilePicUrl(fwdFileId, fwdUserId) : null;
        var fwdPicHtml = fwdSenderPicUrl ? '<img class="forward-sender-pic" src="' + fwdSenderPicUrl + '" alt="">' : '<span class="forward-sender-initial">' + (forwardData.sender_username ? forwardData.sender_username.charAt(0).toUpperCase() : '?') + '</span>';
        contentHtml += '<div class="forward-label" data-source-server-id="' + escapeAttr(forwardData.source_server_id || '') + '" data-source-channel-id="' + escapeAttr(forwardData.source_channel_id || '') + '" data-source-message-id="' + escapeAttr(forwardData.source_message_id || '') + '">' +
            '<div class="forward-sender-info">' + fwdPicHtml + '<span class="forward-sender-name"' + (forwardData.sender_color ? ' style="color:' + forwardData.sender_color + (forwardData.sender_border_color ? ';text-shadow:' + forwardData.sender_border_color : ';text-shadow:' + getDisplayNameTextShadow(forwardData.sender_color)) + '"' : '') + '>' + escapeHtml(forwardData.sender_username || 'unknown') + '</span></div>' +
            '<div class="forward-source-label"><span class="forward-channel-badge">#' + escapeHtml(forwardData.source_channel_name || 'unknown') + '</span> <span class="forward-server-badge">' + escapeHtml(forwardData.source_server_name || 'unknown') + '</span></div></div>';
        // Forward text preview
        if (forwardData.preview_content && forwardData.preview_nonce) {
            try {
                let previewText = E2ECrypto.decrypt(forwardData.preview_content, forwardData.preview_nonce, forwardData.source_channel_id, forwardData.source_server_id, forwardData.preview_message_nonce);
                let previewEmojis = null;
                try {
                    const parsed = JSON.parse(previewText);
                    if (parsed && parsed.type === 'text') {
                        previewText = parsed.text || '';
                        if (Array.isArray(parsed.emojis) && parsed.emojis.length > 0) {
                            previewEmojis = {};
                            for (const ref of parsed.emojis) {
                                if (ref.name && ref.file_id && ref.file_key) {
                                    previewEmojis[ref.name] = { file_id: ref.file_id, file_key: ref.file_key, mime_type: ref.mime_type || 'image/png' };
                                }
                            }
                        }
                    }
                } catch (_) {}
                contentHtml += '<div class="forward-preview"><div class="text"><span class="time-hover">' + time + '</span>' + renderEmojiText(previewText, previewEmojis) + editedHtml + '</div></div>';
            } catch (_) {
                contentHtml += '<div class="forward-preview forward-unavailable">Preview unavailable</div>';
            }
        }
        // Render rich media preview for forwards that contain GIF/sticker/file
        if (forwardData.gif) {
            contentHtml += '<div class="gif-message" style="margin-top:4px">' +
                '<img src="' + escapeHtml(forwardData.gif.url) + '" alt="' + escapeHtml(forwardData.gif.alt || 'GIF') + '" loading="lazy" style="max-width:300px;max-height:300px;border-radius:8px;cursor:pointer">' +
                '</div>';
        } else if (forwardData.sticker) {
            contentHtml += '<div class="sticker-message" data-file-id="' + escapeAttr(forwardData.sticker.file_id) + '" data-file-key="' + escapeAttr(forwardData.sticker.file_key) + '" data-mime-type="' + escapeAttr(forwardData.sticker.mime_type) + '"></div>';
        } else if (forwardData.file) {
            contentHtml += buildFileCardHtml(forwardData.file);
        }
    } else if (gifData) {
        if (gifData.text) contentHtml += '<div class="text"><span class="time-hover">' + time + '</span>' + renderEmojiText(gifData.text) + editedHtml + '</div>';
        contentHtml += '<div class="gif-message">' +
            '<img src="' + escapeHtml(gifData.url) + '" alt="' + escapeHtml(gifData.alt || 'GIF') + '" loading="lazy" style="max-width:300px;max-height:300px;border-radius:8px;cursor:pointer">' +
            '<button class="media-download-btn" title="Download" data-url="' + escapeHtml(gifData.url) + '" data-filename="sticker.gif">⬇</button>' +
            '</div>';
    } else if (stickerData) {
        if (stickerData.text) contentHtml += '<div class="text"><span class="time-hover">' + time + '</span>' + renderEmojiText(stickerData.text) + editedHtml + '</div>';
        contentHtml += '<div class="sticker-message"></div>';
    } else if (filesData) {
        contentHtml += buildMultiFileCardHtml(filesData);
    } else if (fileData) {
        contentHtml += buildFileCardHtml(fileData);
    } else if (textContent) {
        contentHtml += '<div class="text"><span class="time-hover">' + time + '</span>' + highlightMentionsInHtml(renderEmojiText(textContent, extraEmojis)) + editedHtml + '</div>';
    }

    // Check if current user is mentioned in text (for server messages)
    if (textContent && user) {
        var mentionPat = new RegExp('@' + user.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\b|$|\\s)');
        if (mentionPat.test(textContent)) {
            div.classList.add('mentioned');
        }
    }

    const actionsHtml = '<div class="message-actions">' +
        '<button class="msg-action-btn" data-action="reply" title="Reply">&#x21A9;</button>' +
        '<button class="msg-action-btn" data-action="forward" title="Forward to channel">&#x21AA;</button>' +
        '<button class="msg-action-btn" data-action="forward-dm" title="Forward to DM">&#x1F4AC;</button>' +
        (isOwn ? '<button class="msg-action-btn" data-action="edit" title="Edit">&#x270E;</button>' : '') +
        (isOwn ? '<button class="msg-action-btn" data-action="delete" title="Delete">&#x2715;</button>' : '') +
        '</div>';

    div.innerHTML =
        (senderPicUrl ?
            '<div class="avatar"><img class="avatar-img" src="' + senderPicUrl + '" alt="" data-profile-pic="' + (msg.sender_id + ':' + msg.sender_profile_pic) + '"></div>' :
            (msg.sender_profile_pic ?
                '<div class="avatar" data-profile-pic-load="' + (msg.sender_id + ':' + msg.sender_profile_pic) + '">' + initial + '</div>' :
                '<div class="avatar">' + initial + '</div>')) +
        '<div class="content">' +
            '<div class="header">' +
                '<span class="display-name"' + (senderColor ? ' style="color:' + senderColor + ';text-shadow:' + getDisplayNameTextShadow(senderColor, senderBorderColor) + '"' : '') + '>' + escapeHtml(displayName) + '</span>' +
            '</div>' +
            contentHtml +
        '</div>' +
        actionsHtml;

    // Load media preview if applicable (respect auto-load setting)
    const autoLoad = localStorage.getItem('autoLoadPreviews') !== 'false';
    if (filesData) {
        div.querySelectorAll('.file-preview').forEach((container, idx) => {
            if (filesData[idx] && filesData[idx].file_key) {
                if (autoLoad) {
                    loadMediaPreview(container, filesData[idx]);
                } else {
                    // Show manual load button
                    container.innerHTML = '<button class="load-preview-btn" data-file-idx="' + idx + '">Load preview</button>';
                    container.querySelector('.load-preview-btn').addEventListener('click', () => {
                        container.innerHTML = '';
                        loadMediaPreview(container, filesData[idx]);
                    });
                }
            }
        });
    } else if (fileData && fileData.file_key) {
        const container = div.querySelector('.file-preview');
        if (container) {
            if (autoLoad) {
                loadMediaPreview(container, fileData);
            } else {
                container.innerHTML = '<button class="load-preview-btn">Load preview</button>';
                container.querySelector('.load-preview-btn').addEventListener('click', () => {
                    container.innerHTML = '';
                    loadMediaPreview(container, fileData);
                });
            }
        }
    } else if (stickerData && stickerData.file_id) {
        const stickerContainer = div.querySelector('.sticker-message');
        if (stickerContainer) {
            if (autoLoad) {
                loadStickerPreview(stickerContainer, stickerData);
            } else {
                stickerContainer.innerHTML = '<button class="load-preview-btn">Load sticker</button>';
                stickerContainer.querySelector('.load-preview-btn').addEventListener('click', () => {
                    stickerContainer.innerHTML = '';
                    loadStickerPreview(stickerContainer, stickerData);
                });
            }
        }
    } else if (forwardData && forwardData.sticker) {
        const fwdStickerContainer = div.querySelector('.sticker-message');
        if (fwdStickerContainer) {
            if (autoLoad) {
                loadStickerPreview(fwdStickerContainer, forwardData.sticker);
            } else {
                fwdStickerContainer.innerHTML = '<button class="load-preview-btn">Load sticker</button>';
                fwdStickerContainer.querySelector('.load-preview-btn').addEventListener('click', () => {
                    fwdStickerContainer.innerHTML = '';
                    loadStickerPreview(fwdStickerContainer, forwardData.sticker);
                });
            }
        }
    } else if (forwardData && forwardData.file && forwardData.file.file_key) {
        const fwdFileContainer = div.querySelector('.file-preview');
        if (fwdFileContainer) {
            if (autoLoad) {
                loadMediaPreview(fwdFileContainer, forwardData.file);
            } else {
                fwdFileContainer.innerHTML = '<button class="load-preview-btn">Load preview</button>';
                fwdFileContainer.querySelector('.load-preview-btn').addEventListener('click', () => {
                    fwdFileContainer.innerHTML = '';
                    loadMediaPreview(fwdFileContainer, forwardData.file);
                });
            }
        }
    }

    // Reply highlight: if this message replies to the current user, add yellow border
    if (replyTo && replyTo.author && user && replyTo.author === user.username) {
        div.classList.add('reply-highlighted');
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
        // New stickers: derive key from identity. Old stickers: use stored file_key.
        let fileKeyBytes;
        if (stickerData.file_key) {
            fileKeyBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(stickerData.file_key));
        } else {
            const identity = E2ECrypto.getIdentityKeyPair();
            if (!identity) throw new Error('No identity key');
            fileKeyBytes = identity.privateKey;
        }

        const blob = await downloadAndDecryptStickerData(stickerData.file_id, fileKeyBytes, stickerData.mime_type || 'image/png');
        const url = URL.createObjectURL(blob);
        blobUrls.push(url);
        const img = document.createElement('img');
        img.src = url;
        img.alt = stickerData.sticker_name || 'Sticker';
        img.style.maxWidth = '192px';
        img.style.maxHeight = '192px';
        img.style.borderRadius = '8px';
        img.style.cursor = 'pointer';
        img.addEventListener('click', (e) => {
            e.stopPropagation();
            openMediaViewer(url, 'image', null, [{ url: url, type: 'image' }]);
        });
        // Store sticker metadata on the container for forward extraction
        container.setAttribute('data-file-id', stickerData.file_id || '');
        container.setAttribute('data-file-key', stickerData.file_key || '');
        container.setAttribute('data-mime-type', stickerData.mime_type || 'image/png');
        container.appendChild(img);
        // Add download button
        const dlBtn = document.createElement('button');
        dlBtn.className = 'media-download-btn';
        dlBtn.title = 'Download';
        dlBtn.textContent = '⬇';
        dlBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            downloadBlobAs(url, stickerData.sticker_name || 'sticker', stickerData.mime_type || 'image/png');
        });
        container.appendChild(dlBtn);
    } catch (e) {
        container.textContent = '[sticker unavailable]';
    }
}

// --- Message Actions ---

let pendingReply = null;
let pendingForward = null;

function setupMessageActions() {
    const list = document.getElementById('message-list');
    function handleForwardLabelClick(forwardLabel) {
        const serverId = forwardLabel.dataset.sourceServerId;
        const channelId = forwardLabel.dataset.sourceChannelId;
        const messageId = forwardLabel.dataset.sourceMessageId;
        if (channelId) {
            navigateToMessage(serverId, channelId, messageId);
        }
    }
    list.addEventListener('click', (e) => {
        // Forward label click → navigate to source server/channel/message
        const forwardLabel = e.target.closest('.forward-label');
        if (forwardLabel) {
            handleForwardLabelClick(forwardLabel);
            return;
        }
        // Emoji click → download as PNG
        const emojiImg = e.target.closest('.emoji-inline');
        if (emojiImg) {
            const name = (emojiImg.getAttribute('alt') || '').replace(/^:|:$/g, '') || 'emoji';
            downloadBlobAs(emojiImg.src, name + '.png', 'image/png');
            return;
        }
        // GIF image click → open media viewer
        const gifImg = e.target.closest('.gif-message img');
        if (gifImg && !e.target.closest('.media-download-btn')) {
            const url = gifImg.src;
            openMediaViewer(url, 'image', null, [{ url: url, type: 'image' }]);
            return;
        }
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
        } else if (action === 'forward-dm') {
            handleForwardToDm(messageId, msgDiv);
        } else if (action === 'edit') {
            handleEdit(messageId, msgDiv);
        } else if (action === 'delete') {
            handleDelete(messageId, msgDiv);
        }
    });
}

async function navigateToMessage(serverId, channelId, messageId) {
    // Switch to server view if currently in DMs
    if (viewMode === 'dms') {
        const dmStripBtn = document.getElementById('dm-strip-btn');
        if (dmStripBtn) dmStripBtn.classList.remove('active');
        viewMode = 'servers';
    }

    // If this is a DM forward (no serverId), handle it separately
    if (!serverId) {
        if (viewMode !== 'dms') {
            const dmStripBtn = document.getElementById('dm-strip-btn');
            if (dmStripBtn) dmStripBtn.classList.add('active');
            viewMode = 'dms';
        }
        // Ensure DM conversations are loaded before looking up the channel
        if (!dmConversations || dmConversations.length === 0) {
            await loadDmConversations();
        }
        // Switch to the DM channel
        currentDmChannelId = channelId;
        currentChannelId = null;
        currentServerId = null;
        const conv = dmConversations.find(c => c.dm_channel_id === channelId);
        var displayName = conv ? (conv.other_display_name || conv.other_username) : 'DM';
        const otherUser = conv ? { id: conv.other_user_id, username: conv.other_username, display_name: conv.other_display_name } : null;
        currentDmOtherUser = otherUser;
        var dmPicUrl2 = conv && conv.other_profile_picture_file_id ? getProfilePicUrl(conv.other_profile_picture_file_id, conv.other_user_id) : null;
        var dmChatHeaderPicHtml2 = dmPicUrl2 ? '<img class="dm-chat-header-pic" src="' + dmPicUrl2 + '" alt="">' : (conv && conv.other_profile_picture_file_id ? '<div class="dm-chat-header-pic dm-chat-header-pic-load" data-profile-pic-load="' + conv.other_user_id + ':' + conv.other_profile_picture_file_id + '">' + displayName.charAt(0).toUpperCase() + '</div>' : '');
        document.getElementById('channel-name').innerHTML = dmChatHeaderPicHtml2 + escapeHtml(displayName) + ' <button class="btn-unfriend" id="unfriend-btn" title="Unfriend">Unfriend</button>';
        document.getElementById('message-input').disabled = false;
        document.getElementById('send-btn').disabled = false;
        await loadDmMessages(channelId, otherUser ? otherUser.id : '');
        if (window._closeSidebar) window._closeSidebar();
        if (messageId) {
            const target = await waitForElement('[data-message-id="' + messageId + '"]', 10000);
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                target.classList.add('flash-highlight');
                setTimeout(() => target.classList.remove('flash-highlight'), 2000);
            }
        }
        return;
    }

    // Select the server (this will load channels)
    const serverExists = servers.some(s => s.id === serverId);
    if (!serverExists) {
        await loadServers();
    }
    if (serverId !== currentServerId) {
        await selectServer(serverId);
    }

    // Clear mention badge for this channel
    clearUnreadChannelMentions(channelId);

    // Wait for channel element to appear
    const channelEl = await waitForElement('.channel-item[data-id="' + channelId + '"]', 5000);
    if (channelEl) {
        // Select the channel manually
        currentChannelId = channelId;
        document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
        channelEl.classList.add('active');
        const channelName = channelEl.dataset.name || 'channel';
        document.getElementById('channel-name').textContent = '# ' + channelName;
        document.getElementById('message-input').disabled = false;
        document.getElementById('send-btn').disabled = false;
        // Load all messages (no around param), then scroll to target
        await loadMessages(channelId);
        if (window._closeSidebar) window._closeSidebar();
        // Now wait for the target message to appear, then scroll to it
        if (messageId) {
            const target = await waitForElement('[data-message-id="' + messageId + '"]', 10000);
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                target.classList.add('flash-highlight');
                setTimeout(() => target.classList.remove('flash-highlight'), 2000);
            }
        }
    }
}

/** Wait up to `timeout` ms for an element matching `selector` to appear in the DOM. */
function waitForElement(selector, timeout) {
    return new Promise((resolve) => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        const observer = new MutationObserver(() => {
            const found = document.querySelector(selector);
            if (found) {
                observer.disconnect();
                resolve(found);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => {
            observer.disconnect();
            resolve(null);
        }, timeout);
    });
}

function handleReply(messageId, msgDiv) {
    const username = msgDiv.querySelector('.username')?.textContent || 'unknown';
    const textEl = msgDiv.querySelector('.text');
    const preview = textEl ? extractRawMessageText(textEl).substring(0, 80) : '';
    const senderId = msgDiv.getAttribute('data-sender-id') || '';
    pendingReply = { message_id: messageId, author: username, preview: preview, sender_id: senderId };
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
    pendingForward = { messageId, msgDiv, sourceServerId: currentServerId };
    showForwardModal();
}

function handleForwardToDm(messageId, msgDiv) {
    pendingForward = { messageId, msgDiv, toDm: true, sourceServerId: currentServerId };
    showDmForwardModal();
}

function handleEdit(messageId, msgDiv) {
    const textEl = msgDiv.querySelector('.text');
    if (!textEl) return;
    // Extract the raw text including emoji shortcodes (:name:) from alt attributes
    const originalText = extractRawMessageText(textEl);
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

    // Shift+Enter for newline in edit textarea
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            btnRow.querySelector('.edit-save-btn').click();
        }
    });

    btnRow.querySelector('.edit-save-btn').addEventListener('click', async () => {
        const newText = textarea.value.trim();
        if (!newText) {
            textarea.remove();
            btnRow.remove();
            if (oldText) oldText.style.display = '';
            if (oldReply) oldReply.style.display = '';
            if (oldForward) oldForward.style.display = '';
            if (actionsEl) actionsEl.style.display = '';
            return;
        }

        // Preserve any existing GIF/sticker/file data from the original message
        let existingGif = null;
        let existingSticker = null;
        const gifMsgEl = msgDiv.querySelector('.gif-message');
        if (gifMsgEl) {
            const img = gifMsgEl.querySelector('img');
            if (img) {
                existingGif = { url: img.getAttribute('src') || '', alt: img.getAttribute('alt') || 'GIF' };
            }
        }
        const stickerMsgEl = msgDiv.querySelector('.sticker-message');
        if (stickerMsgEl) {
            existingSticker = {
                file_id: stickerMsgEl.getAttribute('data-file-id') || '',
                file_key: stickerMsgEl.getAttribute('data-file-key') || '',
                mime_type: stickerMsgEl.getAttribute('data-mime-type') || 'image/png',
            };
        }

        if (viewMode === 'dms') {
            // DM edit: encrypt with DM E2E and send as dm_edit
            if (!currentDmChannelId || !currentDmOtherUser) {
                textarea.remove();
                btnRow.remove();
                if (oldText) oldText.style.display = '';
                if (oldReply) oldReply.style.display = '';
                if (oldForward) oldForward.style.display = '';
                if (actionsEl) actionsEl.style.display = '';
                return;
            }
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                textarea.remove();
                btnRow.remove();
                if (oldText) oldText.style.display = '';
                if (oldReply) oldReply.style.display = '';
                if (oldForward) oldForward.style.display = '';
                if (actionsEl) actionsEl.style.display = '';
                return;
            }
            try {
                const kp = E2ECrypto.getIdentityKeyPair();
                if (!kp) {
                    textarea.remove();
                    btnRow.remove();
                    if (oldText) oldText.style.display = '';
                    if (oldReply) oldReply.style.display = '';
                    if (oldForward) oldForward.style.display = '';
                    if (actionsEl) actionsEl.style.display = '';
                    return;
                }
                const res = await authFetch('/api/identity/' + currentDmOtherUser.id);
                const data = await res.json();
                const otherPubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
                // Preserve existing GIF/sticker data beside the new text
                let plaintext = newText;
                const emojiRefs = collectEmojiRefsFromMsgEl(msgDiv, newText);
                const payload = { type: 'text', text: newText };
                if (existingGif) {
                    payload.type = 'gif';
                    payload.url = existingGif.url;
                    payload.alt = existingGif.alt;
                    payload.text = newText;
                } else if (existingSticker) {
                    payload.type = 'sticker';
                    payload.file_id = existingSticker.file_id;
                    payload.file_key = existingSticker.file_key;
                    payload.mime_type = existingSticker.mime_type;
                    payload.text = newText;
                }
                if (pendingReply) payload.reply_to = pendingReply;
                if (emojiRefs.length > 0) payload.emojis = emojiRefs;
                plaintext = JSON.stringify(payload);
                const encrypted = E2ECrypto.encryptDm(plaintext, currentDmChannelId, kp.privateKey, otherPubKey);
                ws.send(JSON.stringify({
                    type: 'dm_edit',
                    message_id: messageId,
                    encrypted_content: encrypted.ciphertext,
                    nonce: encrypted.nonce,
                    message_nonce: encrypted.messageNonce || null,
                }));
            } catch (e) {
                console.error('DM edit encrypt failed:', e);
            }
        } else {
            // Channel edit: encrypt with server key and send as message_edit
            if (!currentChannelId || !currentServerId) return;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            try {
                // Preserve existing GIF/sticker data beside the new text
                let plaintext = newText;
                const emojiRefs = collectEmojiRefsFromMsgEl(msgDiv, newText);
                const payload = { type: 'text', text: newText };
                if (existingGif) {
                    payload.type = 'gif';
                    payload.url = existingGif.url;
                    payload.alt = existingGif.alt;
                    payload.text = newText;
                } else if (existingSticker) {
                    payload.type = 'sticker';
                    payload.file_id = existingSticker.file_id;
                    payload.file_key = existingSticker.file_key;
                    payload.mime_type = existingSticker.mime_type;
                    payload.text = newText;
                }
                if (pendingReply) payload.reply_to = pendingReply;
                if (emojiRefs.length > 0) payload.emojis = emojiRefs;
                plaintext = JSON.stringify(payload);
                const encrypted = E2ECrypto.encrypt(plaintext, currentChannelId, currentServerId);
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
        }
        textarea.remove();
        btnRow.remove();
        // Restore the old text display so it's visible while waiting for server confirmation
        if (oldText) oldText.style.display = '';
        if (oldReply) oldReply.style.display = '';
        if (oldForward) oldForward.style.display = '';
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

async function handleEditedMessage(msg, mode) {
    const list = document.getElementById('message-list');
    const existing = list.querySelector('[data-message-id="' + msg.id + '"]');
    if (!existing) return;

    const textEl = existing.querySelector('.text');
    if (textEl && msg.encrypted_content && msg.nonce) {
        try {
            let decrypted;
            if (mode === 'dm' && currentDmChannelId && currentDmOtherUser) {
                const kp = E2ECrypto.getIdentityKeyPair();
                if (!kp) return;
                let otherPubKey;
                try {
                    const res = await authFetch('/api/identity/' + currentDmOtherUser.id);
                    const data = await res.json();
                    otherPubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
                } catch (e) {
                    return;
                }
                decrypted = E2ECrypto.decryptDm(msg.encrypted_content, msg.nonce, currentDmChannelId, kp.privateKey, otherPubKey, msg.message_nonce);
            } else if (currentChannelId && currentServerId) {
                decrypted = E2ECrypto.decrypt(msg.encrypted_content, msg.nonce, currentChannelId, currentServerId, msg.message_nonce);
            }
            if (decrypted) {
                // Ensure the global emoji cache is loaded so renderEmojiText can find custom emojis
                if (!emojiCache) {
                    await loadEmojiCache();
                }
                // Parse JSON payload to extract emoji refs (same as appendMessage/appendDmMessage)
                let renderText = decrypted;
                let extraEmojis = null;
                try {
                    const parsed = JSON.parse(decrypted);
                    if (parsed && parsed.text !== undefined) {
                        renderText = parsed.text || '';
                        if (Array.isArray(parsed.emojis) && parsed.emojis.length > 0) {
                            extraEmojis = {};
                            for (const ref of parsed.emojis) {
                                if (ref.name && ref.file_id && ref.file_key) {
                                    extraEmojis[ref.name] = {
                                        file_id: ref.file_id,
                                        file_key: ref.file_key,
                                        mime_type: ref.mime_type || 'image/png',
                                    };
                                }
                            }
                        }
                    }
                } catch (_) {}
                // Preserve the time-hover span and render emoji text properly
                const timeEl = textEl.querySelector('.time-hover');
                const timeHtml = timeEl ? timeEl.outerHTML : '';
                textEl.innerHTML = timeHtml + renderEmojiText(renderText, extraEmojis);
                // Ensure the text element is visible (it might have been hidden during editing)
                textEl.style.display = '';
            }
        } catch (_) {}
    }

    const contentEl = existing.querySelector('.content');
    if (contentEl) {
        let existingLabel = contentEl.querySelector('.edited-label');
        if (existingLabel) {
            if (!existingLabel.textContent) {
                existingLabel.textContent = '(edited)';
            }
        } else {
            contentEl.insertAdjacentHTML('beforeend', '<span class="edited-label">(edited)</span>');
        }
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
        // Only show channels from the same server as the forwarded message
        const sourceServerId = pendingForward?.sourceServerId || currentServerId;
        if (!sourceServerId) {
            list.innerHTML = '<div style="color:#888">No source server</div>';
            return;
        }
        const chRes = await authFetch('/api/servers/' + sourceServerId + '/channels');
        const channels = await chRes.json();
        const server = servers.find(s => s.id === sourceServerId);
        const serverName = server ? server.name : 'Server';
        let html = '<div class="forward-server"><div class="forward-server-name">' + escapeHtml(serverName) + '</div>';
        for (const ch of channels) {
            html += '<div class="forward-channel-item" data-server-id="' + sourceServerId + '" data-server-name="' + escapeHtml(serverName) + '" data-channel-id="' + ch.id + '" data-channel-name="' + escapeHtml(ch.name) + '">' + escapeHtml(ch.name) + '</div>';
        }
        html += '</div>';
        list.innerHTML = html || '<div style="color:#888">No channels found</div>';
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

    const senderUsername = msgDiv.querySelector('.display-name')?.textContent || msgDiv.querySelector('.username')?.textContent || 'unknown';
    const senderId = msgDiv.getAttribute('data-sender-id') || '';
    var avatarPicAttr = (msgDiv.querySelector('.avatar img.avatar-img')?.getAttribute('data-profile-pic')) || (msgDiv.querySelector('.avatar')?.getAttribute('data-profile-pic-load')) || '';
    var senderPicFileId = avatarPicAttr ? avatarPicAttr.split(':')[1] || '' : '';
    const senderColor = msgDiv.querySelector('.display-name')?.style?.color || '';
    const textEl = msgDiv.querySelector('.text');
    const originalText = textEl ? extractRawMessageText(textEl) : '';

    let previewText = originalText.substring(0, 80);
    // Extract GIF/sticker/file data from the DOM for rich forward previews
    let gifData = null;
    let stickerData = null;
    let fileData = null;
    const gifMsgEl = msgDiv.querySelector('.gif-message');
    if (gifMsgEl) {
        const img = gifMsgEl.querySelector('img');
        if (img) {
            gifData = {
                url: img.getAttribute('src') || '',
                alt: img.getAttribute('alt') || 'GIF',
            };
        }
    }
    const stickerMsgEl = msgDiv.querySelector('.sticker-message');
    if (stickerMsgEl) {
        const img = stickerMsgEl.querySelector('img');
        if (img) {
            // Sticker images have blob URLs as src, but we store the original sticker data
            // in a data attribute for forward purposes
            stickerData = {
                file_id: stickerMsgEl.getAttribute('data-file-id') || '',
                file_key: stickerMsgEl.getAttribute('data-file-key') || '',
                mime_type: stickerMsgEl.getAttribute('data-mime-type') || 'image/png',
            };
        }
    }
    const fileCardEl = msgDiv.querySelector('.file-card');
    if (fileCardEl) {
        fileData = {
            file_id: fileCardEl.getAttribute('data-file-id') || '',
            file_key: fileCardEl.getAttribute('data-file-key') || '',
            file_name: fileCardEl.getAttribute('data-file-name') || 'File',
            file_size: fileCardEl.getAttribute('data-file-size') || '0',
            mime_type: fileCardEl.getAttribute('data-file-mime') || 'application/octet-stream',
        };
    }

    try {
        // Wrap preview with emoji refs so recipients can render them
        const previewEmojiRefs = collectEmojiRefsFromMsgEl(msgDiv, previewText);
        let previewEncrypted = null;
        if (previewText || previewEmojiRefs.length > 0) {
            const previewPlaintext = JSON.stringify({ type: 'text', text: previewText || '', emojis: previewEmojiRefs });
            previewEncrypted = E2ECrypto.encrypt(previewPlaintext, targetChannelId, targetServerId);
        }
        const sourceChannelId = currentChannelId;

        const forwardPayload = {
            type: 'forward',
            source_server_id: currentServerId,
            source_channel_id: sourceChannelId,
            source_message_id: messageId,
            source_server_name: document.getElementById('server-name')?.textContent || 'Server',
            source_channel_name: document.getElementById('channel-name')?.textContent || 'channel',
            sender_username: senderUsername,
            sender_id: senderId,
            sender_profile_pic_file_id: senderPicFileId,
            sender_color: senderColor,
            sender_border_color: msgDiv.querySelector('.display-name')?.style?.textShadow || '',
            timestamp: msgDiv.querySelector('.time')?.textContent || '',
        };
        if (previewEncrypted) {
            forwardPayload.preview_content = previewEncrypted.ciphertext;
            forwardPayload.preview_nonce = previewEncrypted.nonce;
            forwardPayload.preview_message_nonce = previewEncrypted.messageNonce || null;
        }
        // Include rich media data in the forward payload if present
        if (gifData) forwardPayload.gif = gifData;
        if (stickerData) forwardPayload.sticker = stickerData;
        if (fileData) forwardPayload.file = fileData;

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
    const emojiRefs = collectEmojiRefs(content);
    const mentionIds = findMentionsInText(content, currentServerMemberList);
    if (pendingReply || emojiRefs.length > 0 || mentionIds.length > 0) {
        const payload = { type: 'text', text: content };
        if (pendingReply) payload.reply_to = pendingReply;
        if (emojiRefs.length > 0) payload.emojis = emojiRefs;
        plaintext = JSON.stringify(payload);
    }

    var encrypted;
    try {
        encrypted = E2ECrypto.encrypt(plaintext, currentChannelId, currentServerId);
    } catch (e) {
        console.error('Encryption failed:', e);
        return;
    }

    var msgPayload = {
        type: 'message_send',
        channel_id: currentChannelId,
        encrypted_content: encrypted.ciphertext,
        nonce: encrypted.nonce,
        message_nonce: encrypted.messageNonce || null,
    };
    if (mentionIds.length > 0) msgPayload.mentions = mentionIds;
    if (pendingReply && pendingReply.sender_id) msgPayload.reply_to_user_id = pendingReply.sender_id;

    ws.send(JSON.stringify(msgPayload));

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
    document.querySelectorAll('.dm-item').forEach(el => el.classList.remove('active'));
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
    html += '<button class="key-action-btn" id="get-friend-code-btn" title="Get friend code from server">&#128274;</button>';
    html += '<button class="key-action-btn" id="regen-friend-code-btn" title="Generate new friend code" style="color:#ff9800;">&#128260;</button>';
    html += '</div>';
    html += '<div id="friend-code-status" class="friend-code-status" style="font-size:11px;color:#888;margin-top:4px;text-align:center;"></div>';
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
        var displayName = c.other_display_name || c.other_username || '?';
        const initial = displayName.charAt(0).toUpperCase();
        // Profile pic URL for DM avatar
        var dmAvatarHtml = '';
        var dmPicCacheKey = c.other_profile_picture_file_id ? (c.other_user_id + ':' + c.other_profile_picture_file_id) : null;
        var dmPicUrl = dmPicCacheKey ? profilePicCache[dmPicCacheKey] : null;
        if (dmPicUrl) {
            dmAvatarHtml = '<img class="avatar-img" src="' + dmPicUrl + '" alt="">';
        } else if (dmPicCacheKey) {
            dmAvatarHtml = initial;
            // Trigger async fetch
            getProfilePicUrl(c.other_profile_picture_file_id, c.other_user_id);
        } else {
            dmAvatarHtml = initial;
        }
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
            '<div class="dm-avatar' + (dmPicCacheKey ? ' profile-pic-target' : '') + '" data-profile-pic-load="' + (dmPicCacheKey || '') + '">' + dmAvatarHtml + '</div>' +
            '<div class="dm-info">' +
                '<div class="dm-name">' + escapeHtml(displayName) + '</div>' +
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
        // Right-click context menu for mute/unmute
        item.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            var dmId = item.dataset.dmId;
            var username = item.dataset.username || 'user';
            showDmContextMenu(e, dmId, username);
        });
    });
    
    // Restore DM muted UI after render
    updateDmMutedUI();

    // Re-bind context menu to DM items after async profile pic loads change their content

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
    // Look up the user's display name
    var conv = dmConversations.find(c => c.dm_channel_id === dmChannelId);
    var displayName = conv ? (conv.other_display_name || conv.other_username || otherUsername) : otherUsername;
    currentDmOtherUser = { id: otherUserId, username: otherUsername, display_name: conv ? conv.other_display_name : null };
    currentChannelId = null;
    currentServerId = null;

    document.querySelectorAll('.channel-item, .dm-item').forEach(el => el.classList.remove('active'));

    var convForPic = dmConversations.find(function (c) { return c.dm_channel_id === dmChannelId; });
    var dmHeaderPicFileId = convForPic ? convForPic.other_profile_picture_file_id : null;
    var dmHeaderPicUrl = dmHeaderPicFileId ? getProfilePicUrl(dmHeaderPicFileId, otherUserId) : null;
    var dmHeaderPicHtml = dmHeaderPicUrl ? '<img class="dm-chat-header-pic" src="' + dmHeaderPicUrl + '" alt="">' : (dmHeaderPicFileId ? '<div class="dm-chat-header-pic dm-chat-header-pic-load" data-profile-pic-load="' + otherUserId + ':' + dmHeaderPicFileId + '">' + displayName.charAt(0).toUpperCase() + '</div>' : '');
    document.getElementById('channel-name').innerHTML = dmHeaderPicHtml + '<span>' + escapeHtml(displayName) + '</span>' +
        ' <button class="btn-unfriend" id="unfriend-btn" title="Unfriend">Unfriend</button>';
    document.getElementById('message-input').disabled = false;
    document.getElementById('send-btn').disabled = false;

    document.getElementById('unfriend-btn').addEventListener('click', () => unfriend(otherUserId, otherUsername));
    
    // Clear unread badge for this DM channel
    delete unreadDms[dmChannelId];
    updateDmStripBadge();
    updateMentionsBadge();
    saveMentionState();
    await loadDmMessages(dmChannelId, otherUserId);
    renderDmSidebar();

    // Re-add active class after renderDmSidebar re-creates DOM
    var newDmEl = document.querySelector('.dm-item[data-dm-id="' + dmChannelId + '"]');
    if (newDmEl) newDmEl.classList.add('active');

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

        // Resolve the other user's identity key so we can decrypt messages.
        // If the fetch fails (e.g. the user has no public key yet),
        // fall back to showing encrypted placeholders.
        let otherPublicKey = null;
        try {
            const otherUserRes = await authFetch('/api/identity/' + otherUserId);
            if (otherUserRes.ok) {
                const otherUserData = await otherUserRes.json();
                if (otherUserData.identity_public_key) {
                    otherPublicKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(otherUserData.identity_public_key));

                    // TOFU key verification
                    const verification = E2ECrypto.verifyKeyForUser(otherUserId, otherUserData.identity_public_key);
                    if (verification.trusted) {
                        tofuTrusted = true;
                    } else {
                        const banner = document.createElement('div');
                        banner.className = 'message system';
                        banner.style.cssText = 'background:#ff9800;color:#fff;padding:10px;border-radius:6px;margin:10px 0;text-align:center';
                        banner.innerHTML = '⚠ <b>Key Changed!</b> The identity key for this user has changed since you last communicated. ' +
                            '<button onclick="if(confirm(\'Trust the new key?\')){E2ECrypto.trustCurrentKey(\'' + otherUserId + '\',\'' + otherUserData.identity_public_key + '\');this.parentElement.remove();}" ' +
                            'style="margin-left:8px;background:#fff;color:#e65100;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-weight:bold">Trust New Key</button>';
                        list.appendChild(banner);
                    }
                }
            }
        } catch (_) {
            // Identity key unavailable — messages will show as encrypted
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
    if (msg.id) div.setAttribute('data-message-id', msg.id);
    if (msg.sender_id) div.setAttribute('data-sender-id', msg.sender_id);

    const myUserId = localStorage.getItem('user') ? JSON.parse(localStorage.getItem('user')).id : '';
    const isOwn = msg.sender_id === myUserId;

    // DM message grouping: same sender within 2 minutes in same DM channel
    const msgTime = new Date(msg.timestamp).getTime();
    const isGrouped = msg.sender_id === lastDmMessageInfo.senderId &&
        currentDmChannelId === lastDmMessageInfo.dmChannelId &&
        msgTime - lastDmMessageInfo.time < 120000;
    lastDmMessageInfo = { senderId: msg.sender_id, dmChannelId: currentDmChannelId, time: msgTime };
    if (isGrouped) div.classList.add('grouped');

    const displayName = msg.sender_display_name || msg.sender_username || '?';
    const initial = displayName.charAt(0).toUpperCase();
    var senderPicUrl = msg.sender_profile_pic ? getProfilePicUrl(msg.sender_profile_pic, msg.sender_id) : null;
    var senderColor = msg.sender_username_color || null;
    var senderBorderColor = msg.sender_border_color || null;
    if (!senderBorderColor && msg.sender_id && userDisplayNameCache[msg.sender_id]) {
        senderBorderColor = userDisplayNameCache[msg.sender_id].username_border_color || null;
    }
    let time = '';
    try {
        time = new Date(msg.timestamp).toLocaleTimeString();
    } catch (e) {
        time = msg.timestamp || '';
    }

    let textContent = '';
    let fileData = null;
    let filesData = null;
    let stickerData = null;
    let gifData = null;
    let forwardData = null;
    let replyTo = null;
    let extraEmojis = null; // emoji refs embedded in message payload by sender
    if (msg.encrypted_content && msg.nonce && kp && otherPublicKey) {
        try {
            const dmId = msg.dm_channel_id || currentDmChannelId;
            textContent = E2ECrypto.decryptDm(msg.encrypted_content, msg.nonce, dmId, kp.privateKey, otherPublicKey, msg.message_nonce);
            // Check if it's a structured message
            try {
                const parsed = JSON.parse(textContent);
                if (parsed && parsed.type === 'files' && Array.isArray(parsed.files)) {
                    filesData = parsed.files;
                    textContent = '';
                } else if (parsed && parsed.type === 'file') {
                    fileData = parsed;
                    textContent = '';
                } else if (parsed && parsed.type === 'sticker') {
                    stickerData = parsed;
                    textContent = '';
                } else if (parsed && parsed.type === 'gif') {
                    gifData = parsed;
                    textContent = '';
                } else if (parsed && parsed.type === 'forward') {
                    forwardData = parsed;
                    textContent = '';
                } else if (parsed && parsed.type === 'text') {
                    textContent = parsed.text || '';
                }
                if (parsed && parsed.reply_to) {
                    replyTo = parsed.reply_to;
                }
                if (parsed && Array.isArray(parsed.emojis) && parsed.emojis.length > 0) {
                    extraEmojis = {};
                    for (const ref of parsed.emojis) {
                        if (ref.name && ref.file_id && ref.file_key) {
                            extraEmojis[ref.name] = {
                                file_id: ref.file_id,
                                file_key: ref.file_key,
                                mime_type: ref.mime_type || 'image/png',
                            };
                        }
                    }
                }
            } catch (_) {}
        } catch (e) {
            textContent = '[encrypted message - unable to decrypt]';
        }
    }

    let contentHtml = '';
    if (replyTo) {
        contentHtml += '<div class="reply-quote" data-reply-to="' + escapeHtml(replyTo.message_id || '') + '">' +
            '<span class="reply-author">@' + escapeHtml(replyTo.author || 'unknown') + '</span> ' +
            '<span class="reply-preview">' + (replyTo.preview ? renderEmojiText(replyTo.preview) : '') + '</span>' +
            '</div>';
    }
    if (forwardData) {
        div.classList.add('forwarded');
        var fwdFileId = forwardData.sender_profile_pic_file_id || forwardData.sender_profile_pic || '';
        var fwdUserId = forwardData.sender_id || forwardData.source_server_id || '';
        var fwdSenderPicUrl = fwdFileId && fwdUserId ? getProfilePicUrl(fwdFileId, fwdUserId) : null;
        var fwdPicHtml = fwdSenderPicUrl ? '<img class="forward-sender-pic" src="' + fwdSenderPicUrl + '" alt="">' : '<span class="forward-sender-initial">' + (forwardData.sender_username ? forwardData.sender_username.charAt(0).toUpperCase() : '?') + '</span>';
        contentHtml += '<div class="forward-label" data-source-server-id="' + escapeAttr(forwardData.source_server_id || '') + '" data-source-channel-id="' + escapeAttr(forwardData.source_channel_id || '') + '" data-source-message-id="' + escapeAttr(forwardData.source_message_id || '') + '">' +
            '<div class="forward-sender-info">' + fwdPicHtml + '<span class="forward-sender-name"' + (forwardData.sender_color ? ' style="color:' + forwardData.sender_color + (forwardData.sender_border_color ? ';text-shadow:' + forwardData.sender_border_color : ';text-shadow:' + getDisplayNameTextShadow(forwardData.sender_color)) + '"' : '') + '>' + escapeHtml(forwardData.sender_username || 'unknown') + '</span></div>' +
            '<div class="forward-source-label"><span class="forward-channel-badge">#' + escapeHtml(forwardData.source_channel_name || 'unknown') + '</span> <span class="forward-server-badge">' + escapeHtml(forwardData.source_server_name || 'unknown') + '</span></div></div>';
        // Forward text preview (decrypt with DM keys)
        if (forwardData.preview_content && forwardData.preview_nonce && kp && otherPublicKey) {
            try {
                let previewText = E2ECrypto.decryptDm(forwardData.preview_content, forwardData.preview_nonce, currentDmChannelId, kp.privateKey, otherPublicKey, forwardData.preview_message_nonce);
                let previewEmojis = null;
                try {
                    const parsed = JSON.parse(previewText);
                    if (parsed && parsed.type === 'text') {
                        previewText = parsed.text || '';
                        if (Array.isArray(parsed.emojis) && parsed.emojis.length > 0) {
                            previewEmojis = {};
                            for (const ref of parsed.emojis) {
                                if (ref.name && ref.file_id && ref.file_key) {
                                    previewEmojis[ref.name] = { file_id: ref.file_id, file_key: ref.file_key, mime_type: ref.mime_type || 'image/png' };
                                }
                            }
                        }
                    }
                } catch (_) {}
                contentHtml += '<div class="forward-preview"><div class="text"><span class="time-hover">' + time + '</span>' + renderEmojiText(previewText, previewEmojis) + '</div></div>';
            } catch (_) {
                contentHtml += '<div class="forward-preview forward-unavailable">Preview unavailable</div>';
            }
        }
        // Render rich media preview for forwards that contain GIF/sticker/file
        if (forwardData.gif) {
            contentHtml += '<div class="gif-message" style="margin-top:4px">' +
                '<img src="' + escapeHtml(forwardData.gif.url) + '" alt="' + escapeHtml(forwardData.gif.alt || 'GIF') + '" loading="lazy" style="max-width:300px;max-height:300px;border-radius:8px;cursor:pointer">' +
                '</div>';
        } else if (forwardData.sticker) {
            contentHtml += '<div class="sticker-message" data-file-id="' + escapeAttr(forwardData.sticker.file_id) + '" data-file-key="' + escapeAttr(forwardData.sticker.file_key) + '" data-mime-type="' + escapeAttr(forwardData.sticker.mime_type) + '"></div>';
        } else if (forwardData.file) {
            contentHtml += buildFileCardHtml(forwardData.file);
        }
    } else if (gifData) {
        if (gifData.text) contentHtml += '<div class="text"><span class="time-hover">' + time + '</span>' + renderEmojiText(gifData.text) + '</div>';
        contentHtml += '<div class="gif-message">' +
            '<img src="' + escapeHtml(gifData.url) + '" alt="' + escapeHtml(gifData.alt || 'GIF') + '" loading="lazy" style="max-width:300px;max-height:300px;border-radius:8px;cursor:pointer">' +
            '<button class="media-download-btn" title="Download" data-url="' + escapeHtml(gifData.url) + '" data-filename="sticker.gif">⬇</button>' +
            '</div>';
    } else if (stickerData) {
        if (stickerData.text) contentHtml += '<div class="text"><span class="time-hover">' + time + '</span>' + renderEmojiText(stickerData.text) + '</div>';
        contentHtml += '<div class="sticker-message"></div>';
    } else if (filesData) {
        contentHtml += buildMultiFileCardHtml(filesData);
    } else if (fileData) {
        contentHtml += buildFileCardHtml(fileData);
    } else if (textContent) {
        contentHtml += '<div class="text"><span class="time-hover">' + time + '</span>' + highlightMentionsInHtml(renderEmojiText(textContent, extraEmojis)) + '</div>';
    } else if (msg.encrypted_content && !otherPublicKey) {
        const label = isOwn ? '[message sent]' : '[encrypted]';
        contentHtml += '<div class="text" style="color:#888;font-style:italic">' + label + '</div>';
    }

    const actionsHtml = '<div class="message-actions">' +
        '<button class="msg-action-btn" data-action="reply" title="Reply">&#x21A9;</button>' +
        (isOwn ? '<button class="msg-action-btn" data-action="edit" title="Edit">&#x270E;</button>' : '') +
        '</div>';

    const editedHtml = msg.edited_at ? '<span class="edited-label">(edited)</span>' : '';
    div.innerHTML =
        (senderPicUrl ?
            '<div class="avatar"><img class="avatar-img" src="' + senderPicUrl + '" alt="" data-profile-pic="' + (msg.sender_id + ':' + msg.sender_profile_pic) + '"></div>' :
            (msg.sender_profile_pic ?
                '<div class="avatar" data-profile-pic-load="' + (msg.sender_id + ':' + msg.sender_profile_pic) + '">' + initial + '</div>' :
                '<div class="avatar">' + initial + '</div>')) +
        '<div class="content">' +
            '<div class="header">' +
                '<span class="display-name"' + (senderColor ? ' style="color:' + senderColor + ';text-shadow:' + getDisplayNameTextShadow(senderColor, senderBorderColor) + '"' : '') + '>' + escapeHtml(displayName) + '</span>' +
            '</div>' +
            contentHtml +
            editedHtml +
        '</div>' +
        actionsHtml;

    // Reply highlight: if this message replies to the current user, add yellow border
    if (replyTo && replyTo.author && user && replyTo.author === user.username) {
        div.classList.add('reply-highlighted');
    }

    // Check if current user is mentioned in text (for DM messages)
    if (textContent && user) {
        var dmMentionPat = new RegExp('@' + user.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\b|$|\\s)');
        if (dmMentionPat.test(textContent)) {
            div.classList.add('mentioned');
        }
    }

    // Reply quote click -> scroll to original
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

    // Load media preview if applicable (respect auto-load setting)
    const autoLoad = localStorage.getItem('autoLoadPreviews') !== 'false';
    if (stickerData && stickerData.file_id) {
        const stickerContainer = div.querySelector('.sticker-message');
        if (stickerContainer) {
            if (autoLoad) {
                loadStickerPreview(stickerContainer, stickerData);
            } else {
                stickerContainer.innerHTML = '<button class="load-preview-btn">Load sticker</button>';
                stickerContainer.querySelector('.load-preview-btn').addEventListener('click', () => {
                    stickerContainer.innerHTML = '';
                    loadStickerPreview(stickerContainer, stickerData);
                });
            }
        }
    } else if (forwardData && forwardData.sticker) {
        const fwdStickerContainer = div.querySelector('.sticker-message');
        if (fwdStickerContainer) {
            if (autoLoad) {
                loadStickerPreview(fwdStickerContainer, forwardData.sticker);
            } else {
                fwdStickerContainer.innerHTML = '<button class="load-preview-btn">Load sticker</button>';
                fwdStickerContainer.querySelector('.load-preview-btn').addEventListener('click', () => {
                    fwdStickerContainer.innerHTML = '';
                    loadStickerPreview(fwdStickerContainer, forwardData.sticker);
                });
            }
        }
    } else if (forwardData && forwardData.file && forwardData.file.file_key) {
        const fwdFileContainer = div.querySelector('.file-preview');
        if (fwdFileContainer) {
            if (autoLoad) {
                loadMediaPreview(fwdFileContainer, forwardData.file);
            } else {
                fwdFileContainer.innerHTML = '<button class="load-preview-btn">Load preview</button>';
                fwdFileContainer.querySelector('.load-preview-btn').addEventListener('click', () => {
                    fwdFileContainer.innerHTML = '';
                    loadMediaPreview(fwdFileContainer, forwardData.file);
                });
            }
        }
    } else if (filesData) {
        div.querySelectorAll('.file-preview').forEach((container, idx) => {
            if (filesData[idx] && filesData[idx].file_key) {
                if (autoLoad) {
                    loadMediaPreview(container, filesData[idx]);
                } else {
                    container.innerHTML = '<button class="load-preview-btn" data-file-idx="' + idx + '">Load preview</button>';
                    container.querySelector('.load-preview-btn').addEventListener('click', () => {
                        container.innerHTML = '';
                        loadMediaPreview(container, filesData[idx]);
                    });
                }
            }
        });
    } else if (fileData && fileData.file_key) {
        const container = div.querySelector('.file-preview');
        if (container) {
            if (autoLoad) {
                loadMediaPreview(container, fileData);
            } else {
                container.innerHTML = '<button class="load-preview-btn">Load preview</button>';
                container.querySelector('.load-preview-btn').addEventListener('click', () => {
                    container.innerHTML = '';
                    loadMediaPreview(container, fileData);
                });
            }
        }
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
    const emojiRefs = collectEmojiRefs(content);
    const dmMemberList = currentDmOtherUser ? [{ username: currentDmOtherUser.username, id: currentDmOtherUser.id }] : [];
    const mentionIds = findMentionsInText(content, dmMemberList);
    if (pendingReply || emojiRefs.length > 0 || mentionIds.length > 0) {
        const payload = { type: 'text', text: content };
        if (pendingReply) payload.reply_to = pendingReply;
        if (emojiRefs.length > 0) payload.emojis = emojiRefs;
        plaintext = JSON.stringify(payload);
    }

    var encrypted;
    try {
        encrypted = E2ECrypto.encryptDm(plaintext, currentDmChannelId, kp.privateKey, otherPublicKey);
    } catch (e) {
        console.error('DM encryption failed:', e);
        return;
    }

    var msgPayload = {
        type: 'dm_send',
        dm_channel_id: currentDmChannelId,
        encrypted_content: encrypted.ciphertext,
        nonce: encrypted.nonce,
        message_nonce: encrypted.messageNonce || null,
    };
    if (mentionIds.length > 0) msgPayload.mentions = mentionIds;
    if (pendingReply && pendingReply.sender_id) msgPayload.reply_to_user_id = pendingReply.sender_id;

    ws.send(JSON.stringify(msgPayload));

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
    document.querySelectorAll('.dm-item').forEach(el => el.classList.remove('active'));
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
        currentServerMemberList = Array.isArray(members) ? members : [];
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
            var memberInitial = (m.display_name || m.username || '?').charAt(0).toUpperCase();
            var memberPicUrl = m.profile_picture_file_id ? getProfilePicUrl(m.profile_picture_file_id, m.id) : null;
            var memberPicCacheKey = m.id + ':' + m.profile_picture_file_id;
            var memberAvatarHtml = memberPicUrl ?
                '<div class="member-avatar' + (isMemberOwner ? ' owner' : '') + '"><img src="' + memberPicUrl + '" alt="" data-profile-pic="' + memberPicCacheKey + '"></div>' :
                (m.profile_picture_file_id ?
                    '<div class="member-avatar' + (isMemberOwner ? ' owner' : '') + '" data-profile-pic-load="' + memberPicCacheKey + '">' + memberInitial + '</div>' :
                    '<div class="member-avatar' + (isMemberOwner ? ' owner' : '') + '">' + memberInitial + '</div>');
            div.innerHTML =
                memberAvatarHtml +
                '<div>' +
                    '<div class="member-name">' + escapeHtml(m.display_name || m.username) + '</div>' +
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
    await loadServerSettings();
    await loadBannedUsers();
}

async function loadServerSettings() {
    const toggle = document.getElementById('disable-joins-toggle');
    if (!toggle) return;
    // Set toggle based on current server state (from the server list which already has joins_disabled)
    const server = servers.find(s => s.id === currentServerId);
    if (server && server.joins_disabled !== undefined) {
        toggle.checked = server.joins_disabled;
    }
    toggle.onchange = async () => {
        const disabled = toggle.checked;
        try {
            const res = await authFetch('/api/servers/' + currentServerId + '/settings', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ disabled }),
            });
            if (res.ok) {
                // Update the local server cache
                const srv = servers.find(s => s.id === currentServerId);
                if (srv) srv.joins_disabled = disabled;
            } else {
                const err = await res.json();
                alert('Failed to update: ' + (err.error || 'Unknown error'));
                toggle.checked = !disabled;
            }
        } catch (e) {
            alert('Failed to update join settings');
            toggle.checked = !disabled;
        }
    };
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
    if (!currentServerId) return;
    if (!currentInviteCode && isOwner) {
        // Silently generate a new invite code if missing from localStorage
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
            } else {
                return; // Failed to create invite, can't open modal
            }
        } catch (e) {
            console.error('Failed to auto-generate invite code:', e);
            return;
        }
    }
    if (!currentInviteCode) return;
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
    var statusEl = document.getElementById('friend-code-status');
    try {
        // Try localStorage first
        myFriendCode = localStorage.getItem('e2e_friend_code') || '';
        // Show loading indicator if we need to fetch from server
        if (!myFriendCode) {
            if (statusEl) { statusEl.textContent = '⏳ Fetching from server...'; statusEl.style.color = '#888'; }
        } else {
            if (statusEl) { statusEl.textContent = ''; statusEl.style.color = '#888'; }
        }
        // If missing locally, show unavailable — user can recover via password prompt
        // (The server no longer stores plaintext friend codes; only encrypted copies
        // that require the account password to decrypt.)
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
                el.textContent = vis ? '••••••••••••••••' : (el.dataset.value || '(not available - log in again)');
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
            // Get friend code from server button (recover)
            const getBtn = document.getElementById('get-friend-code-btn');
            if (getBtn) {
                getBtn.onclick = async function () {
                    var pw = await verifyStoredPassword();
                    if (!pw) return;
                    handleFriendCodeRecover(pw);
                };
            }
            // Regenerate friend code button
            const regenBtn = document.getElementById('regen-friend-code-btn');
            if (regenBtn) {
                regenBtn.onclick = async function () {
                    var pw = await verifyStoredPassword();
                    if (!pw) return;
                    if (!confirm('Generate a new friend code? Your old one will stop working immediately.')) return;
                    handleFriendCodeRegenerate(pw);
                };
            }
        }
    } catch (_) {}
    loadFriendRequestBadge();
}

// Open the friend code password modal or auto-recover with stored password
async function showFriendCodePasswordModal() {
    // Try auto-recovery with stored password (verifies against server)
    var storedPw = localStorage.getItem('e2e_password');
    if (storedPw) {
        var verifiedPw = await verifyStoredPassword();
        if (verifiedPw) {
            handleFriendCodeRecover(verifiedPw);
            return;
        }
    }
    // No valid stored password — show the modal
    const modal = document.getElementById('friend-code-password-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    const input = document.getElementById('fc-password-input');
    const errorEl = document.getElementById('fc-password-error');
    const successEl = document.getElementById('fc-password-success');
    if (input) { input.value = ''; input.focus(); }
    if (errorEl) errorEl.style.display = 'none';
    if (successEl) successEl.style.display = 'none';
}

async function handleFriendCodeRecover(storedPw) {
    const input = document.getElementById('fc-password-input');
    const errorEl = document.getElementById('fc-password-error');
    const successEl = document.getElementById('fc-password-success');
    // Use verified password (either passed in or from modal input)
    var password = storedPw || (input ? input.value.trim() : '') || '';
    if (!password) {
        if (errorEl) { errorEl.textContent = 'Please enter your password.'; errorEl.style.display = 'block'; }
        if (successEl) successEl.style.display = 'none';
        return;
    }
    if (errorEl) errorEl.style.display = 'none';
    if (successEl) successEl.style.display = 'none';
    // Show loading state
    var recoverStatusEl = document.getElementById('friend-code-status');
    if (recoverStatusEl) { recoverStatusEl.textContent = '⏳ Fetching friend code from server...'; recoverStatusEl.style.color = '#888'; }
    try {
        const res = await authFetch('/api/friend-code');
        if (!res.ok) {
            const err = await res.json();
            if (recoverStatusEl) { recoverStatusEl.textContent = '❌ ' + (err.error || 'Failed to fetch'); recoverStatusEl.style.color = '#f44336'; setTimeout(function() { recoverStatusEl.textContent = ''; }, 4000); }
            if (errorEl) { errorEl.textContent = err.error || 'Failed to fetch friend code from server.'; errorEl.style.display = 'block'; }
            return;
        }
        const data = await res.json();
        if (recoverStatusEl) { recoverStatusEl.textContent = '⏳ Decrypting...'; }
        if (!data.encrypted_friend_code || !data.salt || !data.nonce) {
            if (recoverStatusEl) { recoverStatusEl.textContent = '❌ No encrypted code on server'; recoverStatusEl.style.color = '#ff9800'; setTimeout(function() { recoverStatusEl.textContent = ''; }, 4000); }
            if (errorEl) { errorEl.textContent = 'No encrypted friend code stored on the server. Use "Generate New" to create one.'; errorEl.style.display = 'block'; }
            return;
        }
        if (typeof E2ECrypto === 'undefined' || !E2ECrypto.decryptWithPassword) {
            if (recoverStatusEl) { recoverStatusEl.textContent = '❌ Crypto module missing'; recoverStatusEl.style.color = '#f44336'; setTimeout(function() { recoverStatusEl.textContent = ''; }, 4000); }
            if (errorEl) { errorEl.textContent = 'Crypto module not loaded. Please refresh the page.'; errorEl.style.display = 'block'; }
            return;
        }
        const decrypted = E2ECrypto.decryptWithPassword(data.encrypted_friend_code, password, data.salt, data.nonce);
        if (!decrypted) {
            if (errorEl) { errorEl.textContent = 'Wrong password or corrupted data. Cannot decrypt friend code.'; errorEl.style.display = 'block'; }
            if (!errorEl) { alert('Wrong password or corrupted data. Cannot decrypt friend code.'); }
            return;
        }
        // Update status indicator
        if (recoverStatusEl) { recoverStatusEl.textContent = '✅ Recovered from server'; recoverStatusEl.style.color = '#4caf50'; setTimeout(function() { recoverStatusEl.textContent = ''; }, 3000); }
        
        // Success — store and update UI
        myFriendCode = decrypted;
        localStorage.setItem('e2e_friend_code', myFriendCode);
        const el = document.getElementById('my-friend-code');
        if (el) {
            el.dataset.value = myFriendCode;
            el.dataset.visible = '0';
            el.textContent = '••••••••••••••••';
        }
        if (successEl) { successEl.textContent = 'Friend code recovered successfully! It is now stored locally.'; successEl.style.display = 'block'; }
        if (errorEl) errorEl.style.display = 'none';
        // Close modal if visible
        var fcModal = document.getElementById('friend-code-password-modal');
        if (fcModal && fcModal.style.display !== 'none') {
            setTimeout(function () { fcModal.style.display = 'none'; }, 2000);
        }
    } catch (e) {
        if (recoverStatusEl) { recoverStatusEl.textContent = '❌ Failed to fetch friend code'; recoverStatusEl.style.color = '#f44336'; setTimeout(function() { recoverStatusEl.textContent = ''; }, 4000); }
        if (errorEl) { errorEl.textContent = 'Network error. Is the server running?'; errorEl.style.display = 'block'; }
        if (!errorEl) { alert('Network error. Is the server running?'); }
    }
}

async function handleFriendCodeRegenerate(preverifiedPw) {
    const input = document.getElementById('fc-password-input');
    const errorEl = document.getElementById('fc-password-error');
    const successEl = document.getElementById('fc-password-success');
    var regenStatusEl = document.getElementById('friend-code-status');
    // Use pre-verified password if provided, otherwise verify now
    var password = preverifiedPw || '';
    if (!password) {
        password = await verifyStoredPassword();
    }
    if (!password) {
        password = input ? input.value.trim() : '';
    }
    if (!password) {
        if (errorEl) { errorEl.textContent = 'Please enter your password to authorize regeneration.'; errorEl.style.display = 'block'; }
        if (successEl) successEl.style.display = 'none';
        return;
    }
    if (regenStatusEl) regenStatusEl.textContent = '';
    if (!confirm('Are you sure? Your old friend code will stop working immediately. Anyone who had it will no longer be able to send you friend requests.')) return;
    if (errorEl) errorEl.style.display = 'none';
    if (successEl) successEl.style.display = 'none';
    // Show loading state
    if (regenStatusEl) { regenStatusEl.textContent = '⏳ Generating new friend code...'; regenStatusEl.style.color = '#888'; }
    try {
        // Generate a new friend code client-side
        var newCode = generateCode(8);
        if (regenStatusEl) { regenStatusEl.textContent = '⏳ Encrypting...'; }
        // Encrypt it with the password (same as key escrow encryption)
        if (typeof E2ECrypto === 'undefined' || !E2ECrypto.encryptWithPassword) {
            if (regenStatusEl) { regenStatusEl.textContent = '❌ Crypto module missing'; regenStatusEl.style.color = '#f44336'; setTimeout(function() { regenStatusEl.textContent = ''; }, 4000); }
            if (errorEl) { errorEl.textContent = 'Crypto module not loaded. Please refresh the page.'; errorEl.style.display = 'block'; }
            if (!errorEl) { alert('Crypto module not loaded. Please refresh the page.'); }
            return;
        }
        var encrypted = E2ECrypto.encryptWithPassword(newCode, password);
        if (!encrypted || !encrypted.encrypted_private_key || !encrypted.salt || !encrypted.nonce) {
            if (regenStatusEl) { regenStatusEl.textContent = '❌ Encryption failed'; regenStatusEl.style.color = '#f44336'; setTimeout(function() { regenStatusEl.textContent = ''; }, 4000); }
            if (errorEl) { errorEl.textContent = 'Encryption failed. Please try again.'; errorEl.style.display = 'block'; }
            if (!errorEl) { alert('Encryption failed. Please try again.'); }
            return;
        }
        if (regenStatusEl) { regenStatusEl.textContent = '⏳ Uploading to server...'; }
        // Send to server with password for verification
        const res = await authFetch('/api/friend-code/regen-with-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                password: password,
                friend_code: newCode,
                encrypted_friend_code: encrypted.encrypted_private_key,
                salt: encrypted.salt,
                nonce: encrypted.nonce
            })
        });
        const data = await res.json();
        if (!res.ok) {
            if (regenStatusEl) { regenStatusEl.textContent = '❌ ' + (data.error || 'Server rejected'); regenStatusEl.style.color = '#f44336'; setTimeout(function() { regenStatusEl.textContent = ''; }, 4000); }
            if (errorEl) { errorEl.textContent = data.error || 'Failed to regenerate friend code. Wrong password?'; errorEl.style.display = 'block'; }
            if (!errorEl) { alert(data.error || 'Failed to regenerate friend code.'); }
            return;
        }
        if (regenStatusEl) { regenStatusEl.textContent = '✅ New code generated!'; regenStatusEl.style.color = '#4caf50'; setTimeout(function() { regenStatusEl.textContent = ''; }, 3000); }
        // Success — store and update UI
        myFriendCode = newCode;
        localStorage.setItem('e2e_friend_code', myFriendCode);
        const el = document.getElementById('my-friend-code');
        if (el) {
            el.dataset.value = myFriendCode;
            el.dataset.visible = '0';
            el.textContent = '••••••••••••••••';
        }
        if (successEl) { successEl.textContent = 'New friend code generated and saved!'; successEl.style.display = 'block'; }
        if (errorEl) errorEl.style.display = 'none';
        // Close modal if visible
        var fcModal = document.getElementById('friend-code-password-modal');
        if (fcModal && fcModal.style.display !== 'none') {
            setTimeout(function () { fcModal.style.display = 'none'; }, 2000);
        }
    } catch (e) {
        if (errorEl) { errorEl.textContent = 'Network error. Is the server running?'; errorEl.style.display = 'block'; }
        if (!errorEl) { alert('Network error. Is the server running?'); }
    }
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
}function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
}

// Get a contrasting glow color that ensures the display name is always visible
// against any background. Generates a text-shadow glow with the complementary/inverted color.
function getContrastGlowColor(hexColor) {
    if (!hexColor) return 'rgba(0,0,0,0.8)';
    // Remove # if present
    var color = hexColor.replace('#', '');
    // Handle short hex
    if (color.length === 3) color = color[0] + color[0] + color[1] + color[1] + color[2] + color[2];
    if (color.length !== 6) return 'rgba(0,0,0,0.8)';
    
    var r = parseInt(color.substr(0, 2), 16);
    var g = parseInt(color.substr(2, 2), 16);
    var b = parseInt(color.substr(4, 2), 16);
    
    // Compute perceived luminance (relative brightness using sRGB coefficients)
    var luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    
    // Smooth proportional transition from white to black glow based on luminance.
    // Instead of a hard binary cutoff at 0.5 (which causes jarring flips),
    // we blend continuously across the whole luminance range with a tighter
    // transition zone for more pronounced contrast:
    //
    //   Very dark (lum < 0.35) → pure white glow, strong opacity
    //   Dark-mid  (0.35 - 0.5) → white → light gray, moderate opacity
    //   Mid-range (0.5 - 0.65) → darker gray, moderate opacity
    //   Light-mid (0.65 - 0.9) → dark gray → black, strong opacity
    //   Very light (lum > 0.9)  → pure black glow, strong opacity
    //
    // This ensures the glow contrast is always proportional to how much
    // contrast the text actually needs. The transition is tighter so
    // mid-range colors get a more distinct glow that doesn't flip too soon.
    
    // Map luminance to a blend factor: 0 = white, 1 = black
    // Spread the transition from 0.35 to 0.9 for a late, tight ramp
    // that keeps the glow strongly contrasting before flipping.
    var t = (luminance - 0.35) / 0.55;
    t = Math.max(0, Math.min(1, t)); // Clamp to [0, 1]
    
    // Apply smoothstep (cubic Hermite) for a more natural S-curve
    // Gentle at the ends, steeper in the middle
    t = t * t * (3 - 2 * t);
    
    // Interpolate glow color: 255 (white) → 0 (black)
    var glowVal = Math.round(255 * (1 - t));
    
    // Opacity: stronger at luminance extremes where the text needs
    // more help being visible against varied backgrounds, softer in
    // the mid-range where the text is already moderately visible.
    var distanceFromMid = Math.abs(luminance - 0.5) * 2; // 0 at 0.5, 1 at extremes
    var opacity = Math.min(0.88, 0.50 + 0.38 * distanceFromMid);
    
    return 'rgba(' + glowVal + ',' + glowVal + ',' + glowVal + ',' + opacity.toFixed(2) + ')';
}

// Generate a CSS text-shadow value for the airbrush-like glow effect
// If borderColor is provided, use it directly; otherwise auto-calculate from hexColor
function getDisplayNameTextShadow(hexColor, borderColor) {
    var glowColor = borderColor || getContrastGlowColor(hexColor);
    // Multi-layer shadow for a soft airbrush-like glow
    return '0 0 4px ' + glowColor + ', 0 0 8px ' + glowColor + ', 0 0 16px ' + glowColor;
}

// Update existing message DOM elements (display-name styles and avatars) when a user's
// profile changes (color, glow, display name, profile pic), without reloading all messages.
function updateExistingMessageStyles(userId) {
    if (!userId) return;
    var cache = userDisplayNameCache[userId];
    if (!cache) return;
    var color = cache.username_color || null;
    var borderColor = cache.username_border_color || null;
    var picFileId = cache.profile_picture_file_id || null;
    var displayName = cache.display_name || null;

    // Update all message headers with this sender_id
    document.querySelectorAll('.message[data-sender-id="' + userId + '"]').forEach(function (msgEl) {
        var nameEl = msgEl.querySelector('.display-name');
        if (nameEl) {
            if (color) {
                nameEl.style.color = color;
                nameEl.style.textShadow = getDisplayNameTextShadow(color, borderColor);
            }
            if (displayName) {
                nameEl.textContent = displayName;
            }
        }
        // Update avatar if profile pic changed
        var avatarEl = msgEl.querySelector('.avatar');
        if (avatarEl && picFileId) {
            var cacheKey = userId + ':' + picFileId;
            var existingPic = profilePicCache[cacheKey];
            if (existingPic) {
                // Replace avatar content with img
                avatarEl.setAttribute('data-profile-pic', cacheKey);
                avatarEl.removeAttribute('data-profile-pic-load');
                avatarEl.innerHTML = '<img class="avatar-img" src="' + existingPic + '" alt="" data-profile-pic="' + cacheKey + '">';
            } else {
                // Set up async loading
                avatarEl.setAttribute('data-profile-pic-load', cacheKey);
                if (!avatarEl.querySelector('img')) {
                    avatarEl.innerHTML = (displayName || nameEl?.textContent || '?').charAt(0).toUpperCase();
                }
                getProfilePicUrl(picFileId, userId);
            }
        } else if (avatarEl && !picFileId) {
            // Remove pic, show initial only
            avatarEl.removeAttribute('data-profile-pic');
            avatarEl.removeAttribute('data-profile-pic-load');
            var initial = (nameEl ? nameEl.textContent : '?').charAt(0).toUpperCase();
            avatarEl.innerHTML = initial;
        }
    });
}

// Generate 10 contrasting border/glow color options based on a base color
function generateBorderGlowOptions(baseColor) {
    if (!baseColor) return [];
    var color = baseColor.replace('#', '');
    if (color.length === 3) color = color[0] + color[0] + color[1] + color[1] + color[2] + color[2];
    if (color.length !== 6) return [{ hex: 'rgba(0,0,0,0.8)', name: 'Dark Ink' }];
    
    var r = parseInt(color.substr(0, 2), 16);
    var g = parseInt(color.substr(2, 2), 16);
    var b = parseInt(color.substr(4, 2), 16);
    var luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    
    var options = [];
    
    // For light colors, generate dark glow options; for dark colors, generate light options
    if (luminance > 0.5) {
        // Light base color → dark glow options
        options = [
            { hex: 'rgba(0,0,0,0.85)', name: 'Deep Shadow' },
            { hex: 'rgba(0,0,0,0.65)', name: 'Soft Shadow' },
            { hex: 'rgba(20,20,30,0.8)', name: 'Midnight' },
            { hex: 'rgba(10,10,20,0.75)', name: 'Charcoal' },
            { hex: 'rgba(33,33,33,0.7)', name: 'Slate' },
            { hex: 'rgba(0,20,40,0.7)', name: 'Deep Blue' },
            { hex: 'rgba(40,0,20,0.6)', name: 'Plum' },
            { hex: 'rgba(20,40,0,0.65)', name: 'Forest' },
            { hex: 'rgba(60,30,0,0.6)', name: 'Warm Brown' },
            { hex: 'rgba(80,80,80,0.5)', name: 'Smoke' }
        ];
    } else {
        // Dark base color → light glow options
        options = [
            { hex: 'rgba(255,255,255,0.85)', name: 'Bright Glow' },
            { hex: 'rgba(255,255,255,0.65)', name: 'Soft Glow' },
            { hex: 'rgba(240,240,255,0.7)', name: 'Moonlight' },
            { hex: 'rgba(200,220,255,0.6)', name: 'Ice' },
            { hex: 'rgba(255,240,200,0.65)', name: 'Warm Light' },
            { hex: 'rgba(220,255,220,0.6)', name: 'Pale Green' },
            { hex: 'rgba(255,200,220,0.55)', name: 'Blush' },
            { hex: 'rgba(200,200,255,0.65)', name: 'Lavender' },
            { hex: 'rgba(255,220,180,0.6)', name: 'Peach' },
            { hex: 'rgba(220,240,255,0.7)', name: 'Sky' }
        ];
    }
    return options;
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

/**
 * Extract the raw message text from a .text div, preserving emoji shortcodes (:name:)
 * that are stored in the alt attributes of emoji <img> elements.
 * Also strips the time-hover span from the result.
 */
function extractRawMessageText(textEl) {
    let result = '';
    for (const node of textEl.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            result += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.classList && node.classList.contains('time-hover')) {
                // Skip time-hover spans
                continue;
            } else if (node.classList && node.classList.contains('emoji-inline')) {
                // Use alt text which contains :emoji_name:
                result += node.getAttribute('alt') || '';
            } else {
                result += node.textContent || '';
            }
        }
    }
    return result;
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

// Same multi-chunk decryption as downloadAndDecryptFile, but accepts Uint8Array key directly
async function downloadAndDecryptStickerData(fileId, fileKey, mimeType) {
    const res = await authFetch('/api/files/' + fileId + '/download');
    if (!res.ok) throw new Error('Failed to download');

    const data = new Uint8Array(await res.arrayBuffer());
    if (data.length === 0) throw new Error('Empty file data');

    const CHUNK_PLAINTEXT = 65536;
    const CHUNK_ENCRYPTED_FULL = CHUNK_PLAINTEXT + 16 + 24; // 65576
    const totalChunks = Math.ceil(data.length / CHUNK_ENCRYPTED_FULL);

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

    return new Blob([result], { type: mimeType || 'image/png' });
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

function downloadBlobAs(url, filename, mimeType) {
    const a = document.createElement('a');
    a.href = url;
    const ext = mimeType ? mimeType.split('/')[1] || 'png' : 'png';
    a.download = filename + '.' + ext;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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

// ===== Sticker / Emoji / GIF Panel =====

const EMOJI_DATA = [
    { cat: 'Smileys', emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🫢','🫣','🤫','🤔','🫡','🤐','🤨','😐','😑','😶','🫥','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥵','🥶','🥴','😵','🤯','🥳','🥸','😎','🤓','🧐','😕','🫤','😟','🙁','😮','😯','😲','😳','🥺','🥹','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖'] },
    { cat: 'Gestures', emojis: ['👋','🤚','🖐️','✋','🖖','🫱','🫲','🫳','🫴','👌','🤌','🤏','✌️','🤞','🫰','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','🫵','👍','👎','✊','👊','🤛','🤜','👏','🙌','🫶','👐','🤲','🤝','🙏'] },
    { cat: 'Hearts', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟'] },
    { cat: 'Animals', emojis: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄️','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🐣','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🪱','🐛','🦋','🐌','🐞','🐜','🪳','🦂','🕷️','🐍','🦎','🐢','🐊'] },
    { cat: 'Food', emojis: ['🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🥑','🍆','🥦','🥬','🌶️','🫑','🌽','🥕','🫒','🧄','🧅','🥔','🍠','🫘','🥐','🍞','🥖','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🍔','🍟','🍕','🫓','🥪','🌮','🌯','🫔','🥙','🧆','🥚','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥠','🥮','🍢','🍡','🍧','🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🧂','🥤','🧋','🧃','🍼','🥛','☕','🫖','🍵','🍶','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🧉','🍾'] },
    { cat: 'Activities', emojis: ['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🪀','🏓','🏸','🏒','🥅','⛳','🪁','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷','⛸️','🥌','🎿','🎯','🪃','🏆','🥇','🥈','🥉','🏅','🎖️','🏵️','🎗️','🎫','🎟️','🎪','🤹','🎭','🎨','🧵','🧶','🪡'] },
    { cat: 'Travel', emojis: ['🚗','🚕','🚌','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🛵','🏍️','🛺','🚲','🛴','🛹','🛼','🚁','✈️','🛩️','🚀','🛸','🛰️','🚢','⛵','🛶','🗺️','🧭','🏔️','⛰️','🌋','🗻','🏕️','🏖️','🏜️','🏝️','🏞️','🏟️','🏛️','🏗️','🧱','🪨','🪵','🛖','🏠','🏡','🏢','🏣','🏤','🏥','🏦','🏨','🏩','🏪','🏫','🏬','🏭','🏯','🏰','💒','🗼','🗽','⛪','🕌','🛕','🕍','⛩️','🕋','⛲','⛺','🌁','🌃','🏙️','🌄','🌅','🌆','🌇','🌉','🌌','🎆','🎇','🌠','🎇'] },
    { cat: 'Objects', emojis: ['⌚','📱','💻','⌨️','🖥️','🖨️','🖱️','🖲️','🕹️','🗜️','💽','💾','💿','📀','📼','📷','📸','📹','🎥','📽️','🎞️','📞','☎️','📟','📠','📺','📻','🎙️','🎚️','🎛️','🧭','⏱️','⏲️','⏰','🕰️','⌛','⏳','📡','🔋','🔌','💡','🔦','🕯️','🪔','🧯','🛢️','💸','💵','💴','💶','💷','🪙','💰','💳','💎','⚖️','🪜','🧰','🪛','🔧','🔨','⚒️','🛠️','⛏️','🪚','🔩','⚙️','🪤','🧱','⛓️','🧲','🔫','💣','🧨','🪓','🔪','🗡️','⚔️','🛡️','🚬','⚰️','🪦','⚱️','🏺','🔮','📿','🧿','🪬','💈','⚗️','🔭','🔬','🕳️','🩹','🩺','💊','💉','🩸','🧬','🦠','🧫','🧪','🌡️','🧹','🪠','🧺','🧻','🚽','🚰','🚿','🛁','🛀','🧼','🪥','🪒','🧽','🪣','🧴','🛎️','🔑','🗝️','🚪','🪑','🛋️','🛏️','🛌','🧸','🪆','🖼️','🪞','🪟','🛍️','🛒','🎁','🎈','🎏','🎀','🪄','🪅','🎊','🎉','🎎','🏮','🎐','🧧','✉️','📩','📨','📧','💌','📥','📤','📦','🏷️','🪧','📪','📫','📬','📭','📮','📯','📜','📃','📄','📑','🧾','📊','📈','📉','🗒️','🗓️','📆','📅','🗑️','📇','🗃️','🗳️','🗄️','📋','📁','📂','🗂️','🗞️','📰','📓','📔','📒','📕','📖','📗','📘','📙','📚','📚','🔬','🔭','📡'] },
    { cat: 'Symbols', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉️','☸️','✡️','🔯','🕎','☯️','☦️','🛐','⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆔','⚛️','🉑','☢️','☣️','📴','📳','🈶','🈚','🈸','🈺','🈷️','✴️','🆚','💮','🉐','㊙️','㊗️','🈴','🈵','🈹','🈲','🅰️','🅱️','🆎','🆑','🅾️','🆘','❌','⭕','🛑','⛔','📛','🚫','💯','💢','♨️','🚷','🚯','🚳','🚱','🔞','📵','🚭','❗','❕','❓','❔','‼️','⁉️','🔅','🔆','〽️','⚠️','🚸','🔱','⚜️','🔰','♻️','✅','🈯','💹','❇️','✳️','❎','🌐','💠','Ⓜ️','🌀','💤','🏧','🚾','♿','🅿️','🛗','🈳','🈂️','🛂','🛃','🛄','🛅','🚹','🚺','🚼','⚧️','🚻','🚮','🎦','📶','🈁','🔣','ℹ️','🔤','🔡','🔠','🆖','🆗','🆙','🆒','🆕','🆓','0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟','🔢','#️⃣','*️⃣','⏏️','▶️','⏸️','⏯️','⏹️','⏺️','⏭️','⏮️','⏩','⏪','⏫','⏬','◀️','🔼','🔽','➡️','⬅️','⬆️','⬇️','↗️','↘️','↙️','↖️','↕️','↔️','↪️','↩️','⤴️','⤵️','🔀','🔁','🔂','🔄','🔃','🎵','🎶','➕','➖','➗','✖️','🟰','♾️','💲','💱','™️','©️','®️','〰️','➰','➿','🔚','🔙','🔛','🔝','🔜','✔️','☑️','🔘','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤','🔺','🔻','🔸','🔶','🔷','🔳','🔲','▪️','▫️','◾','◽','◼️','◻️','🟥','🟧','🟨','🟩','🟦','🟪','⬛','⬜','🟫','🔈','🔇','🔉','🔊','🔔','🔕','📣','📢'] },
];

let stickerPanelOpen = false;
let activePanelTab = 'emojis';
let userStickersCache = []; // cached list of user's stickers from /api/users/me/stickers

function setupStickerPanel() {
    const panel = document.getElementById('sticker-panel');
    const btn = document.getElementById('sticker-btn');
    if (!panel || !btn) return;

    btn.addEventListener('click', () => {
        stickerPanelOpen = !stickerPanelOpen;
        panel.style.display = stickerPanelOpen ? 'flex' : 'none';
        if (stickerPanelOpen) renderPanelTab(activePanelTab);
    });

    document.addEventListener('click', (e) => {
        if (stickerPanelOpen && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
            stickerPanelOpen = false;
            panel.style.display = 'none';
        }
    });

    panel.querySelectorAll('.sticker-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            panel.querySelectorAll('.sticker-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            activePanelTab = tab.dataset.tab;
            renderPanelTab(activePanelTab);
        });
    });

    // Setup sticker upload modal
    setupStickerUploadModal();
}

function renderPanelTab(tab) {
    const content = document.getElementById('sticker-panel-content');
    if (!content) return;
    content.innerHTML = '';

    if (tab === 'emojis') renderEmojiGrid(content);
    else if (tab === 'stickers') renderStickerGrid(content);
    else if (tab === 'gifs') renderGifPanel(content);
    else if (tab === 'upload') renderUploadStickerPanel(content);
}

function renderEmojiGrid(container) {
    container.innerHTML = '';

    // Show custom uploaded emojis if available
    const emojiNames = emojiCache ? Object.keys(emojiCache) : [];
    if (emojiNames.length > 0) {
        const uploadsSection = document.createElement('div');
        uploadsSection.style.cssText = 'margin-bottom:8px;padding:8px;';
        const header = document.createElement('div');
        header.style.cssText = 'font-size:12px;color:#888;font-weight:600;padding:4px 0 8px;text-transform:uppercase;';
        header.textContent = 'Custom Emojis';
        uploadsSection.appendChild(header);

        const grid = document.createElement('div');
        grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-start;';

        emojiNames.forEach(name => {
            const cacheEntry = emojiCache[name];
            const item = document.createElement('div');
            item.className = 'emoji-item emoji-item-custom';
            item.dataset.emojiName = name;
            item.style.cssText = 'width:36px;height:36px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:6px;transition:background 0.15s;font-size:14px;overflow:hidden;position:relative;';
            item.title = ':' + name + ':';

            // Delete button (shown on hover)
            const delBtn = document.createElement('button');
            delBtn.className = 'emoji-del-btn';
            delBtn.textContent = '×';
            delBtn.title = 'Delete emoji :' + name + ':';
            delBtn.style.cssText = 'position:absolute;top:0;right:0;width:16px;height:16px;background:#c62828;color:#fff;border:none;border-radius:0 6px 0 6px;font-size:11px;line-height:1;cursor:pointer;display:none;z-index:2;padding:0;';
            delBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm('Delete emoji :' + name + ':?')) return;
                if (cacheEntry && cacheEntry.id) {
                    try {
                        await authFetch('/api/users/me/stickers/' + cacheEntry.id, { method: 'DELETE' });
                    } catch (_) {}
                }
                // Clean up blob URL
                if (emojiBlobCache[name]) {
                    URL.revokeObjectURL(emojiBlobCache[name]);
                    delete emojiBlobCache[name];
                }
                delete emojiCache[name];
                renderEmojiGrid(container);
            });
            item.appendChild(delBtn);

            // Show delete button on hover
            item.addEventListener('mouseenter', () => { delBtn.style.display = 'block'; });
            item.addEventListener('mouseleave', () => { delBtn.style.display = 'none'; });

            // Try to load the emoji preview (use cached blob if available)
            if (cacheEntry) {
                if (emojiBlobCache[name]) {
                    const img = document.createElement('img');
                    img.src = emojiBlobCache[name];
                    img.alt = name;
                    img.style.cssText = 'width:28px;height:28px;object-fit:contain;';
                    item.appendChild(img);
                } else {
                    let pickerKey = null;
                    if (cacheEntry.file_key) {
                        try { pickerKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(cacheEntry.file_key)); } catch (_) {}
                    }
                    if (!pickerKey) {
                        const identity = E2ECrypto.getIdentityKeyPair();
                        if (identity) pickerKey = identity.privateKey;
                    }
                    if (pickerKey && cacheEntry.file_id) {
                        downloadAndDecryptStickerData(cacheEntry.file_id, pickerKey, cacheEntry.mime_type || 'image/png')
                            .then(blob => {
                                const url = URL.createObjectURL(blob);
                                emojiBlobCache[name] = url;
                                const img = document.createElement('img');
                                img.src = url;
                                img.alt = name;
                                img.style.cssText = 'width:28px;height:28px;object-fit:contain;';
                                const existingImg = item.querySelector('img');
                                if (!existingImg) {
                                    item.appendChild(img);
                                }
                            })
                            .catch(() => {
                                if (!item.querySelector('img')) item.textContent = '?';
                            });
                    } else {
                        if (!item.querySelector('img')) item.textContent = '?';
                    }
                }
            } else {
                if (!item.querySelector('img')) item.textContent = '?';
            }

            item.addEventListener('click', () => {
                insertEmojiIntoInput(':' + name + ':');
            });
            grid.appendChild(item);
        });

        uploadsSection.appendChild(grid);
        container.appendChild(uploadsSection);
    }

    // Built-in Unicode emojis
    const grid = document.createElement('div');
    grid.className = 'emoji-grid';

    EMOJI_DATA.forEach(group => {
        const header = document.createElement('div');
        header.style.cssText = 'grid-column:1/-1;font-size:12px;color:#888;font-weight:600;padding:8px 0 4px;text-transform:uppercase;';
        header.textContent = group.cat;
        grid.appendChild(header);

        group.emojis.forEach(emoji => {
            const item = document.createElement('div');
            item.className = 'emoji-item';
            item.textContent = emoji;
            item.title = emoji;
            item.addEventListener('click', () => insertEmojiIntoInput(emoji));
            grid.appendChild(item);
        });
    });

    container.appendChild(grid);
}

function insertEmojiIntoInput(emoji) {
    const input = document.getElementById('message-input');
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    input.value = input.value.substring(0, start) + emoji + input.value.substring(end);
    input.selectionStart = input.selectionEnd = start + emoji.length;
    input.focus();
}

// Load user's own stickers from /api/users/me/stickers
async function loadUserStickers() {
    try {
        const res = await authFetch('/api/users/me/stickers');
        if (res.ok) {
            userStickersCache = await res.json();
            // Decrypt encrypted file_keys using user's identity key
            const identity = E2ECrypto.getIdentityKeyPair();
            if (identity) {
                for (const s of userStickersCache) {
                    if (s.file_key) {
                        var decrypted = E2ECrypto.decodeEncryptedFileKey(s.file_key, identity.privateKey);
                        if (decrypted) s.file_key = decrypted;
                    }
                }
            }
        } else {
            userStickersCache = [];
        }
    } catch (e) {
        userStickersCache = [];
    }
    return userStickersCache;
}

async function loadEmojiCache() {
    try {
        const res = await authFetch('/api/users/me/stickers');
        if (res.ok) {
            const stickers = await res.json();
            // Filter for emoji entries (mime_type === 'image/emoji')
            const emojis = stickers.filter(s => s.mime_type === 'image/emoji');
            const identity = E2ECrypto.getIdentityKeyPair();
            const cache = {};
            for (const s of emojis) {
                var fileKey = s.file_key || null;
                if (fileKey && identity) {
                    var decrypted = E2ECrypto.decodeEncryptedFileKey(fileKey, identity.privateKey);
                    if (decrypted) fileKey = decrypted;
                }
                cache[s.sticker_name] = {
                    id: s.id,
                    file_id: s.file_id,
                    file_key: fileKey,
                    mime_type: s.mime_type,
                };
            }
            emojiCache = cache;
        } else {
            emojiCache = {};
        }
    } catch (e) {
        emojiCache = {};
    }
    return emojiCache;
}

// Collect shareable refs ({name, file_id, file_key, mime_type}) for every
// :name: shortcode in `text` that exists in the local emoji registry. Only
// entries with a shareable file_key are included, so recipients can decrypt them.
function collectEmojiRefs(text) {
    if (!emojiCache || Object.keys(emojiCache).length === 0) return [];
    const parts = text.split(/:([^:]+):/);
    if (parts.length <= 1) return [];
    const refs = [];
    const seen = {};
    for (let i = 1; i < parts.length; i += 2) {
        const name = parts[i];
        if (seen[name]) continue;
        const entry = emojiCache[name];
        if (entry && entry.file_id && entry.file_key) {
            seen[name] = true;
            refs.push({
                name: name,
                file_id: entry.file_id,
                file_key: entry.file_key,
                mime_type: entry.mime_type || 'image/png',
            });
        }
    }
    return refs;
}

/**
 * Collect emoji refs from both the local emoji cache AND from rendered
 * &lt;img&gt; elements in the message DOM. This ensures that when a user edits
 * or forwards a message containing an emoji they don't own (not in their
 * local cache), the emoji metadata (file_id, file_key) is still extracted
 * from the already-rendered image tags and included in the payload.
 * @param {Element} msgEl - The .message DOM element containing rendered emoji images
 * @param {string} text - The text content with :emoji_name: shortcodes
 * @returns {Array} Array of emoji ref objects {name, file_id, file_key, mime_type}
 */
function collectEmojiRefsFromMsgEl(msgEl, text) {
    // Step 1: Get refs from the local emoji cache (standard approach)
    const cacheRefs = collectEmojiRefs(text);
    const seen = {};
    const refs = [];
    for (const ref of cacheRefs) {
        seen[ref.name] = true;
        refs.push(ref);
    }

    // Step 2: For emoji names in the text that weren't in the local cache,
    // look for rendered &lt;img&gt; elements in the message DOM that already
    // display those emojis. Extract file_id and file_key from the src URL.
    const parts = text.split(/:([^:]+):/);
    if (parts.length > 1 && msgEl) {
        const emojiImgs = msgEl.querySelectorAll('.text .emoji-inline');
        for (const img of emojiImgs) {
            const alt = img.getAttribute('alt') || '';
            const match = alt.match(/^:([^:]+):$/);
            if (match) {
                const name = match[1];
                if (!seen[name] && text.includes(':' + name + ':')) {
                    // Parse the src URL to extract file_id and file_key
                    // src format: /api/emojis/{file_id}/{file_key}
                    const src = img.getAttribute('src') || '';
                    const srcParts = src.split('/');
                    if (srcParts.length >= 2) {
                        const fileId = decodeURIComponent(srcParts[srcParts.length - 2]);
                        const fileKey = decodeURIComponent(srcParts[srcParts.length - 1]);
                        if (fileId && fileKey && fileId !== 'null' && fileKey !== 'null') {
                            seen[name] = true;
                            refs.push({
                                name: name,
                                file_id: fileId,
                                file_key: fileKey,
                                mime_type: 'image/png',
                            });
                        }
                    }
                }
            }
        }
    }

    return refs;
}

// Resolve a custom-emoji entry by shortcode. Per-message refs (received from
// other users) take priority over the local registry so shared emojis render
// for recipients who never uploaded them.
function getEmojiEntry(name, extraEmojis) {
    if (extraEmojis && extraEmojis[name]) return extraEmojis[name];
    if (emojiCache && emojiCache[name]) return emojiCache[name];
    return null;
}

function renderEmojiText(text, extraEmojis) {
    const hasKnown = (emojiCache && Object.keys(emojiCache).length > 0) ||
        (extraEmojis && Object.keys(extraEmojis).length > 0);
    if (!hasKnown) return escapeHtml(text);

    // Split by :name: patterns (any characters except colon)
    const parts = text.split(/:([^:]+):/);
    if (parts.length <= 1) return escapeHtml(text);

    // Determine if text is emoji-only (no non-emoji text content)
    let hasTextContent = false;
    for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0 && parts[i].trim()) {
            hasTextContent = true;
            break;
        }
    }
    const emojiOnly = !hasTextContent && parts.length > 1;
    const emojiClass = emojiOnly ? 'emoji-inline emoji-alone' : 'emoji-inline';

    let html = '';
    for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
            const name = parts[i];
            const entry = getEmojiEntry(name, extraEmojis);
            if (entry) {
                if (emojiBlobCache[name]) {
                    html += '<img class="' + emojiClass + '" src="' + emojiBlobCache[name] + '" alt=":' + name + ':" title=":' + name + ':">';
                } else {
                    const spanClass = emojiOnly ? 'emoji-loading emoji-alone' : 'emoji-loading';
                    html += '<span class="' + spanClass + '" data-emoji-name="' + escapeHtml(name) + '">:' + escapeHtml(name) + ':</span>';
                    loadEmojiBlob(name, extraEmojis);
                }
            } else {
                html += ':' + escapeHtml(name) + ':';
            }
        } else {
            html += escapeHtml(parts[i]);
        }
    }
    return html;
}

async function loadEmojiBlob(name, extraEmojis) {
    const entry = getEmojiEntry(name, extraEmojis);
    if (!entry || !entry.file_id || emojiBlobCache[name]) return;
    try {
        // Prefer a stored shareable file_key; fall back to own identity key
        // (legacy emoji uploads that were encrypted with the identity key).
        let fileKey;
        if (entry.file_key) {
            fileKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(entry.file_key));
        } else {
            const identity = E2ECrypto.getIdentityKeyPair();
            if (!identity) return;
            fileKey = identity.privateKey;
        }
        const mime = entry.mime_type || 'image/png';
        const blob = await downloadAndDecryptStickerData(entry.file_id, fileKey, mime);
        const url = URL.createObjectURL(blob);
        emojiBlobCache[name] = url;
        // Replace all loading placeholders in the DOM. Preserve the emoji-alone
        // (large) class so a lone emoji doesn't shrink once it finishes loading.
        document.querySelectorAll('.emoji-loading[data-emoji-name="' + name + '"]').forEach(el => {
            const img = document.createElement('img');
            img.className = el.classList.contains('emoji-alone') ? 'emoji-inline emoji-alone' : 'emoji-inline';
            img.src = url;
            img.alt = ':' + name + ':';
            img.title = ':' + name + ':';
            el.replaceWith(img);
        });
    } catch (e) {
        console.warn('Failed to load emoji blob:', name, e);
    }
}

function renderStickerGrid(container) {
    loadUserStickers().then(stickers => {
        container.innerHTML = '';
        if (!stickers || stickers.length === 0) {
            container.innerHTML = '<div style="text-align:center;color:#888;padding:20px;font-size:13px;">No stickers yet. Use the + tab to upload one.</div>';
            return;
        }
        const searchBar = document.createElement('div');
        searchBar.style.cssText = 'padding:8px 12px;position:sticky;top:0;background:var(--bg-secondary);z-index:1;';
        searchBar.innerHTML = '<input type="text" id="sticker-search-input" placeholder="Search stickers..." style="width:100%;padding:6px 10px;border-radius:6px;border:1px solid #2a2a4a;background:#1a1a2e;color:#e0e0e0;font-size:12px;box-sizing:border-box;">';
        container.appendChild(searchBar);

        const grid = document.createElement('div');
        grid.className = 'sticker-grid';
        grid.id = 'user-sticker-grid';
        container.appendChild(grid);

        // Filter out GIFs — they have their own tab
        const nonGifStickers = stickers.filter(s => !/gif/i.test(s.mime_type));
        renderStickerItems(grid, nonGifStickers);

        document.getElementById('sticker-search-input')?.addEventListener('input', (e) => {
            const q = e.target.value.toLowerCase();
            const filtered = nonGifStickers.filter(s => s.sticker_name.toLowerCase().includes(q));
            grid.innerHTML = '';
            renderStickerItems(grid, filtered);
        });
    });
}

function renderStickerItems(grid, stickers) {
    stickers.forEach(sticker => {
        const item = document.createElement('div');
        item.className = 'sticker-grid-item';
        item.style.position = 'relative';
        item.title = sticker.sticker_name;

        const img = document.createElement('img');
        img.alt = sticker.sticker_name;
        img.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#1e1e1e;';
        (async () => {
            const identity = E2ECrypto.getIdentityKeyPair();
            if (!identity) return;
            const stickerKey = identity.privateKey;
            try {
                const blob = await downloadAndDecryptStickerData(sticker.file_id, stickerKey, sticker.mime_type || 'image/png');
                img.src = URL.createObjectURL(blob);
            } catch (_) {}
        })();

        // Delete button
        const delBtn = document.createElement('button');
        delBtn.innerHTML = '&#128465;';
        delBtn.title = 'Delete sticker';
        delBtn.style.cssText = 'position:absolute;top:2px;right:2px;width:20px;height:20px;border-radius:50%;background:rgba(244,67,54,0.85);color:#fff;border:none;font-size:11px;line-height:20px;text-align:center;cursor:pointer;display:none;z-index:2;padding:0;';
        delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm('Delete sticker "' + sticker.sticker_name + '"?')) return;
            try {
                const res = await authFetch('/api/users/me/stickers/' + sticker.id, { method: 'DELETE' });
                if (res.ok) item.remove();
            } catch (_) {}
        });
        item.appendChild(delBtn);
        item.addEventListener('mouseenter', () => delBtn.style.display = 'block');
        item.addEventListener('mouseleave', () => delBtn.style.display = 'none');

        item.appendChild(img);
        item.addEventListener('click', () => sendStickerMessage(sticker));
        grid.appendChild(item);
    });
}

function renderGifPanel(container) {
    // GIFs are just stickers with image/gif mime type - show user's GIF stickers
    const header = document.createElement('div');
    header.style.cssText = 'padding:8px 12px;font-size:12px;color:#888;';
    header.textContent = 'Your GIFs';
    container.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'gif-grid';
    container.appendChild(grid);

    loadUserStickers().then(stickers => {
        const gifs = stickers.filter(s => /gif/i.test(s.mime_type));
        if (gifs.length === 0) {
            grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#888;padding:20px;font-size:13px;">No GIFs yet. Upload one from the + tab.</div>';
            return;
        }
        gifs.forEach(sticker => {
            const item = document.createElement('div');
            item.className = 'gif-grid-item';
            item.style.position = 'relative';

            const img = document.createElement('img');
            img.alt = sticker.sticker_name;
            img.loading = 'lazy';
            (async () => {
                const identity = E2ECrypto.getIdentityKeyPair();
                if (!identity) return;
                const stickerKey = identity.privateKey;
                try {
                    const blob = await downloadAndDecryptStickerData(sticker.file_id, stickerKey, sticker.mime_type || 'image/gif');
                    img.src = URL.createObjectURL(blob);
                } catch (_) {}
            })();
            item.appendChild(img);

            // Delete button
            const delBtn = document.createElement('button');
            delBtn.innerHTML = '&#128465;';
            delBtn.title = 'Delete GIF';
            delBtn.style.cssText = 'position:absolute;top:2px;right:2px;width:20px;height:20px;border-radius:50%;background:rgba(244,67,54,0.85);color:#fff;border:none;font-size:11px;line-height:20px;text-align:center;cursor:pointer;display:none;z-index:2;padding:0;';
            delBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm('Delete "' + sticker.sticker_name + '"?')) return;
                try {
                    const res = await authFetch('/api/users/me/stickers/' + sticker.id, { method: 'DELETE' });
                    if (res.ok) item.remove();
                } catch (_) {}
            });
            item.appendChild(delBtn);
            item.addEventListener('mouseenter', () => delBtn.style.display = 'block');
            item.addEventListener('mouseleave', () => delBtn.style.display = 'none');

            item.addEventListener('click', () => sendStickerMessage(sticker));
            grid.appendChild(item);
        });
    });
}

function showStickerProgress(label, pct) {
    const container = document.getElementById('sticker-send-progress');
    const fill = document.getElementById('sticker-send-fill');
    const labelEl = container ? container.querySelector('.sticker-send-label') : null;
    if (!container || !fill) return;
    container.style.display = 'block';
    if (labelEl) labelEl.textContent = label || 'Sending sticker...';
    fill.style.width = Math.min(100, Math.max(0, pct)) + '%';
}

function hideStickerProgress() {
    const container = document.getElementById('sticker-send-progress');
    if (container) container.style.display = 'none';
}

function setStickerSendingCooldown(active) {
    isSendingSticker = active;
    // Visually disable the sticker grid items during send
    const panel = document.getElementById('sticker-panel');
    if (!panel) return;
    const grid = panel.querySelector('.sticker-grid, .gif-grid');
    if (grid) {
        grid.style.pointerEvents = active ? 'none' : '';
        grid.style.opacity = active ? '0.5' : '';
    }
}

async function sendStickerMessage(sticker) {
    if (!currentChannelId && !currentDmChannelId) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Cooldown: prevent sending another sticker while one is in progress
    if (isSendingSticker) return;

    setStickerSendingCooldown(true);
    showStickerProgress('Preparing...', 0);

    // If there's text in the input, combine it with the sticker
    const stickerInput = document.getElementById('message-input');
    const pendingText = stickerInput ? stickerInput.value.trim() : '';

    try {
        let filePayload;
        if (sticker.file_key) {
            // Optimized: reuse existing file — no need to download/re-encrypt/re-upload
            showStickerProgress('Sending...', 50);
            const payload = {
                type: 'sticker',
                file_id: sticker.file_id,
                sticker_name: sticker.sticker_name,
                mime_type: sticker.mime_type || 'image/png',
                file_key: sticker.file_key,
            };
            if (pendingText) payload.text = pendingText;
            filePayload = JSON.stringify(payload);
        } else {
            // Fallback for old stickers without file_key: download, decrypt, re-encrypt, re-upload
            showStickerProgress('Decrypting...', 5);
            const identity = E2ECrypto.getIdentityKeyPair();
            if (!identity) { console.error('sendStickerMessage: no identity key'); hideStickerProgress(); setStickerSendingCooldown(false); return; }
            const stickerKey = identity.privateKey;
            const stickerMime = sticker.mime_type || 'image/png';
            const decryptedBlob = await downloadAndDecryptStickerData(sticker.file_id, stickerKey, stickerMime);
            const decrypted = new Uint8Array(await decryptedBlob.arrayBuffer());

            showStickerProgress('Re-encrypting...', 15);
            const freshKey = E2ECrypto.generateFileKey();
            const freshKeyB64 = E2ECrypto.arrayBufferToBase64(freshKey);
            const mime = sticker.mime_type || 'image/png';

            showStickerProgress('Uploading...', 20);
            const initRes = await authFetch('/api/files/init', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ size: decrypted.length, mime })
            });
            if (!initRes.ok) { console.error('sendStickerMessage: init failed', await initRes.text()); hideStickerProgress(); setStickerSendingCooldown(false); return; }
            const { file_id: newFileId } = await initRes.json();

            const CHUNK_SIZE = 64 * 1024;
            const totalChunks = Math.ceil(decrypted.length / CHUNK_SIZE);
            for (let i = 0; i < totalChunks; i++) {
                const start = i * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, decrypted.length);
                const chunkData = decrypted.slice(start, end);
                const encryptedChunk = E2ECrypto.encryptFileChunk(freshKey, chunkData);
                const chunkRes = await authFetch('/api/files/' + newFileId + '/chunk/' + i, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/octet-stream' },
                    body: encryptedChunk
                });
                if (!chunkRes.ok) { console.error('sendStickerMessage: chunk ' + i + ' failed', await chunkRes.text()); hideStickerProgress(); setStickerSendingCooldown(false); return; }
                showStickerProgress('Uploading...', 20 + Math.round(70 * (i + 1) / totalChunks));
            }

            showStickerProgress('Finalizing...', 95);
            const completeRes = await authFetch('/api/files/' + newFileId + '/complete', { method: 'POST' });
            if (!completeRes.ok) { console.error('sendStickerMessage: complete failed', await completeRes.text()); hideStickerProgress(); setStickerSendingCooldown(false); return; }

            const fallbackPayload = {
                type: 'sticker',
                file_id: newFileId,
                sticker_name: sticker.sticker_name,
                mime_type: mime,
                file_key: freshKeyB64,
            };
            if (pendingText) fallbackPayload.text = pendingText;
            filePayload = JSON.stringify(fallbackPayload);
        }

        // Clear input after sending combined message
        if (pendingText && stickerInput) {
            stickerInput.value = '';
            pendingReply = null;
            const replyBar = document.getElementById('reply-bar');
            if (replyBar) replyBar.style.display = 'none';
        }

        showStickerProgress('Sending...', 90);

        if (viewMode === 'dms') {
            const kp = E2ECrypto.getIdentityKeyPair();
            if (!kp) { hideStickerProgress(); setStickerSendingCooldown(false); return; }
            let otherPubKey;
            try {
                const res = await authFetch('/api/identity/' + currentDmOtherUser.id);
                const d = await res.json();
                otherPubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(d.identity_public_key));
            } catch (e) { hideStickerProgress(); setStickerSendingCooldown(false); return; }
            const encrypted = E2ECrypto.encryptDm(filePayload, currentDmChannelId, kp.privateKey, otherPubKey);
            ws.send(JSON.stringify({ type: 'dm_send', dm_channel_id: currentDmChannelId, encrypted_content: encrypted.ciphertext, nonce: encrypted.nonce, message_nonce: encrypted.messageNonce || null }));
            // Brief success glow then cleanup
            const fill = document.getElementById('sticker-send-fill');
            if (fill) { fill.classList.add('success'); fill.style.width = '100%'; }
            await new Promise(r => setTimeout(r, 600));
        } else if (currentChannelId && currentServerId) {
            if (!E2ECrypto.getServerKey(currentServerId)) { hideStickerProgress(); setStickerSendingCooldown(false); return; }
            const encrypted = E2ECrypto.encrypt(filePayload, currentChannelId, currentServerId);
            ws.send(JSON.stringify({
                type: 'message_send',
                channel_id: currentChannelId,
                encrypted_content: encrypted.ciphertext,
                nonce: encrypted.nonce,
                message_nonce: encrypted.messageNonce || null,
            }));
            // Brief success glow then cleanup
            const fill = document.getElementById('sticker-send-fill');
            if (fill) { fill.classList.add('success'); fill.style.width = '100%'; }
            await new Promise(r => setTimeout(r, 600));
        }
    } catch (e) {
        console.error('Failed to send sticker:', e);
    }

    hideStickerProgress();
    setStickerSendingCooldown(false);
    stickerPanelOpen = false;
    const panel = document.getElementById('sticker-panel');
    if (panel) panel.style.display = 'none';
}

// ===== Upload Sticker/GIF Panel (opens the crop modal) =====
function renderUploadStickerPanel(container) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:16px;text-align:center;';
    wrap.innerHTML = '<p style="color:#888;font-size:13px;margin-bottom:12px;">Add to your personal collection</p>' +
        '<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">' +
        '<button id="sticker-upload-trigger" style="background:var(--accent);color:var(--bg-primary);border:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">🖼️ Upload Sticker</button>' +
        '<button id="gif-upload-trigger" style="background:#2a6a3a;color:#fff;border:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">🎬 Upload GIF</button>' +
        '<button id="emoji-upload-trigger" style="background:#6a3a8a;color:#fff;border:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">😊 Upload Emoji</button>' +
        '</div>' +
        '<p style="color:#666;font-size:11px;margin-top:10px;">Emoji: small inline images • use :emoji_name: in messages to insert</p>' +
        '<p style="color:#666;font-size:11px;margin-top:4px;">Stickers: cropped/resized to 420×420 • GIFs always uploaded as-is</p>' +
        '<div style="margin-top:16px;"><button id="sticker-upload-cancel-btn" style="background:rgba(255,255,255,0.1);color:#aaa;border:1px solid #444;padding:8px 20px;border-radius:8px;font-size:13px;cursor:pointer;transition:all 0.15s;">Cancel</button></div>';
    container.appendChild(wrap);

    // Cancel button closes the sticker panel
    var cancelBtn = wrap.querySelector('#sticker-upload-cancel-btn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', function () {
            if (typeof closeStickerPanel === 'function') {
                closeStickerPanel();
            } else {
                document.getElementById('sticker-panel').style.display = 'none';
            }
        });
    }

    wrap.querySelector('#sticker-upload-trigger').addEventListener('click', () => {
        const modal = document.getElementById('sticker-upload-modal');
        if (!modal) return;
        modal.style.display = 'flex';
        document.getElementById('sticker-upload-step-choose').style.display = '';
        document.getElementById('sticker-upload-step-crop').style.display = 'none';
        resetStickerUpload();
        stickerUploadMode = 'sticker'; // set AFTER reset
        document.getElementById('sticker-upload-input').accept = 'image/*';
        const title = document.querySelector('#sticker-upload-modal h3');
        if (title) title.textContent = 'Upload Sticker';
        const confirmBtn = document.getElementById('confirm-sticker-upload');
        if (confirmBtn) confirmBtn.textContent = 'Crop & Upload';
        document.getElementById('sticker-upload-input').click();
    });

    wrap.querySelector('#gif-upload-trigger').addEventListener('click', () => {
        const modal = document.getElementById('sticker-upload-modal');
        if (!modal) return;
        modal.style.display = 'flex';
        document.getElementById('sticker-upload-step-choose').style.display = '';
        document.getElementById('sticker-upload-step-crop').style.display = 'none';
        resetStickerUpload();
        stickerUploadMode = 'gif'; // set AFTER reset so it doesn't get overwritten
        document.getElementById('sticker-upload-input').accept = '.gif,image/gif';
        const title = document.querySelector('#sticker-upload-modal h3');
        if (title) title.textContent = 'Upload GIF';
        const confirmBtn = document.getElementById('confirm-sticker-upload');
        if (confirmBtn) confirmBtn.textContent = 'Upload GIF';
        document.getElementById('sticker-upload-input').click();
    });

    wrap.querySelector('#emoji-upload-trigger').addEventListener('click', () => {
        const modal = document.getElementById('sticker-upload-modal');
        if (!modal) return;
        modal.style.display = 'flex';
        document.getElementById('sticker-upload-step-choose').style.display = '';
        document.getElementById('sticker-upload-step-crop').style.display = 'none';
        resetStickerUpload();
        stickerUploadMode = 'emoji'; // set AFTER reset so it doesn't get overwritten
        document.getElementById('sticker-upload-input').accept = 'image/*';
        const title = document.querySelector('#sticker-upload-modal h3');
        if (title) title.textContent = 'Upload Emoji';
        const confirmBtn = document.getElementById('confirm-sticker-upload');
        if (confirmBtn) confirmBtn.textContent = 'Save Emoji';
        document.getElementById('sticker-upload-input').click();
    });
}

// ===== Crop & Upload =====

// Crop state
let stickerCropState = {
    file: null,
    image: null,
    naturalWidth: 0,
    naturalHeight: 0,
    needsCrop: false,
    cropX: 0,
    cropY: 0,
    cropSize: 0,
    maxCropSize: 420,
};
let stickerUploadMode = 'sticker'; // 'sticker' or 'gif'

function setupStickerUploadModal() {
    const fileInput = document.getElementById('sticker-upload-input');
    const confirmBtn = document.getElementById('confirm-sticker-upload');
    const cancelBtn = document.getElementById('cancel-sticker-upload');
    const dropzone = document.getElementById('sticker-upload-dropzone');

    if (!fileInput) return;

    // Click dropzone to open file picker
    if (dropzone) {
        dropzone.addEventListener('click', () => fileInput.click());
    }

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        stickerCropState.file = file;
        loadImageForCrop(file);
    });

    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            document.getElementById('sticker-upload-modal').style.display = 'none';
            resetStickerUpload();
        });
    }

    if (confirmBtn) {
        confirmBtn.addEventListener('click', processAndUploadSticker);
    }
}

function loadImageForCrop(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            stickerCropState.image = img;
            stickerCropState.naturalWidth = img.naturalWidth;
            stickerCropState.naturalHeight = img.naturalHeight;

            // Hide step 1, show step 2
            document.getElementById('sticker-upload-step-choose').style.display = 'none';
            document.getElementById('sticker-upload-step-crop').style.display = 'block';

            const cropImg = document.getElementById('sticker-crop-image');
            cropImg.src = e.target.result;
            cropImg.onload = () => {
                if (stickerUploadMode === 'emoji') {
                    // Emoji: show crop UI, will be cropped to a square then resized to inline size
                    document.getElementById('sticker-crop-overlay').style.display = '';
                    document.getElementById('sticker-crop-info').textContent =
                        'Emoji: ' + img.naturalWidth + '×' + img.naturalHeight + ' — crop a square region. It will be resized to fit inline.';
                    const confirmBtn = document.getElementById('confirm-sticker-upload');
                    if (confirmBtn) confirmBtn.textContent = 'Save Emoji';
                    initCropBox(cropImg);
                } else if (stickerUploadMode === 'gif') {
                    // GIFs are always uploaded as-is to preserve animation, no cropping
                    document.getElementById('sticker-crop-overlay').style.display = 'none';
                    document.getElementById('sticker-crop-info').textContent =
                        'GIF: ' + img.naturalWidth + '×' + img.naturalHeight + ' — uploaded as-is with animation preserved.';
                } else {
                    const needsCrop = img.naturalWidth > 420 || img.naturalHeight > 420;
                    if (needsCrop) {
                        initCropBox(cropImg);
                    } else {
                        // Image within limit — no adjustable crop box; show full image
                        document.getElementById('sticker-crop-overlay').style.display = 'none';
                        document.getElementById('sticker-crop-info').textContent =
                            'Image is already ' + img.naturalWidth + '×' + img.naturalHeight + '. It will be saved as-is.';
                        const confirmBtn = document.getElementById('confirm-sticker-upload');
                        if (confirmBtn) confirmBtn.textContent = 'Save Sticker';
                        const w = cropImg.naturalWidth;
                        const h = cropImg.naturalHeight;
                        stickerCropState.cropX = 0;
                        stickerCropState.cropY = 0;
                        stickerCropState.cropSize = Math.min(w, h);
                        stickerCropState.maxCropSize = Math.min(w, h);
                    }
                }

                // Set default name from file
                const nameInput = document.getElementById('sticker-upload-name');
                if (nameInput && !nameInput.value) {
                    nameInput.value = stickerCropState.file.name.replace(/\.[^.]+$/, '');
                }
            };
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function initCropBox(cropImg) {
    const frame = document.getElementById('sticker-crop-frame');
    const overlay = document.getElementById('sticker-crop-overlay');
    const box = document.getElementById('sticker-crop-box');
    const handle = document.getElementById('sticker-crop-handle');
    const container = document.getElementById('sticker-crop-container');

    overlay.style.display = '';

    const displayW = cropImg.offsetWidth || cropImg.clientWidth;
    const displayH = cropImg.offsetHeight || cropImg.clientHeight;
    const natW = cropImg.naturalWidth;
    const natH = cropImg.naturalHeight;

    // Scale factor from display to natural
    const scaleX = natW / displayW;
    const scaleY = natH / displayH;

    // Initial crop box: centered, starts at 420px display or the full shorter side
    const initSize = Math.min(Math.min(displayW, displayH), 420);
    const x = (displayW - initSize) / 2;
    const y = (displayH - initSize) / 2;

    box.style.width = initSize + 'px';
    box.style.height = initSize + 'px';
    box.style.left = x + 'px';
    box.style.top = y + 'px';

    stickerCropState.cropX = Math.round(x * scaleX);
    stickerCropState.cropY = Math.round(y * scaleY);
    stickerCropState.cropSize = Math.round(initSize * scaleX);
    // User can select ANY area of the image — it gets scaled down to 420x420
    stickerCropState.maxCropSize = Math.min(natW, natH);
    delete stickerCropState.needsCrop;
    // Always show the crop box for images > 420
    document.getElementById('sticker-crop-info').textContent =
        'Drag or resize the square to select the area to keep. The selection will be resized to 420×420.';

    // Drag state
    let isDragging = false;
    let isResizing = false;
    let startX, startY, startLeft, startTop, startSize;

    // Shared pointer handler: works for both mouse and touch events
    function getPointerClient(e) {
        if (e.touches && e.touches.length > 0) {
            return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
        if (e.changedTouches && e.changedTouches.length > 0) {
            return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
        }
        return { x: e.clientX, y: e.clientY };
    }

    const onPointerDown = (e, resize) => {
        isDragging = !resize;
        isResizing = resize;
        const pt = getPointerClient(e);
        startX = pt.x;
        startY = pt.y;
        startLeft = parseInt(box.style.left);
        startTop = parseInt(box.style.top);
        startSize = parseInt(box.style.width);
        e.preventDefault();
        e.stopPropagation();

        const onPointerMove = (me) => {
            me.preventDefault();
            const pt2 = getPointerClient(me);
            const dx = pt2.x - startX;
            const dy = pt2.y - startY;

            if (isDragging) {
                let newLeft = startLeft + dx;
                let newTop = startTop + dy;
                newLeft = Math.max(0, Math.min(displayW - parseInt(box.style.width), newLeft));
                newTop = Math.max(0, Math.min(displayH - parseInt(box.style.height), newTop));
                box.style.left = newLeft + 'px';
                box.style.top = newTop + 'px';
                stickerCropState.cropX = Math.round(newLeft * scaleX);
                stickerCropState.cropY = Math.round(newTop * scaleY);
            } else if (isResizing) {
                let newSize = startSize + Math.max(dx, dy);
                const maxDisplaySize = Math.min(displayW - startLeft, displayH - startTop, stickerCropState.maxCropSize / Math.max(scaleX, scaleY));
                newSize = Math.max(32, Math.min(maxDisplaySize, newSize));
                box.style.width = newSize + 'px';
                box.style.height = newSize + 'px';
                stickerCropState.cropSize = Math.round(newSize * scaleX);
            }
        };

        const onPointerUp = () => {
            isDragging = false;
            isResizing = false;
            document.removeEventListener('mousemove', onPointerMove);
            document.removeEventListener('mouseup', onPointerUp);
            document.removeEventListener('touchmove', onPointerMove);
            document.removeEventListener('touchend', onPointerUp);
            document.removeEventListener('touchcancel', onPointerUp);
        };

        document.addEventListener('mousemove', onPointerMove);
        document.addEventListener('mouseup', onPointerUp);
        document.addEventListener('touchmove', onPointerMove, { passive: false });
        document.addEventListener('touchend', onPointerUp);
        document.addEventListener('touchcancel', onPointerUp);
    };

    // Mouse events
    box.addEventListener('mousedown', (e) => onPointerDown(e, false));
    handle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        onPointerDown(e, true);
    });
    // Touch events (mobile)
    box.addEventListener('touchstart', (e) => onPointerDown(e, false), { passive: false });
    handle.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        onPointerDown(e, true);
    }, { passive: false });
}

function resetStickerUpload() {
    stickerCropState = {
        file: null, image: null, naturalWidth: 0, naturalHeight: 0,
        needsCrop: false, cropX: 0, cropY: 0, cropSize: 0, maxCropSize: 420,
    };
    stickerUploadMode = 'sticker';
    document.getElementById('sticker-upload-step-choose').style.display = '';
    document.getElementById('sticker-upload-step-crop').style.display = 'none';
    document.getElementById('sticker-crop-overlay').style.display = '';
    document.getElementById('sticker-upload-input').value = '';
    document.getElementById('sticker-upload-input').accept = 'image/*';
    document.getElementById('sticker-upload-name').value = '';
    document.getElementById('sticker-upload-error').style.display = 'none';
    document.getElementById('sticker-upload-progress').style.display = 'none';
    // Reset modal title
    const title = document.querySelector('#sticker-upload-modal h3');
    if (title) title.textContent = 'Upload Sticker/GIF';
}

async function processAndUploadSticker() {
    const nameInput = document.getElementById('sticker-upload-name');
    const progressContainer = document.getElementById('sticker-upload-progress');
    const progressFill = document.getElementById('sticker-progress-fill');
    const progressText = document.getElementById('sticker-progress-text');
    const errorDiv = document.getElementById('sticker-upload-error');

    const name = ((nameInput && nameInput.value.trim()) || stickerCropState.file.name.replace(/\.[^.]+$/, '')).replace(/[^a-zA-Z0-9_]/g, '_');
    if (!name) {
        if (errorDiv) { errorDiv.textContent = 'Enter a sticker name'; errorDiv.style.display = 'block'; }
        return;
    }

    if (errorDiv) errorDiv.style.display = 'none';
    if (progressContainer) progressContainer.style.display = 'block';
    if (progressText) progressText.textContent = 'Processing image...';
    if (progressFill) progressFill.style.width = '2%';

    try {
        const img = stickerCropState.image;
        const originalFile = stickerCropState.file;

        let blob, mimeType;
        // Emojis get a random shareable key so other users can decrypt them via
        // the file_key embedded in messages; stickers/GIFs still use identity.
        let emojiUploadFileKey = null;
        let emojiUploadFileKeyB64 = null;

        // Create a canvas and crop/resize the image
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        let cropX = stickerCropState.cropX;
        let cropY = stickerCropState.cropY;
        let cropSize = stickerCropState.cropSize;

        if (stickerUploadMode === 'emoji') {
            // Emoji: crop the selected square region, then resize to fit within MAX_EMOJI_SIZE (max 420x420)
            const MAX_EMOJI_SIZE = 420;
            let ew = cropSize, eh = cropSize;
            if (ew > MAX_EMOJI_SIZE || eh > MAX_EMOJI_SIZE) {
                const ratio = Math.min(MAX_EMOJI_SIZE / ew, MAX_EMOJI_SIZE / eh);
                ew = Math.round(ew * ratio);
                eh = Math.round(eh * ratio);
            }
            canvas.width = ew;
            canvas.height = eh;
            ctx.drawImage(img, cropX, cropY, cropSize, cropSize, 0, 0, ew, eh);
            const outputMime = 'image/png';
            blob = await new Promise(resolve => canvas.toBlob(resolve, outputMime));
            if (!blob) throw new Error('Failed to process emoji');
            mimeType = 'image/emoji';
            // Emojis use a random shareable key (not the identity key) so that
            // the file_key embedded in messages lets other users decrypt them.
            emojiUploadFileKey = E2ECrypto.generateFileKey();
            emojiUploadFileKeyB64 = E2ECrypto.arrayBufferToBase64(emojiUploadFileKey);
        } else if (stickerUploadMode === 'gif') {
            // GIFs are always uploaded as-is to preserve animation, no cropping
            blob = originalFile;
            mimeType = 'image/gif';
        } else {
            // For images ≤ 420, preserve original non-square dimensions
            // For larger images (GIF or sticker), scale the cropped square area down to 420x420
            if (img.naturalWidth <= 420 && img.naturalHeight <= 420) {
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                ctx.drawImage(img, 0, 0);
            } else {
                canvas.width = 420;
                canvas.height = 420;
                ctx.drawImage(img, cropX, cropY, cropSize, cropSize, 0, 0, 420, 420);
            }

            // Convert to blob (canvas can only encode PNG/JPEG/WebP, never animated GIF)
            const outputMime = 'image/png';
            blob = await new Promise(resolve => canvas.toBlob(resolve, outputMime));
            if (!blob) throw new Error('Failed to process image');

            mimeType = blob.type || outputMime;
        }

        if (progressText) progressText.textContent = 'Encrypting...';
        if (progressFill) progressFill.style.width = '10%';

        // Upload as encrypted file using the standard upload flow
        if (progressText) progressText.textContent = 'Uploading...';
        if (progressFill) progressFill.style.width = '15%';

        // Use the random shareable key for emojis (set above), or the identity
        // private key for stickers/GIFs (synced across devices).
        const identity = E2ECrypto.getIdentityKeyPair();
        if (!identity) throw new Error('No identity key - cannot encrypt sticker');
        const fileKey = emojiUploadFileKey || identity.privateKey;

        // Init file upload
        const initRes = await authFetch('/api/files/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ size: blob.size, mime: mimeType })
        });
        if (!initRes.ok) { const errText = await initRes.text(); console.error('Upload init failed:', initRes.status, errText); throw new Error('Failed to initialize upload (HTTP ' + initRes.status + ')'); }
        const { file_id } = await initRes.json();

        // Read blob and upload in 64KB encrypted chunks
        const fileData = new Uint8Array(await blob.arrayBuffer());
        const CHUNK_SIZE = 64 * 1024;
        const totalChunks = Math.ceil(fileData.length / CHUNK_SIZE);

        for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, fileData.length);
            const chunkData = fileData.slice(start, end);
            const encryptedChunk = E2ECrypto.encryptFileChunk(fileKey, chunkData);
            if (progressText) progressText.textContent = 'Uploading... (' + (i + 1) + '/' + totalChunks + ')';
            if (progressFill) progressFill.style.width = (15 + Math.round(75 * (i + 1) / totalChunks)) + '%';
            const chunkRes = await authFetch('/api/files/' + file_id + '/chunk/' + i, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: encryptedChunk
            });
            if (!chunkRes.ok) throw new Error('Failed to upload chunk ' + (i + 1));
        }

        const completeRes = await authFetch('/api/files/' + file_id + '/complete', { method: 'POST' });
        if (!completeRes.ok) throw new Error('Failed to finalize upload');

        // Register as user sticker. Emojis store their random shareable key so
        // it can travel with messages; stickers/GIFs keep file_key null (identity-derived).
        if (progressText) progressText.textContent = 'Registering sticker...';
        if (progressFill) progressFill.style.width = '95%';
        const stickerRes = await authFetch('/api/users/me/stickers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                file_id: file_id,
                sticker_name: name,
                // Encrypt the shareable emoji key with the user's identity key so the server
                // cannot decrypt emoji images; regular stickers keep file_key null (identity-derived).
                file_key: emojiUploadFileKeyB64 ? E2ECrypto.encodeEncryptedFileKey(emojiUploadFileKeyB64, identity.privateKey) : null,
                mime_type: mimeType,
            }),
        });
        if (!stickerRes.ok) {
            const errData = await stickerRes.json().catch(() => ({}));
            console.error('Sticker register failed:', stickerRes.status, errData);
            throw new Error(errData.error || 'Failed to register sticker (HTTP ' + stickerRes.status + ')');
        }

        // Success: close modal and refresh sticker/emoji cache
        const wasEmoji = stickerUploadMode === 'emoji';
        document.getElementById('sticker-upload-modal').style.display = 'none';
        resetStickerUpload();
        await loadUserStickers(); // refresh cache for next time
        if (wasEmoji) {
            await loadEmojiCache();
        }

    } catch (e) {
        if (errorDiv) { errorDiv.textContent = e.message || 'Upload failed'; errorDiv.style.display = 'block'; }
        if (progressContainer) progressContainer.style.display = 'none';
    }
}

// ===== DM Forward =====
function showDmForwardModal() {
    const modal = document.getElementById('dm-forward-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    loadDmForwardList();
    // Setup cancel button (if not already set up)
    const cancelBtn = document.getElementById('cancel-dm-forward');
    if (cancelBtn && !cancelBtn._dmfSetup) {
        cancelBtn._dmfSetup = true;
        cancelBtn.addEventListener('click', () => {
            modal.style.display = 'none';
            pendingForward = null;
        });
    }
    // Click outside to close
    if (!modal._dmfSetup) {
        modal._dmfSetup = true;
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.style.display = 'none';
                pendingForward = null;
            }
        });
    }
}

async function loadDmForwardList() {
    const list = document.getElementById('dm-forward-list');
    if (!list) return;
    list.innerHTML = '<div style="color:#888;padding:12px;">Loading friends...</div>';
    try {
        // Use already-loaded dmConversations data
        if (!dmConversations || dmConversations.length === 0) {
            await loadDmConversations();
        }
        if (!Array.isArray(dmConversations) || dmConversations.length === 0) {
            list.innerHTML = '<div style="color:#666;padding:12px;font-size:13px;">No friends to forward to.</div>';
            return;
        }
        // Only show users who are members of the source server
        let allowedUserIds = null;
        const sourceServerId = pendingForward?.sourceServerId;
        if (sourceServerId) {
            try {
                const memRes = await authFetch('/api/servers/' + sourceServerId + '/members');
                const members = await memRes.json();
                if (Array.isArray(members)) {
                    allowedUserIds = new Set(members.map(m => m.id));
                }
            } catch (_) {}
        }
        let html = '';
        for (const c of dmConversations) {
            if (allowedUserIds && !allowedUserIds.has(c.other_user_id)) continue;
            var fwdDisplayName = c.other_display_name || c.other_username || '?';
            const initial = fwdDisplayName.charAt(0).toUpperCase();
            var fwdPicUrl = c.other_profile_picture_file_id ? getProfilePicUrl(c.other_profile_picture_file_id, c.other_user_id) : null;
            var avatarHtml = fwdPicUrl ? '<img src="' + fwdPicUrl + '" alt="" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0;">' : '<div style="width:32px;height:32px;border-radius:50%;background:var(--accent);color:var(--bg-primary);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0;overflow:hidden;">' + initial + '</div>';
            html += '<div class="dm-forward-item" data-user-id="' + c.other_user_id + '" data-username="' + escapeAttr(c.other_username) + '" data-dm-channel-id="' + escapeAttr(c.dm_channel_id || '') + '" style="display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer;border-radius:6px;border-bottom:1px solid var(--bg-border);transition:background .15s;">' +
                avatarHtml +
                '<span style="font-size:14px;color:var(--text-primary);">' + escapeHtml(fwdDisplayName) + '</span>' +
                '</div>';
        }
        if (!html) {
            list.innerHTML = '<div style="color:#666;padding:12px;font-size:13px;">No server members to forward to.</div>';
            return;
        }
        list.innerHTML = html;
        list.querySelectorAll('.dm-forward-item').forEach(item => {
            item.addEventListener('mouseenter', () => item.style.background = 'rgba(79,195,247,0.08)');
            item.addEventListener('mouseleave', () => item.style.background = '');
            item.addEventListener('click', () => {
                const userId = item.dataset.userId;
                const username = item.dataset.username;
                const dmChannelId = item.dataset.dmChannelId;
                executeDmForward(userId, username, dmChannelId);
                document.getElementById('dm-forward-modal').style.display = 'none';
                pendingForward = null;
            });
        });
    } catch (e) {
        list.innerHTML = '<div style="color:#666;padding:12px;">Failed to load friends.</div>';
    }
}

async function executeDmForward(targetUserId, targetUsername, dmChannelId) {
    if (!pendingForward || !ws || ws.readyState !== WebSocket.OPEN) return;
    const msgDiv = pendingForward.msgDiv;
    const messageId = pendingForward.messageId;

    // Get our identity key pair for DM encryption
    const kp = E2ECrypto.getIdentityKeyPair();
    if (!kp) return;

    // If no dmChannelId was passed, look it up from dmConversations
    if (!dmChannelId) {
        const conv = dmConversations.find(c => c.other_user_id === targetUserId);
        if (conv) dmChannelId = conv.dm_channel_id;
    }
    if (!dmChannelId) {
        console.error('DM forward: no DM channel found for user', targetUserId);
        return;
    }

    // Fetch the target user's identity key for E2E encryption
    let otherPublicKey;
    try {
        const res = await authFetch('/api/identity/' + targetUserId);
        const data = await res.json();
        otherPublicKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
    } catch (e) {
        console.error('DM forward: failed to fetch recipient key:', e);
        return;
    }

    const senderUsername = msgDiv.querySelector('.display-name')?.textContent || msgDiv.querySelector('.username')?.textContent || 'unknown';
    const senderId = msgDiv.getAttribute('data-sender-id') || '';
    var avatarPicAttr = (msgDiv.querySelector('.avatar img.avatar-img')?.getAttribute('data-profile-pic')) || (msgDiv.querySelector('.avatar')?.getAttribute('data-profile-pic-load')) || '';
    var senderPicFileId = avatarPicAttr ? avatarPicAttr.split(':')[1] || '' : '';
    const senderColor = msgDiv.querySelector('.display-name')?.style?.color || '';
    const textEl = msgDiv.querySelector('.text');
    const originalText = textEl ? extractRawMessageText(textEl) : '';

    let previewText = originalText.substring(0, 80);

    // Extract GIF/sticker/file data from the DOM for rich forward previews
    let gifData = null;
    let stickerData = null;
    let fileData = null;
    const gifMsgEl = msgDiv.querySelector('.gif-message');
    if (gifMsgEl) {
        const img = gifMsgEl.querySelector('img');
        if (img) {
            gifData = {
                url: img.getAttribute('src') || '',
                alt: img.getAttribute('alt') || 'GIF',
            };
        }
    }
    const stickerMsgEl = msgDiv.querySelector('.sticker-message');
    if (stickerMsgEl) {
        const img = stickerMsgEl.querySelector('img');
        if (img) {
            stickerData = {
                file_id: stickerMsgEl.getAttribute('data-file-id') || '',
                file_key: stickerMsgEl.getAttribute('data-file-key') || '',
                mime_type: stickerMsgEl.getAttribute('data-mime-type') || 'image/png',
            };
        }
    }
    const fileCardEl = msgDiv.querySelector('.file-card');
    if (fileCardEl) {
        fileData = {
            file_id: fileCardEl.getAttribute('data-file-id') || '',
            file_key: fileCardEl.getAttribute('data-file-key') || '',
            file_name: fileCardEl.getAttribute('data-file-name') || 'File',
            file_size: fileCardEl.getAttribute('data-file-size') || '0',
            mime_type: fileCardEl.getAttribute('data-file-mime') || 'application/octet-stream',
        };
    }

    try {
        // Wrap preview with emoji refs so recipients can render them
        const previewEmojiRefs = collectEmojiRefsFromMsgEl(msgDiv, previewText);
        let previewEncrypted = null;
        if (previewText || previewEmojiRefs.length > 0) {
            const previewPlaintext = JSON.stringify({ type: 'text', text: previewText || '', emojis: previewEmojiRefs });
            previewEncrypted = E2ECrypto.encryptDm(previewPlaintext, dmChannelId, kp.privateKey, otherPublicKey);
        }

        // Build the forward payload (same structure as channel forwards, with encrypted preview)
        const forwardPayload = {
            type: 'forward',
            source_server_id: currentServerId,
            source_channel_id: currentChannelId,
            source_message_id: messageId,
            source_server_name: document.getElementById('server-name')?.textContent || 'Server',
            source_channel_name: document.getElementById('channel-name')?.textContent || 'channel',
            sender_username: senderUsername,
            sender_id: senderId,
            sender_profile_pic_file_id: senderPicFileId,
            sender_color: senderColor,
            sender_border_color: msgDiv.querySelector('.display-name')?.style?.textShadow || '',
        };
        if (previewEncrypted) {
            forwardPayload.preview_content = previewEncrypted.ciphertext;
            forwardPayload.preview_nonce = previewEncrypted.nonce;
            forwardPayload.preview_message_nonce = previewEncrypted.messageNonce || null;
        }
        // Include rich media data in the forward payload if present
        if (gifData) forwardPayload.gif = gifData;
        if (stickerData) forwardPayload.sticker = stickerData;
        if (fileData) forwardPayload.file = fileData;

        // Encrypt the entire forward payload with DM E2E encryption and send as a regular dm_send
        const plaintext = JSON.stringify(forwardPayload);
        const encrypted = E2ECrypto.encryptDm(plaintext, dmChannelId, kp.privateKey, otherPublicKey);

        ws.send(JSON.stringify({
            type: 'dm_send',
            dm_channel_id: dmChannelId,
            encrypted_content: encrypted.ciphertext,
            nonce: encrypted.nonce,
            message_nonce: encrypted.messageNonce || null,
        }));
    } catch (e) {
        console.error('DM forward encrypt/send failed:', e);
    }
}

// ===== Profile Functions =====

// Fetch profile image from server and cache it as a blob URL
// Decrypt profile pic data using same pattern as downloadAndDecryptStickerData
async function decryptProfilePicData(fileKey, data) {
    const CHUNK_PLAINTEXT = 65536;
    const CHUNK_ENCRYPTED_FULL = CHUNK_PLAINTEXT + 16 + 24; // 65576
    const totalChunks = Math.ceil(data.length / CHUNK_ENCRYPTED_FULL);

    const decryptedChunks = [];
    for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_ENCRYPTED_FULL;
        let chunkData;
        if (i < totalChunks - 1) {
            chunkData = data.slice(start, start + CHUNK_ENCRYPTED_FULL);
        } else {
            chunkData = data.slice(start);
        }
        if (chunkData.length < 40) {
            // Too small to be an encrypted chunk - probably not encrypted data
            return null;
        }
        try {
            const decrypted = E2ECrypto.decryptFileChunk(fileKey, chunkData);
            decryptedChunks.push(decrypted);
        } catch (e) {
            return null; // Decryption failed - not encrypted or wrong key
        }
    }

    let totalLength = 0;
    for (const c of decryptedChunks) totalLength += c.length;
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of decryptedChunks) {
        result.set(c, offset);
        offset += c.length;
    }
    return result;
}

function getProfilePicUrl(fileId, userId) {
    if (!fileId || !userId) return null;
    var cacheKey = userId + ':' + fileId;
    if (profilePicCache[cacheKey]) return profilePicCache[cacheKey];
    
    // Fetch encrypted file
    authFetch('/api/files/' + fileId + '/download').then(async function (res) {
        if (!res.ok) return null;
        var encryptedArray = new Uint8Array(await res.arrayBuffer());
        
        // Get the file key from cache, own profile, or fetch user's profile
        var fileKeyB64 = null;
        
        // Try own profile first
        if (myProfile && myProfile.profile_picture_file_id === fileId && myProfile.profile_picture_file_key) {
            fileKeyB64 = myProfile.profile_picture_file_key;
        }
        
        // Try fileKeyCache
        if (!fileKeyB64) {
            fileKeyB64 = fileKeyCache.get(fileId);
        }
        
        // Try userDisplayNameCache (might have file_key from profile_updated events)
        if (!fileKeyB64 && userDisplayNameCache[userId] && userDisplayNameCache[userId].profile_picture_file_key) {
            fileKeyB64 = userDisplayNameCache[userId].profile_picture_file_key;
        }
        
        // Fetch user's profile to get the file key (for OTHER users' profile pics)
        if (!fileKeyB64) {
            try {
                var profileRes = await authFetch('/api/profile/' + userId);
                if (profileRes.ok) {
                    var profileData = await profileRes.json();
                    if (profileData && profileData.profile_picture_file_key) {
                        fileKeyB64 = profileData.profile_picture_file_key;
                        // Cache it for future use
                        fileKeyCache.set(fileId, fileKeyB64);
                        // Also store in userDisplayNameCache
                        if (!userDisplayNameCache[userId]) userDisplayNameCache[userId] = {};
                        userDisplayNameCache[userId].profile_picture_file_key = fileKeyB64;
                    }
                }
            } catch (e) {
                console.warn('Failed to fetch profile for pic key:', e);
            }
        }
        
        var blob;
        if (fileKeyB64) {
            try {
                var fileKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(fileKeyB64));
                var decrypted = await decryptProfilePicData(fileKey, encryptedArray);
                if (decrypted) {
                    blob = new Blob([decrypted], { type: 'image/png' });
                } else {
                    // Decryption failed - fall back to raw blob (for backward compat)
                    blob = new Blob([encryptedArray], { type: 'image/png' });
                }
            } catch (e) {
                console.warn('Profile pic decrypt failed:', e);
                blob = new Blob([encryptedArray], { type: 'image/png' });
            }
        } else {
            // No file key - use raw blob (for backward compat with unencrypted pics)
            blob = new Blob([encryptedArray], { type: 'image/png' });
        }
        
        var url = URL.createObjectURL(blob);
        profilePicCache[cacheKey] = url;
        // Update loaded avatars: img elements with data-profile-pic
        document.querySelectorAll('[data-profile-pic="' + cacheKey + '"]').forEach(function (el) {
            el.src = url;
        });
        // Update placeholder avatars: divs with data-profile-pic-load
        document.querySelectorAll('[data-profile-pic-load="' + cacheKey + '"]').forEach(function (el) {
            var initialText = el.textContent || '';
            el.innerHTML = '<img src="' + url + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;">';
            if (initialText) {
                var span = document.createElement('span');
                span.className = 'avatar-initial';
                span.style.display = 'none';
                span.textContent = initialText;
                el.appendChild(span);
            }
        });
    }).catch(function () {});
    return null; // Will be updated async when fetch completes
}

// Update sidebar footer with display name and avatar
function updateSidebarFooter() {
    var avatarEl = document.getElementById('footer-user-avatar');
    var usernameEl = document.getElementById('current-user');
    var subEl = document.getElementById('footer-username-sub');
    if (!avatarEl || !usernameEl) return;
    
    var displayName = (myProfile && myProfile.display_name) || user.username;
    var initial = displayName.charAt(0).toUpperCase();
    
    usernameEl.textContent = displayName;
    // Apply username color to sidebar display name
    var userColor = (myProfile && myProfile.username_color) || '#4fc3f7';
    usernameEl.style.color = userColor;
    if (subEl) {
        subEl.textContent = '@' + user.username;
        subEl.style.color = ''; // keep subtitle default muted color
    }
    
    // Remove stale data attributes
    avatarEl.removeAttribute('data-profile-pic');
    avatarEl.removeAttribute('data-profile-pic-load');
    
    if (myProfile && myProfile.profile_picture_file_id) {
        var cacheKey = user.id + ':' + myProfile.profile_picture_file_id;
        var picUrl = getProfilePicUrl(myProfile.profile_picture_file_id, user.id);
        if (picUrl) {
            avatarEl.innerHTML = '<img class="avatar-img" src="' + picUrl + '" alt="" data-profile-pic="' + cacheKey + '">';
        } else {
            avatarEl.innerHTML = initial;
            avatarEl.setAttribute('data-profile-pic-load', cacheKey);
        }
    } else {
        avatarEl.innerHTML = initial;
    }
}

// Load own profile from server
async function loadMyProfile() {
    if (!user || !user.id) return;
    try {
        var res = await authFetch('/api/profile/' + user.id);
        if (!res.ok) return;
        var data = await res.json();
        myProfile = data;
        
        // Update sidebar footer
        updateSidebarFooter();
        
        // Update settings UI if open
        updateProfileSettingsUI(data);
    } catch (e) {
        console.warn('Failed to load profile:', e);
    }
}

// Update the profile settings UI with loaded data
function updateProfileSettingsUI(data) {
    var avatarEl = document.getElementById('settings-profile-avatar');
    var usernameDisplay = document.getElementById('profile-username-display');
    var displayNameDisplay = document.getElementById('profile-display-name-display');
    var nameInput = document.getElementById('profile-display-name-input');
    var saveStatus = document.getElementById('profile-save-status');
    var colorPicker = document.getElementById('username-color-picker');
    var colorPreview = document.getElementById('username-color-preview');
    
    if (!avatarEl) return;
    
    var displayName = (data && data.display_name) || user.username;
    var initial = displayName.charAt(0).toUpperCase();
    
    if (usernameDisplay) usernameDisplay.textContent = '@' + user.username;
    if (displayNameDisplay) {
        displayNameDisplay.textContent = displayName;
        // Apply username color to preview
        var color = (data && data.username_color) || '#4fc3f7';
        displayNameDisplay.style.color = color;
    }
    if (nameInput) nameInput.value = data && data.display_name ? data.display_name : '';
    if (saveStatus) saveStatus.textContent = '';
    
    // Set color picker value
    var userColor = (data && data.username_color) || '#4fc3f7';
    if (colorPicker) colorPicker.value = userColor;
    if (colorPreview) {
        colorPreview.style.color = userColor;
        colorPreview.style.borderColor = userColor;
        colorPreview.style.textShadow = getDisplayNameTextShadow(userColor);
    }
    
    // Render border glow options
    renderBorderGlowOptions(userColor, data && data.username_border_color);
    
    if (data && data.profile_picture_file_id) {
        var picUrl = getProfilePicUrl(data.profile_picture_file_id, user.id);
        if (picUrl) {
            avatarEl.innerHTML = '<img src="' + picUrl + '" alt="">';
        } else {
            // Async load - show initial while loading
            avatarEl.innerHTML = initial;
            // Decrypted load using getProfilePicUrl which now handles decryption
            getProfilePicUrl(data.profile_picture_file_id, user.id);
            // Poll for cache
            var checkCache = setInterval(function () {
                var cacheKey = user.id + ':' + data.profile_picture_file_id;
                if (profilePicCache[cacheKey]) {
                    avatarEl.innerHTML = '<img src="' + profilePicCache[cacheKey] + '" alt="">';
                    updateSidebarFooter();
                    clearInterval(checkCache);
                }
            }, 200);
            setTimeout(function () { clearInterval(checkCache); }, 10000);
        }
    } else {
        avatarEl.innerHTML = initial;
    }
}

// Save display name
async function saveDisplayName() {
    var input = document.getElementById('profile-display-name-input');
    var status = document.getElementById('profile-save-status');
    if (!input) return;
    var name = input.value.trim();
    if (name.length > 50) {
        if (status) { status.textContent = 'Display name too long (max 50 chars)'; status.className = 'profile-save-status error'; }
        return;
    }
    try {
        var res = await authFetch('/api/profile', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ display_name: name })
        });
        if (!res.ok) {
            var err = await res.json();
            if (status) { status.textContent = err.error || 'Failed to save'; status.className = 'profile-save-status error'; }
            return;
        }
        if (status) { status.textContent = 'Display name saved!'; status.className = 'profile-save-status'; }
        setTimeout(function () { if (status) status.textContent = ''; }, 3000);
        await loadMyProfile();
        await loadDmConversations();
    } catch (e) {
        if (status) { status.textContent = 'Failed to connect to server'; status.className = 'profile-save-status error'; }
    }
}

// ===== Profile Picture Crop Modal =====
let profileCropState = {
    file: null,
    image: null,
    naturalWidth: 0,
    naturalHeight: 0,
    cropX: 0,
    cropY: 0,
    cropSize: 420,
    maxCropSize: 0,
    isDragging: false,
    isResizing: false,
    dragStartX: 0,
    dragStartY: 0,
    startLeft: 0,
    startTop: 0,
    startSize: 0
};

function setupProfileCropModal() {
    var modal = document.getElementById('profile-crop-modal');
    if (!modal) return;
    
    document.getElementById('cancel-profile-crop')?.addEventListener('click', function () {
        modal.style.display = 'none';
        profileCropState = { file: null, image: null, naturalWidth: 0, naturalHeight: 0, cropX: 0, cropY: 0, cropSize: 420, maxCropSize: 0, isDragging: false, isResizing: false, dragStartX: 0, dragStartY: 0, startLeft: 0, startTop: 0, startSize: 0 };
    });
    
    document.getElementById('confirm-profile-crop')?.addEventListener('click', processAndUploadProfilePic);
}

function openProfileCrop(file) {
    if (!file || !file.type.startsWith('image/')) {
        var status = document.getElementById('profile-save-status');
        if (status) { status.textContent = 'Please select an image file'; status.className = 'profile-save-status error'; }
        return;
    }
    
    profileCropState.file = file;
    var reader = new FileReader();
    reader.onload = function (e) {
        var img = new Image();
        img.onload = function () {
            profileCropState.image = img;
            profileCropState.naturalWidth = img.naturalWidth;
            profileCropState.naturalHeight = img.naturalHeight;
            
            var cropImg = document.getElementById('profile-crop-image');
            cropImg.src = e.target.result;
            
            // Show crop step
            document.getElementById('profile-crop-modal').style.display = 'flex';
            document.getElementById('profile-crop-progress').style.display = 'none';
            document.getElementById('profile-crop-error').style.display = 'none';
            
            // Init crop box centered
            setTimeout(function () {
                initProfileCropBox(cropImg);
            }, 100);
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function initProfileCropBox(cropImg) {
    var frame = document.getElementById('profile-crop-frame');
    var overlay = document.getElementById('profile-crop-overlay');
    var cropBox = document.getElementById('profile-crop-box');
    var handle = document.getElementById('profile-crop-handle');
    
    // Calculate display size based on image natural dimensions
    var maxW = frame.clientWidth - 4;
    var maxH = frame.clientHeight - 4;
    var displayW = Math.min(cropImg.naturalWidth, maxW);
    var displayH = Math.min(cropImg.naturalHeight, maxH);
    var imgRatio = cropImg.naturalWidth / cropImg.naturalHeight;
    if (displayW / displayH > imgRatio) {
        displayW = displayH * imgRatio;
    } else {
        displayH = displayW / imgRatio;
    }
    
    cropImg.style.width = displayW + 'px';
    cropImg.style.height = displayH + 'px';
    
    // Initial crop: centered square
    var initSize = Math.min(displayW, displayH);
    var startLeft = Math.round((displayW - initSize) / 2);
    var startTop = Math.round((displayH - initSize) / 2);
    
    cropBox.style.left = startLeft + 'px';
    cropBox.style.top = startTop + 'px';
    cropBox.style.width = initSize + 'px';
    cropBox.style.height = initSize + 'px';
    overlay.style.display = '';
    
    // Store crop state in natural image coordinates
    var scaleX = cropImg.naturalWidth / displayW;
    var scaleY = cropImg.naturalHeight / displayH;
    profileCropState.cropX = Math.round(startLeft * scaleX);
    profileCropState.cropY = Math.round(startTop * scaleY);
    profileCropState.cropSize = Math.round(initSize * scaleX);
    profileCropState.maxCropSize = Math.min(cropImg.naturalWidth, cropImg.naturalHeight);
    
    // Mouse/touch drag for crop box
    function startDrag(e) {
        var ev = e.touches ? e.touches[0] : e;
        profileCropState.isDragging = true;
        profileCropState.dragStartX = ev.clientX;
        profileCropState.dragStartY = ev.clientY;
        profileCropState.startLeft = parseInt(cropBox.style.left) || 0;
        profileCropState.startTop = parseInt(cropBox.style.top) || 0;
        e.preventDefault();
    }
    
    function onDrag(e) {
        if (!profileCropState.isDragging) return;
        var ev = e.touches ? e.touches[0] : e;
        var dx = ev.clientX - profileCropState.dragStartX;
        var dy = ev.clientY - profileCropState.dragStartY;
        var newLeft = Math.max(0, Math.min(displayW - parseInt(cropBox.style.width), profileCropState.startLeft + dx));
        var newTop = Math.max(0, Math.min(displayH - parseInt(cropBox.style.height), profileCropState.startTop + dy));
        cropBox.style.left = newLeft + 'px';
        cropBox.style.top = newTop + 'px';
        
        var scaleX = cropImg.naturalWidth / displayW;
        var scaleY = cropImg.naturalHeight / displayH;
        profileCropState.cropX = Math.round(newLeft * scaleX);
        profileCropState.cropY = Math.round(newTop * scaleY);
        e.preventDefault();
    }
    
    function endDrag() {
        profileCropState.isDragging = false;
        profileCropState.isResizing = false;
    }
    
    // Resize via handle
    function startResize(e) {
        var ev = e.touches ? e.touches[0] : e;
        profileCropState.isResizing = true;
        profileCropState.dragStartX = ev.clientX;
        profileCropState.dragStartY = ev.clientY;
        profileCropState.startSize = parseInt(cropBox.style.width) || initSize;
        profileCropState.startLeft = parseInt(cropBox.style.left) || 0;
        profileCropState.startTop = parseInt(cropBox.style.top) || 0;
        e.preventDefault();
        e.stopPropagation();
    }
    
    function onResize(e) {
        if (!profileCropState.isResizing) return;
        var ev = e.touches ? e.touches[0] : e;
        var dx = ev.clientX - profileCropState.dragStartX;
        var dy = ev.clientY - profileCropState.dragStartY;
        var maxDisplaySize = Math.min(displayW - profileCropState.startLeft, displayH - profileCropState.startTop,
            profileCropState.maxCropSize / Math.max(scaleX, scaleY));
        var newSize = Math.max(30, Math.min(maxDisplaySize, profileCropState.startSize + Math.max(dx, dy)));
        cropBox.style.width = newSize + 'px';
        cropBox.style.height = newSize + 'px';
        
        var natX = Math.round((profileCropState.startLeft) * scaleX);
        var natY = Math.round((profileCropState.startTop) * scaleY);
        profileCropState.cropX = natX;
        profileCropState.cropY = natY;
        profileCropState.cropSize = Math.round(newSize * scaleX);
        e.preventDefault();
    }
    
    cropBox.addEventListener('mousedown', startDrag);
    cropBox.addEventListener('touchstart', startDrag, { passive: false });
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('touchmove', onDrag, { passive: false });
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchend', endDrag);
    
    handle.addEventListener('mousedown', startResize);
    handle.addEventListener('touchstart', startResize, { passive: false });
    document.addEventListener('mousemove', onResize);
    document.addEventListener('touchmove', onResize, { passive: false });
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchend', endDrag);
}

// Process and upload cropped profile picture with encryption
async function processAndUploadProfilePic() {
    var progressContainer = document.getElementById('profile-crop-progress');
    var progressFill = document.getElementById('profile-crop-progress-fill');
    var progressText = document.getElementById('profile-crop-progress-text');
    var errorDiv = document.getElementById('profile-crop-error');
    
    if (!profileCropState.image) return;
    if (errorDiv) errorDiv.style.display = 'none';
    if (progressContainer) progressContainer.style.display = 'block';
    if (progressText) progressText.textContent = 'Processing image...';
    if (progressFill) progressFill.style.width = '2%';
    
    try {
        var img = profileCropState.image;
        
        // Crop the selected square region and resize to 420x420 max
        var cropX = profileCropState.cropX || 0;
        var cropY = profileCropState.cropY || 0;
        var cropSize = profileCropState.cropSize || Math.min(profileCropState.naturalWidth || 420, profileCropState.naturalHeight || 420);
        
        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d');
        
        var MAX_PIC_SIZE = 420;
        var finalSize = Math.min(cropSize, MAX_PIC_SIZE);
        if (finalSize < 1) finalSize = Math.min(profileCropState.naturalWidth || 420, profileCropState.naturalHeight || 420, MAX_PIC_SIZE);
        canvas.width = finalSize;
        canvas.height = finalSize;
        ctx.drawImage(img, cropX, cropY, cropSize, cropSize, 0, 0, finalSize, finalSize);
        
        var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
        if (!blob) throw new Error('Failed to process image');
        
        if (progressText) progressText.textContent = 'Encrypting...';
        if (progressFill) progressFill.style.width = '10%';
        
        // Generate a file key for encryption
        var fileKey = E2ECrypto.generateFileKey();
        var fileKeyB64 = E2ECrypto.arrayBufferToBase64(fileKey);
        
        if (progressText) progressText.textContent = 'Uploading...';
        if (progressFill) progressFill.style.width = '15%';
        
        // Init file upload
        var initRes = await authFetch('/api/files/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ size: blob.size, mime: 'image/png' })
        });
        if (!initRes.ok) throw new Error('Upload init failed');
        var initData = await initRes.json();
        var fileId = initData.file_id;
        if (!fileId) throw new Error('No file ID received');
        
        // Upload encrypted chunks
        var CHUNK_SIZE = 64 * 1024;
        var totalChunks = Math.ceil(blob.size / CHUNK_SIZE);
        var arrayBuffer = await blob.arrayBuffer();
        var bytes = new Uint8Array(arrayBuffer);
        
        for (var i = 0; i < totalChunks; i++) {
            var start = i * CHUNK_SIZE;
            var end = Math.min(start + CHUNK_SIZE, bytes.length);
            var chunkData = bytes.slice(start, end);
            
            // Encrypt chunk
            var encryptedChunk = E2ECrypto.encryptFileChunk(fileKey, chunkData);
            
            var chunkRes = await authFetch('/api/files/' + fileId + '/chunk/' + i, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: encryptedChunk
            });
            if (!chunkRes.ok) throw new Error('Chunk ' + (i + 1) + ' upload failed');
            
            if (progressFill) {
                var pct = 15 + ((i + 1) / totalChunks) * 70;
                progressFill.style.width = Math.min(pct, 85) + '%';
            }
        }
        
        if (progressText) progressText.textContent = 'Finalizing...';
        if (progressFill) progressFill.style.width = '90%';
        
        // Complete upload
        var completeRes = await authFetch('/api/files/' + fileId + '/complete', { method: 'POST' });
        if (!completeRes.ok) throw new Error('Upload finalize failed');
        
        // Cache file key for future decryption
        fileKeyCache.set(fileId, fileKeyB64);
        
        // Update profile with file ID and file key
        var res = await authFetch('/api/profile', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                profile_picture_file_id: fileId,
                profile_picture_file_key: fileKeyB64
            })
        });
        if (!res.ok) {
            var errData = await res.json();
            throw new Error(errData.error || 'Failed to set profile picture');
        }
        
        // Close modal
        document.getElementById('profile-crop-modal').style.display = 'none';
        profileCropState = { file: null, image: null, naturalWidth: 0, naturalHeight: 0, cropX: 0, cropY: 0, cropSize: 420, maxCropSize: 0, isDragging: false, isResizing: false, dragStartX: 0, dragStartY: 0, startLeft: 0, startTop: 0, startSize: 0 };
        
        var status = document.getElementById('profile-save-status');
        if (status) { status.textContent = 'Profile picture updated!'; status.className = 'profile-save-status'; }
        setTimeout(function () { if (status) status.textContent = ''; }, 3000);
        await loadMyProfile();
        await loadDmConversations();
    } catch (e) {
        if (errorDiv) { errorDiv.textContent = e.message || 'Failed to upload profile picture'; errorDiv.style.display = 'block'; }
        if (progressContainer) progressContainer.style.display = 'none';
    }
}

// Remove profile picture
async function removeProfilePic() {
    try {
        var res = await authFetch('/api/profile', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ remove_picture: true })
        });
        if (!res.ok) {
            var err = await res.json();
            var status = document.getElementById('profile-save-status');
            if (status) { status.textContent = err.error || 'Failed to remove picture'; status.className = 'profile-save-status error'; }
            return;
        }
        var status = document.getElementById('profile-save-status');
        if (status) { status.textContent = 'Profile picture removed'; status.className = 'profile-save-status'; }
        setTimeout(function () { if (status) status.textContent = ''; }, 3000);
        await loadMyProfile();
        await loadDmConversations();
    } catch (e) {
        var status = document.getElementById('profile-save-status');
        if (status) { status.textContent = 'Failed to connect to server'; status.className = 'profile-save-status error'; }
    }
}

// Wire up profile settings event handlers
// Save username color
async function saveUsernameColor() {
    var colorPicker = document.getElementById('username-color-picker');
    var status = document.getElementById('profile-save-status');
    var color = colorPicker ? colorPicker.value : '#4fc3f7';
    try {
        var res = await authFetch('/api/profile', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username_color: color })
        });
        if (!res.ok) {
            var err = await res.json();
            if (status) { status.textContent = err.error || 'Failed to save color'; status.className = 'profile-save-status error'; }
            return;
        }
        if (status) { status.textContent = 'Username color saved!'; status.className = 'profile-save-status'; }
        setTimeout(function () { if (status) status.textContent = ''; }, 3000);
        await loadMyProfile();
        // Regenerate glow options with the saved color
        var borderColor = null;
        if (myProfile && myProfile.username_border_color) {
            borderColor = myProfile.username_border_color;
        }
        renderBorderGlowOptions(color, borderColor);
    } catch (e) {
        if (status) { status.textContent = 'Failed to connect to server'; status.className = 'profile-save-status error'; }
    }
}

// Render the 10 border glow option swatches in the settings
function renderBorderGlowOptions(baseColor, selectedBorderColor) {
    var container = document.getElementById('border-glow-options');
    var previewEl = document.getElementById('border-glow-preview');
    if (!container) return;
    
    var options = generateBorderGlowOptions(baseColor);
    if (!options || options.length === 0) {
        container.innerHTML = '<div style="color:#888;font-size:13px;padding:8px 0;">Select a username color first to see glow options</div>';
        return;
    }
    
    // Store selected option in container dataset for later use
    container.dataset.baseColor = baseColor || '#4fc3f7';
    
    var html = '<div class="glow-options-grid">';
    options.forEach(function (opt) {
        var isSelected = selectedBorderColor && (opt.hex === selectedBorderColor);
        html += '<button class="glow-option-btn' + (isSelected ? ' selected' : '') + '" data-glow="' + escapeAttr(opt.hex) + '" title="' + escapeHtml(opt.name) + '">' +
            '<span class="glow-option-swatch" style="background:' + opt.hex + ';"></span>' +
            '<span class="glow-option-name">' + escapeHtml(opt.name) + '</span>' +
            '</button>';
    });
    html += '</div>';
    container.innerHTML = html;
    
    // Wire click handlers
    container.querySelectorAll('.glow-option-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            container.querySelectorAll('.glow-option-btn').forEach(function (b) { b.classList.remove('selected'); });
            btn.classList.add('selected');
            var glow = btn.dataset.glow;
            // Update preview
            if (previewEl) {
                previewEl.style.color = baseColor || '#4fc3f7';
                previewEl.style.textShadow = getDisplayNameTextShadow(baseColor || '#4fc3f7', glow);
                previewEl.dataset.selectedGlow = glow;
            }
        });
    });
    
    // If there's a selected border color, update the preview
    if (previewEl) {
        previewEl.style.color = baseColor || '#4fc3f7';
        if (selectedBorderColor) {
            previewEl.style.textShadow = getDisplayNameTextShadow(baseColor || '#4fc3f7', selectedBorderColor);
            previewEl.dataset.selectedGlow = selectedBorderColor;
        } else if (options.length > 0) {
            // Default to the first option's shadow
            previewEl.style.textShadow = getDisplayNameTextShadow(baseColor || '#4fc3f7', options[0].hex);
            previewEl.dataset.selectedGlow = options[0].hex;
            // Also select the first button
            var firstBtn = container.querySelector('.glow-option-btn');
            if (firstBtn) firstBtn.classList.add('selected');
        }
    }
}

// Save the selected border glow color
async function saveBorderGlowColor() {
    var previewEl = document.getElementById('border-glow-preview');
    var status = document.getElementById('profile-save-status');
    var selectedGlow = previewEl ? previewEl.dataset.selectedGlow : null;
    if (!selectedGlow) {
        // Try to find selected button
        var selectedBtn = document.querySelector('.glow-option-btn.selected');
        selectedGlow = selectedBtn ? selectedBtn.dataset.glow : null;
    }
    if (!selectedGlow) {
        if (status) { status.textContent = 'Select a glow option first'; status.className = 'profile-save-status error'; }
        return;
    }
    try {
        var res = await authFetch('/api/profile', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username_border_color: selectedGlow })
        });
        if (!res.ok) {
            var err = await res.json();
            if (status) { status.textContent = err.error || 'Failed to save glow'; status.className = 'profile-save-status error'; }
            return;
        }
        if (status) { status.textContent = 'Glow color saved!'; status.className = 'profile-save-status'; }
        setTimeout(function () { if (status) status.textContent = ''; }, 3000);
        await loadMyProfile();
    } catch (e) {
        if (status) { status.textContent = 'Failed to connect to server'; status.className = 'profile-save-status error'; }
    }
}

function setupProfileSettings() {
    var saveBtn = document.getElementById('profile-save-name-btn');
    var uploadBtn = document.getElementById('profile-pic-upload-btn');
    var removeBtn = document.getElementById('profile-pic-remove-btn');
    var picInput = document.getElementById('profile-pic-input');
    var colorSaveBtn = document.getElementById('username-color-save-btn');
    var colorPicker = document.getElementById('username-color-picker');
    var colorPreview = document.getElementById('username-color-preview');
    
    // Profile name save
    if (saveBtn) {
        saveBtn.addEventListener('click', saveDisplayName);
    }
    
    // Profile picture upload with crop
    if (uploadBtn && picInput) {
        uploadBtn.addEventListener('click', function () { picInput.click(); });
        picInput.addEventListener('change', function (e) {
            var file = e.target.files[0];
            if (file) openProfileCrop(file);
            e.target.value = '';
        });
    }
    if (removeBtn) {
        removeBtn.addEventListener('click', removeProfilePic);
    }
    
    // Username color
    var borderGlowSaveBtn = document.getElementById('border-glow-save-btn');
    
    if (colorPicker && colorPreview) {
        colorPicker.addEventListener('input', function () {
            colorPreview.style.color = colorPicker.value;
            colorPreview.style.borderColor = colorPicker.value;
            colorPreview.style.textShadow = getDisplayNameTextShadow(colorPicker.value);
            // Regenerate border glow options when color changes
            var selectedBtn = document.querySelector('.glow-option-btn.selected');
            var currentGlow = selectedBtn ? selectedBtn.dataset.glow : null;
            renderBorderGlowOptions(colorPicker.value, currentGlow);
        });
    }
    if (colorSaveBtn) {
        colorSaveBtn.addEventListener('click', saveUsernameColor);
    }
    
    // Color presets
    document.querySelectorAll('.color-preset').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var color = btn.dataset.color;
            if (colorPicker) {
                colorPicker.value = color;
                if (colorPreview) {
                    colorPreview.style.color = color;
                    colorPreview.style.borderColor = color;
                    colorPreview.style.textShadow = getDisplayNameTextShadow(color);
                }
                // Regenerate border glow options
                var selectedBtn = document.querySelector('.glow-option-btn.selected');
                var currentGlow = selectedBtn ? selectedBtn.dataset.glow : null;
                renderBorderGlowOptions(color, currentGlow);
            }
        });
    });
    
    // Border glow save button
    if (borderGlowSaveBtn) {
        borderGlowSaveBtn.addEventListener('click', saveBorderGlowColor);
    }
    
    // Profile crop modal
    setupProfileCropModal();
}

// Also call setupProfileSettings on load
document.addEventListener('DOMContentLoaded', function () {
    setTimeout(setupProfileSettings, 500);
});

// ===== Profile Modal =====

let profileModalUserId = null;
let profileEditMode = false;
let profileBannerFileId = null;
let profileBannerFileKey = null;
let profilePfpFileId = null;
let profilePfpFileKey = null;
let bannerCropState = null;
let pfpCropState = null;
let profileOriginalData = null;

// Open profile modal for a given user ID
async function openProfileModal(userId) {
    profileModalUserId = userId;
    profileEditMode = false;
    profileBannerFileId = null;
    profileBannerFileKey = null;
    profilePfpFileId = null;
    profilePfpFileKey = null;
    
    var modal = document.getElementById('profile-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    
    // Show loading state
    document.getElementById('profile-view').style.display = 'block';
    document.getElementById('profile-modal-display-name').textContent = 'Loading...';
    document.getElementById('profile-modal-nickname').textContent = '';
    document.getElementById('profile-modal-description').textContent = '';
    document.getElementById('profile-modal-avatar').innerHTML = '<div style="font-size:36px;color:#1a1a2e;font-weight:700;">...</div>';
    document.getElementById('profile-modal-username-tag').textContent = '';
    document.getElementById('profile-edit-btn').style.display = 'none';
    
    // Fetch profile data
    try {
        var res = await authFetch('/api/profile/' + encodeURIComponent(userId));
        if (!res.ok) {
            document.getElementById('profile-modal-display-name').textContent = 'User not found';
            return;
        }
        var data = await res.json();
        
        // Try to decrypt encrypted profile data if this is our own profile
        var decrypted = null;
        if (data.encrypted_profile_data && data.encrypted_profile_salt && data.encrypted_profile_nonce && userId === user.id) {
            // Verify stored password against server before decrypting
            var password = await verifyStoredPassword();
            if (password) {
                try {
                    var decryptedStr = E2ECrypto.decryptWithPassword(
                        data.encrypted_profile_data,
                        password,
                        data.encrypted_profile_salt,
                        data.encrypted_profile_nonce
                    );
                    if (decryptedStr) {
                        decrypted = JSON.parse(decryptedStr);
                    }
                } catch (e) {
                    console.warn('Failed to decrypt profile data', e);
                }
            }
        }
        
        profileOriginalData = { data: data, decrypted: decrypted };
        renderProfileView(data, decrypted, userId);
    } catch (e) {
        document.getElementById('profile-modal-display-name').textContent = 'Error loading profile';
        console.error('Profile fetch error:', e);
    }
}

// Render profile view mode
function renderProfileView(data, decrypted, uid) {
    var isOwn = uid === user.id;
    
    // Determine display name
    var displayName = (decrypted && decrypted.display_name) || data.display_name || data.username || 'Unknown';
    var nickname = (decrypted && decrypted.nickname) || data.nickname || '';
    var description = (decrypted && decrypted.description) || data.description || '';
    
    // Colors — read from decrypted first (own profile), fall back to unencrypted (other users)
    var usernameColor = (decrypted && decrypted.username_color) || data.username_color || '#4fc3f7';
    var borderColor = (decrypted && decrypted.username_border_color) || data.username_border_color || '';
    var bgColor = (decrypted && decrypted.profile_background_color) || data.profile_background_color || '';
    
    // Apply background color to profile card (colors the gap between banner and avatar)
    var cardEl = document.querySelector('#profile-view .profile-view-card') || document.querySelector('#profile-modal .profile-view-card');
    if (cardEl) {
        cardEl.style.background = bgColor || '';
    }
    
    // Make avatar border match background color
    var avatarEl = document.getElementById('profile-modal-avatar');
    if (avatarEl) {
        avatarEl.style.borderColor = bgColor || '#16213e';
    }
    
    // Set display name with color
    var dnEl = document.getElementById('profile-modal-display-name');
    dnEl.textContent = displayName;
    dnEl.style.color = usernameColor;
    if (borderColor) {
        dnEl.style.textShadow = '0 0 8px ' + borderColor + ', 0 0 16px ' + borderColor;
    } else {
        dnEl.style.textShadow = 'none';
    }
    
    // Set nickname
    document.getElementById('profile-modal-nickname').textContent = nickname || '';
    document.getElementById('profile-modal-nickname').style.display = nickname ? 'block' : 'none';
    
    // Set description with clickable links
    var descEl = document.getElementById('profile-modal-description');
    if (description) {
        descEl.innerHTML = linkifyText(escapeHtml(description));
        descEl.style.display = 'block';
    } else {
        descEl.textContent = '';
        descEl.style.display = 'none';
    }
    
    // Set username tag
    document.getElementById('profile-modal-username-tag').textContent = data.username || '';
    
    // Set banner
    var bannerImg = document.getElementById('profile-banner-img');
    var bannerFileId = data.profile_banner_file_id;
    var bannerFileKey = data.profile_banner_file_key || null;
    if (bannerFileId) {
        getDecryptedFileUrl(bannerFileId, bannerFileKey, function(url) {
            if (url) {
                bannerImg.style.backgroundImage = 'url(' + url + ')';
            } else {
                bannerImg.style.backgroundImage = '';
            }
        });
    } else {
        bannerImg.style.backgroundImage = '';
    }
    
    // Set avatar
    var avatarEl = document.getElementById('profile-modal-avatar');
    var picFileId = data.profile_picture_file_id;
    var picFileKey = data.profile_picture_file_key || null;
    if (picFileId) {
        getDecryptedFileUrl(picFileId, picFileKey, function(url) {
            if (url) {
                avatarEl.innerHTML = '<img src="' + url + '" alt="Avatar">';
            } else {
                avatarEl.innerHTML = '<div style="font-size:36px;color:#1a1a2e;font-weight:700;">' + escapeHtml(displayName.charAt(0).toUpperCase()) + '</div>';
            }
        });
    } else {
        avatarEl.innerHTML = '<div style="font-size:36px;color:#1a1a2e;font-weight:700;">' + escapeHtml(displayName.charAt(0).toUpperCase()) + '</div>';
    }
    
    // Show edit button only for own profile
    var editBtn = document.getElementById('profile-edit-btn');
    if (isOwn) {
        editBtn.style.display = 'block';
    } else {
        editBtn.style.display = 'none';
    }
}

// Helper: get decrypted file URL (async callback)
function getDecryptedFileUrl(fileId, fileKey, callback) {
    if (!fileId) { callback(null); return; }
    var cacheKey = 'pfp_' + fileId;
    var cached = profilePicCache[cacheKey];
    if (cached) { callback(cached); return; }
    
    authFetch('/api/files/' + fileId + '/download')
        .then(function(r) {
            if (!r.ok) throw new Error('Not found');
            return r.arrayBuffer();
        })
        .then(async function(data) {
            var enc = new Uint8Array(data);
            var keyB64 = fileKey || fileKeyCache.get(fileId) || (myProfile && myProfile.profile_picture_file_id === fileId && localStorage.getItem('e2e_file_key_' + fileId));
            if (keyB64 && enc.length > 40) {
                try {
                    var key = new Uint8Array(E2ECrypto.base64ToArrayBuffer(keyB64));
                    var decrypted = await decryptProfilePicData(key, enc);
                    if (decrypted) {
                        var blob = new Blob([decrypted], { type: 'image/png' });
                        var url = URL.createObjectURL(blob);
                        profilePicCache[cacheKey] = url;
                        callback(url);
                        return;
                    }
                } catch (e) {}
            }
            // No key or decryption failed - serve raw
            callback(URL.createObjectURL(new Blob([data])));
        })
        .catch(function() { callback(null); });
}

// Turn plain text URLs into clickable links
function linkifyText(text) {
    var urlRegex = /(https?:\/\/[^\s<]+)/g;
    return text.replace(urlRegex, function(match) {
        return '<a href="' + match + '" target="_blank" rel="noopener noreferrer">' + match + '</a>';
    });
}

function closeProfileModal() {
    document.getElementById('profile-modal').style.display = 'none';
    document.getElementById('profile-view').style.display = 'block';
    
    // Close edit modal if open
    if (profileEditModalOpen) closeProfileEditModal();
    
    // Clean up any crops
    if (bannerCropState) cancelBannerCrop();
    if (pfpCropState) cancelPfpCrop();
    document.getElementById('profile-banner-crop-container').style.display = 'none';
    document.getElementById('profile-pfp-crop-container').style.display = 'none';
    
    profileModalUserId = null;
    profileEditMode = false;
}

var profileEditModalOpen = false;

function openProfileEditModal() {
    if (!profileOriginalData) return;
    profileEditModalOpen = true;
    var modal = document.getElementById('profile-edit-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    renderProfileEdit();
}

function closeProfileEditModal() {
    profileEditModalOpen = false;
    var modal = document.getElementById('profile-edit-modal');
    if (modal) modal.style.display = 'none';
    if (bannerCropState) cancelBannerCrop();
    if (pfpCropState) cancelPfpCrop();
    document.getElementById('profile-banner-crop-container').style.display = 'none';
    document.getElementById('profile-pfp-crop-container').style.display = 'none';
}

// === Handlers wired in DOMContentLoaded ===

// Render profile edit mode (separate modal, side-by-side layout)
function renderProfileEdit() {
    if (!profileOriginalData) return;
    
    var editBtn = document.getElementById('profile-edit-btn');
    if (editBtn) editBtn.style.display = 'none';
    
    var data = profileOriginalData.data;
    var decrypted = profileOriginalData.decrypted || {};
    
    document.getElementById('profile-edit-display-name').value = decrypted.display_name || data.display_name || '';
    document.getElementById('profile-edit-nickname').value = decrypted.nickname || '';
    document.getElementById('profile-edit-description').value = decrypted.description || '';
    updateDescriptionWordCount();
    
    var color = (decrypted && decrypted.username_color) || data.username_color || '#4fc3f7';
    document.getElementById('profile-edit-color').value = color;
    document.getElementById('profile-edit-color-preview').style.color = color;
    
    var bgColor = (decrypted && decrypted.profile_background_color) || data.profile_background_color || '#16213e';
    document.getElementById('profile-edit-bg-color').value = bgColor;
    document.getElementById('profile-edit-bg-preview').style.background = bgColor;
    
    // Glow options
    renderEditGlowOptions(color);
    
    // Show/hide remove buttons based on whether images exist
    if (data.profile_picture_file_id) {
        document.getElementById('profile-avatar-remove-btn').style.display = '';
    } else {
        document.getElementById('profile-avatar-remove-btn').style.display = 'none';
    }
    if (data.profile_banner_file_id) {
        document.getElementById('profile-banner-remove-btn').style.display = '';
    } else {
        document.getElementById('profile-banner-remove-btn').style.display = 'none';
    }
    // Hide any active crop containers
    document.getElementById('profile-banner-crop-container').style.display = 'none';
    document.getElementById('profile-pfp-crop-container').style.display = 'none';
    
    // Initialize the live preview
    updateProfileEditPreview();
}

function updateDescriptionWordCount() {
    var descInput = document.getElementById('profile-edit-description');
    var counter = document.getElementById('profile-desc-word-count');
    if (!descInput || !counter) return;
    var words = descInput.value.trim() ? descInput.value.trim().split(/\s+/).length : 0;
    counter.textContent = words + '/300 words';
    counter.style.color = words > 300 ? 'var(--danger)' : 'var(--text-muted)';
}

function updateProfileEditPreview() {
    if (!profileOriginalData) return;
    var data = profileOriginalData.data;
    var decrypted = profileOriginalData.decrypted || {};
    
    // Update display name preview
    var dnPreview = document.getElementById('profile-edit-display-name-preview');
    if (dnPreview) {
        var dn = document.getElementById('profile-edit-display-name').value || '';
        dnPreview.textContent = dn || data.display_name || data.username || 'Unknown';
        dnPreview.style.color = (decrypted && decrypted.username_color) || data.username_color || '#4fc3f7';
    }
    
    // Update nickname preview
    var nnPreview = document.getElementById('profile-edit-nickname-preview');
    if (nnPreview) {
        var nn = document.getElementById('profile-edit-nickname').value || '';
        nnPreview.textContent = nn;
        nnPreview.style.display = nn ? 'block' : 'none';
    }
    
    // Update description preview
    var descPreview = document.getElementById('profile-edit-description-preview');
    if (descPreview) {
        var desc = document.getElementById('profile-edit-description').value || '';
        if (desc) {
            descPreview.innerHTML = linkifyText(escapeHtml(desc));
            descPreview.style.display = 'block';
        } else {
            descPreview.textContent = '';
            descPreview.style.display = 'none';
        }
    }
    
    // Update background color preview
    var bgColor = document.getElementById('profile-edit-bg-color').value || '';
    var card = document.querySelector('#profile-edit-modal .profile-edit-preview-card');
    if (card) card.style.background = bgColor || '';
    // Make edit avatar border match background color
    var editAvatarEl = document.getElementById('profile-edit-avatar');
    if (editAvatarEl) {
        editAvatarEl.style.borderColor = bgColor || '#16213e';
    }
    
    // Update banner preview from current profile
    var bannerImg = document.getElementById('profile-edit-banner-img');
    if (bannerImg) {
        var bannerFileId = data.profile_banner_file_id;
        var bannerFileKey = data.profile_banner_file_key || null;
        if (bannerFileId) {
            getDecryptedFileUrl(bannerFileId, bannerFileKey, function(url) {
                bannerImg.style.backgroundImage = url ? 'url(' + url + ')' : '';
            });
        } else {
            bannerImg.style.backgroundImage = '';
        }
    }
    
    // Update avatar preview from current profile
    var avatarEl = document.getElementById('profile-edit-avatar');
    if (avatarEl) {
        var picFileId = data.profile_picture_file_id;
        var picFileKey = data.profile_picture_file_key || null;
        var dn = document.getElementById('profile-edit-display-name').value || data.display_name || data.username || 'U';
        if (picFileId) {
            getDecryptedFileUrl(picFileId, picFileKey, function(url) {
                if (url) {
                    avatarEl.innerHTML = '<img src="' + url + '" alt="Avatar">';
                } else {
                    avatarEl.innerHTML = '<div style="font-size:36px;color:#1a1a2e;font-weight:700;">' + escapeHtml(dn.charAt(0).toUpperCase()) + '</div>';
                }
            });
        } else {
            avatarEl.innerHTML = '<div style="font-size:36px;color:#1a1a2e;font-weight:700;">' + escapeHtml(dn.charAt(0).toUpperCase()) + '</div>';
        }
    }
    
    // Also update the view modal banner/avatar with correct file keys
    var viewBannerImg = document.getElementById('profile-banner-img');
    if (viewBannerImg) {
        var vbFileId = data.profile_banner_file_id;
        var vbFileKey = data.profile_banner_file_key || null;
        if (vbFileId) {
            getDecryptedFileUrl(vbFileId, vbFileKey, function(url) {
                viewBannerImg.style.backgroundImage = url ? 'url(' + url + ')' : '';
            });
        }
    }
    var viewAvatarEl = document.getElementById('profile-modal-avatar');
    if (viewAvatarEl) {
        var vpFileId = data.profile_picture_file_id;
        var vpFileKey = data.profile_picture_file_key || null;
        var dn2 = (decrypted && decrypted.display_name) || data.display_name || data.username || 'U';
        if (vpFileId) {
            getDecryptedFileUrl(vpFileId, vpFileKey, function(url) {
                if (url) {
                    viewAvatarEl.innerHTML = '<img src="' + url + '" alt="Avatar">';
                } else {
                    viewAvatarEl.innerHTML = '<div style="font-size:36px;color:#1a1a2e;font-weight:700;">' + escapeHtml(dn2.charAt(0).toUpperCase()) + '</div>';
                }
            });
        }
    }
}

function renderEditGlowOptions(baseColor) {
    var container = document.getElementById('profile-edit-glow-options');
    if (!container) return;
    var options = generateBorderGlowOptions(baseColor);
    if (!options || options.length === 0) {
        container.innerHTML = '<div style="color:#888;font-size:12px;">No glow options available</div>';
        return;
    }
    var currentBorder = (profileOriginalData && profileOriginalData.data && profileOriginalData.data.username_border_color) || '';
    var html = '';
    var baseIsLight = isLightColor(baseColor);
    var bestGlow = '';
    var bestContrast = -1;
    
    options.forEach(function(o) {
        var val = o.hex || o.value || '';
        // Determine contrasting background for color indicator
        var isLight = isLightColor(val);
        var indicatorBg = isLight ? '#555' : '#ccc';
        html += '<button class="glow-btn" data-value="' + escapeAttr(val) + '">' +
            '<span class="glow-color-circle" style="background:' + val + ';box-shadow:inset 0 0 0 2px ' + indicatorBg + ';"></span>' +
            escapeHtml(o.name) +
            '</button>';
        
        // Track best contrasting glow (opposite brightness from base color)
        var glowBrightness = getColorBrightness(val);
        var baseBrightness = getColorBrightness(baseColor);
        var contrast = Math.abs(glowBrightness - baseBrightness);
        if (contrast > bestContrast) {
            bestContrast = contrast;
            bestGlow = val;
        }
    });
    container.innerHTML = html;
    
    // Auto-select best contrasting glow if no saved glow or base color changed significantly
    var autoSelectGlow = bestGlow;
    if (currentBorder) {
        // Check if current border provides enough contrast
        var currentContrast = Math.abs(getColorBrightness(currentBorder) - getColorBrightness(baseColor));
        if (currentContrast < 60) autoSelectGlow = bestGlow; // Too similar, switch
        else autoSelectGlow = currentBorder;
    }
    
    container.querySelectorAll('.glow-btn').forEach(function(btn) {
        if (btn.dataset.value === autoSelectGlow) {
            btn.classList.add('active');
            // Also update preview textShadow when auto-selecting (e.g. when color changes)
            var editPreview = document.getElementById('profile-edit-display-name-preview');
            if (editPreview && autoSelectGlow) {
                editPreview.style.textShadow = '0 0 8px ' + autoSelectGlow + ', 0 0 16px ' + autoSelectGlow;
            }
        }
        btn.addEventListener('click', function() {
            container.querySelectorAll('.glow-btn').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            // Update live preview glow immediately
            var val = btn.dataset.value;
            var editPreview = document.getElementById('profile-edit-display-name-preview');
            if (editPreview) {
                if (val) {
                    editPreview.style.textShadow = '0 0 8px ' + val + ', 0 0 16px ' + val;
                } else {
                    editPreview.style.textShadow = 'none';
                }
            }
        });
    });
}

function getColorBrightness(hex) {
    if (!hex || hex === 'transparent' || hex === 'none') return 255;
    var c = hex.replace('#', '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    var r = parseInt(c.substring(0,2), 16) || 0;
    var g = parseInt(c.substring(2,4), 16) || 0;
    var b = parseInt(c.substring(4,6), 16) || 0;
    return (r * 299 + g * 587 + b * 114) / 1000;
}

function isLightColor(hex) {
    return getColorBrightness(hex) > 140;
}

// Save profile (encrypt and send to server)
// Verify that the stored password matches the server's hash.
// If the password is wrong or missing, prompts the user to re-enter it.
// Returns the verified password, or null if the user cancels.
// Get or create a device-specific wrapping key for encrypting the password at rest.
// This prevents the raw password from appearing in localStorage if the storage is
// leaked or backed up; the device key is regenerated on every logout/clear.
function getDeviceWrappingKey() {
    var key = localStorage.getItem('e2e_device_key');
    if (!key) {
        key = E2ECrypto.arrayBufferToBase64(E2ECrypto.randomBytes(32));
        localStorage.setItem('e2e_device_key', key);
    }
    return new Uint8Array(E2ECrypto.base64ToArrayBuffer(key));
}

function storeEncryptedPassword(password) {
    var deviceKey = getDeviceWrappingKey();
    var encrypted = E2ECrypto.encodeEncryptedFileKey(btoa(password), deviceKey);
    localStorage.setItem('e2e_encrypted_password', encrypted);
    localStorage.removeItem('e2e_password'); // Remove legacy plaintext
}

function loadDecryptedPassword() {
    // Try encrypted password first
    var encrypted = localStorage.getItem('e2e_encrypted_password');
    if (encrypted) {
        var deviceKey = getDeviceWrappingKey();
        var decryptedB64 = E2ECrypto.decodeEncryptedFileKey(encrypted, deviceKey);
        if (decryptedB64) {
            try { return atob(decryptedB64); } catch (_) {}
        }
    }
    // Fall back to legacy plaintext password and auto-migrate to encrypted
    var legacy = localStorage.getItem('e2e_password');
    if (legacy && !encrypted) {
        storeEncryptedPassword(legacy);
    }
    return legacy || null;
}

async function verifyStoredPassword() {
    var stored = loadDecryptedPassword();
    if (stored) {
        try {
            var res = await authFetch('/api/reauth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: stored })
            });
            if (res.ok) {
                // Update the auth token from the reauth response (extends session)
                try {
                    var reauthData = await res.json();
                    if (reauthData && reauthData.token) {
                        localStorage.setItem('token', reauthData.token);
                    }
                } catch (_) {}
                return stored; // Password is still valid
            }
            // reauth might have failed due to an expired token (not wrong password).
            // Try logging in as a fallback before prompting the user.
            if (user && user.username) {
                try {
                    var loginRes = await fetch('/api/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username: user.username, password: stored })
                    });
                    if (loginRes.ok) {
                        var loginData = await loginRes.json();
                        if (loginData && loginData.token) {
                            localStorage.setItem('token', loginData.token);
                            localStorage.setItem('user', JSON.stringify(loginData.user));
                        }
                        return stored; // Password is fine, token was just stale
                    }
                } catch (_) {}
            }
        } catch (e) {
            // Network error — fall through to asking user
        }
    }
    // Stored password is missing or wrong — ask the user
    var newPassword = prompt('Your password has changed. Please enter your current password:');
    if (newPassword) {
        storeEncryptedPassword(newPassword);
        // Also update the token via reauth with the new password
        try {
            var pwRes = await authFetch('/api/reauth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: newPassword })
            });
            if (pwRes.ok) {
                var pwData = await pwRes.json();
                if (pwData && pwData.token) localStorage.setItem('token', pwData.token);
            }
        } catch (_) {}
        return newPassword;
    }
    return null;
}

async function saveProfile() {
    var statusEl = document.getElementById('profile-edit-status');
    if (!statusEl) return;
    statusEl.style.display = 'block';
    statusEl.style.color = 'var(--text-muted)';
    statusEl.textContent = 'Saving...';
    
    var displayName = document.getElementById('profile-edit-display-name').value.trim();
    var nickname = document.getElementById('profile-edit-nickname').value.trim();
    var description = document.getElementById('profile-edit-description').value.trim();
    var color = document.getElementById('profile-edit-color').value;
    
    var bgColor = document.getElementById('profile-edit-bg-color').value;
    
    var glowBtn = document.querySelector('#profile-edit-glow-options .glow-btn.active');
    var borderColor = glowBtn ? glowBtn.dataset.value : '';
    
    // Validate
    if (displayName.length > 32) { statusEl.textContent = 'Display name too long (max 32 chars)'; statusEl.style.color = 'var(--danger)'; return; }
    if (nickname.length > 32) { statusEl.textContent = 'Nickname too long (max 32 chars)'; statusEl.style.color = 'var(--danger)'; return; }
    // Hard-cap description at 300 words — truncate if over
    if (description) {
        var words = description.split(/\s+/);
        if (words.length > 300) {
            words = words.slice(0, 300);
            description = words.join(' ');
            // Update the input field so the user sees the truncated value
            document.getElementById('profile-edit-description').value = description;
            updateDescriptionWordCount();
        }
    }
    var wordCount = description ? description.trim().split(/\s+/).length : 0;
    if (wordCount > 300) { statusEl.textContent = 'Description too long (max 300 words)'; statusEl.style.color = 'var(--danger)'; return; }
    
    try {
        // Build profile data to encrypt
        var profileData = {
            display_name: displayName,
            nickname: nickname,
            description: description,
            username_color: color,
            username_border_color: borderColor,
            profile_background_color: bgColor
        };
        
        // Verify stored password against server before encrypting
        var password = await verifyStoredPassword();
        if (!password) {
            statusEl.textContent = 'Password is required to save profile.';
            statusEl.style.color = 'var(--danger)';
            return;
        }
        
        var encrypted = E2ECrypto.encryptWithPassword(JSON.stringify(profileData), password);
        
        // Build API request
        var body = {
            display_name: displayName,
            nickname: nickname,
            description: description,
            username_color: color,
            encrypted_profile_data: encrypted.encrypted_private_key,
            encrypted_profile_salt: encrypted.salt,
            encrypted_profile_nonce: encrypted.nonce
        };
        // Only send border color if one is selected (skip empty string to avoid server validation error)
        body.profile_background_color = bgColor;
        if (borderColor) {
            body.username_border_color = borderColor;
        }
        
        // Handle banner and PFP uploads
        if (profileBannerFileId) {
            body.profile_banner_file_id = profileBannerFileId;
            body.profile_banner_file_key = profileBannerFileKey || null;
        }
        if (profilePfpFileId) {
            body.profile_picture_file_id = profilePfpFileId;
            body.profile_picture_file_key = profilePfpFileKey || null;
        }
        
        var res = await authFetch('/api/profile', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        
        if (!res.ok) {
            var errData = await res.json().catch(function() { return {}; });
            statusEl.textContent = errData.error || 'Failed to save profile';
            statusEl.style.color = 'var(--danger)';
            return;
        }
        
        statusEl.textContent = 'Profile saved!';
        statusEl.style.color = 'var(--success)';
        
        // Reload profile data and explicitly update the sidebar footer
        await loadMyProfile();
        // Clear any cached PFP that might be stale
        var oldPfpId = myProfile && myProfile.profile_picture_file_id;
        if (oldPfpId && profilePfpFileId && oldPfpId !== profilePfpFileId) {
            delete profilePicCache[user.id + ':' + oldPfpId];
        }
        updateSidebarFooter();
        
        // Refresh the view
        var res2 = await authFetch('/api/profile/' + encodeURIComponent(user.id));
        if (res2.ok) {
            var data2 = await res2.json();
            profileOriginalData = { data: data2, decrypted: profileData };
            renderProfileView(data2, profileData, user.id);
        }
        
        document.getElementById('profile-edit-modal').style.display = 'none';
        profileEditMode = false;
        
        setTimeout(function() { statusEl.style.display = 'none'; }, 2000);
    } catch (e) {
        statusEl.textContent = 'Error saving profile: ' + e.message;
        statusEl.style.color = 'var(--danger)';
    }
}

// ===== Right-panel crop for Banner =====
function openBannerCrop(file) {
    if (!file.type.startsWith('image/')) { alert('Please select an image file.'); return; }
    // Cancel any existing PFP crop first
    if (pfpCropState) cancelPfpCrop();
    
    var container = document.getElementById('profile-banner-crop-container');
    var cropImg = document.getElementById('profile-banner-crop-img');
    var box = document.getElementById('profile-banner-crop-box');
    var handle = document.getElementById('profile-banner-crop-handle');
    
    var reader = new FileReader();
    reader.onload = function(e) {
        var dataUrl = e.target.result;
        cropImg.src = dataUrl;
        container.style.display = 'block';
        container.style.width = '';
        
        cropImg.onload = function() {
            var frame = cropImg.parentElement;
            var imgW = cropImg.naturalWidth;
            var imgH = cropImg.naturalHeight;
            
            // Scale image to FIT (show all corners) — compute display size first
            var maxFrameW = frame.offsetWidth;
            var maxFrameH = frame.offsetHeight;
            var scale = Math.min(maxFrameW / imgW, maxFrameH / imgH);
            var dispW = Math.round(imgW * scale);
            var dispH = Math.round(imgH * scale);
            
            // Resize the frame to match the image (removes black space)
            frame.style.width = dispW + 'px';
            frame.style.height = dispH + 'px';
            
            cropImg.style.width = dispW + 'px';
            cropImg.style.height = dispH + 'px';
            cropImg.style.display = 'block';
            
            // Use image dimensions as the crop area (no overflow, no black space)
            var effectiveW = dispW;
            var effectiveH = dispH;
            
            // Center the image initially so all edges of the image can be reached
            var initOffX = -(dispW - effectiveW) / 2;
            var initOffY = -(dispH - effectiveH) / 2;
            cropImg.style.top = initOffY + 'px';
            cropImg.style.left = initOffX + 'px';
            
            // Scale factors: natural pixels per displayed pixel
            var scaleX = cropImg.naturalWidth / dispW;
            var scaleY = cropImg.naturalHeight / dispH;
            
            // Initial crop centered in the visible area
            var initW = Math.round(effectiveW * 0.7);
            var initH = Math.round(initW * 0.45);
            var initX = Math.round((effectiveW - initW) / 2) - initOffX;
            var initY = Math.round((effectiveH - initH) / 2) - initOffY;
            
            bannerCropState = {
                file: file, img: cropImg, dataUrl: dataUrl,
                startX: initX, startY: initY,
                width: initW, height: initH,
                imgOffX: initOffX, imgOffY: initOffY,
                dispW: effectiveW, dispH: effectiveH,
                fullDispW: dispW, fullDispH: dispH,
                scaleX: scaleX, scaleY: scaleY,
                isDragging: false, isResizing: false,
                dragStartX: 0, dragStartY: 0,
                startLeft: 0, startTop: 0, startSize: 0
            };
            
            updateBannerCropBox();
            updateBannerLivePreview();
            
            // Pan the image so the crop box is visible within the frame
            function panImageForCrop() {
                var s = bannerCropState;
                if (!s) return;
                // Keep crop box visible horizontally
                var cropLeft = s.startX + s.imgOffX;
                var cropRight = cropLeft + s.width;
                if (cropLeft < 0) {
                    s.imgOffX = -s.startX;
                } else if (cropRight > s.dispW) {
                    s.imgOffX = s.dispW - s.startX - s.width;
                }
                // Keep crop box visible vertically
                var cropTop = s.startY + s.imgOffY;
                var cropBottom = cropTop + s.height;
                if (cropTop < 0) {
                    s.imgOffY = -s.startY;
                } else if (cropBottom > s.dispH) {
                    s.imgOffY = s.dispH - s.startY - s.height;
                }
                // Clamp to image bounds (can't move more than the overflow)
                var maxOffX = 0;
                var minOffX = -(s.fullDispW - s.dispW);
                s.imgOffX = Math.max(minOffX, Math.min(maxOffX, s.imgOffX));
                var maxOffY = 0;
                var minOffY = -(s.fullDispH - s.dispH);
                s.imgOffY = Math.max(minOffY, Math.min(maxOffY, s.imgOffY));
                // Apply to image element
                s.img.style.left = s.imgOffX + 'px';
                s.img.style.top = s.imgOffY + 'px';
            }
            
            // Drag
            function startDrag(ev) {
                var e = ev.touches ? ev.touches[0] : ev;
                bannerCropState.isDragging = true;
                bannerCropState.dragStartX = e.clientX;
                bannerCropState.dragStartY = e.clientY;
                bannerCropState.startLeft = bannerCropState.startX;
                bannerCropState.startTop = bannerCropState.startY;
                ev.preventDefault();
            }
            function onDrag(ev) {
                if (!bannerCropState.isDragging) return;
                var e = ev.touches ? ev.touches[0] : ev;
                var dx = e.clientX - bannerCropState.dragStartX;
                var dy = e.clientY - bannerCropState.dragStartY;
                var maxX = bannerCropState.dispW - bannerCropState.width;
                var maxY = bannerCropState.dispH - bannerCropState.height;
                bannerCropState.startX = Math.max(0, Math.min(maxX, bannerCropState.startLeft + dx));
                bannerCropState.startY = Math.max(0, Math.min(maxY, bannerCropState.startTop + dy));
                panImageForCrop();
                updateBannerCropBox();
                updateBannerLivePreview();
                ev.preventDefault();
            }
            // Resize
            function startResize(ev) {
                var e = ev.touches ? ev.touches[0] : ev;
                bannerCropState.isResizing = true;
                bannerCropState.dragStartX = e.clientX;
                bannerCropState.dragStartY = e.clientY;
                bannerCropState.startSize = bannerCropState.width;
                bannerCropState.startLeft = bannerCropState.startX;
                bannerCropState.startTop = bannerCropState.startY;
                ev.preventDefault();
                ev.stopPropagation();
            }
            function onResize(ev) {
                if (!bannerCropState.isResizing) return;
                var e = ev.touches ? ev.touches[0] : ev;
                var dx = e.clientX - bannerCropState.dragStartX;
                var newW = Math.max(40, bannerCropState.startSize + dx);
                var newH = Math.round(newW * (bannerCropState.height / bannerCropState.width));
                if (newH > bannerCropState.dispH - bannerCropState.startTop) {
                    newH = bannerCropState.dispH - bannerCropState.startTop;
                    newW = Math.round(newH * (bannerCropState.width / bannerCropState.height));
                }
                bannerCropState.width = newW;
                bannerCropState.height = newH;
                panImageForCrop();
                updateBannerCropBox();
                updateBannerLivePreview();
                ev.preventDefault();
            }
            function endDrag() {
                bannerCropState.isDragging = false;
                bannerCropState.isResizing = false;
            }
            
            box.addEventListener('mousedown', startDrag);
            box.addEventListener('touchstart', startDrag, { passive: false });
            handle.addEventListener('mousedown', startResize);
            handle.addEventListener('touchstart', startResize, { passive: false });
            document.addEventListener('mousemove', onDrag);
            document.addEventListener('touchmove', onDrag, { passive: false });
            document.addEventListener('mousemove', onResize);
            document.addEventListener('touchmove', onResize, { passive: false });
            document.addEventListener('mouseup', endDrag);
            document.addEventListener('touchend', endDrag);
            
            bannerCropState._cleanup = function() {
                box.removeEventListener('mousedown', startDrag);
                box.removeEventListener('touchstart', startDrag);
                handle.removeEventListener('mousedown', startResize);
                handle.removeEventListener('touchstart', startResize);
                document.removeEventListener('mousemove', onDrag);
                document.removeEventListener('touchmove', onDrag);
                document.removeEventListener('mousemove', onResize);
                document.removeEventListener('touchmove', onResize);
                document.removeEventListener('mouseup', endDrag);
                document.removeEventListener('touchend', endDrag);
            };
        };
    };
    reader.readAsDataURL(file);
}

function updateBannerCropBox() {
    var s = bannerCropState;
    if (!s) return;
    var box = document.getElementById('profile-banner-crop-box');
    if (box) {
        box.style.left = s.startX + 'px';
        box.style.top = s.startY + 'px';
        box.style.width = s.width + 'px';
        box.style.height = s.height + 'px';
    }
}

function updateBannerLivePreview() {
    var s = bannerCropState;
    if (!s) return;
    var canvas = document.createElement('canvas');
    // Account for image offset: the crop box is at startX/startY relative to the frame,
    // but the image is shifted by imgOffX/imgOffY, so the image pixel at the crop is (startX - imgOffX)
    var natX = Math.round((s.startX - s.imgOffX) * s.scaleX);
    var natY = Math.round((s.startY - s.imgOffY) * s.scaleY);
    var natW = Math.round(s.width * s.scaleX);
    var natH = Math.round(s.height * s.scaleY);
    canvas.width = natW;
    canvas.height = natH;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(s.img, natX, natY, natW, natH, 0, 0, natW, natH);
    var dataUrl = canvas.toDataURL('image/png');
    document.getElementById('profile-banner-img').style.backgroundImage = 'url(' + dataUrl + ')';
    // Also update edit modal preview if editing
    var editBanner = document.getElementById('profile-edit-banner-img');
    if (editBanner) editBanner.style.backgroundImage = 'url(' + dataUrl + ')';
    canvas.width = 0;
    canvas.height = 0;
}

function cancelBannerCrop() {
    document.getElementById('profile-banner-crop-container').style.display = 'none';
    if (bannerCropState && bannerCropState._cleanup) {
        bannerCropState._cleanup();
    }
    bannerCropState = null;
    // Restore original banner in both view and edit previews
    if (profileOriginalData) {
        var data = profileOriginalData.data;
        var bannerImg = document.getElementById('profile-banner-img');
        var editBannerImg = document.getElementById('profile-edit-banner-img');
        var restoreFn = function(url) {
            var bgVal = url ? 'url(' + url + ')' : '';
            if (bannerImg) bannerImg.style.backgroundImage = bgVal;
            if (editBannerImg) editBannerImg.style.backgroundImage = bgVal;
        };
        var bannerFileId = data.profile_banner_file_id;
        var bannerFileKey = data.profile_banner_file_key || null;
        if (bannerFileId) {
            getDecryptedFileUrl(bannerFileId, bannerFileKey, restoreFn);
        } else {
            restoreFn(null);
        }
    }
}

async function processBannerCrop() {
    if (!bannerCropState) return;
    try {
        var s = bannerCropState;
        var canvas = document.createElement('canvas');
        // Account for image offset
        var natX = Math.round((s.startX - s.imgOffX) * s.scaleX);
        var natY = Math.round((s.startY - s.imgOffY) * s.scaleY);
        var natW = Math.round(s.width * s.scaleX);
        var natH = Math.round(s.height * s.scaleY);
        canvas.width = natW;
        canvas.height = natH;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(s.img, natX, natY, natW, natH, 0, 0, natW, natH);
        
        var blob = await new Promise(function(resolve) { canvas.toBlob(resolve, 'image/png'); });
        if (!blob) throw new Error('Canvas to blob failed');
        
        var croppedFile = new File([blob], 'banner_crop.png', { type: 'image/png' });
        var uploadResult = await uploadBannerImage(croppedFile);
        if (!uploadResult) throw new Error('Upload failed');
        
        profileBannerFileId = uploadResult.fileId;
        profileBannerFileKey = uploadResult.fileKey;
        document.getElementById('profile-banner-crop-container').style.display = 'none';
        if (bannerCropState && bannerCropState._cleanup) bannerCropState._cleanup();
        bannerCropState = null;
        canvas.width = 0;
        canvas.height = 0;
    } catch (e) {
        alert('Banner crop failed: ' + e.message);
    }
}

// ===== Right-panel crop for Profile Picture =====
function openPfpCrop(file) {
    if (!file.type.startsWith('image/')) { alert('Please select an image file.'); return; }
    // Cancel any existing banner crop first
    if (bannerCropState) cancelBannerCrop();
    
    var container = document.getElementById('profile-pfp-crop-container');
    var cropImg = document.getElementById('profile-pfp-crop-img');
    var box = document.getElementById('profile-pfp-crop-box');
    var handle = document.getElementById('profile-pfp-crop-handle');
    
    var reader = new FileReader();
    reader.onload = function(e) {
        var dataUrl = e.target.result;
        cropImg.src = dataUrl;
        container.style.display = 'block';
        container.style.width = '';
        
        cropImg.onload = function() {
            var frame = cropImg.parentElement;
            var imgW = cropImg.naturalWidth;
            var imgH = cropImg.naturalHeight;
            
            // Scale image to FIT (show all corners) — compute display size first
            var maxFrameW = frame.offsetWidth;
            var maxFrameH = frame.offsetHeight;
            var scale = Math.min(maxFrameW / imgW, maxFrameH / imgH);
            var dispW = Math.round(imgW * scale);
            var dispH = Math.round(imgH * scale);
            
            // Resize the frame to match the image (removes black space)
            frame.style.width = dispW + 'px';
            frame.style.height = dispH + 'px';
            
            cropImg.style.width = dispW + 'px';
            cropImg.style.height = dispH + 'px';
            cropImg.style.display = 'block';
            
            // Use image dimensions as the crop area (no overflow, no black space)
            var effectiveW = dispW;
            var effectiveH = dispH;
            
            // Center the image initially so all edges can be reached
            var initOffX = -(dispW - effectiveW) / 2;
            var initOffY = -(dispH - effectiveH) / 2;
            cropImg.style.top = initOffY + 'px';
            cropImg.style.left = initOffX + 'px';
            
            // Scale factors
            var scaleX = cropImg.naturalWidth / dispW;
            var scaleY = cropImg.naturalHeight / dispH;
            
            // Initial crop: centered square within visible area, accounting for image offset
            var initSize = Math.min(effectiveW, effectiveH) * 0.7;
            var initX = Math.round((effectiveW - initSize) / 2) - initOffX;
            var initY = Math.round((effectiveH - initSize) / 2) - initOffY;
            
            pfpCropState = {
                file: file, img: cropImg, dataUrl: dataUrl,
                startX: initX, startY: initY, size: initSize,
                imgOffX: initOffX, imgOffY: initOffY,
                dispW: effectiveW, dispH: effectiveH,
                fullDispW: dispW, fullDispH: dispH,
                scaleX: scaleX, scaleY: scaleY,
                isDragging: false, isResizing: false,
                dragStartX: 0, dragStartY: 0,
                startLeft: 0, startTop: 0, startSize: 0
            };
            
            updatePfpCropBox();
            updatePfpLivePreview();
            
            // Pan the image so the crop box is visible within the frame
            function panPfpImage() {
                var s = pfpCropState;
                if (!s) return;
                // Keep crop box visible horizontally
                var cropLeft = s.startX + s.imgOffX;
                var cropRight = cropLeft + s.size;
                if (cropLeft < 0) {
                    s.imgOffX = -s.startX;
                } else if (cropRight > s.dispW) {
                    s.imgOffX = s.dispW - s.startX - s.size;
                }
                // Keep crop box visible vertically
                var cropTop = s.startY + s.imgOffY;
                var cropBottom = cropTop + s.size;
                if (cropTop < 0) {
                    s.imgOffY = -s.startY;
                } else if (cropBottom > s.dispH) {
                    s.imgOffY = s.dispH - s.startY - s.size;
                }
                // Clamp to image bounds
                var maxOffX = 0;
                var minOffX = -(s.fullDispW - s.dispW);
                s.imgOffX = Math.max(minOffX, Math.min(maxOffX, s.imgOffX));
                var maxOffY = 0;
                var minOffY = -(s.fullDispH - s.dispH);
                s.imgOffY = Math.max(minOffY, Math.min(maxOffY, s.imgOffY));
                // Apply to image element
                s.img.style.left = s.imgOffX + 'px';
                s.img.style.top = s.imgOffY + 'px';
            }
            
            // Drag
            function startDrag(ev) {
                var e = ev.touches ? ev.touches[0] : ev;
                pfpCropState.isDragging = true;
                pfpCropState.dragStartX = e.clientX;
                pfpCropState.dragStartY = e.clientY;
                pfpCropState.startLeft = pfpCropState.startX;
                pfpCropState.startTop = pfpCropState.startY;
                ev.preventDefault();
            }
            function onDrag(ev) {
                if (!pfpCropState.isDragging) return;
                var e = ev.touches ? ev.touches[0] : ev;
                var dx = e.clientX - pfpCropState.dragStartX;
                var dy = e.clientY - pfpCropState.dragStartY;
                var maxX = pfpCropState.dispW - pfpCropState.size;
                var maxY = pfpCropState.dispH - pfpCropState.size;
                pfpCropState.startX = Math.max(0, Math.min(maxX, pfpCropState.startLeft + dx));
                pfpCropState.startY = Math.max(0, Math.min(maxY, pfpCropState.startTop + dy));
                panPfpImage();
                updatePfpCropBox();
                updatePfpLivePreview();
                ev.preventDefault();
            }
            // Resize (maintains square aspect)
            function startResize(ev) {
                var e = ev.touches ? ev.touches[0] : ev;
                pfpCropState.isResizing = true;
                pfpCropState.dragStartX = e.clientX;
                pfpCropState.dragStartY = e.clientY;
                pfpCropState.startSize = pfpCropState.size;
                pfpCropState.startLeft = pfpCropState.startX;
                pfpCropState.startTop = pfpCropState.startY;
                ev.preventDefault();
                ev.stopPropagation();
            }
            function onResize(ev) {
                if (!pfpCropState.isResizing) return;
                var e = ev.touches ? ev.touches[0] : ev;
                var dx = e.clientX - pfpCropState.dragStartX;
                var maxSize = Math.min(pfpCropState.dispW - pfpCropState.startLeft, pfpCropState.dispH - pfpCropState.startTop);
                pfpCropState.size = Math.max(20, Math.min(maxSize, pfpCropState.startSize + dx));
                panPfpImage();
                updatePfpCropBox();
                updatePfpLivePreview();
                ev.preventDefault();
            }
            function endDrag() {
                pfpCropState.isDragging = false;
                pfpCropState.isResizing = false;
            }
            
            box.addEventListener('mousedown', startDrag);
            box.addEventListener('touchstart', startDrag, { passive: false });
            handle.addEventListener('mousedown', startResize);
            handle.addEventListener('touchstart', startResize, { passive: false });
            document.addEventListener('mousemove', onDrag);
            document.addEventListener('touchmove', onDrag, { passive: false });
            document.addEventListener('mousemove', onResize);
            document.addEventListener('touchmove', onResize, { passive: false });
            document.addEventListener('mouseup', endDrag);
            document.addEventListener('touchend', endDrag);
            
            pfpCropState._cleanup = function() {
                box.removeEventListener('mousedown', startDrag);
                box.removeEventListener('touchstart', startDrag);
                handle.removeEventListener('mousedown', startResize);
                handle.removeEventListener('touchstart', startResize);
                document.removeEventListener('mousemove', onDrag);
                document.removeEventListener('touchmove', onDrag);
                document.removeEventListener('mousemove', onResize);
                document.removeEventListener('touchmove', onResize);
                document.removeEventListener('mouseup', endDrag);
                document.removeEventListener('touchend', endDrag);
            };
        };
    };
    reader.readAsDataURL(file);
}

function updatePfpCropBox() {
    var s = pfpCropState;
    if (!s) return;
    var box = document.getElementById('profile-pfp-crop-box');
    if (box) {
        box.style.left = s.startX + 'px';
        box.style.top = s.startY + 'px';
        box.style.width = s.size + 'px';
        box.style.height = s.size + 'px';
    }
}

function updatePfpLivePreview() {
    var s = pfpCropState;
    if (!s) return;
    var canvas = document.createElement('canvas');
    var natX = Math.round((s.startX - s.imgOffX) * s.scaleX);
    var natY = Math.round((s.startY - s.imgOffY) * s.scaleY);
    var natSize = Math.round(s.size * s.scaleX);
    canvas.width = natSize;
    canvas.height = natSize;
    var ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.arc(natSize/2, natSize/2, natSize/2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(s.img, natX, natY, natSize, natSize, 0, 0, natSize, natSize);
    var dataUrl = canvas.toDataURL('image/png');
    var avatarEl = document.getElementById('profile-modal-avatar');
    avatarEl.innerHTML = '<img src="' + dataUrl + '" alt="Avatar">';
    // Also update edit modal preview if editing
    var editAvatar = document.getElementById('profile-edit-avatar');
    if (editAvatar) editAvatar.innerHTML = '<img src="' + dataUrl + '" alt="Avatar">';
    canvas.width = 0;
    canvas.height = 0;
}

function cancelPfpCrop() {
    document.getElementById('profile-pfp-crop-container').style.display = 'none';
    if (pfpCropState && pfpCropState._cleanup) {
        pfpCropState._cleanup();
    }
    pfpCropState = null;
    // Restore original avatar in both view and edit previews
    if (profileOriginalData) {
        var data = profileOriginalData.data;
        var displayName = (profileOriginalData.decrypted && profileOriginalData.decrypted.display_name) || data.display_name || data.username || 'Unknown';
        var avatarEl = document.getElementById('profile-modal-avatar');
        var editAvatarEl = document.getElementById('profile-edit-avatar');
        var restoreFn = function(url) {
            var html = url ? '<img src="' + url + '" alt="Avatar">' : '<div style="font-size:36px;color:#1a1a2e;font-weight:700;">' + escapeHtml(displayName.charAt(0).toUpperCase()) + '</div>';
            if (avatarEl) avatarEl.innerHTML = html;
            if (editAvatarEl) editAvatarEl.innerHTML = html;
        };
        var picFileId = data.profile_picture_file_id;
        var picFileKey = data.profile_picture_file_key || null;
        if (picFileId) {
            getDecryptedFileUrl(picFileId, picFileKey, restoreFn);
        } else {
            restoreFn(null);
        }
    }
}

async function processPfpCrop() {
    if (!pfpCropState) return;
    try {
        var s = pfpCropState;
        var canvas = document.createElement('canvas');
        var natX = Math.round((s.startX - s.imgOffX) * s.scaleX);
        var natY = Math.round((s.startY - s.imgOffY) * s.scaleY);
        var natSize = Math.round(s.size * s.scaleX);
        canvas.width = natSize;
        canvas.height = natSize;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(s.img, natX, natY, natSize, natSize, 0, 0, natSize, natSize);
        
        var blob = await new Promise(function(resolve) { canvas.toBlob(resolve, 'image/png'); });
        if (!blob) throw new Error('Canvas to blob failed');
        
        var croppedFile = new File([blob], 'avatar_crop.png', { type: 'image/png' });
        var uploadResult = await uploadBannerImage(croppedFile);
        if (!uploadResult) throw new Error('Upload failed');
        
        profilePfpFileId = uploadResult.fileId;
        profilePfpFileKey = uploadResult.fileKey;
        document.getElementById('profile-pfp-crop-container').style.display = 'none';
        if (pfpCropState && pfpCropState._cleanup) pfpCropState._cleanup();
        pfpCropState = null;
        canvas.width = 0;
        canvas.height = 0;
        
        // Show remove button
        document.getElementById('profile-avatar-remove-btn').style.display = '';
    } catch (e) {
        alert('PFP crop failed: ' + e.message);
    }
}

// Upload a processed image file with encryption, return { fileId, fileKey }
async function uploadBannerImage(file) {
    var fileKey = E2ECrypto.generateFileKey();
    var fileKeyB64 = E2ECrypto.arrayBufferToBase64(fileKey);

    var initRes = await authFetch('/api/files/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ size: file.size, mime: file.type || 'image/png' })
    });
    if (!initRes.ok) throw new Error('Failed to init upload');
    var initData = await initRes.json();
    var fileId = initData.file_id;

    var CHUNK_SIZE = 64 * 1024;
    var totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    for (var i = 0; i < totalChunks; i++) {
        var start = i * CHUNK_SIZE;
        var end = Math.min(start + CHUNK_SIZE, file.size);
        var chunkData = new Uint8Array(await file.slice(start, end).arrayBuffer());
        var encryptedChunk = E2ECrypto.encryptFileChunk(fileKey, chunkData);
        var chunkRes = await authFetch('/api/files/' + fileId + '/chunk/' + i, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: encryptedChunk
        });
        if (!chunkRes.ok) throw new Error('Failed to upload chunk ' + (i + 1));
    }

    var completeRes = await authFetch('/api/files/' + fileId + '/complete', { method: 'POST' });
    if (!completeRes.ok) throw new Error('Failed to complete upload');

    fileKeyCache.set(fileId, fileKeyB64);

    return { fileId: fileId, fileKey: fileKeyB64 };
}

// ===== Favorite GIF on .gif file cards =====
