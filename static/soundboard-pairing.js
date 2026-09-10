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
    var _sbPlaying = null; // currently playing Audio or {source, ctx} (from overlay play button)
    var _sbSelfHear = true; // play sounds for ourselves too (default ON)
    var _sbClipsCache = []; // cached clips for play lookups
    var _sbAllPlaying = []; // all active Audio elements (for stop-on-leave)
    var _sbAudioCtx = null; // shared AudioContext for soundboard playback (bypasses autoplay)
    var _sbCurrentClipId = null; // clip ID of the currently playing sound (for overlay button sync)

    // Ensure a shared AudioContext for soundboard playback (bypasses browser
    // autoplay restrictions because the context is created during a user gesture
    // when the soundboard overlay is first opened).
    function _ensureSbAudioCtx() {
        if (!_sbAudioCtx) {
            try {
                var AC = window.AudioContext || window.webkitAudioContext;
                if (AC) _sbAudioCtx = new AC();
            } catch (_) {}
        }
        if (_sbAudioCtx && _sbAudioCtx.state === 'suspended') {
            _sbAudioCtx.resume().catch(function () {});
        }
        return _sbAudioCtx;
    }

    // Play raw WAV bytes through the AudioContext (bypasses autoplay).
    // `offsetProvider` is either a number (ms) or — preferred — a FUNCTION
    // returning the current position in ms. Passing a function lets us sample
    // the position right before the source starts (i.e. AFTER fetch + decode),
    // so the time spent decrypting/downloading/decoding counts toward the
    // late-join offset and everyone stays in sync with the room.
    // Returns a promise resolving to the source node, or null when the clip
    // was already over (offset past the end) — in that case onEnded still
    // fires so callers clean up their state.
    function _playViaAudioCtx(wavBytes, onEnded, offsetProvider) {
        var ctx = _ensureSbAudioCtx();
        if (!ctx) return Promise.reject(new Error('no AudioContext'));
        // If the context is suspended, wait for resume() to complete before
        // decoding — source.start() on a suspended context silently queues
        // without playing, so the user hears nothing. When already running,
        // skip the extra Promise microtask to avoid timing regressions.
        var decode = function (c) {
            return c.decodeAudioData(wavBytes.buffer).then(function (buffer) {
                var getMs = (typeof offsetProvider === 'function') ? offsetProvider : function () { return offsetProvider || 0; };
                var offsetSec = Math.max(0, (getMs() || 0) / 1000);
                if (offsetSec >= buffer.duration) {
                    if (onEnded) { try { onEnded(); } catch (_) {} }
                    return null;
                }
                var source = c.createBufferSource();
                source.buffer = buffer;
                source.connect(c.destination);
                source.onended = function () {
                    if (onEnded) onEnded();
                };
                source.start(0, offsetSec);
                return source;
            });
        };
        if (ctx.state === 'suspended') {
            return ctx.resume().then(function () { return decode(ctx); }).catch(function () { return decode(ctx); });
        }
        return decode(ctx);
    }

    // Called when a relayed clip finishes naturally (or is skipped because the
    // position was past its end). Removes the tracking entry and — for our own
    // plays — restores the overlay's play button so the stale stop button
    // doesn't linger after the sound ended.
    function _sbOnClipEnded(userId, clipId) {
        // Only act if a live entry still exists — a manual stop already removed
        // it (source.stop() also fires onended, so this prevents double cleanup
        // and a duplicate soundboard_stop broadcast).
        var hadLive = _sbAllPlaying.some(function (entry) {
            var eUserId = (entry && entry.userId) || (entry && entry._sbUserId) || null;
            var eClipId = (entry && entry.clipId) || (entry && entry._sbClipId) || null;
            return eUserId === userId && eClipId === clipId;
        });
        if (!hadLive) return;
        _sbAllPlaying = _sbAllPlaying.filter(function (entry) {
            var eUserId = (entry && entry.userId) || (entry && entry._sbUserId) || null;
            var eClipId = (entry && entry.clipId) || (entry && entry._sbClipId) || null;
            return !(eUserId === userId && eClipId === clipId);
        });
        // If this user has no more entries in _sbAllPlaying, clear the playing indicator
        var stillPlaying = _sbAllPlaying.some(function (e) { return ((e && e.userId) || (e && e._sbUserId) || null) === userId; });
        if (!stillPlaying) _sbSetPlaying(userId, false);
        if (_sbPlaying && !(_sbPlaying.type === 'audio')) {
            var pUserId = (_sbPlaying.userId) || (_sbPlaying._sbUserId) || null;
            var pClipId = (_sbPlaying.clipId) || (_sbPlaying._sbClipId) || null;
            if (pUserId === userId && pClipId === clipId) {
                _sbPlaying = null;
                _sbCurrentClipId = null;
            }
        }
        if (userId === window.currentUserId && clipId) {
            _resetSbOverlayForClip(clipId);
            // Tell the room the clip is over so the server clears its playback
            // state (late joiners won't try to sync to a finished clip).
            var w = window.ws;
            if (w && w.readyState === 1) {
                var vs = window.VoiceManager && window.VoiceManager.getVoiceState && window.VoiceManager.getVoiceState();
                if (vs && vs.inVoice) {
                    try {
                        w.send(JSON.stringify({
                            type: 'soundboard_stop',
                            user_id: window.currentUserId,
                            server_id: window.currentServerId || '',
                            channel_id: vs.channelId || '',
                            room_type: vs.roomType || 'server',
                            dm_channel_id: vs.dmChannelId || '',
                        }));
                    } catch (_) {}
                }
            }
        }
    }

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

    // --- Per-user mute: stored in localStorage (global across all servers/DMs) ---
    function _getMutedKey() {
        return 'sb_muted';
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
    window._sbToggleMuteUser = _toggleMuteUser;
    // Read-only proxy for checking membership (indexOf only)
    window._sbMutedList = { indexOf: function(uid) { return _getMutedList().indexOf(uid); } };

    // Wire up all soundboard open buttons
    function openSbOverlay() {
        if (_sbOverlay) _sbOverlay.style.display = 'flex';
        _ensureSbAudioCtx(); // unlock AudioContext on user gesture
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

    // Self-hear toggle — initialize from checkbox state (default ON)
    var _sbSelfHearEl = document.getElementById('soundboard-self-hear');
    if (_sbSelfHearEl) {
        _sbSelfHear = _sbSelfHearEl.hasAttribute('checked') ? !!_sbSelfHearEl.checked : true;
        _sbSelfHearEl.checked = _sbSelfHear;
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
        // Show loading state while fetching (only if cache is empty)
        if (_sbClipsCache.length === 0) {
            _sbClips.innerHTML = '<div class="soundboard-empty" style="animation:sbPulse 1.2s ease-in-out infinite">Loading sounds...</div>';
        }
        try {
            var resp = await fetch('/api/soundboard/my', { headers: authHeaders() });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            var clips = await resp.json();
            if (!Array.isArray(clips)) throw new Error('bad response');
            _sbClipsCache = clips;
            renderSbClips();
        } catch (e) {
            console.error('Load soundboard clips error:', e);
            // On failure, keep the old cache — only wipe on success.
            // If we have cached clips, re-render them (stale list > empty list).
            if (_sbClipsCache.length > 0) {
                renderSbClips();
            } else if (_sbClips) {
                _sbClips.innerHTML = '<div class="soundboard-empty">Couldn\'t load sounds. Tap to retry.</div>';
                _sbClips.onclick = function () { _sbClips.onclick = null; loadSoundboardClips(); };
            }
        }
    }

    function renderSbClips() {
        if (!_sbClips) return;
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
                _stopAllSoundboardAudio();
                _sendSoundboardStop();
                _resetSbButtons();
            };
        });
        _sbClips.querySelectorAll('.sb-delete-btn').forEach(function (btn) {
            btn.onclick = function () {
                var clipId = btn.closest('.soundboard-clip').dataset.clipId;
                deleteSoundboardClip(clipId);
            };
        });
    }

    function _resetSbButtons() {
        if (_sbClips) {
            _sbClips.querySelectorAll('.sb-play-btn').forEach(function (pb) { pb.style.display = ''; });
            _sbClips.querySelectorAll('.sb-pause-btn').forEach(function (pp) { pp.style.display = 'none'; });
            _sbClips.querySelectorAll('.sb-loading').forEach(function (ld) { ld.style.display = 'none'; });
        }
    }

    // Reset buttons for a specific clip by ID
    function _resetSbOverlayForClip(clipId) {
        if (!clipId || !_sbClips) return;
        var clipEl = _sbClips.querySelector('.soundboard-clip[data-clip-id="' + clipId + '"]');
        if (!clipEl) { _resetSbButtons(); return; }
        var pb = clipEl.querySelector('.sb-play-btn');
        var pp = clipEl.querySelector('.sb-pause-btn');
        var ld = clipEl.querySelector('.sb-loading');
        if (pb) pb.style.display = '';
        if (pp) pp.style.display = 'none';
        if (ld) ld.style.display = 'none';
    }

    // Broadcast soundboard_stop to all room members via WS
    function _sendSoundboardStop() {
        var w = window.ws;
        if (!w || w.readyState !== 1) return;
        var vs = window.VoiceManager && window.VoiceManager.getVoiceState && window.VoiceManager.getVoiceState();
        if (!vs || !vs.inVoice) return;
        w.send(JSON.stringify({
            type: 'soundboard_stop',
            user_id: window.currentUserId,
            server_id: window.currentServerId || '',
            channel_id: vs.channelId || '',
            room_type: vs.roomType || 'server',
            dm_channel_id: vs.dmChannelId || '',
        }));
    }

    function playSoundboardClip(clipId, pauseBtn, playBtn, loadBtn) {
        var clip = _sbClipsCache.find(function (c) { return c.id === clipId; });
        if (!clip) {
            // Not in cache yet — fetch the clip list, then retry once. Covers
            // programmatic plays right after page load (cache still empty).
            var retry = function () { playSoundboardClip(clipId, pauseBtn, playBtn, loadBtn); };
            if (loadSoundboardClips) {
                loadSoundboardClips().then(function () {
                    var c2 = _sbClipsCache.find(function (c) { return c.id === clipId; });
                    if (c2) retry();
                }).catch(function () {});
            }
            return;
        }
        // Check if soundboard is disabled (Settings→Voice or voice-popup toggle)
        if (_isSbDisabledGlobal()) {
            alert('Your soundboard is disabled. Go to Settings → Voice to re-enable it.');
            return;
        }
        // Stop any currently playing
        _stopAllSoundboardAudio();
        _resetSbButtons();

        // Show loading indicator
        if (playBtn) playBtn.style.display = 'none';
        if (loadBtn) { loadBtn.style.display = ''; loadBtn.innerHTML = icon('check'); }

        // Decrypt with identity key
        var audioBytes = _decryptSbClip(clip);
        if (!audioBytes) {
            console.error('Failed to decrypt soundboard clip');
            if (loadBtn) loadBtn.style.display = 'none';
            if (playBtn) playBtn.style.display = '';
            return;
        }

        // Use rAF to let the loading indicator paint, then proceed
        requestAnimationFrame(function() {
            var vs = window.VoiceManager && window.VoiceManager.getVoiceState && window.VoiceManager.getVoiceState();
            var inVoice = window.ws && window.ws.readyState === 1 && vs && vs.inVoice;

            if (inVoice) {
                // In voice: upload audio to temp endpoint, then send just the token via WS.
                // This avoids sending huge base64 audio through WebSocket (caused 20s+ delays).
                if (loadBtn) loadBtn.style.display = 'none';
                if (pauseBtn) pauseBtn.style.display = '';
                if (playBtn) playBtn.style.display = 'none';
                _sbCurrentClipId = clipId;
                var rawB64 = uint8ToBase64(audioBytes);
                var playStartTime = Date.now();
                fetch('/api/soundboard/temp-play', {
                    method: 'POST',
                    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
                    body: JSON.stringify({ audio: rawB64 }),
                }).then(function(resp) { return resp.json(); }).then(function(data) {
                    if (!data.token) throw new Error('no token');
                    window.ws.send(JSON.stringify({
                        type: 'soundboard_play',
                        clip_id: clipId,
                        temp_token: data.token,
                        server_id: window.currentServerId || '',
                        channel_id: vs.channelId || '',
                        user_id: window.currentUserId,
                        disabled: false,
                        room_type: vs.roomType || 'server',
                        dm_channel_id: vs.dmChannelId || '',
                        play_start_ms: playStartTime,
                        // Real clip length so late joiners can skip clips that
                        // already finished instead of replaying them from 0.
                        duration_ms: (clip.duration_ms || 0),
                    }));
                }).catch(function(e) {
                    console.error('Soundboard temp upload failed:', e);
                    if (loadBtn) loadBtn.style.display = 'none';
                    if (playBtn) playBtn.style.display = '';
                });
            } else {
                // Not in voice: play locally as a preview (no one else to hear it)
                _playSbAudioLocal(audioBytes, playBtn, pauseBtn, loadBtn);
            }
        });
    }

    // Play soundboard audio locally (preview or self-hear relay)
    function _playSbAudioLocal(audioBytes, playBtn, pauseBtn, loadBtn) {
        if (loadBtn) loadBtn.style.display = 'none';
        if (pauseBtn) pauseBtn.style.display = '';

        var blob = new Blob([audioBytes], { type: 'audio/wav' });
        var url = URL.createObjectURL(blob);
        var audio = new Audio(url);
        _sbPlaying = { type: 'audio', audio: audio, url: url };
        _sbAllPlaying.push(audio);

        audio.onended = function () {
            URL.revokeObjectURL(url);
            var idx = _sbAllPlaying.indexOf(audio);
            if (idx !== -1) _sbAllPlaying.splice(idx, 1);
            if (_sbPlaying && _sbPlaying.audio === audio) _sbPlaying = null;
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
            if (!_sbSelfHear) {
                // We still need the overlay's stop button to flip back when our
                // clip ends naturally — schedule the cleanup with the known
                // duration (always sent now). No audio is played for us.
                var d = data.duration_ms || 0;
                var cid = data.clip_id;
                if (d > 0 && cid) {
                    setTimeout(function () { _sbOnClipEnded(data.user_id, cid); }, d + 250);
                }
                return;
            }
        } else {
            // For others: skip if individually muted
            if (_isUserMuted(data.user_id)) return;
        }
        // Deafened users should not hear any soundboard sounds
        if (window.VoiceManager && window.VoiceManager.getState) {
            var _vs = window.VoiceManager.getState();
            if (_vs && _vs.deafened) return;
        }
        // Multi-device gate: only the device actually IN the target voice room
        // plays the sound. A second device of the same account that is NOT in
        // the call must ignore the relay — otherwise it plays audio that
        // nobody can stop (the stop broadcast only reaches room members).
        var _vsRoom = window.VoiceManager && window.VoiceManager.getVoiceState && window.VoiceManager.getVoiceState();
        if (_vsRoom && _vsRoom.inVoice) {
            var _sameRoom = false;
            if ((data.room_type || 'server') === 'dm') {
                _sameRoom = _vsRoom.roomType === 'dm' && _vsRoom.dmChannelId && _vsRoom.dmChannelId === data.dm_channel_id;
            } else {
                _sameRoom = _vsRoom.roomType !== 'dm' && _vsRoom.serverId && _vsRoom.serverId === data.server_id;
            }
            if (!_sameRoom) return; // play is for a different room
        } else if (!(data._lateJoinOffset >= 0)) {
            // Not in voice and not a late-join synthetic call → ignore
            return;
        }
        // Mute suppress: store the play data so unmute can resume (like late join)
        if (data.user_id !== window.currentUserId && _isUserMuted(data.user_id)) {
            _sbSuppressedPlays[data.user_id] = data;
            return;
        }
        // Determine play source: temp_token (fast HTTP fetch) or legacy encrypted_audio
        var playPromise;
        if (data.temp_token) {
            // New flow: fetch audio from temp HTTP endpoint (avoids huge WS payloads)
            playPromise = fetch('/api/soundboard/temp-play/' + data.temp_token, { headers: authHeaders() })
                .then(function(resp) {
                    if (!resp.ok) throw new Error('temp audio fetch failed ' + resp.status);
                    return resp.arrayBuffer();
                })
                .then(function(buf) { return new Uint8Array(buf); });
        } else if (data.encrypted_audio) {
            // Legacy flow or late-join: audio embedded in WS message
            playPromise = Promise.resolve(base64ToUint8(data.encrypted_audio));
        } else {
            console.warn('Soundboard play: no audio source');
            return;
        }
        playPromise.then(function(audioBytes) {
            if (!audioBytes || audioBytes.length === 0) return;
            // Track this user as actively playing (for the indicator badge)
            _sbSetPlaying(data.user_id, true);
            // Late-join offset is sampled lazily (as a function) so it is read
            // right before the source actually starts — AFTER the fetch above
            // and AFTER decodeAudioData. That way fetch + decrypt + decode
            // time counts toward the offset and we start at the position the
            // room is actually at, not the position when the message arrived.
            var durationMs = data.duration_ms || 0;
            var offsetProvider = function () {
                // Prefer the authoritative server-stamped start time and
                // recompute every call — this is what makes fetch + decrypt
                // + decode time count toward the offset. _lateJoinOffset is
                // only a fallback for messages without a timestamp.
                if (data.play_start_ms) {
                    return Math.max(0, Date.now() - data.play_start_ms);
                }
                return data._lateJoinOffset || 0;
            };
            // Quick skip: if we already know the duration and the offset is
            // clearly past it, don't even bother decoding.
            var earlyOff = offsetProvider();
            if (durationMs > 0 && earlyOff >= durationMs) return;
            if (_sbAudioCtx || _ensureSbAudioCtx()) {
                _playViaAudioCtx(audioBytes, function () {
                    // Clip finished naturally (or was skipped: past the end)
                    _sbOnClipEnded(data.user_id, data.clip_id);
                }, offsetProvider).then(function (source) {
                    if (!source) return;
                    var entry = { type: 'ctx', source: source, userId: data.user_id, clipId: data.clip_id };
                    _sbAllPlaying.push(entry);
                    if (data.user_id === window.currentUserId) {
                        _sbPlaying = entry;
                        _sbCurrentClipId = data.clip_id;
                    }
                }).catch(function (e) {
                    console.error('Soundboard AudioContext play error:', e);
                    // Fall back to Audio() element — pass the current offset
                    // so late-joiners still hear from the right position.
                    _playSbAudioFallback(audioBytes, data.user_id, data.clip_id, offsetProvider());
                });
            } else {
                _playSbAudioFallback(audioBytes, data.user_id, data.clip_id);
            }
        }).catch(function(e) {
            console.error('Soundboard play failed:', e);
        });
    };

    function _playSbAudioFallback(audioBytes, userId, clipId, startOffsetMs) {
        try {
            var blob = new Blob([audioBytes], { type: 'audio/wav' });
            var url = URL.createObjectURL(blob);
            var audio = new Audio(url);
            audio._sbUserId = userId;
            audio._sbClipId = clipId;
            if (startOffsetMs && startOffsetMs > 0) {
                audio.currentTime = startOffsetMs / 1000;
            }
            _sbAllPlaying.push(audio);
            audio.onended = function () {
                URL.revokeObjectURL(url);
                var idx = _sbAllPlaying.indexOf(audio);
                if (idx !== -1) _sbAllPlaying.splice(idx, 1);
                _sbOnClipEnded(userId, clipId);
            };
            if (userId === window.currentUserId) {
                _sbPlaying = audio;
                _sbCurrentClipId = clipId;
            }
            audio.play().catch(function (e) { console.error('Remote play error:', e); });
        } catch (e) {
            console.error('Soundboard fallback play failed:', e);
        }
    }

    // Listen for soundboard_stop from other users via WS
    window._handleSoundboardStop = function (data) {
        // Only stop sounds from a specific user
        if (data.user_id) {
            _sbSetPlaying(data.user_id, false);
            delete _sbSuppressedPlays[data.user_id];
            var stoppedClipId = null;
            var stoppedAnything = false;
            _sbAllPlaying = _sbAllPlaying.filter(function (entry) {
                // Determine the user who owns this entry
                var entryUserId = (entry && entry.userId) || (entry && entry._sbUserId) || null;
                // Only stop entries from the specified user
                if (entryUserId !== data.user_id) return true; // keep other users'
                stoppedAnything = true;
                try {
                    if (entry.type === 'ctx' && entry.source) {
                        entry.source.stop();
                    } else if (entry.pause) {
                        entry.pause();
                        entry.currentTime = 0;
                    }
                } catch (_) {}
                return false; // remove this entry
            });
            if (_sbPlaying) {
                var playingUserId = (_sbPlaying.userId) || (_sbPlaying._sbUserId) || null;
                if (playingUserId === data.user_id) {
                    stoppedClipId = _sbCurrentClipId;
                    stoppedAnything = true;
                    try {
                        if (_sbPlaying.type === 'ctx' && _sbPlaying.source) {
                            _sbPlaying.source.stop();
                        } else if (_sbPlaying.pause) {
                            _sbPlaying.pause();
                            _sbPlaying.currentTime = 0;
                        }
                    } catch (_) {}
                    _sbPlaying = null;
                    _sbCurrentClipId = null;
                }
            }
            // Only reset buttons for the CURRENT user's clip — never wipe
            // another user's stop across all overlay buttons (that hides the
            // active pause button while self-hear audio keeps playing).
            if (stoppedClipId) {
                _resetSbOverlayForClip(stoppedClipId);
            }
        }
    };

    // Stop soundboard audio for the current user only (called on voice leave).
    // Other users' sounds keep playing — their sounds are cleaned up when
    // handleMemberLeave() fires on each peer's client.
    function _stopAllSoundboardAudio() {
        var myId = window.currentUserId;
        _sbAllPlaying = _sbAllPlaying.filter(function (entry) {
            var entryUserId = (entry && entry.userId) || (entry && entry._sbUserId) || null;
            // Only stop sounds played by the current user
            if (myId && entryUserId && entryUserId !== myId) return true; // keep others'
            try {
                if (entry.type === 'ctx' && entry.source) {
                    entry.source.stop();
                } else if (entry.pause) {
                    entry.pause();
                    entry.currentTime = 0;
                } else if (entry && entry.currentTime !== undefined) {
                    entry.pause();
                    entry.currentTime = 0;
                }
            } catch (_) {}
            return false; // remove this entry
        });
        if (_sbPlaying) {
            var playingUserId = (_sbPlaying.userId) || (_sbPlaying._sbUserId) || null;
            if (!myId || playingUserId === myId) {
                _sbPlaying = null;
                _sbCurrentClipId = null;
            }
        }
    }

    // Stop ALL soundboard audio regardless of who played it.
    // Used when leaving a call: the user should stop hearing everything.
    function _stopAllSoundboardAudioAll() {
        _sbAllPlaying.forEach(function (entry) {
            try {
                if (entry.type === 'ctx' && entry.source) {
                    entry.source.stop();
                } else if (entry.pause) {
                    entry.pause();
                    entry.currentTime = 0;
                } else if (entry && entry.currentTime !== undefined) {
                    entry.pause();
                    entry.currentTime = 0;
                }
            } catch (_) {}
        });
        _sbAllPlaying = [];
        _sbPlaying = null;
        _sbCurrentClipId = null;
    }
    window._stopAllSoundboardAudio = _stopAllSoundboardAudio;
    window._stopAllSoundboardAudioAll = _stopAllSoundboardAudioAll;

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
    window._sendSoundboardStop = _sendSoundboardStop;
    window.syncDisableCheckboxes = syncDisableCheckboxes;
    Object.defineProperty(window, "_sbClipsCache", { get: function() { return _sbClipsCache; }, configurable: true });
    Object.defineProperty(window, '_sbAllPlaying', { get: function() { return _sbAllPlaying; }, configurable: true });

    // --- Per-user disabled list (owner disabled this user's soundboard for everyone) ---
    // --- Per-user suppression tracking (for mute→unmute resume like late-join) ---
    var _sbSuppressedPlays = {}; // userId -> data (last play message, kept while muted)
    window._sbResumeForUser = function (userId) {
        var data = _sbSuppressedPlays[userId];
        if (!data) return;
        delete _sbSuppressedPlays[userId];
        // Only resume if the clip hasn't finished: compute remaining time
        var dur = data.duration_ms || 0;
        var start = data.play_start_ms || 0;
        if (dur > 0 && start > 0 && (Date.now() - start) >= dur) return; // already over
        // Replay via the normal path — offset is recomputed lazily so it
        // lands at the current position (like a late join).
        window._handleSoundboardPlay(data);
    };
    window._sbPlayingUsers = {}; // userId -> true (who is currently playing)
    window._sbOnSbPlayingChanged = null; // callback set by voice.js
    function _sbSetPlaying(userId, playing) {
        if (playing) {
            window._sbPlayingUsers[userId] = true;
        } else {
            delete window._sbPlayingUsers[userId];
        }
        if (window._sbOnSbPlayingChanged) window._sbOnSbPlayingChanged();
    }
    window._sbSetPlaying = _sbSetPlaying;

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
