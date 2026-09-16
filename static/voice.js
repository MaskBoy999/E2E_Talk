// =====================================================================
// voice.js — Voice channels & DM calls (WebRTC mesh + E2EE)
//
// Transport: WebRTC mesh — every participant connects P2P to every other
// participant. The Rust server only relays signaling (SDP/ICE) over the
// existing WebSocket and tracks room membership + owner sanctions.
// WebRTC audio keeps playing in background tabs (unlike WebSocket +
// AudioContext PCM which browsers suspend).
//
// E2EE: Insertable Streams (RTCRtpScriptTransform + e2ee-worker.js).
// Audio AND video/screen frames are AES-256-GCM encrypted before leaving
// the device. The key is derived client-side from the existing server key
// (server voice channels, shared by all members) or DM key (DM calls,
// shared with the partner). The server never sees plaintext or the key.
// =====================================================================

(function () {
    'use strict';

    var S = {
        connected: false,
        roomType: null,          // 'server' | 'dm'
        serverId: null,
        channelId: null,
        dmChannelId: null,
        channelName: '',
        isOwner: false,
        forceMuted: false,
        forceDeafened: false,
        members: {},             // uid -> member object
        serverPresence: {},      // server_id -> voice_presence snapshot (who's in each voice channel)
        peers: {},               // uid -> RTCPeerConnection
        remoteStreams: {},       // uid -> {audio, camera, screen} MediaStream
        localStreams: { mic: null, camera: null, screen: null },
        tileTransforms: {},        // 'uid:kind' -> { mirror:bool, rot:deg } per-viewer view transforms
        roomKeyB64: null,
        sigKeyB64: null,        // signaling subkey (SDP/ICE E2EE) derived from the room key
        _pendingRecvTransforms: [],  // receivers awaiting a decrypt transform until the room key arrives
        _pendingPeerUids: {},        // members whose peer could not open yet (room key missing)
        _pendingSignals: {},         // uid -> signaling held until the room key is derivable
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ],
        turnConfigured: false,  // true once the server's TURN config is applied
        audioCtx: null,
        masterGain: null,
        micGain: null,
        remoteAudioEls: {},      // uid -> [HTMLAudioElement] (stacked for >100% volume)
        remoteScreenAudioEls: {}, // uid -> [HTMLAudioElement] (screen-share audio, stacked the same way)
        analyser: null,
        speakingInterval: null,
        speaking: false,
        muted: false,
        deafened: false,
        cameraOn: false,
        screenOn: false,
        cameraFacing: 'user',   // 'user' | 'environment' (flip camera)
        cameraFlash: false,     // torch on the active camera track (mobile)
        popupOpen: false,        // voice channel view (top panel in the text area)
        dmPanelOpen: undefined,  // DM call panel in the DM chat
        dmCallExpanded: false,   // DM call panel expanded → covers the WHOLE screen
        dmPanelHeight: null,     // user-resized DM panel height (px) or null for the CSS default
        voiceFullscreen: false,  // voice channel view expanded → covers the WHOLE screen
        incomingCall: null,      // {callerId, callerUsername, dmChannelId}
        dmCallActive: false,     // we're in a DM call (ringing/connected)
        dmCallAnswered: false,   // the other DM participant joined the room
        dmCallPartner: null,     // {id, username}
        // How long a DM call rings before flipping to the waiting state (both
        // sides). Default 30s; tests shorten it so the timeout flow runs in
        // seconds instead of minutes.
        ringTimeoutMs: 30000,
        settings: {
            micVolume: 100,
            speakerVolume: 100,
            noiseSuppressionMode: 'rnnoise', // 'off' | 'browser' | 'rnnoise'
            echoCancellation: false,          // Chrome's AEC on the mic (default OFF)
            // Audio quality (Settings → Voice → Audio Quality). Send = the
            // capture sample rate / Opus bitrate for the mic; receive = the
            // max playback rate requested from senders (mesh) or the relay
            // ring buffer sample rate. Values: 'low' | 'medium' | 'high' | 'ultra'.
            sendAudioQuality: 'medium',       // default 16 kHz ~32 kbps
            recvAudioQuality: 'medium',       // default 16 kHz playback
            sendScreenAudioQuality: 'medium', // screen share audio quality (relay)
            recvScreenAudioQuality: 'medium', // screen share audio quality (mesh P2P only)
            // Haptic cues (mobile). hapticIncoming: vibrate when a NEW
            // incoming ring starts (notice a call on silent mode).
            // hapticWaiting: vibrate when the ring flips to the waiting state
            // (the green→red badge transition). Both are felt even if the
            // screen is locked or the app is in another tab.
            hapticIncoming: true,
            hapticWaiting: true,
            // Configurable haptic patterns per event type — power users tune
            // intensity (pulse ms), spacing (gap ms) and pulses per cue in
            // Settings → Voice → Haptics. Each { pulse, gap, pulses } becomes
            // a navigator.vibrate pattern [pulse, gap, pulse, …, pulse].
            hapticRingPattern: { pulse: 150, gap: 80, pulses: 2 },    // → [150, 80, 150]
            hapticWaitingPattern: { pulse: 60, gap: 40, pulses: 2 },  // → [60, 40, 60]
            // Notification haptics (Settings → Notifications → Haptic Alerts):
            // notifInbox = a mention/reply lands in the notification box;
            // notifDm = a new message arrives from a DM conversation.
            hapticNotifInbox: true,
            hapticNotifDm: true,
            hapticNotifInboxPattern: { pulse: 120, gap: 90, pulses: 2 },  // → [120, 90, 120]
            hapticNotifDmPattern: { pulse: 80, gap: 60, pulses: 2 },      // → [80, 60, 80]
            // Battery-friendly haptics: while the device is low on battery or
            // the app has been backgrounded for a while, skip the REPEATING
            // ring buzz (one per ringtone cycle) to save battery — the initial
            // single cue and one-shot cues (waiting flip, notifications) still
            // fire. Thresholds are configurable; the whole mode can be turned
            // off (default ON, thresholds 20% / 10 min).
            hapticBatteryFriendly: true,
            hapticBatteryThreshold: 20,   // % below which repeats are skipped
            hapticBackgroundThreshold: 10, // minutes backgrounded before repeats are skipped
            // Video quality (Settings → Voice → Video Quality). Send = the
            // resolution each source is CAPTURED at; receive = the resolution
            // senders scale their stream TO this member (broadcast in
            // voice_state so every peer applies it per-receiver). Defaults are
            // deliberately low: high-res + high-bitrate meshes are what cause
            // the decoder artifacts ("screen looks glitched/torn").
            sendCameraRes: 360,
            sendScreenRes: 480,
            recvCameraRes: 360,
            recvScreenRes: 480,
            relayVideoFps: 15,
            relayVideoQuality: 0.6,
            // When ON, remote camera/screen feeds are NOT auto-loaded: each
            // feed shows a "Load" button (per user AND per kind) and is
            // attached only when clicked. Right-click menus are unaffected.
            manualVideoLoad: false,
            // Legacy mirror of the per-kind video mesh/relay choice (kept for
            // API compatibility). Mesh is the default now, so this is only
            // meaningful when the legacy setVideoMeshMode() toggle is used.
            videoMeshMode: false,
            // Black-feed auto-recovery: seconds of zero encoded frames before
            // the per-sender watchdog forces a renegotiation (a dropped
            // negotiation can leave a camera/screen feed black). 0 = off.
            videoWatchdogSecs: 8,
        },
        _viewLast: '',
        _lastSpeakSent: 0,
        _viewPoll: null,
        _pfpLoading: {},           // picKey -> true (in-flight PFP fetch guard)
        // Manual per-feed video load: uid:kind -> true once the viewer clicked
        // Load for that feed. Reset on leave/join so every call starts fresh.
        _loadedFeeds: {},
        _dmOtherPubB64: null,      // partner identity pubkey fallback for DM call key derivation
        callWaiting: false,        // caller waited 30s unanswered — waiting for manual join
        _ringTimer: null,          // 30s unanswered-ring timeout handle (caller)
        _calleeRingTimer: null,    // 30s ring timeout safety net (callee)
        _ringtoneSource: null,     // active ringtone AudioBufferSourceNode (custom ringtone)
        _ringtoneGain: null,       // ringtone gain node
        _ringtoneRepeatTimer: null, // default-ringtone repeat scheduler
        _ringToken: 0,             // generation token — invalidates stale async ringtone loads
        _testRingTimer: null,      // Test Ringtone auto-stop handle
        waitingCalls: {},          // dm_channel_id -> {waitingUserId, waitingUsername} (persisted waiting state)
        // Signaling E2EE stats (also used by tests)
        sigSentEncrypted: 0,
        sigSentPlain: 0,
        sigRecvEncrypted: 0,
        sigRecvPlain: 0,
        _lastSigWarnKey: null,
        // Per-user mesh/relay overrides. uid → 'mesh' | 'relay' (absent = 'mesh',
        // the default). Relay is opt-in and never auto-selected.
        _audioModeOverrides: {},
        _videoModeOverrides: {},
        _cameraModeOverrides: {},
        _screenModeOverrides: {},
        // Relay video frame blob URLs: { 'uid_kind': blobUrl }
        // Stored so renderPopup() can re-inject <img> tiles after rebuilding.
        _relayVideoFrames: {},
        // Relay audio jitter buffer queues: uid → { queue: [...], nextPlayTime: number }
        _relayAudioQueues: {},
    };

    var e2eeWorker = null;

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------
    var VoiceManager = {
        init: init,
        onWsMessage: onWsMessage,
        handleBinaryRelay: handleBinaryRelay,
        onViewChanged: onViewChanged,
        navigateToVoiceChannel: navigateToVoiceChannel,
        exitVoiceChannelView: exitVoiceChannelView,
        toggleDmExpand: toggleDmExpand,
        joinServerVoice: joinServerVoice,
        leaveVoice: leaveVoice,
        toggleMute: toggleMute,
        toggleDeafen: toggleDeafen,
        toggleCamera: toggleCamera,
        toggleScreen: toggleScreen,
        flipCamera: flipCamera,
        toggleCameraFlash: toggleCameraFlash,
        setCameraFlashOn: setCameraFlashOn,
        openCamOptMenu: openCamOptMenu,
        closeCamOptMenu: closeCamOptMenu,
        setScreenVolume: setScreenVolume,
        toggleServerPopup: toggleServerPopup,
        toggleVoiceFullscreen: toggleVoiceFullscreen,
        setMicVolume: setMicVolume,
        setSpeakerVolume: setSpeakerVolume,
        setNoiseSuppression: setNoiseSuppression,
        setEchoCancellation: setEchoCancellation,
        setSendRes: setSendRes,
        setRecvRes: setRecvRes,
        setManualVideoLoad: setManualVideoLoad,
        setVideoMeshMode: setVideoMeshMode,
        startCamera: startCamera,
        stopCamera: stopCamera,
        setSelfAudioMode: setSelfAudioMode,
        setSelfVideoMode: setSelfVideoMode,
        setSelfCameraMode: setSelfCameraMode,
        setSelfScreenMode: setSelfScreenMode,
        resolveAudioMode: resolveAudioMode,
        resolveVideoMode: resolveVideoMode,
        resolveCameraMode: resolveCameraMode,
        resolveScreenMode: resolveScreenMode,
        setVideoWatchdogSecs: setVideoWatchdogSecs,
        getPeerDiag: function () { return collectPeerDiag(); },
        getVoiceState: function () { return { inVoice: S.connected, channelId: S.channelId, dmChannelId: S.dmChannelId, serverId: S.serverId, roomType: S.roomType }; },
        refreshVoiceDiag: renderVoiceDiag,
        healAndRejoin: healAndRejoin,
        setMemberVolume: setMemberVolume,
        ownerControl: ownerControl,
        callMemberFromVoice: callMemberFromVoice,
        startDmCall: startDmCall,
        acceptDmCall: acceptDmCall,
        declineDmCall: declineDmCall,
        // Mobile haptic cues (exposed for tests).
        vibrateIncomingRingCue: vibrateIncomingRingCue,
        vibrateWaitingCue: vibrateWaitingCue,
        startRingHapticTicker: startRingHapticTicker,
        stopRingHapticTicker: stopRingHapticTicker,
        testHapticPattern: testHapticPattern,
        buildHapticPattern: buildHapticPattern,
        getHapticPattern: getHapticPattern,
        vibrateNotifCue: vibrateNotifCue,
        audioElementHealthSweep: audioElementHealthSweep,
        showIncomingCall: showIncomingCall,
        hideIncomingCall: hideIncomingCall,
        saveSettings: saveSettings,
        updateSettingsLabels: updateSettingsLabels,
        setHapticSetting: function (key, value) {
            if (!S.settings) S.settings = {};
            S.settings[key] = value;
            saveSettings();
        },
        // Battery-friendly haptics (exposed for tests).
        hapticRepeatsSuppressed: hapticRepeatsSuppressed,
        getBackgroundedMinutes: getBackgroundedMinutes,
        getBatteryLevel: getBatteryLevel,
        refreshBatteryCache: refreshBatteryCache,
        setBatteryLevelForTest: function (pct) {
            // Test hook: simulate a battery level so the ticker's synchronous
            // check behaves deterministically without the Battery API.
            S._batteryOverridePct = (pct === null) ? null : pct;
            refreshBatteryCache();
        },
        setBackgroundedMinutesForTest: function (minutes) {
            // Test hook: simulate "backgrounded for N minutes" without a real
            // visibility change (headless has no concept of hidden tabs).
            S._bgOverrideMinutes = (minutes > 0) ? minutes : null;
        },
        resetHapticPattern: resetHapticPattern,
        endDmCall: endDmCall,
        joinWaitingCall: joinWaitingCall,
        syncWaitingCalls: syncWaitingCalls,
        getWaitingCall: function (dmChannelId) { return S.waitingCalls[dmChannelId] || null; },
        getCallState: function (dmChannelId) {
            if (!S.dmCallActive || S.dmChannelId !== dmChannelId) return null;
            if (S.connected && S.dmCallAnswered) return 'connected';
            if (S.callWaiting) return 'waiting';
            return 'calling';
        },
        updateDmCallUI: updateDmCallUI,
        updateChannelChips: updateChannelChips,
        // Re-render self avatars/rows/tiles after the own profile loads (fresh
        // device: pfp arrives async after the voice UI may have rendered).
        refreshSelfProfile: function () {
            if (!S.connected) {
                updateChannelChips();
                return;
            }
            renderBar();
            renderPopup();
            renderDmPanel();
            updateChannelChips();
            updateSelfUI();
        },
        // Re-render ONE member's identity (PFP + display name + color/glow)
        // in every voice surface — server popup rows, DM call tiles, the
        // mini-bar and incoming-call bar — WITHOUT rebuilding the video tiles
        // (a rebuild restarts the <video> decoders → black flash). Called from
        // chat.js when a decrypted profile update lands (profile_updated /
        // profile_key_sync) so a name/PFP change shows up in calls instantly.
        refreshMemberProfile: function (uid) {
            if (!uid) return;
            var m = S.members[uid];
            var isSelf = uid === getSelfId();
            if (!m && !isSelf) return;
            var local = isSelf ? Object.assign({}, m || {}, {
                camera: S.cameraOn,
                screen: S.screenOn,
                muted: S.muted,
                deafened: S.deafened,
                speaking: S.speaking,
            }) : m;
            // A profile update may have changed the pic id — or a previous PFP
            // fetch for this user failed before its key was cached. Drop stale
            // in-flight guards so the re-renders below re-kick the fetch with
            // the CURRENT pic id (the guard is keyed uid:picId and never clears
            // on its own).
            for (var _gk in S._pfpLoading) {
                if (_gk.indexOf(uid + ':') === 0) delete S._pfpLoading[_gk];
            }
            var name = memberDisplayName(uid, local);
            var nameStyle = memberNameStyle(uid);
            var selfMark = (local.is_owner ? ' ' + icon('shield') : '') + (isSelf ? ' (you)' : '');
            // Server voice popup rows
            document.querySelectorAll('.voice-member-row[data-uid="' + uid + '"]').forEach(function (row) {
                var av = row.querySelector('.voice-member-avatar');
                if (av) {
                    var holder = document.createElement('div');
                    holder.innerHTML = memberAvatarHtml(uid, local, name, 'voice-member-avatar');
                    var newAv = holder.firstChild;
                    if (newAv) {
                        if (av.classList.contains('speaking')) newAv.classList.add('speaking');
                        av.replaceWith(newAv);
                        // Re-bind PFP click → profile modal (the replace killed it).
                        newAv.addEventListener('click', function () {
                            if (typeof openProfileModal === 'function') openProfileModal(uid);
                        });
                    }
                }
                var nameEl = row.querySelector('.voice-member-name');
                if (nameEl) {
                    nameEl.textContent = name + selfMark;
                    nameEl.style.cssText = nameStyle || '';
                }
            });
            // DM call tiles
            document.querySelectorAll('.dm-call-tile[data-uid="' + uid + '"]').forEach(function (tile) {
                var av = tile.querySelector('.dm-call-avatar');
                if (av) {
                    var holder = document.createElement('div');
                    holder.innerHTML = memberAvatarHtml(uid, local, name, 'dm-call-avatar');
                    var newAv = holder.firstChild;
                    if (newAv) {
                        if (av.classList.contains('speaking')) newAv.classList.add('speaking');
                        av.replaceWith(newAv);
                        newAv.addEventListener('click', function () {
                            if (typeof openProfileModal === 'function') openProfileModal(uid);
                        });
                    }
                }
                var info = tile.querySelector('.dm-call-tile-info');
                if (info) {
                    // The name is the first non-whitespace node (badges follow).
                    var nameNode = info.firstChild;
                    while (nameNode && nameNode.nodeType === 3 && !nameNode.nodeValue.trim()) nameNode = nameNode.nextSibling;
                    if (nameNode) {
                        var span = document.createElement('span');
                        span.textContent = name;
                        span.style.cssText = nameStyle || '';
                        nameNode.replaceWith(span);
                    }
                }
            });
            // Mini-bar ("In call with X…") + incoming bar ("X is calling…").
            if (S.dmCallPartner && S.dmCallPartner.id === uid) showMiniBar();
            if (S.incomingCall && S.incomingCall.callerId === uid) showIncomingCall(S.incomingCall);
            // Server strip chips + own footer row.
            updateChannelChips();
            if (isSelf) updateSelfUI();
        },
        resetDmPanelOpen: function () { S.dmPanelOpen = undefined; },
        testRingtone: testRingtone,
        playRingtone: playRingtone,
        stopRingtone: stopRingtone,
        // Tests shorten the 30s ring so the timeout flow runs fast.
        setRingTimeoutMs: function (ms) {
            S.ringTimeoutMs = ms > 0 ? ms : 30000;
            if (S._ringTimer) { clearTimeout(S._ringTimer); S._ringTimer = null; }
            if (S._calleeRingTimer) { clearTimeout(S._calleeRingTimer); S._calleeRingTimer = null; }
        },
        isCallWaiting: function () { return S.callWaiting; },
        isIncomingWaiting: function () { return !!(S.incomingCall && S.incomingCall.waiting); },
        getIncomingCall: function () { return S.incomingCall ? { ...S.incomingCall } : null; },
        isConnected: function () { return S.connected; },
        isInDmCall: function () { return S.dmCallActive; },
        getState: function () { return JSON.parse(JSON.stringify(S)); },
        // Debug helpers (used by tests)
        _debug: {
            state: S,
            getMembers: function () { return S.members; },
            getRoomKey: function () { return S.roomKeyB64; },
            getSigKey: function () { return S.sigKeyB64; },
            getIceServers: function () { return JSON.parse(JSON.stringify(S.iceServers)); },
            isTurnConfigured: function () { return S.turnConfigured; },
            getServerPresence: function (serverId) {
                if (serverId) return JSON.parse(JSON.stringify(S.serverPresence[serverId] || null));
                return JSON.parse(JSON.stringify(S.serverPresence));
            },
            // Simulate a speaking toggle for a member in the current room
            // (used by tests to verify the speaking glow without real audio).
            setMemberSpeaking: function (uid, on) {
                if (S.members[uid]) S.members[uid].speaking = !!on;
                updateChannelChips();
                renderBar();
                renderPopup();
                renderDmPanel();
                return true;
            },
            // Drive the REAL server path: send a voice_state with speaking=true
            // so the server broadcasts voice_presence to every server member
            // (including non-participants) and the speaking glow propagates.
            // Also force-unmutes: in headless there is no mic, so joining
            // auto-mutes (the glow is gated on !muted).
            forceSpeaking: function (on) {
                S.muted = false;
                S.deafened = false;
                S.speaking = !!on;
                if (S.connected) {
                    sendVoiceState();
                    updateSelfUI();
                }
                updateChannelChips();
                renderBar();
                renderPopup();
                renderDmPanel();
                return S.speaking;
            },
            encryptSignalPayload: encryptSignalPayload,
            decryptSignalPayload: decryptSignalPayload,
            // Send a probe voice_signal (goes through the real send() → encrypt
            // → server relay → decrypt path) so tests can verify the whole
            // encrypted signaling roundtrip end-to-end.
            sendSignalProbe: function (toUid) {
                if (!S.connected) return false;
                send({
                    type: 'voice_signal',
                    room_type: S.roomType,
                    channel_id: S.channelId || '',
                    dm_channel_id: S.dmChannelId || '',
                    to_user_id: toUid,
                    signal: { type: 'probe', sdp: 'e2ee-probe-' + Date.now() },
                });
                return true;
            },
            // Live getStats diagnostics for every peer (tests): frames
            // encoded/decoded, packet loss, E2EE transform presence.
            getPeerDiag: function () { return collectPeerDiag(); },
            // Manual-load + send-gating introspection (tests). senderGates
            // reports per-peer sender state: track kind, whether the track is
            // held (nulled) because the receiver isn't watching / can't hear.
            isFeedLoaded: isFeedLoaded,
            unloadFeed: unloadFeed,
            loadFeed: function (uid, kind) { markFeedLoaded(uid, kind); applyScreenAudioGate(uid); applyFeedPlaceholders(); if (S.connected) sendVoiceState(); },
            setTileTransform: function (uid, kind, action, val) {
                setTileViewTransform(uid, kind, action, val);
                return true;
            },
            senderGates: function (uid) {
                var pc = S.peers[uid];
                if (!pc || !pc.getSenders) return null;
                return pc.getSenders().map(function (s) {
                    var held = s.track || s._voiceNulled;
                    return {
                        kind: held ? held.kind : 'none',
                        gated: !!s._voiceNulled,
                        id: held ? held.id : null,
                    };
                });
            },
            // Per-user mode overrides (for tests)
            audioOverrides: function () { return JSON.parse(JSON.stringify(S._audioModeOverrides)); },
            videoOverrides: function () { return JSON.parse(JSON.stringify(S._videoModeOverrides)); },
            cameraOverrides: function () { return JSON.parse(JSON.stringify(S._cameraModeOverrides)); },
            screenOverrides: function () { return JSON.parse(JSON.stringify(S._screenModeOverrides)); },
            lastAudioMode: function () { return S._lastAudioMode; },
        },
    };

    window.VoiceManager = VoiceManager;

    // Soundboard playing indicator: refresh badges in-place when a user
    // starts or stops playing a sound.
    window._sbOnSbPlayingChanged = function () {
        // Update badges for every visible member row + DM tile
        Object.keys(S.members || {}).forEach(function (uid) {
            updateMemberBadgesInPlace(uid);
        });
        // Also update self
        updateMemberBadgesInPlace(getSelfId());
    };

    // ------------------------------------------------------------------
    // Init / wiring
    // ------------------------------------------------------------------
    function init() {
        loadSettings();
        fetchTurnConfig();
        armVoiceAudioDebug();
        bindBarControls();
        bindPopupControls();
        bindDmPanelControls();
        bindMiniBarControls();
        bindVolumeMenu();
        bindCamOptMenu();
        bindIncomingCallControls();
        ensureAudioCtx();
        // Keep the fixed overlays aligned to the real text area (the sidebar
        // can grow past 300px on wide screens, so a calc() alone drifts).
        syncOverlayBounds();
        window.addEventListener('resize', syncOverlayBounds);
        // The floating voice bar / DM mini bar can be dragged anywhere on
        // screen (position is persisted in localStorage).
        makeDraggable('voice-bar', 'voice_bar_pos');
        makeDraggable('dm-mini-bar', 'dm_mini_bar_pos');
        // Watch the current view so the bar/popup visibility stays correct
        S._viewPoll = setInterval(checkView, 400);
        // Re-inject DM header call buttons whenever the header is rebuilt
        var hdr = document.getElementById('channel-name');
        if (hdr && window.MutationObserver) {
            var obs = new MutationObserver(function () {
                maybeInjectDmCallButtons();
            });
            obs.observe(hdr, { childList: true, subtree: true });
        }
        maybeInjectDmCallButtons();
    }

    function loadSettings() {
        try {
            var raw = localStorage.getItem('voice_settings');
            if (raw) S.settings = Object.assign(S.settings, JSON.parse(raw));
        } catch (_) {}
        // Migrate the old boolean noiseSuppression setting to the new tri-state
        // mode (old on -> RNNoise, old off -> off).
        if (S.settings.noiseSuppressionMode === undefined && typeof S.settings.noiseSuppression === 'boolean') {
            S.settings.noiseSuppressionMode = S.settings.noiseSuppression ? 'rnnoise' : 'off';
            delete S.settings.noiseSuppression;
            saveSettings();
        }
        // Fullscreen is a per-call UI state only — never persisted. Every join
        // and leave resets it, so a call always starts NOT fullscreen.
        resetFullscreenState();
        if (S.settings.hearSelf === undefined) S.settings.hearSelf = false;
        applySettingsToUI();
    }

    // Reset both fullscreen states to OFF (DM panel expand + voice view
    // fullscreen) and re-apply. Called on every join and leave so each call
    // always starts in the normal (non-fullscreen) layout. The white flash
    // overlay is reset too (a call never starts with the screen white).
    function resetFullscreenState() {
        S.dmCallExpanded = false;
        S.voiceFullscreen = false;
        try { localStorage.removeItem('dm_call_expanded'); } catch (_) {}
        try { localStorage.removeItem('voice_fullscreen'); } catch (_) {}
        applyDmExpand();
        applyVoiceFullscreen();
        S.cameraFlash = false;
        var _ov = el('camera-flash-overlay');
        if (_ov) _ov.style.display = 'none';
        closeCamOptMenu();
    }

    // Fetch the server's TURN servers (if any) so WebRTC calls can traverse
    // strict NATs on phones/mobile networks where STUN-only often fails.
    // Uses chat.js's global authFetch (same lexical scope as `ws`).
    function fetchTurnConfig() {
        if (typeof authFetch !== 'function') return;
        authFetch('/api/voice/turn-config')
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) {
                if (!data || !Array.isArray(data.urls) || data.urls.length === 0) return;
                var urls = data.urls;
                var username = data.username || null;
                var credential = data.credential || null;
                // Drop any STUN-only defaults that collide with TURN urls, then append TURN
                var existing = S.iceServers.filter(function (s) {
                    return !urls.some(function (u) { return s.urls === u; });
                });
                urls.forEach(function (u) {
                    var entry = { urls: u };
                    if (username) entry.username = username;
                    if (credential) entry.credential = credential;
                    existing.push(entry);
                });
                S.iceServers = existing;
                S.turnConfigured = true;
                console.log('voice: TURN configured (' + urls.length + ' server(s))');
                // RTCPeerConnection iceServers are immutable after construction —
                // if any peers were already created before this fetch resolved
                // (e.g. a very fast join right after page load), recreate them so
                // they pick up the TURN servers.
                recreateAllPeers();
            })
            .catch(function (err) {
                console.warn('voice: failed to fetch TURN config:', err);
            });
    }

    function saveSettings() {
        try { localStorage.setItem('voice_settings', JSON.stringify(S.settings)); } catch (_) {}
    }

    function applySettingsToUI() {
        var mv = document.getElementById('voice-mic-volume');
        if (mv) mv.value = S.settings.micVolume;
        var sv = document.getElementById('voice-speaker-volume');
        if (sv) sv.value = S.settings.speakerVolume;
        var ns = document.getElementById('voice-noise-suppression');
        if (ns) ns.value = S.settings.noiseSuppressionMode || 'rnnoise';
        var ec = document.getElementById('voice-echo-cancellation');
        if (ec) ec.checked = !!S.settings.echoCancellation;
        var saq = document.getElementById('voice-send-audio-quality');
        if (saq) saq.value = S.settings.sendAudioQuality || 'medium';
        var raq = document.getElementById('voice-recv-audio-quality');
        if (raq) raq.value = S.settings.recvAudioQuality || 'medium';
        var ssaq = document.getElementById('voice-send-screen-audio-quality');
        if (ssaq) ssaq.value = S.settings.sendScreenAudioQuality || 'medium';
        var rsaq = document.getElementById('voice-recv-screen-audio-quality');
        if (rsaq) rsaq.value = S.settings.recvScreenAudioQuality || 'medium';
        // hear-self is now a button, not a checkbox — no sync needed
        var hi = document.getElementById('voice-haptic-incoming');
        if (hi) hi.checked = S.settings.hapticIncoming !== false;
        var hw = document.getElementById('voice-haptic-waiting');
        if (hw) hw.checked = S.settings.hapticWaiting !== false;
        var hrp = document.getElementById('voice-haptic-ring-pulse');
        if (hrp) hrp.value = String(getHapticPattern('ring').pulse);
        var hrg = document.getElementById('voice-haptic-ring-gap');
        if (hrg) hrg.value = String(getHapticPattern('ring').gap);
        var hrc = document.getElementById('voice-haptic-ring-pulses');
        if (hrc) hrc.value = String(getHapticPattern('ring').pulses);
        var hwp = document.getElementById('voice-haptic-waiting-pulse');
        if (hwp) hwp.value = String(getHapticPattern('waiting').pulse);
        var hwg = document.getElementById('voice-haptic-waiting-gap');
        if (hwg) hwg.value = String(getHapticPattern('waiting').gap);
        var hwc = document.getElementById('voice-haptic-waiting-pulses');
        if (hwc) hwc.value = String(getHapticPattern('waiting').pulses);
        // Notification haptic toggles + sliders (Settings → Notifications).
        var nih = document.getElementById('notif-haptic-inbox');
        if (nih) nih.checked = S.settings.hapticNotifInbox !== false;
        var ndh = document.getElementById('notif-haptic-dm');
        if (ndh) ndh.checked = S.settings.hapticNotifDm !== false;
        var nip = document.getElementById('notif-haptic-inbox-pulse');
        if (nip) nip.value = String(getHapticPattern('notifInbox').pulse);
        var nig = document.getElementById('notif-haptic-inbox-gap');
        if (nig) nig.value = String(getHapticPattern('notifInbox').gap);
        var nic = document.getElementById('notif-haptic-inbox-pulses');
        if (nic) nic.value = String(getHapticPattern('notifInbox').pulses);
        var ndp = document.getElementById('notif-haptic-dm-pulse');
        if (ndp) ndp.value = String(getHapticPattern('notifDm').pulse);
        var ndg = document.getElementById('notif-haptic-dm-gap');
        if (ndg) ndg.value = String(getHapticPattern('notifDm').gap);
        var ndc = document.getElementById('notif-haptic-dm-pulses');
        if (ndc) ndc.value = String(getHapticPattern('notifDm').pulses);
        // Battery-friendly haptics (Settings → Voice → Haptics).
        var hbf = document.getElementById('voice-haptic-battery-friendly');
        if (hbf) hbf.checked = S.settings.hapticBatteryFriendly !== false;
        var hbt = document.getElementById('voice-haptic-battery-threshold');
        if (hbt) hbt.value = S.settings.hapticBatteryThreshold != null ? String(S.settings.hapticBatteryThreshold) : '20';
        var hgt = document.getElementById('voice-haptic-background-threshold');
        if (hgt) hgt.value = S.settings.hapticBackgroundThreshold != null ? String(S.settings.hapticBackgroundThreshold) : '10';
        var sc = document.getElementById('voice-send-camera-res');
        if (sc) sc.value = S.settings.sendCameraRes || 360;
        var ss = document.getElementById('voice-send-screen-res');
        if (ss) ss.value = S.settings.sendScreenRes || 480;
        var rc = document.getElementById('voice-recv-camera-res');
        if (rc) rc.value = S.settings.recvCameraRes || 360;
        var rs = document.getElementById('voice-recv-screen-res');
        if (rs) rs.value = S.settings.recvScreenRes || 480;
        var rf = document.getElementById('voice-relay-video-fps');
        if (rf) rf.value = S.settings.relayVideoFps || 15;
        var jq = document.getElementById('voice-relay-jpeg-quality');
        if (jq) jq.value = S.settings.relayVideoQuality || 0.6;
        var ml = document.getElementById('voice-manual-video-load');
        if (ml) ml.checked = !!S.settings.manualVideoLoad;
        var wd = document.getElementById('voice-video-watchdog-secs');
        if (wd) wd.value = String(S.settings.videoWatchdogSecs || 0);
        updateSettingsLabels();
    }

    // ------------------------------------------------------------------
    // Audio context (created on first user gesture so autoplay is allowed)
    // ------------------------------------------------------------------
    function ensureAudioCtx() {
        if (!S.audioCtx) {
            try {
                var AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return null;
                S.audioCtx = new AC();
                S.masterGain = S.audioCtx.createGain();
                S.masterGain.gain.value = S.settings.speakerVolume / 100;
                S.masterGain.connect(S.audioCtx.destination);
                S.micGain = S.audioCtx.createGain();
                S.micGain.gain.value = S.settings.micVolume / 100;
            } catch (_) { return null; }
        }
        if (S.audioCtx && S.audioCtx.state === 'suspended') {
            S.audioCtx.resume().catch(function () {});
        }
        if (!S._audioCtxListenersAttached) {
            S._audioCtxListenersAttached = true;
            document.addEventListener('visibilitychange', function () {
                if (!document.hidden && S.audioCtx && S.audioCtx.state === 'suspended') {
                    S.audioCtx.resume().catch(function () {});
                }
            });
            document.addEventListener('focus', function () {
                if (S.audioCtx && S.audioCtx.state === 'suspended') {
                    S.audioCtx.resume().catch(function () {});
                }
            }, true);
        }
        return S.audioCtx;
    }

    // ------------------------------------------------------------------
    // Key derivation (both sides derive the same 32-byte key)
    // ------------------------------------------------------------------
    function hexToBytes(hex) {
        var out = new Uint8Array(hex.length / 2);
        for (var i = 0; i < out.length; i++) {
            out[i] = parseInt(hex.substr(i * 2, 2), 16);
        }
        return out;
    }

    function deriveRoomKey() {
        if (!S.roomType) return null;
        try {
            var hex;
            if (S.roomType === 'server') {
                var sk = E2ECrypto.getServerKey(S.serverId);
                if (!sk) return null;
                hex = E2ECrypto.hmacHex(E2ECrypto.arrayBufferToBase64(sk), 'voice:' + S.channelId);
            } else {
                var kp = E2ECrypto.getIdentityKeyPair();
                if (!kp) return null;
                var otherPub = null;
                if (window.dmConversations) {
                    var conv = dmConversations.find(function (c) { return c.dm_channel_id === S.dmChannelId; });
                    if (conv && conv.other_public_key) {
                        otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(conv.other_public_key));
                    }
                }
                // Fallback: ensureDmCallKey() caches the partner's identity key
                // here when the conversation object doesn't have it yet (e.g. the
                // async prefetch in loadDmConversations raced the call button).
                if (!otherPub && S._dmOtherPubB64) {
                    otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(S._dmOtherPubB64));
                }
                if (!otherPub) return null;
                var dmKey = E2ECrypto.getDmKey(S.dmChannelId, kp.privateKey, otherPub);
                hex = E2ECrypto.hmacHex(E2ECrypto.arrayBufferToBase64(dmKey), 'voice:' + S.dmChannelId);
            }
            var bytes = hexToBytes(hex);
            var b64 = E2ECrypto.arrayBufferToBase64(bytes.buffer);
            S.roomKeyB64 = b64;
            // Any remote tracks that arrived before the key was derivable now
            // get their decrypt transform (otherwise one-sided E2EE = silence).
            flushPendingRecvTransforms();
            // Peers held back because the key wasn't ready can now open.
            flushPendingPeerUids();
            // Any peer that DID open before the key existed (or lost its
            // transform mid-call) is healable right now: give every sender and
            // receiver its transform. Without this a keyless peer stays silent
            // forever even after the key lands — the "everyone must rejoin"
            // one-sided-silence bug.
            try { healE2eeInPlace(); } catch (_) {}
            // Signaling that arrived before the key can now be answered.
            flushPendingSignals(false);
            return b64;
        } catch (_) {
            return null;
        }
    }

    // Signaling subkey — a DIFFERENT key from the media key, derived from the
    // same room material, so SDP/ICE ciphertext never reuses the frame key.
    // Both sides derive the same value (room key + room id), so the server can
    // relay encrypted signaling without ever being able to read it.
    function deriveSignalKey() {
        if (!S.roomKeyB64) return null;
        try {
            var roomId = S.dmChannelId || S.channelId || '';
            var hex = E2ECrypto.hmacHex(S.roomKeyB64, 'voice-signal:' + roomId);
            var bytes = hexToBytes(hex);
            S.sigKeyB64 = E2ECrypto.arrayBufferToBase64(bytes.buffer);
            return S.sigKeyB64;
        } catch (_) {
            return null;
        }
    }

    // Encrypt an SDP/ICE signal payload into { e: ciphertext, n: nonce }.
    // Returns null if the key isn't derivable (caller decides fallback).
    function encryptSignalPayload(signalObj) {
        var key = S.sigKeyB64 || deriveSignalKey();
        if (!key) return null;
        try {
            var keyBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(key));
            var enc = E2ECrypto.aeadEncrypt(JSON.stringify(signalObj), keyBytes, 'voice-signal');
            return { e: enc.ciphertext, n: enc.nonce };
        } catch (_) {
            return null;
        }
    }

    // Decrypt a received signal payload. Accepts the encrypted { e, n } format.
    // A plaintext payload is only tolerated when NO key is derivable (both sides
    // ship together, so the encrypted format is always expected); once a key
    // exists, plaintext is rejected — otherwise an active server could strip the
    // {e, n} envelope and inject its own plaintext SDP/ICE (downgrade attack).
    function decryptSignalPayload(payload) {
        var key = S.sigKeyB64 || deriveSignalKey();
        if (!payload || typeof payload !== 'object' || !payload.e || !payload.n) {
            if (key) return null; // downgrade attempt or malformed — drop it
            return payload;       // no key yet — accept legacy/plaintext
        }
        if (!key) return null;
        try {
            var keyBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(key));
            var raw = E2ECrypto.aeadDecrypt(payload.e, keyBytes, payload.n, 'voice-signal');
            if (!raw) return null;
            var str = new TextDecoder().decode(raw);
            return JSON.parse(str);
        } catch (_) {
            return null;
        }
    }

    // ---- DEBUG (one-sided audio) ----
    // Set window.__enableVoiceAudioDebug = true (test init script) to collect:
    //   1. E2EE worker frame timing/drops (e2eeWorker.onmessage) →
    //      window.__voiceE2eeStats
    //   2. Remote <audio> element starvation events (waiting/stalled/playing)
    //      → window.__voiceAudioElEvents (pushed by applyRemoteVolume)
    //   3. Per-100ms inbound-rtp concealment deltas + jitter per peer →
    //      window.__voiceAudioTimeline
    // These correlate a stall in the crypto worker or an element underrun with
    // the jitter-buffer concealment (audible stops) that appears on ONE side.
    var _voiceAudioDbgArmed = false;
    function armVoiceAudioDebug() {
        // Attach the worker-stats handler whenever the worker exists (the
        // early-return guard must NOT skip it: armVoiceAudioDebug() runs at
        // init BEFORE the worker is created, and the guard would then prevent
        // the handler from ever being attached to the real worker).
        if (e2eeWorker) {
            e2eeWorker.onmessage = function (ev) {
                if (ev && ev.data && ev.data.type === 'voice-e2ee-stats') {
                    var w = (window);
                    // Always keep the LAST stats (cheap — one object per
                    // second) so the diagnostics panel can detect a decrypt
                    // transform that is ATTACHED but never invoked (the
                    // one-way audio gap: enc/dec counters stay 0 while the
                    // other direction flows). Full samples stay debug-only.
                    w.__voiceE2eeStats = w.__voiceE2eeStats || { last: null, samples: [] };
                    w.__voiceE2eeStats.last = ev.data.stats;
                    if (w.__enableVoiceAudioDebug) {
                        w.__voiceE2eeStats.samples.push({ t: Date.now(), stats: ev.data.stats });
                        if (w.__voiceE2eeStats.samples.length > 200) w.__voiceE2eeStats.samples.shift();
                    }
                }
            };
        }
        if (_voiceAudioDbgArmed) return;
        _voiceAudioDbgArmed = true;
        try {
            (window).__voiceE2eeStats = (window).__voiceE2eeStats || { last: null, samples: [] };
            (window).__voiceAudioTimeline = (window).__voiceAudioTimeline || [];
            (window).__voiceAudioElEvents = (window).__voiceAudioElEvents || [];
            setInterval(function () {
                var w = (window);
                if (!w.__enableVoiceAudioDebug || !S.connected) return;
                Object.keys(S.peers).forEach(function (uid) {
                    var pc = S.peers[uid];
                    if (!pc) return;
                    pc.getStats().then(function (stats) {
                        var rec = { t: Date.now(), uid: uid.slice(0, 6) };
                        stats.forEach(function (r) {
                            if (r.type === 'inbound-rtp' && r.kind === 'audio') {
                                rec.concealed = r.concealedSamples || 0;
                                rec.emitted = r.jitterBufferEmittedCount || 0;
                                rec.jitter = r.jitterBufferDelay ? (r.jitterBufferDelay / Math.max(1, r.jitterBufferEmittedCount)) * 1000 : 0;
                                rec.packets = r.packetsReceived || 0;
                                rec.lost = r.packetsLost || 0;
                            }
                        });
                        if (rec.concealed !== undefined) {
                            var last = w.__voiceAudioTimeline[w.__voiceAudioTimeline.length - 1];
                            if (last && last.uid === rec.uid && rec.t - last.t < 500) {
                                rec.dConcealed = rec.concealed - last.concealed;
                                rec.dEmitted = rec.emitted - last.emitted;
                                rec.dPackets = rec.packets - last.packets;
                            }
                            w.__voiceAudioTimeline.push(rec);
                            if (w.__voiceAudioTimeline.length > 200) w.__voiceAudioTimeline.shift();
                        }
                    }).catch(function () {});
                });
            }, 100);
        } catch (_) {}
    }

    function ensureE2eeWorker() {
        if (window.RTCRtpScriptTransform && !e2eeWorker) {
            // ?v= busts the browser cache for the worker — a stale cached
            // e2ee-worker.js silently breaks E2EE on EVERY room type (same
            // stale-cache class of bug as voice.js, which is also versioned).
            try { e2eeWorker = new Worker('/e2ee-worker.js?v=3'); } catch (_) {}
            armVoiceAudioDebug();
        }
        if (!window.RTCRtpScriptTransform && !S._warnedNoE2ee) {
            S._warnedNoE2ee = true;
            showToast('This browser does not support end-to-end media encryption — audio/video in calls is NOT encrypted here.');
        }
    }

    // ------------------------------------------------------------------
    // WebSocket helpers. chat.js declares a top-level `let ws` (the socket)
    // in the global lexical scope; we must NOT name any local function `ws`
    // or it would shadow the socket. We reach it lazily at send time.
    // ------------------------------------------------------------------
    function getWs() {
        try { return typeof ws !== 'undefined' ? ws : null; } catch (_) { return null; }
    }
    function send(obj) {
        var w = getWs();
        if (w && w.readyState === WebSocket.OPEN) {
            var payload = obj;
            // Tag every voice message with this device's key so the server can
            // kick the OLD device when the same account joins from another
            // device, and scope leave/disconnect cleanup to the occupying
            // device. Same key the WS auth uses — a plaintext device id, no
            // new secret exposure.
            if (obj && typeof obj === 'object') {
                try { obj.device_id = (typeof getWsDeviceId === 'function' ? getWsDeviceId() : undefined) || localStorage.getItem('e2e_device_key') || undefined; } catch (_) {}
            }
            if (obj && obj.type === 'voice_signal' && obj.signal) {
                var enc = encryptSignalPayload(obj.signal);
                if (enc) {
                    payload = {
                        type: obj.type,
                        room_type: obj.room_type,
                        channel_id: obj.channel_id,
                        dm_channel_id: obj.dm_channel_id,
                        to_user_id: obj.to_user_id,
                        device_id: obj.device_id,
                        signal: enc, // { e, n } — ciphertext, server can't read it
                    };
                    S.sigSentEncrypted++;
                } else {
                    // No key derivable → refuse to leak SDP/ICE in the clear.
                    // (The call simply won't connect, which is safer than the
                    // server observing offers/answers.) Warn once per room.
                    S.sigSentPlain++;
                    var roomKey = S.dmChannelId || S.channelId || '';
                    if (S._lastSigWarnKey !== roomKey) {
                        S._lastSigWarnKey = roomKey;
                        console.warn('voice: cannot encrypt signaling — not sending signal.');
                        showToast('Call encryption key unavailable — signaling is disabled for this call.');
                    }
                    return;
                }
            }
            w.send(JSON.stringify(payload));
        }
    }

    // Binary relay protocol: encode/decode relay frames as binary to avoid
    // JSON serialization overhead on both client and server.
    //
    // Client → Server:  [kind:u8][rt_len:u8][rt][ci_len:u16LE][ci][di_len:u16LE][di][nonce:24][ciphertext]
    // Server → Client:  [0x01 marker][uid_len:u8][uid][kind:u8][nonce:24][ciphertext]

    function encodeRelayBinary(kindStr, nonce, ciphertext) {
        var kindByte = kindStr === 'screen' ? 1 : kindStr === 'audio' ? 2 : kindStr === 'audio_low' ? 3 : kindStr === 'audio_med' ? 4 : kindStr === 'audio_high' ? 5 : kindStr === 'audio_ultra' ? 6 : kindStr === 'screen_audio' ? 7 : kindStr === 'screen_audio_low' ? 8 : kindStr === 'screen_audio_med' ? 9 : kindStr === 'screen_audio_high' ? 10 : kindStr === 'screen_audio_ultra' ? 11 : 0;
        var rt = (S.roomType || 'server');
        var ci = (S.channelId || '');
        var di = (S.dmChannelId || '');
        var rtBytes = new TextEncoder().encode(rt);
        var ciBytes = new TextEncoder().encode(ci);
        var diBytes = new TextEncoder().encode(di);
        var nonceBytes = (typeof nonce === 'string') ? new Uint8Array(E2ECrypto.base64ToArrayBuffer(nonce)) : nonce;
        var total = 1 + 1 + rtBytes.length + 2 + ciBytes.length + 2 + diBytes.length + 24 + ciphertext.length;
        var buf = new ArrayBuffer(total);
        var view = new DataView(buf);
        var u8 = new Uint8Array(buf);
        var pos = 0;
        u8[pos++] = kindByte;
        u8[pos++] = rtBytes.length;
        u8.set(rtBytes, pos); pos += rtBytes.length;
        view.setUint16(pos, ciBytes.length, true); pos += 2;
        u8.set(ciBytes, pos); pos += ciBytes.length;
        view.setUint16(pos, diBytes.length, true); pos += 2;
        u8.set(diBytes, pos); pos += diBytes.length;
        u8.set(nonceBytes, pos); pos += 24;
        u8.set(ciphertext, pos);
        return buf;
    }

    function decodeRelayBinaryIn(data) {
        // Server → Client: [0x01][uid_len][uid][kind][nonce:24][ciphertext]
        var u8 = new Uint8Array(data);
        var pos = 0;
        if (u8[pos++] !== 1) return null; // not a relay marker
        var uidLen = u8[pos++];
        var uid = new TextDecoder().decode(u8.slice(pos, pos + uidLen)); pos += uidLen;
        var kindByte = u8[pos++];
        var kindStr = kindByte === 1 ? 'screen' : kindByte === 2 ? 'audio' : kindByte === 3 ? 'audio_low' : kindByte === 4 ? 'audio_med' : kindByte === 5 ? 'audio_high' : kindByte === 6 ? 'audio_ultra' : kindByte === 7 ? 'screen_audio' : kindByte === 8 ? 'screen_audio_low' : kindByte === 9 ? 'screen_audio_med' : kindByte === 10 ? 'screen_audio_high' : kindByte === 11 ? 'screen_audio_ultra' : 'camera';
        var nonce = u8.slice(pos, pos + 24); pos += 24;
        var ciphertext = u8.slice(pos);
        return { fromUid: uid, kind: kindStr, nonce: nonce, ciphertext: ciphertext };
    }

    function sendRelayBinary(kindStr, nonce, ciphertext) {
        var w = getWs();
        if (w && w.readyState === WebSocket.OPEN) {
            w.send(encodeRelayBinary(kindStr, nonce, ciphertext));
        }
    }

    // ------------------------------------------------------------------
    // Joining / leaving
    // ------------------------------------------------------------------
    function joinServerVoice(serverId, channelId, channelName) {
        ensureAudioCtx();
        if (S.connected) {
            if (S.roomType === 'server' && S.channelId === channelId) {
                // Already in this channel → toggle the popup
                toggleServerPopup();
                return;
            }
            leaveVoice();
        }
        S.roomType = 'server';
        S.serverId = serverId;
        S.channelId = channelId;
        S.dmChannelId = null;
        S.channelName = channelName || '';
        S.popupOpen = false;
        resetFullscreenState();
        S._pendingPeerUids = {};
        if (!deriveRoomKey()) {
            // The room key derives from the SERVER key. If that hasn't been
            // fetched/decrypted yet (fresh join, key rotation, cold boot) every
            // peer would open WITHOUT E2EE — undecryptable media, i.e. nobody
            // hears anybody until a manual rejoin. Kick the key fetch and hold
            // peer creation until it lands (see schedulePeerCreation).
            ensureRoomKey();
        }
        deriveSignalKey();
        send({ type: 'voice_join', room_type: 'server', server_id: serverId, channel_id: channelId });
        playSound('join');
        showToast('Joining voice channel…');
    }

    function leaveVoice() {
        var wasDm = S.roomType === 'dm';
        var wasConnected = S.connected;
        // Stop ALL soundboard audio BEFORE teardown so we can still read voice state
        // for the WS stop message and so _sbAllPlaying is cleared while S is still valid.
        if (window._stopAllSoundboardAudioAll) window._stopAllSoundboardAudioAll();
        else if (window._stopAllSoundboardAudio) window._stopAllSoundboardAudio();
        if (S.connected || S.roomType) {
            send({ type: 'voice_leave', room_type: S.roomType || 'server', channel_id: S.channelId || '', dm_channel_id: S.dmChannelId || '' });
            // Send soundboard stop to room members (must happen BEFORE teardownRoom clears S)
            if (window._sendSoundboardStop) window._sendSoundboardStop();
        }
        teardownRoom();
        if (wasDm || wasConnected) playSound('leave');
        hideBar();
        hidePopup();
        hideDmPanel();
        hideMiniBar();
        hideIncomingCall();
        closePipMenu();
        closeCamOptMenu();
    }

    function teardownRoom() {
        clearRingTimer();
        clearCalleeRingTimer();
        stopRingtone();
        var prevDmChannelId = S.dmChannelId;
        // Manual video-load state is per-call: every join starts with feeds
        // unloaded (each feed loads individually when the viewer clicks it).
        S._loadedFeeds = {};
        S.connected = false;
        S.roomType = null;
        S.serverId = null;
        S.channelId = null;
        S.dmChannelId = null;
        S.channelName = '';
        S.isOwner = false;
        S.forceMuted = false;
        S.forceDeafened = false;
        S.members = {};
        S.roomKeyB64 = null;
        S.sigKeyB64 = null;
        // Drop any receivers still waiting for a decrypt transform — they
        // belonged to the OLD room and must never receive the NEXT room's key
        // (stale-key risk when leaving a room with a still-deriving key).
        S._pendingRecvTransforms = [];
        // Stop the server-key recovery poll (if any) — the guards inside also
        // clear it, but an explicit teardown clear prevents a double-interval
        // if the user leaves and rejoins the same room within one poll tick.
        if (S._srvKeyTimer) {
            clearInterval(S._srvKeyTimer);
            S._srvKeyTimer = null;
        }
        S._dmOtherPubB64 = null;
        S.muted = false;
        S.deafened = false;
        S.cameraOn = false;
        S.screenOn = false;
        S.speaking = false;
        S.dmCallActive = false;
        S.dmCallAnswered = false;
        S.dmCallPartner = null;
        S.callWaiting = false;
        // Always leave the call in the normal layout — fullscreen never
        // carries over into the next call.
        resetFullscreenState();
        // Leaving drops the marker in BOTH places (S.waitingCalls AND the
        // dmConversations fields syncWaitingCalls() rebuilds from) — otherwise
        // the next syncWaitingCalls() on navigation resurrects a phantom
        // waiting indicator for the call we just left.
        if (prevDmChannelId) {
            clearWaitingMarkerForChannel(prevDmChannelId);
        }
        // Back to the mesh default for the next room.
        S._lastAudioMode = 'mesh';
        S._pendingPeerUids = {};
        S._pendingSignals = {};
        stopPendingSignalWatch();
        S._audioModeOverrides = {};
        S._videoModeOverrides = {};
        S._cameraModeOverrides = {};
        S._screenModeOverrides = {};
        closeAllPeers();
        // Bulk-kill any relay audio nodes that survived closeAllPeers (relay
        // users may not have S.remoteAudioEls entries, so per-uid cleanup
        // in removeRemoteAudioEls would miss them).
        Object.keys(_relayPlaybackTimers).forEach(function (uid) {
            var t = _relayPlaybackTimers[uid];
            if (t.processor) { try { t.processor.disconnect(); } catch (_) {} }
            if (t.silent) { try { t.silent.disconnect(); } catch (_) {} }
            delete _relayPlaybackTimers[uid];
        });
        Object.keys(_relayGainNodes).forEach(function (uid) {
            try { _relayGainNodes[uid].disconnect(); } catch (_) {}
            delete _relayGainNodes[uid];
        });
        S._relayAudioQueues = {};
        stopAllVideoRelays();
        // Revoke any remaining relay video blob URLs to prevent memory leak
        if (S._relayVideoFrames) {
            Object.keys(S._relayVideoFrames).forEach(function (fk) {
                var url = S._relayVideoFrames[fk];
                if (url && url.startsWith('blob:')) {
                    try { URL.revokeObjectURL(url); } catch (_) {}
                }
            });
        }
        S._relayVideoFrames = {};
        stopAudioRelay();
        stopLocalMedia();
        stopSpeakingDetection();
        hideVideoReconnect();
        renderBar();
        renderPopup();
        renderDmPanel();
        notifyWaitingChanged();
    }

    // Close and rebuild every peer connection. Used when TURN config arrives
    // after peers were already created (iceServers can't be changed in place).
    // Re-negotiation happens automatically via onnegotiationneeded.
    function recreateAllPeers() {
        var uids = Object.keys(S.peers);
        if (!uids.length) return;
        // No room key means no E2EE — recreating now would leave every edge
        // silent. The pending-peer queue reopens them once the key lands.
        if (!S.roomKeyB64) {
            ensureRoomKey();
            return;
        }
        closeAllPeers();
        var selfId = getSelfId();
        Object.keys(S.members).forEach(function (uid) {
            if (uid !== selfId && !S.peers[uid]) {
                schedulePeerCreation(uid, 0);
            }
        });
    }

    function closeAllPeers() {
        for (var uid in S.peers) {
            var pc = S.peers[uid];
            if (pc._videoWatchTimer) {
                clearInterval(pc._videoWatchTimer);
                pc._videoWatchTimer = null;
            }
            try { pc.close(); } catch (_) {}
        }
        S.peers = {};
        for (var uid2 in S.remoteAudioEls) {
            removeRemoteAudioEls(uid2);
        }
        for (var uid3 in S.remoteScreenAudioEls) {
            removeRemoteScreenAudioEls(uid3);
        }
        S.remoteStreams = {};
        clearRemoteTiles();
    }

    function stopLocalMedia() {
        ['mic', 'camera', 'screen'].forEach(function (kind) {
            var st = S.localStreams[kind];
            if (st) {
                st.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
                S.localStreams[kind] = null;
            }
        });
        if (S.micGain) { try { S.micGain.disconnect(); } catch (_) {} S.micGain = null; }
    }

    // ------------------------------------------------------------------
    // Mic / camera / screen capture
    // ------------------------------------------------------------------
    function effectiveNsMode() {
        var mode = S.settings.noiseSuppressionMode || 'rnnoise';
        var needsWorklet = (mode === 'rnnoise' || mode === 'rnnoise-gate');
        if (needsWorklet && !(window.AudioWorkletNode && window.AudioContext)) {
            // No AudioWorklet support — fall back to the browser's built-in NS.
            return 'browser';
        }
        if (needsWorklet && _nsFailedSession) {
            // The RNNoise pipeline failed earlier this session — use the
            // browser's built-in NS instead (keeps the saved preference for
            // the next page load, where RNNoise is tried again).
            return 'browser';
        }
        return mode;
    }

    // Build the RNNoise pipeline: mic -> AudioWorklet ->
    // MediaStreamAudioDestination -> processed track, which replaces the raw
    // mic track in addLocalTracks(). Runs entirely in the browser, frame by
    // frame, on-device.
    //
    // The worklet (static/rnnoise/sapphi-worklet.js + sapphi-rnnoise.wasm)
    // is the production RNNoise build with the real trained model — earlier
    // vendored shiguredo wasm builds embedded an INERT model (processFrame
    // returned the input unchanged, VAD always 0 → noise suppression did
    // nothing while still adding latency).
    // Sentinel returned by setupMicPipeline when the RNNoise pipeline can't
    // be built — startMic() then falls back to the browser's built-in NS by
    // re-acquiring the mic (the original mic was grabbed with
    // noiseSuppression:false, so it must be re-requested).
    var NS_FALLBACK = {};
    var _nsWasmBinary = null; // cached RNNoise wasm (fetched once per page)
    // Set once when the RNNoise pipeline can't be built (wasm fetch failed,
    // addModule failed, or 48 kHz unavailable). While set, effectiveNsMode()
    // reports 'browser' so the mic is re-acquired with the browser's built-in
    // NS — WITHOUT rewriting the saved setting: a transient failure (network
    // blip, server briefly down) must not permanently strip the user's
    // RNNoise preference. The flag lives per-session; every page load retries
    // RNNoise once before falling back.
    var _nsFailedSession = false;

    function setupMicPipeline(mode) {
        teardownMicPipeline(); // never leak a previous 48 kHz context
        S.localStreams.processedMic = null;
        var needsWorklet = (mode === 'rnnoise' || mode === 'rnnoise-gate');
        if (!needsWorklet || !S.localStreams.mic || !window.AudioWorkletNode) return Promise.resolve(null);
        return Promise.resolve().then(function () {
            var ctx = new AudioContext({ sampleRate: 48000 });
            if (Math.abs(ctx.sampleRate - 48000) > 1) {
                // RNNoise is fixed at 48 kHz; fall back instead of resampling.
                try { ctx.close(); } catch (_) {}
                return NS_FALLBACK;
            }
            var binPromise = _nsWasmBinary ? Promise.resolve(_nsWasmBinary) :
                fetch('/rnnoise/sapphi-rnnoise.wasm').then(function (r) { return r.ok ? r.arrayBuffer() : null; });
            return binPromise.then(function (wasmBinary) {
                if (!wasmBinary) {
                    try { ctx.close(); } catch (_) {}
                    console.warn('RNNoise wasm fetch failed.');
                    return NS_FALLBACK;
                }
                _nsWasmBinary = wasmBinary;
                return ctx.audioWorklet.addModule('/rnnoise/sapphi-worklet.js').then(function () {
                    var src = ctx.createMediaStreamSource(S.localStreams.mic);
                    var worklet = new AudioWorkletNode(ctx, '@sapphi-red/web-noise-suppressor/rnnoise', {
                        numberOfInputs: 1,
                        numberOfOutputs: 1,
                        channelCount: 1,
                        channelCountMode: 'explicit',
                        outputChannelCount: [1],
                        processorOptions: { wasmBinary: wasmBinary, maxChannels: 1 },
                    });
                    var dest = ctx.createMediaStreamDestination();
                    src.connect(worklet);
                    // Krisp-like mode: chain RNNoise → noise gate → compressor
                    if (mode === 'rnnoise-gate') {
                        var analyser = ctx.createAnalyser();
                        analyser.fftSize = 256;
                        var gateGain = ctx.createGain();
                        gateGain.gain.value = 1.0;
                        var compressor = ctx.createDynamicsCompressor();
                        compressor.threshold.value = -30;
                        compressor.knee.value = 12;
                        compressor.ratio.value = 4;
                        compressor.attack.value = 0.003;
                        compressor.release.value = 0.15;
                        worklet.connect(analyser);
                        worklet.connect(gateGain);
                        gateGain.connect(compressor);
                        compressor.connect(dest);
                        // Noise gate: detect RMS level, close gate below threshold
                        var gateData = new Uint8Array(analyser.frequencyBinCount);
                        var _gateOpen = true;
                        var GATE_THRESHOLD = 15;  // RMS 0-255 below this = silence
                        var GATE_RELEASE_MS = 200;
                        var _gateCloseTime = 0;
                        var _gateTimer = setInterval(function () {
                            analyser.getByteTimeDomainData(gateData);
                            var sum = 0;
                            for (var k = 0; k < gateData.length; k++) {
                                var v = (gateData[k] - 128) / 128;
                                sum += v * v;
                            }
                            var rms = Math.sqrt(sum / gateData.length) * 255;
                            var now = ctx.currentTime * 1000;
                            if (rms > GATE_THRESHOLD) {
                                if (!_gateOpen) {
                                    gateGain.gain.setTargetAtTime(1.0, ctx.currentTime, 0.005);
                                    _gateOpen = true;
                                }
                                _gateCloseTime = 0;
                            } else {
                                if (_gateOpen && _gateCloseTime === 0) {
                                    _gateCloseTime = now;
                                }
                                if (_gateOpen && _gateCloseTime > 0 && (now - _gateCloseTime) > GATE_RELEASE_MS) {
                                    gateGain.gain.setTargetAtTime(0.0, ctx.currentTime, 0.03);
                                    _gateOpen = false;
                                }
                            }
                        }, 16);
                        // Stash timer for cleanup
                        S._nsGateTimer = _gateTimer;
                    } else {
                        worklet.connect(dest);
                    }
                    S.nsCtx = ctx;
                    S.localStreams.processedMic = dest.stream;
                    return dest.stream.getAudioTracks()[0];
                });
            })
            .catch(function (err) {
                console.warn('RNNoise setup failed:', err);
                try { ctx.close(); } catch (_) {}
                return NS_FALLBACK;
            });
        });
    }

    function teardownMicPipeline() {
        if (S.localStreams && S.localStreams.processedMic) {
            S.localStreams.processedMic.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
            S.localStreams.processedMic = null;
        }
        if (S._nsGateTimer) { try { clearInterval(S._nsGateTimer); } catch (_) {} S._nsGateTimer = null; }
        if (S.nsCtx) {
            try { S.nsCtx.close(); } catch (_) {}
            S.nsCtx = null;
        }
    }

    function startMic() {
        if (S.localStreams.mic || S.deafened) return Promise.resolve();
        var mode = effectiveNsMode();
        var sendQuality = (S.settings && S.settings.sendAudioQuality) || 'medium';
        var sampleRate = { low: 8000, medium: 16000, high: 24000, ultra: 48000 }[sendQuality] || 16000;
        var constraints = {
            audio: {
                echoCancellation: !!S.settings.echoCancellation,
                noiseSuppression: mode === 'browser', // RNNoise replaces it
                autoGainControl: true,
                sampleRate: { ideal: sampleRate },
            },
            video: false,
        };
        return navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
            S.localStreams.mic = stream;
            // Route mic through a gain node (mic volume)
            if (S.audioCtx && S.micGain) {
                var src = S.audioCtx.createMediaStreamSource(stream);
                src.connect(S.micGain);
                S.micGain.gain.value = S.settings.micVolume / 100;
                // Hear-self loopback: route mic to speakers so you can hear yourself
                if (S.settings.hearSelf) {
                    try { S.micGain.connect(S.masterGain); } catch (_) {}
                    S._hearSelfConnected = true;
                }
            }
            startSpeakingDetection();
            // Build the RNNoise pipeline first so the PROCESSED track is what
            // gets added to the peer connections.
            return setupMicPipeline(mode).then(function (result) {
                if (result === NS_FALLBACK) {
                    // RNNoise couldn't be built (wasm/worklet unavailable). Fall
                    // back to the browser's built-in NS: the mic was acquired
                    // with noiseSuppression:false, so stop it and re-acquire
                    // with the browser NS constraint. Bounded: _nsFailedSession
                    // now forces effectiveNsMode() to 'browser', so the
                    // re-acquired mic uses browser NS and setupMicPipeline
                    // won't be attempted again this session. The saved setting
                    // is untouched — a transient failure must not permanently
                    // remove the user's RNNoise preference (next page load
                    // retries it).
                    stopMic();
                    _nsFailedSession = true;
                    showToast('RNNoise unavailable — using browser noise suppression.');
                    return startMic();
                }
                addLocalTracksToAllPeers();
                return stream;
            });
        }).catch(function (err) {
            // Transient "device busy" failures (e.g. re-acquiring the mic right
            // after stopping it) shouldn't flip the user back to muted — that
            // made the mute button feel like it needed a double-click. Retry
            // once after a short beat; only force-mute on a real denial.
            var transient = err && (err.name === 'NotReadableError' || err.name === 'TrackStartError' || err.name === 'AbortError');
            if (transient && !S._micRetrying) {
                S._micRetrying = true;
                return new Promise(function (res) { setTimeout(res, 350); }).then(function () {
                    S._micRetrying = false;
                    return startMic();
                });
            }
            S._micRetrying = false;
            console.warn('Mic access denied:', err);
            showToast('Microphone access denied — you are muted.');
            S.muted = true;
            updateSelfUI();
            sendVoiceState();
        });
    }

    // Gate (replaceTrack(null)) the mic sender on every peer WITHOUT removing
    // it. Removing the m-line on mute (the old behavior) forced a renegotiation
    // per mute/unmute, and unmute then addTrack()ed a BRAND-NEW transceiver —
    // the receiver accumulated one extra audio receiver per cycle ("recv audio
    // ×3 after muting/unmuting"), and the fresh sender could lose its E2EE
    // encrypt transform ("send audio [E2EE ✗]"). Gating keeps the m-line, the
    // sender object and its transform; unmute just replaceTrack()s the fresh
    // mic track back on the same sender.
    function gateMicSendersOnAllPeers() {
        for (var uid in S.peers) {
            var pc = S.peers[uid];
            if (!pc || !pc.getSenders) continue;
            pc.getSenders().forEach(function (s) {
                var held = s.track || s._voiceNulled;
                if (!held || held.kind !== 'audio') return;
                // Screen-share (tab/system) audio is a separate feed — muting
                // the mic must not gate it.
                if (S.localStreams.screen && S.localStreams.screen.getAudioTracks().indexOf(held) !== -1) return;
                applySenderGate(s, false);
            });
        }
    }

    function stopMic() {
        teardownMicPipeline();
        // Disconnect hear-self loopback before stopping mic
        if (S._hearSelfConnected && S.audioCtx && S.micGain && S.masterGain) {
            try { S.micGain.disconnect(S.masterGain); } catch (_) {}
            S._hearSelfConnected = false;
        }
        if (S.localStreams.mic) {
            S.localStreams.mic.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
            S.localStreams.mic = null;
            // Keep the m-line + sender + its E2EE transform; just stop sending
            // (the receiver sees a live track with 0 packets — correct for a
            // muted sender). No renegotiation.
            gateMicSendersOnAllPeers();
        }
        stopSpeakingDetection();
    }

    function startCamera() {
        if (S.localStreams.camera) return Promise.resolve();
        // Flip uses S.cameraFacing ('user' | 'environment'); a fresh stream
        // starts with the flash off (torch is a per-stream constraint). The
        // white overlay never carries over into the restarted stream.
        S.cameraFlash = false;
        var _stOv = el('camera-flash-overlay');
        if (_stOv) _stOv.style.display = 'none';
        // Capture at the configured SEND resolution (Settings → Voice → Video
        // Quality). Asking the encoder for less than the camera's native res is
        // the cheapest way to cut encode cost + bitrate — the mesh-friendly
        // default is deliberately low to avoid decoder artifacts.
        var camH = S.settings.sendCameraRes || 360;
        return navigator.mediaDevices.getUserMedia({ video: { width: { ideal: resW(camH) }, height: { ideal: camH }, frameRate: { ideal: 30, max: 30 }, facingMode: S.cameraFacing || 'user' }, audio: false })
            .then(function (stream) {
                S.localStreams.camera = stream;
                S.cameraOn = true;
                var cvt = stream.getVideoTracks()[0];
                if (cvt) { try { cvt.contentHint = 'motion'; } catch (_) {} }
                if (useVideoRelay('camera')) {
                    // Server voice channel: relay video via WebSocket
                    startVideoRelay(stream, 'camera');
                } else {
                    addLocalTracksToAllPeers();
                }
                sendVoiceState();
                renderSelfPreview();
                renderPopup();
                renderDmPanel();
                updateSelfUI();
            })
            .catch(function (err) {
                console.warn('Camera access denied:', err);
                showToast('Camera access denied.');
            });
    }

    function stopCamera() {
        if (S.localStreams.camera) {
            S.localStreams.camera.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
            removeTrackFromAllPeers('camera');
            S.localStreams.camera = null;
        }
        stopVideoRelay('camera');
        S.cameraOn = false;
        setCameraFlashOn(false);
        sendVoiceState();
        renderSelfPreview();
        renderPopup();
        renderDmPanel();
        updateSelfUI();
    }

    function startScreen() {
        if (S.localStreams.screen) return Promise.resolve();
        // Cap capture so the mesh doesn't flood: screen shares are mostly
        // static content — 1080p @ 30fps is plenty, and every frame is AES-GCM
        // encrypted per-peer, so huge native-res/fps captures starve the
        // pipeline and produce decoder artifacts.
        var scrH = S.settings.sendScreenRes || 480;
        return navigator.mediaDevices.getDisplayMedia({
            video: {
                cursor: 'always',
                // Cap capture at the configured SEND resolution — asking the
                // screen capture for less than native res cuts encode cost and
                // bitrate at the source (the mesh-friendly default is low).
                width: { max: resW(scrH) },
                height: { max: scrH },
                frameRate: { ideal: 30, max: 30 },
            },
            // Capture tab/system audio too (the Chrome picker shows the
            // "Share tab audio" checkbox). The remote side receives it as a
            // SECOND audio track and routes it through its own per-member
            // volume control (right-click the screen tile).
            audio: true,
        })
            .then(function (stream) {
                S.localStreams.screen = stream;
                S.screenOn = true;
                var svt = stream.getVideoTracks()[0];
                if (svt) {
                    try { svt.contentHint = 'detail'; } catch (_) {}
                    svt.addEventListener('ended', function () {
                        stopScreen();
                    });
                }
                if (useVideoRelay('screen')) {
                    // Server voice channel: relay screen video via WebSocket.
                    // Screen audio is relayed too if audio relay is active,
                    // otherwise it stays on WebRTC mesh.
                    startVideoRelay(stream, 'screen');
                    if (_audioRelayTimer) {
                        startScreenAudioRelay();
                    } else {
                        // Add audio tracks to peers (audio is still on mesh)
                        var audioTracks = stream.getAudioTracks();
                        for (var uid in S.peers) {
                            var pc = S.peers[uid];
                            audioTracks.forEach(function (track) {
                                try { pc.addTrack(track, stream); } catch (_) {}
                            });
                        }
                    }
                } else {
                    addLocalTracksToAllPeers();
                }
                sendVoiceState();
                renderSelfPreview();
                renderPopup();
                renderDmPanel();
                updateSelfUI();
            })
            .catch(function (err) {
                console.warn('Screen share denied:', err);
                showToast('Screen sharing was denied.');
            });
    }

    function stopScreen() {
        if (S.localStreams.screen) {
            S.localStreams.screen.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
            removeTrackFromAllPeers('screen');
            S.localStreams.screen = null;
        }
        stopVideoRelay('screen');
        stopScreenAudioRelay();
        S.screenOn = false;
        sendVoiceState();
        renderSelfPreview();
        renderPopup();
        renderDmPanel();
        updateSelfUI();
    }

    // ------------------------------------------------------------------
    // WebRTC mesh peers
    // ------------------------------------------------------------------

    // Voice latency optimizations (tune Opus + jitter buffer).
    // These do NOT touch E2EE — encryption stays identical.
    function mungeSdp(sdp) {
        // 1. ptime=10: send 10ms Opus frames instead of 20ms (saves ~10ms encode wait)
        // 2. useinbandfec=1: Opus forward error correction (prevents 50-200ms spikes on packet loss)
        // 3. maxplaybackrate: based on recv audio quality setting
        var recvQuality = (S.settings && S.settings.recvAudioQuality) || 'medium';
        var maxPlaybackRate = { low: 8000, medium: 16000, high: 24000, ultra: 48000 }[recvQuality] || 16000;
        return sdp.replace(/a=fmtp:(\d+) (.*)/g, function (match, pt, params) {
            if (params.indexOf('opus') !== -1 || params.indexOf('minptime') !== -1 || params.indexOf('useinbandfec') !== -1) {
                return 'a=fmtp:' + pt + ' ptime=10;minptime=10;useinbandfec=1;maxplaybackrate=' + maxPlaybackRate;
            }
            return match;
        });
    }

    // Open a peer for a member — but NEVER without a room key. With no key the
    // E2EE transform is never attached, the media is undecryptable and the call
    // is silent (both directions) until a manual rejoin. Uids that have to wait
    // are remembered and retried the moment the key becomes derivable.
    function schedulePeerCreation(uid, delayMs) {
        setTimeout(function () {
            if (!S.connected || !S.members[uid] || S.peers[uid]) return;
            if (!S.roomKeyB64) {
                S._pendingPeerUids[uid] = true;
                ensureRoomKey();
                return;
            }
            createPeer(uid);
        }, delayMs || 0);
    }

    function flushPendingPeerUids() {
        if (!S.roomKeyB64) return;
        var uids = Object.keys(S._pendingPeerUids || {});
        if (!uids.length) return;
        S._pendingPeerUids = {};
        uids.forEach(function (uid, idx) { schedulePeerCreation(uid, idx * 100); });
    }

    // The room key needs the server key (server rooms). When it is missing,
    // fetch + decrypt it, then re-derive and release any waiting peers.
    // chat.js exposes fetchAndDecryptServerKey; without it we simply keep
    // retrying the derivation (the key may arrive via another path).
    function ensureRoomKey() {
        if (S.roomType !== 'server' || !S.serverId) return;
        if (S.roomKeyB64) { flushPendingPeerUids(); return; }
        var fetchKey = window.fetchAndDecryptServerKey;
        if (typeof fetchKey !== 'function') return;
        if (S._roomKeyFetching === S.serverId) return; // one in flight
        S._roomKeyFetching = S.serverId;
        try {
            Promise.resolve(fetchKey(S.serverId)).then(function () {
                S._roomKeyFetching = null;
                if (deriveRoomKey()) deriveSignalKey();
            }).catch(function () { S._roomKeyFetching = null; });
        } catch (_) { S._roomKeyFetching = null; }
    }

    function createPeer(uid) {
        if (S.peers[uid]) return S.peers[uid];
        var pc = new RTCPeerConnection({
            iceServers: S.iceServers,
        });

        pc.onicecandidate = function (e) {
            if (!e.candidate) return;
            send({
                type: 'voice_signal',
                room_type: S.roomType,
                channel_id: S.channelId || '',
                dm_channel_id: S.dmChannelId || '',
                to_user_id: uid,
                signal: { type: 'ice', candidate: e.candidate },
            });
        };
        pc.onconnectionstatechange = function () {
            if (pc.connectionState === 'connected') {
                // Senders are fully wired after connection; cap their bitrate now
                // (reapplying is a no-op if already tuned).
                tuneVideoSenders(pc);
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                // Attempt a restart so calls recover from transient network blips
                if (S.connected && pc.signalingState !== 'closed') {
                    try { pc.restartIce(); } catch (_) {}
                }
            }
        };
        // Stuck-peer watchdog: ICE can sit at 'checking' forever without ever
        // firing the failed/disconnected handler (e.g. a one-sided edge where
        // the remote's candidates arrived but a response was dropped). restartIce
        // every 5s until the edge connects or the room ends.
        // Stuck-peer recovery: if an edge is still negotiating after a few
        // seconds, only the IMPOLITE side (the designated offerer) re-fires its
        // negotiation — with slow backoff but NO hard cap on attempts (bounded
        // by the room's lifetime: the watcher stops once connected, failed, or
        // the room ends). Firing on both sides every 5s caused a renegotiation
        // storm; firing on only one side with a growing delay is safe. On a
        // heavily-loaded machine (many simultaneous peers) getUserMedia + the
        // full offer/answer cycle can take tens of seconds, so giving up after
        // a few tries left edges at 'new' forever.
        if (!pc._polite) {
            var _watchDelay = 5000;
            (function watchPeer() {
                setTimeout(function () {
                    if (!S.connected || S.peers[uid] !== pc || pc.signalingState === 'closed') return;
                    if (pc.connectionState === 'connected') return;
                    var stillStuck = pc.connectionState === 'connecting' || pc.connectionState === 'new';
                    if (stillStuck) {
                        // A peer stuck in 'have-local-offer' sent an offer whose
                        // answer was lost — it will NEVER return to 'stable' on
                        // its own, so a bare onnegotiationneeded() nudge is a
                        // no-op (the guard queues it). Roll the local offer back
                        // first so the renegotiation can actually run.
                        if (pc.signalingState === 'have-local-offer') {
                            try {
                                pc.setLocalDescription({ type: 'rollback' }).then(function () {
                                    try { pc.onnegotiationneeded(); } catch (_) {}
                                }).catch(function () {
                                    try { pc.onnegotiationneeded(); } catch (_) {}
                                });
                            } catch (_) {
                                try { pc.onnegotiationneeded(); } catch (_) {}
                            }
                        } else {
                            try { pc.restartIce(); } catch (_) {}
                            try { pc.onnegotiationneeded(); } catch (_) {}
                        }
                        _watchDelay = Math.min(_watchDelay * 1.6, 20000); // 5s → 8s → 13s → 20s (cap)
                        watchPeer();
                    }
                }, _watchDelay);
            })();
        }
        // ICE candidates that arrive BEFORE the remote description is set are
        // buffered here — calling addIceCandidate early throws InvalidStateError
        // and the old code swallowed it, silently dropping candidates. In a
        // large mesh (late joiners negotiating N peers at once on a loaded main
        // thread) the offer->answer window stretches, so this race dropped
        // enough candidates to leave peers stuck at 'checking' forever.
        pc._pendingIce = [];
        pc._negotiating = false;
        pc._makingOffer = false;
        // Video-negotiation watchdog: when a local video track (camera/screen)
        // is added, a glare/rollback race can swallow the renegotiation that
        // carries the video m-line. The sender then encodes ZERO frames — the
        // other side gets a black/absent tile until the user leaves and
        // rejoins ("sometimes I need to rejoin to see the camera"). Watch the
        // encoder: if a live video sender has produced no frames for two
        // consecutive checks (~8s), force the m-line back into the SDP by
        // renegotiating (rolling back a stale offer first if needed).
        pc._videoWatchCount = 0;
        // Consecutive zero-frame checks (at the 4s interval) that trigger a
        // renegotiation — derived from the configurable videoWatchdogSecs
        // setting (Settings → Voice → Video Quality). 0 = watchdog off.
        pc._videoWatchThreshold = watchdogCheckThreshold();
        // Cooldown: minimum ms between watchdog fires to prevent a vicious
        // cycle where the renegotiation itself causes another stall.
        pc._videoWatchLastFire = 0;
        var _watchCooldownMs = 30000; // 30s minimum between fires
        pc._videoWatchTimer = setInterval(function () {
            if (!S.connected || S.peers[uid] !== pc || pc.signalingState === 'closed') {
                clearInterval(pc._videoWatchTimer);
                return;
            }
            // Skip the check when the tab is in the background. Chrome
            // throttles setTimeout/setInterval to 1Hz in background tabs,
            // so getStats() returns stale data and the watchdog would see
            // false stalls — triggering needless renegotiations that disrupt
            // the relay pipeline (the root cause of the "reconnecting media"
            // cycle when two tabs are open on the same device).
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
                pc._videoWatchCount = 0;
                return;
            }
            var vids;
            try {
                vids = pc.getSenders().filter(function (s) { return s.track && s.track.kind === 'video' && s.track.readyState === 'live'; });
            } catch (_) {
                return;
            }
            var liveVids = vids.length;
            // Quick exit: if there are no live video senders AND no live
            // video/audio receivers, there is nothing to check. This avoids
            // firing the watchdog for pure-audio-relay peers where WebRTC
            // carries no media at all — the renegotiation would only disrupt
            // the WebSocket relay pipeline for no benefit.
            var liveVideoRecvs = 0;
            var liveAudioRecvs = 0;
            try {
                liveVideoRecvs = pc.getReceivers().filter(function (r) { return r.track && r.track.readyState === 'live' && r.track.kind === 'video'; }).length;
                var memberMuted = S.members && S.members[uid] && (S.members[uid].muted || S.members[uid].force_muted);
                liveAudioRecvs = pc.getReceivers().filter(function (r) { return r.track && r.track.readyState === 'live' && r.track.kind === 'audio' && !S.deafened && !memberMuted; }).length;
            } catch (_) {}
            if (liveVids === 0 && liveVideoRecvs === 0 && liveAudioRecvs === 0) {
                // Nothing to check — reset count so we don't accumulate
                // stale stall signals from a previous media configuration.
                pc._videoWatchCount = 0;
                return;
            }
            pc.getStats().then(function (stats) {
                if (!S.connected || S.peers[uid] !== pc) return;
                // Per-sender check: EVERY live video sender must be encoding.
                var encodedVids = 0;
                try {
                    stats.forEach(function (r) {
                        if (r.type === 'outbound-rtp' && (r.kind === 'video' || r.mediaType === 'video') && (r.framesEncoded || 0) > 0) {
                            encodedVids++;
                        }
                    });
                } catch (_) {}
                var anyStuck = encodedVids < liveVids;
                // NOTE: no reset here — the shared counter below handles both
                // sender and receiver stuck signals together. (A reset here
                // would zero the count every tick whenever the senders look
                // fine, so a stuck RECEIVER could never accumulate to the
                // threshold.)
                // ---- RECEIVER-side check (the user's "black no matter what"):
                // the SENDER-side watchdog above catches a sender that stopped
                // ENCODING, but a black feed can also be a receiver that gets
                // 0 packets / 0 decoded frames while the sender encodes fine
                // (a held send-gate that never got the Load state, a lost
                // renegotiation, or a missing/never-invoked decrypt transform).
                // Watch every LIVE remote feed this side is EXPECTING (loaded
                // and not deafened): if it decodes nothing for the threshold,
                // heal it — re-apply E2EE transforms and renegotiate, which
                // re-fires ontrack and re-syncs the sender's gate with our
                // current load state.
                var recvStuck = false;
                try {
                    var expectedFeeds = 0;
                    ['camera', 'screen'].forEach(function (kind) {
                        if (isFeedLoaded(uid, kind)) expectedFeeds++;
                    });
                    var liveRecvs = pc.getReceivers().filter(function (r) {
                        return r.track && r.track.readyState === 'live' && r.track.kind === 'video';
                    });
                    var memberMuted2 = S.members && S.members[uid] && (S.members[uid].muted || S.members[uid].force_muted);
                    var audioRecvs = pc.getReceivers().filter(function (r) {
                        return r.track && r.track.readyState === 'live' && r.track.kind === 'audio' && !S.deafened && !memberMuted2;
                    });
                    if ((expectedFeeds > 0 && liveRecvs.length) || audioRecvs.length) {
                        // Per-receiver progress tracking: each receiver gets
                        // its OWN packet/frame counters (matched by ssrc via
                        // the track-to-ssrc mapping in getStats).  The old
                        // approach used aggregate totals, so if ONE receiver
                        // advanced its packets, ALL receivers looked healthy.
                        var perRx = {}; // trackId -> { pkts, decoded, stalled, seen }
                        try {
                            // Build a map: track.id -> ssrc by iterating
                            // inbound-rtp stats and matching to receivers.
                            var ssrcMap = {}; // ssrc -> { pkts, decoded, kind }
                            stats.forEach(function (r) {
                                if (r.type !== 'inbound-rtp') return;
                                if (r.ssrc) {
                                    ssrcMap[r.ssrc] = {
                                        pkts: r.packetsReceived || 0,
                                        decoded: r.framesDecoded || 0,
                                        kind: r.kind || r.mediaType || '',
                                    };
                                }
                            });
                            liveRecvs.concat(audioRecvs).forEach(function (r) {
                                if (!r.track || !r.track.id) return;
                                var tid = r.track.id;
                                // Try to find the ssrc for this receiver
                                // via getStats() stat objects that reference
                                // the track. Chrome exposes stats per ssrc.
                                var bestPkts = 0, bestDecoded = 0;
                                try {
                                    stats.forEach(function (s) {
                                        if (s.type !== 'inbound-rtp') return;
                                        var k = s.kind || s.mediaType || '';
                                        var isVideo = r.track.kind === 'video';
                                        if ((isVideo && k !== 'video') || (!isVideo && k !== 'audio')) return;
                                        // Use the highest packet count we find
                                        // for this kind — the browser may report
                                        // one inbound-rtp per ssrc.
                                        if ((s.packetsReceived || 0) > bestPkts) {
                                            bestPkts = s.packetsReceived || 0;
                                            bestDecoded = s.framesDecoded || 0;
                                        }
                                    });
                                } catch (_) {}
                                perRx[tid] = { pkts: bestPkts, decoded: bestDecoded, stalled: 0, seen: 1 };
                            });
                        } catch (_) {}
                        // Compare against previous check's snapshot
                        if (!pc._recvProgress) pc._recvProgress = {};
                        var anyStalled = false;
                        Object.keys(perRx).forEach(function (tid) {
                            var now = perRx[tid];
                            var prev = pc._recvProgress[tid];
                            if (!prev) {
                                // First sighting: baseline, don't flag.
                                pc._recvProgress[tid] = now;
                                return;
                            }
                            now.seen = (prev.seen || 0) + 1;
                            var advanced = now.pkts > prev.pkts || now.decoded > prev.decoded;
                            if (advanced) {
                                now.stalled = 0;
                            } else {
                                now.stalled = (prev.stalled || 0) + 1;
                                if (now.stalled > 0 && now.seen > 1) anyStalled = true;
                            }
                            perRx[tid] = now;
                        });
                        // Prune stale entries
                        try {
                            Object.keys(pc._recvProgress).forEach(function (k) {
                                if (!(k in perRx)) delete pc._recvProgress[k];
                            });
                        } catch (_) {}
                        pc._recvProgress = perRx;
                        if ((expectedFeeds > 0 && liveRecvs.length > 0) || audioRecvs.length > 0) {
                            if (anyStalled) recvStuck = true;
                        }
                    }
                } catch (_) {}
                // Debug snapshot for the diagnostics panel + tests: exposes
                // exactly what the watchdog computed this check.
                try {
                    pc.__lastWatch = {
                        ts: Date.now(),
                        sig: pc.signalingState,
                        liveVids: liveVids,
                        encodedVids: encodedVids,
                        anyStuck: anyStuck,
                        recvStuck: recvStuck,
                        count: pc._videoWatchCount || 0,
                        threshold: pc._videoWatchThreshold,
                        cooldownMs: _watchCooldownMs,
                        timeSinceLastFire: Date.now() - (pc._videoWatchLastFire || 0),
                    };
                } catch (_) {}
                if (!anyStuck && !recvStuck) {
                    pc._videoWatchCount = 0;
                    return;
                }
                if (!pc._videoWatchThreshold) {
                    return;
                }
                pc._videoWatchCount = (pc._videoWatchCount || 0) + 1;
                if (pc._videoWatchCount >= pc._videoWatchThreshold) {
                    pc._videoWatchCount = 0;
                    // Don't fire if a renegotiation is already in flight.
                    if (pc.signalingState !== 'stable') {
                        return;
                    }
                    // Don't fire if we fired recently — the renegotiation
                    // itself can cause a brief stall that would re-trigger.
                    var _now = Date.now();
                    if (pc._videoWatchLastFire && (_now - pc._videoWatchLastFire) < _watchCooldownMs) {
                        return;
                    }
                    pc._videoWatchLastFire = _now;
                    try { healE2eeInPlace(); } catch (_) {}
                    showVideoReconnect(recvStuck && !anyStuck ? 'audio-or-video' : (recvStuck ? 'audio-or-video' : 'video'));
                    try { pc.onnegotiationneeded(); } catch (_) {}
                    try { sendVoiceState(); } catch (_) {}
                }
            }).catch(function () {});
        }, 4000);
        // Perfect negotiation (glare) roles: in a mesh BOTH sides create a peer
        // for the same edge and both fire onnegotiationneeded at once. If both
        // send offers and both roll back (naive rollback), each side ends up
        // answering the OTHER's offer — two different SDP pairs, mismatched
        // DTLS fingerprints → ICE stuck at 'checking' forever (exactly what the
        // last joiners showed in the 10-user mesh). The fix: ONE side owns the
        // offer per edge, chosen deterministically by user id (the "impolite"
        // side, lower id, offers; the "polite" side, higher id, only answers).
        // This mirrors the JSEP perfect-negotiation spec.
        var selfIdForRole = getSelfId();
        pc._polite = selfIdForRole > uid;
        pc.ontrack = function (e) {
            handleRemoteTrack(uid, e);
        };
        pc.onnegotiationneeded = function () {
            // Perfect negotiation: BOTH sides may initiate (that's required for
            // ICE-restart recovery — a polite side whose ICE failed must be able
            // to renegotiate). The polite/impolite roles only decide who yields
            // on GLARE (receiving an offer while holding a local offer), which
            // is handled in handleSignal, not here.
            // Perfect-negotiation guard: onnegotiationneeded can fire many times
            // in a burst (one per added track, plus sender.transform assignment
            // from applySendE2EE). A concurrent createOffer() while a negotiation
            // is already in flight rejects with InvalidStateError, which the old
            // code swallowed — leaving peers at 'new' forever in big meshes.
            // If we're mid-negotiation, re-run once the current one settles.
            if (pc._negotiating || pc._makingOffer || pc.signalingState !== 'stable') {
                pc._negotiationQueued = true;
                return;
            }
            pc._negotiating = true;
            // _makingOffer is set SYNCHRONOUSLY (before createOffer resolves) so
            // the glare check in handleSignal sees it even while signalingState
            // is still 'stable' — otherwise a polite side could answer the
            // remote's offer while its own offer is in flight, and the two
            // sides would converge on different SDP pairs (DTLS mismatch).
            pc._makingOffer = true;
            pc._negotiationQueued = false;
            pc.createOffer().then(function (offer) {
                offer.sdp = mungeSdp(offer.sdp);
                return pc.setLocalDescription(offer);
            }).then(function () {
                send({
                    type: 'voice_signal',
                    room_type: S.roomType,
                    channel_id: S.channelId || '',
                    dm_channel_id: S.dmChannelId || '',
                    to_user_id: uid,
                    signal: { type: 'offer', sdp: pc.localDescription.sdp },
                });
                tuneVideoSenders(pc);
            }).catch(function (err) {
                console.warn('Offer failed:', err);
            }).finally(function () {
                pc._negotiating = false;
                pc._makingOffer = false;
                // If a burst of track additions happened while we were busy,
                // renegotiate once to pick up anything that was missed.
                if (pc._negotiationQueued && pc.signalingState === 'stable') {
                    pc.onnegotiationneeded();
                }
            });
        };
        // Stuck-peer safety net: if the impolite side's offer was lost (no
        // remote description after 4s), re-fire the negotiation so the edge
        // recovers instead of sitting at 'new' forever.
        if (!pc._polite) {
            setTimeout(function () {
                if (S.connected && S.peers[uid] === pc && !pc.remoteDescription && pc.connectionState === 'new' && pc.signalingState !== 'closed') {
                    try { pc.onnegotiationneeded(); } catch (_) {}
                }
            }, 4000);
        }

        S.peers[uid] = pc;
        addLocalTracks(pc);
        applySendE2EE(pc);
        // Per-receiver send gating: hold feeds this receiver isn't watching
        // (manual load / unloaded) and audio a deafened receiver can't hear.
        // Feed gating FIRST so tuneVideoSenders only sizes ungated senders.
        tuneFeedSenders(pc, uid);
        tuneAudioSenders(pc, uid);
        tuneVideoSenders(pc, uid);
        return pc;
    }

    function addLocalTracks(pc) {
        ensureE2eeWorker();
        // NOTE: MediaStream.id is read-only, so we never tag streams with
        // 'camera-'/'screen-' — the receiver classifies by member flags + fill
        // order instead (see handleRemoteTrack). Only the stream object matters
        // here; addTrack associates the track with it for the msid.
        // A sender may hold a track via _voiceNulled (send gating held it with
        // replaceTrack(null)) — such a sender is still OCCUPIED, so the guards
        // below must count it or a gated feed would be re-added as a second
        // sender (mic/camera restart, RNS pipeline finishing) and the receiver
        // would get a duplicate m-line the gating never covers.
        function senderOccupied(s, track) {
            return (s.track && s.track.id === track.id) || (s._voiceNulled && s._voiceNulled.id === track.id);
        }
        // Optimization 3: Set high network priority on senders so voice/audio
        // streams get bandwidth first when the network is congested.
        // Also apply per-sender audio bitrate based on send quality setting.
        function setSenderPriority(track) {
            try {
                var sender = pc.getSenders().find(function (s) { return s.track === track; });
                if (sender && sender.getParameters) {
                    sender.getParameters().then(function (params) {
                        if (params.encodings && params.encodings[0]) {
                            params.encodings[0].networkPriority = 'high';
                            // Apply audio bitrate based on send quality
                            if (track.kind === 'audio') {
                                var sq = (S.settings && S.settings.sendAudioQuality) || 'medium';
                                var audioBitrate = { low: 16000, medium: 32000, high: 64000, ultra: 128000 }[sq] || 32000;
                                params.encodings[0].maxBitrate = audioBitrate;
                            }
                            sender.setParameters(params);
                        }
                    }).catch(function () {});
                }
            } catch (_) {}
        }
        // When mic audio is being server-relayed it must NOT also be added to
        // the WebRTC peers — a peer created after the switch (new joiner)
        // would otherwise receive BOTH the relay copy and a live mesh track.
        if (S.localStreams.mic && !S.muted && !S.deafened && !_audioRelayTimer) {
            // Prefer the RNNoise-processed track when active; otherwise the
            // raw mic track.
            var at = (S.localStreams.processedMic && S.localStreams.processedMic.getAudioTracks()[0]) || S.localStreams.mic.getAudioTracks()[0];
            if (at && !pc.getSenders().find(function (s) { return (s.track && s.track.kind === 'audio') || (s._voiceNulled && s._voiceNulled.kind === 'audio'); })) {
                pc.addTrack(at, new MediaStream([at]));
                setSenderPriority(at);
            }
        }
        if (S.localStreams.camera && S.cameraOn) {
            if (!useVideoRelay('camera')) {
                var vt = S.localStreams.camera.getVideoTracks()[0];
                if (vt && !pc.getSenders().find(function (s) { return senderOccupied(s, vt); })) {
                    pc.addTrack(vt, new MediaStream([vt]));
                    setSenderPriority(vt);
                }
            }
        }
        if (S.localStreams.screen && S.screenOn) {
            if (!useVideoRelay('screen')) {
                var st = S.localStreams.screen.getVideoTracks()[0];
                if (st && !pc.getSenders().find(function (s) { return senderOccupied(s, st); })) {
                    pc.addTrack(st, new MediaStream([st]));
                    setSenderPriority(st);
                }
            }
            // Screen-share audio (tab/system): sent as its own track so the
            // receiver can mix it separately from the mic (per-member screen
            // volume). The mic audio track is added FIRST, so the receiver
            // classifies audio tracks by fill order — mic, then screen.
            var sat = S.localStreams.screen.getAudioTracks()[0];
            if (sat && !_audioRelayTimer && !pc.getSenders().find(function (s) { return senderOccupied(s, sat); })) {
                pc.addTrack(sat, new MediaStream([sat]));
                setSenderPriority(sat);
            }
        }
    }

    function addLocalTracksToAllPeers() {
        for (var uid in S.peers) {
            addLocalTracks(S.peers[uid]);
            applySendE2EE(S.peers[uid]);
            tuneFeedSenders(S.peers[uid], uid);
            tuneAudioSenders(S.peers[uid], uid);
            tuneVideoSenders(S.peers[uid], uid);
        }
    }

    // Cap video send bitrate so screen shares / cameras don't saturate the
    // mesh. Unbounded encoders at high resolution + fps generate far more
    // RTP than the connection can carry → packet loss → decoder artifacts.
    // The cap now follows the EFFECTIVE resolution (Settings → Voice → Video
    // Quality): each sender is scaled down to what THIS receiver asked for
    // (recv res broadcast in voice_state) and given a matching bitrate, so a
    // 1080p screen at the old flat 5 Mbps no longer outruns the pipe.
    // 'balanced' lets the encoder drop resolution gracefully under congestion
    // instead of quantizing the full frame into artifacts, and contentHint
    // tells the encoder the screen content is detail-heavy (text).
    function tuneVideoSenders(pc, uid) {
        if (!pc || !pc.getSenders) return;
        if (!uid) {
            for (var k in S.peers) {
                if (S.peers[k] === pc) { uid = k; break; }
            }
        }
        try {
            pc.getSenders().forEach(function (s) {
                if (!s.track || s.track.kind !== 'video') return;
                var isScreen = S.localStreams.screen && S.localStreams.screen.getVideoTracks().indexOf(s.track) !== -1;
                var baseH = isScreen ? (S.settings.sendScreenRes || 480) : (S.settings.sendCameraRes || 360);
                // What THIS receiver wants (their broadcast recv res; fall back
                // to our own receive default when they haven't declared it).
                var member = uid ? S.members[uid] : null;
                var declared = member ? (isScreen ? member.recv_screen_res : member.recv_camera_res) : 0;
                var wantH = declared > 0 ? declared : (isScreen ? (S.settings.recvScreenRes || 480) : (S.settings.recvCameraRes || 360));
                var scale = Math.max(1, baseH / Math.max(1, wantH));
                var effH = Math.round(baseH / scale);
                var maxBitrate = bitrateForRes(effH, isScreen);
                try {
                    var params = s.getParameters();
                    if (!params.encodings || params.encodings.length === 0) return;
                    params.encodings.forEach(function (enc) {
                        enc.maxBitrate = maxBitrate;
                        enc.maxFramerate = 30;
                        // scaleResolutionDownBy is per-encoding, so each peer
                        // gets its own resolution in the mesh ("what I send to
                        // that person"). Scale DOWN only — never upscale.
                        enc.scaleResolutionDownBy = scale;
                    });
                    params.degradationPreference = 'balanced';
                    s.setParameters(params).catch(function () {});
                } catch (_) {}
            });
        } catch (_) {}
    }

    function removeTrackFromAllPeers(kind) {
        for (var uid in S.peers) {
            var pc = S.peers[uid];
            var senders = pc.getSenders().filter(function (s) {
                // A sender may hold its track in _voiceNulled (send gating) —
                // it must be removed too, or a gated sender would survive a
                // mic restart with a dead held track.
                var held = s.track || s._voiceNulled;
                if (!held) return false;
                if (kind === 'audio') {
                    // Mic audio only — muting must NOT kill the screen-share
                    // audio (that is removed with kind 'screen' instead).
                    if (held.kind !== 'audio') return false;
                    if (S.localStreams.screen && S.localStreams.screen.getAudioTracks().indexOf(held) !== -1) return false;
                    return true;
                }
                // 'screen' removes BOTH the screen video track and its audio
                // track (the whole screen stream).
                if (kind === 'screen') return S.localStreams.screen && S.localStreams.screen.getTracks().indexOf(held) !== -1;
                return held.kind === 'video' && isTrackKind(held, kind);
            });
            senders.forEach(function (s) {
                s._voiceNulled = null;
                try { pc.removeTrack(s); } catch (_) {}
            });
            // Renegotiate
            if (pc.signalingState !== 'closed') {
                pc.onnegotiationneeded && pc.onnegotiationneeded();
            }
        }
    }

    function isTrackKind(track, kind) {
        // Camera/screen video tracks are distinguished by which local stream they came from
        if (kind === 'camera') return S.localStreams.camera && S.localStreams.camera.getVideoTracks().indexOf(track) !== -1;
        if (kind === 'screen') return S.localStreams.screen && S.localStreams.screen.getVideoTracks().indexOf(track) !== -1;
        return false;
    }

    // Does the receiver (member's broadcast state) want THIS sender's feed?
    // The receiver's loaded/unloaded lists are keyed by the SENDER's uid (who
    // is sending to them) — i.e. MY uid on this device. Manual-load ON: only
    // explicitly loaded feeds. Manual-load OFF: everything except explicitly
    // unloaded feeds. A missing member state (peer created before their
    // voice_state arrived) defaults to yes — never drop media by accident.
    function feedWanted(member, kind) {
        if (!member) return true;
        var key = getSelfId() + ':' + kind;
        if (member.manual_video_load) {
            return (member.loaded_feeds || []).indexOf(key) !== -1;
        }
        return (member.unloaded_feeds || []).indexOf(key) === -1;
    }

    // Per-peer video gating: hold a feed's RTP when the receiver isn't watching
    // it (manual load on + not loaded, or explicitly unloaded) instead of
    // encoding frames nobody renders. replaceTrack(null) keeps the m-line and
    // the E2EE transform in place — no renegotiation, and restoring the same
    // track object resumes instantly.
    function tuneFeedSenders(pc, uid) {
        if (!pc || !pc.getSenders) return;
        if (!uid) {
            for (var k in S.peers) {
                if (S.peers[k] === pc) { uid = k; break; }
            }
        }
        var member = S.members[uid];
        pc.getSenders().forEach(function (s) {
            // A gated sender has track === null but holds it in _voiceNulled —
            // it must be re-evaluated too or it can never be restored.
            var held = s.track || s._voiceNulled;
            if (!held || held.kind !== 'video') return;
            var kind = isTrackKind(held, 'camera') ? 'camera' : 'screen';
            applySenderGate(s, feedWanted(member, kind));
        });
    }

    // Per-peer AUDIO gating: a DEAFENED receiver can't hear anything, so stop
    // sending mic + screen-share audio to them (pure bitrate waste). A MUTED
    // receiver still hears, so they keep receiving.
    function tuneAudioSenders(pc, uid) {
        if (!pc || !pc.getSenders) return;
        if (!uid) {
            for (var k in S.peers) {
                if (S.peers[k] === pc) { uid = k; break; }
            }
        }
        var member = S.members[uid];
        var want = !(member && member.deafened);
        // Audio quality: use min(send, recv) like video resolution.
        var sendQ = (S.settings && S.settings.sendAudioQuality) || 'medium';
        var recvQ = (member && member.recv_audio_quality) || 'medium';
        var qOrder = { low: 0, medium: 1, high: 2, ultra: 3 };
        var effectiveQ = qOrder[sendQ] <= qOrder[recvQ] ? sendQ : recvQ;
        var audioBitrate = { low: 16000, medium: 32000, high: 64000, ultra: 128000 }[effectiveQ] || 32000;
        var screenAudioTrack = (S.localStreams.screen && S.localStreams.screen.getAudioTracks()[0]) || null;
        pc.getSenders().forEach(function (s) {
            var held = s.track || s._voiceNulled;
            if (!held || held.kind !== 'audio') return;
            var wantThis = want;
            if (screenAudioTrack && held.id === screenAudioTrack.id) {
                wantThis = want && feedWanted(member, 'screen');
            }
            applySenderGate(s, wantThis);
            // Apply min(send, recv) bitrate per-receiver
            try {
                var params = s.getParameters();
                if (params.encodings && params.encodings[0]) {
                    params.encodings[0].maxBitrate = audioBitrate;
                    params.encodings[0].networkPriority = 'high';
                    s.setParameters(params).catch(function () {});
                }
            } catch (_) {}
        });
    }

    // replaceTrack(null) ↔ restore. s._voiceNulled remembers the held track so
    // a later restore returns the SAME track object (media resumes with no new
    // negotiation). The restore prefers the CURRENT track for that role (the
    // mic may have been restarted with a new track while gated — e.g. the
    // RNNoise processed track arriving after the gate).
    function currentTrackFor(s) {
        var held = s._voiceNulled;
        if (!held) return null;
        if (held.kind === 'audio') {
            if (S.localStreams.screen && S.localStreams.screen.getAudioTracks().indexOf(held) !== -1) {
                return S.localStreams.screen.getAudioTracks()[0] || null;
            }
            if (S.localStreams.mic) {
                var processed = S.localStreams.processedMic && S.localStreams.processedMic.getAudioTracks()[0];
                return processed || S.localStreams.mic.getAudioTracks()[0] || null;
            }
            return null;
        }
        if (S.localStreams.camera && S.localStreams.camera.getVideoTracks().indexOf(held) !== -1) {
            return S.localStreams.camera.getVideoTracks()[0] || null;
        }
        if (S.localStreams.screen && S.localStreams.screen.getVideoTracks().indexOf(held) !== -1) {
            return S.localStreams.screen.getVideoTracks()[0] || null;
        }
        return null;
    }

    function applySenderGate(s, want) {
        if (want) {
            if (s._voiceNulled) {
                var fresh = currentTrackFor(s);
                if (!fresh) {
                    // The source stream is gone (mic stopped, screen off) —
                    // stay gated rather than restoring a dead track. The next
                    // gate evaluation (e.g. unmute after the mic restarts)
                    // restores it.
                    return;
                }
                s._voiceNulled = null;
                try { s.replaceTrack(fresh); } catch (_) {}
            }
        } else if (!s._voiceNulled) {
            s._voiceNulled = s.track;
            try { s.replaceTrack(null); } catch (_) {}
        }
    }

    function applySendE2EE(pc) {
        ensureE2eeWorker();
        if (!window.RTCRtpScriptTransform || !e2eeWorker || !S.roomKeyB64) return;
        try {
            pc.getSenders().forEach(function (s) {
                if (s.track) {
                    s.transform = new RTCRtpScriptTransform(e2eeWorker, { operation: 'encrypt', key: S.roomKeyB64 });
                }
            });
        } catch (_) {}
    }

    // Apply the E2EE decrypt transform to a receiver. Returns true on success.
    // If the room key isn't ready yet, the receiver is queued and the transform
    // is applied later by flushPendingRecvTransforms() once the key exists —
    // otherwise the sender encrypts while we can't decrypt → silence/garbage.
    function applyRecvE2EE(receiver) {
        ensureE2eeWorker();
        if (!window.RTCRtpScriptTransform || !e2eeWorker || !S.roomKeyB64) return false;
        try {
            // Never replace an existing transform mid-stream (see
            // reapplyAllE2EE): a receiver that already has one is decrypting
            // fine — reassigning would detach it and Chrome may not wire the
            // replacement, silently killing that direction (one-sided audio).
            if (receiver.transform) return true;
            receiver.transform = new RTCRtpScriptTransform(e2eeWorker, { operation: 'decrypt', key: S.roomKeyB64 });
            return true;
        } catch (_) {
            return false;
        }
    }

    // Heal ANY sender/receiver that lost its E2EE transform — track swaps,
    // renegotiation recreating receivers, transient apply failures (which only
    // queue, and the queue only flushes on key arrival — a failure after the
    // key was already set stayed ✗ forever). Re-applies encrypt to EVERY sender
    // (including gated/null-track ones: the transform survives replaceTrack,
    // so setting it while gated is harmless and ready for the restore) and
    // decrypt to every live receiver, then retries the pending queue. Called
    // after every negotiation settles so a black/raw feed heals itself within
    // one renegotiation.
    function reapplyAllE2EE(pc) {
        // Senders only, ADD where missing — never replace a working transform
        // and never touch receivers (receiver re-application after the
        // negotiation settles was the one-sided-audio regression). Receivers
        // get their decrypt transform once at ontrack; new receivers created
        // by renegotiation fire ontrack again and are covered there.
        ensureE2eeWorker();
        if (!window.RTCRtpScriptTransform || !e2eeWorker || !S.roomKeyB64) return;
        try {
            pc.getSenders().forEach(function (s) {
                try {
                    if (!s.transform) {
                        s.transform = new RTCRtpScriptTransform(e2eeWorker, { operation: 'encrypt', key: S.roomKeyB64 });
                    }
                } catch (_) {}
            });
        } catch (_) {}
        flushPendingRecvTransforms();
    }

    function queueRecvE2EE(receiver, trackId) {
        // Only queue when the transform API actually exists — otherwise (e.g.
        // Firefox, where E2EE is intentionally skipped) every ontrack would
        // enqueue an entry that can never flush (unbounded growth).
        if (!window.RTCRtpScriptTransform || !e2eeWorker) return;
        S._pendingRecvTransforms = S._pendingRecvTransforms || [];
        // Replace any prior entry for this track (a track's ontrack can fire
        // again on renegotiation) so the queue never accumulates dead entries.
        S._pendingRecvTransforms = S._pendingRecvTransforms.filter(function (p) { return p.trackId !== trackId; });
        S._pendingRecvTransforms.push({ receiver: receiver, trackId: trackId });
    }

    function flushPendingRecvTransforms() {
        if (!S._pendingRecvTransforms || !S._pendingRecvTransforms.length || !S.roomKeyB64) return;
        var remaining = [];
        S._pendingRecvTransforms.forEach(function (p) {
            if (!p || !p.receiver) return;
            if (!applyRecvE2EE(p.receiver)) remaining.push(p);
        });
        S._pendingRecvTransforms = remaining;
    }

    function handleRemoteTrack(uid, e) {
        if (e.track.kind === 'audio') {
            // E2EE on the receiver — if the key isn't ready yet, queue it and
            // apply once the key arrives (one-sided E2EE = permanent silence).
            ensureE2eeWorker();
            if (!applyRecvE2EE(e.receiver)) {
                queueRecvE2EE(e.receiver, e.track.id);
            }
            // Optimization 2: Hint the jitter buffer to target 20ms (default is 40-80ms).
            // This is a minimum target — NetEQ still adapts upward on bad networks.
            try {
                if (e.receiver && 'jitterBufferTarget' in e.receiver) {
                    e.receiver.jitterBufferTarget = 20;
                }
            } catch (_) {}
            S.remoteStreams[uid] = S.remoteStreams[uid] || {};
            var mic = S.remoteStreams[uid].audio;
            var scA = S.remoteStreams[uid].screenAudio;
            // Renegotiation (ICE restart, media add/remove) re-fires ontrack
            // with the SAME track object. Rebuilding the stream + refreshing
            // srcObject would RESTART the <audio> element playback → an
            // audible volume drop "for no reason". Keep playing if it's the
            // same track.
            if (mic && mic.getAudioTracks()[0] === e.track) return;
            if (scA && scA.getAudioTracks()[0] === e.track) return;
            // The sender adds the mic audio track FIRST, then the screen-share
            // audio track — so the first audio track is the mic and the
            // second is the screen's tab/system audio. If the old mic track
            // is already ended (mic restart), the new track replaces it.
            if (mic && mic.getAudioTracks()[0] && mic.getAudioTracks()[0].readyState === 'ended') {
                delete S.remoteStreams[uid].audio;
                mic = null;
            }
            var slot = mic ? 'screenAudio' : 'audio';
            S.remoteStreams[uid][slot] = new MediaStream([e.track]);
            if (slot === 'audio') {
                playRemoteAudio(uid);
            } else {
                // Respect the screen feed's load state — a share that is
                // unloaded (or held behind Load) must stay silent.
                applyScreenAudioGate(uid);
            }
            e.track.onended = function () {
                var st = S.remoteStreams[uid];
                if (st && st[slot] && st[slot].getAudioTracks()[0] === e.track) {
                    delete st[slot];
                    if (slot === 'screenAudio') removeRemoteScreenAudioEls(uid);
                }
                renderPopup();
                renderDmPanel();
            };
        } else if (e.track.kind === 'video') {
            S.remoteStreams[uid] = S.remoteStreams[uid] || {};
            // E2EE on the receiver — queue if the key isn't ready yet (see
            // applyRecvE2EE/flushPendingRecvTransforms). Applied for EVERY
            // video track (including parked/pending ones) — a missing decrypt
            // transform leaves the feed permanently black (encrypted frames
            // can't decode).
            ensureE2eeWorker();
            if (!applyRecvE2EE(e.receiver)) {
                queueRecvE2EE(e.receiver, e.track.id);
            }
            // MediaStream.id is read-only, so stream ids can never carry a
            // 'screen-' prefix — the sender's camStream.id/scrStream.id tagging
            // silently no-ops. e.streams is also often EMPTY for later
            // renegotiated tracks, so never rely on it for classification.
            //
            // Primary signal: the member's broadcast camera_track_id /
            // screen_track_id (the sender's track ids survive the SDP msid
            // round-trip, so they match exactly). If the state broadcast
            // hasn't arrived yet, park the track in a per-uid pending queue
            // instead of guessing — fixVideoSlots() drains it the moment the
            // ids arrive, so a screen share can never be mislabeled as a
            // camera feed ("sharescreen looks wrong" race).
            var key = classifyVideoSlot(uid, e.track.id);
            // Renegotiation re-fires ontrack with the SAME track object. If
            // it's already in its slot, leave everything alone — rebuilding the
            // panel would restart every <video> decoder → black flash on any
            // member's renegotiation.
            if (key) {
                var existingStream = S.remoteStreams[uid][key];
                if (existingStream && existingStream.getVideoTracks().some(function (t) { return t.id === e.track.id; })) {
                    return;
                }
                S.remoteStreams[uid][key] = new MediaStream([e.track]);
            } else {
                // Unknown ids yet — hold the track until the state arrives
                // (dedupe: renegotiation can re-fire before the ids arrive).
                S.remoteStreams[uid]._pending = S.remoteStreams[uid]._pending || [];
                if (!S.remoteStreams[uid]._pending.some(function (t) { return t.id === e.track.id; })) {
                    S.remoteStreams[uid]._pending.push(e.track);
                }
                return;
            }
            // Clear the slot (or the pending queue) when the remote stops
            // this track, so a stale stream doesn't linger on the tile.
            e.track.onended = function () {
                var rs2 = S.remoteStreams[uid];
                if (!rs2) return;
                if (rs2._pending) {
                    rs2._pending = rs2._pending.filter(function (t) { return t !== e.track; });
                    if (!rs2._pending.length) delete rs2._pending;
                }
                if (key && rs2[key] && rs2[key].getTracks().indexOf(e.track) !== -1) {
                    delete rs2[key];
                    clearFeedLoaded(uid, key);
                    renderPopup();
                    renderDmPanel();
                }
            };
            if (key) renderRemoteTile(uid, key);
            renderPopup();
            renderDmPanel();
        }
    }

    // Classify an incoming remote video track as 'camera' | 'screen' | null.
    // Exact match against the member's broadcast track ids wins; flag-only
    // fallbacks are used when the ids aren't known yet, and null means "hold
    // the track until the ids arrive" (the pending queue).
    function classifyVideoSlot(uid, trackId) {
        var m = S.members[uid] || {};
        if (m.camera_track_id && trackId === m.camera_track_id) return 'camera';
        if (m.screen_track_id && trackId === m.screen_track_id) return 'screen';
        // No ids (member state not arrived, or sender predates track-id
        // signaling). Fall back to the broadcast flags, then to the fill
        // order the sender uses (camera added before screen).
        if (m.screen && !m.camera) return 'screen';
        if (m.camera && !m.screen) return 'camera';
        if (!m.camera && !m.screen) return null;
        var existing = S.remoteStreams[uid];
        var camLive = existing && existing.camera && existing.camera.getVideoTracks()[0] &&
            existing.camera.getVideoTracks()[0].readyState !== 'ended';
        return camLive ? 'screen' : 'camera';
    }

    // Re-slot remote video streams once a member's track ids arrive: drain the
    // pending queue and move any track that landed in the wrong slot (the
    // pre-id fill-order fallback) to where it belongs. Never clobbers a live
    // stream that is already in the correct slot.
    function fixVideoSlots(uid) {
        var m = S.members[uid];
        var rs = S.remoteStreams[uid];
        if (!m || !rs) return;
        var camId = m.camera_track_id || null;
        var scrId = m.screen_track_id || null;
        var changed = false;
        // 1. Drain pending tracks now that the ids are known.
        if (rs._pending && rs._pending.length) {
            rs._pending = rs._pending.filter(function (t) {
                var where = null;
                if (camId && t.id === camId) where = 'camera';
                else if (scrId && t.id === scrId) where = 'screen';
                if (where) {
                    rs[where] = new MediaStream([t]);
                    changed = true;
                    return false;
                }
                return true;
            });
            if (!rs._pending.length) delete rs._pending;
        }
        if (!camId && !scrId) {
            if (changed) { renderPopup(); renderDmPanel(); }
            return;
        }
        // 2. Move tracks that sit in the wrong slot (swapped, or the
        // only-screen-in-camera-slot race).
        var camStream = rs.camera || null;
        var scrStream = rs.screen || null;
        var inCam = function (id) { return !!(id && camStream && camStream.getVideoTracks().some(function (t) { return t.id === id; })); };
        var inScr = function (id) { return !!(id && scrStream && scrStream.getVideoTracks().some(function (t) { return t.id === id; })); };
        var cInCam = inCam(camId), cInScr = inScr(camId);
        var sInCam = inCam(scrId), sInScr = inScr(scrId);
        if ((!camId || cInCam) && (!scrId || sInScr)) {
            if (changed) { renderPopup(); renderDmPanel(); }
            return;
        }
        if (cInScr && sInCam) {
            // Both present but swapped.
            rs.camera = scrStream;
            rs.screen = camStream;
            changed = true;
        } else if (cInScr && !sInCam) {
            // Camera track landed in the screen slot.
            rs.camera = scrStream;
            rs.screen = null;
            changed = true;
        } else if (sInCam && !cInScr) {
            // Screen track landed in the camera slot (only-screen race).
            rs.screen = camStream;
            rs.camera = null;
            changed = true;
        }
        if (changed) {
            renderPopup();
            renderDmPanel();
        }
    }

    // ------------------------------------------------------------------
    // Remote audio playback — per-member <audio> elements.
    //
    // IMPORTANT (2026-08-05, root cause of "no audio"): remote audio MUST NOT
    // be routed through the AudioContext node chain (source -> gain ->
    // masterGain -> destination). Empirically that topology stalls Chrome's
    // WebRTC audio decoder (the jitter buffer never drains — 0 samples
    // decoded, while packets flow) on this machine, whereas an <audio>
    // element sink decodes reliably (validated in repeated vanilla runs,
    // with AND without E2EE). element.volume is capped at 1.0, so member
    // volumes above 100% are reached by stacking extra <audio> elements
    // (each contributes up to 1.0 of gain).
    // ------------------------------------------------------------------
    function remoteVolumeFor(uid) {
        var saved = parseFloat(localStorage.getItem('voice_volume_' + uid) || '100');
        var member = isNaN(saved) ? 1 : saved / 100;
        return member * (S.settings.speakerVolume / 100) * (S.deafened ? 0 : 1);
    }

    function removeRemoteAudioEls(uid) {
        var els = S.remoteAudioEls[uid];
        if (els) {
            els.forEach(function (el) {
                try { el.pause(); } catch (_) {}
                try { el.srcObject = null; } catch (_) {}
                try { el.remove(); } catch (_) {}
            });
        }
        delete S.remoteAudioEls[uid];
        cleanupMemberGain(uid);
    }

    function applyRemoteVolume(uid) {
        var els = S.remoteAudioEls[uid];
        if (!els) return;
        // Round to 2 decimals so ceil() never mints a negligible extra
        // element for volumes like 2.0000001. Cap at 1000 (100000%) — the
        // per-member volume menu allows up to 100000% for boosting quiet
        // users via the custom % input.
        var vol = Math.max(0, Math.min(1000, Math.round(remoteVolumeFor(uid) * 100) / 100));
        var need = Math.max(1, Math.ceil(vol));
        var stream = S.remoteStreams[uid] && S.remoteStreams[uid].audio;
        while (els.length < need) {
            var el = document.createElement('audio');
            el.autoplay = true;
            el.muted = false;
            el.style.display = 'none';
            if (stream) el.srcObject = stream;
            el.play().catch(function () {});
            // DEBUG (one-sided audio): log starvation events on this element so
            // we can correlate decoder underruns with the concealment pattern.
            try {
                if (window.__enableVoiceAudioDebug && window.__voiceAudioElEvents) {
                    ['waiting', 'stalled', 'playing', 'emptied'].forEach(function (evName) {
                        el.addEventListener(evName, function () {
                            window.__voiceAudioElEvents.push({ t: Date.now(), ev: evName, uid: uid.slice(0, 6) });
                        });
                    });
                }
            } catch (_) {}
            document.body.appendChild(el);
            els.push(el);
        }
        while (els.length > need) {
            var old = els.pop();
            try { old.pause(); } catch (_) {}
            try { old.remove(); } catch (_) {}
        }
        els.forEach(function (el, i) {
            el.volume = Math.max(0, Math.min(1, vol - i));
        });
        // Also update relay audio gain node
        if (_relayGainNodes[uid]) {
            _relayGainNodes[uid].gain.value = Math.max(0, Math.min(2, vol));
        }
    }

    function playRemoteAudio(uid) {
        if (!S.remoteStreams[uid] || !S.remoteStreams[uid].audio) return;
        try {
            var stream = S.remoteStreams[uid].audio;
            var els = S.remoteAudioEls[uid];
            if (!els) {
                removeRemoteAudioEls(uid);
                S.remoteAudioEls[uid] = [];
                els = S.remoteAudioEls[uid];
            }
            // Refresh srcObject IN PLACE only when the track actually changed
            // (renegotiation re-fires ontrack with the same track) — setting a
            // new srcObject restarts element playback and causes a volume dip.
            var track = stream.getAudioTracks()[0];
            if (!track) return;
            els.forEach(function (el) {
                var cur = null;
                try { cur = el.srcObject; } catch (_) {}
                var curTrack = cur && cur.getAudioTracks ? cur.getAudioTracks()[0] : null;
                if (curTrack !== track) {
                    try { el.srcObject = stream; } catch (_) {}
                }
            });
            applyRemoteVolume(uid);
        } catch (_) {}
    }

    // Autoplay safety net: elements are created at ontrack (outside a user
    // gesture), so a strict autoplay policy can block the initial play().
    // Retry every paused element on the next real user gesture.
    function retryRemoteAudioPlay() {
        Object.keys(S.remoteAudioEls).forEach(function (uid) {
            (S.remoteAudioEls[uid] || []).forEach(function (el) {
                if (el.paused && el.srcObject) {
                    try { el.play().catch(function () {}); } catch (_) {}
                }
            });
        });
    }
    document.addEventListener('click', retryRemoteAudioPlay, true);
    document.addEventListener('keydown', retryRemoteAudioPlay, true);

    // ------------------------------------------------------------------
    // Audio-element health sweep: the decoder watchdog heals a STALLED
    // decoder (0 frames decoded), but "audio got messed up / silent until I
    // rejoin" can also be the OUTPUT path — an <audio> element that is
    // paused (autoplay blocked, play() raced a srcObject swap) or stuck in
    // HAVE_NOTHING (the srcObject swap happened while the element was
    // loading). Rejoin fixes it only because the whole graph is rebuilt, so
    // re-create the same effect in place: re-attach the live stream to a
    // stuck element (which restarts playback from the live decoder, not the
    // beginning) and re-run play(). Runs every 2s while connected.
    function audioElementHealthSweep() {
        if (!S.connected) return;
        Object.keys(S.remoteAudioEls).forEach(function (uid) {
            var stream = S.remoteStreams[uid] && S.remoteStreams[uid].audio;
            (S.remoteAudioEls[uid] || []).forEach(function (el) {
                try {
                    if (el.srcObject && stream) {
                        if (el.paused) {
                            el.play().catch(function () {});
                        } else if (el.readyState === 0 /* HAVE_NOTHING */) {
                            // Element never got data — re-attach the live
                            // stream to kick the decoder pipeline.
                            el.srcObject = null;
                            el.srcObject = stream;
                            el.play().catch(function () {});
                        }
                    }
                } catch (_) {}
            });
        });
    }
    setInterval(audioElementHealthSweep, 2000);

    function setMemberVolume(uid, pct) {
        try { localStorage.setItem('voice_volume_' + uid, String(pct)); } catch (_) {}
        if (S.remoteAudioEls[uid]) applyRemoteVolume(uid);
        var label = document.getElementById('volume-menu-value');
        if (label) label.textContent = pct + '%';
    }

    // ------------------------------------------------------------------
    // Screen-share audio playback — a SEPARATE per-member volume from the
    // mic, stored under voice_screen_volume_<uid> and applied to its own
    // stacked <audio> elements (same >100% stacking as the mic). Right-click
    // a member's screen tile to adjust it (0–500% slider, custom % to
    // 100000%).
    // ------------------------------------------------------------------
    function remoteScreenVolumeFor(uid) {
        var saved = parseFloat(localStorage.getItem('voice_screen_volume_' + uid) || '100');
        var member = isNaN(saved) ? 1 : saved / 100;
        return member * (S.settings.speakerVolume / 100) * (S.deafened ? 0 : 1);
    }

    function removeRemoteScreenAudioEls(uid) {
        var els = S.remoteScreenAudioEls[uid];
        if (els) {
            els.forEach(function (el) {
                try { el.pause(); } catch (_) {}
                try { el.srcObject = null; } catch (_) {}
                try { el.remove(); } catch (_) {}
            });
        }
        delete S.remoteScreenAudioEls[uid];
    }

    function applyRemoteScreenVolume(uid) {
        var els = S.remoteScreenAudioEls[uid];
        if (!els) return;
        var vol = Math.max(0, Math.min(1000, Math.round(remoteScreenVolumeFor(uid) * 100) / 100));
        var need = Math.max(1, Math.ceil(vol));
        var stream = S.remoteStreams[uid] && S.remoteStreams[uid].screenAudio;
        while (els.length < need) {
            var el2 = document.createElement('audio');
            el2.autoplay = true;
            el2.muted = false;
            el2.style.display = 'none';
            if (stream) el2.srcObject = stream;
            el2.play().catch(function () {});
            document.body.appendChild(el2);
            els.push(el2);
        }
        while (els.length > need) {
            var old = els.pop();
            try { old.pause(); } catch (_) {}
            try { old.remove(); } catch (_) {}
        }
        els.forEach(function (el, i) {
            el.volume = Math.max(0, Math.min(1, vol - i));
        });
    }

    function playRemoteScreenAudio(uid) {
        if (!S.remoteStreams[uid] || !S.remoteStreams[uid].screenAudio) return;
        try {
            var stream = S.remoteStreams[uid].screenAudio;
            var els = S.remoteScreenAudioEls[uid];
            if (!els) {
                removeRemoteScreenAudioEls(uid);
                S.remoteScreenAudioEls[uid] = [];
                els = S.remoteScreenAudioEls[uid];
            }
            var track = stream.getAudioTracks()[0];
            if (!track) return;
            els.forEach(function (el) {
                var cur = null;
                try { cur = el.srcObject; } catch (_) {}
                var curTrack = cur && cur.getAudioTracks ? cur.getAudioTracks()[0] : null;
                if (curTrack !== track) {
                    try { el.srcObject = stream; } catch (_) {}
                }
            });
            applyRemoteScreenVolume(uid);
        } catch (_) {}
    }

    // Screen-share audio is only audible while the screen feed is LOADED.
    // Unloading a share must silence its tab/system audio too on the receiver
    // (the sender side is gated separately in tuneAudioSenders). Reloading
    // resumes playback without any renegotiation.
    function applyScreenAudioGate(uid) {
        if (!uid) return;
        if (!isFeedLoaded(uid, 'screen')) {
            removeRemoteScreenAudioEls(uid);
            return;
        }
        if (S.remoteStreams[uid] && S.remoteStreams[uid].screenAudio) {
            playRemoteScreenAudio(uid);
        }
    }

    function setScreenVolume(uid, pct) {
        try { localStorage.setItem('voice_screen_volume_' + uid, String(pct)); } catch (_) {}
        if (S.remoteScreenAudioEls[uid]) applyRemoteScreenVolume(uid);
        var label = document.getElementById('volume-menu-value');
        if (label) label.textContent = pct + '%';
    }

    // Drain any candidates that arrived before the remote description existed.
    function flushPendingIce(pc) {
        var q = pc._pendingIce || [];
        pc._pendingIce = [];
        q.forEach(function (c) {
            pc.addIceCandidate(c).catch(function (_) {});
        });
    }

    // ------------------------------------------------------------------
    // Signaling handling
    // ------------------------------------------------------------------
    function handleSignal(fromUid, signal) {
        var pc = S.peers[fromUid];
        if (!pc) {
            // A peer we haven't created yet — create it (covers late-joining
            // members and DM callees who receive an offer before their own
            // voice_joined lands). BUT only once the room key exists: a peer
            // opened without it has no E2EE transform on either side, so the
            // media is undecryptable in both directions and the call is silent
            // until a manual rejoin. Until then the signaling is held.
            if (!S.roomKeyB64) {
                queuePendingSignal(fromUid, signal);
                return;
            }
            pc = createPeer(fromUid);
        }
        var sdp = signal.sdp;
        if (signal.type === 'offer') {
            var answerOffer = function () {
                pc.setRemoteDescription({ type: 'offer', sdp: sdp }).then(function () {
                    addLocalTracks(pc);
                    applySendE2EE(pc);
                    flushPendingIce(pc);
                    return pc.createAnswer();
                }).then(function (answer) {
                    answer.sdp = mungeSdp(answer.sdp);
                    return pc.setLocalDescription(answer);
                }).then(function () {
                    send({
                        type: 'voice_signal',
                        room_type: S.roomType,
                        channel_id: S.channelId || '',
                        dm_channel_id: S.dmChannelId || '',
                        to_user_id: fromUid,
                        signal: { type: 'answer', sdp: pc.localDescription.sdp },
                    });
                }).catch(function (err) {
                    console.warn('Answer failed:', err);
                });
            };
            var glare = pc.signalingState === 'have-local-offer';
            if (glare) {
                // Perfect-negotiation glare: exactly one side yields.
                //   - Polite side (higher id): roll back our offer, accept the
                //     remote's — converge on ONE SDP pair.
                //   - Impolite side (lower id): ignore — we own this edge; the
                //     polite side answers ours.
                if (pc._polite) {
                    pc.setLocalDescription({ type: 'rollback' }).then(function () {
                        return pc.setRemoteDescription({ type: 'offer', sdp: sdp });
                    }).then(function () {
                        addLocalTracks(pc);
                        applySendE2EE(pc);
                        flushPendingIce(pc);
                        return pc.createAnswer();
                    }).then(function (answer) {
                        answer.sdp = mungeSdp(answer.sdp);
                        tuneVideoSenders(pc);
                        return pc.setLocalDescription(answer);
                    }).then(function () {
                        send({
                            type: 'voice_signal',
                            room_type: S.roomType,
                            channel_id: S.channelId || '',
                            dm_channel_id: S.dmChannelId || '',
                            to_user_id: fromUid,
                            signal: { type: 'answer', sdp: pc.localDescription.sdp },
                        });
                    }).catch(function (err) {
                        console.warn('Answer failed:', err);
                    });
                }
                return;
            }
            // Our own offer is still being created (signalingState is still
            // 'stable', _makingOffer true) — defer this offer a beat so the
            // two offers don't cross mid-flight, then re-evaluate: whoever has
            // the local offer by then wins the glare check properly.
            if (pc._makingOffer) {
                setTimeout(function () {
                    if (!S.connected || S.peers[fromUid] !== pc || pc.signalingState === 'closed') return;
                    handleSignal(fromUid, signal);
                }, 150);
                return;
            }
            answerOffer();
        } else if (signal.type === 'answer') {
            pc.setRemoteDescription({ type: 'answer', sdp: sdp }).then(function () {
                tuneVideoSenders(pc);
                reapplyAllE2EE(pc);
                flushPendingIce(pc);
            }).catch(function (err) {
                // The answer may match an offer we already rolled back (e.g. the
                // stuck-peer watchdog re-negotiated while the answer was in
                // flight). Rolling back the leftover local offer and applying
                // the answer re-converges the edge; if that still fails (no
                // matching offer at all), re-offer so the remote answers the
                // CURRENT negotiation.
                console.warn('setRemote( answer ) failed:', err);
                if (pc.signalingState === 'have-local-offer') {
                    pc.setLocalDescription({ type: 'rollback' }).then(function () {
                        return pc.setRemoteDescription({ type: 'answer', sdp: sdp });
                    }).then(function () {
                        tuneVideoSenders(pc);
                        flushPendingIce(pc);
                    }).catch(function () {
                        try { pc.onnegotiationneeded(); } catch (_) {}
                    });
                } else {
                    try { pc.onnegotiationneeded(); } catch (_) {}
                }
            });
        } else if (signal.type === 'ice') {
            if (!signal.candidate) return;
            // Buffer until the remote description exists — addIceCandidate before
            // that throws InvalidStateError and would lose the candidate.
            if (!pc.remoteDescription) {
                if (!pc._pendingIce) pc._pendingIce = [];
                pc._pendingIce.push(signal.candidate);
            } else {
                pc.addIceCandidate(signal.candidate).catch(function (_) {});
            }
        }
    }

    // Signals that arrived before the room key was derivable. Replayed in
    // arrival order once it lands, so the handshake completes exactly once and
    // with E2EE attached. (Opening the peer early instead is what produced
    // silent calls, because a transform can never be attached retroactively in
    // a way the remote can decrypt without a renegotiation.)
    function queuePendingSignal(uid, signal) {
        S._pendingPeerUids[uid] = true;
        var q = S._pendingSignals[uid];
        if (!q) { q = S._pendingSignals[uid] = []; }
        // One handshake's worth is all that can ever be useful; the cap stops a
        // hostile/broken peer from growing the queue without bound.
        if (q.length < 64) q.push(signal);
        ensureRoomKey();
        startPendingSignalWatch();
    }

    function stopPendingSignalWatch() {
        if (S._pendingSignalTimer) {
            clearInterval(S._pendingSignalTimer);
            S._pendingSignalTimer = null;
        }
        S._pendingSignalTries = 0;
    }

    function startPendingSignalWatch() {
        if (S._pendingSignalTimer) return;
        S._pendingSignalTries = 0;
        S._pendingSignalTimer = setInterval(function () {
            if (!S.connected || !S.roomType) {
                stopPendingSignalWatch();
                S._pendingSignals = {};
                return;
            }
            if (S.roomKeyB64) {
                stopPendingSignalWatch();
                flushPendingSignals(false);
                return;
            }
            // DM keys come from the partner's identity key, which may land
            // through the conversation prefetch — retry the derivation too.
            if (S.roomType === 'dm') deriveRoomKey();
            ensureRoomKey();
            S._pendingSignalTries++;
            // ~6s without a key: give up holding and open the peers anyway.
            // The edge then exists, and deriveRoomKey()'s heal (or the 4s
            // stuck-peer watchdog) repairs the transforms the moment the key
            // arrives. Better a recoverable edge than a handshake that never
            // completes.
            if (S._pendingSignalTries >= 24) {
                stopPendingSignalWatch();
                flushPendingSignals(true);
            }
        }, 250);
    }

    function flushPendingSignals(force) {
        if (!S.roomKeyB64 && !force) return;
        var uids = Object.keys(S._pendingSignals || {});
        if (!uids.length) return;
        uids.forEach(function (uid) {
            var list = S._pendingSignals[uid];
            delete S._pendingSignals[uid];
            if (!list || !list.length) return;
            // Force path: create the peer FIRST so replaying the held signals
            // does not re-queue them (which would restart the watch forever).
            if (!S.peers[uid] && uid !== getSelfId()) {
                try { createPeer(uid); } catch (_) {}
            }
            list.forEach(function (sig) {
                try { handleSignal(uid, sig); } catch (_) {}
            });
        });
    }

    // ------------------------------------------------------------------
    // WS message routing (called from chat.js onmessage)
    // ------------------------------------------------------------------
    function onWsMessage(data) {
        switch (data.type) {
            case 'voice_joined':
                handleVoiceJoined(data);
                break;
            case 'voice_members':
                handleVoiceMembers(data);
                break;
            case 'voice_member_update':
                handleMemberUpdate(data.member);
                break;
            case 'voice_member_leave':
                handleMemberLeave(data.user_id);
                break;
            case 'voice_presence':
                handleVoicePresence(data);
                break;
            case 'voice_signal': {
                var wasEnc = !!(data.signal && data.signal.e && data.signal.n);
                var sig = decryptSignalPayload(data.signal);
                if (sig) {
                    if (wasEnc) S.sigRecvEncrypted++; else S.sigRecvPlain++;
                    handleSignal(data.from_user_id, sig);
                }
                break;
            }
            case 'voice_kicked':
                handleKicked(data);
                break;
            case 'voice_member_replaced':
                handleMemberReplaced(data);
                break;
            case 'voice_control_received':
                handleControlReceived(data);
                break;
            case 'dm_call_ring':
                handleDmCallRing(data);
                break;
            case 'dm_call_waiting':
                handleDmCallWaiting(data);
                break;
            case 'dm_waiting_cleared':
                handleDmWaitingCleared(data);
                break;
            case 'dm_call_end':
                handleDmCallEnd(data);
                break;
            case 'voice_media_relay':
                handleMediaRelay(data);
                break;
            default:
                return false;
        }
        return true;
    }

    function handleVoiceJoined(data) {
        S.roomType = data.room_type || S.roomType;
        if (data.server_id) S.serverId = data.server_id;
        if (data.channel_id) S.channelId = data.channel_id;
        if (data.dm_channel_id) S.dmChannelId = data.dm_channel_id;
        S.isOwner = !!data.is_owner;
        S.forceMuted = !!data.force_muted;
        S.forceDeafened = !!data.force_deafened;
        S.muted = S.forceMuted || S.forceDeafened;
        S.deafened = S.forceDeafened;
        S.connected = true;
        if (S.roomType === 'dm') {
            S.dmCallActive = true;
            S.incomingCall = null;
            // Once we're in the room, the incoming/ringing bar is always gone
            // (it must not linger after joining a waiting call).
            hideIncomingCall();
            var selfIdHere = getSelfId();
            var otherJoined = (data.members || []).some(function (m) { return m.user_id !== selfIdHere; });
            if (otherJoined) {
                markDmCallAnswered();
            }
        }
        deriveRoomKey();
        deriveSignalKey();
        ensureE2eeWorker();

        // Set member list
        var newMembers = {};
        (data.members || []).forEach(function (m) { newMembers[m.user_id] = m; });
        S.members = newMembers;

        // Connect to every other member. Peers are created with a small stagger:
        // when a user joins a large room, creating N peers synchronously fires N
        // offers + candidate floods at once (glare + rate-limit pressure, and a
        // last joiner on a loaded machine can end up with half its edges stuck).
        // Spreading creation over ~100ms per peer keeps the signaling burst
        // manageable without meaningfully delaying the call.
        var selfId = getSelfId();
        var peerUids = Object.keys(S.members).filter(function (uid) { return uid !== selfId && !S.peers[uid]; });
        peerUids.forEach(function (uid, idx) { schedulePeerCreation(uid, idx * 100); });
        if (!S.roomKeyB64) ensureRoomKey();

        if (S.roomType === 'server') {
            showBar();
            renderPopup();
        } else {
            // DM call — show panel or mini bar depending on the current view
            updateDmCallUI();
        }
        updateSelfUI();
        updateChannelChips();

        // Late-join soundboard sync: if a soundboard clip was already playing
        // when we joined, pick it up from the current position. The offset is
        // NOT computed here — _handleSoundboardPlay samples Date.now() lazily
        // right before playback starts, so fetch + decrypt + decode time is
        // included and we land exactly where the room is.
        if (data.current_soundboard && window._handleSoundboardPlay) {
            var sb = data.current_soundboard;
            var startedMs = sb.play_start_ms || sb.started_at_ms || 0;
            var durMs = sb.duration_ms || 0;
            // Skip clips that have definitely finished (duration known).
            // No 30s hardcoded cap — duration_ms comes from the real clip.
            var elapsedNow = Date.now() - startedMs;
            if (!(durMs > 0 && elapsedNow >= durMs)) {
                window._handleSoundboardPlay({
                    user_id: sb.user_id,
                    clip_id: sb.clip_id,
                    temp_token: sb.temp_token,
                    play_start_ms: startedMs,
                    duration_ms: durMs,
                    _lateJoinOffset: elapsedNow > 0 ? elapsedNow : 0,
                    // Room identity for the multi-device gate
                    room_type: S.roomType || 'server',
                    server_id: S.serverId || '',
                    channel_id: S.channelId || '',
                    dm_channel_id: S.dmChannelId || '',
                });
            }
        }

        // Mic: auto start unless force-muted/deafened
        if (!S.muted && !S.deafened) {
            startMic();
        }

        // Report current self state (mute/deafen/camera/screen/mirror) so peers
        // render our tiles correctly right away — covers pre-started cameras
        // and a mirror preference set before joining.
        sendVoiceState();

        // SERVER safety net: if the room key couldn't be derived at join
        // (the device's server key fetch was in flight — e.g. a phone that
        // just joined the server, or a key_needed handshake that raced the
        // voice join), poll until the key appears, then re-derive and apply
        // E2EE. WITHOUT this, one side encrypts with a room key the other
        // side lacks → one-sided E2EE → total silence in the channel (DM
        // calls were immune because their keys come from identity keys that
        // are always present locally).
        if (S.roomType === 'server' && !S.roomKeyB64) {
            var _srvIdForKey = S.serverId;
            var _srvKeyTries = 0;
            var _srvKeyTimer = setInterval(function () {
                if (!S.connected || S.roomType !== 'server' || S.serverId !== _srvIdForKey) {
                    clearInterval(_srvKeyTimer);
                    if (S._srvKeyTimer === _srvKeyTimer) S._srvKeyTimer = null;
                    return;
                }
                if (S.roomKeyB64) {
                    clearInterval(_srvKeyTimer);
                    if (S._srvKeyTimer === _srvKeyTimer) S._srvKeyTimer = null;
                    return;
                }
                _srvKeyTries++;
                if (_srvKeyTries > 20) { // ~10s cap
                    clearInterval(_srvKeyTimer);
                    if (S._srvKeyTimer === _srvKeyTimer) S._srvKeyTimer = null;
                    return;
                }
                if (!E2ECrypto.getServerKey(_srvIdForKey)) return;
                clearInterval(_srvKeyTimer);
                if (S._srvKeyTimer === _srvKeyTimer) S._srvKeyTimer = null;
                deriveRoomKey();
                deriveSignalKey();
                // Re-apply E2EE to ANY peer created without the key, then nudge
                // a renegotiation on EVERY peer: a keyless joiner's offers were
                // refused for all of them (send() drops signals without a key),
                // so each one must complete its own offer/answer cycle. Nudging
                // only the first peer would leave 3+ member rooms silent with
                // the other members (DM is always 1:1, so its single-peer nudge
                // is fine there — this server mesh is not).
                Object.keys(S.peers).forEach(function (uid) {
                    var _pc = S.peers[uid];
                    applySendE2EE(_pc);
                    try { _pc.onnegotiationneeded(); } catch (_) {}
                });
            }, 500);
            S._srvKeyTimer = _srvKeyTimer;
        }

        // DM safety net: if the room key still couldn't be derived at join
        // (partner identity key fetch was in flight), re-derive now that the
        // members list is set — otherwise signaling E2EE drops every offer.
        if (S.roomType === 'dm' && !S.roomKeyB64) {
            var _pid = S.dmCallPartner && S.dmCallPartner.id;
            ensureDmCallKey(_pid).then(function (ok) {
                if (!ok || !S.connected) return;
                deriveRoomKey();
                deriveSignalKey();
                // Re-apply E2EE to any peers created without the key.
                Object.keys(S.peers).forEach(function (uid) {
                    applySendE2EE(S.peers[uid]);
                });
                // If we were mid-negotiation, nudge a renegotiation so the
                // now-encrypted offer/answer cycle completes.
                if (Object.keys(S.peers).length) {
                    try { S.peers[Object.keys(S.peers)[0]].onnegotiationneeded(); } catch (_) {}
                }
            });
        }

        if (S.roomType === 'server') {
            playSound('join');
            showToast('Connected to ' + (S.channelName || 'voice channel'));
        }
    }

    function handleVoiceMembers(data) {
        if (!S.connected) return;
        var list = data.members || [];
        var newMembers = {};
        list.forEach(function (m) { newMembers[m.user_id] = m; });
        S.members = newMembers;

        var selfId = getSelfId();
        if (S.roomType === 'dm' && list.some(function (m) { return m.user_id !== selfId; })) {
            markDmCallAnswered();
        }
        // Open peers for newcomers (staggered like the join path — see
        // handleVoiceJoined for why the burst must be spread out).
        var newUids = list.filter(function (m) { return m.user_id !== selfId && !S.peers[m.user_id]; });
        newUids.forEach(function (m, idx) { schedulePeerCreation(m.user_id, idx * 100); });
        if (!S.roomKeyB64) ensureRoomKey();
        // Close peers for people who left
        Object.keys(S.peers).forEach(function (uid) {
            if (!newMembers[uid]) {
                var _pc = S.peers[uid];
                if (_pc._videoWatchTimer) {
                    clearInterval(_pc._videoWatchTimer);
                    _pc._videoWatchTimer = null;
                }
                try { _pc.close(); } catch (_) {}
                delete S.peers[uid];
                removeRemoteAudioEls(uid);
                removeRemoteScreenAudioEls(uid);
                cleanupMemberGain(uid);
                delete S.remoteStreams[uid];
                removeRemoteTile(uid);
            }
        });
        // A full member-list snapshot carries everyone's feed state — re-gate
        // our senders for every existing peer (load/unload + deafen changes).
        Object.keys(S.peers).forEach(function (uid) {
            if (!S.members[uid]) return;
            tuneFeedSenders(S.peers[uid], uid);
            tuneAudioSenders(S.peers[uid], uid);
            tuneVideoSenders(S.peers[uid], uid);
        });

        renderBar();
        renderPopup();
        renderDmPanel();
        updateChannelChips();
    }

    function handleMemberUpdate(member) {
        if (!S.connected) return;
        var prev = S.members[member.user_id];
        var isSelf = member.user_id === getSelfId();
        // Only camera/screen/username changes require a full re-render (the
        // video tiles appear/disappear). Mute, deafen, force-mute, force-deafen
        // and speaking changes are just badges + glow — patched in place so the
        // camera/screen <video> elements are never destroyed and recreated
        // (that used to restart/refresh the feeds on every mute toggle).
        // SELF camera/screen are driven by LOCAL state (S.cameraOn/S.screenOn)
        // and the self row always renders from those — so a server echo with a
        // stale camera/screen (e.g. camera started BEFORE joining, or the
        // speaking broadcast) must never count as mediaChanged: that previously
        // rebuilt the self row and recreated the self <video> on the first
        // speaking toggle after joining with a pre-started camera.
        var mediaChanged = !prev ||
            prev.username !== member.username ||
            (!isSelf && (prev.camera !== member.camera || prev.screen !== member.screen)) ||
            // Track ids change on track restarts (camera flip, screen restart)
            // even when the on/off flags don't — re-slot so the right feed
            // lands in the right tile.
            (!isSelf && (prev.camera_track_id !== member.camera_track_id || prev.screen_track_id !== member.screen_track_id)) ||
            // Audio/video mode changes update the M/R badge in the member row
            (prev.audio_mode !== member.audio_mode || prev.video_mode !== member.video_mode);
        // What THIS member is willing to receive changed: manual-load
        // loaded/unloaded feeds, or they deafened/undeafened. Re-gate our
        // senders for them so we stop/start sending exactly what they watch.
        var feedStateChanged = !prev ||
            prev.manual_video_load !== member.manual_video_load ||
            prev.deafened !== member.deafened ||
            (prev.loaded_feeds || []).join(',') !== (member.loaded_feeds || []).join(',') ||
            (prev.unloaded_feeds || []).join(',') !== (member.unloaded_feeds || []).join(',');
        S.members[member.user_id] = member;
        // Drop stale relay frames when the sender turns a feed off OR moves it
        // back to the mesh path (the relay <img> must never keep hiding the
        // fresh mesh <video>). Only an EXPLICIT 'mesh' broadcast counts — the
        // local auto-mode fallback must not decide this for another user.
        if (!isSelf && prev) {
            ['camera', 'screen'].forEach(function (k) {
                var announced = k === 'camera'
                    ? (member.camera_mode || member.video_mode)
                    : (member.screen_mode || member.video_mode);
                var turnedOff = prev[k] && !member[k];
                var leftRelay = !!member[k] && announced === 'mesh';
                if (!turnedOff && !leftRelay) return;
                dropRelayFeed(member.user_id, k, !!member[k]);
            });
        }
        // Check if deafen state changed for any member — recalc audio mode
        if (prev && prev.deafened !== member.deafened) {
            }
        // The member changed their RECEIVE resolution — re-tune our sender for
        // them so we send exactly what they asked for (per-receiver scaling).
        if (!isSelf && prev &&
            (prev.recv_camera_res !== member.recv_camera_res || prev.recv_screen_res !== member.recv_screen_res)) {
            tuneVideoSenders(S.peers[member.user_id], member.user_id);
        }
        // The member changed their RECEIVE audio quality — re-tune our audio
        // sender bitrate for them (min(send, recv) logic).
        if (!isSelf && prev && prev.recv_audio_quality !== member.recv_audio_quality) {
            tuneAudioSenders(S.peers[member.user_id], member.user_id);
        }
        if (!isSelf && feedStateChanged) {
            tuneFeedSenders(S.peers[member.user_id], member.user_id);
            tuneAudioSenders(S.peers[member.user_id], member.user_id);
            tuneVideoSenders(S.peers[member.user_id], member.user_id);
        }
        if (S.roomType === 'dm' && member.user_id !== getSelfId()) {
            markDmCallAnswered();
        }
        if (member.user_id === getSelfId()) {
            S.forceMuted = !!member.force_muted;
            S.forceDeafened = !!member.force_deafened;
            S.muted = !!member.muted;
            S.deafened = !!member.deafened;
            updateSelfUI();
            }
        if (mediaChanged) {
            // The state broadcast may have arrived AFTER the video tracks
            // (their classification raced) — put every stream in the correct
            // slot before re-rendering.
            if (!isSelf) fixVideoSlots(member.user_id);
            renderBar();
            renderPopup();
            renderDmPanel();
        } else {
            // Badges (muted/deafened/force) + speaking glow, in place.
            updateMemberBadgesInPlace(member.user_id);
            updateSpeakingUI();
        }
        updateChannelChips();
    }

    // Patch a single member's status badges in place (server popup row + DM
    // tile) without touching the media area, so video elements stay alive.
    function updateMemberBadgesInPlace(uid) {
        var m = S.members[uid];
        if (!m) return;
        var isSelf = uid === getSelfId();
        var local = isSelf ? Object.assign({}, m, {
            camera: S.cameraOn,
            screen: S.screenOn,
            muted: S.muted,
            deafened: S.deafened,
            speaking: S.speaking,
        }) : m;
        // Server popup rows
        document.querySelectorAll('.voice-member-row[data-uid="' + uid + '"]').forEach(function (row) {
            var st = row.querySelector('.voice-member-status');
            if (st) {
                var html = memberBadges(local, 'vm');
                if (S.roomType === 'server' && S.connected) {
                    var audioMode = resolveAudioMode(uid);
                    var cameraMode = resolveCameraMode(uid);
                    var screenMode = resolveScreenMode(uid);
                    var audioOv = S._audioModeOverrides[uid];
                    var cameraOv = S._cameraModeOverrides[uid];
                    var screenOv = S._screenModeOverrides[uid];
                    var audioIsManual = audioOv === 'mesh' || audioOv === 'relay';
                    var cameraIsManual = cameraOv === 'mesh' || cameraOv === 'relay';
                    var screenIsManual = screenOv === 'mesh' || screenOv === 'relay';
                    html += ' <span class="voice-mode-badge mode-' + audioMode + (isSelf ? ' is-self' : '') + '" data-mode-kind="audio" data-uid="' + esc(uid) + '" title="Audio: ' + audioMode + (audioIsManual ? ' (manual)' : ' (auto)') + '">' + icon('volume-on', 10) + (audioMode === 'mesh' ? 'M' : 'R') + '</span>';
                    html += ' <span class="voice-mode-badge mode-' + cameraMode + (isSelf ? ' is-self' : '') + '" data-mode-kind="camera" data-uid="' + esc(uid) + '" title="Camera: ' + cameraMode + (cameraIsManual ? ' (manual)' : ' (auto)') + '">' + icon('camera', 10) + (cameraMode === 'mesh' ? 'M' : 'R') + '</span>';
                    html += ' <span class="voice-mode-badge mode-' + screenMode + (isSelf ? ' is-self' : '') + '" data-mode-kind="screen" data-uid="' + esc(uid) + '" title="Screen: ' + screenMode + (screenIsManual ? ' (manual)' : ' (auto)') + '">' + icon('monitor', 10) + (screenMode === 'mesh' ? 'M' : 'R') + '</span>';
                }
                st.innerHTML = html;
            }
        });
        // DM tiles
        document.querySelectorAll('.dm-call-tile[data-uid="' + uid + '"]').forEach(function (tile) {
            var info = tile.querySelector('.dm-call-tile-info');
            if (info) {
                info.querySelectorAll('.vm-badge').forEach(function (b) { b.remove(); });
                info.insertAdjacentHTML('beforeend', memberBadges(m, 'vm'));
            }
        });
    }

    // Toggle only the .speaking classes on existing rows/tiles — never rebuild
    // the member list, so video elements stay alive while the glow animates.
    function updateSpeakingUI() {
        document.querySelectorAll('.voice-member-row').forEach(function (row) {
            var uid = row.getAttribute('data-uid');
            var isSelf = row.getAttribute('data-self') === '1';
            var speaking = false;
            if (isSelf) {
                speaking = S.speaking && !S.muted && !S.forceMuted;
            } else {
                var m = S.members[uid];
                speaking = !!(m && m.speaking && !(m.muted || m.force_muted));
            }
            row.classList.toggle('speaking', speaking);
            var av = row.querySelector('.voice-member-avatar');
            if (av) av.classList.toggle('speaking', speaking);
        });
        document.querySelectorAll('.dm-call-tile').forEach(function (tile) {
            var uid = tile.getAttribute('data-uid');
            var m = S.members[uid];
            var speaking = !!(m && m.speaking && !(m.muted || m.force_muted));
            tile.classList.toggle('speaking', speaking);
            var av = tile.querySelector('.dm-call-avatar');
            if (av) av.classList.toggle('speaking', speaking);
        });
    }

    function handleMemberLeave(uid) {
        if (!S.connected) return;
        delete S.members[uid];
        if (S.peers[uid]) {
            var _pc2 = S.peers[uid];
            if (_pc2._videoWatchTimer) {
                clearInterval(_pc2._videoWatchTimer);
                _pc2._videoWatchTimer = null;
            }
            try { _pc2.close(); } catch (_) {}
            delete S.peers[uid];
        }
        removeRemoteAudioEls(uid);
        removeRemoteScreenAudioEls(uid);
        cleanupMemberGain(uid);
        delete S.remoteStreams[uid];
        removeRemoteTile(uid);
        // Stop any soundboard sounds from the leaving user
        if (window._handleSoundboardStop) {
            window._handleSoundboardStop({ user_id: uid });
        }
        renderBar();
        renderPopup();
        renderDmPanel();
        updateChannelChips();
    }

    // A server-wide voice presence snapshot (who is in each voice channel and
    // who is speaking). Sent to ALL server members — participants and
    // non-participants — so the channel list stays live.
    function handleVoicePresence(data) {
        if (!data || !data.server_id) return;
        S.serverPresence[data.server_id] = data;
        updateChannelChips();
        // The server-list voice dots must track presence live — every voice
        // join/leave/speaking change re-broadcasts voice_presence to all
        // server members (including ourselves), so a dot appears/disappears
        // the moment someone enters or leaves a voice channel.
        updateServerVoiceIndicators();
        // Update category voice indicators (green dot on category header)
        if (typeof window.updateCategoryIndicators === 'function') {
            window.updateCategoryIndicators();
        }
    }

    // Ask the server for the current voice presence snapshot for a server.
    function requestServerPresence(serverId) {
        if (!serverId) return;
        send({ type: 'voice_presence_request', server_id: serverId });
    }

    // Server-list voice indicator: a small green dot on each server icon whose
    // server has at least one member in a voice channel (from the server-wide
    // voice_presence snapshot). Called on every presence broadcast AND after
    // the server list is (re)built, because a rebuild wipes the dots. "Even own
    // person": the presence snapshot includes us, so joining a voice channel
    // lights up our own server icon too.
    function updateServerVoiceIndicators() {
        // Individual server-icon dots — skip mini-icons inside collapsed group grids
        // (those get their dot from the group-level indicator instead)
        var icons = document.querySelectorAll('.server-icon[data-id]');
        icons.forEach(function (icon) {
            if (icon.closest('.server-group-collapsed-grid')) return;
            var sid = icon.getAttribute('data-id');
            if (!sid) return;
            var presence = S.serverPresence[sid];
            var active = false;
            if (presence && presence.channels) {
                for (var i = 0; i < presence.channels.length; i++) {
                    if ((presence.channels[i].members || []).length > 0) {
                        active = true;
                        break;
                    }
                }
            }
            var dot = icon.querySelector('.server-voice-dot');
            if (active && !dot) {
                dot = document.createElement('span');
                dot.className = 'server-voice-dot';
                dot.title = 'Someone is in a voice channel';
                icon.appendChild(dot);
            } else if (!active && dot) {
                dot.remove();
            }
        });
        // Group voice indicators:
        //  Collapsed: green dot on the group header (covers the whole group)
        //  Expanded:   dots already appear on individual server icons above
        var groups = document.querySelectorAll('.server-group');
        groups.forEach(function (grp) {
            var gId = grp.dataset.groupId;
            if (!gId) return;
            var isCollapsed = grp.classList.contains('collapsed');
            var groupActive = false;
            var svIcons = grp.querySelectorAll('.server-icon[data-id]');
            svIcons.forEach(function (icon) {
                var sid = icon.getAttribute('data-id');
                if (!sid || groupActive) return;
                var presence = S.serverPresence[sid];
                if (presence && presence.channels) {
                    for (var i = 0; i < presence.channels.length; i++) {
                        if ((presence.channels[i].members || []).length > 0) {
                            groupActive = true;
                            break;
                        }
                    }
                }
            });
            var gDot = grp.querySelector('.group-voice-dot');
            // Only show group-level dot when collapsed (expanded gets per-server dots)
            if (isCollapsed && groupActive && !gDot) {
                gDot = document.createElement('span');
                gDot.className = 'group-voice-dot';
                gDot.title = 'Someone is in a voice channel';
                grp.appendChild(gDot);
            } else if ((!isCollapsed || !groupActive) && gDot) {
                gDot.remove();
            }
        });
    }

    function handleKicked(data) {
        if (data.reason === 'replaced') {
            showToast('Signed in on another device — you left the call.');
        } else {
            showToast('You were kicked from the voice channel.');
        }
        playSound('leave');
        teardownRoom();
        hideBar();
        hidePopup();
        hideDmPanel();
        hideMiniBar();
    }

    // The same user re-joined this room from ANOTHER device (this side must
    // have been replaced). Our peer for them is stale — the old device is
    // tearing down its connections, so any signal that lands here must create
    // a FRESH peer instead of being fed into the dead one.
    function handleMemberReplaced(data) {
        var uid = data.user_id;
        if (!uid || uid === getSelfId()) return;
        if (S.peers[uid]) {
            var _pc3 = S.peers[uid];
            if (_pc3._videoWatchTimer) {
                clearInterval(_pc3._videoWatchTimer);
                _pc3._videoWatchTimer = null;
            }
            try { _pc3.close(); } catch (_) {}
            delete S.peers[uid];
        }
        removeRemoteAudioEls(uid);
        removeRemoteScreenAudioEls(uid);
        cleanupMemberGain(uid);
        delete S.remoteStreams[uid];
        removeRemoteTile(uid);
    }

    function handleControlReceived(data) {
        if (data.action === 'mute' || data.action === 'deafen' || data.action === 'unmute' || data.action === 'undeafen') {
            S.forceMuted = !!data.muted;
            S.forceDeafened = !!data.deafened;
            S.muted = !!data.muted || S.forceMuted;
            S.deafened = !!data.deafened;
            // Force mute → stop sending audio
            if (S.forceMuted || S.forceDeafened) {
                stopMic();
            } else if (!S.muted && !S.deafened) {
                startMic();
            }
            // Pause remote audio if deafened / apply member volumes
            Object.keys(S.remoteAudioEls).forEach(function (uid) {
                applyRemoteVolume(uid);
            });
            Object.keys(S.remoteScreenAudioEls).forEach(function (uid) {
                applyRemoteScreenVolume(uid);
            });
            updateSelfUI();
            renderBar();
            updateMemberBadgesInPlace(getSelfId());
            updateSpeakingUI();
            sendVoiceState();
        }
    }

    // ------------------------------------------------------------------
    // DM calls
    // ------------------------------------------------------------------

    // Ensure the partner's identity public key is cached before a DM call
    // starts. The room key (and its signaling subkey) are derived from it —
    // if it's missing, deriveRoomKey() returns null, signaling E2EE refuses
    // to send SDP/ICE, and the call silently never connects. The prefetch in
    // chat.js's loadDmConversations races the call button, so fetch it here
    // when the conversation object doesn't have it yet.
    function ensureDmCallKey(partnerId) {
        var conv = null;
        if (window.dmConversations) {
            conv = dmConversations.find(function (c) { return c.dm_channel_id === S.dmChannelId; });
        }
        if (conv && conv.other_public_key) {
            S._dmOtherPubB64 = conv.other_public_key;
            return Promise.resolve(true);
        }
        if (S._dmOtherPubB64) return Promise.resolve(true);
        if (!partnerId) return Promise.resolve(false);
        return authFetch('/api/identity/' + encodeURIComponent(partnerId))
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) {
                if (data && data.identity_public_key) {
                    S._dmOtherPubB64 = data.identity_public_key;
                    if (conv) conv.other_public_key = data.identity_public_key;
                    return true;
                }
                return false;
            })
            .catch(function () { return false; });
    }

    // Find the existing DM conversation with `uid`, or create one via the
    // get-or-create DM endpoint (friends only). Resolves to the conversation
    // object (with dm_channel_id) or null. The new conversation is cached into
    // dmConversations so the DM list shows it and future lookups hit locally.
    function getOrCreateDmChannelId(uid) {
        if (typeof dmConversations !== 'undefined' && dmConversations) {
            var found = dmConversations.find(function (c) { return c.other_user_id === uid; });
            if (found && found.dm_channel_id) return Promise.resolve(found);
        }
        return authFetch('/api/dm/' + encodeURIComponent(uid), { method: 'POST' })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) {
                if (!data || !data.id) return null;
                if (typeof dmConversations !== 'undefined' && dmConversations) {
                    var existing = dmConversations.find(function (c) { return c.dm_channel_id === data.id; });
                    if (!existing) {
                        existing = { dm_channel_id: data.id, other_user_id: uid, other_username: '', other_public_key: null };
                        dmConversations.push(existing);
                    }
                    return existing;
                }
                return { dm_channel_id: data.id, other_user_id: uid, other_username: '' };
            })
            .catch(function () { return null; });
    }

    // Call a member found in a server voice channel (member row or channel-list
    // chip). Finds/creates their DM, then starts a DM call — the current server
    // room is left automatically by startDmCall, and if the callee accepts they
    // leave the voice channel too and join this DM call.
    function callMemberFromVoice(uid, username) {
        if (!uid || uid === getSelfId()) return;
        getOrCreateDmChannelId(uid).then(function (conv) {
            if (!conv || !conv.dm_channel_id) {
                showToast('Could not start a call — you may not be friends with that user.');
                return;
            }
            var name = username || '';
            if (conv.other_username) name = conv.other_username;
            startDmCall(conv.dm_channel_id, uid, name);
        });
    }

    async    function startDmCall(dmChannelId, partnerId, partnerUsername) {
        ensureAudioCtx();
        // If we're already in a room (server voice channel OR another DM
        // call), leave it first — a DM call is exclusive like a voice channel.
        if (S.connected && S.roomType) {
            leaveVoice();
        }
        S.roomType = 'dm';
        S.dmChannelId = dmChannelId;
        S.channelId = null;
        S.serverId = null;
        S.dmCallPartner = { id: partnerId, username: partnerUsername };
        S.dmCallActive = true;
        S.dmCallAnswered = false;
        S.popupOpen = false;
        S.callWaiting = false;
        // Every call entry starts with the panel state fresh: hideDmPanel()
        // sets dmPanelOpen=false on leave and it was never reset, so a user
        // who left one call would never see the panel in ANY later call
        // (accept/join showed nothing).
        S.dmPanelOpen = undefined;
        // Await the partner's key BEFORE joining — otherwise the signaling E2EE
        // drops every offer/answer and the call never connects.
        await ensureDmCallKey(partnerId);
        deriveRoomKey();
        deriveSignalKey();
        resetFullscreenState();
        send({ type: 'voice_join', room_type: 'dm', dm_channel_id: dmChannelId });
        send({ type: 'dm_call_ring', dm_channel_id: dmChannelId });
        playSound('join');
        showToast('Calling ' + (partnerUsername || '…'));
        updateDmCallUI();
        notifyWaitingChanged();
        // 30s unanswered → stop ringing, wait for a manual join. The callee is
        // told via dm_call_waiting so their ringtone stops and their incoming
        // bar flips to the waiting state (they can still join by hand).
        // Note: the caller is S.connected as soon as their own voice_joined
        // lands — the timeout keys off dmCallAnswered (did the OTHER side join)
        // instead of connected, which is always true here.
        clearRingTimer();
        S._ringTimer = setTimeout(function () {
            if (S.dmCallActive && !S.dmCallAnswered && S.dmChannelId === dmChannelId) {
                S.callWaiting = true;
                stopRingtone();
                send({ type: 'dm_call_waiting', dm_channel_id: S.dmChannelId });
                showToast('Waiting for ' + (partnerUsername || 'them') + ' to join the call…');
                updateDmCallUI();
                notifyWaitingChanged();
            }
        }, S.ringTimeoutMs);
    }

    function clearRingTimer() {
        if (S._ringTimer) {
            clearTimeout(S._ringTimer);
            S._ringTimer = null;
        }
    }

    // The other DM participant joined the room — cancel the waiting state and
    // any pending 30s ring timeout.
    function markDmCallAnswered() {
        var changed = false;
        if (S.dmCallActive && !S.dmCallAnswered) {
            S.dmCallAnswered = true;
            clearRingTimer();
            changed = true;
        }
        if (S.callWaiting) {
            S.callWaiting = false;
            changed = true;
        }
        // Nothing actually changed (e.g. a speaking toggle broadcast) — do NOT
        // touch the UI. Previously this called updateDmCallUI() on EVERY
        // voice_member_update, which re-rendered the whole DM call panel and
        // recreated every <video> (black-flash refresh on every green bubble).
        if (!changed) return;
        // Update mini bar / panel to reflect the new state (Calling → In call),
        // but ONLY for the view we're actually in: panel when the DM chat is
        // open, floating mini bar everywhere else.
        updateDmCallUI();
        // The call just connected — put BOTH sides in the call's DM view so the
        // panel is visible immediately. The callee already gets this from
        // acceptDmCall; the CALLER who started the call from outside the DM
        // (the 📞 button on a voice-channel member row/chip, another DM, home)
        // was left stranded with only the floating mini-bar and had to reopen
        // the DM conversation to see the popup. Mirror acceptDmCall /
        // joinWaitingCall: switch the app into this DM (enterDmView sets
        // viewMode, selectDmChannel re-runs updateDmCallUI at the end so the
        // panel appears the moment the DM view opens).
        if (S.dmChannelId && typeof selectDmChannel === 'function' &&
            (typeof currentDmChannelId === 'undefined' || currentDmChannelId !== S.dmChannelId)) {
            var _partner = S.dmCallPartner || null;
            if (typeof enterDmView === 'function' && (typeof viewMode === 'undefined' || viewMode !== 'dms')) {
                try { enterDmView(); } catch (_) {}
            }
            try {
                selectDmChannel(S.dmChannelId, _partner ? _partner.id : null, _partner ? (_partner.username || '') : '', null);
            } catch (_) {}
        }
        // The call is live — drop any persisted waiting marker for this channel
        // (both S.waitingCalls and the dmConversations fields syncWaitingCalls
        // rebuilds from, so a later navigation can't resurrect a phantom
        // "waiting" indicator while the call is connected).
        if (S.dmChannelId) {
            clearWaitingMarkerForChannel(S.dmChannelId);
        }
        notifyWaitingChanged();
    }

    async function acceptDmCall() {
        if (!S.incomingCall) return;
        var c = S.incomingCall;
        S.incomingCall = null;
        hideIncomingCall();
        clearCalleeRingTimer();
        stopRingtone();
        // CRITICAL: create/resume the AudioContext INSIDE this user gesture.
        // Without this, the callee's AudioContext is first created later from
        // ontrack (NOT a gesture) → Chrome creates it 'suspended' and refuses
        // to resume it → the remote audio graph is connected to a suspended
        // context → total silence on the callee side.
        ensureAudioCtx();
        // Accepting always leaves the CURRENT room first — whether that's a
        // server voice channel or another DM call (Discord-style: accepting a
        // new call moves you out of the old one).
        if (S.connected && S.roomType) {
            leaveVoice();
        }
        S.roomType = 'dm';
        S.dmChannelId = c.dmChannelId;
        S.channelId = null;
        S.serverId = null;
        S.dmCallPartner = { id: c.callerId, username: c.callerUsername };
        S.dmCallActive = true;
        S.dmCallAnswered = true;
        S.callWaiting = false;
        // Every call entry starts with the panel state fresh (see startDmCall)
        // so accepting after a previous leave still shows the panel.
        S.dmPanelOpen = undefined;
        // The call is live the moment we accept — drop any persisted waiting
        // marker (both places) so syncWaitingCalls() can't resurrect it.
        clearWaitingMarkerForChannel(c.dmChannelId);
        resetFullscreenState();
        await ensureDmCallKey(c.callerId);
        deriveRoomKey();
        deriveSignalKey();
        send({ type: 'voice_join', room_type: 'dm', dm_channel_id: c.dmChannelId });
        playSound('join');
        // Update the panel/mini-bar for the CURRENT view now (immediate
        // feedback), then switch the view to this DM if we're not already
        // there — selectDmChannel re-runs updateDmCallUI() at the end, so the
        // panel appears the moment the DM view opens.
        updateDmCallUI();
        // The old guard `window.currentDmOtherUser === null` NEVER matched:
        // currentDmOtherUser is a top-level `let` (a global lexical binding,
        // not a window property), so window.currentDmOtherUser is always
        // undefined → selectDmChannel was never called and accepting from any
        // other view (server channel, a different DM, home) left the user
        // stranded with only the mini bar and no call panel. Now we switch the
        // app into DM view whenever we're not already viewing this DM —
        // enterDmView sets viewMode + renders the DM sidebar (selectDmChannel
        // itself never sets viewMode), then selectDmChannel loads the
        // conversation and re-runs updateDmCallUI() so the panel appears the
        // moment the DM view opens.
        if (typeof selectDmChannel === 'function' &&
            (typeof currentDmChannelId === 'undefined' || currentDmChannelId !== c.dmChannelId)) {
            if (typeof enterDmView === 'function' && (typeof viewMode === 'undefined' || viewMode !== 'dms')) {
                try { enterDmView(); } catch (_) {}
            }
            try { selectDmChannel(c.dmChannelId, c.callerId, c.callerUsername, null); } catch (_) {}
        }
    }

    // Rebuild S.waitingCalls from the DM conversation list (which the server
    // enriches with waiting_user_id / waiting_username from the persisted
    // dm_call_waiting table). Called after loadDmConversations and on WS
    // Sync persisted waiting state from dmConversations so the waiting
    // indicator survives page refreshes.
    function syncWaitingCalls() {
        if (typeof dmConversations === 'undefined' || !dmConversations) return;
        S.waitingCalls = {};
        var selfId = getSelfId();
        dmConversations.forEach(function (conv) {
            if (conv && conv.dm_channel_id && conv.waiting_user_id) {
                // A marker pointing at OUR OWN user id means "I am the one
                // waiting". That is only true while THIS page is actually in
                // the waiting room. After a page refresh the call is CLOSED
                // (refresh leaves all calls by design), so a self-referencing
                // marker is a stale leftover from the dead room — it must not
                // resurrect the "waiting for X" indicator. Markers pointing at
                // the OTHER user ("they are waiting for US") are about the
                // OTHER side's room, which survives our refresh, so they stay.
                if (selfId && conv.waiting_user_id === selfId) {
                    if (!(S.dmCallActive && S.dmChannelId === conv.dm_channel_id)) return;
                }
                S.waitingCalls[conv.dm_channel_id] = {
                    waitingUserId: conv.waiting_user_id,
                    waitingUsername: conv.waiting_username || '',
                };
            }
        });
        // NOTE: a page refresh, tab close or browser close must CLOSE the call
        // — we deliberately do NOT rejoin here. The server clears our waiting
        // marker once the grace window passes (and the periodic sweep backstops
        // crashes where no disconnect event fired), and the other side's
        // indicator disappears via dm_waiting_cleared. The only auto-rejoin
        // left is the mid-session reconnect() path (network blip, same page),
        // and the mutual-callback in handleDmCallRing (they called us back).
        // Let the DM chat re-render any waiting banner.
        if (typeof document !== 'undefined') {
            document.dispatchEvent(new CustomEvent('voice-waiting-changed'));
        }
    }

    // Join a DM call room WITHOUT ringing the other person (used for the
    // persisted "waiting" state — the other side may be offline or just
    // waiting in the room). If they're in the room, the call connects instantly.
    async function joinWaitingCall(dmChannelId, partnerId, partnerUsername) {
        ensureAudioCtx();
        if (S.connected && S.roomType === 'server') {
            leaveVoice();
        }
        S.roomType = 'dm';
        S.dmChannelId = dmChannelId;
        S.channelId = null;
        S.serverId = null;
        S.dmCallPartner = { id: partnerId, username: partnerUsername };
        S.dmCallActive = true;
        S.dmCallAnswered = false;
        S.popupOpen = false;
        // Every call entry starts with the panel state fresh (see startDmCall).
        S.dmPanelOpen = undefined;
        // Joining the waiting room means WE are the one waiting until the
        // partner shows up (voice_joined with otherJoined → markDmCallAnswered
        // flips it off the moment they connect). Keeps the bar/mini-bar honest:
        // "Waiting for X…" instead of a false "Calling X…" after a refresh.
        S.callWaiting = true;
        resetFullscreenState();
        await ensureDmCallKey(partnerId);
        deriveRoomKey();
        deriveSignalKey();
        send({ type: 'voice_join', room_type: 'dm', dm_channel_id: dmChannelId });
        playSound('join');
        // Same view switch as acceptDmCall: joining from outside this DM
        // (incoming bar's Join while in a server channel, another DM, home)
        // must land us IN the DM so the call panel is visible immediately.
        updateDmCallUI();
        if (typeof selectDmChannel === 'function' &&
            (typeof currentDmChannelId === 'undefined' || currentDmChannelId !== dmChannelId)) {
            if (typeof enterDmView === 'function' && (typeof viewMode === 'undefined' || viewMode !== 'dms')) {
                try { enterDmView(); } catch (_) {}
            }
            try { selectDmChannel(dmChannelId, partnerId, partnerUsername, null); } catch (_) {}
        }
        // Clear the persisted waiting marker for this channel now that we're
        // (re)joining — the call connects if the other side is present. Clear
        // the marker in BOTH places (S.waitingCalls + dmConversations fields)
        // so syncWaitingCalls() can't resurrect it while we're connected.
        clearWaitingMarkerForChannel(dmChannelId);
        if (typeof document !== 'undefined') {
            document.dispatchEvent(new CustomEvent('voice-waiting-changed'));
        }
    }

    function declineDmCall() {
        if (!S.incomingCall) return;
        send({ type: 'dm_call_end', dm_channel_id: S.incomingCall.dmChannelId, reason: 'declined' });
        S.incomingCall = null;
        hideIncomingCall();
        clearCalleeRingTimer();
        stopRingtone();
        playSound('leave');
        // The green "ringing" badge must go away immediately (the server then
        // re-flips us to the amber waiting badge via dm_call_waiting).
        notifyWaitingChanged();
    }

    function endDmCall() {
        leaveVoice();
    }

    function handleDmCallRing(data) {
        // If we're ALREADY in a DM call for this channel — whether waiting for
        // the partner to rejoin or already connected — this ring is them coming
        // back / calling into the room we're in. Don't reject and don't send
        // dm_call_end (that would kill the call); the voice_join reconnect is
        // what establishes the peers. Guarded by channel + dmCallActive alone,
        // NOT callWaiting: by the time the ring arrives, the partner's
        // voice_join has usually already run markDmCallAnswered() (clearing
        // callWaiting), so a callWaiting check would wrongly reject the call.
        if (S.dmCallActive && S.dmChannelId === data.dm_channel_id) {
            showToast(data.caller_username + ' is rejoining the call…');
            return;
        }
        // Mutual callback: if there's a PERSISTED waiting state for this channel
        // where I'M the one waiting (I called them, they didn't answer, and now
        // they're calling me back), auto-join the room so both sides connect —
        // no ringtone, no accept prompt. Works even after a page refresh because
        // syncWaitingCalls() restored S.waitingCalls from the conversation list.
        var pw = S.waitingCalls[data.dm_channel_id];
        if (pw && pw.waitingUserId === getSelfId() && !S.dmCallActive) {
            showToast(data.caller_username + ' called you back — connecting…');
            joinWaitingCall(data.dm_channel_id, data.caller_id, data.caller_username);
            return;
        }
        // Muted DM conversation (or the caller muted as a user): the call is
        // ignored entirely — no bar, no ringtone, no waiting marker. The
        // caller is auto-declined so they stop ringing and land in the waiting
        // state (same as a manual decline) instead of ringing for 30s.
        var mutedConv = (typeof isUserMuted === 'function' && isUserMuted(data.caller_id)) ||
            (typeof isDmMuted === 'function' && isDmMuted(data.dm_channel_id));
        if (mutedConv) {
            send({ type: 'dm_call_end', dm_channel_id: data.dm_channel_id, reason: 'declined' });
            return;
        }
        // Show the incoming bar even when we're busy (in a server voice
        // channel or another DM call) — accepting leaves the current room and
        // joins this call (Discord behavior).
        S.incomingCall = { callerId: data.caller_id, callerUsername: data.caller_username, dmChannelId: data.dm_channel_id };
        showIncomingCall(S.incomingCall);
        // The DM-strip indicator mirrors call state from ANY view — a fresh
        // ring is the "calling" state for the callee, so update it now.
        notifyWaitingChanged();
        // Play the user's custom ringtone (loops until answered / 30s timeout).
        playRingtone(true);
        // A genuine new ring just started (all early-return guards passed) —
        // buzz so a call on silent mode is noticed before the ring times out,
        // then keep buzzing once per ringtone cycle until it's answered or
        // declined. startRingHapticTicker fires the immediate first cue itself.
        startRingHapticTicker();
        // Local safety net: even if the caller's dm_call_waiting is never
        // delivered (e.g. the caller's tab died), stop ringing after 30s and
        // flip the incoming bar to the waiting state.
        clearCalleeRingTimer();
        S._calleeRingTimer = setTimeout(function () {
            if (S.incomingCall && S.incomingCall.dmChannelId === data.dm_channel_id && !S.incomingCall.waiting) {
                // Pass the caller identity so the local fallback persists the
                // correct waiting marker even if the server's dm_call_waiting
                // never arrives (e.g. the caller's tab died).
                handleDmCallWaiting({
                    dm_channel_id: data.dm_channel_id,
                    caller_id: S.incomingCall.callerId,
                    caller_username: S.incomingCall.callerUsername,
                });
            }
        }, S.ringTimeoutMs);
    }

    function clearCalleeRingTimer() {
        if (S._calleeRingTimer) {
            clearTimeout(S._calleeRingTimer);
            S._calleeRingTimer = null;
        }
    }

    function handleDmCallWaiting(data) {
        // Case 1: we never joined (incoming bar) — the caller stopped ringing
        // after 30s unanswered, or left while we were deciding. Keep the bar but
        // flip it to the waiting state so we can still join the call manually.
        // NOTE: S.dmChannelId is still null here (we haven't joined yet), so the
        // channel match must use S.incomingCall — not the early-return guard.
        // The !S.incomingCall.waiting guard makes the flip idempotent: the
        // server's dm_call_waiting AND the local 30s fallback timer both arrive
        // for a timed-out ring, and without the guard the flip (persist marker,
        // hide Decline, vibrate) would run twice — a double haptic buzz.
        if (S.incomingCall && S.incomingCall.dmChannelId === data.dm_channel_id && !S.incomingCall.waiting) {
            S.incomingCall.waiting = true;
            // Ring → waiting: the badge just flipped green→red — vibrate so
            // the transition is felt even if the screen is off / app hidden.
            vibrateWaitingCue();
            stopRingtone();
            var b = el('incoming-call-bar');
            if (b) b.classList.add('waiting');
            var name = el('incoming-call-name');
            if (name) {
                var disp = (typeof userDisplayNameCache !== 'undefined' && userDisplayNameCache[data.caller_id] && userDisplayNameCache[data.caller_id].display_name) || data.caller_username || S.incomingCall.callerUsername || '';
                name.innerHTML = memberNameSpan(data.caller_id, disp) + ' is waiting for you to join';
            }
            var acceptBtn = el('incoming-call-accept');
            if (acceptBtn) acceptBtn.textContent = 'Join';
            // Someone is waiting for us — the indicator must NOT be dismissible,
            // so hide the Decline button (it only stops the ringing, and the
            // ringing already stopped). It returns in showIncomingCall().
            var declineBtn = el('incoming-call-decline');
            if (declineBtn) declineBtn.style.display = 'none';
            // Persist the waiting marker: the CALLER is the one waiting for us.
            S.waitingCalls[data.dm_channel_id] = {
                waitingUserId: data.caller_id,
                waitingUsername: data.caller_username || S.incomingCall.callerUsername || '',
            };
            // Keep dmConversations in sync so syncWaitingCalls() doesn't wipe
            // this state on the next navigation/reconnect.
            if (typeof dmConversations !== 'undefined' && dmConversations) {
                dmConversations.forEach(function (c) {
                    if (c && c.dm_channel_id === data.dm_channel_id) {
                        c.waiting_user_id = data.caller_id;
                        c.waiting_username = data.caller_username || S.incomingCall.callerUsername || '';
                    }
                });
            }
            notifyWaitingChanged();
            return;
        }
        // Case 2: we're in an active DM call and the partner left — the call is
        // NOT closed. We flip to the waiting state (same UI as the 30s timeout)
        // so the partner can rejoin whenever they come back. Also persist the
        // marker so it survives refreshes.
        if (S.dmCallActive && S.dmChannelId === data.dm_channel_id) {
            // Race guard: a genuine leave is always preceded by
            // voice_member_leave + voice_members (server sends them in order
            // before dm_call_waiting), so by now the partner is gone from
            // S.members. If they're still listed, this dm_call_waiting is a
            // stale 30s-timeout message landing right as the partner just
            // joined — a connected call must NOT be flipped to waiting.
            var partnerId = S.dmCallPartner && S.dmCallPartner.id;
            if (partnerId && S.members[partnerId]) return;
            var wasWaiting = S.callWaiting;
            S.callWaiting = true;
            S.dmCallAnswered = false;
            stopRingtone();
            // I'm the one left waiting for the partner to come back.
            S.waitingCalls[data.dm_channel_id] = {
                waitingUserId: getSelfId(),
                waitingUsername: '',
            };
            // Keep dmConversations in sync so syncWaitingCalls() doesn't wipe
            // this state on the next navigation/reconnect.
            if (typeof dmConversations !== 'undefined' && dmConversations) {
                dmConversations.forEach(function (c) {
                    if (c && c.dm_channel_id === data.dm_channel_id) {
                        c.waiting_user_id = getSelfId();
                        c.waiting_username = '';
                    }
                });
            }
            notifyWaitingChanged();
            updateDmCallUI();
            // Toast only on the transition into waiting (leaveVoice also sends
            // dm_call_waiting, so a duplicate may arrive — avoid double toasts).
            if (!wasWaiting) showToast('Call partner left — waiting for them to rejoin…');
        }
        // Case 3: neither incoming bar nor active call — we dismissed or
        // navigated away. Still update dmConversations so the persisted
        // waiting state is available when we return to this DM.
        S.waitingCalls[data.dm_channel_id] = {
            waitingUserId: data.caller_id,
            waitingUsername: data.caller_username || '',
        };
        if (typeof dmConversations !== 'undefined' && dmConversations) {
            dmConversations.forEach(function (c) {
                if (c && c.dm_channel_id === data.dm_channel_id) {
                    c.waiting_user_id = data.caller_id;
                    c.waiting_username = data.caller_username || '';
                }
            });
        }
        notifyWaitingChanged();
    }

    function handleDmCallEnd(data) {
        var isDecline = data.reason === 'declined';
        if (S.incomingCall && S.incomingCall.dmChannelId === data.dm_channel_id) {
            S.incomingCall = null;
            hideIncomingCall();
            clearCalleeRingTimer();
            stopRingtone();
            showToast(isDecline ? 'Call declined.' : 'Call ended.');
            playSound('leave');
            notifyWaitingChanged();
        }
        // The call is fully over (not a decline, and we never joined): the
        // waiter is gone, so drop any persisted waiting marker for this
        // channel even without an active call — otherwise the indicator would
        // linger until the next conversation reload.
        if (!isDecline && !S.dmCallActive && S.waitingCalls[data.dm_channel_id]) {
            delete S.waitingCalls[data.dm_channel_id];
            if (typeof dmConversations !== 'undefined' && dmConversations) {
                dmConversations.forEach(function (c) {
                    if (c && c.dm_channel_id === data.dm_channel_id) {
                        c.waiting_user_id = null;
                        c.waiting_username = '';
                    }
                });
            }
            notifyWaitingChanged();
        }
        if (S.dmCallActive && S.dmChannelId === data.dm_channel_id) {
            var wasConnected = S.connected;
            clearRingTimer();
            clearCalleeRingTimer();
            stopRingtone();
            if (isDecline) {
                // Callee declined — place caller in waiting state (same as 30s
                // timeout) so they can call again. Don't tear down the room.
                // The ring→waiting transition is felt as well as seen: the
                // waiting haptic (default [60,40,60]) fires here too, exactly
                // like the 30s-unanswered path — the user asked for the cue on
                // decline as well as timeout.
                vibrateWaitingCue();
                S.callWaiting = true;
                S.dmCallAnswered = false;
                S.waitingCalls[data.dm_channel_id] = {
                    waitingUserId: getSelfId(),
                    waitingUsername: '',
                };
                if (typeof dmConversations !== 'undefined' && dmConversations) {
                    dmConversations.forEach(function (c) {
                        if (c && c.dm_channel_id === data.dm_channel_id) {
                            c.waiting_user_id = getSelfId();
                            c.waiting_username = '';
                        }
                    });
                }
                notifyWaitingChanged();
                updateDmCallUI();
                showToast('Call declined — waiting for them to join…');
            } else {
                teardownRoom();
                hideBar();
                hidePopup();
                hideDmPanel();
                hideMiniBar();
                if (wasConnected) playSound('leave');
                showToast('Call ended.');
                if (S.waitingCalls[data.dm_channel_id]) {
                    delete S.waitingCalls[data.dm_channel_id];
                    if (typeof dmConversations !== 'undefined' && dmConversations) {
                        dmConversations.forEach(function (c) {
                            if (c && c.dm_channel_id === data.dm_channel_id) {
                                c.waiting_user_id = null;
                                c.waiting_username = '';
                            }
                        });
                    }
                    notifyWaitingChanged();
                }
            }
        }
    }

    // The person who was waiting for us is gone (left the room, closed the
    // tab, their connection dropped and they never came back, or the server
    // restarted). Remove the waiting marker and any waiting-state incoming
    // bar so the indicator can't linger — the call is no longer joinable.
    function handleDmWaitingCleared(data) {
        var ch = data && data.dm_channel_id;
        if (!ch) return;
        var had = !!S.waitingCalls[ch];
        if (S.waitingCalls[ch]) delete S.waitingCalls[ch];
        // If the incoming bar was showing the waiting state for this channel,
        // close it too — there is nobody waiting anymore.
        if (S.incomingCall && S.incomingCall.dmChannelId === ch) {
            var wasWaiting = !!S.incomingCall.waiting;
            if (wasWaiting) {
                S.incomingCall = null;
                hideIncomingCall();
                stopRingtone();
                playSound('leave');
            }
        }
        // Keep dmConversations in sync so a later syncWaitingCalls() rebuild
        // doesn't resurrect the stale marker.
        if (typeof dmConversations !== 'undefined' && dmConversations) {
            dmConversations.forEach(function (c) {
                if (c && c.dm_channel_id === ch) {
                    c.waiting_user_id = null;
                    c.waiting_username = '';
                }
            });
        }
        if (had) notifyWaitingChanged();
    }

    // ------------------------------------------------------------------
    // Self state toggles
    // ------------------------------------------------------------------
    function toggleMute() {
        ensureAudioCtx();
        if (S.forceMuted) {
            showToast('You are server-muted and cannot unmute.');
            return;
        }
        S.muted = !S.muted;
        if (S.muted) {
            stopMic();
        } else if (S.connected && !S.deafened) {
            startMic();
        }
        sendVoiceState();
        updateSelfUI();
        playSound(S.muted ? 'mute' : 'unmute');
    }

    // --- Picture-in-Picture ---
    var _pipActive = false;
    var _pipTempVideo = null;
    var _pipCanvas = null;
    var _pipAnimFrame = 0;
    var _pipUid = null;   // member whose feed is in the PiP window
    var _pipKind = null;  // 'camera' | 'screen'
    // Clicking the PiP button opens a picker of every live camera/screen feed
    // so you can choose which member/stream to pop out (and switch between
    // them). Clicking it again while a PiP window is open closes it.
    function togglePiP(anchor) {
        if (_pipActive) { stopPiP(); return; }
        openPipMenu(anchor);
    }

    function stopPiP() {
        _pipActive = false;
        _pipUid = null;
        _pipKind = null;
        try { document.exitPictureInPicture().catch(function () {}); } catch (_) {}
        _cleanupCanvasPiP();
    }

    // Start PiP for one specific feed (invoked from the picker).
    function startPiPForTile(target, uid, kind) {
        if (!target) { showToast('No active video to PiP'); return; }
        if (!document.pictureInPictureEnabled) { showToast('PiP not supported in this browser'); return; }
        _pipUid = uid || target.getAttribute('data-uid') || getSelfId();
        _pipKind = kind || target.getAttribute('data-kind') || 'camera';
        var st = S.tileTransforms[_pipUid + ':' + _pipKind] || null;
        var hasTransform = st && (st.mirror || st.rot);
        var isImg = target.tagName === 'IMG';
        // If the target has rotation/mirror transforms, or is a relay <img>,
        // use a canvas compositing pipeline so the PiP window shows the
        // transformed view (browser PiP ignores CSS transforms).
        if (hasTransform || isImg) { _startCanvasPiP(target, _pipUid, _pipKind, isImg); return; }
        // No transforms, <video> element — PiP directly.
        if (!target.srcObject) { showToast('No active video to PiP'); return; }
        target.requestPictureInPicture().then(function () {
            _pipActive = true;
            target.addEventListener('leavepictureinpicture', function handler() {
                _pipActive = false;
                _pipUid = null;
                _pipKind = null;
                target.removeEventListener('leavepictureinpicture', handler);
            });
        }).catch(function (err) { console.warn('[PiP]', err); showToast('PiP failed: ' + (err.message || err)); });
    }

    // Every camera/screen feed currently on screen, de-duplicated per
    // (member, kind), preferring the visible tile when a feed is rendered in
    // more than one place (popup row + DM body + fullscreen wrapper).
    function collectPipSources() {
        var selfId = getSelfId();
        var byKey = {};
        var order = [];
        var nodes = document.querySelectorAll('img[data-kind], video[data-kind]');
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var cls = node.className || '';
            var isTile = cls.indexOf('relay-video') !== -1 || cls.indexOf('remote-video-tile') !== -1 || cls.indexOf('voice-self-video') !== -1;
            if (!isTile) continue;
            var kind = node.getAttribute('data-kind');
            if (kind !== 'camera' && kind !== 'screen') continue;
            var uid = node.getAttribute('data-uid') || selfId;
            if (!uid) continue;
            var key = uid + ':' + kind;
            var vis = isTileVisible(node);
            if (!byKey[key]) {
                byKey[key] = { uid: uid, kind: kind, tile: node, visible: vis };
                order.push(key);
            } else if (vis && !byKey[key].visible) {
                byKey[key] = { uid: uid, kind: kind, tile: node, visible: true };
            }
        }
        return order.map(function (k) { return byKey[k]; });
    }

    function closePipMenu() {
        var menu = el('voice-pip-menu');
        if (!menu) return;
        menu.style.display = 'none';
        if (menu._pipDocClick) {
            document.removeEventListener('click', menu._pipDocClick);
            menu._pipDocClick = null;
        }
    }

    function openPipMenu(anchor) {
        var menu = el('voice-pip-menu');
        if (!menu) return;
        if (!document.pictureInPictureEnabled) { showToast('PiP not supported in this browser'); return; }
        var selfId = getSelfId();
        var sources = collectPipSources();
        menu.innerHTML = '';
        if (sources.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'voice-pip-empty';
            empty.textContent = 'No active camera or screen share';
            menu.appendChild(empty);
        } else {
            sources.forEach(function (src) {
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.setAttribute('data-uid', src.uid);
                btn.setAttribute('data-kind', src.kind);
                if (_pipActive && src.uid === _pipUid && src.kind === _pipKind) btn.classList.add('active');
                var label = document.createElement('span');
                var m = S.members[src.uid];
                label.textContent = (src.uid === selfId) ? 'You' : memberDisplayName(src.uid, m);
                btn.appendChild(label);
                var kindEl = document.createElement('span');
                kindEl.className = 'voice-pip-kind';
                kindEl.textContent = src.kind === 'camera' ? 'Camera' : 'Screen';
                btn.appendChild(kindEl);
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    closePipMenu();
                    startPiPForTile(src.tile, src.uid, src.kind);
                });
                menu.appendChild(btn);
            });
        }
        // Show, then position near the button that opened it (clamped to the
        // viewport) — same placement logic as the camera options menu.
        menu.style.display = 'flex';
        menu.style.left = '0px';
        menu.style.top = '0px';
        var rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
        var mw = menu.offsetWidth || 200;
        var mh = menu.offsetHeight || 100;
        var left = rect ? (rect.left + rect.width / 2 - mw / 2) : (window.innerWidth / 2 - mw / 2);
        var top = rect ? (rect.top - mh - 8) : 80;
        left = Math.max(8, Math.min(window.innerWidth - mw - 8, left));
        if (top < 8) top = rect ? Math.min(window.innerHeight - mh - 8, rect.bottom + 8) : 8;
        menu.style.left = left + 'px';
        menu.style.top = Math.max(8, top) + 'px';
        setTimeout(function () {
            var onDocClick = function (e) {
                if (menu.style.display === 'none' || menu.contains(e.target)) return;
                closePipMenu();
            };
            menu._pipDocClick = onDocClick;
            document.addEventListener('click', onDocClick);
        }, 10);
    }

    function _startCanvasPiP(target, uid, kind, isImg) {
        // Never stack sessions — a rapid toggle-off/on used to leave the older
        // canvas + hidden video alive.
        _cleanupCanvasPiP();
        var st = uid && kind ? S.tileTransforms[uid + ':' + kind] : null;
        var rot = st && st.rot ? ((st.rot % 360) + 360) % 360 : 0;
        var mirror = st && st.mirror;
        var srcW = 0, srcH = 0;
        // A relay <img> already has a decoded frame (naturalWidth) but a
        // freshly injected one may not, and a mesh <video> needs metadata.
        // drawImage() on a not-yet-decoded source is a silent no-op, so the
        // old code started the capture stream immediately and the PiP window
        // stayed BLANK. Wait for a real frame before creating the canvas.
        var readSrcSize = function () {
            srcW = isImg ? (target.naturalWidth || 0) : (target.videoWidth || 0);
            srcH = isImg ? (target.naturalHeight || 0) : (target.videoHeight || 0);
            if (!(srcW > 0 && srcH > 0)) {
                srcW = target.clientWidth || 0;
                srcH = target.clientHeight || 0;
            }
            return srcW > 0 && srcH > 0;
        };
        if (!readSrcSize()) {
            var waited = 0;
            var waitId = setInterval(function () {
                waited += 100;
                if (readSrcSize() || waited >= 4000) {
                    clearInterval(waitId);
                    if (srcW > 0 && srcH > 0) start();
                    else showToast('PiP: video not ready');
                }
            }, 100);
            return;
        }
        start();

        function start() {
            var sideways = rot === 90 || rot === 270;
            var canvasW = sideways ? srcH : srcW;
            var canvasH = sideways ? srcW : srcH;
            var canvas = document.createElement('canvas');
            canvas.width = canvasW;
            canvas.height = canvasH;
            _pipCanvas = canvas;
            // Expose for test verification
            try { window._pipCanvas = canvas; window._pipFramesDrawn = 0; window._pipLastError = null; } catch (_) {}
            var ctx = canvas.getContext('2d');
            // Mark active BEFORE starting the draw loop so drawFrame() runs.
            _pipActive = true;
            // Draw loop: composite the source with rotation + mirror. Uses a
            // TIMER, not requestAnimationFrame — rAF drops to ~1fps for a
            // background/occluded tab, which is exactly when PiP is being used
            // (the page is behind the PiP window or another window).
            var drawFrame = function () {
                if (!_pipActive) return;
                try {
                    ctx.save();
                    ctx.translate(canvasW / 2, canvasH / 2);
                    if (mirror) ctx.scale(-1, 1);
                    if (rot) ctx.rotate(rot * Math.PI / 180);
                    ctx.drawImage(target, -srcW / 2, -srcH / 2, srcW, srcH);
                    ctx.restore();
                    try { window._pipFramesDrawn = (window._pipFramesDrawn || 0) + 1; } catch (_) {}
                } catch (e) {
                    try { window._pipLastError = String((e && e.message) || e); } catch (_) {}
                }
                _pipAnimFrame = setTimeout(drawFrame, 33);
            };
            drawFrame();
            // Capture canvas stream and pipe to hidden video
            var stream = canvas.captureStream(30);
            var pipVideo = document.createElement('video');
            pipVideo.srcObject = stream;
            pipVideo.muted = true;
            pipVideo.playsInline = true;
            pipVideo.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;';
            document.body.appendChild(pipVideo);
            _pipTempVideo = pipVideo;
            pipVideo.play().catch(function() {});
            // requestPictureInPicture() throws InvalidStateError until the
            // element has metadata (HAVE_METADATA). A canvas captureStream is
            // empty for a moment after captureStream() — calling PiP right away
            // ALWAYS failed with "Metadata for the video element are not loaded
            // yet", which is why PiP silently did nothing. Wait for the first
            // real frame (and retry briefly) before requesting.
            var pipTries = 0;
            var tryPip = function () {
                if (!_pipActive) return;
                if (!pipVideo.isConnected) return;
                if (pipVideo.readyState < 1 /* HAVE_METADATA */) {
                    if (++pipTries > 60) { // ~3s
                        showToast('PiP failed: video not ready');
                        _cleanupCanvasPiP();
                        return;
                    }
                    setTimeout(tryPip, 50);
                    return;
                }
                pipVideo.requestPictureInPicture().then(function() {
                    _pipActive = true;
                    pipVideo.addEventListener('leavepictureinpicture', function handler() {
                        pipVideo.removeEventListener('leavepictureinpicture', handler);
                        _cleanupCanvasPiP();
                    });
                }).catch(function(err) {
                    console.warn('[PiP canvas]', err);
                    showToast('PiP failed: ' + ((err && err.message) || err));
                    _cleanupCanvasPiP();
                });
            };
            tryPip();
        }
    }

    function _cleanupCanvasPiP() {
        _pipActive = false;
        if (_pipAnimFrame) { clearTimeout(_pipAnimFrame); _pipAnimFrame = 0; }
        _pipCanvas = null;
        try { window._pipCanvas = null; } catch (_) {}
        if (_pipTempVideo) {
            if (_pipTempVideo.srcObject) {
                try { _pipTempVideo.srcObject.getTracks().forEach(function(t) { t.stop(); }); } catch (_) {}
            }
            _pipTempVideo.srcObject = null;
            _pipTempVideo.src = '';
            if (_pipTempVideo.parentNode) _pipTempVideo.parentNode.removeChild(_pipTempVideo);
            _pipTempVideo = null;
        }
    }

    function toggleDeafen() {
        ensureAudioCtx();
        if (S.forceDeafened) {
            showToast('You are server-deafened and cannot undeafen.');
            return;
        }
        S.deafened = !S.deafened;
        if (S.deafened) {
            S.muted = true;
            stopMic();
        } else {
            S.muted = false;
            if (S.connected) startMic();
        }
        // Mute/unmute all remote audio (mic AND screen-share audio)
        Object.keys(S.remoteAudioEls).forEach(function (uid) {
            applyRemoteVolume(uid);
        });
        Object.keys(S.remoteScreenAudioEls).forEach(function (uid) {
            applyRemoteScreenVolume(uid);
        });
        sendVoiceState();
        updateSelfUI();
        playSound(S.deafened ? 'deafen' : 'undeafen');
    }

    function toggleCamera() {
        ensureAudioCtx();
        if (!S.connected) {
            // Allow toggling camera before joining (per spec: camera/screen before join)
            if (S.cameraOn) stopCamera(); else startCamera();
            return;
        }
        if (S.cameraOn) stopCamera(); else startCamera();
    }

    function toggleScreen() {
        ensureAudioCtx();
        if (S.screenOn) stopScreen(); else startScreen();
    }

    // Switch between the front and back camera (mobile). The camera is
    // restarted with the new facingMode; peers renegotiate automatically
    // (stopCamera removes the old track, startCamera re-adds the new one).
    function flipCamera() {
        ensureAudioCtx();
        if (!S.cameraOn) {
            showToast('Turn the camera on first.');
            return;
        }
        S.cameraFacing = S.cameraFacing === 'user' ? 'environment' : 'user';
        stopCamera();
        startCamera();
    }

    // Flash on/off. Cameras with a torch (most rear cameras) use the real
    // LED via applyConstraints. Cameras WITHOUT torch — like the selfie/
    // front camera — fall back to a white screen overlay covering the app,
    // with a button on it to turn the flash back off.
    function setCameraFlashOn(on) {
        S.cameraFlash = !!on;
        var track = S.localStreams.camera && S.localStreams.camera.getVideoTracks()[0];
        var torch = !!(track && track.getCapabilities && track.getCapabilities().torch);
        if (torch && track) {
            track.applyConstraints({ advanced: [{ torch: S.cameraFlash }] }).catch(function () {
                S.cameraFlash = false;
                showToast('Flash could not be toggled.');
            });
        } else {
            var ov = el('camera-flash-overlay');
            if (ov) ov.style.display = S.cameraFlash ? 'flex' : 'none';
        }
        closeCamOptMenu();
        updateSelfUI();
    }

    function toggleCameraFlash() {
        ensureAudioCtx();
        if (!S.cameraOn || !S.localStreams.camera) {
            showToast('Turn the camera on first.');
            return;
        }
        setCameraFlashOn(!S.cameraFlash);
    }

    // Camera options dropdown (flip / mirror / flash) — one button in each
    // call's control row opens it; it closes on an outside click. Flip and
    // mirror close it immediately; flash closes it too (the white overlay
    // itself becomes the "flash is on" indicator).
    function openCamOptMenu(anchor) {
        var menu = el('voice-cam-opt-menu');
        if (!menu) return;
        // Disable camera-only options when camera is off
        var flip = el('cam-opt-flip');
        var flash = el('cam-opt-flash');
        if (flip) flip.style.opacity = S.cameraOn ? '1' : '0.4';
        if (flash) flash.style.opacity = S.cameraOn ? '1' : '0.4';
        updateCamOptMenuState();
        menu.style.display = 'flex';
        var r = anchor.getBoundingClientRect();
        var mw = 200;
        var x = Math.max(6, Math.min(r.left, window.innerWidth - mw - 8));
        var y = r.bottom + 6;
        if (y + 130 > window.innerHeight) y = Math.max(6, r.top - 130);
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        if (menu._camOptDocClick) document.removeEventListener('click', menu._camOptDocClick);
        var onDocClick = function (e) {
            if (menu.style.display === 'none' || menu.contains(e.target)) return;
            closeCamOptMenu();
            document.removeEventListener('click', onDocClick);
            menu._camOptDocClick = null;
        };
        menu._camOptDocClick = onDocClick;
        setTimeout(function () { document.addEventListener('click', onDocClick); }, 10);
    }

    function closeCamOptMenu() {
        var menu = el('voice-cam-opt-menu');
        if (menu) menu.style.display = 'none';
    }

    function updateCamOptMenuState() {
        var flash = el('cam-opt-flash');
        if (flash) flash.classList.toggle('active', !!S.cameraFlash);
        var isDm = S.roomType === 'dm';
        // Hide mesh/relay options in DM calls (always mesh)
        var audioMode = el('cam-opt-audio-mode');
        var cameraMode = el('cam-opt-camera-mode');
        var screenMode = el('cam-opt-screen-mode');
        if (audioMode) audioMode.style.display = isDm ? 'none' : '';
        if (cameraMode) cameraMode.style.display = isDm ? 'none' : '';
        if (screenMode) screenMode.style.display = isDm ? 'none' : '';
        // Audio mode label
        var alabel = el('cam-opt-audio-mode-label');
        if (alabel) {
            var selfId = getSelfId();
            var aMode = selfId ? resolveAudioMode(selfId) : 'mesh';
            alabel.textContent = 'Audio: ' + (aMode === 'mesh' ? 'P2P mesh' : 'Server relay');
        }
        // Camera mode label
        var clabel = el('cam-opt-camera-mode-label');
        if (clabel) {
            var selfId2 = getSelfId();
            var cMode = selfId2 ? resolveCameraMode(selfId2) : 'mesh';
            clabel.textContent = 'Camera: ' + (cMode === 'mesh' ? 'P2P mesh' : 'Server relay');
        }
        // Screen mode label
        var slabel = el('cam-opt-screen-mode-label');
        if (slabel) {
            var selfId3 = getSelfId();
            var sMode = selfId3 ? resolveScreenMode(selfId3) : 'mesh';
            slabel.textContent = 'Screen: ' + (sMode === 'mesh' ? 'P2P mesh' : 'Server relay');
        }
    }

    function bindCamOptMenu() {
        var menu = el('voice-cam-opt-menu');
        if (!menu) return;
        var flip = el('cam-opt-flip');
        var flash = el('cam-opt-flash');
        var audioMode = el('cam-opt-audio-mode');
        var cameraMode = el('cam-opt-camera-mode');
        var screenMode = el('cam-opt-screen-mode');
        if (flip) flip.addEventListener('click', function (e) { e.stopPropagation(); flipCamera(); closeCamOptMenu(); });
        if (flash) flash.addEventListener('click', function (e) { e.stopPropagation(); toggleCameraFlash(); });
        if (audioMode) audioMode.addEventListener('click', function (e) {
            e.stopPropagation();
            var selfId = getSelfId();
            var cur = selfId ? (S._audioModeOverrides[selfId] || 'mesh') : 'mesh';
            var next = cur === 'relay' ? 'mesh' : 'relay';
            setSelfAudioMode(next);
            updateCamOptMenuState();
        });
        if (cameraMode) cameraMode.addEventListener('click', function (e) {
            e.stopPropagation();
            var selfId = getSelfId();
            var cur = selfId ? (S._cameraModeOverrides[selfId] || 'mesh') : 'mesh';
            var next = cur === 'relay' ? 'mesh' : 'relay';
            setSelfCameraMode(next);
            updateCamOptMenuState();
        });
        if (screenMode) screenMode.addEventListener('click', function (e) {
            e.stopPropagation();
            var selfId = getSelfId();
            var cur = selfId ? (S._screenModeOverrides[selfId] || 'mesh') : 'mesh';
            var next = cur === 'relay' ? 'mesh' : 'relay';
            setSelfScreenMode(next);
            updateCamOptMenuState();
        });
        var off = el('camera-flash-off');
        if (off) off.addEventListener('click', function () { setCameraFlashOn(false); });
    }

    function sendVoiceState() {
        if (!S.connected) return;
        // Track ids let receivers match incoming video tracks to the correct
        // slot (camera vs screen) even when the track arrives BEFORE this
        // state broadcast — otherwise a screen share can land in the camera
        // slot (or vice versa) and "look wrong" until a renegotiation.
        var camTrack = S.localStreams.camera && S.localStreams.camera.getVideoTracks()[0];
        var scrTrack = S.localStreams.screen && S.localStreams.screen.getVideoTracks()[0];
        var selfId = getSelfId();
        send({
            type: 'voice_state',
            room_type: S.roomType,
            channel_id: S.channelId || '',
            dm_channel_id: S.dmChannelId || '',
            muted: S.muted,
            deafened: S.deafened,
            camera: S.cameraOn,
            screen: S.screenOn,
            speaking: S.speaking,
            camera_track_id: camTrack ? camTrack.id : null,
            screen_track_id: scrTrack ? scrTrack.id : null,
            // Broadcast self audio/video mode so peers can show M/R badges.
            // Mesh is the default — relay only when the user opted in.
            audio_mode: selfId ? (S._audioModeOverrides[selfId] || 'mesh') : 'mesh',
            video_mode: selfId ? (S._videoModeOverrides[selfId] || 'mesh') : 'mesh',
            camera_mode: selfId ? (S._cameraModeOverrides[selfId] || 'mesh') : 'mesh',
            screen_mode: selfId ? (S._screenModeOverrides[selfId] || 'mesh') : 'mesh',
            // Receive-resolution preference: every peer scales its sender for
            // THIS member down to these heights (per-receiver quality).
            recv_camera_res: S.settings.recvCameraRes || 360,
            recv_screen_res: S.settings.recvScreenRes || 480,
            // Audio quality preference: broadcast so peers can tune their
            // Opus encoding / relay capture to match what this member wants.
            send_audio_quality: S.settings.sendAudioQuality || 'medium',
            recv_audio_quality: S.settings.recvAudioQuality || 'medium',
            send_screen_audio_quality: S.settings.sendScreenAudioQuality || 'medium',
            recv_screen_audio_quality: S.settings.recvScreenAudioQuality || 'medium',
            // Manual video-load state: which feeds ("uid:kind") this viewer has
            // explicitly loaded/unloaded, so every sender can stop sending a
            // feed nobody is watching (bitrate) — see feedWanted().
            manual_video_load: !!S.settings.manualVideoLoad,
            loaded_feeds: loadedFeedsList(),
            unloaded_feeds: unloadedFeedsList(),
        });
    }

    // ------------------------------------------------------------------
    // Speaking detection
    // ------------------------------------------------------------------
    function startSpeakingDetection() {
        stopSpeakingDetection();
        if (!S.localStreams.mic || !S.audioCtx) return;
        try {
            var src = S.audioCtx.createMediaStreamSource(S.localStreams.mic);
            S.analyser = S.audioCtx.createAnalyser();
            S.analyser.fftSize = 512;
            src.connect(S.analyser);
            var buf = new Uint8Array(S.analyser.fftSize);
            S.speakingInterval = setInterval(function () {
                if (!S.analyser) return;
                S.analyser.getByteTimeDomainData(buf);
                var sum = 0;
                for (var i = 0; i < buf.length; i++) {
                    var v = (buf[i] - 128) / 128;
                    sum += v * v;
                }
                var rms = Math.sqrt(sum / buf.length);
                var now = Date.now();
                var speaking = rms > 0.02 && !S.muted && !S.deafened;
                if (speaking !== S.speaking && now - S._lastSpeakSent > 120) {
                    S.speaking = speaking;
                    S._lastSpeakSent = now;
                    sendVoiceState();
                    updateSelfUI();
                    renderBar();
                    updateSpeakingUI();
                }
            }, 120);
        } catch (_) {}
    }

    function stopSpeakingDetection() {
        if (S.speakingInterval) {
            clearInterval(S.speakingInterval);
            S.speakingInterval = null;
        }
        if (S.analyser) { try { S.analyser.disconnect(); } catch (_) {} S.analyser = null; }
    }

    // ------------------------------------------------------------------
    // Owner controls (server rooms only)
    // ------------------------------------------------------------------
    function ownerControl(action, targetUid) {
        if (!S.connected || S.roomType !== 'server') return;
        send({
            type: 'voice_control',
            room_type: 'server',
            server_id: S.serverId,
            channel_id: S.channelId,
            action: action,
            target_user_id: targetUid,
        });
    }

    // ------------------------------------------------------------------
    // UI: helpers
    // ------------------------------------------------------------------
    function getSelfId() {
        if (window.currentUser && currentUser.id) return currentUser.id;
        try {
            var u = JSON.parse(localStorage.getItem('user') || 'null');
            return u && u.id ? u.id : null;
        } catch (_) { return null; }
    }

    function el(id) { return document.getElementById(id); }

    // Tell the DM chat layer that the persisted waiting state changed so it can
    // show/hide the "X is waiting for you to join the call" banner.
    function notifyWaitingChanged() {
        if (typeof document !== 'undefined') {
            document.dispatchEvent(new CustomEvent('voice-waiting-changed'));
        }
    }

    // Clear the persisted waiting marker for a DM channel on THIS client (both
    // the live S.waitingCalls entry and the cached dmConversations fields that
    // syncWaitingCalls() rebuilds from). Keeping the two in lockstep is what
    // prevents the "double stalemate": a stale local waiting_user_id survives
    // call transitions (connected, joined, left) because syncWaitingCalls()
    // re-reads the conversation list, resurrecting a phantom "waiting"
    // indicator for a call nobody is in. Call this whenever the authoritative
    // server state says nobody is waiting (call live, call ended, we joined).
    function clearWaitingMarkerForChannel(dmChannelId) {
        if (!dmChannelId) return;
        var had = !!(S.waitingCalls && S.waitingCalls[dmChannelId]);
        if (S.waitingCalls && S.waitingCalls[dmChannelId]) {
            delete S.waitingCalls[dmChannelId];
        }
        if (typeof dmConversations !== 'undefined' && dmConversations) {
            dmConversations.forEach(function (c) {
                if (c && c.dm_channel_id === dmChannelId && (c.waiting_user_id || c.waiting_username)) {
                    c.waiting_user_id = null;
                    c.waiting_username = '';
                }
            });
        }
        if (had) notifyWaitingChanged();
    }

    // Build a navigator.vibrate pattern from a { pulse, gap, pulses } config:
    // [pulse, gap, pulse, gap, …, pulse] — `pulses` buzzes separated by `gap`
    // pauses. Clamped to sane bounds regardless of what the sliders or
    // persisted settings contain.
    function buildHapticPattern(cfg) {
        var pulse = parseInt(cfg && cfg.pulse, 10);
        var gap = parseInt(cfg && cfg.gap, 10);
        var pulses = parseInt(cfg && cfg.pulses, 10);
        if (isNaN(pulse)) pulse = 150;
        if (isNaN(gap)) gap = 80;
        if (isNaN(pulses)) pulses = 2;
        pulse = Math.max(10, Math.min(2000, pulse));
        gap = Math.max(10, Math.min(2000, gap));
        pulses = Math.max(1, Math.min(10, pulses));
        var pattern = [];
        for (var i = 0; i < pulses; i++) {
            if (i > 0) pattern.push(gap);
            pattern.push(pulse);
        }
        return pattern;
    }

    // The configured pattern for an event type ('ring' | 'waiting' |
    // 'notifInbox' | 'notifDm'). Installs the default into S.settings when
    // absent (old persisted settings) so slider edits always mutate a
    // persisted object.
    var HAPTIC_KINDS = {
        ring:        { key: 'hapticRingPattern',        def: { pulse: 150, gap: 80, pulses: 2 } },
        waiting:     { key: 'hapticWaitingPattern',     def: { pulse: 60, gap: 40, pulses: 2 } },
        notifInbox:  { key: 'hapticNotifInboxPattern',  def: { pulse: 120, gap: 90, pulses: 2 } },
        notifDm:     { key: 'hapticNotifDmPattern',     def: { pulse: 80, gap: 60, pulses: 2 } },
    };
    function getHapticPattern(kind) {
        if (!S.settings) S.settings = {};
        var entry = HAPTIC_KINDS[kind] || HAPTIC_KINDS.ring;
        var cfg = S.settings[entry.key];
        if (!cfg || typeof cfg !== 'object') {
            cfg = { pulse: entry.def.pulse, gap: entry.def.gap, pulses: entry.def.pulses };
            S.settings[entry.key] = cfg;
        }
        return cfg;
    }

    // Haptic cue (mobile) when a NEW incoming ring starts — a distinct,
    // longer ring-like pattern so it's felt as "someone is calling" (vs the
    // short double-buzz of the ring→waiting cue). Uses the tuned pattern from
    // Settings → Voice → Haptics. Gated by Settings → Voice → Haptics →
    // "Vibrate on incoming calls". navigator.vibrate is a no-op on
    // browsers/devices without a vibrator, so the API check is enough.
    function vibrateIncomingRingCue() {
        if (S.settings && S.settings.hapticIncoming === false) return;
        if (typeof navigator === 'undefined' || !navigator.vibrate) return;
        try { navigator.vibrate(buildHapticPattern(getHapticPattern('ring'))); } catch (_) {}
    }

    // Repeating haptic ticker for a PROLONGED unanswered ring: instead of one
    // pulse at ring start, buzz once per ringtone cycle so the call keeps being
    // felt until it's answered/declined/times out. Default ringtone cycles at
    // 1100ms (see playDefaultRingtone's repeat); a custom ringtone re-syncs the
    // cadence to its decoded length via resyncRingHapticTicker. Runs only while
    // an incoming ring is active (S.incomingCall); each buzz is gated by the
    // same Settings → Voice → "Vibrate on incoming calls" toggle.
    function startRingHapticTicker() {
        stopRingHapticTicker();
        // Default ringtone cycle (playDefaultRingtone repeats every 1100ms).
        S._ringHapticCycleMs = 1100;
        // The first cue fires immediately (the single-pulse behavior)…
        vibrateIncomingRingCue();
        // …then once per ringtone cycle. Battery-friendly mode: repeats are
        // skipped while the device is low on battery or backgrounded too long,
        // but the timer keeps running so buzzes resume the moment conditions
        // improve (the user plugs in / returns to the app).
        startBatteryPoll();
        tickRingHaptic();
    }

    function tickRingHaptic() {
        S._ringHapticTimer = setTimeout(function () {
            // The ring ended or flipped to waiting — stop ticking entirely.
            if (!S.incomingCall) return;
            if (!hapticRepeatsSuppressed()) {
                vibrateIncomingRingCue();
            }
            tickRingHaptic();
        }, S._ringHapticCycleMs || 1100);
    }

    // Custom-ringtone path: re-sync the buzz cadence to the decoded audio
    // length so a 1-30s file buzzes once per actual loop instead of the
    // default 1.1s cadence. The pending timer fires at most once at the old
    // cadence; subsequent ticks use the ringtone's real cycle.
    function resyncRingHapticTicker(cycleMs) {
        if (!S.incomingCall || !S._ringHapticTimer || !(cycleMs > 0)) return;
        S._ringHapticCycleMs = cycleMs;
    }

    function stopRingHapticTicker() {
        if (S._ringHapticTimer) {
            clearTimeout(S._ringHapticTimer);
            S._ringHapticTimer = null;
        }
        S._ringHapticCycleMs = null;
        stopBatteryPoll();
    }

    // ------------------------------------------------------------------
    // Battery-friendly haptics: skip REPEATING buzzes (the per-ringtone-cycle
    // ring ticker) while the device is low on battery or the app has been
    // backgrounded for a while. One-shot cues (first ring buzz, waiting flip,
    // notifications) still fire — repeats are the battery drain. Thresholds are
    // configurable in Settings → Voice → Haptics; the whole mode can be turned
    // off. Uses the Battery Status API (Chrome/Android; Firefox uses a
    // permission prompt; Safari/iOS desktop unsupported → treated as "not low").
    //
    // Backgrounded-time tracking: `document.visibilityState` is authoritative
    // on mobile (the page is hidden when another app/notification shade is
    // up). We record when we became hidden and how long we've been hidden on
    // each tick; the hidden-start timestamp survives via a monotonic clock so
    // a 15-min backgrounding is measured correctly even if ticks are delayed.
    var _bgStartedMs = null;
    function _updateBackgroundStart() {
        if (typeof document === 'undefined') return;
        if (document.visibilityState === 'hidden') {
            if (_bgStartedMs === null) _bgStartedMs = Date.now();
        } else {
            _bgStartedMs = null;
        }
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', _updateBackgroundStart);
    }

    // How many minutes the app has been continuously backgrounded (0 if
    // visible). Clamped to 0 so a negative (clock skew) never triggers. The
    // _bgOverrideMinutes hook lets tests simulate a backgrounding without a
    // real visibility change (headless pages are always "visible").
    function getBackgroundedMinutes() {
        if (S && S._bgOverrideMinutes != null) {
            return Math.max(0, S._bgOverrideMinutes);
        }
        _updateBackgroundStart();
        if (_bgStartedMs === null) return 0;
        return Math.max(0, Math.round((Date.now() - _bgStartedMs) / 60000));
    }

    // Resolves with the current battery level in % (0-100), or null when the
    // Battery Status API is unavailable (treated as "not low"). Cached per
    // call; the API is cheap to poll.
    function getBatteryLevel() {
        if (typeof navigator === 'undefined' || !navigator.getBattery) {
            return Promise.resolve(null);
        }
        try {
            return navigator.getBattery().then(function (b) {
                return (b && typeof b.level === 'number') ? Math.round(b.level * 100) : null;
            }).catch(function () { return null; });
        } catch (_) {
            return Promise.resolve(null);
        }
    }

    // True when battery-friendly mode is enabled AND the device currently
    // qualifies (low battery or backgrounded too long). Repeats should be
    // skipped; one-shot cues should NOT be gated by this.
    function hapticRepeatsSuppressed() {
        if (!S.settings || S.settings.hapticBatteryFriendly === false) return false;
        // Thresholds are customizable; a threshold of 0 disables that half of
        // the check entirely (so "never skip" is possible).
        var bgThr = (S.settings.hapticBackgroundThreshold != null) ? S.settings.hapticBackgroundThreshold : 10;
        if (bgThr > 0 && getBackgroundedMinutes() >= bgThr) return true;
        // Battery check is async; for the synchronous ticker path we cache the
        // last result and re-poll in the background (see refreshBatteryCache).
        if (S._batteryLow === true) return true;
        return false;
    }

    // Async refresh of the cached battery-low flag (polled on an interval while
    // a ring is active so the ticker's synchronous check stays cheap and
    // current). Stops when no ring is active.
    function refreshBatteryCache() {
        // A test/injected override wins over the real Battery API so behavior
        // is deterministic (headless browsers may expose a stub API).
        if (S && S._batteryOverridePct != null) {
            var thrO = S.settings && typeof S.settings.hapticBatteryThreshold === 'number'
                ? S.settings.hapticBatteryThreshold : 20;
            S._batteryLow = thrO > 0 && S._batteryOverridePct <= thrO;
            return;
        }
        getBatteryLevel().then(function (pct) {
            if (pct === null) return; // no Battery API — leave the cached flag alone
            var thr = S.settings && typeof S.settings.hapticBatteryThreshold === 'number'
                ? S.settings.hapticBatteryThreshold : 20;
            // A threshold of 0 disables the battery half of the check.
            S._batteryLow = thr > 0 && pct <= thr;
        });
    }
    // Re-check battery once a minute while a ring is active.
    function startBatteryPoll() {
        stopBatteryPoll();
        refreshBatteryCache();
        S._batteryPollTimer = setInterval(refreshBatteryCache, 60000);
    }
    function stopBatteryPoll() {
        if (S._batteryPollTimer) {
            clearInterval(S._batteryPollTimer);
            S._batteryPollTimer = null;
        }
    }

    // Brief haptic cue (mobile) when an incoming ring flips to the waiting
    // state — the green→red badge transition — so it's felt as well as seen.
    // Respects Settings → Voice → Haptics; navigator.vibrate is a no-op on
    // browsers/devices without a vibrator, so the API check is enough.
    function vibrateWaitingCue() {
        if (S.settings && S.settings.hapticWaiting === false) return;
        if (typeof navigator === 'undefined' || !navigator.vibrate) return;
        try { navigator.vibrate(buildHapticPattern(getHapticPattern('waiting'))); } catch (_) {}
    }

    // Haptic cue (mobile) for notifications — 'notifInbox' (a mention/reply
    // landed in the notification box) or 'notifDm' (a new DM message arrived).
    // Each is gated by its own toggle in Settings → Notifications → Haptic
    // Alerts and uses its own tunable { pulse, gap, pulses } pattern.
    function vibrateNotifCue(kind) {
        if (kind === 'notifInbox' && S.settings && S.settings.hapticNotifInbox === false) return;
        if (kind === 'notifDm' && S.settings && S.settings.hapticNotifDm === false) return;
        if (typeof navigator === 'undefined' || !navigator.vibrate) return;
        try { navigator.vibrate(buildHapticPattern(getHapticPattern(kind))); } catch (_) {}
    }

    // "Test pattern" buttons in Settings → Voice → Haptics: buzz immediately
    // with the configured pattern, bypassing the enable toggles so power users
    // can tune intensity/duration while the cue is disabled.
    function testHapticPattern(kind) {
        if (typeof navigator === 'undefined' || !navigator.vibrate) return;
        try { navigator.vibrate(buildHapticPattern(getHapticPattern(kind))); } catch (_) {}
    }

    // Reset a haptic pattern back to its default ({ pulse, gap, pulses } from
    // HAPTIC_KINDS) and refresh the slider UI/labels.
    function resetHapticPattern(kind) {
        var entry = HAPTIC_KINDS[kind] || HAPTIC_KINDS.ring;
        if (!S.settings) S.settings = {};
        S.settings[entry.key] = { pulse: entry.def.pulse, gap: entry.def.gap, pulses: entry.def.pulses };
        saveSettings();
        applySettingsToUI();
        updateSettingsLabels();
    }

    function showToast(msg) {
        if (typeof window.showToast === 'function') {
            window.showToast(msg);
            return;
        }
        if (typeof toast === 'function') { toast(msg); return; }
        var t = el('toast-container');
        if (t) {
            var d = document.createElement('div');
            d.className = 'toast';
            d.textContent = msg;
            t.appendChild(d);
            setTimeout(function () { d.remove(); }, 3000);
        }
    }

    // ------------------------------------------------------------------
    // View tracking (bar visibility rules)
    // ------------------------------------------------------------------
    function currentViewKey() {
        if (typeof viewMode !== 'undefined') {
            if (viewMode === 'servers') return 'srv:' + (typeof currentChannelId !== 'undefined' ? currentChannelId : '');
            if (viewMode === 'dms') return 'dm:' + (typeof currentDmChannelId !== 'undefined' ? currentDmChannelId : '');
        }
        return '';
    }

    function checkView() {
        var key = currentViewKey();
        if (key !== S._viewLast) {
            S._viewLast = key;
            onViewChanged();
        }
    }

    function onViewChanged() {
        syncOverlayBounds();
        if (!S.connected) return;
        // NOTE: the voice channel view is NOT closed here. Closing it on view
        // changes races with programmatic re-renders (e.g. a late
        // selectServer/auto-select resetting currentChannelId) which would
        // yank the popup shut right after the user opened it. Instead the
        // channel/DM/server CLICK handlers in chat.js close it on genuine
        // user clicks (event.isTrusted) — instant and race-free.
        updateDmCallUI();
        updateBarVisibility();
    }

    // Fixed overlays (voice popup, DM panel, bars) must exactly match the
    // text area, which starts at the right edge of the server strip + sidebar.
    // Reading .main's rect handles every viewport/sidebar width (including the
    // 340px ultrawide sidebar) instead of hardcoding a calc().
    function syncOverlayBounds() {
        var main = document.querySelector('.main');
        if (!main) return;
        var left = main.getBoundingClientRect().left;
        // The voice channel view + DM panel are their OWN channel view: they
        // fill the text area between the chat header and the chat input (the
        // message list's rect), instead of floating over it. The floating
        // voice bar / DM mini bar only snap when the user hasn't dragged them
        // (a saved drag position means the user put it where they want it).
        var body = document.querySelector('.chat-body');
        var top = 56;
        var bottom = 0;
        if (body) {
            var r = body.getBoundingClientRect();
            top = r.top;
            bottom = window.innerHeight - r.bottom;
        }
        ['voice-popup', 'dm-call-panel'].forEach(function (id) {
            var el2 = document.getElementById(id);
            if (!el2) return;
            if (id === 'dm-call-panel') {
                if (S.dmCallExpanded) {
                    // Expanded: covers the ENTIRE viewport (server strip +
                    // sidebar + chat header + input) so you see only the call.
                    el2.style.left = '0';
                    el2.style.top = '0';
                    el2.style.bottom = '0';
                    el2.style.height = 'auto';
                } else {
                    // Collapsed: top panel of the text area (measured chat-body
                    // top, below the chat header); the user can drag the bottom
                    // handle to resize it (saved in S.dmPanelHeight), otherwise
                    // the CSS default clamp(460px, 68vh, 78vh) applies — DM
                    // calls are 1-on-1, so the panel can be tall without
                    // scrolling the tiles.
                    el2.style.left = left + 'px';
                    el2.style.top = top + 'px';
                    el2.style.bottom = '';
                    var dh = clampDmPanelHeight(S.dmPanelHeight);
                    el2.style.height = dh ? dh + 'px' : '';
                }
            } else if (S.voiceFullscreen) {
                // Voice view fullscreen: covers the ENTIRE viewport too.
                el2.style.left = '0';
                el2.style.top = '0';
                el2.style.bottom = '0';
                el2.style.height = 'auto';
            } else {
                // Voice channel view: its own channel view covering the whole
                // chat column — the channel name header at the top and the
                // text input space at the bottom are covered too.
                el2.style.left = left + 'px';
                el2.style.top = '0';
                el2.style.bottom = '0';
                el2.style.height = 'auto'; // override the CSS 52vh so top+bottom win
            }
        });        ['voice-bar', 'dm-mini-bar'].forEach(function (id) {
            var el2 = document.getElementById(id);
            if (!el2) return;

            var key = id === 'voice-bar' ? 'voice_bar_pos' : 'dm_mini_bar_pos';
            if (localStorage.getItem(key)) return; // user dragged it — keep position
            // Snap back to the default corner: clear inline top/bottom so the
            // stylesheet's top: 12px anchor applies again.
            el2.style.left = left + 'px';
            el2.style.top = '';
            el2.style.bottom = '';
        });
    }

    // Drag-to-move a floating overlay (voice bar / DM mini bar). Pointer
    // events give smooth dragging on mouse + touch; the position is clamped
    // to the viewport and persisted so it survives reloads and view changes.
    function makeDraggable(id, storageKey) {
        var el2 = document.getElementById(id);
        if (!el2) return;
        // Restore a previously saved position. The CSS anchors these bars with
        // top: 12px — if we set bottom but leave top resolved, the browser
        // STRETCHES the fixed element between the two constraints instead of
        // moving it (the bar looked glued to the edge and grew on drag).
        // Override bottom with auto so top/left alone position it.
        try {
            var saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
            if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
                el2.style.left = saved.left + 'px';
                el2.style.top = saved.top + 'px';
                el2.style.bottom = 'auto';
            }
        } catch (_) {}

        var dragging = false;
        var startX = 0, startY = 0, origLeft = 0, origTop = 0;

        el2.addEventListener('pointerdown', function (e) {
            // Don't start a drag from the control buttons (they stay clickable)
            if (e.target.closest('button')) return;
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            var r = el2.getBoundingClientRect();
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            origLeft = r.left;
            origTop = r.top;
            // Anchor by top/left only for the whole drag — see restore above.
            el2.style.bottom = 'auto';
            el2.classList.add('dragging');
            try { el2.setPointerCapture(e.pointerId); } catch (_) {}
            e.preventDefault();
        });

        el2.addEventListener('pointermove', function (e) {
            if (!dragging) return;
            var dx = e.clientX - startX;
            var dy = e.clientY - startY;
            var w = el2.offsetWidth;
            var h = el2.offsetHeight;
            var maxLeft = Math.max(8, window.innerWidth - w - 8);
            var maxTop = Math.max(8, window.innerHeight - h - 8);
            el2.style.left = Math.min(Math.max(8, origLeft + dx), maxLeft) + 'px';
            el2.style.top = Math.min(Math.max(8, origTop + dy), maxTop) + 'px';
            e.preventDefault();
        });

        function endDrag() {
            if (!dragging) return;
            dragging = false;
            el2.classList.remove('dragging');
            try {
                var r = el2.getBoundingClientRect();
                localStorage.setItem(storageKey, JSON.stringify({
                    left: r.left,
                    top: r.top,
                }));
            } catch (_) {}
        }
        el2.addEventListener('pointerup', endDrag);
        el2.addEventListener('pointercancel', endDrag);
    }

    // For server rooms: the small bar is the persistent control while
    // anywhere EXCEPT the voice channel view itself. When the voice channel
    // view (popup) is open, it replaces the bar — it has its own controls.
    function updateBarVisibility() {
        if (!S.connected) {
            hideBar();
            return;
        }
        if (S.roomType === 'server') {
            if (S.popupOpen) {
                // Voice channel view is open → it IS the channel view (it has
                // its own mute/deafen/camera/screen/leave controls).
                hideBar();
            } else {
                // Anywhere else → small persistent bar
                showBar();
            }
        } else {
            // DM call: never show the server voice-bar. The DM mini bar
            // (draggable, top-anchored) is the persistent control when NOT in
            // the DM chat view — updateDmCallUI() handles panel vs mini bar.
            hideBar();
        }
    }

    function updateDmCallUI() {
        if (!S.dmCallActive) return;
        var inDmView = typeof currentDmChannelId !== 'undefined' && S.dmChannelId && currentDmChannelId === S.dmChannelId;
        if (inDmView) {
            hideMiniBar();
            if (S.dmPanelOpen !== false) showDmPanel();
        } else {
            hideDmPanel();
            showMiniBar();
        }
    }

    // ------------------------------------------------------------------
    // UI: bar
    // ------------------------------------------------------------------
    function showBar() {
        var bar = el('voice-bar');
        if (!bar) return;
        syncOverlayBounds();
        bar.style.display = 'flex';
        var name = el('voice-bar-name');
        if (name) {
            if (S.roomType === 'dm' && S.dmCallPartner) {
                var pn = memberDisplayName(S.dmCallPartner.id, S.dmCallPartner);
                name.innerHTML = 'In call with ' + memberNameSpan(S.dmCallPartner.id, pn);
            } else {
                name.textContent = S.channelName || 'Voice Connected';
            }
        }
        updateSelfUI();
        renderBar();
    }

    function hideBar() {
        var bar = el('voice-bar');
        if (bar) bar.style.display = 'none';
    }

    function bindBarControls() {
        var bar = el('voice-bar');
        if (!bar) return;
        bindClick(bar, 'voice-bar-mute', function () { toggleMute(); });
        bindClick(bar, 'voice-bar-deafen', function () { toggleDeafen(); });
        bindClick(bar, 'voice-bar-camera', function () { toggleCamera(); });
        bindClick(bar, 'voice-bar-cam-opt', function (e) { openCamOptMenu(this); });
        bindClick(bar, 'voice-bar-screen', function () { toggleScreen(); });
        bindClick(bar, 'voice-bar-soundboard', function () {
            var sbOverlay = document.getElementById('soundboard-overlay');
            if (sbOverlay) sbOverlay.style.display = 'flex';
            if (window._loadSoundboardClips) window._loadSoundboardClips();
        });
        bindClick(bar, 'voice-bar-leave', function () { leaveVoice(); });
        bindClick(bar, 'voice-bar-popup', function () {
            // The ☰ button redirects us INTO the voice channel view.
            if (S.roomType === 'server') navigateToVoiceChannel();
        });
    }

    function renderBar() {
        var micBtn = el('voice-bar-mute');
        if (micBtn) {
            micBtn.innerHTML = S.muted ? icon('mic-off') : icon('mic');
            micBtn.classList.toggle('active', S.muted);
            micBtn.classList.toggle('locked', S.forceMuted);
            micBtn.title = S.forceMuted ? 'Server muted' : (S.muted ? 'Unmute' : 'Mute');
        }
        var deafBtn = el('voice-bar-deafen');
        if (deafBtn) {
            deafBtn.innerHTML = S.deafened ? icon('volume-off') : icon('volume-on');
            deafBtn.classList.toggle('active', S.deafened);
            deafBtn.classList.toggle('locked', S.forceDeafened);
            deafBtn.title = S.forceDeafened ? 'Server deafened' : (S.deafened ? 'Undeafen' : 'Deafen');
        }
        var camBtn = el('voice-bar-camera');
        if (camBtn) {
            camBtn.innerHTML = S.cameraOn ? icon('video') : icon('camera');
            camBtn.classList.toggle('active', S.cameraOn);
        }
        var scrBtn = el('voice-bar-screen');
        if (scrBtn) {
            scrBtn.classList.toggle('active', S.screenOn);
        }
    }

    // ------------------------------------------------------------------
    // UI: server voice channel view (top panel of the text area)
    // ------------------------------------------------------------------
    function toggleServerPopup() {
        S.popupOpen = !S.popupOpen;
        if (S.popupOpen) showPopup(); else hidePopup();
        updateBarVisibility();
    }

    // Enter the voice channel view (its own channel view at the top of the
    // text area — NOT an overlay). The ☰ button on the small bar redirects
    // here, just like clicking the voice channel again while already in it.
    function navigateToVoiceChannel() {
        if (S.roomType !== 'server' || !S.channelId || !S.connected) return;
        showPopup();
        updateBarVisibility();
    }

    function exitVoiceChannelView() {
        hidePopup();
        updateBarVisibility();
    }

    function showPopup() {
        var pop = el('voice-popup');
        if (!pop) return;
        // Always start in non-fullscreen when opening the popup
        S.voiceFullscreen = false;
        try { localStorage.removeItem('voice_fullscreen'); } catch (_) {}
        applyVoiceFullscreen();
        syncOverlayBounds();
        S.popupOpen = true;
        pop.style.display = 'flex';
        var name = el('voice-popup-name');
        if (name) name.textContent = S.channelName || 'Voice Channel';
        renderPopup();
        renderSelfPreview();
    }

    function hidePopup() {
        S.popupOpen = false;
        var pop = el('voice-popup');
        if (pop) pop.style.display = 'none';
    }

    function bindPopupControls() {
        var pop = el('voice-popup');
        if (!pop) return;
        bindClick(pop, 'voice-popup-close', function () { exitVoiceChannelView(); });
        bindClick(pop, 'voice-popup-fullscreen', function () { toggleVoiceFullscreen(); });
        bindClick(pop, 'voice-popup-mute', function () { toggleMute(); });
        bindClick(pop, 'voice-popup-deafen', function () { toggleDeafen(); });
        bindClick(pop, 'voice-popup-camera', function () { toggleCamera(); });
        bindClick(pop, 'voice-popup-cam-opt', function (e) { openCamOptMenu(this); });
        bindClick(pop, 'voice-popup-screen', function () { toggleScreen(); });
        bindClick(pop, 'voice-popup-pip', function () { togglePiP(this); });
        bindClick(pop, 'voice-popup-leave', function () { leaveVoice(); });
        var pmv = pop.querySelector('#voice-popup-mic-volume');
        if (pmv) pmv.addEventListener('input', function (e) { setMicVolume(parseInt(e.target.value, 10)); updateSettingsLabels(); });
        var psv = pop.querySelector('#voice-popup-speaker-volume');
        if (psv) psv.addEventListener('input', function (e) { setSpeakerVolume(parseInt(e.target.value, 10)); updateSettingsLabels(); });
        var pns = pop.querySelector('#voice-popup-noise-suppression');
        if (pns) pns.addEventListener('change', function (e) { setNoiseSuppression(e.target.value); });

        // Reset buttons — restore mic/speaker to 100% (voice channel view popup)
        var pmvReset = pop.querySelector('#voice-popup-mic-reset');
        if (pmvReset) pmvReset.addEventListener('click', function () { setMicVolume(100); applySettingsToUI(); });
        var psvReset = pop.querySelector('#voice-popup-speaker-reset');
        if (psvReset) psvReset.addEventListener('click', function () { setSpeakerVolume(100); applySettingsToUI(); });

        // Settings-modal sliders (same bindings)
        var smv = document.getElementById('voice-mic-volume');
        if (smv) smv.addEventListener('input', function (e) { setMicVolume(parseInt(e.target.value, 10)); updateSettingsLabels(); });
        var ssv = document.getElementById('voice-speaker-volume');
        if (ssv) ssv.addEventListener('input', function (e) { setSpeakerVolume(parseInt(e.target.value, 10)); updateSettingsLabels(); });
        // Reset buttons — restore mic/speaker to 100% (settings modal)
        var smvReset = document.getElementById('voice-mic-reset');
        if (smvReset) smvReset.addEventListener('click', function () { setMicVolume(100); applySettingsToUI(); });
        var ssvReset = document.getElementById('voice-speaker-reset');
        if (ssvReset) ssvReset.addEventListener('click', function () { setSpeakerVolume(100); applySettingsToUI(); });
        var sns = document.getElementById('voice-noise-suppression');
        var nsDesc = document.getElementById('ns-description');
        var nsDescs = {
            'rnnoise': 'RNNoise suppresses keyboard, fan & background noise on-device, right in your browser.',
            'rnnoise-gate': 'RNNoise + Gate chains the neural model with a noise gate and compressor for the deepest on-device suppression.',
            'browser': 'Uses the browser\u2019s built-in noise suppression. Changes apply the next time your mic starts.',
            'off': 'No noise suppression — raw microphone audio.'
        };
        function updateNsDesc(val) { if (nsDesc) nsDesc.textContent = nsDescs[val] || nsDescs['rnnoise']; }
        if (sns) {
            sns.addEventListener('change', function (e) { setNoiseSuppression(e.target.value); updateNsDesc(e.target.value); });
            updateNsDesc(sns.value);
        }
        var sec = document.getElementById('voice-echo-cancellation');
        if (sec) sec.addEventListener('change', function (e) { setEchoCancellation(e.target.checked); });
        var saq = document.getElementById('voice-send-audio-quality');
        if (saq) saq.addEventListener('change', function (e) {
            S.settings.sendAudioQuality = e.target.value;
            saveSettings();
            updateSettingsLabels();
            restartMicForSettings();
        });
        var raq = document.getElementById('voice-recv-audio-quality');
        if (raq) raq.addEventListener('change', function (e) {
            S.settings.recvAudioQuality = e.target.value;
            saveSettings();
            updateSettingsLabels();
            if (S.connected) sendVoiceState();
        });
        var ssaq = document.getElementById('voice-send-screen-audio-quality');
        if (ssaq) ssaq.addEventListener('change', function (e) {
            S.settings.sendScreenAudioQuality = e.target.value;
            saveSettings();
        });
        var rsaq = document.getElementById('voice-recv-screen-audio-quality');
        if (rsaq) rsaq.addEventListener('change', function (e) {
            S.settings.recvScreenAudioQuality = e.target.value;
            saveSettings();
            updateSettingsLabels();
            if (S.connected) sendVoiceState();
        });
        // --- Test Mic button (hear-self) ---
        var _hearSelfBtn = document.getElementById('voice-hear-self-btn');
        var _hearSelfMeterWrap = document.getElementById('voice-hear-self-meter-wrap');
        var _hearSelfMeter = document.getElementById('voice-hear-self-meter');
        var _hearSelfDb = document.getElementById('voice-hear-self-db');
        var _hearSelfStatus = document.getElementById('voice-hear-self-status');
        var _hearSelfNsMode = document.getElementById('voice-hear-self-ns-mode');
        var _hearSelfGain = document.getElementById('voice-hear-self-gain');
        var _hearSelfStream = null;
        var _hearSelfCtx = null;
        var _hearSelfAnalyser = null;
        var _hearSelfRafId = null;
        var _hearSelfSink = null;
        var _hearSelfNsCtx = null;
        var _hearSelfNsStream = null;
        var _hearSelfGateTimer = null;

        function startHearSelfTest() {
            var nsMode = (S.settings && S.settings.noiseSuppressionMode) || 'rnnoise';
            var micVol = (S.settings && S.settings.micVolume !== undefined) ? S.settings.micVolume : 100;
            var constraints = { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } };
            // Update UI immediately (before async getUserMedia)
            S.settings.hearSelf = true;
            saveSettings();
            if (_hearSelfBtn) { _hearSelfBtn.textContent = '\u23F9 Stop Test'; _hearSelfBtn.classList.remove('btn-primary'); _hearSelfBtn.classList.add('btn-danger'); }
            if (_hearSelfMeterWrap) _hearSelfMeterWrap.style.display = 'block';
            if (_hearSelfStatus) _hearSelfStatus.textContent = '\uD83D\uDD34 Starting mic...';
            if (_hearSelfNsMode) _hearSelfNsMode.textContent = nsMode;
            if (_hearSelfGain) _hearSelfGain.textContent = micVol + '%';
            window._stopHearSelfTest = stopHearSelfTest;
            navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
                _hearSelfStream = stream;
                var ctx = new (window.AudioContext || window.webkitAudioContext)();
                _hearSelfCtx = ctx;
                var source = ctx.createMediaStreamSource(stream);
                // --- Build standalone noise suppression chain ---
                function buildNsChain(rawSource) {
                    if (nsMode === 'off') return Promise.resolve(rawSource);
                    if (nsMode === 'browser') {
                        return navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: true, echoCancellation: false, autoGainControl: false } }).then(function (nsStream) {
                            var nsCtx2 = new (window.AudioContext || window.webkitAudioContext)();
                            var nsSrc2 = nsCtx2.createMediaStreamSource(nsStream);
                            var nsDest2 = nsCtx2.createMediaStreamDestination();
                            nsSrc2.connect(nsDest2);
                            _hearSelfNsCtx = nsCtx2;
                            _hearSelfNsStream = nsStream;
                            return ctx.createMediaStreamSource(nsDest2.stream);
                        }).catch(function () { return rawSource; });
                    }
                    // RNNoise / RNNoise+Gate: build a standalone worklet chain
                    if (nsMode === 'rnnoise' || nsMode === 'rnnoise-gate') {
                        if (!window.AudioWorkletNode || !window.AudioContext) return Promise.resolve(rawSource);
                        return Promise.resolve().then(function () {
                            var nsCtx = new AudioContext({ sampleRate: 48000 });
                            if (Math.abs(nsCtx.sampleRate - 48000) > 1) { try { nsCtx.close(); } catch(_){} return rawSource; }
                            var binPromise = _nsWasmBinary ? Promise.resolve(_nsWasmBinary) :
                                fetch('/rnnoise/sapphi-rnnoise.wasm').then(function (r) { return r.ok ? r.arrayBuffer() : null; });
                            return binPromise.then(function (wasmBinary) {
                                if (!wasmBinary) { try { nsCtx.close(); } catch(_){} return rawSource; }
                                _nsWasmBinary = wasmBinary;
                                return nsCtx.audioWorklet.addModule('/rnnoise/sapphi-worklet.js').then(function () {
                                    var nsSrc = nsCtx.createMediaStreamSource(stream);
                                    var worklet = new AudioWorkletNode(nsCtx, '@sapphi-red/web-noise-suppressor/rnnoise', {
                                        numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit',
                                        outputChannelCount: [1],
                                        processorOptions: { wasmBinary: wasmBinary, maxChannels: 1 },
                                    });
                                    var nsDest = nsCtx.createMediaStreamDestination();
                                    nsSrc.connect(worklet);
                                    if (nsMode === 'rnnoise-gate') {
                                        var gateAnalyser = nsCtx.createAnalyser(); gateAnalyser.fftSize = 256;
                                        var gateGain = nsCtx.createGain(); gateGain.gain.value = 1.0;
                                        var compressor = nsCtx.createDynamicsCompressor();
                                        compressor.threshold.value = -30; compressor.knee.value = 12;
                                        compressor.ratio.value = 4; compressor.attack.value = 0.003; compressor.release.value = 0.15;
                                        worklet.connect(gateAnalyser); worklet.connect(gateGain);
                                        gateGain.connect(compressor); compressor.connect(nsDest);
                                        var gateData = new Uint8Array(gateAnalyser.frequencyBinCount);
                                        var _gateOpen = true, _gateCloseTime = 0;
                                        _hearSelfGateTimer = setInterval(function () {
                                            if (!_hearSelfCtx) { clearInterval(_hearSelfGateTimer); _hearSelfGateTimer = null; return; }
                                            gateAnalyser.getByteTimeDomainData(gateData);
                                            var sum = 0; for (var k = 0; k < gateData.length; k++) { var v2 = (gateData[k] - 128) / 128; sum += v2 * v2; }
                                            var rms = Math.sqrt(sum / gateData.length) * 255;
                                            var now = nsCtx.currentTime * 1000;
                                            if (rms > 15) { if (!_gateOpen) { gateGain.gain.setTargetAtTime(1.0, nsCtx.currentTime, 0.005); _gateOpen = true; } _gateCloseTime = 0; }
                                            else { if (_gateOpen && _gateCloseTime === 0) _gateCloseTime = now; if (_gateOpen && _gateCloseTime > 0 && (now - _gateCloseTime) > 200) { gateGain.gain.setTargetAtTime(0.0, nsCtx.currentTime, 0.03); _gateOpen = false; } }
                                        }, 16);
                                    } else {
                                        worklet.connect(nsDest);
                                    }
                                    _hearSelfNsCtx = nsCtx;
                                    _hearSelfNsStream = nsDest.stream;
                                    return ctx.createMediaStreamSource(nsDest.stream);
                                });
                            });
                        }).catch(function () { return rawSource; });
                    }
                    return Promise.resolve(rawSource);
                }

                buildNsChain(source).then(function (input) {
                    // Analyser for meter
                    var analyser = ctx.createAnalyser();
                    analyser.fftSize = 512;
                    input.connect(analyser);
                    _hearSelfAnalyser = analyser;
                    // Connect to speakers
                    var gain = ctx.createGain();
                    gain.gain.value = micVol / 100;
                    _hearSelfSink = gain;
                    S._hearSelfSink = gain;
                    input.connect(gain);
                    gain.connect(ctx.destination);
                    // Update meter
                    var buf = new Uint8Array(analyser.fftSize);
                    function updateMeter() {
                        if (!_hearSelfAnalyser) return;
                        analyser.getByteTimeDomainData(buf);
                        var sum = 0;
                        for (var i = 0; i < buf.length; i++) {
                            var v = (buf[i] - 128) / 128;
                            sum += v * v;
                        }
                        var rms = Math.sqrt(sum / buf.length);
                        var pct = Math.min(100, Math.round(rms * 200));
                        var db = rms > 0 ? Math.round(20 * Math.log10(rms)) : -96;
                        if (_hearSelfMeter) _hearSelfMeter.style.width = pct + '%';
                        if (_hearSelfDb) _hearSelfDb.textContent = db + ' dB';
                        _hearSelfRafId = requestAnimationFrame(updateMeter);
                    }
                    updateMeter();
                    if (_hearSelfStatus) _hearSelfStatus.textContent = '\uD83D\uDD34 Listening...';
                });
            }).catch(function (e) {
                console.error('Hear-self mic error:', e);
                stopHearSelfTest();
                if (_hearSelfStatus) _hearSelfStatus.innerHTML = icon('warning') + ' Mic access denied';
            });
        }
        function stopHearSelfTest() {
            if (_hearSelfRafId) { cancelAnimationFrame(_hearSelfRafId); _hearSelfRafId = null; }
            _hearSelfAnalyser = null;
            if (_hearSelfSink) { try { _hearSelfSink.disconnect(); } catch (_) {} _hearSelfSink = null; } S._hearSelfSink = null;
            if (_hearSelfGateTimer) { try { clearInterval(_hearSelfGateTimer); } catch (_) {} _hearSelfGateTimer = null; }
            if (_hearSelfNsCtx) { try { _hearSelfNsCtx.close(); } catch (_) {} _hearSelfNsCtx = null; }
            if (_hearSelfNsStream) { try { _hearSelfNsStream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {} _hearSelfNsStream = null; }
            if (_hearSelfCtx) { try { _hearSelfCtx.close(); } catch (_) {} _hearSelfCtx = null; }
            if (_hearSelfStream) { _hearSelfStream.getTracks().forEach(function (t) { t.stop(); }); _hearSelfStream = null; }
            S.settings.hearSelf = false;
            saveSettings();
            if (_hearSelfBtn) { _hearSelfBtn.innerHTML = icon('mic') + ' Start Test'; _hearSelfBtn.classList.remove('btn-danger'); _hearSelfBtn.classList.add('btn-primary'); }
            if (_hearSelfMeterWrap) _hearSelfMeterWrap.style.display = 'none';
            if (_hearSelfMeter) _hearSelfMeter.style.width = '0%';
            if (_hearSelfDb) _hearSelfDb.textContent = '';
            if (_hearSelfStatus) _hearSelfStatus.textContent = '';
            window._stopHearSelfTest = null;
        }
        if (_hearSelfBtn) {
            _hearSelfBtn.addEventListener('click', function () {
                if (S.settings.hearSelf) {
                    stopHearSelfTest();
                } else {
                    startHearSelfTest();
                }
            });
        }
        // Auto-stop hear-self when settings modal closes
        var settingsCloseBtn = document.querySelector('#settings-modal .settings-close');
        if (settingsCloseBtn) {
            settingsCloseBtn.addEventListener('click', function () {
                if (S.settings.hearSelf) stopHearSelfTest();
            });
        }
        var shi = document.getElementById('voice-haptic-incoming');
        if (shi) shi.addEventListener('change', function (e) {
            S.settings.hapticIncoming = !!e.target.checked;
            saveSettings();
        });
        var shw = document.getElementById('voice-haptic-waiting');
        if (shw) shw.addEventListener('change', function (e) {
            S.settings.hapticWaiting = !!e.target.checked;
            saveSettings();
        });
        // Haptic pattern tuning sliders — live-update the pattern + labels.
        var bindHapticSlider = function (id, kind, field) {
            var s = document.getElementById(id);
            if (!s) return;
            s.addEventListener('input', function (e) {
                var v = parseInt(e.target.value, 10);
                if (isNaN(v)) return;
                getHapticPattern(kind)[field] = v;
                saveSettings();
                updateSettingsLabels();
            });
        };
        bindHapticSlider('voice-haptic-ring-pulse', 'ring', 'pulse');
        bindHapticSlider('voice-haptic-ring-gap', 'ring', 'gap');
        bindHapticSlider('voice-haptic-ring-pulses', 'ring', 'pulses');
        bindHapticSlider('voice-haptic-waiting-pulse', 'waiting', 'pulse');
        bindHapticSlider('voice-haptic-waiting-gap', 'waiting', 'gap');
        bindHapticSlider('voice-haptic-waiting-pulses', 'waiting', 'pulses');
        // Test buttons — buzz immediately with the tuned pattern (bypasses the
        // enable toggles so the pattern can be tuned while the cue is off).
        var hrt = document.getElementById('voice-haptic-ring-test');
        if (hrt) hrt.addEventListener('click', function () { testHapticPattern('ring'); });
        var hwt = document.getElementById('voice-haptic-waiting-test');
        if (hwt) hwt.addEventListener('click', function () { testHapticPattern('waiting'); });
        // Reset buttons — restore each haptic pattern to its default.
        var bindHapticReset = function (id, kind) {
            var b = document.getElementById(id);
            if (!b) return;
            b.addEventListener('click', function () { resetHapticPattern(kind); });
        };
        bindHapticReset('voice-haptic-ring-reset', 'ring');
        bindHapticReset('voice-haptic-waiting-reset', 'waiting');
        bindHapticReset('notif-haptic-inbox-reset', 'notifInbox');
        bindHapticReset('notif-haptic-dm-reset', 'notifDm');
        // Battery-friendly haptics (Settings → Voice → Haptics).
        var hbf = document.getElementById('voice-haptic-battery-friendly');
        if (hbf) hbf.addEventListener('change', function (e) {
            S.settings.hapticBatteryFriendly = !!e.target.checked;
            saveSettings();
        });
        var hbt = document.getElementById('voice-haptic-battery-threshold');
        if (hbt) hbt.addEventListener('input', function (e) {
            var v = parseInt(e.target.value, 10);
            if (isNaN(v)) return;
            S.settings.hapticBatteryThreshold = v;
            saveSettings();
            refreshBatteryCache();
            updateSettingsLabels();
        });
        var hgt = document.getElementById('voice-haptic-background-threshold');
        if (hgt) hgt.addEventListener('input', function (e) {
            var v = parseInt(e.target.value, 10);
            if (isNaN(v)) return;
            S.settings.hapticBackgroundThreshold = v;
            saveSettings();
            updateSettingsLabels();
        });
        // Video quality (Settings → Voice)
        var sc = document.getElementById('voice-send-camera-res');
        if (sc) sc.addEventListener('change', function (e) { setSendRes('camera', e.target.value); });
        var ss = document.getElementById('voice-send-screen-res');
        if (ss) ss.addEventListener('change', function (e) { setSendRes('screen', e.target.value); });
        var rc = document.getElementById('voice-recv-camera-res');
        if (rc) rc.addEventListener('change', function (e) { setRecvRes('camera', e.target.value); });
        var rs = document.getElementById('voice-recv-screen-res');
        if (rs) rs.addEventListener('change', function (e) { setRecvRes('screen', e.target.value); });
        var rf = document.getElementById('voice-relay-video-fps');
        if (rf) rf.addEventListener('change', function (e) { S.settings.relayVideoFps = Math.max(1, Math.min(30, parseInt(e.target.value) || 30)); saveSettings(); });
        var jq = document.getElementById('voice-relay-jpeg-quality');
        if (jq) jq.addEventListener('change', function (e) { S.settings.relayVideoQuality = Math.max(0.1, Math.min(1.0, parseFloat(e.target.value) || 0.6)); saveSettings(); });
        var ml = document.getElementById('voice-manual-video-load');
        if (ml) ml.addEventListener('change', function (e) { setManualVideoLoad(e.target.checked); });
        var wd = document.getElementById('voice-video-watchdog-secs');
        if (wd) wd.addEventListener('change', function (e) { setVideoWatchdogSecs(e.target.value); });
        // Call diagnostics (Settings → Voice → Advanced)
        var dr = document.getElementById('voice-diag-refresh');
        if (dr) dr.addEventListener('click', function () { renderVoiceDiag(); });
        var dh = document.getElementById('voice-diag-heal');
        if (dh) dh.addEventListener('click', function () { healAndRejoin(); });
        var da = document.getElementById('voice-diag-auto');
        if (da) da.addEventListener('change', function (e) {
            if (e.target.checked) renderVoiceDiag();
        });
        startVoiceDiagPoll();
    }

    function updateSettingsLabels() {
        var mv = document.getElementById('voice-mic-volume-val');
        if (mv) mv.textContent = S.settings.micVolume + '%';
        var sv = document.getElementById('voice-speaker-volume-val');
        if (sv) sv.textContent = S.settings.speakerVolume + '%';
        var pmv = document.getElementById('voice-popup-mic-volume');
        if (pmv) pmv.value = S.settings.micVolume;
        var psv = document.getElementById('voice-popup-speaker-volume');
        if (psv) psv.value = S.settings.speakerVolume;
        var pmvV = document.getElementById('voice-popup-mic-volume-val');
        if (pmvV) pmvV.textContent = S.settings.micVolume + '%';
        var psvV = document.getElementById('voice-popup-speaker-volume-val');
        if (psvV) psvV.textContent = S.settings.speakerVolume + '%';
        var pns = document.getElementById('voice-popup-noise-suppression');
        if (pns) pns.value = S.settings.noiseSuppressionMode || 'rnnoise';
        // Haptic pattern tuning sliders (Settings → Voice → Haptics).
        var hrpv = document.getElementById('voice-haptic-ring-pulse-val');
        if (hrpv) hrpv.textContent = getHapticPattern('ring').pulse + 'ms';
        var hrgv = document.getElementById('voice-haptic-ring-gap-val');
        if (hrgv) hrgv.textContent = getHapticPattern('ring').gap + 'ms';
        var hrcv = document.getElementById('voice-haptic-ring-pulses-val');
        if (hrcv) hrcv.textContent = getHapticPattern('ring').pulses + '×';
        var hwpv = document.getElementById('voice-haptic-waiting-pulse-val');
        if (hwpv) hwpv.textContent = getHapticPattern('waiting').pulse + 'ms';
        var hwgv = document.getElementById('voice-haptic-waiting-gap-val');
        if (hwgv) hwgv.textContent = getHapticPattern('waiting').gap + 'ms';
        var hwcv = document.getElementById('voice-haptic-waiting-pulses-val');
        if (hwcv) hwcv.textContent = getHapticPattern('waiting').pulses + '×';
        // Notification haptic labels (Settings → Notifications).
        var nipv = document.getElementById('notif-haptic-inbox-pulse-val');
        if (nipv) nipv.textContent = getHapticPattern('notifInbox').pulse + 'ms';
        var nigv = document.getElementById('notif-haptic-inbox-gap-val');
        if (nigv) nigv.textContent = getHapticPattern('notifInbox').gap + 'ms';
        var nicv = document.getElementById('notif-haptic-inbox-pulses-val');
        if (nicv) nicv.textContent = getHapticPattern('notifInbox').pulses + '×';
        var ndpv = document.getElementById('notif-haptic-dm-pulse-val');
        if (ndpv) ndpv.textContent = getHapticPattern('notifDm').pulse + 'ms';
        var ndgv = document.getElementById('notif-haptic-dm-gap-val');
        if (ndgv) ndgv.textContent = getHapticPattern('notifDm').gap + 'ms';
        var ndcv = document.getElementById('notif-haptic-dm-pulses-val');
        if (ndcv) ndcv.textContent = getHapticPattern('notifDm').pulses + '×';
        // Battery-friendly labels (Settings → Voice → Haptics).
        var hbtv = document.getElementById('voice-haptic-battery-threshold-val');
        if (hbtv) hbtv.textContent = (S.settings.hapticBatteryThreshold != null ? S.settings.hapticBatteryThreshold : 20) + '%';
        var hgtv = document.getElementById('voice-haptic-background-threshold-val');
        if (hgtv) hgtv.textContent = (S.settings.hapticBackgroundThreshold != null ? S.settings.hapticBackgroundThreshold : 10) + ' min';
    }

    // Display name from the decrypted profile cache, falling back to username.
    function memberDisplayName(uid, m) {
        if (typeof userDisplayNameCache !== 'undefined' && userDisplayNameCache[uid] && userDisplayNameCache[uid].display_name) {
            return userDisplayNameCache[uid].display_name;
        }
        return (m && m.username) || 'Unknown';
    }

    // Display-name color + glow (same treatment as the chat/member list):
    // returns a CSS style string, or '' when the user has no custom color.
    function memberNameStyle(uid) {
        var style = '';
        if (uid && typeof userDisplayNameCache !== 'undefined' && userDisplayNameCache[uid]) {
            var color = userDisplayNameCache[uid].username_color;
            if (color) {
                style = 'color:' + color + ';';
                if (typeof getDisplayNameTextShadow === 'function') {
                    var border = userDisplayNameCache[uid].username_border_color;
                    style += 'text-shadow:' + getDisplayNameTextShadow(color, border) + ';';
                }
            }
        }
        return style;
    }

    // Wraps a display name in a colored span when the user has a custom color;
    // otherwise returns the plain escaped name.
    function memberNameSpan(uid, name) {
        var style = memberNameStyle(uid);
        return style ? '<span style="' + style + '">' + esc(name) + '</span>' : esc(name);
    }

    // Avatar HTML using the decrypted PFP pipeline (same as the channel list):
    // cached blob URL, or an async-loading placeholder with the initial letter.
    function memberAvatarHtml(uid, m, name, cls) {
        var entry = (typeof userDisplayNameCache !== 'undefined') ? userDisplayNameCache[uid] : null;
        var picId = (entry && entry.profile_picture_file_id) || null;
        var picKey = picId ? (uid + ':' + picId) : '';
        var picUrl = (picKey && typeof profilePicCache !== 'undefined' && profilePicCache[picKey]) ? profilePicCache[picKey] : null;
        var initial = (name || '?').charAt(0).toUpperCase();
        var speakingCls = (m.speaking && !(m.muted || m.force_muted)) ? ' speaking' : '';
        if (picUrl) {
            return '<div class="' + cls + speakingCls + '"><img class="voice-pfp-img" src="' + esc(picUrl) + '" alt=""></div>';
        }
        if (picId) {
            if (!S._pfpLoading[picKey]) {
                S._pfpLoading[picKey] = true;
                try { getProfilePicUrl(picId, uid); } catch (_) {}
            }
            return '<div class="' + cls + ' voice-pfp-load' + speakingCls + '" data-profile-pic-load="' + esc(picKey) + '">' + esc(initial) + '</div>';
        }
        return '<div class="' + cls + speakingCls + '">' + esc(initial) + '</div>';
    }

    // Status badges (no speaking emoji — the green ring around the avatar is
    // the only speaking indicator).
    function memberBadges(m, prefix) {
        var html = '';
        if (m.force_muted) html += ' <span class="' + prefix + '-badge locked" title="Server muted">' + icon('lock') + icon('mic-off') + '</span>';
        else if (m.muted) html += ' <span class="' + prefix + '-badge" title="Muted">' + icon('mic-off') + '</span>';
        if (m.force_deafened) html += ' <span class="' + prefix + '-badge locked" title="Server deafened">' + icon('lock') + icon('volume-off') + '</span>';
        else if (m.deafened) html += ' <span class="' + prefix + '-badge" title="Deafened">' + icon('volume-off') + '</span>';
        if (m.camera) html += ' <span class="' + prefix + '-badge" title="Camera">' + icon('camera') + '</span>';
        if (m.screen) html += ' <span class="' + prefix + '-badge" title="Screen">' + icon('monitor') + '</span>';
        // Soundboard playing indicator — shows who is playing a sound so you know who to mute
        if (window._sbPlayingUsers && window._sbPlayingUsers[m.user_id]) {
            html += ' <span class="' + prefix + '-badge sb-playing-indicator" title="Playing soundboard">🎵</span>';
        }
        return html;
    }

    // One member row for the server voice popup: identity (PFP + name) on the
    // left, and that member's camera / screen-share videos side by side (the
    // tile element IS the <video>, so no nested query is needed).
    function voiceMemberRowHtml(uid, m, isSelf) {
        var local = isSelf ? Object.assign({}, m, {
            camera: S.cameraOn,
            screen: S.screenOn,
            muted: S.muted,
            deafened: S.deafened,
            speaking: S.speaking,
        }) : m;
        var speaking = local.speaking && !(local.muted || local.force_muted);
        var name = memberDisplayName(uid, local);
        var nameStyle = memberNameStyle(uid);
        var html = '<div class="voice-member-row' + (speaking ? ' speaking' : '') + '" data-uid="' + esc(uid) + '"' + (isSelf ? ' data-self="1"' : '') + '>';
        html += '<div class="voice-member-ident">';
        html += memberAvatarHtml(uid, local, name, 'voice-member-avatar');
        html += '<div class="voice-member-info">';
        html += '<span class="voice-member-name"' + (nameStyle ? ' style="' + nameStyle + '"' : '') + '>' + esc(name) + (local.is_owner ? ' 👑' : '') + (isSelf ? ' (you)' : '') + '</span>';
        // Per-user mode badges: show audio + video transmission mode.
        // Self gets clickable badges to toggle; others see indicators.
        if (S.roomType === 'server' && S.connected) {
            var audioMode = resolveAudioMode(uid);
            var cameraMode = resolveCameraMode(uid);
            var screenMode = resolveScreenMode(uid);
            var audioOv = S._audioModeOverrides[uid];
            var cameraOv = S._cameraModeOverrides[uid];
            var screenOv = S._screenModeOverrides[uid];
            var audioIsManual = audioOv === 'mesh' || audioOv === 'relay';
            var cameraIsManual = cameraOv === 'mesh' || cameraOv === 'relay';
            var screenIsManual = screenOv === 'mesh' || screenOv === 'relay';
            html += '<span class="voice-member-status">' + memberBadges(local, 'vm');
            html += ' <span class="voice-mode-badge mode-' + audioMode + (isSelf ? ' is-self' : '') + '" data-mode-kind="audio" data-uid="' + esc(uid) + '" title="Audio: ' + audioMode + (audioIsManual ? ' (manual)' : ' (auto)') + '">' + icon('volume-on', 10) + (audioMode === 'mesh' ? 'M' : 'R') + '</span>';
            html += ' <span class="voice-mode-badge mode-' + cameraMode + (isSelf ? ' is-self' : '') + '" data-mode-kind="camera" data-uid="' + esc(uid) + '" title="Camera: ' + cameraMode + (cameraIsManual ? ' (manual)' : ' (auto)') + '">' + icon('camera', 10) + (cameraMode === 'mesh' ? 'M' : 'R') + '</span>';
            html += ' <span class="voice-mode-badge mode-' + screenMode + (isSelf ? ' is-self' : '') + '" data-mode-kind="screen" data-uid="' + esc(uid) + '" title="Screen: ' + screenMode + (screenIsManual ? ' (manual)' : ' (auto)') + '">' + icon('monitor', 10) + (screenMode === 'mesh' ? 'M' : 'R') + '</span>';
            html += '</span>';
        } else {
            html += '<span class="voice-member-status">' + memberBadges(local, 'vm') + '</span>';
        }
        html += '</div></div>';
        // Call button on every OTHER member's row — starts a DM call with them
        // (they leave the voice channel if they accept).
        if (!isSelf) {
            html += '<button class="voice-member-call" data-uid="' + esc(uid) + '" title="Call ' + esc(name) + '" aria-label="Call ' + esc(name) + '">📞</button>';
        }
        html += '<div class="voice-member-media">';
        html += '<video class="remote-video-tile" data-uid="' + esc(uid) + '" data-kind="camera" data-self="' + (isSelf ? '1' : '0') + '" autoplay playsinline muted style="display:' + (local.camera ? 'block' : 'none') + '"></video>';
        html += '<video class="remote-video-tile" data-uid="' + esc(uid) + '" data-kind="screen" data-self="' + (isSelf ? '1' : '0') + '" autoplay playsinline muted style="display:' + (local.screen ? 'block' : 'none') + '"></video>';
        html += '</div></div>';
        return html;
    }

    // ------------------------------------------------------------------
    // Tile helpers — visibility, single interaction binder, relay <img>.
    // ------------------------------------------------------------------

    // Is this tile actually rendered on screen? A relay feed keeps TWO nodes
    // in the DOM with the same [data-uid][data-kind]: the visible relay <img>
    // and the hidden mesh <video>. The old visibility filters matched on a
    // `[style*="display:none"]` attribute substring, which NEVER matched —
    // Chrome serialises inline styles as `display: none;` WITH a space — so
    // fullscreen/PiP/transform paths happily targeted the hidden node.
    function isTileVisible(node) {
        if (!node || !node.isConnected) return false;
        if (document.fullscreenElement === node) return true;
        if (node.closest && node.closest('.voice-fs-wrap')) return true;
        return !!node.offsetParent;
    }

    // The tile the user actually sees for uid+kind: the relay <img> when relay
    // frames are live, otherwise the visible mesh <video>.
    function pickVisibleTile(uid, kind) {
        var sel = '[data-uid="' + uid + '"][data-kind="' + kind + '"]';
        var found = null;
        document.querySelectorAll('img.relay-video' + sel).forEach(function (n) {
            if (!found && isTileVisible(n)) found = n;
        });
        if (found) return found;
        document.querySelectorAll('video.remote-video-tile' + sel + ', video.voice-self-video' + sel).forEach(function (n) {
            if (!found && isTileVisible(n)) found = n;
        });
        return found;
    }

    // The only place tile click/contextmenu handlers are bound. Guarded, since
    // the relay path used to add its OWN click handler on top of this one: a
    // single click ran toggleFullscreen twice, and the second call exited then
    // immediately re-entered fullscreen (tile 1 worked, tile 2 seemed dead,
    // and clicking inside fullscreen bounced straight back in).
    function bindTileInteractions(node) {
        if (!node || node._tileBound) return;
        node._tileBound = true;
        var uid = node.dataset ? node.dataset.uid : null;
        var kind = node.dataset ? node.dataset.kind : null;
        node.addEventListener('click', function () { toggleFullscreen(node); });
        // Right-click opens the View menu (mirror / rotate / reset). Screen
        // tiles also target the SCREEN audio volume; camera tiles have no
        // audio at all. Stops propagation so the member row's own handler
        // doesn't double-open the menu.
        if (!uid) return;
        node.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            e.stopPropagation();
            openVolumeMenu(e, uid, kind === 'screen' ? 'screen' : 'video');
        });
    }

    // Drop the relay <img> for uid+kind and hand every tile back to the mesh
    // <video>: used when the sender turns the feed OFF or switches that feed
    // from relay back to mesh. Without this the stale relay image kept hiding
    // the fresh mesh <video> behind it. Never touches the media/encryption
    // path itself — it only removes the client-side render surface.
    function dropRelayFeed(uid, kind, feedOn) {
        var fk = uid + '_' + kind;
        var imgs = document.querySelectorAll('img.relay-video[data-uid="' + uid + '"][data-kind="' + kind + '"]');
        if (!S._relayVideoFrames[fk] && !imgs.length) return;
        if (S._relayVideoFrames[fk]) {
            URL.revokeObjectURL(S._relayVideoFrames[fk]);
            delete S._relayVideoFrames[fk];
        }
        document.querySelectorAll('video.remote-video-tile[data-uid="' + uid + '"][data-kind="' + kind + '"]').forEach(function (vid) {
            vid.removeAttribute('data-relay-hidden');
            // 'block'/'none' — an empty string would fall back to the initial
            // `inline` display for a <video> and break the media row layout.
            vid.style.display = feedOn ? 'block' : 'none';
            if (feedOn) reattachTileStream(vid);
            if (vid.dataset) applyTileTransform(vid, uid, kind);
        });
        imgs.forEach(function (img) {
            if (img.src && img.src.indexOf('blob:') === 0) URL.revokeObjectURL(img.src);
            img.remove();
        });
        syncResetViewChips(uid, kind);
    }

    // Inject (or refresh) the relay <img> tile for uid+kind in EVERY container
    // that renders that feed (the server-popup member row AND the DM call tile
    // can both exist for the same uid+kind). A single unscoped
    // document.querySelector() used to hit whichever came FIRST in the DOM —
    // in a DM call that was the hidden server-popup row, so the DM tile stayed
    // a hidden mesh <video> with no image at all (black tile / "PiP does
    // nothing"). The mesh <video> stays in the DOM as the WebRTC sink but is
    // flagged data-relay-hidden + display:none so it can never be mistaken for
    // the visible tile. Sizing comes from the .relay-video stylesheet — the old
    // inline cssText carried !important width/height that survived into rotated
    // and fullscreen tiles and cropped them.
    function injectRelayTile(uid, kind, url, onlyParent) {
        var videos = document.querySelectorAll('video.remote-video-tile[data-uid="' + uid + '"][data-kind="' + kind + '"]');
        var made = null;
        videos.forEach(function (videoTile) {
            var parent = videoTile.parentElement;
            if (!parent) return;
            if (onlyParent && parent !== onlyParent) return;
            var img = parent.querySelector('img.relay-video[data-uid="' + uid + '"][data-kind="' + kind + '"]');
            if (img) {
                if (img.src !== url) {
                    if (img.src && img.src.indexOf('blob:') === 0) URL.revokeObjectURL(img.src);
                    img.src = url;
                }
            } else {
                img = document.createElement('img');
                img.src = url;
                img.className = 'remote-video-tile relay-video';
                img.setAttribute('data-uid', uid);
                img.setAttribute('data-kind', kind);
                parent.insertBefore(img, videoTile);
                bindTileInteractions(img);
                // Keep the per-viewer mirror/rotation across a tile rebuild
                // (renderPopup/renderDmPanel destroy and re-create every tile).
                applyTileTransform(img, uid, kind);
            }
            videoTile.setAttribute('data-relay-hidden', '1');
            videoTile.style.display = 'none';
            if (!made) made = img;
        });
        if (made) syncResetViewChips(uid, kind);
        return made;
    }

    // Attach srcObject to every media tile inside a container. Self tiles use
    // the local camera/screen streams; other tiles use the remote streams.
    function wireVoiceMedia(root) {
        if (!root) return;
        root.querySelectorAll('.remote-video-tile').forEach(function (video) {
            var uid = video.dataset.uid;
            var kind = video.dataset.kind;
            var isSelf = video.dataset.self === '1';
            var isImg = video.tagName === 'IMG';
            var stream = null;
            if (isImg) {
                // Relay <img> tile — the relay pipeline owns src/streams. Only
                // restore the per-viewer view transform after a rebuild.
                applyTileTransform(video, uid, kind);
                bindTileInteractions(video);
                return;
            }
            if (isSelf) {
                stream = kind === 'camera' ? S.localStreams.camera : S.localStreams.screen;
                if (stream) {
                    video.srcObject = stream;
                    video.play().catch(function () {});
                }
            } else {
                if (S.remoteStreams[uid]) stream = S.remoteStreams[uid][kind];
                // Manual-load aware: holds behind a Load button when enabled.
                attachRemoteVideo(video, uid, kind, stream);
            }
            // Per-viewer mirror/rotate transforms (right-click menu) apply for
            // how YOU see this feed — remote and SELF tiles alike. Pure
            // renderer-side CSS — nothing is sent.
            applyTileTransform(video, uid, kind);
            bindTileInteractions(video);
        });
        // Tiles may have been rebuilt — re-sync any "Reset view" hint chips.
        syncAllResetViewChips();
    }

    // Re-inject relay video <img> tiles after renderPopup() rebuilds all tiles
    // as <video> elements. Called from renderPopup() and renderDmPanel().
    function reInjectRelayFrames() {
        var frames = S._relayVideoFrames;
        if (!frames) return;
        var count = 0;
        for (var key in frames) {
            var parts = key.split('_');
            var uid = parts[0];
            var kind = parts[1];
            var url = frames[key];
            if (!url || !uid || !kind) continue;
            // If the relay img is currently fullscreened its element lives in
            // the wrap, not in the rebuilt tile list — re-home it to the new
            // tile so exiting fullscreen lands it in the right container.
            var existing = document.querySelector('img.relay-video[data-uid="' + uid + '"][data-kind="' + kind + '"]');
            if (existing && existing.closest && existing.closest('.voice-fs-wrap')) {
                var newTile = document.querySelector('video.remote-video-tile[data-uid="' + uid + '"][data-kind="' + kind + '"]');
                if (newTile && newTile.parentElement) {
                    existing._fsOrigParent = newTile.parentElement;
                    existing._fsOrigNext = null;
                    newTile.setAttribute('data-relay-hidden', '1');
                    newTile.style.display = 'none';
                }
                continue;
            }
            // injectRelayTile(): creates/refreshes the relay <img> in EVERY
            // container that renders this feed (server popup row, DM call tile,
            // rotated slot), binds interactions ONCE (guarded — the old code let
            // wireVoiceMedia add a second click handler, double-toggling
            // fullscreen) and re-applies the per-viewer mirror/rotation so a
            // rebuilt tile does not come back untransformed.
            if (injectRelayTile(uid, kind, url, null)) count++;
        }
        if (count > 0) console.log('[Relay] re-injected ' + count + ' relay frame(s)');
    }

    function renderPopup() {
        var list = el('voice-popup-members');
        if (!list) return;
        var selfId = getSelfId();
        var html = '';
        // Self first, then everyone else
        var uids = Object.keys(S.members).sort(function (a, b) {
            var sa = a === selfId ? 0 : 1;
            var sb = b === selfId ? 0 : 1;
            return sa - sb;
        });
        uids.forEach(function (uid) {
            html += voiceMemberRowHtml(uid, S.members[uid], uid === selfId);
        });
        if (!uids.length) {
            html = '<div class="voice-member-empty">No one here yet</div>';
        }
        list.innerHTML = html;
        // Re-inject relay video frames — renderPopup() rebuilds all tiles as
        // <video> elements, destroying relay <img> elements each time.
        reInjectRelayFrames();
        // A member-row rebuild wipes the reconnect chip in the self row's media
        // container — re-apply if the watchdog notice is currently showing.
        syncVideoReconnectChips();

        // Right-click → volume menu (all users) + owner controls (server owner)
        list.querySelectorAll('.voice-member-row').forEach(function (row) {
            row.addEventListener('contextmenu', function (e) {
                e.preventDefault();
                openVolumeMenu(e, row.dataset.uid);
            });
        });
        // Click the member's PFP → open their profile view (like everywhere else).
        list.querySelectorAll('.voice-member-avatar').forEach(function (av) {
            av.addEventListener('click', function () {
                var row = av.closest('.voice-member-row');
                if (!row) return;
                var uid = row.getAttribute('data-uid');
                if (uid && typeof openProfileModal === 'function') openProfileModal(uid);
            });
        });
        // Call button → start a DM call with that member (they leave the voice
        // channel when they accept).
        list.querySelectorAll('.voice-member-call').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                var uid = btn.getAttribute('data-uid');
                if (!uid) return;
                var m = S.members[uid];
                callMemberFromVoice(uid, m ? (m.username || '') : '');
            });
        });
        // Mode badge click → toggle mesh/relay (self only).
        // Others just see the indicator; clicking does nothing.
        // Uses event delegation on the list container so clicks survive
        // innerHTML replacement from updateMemberBadgesInPlace.
        // Guard: only bind the delegation listener once.
        if (!list._modeBadgeDelegationBound) {
            list._modeBadgeDelegationBound = true;
            list.addEventListener('click', function (e) {
                var badge = e.target.closest('.voice-mode-badge.is-self');
                if (!badge) return;
                e.preventDefault();
                e.stopPropagation();
                var kind = badge.getAttribute('data-mode-kind');
                var uid = badge.getAttribute('data-uid');
                if (uid !== getSelfId()) return;
                if (kind === 'audio') {
                    var cur = S._audioModeOverrides[uid] || 'mesh';
                    setSelfAudioMode(cur === 'relay' ? 'mesh' : 'relay');
                } else if (kind === 'camera') {
                    var cur = S._cameraModeOverrides[uid] || 'mesh';
                    setSelfCameraMode(cur === 'relay' ? 'mesh' : 'relay');
                } else if (kind === 'screen') {
                    var cur = S._screenModeOverrides[uid] || 'mesh';
                    setSelfScreenMode(cur === 'relay' ? 'mesh' : 'relay');
                }
            });
        }
        wireVoiceMedia(list);
    }

    function clearRemoteTiles() {
        var lists = [el('voice-popup-members'), el('dm-call-body')];
        lists.forEach(function (l) {
            if (!l) return;
            l.querySelectorAll('.remote-video-tile, .voice-tile-slot, .voice-feed-load-btn, .voice-feed-unload-btn, .voice-tile-reset-view').forEach(function (t) { t.remove(); });
        });
    }

    function removeRemoteTile(uid) {
        document.querySelectorAll('.remote-video-tile[data-uid="' + uid + '"]').forEach(function (t) { t.remove(); });
        // Rotation slots wrap their tile — drop them with it.
        document.querySelectorAll('.voice-tile-slot[data-uid="' + uid + '"]').forEach(function (s) { s.remove(); });
        ['camera', 'screen'].forEach(function (k) {
            var key = feedKey(uid, k);
            document.querySelectorAll('.voice-feed-load-btn[data-feed="' + key + '"], .voice-feed-unload-btn[data-feed="' + key + '"], .voice-tile-reset-view[data-feed="' + resetViewChipFeedKey(uid, k) + '"]').forEach(function (b) { b.remove(); });
            // Drop the manual-load state for this member's feeds (both kinds).
            clearFeedLoaded(uid, k);
        });
    }

    function feedKey(uid, kind) { return uid + ':' + kind; }
    // Tri-state per-feed load: true = explicitly loaded, false = explicitly
    // unloaded, undefined = never touched (auto-load when the manual-load
    // setting is OFF, held behind Load when it's ON). Unloading works even
    // with the setting OFF — that feed stays unloaded until reloaded.
    function isFeedLoaded(uid, kind) {
        var key = feedKey(uid, kind);
        if (S._loadedFeeds[key] === true) return true;
        if (S._loadedFeeds[key] === false) return false;
        return !S.settings.manualVideoLoad;
    }
    function markFeedLoaded(uid, kind) { S._loadedFeeds[feedKey(uid, kind)] = true; }
    function markFeedUnloaded(uid, kind) { S._loadedFeeds[feedKey(uid, kind)] = false; }
    function clearFeedLoaded(uid, kind) { delete S._loadedFeeds[feedKey(uid, kind)]; }
    // The lists broadcast in voice_state so every sender knows which feeds
    // ("uid:kind") this viewer is actually watching.
    function loadedFeedsList() {
        return Object.keys(S._loadedFeeds).filter(function (k) { return S._loadedFeeds[k] === true; });
    }
    function unloadedFeedsList() {
        return Object.keys(S._loadedFeeds).filter(function (k) { return S._loadedFeeds[k] === false; });
    }
    // Stop receiving a feed AND tell every sender to stop sending it (bitrate).
    // The feed returns behind its Load button; clicking Load (or disabling the
    // manual-load feature) resumes both directions.
    function unloadFeed(uid, kind) {
        markFeedUnloaded(uid, kind);
        // Target the mesh <video> explicitly — a relay <img> shares the same
        // [data-uid][data-kind] and must not be picked (srcObject on an <img>
        // is meaningless and hid the real element).
        var v = document.querySelector('video.remote-video-tile[data-uid="' + uid + '"][data-kind="' + kind + '"]');
        if (v) { try { v.srcObject = null; } catch (_) {} }
        applyFeedPlaceholders();
        // Unloading the screen also silences its tab/system audio (receiver side).
        applyScreenAudioGate(uid);
        if (S.connected) sendVoiceState();
    }

    // Position a feed button (Load center / Unload top-right) over ITS OWN
    // tile. Runs immediately and then retries across a few animation frames,
    // because attachRemoteVideo can run before the container is laid out
    // (panel hidden at render, stream still attaching) — without the retry the
    // button falls to the flex row's static position (e.g. "on the right of
    // the camera" instead of inside its top-right corner). Skipped while the
    // video lives in a fullscreen wrap (its offsets are then relative to the
    // wrap, not the tile container).
    function positionFeedButton(btn, video, isLoad) {
        if (!btn || !video) return;
        var place = function () {
            if (!btn.isConnected || !video.isConnected) return;
            if (video.closest && video.closest('.voice-fs-wrap')) return;
            // Use viewport bounding rects, NOT offsetLeft/offsetTop: the
            // button's absolute coords are relative to ITS containing block,
            // while the video's offsets are relative to ITS offsetParent.
            // Those can differ (flex rows, nested positioned ancestors, CSS
            // transforms on the tile) — the mismatch landed the button OUTSIDE
            // the tile (e.g. "to the right of the camera"). Rect math is
            // coordinate-system-proof and follows transforms too.
            var vr = video.getBoundingClientRect();
            if (vr.width <= 1 || vr.height <= 1) return; // not laid out yet
            var op = btn.offsetParent;
            if (!op) return;
            var or = op.getBoundingClientRect();
            var x = vr.left - or.left;
            var y = vr.top - or.top;
            if (isLoad) {
                btn.style.left = Math.round(x + vr.width / 2) + 'px';
                btn.style.top = Math.round(y + vr.height / 2) + 'px';
            } else {
                var bw = btn.offsetWidth || 22;
                btn.style.left = Math.round(x + vr.width - bw - 6) + 'px';
                btn.style.top = Math.round(y + 6) + 'px';
            }
        };
        place();
        var tries = 0;
        (function retry() {
            requestAnimationFrame(function () {
                if (!btn.isConnected || tries >= 20) return;
                tries++;
                place();
                retry();
            });
        })();
        // The video's intrinsic size only becomes known once its decoder has a
        // frame — that can be seconds after attach. Re-position when it
        // changes (fires on dimension change) and on window resizes.
        try { video.addEventListener('resize', place); } catch (_) {}
        try { window.addEventListener('resize', place); } catch (_) {}
    }

    // Attach a remote camera/screen stream to its tile — or, when the feed
    // isn't loaded (manual video load ON + not clicked, or explicitly
    // unloaded), hold it behind a Load button instead. Per (user, kind) —
    // loading your camera and your screen are independent, as are different
    // users' feeds. A loaded feed gets an Unload button (top-right, hover to
    // reveal on PC, always visible on touch) that stops both directions.
    // Right-click on the held tile (or its Load/Unload button) still opens
    // the volume menu.
    function attachRemoteVideo(video, uid, kind, stream) {
        if (!video) return;
        // Feed buttons always live in the media row (not inside a rotation
        // slot), so when the tile is currently wrapped look the row up.
        var parent = video.parentElement;
        if (parent && parent.classList && parent.classList.contains('voice-tile-slot')) {
            parent = parent.parentElement;
        }
        var key = feedKey(uid, kind);
        var holder = parent ? parent.querySelector('.voice-feed-load-btn[data-feed="' + key + '"]') : null;
        var unloadBtn = parent ? parent.querySelector('.voice-feed-unload-btn[data-feed="' + key + '"]') : null;
        // The tile element stays in the DOM with display:none when the member's
        // feed is OFF — and the voice_state flip can arrive before the RTP
        // track ends, so the stream can STILL be present here. Never show
        // Load/Unload over a hidden tile: the button would keep its stale
        // position and overlap the remaining visible feed's buttons ("stopping
        // the screen share overlaps the camera's Load/Unload buttons").
        if (!video.offsetParent) {
            if (holder) holder.style.display = 'none';
            if (unloadBtn) unloadBtn.style.display = 'none';
            return;
        }
        var hold = !!stream && !isFeedLoaded(uid, kind);
        if (hold) {
            try { if (video.srcObject) video.srcObject = null; } catch (_) {}
            if (unloadBtn) unloadBtn.style.display = 'none';
            if (!holder) {
                holder = document.createElement('button');
                holder.type = 'button';
                holder.className = 'voice-feed-load-btn';
                holder.setAttribute('data-feed', key);
                holder.innerHTML = '<svg class="ui-icon" width="14" height="14"><use href="#icon-play"/></svg><span class="voice-feed-load-lbl">' +
                    (kind === 'screen' ? 'Load screen' : 'Load camera') + '</span>';
                holder.addEventListener('click', function () {
                    markFeedLoaded(uid, kind);
                    var v = document.querySelector('video.remote-video-tile[data-uid="' + uid + '"][data-kind="' + kind + '"]');
                    if (v && S.remoteStreams[uid] && S.remoteStreams[uid][kind]) {
                        v.srcObject = S.remoteStreams[uid][kind];
                        v.play().catch(function () {});
                    }
                    applyFeedPlaceholders();
                    // Reloading the screen resumes its tab/system audio (receiver side).
                    applyScreenAudioGate(uid);
                    // The receiver now wants this feed — tell senders to resume.
                    if (S.connected) sendVoiceState();
                });
                // Right-click on the Load button behaves like right-click on the
                // feed tile (volume/view menu) — manual load never breaks it.
                holder.addEventListener('contextmenu', function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    openVolumeMenu(e, uid, kind === 'screen' ? 'screen' : 'video');
                });
                if (parent) parent.appendChild(holder);
            }
            // Position the button over ITS OWN tile, not the center of the
            // media row — with both camera + screen present the tiles sit side
            // by side, and a container-centered button would land between them.
            // Re-computed every time the button is shown (layout can shift when
            // a sibling tile appears/disappears).
            holder.style.display = 'flex';
            positionFeedButton(holder, video, true);
        } else {
            if (holder) holder.style.display = 'none';
            if (stream && video.srcObject !== stream) {
                // Renegotiation re-fires ontrack with the SAME underlying track
                // wrapped in a NEW MediaStream — replacing srcObject would
                // restart the decoder → a black flash on every renegotiation.
                // Keep the element's stream when the track didn't change.
                var curVid = null;
                try { curVid = video.srcObject && video.srcObject.getVideoTracks()[0]; } catch (_) {}
                var newVid = stream.getVideoTracks()[0];
                if (!(curVid && newVid && curVid.id === newVid.id)) {
                    video.srcObject = stream;
                    video.play().catch(function () {});
                }
            }
            if (stream) {
                if (!unloadBtn) {
                    unloadBtn = document.createElement('button');
                    unloadBtn.type = 'button';
                    unloadBtn.className = 'voice-feed-unload-btn';
                    unloadBtn.setAttribute('data-feed', key);
                    unloadBtn.title = 'Stop receiving this feed — the sender stops sending it to you (tap Load to resume)';
                    unloadBtn.innerHTML = icon('close');
                    unloadBtn.addEventListener('click', function (e) {
                        e.stopPropagation();
                        unloadFeed(uid, kind);
                    });
                    unloadBtn.addEventListener('contextmenu', function (e) {
                        e.preventDefault();
                        e.stopPropagation();
                        openVolumeMenu(e, uid, kind === 'screen' ? 'screen' : 'video');
                    });
                    if (parent) parent.appendChild(unloadBtn);
                }
                unloadBtn.style.display = 'flex';
                // Position over ITS OWN tile's top-right corner.
                positionFeedButton(unloadBtn, video, false);
            } else if (unloadBtn) {
                unloadBtn.style.display = 'none';
            }
        }
    }

    // Re-evaluate every remote feed tile (used when the manual-load toggle or
    // a Load click changes what should be attached vs held).
    function applyFeedPlaceholders() {
        document.querySelectorAll('.remote-video-tile[data-self="0"]').forEach(function (video) {
            var uid = video.dataset.uid;
            var kind = video.dataset.kind;
            var stream = S.remoteStreams[uid] ? S.remoteStreams[uid][kind] : null;
            attachRemoteVideo(video, uid, kind, stream);
        });
        // Keep every member's screen-share audio in sync with its load state.
        Object.keys(S.remoteStreams).forEach(function (uid) {
            applyScreenAudioGate(uid);
        });
    }

    function renderRemoteTile(uid, kind) {
        // The tile element IS the <video> (class remote-video-tile sits on the
        // video itself) — attach srcObject directly (or hold behind Load when
        // manual video load is on).
        var video = document.querySelector('video.remote-video-tile[data-uid="' + uid + '"][data-kind="' + kind + '"]');
        if (!video) return;
        attachRemoteVideo(video, uid, kind, S.remoteStreams[uid] ? S.remoteStreams[uid][kind] : null);
    }

    function selfPreviewEl() {
        var wrap = document.createElement('div');
        wrap.className = 'voice-self-preview-wrap';
        if (S.cameraOn && S.localStreams.camera) {
            var v = document.createElement('video');
            v.autoplay = true;
            v.muted = true;
            v.playsInline = true;
            v.srcObject = S.localStreams.camera;
            v.className = 'voice-self-video';
            // data-kind/self/uid let the fullscreen-exit path (moveTileBack /
            // findTileSlot / reattachTileStream) restore the element live.
            v.setAttribute('data-kind', 'camera');
            v.setAttribute('data-self', '1');
            v.setAttribute('data-uid', getSelfId());
            // Single guarded binder: click = fullscreen, right-click = the View
            // menu (mirror / rotate / reset) on our OWN feed.
            bindTileInteractions(v);
            wrap.appendChild(v);
        }
        if (S.screenOn && S.localStreams.screen) {
            var s = document.createElement('video');
            s.autoplay = true;
            s.muted = true;
            s.playsInline = true;
            s.srcObject = S.localStreams.screen;
            s.className = 'voice-self-video';
            s.setAttribute('data-kind', 'screen');
            s.setAttribute('data-self', '1');
            s.setAttribute('data-uid', getSelfId());
            bindTileInteractions(s);
            wrap.appendChild(s);
        }
        if (!S.cameraOn && !S.screenOn) {
            var d = document.createElement('div');
            d.className = 'voice-self-avatar';
            d.textContent = (S.channelName || 'V').charAt(0).toUpperCase();
            wrap.appendChild(d);
        }
        return wrap;
    }

    function renderSelfPreview() {
        // Server popup shows the self camera/screen inline in the self member
        // row (renderPopup), so only the DM panel keeps a dedicated self strip.
        var dmPrev = el('dm-call-self');
        if (dmPrev) {
            dmPrev.innerHTML = '';
            dmPrev.appendChild(selfPreviewEl());
            // A re-render wipes the reconnect chip — re-apply if it was active.
            syncVideoReconnectChips();
            // Fresh self-strip videos: re-apply any per-viewer mirror/rotate
            // transform (and its rotation slot) so a rebuild doesn't silently
            // reset how YOU had your own feeds arranged.
            document.querySelectorAll('#dm-call-self video.voice-self-video').forEach(function (v) {
                applyTileTransform(v, v.dataset.uid, v.dataset.kind);
            });
            // The self strip was rebuilt — restore any "Reset view" hint chip.
            syncAllResetViewChips();
        }
    }

    // ------------------------------------------------------------------
    // UI: DM call panel (top panel of the text area)
    // ------------------------------------------------------------------
    function showDmPanel() {
        var p = el('dm-call-panel');
        if (!p) return;
        syncOverlayBounds();
        S.dmPanelOpen = true;
        p.style.display = 'flex';
        var name = el('dm-call-name');
        if (name) {
            var pn = S.dmCallPartner ? memberDisplayName(S.dmCallPartner.id, S.dmCallPartner) : null;
            var pid = S.dmCallPartner ? S.dmCallPartner.id : null;
            if (S.callWaiting) {
                name.innerHTML = 'Waiting for ' + (pn ? memberNameSpan(pid, pn) : esc('answer')) + '…';
            } else if (!S.dmCallAnswered && S.dmCallActive) {
                name.innerHTML = 'Calling ' + (pn ? memberNameSpan(pid, pn) : '…') + '…';
            } else {
                name.innerHTML = pn ? memberNameSpan(pid, pn) : '…';
            }
        }
        applyDmExpand();
        renderDmPanel();
        renderSelfPreview();
    }

    // Expand/collapse the DM call panel: expanded covers the whole text area
    // (just the call — great for phones, so you see your own camera + screen
    // AND the other person's at the same time); collapsed is the top panel
    // with the chat text still visible below. Per-call only — every join/leave
    // resets it, so a call always starts collapsed.
    function toggleDmExpand() {
        S.dmCallExpanded = !S.dmCallExpanded;
        applyDmExpand();
        syncOverlayBounds();
    }

    function applyDmExpand() {
        var p = el('dm-call-panel');
        if (!p) return;
        p.classList.toggle('expanded', !!S.dmCallExpanded);
        var btn = el('dm-call-expand');
        if (btn) {
            btn.innerHTML = S.dmCallExpanded ? icon('minimize') : icon('maximize');
            btn.title = S.dmCallExpanded ? 'Collapse — show chat below' : 'Expand — cover the whole screen';
        }
    }

    // Fullscreen the voice channel view: covers the WHOLE screen (server
    // strip + sidebar included) so you see only the call. The ⤢/⤡ button
    // lives in the voice view header; fullscreen is per-call only (reset on
    // join/leave — a call always starts in the normal view).
    function toggleVoiceFullscreen() {
        S.voiceFullscreen = !S.voiceFullscreen;
        applyVoiceFullscreen();
        syncOverlayBounds();
    }

    function applyVoiceFullscreen() {
        var p = el('voice-popup');
        if (!p) return;
        p.classList.toggle('fullscreen', !!S.voiceFullscreen);
        var btn = el('voice-popup-fullscreen');
        if (btn) {
            btn.innerHTML = S.voiceFullscreen ? icon('minimize') : icon('maximize');
            btn.title = S.voiceFullscreen ? 'Exit full screen' : 'Full screen';
        }
    }

    function hideDmPanel() {
        S.dmPanelOpen = false;
        var p = el('dm-call-panel');
        if (p) p.style.display = 'none';
    }

    function bindDmPanelControls() {
        var p = el('dm-call-panel');
        if (!p) return;
        bindClick(p, 'dm-call-mute', function () { toggleMute(); });
        bindClick(p, 'dm-call-deafen', function () { toggleDeafen(); });
        bindClick(p, 'dm-call-camera', function () { toggleCamera(); });
        bindClick(p, 'dm-call-cam-opt', function (e) { openCamOptMenu(this); });
        bindClick(p, 'dm-call-screen', function () { toggleScreen(); });
        bindClick(p, 'dm-call-pip', function () { togglePiP(this); });
        bindClick(p, 'dm-call-soundboard', function () {
            var sbOverlay = document.getElementById('soundboard-overlay');
            if (sbOverlay) sbOverlay.style.display = 'flex';
            if (window._loadSoundboardClips) window._loadSoundboardClips();
        });
        bindClick(p, 'dm-call-end', function () { endDmCall(); });
        bindClick(p, 'dm-call-expand', function () { toggleDmExpand(); });
        bindClick(p, 'dm-call-close', function () { hideDmPanel(); });
        initDmResize();
    }

    // Clamp a saved DM panel height to a sane range for the current viewport
    // (min 240px so the header, member tiles and control buttons never
    // overlap; max keeps the chat header plus a sliver of the text area
    // visible below the panel).
    function clampDmPanelHeight(h) {
        if (!h) return null;
        var min = 240;
        var max = Math.max(min, window.innerHeight - 90);
        return Math.max(min, Math.min(h, max));
    }

    // Drag the bottom handle to resize the DM call panel's height. The height
    // lives in S.dmPanelHeight and is persisted in localStorage, so the user's
    // choice survives page refreshes (unlike expand/fullscreen, which reset to
    // OFF on every join/leave). Hidden while the panel is expanded.
    function initDmResize() {
        var handle = el('dm-call-resize');
        var panel = el('dm-call-panel');
        if (!handle || !panel) return;
        try {
            var saved = parseInt(localStorage.getItem('dm_call_panel_h'), 10);
            if (saved && saved >= 240) S.dmPanelHeight = saved;
        } catch (e) {}
        var startY = 0;
        var startH = 0;
        var dragging = false;
        function onMove(e) {
            if (!dragging) return;
            var h = clampDmPanelHeight(startH + (e.clientY - startY));
            if (!h) return;
            S.dmPanelHeight = h;
            panel.style.height = h + 'px';
            try { localStorage.setItem('dm_call_panel_h', String(h)); } catch (err) {}
            e.preventDefault();
        }
        function onUp() {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            document.body.classList.remove('resizing-dm');
        }
        handle.addEventListener('pointerdown', function (e) {
            if (S.dmCallExpanded) return;
            dragging = true;
            startY = e.clientY;
            startH = panel.offsetHeight;
            handle.classList.add('dragging');
            document.body.classList.add('resizing-dm');
            handle.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
    }

    function renderDmPanel() {
        var body = el('dm-call-body');
        if (!body) return;
        var selfId = getSelfId();
        var html = '';
        // Partner tiles
        Object.keys(S.members).forEach(function (uid) {
            if (uid === selfId) return;
            html += dmTileHtml(uid, S.members[uid]);
        });
        if (!html) html = '<div class="dm-call-empty">Waiting for the other person…</div>';
        body.innerHTML = html;
        // Re-inject relay video frames after tile rebuild
        reInjectRelayFrames();

        // Wire remote tiles — the tile element IS the <video>
        body.querySelectorAll('.remote-video-tile').forEach(function (video) {
            var uid = video.dataset.uid;
            var kind = video.dataset.kind;
            var isImg = video.tagName === 'IMG';
            if (!isImg) {
                var _stream = S.remoteStreams[uid] ? S.remoteStreams[uid][kind] : null;
                // Manual-load aware: holds behind a Load button when enabled.
                attachRemoteVideo(video, uid, kind, _stream);
            }
            // Per-viewer mirror/rotate transform (right-click menu) — how YOU
            // see this feed. Remote tiles never mirror by default.
            applyTileTransform(video, uid, kind);
            bindTileInteractions(video);
        });
        // Right-click ANYWHERE on a DM call tile (avatar, name, placeholder —
        // not just the video) opens the per-member volume slider, matching the
        // voice-channel member rows. Both handlers stopPropagation so the menu
        // never opens twice for the same right-click.
        body.querySelectorAll('.dm-call-tile').forEach(function (tile) {
            tile.addEventListener('contextmenu', function (e) {
                e.preventDefault();
                e.stopPropagation();
                var uid = tile.getAttribute('data-uid');
                if (uid) openVolumeMenu(e, uid, 'member');
            });
        });
        // Click the member's PFP → open their profile view.
        body.querySelectorAll('.dm-call-avatar').forEach(function (av) {
            av.addEventListener('click', function () {
                var tile = av.closest('.dm-call-tile');
                if (!tile) return;
                var uid = tile.getAttribute('data-uid');
                if (uid && typeof openProfileModal === 'function') openProfileModal(uid);
            });
        });
        updateSelfUI();
    }

    function dmTileHtml(uid, m) {
        var muted = m.muted || m.force_muted;
        var speaking = m.speaking && !muted;
        var name = memberDisplayName(uid, m);
        var html = '<div class="dm-call-tile' + (speaking ? ' speaking' : '') + '" data-uid="' + esc(uid) + '">';
        html += '<div class="dm-call-tile-head">';
        html += memberAvatarHtml(uid, m, name, 'dm-call-avatar');
        html += '<div class="dm-call-tile-info">';
        html += memberNameSpan(uid, name);
        html += memberBadges(m, 'vm');
        html += '</div></div>';
        html += '<div class="dm-call-tile-media">';
        html += '<video class="remote-video-tile" data-uid="' + esc(uid) + '" data-kind="camera" data-self="0" autoplay playsinline muted style="display:' + (m.camera ? 'block' : 'none') + '"></video>';
        html += '<video class="remote-video-tile" data-uid="' + esc(uid) + '" data-kind="screen" data-self="0" autoplay playsinline muted style="display:' + (m.screen ? 'block' : 'none') + '"></video>';
        if (!m.camera && !m.screen) {
            html += '<div class="dm-call-tile-placeholder">No video</div>';
        }
        html += '</div></div>';
        return html;
    }

    // ------------------------------------------------------------------
    // UI: mini bar (DM call persists when switching chats)
    // ------------------------------------------------------------------
    function showMiniBar() {
        var m = el('dm-mini-bar');
        if (!m) return;
        syncOverlayBounds();
        m.style.display = 'flex';
        var name = el('dm-mini-bar-name');
        if (name) {
            var pn = S.dmCallPartner ? memberDisplayName(S.dmCallPartner.id, S.dmCallPartner) : null;
            var pid = S.dmCallPartner ? S.dmCallPartner.id : null;
            if (S.callWaiting) {
                name.innerHTML = pn ? ('Waiting for ' + memberNameSpan(pid, pn) + '…') : 'Waiting for answer…';
            } else if (!S.dmCallAnswered && S.dmCallActive) {
                name.innerHTML = pn ? ('Calling ' + memberNameSpan(pid, pn) + '…') : 'Calling…';
            } else {
                name.innerHTML = pn ? ('In call with ' + memberNameSpan(pid, pn)) : 'In call';
            }
        }
    }

    function hideMiniBar() {
        var m = el('dm-mini-bar');
        if (m) m.style.display = 'none';
    }

    function bindMiniBarControls() {
        var m = el('dm-mini-bar');
        if (!m) return;
        bindClick(m, 'dm-mini-bar-body', function () {
            if (S.dmChannelId && typeof selectDmChannel === 'function') {
                try { selectDmChannel(S.dmChannelId, S.dmCallPartner ? S.dmCallPartner.id : null, S.dmCallPartner ? S.dmCallPartner.username : null, null); } catch (_) {}
            }
        });
        bindClick(m, 'dm-mini-bar-goto', function () {
            if (S.dmChannelId && typeof selectDmChannel === 'function') {
                try { selectDmChannel(S.dmChannelId, S.dmCallPartner ? S.dmCallPartner.id : null, S.dmCallPartner ? S.dmCallPartner.username : null, null); } catch (_) {}
            }
        });
        bindClick(m, 'dm-mini-bar-end', function () { endDmCall(); });
        bindClick(m, 'dm-mini-bar-mute', function () { toggleMute(); });
        bindClick(m, 'dm-mini-bar-deafen', function () { toggleDeafen(); });
        bindClick(m, 'dm-mini-bar-camera', function () { toggleCamera(); });
        bindClick(m, 'dm-mini-bar-cam-opt', function (e) { openCamOptMenu(this); });
        bindClick(m, 'dm-mini-bar-screen', function () { toggleScreen(); });
        bindClick(m, 'dm-mini-bar-soundboard', function () {
            var sbOverlay = document.getElementById('soundboard-overlay');
            if (sbOverlay) sbOverlay.style.display = 'flex';
            if (window._loadSoundboardClips) window._loadSoundboardClips();
        });
    }

    // ------------------------------------------------------------------
    // UI: incoming DM call bar
    // ------------------------------------------------------------------
    function showIncomingCall(call) {
        var b = el('incoming-call-bar');
        if (!b) return;
        b.classList.remove('waiting');
        b.style.display = 'flex';
        var name = el('incoming-call-name');
        if (name) {
            var disp = (call.callerId && typeof userDisplayNameCache !== 'undefined' && userDisplayNameCache[call.callerId] && userDisplayNameCache[call.callerId].display_name) || call.callerUsername || '…';
            name.innerHTML = memberNameSpan(call.callerId, disp) + ' is calling…';
        }
        var acceptBtn = el('incoming-call-accept');
        if (acceptBtn) acceptBtn.textContent = 'Accept';
        var declineBtn = el('incoming-call-decline');
        if (declineBtn) declineBtn.style.display = '';
    }

    function hideIncomingCall() {
        clearCalleeRingTimer();
        var b = el('incoming-call-bar');
        if (b) {
            b.style.display = 'none';
            b.classList.remove('waiting');
        }
        var acceptBtn = el('incoming-call-accept');
        if (acceptBtn) acceptBtn.textContent = 'Accept';
    }

    function bindIncomingCallControls() {
        var b = el('incoming-call-bar');
        if (!b) return;
        bindClick(b, 'incoming-call-accept', function () { acceptDmCall(); });
        bindClick(b, 'incoming-call-decline', function () { declineDmCall(); });
    }

    // ------------------------------------------------------------------
    // UI: per-viewer tile transforms (right-click menu) — mirror/rotate only
    // change how YOU see a member's camera/screen feed. Nothing is signaled
    // or sent; the E2EE media path is untouched. The mirror is ALWAYS a
    // horizontal flip in screen space, independent of any rotation applied.
    // ------------------------------------------------------------------
    function tileTransformCss(uid, kind) {
        var st = S.tileTransforms[uid + ':' + kind];
        if (!st || (!st.mirror && !st.rot)) return '';
        // Rotate is applied FIRST (rightmost), then the horizontal flip — so
        // scaleX(-1) always mirrors left↔right on screen, even when rotated.
        var parts = [];
        if (st.mirror) parts.push('scaleX(-1)');
        if (st.rot) parts.push('rotate(' + st.rot + 'deg)');
        return parts.join(' ');
    }

    function applyTileTransform(video, uid, kind) {
        var st = S.tileTransforms[uid + ':' + kind];
        var rot = st && st.rot ? ((st.rot % 360) + 360) % 360 : 0;
        var css = tileTransformCss(uid, kind);
        var sideways = rot === 90 || rot === 270;
        var fsWrap = video.closest ? video.closest('.voice-fs-wrap') : null;
        var isNativeFs = document.fullscreenElement === video;
        var inFullscreen = fsWrap || isNativeFs;
        var slot = video.parentElement && video.parentElement.classList.contains('voice-tile-slot')
            ? video.parentElement : null;
        if (inFullscreen) {
            // Fullscreen (CSS wrapper OR native): contain-fit the picture to
            // the screen — both axes scaled by the SAME factor, ratio kept.
            // Apply rotation/mirror transform.
            clearInlineDims(video);
            // Get natural (unrotated) video dimensions.
            var bw = video.videoWidth || video.naturalWidth || 0;
            var bh = video.videoHeight || video.naturalHeight || 0;
            if (!(bw > 0 && bh > 0)) {
                bw = video.offsetWidth || 1;
                bh = video.offsetHeight || 1;
            }
            // Effective visual dimensions after rotation.
            var evw = sideways ? bh : bw;
            var evh = sideways ? bw : bh;
            var fw, fh;
            if (fsWrap) {
                fw = fsWrap.clientWidth || window.innerWidth;
                fh = fsWrap.clientHeight || window.innerHeight;
            } else {
                fw = window.innerWidth;
                fh = window.innerHeight;
            }
            // Contain-fit: scale so the VISUAL box fits BOTH screen axes.
            // The old rule (largest visual dim vs largest screen dim) only
            // ever compared one axis pair — a portrait phone camera kept its
            // width while the height overflowed the shorter screen edge, i.e.
            // "width is kept the same while height is the only one being
            // resized": the picture was cropped instead of shrunk uniformly.
            var s = (evw > 0 && evh > 0) ? Math.min(fw / evw, fh / evh) : 1;
            if (!isFinite(s) || s <= 0) s = 1;
            if (evw > 0 && evh > 0) {
                // The element's LAYOUT box is the visual box TRANSPOSED when
                // rotated 90°/270°: after rotate(90deg) a layW×layH element
                // paints a layH×layW visual. Writing the visual dims straight
                // into the layout (the old code) gave the box the wrong
                // aspect, which the rotation then skewed — the stretched look
                // reported on mobile in fullscreen and PiP.
                var layW = sideways ? evh * s : evw * s;
                var layH = sideways ? evw * s : evh * s;
                setDimImportant(video, 'width', Math.round(layW) + 'px');
                setDimImportant(video, 'height', Math.round(layH) + 'px');
                setDimImportant(video, 'maxWidth', 'none');
                setDimImportant(video, 'maxHeight', 'none');
            }
            // Inline !important transform: the stylesheet's `.voice-fs-wrap img
            // .relay-video { width/height: 100% !important }` used to win, so a
            // fullscreened tile showed the RAW feed with no mirror/rotation.
            setTransform(video, css);
            return;
        }
        var inMedia = video.parentElement && (
            video.parentElement.classList.contains('voice-member-media') ||
            video.parentElement.classList.contains('dm-call-tile-media') ||
            // The DM call panel's self strip — camera + screen share side by
            // side. Without the slot a rotated SELF camera's visual box sticks
            // out and overlaps the sibling screen tile (same bug as remote
            // tiles, which were already fixed).
            video.parentElement.classList.contains('voice-self-preview-wrap'));
        if (!sideways) {
            // Back to normal: unwrap any rotation slot (the flex row reserves
            // the video's natural footprint again) and clear the swapped dims.
            if (slot && slot.parentElement) {
                slot.parentElement.insertBefore(video, slot);
                slot.remove();
            }
            clearInlineDims(video);
            // Non-rotated tiles in media context: let CSS handle sizing
            // (height:100%, width:auto, max-width:46%). Only set inline dims
            // when there IS a rotation (sideways) that swaps width/height.
            setTransform(video, css);
            return;
        }
        // 90°/270° rotation. A rotated element's VISUAL box is the transpose of
        // its LAYOUT box — the flex row reserves the layout box, so the wider
        // visual sticks out and overlaps the sibling tile (rotated camera over
        // the screen share and vice versa). Fix: wrap the video in a slot sized
        // to the ROTATED visual box; the row then reserves the real footprint.
        if (slot) {
            // Already wrapped — reuse the slot's size (the video's %-based CSS
            // height no longer resolves against the row inside the slot).
            var sVw = parseFloat(slot.style.width);
            var sVh = parseFloat(slot.style.height);
            if (sVw > 0 && sVh > 0) {
                setDimImportant(video, 'width', Math.round(sVh) + 'px');
                setDimImportant(video, 'height', Math.round(sVw) + 'px');
                setDimImportant(video, 'maxWidth', 'none');
                setDimImportant(video, 'maxHeight', 'none');
                setTransform(video, css);
                return;
            }
        }
        if (!inMedia) {
            // Not in a tile row (e.g. the DM self preview) — plain transform.
            clearInlineDims(video);
            setTransform(video, css);
            return;
        }
        // Measure the NATURAL (unrotated) size while the video is still a
        // direct child of the row (height:100% resolves against the row).
        clearInlineDims(video);
        var bw = video.offsetWidth;
        var bh = video.offsetHeight;
        if (!(bw > 0 && bh > 0)) return;
        var parent = video.parentElement;
        var pw = parent ? parent.clientWidth : 0;
        var ph = parent ? parent.clientHeight : 0;
        // The rotated visual box is bh × bw scaled to fit the container.
        var s = Math.min(1,
            pw > 0 ? pw / bh : 1,
            ph > 0 ? ph / bw : 1);
        // Slot = the rotated (portrait) visual box; the video's layout is the
        // slot transposed (landscape, so the 16:9 content fills it without
        // letterboxing) and the rotation turns it into exactly the slot size.
        var Vw = Math.max(1, Math.round(bh * s));
        var Vh = Math.max(1, Math.round(bw * s));
        if (!slot) {
            slot = document.createElement('div');
            slot.className = 'voice-tile-slot';
            slot.setAttribute('data-uid', uid);
            slot.setAttribute('data-kind', kind);
            parent.insertBefore(slot, video);
            slot.appendChild(video);
        }
        slot.style.width = Vw + 'px';
        slot.style.height = Vh + 'px';
        slot.style.maxWidth = 'none';
        slot.style.maxHeight = 'none';
        // !important inline dims: the `.relay-video` stylesheet sets
        // `height:100%` / `width:auto` with !important and
        // `.voice-member-media .remote-video-tile` caps max-width — plain
        // inline sizes LOST to those and the rotated relay tile came back
        // cropped / oversized after a rebuild.
        setDimImportant(video, 'width', Vh + 'px');
        setDimImportant(video, 'height', Vw + 'px');
        setDimImportant(video, 'maxWidth', 'none');
        setDimImportant(video, 'maxHeight', 'none');
        setTransform(video, css);
    }

    // Reset any inline layout dims set by a previous rotation swap (including
    // the !important ones used inside fullscreen).
    function clearInlineDims(video) {
        if (!video) return;
        var props = { width: 'width', height: 'height', maxWidth: 'max-width', maxHeight: 'max-height' };
        Object.keys(props).forEach(function (p) {
            // removeProperty needs KEBAB-CASE — 'maxWidth' is invalid and
            // silently did nothing, so the !important caps survived a
            // fullscreen exit and kept the tile oversized (cropped).
            try { video.style.removeProperty(props[p]); } catch (_) {}
            try { video.style[p] = ''; } catch (_) {}
        });
    }

    // Inline !important transform. Inline beats the stylesheet, so this is how
    // the mirror/rotation is guaranteed to render — inside the CSS fullscreen
    // wrapper the sheet's !important sizing rules previously made the
    // transform invisible.
    function setTransform(node, css) {
        if (!node) return;
        try {
            if (css) node.style.setProperty('transform', css, 'important');
            else node.style.removeProperty('transform');
        } catch (_) {
            node.style.transform = css || '';
        }
    }

    // Inline !important beats the fullscreen stylesheet's !important rules.
    function setDimImportant(video, prop, val) {
        // setProperty expects kebab-case CSS property names
        var cssProp = prop.replace(/([A-Z])/g, '-$1').toLowerCase();
        try { video.style.setProperty(cssProp, val, 'important'); } catch (_) { video.style[prop] = val; }
    }

    function applyTileTransformAll(uid, kind) {
        // Both tile classes: remote/popup tiles (.remote-video-tile) and the
        // DM panel's own self strip (.voice-self-video).
        document.querySelectorAll('.remote-video-tile[data-kind="' + kind + '"][data-uid="' + uid + '"], .voice-self-video[data-kind="' + kind + '"][data-uid="' + uid + '"]').forEach(function (v) {
            applyTileTransform(v, uid, kind);
        });
        // Keep the "Reset view" hint chip in sync with the transform state.
        syncResetViewChips(uid, kind);
    }

    // ------------------------------------------------------------------
    // "Reset view" hint chip
    // ------------------------------------------------------------------
    // Floats at the bottom-center of ANY tile (camera or screen, remote or
    // your own, tile or fullscreen) whose feed is mirrored/rotated for you, so
    // the transform is noticeable and restorable in one click. Clicking clears
    // the per-viewer transform; right-click opens the same view/volume menu.
    function resetViewChipFeedKey(uid, kind) { return 'rv:' + feedKey(uid, kind); }

    function positionResetViewChip(chip, video) {
        if (!chip || !video) return;
        var place = function () {
            if (!chip.isConnected || !video.isConnected) return;
            var vr = video.getBoundingClientRect();
            if (vr.width <= 1 || vr.height <= 1) return; // not laid out yet
            var op = chip.offsetParent;
            if (!op) return;
            var or = op.getBoundingClientRect();
            var cw = chip.offsetWidth || 90;
            var ch = chip.offsetHeight || 24;
            // Clamp the chip INSIDE the tile's own bounds. Both sides must be
            // in offsetParent coordinates — the old clamp compared the chip's
            // parent-relative left against the tile's WIDTH, so on a narrow
            // mobile tile it pushed the chip outside the tile and off-screen.
            var tileLeft = vr.left - or.left;
            var tileTop = vr.top - or.top;
            var maxLeft = tileLeft + Math.max(0, vr.width - cw);
            var chipLeft = tileLeft + (vr.width - cw) / 2;
            chipLeft = Math.max(tileLeft, Math.min(chipLeft, maxLeft));
            chip.style.left = Math.round(chipLeft) + 'px';
            var maxTop = tileTop + Math.max(0, vr.height - ch);
            var chipTop = tileTop + vr.height - ch - 4;
            chip.style.top = Math.round(Math.max(tileTop, Math.min(chipTop, maxTop))) + 'px';
        };
        place();
        var tries = 0;
        (function retry() {
            if (tries < 5 && chip.isConnected && !chip.style.left) {
                tries++;
                setTimeout(place, 60);
            }
        })();
    }

    function syncResetViewChips(uid, kind) {
        var key = resetViewChipFeedKey(uid, kind);
        document.querySelectorAll('.voice-tile-reset-view[data-feed="' + key + '"]').forEach(function (c) { c.remove(); });
        var st = S.tileTransforms[uid + ':' + kind];
        if (!st || (!st.mirror && !st.rot)) return;
        // Only over a VISIBLE video for this feed (skip display:none tiles —
        // a hidden feed's chip would linger over the remaining visible one).
        var video = null;
        document.querySelectorAll('.remote-video-tile[data-kind="' + kind + '"][data-uid="' + uid + '"], .voice-self-video[data-kind="' + kind + '"][data-uid="' + uid + '"]').forEach(function (v) {
            if (!video && v.offsetParent) video = v;
        });
        if (!video) return;
        var parent = video.parentElement;
        if (parent && parent.classList && parent.classList.contains('voice-tile-slot')) parent = parent.parentElement;
        if (!parent) return;
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'voice-tile-reset-view';
        chip.setAttribute('data-feed', key);
        chip.title = 'This feed is mirrored/rotated for you — click to reset';
        chip.innerHTML = '<svg class="ui-icon" width="14" height="14"><use href="#icon-refresh-alt"/></svg><span class="voice-tile-reset-lbl">Reset view</span>';
        chip.addEventListener('click', function (e) {
            e.stopPropagation();
            setTileViewTransform(uid, kind, 'reset', 0);
        });
        chip.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            e.stopPropagation();
            openVolumeMenu(e, uid, kind === 'screen' ? 'screen' : 'video');
        });
        parent.appendChild(chip);
        positionResetViewChip(chip, video);
    }

    function syncAllResetViewChips() {
        Object.keys(S.tileTransforms).forEach(function (key) {
            var parts = key.split(':');
            if (parts.length === 2) syncResetViewChips(parts[0], parts[1]);
        });
    }

    function setTileViewTransform(uid, kind, action, val) {
        var key = uid + ':' + kind;
        var st = S.tileTransforms[key] || { mirror: false, rot: 0 };
        if (action === 'mirror') st.mirror = !!val;
        else if (action === 'rot') st.rot = ((val % 360) + 360) % 360;
        else if (action === 'reset') st = { mirror: false, rot: 0 };
        if (st.mirror || st.rot) S.tileTransforms[key] = st;
        else delete S.tileTransforms[key];
        applyTileTransformAll(uid, kind);
    }

    // ------------------------------------------------------------------
    // UI: volume menu (right-click)
    // ------------------------------------------------------------------
    // Build the "View" section of the volume menu: mirror horizontally / rotate
    // 90° left or right / reset — per-viewer CSS transforms on the feed being
    // right-clicked (camera or screen tile only).
    function buildViewSection(menu, uid, viewKind) {
        var tKey = uid + ':' + viewKind;
        var tState = S.tileTransforms[tKey] || { mirror: false, rot: 0 };
        var viewLabel = document.createElement('div');
        viewLabel.className = 'volume-menu-view-label';
        viewLabel.textContent = 'View';
        menu.appendChild(viewLabel);
        var viewRow = document.createElement('div');
        viewRow.className = 'volume-menu-view-row';
        var btnMirror = document.createElement('button');
        btnMirror.type = 'button';
        btnMirror.className = 'volume-menu-view-btn' + (tState.mirror ? ' active' : '');
        btnMirror.title = 'Mirror horizontally (always horizontal, independent of rotation)';
        btnMirror.innerHTML = icon('mirror') + ' Mirror';
        btnMirror.addEventListener('click', function (ev) {
            ev.stopPropagation();
            setTileViewTransform(uid, viewKind, 'mirror', !tState.mirror);
            tState = S.tileTransforms[tKey] || { mirror: false, rot: 0 };
            btnMirror.classList.toggle('active', !!tState.mirror);
        });
        viewRow.appendChild(btnMirror);
        var btnRotL = document.createElement('button');
        btnRotL.type = 'button';
        btnRotL.className = 'volume-menu-view-btn';
        btnRotL.title = 'Rotate 90° left';
        btnRotL.innerHTML = icon('rotate-left') + ' 90&deg;';
        btnRotL.addEventListener('click', function (ev) {
            ev.stopPropagation();
            setTileViewTransform(uid, viewKind, 'rot', (tState.rot || 0) - 90);
            tState = S.tileTransforms[tKey] || { mirror: false, rot: 0 };
        });
        viewRow.appendChild(btnRotL);
        var btnRotR = document.createElement('button');
        btnRotR.type = 'button';
        btnRotR.className = 'volume-menu-view-btn';
        btnRotR.title = 'Rotate 90° right';
        btnRotR.innerHTML = icon('rotate-right') + ' 90&deg;';
        btnRotR.addEventListener('click', function (ev) {
            ev.stopPropagation();
            setTileViewTransform(uid, viewKind, 'rot', (tState.rot || 0) + 90);
            tState = S.tileTransforms[tKey] || { mirror: false, rot: 0 };
        });
        viewRow.appendChild(btnRotR);
        var btnViewReset = document.createElement('button');
        btnViewReset.type = 'button';
        btnViewReset.className = 'volume-menu-view-btn';
        btnViewReset.title = 'Reset view (no mirror, no rotation)';
        btnViewReset.innerHTML = icon('reset') + ' Reset';
        btnViewReset.addEventListener('click', function (ev) {
            ev.stopPropagation();
            setTileViewTransform(uid, viewKind, 'reset', 0);
            tState = { mirror: false, rot: 0 };
            btnMirror.classList.remove('active');
        });
        viewRow.appendChild(btnViewReset);
        menu.appendChild(viewRow);
    }

    function openVolumeMenu(e, uid, kind) {
        var menu = el('volume-menu');
        if (!menu) return;
        // kind: 'member' (mic volume, default) | 'screen' (screen-share audio
        // volume — right-click the member's SCREEN tile) | 'video' (camera
        // tile — video only: no volume meter, since a camera feed carries no
        // audio; the member's mic volume lives on the member row / tile
        // chrome, and screen audio on the screen tile).
        var isScreen = kind === 'screen';
        var isVideoOnly = kind === 'video';
        var selfId = getSelfId();
        var isSelf = uid === selfId;
        var member = S.members[uid];
        var name = member ? (userDisplayNameCache[uid] && userDisplayNameCache[uid].display_name) || member.username || member.display_name || 'Member' : 'Member';
        // Your own camera/screen: the View section (mirror / rotate / reset)
        // works exactly like everyone else's tiles. Volume sliders are skipped
        // — you don't adjust your own mic or the audio of your own share here.
        var headerName;
        if (isSelf) {
            if (isScreen) headerName = 'Your screen share';
            else if (isVideoOnly) headerName = 'Your camera';
            else headerName = 'You';
        } else {
            headerName = name;
        }

        menu.innerHTML = '';
        var header = document.createElement('div');
        header.className = 'volume-menu-header';
        // Self tiles already carry "Your camera / Your screen share" — no
        // redundant prefix.
        header.textContent = isSelf ? headerName : ((isScreen ? 'Screen share — ' : (isVideoOnly ? 'Camera — ' : '')) + headerName);
        menu.appendChild(header);

        // View transform section: mirror horizontally / rotate 90° left or
        // right / reset — applies only to how THIS viewer sees the feed.
        // The mirror is always horizontal regardless of rotation. Only shown
        // when right-clicking a CAMERA or SCREEN tile (a member row has no
        // feed to transform).
        if (isScreen || isVideoOnly) {
            buildViewSection(menu, uid, isScreen ? 'screen' : 'camera');
        }

        // Volume meter: the member row controls the member's MIC volume, the
        // screen tile controls the SCREEN-share audio (a separate per-member
        // volume), and a camera tile has no audio at all — no meter. Skipped
        // for your own tiles (no self-loopback volume here).
        if (!isVideoOnly && !isSelf) {
            // Small caption so it's obvious WHICH volume this slider controls:
            // the member's mic, or the screen-share audio (separate per-member
            // volume).
            var volLabel = document.createElement('div');
            volLabel.className = 'volume-menu-vol-label';
            volLabel.textContent = isScreen ? 'Screen audio volume' : 'Mic volume';
            menu.appendChild(volLabel);
            var savedVol = parseInt(localStorage.getItem((isScreen ? 'voice_screen_volume_' : 'voice_volume_') + uid) || '100', 10);
            if (isNaN(savedVol)) savedVol = 100;
            var applyVol = isScreen ? setScreenVolume : setMemberVolume;
            var sliderRow = document.createElement('div');
            sliderRow.className = 'volume-menu-slider-row';
            var slider = document.createElement('input');
            slider.type = 'range';
            slider.min = 0;
            slider.max = 500;
            // The slider covers the 0–500% fine-tuning range; the custom % input
            // below goes up to 10000% for boosting quiet users.
            slider.value = String(Math.min(savedVol, 500));
            slider.className = 'volume-menu-slider';
            var val = document.createElement('span');
            val.id = 'volume-menu-value';
            val.className = 'volume-menu-value';
            val.textContent = savedVol + '%';
            slider.addEventListener('input', function () {
                var pct = parseInt(slider.value, 10);
                applyVol(uid, pct);
                var inp = menu.querySelector('.volume-menu-custom-input');
                if (inp) inp.value = String(pct);
            });
            sliderRow.appendChild(slider);
            sliderRow.appendChild(val);
            menu.appendChild(sliderRow);

            // Custom % input — allows boosting up to 10000% (type a value; the
            // slider caps at 500 but the applied gain uses the typed value).
            var inputRow = document.createElement('div');
            inputRow.className = 'volume-menu-input-row';
            var inp = document.createElement('input');
            inp.type = 'number';
            inp.min = 0;
            inp.max = 100000;
            inp.step = 5;
            inp.value = String(savedVol);
            inp.className = 'volume-menu-custom-input';
            var pctLbl = document.createElement('span');
            pctLbl.className = 'volume-menu-custom-pct';
            pctLbl.textContent = '%';
            function applyCustomPct() {
                var raw = parseInt(inp.value, 10);
                if (isNaN(raw)) raw = 100;
                var pct = Math.max(0, Math.min(100000, raw));
                inp.value = String(pct);
                applyVol(uid, pct);
                slider.value = String(Math.min(pct, 500));
            }
            inp.addEventListener('input', applyCustomPct);
            inp.addEventListener('change', applyCustomPct);
            inputRow.appendChild(inp);
            inputRow.appendChild(pctLbl);
            menu.appendChild(inputRow);

            // Reset this member's volume back to 100% (clears the per-user override)
            var resetBtn = document.createElement('button');
            resetBtn.className = 'volume-menu-btn';
            resetBtn.innerHTML = icon('reset') + ' Reset volume (100%)';
            resetBtn.addEventListener('click', function () {
                applyVol(uid, 100);
                var s = menu.querySelector('.volume-menu-slider');
                if (s) s.value = '100';
                var ci = menu.querySelector('.volume-menu-custom-input');
                if (ci) ci.value = '100';
                // Don't close menu — just update the display in place
            });
            menu.appendChild(resetBtn);
        }

        // Owner controls — only for the server owner, server rooms, OTHER
        // members, and only on the MEMBER row menu. Right-clicking a camera or
        // screen tile is about the FEED (view transforms / screen audio), not
        // the person — mute/deafen/kick live on the member row.
        if (!isScreen && !isVideoOnly && S.roomType === 'server' && S.isOwner && uid !== selfId) {
            var m = S.members[uid];
            var row1 = document.createElement('button');
            row1.className = 'volume-menu-btn';
            row1.innerHTML = m.force_muted ? icon('unlock') + ' Unmute' : icon('volume-off') + ' Server Mute';
            row1.addEventListener('click', function () {
                var wasMuted = !!m.force_muted;
                ownerControl(wasMuted ? 'unmute' : 'mute', uid);
                // Flip label in place — don't close menu
                m.force_muted = !wasMuted;
            row1.innerHTML = m.force_muted ? icon('volume-on') + ' Unmute' : icon('volume-off') + ' Server Mute';
                row1.className = 'volume-menu-btn' + (m.force_muted ? ' active' : '');
            });
            menu.appendChild(row1);
            var row2 = document.createElement('button');
            row2.className = 'volume-menu-btn';
            row2.innerHTML = m.force_deafened ? icon('unlock') + ' Undeafen' : icon('volume-off') + ' Server Deafen';
            row2.addEventListener('click', function () {
                var wasDeaf = !!m.force_deafened;
                ownerControl(wasDeaf ? 'undeafen' : 'deafen', uid);
                m.force_deafened = !wasDeaf;
                row2.innerHTML = m.force_deafened ? icon('unlock') + ' Undeafen' : icon('volume-off') + ' Server Deafen';
                row2.className = 'volume-menu-btn' + (m.force_deafened ? ' active' : '');
            });
            menu.appendChild(row2);
            var row3 = document.createElement('button');
            row3.className = 'volume-menu-btn danger';
            row3.innerHTML = icon('kick') + ' Kick';
            row3.addEventListener('click', function () {
                ownerControl('kick', uid);
                // Don't close menu — let the member row disappear on its own
            });
            menu.appendChild(row3);
        }

        // Soundboard mute/unmute — available for all users on other members
        if (!isScreen && !isVideoOnly && !isSelf && S.roomType === 'server') {
            var sbMutedList = (window._sbMutedList || []);
            var isSbMuted = sbMutedList.indexOf(uid) !== -1;
            var sbBtn = document.createElement('button');
            sbBtn.className = 'volume-menu-btn' + (isSbMuted ? ' active' : '');
            sbBtn.innerHTML = isSbMuted ? icon('check') + ' ' + icon('volume-on') + ' Unmute Soundboard' : icon('volume-off') + ' Mute Soundboard';
            sbBtn.addEventListener('click', function () {
                var serverId = window.currentServerId;
                // Update local mute list IMMEDIATELY (not in .then) so it takes
                // effect right away. _sbToggleMuteUser returns true if the user
                // is NOW muted (the closure's isSbMuted goes stale after the
                // first click — always derive the new state from the toggle).
                var nowMuted = false;
                if (window._sbToggleMuteUser) {
                    nowMuted = window._sbToggleMuteUser(uid);
                }
                // Stop any currently playing sounds from this user immediately,
                // but ONLY when muting. On unmute we must NOT call
                // _handleSoundboardStop because it deletes _sbSuppressedPlays[uid]
                // before _sbResumeForUser can read it — which kills the resume.
                if (nowMuted && window._handleSoundboardStop) {
                    window._handleSoundboardStop({ user_id: uid });
                }
                // Also persist to server (fire-and-forget)
                var method = nowMuted ? 'PUT' : 'DELETE';
                var _sbAuthToken = localStorage.getItem('token') || '';
                fetch('/api/soundboard/mute/' + serverId + '/' + uid, {
                    method: method,
                    headers: Object.assign({ 'Content-Type': 'application/json' }, _sbAuthToken ? { Authorization: 'Bearer ' + _sbAuthToken } : {}),
                }).catch(function () {});
                // On UNMUTE: resume this user's soundboard sound if one was
                // suppressed while they were muted (like a late join).
                if (!nowMuted && window._sbResumeForUser) {
                    window._sbResumeForUser(uid);
                }
                // Update the indicator IN PLACE — the menu stays open and the
                // ✓ label flips without needing to reopen it.
                sbBtn.className = 'volume-menu-btn' + (nowMuted ? ' active' : '');
                sbBtn.innerHTML = nowMuted ? icon('check') + ' ' + icon('volume-on') + ' Unmute Soundboard' : icon('volume-off') + ' Mute Soundboard';
            });
            menu.appendChild(sbBtn);
        }

        // Owner controls — Disable/Enable this member's soundboard (server owner only)
        // Merged: the per-user disable is the owner's tool; the global kill-switch
        // lives in Settings → Voice, so there's no need for a separate context-menu button.
        if (!isScreen && !isVideoOnly && !isSelf && S.roomType === 'server' && S.isOwner) {
            var sbDisabledList = (window._sbDisabledUsers || []);
            var isSbDisabled = sbDisabledList.indexOf(uid) !== -1;
            var sbDisBtn = document.createElement('button');
            sbDisBtn.className = 'volume-menu-btn' + (isSbDisabled ? ' active' : '');
            sbDisBtn.innerHTML = isSbDisabled ? icon('check') + ' ' + icon('volume-on') + ' Enable Soundboard' : icon('close') + ' Disable Soundboard';
            sbDisBtn.addEventListener('click', function () {
                var serverId = window.currentServerId;
                // Update local disabled list IMMEDIATELY, then derive the new
                // state from the array itself (closure state goes stale).
                var idx = window._sbDisabledUsers.indexOf(uid);
                if (idx !== -1) {
                    window._sbDisabledUsers.splice(idx, 1);
                } else {
                    window._sbDisabledUsers.push(uid);
                }
                var nowDisabled = window._sbDisabledUsers.indexOf(uid) !== -1;
                // Stop sounds only when DISABLE-ing. On enable, do NOT call
                // _handleSoundboardStop — it deletes _sbSuppressedPlays[uid]
                // before _sbResumeForUser can read it (same bug as mute).
                if (nowDisabled && window._handleSoundboardStop) {
                    window._handleSoundboardStop({ user_id: uid });
                }
                // Also persist to server (fire-and-forget)
                var method = nowDisabled ? 'PUT' : 'DELETE';
                var _sbAuthToken2 = localStorage.getItem('token') || '';
                fetch('/api/soundboard/disable/' + serverId + '/' + uid, {
                    method: method,
                    headers: Object.assign({ 'Content-Type': 'application/json' }, _sbAuthToken2 ? { Authorization: 'Bearer ' + _sbAuthToken2 } : {}),
                }).catch(function () {});
                // On ENABLE: resume this user's soundboard sound if one was
                // suppressed while they were disabled (like a late join).
                if (!nowDisabled && window._sbResumeForUser) {
                    window._sbResumeForUser(uid);
                }
                // Update the indicator IN PLACE — menu stays open, label flips.
                sbDisBtn.className = 'volume-menu-btn' + (nowDisabled ? ' active' : '');
                sbDisBtn.innerHTML = nowDisabled ? icon('check') + ' ' + icon('volume-on') + ' Enable Soundboard' : icon('close') + ' Disable Soundboard';
            });
            menu.appendChild(sbDisBtn);
        }

        menu.style.display = 'block';
        var x = Math.min(e.clientX, window.innerWidth - 220);
        var y = Math.min(e.clientY, window.innerHeight - 260);
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';

        // Close on click OUTSIDE the menu only — clicks inside (slider, custom
        // % input, buttons) must never dismiss it. Previously the first click
        // anywhere (including inside the menu) closed it, making the controls
        // unusable.
        if (menu._volDocClick) document.removeEventListener('click', menu._volDocClick);
        var onDocClick = function (e) {
            if (menu.style.display === 'none' || menu.contains(e.target)) return;
            closeVolumeMenu();
            document.removeEventListener('click', onDocClick);
            menu._volDocClick = null;
        };
        menu._volDocClick = onDocClick;
        setTimeout(function () {
            document.addEventListener('click', onDocClick);
        }, 10);
    }

    function closeVolumeMenu() {
        var menu = el('volume-menu');
        if (menu) menu.style.display = 'none';
    }

    function bindVolumeMenu() {
        var menu = el('volume-menu');
        if (menu) menu.style.display = 'none';
    }

    // ------------------------------------------------------------------
    // DM header call buttons (injected after header rebuilds)
    // ------------------------------------------------------------------
    function maybeInjectDmCallButtons() {
        var hdr = el('channel-name');
        if (!hdr) return;
        var inDmView = typeof viewMode !== 'undefined' && viewMode === 'dms' && typeof currentDmOtherUser !== 'undefined' && currentDmOtherUser;
        if (!inDmView) return;
        if (hdr.querySelector('.dm-call-btns')) return;
        var other = currentDmOtherUser;
        if (!other || !other.id) return;
        var wrap = document.createElement('span');
        wrap.className = 'dm-call-btns';
        wrap.style.marginLeft = '10px';
        wrap.style.whiteSpace = 'nowrap';
        var voiceBtn = document.createElement('button');
        voiceBtn.className = 'btn-unfriend dm-call-btn';
        voiceBtn.title = 'Voice call';
        voiceBtn.innerHTML = '&#128222;';
        voiceBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var chId = currentDmChannelId;
            // Already in a call in this DM (possibly waiting) — a click is a
            // nudge, re-ring the partner without re-joining the room.
            if (S.dmCallActive && S.dmChannelId === chId) {
                send({ type: 'dm_call_ring', dm_channel_id: chId });
                showToast('Ringing ' + (other.username || other.display_name || '…') + '…');
                return;
            }
            // The OTHER person is waiting in this DM's call room (we missed
            // their call). Joining silently connects both sides instantly —
            // ringing again would race with the room reconnect.
            var wc = S.waitingCalls ? S.waitingCalls[chId] : null;
            if (wc && !S.dmCallActive && wc.waitingUserId !== getSelfId()) {
                joinWaitingCall(chId, other.id, other.username || other.display_name || '');
                return;
            }
            // Otherwise start a fresh call (or, if I'M the one waiting after a
            // refresh, ring the other person — the room reconnect happens
            // through the normal join flow).
            startDmCall(chId, other.id, other.username || other.display_name || '');
        });
        wrap.appendChild(voiceBtn);
        hdr.appendChild(wrap);
    }

    // ------------------------------------------------------------------
    // Sounds (WebAudio beeps — no files needed)
    // ------------------------------------------------------------------
    function playSound(kind) {
        ensureAudioCtx();
        if (!S.audioCtx) return;
        try {
            var ctx = S.audioCtx;
            if (ctx.state === 'suspended') ctx.resume().catch(function () {});
            var osc = ctx.createOscillator();
            var gain = ctx.createGain();
            osc.type = 'sine';
            var now = ctx.currentTime;
            var freq = 440, dur = 0.08;
            if (kind === 'mute') { freq = 220; dur = 0.06; }
            else if (kind === 'unmute') { freq = 520; dur = 0.08; }
            else if (kind === 'deafen') { freq = 180; dur = 0.09; }
            else if (kind === 'undeafen') { freq = 560; dur = 0.09; }
            else if (kind === 'join') { freq = 660; dur = 0.12; }
            else if (kind === 'leave') { freq = 330; dur = 0.15; }
            else if (kind === 'ring') { freq = 880; dur = 0.15; }
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.15, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now);
            osc.stop(now + dur);
        } catch (_) {}
    }

    // ------------------------------------------------------------------
    // Ringtone (custom, encrypted, syncs across devices — Settings → Voice)
    // ------------------------------------------------------------------
    // Plays the user's chosen ringtone when a DM call rings. If the file is
    // shorter than the ring, it loops. Falls back to a default beep pattern
    // when no custom ringtone is set.
    function stopRingtone() {
        // Stop the per-cycle haptic ticker: the ring is over (answered,
        // declined, waiting-flip, hang-up). It restarts on a new ring.
        stopRingHapticTicker();
        // Bump the token so any in-flight async ringtone load/decode aborts
        // instead of starting a source after the ring ended.
        S._ringToken = (S._ringToken || 0) + 1;
        if (S._testRingTimer) {
            clearTimeout(S._testRingTimer);
            S._testRingTimer = null;
        }
        if (S._ringtoneSource) {
            try { S._ringtoneSource.stop(); } catch (_) {}
            try { S._ringtoneSource.disconnect(); } catch (_) {}
            S._ringtoneSource = null;
        }
        if (S._ringtoneGain) {
            try { S._ringtoneGain.disconnect(); } catch (_) {}
            S._ringtoneGain = null;
        }
        if (S._ringtoneRepeatTimer) {
            clearTimeout(S._ringtoneRepeatTimer);
            S._ringtoneRepeatTimer = null;
        }
    }

    // Ringtone volume from the Voice settings slider (0-100%), clamped to 0-1.
    function getRingtoneVolume() {
        var v = parseInt(localStorage.getItem('ringtone_volume'), 10);
        if (isNaN(v)) v = 60;
        if (v < 0) v = 0;
        if (v > 100) v = 100;
        return v / 100;
    }

    // loop=true → keep playing until stopRingtone() (call ring).
    // loop=false → play once (Test Ringtone button).
    function playRingtone(loop) {
        ensureAudioCtx();
        if (!S.audioCtx) return;
        stopRingtone();
        // Generation token: the custom-ringtone path is fully async (getRingtoneUrl
        // → FileReader → decodeAudioData). If the call is accepted/declined/ended
        // while the audio is still loading/decoding, the pending callbacks must NOT
        // start a source afterwards — otherwise the ringtone plays mid-call.
        var token = (S._ringToken = (S._ringToken || 0) + 1);
        var ctx = S.audioCtx;
        if (ctx.state === 'suspended') ctx.resume().catch(function () {});
        var urlPromise = (typeof getRingtoneUrl === 'function') ? getRingtoneUrl() : Promise.resolve(null);
        Promise.resolve(urlPromise).then(function (url) {
            if (token !== S._ringToken) return;
            if (!url) { playDefaultRingtone(loop, token); return; }
            var blob = dataUrlToBlob(url);
            if (!blob) { playDefaultRingtone(loop, token); return; }
            var reader = new FileReader();
            reader.onload = function (e) {
                if (token !== S._ringToken) return;
                try {
                    ctx.decodeAudioData(e.target.result, function (buffer) {
                        if (token !== S._ringToken) return;
                        try {
                            var source = ctx.createBufferSource();
                            source.buffer = buffer;
                            source.loop = !!loop;
                            var gain = ctx.createGain();
                            gain.gain.value = getRingtoneVolume();
                            source.connect(gain);
                            gain.connect(S.masterGain || ctx.destination);
                            source.start(0);
                            S._ringtoneSource = source;
                            S._ringtoneGain = gain;
                            // Sync the haptic ticker to the real ringtone
                            // length so an unanswered call buzzes once per
                            // actual loop (custom files are 1-30s).
                            if (loop && S.incomingCall && typeof buffer.duration === 'number' && buffer.duration > 0) {
                                resyncRingHapticTicker(Math.round(buffer.duration * 1000));
                            }
                        } catch (err) {
                            console.warn('Ringtone play failed, using default:', err);
                            playDefaultRingtone(loop, token);
                        }
                    }, function () {
                        console.warn('Ringtone decode failed, using default');
                        playDefaultRingtone(loop, token);
                    });
                } catch (err) {
                    console.warn('Ringtone decode error, using default:', err);
                    playDefaultRingtone(loop, token);
                }
            };
            reader.onerror = function () {
                console.warn('Ringtone read failed, using default');
                playDefaultRingtone(loop, token);
            };
            reader.readAsArrayBuffer(blob);
        }).catch(function () {
            if (token === S._ringToken) playDefaultRingtone(loop, token);
        });
    }

    function playDefaultRingtone(loop, token) {
        ensureAudioCtx();
        if (!S.audioCtx) return;
        var ctx = S.audioCtx;
        var ringOnce = function () {
            if (!S.audioCtx) return;
            if (token !== undefined && token !== S._ringToken) return;
            try {
                var now = ctx.currentTime;
                // Disconnect the previous repeat's gain so repeats don't stack.
                if (S._ringtoneGain) {
                    try { S._ringtoneGain.disconnect(); } catch (_) {}
                    S._ringtoneGain = null;
                }
                var gain = ctx.createGain();
                gain.connect(S.masterGain || ctx.destination);
                gain.gain.setValueAtTime(0, now);
                gain.gain.linearRampToValueAtTime(0.18, now + 0.02);
                gain.gain.linearRampToValueAtTime(0, now + 0.5);
                var osc = ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.value = 880;
                osc.connect(gain);
                osc.start(now);
                osc.stop(now + 0.55);
                if (loop) {
                    S._ringtoneRepeatTimer = setTimeout(function () { ringOnce(); }, 1100);
                }
                // Keep a ref so stopRingtone can silence mid-ring.
                S._ringtoneGain = gain;
            } catch (_) {}
        };
        ringOnce();
    }

    // Exposed for the Test Ringtone button in Settings (plays once).
    function testRingtone() {
        // Don't let the settings preview kill a real incoming-call ringtone.
        if (S.incomingCall || S.dmCallActive) return;
        playRingtone(false);
        // Auto-stop after ~4s so a long ringtone doesn't keep playing. Stored in
        // a handle and cleared by stopRingtone so a real call ringing during the
        // test window can't be silenced by this stale timeout.
        if (S._testRingTimer) { clearTimeout(S._testRingTimer); S._testRingTimer = null; }
        S._testRingTimer = setTimeout(function () {
            S._testRingTimer = null;
            stopRingtone();
        }, 4000);
    }

    // ------------------------------------------------------------------
    // Self UI
    // ------------------------------------------------------------------
    function updateSelfUI() {
        ['voice-bar-mute', 'voice-popup-mute', 'dm-call-mute', 'dm-mini-bar-mute'].forEach(function (id) {
            var b = el(id);
            if (!b) return;
            b.innerHTML = S.muted ? icon('mic-off') : icon('mic');
            b.classList.toggle('active', S.muted);
            b.classList.toggle('locked', S.forceMuted);
        });
        ['voice-bar-deafen', 'voice-popup-deafen', 'dm-call-deafen', 'dm-mini-bar-deafen'].forEach(function (id) {
            var b = el(id);
            if (!b) return;
            b.innerHTML = S.deafened ? icon('volume-off') : icon('volume-on');
            b.classList.toggle('active', S.deafened);
            b.classList.toggle('locked', S.forceDeafened);
        });
        ['voice-bar-camera', 'voice-popup-camera', 'dm-call-camera', 'dm-mini-bar-camera'].forEach(function (id) {
            var b = el(id);
            if (!b) return;
            b.classList.toggle('active', S.cameraOn);
        });
        ['voice-bar-screen', 'voice-popup-screen', 'dm-call-screen', 'dm-mini-bar-screen'].forEach(function (id) {
            var b = el(id);
            if (!b) return;
            b.classList.toggle('active', S.screenOn);
        });
        // Camera options button (opens the flip/mirror/flash/audio/video mode dropdown) —
        // always enabled so video mesh mode toggle is accessible without camera.
        ['voice-bar-cam-opt', 'voice-popup-cam-opt', 'dm-call-cam-opt', 'dm-mini-bar-cam-opt'].forEach(function (id) {
            var b = el(id);
            if (!b) return;
            b.disabled = false;
        });
        // Keep the dropdown's own option states fresh (active mirror/flash).
        updateCamOptMenuState();
        // If the camera turned off, never leave the white flash overlay up.
        // (Directly — setCameraFlashOn would re-enter updateSelfUI.)
        if (!S.cameraOn) {
            var _ov2 = el('camera-flash-overlay');
            if (_ov2) _ov2.style.display = 'none';
        }
    }

    // ------------------------------------------------------------------
    // Channel-list members (who is in each voice channel)
    // Renders from the server-wide voice_presence snapshot so even members
    // who are NOT in the room see who is connected + speaking.
    // ------------------------------------------------------------------
    function updateChannelChips() {
        var serverId = (typeof currentServerId !== 'undefined' && currentServerId) || S.serverId;
        if (!serverId) return;
        var presence = S.serverPresence[serverId];
        var items = document.querySelectorAll('.channel-item-voice');

        items.forEach(function (item) {
            var chId = item.getAttribute('data-id');
            if (!chId) return;
            var chipWrap = item.querySelector('.voice-channel-chips');
            if (!chipWrap) {
                chipWrap = document.createElement('div');
                chipWrap.className = 'voice-channel-chips';
                item.appendChild(chipWrap);
            }

            // Find the members for this channel from the presence snapshot.
            // Fall back to live room members when we're inside this channel.
            var members = null;
            if (presence && presence.channels) {
                for (var i = 0; i < presence.channels.length; i++) {
                    if (presence.channels[i].channel_id === chId) {
                        members = presence.channels[i].members || [];
                        break;
                    }
                }
            }
            if (S.connected && S.roomType === 'server' && S.channelId === chId) {
                members = Object.keys(S.members).map(function (uid) { return S.members[uid]; });
            }

            var html = '';
            (members || []).forEach(function (m) {
                var speaking = m.speaking && !(m.muted || m.force_muted);
                var name = (userDisplayNameCache[m.user_id] && userDisplayNameCache[m.user_id].display_name) || m.username || '? ';
                var picId = userDisplayNameCache[m.user_id] && userDisplayNameCache[m.user_id].profile_picture_file_id;
                var picKey = picId ? (m.user_id + ':' + picId) : '';
                var picUrl = picKey && profilePicCache[picKey];
                var title = name + (m.muted || m.force_muted ? ' (muted)' : '') + (m.deafened || m.force_deafened ? ' (deafened)' : '') + (m.screen ? ' (sharing)' : '') + (m.camera ? ' (camera)' : '');

                var avatar;
                if (picUrl) {
                    avatar = '<img class="voice-chip-avatar" src="' + esc(picUrl) + '" alt="" loading="lazy">';
                } else if (picId) {
                    avatar = '<span class="voice-chip-avatar voice-chip-avatar-load" data-profile-pic-load="' + esc(picKey) + '">' + esc(name).charAt(0).toUpperCase() + '</span>';
                    // Kick off the async PFP fetch/decrypt once per key (guarded
                    // so re-renders during speaking toggles don't re-fetch).
                    if (!S._pfpLoading[picKey]) {
                        S._pfpLoading[picKey] = true;
                        try { getProfilePicUrl(picId, m.user_id); } catch (_) {}
                    }
                } else {
                    avatar = '<span class="voice-chip-avatar">' + esc(name).charAt(0).toUpperCase() + '</span>';
                }

                var badges = '';
                if (m.force_muted) badges += '<span class="vc-badge locked" title="Server muted">' + icon('lock') + icon('mic-off') + '</span>';
                else if (m.muted) badges += '<span class="vc-badge" title="Muted">' + icon('mic-off') + '</span>';
                if (m.force_deafened) badges += '<span class="vc-badge locked" title="Server deafened">' + icon('lock') + icon('volume-off') + '</span>';
                else if (m.deafened) badges += '<span class="vc-badge" title="Deafened">' + icon('volume-off') + '</span>';
                if (m.camera) badges += '<span class="vc-badge" title="Camera">' + icon('camera') + '</span>';
                if (m.screen) badges += '<span class="vc-badge" title="Screen">' + icon('monitor') + '</span>';

                var chipStyle = memberNameStyle(m.user_id);
                var isSelfChip = m.user_id === getSelfId();
                html += '<div class="voice-chip-row' + (speaking ? ' speaking' : '') + '" data-uid="' + esc(m.user_id) + '" title="' + esc(title) + '">' +
                    avatar +
                    '<span class="voice-chip-name"' + (chipStyle ? ' style="' + chipStyle + '"' : '') + '>' + esc(name) + '</span>' +
                    (badges ? '<span class="voice-chip-badges">' + badges + '</span>' : '') +
                    // Call button on every OTHER member's chip — starts a DM
                    // call with them right from the channel list.
                    (!isSelfChip ? '<button class="voice-chip-call" data-uid="' + esc(m.user_id) + '" title="Call ' + esc(name) + '" aria-label="Call ' + esc(name) + '">📞</button>' : '') +
                    '</div>';
            });
            chipWrap.innerHTML = html;
            // Click a chip's PFP → open that member's profile view.
            chipWrap.querySelectorAll('.voice-chip-avatar').forEach(function (av) {
                av.addEventListener('click', function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    var row = av.closest('.voice-chip-row');
                    if (!row) return;
                    var uid = row.getAttribute('data-uid');
                    if (uid && typeof openProfileModal === 'function') openProfileModal(uid);
                });
            });
            // Click a chip's call button → DM call with that member.
            chipWrap.querySelectorAll('.voice-chip-call').forEach(function (btn) {
                btn.addEventListener('click', function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    var uid = btn.getAttribute('data-uid');
                    if (!uid) return;
                    callMemberFromVoice(uid, '');
                });
            });
        });
    }

    // ------------------------------------------------------------------
    // Settings helpers
    // ------------------------------------------------------------------
    function setMicVolume(v) {
        S.settings.micVolume = v;
        saveSettings();
        if (S.micGain) S.micGain.gain.value = v / 100;
        // Live-update hear-self test gain if running
        if (S._hearSelfSink) S._hearSelfSink.gain.value = v / 100;
        // Update all volume labels (settings modal + voice popup)
        if (typeof updateSettingsLabels === 'function') updateSettingsLabels();
    }

    function setSpeakerVolume(v) {
        S.settings.speakerVolume = v;
        saveSettings();
        // masterGain still feeds the ringtone; remote audio uses <audio>
        // element stacks whose volume is (re)computed from speakerVolume.
        if (S.masterGain) S.masterGain.gain.value = v / 100;
        Object.keys(S.remoteAudioEls).forEach(function (uid) {
            applyRemoteVolume(uid);
        });
        Object.keys(S.remoteScreenAudioEls).forEach(function (uid) {
            applyRemoteScreenVolume(uid);
        });
        if (_hearSelfAudioEl) _hearSelfAudioEl.volume = v / 100;
        if (typeof updateSettingsLabels === 'function') updateSettingsLabels();
    }

    function setNoiseSuppression(mode) {
        S.settings.noiseSuppressionMode = mode;
        saveSettings();
        updateSettingsLabels();
        restartMicForSettings();
        // Live-restart hear-self test if running so NS chain rebuilds
        if (S.settings.hearSelf && window._stopHearSelfTest) {
            window._stopHearSelfTest();
            // Small delay to let the old stream tracks stop
            setTimeout(function () {
                if (_hearSelfBtn) _hearSelfBtn.click();
            }, 150);
        }
    }

    function setEchoCancellation(enabled) {
        S.settings.echoCancellation = !!enabled;
        saveSettings();
        updateSettingsLabels();
        restartMicForSettings();
    }

    // ---- Video quality settings (Settings → Voice → Video Quality) ----

    // 16:9 width for a target height (what getUserMedia/getDisplayMedia ask for).
    function resW(h) {
        return Math.round((h || 360) * 16 / 9);
    }

    // A bitrate that matches the EFFECTIVE resolution. Over-allocating bitrate
    // at low resolution is harmless, but under-allocating at high resolution is
    // exactly what produces the blocky/"torn" artifacts — so the cap follows
    // the resolution instead of being a fixed per-kind number.
    function bitrateForRes(h, isScreen) {
        if (h >= 2160) return 12000000;
        if (h >= 1440) return 8000000;
        if (h >= 1080) return isScreen ? 5000000 : 3000000;
        if (h >= 720) return 2500000;
        if (h >= 480) return 1200000;
        if (h >= 360) return 700000;
        if (h >= 240) return 400000;
        return 250000;
    }

    // Change the CAPTURE resolution of a source. If the source is live, restart
    // it so the new resolution takes effect immediately (camera: re-request GUM
    // at the new size; screen: re-prompt + re-capture).
    function setSendRes(kind, h) {
        h = parseInt(h, 10) || (kind === 'screen' ? 480 : 360);
        S.settings[kind === 'screen' ? 'sendScreenRes' : 'sendCameraRes'] = h;
        saveSettings();
        updateSettingsLabels();
        if (!S.connected) return;
        if (kind === 'screen' && S.screenOn) {
            stopScreen();
            startScreen();
        } else if (kind === 'camera' && S.cameraOn) {
            stopCamera();
            startCamera();
        }
        retuneAllVideoSenders();
    }

    // ------------------------------------------------------------------
    // Video relay: canvas capture → encrypt → WebSocket → server → peers
    // ------------------------------------------------------------------
    // When relay mode is active, video frames are captured from the local
    // camera/screen track via a canvas, JPEG-encoded, AES-GCM encrypted
    // with the room key, and sent as WebSocket messages. The server relays
    // them to all room members. This replaces WebRTC video tracks for
    // server voice channels (audio stays on WebRTC mesh).
    //
    // Benefits: server handles bandwidth for video distribution, each
    // participant only uploads 1 copy of their video to the server.
    // Trade-off: slightly higher latency (~100ms vs ~50ms for P2P video)
    // but video quality/scale is prioritized.

    S._relayTimers = {};   // { camera: intervalId, screen: intervalId }
    var _relayCanvases = {}; // { camera: canvas, screen: canvas }
    // Drop relayed video frames once the WebSocket backlog passes this. Video
    // is the sacrificial stream: the audio relay keeps flowing regardless (it
    // is tiny and must never be starved by a busy video pipe).
    var RELAY_VIDEO_MAX_BUFFERED = 256 * 1024;

    // Determine whether to use relay mode for video in the current room.
    // Server voice channels use relay; DM calls use WebRTC mesh.
    function useVideoRelay(kind) {
        if (S.roomType !== 'server' || !S.connected) return false;
        var selfId = getSelfId();
        // Check kind-specific override first (camera/screen have independent modes)
        if (kind === 'camera') return resolveCameraMode(selfId) === 'relay';
        if (kind === 'screen') return resolveScreenMode(selfId) === 'relay';
        return resolveVideoMode(selfId) === 'relay';
    }

    // Start capturing frames from a MediaStream and relaying them via WebSocket.
    // kind = 'camera' | 'screen'
    function startVideoRelay(stream, kind) {
        if (S._relayTimers[kind]) return; // already running

        var fps = S.settings.relayVideoFps || 15;
        var maxH = S.settings[kind === 'screen' ? 'sendScreenRes' : 'sendCameraRes'] || (kind === 'screen' ? 480 : 360);

        // Multithreading support: the JPEG encode runs in a worker (needs
        // OffscreenCanvas + createImageBitmap), and a backgrounded tab uses a
        // worker clock instead of being clamped to 1 fps.
        var _workerClockAvailable = (typeof Worker !== 'undefined');
        var _canWorkerEncode = _workerClockAvailable && typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined';

        var video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        // Keep the element in the document (hidden) — Chrome is inconsistent
        // about decoding frames for a fully detached media element, and a
        // stalled decode is what makes drawImage() re-draw a stale frame.
        video.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;';
        document.body.appendChild(video);
        video.play().catch(function () {});

        // Wait for the video to have dimensions before starting the loop
        var startLoop = function () {
            if (S._relayTimers[kind]) return;
            // Size the capture canvas from the SOURCE's real aspect ratio —
            // NOT a forced 16:9. The old code always built a resW(maxH)×maxH
            // canvas, so a portrait phone camera (e.g. 720×1280) was drawn
            // stretched sideways into a landscape canvas and every consumer
            // (tile, fullscreen, PiP) showed the pre-stretched frame — the
            // reported "width is kept the same while height is the only one
            // being resized". Cap the HEIGHT at the configured resolution;
            // width follows the ratio (a 16:9 source at maxH keeps its exact
            // old dimensions, so only non-16:9 sources change).
            var srcW = video.videoWidth || 0;
            var srcH = video.videoHeight || 0;
            var w = resW(maxH);
            var h = maxH;
            if (srcW > 0 && srcH > 0) {
                var sc = maxH / srcH;
                w = Math.max(2, Math.round(srcW * sc));
                h = Math.max(2, Math.round(srcH * sc));
            }
            // Double-buffer: two canvases so capture can run while the previous
            // frame is still being encoded — prevents the busy guard from dropping
            // every other frame when toBlob() is slow.
            var canvasA = document.createElement('canvas');
            canvasA.width = w; canvasA.height = h;
            var canvasB = document.createElement('canvas');
            canvasB.width = w; canvasB.height = h;
            var ctxA = canvasA.getContext('2d');
            var ctxB = canvasB.getContext('2d');
            var state = { running: true, video: video, _visHandler: null, encWorker: null };
            _relayCanvases[kind] = state;
            S._relayTimers[kind] = true; // mark as active
            var encodingA = false; // per-canvas: true while encode+encrypt is in flight
            var encodingB = false;
            var reusableKeyBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(S.roomKeyB64));
            var targetMs = Math.max(16, 1000 / fps);
            var sendIndex = 0; // alternates 0/1 for double-buffer

            // Chrome clamps setTimeout on a HIDDEN page to ~1/s (and to
            // 1/minute after a while). A blurred-but-visible window is NOT
            // throttled, so only a truly backgrounded tab takes the worker
            // clock path. The old `|| !document.hasFocus()` condition made
            // every relay loop busy-spin the moment the screen-share picker
            // stole focus — with two streams (camera + screen) that spin
            // saturated the main thread, which collapsed BOTH feeds to ~1 fps
            // and starved the audio-relay poll at the same time.
            function needsUnthrottledLoop() {
                return _workerClockAvailable && document.visibilityState === 'hidden';
            }
            S._relayStats = S._relayStats || {};
            S._relayStats[kind] = { sent: 0, startedAt: Date.now() };

            // ---- Off-main-thread JPEG encoder ----
            // The JPEG encode is the expensive part of a relay frame. Doing it
            // on the main thread for TWO simultaneous streams starves timers
            // and the audio relay, so each stream gets its own worker that
            // draws the frame on an OffscreenCanvas and encodes it there.
            var encWorker = null;
            var frameSeq = 0;
            if (_canWorkerEncode) {
                try { encWorker = new Worker('relay-encode-worker.js'); } catch (_) { encWorker = null; }
            }
            state.encWorker = encWorker;

            function finishEncode(isA) { if (isA) encodingA = false; else encodingB = false; }

            // Backpressure check → encrypt → relay. Video is dropped
            // aggressively when the socket is congested; the audio relay has
            // its own (much higher) threshold so audio is never starved by a
            // busy video pipe.
            function sendEncoded(buf, isA) {
                var ws = getWs();
                if (ws && ws.bufferedAmount > RELAY_VIDEO_MAX_BUFFERED) { finishEncode(isA); return; }
                try {
                    var raw = new Uint8Array(buf);
                    var enc = E2ECrypto.aeadEncrypt(raw, reusableKeyBytes);
                    sendRelayBinary(kind, enc.nonce, new Uint8Array(E2ECrypto.base64ToArrayBuffer(enc.ciphertext)));
                    try { S._relayStats[kind].sent++; } catch (_) {}
                } catch (_) {}
                finishEncode(isA);
            }

            if (encWorker) {
                encWorker.onmessage = function (e) {
                    var d = e.data || {};
                    if (d.error || !d.buffer || d.size < 100) { finishEncode(!!d.isA); return; }
                    sendEncoded(d.buffer, !!d.isA);
                };
                encWorker.onerror = function () { finishEncode(true); finishEncode(false); };
            }

            // Capture-and-send pipeline — draws onto the idle canvas, then
            // kicks off async encode on that canvas. Returns immediately so
            // the caller can schedule the next capture without waiting.
            function captureFrame() {
                if (!state.running || !S.connected || !S.roomKeyB64) { S._relayTimers[kind] = null; state.running = false; return; }
                // Pick the idle canvas (alternate each frame)
                var drawCanvas = sendIndex === 0 ? canvasA : canvasB;
                var drawCtx = sendIndex === 0 ? ctxA : ctxB;
                var isA = sendIndex === 0;
                sendIndex = 1 - sendIndex;
                // Skip this canvas if its previous encode is still in flight
                if (isA ? encodingA : encodingB) return;
                if (isA) encodingA = true; else encodingB = true;
                try {
                    drawCtx.drawImage(video, 0, 0, w, h);
                    if (encWorker) {
                        // Hand the frame to the worker as an ImageBitmap so the
                        // JPEG encode happens off the main thread.
                        createImageBitmap(drawCanvas).then(function (bmp) {
                            try {
                                encWorker.postMessage({ id: ++frameSeq, bitmap: bmp, isA: isA, quality: S.settings.relayVideoQuality || 0.6 }, [bmp]);
                            } catch (_) { try { bmp.close(); } catch (_e) {} finishEncode(isA); }
                        }).catch(function () { finishEncode(isA); });
                        return;
                    }
                    drawCanvas.toBlob(function (blob) {
                        if (!blob || blob.size < 100) { finishEncode(isA); return; }
                        blob.arrayBuffer().then(function (buf) { sendEncoded(buf, isA); }).catch(function () { finishEncode(isA); });
                    }, 'image/jpeg', S.settings.relayVideoQuality || 0.6);
                } catch (_) { finishEncode(isA); }
            }

            // ---- Timer modes ----
            // Visible: a plain setTimeout chain at the target rate.
            // Backgrounded: a dedicated worker clock. A worker's timers are not
            // subject to the page-level background clamp, and — unlike the old
            // MessageChannel ping-pong — the worker does not busy-spin the main
            // thread, so it cannot starve audio or the other relay stream.
            var _tickWorker = null;
            var _tickLast = 0;
            var _timerId = 0;

            function stopMcLoop() {
                if (!_tickWorker) return;
                try { _tickWorker.postMessage({ cmd: 'stop' }); } catch (_) {}
                try { _tickWorker.terminate(); } catch (_) {}
                _tickWorker = null;
            }

            function startMcLoop() {
                if (_tickWorker) return;
                try { _tickWorker = new Worker('relay-tick-worker.js'); } catch (_) { _tickWorker = null; return; }
                _tickLast = performance.now();
                _tickWorker.onmessage = function () {
                    if (!state.running || !needsUnthrottledLoop()) {
                        stopMcLoop();
                        if (state.running) scheduleNext();
                        return;
                    }
                    var now = performance.now();
                    if (now - _tickLast >= targetMs) {
                        captureFrame();
                        _tickLast = now;
                    }
                };
                _tickWorker.postMessage({ cmd: 'start', ms: Math.max(10, Math.min(60, targetMs)) });
            }

            function scheduleNext() {
                if (!state.running || !S.connected || !S.roomKeyB64) {
                    S._relayTimers[kind] = null;
                    state.running = false;
                    stopMcLoop();
                    return;
                }
                if (needsUnthrottledLoop()) {
                    // Backgrounded — worker clock (not clamped)
                    S._relayTimers[kind] = true;
                    startMcLoop();
                    return;
                }
                // Visible — the single setTimeout chain
                if (_tickWorker) stopMcLoop();
                _timerId = setTimeout(function () {
                    if (!state.running) return;
                    if (needsUnthrottledLoop()) {
                        S._relayTimers[kind] = true;
                        startMcLoop();
                        return;
                    }
                    captureFrame();
                    if (state.running) scheduleNext();
                }, targetMs);
                S._relayTimers[kind] = _timerId;
            }

            function onVisChange() {
                if (!state.running) {
                    document.removeEventListener('visibilitychange', _visHandler);
                    return;
                }
                if (needsUnthrottledLoop()) {
                    // Backgrounded — swap to the worker clock.
                    if (_timerId) { clearTimeout(_timerId); _timerId = 0; }
                    S._relayTimers[kind] = true;
                    startMcLoop();
                }
                // Foregrounded: the worker clock stands down on its next tick
                // and resumes the setTimeout chain itself (no second chain).
            }
            var _visHandler = onVisChange;
            state._visHandler = _visHandler;
            document.addEventListener('visibilitychange', _visHandler);
            // Start the loop
            scheduleNext();
        };

        // Start when video has enough metadata
        if (video.readyState >= 2) {
            startLoop();
        } else {
            video.addEventListener('loadeddata', startLoop, { once: true });
            var fallbackTimer = setTimeout(startLoop, 1000);
            var existing = _relayCanvases[kind];
            if (existing && existing.running !== undefined) {
                existing._fallbackTimer = fallbackTimer;
            } else {
                _relayCanvases[kind] = { _fallbackTimer: fallbackTimer };
            }
        }
    }

    // Stop the relay capture loop for a given kind.
    function stopVideoRelay(kind) {
        // Cancel any pending fallback timer that would restart a dead relay
        var existing = _relayCanvases[kind];
        if (existing && existing._fallbackTimer) {
            clearTimeout(existing._fallbackTimer);
        }
        if (S._relayTimers[kind]) {
            if (S._relayTimers[kind] !== true) clearTimeout(S._relayTimers[kind]);
            delete S._relayTimers[kind];
        }
        // Stop the running loop — this invalidates any in-flight toBlob()
        // callbacks so they won't reschedule the loop.
        var state = _relayCanvases[kind];
        if (state && state.running !== undefined) {
            state.running = false;
        }
        // Remove visibility / focus listeners
        if (state && state._visHandler) {
            document.removeEventListener('visibilitychange', state._visHandler);
            window.removeEventListener('focus', state._visHandler);
            window.removeEventListener('blur', state._visHandler);
        }
        // Tear the off-main-thread encoder down
        if (state && state.encWorker) {
            try { state.encWorker.terminate(); } catch (_) {}
            state.encWorker = null;
        }
        // Release the hidden video element's stream reference and detach it
        if (state && state.video) {
            try { state.video.srcObject = null; } catch (_) {}
            try { if (state.video.parentNode) state.video.parentNode.removeChild(state.video); } catch (_) {}
        }
        delete _relayCanvases[kind];
    }

    // Stop all relay capture loops.
    function stopAllVideoRelays() {
        stopVideoRelay('camera');
        stopVideoRelay('screen');
    }

    // Handle incoming binary relay frame from server.
    // Format: [0x01 marker][uid_len:u8][uid][kind:u8][nonce:24][ciphertext]
    function handleBinaryRelay(arrayBuffer) {
        try {
            var decoded = decodeRelayBinaryIn(arrayBuffer);
            if (!decoded) { console.log('[BIN-RELAY] decode failed'); return; }
            if (decoded.fromUid === getSelfId()) return;
            if (!S.roomKeyB64) { console.log('[BIN-RELAY] no roomKeyB64'); return; }
            var keyBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(S.roomKeyB64));
            var plaintext;
            try {
                plaintext = E2ECrypto.aeadDecrypt(
                    E2ECrypto.arrayBufferToBase64(decoded.ciphertext.buffer),
                    keyBytes,
                    E2ECrypto.arrayBufferToBase64(decoded.nonce.buffer)
                );
            } catch (e) { console.log('[BIN-RELAY] decrypt failed:', e); return; }

            if (decoded.kind.startsWith('audio') || decoded.kind.startsWith('screen_audio')) {
                handleRelayedAudioFrame(decoded.fromUid, plaintext, decoded.kind);
                return;
            }

            // Video frame — render as <img>
            var blob = new Blob([plaintext], { type: 'image/jpeg' });
            var url = URL.createObjectURL(blob);
            var frameKey = decoded.fromUid + '_' + decoded.kind;

            if (S._relayVideoFrames[frameKey]) {
                URL.revokeObjectURL(S._relayVideoFrames[frameKey]);
            }
            S._relayVideoFrames[frameKey] = url;

            // Render as a relay <img> tile (the mesh <video> is hidden behind it).
            injectRelayTile(decoded.fromUid, decoded.kind, url);

            if (!S.members[decoded.fromUid]) S.members[decoded.fromUid] = {};
            S.members[decoded.fromUid][decoded.kind === 'camera' ? 'camera' : 'screen'] = true;
            S.members[decoded.fromUid]['_relay_' + decoded.kind] = Date.now();
        } catch (_) {}
    }

    // Handle an incoming relayed video frame from the server.
    // Decrypts the frame and renders it as an <img> element.
    function handleMediaRelay(data) {
        var fromUid = data.from_user_id;
        var kind = data.kind; // 'camera' | 'screen' | 'audio'
        var frame = data.frame;
        if (!fromUid || !frame || !frame.e || !frame.n) return;
        if (fromUid === getSelfId()) return;

        // Decrypt the frame
        if (!S.roomKeyB64) return;
        var keyBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(S.roomKeyB64));
        var plaintext;
        try {
            plaintext = E2ECrypto.aeadDecrypt(frame.e, keyBytes, frame.n);
        } catch (_) { return; }

        if (kind === 'audio') {
            handleRelayedAudioFrame(fromUid, plaintext, 'audio');
            return;
        }

        // Video frame — render as <img> in the appropriate tile
        var blob = new Blob([plaintext], { type: 'image/jpeg' });
        var url = URL.createObjectURL(blob);
        var frameKey = fromUid + '_' + kind;

        // Store URL for re-injection after renderPopup rebuilds
        if (S._relayVideoFrames[frameKey]) {
            URL.revokeObjectURL(S._relayVideoFrames[frameKey]);
        }
        S._relayVideoFrames[frameKey] = url;

        // Render as a relay <img> tile (the mesh <video> is hidden behind it).
        injectRelayTile(fromUid, kind, url);

        if (!S.members[fromUid]) S.members[fromUid] = {};
        S.members[fromUid][kind === 'camera' ? 'camera' : 'screen'] = true;
        S.members[fromUid]['_relay_' + kind] = Date.now();
    }

    // Expose relay controls
    function startRelayForStream(stream, kind) {
        if (useVideoRelay()) {
            // Don't add video tracks to WebRTC peers — relay instead
            startVideoRelay(stream, kind);
            return true; // relayed
        }
        return false; // not relayed, use WebRTC
    }

    // ------------------------------------------------------------------
    // Mesh/relay mode selection
    // ------------------------------------------------------------------
    // MESH (P2P) is the default for EVERY media kind and is NEVER switched
    // automatically: a server voice channel stays on the mesh no matter how
    // many members are present. Server relay is strictly opt-in per kind
    // (audio / camera / screen) from the camera options menu. The old
    // threshold-based auto-switch that forced relay at > 5 active members is
    // gone — nothing turns relay on for you.

    // Resolve the effective audio mode for a given user.
    // Checks the per-user override first, then falls back to mesh (default).
    // Only self uid is affected by overrides (others' modes are their own).
    function resolveAudioMode(uid) {
        var selfId = getSelfId();
        if (uid === selfId) {
            var ov = S._audioModeOverrides[uid];
            if (ov === 'mesh' || ov === 'relay') return ov;
        } else {
            // For remote users, use the mode they broadcast via voice_state
            var m = S.members[uid];
            if (m && (m.audio_mode === 'mesh' || m.audio_mode === 'relay')) return m.audio_mode;
        }
        return 'mesh';
    }

    // Resolve the effective video mode for a given user.
    function resolveVideoMode(uid) {
        var selfId = getSelfId();
        if (uid === selfId) {
            var ov = S._videoModeOverrides[uid];
            if (ov === 'mesh' || ov === 'relay') return ov;
        } else {
            // For remote users, use the mode they broadcast via voice_state
            var m = S.members[uid];
            if (m && (m.video_mode === 'mesh' || m.video_mode === 'relay')) return m.video_mode;
        }
        return 'mesh';
    }

    // Resolve camera-specific video mode (camera = video only, no audio).
    function resolveCameraMode(uid) {
        var selfId = getSelfId();
        if (uid === selfId) {
            var ov = S._cameraModeOverrides[uid];
            if (ov === 'mesh' || ov === 'relay') return ov;
        } else {
            var m = S.members[uid];
            if (m && (m.camera_mode === 'mesh' || m.camera_mode === 'relay')) return m.camera_mode;
        }
        return 'mesh';
    }

    // Resolve screen-specific mode (screen = video + screen audio).
    function resolveScreenMode(uid) {
        var selfId = getSelfId();
        if (uid === selfId) {
            var ov = S._screenModeOverrides[uid];
            if (ov === 'mesh' || ov === 'relay') return ov;
        } else {
            var m = S.members[uid];
            if (m && (m.screen_mode === 'mesh' || m.screen_mode === 'relay')) return m.screen_mode;
        }
        return 'mesh';
    }

    // Last applied audio mode — diagnostics/tests only. Modes never
    // auto-switch anymore: mesh is the default, relay is opt-in.
    S._lastAudioMode = 'mesh';

    // Set the audio mode for self ('mesh' default, or 'relay').
    function setSelfAudioMode(mode) {
        var selfId = getSelfId();
        if (!selfId) return;
        var next = (mode === 'relay') ? 'relay' : 'mesh';
        S._audioModeOverrides[selfId] = next;
        S._lastAudioMode = next;
        sendVoiceState();
        if (next === 'relay') switchAudioToRelay(); else switchAudioToMesh();
        updateCamOptMenuState();
        renderPopup();
        showToast('Audio mode: ' + (next === 'relay' ? 'Server relay' : 'P2P mesh'));
    }

    // Apply the effective mesh/relay mode for ONE video kind to the live
    // peers: in relay mode the WebRTC video sender is nulled and the relay
    // loop started; in mesh mode the relay is stopped and the WebRTC track is
    // re-added. Shared by the camera / screen / global video toggles.
    function applyVideoRelayForKind(kind) {
        var selfId = getSelfId();
        if (!selfId) return;
        var effective = kind === 'camera' ? resolveCameraMode(selfId) : resolveScreenMode(selfId);
        var uid;
        if (effective === 'relay') {
            for (uid in S.peers) {
                var pc = S.peers[uid];
                if (!pc || !pc.getSenders) continue;
                pc.getSenders().forEach(function (sender) {
                    if (sender.track && sender.track.kind === 'video' && isTrackKind(sender.track, kind)) {
                        sender.replaceTrack(null).catch(function () {});
                        sender._voiceNulled = sender.track;
                    }
                });
            }
            var stream = kind === 'camera' ? S.localStreams.camera : S.localStreams.screen;
            var on = kind === 'camera' ? S.cameraOn : S.screenOn;
            if (stream && on) startVideoRelay(stream, kind);
        } else {
            stopVideoRelay(kind);
            for (uid in S.peers) {
                var pc2 = S.peers[uid];
                if (pc2 && pc2.getSenders) {
                    pc2.getSenders().forEach(function (sender) {
                        if (sender.track && sender.track.kind === 'video' && isTrackKind(sender.track, kind)) {
                            try { pc2.removeTrack(sender); } catch (_) {}
                        } else if (sender._voiceNulled && sender._voiceNulled.kind === 'video' && isTrackKind(sender._voiceNulled, kind)) {
                            try { pc2.removeTrack(sender); } catch (_) {}
                            sender._voiceNulled = null;
                        }
                    });
                }
                addLocalTracks(pc2);
            }
        }
    }

    // Global video mode for self: applies to camera AND screen at once.
    function setSelfVideoMode(mode) {
        var selfId = getSelfId();
        if (!selfId) return;
        var next = (mode === 'relay') ? 'relay' : 'mesh';
        S._videoModeOverrides[selfId] = next;
        S._cameraModeOverrides[selfId] = next;
        S._screenModeOverrides[selfId] = next;
        sendVoiceState();
        applyVideoRelayForKind('camera');
        applyVideoRelayForKind('screen');
        updateCamOptMenuState();
        renderPopup();
        showToast('Video mode: ' + (next === 'relay' ? 'Server relay' : 'P2P mesh'));
    }

    // Set camera-specific video mode (camera = video only, no audio).
    function setSelfCameraMode(mode) {
        var selfId = getSelfId();
        if (!selfId) return;
        var next = (mode === 'relay') ? 'relay' : 'mesh';
        S._cameraModeOverrides[selfId] = next;
        sendVoiceState();
        applyVideoRelayForKind('camera');
        updateCamOptMenuState();
        renderPopup();
        showToast('Camera mode: ' + (next === 'relay' ? 'Server relay' : 'P2P mesh'));
    }

    // Set screen-specific mode (screen = video + screen audio).
    function setSelfScreenMode(mode) {
        var selfId = getSelfId();
        if (!selfId) return;
        var next = (mode === 'relay') ? 'relay' : 'mesh';
        S._screenModeOverrides[selfId] = next;
        sendVoiceState();
        applyVideoRelayForKind('screen');
        updateCamOptMenuState();
        renderPopup();
        showToast('Screen mode: ' + (next === 'relay' ? 'Server relay' : 'P2P mesh'));
    }

    // Switch audio from WebRTC mesh to WebSocket relay.
    function switchAudioToRelay() {
        S._lastAudioMode = 'relay';
        // Mute ALL audio senders on WebRTC peers (mic + screen audio).
        // Both are relayed via WebSocket now.
        for (var uid in S.peers) {
            var pc = S.peers[uid];
            if (!pc || !pc.getSenders) continue;
            pc.getSenders().forEach(function (sender) {
                if (sender.track && sender.track.kind === 'audio') {
                    sender.replaceTrack(null).catch(function () {});
                    sender._voiceNulled = sender.track;
                }
            });
        }
        // Start both mic and screen audio relay capture loops
        startAudioRelay();
        startScreenAudioRelay();
    }

    // Switch audio from WebSocket relay back to WebRTC mesh.
    function switchAudioToMesh() {
        S._lastAudioMode = 'mesh';
        // Stop both mic and screen audio relay capture loops
        stopAudioRelay();
        stopScreenAudioRelay();
        // Kill all relay PLAYBACK receivers (mic + screen audio)
        Object.keys(_relayPlaybackTimers).forEach(function (uid) {
            var t = _relayPlaybackTimers[uid];
            if (t.processor) { try { t.processor.disconnect(); } catch (_) {} }
            if (t.silent) { try { t.silent.disconnect(); } catch (_) {} }
            delete _relayPlaybackTimers[uid];
        });
        Object.keys(_relayGainNodes).forEach(function (uid) {
            try { _relayGainNodes[uid].disconnect(); } catch (_) {}
            delete _relayGainNodes[uid];
        });
        S._relayAudioQueues = {};
        Object.keys(_relayScreenPlaybackTimers).forEach(function (uid) {
            var t = _relayScreenPlaybackTimers[uid];
            if (t.processor) { try { t.processor.disconnect(); } catch (_) {} }
            if (t.silent) { try { t.silent.disconnect(); } catch (_) {} }
            delete _relayScreenPlaybackTimers[uid];
        });
        Object.keys(_relayScreenGainNodes).forEach(function (uid) {
            try { _relayScreenGainNodes[uid].disconnect(); } catch (_) {}
            delete _relayScreenGainNodes[uid];
        });
        S._relayScreenAudioQueues = {};
        // Restore ALL audio tracks (mic + screen) on all WebRTC peers
        var micTrack = (S.localStreams.mic &&
            ((S.localStreams.processedMic && S.localStreams.processedMic.getAudioTracks()[0]) ||
             S.localStreams.mic.getAudioTracks()[0])) || null;
        var screenAudioTrack = (S.localStreams.screen && S.localStreams.screen.getAudioTracks()[0]) || null;
        for (var uid in S.peers) {
            var pc = S.peers[uid];
            if (!pc || !pc.getSenders) continue;
            pc.getSenders().forEach(function (sender) {
                if (sender.track === null || sender._voiceNulled) {
                    var held = sender._voiceNulled;
                    // Restore the correct track based on what was nulled
                    var trackToRestore = micTrack;
                    if (held && screenAudioTrack && held.id === screenAudioTrack.id) {
                        trackToRestore = screenAudioTrack;
                    }
                    if (trackToRestore) sender.replaceTrack(trackToRestore).catch(function () {});
                    delete sender._voiceNulled;
                }
            });
        }
    }

    // Audio relay capture loop: captures mic PCM, encrypts, sends via WebSocket.
    var _audioRelayTimer = null;

    // Audio must never be starved by a congested video pipe: the video relay
    // drops frames at RELAY_VIDEO_MAX_BUFFERED (256 KB), while audio keeps
    // flowing until the socket is genuinely unusable. The old 256 KB audio
    // threshold meant two video streams alone could silence the mic relay.
    var RELAY_AUDIO_MAX_BUFFERED = 4 * 1024 * 1024;

    var _relayCaptureSab = null; // SharedArrayBuffer for capture worklet → main thread
    var _relayCaptureInt = null; // Int32 view (writePos at [0], readPos at [1])
    var _relayCaptureFloat = null; // Float32 view starting at byte 8
    var _relayCapturePoll = null; // interval for polling capture SAB
    var _relayCaptureMc = null; // worker clock for background-tab polling
    // Screen audio relay capture (separate from mic)
    var _screenAudioRelayTimer = null;
    var _screenAudioRelaySab = null;
    var _screenAudioRelayInt = null;
    var _screenAudioRelayFloat = null;
    var _screenAudioRelayPoll = null;
    var _screenAudioRelayMc = null;

    // Background-tab clock for the audio relay poll. A worker's timers are not
    // clamped the way a hidden page's setTimeout is, and — unlike the
    // MessageChannel ping-pong this replaces — the worker does not busy-spin
    // the main thread (that spin burned a CPU core whenever the audio relay was
    // active in a background tab).
    function startAudioRelayMcPoll() {
        if (_relayCaptureMc) return;
        if (typeof Worker === 'undefined') return; // visible setInterval still polls
        var worker;
        try { worker = new Worker('relay-tick-worker.js'); } catch (_) { return; }
        _relayCaptureMc = worker;
        var lastPoll = performance.now();
        worker.onmessage = function () {
            if (_relayCaptureMc !== worker) return;
            if (!S.connected || !_relayCaptureSab) {
                _relayCaptureMc = null;
                try { worker.terminate(); } catch (_) {}
                return;
            }
            // Visible again: the setInterval handles polling; stand down.
            if (document.visibilityState === 'visible') {
                _relayCaptureMc = null;
                try { worker.terminate(); } catch (_) {}
                return;
            }
            var now = performance.now();
            if (now - lastPoll >= 10) {
                pollAudioRelaySAB();
                lastPoll = now;
            }
        };
        worker.postMessage({ cmd: 'start', ms: 10 });
    }

    // Shared poll logic used by both the setInterval and worker-clock paths
    function pollAudioRelaySAB() {
        try {
            if (!S.connected || !S.roomKeyB64 || S.muted || S.deafened) return;
            var w = getWs();
            if (!w || w.readyState !== WebSocket.OPEN) return;
            if (w.bufferedAmount > RELAY_AUDIO_MAX_BUFFERED) return;
            var readPos = Atomics.load(_relayCaptureInt, 1);
            var writePos = Atomics.load(_relayCaptureInt, 0);
            var ringLen = _relayCaptureFloat.length;
            var avail = (writePos - readPos + ringLen) % ringLen;
            if (avail < RELAY_FRAME_SAMPLES) return;
            var pcm = new Float32Array(RELAY_FRAME_SAMPLES);
            for (var i = 0; i < RELAY_FRAME_SAMPLES; i++) {
                pcm[i] = _relayCaptureFloat[(readPos + i) % ringLen];
            }
            Atomics.store(_relayCaptureInt, 1, (readPos + RELAY_FRAME_SAMPLES) % ringLen);
            // Downsample from 48kHz to the effective quality rate
            var targetRate = getRelayAudioQuality();
            var downsampled = downsampleRelayAudio(pcm, RELAY_SAMPLE_RATE, targetRate);
            var int16 = new Int16Array(downsampled.length);
            for (var i = 0; i < downsampled.length; i++) {
                var s = Math.max(-1, Math.min(1, downsampled[i]));
                int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            var raw = new Uint8Array(int16.buffer);
            var keyBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(S.roomKeyB64));
            var enc = E2ECrypto.aeadEncrypt(raw, keyBytes);
            var kindStr = getRelayAudioKind(targetRate);
            sendRelayBinary(kindStr, enc.nonce, new Uint8Array(E2ECrypto.base64ToArrayBuffer(enc.ciphertext)));
        } catch (_) {}
    }

    function startAudioRelay() {
        if (_audioRelayTimer) return;
        if (!S.localStreams.mic) return;

        var stream = S.localStreams.processedMic || S.localStreams.mic;
        var audioCtx = ensureAudioCtx();
        if (!audioCtx) return;
        var source = audioCtx.createMediaStreamSource(stream);

        // SharedArrayBuffer for lock-free capture → main thread communication.
        // Worklet writes samples on the audio thread; main thread polls and sends.
        var SAB_SIZE = 8 + RELAY_SAMPLE_RATE * 4; // header + 1 second of Float32
        if (typeof SharedArrayBuffer !== 'undefined' && audioCtx.audioWorklet) {
            _relayCaptureSab = new SharedArrayBuffer(SAB_SIZE);
            _relayCaptureInt = new Int32Array(_relayCaptureSab);
            _relayCaptureFloat = new Float32Array(_relayCaptureSab, 8);
            Atomics.store(_relayCaptureInt, 0, 0); // writePos
            Atomics.store(_relayCaptureInt, 1, 0); // readPos

            var startCaptureWorklet = function () {
                var node = new AudioWorkletNode(audioCtx, 'relay-capture-processor', {
                    processorOptions: { sharedBuffer: _relayCaptureSab }
                });
                source.connect(node);
                var silent = audioCtx.createGain();
                silent.gain.value = 0;
                node.connect(silent);
                silent.connect(audioCtx.destination);
                _audioRelayTimer = { source: source, node: node, silent: silent };

                // Poll the SAB every 10ms and send captured audio.
                // Uses setInterval when visible, the worker clock when hidden.
                _relayCapturePoll = setInterval(function () {
                    pollAudioRelaySAB();
                    // Also start MC poll if tab is hidden (setInterval is throttled)
                    if (document.visibilityState === 'hidden') {
                        startAudioRelayMcPoll();
                    }
                }, 10);
                // If tab is already hidden, start MC poll immediately
                if (document.visibilityState === 'hidden') {
                    startAudioRelayMcPoll();
                }
            };

            // Load capture worklet module with timeout fallback
            var fallbackTimer = setTimeout(function () {
                console.warn('[VOICE] Capture AudioWorklet addModule timed out, using ScriptProcessor fallback');
                startAudioRelayFallback(source, audioCtx);
            }, 2000);
            audioCtx.audioWorklet.addModule('relay-capture-processor.js').then(function () {
                clearTimeout(fallbackTimer);
                startCaptureWorklet();
            }).catch(function (e) {
                clearTimeout(fallbackTimer);
                console.warn('[VOICE] Capture AudioWorklet addModule failed:', e, 'using ScriptProcessor fallback');
                startAudioRelayFallback(source, audioCtx);
            });
        } else {
            startAudioRelayFallback(source, audioCtx);
        }
    }

    function startAudioRelayFallback(source, audioCtx) {
        // ScriptProcessor fallback (legacy path — may have sample-skip issues)
        var processor = audioCtx.createScriptProcessor(2048, 1, 1);
        processor.onaudioprocess = function (e) {
            try {
                if (!S.connected || !S.roomKeyB64 || S.muted || S.deafened) return;
                var w = getWs();
                if (!w || w.readyState !== WebSocket.OPEN) return;
                if (w.bufferedAmount > RELAY_AUDIO_MAX_BUFFERED) return;
                var pcm = e.inputBuffer.getChannelData(0);
                var int16 = new Int16Array(pcm.length);
                for (var i = 0; i < pcm.length; i++) {
                    var s = Math.max(-1, Math.min(1, pcm[i]));
                    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                var raw = new Uint8Array(int16.buffer);
                var keyBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(S.roomKeyB64));
                var enc = E2ECrypto.aeadEncrypt(raw, keyBytes);
                sendRelayBinary('audio', enc.nonce, new Uint8Array(E2ECrypto.base64ToArrayBuffer(enc.ciphertext)));
            } catch (_) {}
        };
        source.connect(processor);
        var silent = audioCtx.createGain();
        silent.gain.value = 0;
        processor.connect(silent);
        silent.connect(audioCtx.destination);
        _audioRelayTimer = { source: source, processor: processor, silent: silent };
    }

    function stopAudioRelay() {
        if (_relayCapturePoll) {
            clearInterval(_relayCapturePoll);
            _relayCapturePoll = null;
        }
        if (_relayCaptureMc) {
            try { _relayCaptureMc.postMessage({ cmd: 'stop' }); } catch (_) {}
            try { _relayCaptureMc.terminate(); } catch (_) {}
            _relayCaptureMc = null;
        }
        _relayCaptureSab = null;
        _relayCaptureInt = null;
        _relayCaptureFloat = null;
        if (_audioRelayTimer) {
            try {
                if (_audioRelayTimer.processor) _audioRelayTimer.processor.disconnect();
                if (_audioRelayTimer.node) {
                    try { _audioRelayTimer.node.port.postMessage({ type: 'stop' }); } catch (_) {}
                    _audioRelayTimer.node.disconnect();
                }
                _audioRelayTimer.source.disconnect();
                if (_audioRelayTimer.silent) _audioRelayTimer.silent.disconnect();
            } catch (_) {}
            _audioRelayTimer = null;
        }
    }

    // ------------------------------------------------------------------
    // Screen audio relay capture — same pipeline as mic but captures
    // from S.localStreams.screen audio track.  Runs alongside mic relay.
    // ------------------------------------------------------------------
    function startScreenAudioRelay() {
        if (_screenAudioRelayTimer) return;
        if (!S.localStreams.screen) return;
        var audioTracks = S.localStreams.screen.getAudioTracks();
        if (!audioTracks.length) return;
        var stream = new MediaStream([audioTracks[0]]);
        var audioCtx = ensureAudioCtx();
        if (!audioCtx) return;
        var source = audioCtx.createMediaStreamSource(stream);
        var SAB_SIZE = 8 + RELAY_SAMPLE_RATE * 4;
        if (typeof SharedArrayBuffer !== 'undefined' && audioCtx.audioWorklet) {
            _screenAudioRelaySab = new SharedArrayBuffer(SAB_SIZE);
            _screenAudioRelayInt = new Int32Array(_screenAudioRelaySab);
            _screenAudioRelayFloat = new Float32Array(_screenAudioRelaySab, 8);
            Atomics.store(_screenAudioRelayInt, 0, 0);
            Atomics.store(_screenAudioRelayInt, 1, 0);

            var startCaptureWorklet = function () {
                var node = new AudioWorkletNode(audioCtx, 'relay-capture-processor', {
                    processorOptions: { sharedBuffer: _screenAudioRelaySab }
                });
                source.connect(node);
                var silent = audioCtx.createGain();
                silent.gain.value = 0;
                node.connect(silent);
                silent.connect(audioCtx.destination);
                _screenAudioRelayTimer = { source: source, node: node, silent: silent };
                _screenAudioRelayPoll = setInterval(function () {
                    pollScreenAudioRelaySAB();
                    if (document.visibilityState === 'hidden') startScreenAudioRelayMcPoll();
                }, 10);
                if (document.visibilityState === 'hidden') startScreenAudioRelayMcPoll();
            };
            audioCtx.audioWorklet.addModule('relay-capture-processor.js').then(startCaptureWorklet).catch(function () {
                startScreenAudioRelayFallback(source, audioCtx);
            });
        } else {
            startScreenAudioRelayFallback(source, audioCtx);
        }
    }

    function startScreenAudioRelayFallback(source, audioCtx) {
        var processor = audioCtx.createScriptProcessor(2048, 1, 1);
        processor.onaudioprocess = function (e) {
            try {
                if (!S.connected || !S.roomKeyB64 || S.muted || S.deafened) return;
                var w = getWs();
                if (!w || w.readyState !== WebSocket.OPEN) return;
                if (w.bufferedAmount > RELAY_AUDIO_MAX_BUFFERED) return;
                var pcm = e.inputBuffer.getChannelData(0);
                var targetRate = getRelayScreenAudioQuality();
                var downsampled = downsampleRelayAudio(pcm, RELAY_SAMPLE_RATE, targetRate);
                var int16 = new Int16Array(downsampled.length);
                for (var i = 0; i < downsampled.length; i++) {
                    var s = Math.max(-1, Math.min(1, downsampled[i]));
                    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                var raw = new Uint8Array(int16.buffer);
                var keyBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(S.roomKeyB64));
                var enc = E2ECrypto.aeadEncrypt(raw, keyBytes);
                var kindStr = getRelayScreenAudioKind(targetRate);
                sendRelayBinary(kindStr, enc.nonce, new Uint8Array(E2ECrypto.base64ToArrayBuffer(enc.ciphertext)));
            } catch (_) {}
        };
        source.connect(processor);
        var silent = audioCtx.createGain();
        silent.gain.value = 0;
        processor.connect(silent);
        silent.connect(audioCtx.destination);
        _screenAudioRelayTimer = { source: source, processor: processor, silent: silent };
    }

    // Same worker clock as the mic poll. The old version never stood down when
    // the tab became visible again and spun the main thread forever.
    function startScreenAudioRelayMcPoll() {
        if (_screenAudioRelayMc) return;
        if (typeof Worker === 'undefined') return;
        var worker;
        try { worker = new Worker('relay-tick-worker.js'); } catch (_) { return; }
        _screenAudioRelayMc = worker;
        var lastPoll = performance.now();
        worker.onmessage = function () {
            if (_screenAudioRelayMc !== worker) return;
            if (!_screenAudioRelayTimer) {
                _screenAudioRelayMc = null;
                try { worker.terminate(); } catch (_) {}
                return;
            }
            if (document.visibilityState === 'visible') {
                _screenAudioRelayMc = null;
                try { worker.terminate(); } catch (_) {}
                return;
            }
            var now = performance.now();
            if (now - lastPoll >= 10) {
                pollScreenAudioRelaySAB();
                lastPoll = now;
            }
        };
        worker.postMessage({ cmd: 'start', ms: 10 });
    }

    function pollScreenAudioRelaySAB() {
        try {
            if (!S.connected || !S.roomKeyB64 || S.muted || S.deafened) return;
            if (!S.localStreams.screen || !S.localStreams.screen.getAudioTracks().length) return;
            var w = getWs();
            if (!w || w.readyState !== WebSocket.OPEN) return;
            if (w.bufferedAmount > RELAY_AUDIO_MAX_BUFFERED) return;
            var readPos = Atomics.load(_screenAudioRelayInt, 1);
            var writePos = Atomics.load(_screenAudioRelayInt, 0);
            var ringLen = _screenAudioRelayFloat.length;
            var avail = (writePos - readPos + ringLen) % ringLen;
            if (avail < RELAY_FRAME_SAMPLES) return;
            var pcm = new Float32Array(RELAY_FRAME_SAMPLES);
            for (var i = 0; i < RELAY_FRAME_SAMPLES; i++) {
                pcm[i] = _screenAudioRelayFloat[(readPos + i) % ringLen];
            }
            Atomics.store(_screenAudioRelayInt, 1, (readPos + RELAY_FRAME_SAMPLES) % ringLen);
            var targetRate = getRelayScreenAudioQuality();
            var downsampled = downsampleRelayAudio(pcm, RELAY_SAMPLE_RATE, targetRate);
            var int16 = new Int16Array(downsampled.length);
            for (var i = 0; i < downsampled.length; i++) {
                var s = Math.max(-1, Math.min(1, downsampled[i]));
                int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            var raw = new Uint8Array(int16.buffer);
            var keyBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(S.roomKeyB64));
            var enc = E2ECrypto.aeadEncrypt(raw, keyBytes);
            var kindStr = getRelayScreenAudioKind(targetRate);
            sendRelayBinary(kindStr, enc.nonce, new Uint8Array(E2ECrypto.base64ToArrayBuffer(enc.ciphertext)));
        } catch (_) {}
    }

    function stopScreenAudioRelay() {
        if (_screenAudioRelayPoll) { clearInterval(_screenAudioRelayPoll); _screenAudioRelayPoll = null; }
        if (_screenAudioRelayMc) {
            try { _screenAudioRelayMc.postMessage({ cmd: 'stop' }); } catch (_) {}
            try { _screenAudioRelayMc.terminate(); } catch (_) {}
            _screenAudioRelayMc = null;
        }
        _screenAudioRelaySab = null; _screenAudioRelayInt = null; _screenAudioRelayFloat = null;
        if (_screenAudioRelayTimer) {
            try {
                if (_screenAudioRelayTimer.processor) _screenAudioRelayTimer.processor.disconnect();
                if (_screenAudioRelayTimer.node) {
                    try { _screenAudioRelayTimer.node.port.postMessage({ type: 'stop' }); } catch (_) {}
                    _screenAudioRelayTimer.node.disconnect();
                }
                _screenAudioRelayTimer.source.disconnect();
                if (_screenAudioRelayTimer.silent) _screenAudioRelayTimer.silent.disconnect();
            } catch (_) {}
            _screenAudioRelayTimer = null;
        }
    }

    // ------------------------------------------------------------------
    // Relayed audio playback — jitter buffer
    // ------------------------------------------------------------------
    var _relayGainNodes = {}; // uid → GainNode (mic audio)
    var _relayPlaybackTimers = {}; // uid → { node, silent } (mic audio)
    var _relayScreenGainNodes = {}; // uid → GainNode (screen audio)
    var _relayScreenPlaybackTimers = {}; // uid → { node, silent } (screen audio)
    var RELAY_SAMPLE_RATE = 48000;
    var RELAY_FRAME_SAMPLES = 2048; // must match sender buffer size (2048 = ~43ms at 48kHz)
    var RELAY_JITTER_MS = 60; // buffer 60ms before playing (≈1.5 frames)
    var RELAY_RING_LEN = RELAY_SAMPLE_RATE * 3; // 3 seconds of ring buffer

    // Audio quality → sample rate mapping. The sender downsamples to the
    // effective rate (min of send/receive) and the receiver upsamples back
    // to RELAY_SAMPLE_RATE for the worklet ring buffer.
    var AUDIO_QUALITY_RATES = { low: 8000, medium: 16000, high: 24000, ultra: 48000 };
    var AUDIO_KIND_SAMPLE_RATES = { audio: 48000, audio_low: 8000, audio_med: 16000, audio_high: 24000, audio_ultra: 48000,
        screen_audio: 48000, screen_audio_low: 8000, screen_audio_med: 16000, screen_audio_high: 24000, screen_audio_ultra: 48000 };

    // Relay audio: sender sends at their own sendAudioQuality rate.
    // Each receiver plays at min(sender_rate, recvAudioQuality).
    function getRelayAudioQuality() {
        var sendQ = (S.settings && S.settings.sendAudioQuality) || 'medium';
        return AUDIO_QUALITY_RATES[sendQ] || 16000;
    }

    function getRelayAudioKind(targetRate) {
        if (targetRate <= 8000) return 'audio_low';
        if (targetRate <= 16000) return 'audio_med';
        if (targetRate <= 24000) return 'audio_high';
        return 'audio_ultra';
    }

    function getRelayScreenAudioQuality() {
        var sendQ = (S.settings && S.settings.sendScreenAudioQuality) || (S.settings && S.settings.sendAudioQuality) || 'medium';
        return AUDIO_QUALITY_RATES[sendQ] || 16000;
    }

    function getRelayScreenAudioKind(targetRate) {
        if (targetRate <= 8000) return 'screen_audio_low';
        if (targetRate <= 16000) return 'screen_audio_med';
        if (targetRate <= 24000) return 'screen_audio_high';
        return 'screen_audio_ultra';
    }

    // Downsample Float32 PCM from srcRate to dstRate using linear interpolation.
    function downsampleRelayAudio(pcm, srcRate, dstRate) {
        if (srcRate === dstRate) return pcm;
        var ratio = srcRate / dstRate;
        var outLen = Math.round(pcm.length / ratio);
        var out = new Float32Array(outLen);
        for (var i = 0; i < outLen; i++) {
            var pos = i * ratio;
            var idx = Math.floor(pos);
            var frac = pos - idx;
            out[i] = pcm[idx] * (1 - frac) + (pcm[Math.min(idx + 1, pcm.length - 1)]) * frac;
        }
        return out;
    }

    // Upsample Float32 PCM from srcRate to dstRate using linear interpolation.
    function upsampleRelayAudio(pcm, srcRate, dstRate) {
        if (srcRate === dstRate) return pcm;
        var ratio = dstRate / srcRate;
        var outLen = Math.round(pcm.length * ratio);
        var out = new Float32Array(outLen);
        for (var i = 0; i < outLen; i++) {
            var pos = i / ratio;
            var idx = Math.floor(pos);
            var frac = pos - idx;
            out[i] = pcm[idx] * (1 - frac) + (pcm[Math.min(idx + 1, pcm.length - 1)]) * frac;
        }
        return out;
    }

    // SharedArrayBuffer layout for lock-free main-thread → AudioWorklet communication:
    //   Int32[0] = writePos  (main thread writes via Atomics.store)
    //   Int32[1] = readPos   (worklet writes via Atomics.store)
    //   Float32[2..] = ring buffer samples
    var RELAY_SHARED_HEADER_BYTES = 8; // 2 x Int32

    function createRelaySharedBuffer() {
        if (typeof SharedArrayBuffer === 'undefined') return null;
        var byteLength = RELAY_SHARED_HEADER_BYTES + RELAY_RING_LEN * 4;
        var sab = new SharedArrayBuffer(byteLength);
        var intView = new Int32Array(sab);
        Atomics.store(intView, 0, 0); // writePos = 0
        Atomics.store(intView, 1, 0); // readPos = 0
        return sab;
    }

    function getOrCreateMemberGain(uid) {
        if (_relayGainNodes[uid]) return _relayGainNodes[uid];
        var ctx = ensureAudioCtx();
        var gain = ctx.createGain();
        var vol = remoteVolumeFor(uid);
        gain.gain.value = Math.max(0, Math.min(2, vol));
        gain.connect(ctx.destination);
        _relayGainNodes[uid] = gain;
        window.__relayGainNodes = _relayGainNodes;
        return gain;
    }

    function cleanupMemberGain(uid) {
        // Clear the ring buffer so the worklet outputs silence immediately
        // instead of stale samples during the disconnect race.
        if (S._relayAudioQueues[uid]) {
            var q = S._relayAudioQueues[uid];
            if (q._sharedInt) {
                // Set writePos = readPos so worklet sees 0 available samples
                Atomics.store(q._sharedInt, 0, Atomics.load(q._sharedInt, 1));
            } else {
                q.writePos = q.readPos;
            }
        }
        if (_relayGainNodes[uid]) {
            try { _relayGainNodes[uid].disconnect(); } catch (_) {}
            delete _relayGainNodes[uid];
        }
        if (_relayPlaybackTimers[uid]) {
            var t = _relayPlaybackTimers[uid];
            if (t.node) {
                try { t.node.port.postMessage({ type: 'stop' }); } catch (_) {}
                try { t.node.disconnect(); } catch (_) {}
            }
            if (t.processor) {
                try { t.processor.disconnect(); } catch (_) {}
            }
            if (t.silent) {
                try { t.silent.disconnect(); } catch (_) {}
            }
            delete _relayPlaybackTimers[uid];
        }
        delete S._relayAudioQueues[uid];
    }

    function getOrCreateScreenMemberGain(uid) {
        if (_relayScreenGainNodes[uid]) return _relayScreenGainNodes[uid];
        var ctx = ensureAudioCtx();
        var gain = ctx.createGain();
        var vol = remoteScreenVolumeFor(uid);
        gain.gain.value = Math.max(0, Math.min(2, vol));
        gain.connect(ctx.destination);
        _relayScreenGainNodes[uid] = gain;
        return gain;
    }

    function cleanupScreenMemberGain(uid) {
        if ((S._relayScreenAudioQueues || {})[uid]) {
            var q = S._relayScreenAudioQueues[uid];
            if (q._sharedInt) {
                Atomics.store(q._sharedInt, 0, Atomics.load(q._sharedInt, 1));
            } else {
                q.writePos = q.readPos;
            }
        }
        if (_relayScreenGainNodes[uid]) {
            try { _relayScreenGainNodes[uid].disconnect(); } catch (_) {}
            delete _relayScreenGainNodes[uid];
        }
        if (_relayScreenPlaybackTimers[uid]) {
            var t = _relayScreenPlaybackTimers[uid];
            if (t.node) {
                try { t.node.port.postMessage({ type: 'stop' }); } catch (_) {}
                try { t.node.disconnect(); } catch (_) {}
            }
            if (t.processor) { try { t.processor.disconnect(); } catch (_) {} }
            if (t.silent) { try { t.silent.disconnect(); } catch (_) {} }
            delete _relayScreenPlaybackTimers[uid];
        }
        delete (S._relayScreenAudioQueues || {})[uid];
    }

    function startRelayScreenAudioPlayback(uid) {
        if (_relayScreenPlaybackTimers[uid]) return;
        var ctx = ensureAudioCtx();
        if (!ctx) return;
        var q = (S._relayScreenAudioQueues || {})[uid];
        if (!q) return;

        var startNode = function () {
            if (_relayScreenPlaybackTimers[uid]) return;
            var nodeOpts = { processorOptions: {} };
            if (q._sharedSab) nodeOpts.processorOptions.sharedBuffer = q._sharedSab;
            var node = new AudioWorkletNode(ctx, 'relay-audio-processor', nodeOpts);
            var silent = ctx.createGain();
            silent.gain.value = 0;
            var gain = getOrCreateScreenMemberGain(uid);
            node.connect(gain);
            node.connect(silent);
            silent.connect(ctx.destination);
            q._workletNode = node;
            _relayScreenPlaybackTimers[uid] = { node: node, silent: silent };
            if (!q._sharedSab) {
                var len = (q.writePos - q.readPos + q.ring.length) % q.ring.length;
                if (len > 0) {
                    var chunk = new Float32Array(len);
                    for (var i = 0; i < len; i++) {
                        chunk[i] = q.ring[q.readPos];
                        q.readPos = (q.readPos + 1) % q.ring.length;
                    }
                    node.port.postMessage({ samples: chunk });
                }
            }
        };
        if (ctx.audioWorklet) {
            ctx.audioWorklet.addModule('relay-audio-processor.js').then(startNode).catch(function () {
                startRelayScreenAudioPlaybackFallback(uid);
            });
        } else {
            startRelayScreenAudioPlaybackFallback(uid);
        }
    }

    function startRelayScreenAudioPlaybackFallback(uid) {
        var ctx = ensureAudioCtx();
        if (!ctx) return;
        var q = (S._relayScreenAudioQueues || {})[uid];
        if (!q) return;
        var processor = ctx.createScriptProcessor(2048, 1, 1);
        var gain = getOrCreateScreenMemberGain(uid);
        processor.onaudioprocess = function (e) {
            var out = e.outputBuffer.getChannelData(0);
            var ringLen = q.ring.length;
            var readPos = q.readPos;
            var avail = (q.writePos - readPos + ringLen) % ringLen;
            var need = out.length;
            if (avail < need) {
                // Underrun: output silence
                for (var i = 0; i < need; i++) out[i] = 0;
                return;
            }
            for (var i = 0; i < need; i++) {
                out[i] = q.ring[(readPos + i) % ringLen];
            }
            q.readPos = (readPos + need) % ringLen;
        };
        processor.connect(gain);
        var silent = ctx.createGain();
        silent.gain.value = 0;
        processor.connect(silent);
        silent.connect(ctx.destination);
        _relayScreenPlaybackTimers[uid] = { processor: processor, silent: silent };
    }

    function handleRelayedAudioFrame(fromUid, rawPcmBytes, kindStr) {
        try {
            var audioCtx = ensureAudioCtx();
            if (!audioCtx) return;
            if (!S.members[fromUid]) return;

            var srcRate = AUDIO_KIND_SAMPLE_RATES[kindStr] || RELAY_SAMPLE_RATE;
            var isScreenAudio = kindStr.indexOf('screen_audio') === 0;

            // Deafened: drop incoming audio to save bandwidth
            if (S.deafened) return;

            var int16 = new Int16Array(rawPcmBytes.buffer, rawPcmBytes.byteOffset, rawPcmBytes.byteLength / 2);
            var float32 = new Float32Array(int16.length);
            for (var i = 0; i < int16.length; i++) {
                float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF);
            }

            // Upsample from the sender's rate to RELAY_SAMPLE_RATE (48kHz)
            if (srcRate < RELAY_SAMPLE_RATE) {
                float32 = upsampleRelayAudio(float32, srcRate, RELAY_SAMPLE_RATE);
            }

            // Route to the correct queue: mic audio vs screen audio
            var queues = isScreenAudio ? (S._relayScreenAudioQueues || (S._relayScreenAudioQueues = {})) : S._relayAudioQueues;
            var playbackFn = isScreenAudio ? startRelayScreenAudioPlayback : startRelayPlayback;

            if (!queues[fromUid]) {
                var sharedSab = createRelaySharedBuffer();
                queues[fromUid] = {
                    ring: new Float32Array(RELAY_RING_LEN),
                    writePos: 0,
                    readPos: 0,
                    _workletNode: null,
                    _sharedSab: sharedSab,
                    _sharedInt: sharedSab ? new Int32Array(sharedSab) : null,
                    _sharedFloat: sharedSab ? new Float32Array(sharedSab, RELAY_SHARED_HEADER_BYTES) : null,
                };
                playbackFn(fromUid);
            }

            var q = queues[fromUid];

            if (q._sharedSab && q._sharedFloat && q._sharedInt) {
                var ringLen = RELAY_RING_LEN;
                var writePos = Atomics.load(q._sharedInt, 0);
                var readPos = Atomics.load(q._sharedInt, 1);
                var avail = (writePos - readPos + ringLen) % ringLen;
                var free = ringLen - avail;
                if (float32.length > free) return;
                for (var i = 0; i < float32.length; i++) {
                    q._sharedFloat[writePos] = float32[i];
                    writePos = (writePos + 1) % ringLen;
                }
                Atomics.store(q._sharedInt, 0, writePos);
                return;
            }

            if (q._workletNode) {
                q._workletNode.port.postMessage({ samples: float32 });
                return;
            }

            // Worklet not ready yet — buffer in the ring (single-threaded, no race)
            var len = float32.length;
            var avail2 = (q.writePos - q.readPos + q.ring.length) % q.ring.length;
            var free2 = q.ring.length - avail2;
            if (len > free2) return;
            for (var i = 0; i < len; i++) {
                q.ring[q.writePos] = float32[i];
                q.writePos = (q.writePos + 1) % q.ring.length;
            }
        } catch (_) {}
    }

    function startRelayPlayback(uid) {
        if (_relayPlaybackTimers[uid]) return;
        var ctx = ensureAudioCtx();
        if (!ctx) return;

        var q = S._relayAudioQueues[uid];
        if (!q) return;

        // Ensure the AudioWorklet module is loaded (one-time async).
        // After addModule resolves, all subsequent addModule calls are instant.
        var startNode = function () {
            if (_relayPlaybackTimers[uid]) return; // already started

            // Pass SharedArrayBuffer via processorOptions for lock-free communication.
            // The worklet reads directly from shared memory — no postMessage on audio thread.
            var nodeOpts = { processorOptions: {} };
            if (q._sharedSab) {
                nodeOpts.processorOptions.sharedBuffer = q._sharedSab;
            }
            var node = new AudioWorkletNode(ctx, 'relay-audio-processor', nodeOpts);
            var silent = ctx.createGain();
            silent.gain.value = 0;

            var gain = getOrCreateMemberGain(uid);
            node.connect(gain);
            node.connect(silent);
            silent.connect(ctx.destination);

            q._workletNode = node;
            _relayPlaybackTimers[uid] = { node: node, silent: silent };

            // If SharedArrayBuffer is in use, the worklet reads directly from shared memory.
            // Only feed initial data via postMessage for the fallback (non-SAB) path.
            if (!q._sharedSab) {
                var len = (q.writePos - q.readPos + q.ring.length) % q.ring.length;
                if (len > 0) {
                    var chunk = new Float32Array(len);
                    for (var i = 0; i < len; i++) {
                        chunk[i] = q.ring[q.readPos];
                        q.readPos = (q.readPos + 1) % q.ring.length;
                    }
                    node.port.postMessage({ samples: chunk });
                }
            }
        };

        if (ctx.audioWorklet) {
            // addModule is idempotent — resolves instantly if already loaded.
            // Add a timeout: some environments (headless Chrome, self-signed certs)
            // may hang the fetch without resolving or rejecting.
            var fallbackTimer = setTimeout(function () {
                console.warn('[VOICE] AudioWorklet addModule timed out, using ScriptProcessor fallback for', uid);
                startRelayPlaybackFallback(uid);
            }, 2000);
            ctx.audioWorklet.addModule('relay-audio-processor.js').then(function () {
                clearTimeout(fallbackTimer);
                startNode();
            }).catch(function (e) {
                clearTimeout(fallbackTimer);
                console.warn('[VOICE] AudioWorklet addModule failed:', e, 'using ScriptProcessor fallback for', uid);
                startRelayPlaybackFallback(uid);
            });
        } else {
            startRelayPlaybackFallback(uid);
        }
    }

    function startRelayPlaybackFallback(uid) {
        if (_relayPlaybackTimers[uid]) return;
        var ctx = ensureAudioCtx();
        if (!ctx) return;
        var q = S._relayAudioQueues[uid];
        if (!q) return;

        var FRAME = 2048;
        var processor = ctx.createScriptProcessor(FRAME, 0, 1);
        var silentCount = 0;
        var wasSilent = true;
        var prevTail = 0;

        processor.onaudioprocess = function (e) {
            var output = e.outputBuffer.getChannelData(0);
            var q = S._relayAudioQueues[uid];
            if (!q) { output.fill(0); return; }
            var avail = (q.writePos - q.readPos + q.ring.length) % q.ring.length;
            if (avail < FRAME) {
                if (!wasSilent) {
                    for (var j = 0; j < FRAME; j++) {
                        var t = 1 - j / FRAME;
                        output[j] = prevTail * t * t * (3 - 2 * t);
                    }
                } else {
                    output.fill(0);
                }
                wasSilent = true;
                prevTail = 0;
                silentCount++;
                return;
            }
            silentCount = 0;
            for (var i = 0; i < FRAME; i++) {
                output[i] = q.ring[q.readPos];
                q.readPos = (q.readPos + 1) % q.ring.length;
            }
            if (wasSilent) {
                wasSilent = false;
                for (var j = 0; j < FRAME; j++) {
                    var t = j / FRAME;
                    output[j] *= t * t * (3 - 2 * t);
                }
            }
            prevTail = output[FRAME - 1];
        };

        var gain = getOrCreateMemberGain(uid);
        processor.connect(gain);
        var silent = ctx.createGain();
        silent.gain.value = 0;
        processor.connect(silent);
        silent.connect(ctx.destination);

        _relayPlaybackTimers[uid] = { processor: processor, silent: silent };
    }

    // Change the resolution OTHERS send to us (per-receiver: each peer scales
    // its sender for this member down to the requested height). Broadcast in
    // voice_state so every peer applies it, then re-tune our own senders too
    // (our own sender for each peer scales per THEIR declared preference).
    function setRecvRes(kind, h) {
        h = parseInt(h, 10) || (kind === 'screen' ? 480 : 360);
        S.settings[kind === 'screen' ? 'recvScreenRes' : 'recvCameraRes'] = h;
        saveSettings();
        updateSettingsLabels();
        if (S.connected) {
            sendVoiceState();
            retuneAllVideoSenders();
        }
    }

    // Manual per-feed loading: when ON, remote camera/screen feeds are held as
    // placeholders with a Load button until clicked (independently per user AND
    // per kind). Senders keep sending; this only affects what the viewer loads.
    function setManualVideoLoad(on) {
        S.settings.manualVideoLoad = !!on;
        if (!on) {
            // Disabling manual load auto-loads EVERY feed again, including the
            // ones explicitly unloaded with the Unload button (the toggle is
            // the escape hatch) — otherwise a feed the user unloaded earlier
            // would stay black until they click Load again.
            Object.keys(S._loadedFeeds).forEach(function (k) {
                if (S._loadedFeeds[k] === false) delete S._loadedFeeds[k];
            });
        }
        saveSettings();
        updateSettingsLabels();
        renderPopup();
        renderDmPanel();
        renderSelfPreview();
        applyFeedPlaceholders();
        // Toggling changes what feeds this viewer is willing to receive —
        // broadcast so every sender re-gates accordingly.
        if (S.connected) sendVoiceState();
    }

    // Legacy global video toggle (kept for API/tests only — the UI now uses
    // the per-kind mesh/relay control). Mesh is the default for every kind.
    function setVideoMeshMode(on) {
        S.settings.videoMeshMode = !!on;
        saveSettings();
        if (!S.connected) { updateCamOptMenuState(); return; }
        setSelfVideoMode(on ? 'mesh' : 'relay');
    }

    function retuneAllVideoSenders() {
        for (var uid in S.peers) {
            tuneVideoSenders(S.peers[uid], uid);
        }
    }

    // Black-feed watchdog: how many consecutive zero-frame checks (at the
    // watchdog's 4s interval) trigger a renegotiation. Derived from the
    // configurable videoWatchdogSecs setting; 0 = disabled.
    function watchdogCheckThreshold() {
        var secs = parseInt(S.settings.videoWatchdogSecs, 10) || 0;
        if (secs <= 0) return 0;
        return Math.max(1, Math.round(secs / 4));
    }

    function applyVideoWatchdogToPeers() {
        var th = watchdogCheckThreshold();
        for (var uid in S.peers) {
            var _p = S.peers[uid];
            _p._videoWatchThreshold = th;
            if (th === 0) _p._videoWatchCount = 0;
        }
    }

    // Set the seconds of zero frames before the video watchdog renegotiates
    // (0 = off). Applies immediately to every existing peer.
    function setVideoWatchdogSecs(secs) {
        S.settings.videoWatchdogSecs = Math.max(0, Math.min(60, parseInt(secs, 10) || 0));
        saveSettings();
        updateSettingsLabels();
        applyVideoWatchdogToPeers();
    }

    // ------------------------------------------------------------------
    // Call diagnostics (Settings → Voice → Advanced)
    // ------------------------------------------------------------------
    // Live getStats for every peer so a black feed can be diagnosed at a
    // glance instead of by feel: frames encoded/decoded, packet loss, and
    // whether the E2EE media transform is attached to each sender/receiver.
    // No wire changes — pure local getStats.
    function fmtBytes(n) {
        if (!n) return '0 B';
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1048576).toFixed(2) + ' MB';
    }

    // Aggregate one direction's stats for one kind (audio/video): sender or
    // receiver side merged with its matching outbound/inbound-rtp reports.
    function mergeDiagKind(trackAgg, rtpAgg) {
        var m = { tracks: 0, transform: false, trackStates: [], reports: 0, frames: 0, packets: 0, loss: 0, bytes: 0 };
        if (trackAgg) {
            m.tracks = trackAgg.count || 0;
            m.transform = !!trackAgg.transform;
            m.trackStates = trackAgg.trackStates || [];
        }
        if (rtpAgg) {
            m.reports = rtpAgg.count || 0;
            m.frames = rtpAgg.frames || 0;
            m.packets = rtpAgg.packets || 0;
            m.loss = rtpAgg.loss || 0;
            m.bytes = rtpAgg.bytes || 0;
        }
        return m;
    }

    // Resolves to an array of per-peer diagnostics (one entry per RTCPeerConnection
    // in S.peers). Exposed on VoiceManager.getPeerDiag() and _debug.getPeerDiag.
    function collectPeerDiag() {
        var out = [];
        var uids = S.connected ? Object.keys(S.peers) : [];
        if (!uids.length) return Promise.resolve(out);
        var jobs = uids.map(function (uid) {
            var pc = S.peers[uid];
            var entry = {
                uid: uid,
                connectionState: pc.connectionState || '?',
                signalingState: pc.signalingState || '?',
                senders: {},
                receivers: {},
            };
            return pc.getStats().then(function (stats) {
                var outAgg = {}, inAgg = {};
                try {
                    stats.forEach(function (r) {
                        var k = r.kind || r.mediaType;
                        if (!k) return;
                        if (r.type === 'outbound-rtp') {
                            (outAgg[k] = outAgg[k] || { count: 0, frames: 0, packets: 0, loss: 0, bytes: 0 });
                            outAgg[k].count++;
                            outAgg[k].frames += r.framesEncoded || 0;
                            outAgg[k].packets += r.packetsSent || 0;
                            outAgg[k].loss += r.packetsLost || 0;
                            outAgg[k].bytes += r.bytesSent || 0;
                        } else if (r.type === 'inbound-rtp') {
                            (inAgg[k] = inAgg[k] || { count: 0, frames: 0, packets: 0, loss: 0, bytes: 0 });
                            inAgg[k].count++;
                            inAgg[k].frames += r.framesDecoded || 0;
                            inAgg[k].packets += r.packetsReceived || 0;
                            inAgg[k].loss += r.packetsLost || 0;
                            inAgg[k].bytes += r.bytesReceived || 0;
                        }
                    });
                } catch (_) {}
                var sAgg = {}, rAgg = {};
                pc.getSenders().forEach(function (s) {
                    var kind = s.track ? s.track.kind : 'held';
                    (sAgg[kind] = sAgg[kind] || { count: 0, transform: false, trackStates: [] });
                    sAgg[kind].count++;
                    sAgg[kind].transform = sAgg[kind].transform || !!s.transform;
                    sAgg[kind].trackStates.push(s.track ? s.track.readyState : 'null');
                });
                pc.getReceivers().forEach(function (r) {
                    var kind = r.track ? r.track.kind : 'held';
                    (rAgg[kind] = rAgg[kind] || { count: 0, transform: false, trackStates: [] });
                    rAgg[kind].count++;
                    rAgg[kind].transform = rAgg[kind].transform || !!r.transform;
                    rAgg[kind].trackStates.push(r.track ? r.track.readyState : 'null');
                });
                ['audio', 'video'].forEach(function (k) {
                    if (outAgg[k] || sAgg[k]) entry.senders[k] = mergeDiagKind(sAgg[k], outAgg[k]);
                    if (inAgg[k] || rAgg[k]) entry.receivers[k] = mergeDiagKind(rAgg[k], inAgg[k]);
                });
                return entry;
            }).catch(function () {
                entry.error = 'getStats failed';
                return entry;
            });
        });
        return Promise.all(jobs);
    }

    function shortUid(uid) {
        return uid && uid.length > 10 ? uid.slice(0, 8) + '…' : (uid || '?');
    }

    // Human-readable diagnosis + suggested fix for the signatures the panel
    // detects (black feed, missing E2EE, duplicate receivers). Rendered under
    // the peer so the user knows WHAT is wrong and WHAT to do about it.
    function diagReasons(p) {
        var reasons = [];
        ['audio', 'video'].forEach(function (k) {
            var s = p.senders[k];
            var r = p.receivers[k];
            if (r) {
                if (k === 'video' && r.tracks > 0 && r.frames === 0) {
                    if (r.packets === 0) {
                        reasons.push('' + icon('warning') + ' Black feed: the sender is not sending this camera/screen to you (0 packets). If “Load each camera / screen share manually” is ON, click the <b>Load</b> button on their tile. If it’s OFF, their feed to you is stalled — the receiver watchdog renegotiates automatically, or ask them to toggle their camera/screen, or rejoin the call.');
                    } else {
                        reasons.push('' + icon('warning') + ' Black feed: packets arrive but nothing decodes — a codec/key issue; the receiver watchdog heals it automatically (Reconnecting video…), or rejoin the call.');
                    }
                }
                if (k === 'video' && r.tracks > 0 && !r.transform) {
                    reasons.push('' + icon('warning') + ' E2EE decrypt transform missing on this feed — encrypted frames can’t decode (black). The watchdog re-applies it automatically, or press <b>Rejoin &amp; heal</b>.');
                }
                // Accumulated m-lines: a member has at most ONE mic audio + ONE
                // screen-share audio, and at most camera + screen video. More
                // receivers than that are stale duplicates (lost removeTrack
                // renegotiations) — they don't receive anything and can confuse
                // the renderer, so surface them.
                var maxRecv = k === 'audio' ? 2 : 2;
                if (r.tracks > maxRecv) {
                    reasons.push('' + icon('warning') + ' ' + r.tracks + ' ' + k + ' receivers on this peer — accumulated m-lines from repeated camera/screen/mute toggles. The watchdog renegotiates to clean them up; if they persist, press <b>Rejoin &amp; heal</b>.');
                }
                if (k === 'audio' && r.tracks > 0 && r.frames === 0 && r.packets > 0) {
                    reasons.push('ℹ Audio packets arrive but frames read 0 — usually a Chrome audio-stats quirk, not a problem, if you can hear them.');
                }
            }
            if (s && k === 'audio' && s.tracks > 0 && !s.transform) {
                reasons.push('' + icon('warning') + ' Your mic is being sent WITHOUT end-to-end encryption. Mute + unmute once (restarts the mic on the same line) or rejoin the call to restore the encrypt transform.');
            }
            if (s && k === 'video' && s.tracks > 0 && s.frames === 0) {
                reasons.push('' + icon('warning') + ' Your camera to this peer is not encoding — toggle your camera off/on.');
            }
            // One-way E2EE gap: the worker shows frames DO flow through the
            // transforms on one side but the OTHER direction's counters never
            // move — a decrypt transform that Chrome attached but never
            // invokes. The audio sounds fine (it arrives as plaintext) but the
            // direction is NOT encrypted. The watchdog heals this by
            // re-applying transforms + renegotiating.
            if (k === 'audio' && r && r.tracks > 0 && r.transform) {
                var st = window.__voiceE2eeStats && window.__voiceE2eeStats.last;
                if (st && st.decA === 0 && st.encA > 0) {
                    reasons.push('' + icon('warning') + ' One-way E2EE gap: incoming audio decrypts 0 frames while the other side encrypts ' + st.encA + ' — Chrome attached the decrypt transform but never invokes it; this direction is flowing as PLAINTEXT. The watchdog re-negotiates to heal it (Reconnecting media…), or press <b>Rejoin &amp; heal</b>.');
                }
            }
        });
        var missing = [];
        ['audio', 'video'].forEach(function (k) {
            if (p.senders[k] && p.senders[k].tracks > 0 && !p.senders[k].transform) missing.push('send ' + k);
            if (p.receivers[k] && p.receivers[k].tracks > 0 && !p.receivers[k].transform) missing.push('recv ' + k);
        });
        if (missing.length && !reasons.some(function (x) { return x.indexOf('rejoin the call to restore it') !== -1 || x.indexOf('restore the encrypt transform') !== -1; })) {
            reasons.push('' + icon('warning') + ' E2EE transform missing on: ' + missing.join(', ') + ' — rejoin the call to restore full end-to-end encryption.');
        }
        return reasons;
    }

    function diagPeerHtml(p) {
        var html = '<div style="margin-top:4px">▸ <b>' + esc(shortUid(p.uid)) + '</b>  [' + esc(p.connectionState) + (p.signalingState ? ' / ' + esc(p.signalingState) : '') + (p.error ? ' / ' + esc(p.error) : '') + ']</div>';
        ['audio', 'video'].forEach(function (k) {
            var s = p.senders[k];
            var r = p.receivers[k];
            if (s) {
                var warn = (k === 'video' && s.tracks > 0 && s.frames === 0) ? ' <span style="color:#f0b232">' + icon('warning') + ' no frames encoded (they see you black?)</span>' : '';
                html += '<div style="padding-left:12px">send ' + k + (s.tracks > 1 ? ' ×' + s.tracks : '') + ': frames ' + s.frames + ' · pkts ' + s.packets + ' · loss ' + s.loss + ' · ' + fmtBytes(s.bytes) + ' · [E2EE ' + (s.transform ? '<span style="color:#57f287">✓</span>' : '<span style="color:#f23f42">✗</span>') + ']' + (s.trackStates.length ? ' · ' + s.trackStates.join(',') : '') + warn + '</div>';
            }
            if (r) {
                var warn2 = (k === 'video' && r.tracks > 0 && r.frames === 0) ? ' <span style="color:#f0b232">' + icon('warning') + ' no frames decoded (black feed)</span>' : '';
                html += '<div style="padding-left:12px">recv ' + k + (r.tracks > 1 ? ' ×' + r.tracks : '') + ': frames ' + r.frames + ' · pkts ' + r.packets + ' · loss ' + r.loss + ' · ' + fmtBytes(r.bytes) + ' · [E2EE ' + (r.transform ? '<span style="color:#57f287">✓</span>' : '<span style="color:#f23f42">✗</span>') + ']' + (r.trackStates.length ? ' · ' + r.trackStates.join(',') : '') + warn2 + '</div>';
            }
        });
        var reasons = diagReasons(p);
        if (reasons.length) {
            html += '<div style="padding-left:12px;margin-top:3px;color:#f0b232">' + reasons.join('<br>') + '</div>';
        }
        return html;
    }

    function renderVoiceDiag() {
        var list = el('voice-diag-list');
        if (!list) return;
        var when = Date.now();
        collectPeerDiag().then(function (peers) {
            // The panel may have been closed or re-rendered meanwhile — only
            // paint if it's still the same element.
            if (el('voice-diag-list') !== list) return;
            if (!peers.length) {
                list.innerHTML = '<div style="color:var(--text-muted)">Not in a call — join a voice channel or DM call to see per-peer stats.</div>';
                return;
            }
            var html = peers.map(diagPeerHtml).join('');
            html += '<div style="color:var(--text-muted);margin-top:6px">Updated ' + new Date(when).toLocaleTimeString() + ' · ' + peers.length + ' peer(s)</div>';
            list.innerHTML = html;
        });
    }

    // "Rejoin & heal" — the diagnostics panel's auto-fix. Two stages:
    //   1. IN-PLACE E2EE heal (non-disruptive): add the encrypt transform to
    //      any sender missing it and the decrypt transform to any receiver
    //      missing it, then flush the pending-receiver queue. NEVER replaces a
    //      working transform: reassigning a live receiver's transform
    //      mid-stream was the root cause of the one-sided audio regression
    //      (the decrypt transform stopped receiving frames entirely → permanent
    //      concealment). A receiver with NO transform is already broken, so
    //      adding one there is safe and is exactly the late-key / lost-
    //      transform heal.
    //   2. FULL REJOIN (disruptive but definitive) ONLY when a problem survives
    //      the in-place heal: a peer stuck at failed/disconnected, or a black
    //      video feed (receiver has packets but 0 frames decoded). Rejoining
    //      recreates every peer from scratch — new receivers, transforms
    //      applied fresh at ontrack — the reliable fix the panel's own reason
    //      hints point at ("click Load on their tile / rejoin").
    function healE2eeInPlace() {
        var applied = 0;
        ensureE2eeWorker();
        if (!window.RTCRtpScriptTransform || !e2eeWorker || !S.roomKeyB64) return applied;
        Object.keys(S.peers).forEach(function (uid) {
            var pc = S.peers[uid];
            if (!pc || !pc.getSenders) return;
            try {
                pc.getSenders().forEach(function (s) {
                    try {
                        if (!s.transform) {
                            s.transform = new RTCRtpScriptTransform(e2eeWorker, { operation: 'encrypt', key: S.roomKeyB64 });
                            applied++;
                        }
                    } catch (_) {}
                });
                pc.getReceivers().forEach(function (r) {
                    try {
                        if (r.track && r.track.readyState === 'live' && !r.transform) {
                            r.transform = new RTCRtpScriptTransform(e2eeWorker, { operation: 'decrypt', key: S.roomKeyB64 });
                            applied++;
                        }
                    } catch (_) {}
                });
            } catch (_) {}
        });
        flushPendingRecvTransforms();
        return applied;
    }

    // Leave + rejoin the CURRENT room. DM rejoin is QUIET: it re-enters the
    // voice room WITHOUT sending dm_call_ring — the partner is already in the
    // call, so re-ringing them would be obnoxious. The partner's client sees
    // our voice_joined and recreates its peer for us.
    function rejoinCurrentRoom() {
        if (S.roomType === 'server') {
            var sid = S.serverId, cid = S.channelId, cname = S.channelName;
            if (!sid || !cid) return;
            leaveVoice();
            joinServerVoice(sid, cid, cname);
        } else if (S.roomType === 'dm') {
            var ch = S.dmChannelId;
            var partner = S.dmCallPartner;
            var answered = S.dmCallAnswered;
            if (!ch) return;
            leaveVoice();
            S.roomType = 'dm';
            S.dmChannelId = ch;
            S.dmCallPartner = partner;
            S.dmCallActive = true;
            S.dmCallAnswered = answered;
            S.popupOpen = false;
            S.callWaiting = false;
            ensureDmCallKey(partner && partner.id).then(function (ok) {
                if (!ok || S.roomType !== 'dm' || S.dmChannelId !== ch) return;
                deriveRoomKey();
                deriveSignalKey();
                resetFullscreenState();
                send({ type: 'voice_join', room_type: 'dm', dm_channel_id: ch });
                playSound('join');
                showToast('Rejoined call — peers reconnecting…');
                updateDmCallUI();
                notifyWaitingChanged();
            });
        }
    }

    // Does a peer still look broken after the in-place heal? (failed/
    // disconnected connection, or a black video feed: packets arriving but 0
    // frames decoded.) Returns a Promise<boolean>.
    function diagStillBroken() {
        return collectPeerDiag().then(function (diag) {
            return diag.some(function (p) {
                if (p.connectionState === 'failed' || p.connectionState === 'disconnected') return true;
                var rv = p.receivers && p.receivers.video;
                // Black-feed signature: a video track exists, packets arrive,
                // but nothing decodes (mergeDiagKind reports track counts under
                // `tracks`, not `count`).
                if (rv && rv.tracks > 0 && rv.packets > 0 && rv.frames === 0) return true;
                return false;
            });
        }).catch(function () { return false; });
    }

    // The diagnostics panel's "Rejoin & heal" button handler.
    function healAndRejoin() {
        if (!S.roomType || !S.connected) {
            showToast('Not in a call — nothing to heal.');
            return;
        }
        showToast('Healing E2EE transforms…');
        var applied = healE2eeInPlace();
        // Give the transforms a beat to take effect, then check whether the
        // in-place heal was enough or a full rejoin is warranted.
        setTimeout(function () {
            if (!S.roomType || !S.connected) return;
            diagStillBroken().then(function (broken) {
                if (!S.roomType || !S.connected) return;
                if (broken) {
                    showToast('Rejoining room — reconnecting peers…');
                    rejoinCurrentRoom();
                } else {
                    showToast(applied > 0
                        ? 'Healed ' + applied + ' missing E2EE transform(s) in place.'
                        : 'E2EE transforms OK — no rejoin needed.');
                    renderVoiceDiag();
                }
            });
        }, 500);
    }

    // Auto-refresh ticker: paints only while the Voice settings tab is visible
    // and the auto checkbox is on (and a call is active). Cheap — one getStats
    // per peer every 2.5s.
    var _voiceDiagTimer = null;
    function startVoiceDiagPoll() {
        if (_voiceDiagTimer) return;
        _voiceDiagTimer = setInterval(function () {
            var diag = el('voice-diag-list');
            if (!diag) return;
            var auto = el('voice-diag-auto');
            var panel = el('voice-settings');
            if (!auto || !auto.checked) return;
            if (!panel || panel.offsetParent === null) return;
            renderVoiceDiag();
        }, 2500);
    }

    // Transient "Reconnecting video…" notice shown when the per-sender watchdog
    // fires (a live video feed stopped encoding — the screen is about to freeze
    // briefly while the m-line is renegotiated). Shown over the LOCAL user's own
    // feeds: the stuck encoder is ours, so this is the feed everyone else sees
    // black. Auto-hides after a few seconds.
    var _videoReconnectTimer = null;
    var _videoReconnectActive = false;
    // The reconnect notice lives in a BODY-LEVEL toast, NOT inside the media
    // containers. The DM self strip and member rows are re-rendered constantly
    // (camera/screen toggles, member updates, renegotiation-triggered re-)
    // — an innerHTML rebuild of those hosts would wipe an embedded chip, and
    // several wipe paths were found (innerHTML set, element replace, etc.). A
    // fixed-position toast is immune to all of them: no render touches it.
    function videoReconnectToast() {
        var t = el('voice-reconnect-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'voice-reconnect-toast';
            t.className = 'voice-video-reconnect-chip';
            t.textContent = 'Reconnecting video…';
            document.body.appendChild(t);
        }
        return t;
    }
    function syncVideoReconnectChips() {
        var t = videoReconnectToast();
        t.style.display = _videoReconnectActive ? 'flex' : 'none';
    }
    function showVideoReconnect(kind) {
        _videoReconnectActive = true;
        // The watchdog now covers AUDIO too (a live remote mic that decodes
        // nothing for the whole window), so say which medium is reconnecting.
        var t = videoReconnectToast();
        if (kind === 'audio') {
            t.textContent = 'Reconnecting audio…';
        } else if (kind === 'video') {
            t.textContent = 'Reconnecting video…';
        } else {
            t.textContent = 'Reconnecting media…';
        }
        syncVideoReconnectChips();
        if (_videoReconnectTimer) clearTimeout(_videoReconnectTimer);
        _videoReconnectTimer = setTimeout(hideVideoReconnect, 6000);
    }

    function hideVideoReconnect() {
        _videoReconnectActive = false;
        syncVideoReconnectChips();
    }

    function restartMicForSettings() {
        if (!S.connected) return;
        if (S.localStreams.mic) {
            stopMic();
        }
        if (!S.muted && !S.deafened) {
            startMic();
        }
    }

    // ------------------------------------------------------------------
    // Fullscreen helpers
    // ------------------------------------------------------------------
    // Fullscreen a WRAPPER div, not the <video> element itself — Chrome shows
    // its native playback controls (play/pause, timeline, volume) on a
    // fullscreened <video> even without the controls attribute. With a plain
    // div as the fullscreen element, no controls appear.
    //
    // On exit the SAME <video> element is moved back into its slot and its
    // decoder state is preserved — the panel is NOT re-rendered. Re-rendering
    // would destroy the element, and the fresh element's decoder must wait for
    // a new keyframe before painting. A STATIC screen share (a quiet tab, a
    // paused video) never sends one promptly, so the tile stayed black while
    // the separate screen-audio elements kept playing ("lost the sharescreen
    // video, hear only audio"). Keeping the element keeps the last frame and
    // continues decoding seamlessly.
    function toggleFullscreen(el) {
        if (!el) return;
        var fsEl = document.fullscreenElement;
        // 1) This element (or its fullscreen wrapper) IS the native fullscreen
        //    element — a click exits, and STOPS there. The old code fell through
        //    to the "exit then re-enter" branch, which is the reported bug: a
        //    click in fullscreen exited and immediately re-entered, so only
        //    Escape worked, phone users were stuck fullscreen, and the second
        //    tile appeared dead.
        if (fsEl && (fsEl === el || (fsEl.contains && fsEl.contains(el)))) {
            document.exitFullscreen().catch(function () {});
            // enterTileFullscreen() installed a fullscreenchange handler that
            // restores the tile + removes the wrapper. Only the legacy case
            // (the tile itself is the fullscreen element) needs a manual restore.
            if (fsEl === el) {
                var w0 = el.closest ? el.closest('.voice-fs-wrap') : null;
                if (w0) restoreFromFsWrap(w0, el);
            }
            return;
        }
        // 2) Inside the CSS overlay wrapper — restore the tile and leave.
        var activeWrap = el.closest ? el.closest('.voice-fs-wrap') : null;
        if (activeWrap) {
            restoreFromFsWrap(activeWrap, el);
            if (fsEl) document.exitFullscreen().catch(function () {});
            return;
        }
        // 3) Native fullscreen is active on ANOTHER element — exit, then enter
        //    with the requested one (guarded: the exit promise can resolve
        //    after a re-render swapped the element out).
        if (fsEl) {
            var target = el;
            document.exitFullscreen().then(function () {
                if (document.fullscreenElement) return;
                if (!target.isConnected) return;
                enterTileFullscreen(target);
            }).catch(function () {});
            return;
        }
        // 4) Another element is fullscreened via the CSS wrapper — restore it.
        var existingFs = document.querySelector('.voice-fs-wrap');
        if (existingFs) {
            var existingEl = existingFs.firstElementChild;
            if (existingEl) restoreFromFsWrap(existingFs, existingEl);
        }
        enterTileFullscreen(el);
    }

    // Enter fullscreen for a tile. The tile is moved into a `.voice-fs-wrap`
    // DIV and THAT DIV becomes the native fullscreen element (falling back to
    // the plain CSS overlay if the request is refused).
    //
    // Fullscreening the tile itself is what broke mirror/rotation + sizing in
    // fullscreen: Chrome's fullscreen UA stylesheet uses !important rules that
    // force `transform: none` and `width/height: 100%` on the fullscreen
    // element, and UA !important beats author !important — verified live:
    // inline `transform: scaleX(-1) !important` still present while
    // getComputedStyle() reported "none", so the feed rendered untransformed.
    // A div wrapper keeps the tile's transforms/sizing AND avoids Chrome's
    // native playback controls on a fullscreened <video>.
    function enterTileFullscreen(el) {
        if (!el || !el.isConnected) return;
        if (el.closest && el.closest('.voice-fs-wrap')) return;
        el._fsOrigParent = el.parentNode;
        el._fsOrigNext = el.nextSibling;
        var wrap = document.createElement('div');
        wrap.className = 'voice-fs-wrap';
        if (el.parentNode) el.parentNode.insertBefore(wrap, el);
        wrap.appendChild(el);
        el._fsWrap = wrap;
        var paint = function () {
            if (!el.dataset) return;
            applyTileTransform(el, el.dataset.uid, el.dataset.kind);
            syncResetViewChips(el.dataset.uid, el.dataset.kind);
        };
        var restored = false;
        var restore = function () {
            if (restored) return;
            restored = true;
            document.removeEventListener('fullscreenchange', handler);
            if (el.parentNode === wrap) moveTileBack(el);
            if (wrap.parentNode) wrap.remove();
            reattachTileStream(el);
            paint();
        };
        var handler = function () {
            if (!document.fullscreenElement) restore();
            else paint(); // re-apply after an orientation/resize relayout
        };
        document.addEventListener('fullscreenchange', handler);
        // Clicking the black area around the tile exits too.
        wrap.addEventListener('click', function (e) {
            if (e.target === wrap) document.exitFullscreen().catch(function () {});
        });
        var req = wrap.requestFullscreen ? wrap.requestFullscreen() : null;
        if (req && req.then) {
            // Rejected (no user activation / blocked) — the fixed inset:0
            // wrapper already covers the screen, so the overlay still works.
            req.then(paint).catch(function () { paint(); });
        } else {
            paint();
        }
    }

    // Restore a <video> that lives inside a .voice-fs-wrap back into the
    // member row / tile slot it was lifted from — WITHOUT destroying it. The
    // element is moved out of the wrapper first (removing the wrapper would
    // detach and lose the element's decoder state + last frame).
    function restoreFromFsWrap(wrap, el) {
        if (el && el.parentNode === wrap) {
            moveTileBack(el);
        }
        if (wrap.parentNode) wrap.remove();
        if (el) {
            reattachTileStream(el);
            if (el.dataset) applyTileTransform(el, el.dataset.uid, el.dataset.kind);
        }
    }

    // Put a fullscreened tile back into its live slot, preserving the <video>
    // element. If the original container was re-rendered while fullscreened
    // (camera/screen member update, DM self strip rebuild) the element is
    // dropped instead — the fresh render already has a correct tile, and we
    // make sure THAT tile has the stream attached.
    function moveTileBack(el) {
        var origParent = el._fsOrigParent;
        var origNext = el._fsOrigNext;
        if (origParent && origParent.isConnected) {
            if (origNext && origNext.parentNode === origParent) {
                origParent.insertBefore(el, origNext);
            } else {
                origParent.appendChild(el);
            }
            return;
        }
        var slot = findTileSlot(el);
        if (slot) {
            slot.appendChild(el);
        } else {
            // A duplicate already exists in the current render (or the tile was
            // removed entirely) — make sure the live duplicate has its stream.
            var dup = findTileDuplicate(el);
            if (dup) {
                if (isTileVisible(dup)) {
                    reattachTileStream(dup);
                } else if (dup.parentElement) {
                    // The "live" duplicate is a tile we can't show (e.g. the
                    // hidden mesh <video> behind a relay <img>). Put the
                    // restored element back beside it instead of orphaning it —
                    // this is what froze the tile after a second fullscreen.
                    dup.parentElement.insertBefore(el, dup);
                    reattachTileStream(el);
                }
            }
        }
    }

    // Find the live container this tile should live in (self strip, DM tile
    // media, or voice member media), or null if a duplicate already exists.
    function findTileSlot(el) {
        var isSelf = el.dataset && el.dataset.self === '1';
        var kind = el.dataset && el.dataset.kind;
        if (isSelf) {
            var dmPrev = el('dm-call-self');
            if (!dmPrev) return null;
            if (kind && dmPrev.querySelector('.voice-self-video[data-kind="' + kind + '"]')) return null;
            return dmPrev;
        }
        var uid = el.dataset && el.dataset.uid;
        if (!uid) return null;
        var sel = '.dm-call-tile[data-uid="' + uid + '"] .dm-call-tile-media, .voice-member-row[data-uid="' + uid + '"] .voice-member-media';
        var list = document.querySelectorAll(sel);
        for (var i = 0; i < list.length; i++) {
            if (!list[i].isConnected) continue;
            if (kind && list[i].querySelector('.remote-video-tile[data-uid="' + uid + '"][data-kind="' + kind + '"]')) return null;
            return list[i];
        }
        return null;
    }

    function findTileDuplicate(el) {
        var isSelf = el.dataset && el.dataset.self === '1';
        var kind = el.dataset && el.dataset.kind;
        var uid = el.dataset && el.dataset.uid;
        if (isSelf) {
            var dmPrev = el('dm-call-self');
            return dmPrev && kind ? dmPrev.querySelector('.voice-self-video[data-kind="' + kind + '"]') : null;
        }
        if (!uid) return null;
        // Never return the element being restored as its own duplicate, and
        // skip anything still sitting in a fullscreen wrapper. The old query
        // returned the lifted element, so the live tile never got the stream
        // back (black/frozen tile after exiting a second fullscreen).
        var list = document.querySelectorAll('.remote-video-tile[data-uid="' + uid + '"][data-kind="' + kind + '"]');
        for (var i = 0; i < list.length; i++) {
            var n = list[i];
            if (n === el) continue;
            if (n.closest && n.closest('.voice-fs-wrap')) continue;
            return n;
        }
        return null;
    }

    // Re-attach the stream to a tile if it changed while fullscreened (a
    // renegotiation can replace the underlying track). No-op when the stream
    // is unchanged — the element's decoder keeps its state and last frame.
    function reattachTileStream(el) {
        if (!el || !el.isConnected) return;
        var uid = el.dataset && el.dataset.uid;
        var kind = el.dataset && el.dataset.kind;
        var isSelf = el.dataset && el.dataset.self === '1';
        var stream = null;
        if (isSelf) {
            stream = kind === 'camera' ? S.localStreams.camera : S.localStreams.screen;
        } else if (uid && S.remoteStreams[uid]) {
            stream = S.remoteStreams[uid][kind];
        }
        if (stream && el.srcObject !== stream) {
            el.srcObject = stream;
        }
        try { el.play().catch(function () {}); } catch (_) {}
    }

    // ------------------------------------------------------------------
    // Utils
    // ------------------------------------------------------------------
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function bindClick(root, id, fn) {
        var btn = root.querySelector('#' + id);
        if (btn) btn.addEventListener('click', fn);
    }

    // ------------------------------------------------------------------
    // Expose hook for chat.js to call after WS reconnect
    // ------------------------------------------------------------------
    VoiceManager.reconnect = function () {
        // Rejoin the room we were in before the socket dropped
        if (S.roomType === 'server' && S.serverId && S.channelId) {
            send({ type: 'voice_join', room_type: 'server', server_id: S.serverId, channel_id: S.channelId });
        } else if (S.roomType === 'dm' && S.dmChannelId) {
            send({ type: 'voice_join', room_type: 'dm', dm_channel_id: S.dmChannelId });
        }
        // Refresh waiting state from server-persisted data so indicators
        // survive reconnects.
        syncWaitingCalls();
        // Refresh the server-wide presence so channel-list member rows recover
        // after a socket drop (without waiting for the next channel-list rebuild).
        var sid = (typeof currentServerId !== 'undefined' && currentServerId) || S.serverId;
        if (sid) requestServerPresence(sid);
        // Re-apply the server-list voice dots in case the list was rebuilt
        // while the socket was down (a rebuild wipes them).
        updateServerVoiceIndicators();
    };

    // Page-load fallback: a freshly loaded page sends voice_leave_all so the
    // server drops us from every voice room we might still be in (crash, stale
    // socket, or server restart can skip the disconnect cleanup). Only fires
    // when we have no active room state — on a mid-session WS reconnect S is
    // still populated (reconnect() rejoins instead), so live calls are never
    // kicked by this.
    VoiceManager.leaveAllStaleRooms = function () {
        if (S.roomType || S.connected || S.dmCallActive) return;
        send({ type: 'voice_leave_all' });
    };

    // Allow chat.js to inject the DM header call buttons right after it builds a header
    VoiceManager.maybeInjectDmCallButtons = maybeInjectDmCallButtons;

    // Called by chat.js after it re-renders the channel list
    VoiceManager.onChannelsRendered = function () {
        updateChannelChips();
        // Ask for a fresh presence snapshot whenever a server's channel list
        // is (re)built — covers first load, server switches and refreshes.
        var sid = (typeof currentServerId !== 'undefined' && currentServerId) || S.serverId;
        if (sid) requestServerPresence(sid);
    };

    VoiceManager.requestServerPresence = requestServerPresence;
    VoiceManager.updateServerVoiceIndicators = updateServerVoiceIndicators;
    // Cached voice_presence snapshot for a server (null if never requested /
    // no voice activity since load) — lets the server-list renderer skip
    // re-requesting snapshots it already has.
    VoiceManager.getServerPresence = function (serverId) {
        return S.serverPresence[serverId] || null;
    };
    VoiceManager.refreshChannelChips = updateChannelChips;
    // Test-only: simulate a voice_presence WS message without a real server
    VoiceManager.setServerPresence = function (serverId, presenceData) {
        handleVoicePresence(Object.assign({ server_id: serverId }, presenceData));
    };
})();
