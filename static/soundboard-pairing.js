// F12: Soundboard (per-account, identity-key encrypted) + F6: QR-code device pairing
(function () {
    'use strict';

    // === SOUNDBOARD ===
    var _sbOverlay = document.getElementById('soundboard-overlay');
    var _sbClips = document.getElementById('soundboard-clips');
    var _sbFile = document.getElementById('soundboard-file');
    var _sbUploadBtn = document.getElementById('soundboard-upload-btn');
    var _sbClose = document.getElementById('soundboard-close');
    var _sbBtn = document.getElementById('voice-popup-soundboard');
    var _sbDmBtn = document.getElementById('dm-call-soundboard');
    var _sbVoiceBarBtn = document.getElementById('voice-bar-soundboard');
    var _sbPlaying = null; // currently playing Audio element (from overlay play button)
    var _sbSelfHear = false; // play sounds for ourselves too
    var _sbClipsCache = []; // cached clips for play lookups
    var _sbAllPlaying = []; // all active Audio elements (for stop-on-leave)

    // --- Per-account disable soundboard (stored in localStorage, used by Settings→Voice + voice-popup) ---
    function _isSbDisabledGlobal() {
        return localStorage.getItem('sb_disabled_global') === '1';
    }
    function _setSbDisabledGlobal(disabled) {
        localStorage.setItem('sb_disabled_global', disabled ? '1' : '0');
        // Sync all three checkboxes
        syncDisableCheckboxes(disabled);
    }
    function syncDisableCheckboxes(disabled) {
        var ids = ['voice-disable-soundboard', 'voice-popup-disable-sb'];
        ids.forEach(function (id) {
            var cb = document.getElementById(id);
            if (cb) cb.checked = disabled;
        });
    }

    // Wire up Settings→Voice checkbox
    var _svCb = document.getElementById('voice-disable-soundboard');
    if (_svCb) {
        _svCb.checked = _isSbDisabledGlobal();
        _svCb.addEventListener('change', function () { _setSbDisabledGlobal(_svCb.checked); });
    }
    // Wire up voice-popup-settings checkbox
    var _vpCb = document.getElementById('voice-popup-disable-sb');
    if (_vpCb) {
        _vpCb.checked = _isSbDisabledGlobal();
        _vpCb.addEventListener('change', function () { _setSbDisabledGlobal(_vpCb.checked); });
    }

    // --- Per-user mute: stored in localStorage (like custom volume) ---
    function _getMutedKey() {
        var sid = window.currentServerId || '_global';
        return 'sb_muted_' + sid;
    }
    function _getMutedList() {
        try { return JSON.parse(localStorage.getItem(_getMutedKey()) || '[]'); } catch (_) { return []; }
    }
    function _saveMutedList(list) {
        try { localStorage.setItem(_getMutedKey(), JSON.stringify(list)); } catch (_) {}
    }
    function _isUserMuted(userId) {
        return _getMutedList().indexOf(userId) !== -1;
    }
    function _toggleMuteUser(userId) {
        var list = _getMutedList();
        var idx = list.indexOf(userId);
        if (idx !== -1) { list.splice(idx, 1); } else { list.push(userId); }
        _saveMutedList(list);
        return idx === -1; // returns true if now muted
    }
    // Expose for external checks
    window._sbIsUserMuted = _isUserMuted;
    window._sbMutedList = { indexOf: function(uid) { return _getMutedList().indexOf(uid); } };

    // Wire up all soundboard open buttons
    function openSbOverlay() {
        if (_sbOverlay) _sbOverlay.style.display = 'flex';
        loadSoundboardClips();
    }
    if (_sbBtn) _sbBtn.onclick = openSbOverlay;
    if (_sbDmBtn) _sbDmBtn.onclick = openSbOverlay;
    if (_sbVoiceBarBtn) _sbVoiceBarBtn.onclick = openSbOverlay;
    if (_sbClose) {
        _sbClose.onclick = function () { _sbOverlay.style.display = 'none'; };
    }
    if (_sbOverlay) {
        _sbOverlay.addEventListener('click', function (e) {
            if (e.target === _sbOverlay) _sbOverlay.style.display = 'none';
        });
    }

    // Self-hear toggle
    var _sbSelfHearEl = document.getElementById('soundboard-self-hear');
    if (_sbSelfHearEl) {
        _sbSelfHearEl.addEventListener('change', function () {
            _sbSelfHear = _sbSelfHearEl.checked;
        });
    }

    if (_sbUploadBtn) {
        _sbUploadBtn.onclick = function () { _sbFile.click(); };
    }
    if (_sbFile) {
        _sbFile.addEventListener('change', handleSoundboardUpload);
    }

    function authHeaders() {
        var t = window.token || localStorage.getItem('token');
        return t ? { 'Authorization': 'Bearer ' + t } : {};
    }

    function _showSbProgress(msg) {
        var bar = document.getElementById('soundboard-progress');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'soundboard-progress';
            bar.style.cssText = 'text-align:center;padding:10px;color:var(--accent);font-size:13px;animation:sbPulse 1.2s ease-in-out infinite;';
            var clips = document.getElementById('soundboard-clips');
            if (clips) clips.parentElement.insertBefore(bar, clips);
        }
        bar.textContent = msg;
        bar.style.display = 'block';
    }
    function _hideSbProgress() {
        var bar = document.getElementById('soundboard-progress');
        if (bar) bar.style.display = 'none';
    }

    async function handleSoundboardUpload() {
        var file = _sbFile.files[0];
        if (!file) return;
        var serverId = window.currentServerId || '_global';
        try {
            _showSbProgress('Decoding audio...');
            var ctx = new (window.AudioContext || window.webkitAudioContext)();
            var buf = await file.arrayBuffer();
            _showSbProgress('Processing audio...');
            var audio = await ctx.decodeAudioData(buf);
            var wavBuffer = audioBufferToWav(audio);
            var wavBytes = new Uint8Array(wavBuffer);

            _showSbProgress('Encrypting with identity key...');
            var E = window.E2ECrypto;
            var identity = E && E.getIdentityKeyPair();
            var encrypted, nonce;
            if (identity) {
                var enc = E.envelopeEncrypt(wavBytes, identity.publicKey, identity.privateKey);
                encrypted = enc.ciphertext;
                nonce = enc.nonce;
            } else {
                encrypted = uint8ToBase64(wavBytes);
                nonce = '';
            }

            var name = file.name.replace(/\.[^.]+$/, '');
            _showSbProgress('Uploading...');
            var resp = await fetch('/api/soundboard', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({
                    server_id: serverId,
                    name: name,
                    encrypted_audio: encrypted,
                    audio_nonce: nonce,
                    duration_ms: Math.round(audio.duration * 1000),
                })
            });
            var data = await resp.json();
            _hideSbProgress();
            if (data.ok) {
                loadSoundboardClips();
            } else {
                alert('Upload failed: ' + (data.error || 'unknown'));
            }
            ctx.close();
        } catch (e) {
            _hideSbProgress();
            console.error('Soundboard upload error:', e);
            alert('Failed to process audio: ' + e.message);
        }
        _sbFile.value = '';
    }

    function audioBufferToWav(buffer) {
        var numChannels = buffer.numberOfChannels;
        var sampleRate = buffer.sampleRate;
        var format = 1;
        var bitDepth = 16;
        var bytesPerSample = bitDepth / 8;
        var blockAlign = numChannels * bytesPerSample;
        var samples = buffer.length;
        var dataSize = samples * blockAlign;
        var headerSize = 44;
        var arrayBuffer = new ArrayBuffer(headerSize + dataSize);
        var view = new DataView(arrayBuffer);
        function writeString(offset, str) {
            for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
        }
        writeString(0, 'RIFF');
        view.setUint32(4, 36 + dataSize, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, format, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * blockAlign, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitDepth, true);
        writeString(36, 'data');
        view.setUint32(40, dataSize, true);
        var offset = 44;
        for (var i = 0; i < samples; i++) {
            for (var ch = 0; ch < numChannels; ch++) {
                var sample = buffer.getChannelData(ch)[i];
                sample = Math.max(-1, Math.min(1, sample));
                view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
                offset += 2;
            }
        }
        return arrayBuffer;
    }

    function uint8ToBase64(bytes) {
        var binary = '';
        for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }

    function _decryptSbClip(clip) {
        var E = window.E2ECrypto;
        if (!E || !clip) return null;
        var identity = E.getIdentityKeyPair();
        if (!identity) return null;
        try {
            var pt = E.envelopeDecrypt(clip.encrypted_audio, identity.privateKey, identity.publicKey, clip.audio_nonce);
            return pt;
        } catch (e) {
            console.error('Soundboard decrypt error:', e);
            return null;
        }
    }

    async function loadSoundboardClips() {
        if (!_sbClips) return;
        // Show loading state while fetching
        if (_sbClipsCache.length === 0) {
            _sbClips.innerHTML = '<div class="soundboard-empty" style="animation:sbPulse 1.2s ease-in-out infinite">Loading sounds...</div>';
        }
        try {
            var resp = await fetch('/api/soundboard/my', { headers: authHeaders() });
            var clips = await resp.json();
            _sbClipsCache = Array.isArray(clips) ? clips : [];
            if (_sbClipsCache.length === 0) {
                _sbClips.innerHTML = '<div class="soundboard-empty">No sounds yet. Upload an audio file to get started!</div>';
                return;
            }
            var html = '';
            _sbClipsCache.forEach(function (clip) {
                html += '<div class="soundboard-clip" data-clip-id="' + clip.id + '">' +
                    '<div class="soundboard-clip-info"><span class="soundboard-clip-name">' + escapeHtml(clip.name) + '</span>' +
                    '<span class="soundboard-clip-dur">' + (clip.duration_ms / 1000).toFixed(1) + 's</span></div>' +
                    '<div class="soundboard-clip-actions">' +
                    '<button class="sb-play-btn" title="Play">&#9654;</button>' +
                    '<button class="sb-pause-btn" title="Pause/Stop" style="display:none">&#9724;</button>' +
                    '<button class="sb-loading" style="display:none;font-size:14px;color:var(--accent)">&#8987;</button>' +
                    '<button class="sb-delete-btn" title="Delete">&#128465;</button>' +
                    '</div></div>';
            });
            _sbClips.innerHTML = html;
            _sbClips.querySelectorAll('.sb-play-btn').forEach(function (btn) {
                btn.onclick = function () {
                    var clipId = btn.closest('.soundboard-clip').dataset.clipId;
                    var clipEl = btn.closest('.soundboard-clip');
                    var pauseBtn = clipEl.querySelector('.sb-pause-btn');
                    var loadBtn = clipEl.querySelector('.sb-loading');
                    playSoundboardClip(clipId, pauseBtn, btn, loadBtn);
                };
            });
            _sbClips.querySelectorAll('.sb-pause-btn').forEach(function (btn) {
                btn.onclick = function () {
                    if (_sbPlaying) {
                        try { _sbPlaying.pause(); } catch (_) {}
                        try { _sbPlaying.currentTime = 0; } catch (_) {}
                        _sbPlaying = null;
                    }
                    _sbClips.querySelectorAll('.sb-play-btn').forEach(function (pb) { pb.style.display = ''; });
                    _sbClips.querySelectorAll('.sb-pause-btn').forEach(function (pp) { pp.style.display = 'none'; });
                    _sbClips.querySelectorAll('.sb-loading').forEach(function (ld) { ld.style.display = 'none'; });
                };
            });
            _sbClips.querySelectorAll('.sb-delete-btn').forEach(function (btn) {
                btn.onclick = function () {
                    var clipId = btn.closest('.soundboard-clip').dataset.clipId;
                    deleteSoundboardClip(clipId);
                };
            });
        } catch (e) {
            console.error('Load soundboard clips error:', e);
        }
    }

    function playSoundboardClip(clipId, pauseBtn, playBtn, loadBtn) {
        var clip = _sbClipsCache.find(function (c) { return c.id === clipId; });
        if (!clip) return;
        // Check if soundboard is disabled (Settings→Voice or voice-popup toggle)
        if (_isSbDisabledGlobal()) {
            alert('Your soundboard is disabled. Go to Settings → Voice to re-enable it.');
            return;
        }
        // Stop any currently playing from overlay
        if (_sbPlaying) {
            try { _sbPlaying.pause(); } catch (_) {}
            try { _sbPlaying.currentTime = 0; } catch (_) {}
            _sbPlaying = null;
        }

        // Show loading indicator
        if (playBtn) playBtn.style.display = 'none';
        if (loadBtn) { loadBtn.style.display = ''; loadBtn.textContent = '⏳'; }

        // Decrypt with identity key
        var audioBytes = _decryptSbClip(clip);
        if (!audioBytes) {
            console.error('Failed to decrypt soundboard clip');
            if (loadBtn) loadBtn.style.display = 'none';
            if (playBtn) playBtn.style.display = '';
            return;
        }

        // Use setTimeout to allow the loading indicator to render before heavy decryption
        setTimeout(function() {
            var vs = window.VoiceManager && window.VoiceManager.getVoiceState && window.VoiceManager.getVoiceState();
            var inVoice = window.ws && window.ws.readyState === 1 && vs && vs.inVoice;

            if (inVoice) {
                // In voice: only broadcast via WS. The relay will call _handleSoundboardPlay
                // for ALL room members including this sender (respecting _sbSelfHear toggle).
                // This avoids double playback and ensures the hear-self toggle works correctly.
                if (loadBtn) loadBtn.style.display = 'none';
                if (playBtn) playBtn.style.display = '';
                var rawB64 = uint8ToBase64(audioBytes);
                window.ws.send(JSON.stringify({
                    type: 'soundboard_play',
                    clip_id: clipId,
                    server_id: window.currentServerId || '',
                    encrypted_audio: rawB64,
                    audio_nonce: '',
                    user_id: window.currentUserId,
                    disabled: false,
                    room_type: vs.roomType || 'server',
                    dm_channel_id: vs.dmChannelId || '',
                }));
            } else {
                // Not in voice: play locally as a preview (no one else to hear it)
                var blob = new Blob([audioBytes], { type: 'audio/wav' });
                var url = URL.createObjectURL(blob);
                var audio = new Audio(url);
                _sbPlaying = audio;

                if (loadBtn) loadBtn.style.display = 'none';
                if (pauseBtn) pauseBtn.style.display = '';

                audio.onended = function () {
                    URL.revokeObjectURL(url);
                    _sbPlaying = null;
                    if (playBtn) playBtn.style.display = '';
                    if (pauseBtn) pauseBtn.style.display = 'none';
                };
                audio.play().then(function() {
                    if (loadBtn) loadBtn.style.display = 'none';
                }).catch(function (e) {
                    console.error('Play error:', e);
                    if (loadBtn) loadBtn.style.display = 'none';
                    if (playBtn) playBtn.style.display = '';
                });
            }
        }, 50); // 50ms delay so loading indicator renders
    }

    async function deleteSoundboardClip(clipId) {
        if (!confirm('Delete this sound?')) return;
        try {
            await fetch('/api/soundboard/clip/' + clipId, { method: 'DELETE', headers: authHeaders() });
            loadSoundboardClips();
        } catch (e) { console.error('Delete clip error:', e); }
    }

    // Listen for soundboard plays from other users (and self via WS relay) via WS
    window._handleSoundboardPlay = function (data) {
        // If soundboard sounds are disabled in settings, block both play and receive
        if (_isSbDisabledGlobal()) return;
        // Ignore disabled soundboard (owner disabled for this user)
        if (data.disabled) return;
        // For self: only play if hear-self is toggled on
        if (data.user_id === window.currentUserId) {
            if (!_sbSelfHear) return;
        } else {
            // For others: skip if individually muted
            if (_isUserMuted(data.user_id)) return;
        }
        try {
            var audioBytes = base64ToUint8(data.encrypted_audio);
            var blob = new Blob([audioBytes], { type: 'audio/wav' });
            var url = URL.createObjectURL(blob);
            var audio = new Audio(url);
            // Track for cleanup
            _sbAllPlaying.push(audio);
            audio.onended = function () {
                URL.revokeObjectURL(url);
                var idx = _sbAllPlaying.indexOf(audio);
                if (idx !== -1) _sbAllPlaying.splice(idx, 1);
            };
            // If this is from the overlay play button (self, via WS relay),
            // set _sbPlaying so the overlay pause/stop button works
            if (data.user_id === window.currentUserId) {
                _sbPlaying = audio;
            }
            audio.play().catch(function (e) { console.error('Remote play error:', e); });
        } catch (e) {
            console.error('Soundboard remote play failed:', e);
        }
    };

    // Stop all soundboard audio (called on voice leave, page unload, etc.)
    window._stopAllSoundboardAudio = function () {
        _sbAllPlaying.forEach(function (a) {
            try { a.pause(); } catch (_) {}
            try { a.currentTime = 0; } catch (_) {}
        });
        _sbAllPlaying = [];
        _sbPlaying = null;
    };

    function base64ToUint8(b64) {
        var binary = atob(b64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    // Legacy: load muted list from server (for backward compat, but now we use localStorage)
    window._loadSoundboardMutes = function () {
        // Mutes are now in localStorage — this is a no-op for backward compat
    };

    function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Expose for WS handler and DM mini bar
    window._loadSoundboardClips = loadSoundboardClips;
    window._playSoundboardClip = playSoundboardClip;
    Object.defineProperty(window, "_sbClipsCache", { get: function() { return _sbClipsCache; }, configurable: true });
    window._sbAllPlaying = _sbAllPlaying;

    // --- Per-user disabled list (owner disabled this user's soundboard for everyone) ---
    window._sbDisabledUsers = [];
    window._loadDisabledSoundboardUsers = async function () {
        var sid = window.currentServerId;
        if (!sid) { window._sbDisabledUsers = []; return; }
        try {
            var resp = await fetch('/api/soundboard/disabled/' + sid, { headers: authHeaders() });
            var data = await resp.json();
            window._sbDisabledUsers = Array.isArray(data.users) ? data.users : [];
        } catch (_) { window._sbDisabledUsers = []; }
    };
})();
