// =====================================================================
// voice.js — Voice channels & DM calls (WebRTC mesh + E2EE)
//
// Transport: WebRTC mesh — every participant connects P2P to every other
// participant. The Rust server only relays signaling (SDP/ICE) over the
// existing WebSocket and tracks room membership + owner sanctions.
// WebRTC audio keeps playing in background tabs (unlike WebSocket +
// AudioContext PCM which browsers suspend) — this is how Discord works.
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
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ],
        turnConfigured: false,  // true once the server's TURN config is applied
        audioCtx: null,
        masterGain: null,
        micGain: null,
        memberGains: {},         // uid -> GainNode
        analyser: null,
        speakingInterval: null,
        speaking: false,
        muted: false,
        deafened: false,
        cameraOn: false,
        screenOn: false,
        popupOpen: false,        // voice popup covering the text area
        dmPanelOpen: false,      // DM call panel in the DM chat
        incomingCall: null,      // {callerId, callerUsername, dmChannelId}
        dmCallActive: false,     // we're in a DM call (ringing/connected)
        dmCallPartner: null,     // {id, username}
        settings: {
            micVolume: 100,
            speakerVolume: 100,
            noiseSuppression: true,
        },
        _viewLast: '',
        _lastSpeakSent: 0,
        _viewPoll: null,
        _pfpLoading: {},           // picKey -> true (in-flight PFP fetch guard)
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
        joinServerVoice: joinServerVoice,
        leaveVoice: leaveVoice,
        toggleMute: toggleMute,
        toggleDeafen: toggleDeafen,
        toggleCamera: toggleCamera,
        toggleScreen: toggleScreen,
        setMicVolume: setMicVolume,
        setSpeakerVolume: setSpeakerVolume,
        setNoiseSuppression: setNoiseSuppression,
        setMemberVolume: setMemberVolume,
        ownerControl: ownerControl,
        startDmCall: startDmCall,
        acceptDmCall: acceptDmCall,
        declineDmCall: declineDmCall,
        endDmCall: endDmCall,
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
        applySettingsToUI();
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
        if (ns) ns.checked = S.settings.noiseSuppression;
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
                if (!otherPub && S.dmCallPartner && S.dmCallPartner.id) {
                    // Fall back to an async fetch path handled elsewhere
                }
                if (!otherPub) return null;
                var dmKey = E2ECrypto.getDmKey(S.dmChannelId, kp.privateKey, otherPub);
                hex = E2ECrypto.hmacHex(E2ECrypto.arrayBufferToBase64(dmKey), 'voice:' + S.dmChannelId);
            }
            var bytes = hexToBytes(hex);
            var b64 = E2ECrypto.arrayBufferToBase64(bytes.buffer);
            S.roomKeyB64 = b64;
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
            try { e2eeWorker = new Worker('/e2ee-worker.js'); } catch (_) {}
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
            if (wasDm) {
                // Notify the other side the call ended
                if (S.dmChannelId) send({ type: 'dm_call_end', dm_channel_id: S.dmChannelId });
            }
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
        S.muted = false;
        S.deafened = false;
        S.cameraOn = false;
        S.screenOn = false;
        S.speaking = false;
        S.dmCallActive = false;
        S.dmCallPartner = null;
        closeAllPeers();
        stopLocalMedia();
        stopSpeakingDetection();
        renderBar();
        renderPopup();
        renderDmPanel();
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
        for (var uid2 in S.memberGains) {
            try { S.memberGains[uid2].disconnect(); } catch (_) {}
        }
        S.memberGains = {};
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
    function startMic() {
        if (S.localStreams.mic || S.deafened) return Promise.resolve();
        var constraints = {
            audio: {
                echoCancellation: true,
                noiseSuppression: S.settings.noiseSuppression,
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
            addLocalTracksToAllPeers();
            return stream;
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
        if (S.localStreams.mic) {
            S.localStreams.mic.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
            S.localStreams.mic = null;
            removeTrackFromAllPeers('audio');
        }
        stopSpeakingDetection();
    }

    function startCamera() {
        if (S.localStreams.camera) return Promise.resolve();
        return navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false })
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
        return navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false })
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
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                // Attempt a restart so calls recover from transient network blips
                if (S.connected && pc.signalingState !== 'closed') {
                    try { pc.restartIce(); } catch (_) {}
                }
            }
        };
        pc.ontrack = function (e) {
            handleRemoteTrack(uid, e);
        };
        pc.onnegotiationneeded = function () {
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
            }).catch(function (err) {
                console.warn('Offer failed:', err);
            });
        };

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
            var at = S.localStreams.mic.getAudioTracks()[0];
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
        }
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

    function handleRemoteTrack(uid, e) {
        if (e.track.kind === 'audio') {
            S.remoteStreams[uid] = S.remoteStreams[uid] || {};
            S.remoteStreams[uid].audio = new MediaStream([e.track]);
            playRemoteAudio(uid);
            // E2EE on the receiver
            ensureE2eeWorker();
            if (window.RTCRtpScriptTransform && e2eeWorker && S.roomKeyB64) {
                try { e.receiver.transform = new RTCRtpScriptTransform(e2eeWorker, { operation: 'decrypt', key: S.roomKeyB64 }); } catch (_) {}
            }
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
            if (window.RTCRtpScriptTransform && e2eeWorker && S.roomKeyB64) {
                try { e.receiver.transform = new RTCRtpScriptTransform(e2eeWorker, { operation: 'decrypt', key: S.roomKeyB64 }); } catch (_) {}
            }
            renderRemoteTile(uid, key);
            renderPopup();
            renderDmPanel();
        }
    }

    function playRemoteAudio(uid) {
        ensureAudioCtx();
        if (!S.audioCtx || !S.remoteStreams[uid] || !S.remoteStreams[uid].audio) return;
        try {
            if (S.memberGains[uid]) { try { S.memberGains[uid].disconnect(); } catch (_) {} S.memberGains[uid] = null; }
            var src = S.audioCtx.createMediaStreamSource(S.remoteStreams[uid].audio);
            var gain = S.audioCtx.createGain();
            var saved = parseFloat(localStorage.getItem('voice_volume_' + uid) || '100');
            gain.gain.value = (isNaN(saved) ? 1 : saved / 100) * (S.deafened ? 0 : 1);
            src.connect(gain);
            gain.connect(S.masterGain);
            S.memberGains[uid] = gain;
        } catch (_) {}
    }

    function setMemberVolume(uid, pct) {
        try { localStorage.setItem('voice_volume_' + uid, String(pct)); } catch (_) {}
        if (S.memberGains[uid]) {
            S.memberGains[uid].gain.value = (pct / 100) * (S.deafened ? 0 : 1);
        }
        var label = document.getElementById('volume-menu-value');
        if (label) label.textContent = pct + '%';
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
            pc.setRemoteDescription({ type: 'offer', sdp: sdp }).then(function () {
                addLocalTracks(pc);
                applySendE2EE(pc);
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
        } else if (signal.type === 'answer') {
            pc.setRemoteDescription({ type: 'answer', sdp: sdp }).catch(function (err) {
                console.warn('setRemote( answer ) failed:', err);
            });
        } else if (signal.type === 'ice') {
            if (signal.candidate) {
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
        }
        deriveRoomKey();
        deriveSignalKey();
        ensureE2eeWorker();

        // Set member list
        var newMembers = {};
        (data.members || []).forEach(function (m) { newMembers[m.user_id] = m; });
        S.members = newMembers;

        // Connect to every other member
        var selfId = getSelfId();
        Object.keys(S.members).forEach(function (uid) {
            if (uid !== selfId && !S.peers[uid]) {
                createPeer(uid);
            }
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
        // Open peers for newcomers
        list.forEach(function (m) {
            if (m.user_id !== selfId && !S.peers[m.user_id]) {
                createPeer(m.user_id);
            }
        });
        // Close peers for people who left
        Object.keys(S.peers).forEach(function (uid) {
            if (!newMembers[uid]) {
                try { S.peers[uid].close(); } catch (_) {}
                delete S.peers[uid];
                if (S.memberGains[uid]) { try { S.memberGains[uid].disconnect(); } catch (_) {} delete S.memberGains[uid]; }
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
        var speakingOnly = prev &&
            prev.muted === member.muted &&
            prev.deafened === member.deafened &&
            prev.camera === member.camera &&
            prev.screen === member.screen &&
            prev.force_muted === member.force_muted &&
            prev.force_deafened === member.force_deafened &&
            prev.username === member.username;
        S.members[member.user_id] = member;
        if (member.user_id === getSelfId()) {
            S.forceMuted = !!member.force_muted;
            S.forceDeafened = !!member.force_deafened;
            S.muted = !!member.muted;
            S.deafened = !!member.deafened;
            updateSelfUI();
        }
        if (speakingOnly) {
            // Only the speaking glow changed — toggle classes in place so the
            // camera/screen <video> elements are NOT destroyed and recreated
            // (that made the feeds restart/jitter every time the indicator
            // appeared or disappeared).
            updateSpeakingUI();
        } else {
            renderBar();
            renderPopup();
            renderDmPanel();
        }
        updateChannelChips();
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
        if (S.memberGains[uid]) { try { S.memberGains[uid].disconnect(); } catch (_) {} delete S.memberGains[uid]; }
        delete S.remoteStreams[uid];
        removeRemoteTile(uid);
        renderBar();
        renderPopup();
        renderDmPanel();
        updateChannelChips();
    }

    // A server-wide voice presence snapshot (who is in each voice channel and
    // who is speaking). Sent to ALL server members — participants and
    // non-participants — so the channel list stays live like Discord.
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
                // Pause remote audio if deafened
                Object.keys(S.memberGains).forEach(function (uid) {
                    S.memberGains[uid].gain.value = S.deafened ? 0 : (parseFloat(localStorage.getItem('voice_volume_' + uid) || '100') / 100);
                });
            } else {
                if (!S.muted && !S.deafened) startMic();
                Object.keys(S.memberGains).forEach(function (uid) {
                    S.memberGains[uid].gain.value = (parseFloat(localStorage.getItem('voice_volume_' + uid) || '100') / 100) * (S.deafened ? 0 : 1);
                });
            }
            updateSelfUI();
            renderBar();
            renderPopup();
            renderDmPanel();
            sendVoiceState();
        }
    }

    // ------------------------------------------------------------------
    // DM calls
    // ------------------------------------------------------------------
    function startDmCall(dmChannelId, partnerId, partnerUsername) {
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
        S.popupOpen = false;
        deriveRoomKey();
        deriveSignalKey();
        send({ type: 'voice_join', room_type: 'dm', dm_channel_id: dmChannelId });
        send({ type: 'dm_call_ring', dm_channel_id: dmChannelId });
        playSound('join');
        showToast('Calling ' + (partnerUsername || '…'));
        updateDmCallUI();
    }

    function acceptDmCall() {
        if (!S.incomingCall) return;
        var c = S.incomingCall;
        S.incomingCall = null;
        hideIncomingCall();
        if (S.connected && S.roomType === 'server') {
            leaveVoice();
        }
        S.roomType = 'dm';
        S.dmChannelId = c.dmChannelId;
        S.channelId = null;
        S.serverId = null;
        S.dmCallPartner = { id: c.callerId, username: c.callerUsername };
        S.dmCallActive = true;
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

    function declineDmCall() {
        if (!S.incomingCall) return;
        send({ type: 'dm_call_end', dm_channel_id: S.incomingCall.dmChannelId });
        S.incomingCall = null;
        hideIncomingCall();
        playSound('leave');
    }

    function endDmCall() {
        leaveVoice();
        showToast('Call ended.');
    }

    function handleDmCallRing(data) {
        if (S.dmCallActive || S.connected) {
            // Already busy — let the caller know we can't join
            send({ type: 'dm_call_end', dm_channel_id: data.dm_channel_id });
            return;
        }
        S.incomingCall = { callerId: data.caller_id, callerUsername: data.caller_username, dmChannelId: data.dm_channel_id };
        showIncomingCall(S.incomingCall);
        playSound('ring');
    }

    function handleDmCallEnd(data) {
        if (S.incomingCall && S.incomingCall.dmChannelId === data.dm_channel_id) {
            S.incomingCall = null;
            hideIncomingCall();
            showToast('Call ended.');
            playSound('leave');
        }
        if (S.dmCallActive && S.dmChannelId === data.dm_channel_id) {
            // Other side hung up or the call was cancelled
            var wasConnected = S.connected;
            teardownRoom();
            hideBar();
            hidePopup();
            hideDmPanel();
            hideMiniBar();
            if (wasConnected) playSound('leave');
            showToast('Call ended.');
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
        Object.keys(S.memberGains).forEach(function (uid) {
            var base = parseFloat(localStorage.getItem('voice_volume_' + uid) || '100') / 100;
            S.memberGains[uid].gain.value = S.deafened ? 0 : base;
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
        if (!S.connected) return;
        updateDmCallUI();
        updateBarVisibility();
    }

    // For server rooms: the small bar is hidden while viewing the voice
    // channel itself (the popup covers the text area there instead).
    function updateBarVisibility() {
        if (!S.connected) {
            hideBar();
            return;
        }
        if (S.roomType === 'server') {
            var inVoiceView = typeof currentChannelId !== 'undefined' && S.channelId && currentChannelId === S.channelId;
            if (inVoiceView) {
                // Viewing the voice channel itself → popup covers the text area
                hideBar();
                if (S.popupOpen) showPopup(); else hidePopup();
            } else {
                // Anywhere else → small persistent bar (Discord-style)
                showBar();
            }
        } else {
            // DM call: bar shows only when NOT in the DM chat view
            var inDmView = typeof currentDmChannelId !== 'undefined' && S.dmChannelId && currentDmChannelId === S.dmChannelId;
            if (inDmView) {
                hideBar();
            } else {
                showBar();
            }
        }
    }

    function updateDmCallUI() {
        if (!S.dmCallActive) return;
        var inDmView = typeof currentDmChannelId !== 'undefined' && S.dmChannelId && currentDmChannelId === S.dmChannelId;
        if (inDmView) {
            hideMiniBar();
            showDmPanel();
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
            if (S.roomType === 'server') toggleServerPopup();
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
    // UI: server voice popup (covers the text area)
    // ------------------------------------------------------------------
    function toggleServerPopup() {
        S.popupOpen = !S.popupOpen;
        if (S.popupOpen) showPopup(); else hidePopup();
        updateBarVisibility();
    }

    function showPopup() {
        var pop = el('voice-popup');
        if (!pop) return;
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
        bindClick(pop, 'voice-popup-close', function () { S.popupOpen = false; hidePopup(); updateBarVisibility(); });
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
        if (pns) pns.addEventListener('change', function (e) { setNoiseSuppression(e.target.checked); });

        // Settings-modal sliders (same bindings)
        var smv = document.getElementById('voice-mic-volume');
        if (smv) smv.addEventListener('input', function (e) { setMicVolume(parseInt(e.target.value, 10)); updateSettingsLabels(); });
        var ssv = document.getElementById('voice-speaker-volume');
        if (ssv) ssv.addEventListener('input', function (e) { setSpeakerVolume(parseInt(e.target.value, 10)); updateSettingsLabels(); });
        var sns = document.getElementById('voice-noise-suppression');
        if (sns) sns.addEventListener('change', function (e) { setNoiseSuppression(e.target.checked); });
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
        if (pns) pns.checked = S.settings.noiseSuppression;
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
        // Self first (Discord-style), then everyone else
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
    // UI: DM call panel (covers bottom half of text area)
    // ------------------------------------------------------------------
    function showDmPanel() {
        var p = el('dm-call-panel');
        if (!p) return;
        S.dmPanelOpen = true;
        p.style.display = 'flex';
        var name = el('dm-call-name');
        if (name) name.textContent = S.dmCallPartner ? S.dmCallPartner.username : '…';
        renderDmPanel();
        renderSelfPreview();
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
                openVolumeMenu(e, uid);
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
        m.style.display = 'flex';
        var name = el('dm-mini-bar-name');
        if (name) name.textContent = S.dmCallPartner ? ('In call with ' + S.dmCallPartner.username) : 'In call';
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
        b.style.display = 'flex';
        var name = el('incoming-call-name');
        if (name) name.textContent = call.callerUsername + ' is calling…';
    }

    function hideIncomingCall() {
        var b = el('incoming-call-bar');
        if (b) b.style.display = 'none';
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
            startDmCall(currentDmChannelId, other.id, other.username || other.display_name || '');
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
    // Channel-list members (who is in each voice channel, Discord-style)
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
        if (S.masterGain) S.masterGain.gain.value = v / 100;
    }

    function setNoiseSuppression(on) {
        S.settings.noiseSuppression = on;
        saveSettings();
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
    function toggleFullscreen(el) {
        if (!el) return;
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(function () {});
            return;
        }
        // Fullscreen a WRAPPER div, not the <video> element itself — Chrome
        // shows its native playback controls (play/pause, timeline, volume) on
        // a fullscreened <video> even without the controls attribute. With a
        // plain div as the fullscreen element, no controls appear.
        var wrap = document.createElement('div');
        wrap.className = 'voice-fs-wrap';
        wrap.appendChild(el);
        document.body.appendChild(wrap);
        wrap.requestFullscreen().catch(function () {
            wrap.remove();
        });
        document.addEventListener('fullscreenchange', function handler() {
            document.removeEventListener('fullscreenchange', handler);
            if (document.fullscreenElement) return;
            // Drop the moved element and re-render: fresh tiles get their
            // srcObject re-attached, which also unfreezes the frame that Chrome
            // detaches after fullscreen.
            wrap.remove();
            renderPopup();
            renderDmPanel();
            renderSelfPreview();
        });
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
        // Refresh the server-wide presence so channel-list member rows recover
        // after a socket drop (without waiting for the next channel-list rebuild).
        var sid = (typeof currentServerId !== 'undefined' && currentServerId) || S.serverId;
        if (sid) requestServerPresence(sid);
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
