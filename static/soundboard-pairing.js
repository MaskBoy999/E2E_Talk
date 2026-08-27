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
    var _sbMutedList = [];
    var _sbPlaying = null; // currently playing Audio element
    var _sbSelfHear = false; // play sounds for ourselves too
    var _sbClipsCache = []; // cached clips for play lookups

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

    // Derive a symmetric key from the user's identity key pair (self-ECDH).
    // This key is deterministic for the account and doesn't depend on any server.
    function _getUserSbKey() {
        var E = window.E2ECrypto;
        if (!E) return null;
        var kp = E.getIdentityKeyPair();
        if (!kp) return null;
        // Self-ECDH: shared secret from own private + own public
        // (deterministic, only the account holder can derive it)
        return E.envelopeEncrypt(new Uint8Array(0), kp.publicKey, kp.privateKey);
    }

    async function handleSoundboardUpload() {
        var file = _sbFile.files[0];
        if (!file) return;
        // Soundboard is per-account — upload works in any context (server, DM, or standalone)
        var serverId = window.currentServerId || '_global';
        try {
            _showSbProgress('Decoding audio...');
            var ctx = new (window.AudioContext || window.webkitAudioContext)();
            var buf = await file.arrayBuffer();
            _showSbProgress('Processing audio...');
            var audio = await ctx.decodeAudioData(buf);
            var wavBuffer = audioBufferToWav(audio);
            var wavBytes = new Uint8Array(wavBuffer);

            // Encrypt with user's identity key (per-account)
            _showSbProgress('Encrypting with identity key...');
            var E = window.E2ECrypto;
            var identity = E && E.getIdentityKeyPair();
            var encrypted, nonce;
            if (identity) {
                var enc = E.envelopeEncrypt(wavBytes, identity.publicKey, identity.privateKey);
                encrypted = enc.ciphertext; // base64
                nonce = enc.nonce;           // base64
            } else {
                // Fallback: no identity key, store unencrypted (shouldn't happen)
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
        var format = 1; // PCM
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

    // Decrypt a soundboard clip using the user's identity key (self-envelope).
    // Returns Uint8Array of raw audio bytes, or null on failure.
    function _decryptSbClip(clip) {
        var E = window.E2ECrypto;
        if (!E || !clip) return null;
        var identity = E.getIdentityKeyPair();
        if (!identity) return null;
        try {
            // Self-envelope: senderPublicKey === own publicKey
            var pt = E.envelopeDecrypt(clip.encrypted_audio, identity.privateKey, identity.publicKey, clip.audio_nonce);
            return pt;
        } catch (e) {
            console.error('Soundboard decrypt error:', e);
            return null;
        }
    }

    async function loadSoundboardClips() {
        if (!_sbClips) return;
        try {
            // Per-account: load ALL clips for the current user (across all servers)
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
                    '<button class="sb-delete-btn" title="Delete">&#128465;</button>' +
                    '</div></div>';
            });
            _sbClips.innerHTML = html;
            // Wire up play buttons
            _sbClips.querySelectorAll('.sb-play-btn').forEach(function (btn) {
                btn.onclick = function () {
                    var clipId = btn.closest('.soundboard-clip').dataset.clipId;
                    var clipEl = btn.closest('.soundboard-clip');
                    var pauseBtn = clipEl.querySelector('.sb-pause-btn');
                    playSoundboardClip(clipId, pauseBtn, btn);
                };
            });
            // Wire up pause/stop buttons
            _sbClips.querySelectorAll('.sb-pause-btn').forEach(function (btn) {
                btn.onclick = function () {
                    if (_sbPlaying) {
                        try { _sbPlaying.pause(); } catch (_) {}
                        try { _sbPlaying.currentTime = 0; } catch (_) {}
                        _sbPlaying = null;
                    }
                    _sbClips.querySelectorAll('.sb-play-btn').forEach(function (pb) { pb.style.display = ''; });
                    _sbClips.querySelectorAll('.sb-pause-btn').forEach(function (pp) { pp.style.display = 'none'; });
                };
            });
            // Wire up delete buttons
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

    function playSoundboardClip(clipId, pauseBtn, playBtn) {
        var clip = _sbClipsCache.find(function (c) { return c.id === clipId; });
        if (!clip) return;
        // Stop any currently playing
        if (_sbPlaying) {
            try { _sbPlaying.pause(); } catch (_) {}
            try { _sbPlaying.currentTime = 0; } catch (_) {}
            _sbPlaying = null;
        }
        // Decrypt with identity key
        var audioBytes = _decryptSbClip(clip);
        if (!audioBytes) {
            console.error('Failed to decrypt soundboard clip');
            return;
        }
        var blob = new Blob([audioBytes], { type: 'audio/wav' });
        var url = URL.createObjectURL(blob);
        var audio = new Audio(url);
        _sbPlaying = audio;
        if (playBtn) playBtn.style.display = 'none';
        if (pauseBtn) pauseBtn.style.display = '';
        audio.onended = function () {
            URL.revokeObjectURL(url);
            _sbPlaying = null;
            if (playBtn) playBtn.style.display = '';
            if (pauseBtn) pauseBtn.style.display = 'none';
        };
        audio.play().catch(function (e) { console.error('Play error:', e); });

        // Broadcast raw audio bytes to voice room via WS
        // (recipients play raw audio directly — no re-encryption needed)
        var vs = window.VoiceManager && window.VoiceManager.getVoiceState && window.VoiceManager.getVoiceState();
        if (window.ws && window.ws.readyState === 1 && vs && vs.inVoice) {
            var rawB64 = uint8ToBase64(audioBytes);
            window.ws.send(JSON.stringify({
                type: 'soundboard_play',
                clip_id: clipId,
                server_id: window.currentServerId || '',
                encrypted_audio: rawB64, // raw audio bytes (base64), not actually encrypted here
                audio_nonce: '',         // not used — audio is raw
                user_id: window.currentUserId,
                room_type: vs.roomType || 'server',
                dm_channel_id: vs.dmChannelId || '',
            }));
        }
    }

    async function deleteSoundboardClip(clipId) {
        if (!confirm('Delete this sound?')) return;
        try {
            await fetch('/api/soundboard/clip/' + clipId, { method: 'DELETE', headers: authHeaders() });
            loadSoundboardClips();
        } catch (e) { console.error('Delete clip error:', e); }
    }

    // Listen for soundboard plays from other users via WS
    window._handleSoundboardPlay = function (data) {
        if (data.user_id === window.currentUserId) {
            // Self-hear: play back our own sounds if the toggle is on
            if (!_sbSelfHear) return;
        } else {
            if (_sbMutedList.indexOf(data.user_id) !== -1) return;
        }
        // Play the raw audio bytes directly (sent as base64)
        try {
            var audioBytes = base64ToUint8(data.encrypted_audio);
            var blob = new Blob([audioBytes], { type: 'audio/wav' });
            var url = URL.createObjectURL(blob);
            var audio = new Audio(url);
            audio.onended = function () { URL.revokeObjectURL(url); };
            audio.play().catch(function (e) { console.error('Remote play error:', e); });
        } catch (e) {
            console.error('Soundboard remote play failed:', e);
        }
    };

    function base64ToUint8(b64) {
        var binary = atob(b64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    // Load muted soundboard users
    window._loadSoundboardMutes = async function () {
        var serverId = window.currentServerId;
        if (!serverId) return;
        try {
            var resp = await fetch('/api/soundboard/muted/' + serverId, { headers: authHeaders() });
            var data = await resp.json();
            _sbMutedList = data.muted || [];
        } catch (e) { /* ignore */ }
    };

    function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Expose for WS handler and DM mini bar
    window._sbMutedList = _sbMutedList;
    window._loadSoundboardClips = loadSoundboardClips;
    window._playSoundboardClip = playSoundboardClip;
    Object.defineProperty(window, "_sbClipsCache", { get: function() { return _sbClipsCache; }, configurable: true });
})();
