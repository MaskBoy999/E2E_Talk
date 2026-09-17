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
    var _sbLoopEnabled = false; // Loop toggle: keep re-playing our clip until manually stopped
    var _sbLoopSession = null; // { clipId } while OUR clip is looping (cleared on stop/leave/disable)
    // Per-user last accepted play message. Kept while a user is muted / disabled
    // / deafened so unmute (or re-enable / undeafen) can RESUME their clip from
    // the room's current position — exactly like a late join. A real stop or a
    // natural end clears it (there is nothing left to resume).
    var _sbLastPlay = {}; // userId -> play data
    // Per-user play epoch: bumped whenever a play starts OR the user's sound is
    // stopped. Async work (temp-token fetch → decode → play) captures the epoch
    // when it begins and aborts if it changed, so a stop / a newer play can
    // never be overtaken by an in-flight one (the "loop restarts after stop" and
    // "phantom play" bugs).
    var _sbPlayEpoch = {}; // userId -> int
    // Our OWN broadcast tracked WITHOUT a local audio entry (Hear-Myself OFF, or
    // deafened). A real entry exists when we hear ourselves, but with no local
    // audio nothing would ever fire the natural end — the room's playback state
    // stayed set and the clip kept "playing" for everyone. This pseudo-entry is
    // the timer that closes it out (and re-cycles when Loop is on).
    var _sbOwnBroadcast = null; // { userId, clipId, timer, durationMs }

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
            // A source started on a suspended context is only QUEUED, so the
            // user hears nothing until the context resumes. Chrome resolves
            // resume() even when the page still lacks user activation and the
            // context stays suspended — detect that and REJECT so the caller
            // falls back to an <audio> element (which plays under the media
            // engagement policy). Leaving it queued is what made a mid-play
            // joiner hear nothing at all until they happened to click.
            return ctx.resume().then(function () {
                if (ctx.state !== 'running') throw new Error('sb-context-still-suspended');
                return decode(ctx);
            });
        }
        return decode(ctx);
    }

    // Autoplay-policy unlock: a play that arrives before the page has had any
    // user interaction can find the shared AudioContext suspended. Anything
    // queued on it starts as soon as it resumes, so resume on the first real
    // gesture (join clicks, tab focus, any pointer/key input).
    function _unlockSbAudioCtxOnGesture() {
        if (_sbAudioCtx && _sbAudioCtx.state === 'suspended') {
            _sbAudioCtx.resume().catch(function () {});
        }
    }
    document.addEventListener('pointerdown', _unlockSbAudioCtxOnGesture, true);
    document.addEventListener('keydown', _unlockSbAudioCtxOnGesture, true);
    document.addEventListener('touchstart', _unlockSbAudioCtxOnGesture, true);

    // --- Play epoch + suppression helpers ---
    function _bumpSbEpoch(userId) {
        if (!userId) return 0;
        _sbPlayEpoch[userId] = (_sbPlayEpoch[userId] || 0) + 1;
        return _sbPlayEpoch[userId];
    }
    function _sbEpochOf(userId) { return _sbPlayEpoch[userId] || 0; }

    function _sbIsDeafened() {
        if (!(window.VoiceManager && window.VoiceManager.getState)) return false;
        var st = window.VoiceManager.getState();
        return !!(st && st.deafened);
    }

    // The server id of the voice room we are ACTUALLY in. Using the viewed
    // server (window.currentServerId) sent play/stop frames to the wrong room
    // whenever the user navigated to another server mid-call, so the sound
    // never reached (or never stopped for) the people in the call.
    function _sbVoiceServerId() {
        var vs = window.VoiceManager && window.VoiceManager.getVoiceState && window.VoiceManager.getVoiceState();
        if (vs && vs.inVoice && vs.roomType !== 'dm' && vs.serverId) return vs.serverId;
        return window.currentServerId || '';
    }

    // Called when a relayed clip finishes naturally (or is skipped because the
    // position was past its end). Removes the tracking entry and — for our own
    // plays — restores the overlay's play button so the stale stop button
    // doesn't linger after the sound ended.
    function _sbOnClipEnded(userId, clipId) {
        // Loop FIRST — our own clip finishing a cycle starts the next one
        // instead of ending. This has to run before the live-entry check
        // below: with Hear Myself OFF nothing plays locally, so the duration
        // timer is the only thing that can re-cycle the clip and no entry
        // ever exists for it.
        if (userId === window.currentUserId && clipId &&
            _sbLoopEnabled && _sbLoopSession && _sbLoopSession.clipId === clipId &&
            !_isSbDisabledGlobal() &&
            window.ws && window.ws.readyState === 1) {
            var vsLoop = window.VoiceManager && window.VoiceManager.getVoiceState && window.VoiceManager.getVoiceState();
            if (vsLoop && vsLoop.inVoice) {
                // Re-arm the overlay's stop button for the next cycle.
                // playSoundboardClip() itself resets + re-arms the buttons, so
                // pass the row's real elements (nulls are fine when the overlay
                // isn't showing this clip — playback still happens).
                var loopEl = _sbClips && _sbClips.querySelector('.soundboard-clip[data-clip-id="' + clipId + '"]');
                playSoundboardClip(clipId,
                    loopEl && loopEl.querySelector('.sb-pause-btn'),
                    loopEl && loopEl.querySelector('.sb-play-btn'),
                    loopEl && loopEl.querySelector('.sb-loading'));
                return;
            }
            _sbLoopSession = null; // left the room — the loop dies here
        }
        // A natural end means the clip is OVER: drop the resume record for
        // other users' clips (nothing to land back into). Our own record is
        // never kept — see _handleSoundboardPlay.
        if (userId !== window.currentUserId) delete _sbLastPlay[userId];
        // Act when a live entry still exists — a manual stop already removed it
        // (source.stop() also fires onended, so this prevents double cleanup and
        // a duplicate soundboard_stop broadcast). Our own broadcast may ALSO be
        // tracked as a pseudo-entry when we couldn't hear it locally (Hear
        // Myself OFF / deafened) — that is the only thing that can fire here in
        // that case, and it is what sends the room stop.
        var hadLive = _sbAllPlaying.some(function (entry) {
            var eUserId = (entry && entry.userId) || (entry && entry._sbUserId) || null;
            var eClipId = (entry && entry.clipId) || (entry && entry._sbClipId) || null;
            return eUserId === userId && eClipId === clipId;
        });
        var ownBroadcast = (_sbOwnBroadcast && _sbOwnBroadcast.userId === userId && _sbOwnBroadcast.clipId === clipId) ? _sbOwnBroadcast : null;
        if (!hadLive && !ownBroadcast) return;
        if (ownBroadcast) {
            clearTimeout(ownBroadcast.timer);
            _sbOwnBroadcast = null;
        }
        if (hadLive) {
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
        }
        if (userId === window.currentUserId && clipId) {
            // Not looping any more: hand the overlay's stop button back and
            // tell the room the clip is over so the server clears its playback
            // state (late joiners won't try to sync to a finished clip).
            _sbLoopSession = null;
            _sbPlaying = null;
            _sbCurrentClipId = null;
            _resetSbOverlayForClip(clipId);
            _sendSoundboardStop();
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
        if (disabled) {
            // Turning the setting ON must stop OUR sound right now — for us AND
            // for the room. The local stop used to leave the broadcast running,
            // so everyone else kept hearing a clip we had "disabled".
            _sbStopOwnPlaybackBroadcastingStop();
            // Receiving is blocked while disabled (existing behaviour), but the
            // last-play records are kept so re-enabling resumes mid-clip.
            _stopAllSoundboardAudioAll();
            _resetSbButtons();
        } else {
            // Re-enabled: pick up any still-playing clips we suppressed while
            // disabled, from the room's current position (like a late join).
            window._sbResumeAllSuppressed();
        }
    }

    // Stop what WE are playing and tell the room, without touching anyone
    // else's audio. Used when our own soundboard is turned off (setting or
    // owner) — "stop it ourselves" on the room's behalf.
    function _sbStopOwnPlaybackBroadcastingStop() {
        _stopAllSoundboardAudio();
        _sendSoundboardStop();
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

    // Loop toggle — persist so the panel comes back the way it was left.
    // While ON, our clip re-plays (a fresh relayed cycle) every time it ends
    // naturally, until we stop it, leave the call, or disable the soundboard.
    var _sbLoopEl = document.getElementById('soundboard-loop');
    if (_sbLoopEl) {
        _sbLoopEnabled = localStorage.getItem('sb_loop') === '1';
        _sbLoopEl.checked = _sbLoopEnabled;
        _sbLoopEl.addEventListener('change', function () {
            _sbLoopEnabled = _sbLoopEl.checked;
            try { localStorage.setItem('sb_loop', _sbLoopEnabled ? '1' : '0'); } catch (_) {}
            // Turning Loop OFF mid-loop ends the session at the current cycle.
            if (!_sbLoopEnabled) _sbLoopSession = null;
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
                if (_sbLoopEnabled) _sbLoopSession = { clipId: clipId };
                playSoundboardClip(clipId, pauseBtn, btn, loadBtn);
            };
        });
        _sbClips.querySelectorAll('.sb-pause-btn').forEach(function (btn) {
            btn.onclick = function () {
                _sbLoopSession = null; // manual stop always ends the loop
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
        // Re-apply the playing state: a full re-render (opening/closing the
        // overlay) reset every row, so a clip that is still playing looked
        // stopped — the stop button vanished and couldn't be clicked.
        _sbSyncOverlayPlayingState();
    }

    // Show the stop button for the clip we are currently broadcasting, if any.
    function _sbSyncOverlayPlayingState() {
        if (!_sbClips) return;
        var cid = _sbCurrentClipId || (_sbOwnBroadcast && _sbOwnBroadcast.clipId);
        if (!cid) return;
        var clipEl = _sbClips.querySelector('.soundboard-clip[data-clip-id="' + cid + '"]');
        if (!clipEl) return;
        var pb = clipEl.querySelector('.sb-play-btn');
        var pp = clipEl.querySelector('.sb-pause-btn');
        var ld = clipEl.querySelector('.sb-loading');
        if (pb) pb.style.display = 'none';
        if (pp) pp.style.display = '';
        if (ld) ld.style.display = 'none';
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

    // Broadcast soundboard_stop to all room members via WS. The server forces
    // user_id to the authenticated sender and only clears the room's playback
    // state if that sender is the clip's owner, so this can never stop a clip
    // we are not playing (and never clears someone else's state).
    function _sendSoundboardStop() {
        var w = window.ws;
        if (!w || w.readyState !== 1) return;
        var vs = window.VoiceManager && window.VoiceManager.getVoiceState && window.VoiceManager.getVoiceState();
        if (!vs || !vs.inVoice) return;
        var isDm = vs.roomType === 'dm';
        w.send(JSON.stringify({
            type: 'soundboard_stop',
            user_id: window.currentUserId,
            // The VOICE room's server, not the one being viewed — navigating to
            // another server mid-call used to send the stop to the wrong room.
            server_id: isDm ? '' : (vs.serverId || ''),
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
        // Owner disabled this account's soundboard (live or persisted)
        if (_sbIsOwnerDisabledForMe()) {
            alert('Your soundboard is disabled by the server owner.');
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
                _sbLoopSession = _sbLoopEnabled ? { clipId: clipId } : null;
                // Snapshot the self epoch: if the user stops (or starts another
                // clip) while the audio is still uploading, the send is skipped
                // instead of starting a sound that was already stopped.
                var _sbSelfEpoch = _sbEpochOf(window.currentUserId);
                var rawB64 = uint8ToBase64(audioBytes);
                var playStartTime = Date.now();
                // The VOICE room's server (not the one being viewed) so the play
                // reaches the room even if the user navigated elsewhere mid-call.
                var sendServerId = (vs.roomType === 'dm') ? '' : (vs.serverId || '');
                fetch('/api/soundboard/temp-play', {
                    method: 'POST',
                    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
                    body: JSON.stringify({ audio: rawB64 }),
                }).then(function(resp) { return resp.json(); }).then(function(data) {
                    if (!data.token) throw new Error('no token');
                    if (_sbEpochOf(window.currentUserId) !== _sbSelfEpoch) return; // stopped mid-upload
                    window.ws.send(JSON.stringify({
                        type: 'soundboard_play',
                        clip_id: clipId,
                        temp_token: data.token,
                        server_id: sendServerId,
                        channel_id: vs.channelId || '',
                        user_id: window.currentUserId,
                        disabled: false,
                        room_type: vs.roomType || 'server',
                        dm_channel_id: vs.dmChannelId || '',
                        play_start_ms: playStartTime,
                        // Real clip length so late joiners can skip clips that
                        // already finished instead of replaying them from 0.
                        duration_ms: (clip.duration_ms || 0),
                        // Loop mode: the server stores the flag so late joiners
                        // know this clip never "has definitely finished".
                        loop: _sbLoopEnabled,
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
        if (!data) return;
        var isSelf = data.user_id === window.currentUserId;
        // Remember the latest play for every OTHER user, even when we cannot
        // hear it right now. This IS the mute→unmute / disable→re-enable /
        // deafen→undeafen resume source: a clip already playing when we muted
        // keeps its record, so unmuting lands back mid-clip instead of silence.
        if (!isSelf && data.clip_id) _sbLastPlay[data.user_id] = data;
        // If soundboard sounds are disabled in settings, block both play and receive
        if (_isSbDisabledGlobal()) return;
        // Owner disabled OUR soundboard live (or for this server) → we cannot
        // play or hear. (A relayed play of ours still arrives with disabled
        // unset when the owner toggle raced it — this local check closes it.)
        if (isSelf && _sbIsOwnerDisabledForMe()) return;
        // Ignore disabled soundboard (owner disabled for this user)
        if (data.disabled) return;
        if (!isSelf && _sbIsOwnerDisabledForUser(data.user_id)) return;
        // For self: play only when Hear Myself is on AND we are not deafened.
        // Either way we must TRACK the broadcast so its natural end still tells
        // the room to stop — with no local audio nothing else would fire.
        if (isSelf) {
            if (!_sbSelfHear || _sbIsDeafened()) {
                // We still need the overlay's stop button to flip back when our
                // clip ends naturally — schedule the cleanup with the known
                // duration (always sent now). No audio is played for us. While
                // looping, keep the session alive across the silent cycles so
                // toggling hear-self ON mid-loop picks up the next cycle.
                var d = data.duration_ms || 0;
                var cid = data.clip_id;
                if (_sbLoopEnabled) _sbLoopSession = { clipId: cid };
                // The timer drives _sbOnClipEnded even with no local audio: with
                // Loop ON it is what re-cycles the clip (and re-broadcasts it to
                // the room) while the player themselves hears nothing. Keeping
                // it in _sbOwnBroadcast lets a stop cancel it so a stopped sound
                // can never spring back to life.
                if (_sbOwnBroadcast) { clearTimeout(_sbOwnBroadcast.timer); _sbOwnBroadcast = null; }
                if (d > 0 && cid) {
                    _sbOwnBroadcast = {
                        userId: data.user_id,
                        clipId: cid,
                        durationMs: d,
                        timer: setTimeout(function () { _sbOnClipEnded(data.user_id, cid); }, d + 250),
                    };
                }
                return;
            }
        } else if (_sbIsUserMuted(data.user_id)) {
            // For others: muted → SUPPRESS instead of dropping. The play was
            // already recorded above; voice.js calls _sbResumeForUser(uid) on
            // unmute, which replays it with a lazily-sampled offset so the
            // listener lands mid-clip like a late join.
            return;
        }
        // Deafened users should not hear any soundboard sounds
        if (_sbIsDeafened()) return;
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
        // One sound per player: a second play from the same user replaces the
        // first (Discord behaviour). Without this, a loop re-cycle would
        // overlap the still-decoding previous cycle and double the audio.
        _sbStopEntriesFor(data.user_id);
        // Claim this play. Bumping the epoch makes any in-flight async work for
        // this user (a fetch + decode from an older play, or a stop) stale.
        var _sbMyEpoch = _bumpSbEpoch(data.user_id);
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
            // An in-flight play superseded by a newer play or a stop must never
            // start — this is what made a stopped loop restart itself.
            if (_sbEpochOf(data.user_id) !== _sbMyEpoch) return;
            if (!audioBytes || audioBytes.length === 0) return;
            // Disabled mid-flight (global toggle or an owner disable that
            // arrived while the fetch was running) → drop it here.
            if (_isSbDisabledGlobal() || (data.user_id !== window.currentUserId && _isUserMuted(data.user_id))) return;
            if (_sbIsDeafened() && data.user_id !== window.currentUserId) return;
            // Track this user as actively playing (for the indicator badge)
            _sbSetPlaying(data.user_id, true);
            // Playback offset — CLOCK-SKEW-PROOF. play_start_ms is the
            // SERVER's clock, so `Date.now() - play_start_ms` is garbage
            // whenever the client clock differs from the server's (a skewed
            // client computed a huge offset and SKIPPED the clip as "already
            // finished" — the exact "join mid-play and hear nothing" bug).
            // Both deltas below are differences, so any constant skew cancels:
            //   elapsed = (serverNow - playStart)   [server clock, at relay]
            //           + (localNow - localRecv)    [local clock, since arrival]
            // The AudioContext path samples this lazily right before the
            // source starts, so fetch + decode time counts toward the offset.
            var receivedAtMs = data._sbRecvLocalMs || Date.now();
            var offsetProvider = function () {
                var off = 0;
                if (data.play_start_ms && data.server_now_ms) {
                    var serverElapsed = Math.max(0, data.server_now_ms - data.play_start_ms);
                    off = serverElapsed + Math.max(0, Date.now() - receivedAtMs);
                } else if (data.play_start_ms) {
                    // Fallback: server-stamped start against our clock (small skew only)
                    off = Math.max(0, Date.now() - data.play_start_ms);
                } else {
                    off = data._lateJoinOffset || 0;
                }
                // Looping clips: wrap the offset into the current cycle so a
                // late joiner mid-cycle lands at the right position instead of
                // being skipped as "already finished".
                var dMs = durationMsOf(data);
                if (data.loop && dMs > 0 && off >= dMs) off = off % dMs;
                return off;
            };
            // Quick skip: if we already know the duration and the offset is
            // clearly past it (non-looping), don't even bother decoding.
            var earlyOff = offsetProvider();
            if (!data.loop && durationMsOf(data) > 0 && earlyOff >= durationMsOf(data)) {
                // Already over. Clear the badge we just set — with several
                // players at once a skipped clip would otherwise leave THIS
                // user's "playing" indicator stuck on forever (nothing fires
                // the end handler for audio that never started).
                _sbSetPlaying(data.user_id, false);
                return;
            }
            if (_sbAudioCtx || _ensureSbAudioCtx()) {
                _playViaAudioCtx(audioBytes, function () {
                    // Clip finished naturally (or was skipped: past the end)
                    _sbOnClipEnded(data.user_id, data.clip_id);
                }, offsetProvider).then(function (source) {
                    // A stop (or a newer play) landed while we were decoding:
                    // discard the source instead of starting it.
                    if (_sbEpochOf(data.user_id) !== _sbMyEpoch) {
                        if (source) { try { source.stop(); } catch (_) {} }
                        return;
                    }
                    if (!source) return;
                    var entry = { type: 'ctx', source: source, userId: data.user_id, clipId: data.clip_id };
                    _sbAllPlaying.push(entry);
                    if (data.user_id === window.currentUserId) {
                        _sbPlaying = entry;
                        _sbCurrentClipId = data.clip_id;
                    }
                }).catch(function (e) {
                    console.error('Soundboard AudioContext play error:', e);
                    if (_sbEpochOf(data.user_id) !== _sbMyEpoch) return; // stopped mid-decode
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

    function durationMsOf(data) { return data.duration_ms || 0; }

    // Stop and drop every active entry played by `userId` (any entry shape:
    // {type:'ctx',source} objects, Audio elements, the _sbPlaying handle).
    function _sbStopEntriesFor(userId) {
        _sbAllPlaying = _sbAllPlaying.filter(function (entry) {
            var entryUserId = (entry && entry.userId) || (entry && entry._sbUserId) || null;
            if (entryUserId !== userId) return true;
            try {
                if (entry.type === 'ctx' && entry.source) entry.source.stop();
                else if (entry.pause) { entry.pause(); entry.currentTime = 0; }
                else if (entry.stop) entry.stop();
            } catch (_) {}
            return false;
        });
        if (_sbPlaying) {
            var pid = (_sbPlaying.userId) || (_sbPlaying._sbUserId) || null;
            if (pid === userId) { _sbPlaying = null; _sbCurrentClipId = null; }
        }
    }

    function _playSbAudioFallback(audioBytes, userId, clipId, startOffsetMs) {
        try {
            var blob = new Blob([audioBytes], { type: 'audio/wav' });
            var url = URL.createObjectURL(blob);
            var audio = new Audio(url);
            audio._sbUserId = userId;
            audio._sbClipId = clipId;
            if (startOffsetMs && startOffsetMs > 0) {
                var targetSec = startOffsetMs / 1000;
                audio.currentTime = targetSec;
                // Some browsers drop a seek issued before the media is ready
                // and restart at 0 — reapply it once metadata is in so late
                // joiners / unmuted listeners stay at the room's position.
                audio.addEventListener('loadedmetadata', function () {
                    try {
                        if (Math.abs(audio.currentTime - targetSec) > 0.25) audio.currentTime = targetSec;
                    } catch (_) {}
                });
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

    // Stop one user's live sound and clear their playing indicator. Does NOT
    // touch the resume record — the caller decides that (mute keeps it so
    // unmute can resume; a real stop deletes it). Handles real audio entries,
    // the _sbPlaying handle, and our own pseudo broadcast entry.
    function _sbStopEntriesAndIndicator(userId) {
        if (!userId) return null;
        _sbSetPlaying(userId, false);
        var stoppedClipId = null;
        _sbAllPlaying = _sbAllPlaying.filter(function (entry) {
            var entryUserId = (entry && entry.userId) || (entry && entry._sbUserId) || null;
            if (entryUserId !== userId) return true; // keep other users'
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
            if (playingUserId === userId) {
                stoppedClipId = _sbCurrentClipId;
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
        if (_sbOwnBroadcast && _sbOwnBroadcast.userId === userId) {
            clearTimeout(_sbOwnBroadcast.timer);
            stoppedClipId = stoppedClipId || _sbOwnBroadcast.clipId;
            _sbOwnBroadcast = null;
        }
        // Only reset buttons for this user's clip — never wipe another user's
        // stop across all overlay buttons (that hides the active pause button
        // while self-hear audio keeps playing).
        if (stoppedClipId) _resetSbOverlayForClip(stoppedClipId);
        return stoppedClipId;
    }

    // Listen for soundboard_stop from the room via WS. The server forces user_id
    // to the authenticated sender, so this only stops the sender's own clip.
    window._handleSoundboardStop = function (data) {
        if (!data || !data.user_id) return;
        var uid = data.user_id;
        // Cancel any in-flight async play for this user (the fetch/decode may
        // still be running) so it cannot start after the stop.
        _bumpSbEpoch(uid);
        // A real stop (pressed stop, natural end, player left) ends the resume
        // record. An owner-disable stop KEEPS it so re-enabling resumes mid-clip.
        if (data.reason !== 'soundboard_disabled') delete _sbLastPlay[uid];
        _sbStopEntriesAndIndicator(uid);
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
        // Cancel any in-flight own play (temp-token upload still running) and
        // drop the own-broadcast timer — a stop must beat a late async start.
        if (myId) _bumpSbEpoch(myId);
        if (_sbOwnBroadcast) { clearTimeout(_sbOwnBroadcast.timer); _sbOwnBroadcast = null; }
        // Stopping our own audio always ends a Loop session (manual stop,
        // starting another clip, or the setting being turned off mid-loop) and
        // we are no longer "playing" for anyone (badge must not linger).
        _sbLoopSession = null;
        if (myId) _sbSetPlaying(myId, false);
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
        if (_sbOwnBroadcast) { clearTimeout(_sbOwnBroadcast.timer); _sbOwnBroadcast = null; }
        _bumpSbEpoch(window.currentUserId);
        // Every caller is a "we are no longer hearing anything" moment (leave,
        // kick, teardown, soundboard disabled) — the loop must die with it or
        // we would keep re-broadcasting a clip into a room we left. Every
        // playing badge goes too: nobody is playing into an empty room.
        _sbLoopSession = null;
        var hadIndicators = Object.keys(window._sbPlayingUsers || {}).length > 0;
        window._sbPlayingUsers = {};
        if (hadIndicators && window._sbOnSbPlayingChanged) window._sbOnSbPlayingChanged();
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

    // Live owner enable/disable of THIS account's soundboard (server rooms).
    // Disable means BOTH directions stop right now: what we are PLAYING (our
    // self-hear + the room's copy) and what we could hear. The server also
    // broadcasts soundboard_stop to every listener room so members stop
    // hearing the disabled user's clip. Un-disable: only clears the live
    // block — a stopped clip stays stopped (there is no state to resume).
    window._handleSoundboardDisabled = function (data) {
        var serverId = data.server_id || (data.serverId || '');
        // Match against the server of the voice room we are actually in — the
        // viewed server can differ mid-call, which used to drop the disable.
        var myVoiceSid = _sbVoiceServerId();
        if (serverId && myVoiceSid && serverId !== myVoiceSid) return;
        var nowDisabled = !!data.disabled;
        // The server only targets the disabled account's own connections, but
        // never stop someone else's audio if a stray message shows up.
        var forSelf = !data.user_id || data.user_id === window.currentUserId;
        if (nowDisabled && forSelf) {
            // Stop what WE are playing (self-hear + the room's copy) and tell
            // listeners to drop our clip. Other members' sounds are untouched.
            _sbStopOwnPlaybackBroadcastingStop();
            _resetSbButtons();
        } else if (!nowDisabled && forSelf) {
            // Re-enabled: pick up any still-playing suppressed clips mid-way.
            window._sbResumeAllSuppressed();
        }
        // Reflect the state for the rest of this session in THIS server.
        if (serverId) {
            _sbOwnerDisabledByServer[serverId] = nowDisabled;
        } else {
            window._sbOwnerDisabledLive = nowDisabled;
        }
    };

    // Owner-disable state learned live per server (serverId -> bool). Merged
    // with the REST-learned _sbDisabledUsers list at every gate so a disable
    // that happens mid-session is honoured without waiting for a reload.
    var _sbOwnerDisabledByServer = {};
    // Is this (other) user's soundboard disabled by the owner for the server we
    // are in? The REST list is loaded per VIEWED server, so it is only trusted
    // when that matches the voice room's server.
    function _sbIsOwnerDisabledForUser(userId) {
        if (!userId) return false;
        var sid = _sbVoiceServerId();
        if (sid && sid !== window.currentServerId) return false;
        return Array.isArray(window._sbDisabledUsers) && window._sbDisabledUsers.indexOf(userId) !== -1;
    }
    function _sbIsOwnerDisabledForMe() {
        var sid = window.currentServerId;
        if (sid && _sbOwnerDisabledByServer[sid] === true) return true;
        if (window._sbOwnerDisabledLive === true) return true;
        // Live disables are also keyed by the VOICE room's server.
        var vsid = _sbVoiceServerId();
        if (vsid && _sbOwnerDisabledByServer[vsid] === true) return true;
        // Survives a reload: the REST-loaded disabled list contains OUR id.
        var myId = window.currentUserId;
        if (myId && _sbIsOwnerDisabledForUser(myId)) return true;
        return false;
    }
    // Called by voice.js teardownRoom(): the local loop session dies with the
    // room (leaving must not keep re-broadcasting a clip to a room we left),
    // while playback for members who stay is unaffected.
    window._sbClearLoopSession = function () { _sbLoopSession = null; };
    window._sbIsOwnerDisabledForMe = _sbIsOwnerDisabledForMe;
    Object.defineProperty(window, "_sbClipsCache", { get: function() { return _sbClipsCache; }, configurable: true });
    Object.defineProperty(window, '_sbAllPlaying', { get: function() { return _sbAllPlaying; }, configurable: true });

    // --- Per-user last-play records (mute/disable/deafen → resume like late-join) ---
    window._sbResumeForUser = function (userId) {
        var data = _sbLastPlay[userId];
        if (!data) return;
        // Still suppressed? (muted / our own soundboard disabled / deafened /
        // this user's soundboard disabled by the owner)
        if (_isSbDisabledGlobal()) return;
        if (_sbIsUserMuted(userId)) return;
        if (_sbIsDeafened()) return;
        if (userId !== window.currentUserId && _sbIsOwnerDisabledForUser(userId)) return;
        // Only resume if the clip hasn't finished: compute the elapsed time
        // with the same CLOCK-SKEW-PROOF math as _handleSoundboardPlay
        // (play_start_ms is the SERVER's clock, so a skewed local clock
        // must never be differenced against it directly).
        var dur = data.duration_ms || 0;
        if (dur > 0 && data.play_start_ms && data.server_now_ms) {
            var serverElapsed = Math.max(0, data.server_now_ms - data.play_start_ms);
            var sinceRecv = Math.max(0, Date.now() - (data._sbRecvLocalMs || Date.now()));
            if (!data.loop && serverElapsed + sinceRecv >= dur) { delete _sbLastPlay[userId]; return; } // already over
        }
        // Replay via the normal path — the offset is recomputed lazily so it
        // lands at the room's current position (like a late join).
        window._handleSoundboardPlay(data);
    };
    // Resume every still-playing suppressed clip. Used when OUR soundboard is
    // re-enabled or we undeafen. Our own clip is never resumed (it was STOPPED,
    // not suppressed, so it should stay stopped).
    window._sbResumeAllSuppressed = function () {
        Object.keys(_sbLastPlay).forEach(function (uid) {
            if (uid === window.currentUserId) return;
            window._sbResumeForUser(uid);
        });
    };
    // Stop a user's live sound WITHOUT dropping their resume record. The voice
    // menu calls this when muting / owner-disabling someone so unmuting lands
    // mid-clip instead of silence (a real room stop would delete the record).
    window._sbStopLiveForUser = function (userId) {
        if (!userId) return;
        _bumpSbEpoch(userId);
        _sbStopEntriesAndIndicator(userId);
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
