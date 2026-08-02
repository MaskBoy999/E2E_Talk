/* voice.js v1 — Encrypted voice channels & DM calls.
 *
 * Architecture: the server relays CIPHERTEXT ONLY. Every audio/video frame is
 * encrypted client-side with the room key before it touches the network:
 *   - server voice channels → E2ECrypto.getServerKey(serverId)  (all members hold it)
 *   - DM calls            → E2ECrypto.getDmKey(dmChannelId, ...) (both participants)
 * The relay can never eavesdrop; it only forwards opaque frames and enforces
 * owner sanctions (force mute / force deafen / kick) by dropping frames.
 *
 * Media model:
 *   - Audio: 16 kHz mono 16-bit PCM, 20 ms frames (~320 samples). Capture via
 *     ScriptProcessorNode with a simple decimator from the context rate.
 *   - Video: camera/screen captured to a small canvas → JPEG frames at ~6 fps.
 */
(function () {
    'use strict';

    if (window.VoiceManager) return; // already loaded

    // ---------- settings (localStorage) ----------
    function getSetting(key, def) {
        try {
            var v = localStorage.getItem('voice_' + key);
            return v === null ? def : JSON.parse(v);
        } catch (_) { return def; }
    }
    function setSetting(key, val) {
        try { localStorage.setItem('voice_' + key, JSON.stringify(val)); } catch (_) {}
    }

    var micVolume = getSetting('mic_volume', 100);
    var speakerVolume = getSetting('speaker_volume', 100);
    var noiseSuppression = getSetting('noise_suppression', true);
    // per-member volume: userId -> 0..500
    var memberVolumes = {};
    try { memberVolumes = JSON.parse(localStorage.getItem('voice_member_volumes') || '{}'); } catch (_) {}

    // ---------- state ----------
    var currentRoom = null; // { key, kind: 'server'|'dm', serverId, channelId, dmChannelId, name, otherUserId }
    var members = {};       // userId -> { username, muted, deafened, camera, screen, speaking, force_muted, force_deafened, gain, nextTime, videoUrl }
    var selfState = { muted: false, deafened: false, camera: false, screen: false, speaking: false, forceMuted: false, forceDeafened: false };

    var audioCtx = null;
    var micStream = null;
    var micSource = null;
    var captureNode = null;
    var analyser = null;
    var masterGain = null;
    var speakTimer = null;
    var speakLevel = 0;
    var lastSpeakSent = 0;

    var videoStreams = {};    // kind ('camera'|'screen') -> { stream, canvas, timer, previewEl }
    // (camera + screen share can run at the same time — each kind keeps its own
    //  capture loop so toggling one never stops the other)

    var micStartFailed = false; // getUserMedia denied -> don't retry on every focus/visibilitychange

    var popupOpen = false;    // voice popup (server) open?
    var dmPanelOpen = false;  // dm call panel open?
    var ringingCall = null;   // incoming dm call: { room, dmChannelId, callerUserId, callerUsername }

    // ---------- small helpers ----------
    // chat.js declares `let ws` at top-level: that binding lives in the global
    // LEXICAL scope (NOT on window), so we must reference the bare identifier.
    function wsSend(obj) {
        if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(obj));
            return true;
        }
        return false;
    }
    function escapeHtml(s) {
        var d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }
    function displayNameFor(uid) {
        var c = (typeof userDisplayNameCache !== 'undefined' && userDisplayNameCache[uid]) || {};
        if (c.display_name) return c.display_name;
        var m = members[uid];
        return m ? m.username : (uid === (typeof user !== 'undefined' && user && user.id) ? (user && user.username) : uid);
    }
    function toast(msg) {
        var t = document.createElement('div');
        t.className = 'voice-toast';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 350); }, 2600);
    }

    // Click any video/screen tile to toggle native fullscreen on it.
    function makeFullscreenable(el) {
        if (!el || el.__fsBound) return;
        el.__fsBound = true;
        el.style.cursor = 'zoom-in';
        el.title = 'Click to fullscreen';
        el.addEventListener('click', function (e) {
            e.stopPropagation();
            try {
                if (document.fullscreenElement === el) {
                    // Must call with explicit receiver or `this` is lost
                    // (illegal invocation in strict mode).
                    var exit = document.exitFullscreen || document.webkitExitFullscreen || function () {};
                    exit.call(document).catch(function () {});
                } else {
                    var req = el.requestFullscreen || el.webkitRequestFullscreen || function () {};
                    req.call(el).catch(function () {});
                }
            } catch (_) {}
        });
    }

    // If a video tile is currently fullscreened, destroying it (e.g. a re-render
    // that wipes the member list) makes Chrome keep rendering the detached
    // element — the tile looks frozen when you exit fullscreen. Wrap a container
    // wipe so the fullscreened element is parked in a hidden holder (staying
    // connected keeps the browser's fullscreen session alive), then re-inserted
    // into the freshly built tile afterwards. Returns a restore function, or
    // null when nothing is fullscreened inside `container`.
    function isFullscreenActiveIn(el) {
        var fs = document.fullscreenElement || document.webkitFullscreenElement;
        return !!fs && !!el && (fs === el || (el.contains ? el.contains(fs) : false));
    }
    function preserveFullscreenAcrossWipe(container) {
        var fs = document.fullscreenElement || document.webkitFullscreenElement;
        if (!fs || !container || !container.contains(fs)) return null;
        var holder = document.createElement('div');
        holder.style.display = 'none';
        document.body.appendChild(holder);
        holder.appendChild(fs); // stays connected -> the fullscreen session survives the wipe
        return function () {
            if (!document.contains(fs)) { holder.remove(); return; }
            // If the rebuild already re-attached this element (e.g. a reused
            // self <video> via getSelfVideoEl), leave it where it is.
            if (container.contains(fs)) { holder.remove(); return; }
            var uid = fs.getAttribute('data-uid') || '';
            var stream = fs.getAttribute('data-stream') || '';
            var target = null;
            if (uid && stream) {
                target = container.querySelector('img[data-uid="' + uid + '"][data-stream="' + stream + '"]');
            }
            if (target && target !== fs) target.replaceWith(fs);
            else container.appendChild(fs);
            holder.remove();
        };
    }

    // Watchdog: browsers suspend AudioContexts created/resumed outside a user
    // gesture. While we're in a room, keep trying to resume a suspended context
    // and tell the user why there is no sound (and that clicking fixes it).
    var audioWatchdog = null;
    var audioWarned = false;
    function startAudioWatchdog() {
        stopAudioWatchdog();
        audioWarned = false;
        audioWatchdog = setInterval(function () {
            if (!currentRoom) { stopAudioWatchdog(); return; }
            if (audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume().catch(function () {});
                if (!audioWarned) {
                    audioWarned = true;
                    toast('Sound is paused by the browser — click anywhere in the app to enable audio.');
                }
            } else {
                audioWarned = false;
            }
        }, 2000);
    }
    function stopAudioWatchdog() {
        if (audioWatchdog) { clearInterval(audioWatchdog); audioWatchdog = null; }
    }
    function getUserMediaAudio() {
        return navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: noiseSuppression,
                autoGainControl: true
            }
        });
    }
    function getRoomKey() {
        if (!currentRoom) return null;
        if (currentRoom.kind === 'server') {
            return E2ECrypto.getServerKey(currentRoom.serverId);
        }
        // DM call key
        try {
            var identity = E2ECrypto.getIdentityKeyPair();
            if (!identity) return null;
            var otherPub = null;
            if (currentRoom.otherPubKey) {
                otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(currentRoom.otherPubKey));
            } else {
            var conv = (typeof dmConversations !== 'undefined' ? (dmConversations || []) : []).find(function (c) {
                return c.dm_channel_id === currentRoom.dmChannelId;
            });
                if (conv && conv.other_public_key) {
                    otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(conv.other_public_key));
                }
            }
            if (!otherPub) return null;
            return E2ECrypto.getDmKey(currentRoom.dmChannelId, identity.privateKey, otherPub);
        } catch (_) { return null; }
    }

    // ---------- UI sound effects ----------
    var uiGain = null; // single shared output node for UI beeps
    // Short synthesized beeps for mute/unmute, deafen/undeafen and join/leave
    // call. Played through the shared AudioContext. If the context is suspended
    // (autoplay policy), we schedule the beeps anyway and resume — scheduling on
    // a suspended context is legal and plays once it resumes, and the join
    // sound runs in a microtask after the click, so the resume here is what
    // makes the first join audible.
    function playUiSound(kind) {
        try {
            var ctx = ensureAudioContext();
            if (!ctx) return;
            if (ctx.state === 'suspended') ctx.resume().catch(function () {});
            var notes = {
                join: [[440, 0.08], [660, 0.12]],
                leave: [[660, 0.08], [330, 0.14]],
                mute: [[220, 0.06]],
                unmute: [[440, 0.07]],
                deafen: [[200, 0.05], [160, 0.08]],
                undeafen: [[320, 0.05], [480, 0.08]]
            }[kind];
            if (!notes) return;
            if (!uiGain) {
                uiGain = ctx.createGain();
                uiGain.gain.value = 0.28;
                uiGain.connect(ctx.destination);
            }
            var t = ctx.currentTime;
            notes.forEach(function (n) {
                var osc = ctx.createOscillator();
                var g = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = n[0];
                g.gain.setValueAtTime(0.0001, t);
                g.gain.exponentialRampToValueAtTime(0.9, t + 0.012);
                g.gain.exponentialRampToValueAtTime(0.0001, t + n[1]);
                osc.connect(g);
                g.connect(uiGain);
                osc.start(t);
                osc.stop(t + n[1] + 0.02);
                t += n[1] + 0.04;
            });
        } catch (_) {}
    }

    // ---------- audio capture ----------
    function ensureAudioContext() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            masterGain = audioCtx.createGain();
            masterGain.gain.value = speakerVolume / 100;
            masterGain.connect(audioCtx.destination);
        }
        // Browsers suspend AudioContexts unless created/resumed during a user
        // gesture. The join click happened before the async voice_joined ack, so
        // we must actively resume here or nothing will ever be audible.
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
        return audioCtx;
    }
    // Safety net: any user gesture while in a call resumes a suspended context
    // (covers cases where autoplay policy killed it, e.g. after a page reload
    // with a persisted room or when the join ack arrived too late).
    function armGestureResume() {
        var resumeCtx = function () {
            if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
        };
        ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
            document.addEventListener(ev, resumeCtx, { once: false, passive: true });
        });
    }
    function startCapture() {
        if (!currentRoom) return;
        if (micStartFailed) return;
        ensureAudioContext();
        getUserMediaAudio().then(function (stream) {
            micStartFailed = false;
            micStream = stream;
            micSource = audioCtx.createMediaStreamSource(stream);
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = 1024;
            micSource.connect(analyser);
            var ctxRate = audioCtx.sampleRate;
            var DECIMATE = Math.max(1, Math.round(ctxRate / 16000));
            captureNode = audioCtx.createScriptProcessor(4096, 1, 1);
            var acc = new Int16Array(320); // one 20ms frame @16k
            var accLen = 0;
            var subAcc = 0, subN = 0;
            captureNode.onaudioprocess = function (e) {
                var input = e.inputBuffer.getChannelData(0);
                for (var i = 0; i < input.length; i++) {
                    subAcc += input[i];
                    subN++;
                    if (subN >= DECIMATE) {
                        var s = subAcc / subN;
                        subAcc = 0; subN = 0;
                        if (s > 1) s = 1; else if (s < -1) s = -1;
                        acc[accLen++] = (s * 32767) * (micVolume / 100);
                        if (accLen >= 320) {
                            var frame = new Uint8Array(acc.buffer.slice(0, 640));
                            accLen = 0;
                            sendAudioFrame(frame);
                        }
                    }
                }
            };
            // The ScriptProcessorNode MUST be part of the audio graph or its
            // onaudioprocess callback never fires (audio capture silently dies).
            // Its output buffer is never written, so this connection emits
            // silence — no self-monitoring, no feedback loop. Playback of other
            // members happens separately via handleIncomingAudio → destination.
            captureNode.connect(audioCtx.destination);
            startSpeakDetection();
        }).catch(function (err) {
            console.warn('voice: mic denied', err);
            micStartFailed = true;
            toast('Microphone access denied. Voice joined but you are muted.');
            selfState.muted = true;
            updateSelfUI();
        });
    }

    function sendAudioFrame(frameBytes) {
        if (!currentRoom || selfState.muted || selfState.deafened || selfState.forceMuted || selfState.forceDeafened) return;
        var key = getRoomKey();
        if (!key) return;
        try {
            var enc = E2ECrypto.aeadEncrypt(frameBytes, key);
            wsSend({ type: 'voice_audio', room: currentRoom.key, data: enc.ciphertext, nonce: enc.nonce });
        } catch (err) {
            console.warn('voice: audio encrypt failed', err);
        }
    }

    function startSpeakDetection() {
        if (!analyser || !currentRoom) return;
        var buf = new Uint8Array(analyser.fftSize);
        speakTimer = setInterval(function () {
            if (!analyser) return;
            analyser.getByteTimeDomainData(buf);
            var sum = 0;
            for (var i = 0; i < buf.length; i++) {
                var v = (buf[i] - 128) / 128;
                sum += v * v;
            }
            var rms = Math.sqrt(sum / buf.length);
            var speaking = rms > 0.02 && !selfState.muted && !selfState.deafened;
            if (speaking && !getRoomKey()) {
                // No room key means frames can't be encrypted/sent, so we are NOT
                // actually being heard. Don't light the "you're speaking" ring or
                // broadcast speaking=true — the user was seeing the light on while
                // nobody could hear them.
                speaking = false;
            }
            speakLevel = speaking ? Math.min(100, Math.round(rms * 60)) : 0;
            var now = Date.now();
            if (speaking !== selfState.speaking && now - lastSpeakSent > 120) {
                selfState.speaking = speaking;
                lastSpeakSent = now;
                if (currentRoom) {
                    wsSend({ type: 'voice_state', room: currentRoom.key, muted: selfState.muted, deafened: selfState.deafened, camera: selfState.camera, screen: selfState.screen, speaking: speaking });
                }
            }
        }, 120);
    }

    // ---------- audio playback ----------
    function ensureMemberGain(uid) {
        ensureAudioContext();
        if (members[uid] && members[uid].gain) return members[uid].gain;
        var gain = audioCtx.createGain();
        var vol = memberVolumes[uid] != null ? memberVolumes[uid] : 100;
        gain.gain.value = (vol / 100) * (speakerVolume / 100);
        gain.connect(masterGain);
        if (!members[uid]) members[uid] = {};
        members[uid].gain = gain;
        members[uid].volume = vol;
        return gain;
    }

    function handleIncomingAudio(data, nonce, uid) {
        if (!currentRoom || selfState.deafened || selfState.forceDeafened) return;
        var m = members[uid];
        if (m && (m.deafened || m.force_deafened)) return; // they're deafened → skip (server also drops)
        var key = getRoomKey();
        if (!key) return;
        try {
            var raw = E2ECrypto.aeadDecrypt(data, key, nonce);
            if (!raw || raw.length < 640) return;
            // Int16 -> Float32
            var i16 = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
            var f32 = new Float32Array(i16.length);
            for (var i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
            var gain = ensureMemberGain(uid);
            var buffer = audioCtx.createBuffer(1, f32.length, 16000);
            buffer.copyToChannel(f32, 0);
            var src = audioCtx.createBufferSource();
            src.buffer = buffer;
            src.connect(gain);
            var m2 = members[uid];
            if (!m2) { members[uid] = {}; m2 = members[uid]; }
            if (!m2.nextTime || m2.nextTime < audioCtx.currentTime) m2.nextTime = audioCtx.currentTime + 0.05;
            var dur = f32.length / 16000;
            src.start(m2.nextTime);
            m2.nextTime += dur;
            // drop frames piling up (way behind)
            if (m2.nextTime - audioCtx.currentTime > 0.8) m2.nextTime = audioCtx.currentTime + 0.05;
        } catch (err) {
            // silent
        }
    }

    // ---------- video ----------
    function startVideo(kind) {
        if (!currentRoom) return;
        if (videoStreams[kind] && videoStreams[kind].stream) return; // that kind is already on
        var constraints = kind === 'screen'
            ? { video: true }
            : { video: { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: 'user' } };
        var p = kind === 'screen'
            ? navigator.mediaDevices.getDisplayMedia(constraints)
            : navigator.mediaDevices.getUserMedia({ video: constraints.video });
        p.then(function (stream) {
            var canvas = document.createElement('canvas');
            canvas.width = kind === 'screen' ? 640 : 480;
            canvas.height = kind === 'screen' ? 360 : 270;
            var videoEl = document.createElement('video');
            videoEl.muted = true;
            videoEl.playsInline = true;
            videoEl.srcObject = stream;
            videoEl.play().catch(function () {});
            videoStreams[kind] = { stream: stream, canvas: canvas, timer: null, previewEl: videoEl };
            if (kind === 'screen') selfState.screen = true;
            else selfState.camera = true;
            videoStreams[kind].timer = setInterval(function () {
                var rec = videoStreams[kind];
                if (!rec || !rec.stream || rec.stream.getVideoTracks().length === 0) return;
                if (videoEl.readyState < 2) return;
                var ctx2 = canvas.getContext('2d');
                ctx2.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
                var jpeg;
                try { jpeg = canvas.toDataURL('image/jpeg', 0.45); } catch (_) { return; }
                var key = getRoomKey();
                if (!key) return;
                try {
                    var enc = E2ECrypto.aeadEncrypt(jpeg, key);
                    wsSend({ type: 'voice_video', room: currentRoom.key, stream: kind, data: enc.ciphertext, nonce: enc.nonce });
                } catch (_) {}
            }, 160);
            stream.getVideoTracks()[0].addEventListener('ended', function () {
                stopVideo(kind, true);
            });
            wsSend({ type: 'voice_state', room: currentRoom.key, muted: selfState.muted, deafened: selfState.deafened, camera: selfState.camera, screen: selfState.screen, speaking: selfState.speaking });
            updateSelfUI();
            renderMembers();
            renderLocalVideoPreview();
        }).catch(function (err) {
            console.warn('voice: video denied', err);
            toast(kind === 'screen' ? 'Screen sharing was denied.' : 'Camera access was denied.');
        });
    }

    // Stop one kind of video (camera or screen). Passing no kind stops both.
    function stopVideo(kind, updateRemote) {
        var kinds = kind ? [kind] : Object.keys(videoStreams);
        kinds.forEach(function (k) {
            var rec = videoStreams[k];
            if (!rec) return;
            if (rec.timer) clearInterval(rec.timer);
            if (rec.stream) rec.stream.getTracks().forEach(function (t) { t.stop(); });
            delete videoStreams[k];
            if (k === 'screen') selfState.screen = false;
            else selfState.camera = false;
        });
        if (currentRoom && updateRemote !== false) {
            wsSend({ type: 'voice_state', room: currentRoom.key, muted: selfState.muted, deafened: selfState.deafened, camera: selfState.camera, screen: selfState.screen, speaking: selfState.speaking });
        }
        updateSelfUI();
        renderMembers();
        hideLocalVideoPreview();
    }

    function handleIncomingVideo(data, nonce, uid, stream) {
        if (!currentRoom) return;
        var key = getRoomKey();
        if (!key) return;
        try {
            var raw = E2ECrypto.aeadDecrypt(data, key, nonce);
            if (!raw) return;
            var url = new TextDecoder().decode(raw);
            var m = members[uid];
            if (!m) { members[uid] = {}; m = members[uid]; }
            if (stream === 'screen') {
                if (!m.screen) return; // stale frame after they stopped sharing
                m.screenUrl = url;
            } else {
                if (!m.camera) return; // stale frame after they stopped camera
                m.videoUrl = url;
            }
            updateVideoTile(uid);
        } catch (_) {}
    }

    // DM calls encrypt with an ECDH-derived per-channel key. If it can't be
    // derived at join time (the other user's identity public key missing from the
    // conversation list), audio frames are silently dropped in BOTH directions —
    // the classic "can talk in server rooms but not in DM calls" symptom. Retry
    // fetching the other user's identity key and warn instead of failing silently.
    // NOTE: this only heals a missing OTHER-user key. If the LOCAL identity
    // keypair is missing (fresh device before key-blob restore), the fetch
    // succeeds but getRoomKey() still fails — the toast then accurately reports
    // that audio is disabled (identity provisioning is a separate flow).
    function healDmRoomKey() {
        if (!currentRoom || currentRoom.kind !== 'dm' || !currentRoom.otherUserId) return;
        if (getRoomKey()) return; // already derivable
        var tries = 0;
        var attempt = function () {
            if (!currentRoom || currentRoom.kind !== 'dm') return;
            if (getRoomKey()) return; // healed
            if (tries >= 3) {
                toast('Call encryption key unavailable — audio is disabled in this call.');
                return;
            }
            tries++;
            var url = '/api/identity/' + encodeURIComponent(currentRoom.otherUserId);
            var p = (typeof authFetch !== 'undefined')
                ? authFetch(url)
                : fetch(url, { headers: { 'Authorization': 'Bearer ' + (typeof token !== 'undefined' ? token() : (localStorage.getItem('token') || '')) } });
            p.then(function (r) { return r.ok ? r.json() : null; })
                .then(function (d) {
                    if (!currentRoom || currentRoom.kind !== 'dm') return;
                    if (d && d.identity_public_key) {
                        currentRoom.otherPubKey = d.identity_public_key;
                        if (!getRoomKey() && tries < 3) setTimeout(attempt, 1500);
                        else if (!getRoomKey()) toast('Call encryption key unavailable — audio is disabled in this call.');
                    } else if (tries < 3) {
                        setTimeout(attempt, 1500);
                    } else {
                        toast('Call encryption key unavailable — audio is disabled in this call.');
                    }
                })
                .catch(function () {
                    if (tries < 3) setTimeout(attempt, 1500);
                    else toast('Call encryption key unavailable — audio is disabled in this call.');
                });
        };
        attempt();
    }

    // ---------- join / leave ----------
    async function joinServerVoice(serverId, channelId, channelName) {
        var key = 'server:' + serverId + ':' + channelId;
        if (currentRoom && currentRoom.key === key && currentRoom.kind === 'server') {
            // already in — toggle popup
            toggleServerPopup();
            return;
        }
        // leave any current room
        await leaveRoom(false);
        currentRoom = { key: key, kind: 'server', serverId: serverId, channelId: channelId, name: channelName };
        wsSend({ type: 'voice_join', room: key, kind: 'server', server_id: serverId, channel_id: channelId });
        showServerVoiceBar();
        playUiSound('join');
    }

    async function startDmCall(dmChannelId, otherUser) {
        if (!otherUser) return;
        var key = 'dm:' + dmChannelId;
        if (currentRoom && currentRoom.key === key && currentRoom.kind === 'dm') return;
        await leaveRoom(false);
        currentRoom = { key: key, kind: 'dm', dmChannelId: dmChannelId, name: otherUser.username || otherUser.display_name || 'Call', otherUserId: otherUser.id, otherUsername: otherUser.username };
        // resolve other user's identity public key for the DM key
        try {
            var conv = (typeof dmConversations !== 'undefined' ? (dmConversations || []) : []).find(function (c) { return c.dm_channel_id === dmChannelId; });
            if (conv && conv.other_public_key) currentRoom.otherPubKey = conv.other_public_key;
            else if (currentRoom.otherUserId) {
                var idRes = await (typeof authFetch !== 'undefined' ? authFetch('/api/identity/' + encodeURIComponent(currentRoom.otherUserId)) : fetch('/api/identity/' + encodeURIComponent(currentRoom.otherUserId), { headers: { 'Authorization': 'Bearer ' + (typeof token !== 'undefined' ? token() : (localStorage.getItem('token') || '')) } }));
                if (idRes.ok) {
                    var idData = await idRes.json();
                    if (idData.identity_public_key) currentRoom.otherPubKey = idData.identity_public_key;
                }
            }
        } catch (_) {}
        wsSend({ type: 'voice_join', room: key, kind: 'dm', dm_channel_id: dmChannelId });
        showDmCallBar();
        playUiSound('join');
    }

    async function leaveRoom(sendLeave) {
        if (!currentRoom) return;
        stopAudioWatchdog();
        playUiSound('leave');
        stopCapture();
        stopVideo(false);
        if (sendLeave !== false) {
            wsSend({ type: 'voice_leave', room: currentRoom.key });
        }
        currentRoom = null;
        members = {};
        ringingCall = null;
        hideServerVoiceBar();
        hideDmCallBar();
        closePopup();
        closeDmPanel();
        hideMiniBar();
        hideRingBar();
        renderMembers();
        clearMemberChips();
    }

    function stopCapture() {
        if (speakTimer) { clearInterval(speakTimer); speakTimer = null; }
        if (captureNode) { try { captureNode.disconnect(); } catch (_) {} captureNode = null; }
        if (micSource) { try { micSource.disconnect(); } catch (_) {} micSource = null; }
        if (micStream) { micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; }
        analyser = null;
        selfState.muted = false;
        selfState.deafened = false;
        selfState.speaking = false;
        selfState.camera = false;
        selfState.screen = false;
        selfState.forceMuted = false;
        selfState.forceDeafened = false;
    }

    // ---------- self controls ----------
    function setSelfMuted(muted) {
        selfState.muted = muted;
        playUiSound(muted ? 'mute' : 'unmute');
        if (currentRoom) wsSend({ type: 'voice_state', room: currentRoom.key, muted: muted, deafened: selfState.deafened, camera: selfState.camera, screen: selfState.screen, speaking: false });
        updateSelfUI();
    }
    function setSelfDeafened(deafened) {
        selfState.deafened = deafened;
        playUiSound(deafened ? 'deafen' : 'undeafen');
        if (currentRoom) wsSend({ type: 'voice_state', room: currentRoom.key, muted: selfState.muted, deafened: deafened, camera: selfState.camera, screen: selfState.screen, speaking: false });
        updateSelfUI();
    }
    function toggleCamera() {
        if (selfState.camera) stopVideo('camera', true);
        else startVideo('camera');
    }
    function toggleScreen() {
        if (selfState.screen) stopVideo('screen', true);
        else startVideo('screen');
    }

    // ---------- server message routing ----------
    function handleServerMessage(data) {
        switch (data.type) {
            case 'voice_joined': {
                if (!currentRoom || data.room !== currentRoom.key) return;
                members = {};
                (data.members || []).forEach(function (m) { members[m.user_id] = m; });
                selfState.forceMuted = !!data.force_muted;
                selfState.forceDeafened = !!data.force_deafened;
                selfState.muted = !!data.muted;
                selfState.deafened = !!data.deafened;
                if (selfState.forceMuted) selfState.muted = true;
                if (selfState.forceDeafened) { selfState.deafened = true; selfState.muted = true; }
                if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
                micStartFailed = false; // fresh join -> allow a new mic attempt
                if (!micStream && !selfState.deafened) startCapture();
                renderMembers();
                renderChannelChips();
                startAudioWatchdog();
                // DM calls must have the ECDH room key; try to heal it if missing.
                if (currentRoom.kind === 'dm' && !getRoomKey()) {
                    healDmRoomKey();
                }
                if (currentRoom.kind === 'dm') { openDmPanelIfRelevant(); showDmCallBar(); }
                else { showServerVoiceBar(); }
                break;
            }
            case 'voice_members': {
                if (!currentRoom || data.room !== currentRoom.key) return;
                (data.members || []).forEach(function (m) {
                    var prev = members[m.user_id];
                    members[m.user_id] = m;
                    // keep gain node when present
                    if (prev && prev.gain) m.gain = prev.gain;
                    if (prev && prev.nextTime) m.nextTime = prev.nextTime;
                    // Only carry over video frames if that stream is still on
                    // (a member who just turned camera/screen off must not keep
                    // their stale last frame).
                    if (prev && prev.videoUrl && m.camera) { m.videoUrl = prev.videoUrl; }
                    if (prev && prev.screenUrl && m.screen) { m.screenUrl = prev.screenUrl; }
                    var myId = typeof user !== 'undefined' && user ? user.id : null;
                    if (m.user_id === myId) {
                        var wasDeafened = selfState.deafened;
                        selfState.forceMuted = !!m.force_muted;
                        selfState.forceDeafened = !!m.force_deafened;
                        selfState.muted = !!m.muted;
                        selfState.deafened = !!m.deafened;
                        if (selfState.forceMuted) selfState.muted = true;
                        if (selfState.forceDeafened) { selfState.deafened = true; selfState.muted = true; }
                        // The owner lifted a force-deafen → restart the mic so the
                        // user can talk again (it was skipped while deafened).
                        if (wasDeafened && !selfState.deafened && !micStream && currentRoom) {
                            startCapture();
                        }
                        if (!wasDeafened && selfState.forceDeafened) {
                            toast('The owner deafened you — you can\'t hear until they lift it.');
                        } else if (wasDeafened && !selfState.forceDeafened) {
                            toast('The owner lifted the deafen — you can hear again.');
                        }
                    }
                });
                // remove members no longer present
                var seen = {};
                (data.members || []).forEach(function (m) { seen[m.user_id] = 1; });
                Object.keys(members).forEach(function (uid) {
                    if (!seen[uid] && uid !== user.id) {
                        if (members[uid].gain) { try { members[uid].gain.disconnect(); } catch (_) {} }
                        delete members[uid];
                    }
                });
                renderMembers();
                renderChannelChips();
                updateSelfUI();
                break;
            }
            case 'voice_audio': {
                if (!currentRoom || data.room !== currentRoom.key) return;
                handleIncomingAudio(data.data, data.nonce, data.user_id);
                break;
            }
            case 'voice_video': {
                if (!currentRoom || data.room !== currentRoom.key) return;
                handleIncomingVideo(data.data, data.nonce, data.user_id, data.stream);
                break;
            }
            case 'voice_state': {
                if (!currentRoom || data.room !== currentRoom.key) return;
                if (!members[data.user_id]) members[data.user_id] = {};
                members[data.user_id].muted = !!data.muted;
                members[data.user_id].deafened = !!data.deafened;
                members[data.user_id].camera = !!data.camera;
                members[data.user_id].screen = !!data.screen;
                members[data.user_id].speaking = !!data.speaking;
                // The server relays force flags on every voice_state broadcast, so
                // keep them on the member record too (updateMemberState reads them
                // to render the correct mute/deafen icon).
                members[data.user_id].force_muted = !!data.force_muted;
                members[data.user_id].force_deafened = !!data.force_deafened;
                // Camera/screen turned off → drop the stale last frame so it can't
                // linger in the tile ("last frame stuck" bug).
                if (!data.camera) delete members[data.user_id].videoUrl;
                if (!data.screen) delete members[data.user_id].screenUrl;
                var myId = typeof user !== 'undefined' && user ? user.id : null;
                if (data.user_id === myId) {
                    selfState.forceMuted = !!data.force_muted;
                    selfState.forceDeafened = !!data.force_deafened;
                    selfState.muted = !!data.muted;
                    selfState.deafened = !!data.deafened;
                    if (selfState.forceMuted) selfState.muted = true;
                    if (selfState.forceDeafened) { selfState.deafened = true; selfState.muted = true; }
                    // If we were deafened and the owner released us (or we
                    // undeafened ourselves), make sure capture is running again.
                    if (!selfState.deafened && !micStream && currentRoom) {
                        startCapture();
                    }
                    updateSelfUI(); // reflect owner lock on our own bar/popup buttons
                }
                // Patch just the affected row — a full re-render on every speaking
                // toggle restarted the camera and swapped owner buttons mid-click.
                updateMemberState(data.user_id);
                updateSpeakingRing(data.user_id);
                break;
            }
            case 'voice_kicked': {
                if (!currentRoom || data.room !== currentRoom.key) return;
                toast('You were kicked from the voice channel by the owner.');
                leaveRoom(true);
                break;
            }
            case 'dm_call_ring': {
                // Incoming DM call — show it even though we haven't joined yet.
                if (currentRoom && currentRoom.key === data.room) return;
                ringingCall = {
                    room: data.room,
                    dmChannelId: data.dm_channel_id,
                    callerUserId: data.caller_user_id,
                    callerUsername: data.caller_username || 'Someone',
                };
                showRingBar();
                break;
            }
            case 'dm_call_end': {
                if (ringingCall && ringingCall.room === data.room) {
                    ringingCall = null;
                    hideRingBar();
                }
                break;
            }
            default: break;
        }
    }

    function isVoiceMessage(type) {
        return typeof type === 'string' && (type.indexOf('voice_') === 0 || type.indexOf('dm_call_') === 0);
    }

    // ---------- UI: channel list chips (Discord-style) ----------
    function ensureChipContainer(channelId) {
        var el = document.querySelector('.channel-item[data-id="' + channelId + '"] .voice-member-chips');
        if (!el) {
            var ch = document.querySelector('.channel-item[data-id="' + channelId + '"]');
            if (!ch) return null;
            el = document.createElement('div');
            el.className = 'voice-member-chips';
            ch.appendChild(el);
        }
        return el;
    }

    function renderChannelChips() {
        if (!currentRoom || currentRoom.kind !== 'server') return;
        var chips = ensureChipContainer(currentRoom.channelId);
        if (!chips) return;
        chips.innerHTML = '';
        Object.keys(members).forEach(function (uid) {
            if (uid === user.id) return; // self shown in bar, not chips
            var m = members[uid];
            var chip = document.createElement('div');
            chip.className = 'voice-chip' + (m.speaking ? ' speaking' : '');
            chip.textContent = (m.deafened || m.force_deafened ? '🔇' : (m.muted || m.force_muted ? '🎤' : '🔊')) + ((m.force_muted || m.force_deafened) ? '🔒' : '') + ' ' + (m.username || uid);
            chip.title = (m.username || uid);
            chips.appendChild(chip);
        });
    }

    function clearMemberChips() {
        document.querySelectorAll('.voice-member-chips').forEach(function (el) { el.remove(); });
    }

    // ---------- UI: member list ----------
    // Reuse the existing self-video element across re-renders so the camera
    // preview never restarts (a rebuilt <video> flashes black and makes the
    // whole member list look like it is reloading).
    function getSelfVideoEl(kind, existing, forDm) {
        var rec = videoStreams[kind];
        if (!rec || !rec.stream || rec.stream.getVideoTracks().length === 0) return null;
        if (existing && existing.srcObject === rec.stream) {
            makeFullscreenable(existing);
            return existing;
        }
        var vd = document.createElement('video');
        vd.muted = true; vd.playsInline = true; vd.autoplay = true;
        vd.srcObject = rec.stream;
        makeFullscreenable(vd);
        if (!forDm) vd.className = kind === 'camera' ? 'voice-self-video' : 'voice-self-screen';
        return vd;
    }

    // In-place update of a single member row on voice_state churn (speaking
    // toggles, mute/deafen/camera changes). Rebuilding the whole list on every
    // state change destroyed the self camera and replaced the owner buttons
    // mid-click, which made them unreliable.
    function updateMemberState(uid) {
        var m = members[uid];
        if (!m) return;
        var myId = typeof user !== 'undefined' && user ? user.id : null;
        var list = document.getElementById('voice-popup-members');
        if (list) {
            var row = list.querySelector('.voice-member-row[data-uid="' + uid + '"]');
            if (!row) { renderMembers(); return; }
            var ic = memberIcon(m);
            var iconEl = row.querySelector('.voice-member-icon');
            if (iconEl) iconEl.textContent = ic;
            row.classList.toggle('speaking', !!m.speaking);
            row.classList.toggle('force-locked', !!(m.force_muted || m.force_deafened));
            if (uid !== myId) {
                updateVideoTile(uid);
                // owner control buttons reflect the current force state
                var ctrl = row.querySelector('.voice-member-owner-controls');
                if (ctrl) {
                    var mb = ctrl.querySelector('[data-a="mute"]');
                    if (mb) { mb.classList.toggle('active', !!m.force_muted); mb.textContent = m.force_muted ? '🔇' : '🎤'; mb.title = m.force_muted ? 'Unmute (forced)' : 'Force mute'; }
                    var db = ctrl.querySelector('[data-a="deafen"]');
                    if (db) { db.classList.toggle('active', !!m.force_deafened); db.textContent = m.force_deafened ? '🔕' : '🔇'; db.title = m.force_deafened ? 'Undeafen (forced)' : 'Force deafen'; }
                }
            }
        }
        // DM call body: patch the other participant's tile in place too
        if (currentRoom && currentRoom.kind === 'dm' && uid === currentRoom.otherUserId) {
            var body = document.getElementById('dm-call-body');
            if (body) {
                var tiles = body.querySelectorAll('.dm-call-tile');
                var otherTile = tiles.length > 1 ? tiles[1] : null;
                if (otherTile) {
                    otherTile.classList.toggle('speaking', !!m.speaking);
                    var nameEl = otherTile.querySelector('.dm-call-tile-name');
                    if (nameEl) {
                        var name = displayNameFor(uid);
                        nameEl.textContent = name + (m.muted ? ' 🎤' : '') + (m.deafened ? ' 🔇' : '');
                    }
                }
            }
        }
        // NOTE: chips are re-rendered by updateSpeakingRing() right after this in
        // the voice_state handler, so don't re-render them here too.
    }

    function memberIcon(m) {
        var ic = m.deafened || m.force_deafened ? '🔇' : (m.muted || m.force_muted ? '🎤' : '🔊');
        if (m.force_muted || m.force_deafened) ic += '🔒';
        if (m.camera) ic += ' 📷';
        if (m.screen) ic += ' 🖥️';
        return ic;
    }

    function renderMembers() {
        // popup member list
        var list = document.getElementById('voice-popup-members');
        if (list) {
            var prevSelfVideos = {
                camera: list.querySelector('.voice-self-video'),
                screen: list.querySelector('.voice-self-screen')
            };
            // If the user is fullscreening one of the tiles inside this list, we
            // must NOT destroy it (the browser would keep rendering the detached
            // element and freeze it on exit). Park it aside, wipe, then re-insert.
            var fsRestore = preserveFullscreenAcrossWipe(list);
            list.innerHTML = '';
            if (!currentRoom) { list.innerHTML = '<div class="voice-popup-empty">Not connected</div>'; }
            else {
                var myId = typeof user !== 'undefined' && user ? user.id : null;
                Object.keys(members).forEach(function (uid) {
                    var m = members[uid];
                    var row = document.createElement('div');
                    var forceLocked = !!(m.force_muted || m.force_deafened);
                    row.className = 'voice-member-row' + (m.speaking ? ' speaking' : '') + (forceLocked ? ' force-locked' : '');
                    row.setAttribute('data-uid', uid);
                    var isOwnerSelf = uid === myId;
                    var name = m.username || uid;
                    var ic = memberIcon(m);
                    row.innerHTML = '<span class="voice-member-icon">' + ic + '</span>' +
                        '<span class="voice-member-name">' + escapeHtml(name) + '</span>' +
                        (isOwnerSelf ? '<span class="voice-member-you">(you)</span>' : '');
                    if (isOwnerSelf && (selfState.camera || selfState.screen)) {
                        // Render our own live camera + screen inline and REUSE the
                        // previous elements so the previews never restart on re-renders.
                        // Camera and screen sit side by side (never a pip overlay).
                        var box = document.createElement('div');
                        box.className = 'voice-self-videos';
                        if (selfState.screen && videoStreams.screen) {
                            var sv = getSelfVideoEl('screen', prevSelfVideos.screen);
                            if (sv) box.appendChild(sv);
                        }
                        if (selfState.camera && videoStreams.camera) {
                            var cv = getSelfVideoEl('camera', prevSelfVideos.camera);
                            if (cv) box.appendChild(cv);
                        }
                        if (box.children.length) row.appendChild(box);
                    }
                    row.addEventListener('contextmenu', function (e) {
                        e.preventDefault();
                        openVolumeMenu(e.clientX, e.clientY, uid);
                    });
                    // owner controls for server rooms
                    if (currentRoom.kind === 'server' && !isOwnerSelf && typeof isOwner !== 'undefined' && isOwner && uid !== currentRoom.otherUserId) {
                        var ctrl = document.createElement('span');
                        ctrl.className = 'voice-member-owner-controls';
                        ctrl.innerHTML =
                            '<button class="voice-owner-btn' + (m.force_muted ? ' active' : '') + '" data-a="mute" title="' + (m.force_muted ? 'Unmute (forced)' : 'Force mute') + '">' + (m.force_muted ? '🔇' : '🎤') + '</button>' +
                            '<button class="voice-owner-btn' + (m.force_deafened ? ' active' : '') + '" data-a="deafen" title="' + (m.force_deafened ? 'Undeafen (forced)' : 'Force deafen') + '">' + (m.force_deafened ? '🔕' : '🔇') + '</button>' +
                            '<button class="voice-owner-btn" data-a="kick" title="Kick">✕</button>';
                        ctrl.addEventListener('click', function (ev) {
                            ev.stopPropagation();
                            var action = ev.target.getAttribute('data-a');
                            if (!action) return;
                            if (action === 'mute') {
                                wsSend({ type: 'voice_control', room: currentRoom.key, action: m.force_muted ? 'unmute' : 'mute', target_user_id: uid });
                            } else if (action === 'deafen') {
                                wsSend({ type: 'voice_control', room: currentRoom.key, action: m.force_deafened ? 'undeafen' : 'deafen', target_user_id: uid });
                            } else if (action === 'kick') {
                                wsSend({ type: 'voice_control', room: currentRoom.key, action: 'kick', target_user_id: uid });
                            }
                        });
                        row.appendChild(ctrl);
                    }
                    // video tile — remote members only. Screen share and camera
                    // are rendered side by side (no pip overlay); click to fullscreen.
                    if (uid !== myId && (m.camera || m.screen)) {
                        var vt = document.createElement('div');
                        vt.className = 'voice-video-tile';
                        if (m.screenUrl) {
                            var si = document.createElement('img');
                            si.className = 'voice-video-screen';
                            si.setAttribute('data-uid', uid);
                            si.setAttribute('data-stream', 'screen');
                            si.src = m.screenUrl;
                            si.alt = '';
                            makeFullscreenable(si);
                            vt.appendChild(si);
                        }
                        if (m.videoUrl) {
                            var ci = document.createElement('img');
                            ci.className = 'voice-video-cam';
                            ci.setAttribute('data-uid', uid);
                            ci.setAttribute('data-stream', 'camera');
                            ci.src = m.videoUrl;
                            ci.alt = '';
                            makeFullscreenable(ci);
                            vt.appendChild(ci);
                        }
                        if (!vt.children.length) {
                            vt.innerHTML = '<span class="voice-video-waiting">video…</span>';
                        }
                        row.appendChild(vt);
                    }
                    list.appendChild(row);
                });
                if (Object.keys(members).length === 0) {
                    list.innerHTML = '<div class="voice-popup-empty">No one else is here yet</div>';
                }
            }
            if (fsRestore) fsRestore();
        }
        // DM call body
        renderDmCallBody();
        // mini bar text
        var mini = document.getElementById('call-mini-text');
        if (mini && currentRoom) mini.textContent = currentRoom.kind === 'dm' ? ('📞 In call with ' + currentRoom.name) : ('🔊 ' + currentRoom.name);
    }

    function renderDmCallBody() {
        var body = document.getElementById('dm-call-body');
        if (!body) return;
        if (!currentRoom || currentRoom.kind !== 'dm') { body.innerHTML = ''; return; }
        var prevSelfCam = body.querySelector('.dm-self-cam');
        var prevSelfScr = body.querySelector('.dm-self-scr');
        var fsRestore = preserveFullscreenAcrossWipe(body);
        body.innerHTML = '';
        // self + other tiles
        var self = document.createElement('div');
        self.className = 'dm-call-tile' + (selfState.speaking ? ' speaking' : '');
        var myName = (typeof user !== 'undefined' && user && user.username) || 'You';
        var hasSelfVid = (selfState.camera && videoStreams.camera) || (selfState.screen && videoStreams.screen);
        self.innerHTML = '<div class="dm-call-tile-name">You' + (selfState.muted ? ' 🎤' : '') + (selfState.deafened ? ' 🔇' : '') + '</div>' +
            (hasSelfVid ? '' : '<div class="dm-call-tile-avatar">' + escapeHtml(myName.charAt(0).toUpperCase()) + '</div>');
        if (hasSelfVid) {
            var sbox = document.createElement('div');
            sbox.className = 'dm-self-videos';
            if (selfState.screen && videoStreams.screen) {
                var sv = getSelfVideoEl('screen', prevSelfScr, true);
                if (sv) { sv.className = 'dm-self-scr dm-call-tile-video'; sbox.appendChild(sv); }
            }
            if (selfState.camera && videoStreams.camera) {
                var cv = getSelfVideoEl('camera', prevSelfCam, true);
                if (cv) { cv.className = 'dm-self-cam dm-call-tile-video'; sbox.appendChild(cv); }
            }
            if (sbox.children.length) self.appendChild(sbox);
        }
        body.appendChild(self);
        var otherId = currentRoom.otherUserId;
        if (otherId && members[otherId]) {
            var m = members[otherId];
            var other = document.createElement('div');
            other.className = 'dm-call-tile' + (m.speaking ? ' speaking' : '');
            var name = displayNameFor(otherId);
            other.innerHTML = '<div class="dm-call-tile-name">' + escapeHtml(name) + (m.muted ? ' 🎤' : '') + (m.deafened ? ' 🔇' : '') + '</div>';
            if (m.screenUrl || m.videoUrl) {
                var ov = document.createElement('div');
                ov.className = 'dm-other-videos';
                if (m.screenUrl) {
                    var oi = document.createElement('img');
                    oi.className = 'dm-call-tile-video';
                    oi.setAttribute('data-uid', otherId);
                    oi.setAttribute('data-stream', 'screen');
                    oi.src = m.screenUrl;
                    oi.alt = '';
                    makeFullscreenable(oi);
                    ov.appendChild(oi);
                }
                if (m.videoUrl) {
                    var oi2 = document.createElement('img');
                    oi2.className = 'dm-call-tile-video';
                    oi2.setAttribute('data-uid', otherId);
                    oi2.setAttribute('data-stream', 'camera');
                    oi2.src = m.videoUrl;
                    oi2.alt = '';
                    makeFullscreenable(oi2);
                    ov.appendChild(oi2);
                }
                other.appendChild(ov);
            } else {
                other.innerHTML += '<div class="dm-call-tile-avatar">' + escapeHtml(name.charAt(0).toUpperCase()) + '</div>';
            }
            other.addEventListener('contextmenu', function (e) { e.preventDefault(); openVolumeMenu(e.clientX, e.clientY, otherId); });
            body.appendChild(other);
        } else {
            body.innerHTML += '<div class="dm-call-waiting">Waiting for the other person to join…</div>';
        }
        if (fsRestore) fsRestore();
    }

    function renderLocalVideoPreview() {
        // Self video is now rendered inline by renderMembers(), so this only
        // cleans up any stale standalone self row left over from older flows.
        var s = document.querySelector('.self-video-row');
        if (s) s.remove();
    }

    function hideLocalVideoPreview() {
        var s = document.querySelector('.self-video-row');
        if (s) s.remove();
    }

    // DM calls render the other participant's video inside #dm-call-body.
    // Updating it IN PLACE per frame (instead of renderMembers() → innerHTML
    // wipe) is essential: a full wipe on every ~160ms frame would destroy a
    // fullscreened tile and freeze it on exit.
    function updateDmVideoTile(uid) {
        var m = members[uid];
        if (!m) return;
        var body = document.getElementById('dm-call-body');
        if (!body) return;
        var tiles = body.querySelectorAll('.dm-call-tile');
        // tile 0 is self, tile 1 is the other participant
        var otherTile = tiles.length > 1 ? tiles[1] : null;
        if (!otherTile) { renderMembers(); return; }
        var ov = otherTile.querySelector('.dm-other-videos');
        var wantTile = m.camera || m.screen;
        if (!wantTile) {
            if (ov && !isFullscreenActiveIn(ov)) ov.remove();
            return;
        }
        if (!ov) {
            ov = document.createElement('div');
            ov.className = 'dm-other-videos';
            otherTile.appendChild(ov);
        }
        var waiting = ov.querySelector('.voice-video-waiting, .dm-video-waiting');
        if (waiting) waiting.remove();
        var screenImg = ov.querySelector('img[data-stream="screen"]');
        var camImg = ov.querySelector('img[data-stream="camera"]');
        if (m.screenUrl) {
            if (!screenImg) {
                screenImg = document.createElement('img');
                screenImg.className = 'dm-video-screen dm-call-tile-video';
                screenImg.setAttribute('data-uid', uid);
                screenImg.setAttribute('data-stream', 'screen');
                makeFullscreenable(screenImg);
                ov.appendChild(screenImg);
            }
            if (screenImg.getAttribute('src') !== m.screenUrl) screenImg.src = m.screenUrl;
        } else if (screenImg && !isFullscreenActiveIn(screenImg)) {
            screenImg.remove();
        }
        if (m.videoUrl) {
            if (!camImg) {
                camImg = document.createElement('img');
                camImg.className = 'dm-video-cam dm-call-tile-video';
                camImg.setAttribute('data-uid', uid);
                camImg.setAttribute('data-stream', 'camera');
                makeFullscreenable(camImg);
                ov.appendChild(camImg);
            }
            if (camImg.getAttribute('src') !== m.videoUrl) camImg.src = m.videoUrl;
        } else if (camImg && !isFullscreenActiveIn(camImg)) {
            camImg.remove();
        }
    }

    function updateVideoTile(uid) {
        // Update just this member's tile in place (cheaper than a full re-render
        // at ~6fps and keeps any in-progress interactions intact).
        var m = members[uid];
        if (!m) return;
        if (currentRoom && currentRoom.kind === 'dm') {
            updateDmVideoTile(uid);
            return;
        }
        var list = document.getElementById('voice-popup-members');
        var found = false;
        if (list) {
            list.querySelectorAll('.voice-member-row').forEach(function (row) {
                if (row.getAttribute('data-uid') !== uid) return;
                found = true;
                var tile = row.querySelector('.voice-video-tile');
                var wantTile = m.camera || m.screen;
                if (!wantTile) {
                    if (tile && !isFullscreenActiveIn(tile)) tile.remove();
                    return;
                }
                if (!tile) {
                    tile = document.createElement('div');
                    tile.className = 'voice-video-tile';
                    row.appendChild(tile);
                }
                // Rebuild content each frame — but ALWAYS replace any stale
                // "video…" waiting span first (it used to stack above the image
                // forever once frames started arriving).
                var waiting = tile.querySelector('.voice-video-waiting');
                if (waiting) waiting.remove();
                // Screen share and camera render SIDE BY SIDE (never a pip
                // overlay). Each frame we add/update/remove whichever imgs the
                // member currently has streaming.
                var screenImg = tile.querySelector('img.voice-video-screen');
                var camImg = tile.querySelector('img.voice-video-cam');
                if (m.screenUrl) {
                    if (!screenImg) {
                        screenImg = document.createElement('img');
                        screenImg.className = 'voice-video-screen';
                        screenImg.setAttribute('data-uid', uid);
                        screenImg.setAttribute('data-stream', 'screen');
                        makeFullscreenable(screenImg);
                        tile.appendChild(screenImg);
                    }
                    if (screenImg.getAttribute('src') !== m.screenUrl) screenImg.src = m.screenUrl;
                } else if (screenImg && !isFullscreenActiveIn(screenImg)) {
                    screenImg.remove();
                }
                if (m.videoUrl) {
                    if (!camImg) {
                        camImg = document.createElement('img');
                        camImg.className = 'voice-video-cam';
                        camImg.setAttribute('data-uid', uid);
                        camImg.setAttribute('data-stream', 'camera');
                        makeFullscreenable(camImg);
                        tile.appendChild(camImg);
                    }
                    if (camImg.getAttribute('src') !== m.videoUrl) camImg.src = m.videoUrl;
                } else if (camImg && !isFullscreenActiveIn(camImg)) {
                    camImg.remove();
                }
                if (!tile.querySelector('img')) {
                    var sp = document.createElement('span');
                    sp.className = 'voice-video-waiting';
                    sp.textContent = 'video…';
                    tile.appendChild(sp);
                }
            });
        }
        if (!found) renderMembers();
    }

    function updateSpeakingRing(uid) {
        // chip
        document.querySelectorAll('.voice-chip').forEach(function (chip) {
            // chips don't carry uid attribute; re-render
        });
        renderChannelChips();
    }

    // ---------- UI: volume menu ----------
    function openVolumeMenu(x, y, uid) {
        var menu = document.getElementById('member-volume-menu');
        if (!menu) return;
        var cur = memberVolumes[uid] != null ? memberVolumes[uid] : 100;
        menu.style.display = 'block';
        menu.style.left = Math.min(x, window.innerWidth - 220) + 'px';
        menu.style.top = Math.min(y, window.innerHeight - 140) + 'px';
        menu.dataset.uid = uid;
        var slider = document.getElementById('member-volume-slider');
        slider.value = cur;
        document.getElementById('member-volume-label').textContent = cur + '%';
        document.getElementById('member-volume-header').textContent = 'Volume — ' + (members[uid] && members[uid].username || uid);
        slider.oninput = function () {
            var v = parseInt(slider.value, 10);
            memberVolumes[uid] = v;
            try { localStorage.setItem('voice_member_volumes', JSON.stringify(memberVolumes)); } catch (_) {}
            document.getElementById('member-volume-label').textContent = v + '%';
            if (members[uid] && members[uid].gain) members[uid].gain.gain.value = (v / 100) * (speakerVolume / 100);
        };
        document.getElementById('member-volume-reset').onclick = function () {
            memberVolumes[uid] = 100;
            try { localStorage.setItem('voice_member_volumes', JSON.stringify(memberVolumes)); } catch (_) {}
            slider.value = 100;
            document.getElementById('member-volume-label').textContent = '100%';
            if (members[uid] && members[uid].gain) members[uid].gain.gain.value = speakerVolume / 100;
        };
    }

    // ---------- UI: bars / popup / panels ----------
    function showServerVoiceBar() {
        var el = document.getElementById('voice-bar');
        if (!el) {
            el = document.createElement('div');
            el.id = 'voice-bar';
            el.className = 'voice-bar';
            el.innerHTML = '<span class="voice-bar-name">🔊 ' + escapeHtml(currentRoom ? currentRoom.name : '') + '</span>' +
                '<button class="voice-bar-btn" id="voice-bar-mute" title="Mute">🎤</button>' +
                '<button class="voice-bar-btn" id="voice-bar-deafen" title="Deafen">🔇</button>' +
                '<button class="voice-bar-btn" id="voice-bar-camera" title="Camera">📷</button>' +
                '<button class="voice-bar-btn" id="voice-bar-screen" title="Share screen">🖥️</button>' +
                '<button class="voice-bar-btn" id="voice-bar-open" title="Open voice panel">☰</button>' +
                '<button class="voice-bar-btn voice-bar-leave" id="voice-bar-leave" title="Leave">📞</button>';
            document.body.appendChild(el);
            bindBarButtons();
        } else {
            // Update the channel name in place — never rebuild the bar's innerHTML
            // (rebuilding replaces the buttons under the user's cursor, making the
            // bar appear "not working").
            var nameEl = el.querySelector('.voice-bar-name');
            if (nameEl && currentRoom) nameEl.textContent = '🔊 ' + currentRoom.name;
        }
        // Respect the popup state (e.g. a WS reconnect while the popup is open
        // must not force the floating bar back over it).
        syncVoiceBarWithPopup();
        updateSelfUI();
    }
    function hideServerVoiceBar() {
        var el = document.getElementById('voice-bar');
        if (el) el.style.display = 'none';
    }
    function bindBarButtons() {
        var btn;
        btn = document.getElementById('voice-bar-mute'); if (btn) btn.onclick = function () { setSelfMuted(!selfState.muted); };
        btn = document.getElementById('voice-bar-deafen'); if (btn) btn.onclick = function () { setSelfDeafened(!selfState.deafened); };
        btn = document.getElementById('voice-bar-camera'); if (btn) btn.onclick = toggleCamera;
        btn = document.getElementById('voice-bar-screen'); if (btn) btn.onclick = toggleScreen;
        btn = document.getElementById('voice-bar-open'); if (btn) btn.onclick = function () { toggleServerPopup(); };
        btn = document.getElementById('voice-bar-leave'); if (btn) btn.onclick = function () { leaveRoom(true); };
    }
    function updateSelfUI() {
        function setState(btnId, active, disabled) {
            var b = document.getElementById(btnId);
            if (!b) return;
            b.classList.toggle('active', !!active);
            b.classList.toggle('disabled', !!disabled);
        }
        setState('voice-bar-mute', selfState.muted || selfState.deafened, selfState.forceMuted);
        setState('voice-bar-deafen', selfState.deafened, selfState.forceDeafened);
        setState('voice-bar-camera', selfState.camera);
        setState('voice-bar-screen', selfState.screen);
        setState('vp-mute-btn', selfState.muted || selfState.deafened, selfState.forceMuted);
        setState('vp-deafen-btn', selfState.deafened, selfState.forceDeafened);
        setState('vp-camera-btn', selfState.camera);
        setState('vp-screen-btn', selfState.screen);
        setState('dm-call-mute-btn', selfState.muted || selfState.deafened, selfState.forceMuted);
        setState('dm-call-deafen-btn', selfState.deafened, selfState.forceDeafened);
        setState('dm-call-camera-btn', selfState.camera);
        setState('dm-call-screen-btn', selfState.screen);
        // victim lock text
        var lock = document.getElementById('voice-popup-title');
        if (lock && currentRoom && (selfState.forceMuted || selfState.forceDeafened)) {
            lock.textContent = '🔊 ' + currentRoom.name + ' — 🔒 owner locked ' + (selfState.forceDeafened ? 'deafen' : 'mute');
        } else if (lock && currentRoom) {
            lock.textContent = '🔊 ' + currentRoom.name;
        }
    }
    // The floating voice bar is only shown while the user is looking at anything
    // OTHER than the voice channel view itself (the popup covers the text area and
    // has its own controls, so the bar would just overlap it).
    function syncVoiceBarWithPopup() {
        var bar = document.getElementById('voice-bar');
        if (!bar) return;
        var shouldShow = currentRoom && currentRoom.kind === 'server' && !popupOpen;
        bar.style.display = shouldShow ? 'flex' : 'none';
    }
    function toggleServerPopup() {
        if (currentRoom && currentRoom.kind !== 'server') return;
        var el = document.getElementById('voice-popup');
        if (!el) return;
        popupOpen = !popupOpen;
        el.style.display = popupOpen ? 'flex' : 'none';
        if (popupOpen) { renderMembers(); renderLocalVideoPreview(); updateSelfUI(); }
        syncVoiceBarWithPopup();
    }
    function closePopup() {
        var el = document.getElementById('voice-popup');
        if (el) el.style.display = 'none';
        popupOpen = false;
        syncVoiceBarWithPopup();
    }

    // DM call panel: half the text area, shown when viewing the DM, hidden (but call stays) elsewhere
    function showDmCallBar() {
        // If the DM is the active view, show the panel; else show the mini bar.
        openDmPanelIfRelevant();
        updateMiniBar();
    }
    function hideDmCallBar() {
        closeDmPanel();
        hideMiniBar();
    }
    function openDmPanelIfRelevant() {
        if (!currentRoom || currentRoom.kind !== 'dm') return;
        var el = document.getElementById('dm-call-panel');
        if (!el) return;
        var relevant = typeof viewMode !== 'undefined' && viewMode === 'dms' && typeof currentDmChannelId !== 'undefined' && currentDmChannelId === currentRoom.dmChannelId;
        dmPanelOpen = relevant;
        el.style.display = relevant ? 'flex' : 'none';
        if (relevant) {
            // Keep the incoming-call accept/decline prompt visible across view
            // switches (renderDmCallBody would wipe it since we're not in the room).
            if (ringingCall && ringingCall.dmChannelId === currentRoom.dmChannelId) {
                showDmJoinPrompt(ringingCall);
            } else {
                renderDmCallBody();
            }
            updateSelfUI();
        }
        updateMiniBar();
    }
    function closeDmPanel() {
        var el = document.getElementById('dm-call-panel');
        if (el) el.style.display = 'none';
        dmPanelOpen = false;
    }
    function updateMiniBar() {
        var el = document.getElementById('call-mini-bar');
        if (!el) return;
        var joinBtn = document.getElementById('call-mini-return');
        var endBtn = document.getElementById('call-mini-end');
        if (ringingCall) {
            el.style.display = 'flex';
            document.getElementById('call-mini-text').textContent = '📞 Incoming call from ' + ringingCall.callerUsername;
            if (joinBtn) { joinBtn.textContent = 'Join'; joinBtn.style.display = ''; }
            if (endBtn) { endBtn.textContent = 'Decline'; endBtn.style.display = ''; }
        } else if (currentRoom && currentRoom.kind === 'dm' && !dmPanelOpen) {
            el.style.display = 'flex';
            document.getElementById('call-mini-text').textContent = '📞 In call with ' + currentRoom.name;
            if (joinBtn) { joinBtn.textContent = 'Return'; joinBtn.style.display = ''; }
            if (endBtn) { endBtn.textContent = 'End'; endBtn.style.display = ''; }
        } else {
            el.style.display = 'none';
        }
    }
    function hideMiniBar() {
        var el = document.getElementById('call-mini-bar');
        if (el) el.style.display = 'none';
    }
    function showRingBar() {
        updateMiniBar();
        // If the callee is already viewing that DM, open the panel with a join prompt.
        if (ringingCall && typeof viewMode !== 'undefined' && viewMode === 'dms' &&
            typeof currentDmChannelId !== 'undefined' && currentDmChannelId === ringingCall.dmChannelId) {
            showDmJoinPrompt(ringingCall);
        }
    }
    function hideRingBar() {
        updateMiniBar();
        hideDmJoinPrompt();
    }
    function showDmJoinPrompt(ring) {
        var body = document.getElementById('dm-call-body');
        if (!body) return;
        body.innerHTML = '<div class="dm-call-waiting" id="dm-call-ring-prompt">' +
            '<div class="dm-call-ring-title">📞 Incoming call from ' + escapeHtml(ring.callerUsername || 'Someone') + '</div>' +
            '<div class="dm-call-ring-actions">' +
            '<button class="voice-ctrl-btn" id="dm-call-accept-btn">Accept</button>' +
            '<button class="voice-ctrl-btn voice-leave-call" id="dm-call-decline-btn">Decline</button>' +
            '</div></div>';
        var accept = document.getElementById('dm-call-accept-btn');
        var decline = document.getElementById('dm-call-decline-btn');
        if (accept) accept.onclick = function () {
            var other = { id: ring.callerUserId, username: ring.callerUsername };
            startDmCall(ring.dmChannelId, other);
        };
        if (decline) decline.onclick = function () { ringingCall = null; hideRingBar(); };
    }
    function hideDmJoinPrompt() {
        var body = document.getElementById('dm-call-body');
        if (body) body.innerHTML = '';
    }

    // ---------- UI: DM header call button ----------
    function ensureDmCallButton() {
        var header = document.getElementById('channel-name');
        if (!header) return;
        if (header.querySelector('#dm-call-btn')) return;
        if (typeof viewMode === 'undefined' || viewMode !== 'dms' || typeof currentDmChannelId === 'undefined' || !currentDmChannelId) return;
        var btn = document.createElement('button');
        btn.id = 'dm-call-btn';
        btn.className = 'dm-call-btn';
        btn.title = 'Start voice call';
        btn.textContent = '📞';
        btn.onclick = function () {
            if (currentRoom && currentRoom.kind === 'dm') {
                leaveRoom(true);
                return;
            }
        var other = typeof currentDmOtherUser !== 'undefined' ? currentDmOtherUser : null;
        if (other && typeof currentDmChannelId !== 'undefined') startDmCall(currentDmChannelId, other);
        };
        header.appendChild(btn);
        if (currentRoom && currentRoom.kind === 'dm' && window.currentDmChannelId === currentRoom.dmChannelId) {
            btn.classList.add('active');
            btn.textContent = '📞';
        }
    }

    // ---------- init / wiring ----------
    var initDone = false;
    function init() {
        // voice.js loads before chat.js, and chat.js ALSO calls VoiceManager.init()
        // on DOMContentLoaded — so init runs twice. Without this guard every popup
        // control would get two listeners and each click would toggle mute twice
        // (net no change → the voice bar "isn't working").
        if (initDone) return;
        initDone = true;
        // Resume a suspended AudioContext on any user gesture (autoplay-policy
        // safety net for contexts created outside a click, e.g. after reload).
        armGestureResume();
        // Leaving fullscreen must refresh the member tiles so the restored
        // element gets the latest frame (the fullscreen element was parked and
        // may have missed updates while detached from its tile).
        document.addEventListener('fullscreenchange', function () {
            if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                renderMembers();
            }
        });
        // Browsers suspend AudioContexts in background/hidden tabs. When the
        // user comes back to this window (common when testing two windows on the
        // same PC — one normal, one incognito), resume the context so sound
        // returns without a reload.
        function resumeOnVisible() {
            if (document.hidden) return;
            if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
            if (currentRoom && !micStream && !selfState.deafened && !micStartFailed) startCapture();
        }
        document.addEventListener('visibilitychange', resumeOnVisible);
        window.addEventListener('focus', resumeOnVisible);
        // popup controls
        var popup = document.getElementById('voice-popup');
        if (popup) {
            document.getElementById('voice-popup-close').addEventListener('click', function () { popupOpen = true; toggleServerPopup(); });
            document.getElementById('vp-mute-btn').addEventListener('click', function () { setSelfMuted(!selfState.muted); });
            document.getElementById('vp-deafen-btn').addEventListener('click', function () { setSelfDeafened(!selfState.deafened); });
            document.getElementById('vp-camera-btn').addEventListener('click', toggleCamera);
            document.getElementById('vp-screen-btn').addEventListener('click', toggleScreen);
            document.getElementById('vp-leave-btn').addEventListener('click', function () { leaveRoom(true); });
            var mic = document.getElementById('vp-mic-vol');
            var spk = document.getElementById('vp-spk-vol');
            mic.value = micVolume;
            spk.value = speakerVolume;
            mic.oninput = function () { setMicVolume(parseInt(mic.value, 10)); };
            spk.oninput = function () { setSpeakerVolume(parseInt(spk.value, 10)); };
            document.getElementById('vp-noise').checked = noiseSuppression;
            document.getElementById('vp-noise').onchange = function () {
                noiseSuppression = this.checked;
                setSetting('noise_suppression', noiseSuppression);
                // reacquire mic with new constraint
                if (currentRoom && micStream) {
                    stopCapture();
                    selfState.muted = false; selfState.deafened = false;
                    startCapture();
                }
            };
        }
        // dm call panel controls
        document.getElementById('dm-call-mute-btn').addEventListener('click', function () { setSelfMuted(!selfState.muted); });
        document.getElementById('dm-call-deafen-btn').addEventListener('click', function () { setSelfDeafened(!selfState.deafened); });
        document.getElementById('dm-call-camera-btn').addEventListener('click', toggleCamera);
        document.getElementById('dm-call-screen-btn').addEventListener('click', toggleScreen);
        document.getElementById('dm-call-end-btn').addEventListener('click', function () { leaveRoom(true); });
        // mini bar
        document.getElementById('call-mini-return').addEventListener('click', function () {
            if (ringingCall) {
                var other = { id: ringingCall.callerUserId, username: ringingCall.callerUsername };
                startDmCall(ringingCall.dmChannelId, other);
                return;
            }
            if (!currentRoom || currentRoom.kind !== 'dm') return;
            var convEl = document.querySelector('.dm-item[data-dm-id="' + currentRoom.dmChannelId + '"]');
            if (convEl) convEl.click();
            else if (typeof selectDmChannel !== 'undefined' && currentRoom.otherUserId) {
                // fallback: find conversation
                var conv = (typeof dmConversations !== 'undefined' ? (dmConversations || []) : []).find(function (c) { return c.dm_channel_id === currentRoom.dmChannelId; });
                if (conv) selectDmChannel(currentRoom.dmChannelId, conv.other_user_id, conv.other_username, document.querySelector('.dm-item[data-dm-id="' + currentRoom.dmChannelId + '"]') || document.createElement('div'));
            }
        });
        document.getElementById('call-mini-end').addEventListener('click', function () {
            if (ringingCall) {
                ringingCall = null;
                hideRingBar();
                return;
            }
            leaveRoom(true);
        });
        // volume menu close on outside click
        document.addEventListener('click', function (e) {
            var menu = document.getElementById('member-volume-menu');
            if (menu && menu.style.display !== 'none' && !menu.contains(e.target)) menu.style.display = 'none';
        });
        // settings wiring
        var smic = document.getElementById('voice-mic-volume');
        var sspk = document.getElementById('voice-speaker-volume');
        var snoise = document.getElementById('voice-noise-suppression');
        if (smic) {
            smic.value = micVolume;
            document.getElementById('voice-mic-volume-label').textContent = micVolume + '%';
            smic.oninput = function () { setMicVolume(parseInt(smic.value, 10)); document.getElementById('voice-mic-volume-label').textContent = smic.value + '%'; };
        }
        if (sspk) {
            sspk.value = speakerVolume;
            document.getElementById('voice-speaker-volume-label').textContent = speakerVolume + '%';
            sspk.oninput = function () { setSpeakerVolume(parseInt(sspk.value, 10)); document.getElementById('voice-speaker-volume-label').textContent = sspk.value + '%'; };
        }
        if (snoise) {
            snoise.checked = noiseSuppression;
            snoise.onchange = function () {
                noiseSuppression = this.checked;
                setSetting('noise_suppression', noiseSuppression);
                if (currentRoom && micStream) {
                    stopCapture();
                    selfState.muted = false; selfState.deafened = false;
                    startCapture();
                }
            };
        }
        // observe view changes to toggle DM panel / call button
        var origSet = null;
        if (typeof selectDmChannel !== 'undefined') {
            origSet = selectDmChannel;
            var origDm = selectDmChannel;
            selectDmChannel = function () {
                var r = origDm.apply(this, arguments);
                setTimeout(function () { openDmPanelIfRelevant(); ensureDmCallButton(); }, 50);
                return r;
            };
        }
        // hook selectChannel too (server view) → DM panel hides, and the voice
        // popup closes when switching to a different channel (otherwise the popup
        // stays over the new channel's messages and looks like you can't switch).
        if (typeof selectChannel !== 'undefined') {
            var origSel = selectChannel;
            selectChannel = function (channelId) {
                var r = origSel.apply(this, arguments);
                setTimeout(function () {
                    closeDmPanel();
                    updateMiniBar();
                    if (currentRoom && currentRoom.kind === 'server' && channelId !== currentRoom.channelId) {
                        closePopup();
                    }
                }, 50);
                return r;
            };
        }
        // initial header button (in case a DM is already open)
        setTimeout(ensureDmCallButton, 1500);
    }

    function setMicVolume(v) {
        micVolume = Math.max(0, Math.min(200, v));
        setSetting('mic_volume', micVolume);
    }
    function setSpeakerVolume(v) {
        speakerVolume = Math.max(0, Math.min(200, v));
        setSetting('speaker_volume', speakerVolume);
        if (masterGain) masterGain.gain.value = speakerVolume / 100;
        // update all member gains
        Object.keys(members).forEach(function (uid) {
            if (members[uid] && members[uid].gain) {
                var vol = members[uid].volume != null ? members[uid].volume : 100;
                members[uid].gain.gain.value = (vol / 100) * (speakerVolume / 100);
            }
        });
    }

    // expose
    window.VoiceManager = {
        init: init,
        _debugAudioCtx: function () { return audioCtx; },
        _debugRoomKey: function () {
            try {
                var k = getRoomKey();
                return k ? 'key:' + k.length : 'NO_KEY';
            } catch (e) { return 'ERR:' + e.message; }
        },
        _debugSimulateKeyLoss: function () {
            // Forget the resolved other-public-key AND the conversation's cached
            // copy so getRoomKey() can't derive the DM key — mimics the real
            // "can't talk in DM calls" silent-failure state (both sources missing).
            if (!currentRoom || currentRoom.kind !== 'dm') return false;
            currentRoom.otherPubKey = null;
            var conv = (typeof dmConversations !== 'undefined' ? (dmConversations || []) : []).find(function (c) { return c.dm_channel_id === currentRoom.dmChannelId; });
            if (conv) { conv.other_public_key = null; }
            return true;
        },
        _debugHealKey: function () { healDmRoomKey(); },
        _debugState: function () {
            return {
                muted: selfState.muted,
                deafened: selfState.deafened,
                forceMuted: selfState.forceMuted,
                forceDeafened: selfState.forceDeafened,
                speaking: selfState.speaking,
                micStream: !!micStream
            };
        },
        handleServerMessage: handleServerMessage,
        isVoiceMessage: isVoiceMessage,
        joinServerVoice: joinServerVoice,
        startDmCall: startDmCall,
        leaveRoom: leaveRoom,
        ensureDmCallButton: ensureDmCallButton,
        openDmPanelIfRelevant: openDmPanelIfRelevant,
        toggleServerPopup: toggleServerPopup,
        onViewChanged: function () { setTimeout(function () { openDmPanelIfRelevant(); ensureDmCallButton(); }, 50); },
        reconnect: function () {
            // rejoin current room after ws reconnect
            if (!currentRoom) return;
            var room = currentRoom;
            currentRoom = null;
            members = {};
            if (room.kind === 'server') {
                currentRoom = room;
                wsSend({ type: 'voice_join', room: room.key, kind: 'server', server_id: room.serverId, channel_id: room.channelId });
            } else {
                currentRoom = room;
                wsSend({ type: 'voice_join', room: room.key, kind: 'dm', dm_channel_id: room.dmChannelId });
            }
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
