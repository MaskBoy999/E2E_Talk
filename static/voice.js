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
        roomKeyB64: null,
        sigKeyB64: null,        // signaling subkey (SDP/ICE E2EE) derived from the room key
        _pendingRecvTransforms: [],  // receivers awaiting a decrypt transform until the room key arrives
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ],
        turnConfigured: false,  // true once the server's TURN config is applied
        audioCtx: null,
        masterGain: null,
        micGain: null,
        remoteAudioEls: {},      // uid -> [HTMLAudioElement] (stacked for >100% volume)
        analyser: null,
        speakingInterval: null,
        speaking: false,
        muted: false,
        deafened: false,
        cameraOn: false,
        screenOn: false,
        popupOpen: false,        // voice channel view (top panel in the text area)
        dmPanelOpen: undefined,  // DM call panel in the DM chat
        dmCallExpanded: false,   // DM call panel expanded → covers the WHOLE screen
        voiceFullscreen: false,  // voice channel view expanded → covers the WHOLE screen
        incomingCall: null,      // {callerId, callerUsername, dmChannelId}
        dmCallActive: false,     // we're in a DM call (ringing/connected)
        dmCallAnswered: false,   // the other DM participant joined the room
        dmCallPartner: null,     // {id, username}
        settings: {
            micVolume: 100,
            speakerVolume: 100,
            noiseSuppressionMode: 'rnnoise', // 'off' | 'browser' | 'rnnoise'
            echoCancellation: false,          // Chrome's AEC on the mic (default OFF)
        },
        _viewLast: '',
        _lastSpeakSent: 0,
        _viewPoll: null,
        _pfpLoading: {},           // picKey -> true (in-flight PFP fetch guard)
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
    };

    var e2eeWorker = null;

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------
    var VoiceManager = {
        init: init,
        onWsMessage: onWsMessage,
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
        toggleServerPopup: toggleServerPopup,
        toggleVoiceFullscreen: toggleVoiceFullscreen,
        setMicVolume: setMicVolume,
        setSpeakerVolume: setSpeakerVolume,
        setNoiseSuppression: setNoiseSuppression,
        setEchoCancellation: setEchoCancellation,
        setMemberVolume: setMemberVolume,
        ownerControl: ownerControl,
        startDmCall: startDmCall,
        acceptDmCall: acceptDmCall,
        declineDmCall: declineDmCall,
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
        resetDmPanelOpen: function () { S.dmPanelOpen = undefined; },
        testRingtone: testRingtone,
        playRingtone: playRingtone,
        stopRingtone: stopRingtone,
        isCallWaiting: function () { return S.callWaiting; },
        isIncomingWaiting: function () { return !!(S.incomingCall && S.incomingCall.waiting); },
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
        },
    };

    window.VoiceManager = VoiceManager;

    // ------------------------------------------------------------------
    // Init / wiring
    // ------------------------------------------------------------------
    function init() {
        loadSettings();
        fetchTurnConfig();
        bindBarControls();
        bindPopupControls();
        bindDmPanelControls();
        bindMiniBarControls();
        bindVolumeMenu();
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
        applySettingsToUI();
    }

    // Reset both fullscreen states to OFF (DM panel expand + voice view
    // fullscreen) and re-apply. Called on every join and leave so each call
    // always starts in the normal (non-fullscreen) layout.
    function resetFullscreenState() {
        S.dmCallExpanded = false;
        S.voiceFullscreen = false;
        try { localStorage.removeItem('dm_call_expanded'); } catch (_) {}
        try { localStorage.removeItem('voice_fullscreen'); } catch (_) {}
        applyDmExpand();
        applyVoiceFullscreen();
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
        updateSettingsLabels();
    }

    // ------------------------------------------------------------------
    // Audio context (created on first user gesture so autoplay is allowed)
    // ------------------------------------------------------------------
    function ensureAudioCtx() {
        if (!S.audioCtx) {
            try {
                var AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return;
                S.audioCtx = new AC();
                S.masterGain = S.audioCtx.createGain();
                S.masterGain.gain.value = S.settings.speakerVolume / 100;
                S.masterGain.connect(S.audioCtx.destination);
                S.micGain = S.audioCtx.createGain();
                S.micGain.gain.value = S.settings.micVolume / 100;
            } catch (_) {}
        }
        if (S.audioCtx && S.audioCtx.state === 'suspended') {
            S.audioCtx.resume().catch(function () {});
        }
        // Keep the context alive when the tab regains focus/visibility
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

    function ensureE2eeWorker() {
        if (window.RTCRtpScriptTransform && !e2eeWorker) {
            // ?v= busts the browser cache for the worker — a stale cached
            // e2ee-worker.js silently breaks E2EE on EVERY room type (same
            // stale-cache class of bug as voice.js, which is also versioned).
            try { e2eeWorker = new Worker('/e2ee-worker.js?v=2'); } catch (_) {}
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
            if (obj && obj.type === 'voice_signal' && obj.signal) {
                var enc = encryptSignalPayload(obj.signal);
                if (enc) {
                    payload = {
                        type: obj.type,
                        room_type: obj.room_type,
                        channel_id: obj.channel_id,
                        dm_channel_id: obj.dm_channel_id,
                        to_user_id: obj.to_user_id,
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
        deriveRoomKey();
        deriveSignalKey();
        send({ type: 'voice_join', room_type: 'server', server_id: serverId, channel_id: channelId });
        playSound('join');
        showToast('Joining voice channel…');
    }

    function leaveVoice() {
        var wasDm = S.roomType === 'dm';
        if (S.connected || S.roomType) {
            send({ type: 'voice_leave', room_type: S.roomType || 'server', channel_id: S.channelId || '', dm_channel_id: S.dmChannelId || '' });
        }
        teardownRoom();
        if (wasDm) playSound('leave');
        else if (S.connected) playSound('leave');
        hideBar();
        hidePopup();
        hideDmPanel();
        hideMiniBar();
        hideIncomingCall();
    }

    function teardownRoom() {
        clearRingTimer();
        clearCalleeRingTimer();
        stopRingtone();
        var prevDmChannelId = S.dmChannelId;
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
        if (S.waitingCalls && prevDmChannelId && S.waitingCalls[prevDmChannelId]) {
            delete S.waitingCalls[prevDmChannelId];
            notifyWaitingChanged();
        }
        closeAllPeers();
        stopLocalMedia();
        stopSpeakingDetection();
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
        closeAllPeers();
        var selfId = getSelfId();
        Object.keys(S.members).forEach(function (uid) {
            if (uid !== selfId && !S.peers[uid]) {
                createPeer(uid);
            }
        });
    }

    function closeAllPeers() {
        for (var uid in S.peers) {
            try { S.peers[uid].close(); } catch (_) {}
        }
        S.peers = {};
        for (var uid2 in S.remoteAudioEls) {
            removeRemoteAudioEls(uid2);
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
        if (mode === 'rnnoise' && !(window.AudioWorkletNode && window.AudioContext)) {
            // No AudioWorklet support — fall back to the browser's built-in NS.
            return 'browser';
        }
        if (mode === 'rnnoise' && _nsFailedSession) {
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
        if (mode !== 'rnnoise' || !S.localStreams.mic || !window.AudioWorkletNode) return Promise.resolve(null);
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
                    worklet.connect(dest);
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
        if (S.nsCtx) {
            try { S.nsCtx.close(); } catch (_) {}
            S.nsCtx = null;
        }
    }

    function startMic() {
        if (S.localStreams.mic || S.deafened) return Promise.resolve();
        var mode = effectiveNsMode();
        var constraints = {
            audio: {
                echoCancellation: !!S.settings.echoCancellation,
                noiseSuppression: mode === 'browser', // RNNoise replaces it
                autoGainControl: true,
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

    function stopMic() {
        teardownMicPipeline();
        if (S.localStreams.mic) {
            S.localStreams.mic.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
            S.localStreams.mic = null;
            removeTrackFromAllPeers('audio');
        }
        stopSpeakingDetection();
    }

    function startCamera() {
        if (S.localStreams.camera) return Promise.resolve();
        return navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, facingMode: 'user' }, audio: false })
            .then(function (stream) {
                S.localStreams.camera = stream;
                S.cameraOn = true;
                addLocalTracksToAllPeers();
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
            S.localStreams.camera = null;
        }
        S.cameraOn = false;
        removeTrackFromAllPeers('camera');
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
        return navigator.mediaDevices.getDisplayMedia({
            video: {
                cursor: 'always',
                width: { max: 1920 },
                height: { max: 1080 },
                frameRate: { ideal: 30, max: 30 },
            },
            audio: false,
        })
            .then(function (stream) {
                S.localStreams.screen = stream;
                S.screenOn = true;
                stream.getVideoTracks()[0].addEventListener('ended', function () {
                    stopScreen();
                });
                addLocalTracksToAllPeers();
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
            S.localStreams.screen = null;
        }
        S.screenOn = false;
        removeTrackFromAllPeers('screen');
        sendVoiceState();
        renderSelfPreview();
        renderPopup();
        renderDmPanel();
        updateSelfUI();
    }

    // ------------------------------------------------------------------
    // WebRTC mesh peers
    // ------------------------------------------------------------------
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
        return pc;
    }

    function addLocalTracks(pc) {
        ensureE2eeWorker();
        // NOTE: MediaStream.id is read-only, so we never tag streams with
        // 'camera-'/'screen-' — the receiver classifies by member flags + fill
        // order instead (see handleRemoteTrack). Only the stream object matters
        // here; addTrack associates the track with it for the msid.
        if (S.localStreams.mic && !S.muted && !S.deafened) {
            // Prefer the RNNoise-processed track when active; otherwise the
            // raw mic track.
            var at = (S.localStreams.processedMic && S.localStreams.processedMic.getAudioTracks()[0]) || S.localStreams.mic.getAudioTracks()[0];
            if (at && !pc.getSenders().find(function (s) { return s.track && s.track.kind === 'audio'; })) {
                pc.addTrack(at, new MediaStream([at]));
            }
        }
        if (S.localStreams.camera && S.cameraOn) {
            var vt = S.localStreams.camera.getVideoTracks()[0];
            if (vt && !pc.getSenders().find(function (s) { return s.track && s.track.id === vt.id; })) {
                pc.addTrack(vt, new MediaStream([vt]));
            }
        }
        if (S.localStreams.screen && S.screenOn) {
            var st = S.localStreams.screen.getVideoTracks()[0];
            if (st && !pc.getSenders().find(function (s) { return s.track && s.track.id === st.id; })) {
                pc.addTrack(st, new MediaStream([st]));
            }
        }
    }

    function addLocalTracksToAllPeers() {
        for (var uid in S.peers) {
            addLocalTracks(S.peers[uid]);
            applySendE2EE(S.peers[uid]);
            tuneVideoSenders(S.peers[uid]);
        }
    }

    // Cap video send bitrate so screen shares / cameras don't saturate the
    // mesh. Unbounded encoders at high resolution + fps generate far more
    // RTP than the connection can carry → packet loss → decoder artifacts.
    // Screen: 2.5 Mbps (static content, plenty). Camera: 1.2 Mbps. Prefer
    // maintaining resolution so text in shares stays readable when bandwidth
    // dips (degradationPreference is a sender parameter, not a capture one).
    function tuneVideoSenders(pc) {
        if (!pc || !pc.getSenders) return;
        try {
            pc.getSenders().forEach(function (s) {
                if (!s.track || s.track.kind !== 'video') return;
                var isScreen = S.localStreams.screen && S.localStreams.screen.getVideoTracks().indexOf(s.track) !== -1;
                var maxBitrate = isScreen ? 2500000 : 1200000;
                try {
                    var params = s.getParameters();
                    if (!params.encodings || params.encodings.length === 0) return;
                    params.encodings.forEach(function (enc) {
                        enc.maxBitrate = maxBitrate;
                        enc.maxFramerate = 30;
                    });
                    params.degradationPreference = isScreen ? 'maintain-resolution' : 'balanced';
                    s.setParameters(params).catch(function () {});
                } catch (_) {}
            });
        } catch (_) {}
    }

    function removeTrackFromAllPeers(kind) {
        for (var uid in S.peers) {
            var pc = S.peers[uid];
            var senders = pc.getSenders().filter(function (s) {
                return s.track && (kind === 'audio' ? s.track.kind === 'audio' : (s.track.kind === 'video' && isTrackKind(s.track, kind)));
            });
            senders.forEach(function (s) {
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
            receiver.transform = new RTCRtpScriptTransform(e2eeWorker, { operation: 'decrypt', key: S.roomKeyB64 });
            return true;
        } catch (_) {
            return false;
        }
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
            // Renegotiation (ICE restart, media add/remove) re-fires ontrack
            // with the SAME track object. Rebuilding the stream + refreshing
            // srcObject would RESTART the <audio> element playback → an
            // audible volume drop "for no reason". Keep playing if it's the
            // same track.
            var prev = S.remoteStreams[uid] && S.remoteStreams[uid].audio;
            if (prev && prev.getAudioTracks()[0] === e.track) return;
            S.remoteStreams[uid] = S.remoteStreams[uid] || {};
            S.remoteStreams[uid].audio = new MediaStream([e.track]);
            playRemoteAudio(uid);
        } else if (e.track.kind === 'video') {
            S.remoteStreams[uid] = S.remoteStreams[uid] || {};
            // MediaStream.id is read-only, so stream ids can never carry a
            // 'screen-' prefix — the sender's camStream.id/scrStream.id tagging
            // silently no-ops. Classify from the member's broadcast flags, and
            // when both are on use the fill order (camera is added first).
            // e.streams is also often EMPTY for later renegotiated tracks, so
            // never rely on it for classification.
            var m = S.members[uid] || {};
            var existing = S.remoteStreams[uid];
            var key;
            if (m.screen && !m.camera) key = 'screen';
            else if (m.camera && !m.screen) key = 'camera';
            else key = existing.camera ? 'screen' : 'camera'; // both on, or flags not yet arrived
            S.remoteStreams[uid][key] = new MediaStream([e.track]);
            // Clear the slot when the remote stops this track, so a stale
            // stream doesn't linger on the tile.
            e.track.onended = function () {
                if (S.remoteStreams[uid] && S.remoteStreams[uid][key] &&
                    S.remoteStreams[uid][key].getTracks().indexOf(e.track) !== -1) {
                    delete S.remoteStreams[uid][key];
                    renderPopup();
                    renderDmPanel();
                }
            };
            // E2EE on the receiver — queue if the key isn't ready yet (see
            // applyRecvE2EE/flushPendingRecvTransforms).
            ensureE2eeWorker();
            if (!applyRecvE2EE(e.receiver)) {
                queueRecvE2EE(e.receiver, e.track.id);
            }
            renderRemoteTile(uid, key);
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
    }

    function applyRemoteVolume(uid) {
        var els = S.remoteAudioEls[uid];
        if (!els) return;
        // Round to 2 decimals so ceil() never mints a negligible extra
        // element for volumes like 2.0000001.
        var vol = Math.max(0, Math.min(5, Math.round(remoteVolumeFor(uid) * 100) / 100));
        var need = Math.max(1, Math.ceil(vol));
        var stream = S.remoteStreams[uid] && S.remoteStreams[uid].audio;
        while (els.length < need) {
            var el = document.createElement('audio');
            el.autoplay = true;
            el.muted = false;
            el.style.display = 'none';
            if (stream) el.srcObject = stream;
            el.play().catch(function () {});
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

    function setMemberVolume(uid, pct) {
        try { localStorage.setItem('voice_volume_' + uid, String(pct)); } catch (_) {}
        if (S.remoteAudioEls[uid]) applyRemoteVolume(uid);
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
            // A peer we haven't created yet — create it (covers late-joining members
            // and DM callees who receive an offer before their own voice_joined lands)
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
                flushPendingIce(pc);
            }).catch(function (err) {
                console.warn('setRemote( answer ) failed:', err);
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
            case 'voice_control_received':
                handleControlReceived(data);
                break;
            case 'dm_call_ring':
                handleDmCallRing(data);
                break;
            case 'dm_call_waiting':
                handleDmCallWaiting(data);
                break;
            case 'dm_call_end':
                handleDmCallEnd(data);
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
        peerUids.forEach(function (uid, idx) {
            setTimeout(function () {
                if (!S.connected || S.roomKeyB64 === undefined) return;
                if (S.peers[uid]) return;
                createPeer(uid);
            }, idx * 100);
        });

        if (S.roomType === 'server') {
            showBar();
            renderPopup();
        } else {
            // DM call — show panel or mini bar depending on the current view
            updateDmCallUI();
        }
        updateSelfUI();
        updateChannelChips();

        // Mic: auto start unless force-muted/deafened
        if (!S.muted && !S.deafened) {
            startMic();
        }

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
        newUids.forEach(function (m, idx) {
            setTimeout(function () {
                if (!S.connected || !S.members[m.user_id]) return;
                if (S.peers[m.user_id]) return;
                createPeer(m.user_id);
            }, idx * 100);
        });
        // Close peers for people who left
        Object.keys(S.peers).forEach(function (uid) {
            if (!newMembers[uid]) {
                try { S.peers[uid].close(); } catch (_) {}
                delete S.peers[uid];
                removeRemoteAudioEls(uid);
                delete S.remoteStreams[uid];
                removeRemoteTile(uid);
            }
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
            (!isSelf && (prev.camera !== member.camera || prev.screen !== member.screen));
        S.members[member.user_id] = member;
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
            if (st) st.innerHTML = memberBadges(local, 'vm');
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
            try { S.peers[uid].close(); } catch (_) {}
            delete S.peers[uid];
        }
        removeRemoteAudioEls(uid);
        delete S.remoteStreams[uid];
        removeRemoteTile(uid);
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
    }

    // Ask the server for the current voice presence snapshot for a server.
    function requestServerPresence(serverId) {
        if (!serverId) return;
        send({ type: 'voice_presence_request', server_id: serverId });
    }

    function handleKicked(data) {
        showToast('You were kicked from the voice channel.');
        playSound('leave');
        teardownRoom();
        hideBar();
        hidePopup();
        hideDmPanel();
        hideMiniBar();
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

    async    function startDmCall(dmChannelId, partnerId, partnerUsername) {
        ensureAudioCtx();
        // If we're already in a server room, leave it first
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
        S.callWaiting = false;
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
        }, 30000);
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
        // open, floating mini bar everywhere else. (Previously this forced the
        // DM call panel open over whatever channel the user was viewing.)
        updateDmCallUI();
        notifyWaitingChanged();
        // The call is live — drop any persisted waiting marker for this channel.
        if (S.dmChannelId && S.waitingCalls[S.dmChannelId]) {
            delete S.waitingCalls[S.dmChannelId];
            notifyWaitingChanged();
        }
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
        if (S.connected && S.roomType === 'server') {
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
        resetFullscreenState();
        await ensureDmCallKey(c.callerId);
        deriveRoomKey();
        deriveSignalKey();
        send({ type: 'voice_join', room_type: 'dm', dm_channel_id: c.dmChannelId });
        playSound('join');
        updateDmCallUI();
        // Switch the view to this DM so the panel is visible
        if (typeof selectDmChannel === 'function' && window.currentDmOtherUser === null) {
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
        dmConversations.forEach(function (conv) {
            if (conv && conv.dm_channel_id && conv.waiting_user_id) {
                S.waitingCalls[conv.dm_channel_id] = {
                    waitingUserId: conv.waiting_user_id,
                    waitingUsername: conv.waiting_username || '',
                };
            }
        });
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
        S.callWaiting = false;
        resetFullscreenState();
        await ensureDmCallKey(partnerId);
        deriveRoomKey();
        deriveSignalKey();
        send({ type: 'voice_join', room_type: 'dm', dm_channel_id: dmChannelId });
        playSound('join');
        updateDmCallUI();
        // Clear the persisted waiting marker for this channel now that we're
        // (re)joining — the call connects if the other side is present.
        delete S.waitingCalls[dmChannelId];
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
        if (S.dmCallActive || S.connected) {
            // Already busy — let the caller know we can't join
            send({ type: 'dm_call_end', dm_channel_id: data.dm_channel_id });
            return;
        }
        S.incomingCall = { callerId: data.caller_id, callerUsername: data.caller_username, dmChannelId: data.dm_channel_id };
        showIncomingCall(S.incomingCall);
        // Play the user's custom ringtone (loops until answered / 30s timeout).
        playRingtone(true);
        // Local safety net: even if the caller's dm_call_waiting is never
        // delivered (e.g. the caller's tab died), stop ringing after 30s and
        // flip the incoming bar to the waiting state.
        clearCalleeRingTimer();
        S._calleeRingTimer = setTimeout(function () {
            if (S.incomingCall && S.incomingCall.dmChannelId === data.dm_channel_id && !S.incomingCall.waiting) {
                handleDmCallWaiting({ dm_channel_id: data.dm_channel_id });
            }
        }, 30000);
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
        if (S.incomingCall && S.incomingCall.dmChannelId === data.dm_channel_id) {
            S.incomingCall.waiting = true;
            stopRingtone();
            var b = el('incoming-call-bar');
            if (b) b.classList.add('waiting');
            var name = el('incoming-call-name');
            if (name) name.textContent = S.incomingCall.callerUsername + ' is waiting for you to join';
            var acceptBtn = el('incoming-call-accept');
            if (acceptBtn) acceptBtn.textContent = 'Join';
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
        }
        if (S.dmCallActive && S.dmChannelId === data.dm_channel_id) {
            var wasConnected = S.connected;
            clearRingTimer();
            clearCalleeRingTimer();
            stopRingtone();
            if (isDecline) {
                // Callee declined — place caller in waiting state (same as 30s
                // timeout) so they can call again. Don't tear down the room.
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
        // Mute/unmute all remote audio
        Object.keys(S.remoteAudioEls).forEach(function (uid) {
            applyRemoteVolume(uid);
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

    function sendVoiceState() {
        if (!S.connected) return;
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
                    // top, below the chat header); CSS keeps the 52vh height.
                    el2.style.left = left + 'px';
                    el2.style.top = top + 'px';
                    el2.style.bottom = '';
                    el2.style.height = '';
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
        });
        ['voice-bar', 'dm-mini-bar'].forEach(function (id) {
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
        if (name) name.textContent = S.roomType === 'dm' ? ('In call with ' + (S.dmCallPartner ? S.dmCallPartner.username : '…')) : (S.channelName || 'Voice Connected');
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
        bindClick(bar, 'voice-bar-screen', function () { toggleScreen(); });
        bindClick(bar, 'voice-bar-leave', function () { leaveVoice(); });
        bindClick(bar, 'voice-bar-popup', function () {
            // The ☰ button redirects us INTO the voice channel view.
            if (S.roomType === 'server') navigateToVoiceChannel();
        });
    }

    function renderBar() {
        var micBtn = el('voice-bar-mute');
        if (micBtn) {
            micBtn.textContent = S.muted ? '🔇' : '🎤';
            micBtn.classList.toggle('active', S.muted);
            micBtn.classList.toggle('locked', S.forceMuted);
            micBtn.title = S.forceMuted ? 'Server muted' : (S.muted ? 'Unmute' : 'Mute');
        }
        var deafBtn = el('voice-bar-deafen');
        if (deafBtn) {
            deafBtn.textContent = S.deafened ? '🔇' : '🔈';
            deafBtn.classList.toggle('active', S.deafened);
            deafBtn.classList.toggle('locked', S.forceDeafened);
            deafBtn.title = S.forceDeafened ? 'Server deafened' : (S.deafened ? 'Undeafen' : 'Deafen');
        }
        var camBtn = el('voice-bar-camera');
        if (camBtn) {
            camBtn.textContent = S.cameraOn ? '🎥' : '📷';
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
        bindClick(pop, 'voice-popup-screen', function () { toggleScreen(); });
        bindClick(pop, 'voice-popup-leave', function () { leaveVoice(); });
        var pmv = pop.querySelector('#voice-popup-mic-volume');
        if (pmv) pmv.addEventListener('input', function (e) { setMicVolume(parseInt(e.target.value, 10)); });
        var psv = pop.querySelector('#voice-popup-speaker-volume');
        if (psv) psv.addEventListener('input', function (e) { setSpeakerVolume(parseInt(e.target.value, 10)); });
        var pns = pop.querySelector('#voice-popup-noise-suppression');
        if (pns) pns.addEventListener('change', function (e) { setNoiseSuppression(e.target.value); });

        // Settings-modal sliders (same bindings)
        var smv = document.getElementById('voice-mic-volume');
        if (smv) smv.addEventListener('input', function (e) { setMicVolume(parseInt(e.target.value, 10)); updateSettingsLabels(); });
        var ssv = document.getElementById('voice-speaker-volume');
        if (ssv) ssv.addEventListener('input', function (e) { setSpeakerVolume(parseInt(e.target.value, 10)); updateSettingsLabels(); });
        var sns = document.getElementById('voice-noise-suppression');
        if (sns) sns.addEventListener('change', function (e) { setNoiseSuppression(e.target.value); });
        var sec = document.getElementById('voice-echo-cancellation');
        if (sec) sec.addEventListener('change', function (e) { setEchoCancellation(e.target.checked); });
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
        var pns = document.getElementById('voice-popup-noise-suppression');
        if (pns) pns.value = S.settings.noiseSuppressionMode || 'rnnoise';
    }

    // Display name from the decrypted profile cache, falling back to username.
    function memberDisplayName(uid, m) {
        if (typeof userDisplayNameCache !== 'undefined' && userDisplayNameCache[uid] && userDisplayNameCache[uid].display_name) {
            return userDisplayNameCache[uid].display_name;
        }
        return (m && m.username) || 'Unknown';
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
        if (m.force_muted) html += ' <span class="' + prefix + '-badge locked" title="Server muted">🔒🔇</span>';
        else if (m.muted) html += ' <span class="' + prefix + '-badge" title="Muted">🔇</span>';
        if (m.force_deafened) html += ' <span class="' + prefix + '-badge locked" title="Server deafened">🔒🔈</span>';
        else if (m.deafened) html += ' <span class="' + prefix + '-badge" title="Deafened">🔈</span>';
        if (m.camera) html += ' <span class="' + prefix + '-badge" title="Camera">📷</span>';
        if (m.screen) html += ' <span class="' + prefix + '-badge" title="Screen">🖥️</span>';
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
        var html = '<div class="voice-member-row' + (speaking ? ' speaking' : '') + '" data-uid="' + esc(uid) + '"' + (isSelf ? ' data-self="1"' : '') + '>';
        html += '<div class="voice-member-ident">';
        html += memberAvatarHtml(uid, local, name, 'voice-member-avatar');
        html += '<div class="voice-member-info">';
        html += '<span class="voice-member-name">' + esc(name) + (local.is_owner ? ' 👑' : '') + (isSelf ? ' (you)' : '') + '</span>';
        html += '<span class="voice-member-status">' + memberBadges(local, 'vm') + '</span>';
        html += '</div></div>';
        html += '<div class="voice-member-media">';
        html += '<video class="remote-video-tile" data-uid="' + esc(uid) + '" data-kind="camera" data-self="' + (isSelf ? '1' : '0') + '" autoplay playsinline muted style="display:' + (local.camera ? 'block' : 'none') + '"></video>';
        html += '<video class="remote-video-tile" data-uid="' + esc(uid) + '" data-kind="screen" data-self="' + (isSelf ? '1' : '0') + '" autoplay playsinline muted style="display:' + (local.screen ? 'block' : 'none') + '"></video>';
        html += '</div></div>';
        return html;
    }

    // Attach srcObject to every media tile inside a container. Self tiles use
    // the local camera/screen streams; other tiles use the remote streams.
    function wireVoiceMedia(root) {
        if (!root) return;
        var selfId = getSelfId();
        root.querySelectorAll('.remote-video-tile').forEach(function (video) {
            var uid = video.dataset.uid;
            var kind = video.dataset.kind;
            var isSelf = video.dataset.self === '1';
            var stream = null;
            if (isSelf) {
                stream = kind === 'camera' ? S.localStreams.camera : S.localStreams.screen;
            } else if (S.remoteStreams[uid]) {
                stream = S.remoteStreams[uid][kind];
            }
            if (stream) {
                video.srcObject = stream;
                video.play().catch(function () {});
            }
            video.addEventListener('click', function () { toggleFullscreen(video); });
        });
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

        // Right-click → volume menu (all users) + owner controls (server owner)
        list.querySelectorAll('.voice-member-row').forEach(function (row) {
            row.addEventListener('contextmenu', function (e) {
                e.preventDefault();
                openVolumeMenu(e, row.dataset.uid);
            });
        });
        wireVoiceMedia(list);
    }

    function clearRemoteTiles() {
        var lists = [el('voice-popup-members'), el('dm-call-body')];
        lists.forEach(function (l) {
            if (!l) return;
            l.querySelectorAll('.remote-video-tile').forEach(function (t) { t.remove(); });
        });
    }

    function removeRemoteTile(uid) {
        document.querySelectorAll('.remote-video-tile[data-uid="' + uid + '"]').forEach(function (t) { t.remove(); });
    }

    function renderRemoteTile(uid, kind) {
        // The tile element IS the <video> (class remote-video-tile sits on the
        // video itself) — attach srcObject directly.
        var video = document.querySelector('.remote-video-tile[data-uid="' + uid + '"][data-kind="' + kind + '"]');
        if (!video) return;
        if (S.remoteStreams[uid] && S.remoteStreams[uid][kind]) {
            video.srcObject = S.remoteStreams[uid][kind];
            video.play().catch(function () {});
        }
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
            v.addEventListener('click', function () { toggleFullscreen(v); });
            wrap.appendChild(v);
        }
        if (S.screenOn && S.localStreams.screen) {
            var s = document.createElement('video');
            s.autoplay = true;
            s.muted = true;
            s.playsInline = true;
            s.srcObject = S.localStreams.screen;
            s.className = 'voice-self-video';
            s.addEventListener('click', function () { toggleFullscreen(s); });
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
            if (S.callWaiting) {
                name.textContent = 'Waiting for ' + (S.dmCallPartner ? S.dmCallPartner.username : 'answer') + '…';
            } else if (!S.dmCallAnswered && S.dmCallActive) {
                name.textContent = 'Calling ' + (S.dmCallPartner ? S.dmCallPartner.username : '…') + '…';
            } else {
                name.textContent = S.dmCallPartner ? S.dmCallPartner.username : '…';
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
            btn.textContent = S.dmCallExpanded ? '\u2921' : '\u2922';
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
            btn.textContent = S.voiceFullscreen ? '\u2921' : '\u2922';
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
        bindClick(p, 'dm-call-screen', function () { toggleScreen(); });
        bindClick(p, 'dm-call-end', function () { endDmCall(); });
        bindClick(p, 'dm-call-expand', function () { toggleDmExpand(); });
        bindClick(p, 'dm-call-close', function () { hideDmPanel(); });
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

        // Wire remote tiles — the tile element IS the <video>
        body.querySelectorAll('.remote-video-tile').forEach(function (video) {
            var uid = video.dataset.uid;
            var kind = video.dataset.kind;
            if (S.remoteStreams[uid] && S.remoteStreams[uid][kind]) {
                video.srcObject = S.remoteStreams[uid][kind];
                video.play().catch(function () {});
            }
            video.addEventListener('click', function () { toggleFullscreen(video); });
            video.addEventListener('contextmenu', function (e) {
                e.preventDefault();
                e.stopPropagation();
                openVolumeMenu(e, uid);
            });
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
                if (uid) openVolumeMenu(e, uid);
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
        html += '<span>' + esc(name) + '</span>';
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
            if (S.callWaiting) {
                name.textContent = S.dmCallPartner ? ('Waiting for ' + S.dmCallPartner.username + '…') : 'Waiting for answer…';
            } else if (!S.dmCallAnswered && S.dmCallActive) {
                name.textContent = S.dmCallPartner ? ('Calling ' + S.dmCallPartner.username + '…') : 'Calling…';
            } else {
                name.textContent = S.dmCallPartner ? ('In call with ' + S.dmCallPartner.username) : 'In call';
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
        bindClick(m, 'dm-mini-bar-end', function () { endDmCall(); });
        bindClick(m, 'dm-mini-bar-mute', function () { toggleMute(); });
        bindClick(m, 'dm-mini-bar-deafen', function () { toggleDeafen(); });
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
        if (name) name.textContent = call.callerUsername + ' is calling…';
        var acceptBtn = el('incoming-call-accept');
        if (acceptBtn) acceptBtn.textContent = 'Accept';
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
    // UI: volume menu (right-click)
    // ------------------------------------------------------------------
    function openVolumeMenu(e, uid) {
        var menu = el('volume-menu');
        if (!menu) return;
        var member = S.members[uid];
        var name = member ? member.username : 'Member';
        var selfId = getSelfId();

        menu.innerHTML = '';
        var header = document.createElement('div');
        header.className = 'volume-menu-header';
        header.textContent = name;
        menu.appendChild(header);

        var sliderRow = document.createElement('div');
        sliderRow.className = 'volume-menu-slider-row';
        var slider = document.createElement('input');
        slider.type = 'range';
        slider.min = 0;
        slider.max = 500;
        slider.value = localStorage.getItem('voice_volume_' + uid) || '100';
        slider.className = 'volume-menu-slider';
        var val = document.createElement('span');
        val.id = 'volume-menu-value';
        val.className = 'volume-menu-value';
        val.textContent = slider.value + '%';
        slider.addEventListener('input', function () {
            setMemberVolume(uid, parseInt(slider.value, 10));
        });
        sliderRow.appendChild(slider);
        sliderRow.appendChild(val);
        menu.appendChild(sliderRow);

        // Owner controls — only for the server owner, server rooms, other members
        if (S.roomType === 'server' && S.isOwner && uid !== selfId) {
            var m = S.members[uid];
            var row1 = document.createElement('button');
            row1.className = 'volume-menu-btn';
            row1.textContent = m.force_muted ? '🔓 Unmute' : '🔇 Server Mute';
            row1.addEventListener('click', function () { ownerControl(m.force_muted ? 'unmute' : 'mute', uid); closeVolumeMenu(); });
            menu.appendChild(row1);
            var row2 = document.createElement('button');
            row2.className = 'volume-menu-btn';
            row2.textContent = m.force_deafened ? '🔓 Undeafen' : '🔈 Server Deafen';
            row2.addEventListener('click', function () { ownerControl(m.force_deafened ? 'undeafen' : 'deafen', uid); closeVolumeMenu(); });
            menu.appendChild(row2);
            var row3 = document.createElement('button');
            row3.className = 'volume-menu-btn danger';
            row3.textContent = '👢 Kick';
            row3.addEventListener('click', function () { ownerControl('kick', uid); closeVolumeMenu(); });
            menu.appendChild(row3);
        }

        menu.style.display = 'block';
        var x = Math.min(e.clientX, window.innerWidth - 220);
        var y = Math.min(e.clientY, window.innerHeight - 260);
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';

        setTimeout(function () {
            document.addEventListener('click', closeVolumeMenuOnce, { once: true });
        }, 10);
    }

    function closeVolumeMenuOnce() { closeVolumeMenu(); }

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
            b.textContent = S.muted ? '🔇' : '🎤';
            b.classList.toggle('active', S.muted);
            b.classList.toggle('locked', S.forceMuted);
        });
        ['voice-bar-deafen', 'voice-popup-deafen', 'dm-call-deafen', 'dm-mini-bar-deafen'].forEach(function (id) {
            var b = el(id);
            if (!b) return;
            b.textContent = S.deafened ? '🙉' : '🔈';
            b.classList.toggle('active', S.deafened);
            b.classList.toggle('locked', S.forceDeafened);
        });
        ['voice-bar-camera', 'voice-popup-camera', 'dm-call-camera'].forEach(function (id) {
            var b = el(id);
            if (!b) return;
            b.classList.toggle('active', S.cameraOn);
        });
        ['voice-bar-screen', 'voice-popup-screen', 'dm-call-screen'].forEach(function (id) {
            var b = el(id);
            if (!b) return;
            b.classList.toggle('active', S.screenOn);
        });
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
                if (m.force_muted) badges += '<span class="vc-badge locked" title="Server muted">🔒🔇</span>';
                else if (m.muted) badges += '<span class="vc-badge" title="Muted">🔇</span>';
                if (m.force_deafened) badges += '<span class="vc-badge locked" title="Server deafened">🔒🔈</span>';
                else if (m.deafened) badges += '<span class="vc-badge" title="Deafened">🔈</span>';
                if (m.camera) badges += '<span class="vc-badge" title="Camera">📷</span>';
                if (m.screen) badges += '<span class="vc-badge" title="Screen">🖥️</span>';

                html += '<div class="voice-chip-row' + (speaking ? ' speaking' : '') + '" data-uid="' + esc(m.user_id) + '" title="' + esc(title) + '">' +
                    avatar +
                    '<span class="voice-chip-name">' + esc(name) + '</span>' +
                    (badges ? '<span class="voice-chip-badges">' + badges + '</span>' : '') +
                    '</div>';
            });
            chipWrap.innerHTML = html;
        });
    }

    // ------------------------------------------------------------------
    // Settings helpers
    // ------------------------------------------------------------------
    function setMicVolume(v) {
        S.settings.micVolume = v;
        saveSettings();
        if (S.micGain) S.micGain.gain.value = v / 100;
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
    }

    function setNoiseSuppression(mode) {
        S.settings.noiseSuppressionMode = mode;
        saveSettings();
        updateSettingsLabels();
        restartMicForSettings();
    }

    function setEchoCancellation(enabled) {
        S.settings.echoCancellation = !!enabled;
        saveSettings();
        updateSettingsLabels();
        restartMicForSettings();
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
    // div as the fullscreen element, no controls appear. The wrapper is
    // removed on exit and the tiles re-render (fresh srcObject re-attached),
    // which also unfreezes the frame Chrome detaches after fullscreen.
    function toggleFullscreen(el) {
        if (!el) return;
        var activeWrap = el.closest ? el.closest('.voice-fs-wrap') : null;
        if (activeWrap) {
            // Already fullscreened — restore the tile to its original slot.
            restoreFromFsWrap(activeWrap, el);
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(function () {});
            }
            return;
        }
        if (document.fullscreenElement && !document.querySelector('.voice-fs-wrap')) {
            // Something else is fullscreened — leave it alone.
            return;
        }
        // Remember where the element lives so it can be restored exactly — the
        // old code relied on fullscreenchange alone, which never fires when the
        // browser declines/stubs the request (embedded contexts, tests), leaving
        // the <video> stuck in the black wrapper forever.
        var origParent = el.parentNode;
        var origNext = el.nextSibling;
        var wrap = document.createElement('div');
        wrap.className = 'voice-fs-wrap';
        wrap.appendChild(el);
        document.body.appendChild(wrap);
        var restored = false;
        var restore = function () {
            if (restored) return;
            restored = true;
            document.removeEventListener('fullscreenchange', handler);
            if (el.parentNode === wrap) {
                if (origNext && origNext.parentNode === origParent) {
                    origParent.insertBefore(el, origNext);
                } else {
                    origParent.appendChild(el);
                }
            }
            if (wrap.parentNode) wrap.remove();
            renderPopup();
            renderDmPanel();
            renderSelfPreview();
        };
        // Register BEFORE requestFullscreen: fullscreenchange also fires when
        // ENTERING fullscreen, so only restore when it is genuinely not active.
        var handler = function () {
            if (!document.fullscreenElement) restore();
        };
        document.addEventListener('fullscreenchange', handler);
        wrap.requestFullscreen().then(function () {
            // The promise resolved but the browser may still not have entered
            // fullscreen (denied/stubbed). If so, put the tile back — otherwise
            // the video stays frozen in the wrapper ("fullscreen stuck" bug).
            setTimeout(function () {
                if (!document.fullscreenElement) restore();
            }, 400);
        }).catch(function () {
            restore();
        });
    }

    // Restore a <video> that lives inside a .voice-fs-wrap back into the
    // member row / tile slot it was lifted from.
    function restoreFromFsWrap(wrap, el) {
        if (wrap.parentNode) wrap.remove();
        renderPopup();
        renderDmPanel();
        renderSelfPreview();
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
    VoiceManager.refreshChannelChips = updateChannelChips;
})();
