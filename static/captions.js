/**
 * Live captions — local, per participant, no network.
 *
 * ===== WHAT CHANGED AND WHY (read this before touching the file) =====
 *
 * This used to work the way speech-to-text usually does: the platform's
 * recogniser listened to this device's microphone, and the account could opt in
 * to *publish* its own transcript to everyone else over the call's signal
 * envelope. Both halves were wrong:
 *
 *   1. Publishing sends text derived from a private call to other people, and
 *      it only ever described the person who turned it on — everyone else saw
 *      nothing unless they also had a working recogniser.
 *   2. The desktop app had no local engine at all, so captions did not exist
 *      there (the old code refused to fall back to an online service, which was
 *      the right call and left desktop with nothing).
 *
 * So captions were rebuilt around what the user actually asked for: turn them
 * on, and this device transcribes what EVERY participant is saying, from the
 * audio it already decrypts to play. Concretely:
 *
 *   - The engine is a whisper model bundled in the app
 *     (static/vendor/asr/, see tools/fetch-asr-assets.mjs) and run inside this
 *     webview by captions-asr-worker.js. `env.allowRemoteModels = false`, no
 *     CDN, no service: decrypted audio never leaves the device, not even to the
 *     host machine. Same model on desktop and Android.
 *   - One transcribing lane per participant. A per-speaker tap
 *     (attach()) takes the PCM of that person's decrypted stream, gates it on
 *     energy, and hands ~5 s windows to the worker, so every line is labelled
 *     with who said it.
 *   - There is NO publish path any more, and no caption message type: the
 *     `voice_signal` envelope no longer carries transcripts, so nothing derived
 *     from a call can be read by anyone but the account that turned captions on.
 *   - Captions are still never written to disk, never logged, never put in a
 *     notification: lines live in this module's memory and the DOM, and stopping
 *     captions (or leaving the page) drops them.
 *
 * Cost, stated honestly: whisper-tiny on a single wasm thread keeps up with
 * roughly real time on a desktop CPU and lags a few seconds behind on a phone,
 * and each participant being transcribed costs one decode. Turns are therefore
 * transcribed one window at a time per speaker, and a speaker who is talking
 * while their previous window is still decoding simply skips that window (a
 * caption that arrives 20 seconds late is worse than a missing one).
 */
(function () {
    'use strict';

    var WORKER_URL = 'captions-asr-worker.js?v=1';
    var CHUNK_SECONDS = 5;        // audio per recognition window
    var MIN_SPEECH_RMS = 0.006;   // below this the window is silence, not speech
    var MAX_LINES = 30;
    var MAX_TEXT = 240;
    var MAX_PENDING = 1;          // windows queued per speaker while one decodes

    // Whisper is multilingual but needs to be told which language to decode:
    // transformers.js defaults to English when none is given, so this is a
    // setting rather than a guess. The list is the languages the model supports
    // that are plausible for this app's users.
    var LANGUAGES = [
        ['en', 'English'], ['ro', 'Romanian'], ['fr', 'French'], ['de', 'German'],
        ['es', 'Spanish'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'],
        ['pl', 'Polish'], ['ru', 'Russian'], ['uk', 'Ukrainian'], ['tr', 'Turkish'],
        ['sv', 'Swedish'], ['da', 'Danish'], ['cs', 'Czech'], ['hu', 'Hungarian'],
        ['bg', 'Bulgarian'], ['el', 'Greek'], ['fi', 'Finnish'], ['no', 'Norwegian'],
    ];

    var _lines = [];              // { who, text, final, at } — memory only
    var _running = false;
    var _worker = null;
    var _modelState = 'cold';     // cold | loading | ready | failed
    var _modelProgress = 0;
    var _modelError = '';
    var _speakers = {};           // uid -> Speaker
    var _selfStream = null;       // optional mic tap
    var _nextId = 1;
    var _pending = {};            // request id -> uid

    function setting(key, fallback) {
        try { return localStorage.getItem('captions_' + key) || fallback; } catch (_) { return fallback; }
    }
    function saveSetting(key, value) {
        try { localStorage.setItem('captions_' + key, value); } catch (_) {}
    }
    function enabledByDefault() { return setting('enabled', '0') === '1'; }
    function language() { return setting('language', 'en'); }
    function includeSelf() { return setting('includeSelf', '0') === '1'; }

    // ─── worker ──────────────────────────────────────────────────────────

    function worker() {
        if (_worker) return _worker;
        _worker = new Worker(WORKER_URL, { type: 'module' });
        _modelState = 'loading';
        _worker.onmessage = function (ev) {
            var m = ev && ev.data;
            if (!m) return;
            if (m.type === 'progress') {
                if (typeof m.progress === 'number' && m.progress >= 0) _modelProgress = m.progress;
                renderStatus();
                return;
            }
            if (m.type === 'ready') {
                _modelState = 'ready';
                renderStatus();
                // Transcribe the newest window each speaker produced while the
                // model was still loading. Dropping them (the old behaviour)
                // threw away the first words of the call for no reason: one
                // held window per speaker costs a few hundred KB.
                flushPendingWindows();
                return;
            }
            if (m.type === 'result') {
                var uid = _pending[m.id];
                delete _pending[m.id];
                var s = uid ? _speakers[uid] : null;
                if (s) s.inflight = false;
                if (m.text) pushLine((s && s.name) || m.speaker || 'Someone', m.text, true);
                return;
            }
            if (m.type === 'error') {
                if (m.id && _pending[m.id]) {
                    var uid2 = _pending[m.id];
                    delete _pending[m.id];
                    if (_speakers[uid2]) _speakers[uid2].inflight = false;
                }
                if (!m.id) {
                    _modelState = 'failed';
                    _modelError = m.message || 'unknown error';
                    stop();
                    renderStatus();
                    if (typeof showToast === 'function') showToast('Captions stopped: ' + _modelError);
                }
            }
        };
        _worker.onerror = function (e) {
            _modelState = 'failed';
            _modelError = (e && e.message) || 'worker failed to start';
            renderStatus();
        };
        _worker.postMessage({ type: 'warm' });
        return _worker;
    }

    function rms(samples) {
        var sum = 0;
        for (var i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        return Math.sqrt(sum / (samples.length || 1));
    }

    /** Hand one window of one speaker's audio to the worker. */
    function transcribe(uid, samples, sampleRate) {
        var s = _speakers[uid];
        if (!s) return false;
        if (s.inflight) return false;               // still decoding the last one
        if (_modelState === 'cold') worker();
        if (_modelState !== 'ready') {
            // The model is still loading: keep only the newest window for this
            // speaker and hand it over the moment the worker reports ready (see
            // flushPendingWindows), so enabling captions mid-sentence does not
            // throw the sentence away.
            s.pending = { samples: new Float32Array(samples), sampleRate: sampleRate || 16000 };
            updatePanelStatus();
            return false;
        }
        var buf = new Float32Array(samples);
        var id = _nextId++;
        s.inflight = true;
        _pending[id] = uid;
        s.windows++;
        _worker.postMessage({
            type: 'transcribe', id: id, speaker: s.name,
            audio: buf, sampleRate: sampleRate || 16000, language: language(),
        }, [buf.buffer]);
        return true;
    }

    /**
     * Hand the one window each speaker held while the model was loading to the
     * worker. Called from the worker's `ready` message; a no-op otherwise.
     */
    function flushPendingWindows() {
        Object.keys(_speakers).forEach(function (uid) {
            var s = _speakers[uid];
            if (!s || !s.pending) return;
            var p = s.pending;
            s.pending = null;
            if (rms(p.samples) >= MIN_SPEECH_RMS) transcribe(uid, p.samples, p.sampleRate);
        });
    }

    // ─── per-participant taps ────────────────────────────────────────────

    function displayName(uid) {
        try {
            var cache = window.userDisplayNameCache || {};
            var c = cache[uid];
            if (c) return c.display_name || c.username || uid;
        } catch (_) {}
        try {
            if (window.myUser && (window.myUser.id === uid) && window.myUser.username) return window.myUser.username;
        } catch (_) {}
        return uid ? String(uid).slice(0, 6) : 'Someone';
    }

    /**
     * Start transcribing the decrypted audio of one participant.
     * `stream` is their remote audio MediaStream (voice.js hands it over when the
     * element sink starts playing it). Idempotent per (uid, stream).
     */
    function attach(uid, stream, name) {
        if (!uid || !stream) return;
        var existing = _speakers[uid];
        if (existing && existing.stream === stream) return;
        if (existing) detach(uid);
        if (!_running) return;   // remembered; attach() runs again when captions start

        var speaker = { uid: uid, name: name || displayName(uid), stream: stream, windows: 0, inflight: false, pending: null, buf: [], ctx: null, node: null, src: null, sink: null };
        _speakers[uid] = speaker;

        try {
            // A dedicated low-rate context keeps the recognition tap away from
            // the playback graph (the app's own AudioContext drives the
            // noise-suppression worklet and master gain; a second consumer of
            // the same track must not disturb it).
            var Ctx = window.AudioContext || window.webkitAudioContext;
            var ctx;
            try { ctx = new Ctx({ sampleRate: 16000 }); } catch (_) { ctx = new Ctx(); }
            speaker.ctx = ctx;
            // A context created outside a user gesture starts suspended, and a
            // suspended context fires no onaudioprocess at all — captions would
            // sit silent forever with no error to show for it. Resume
            // explicitly; the promise is deliberately ignored.
            try { if (ctx.state === 'suspended' && ctx.resume) Promise.resolve(ctx.resume()).catch(function () {}); } catch (_) {}
            speaker.src = ctx.createMediaStreamSource(stream);
            // ScriptProcessorNode: deprecated, but it exists in every webview we
            // ship (AudioWorklet needs a separate module file and the same
            // origin/worker permissions, for no benefit here).
            var node = ctx.createScriptProcessor(4096, 1, 1);
            speaker.node = node;
            var sink = ctx.createGain();
            sink.gain.value = 0;         // never audible: this path only listens
            speaker.sink = sink;
            node.onaudioprocess = function (ev) {
                if (!_running) return;
                var data = ev.inputBuffer.getChannelData(0);
                speaker.buf.push(new Float32Array(data));
                var need = Math.floor(CHUNK_SECONDS * ctx.sampleRate);
                var have = 0;
                for (var i = 0; i < speaker.buf.length; i++) have += speaker.buf[i].length;
                if (have < need) return;
                var merged = new Float32Array(have);
                var off = 0;
                for (var j = 0; j < speaker.buf.length; j++) { merged.set(speaker.buf[j], off); off += speaker.buf[j].length; }
                speaker.buf = [];
                if (rms(merged) < MIN_SPEECH_RMS) return;     // silence: never ask the model
                transcribe(uid, merged, ctx.sampleRate);
            };
            speaker.src.connect(node);
            node.connect(sink);
            sink.connect(ctx.destination);
            renderStatus();
        } catch (e) {
            // No AudioContext tap (a webview without Web Audio, a stream that is
            // already gone) — captions just have nothing to hear from this
            // participant.
            delete _speakers[uid];
        }
    }

    function detach(uid) {
        var s = _speakers[uid];
        if (!s) return;
        try { if (s.node) { s.node.onaudioprocess = null; s.node.disconnect(); } } catch (_) {}
        try { if (s.src) s.src.disconnect(); } catch (_) {}
        try { if (s.sink) s.sink.disconnect(); } catch (_) {}
        try { if (s.ctx && s.ctx.close) s.ctx.close(); } catch (_) {}
        delete _speakers[uid];
    }

    function detachAll() {
        Object.keys(_speakers).forEach(detach);
    }

    /** Attach every remote audio stream the call currently has. */
    function attachAll() {
        if (typeof window.__voiceForEachRemoteAudio === 'function') {
            try { window.__voiceForEachRemoteAudio(function (uid, stream) { attach(uid, stream); }); } catch (_) {}
        }
        if (includeSelf()) attachSelf();
    }

    function attachSelf() {
        if (_selfStream) return;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
        navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
            if (!_running || !includeSelf()) {
                try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
                return;
            }
            _selfStream = stream;
            var me = null;
            try { me = window.myUser && window.myUser.id; } catch (_) {}
            attach('self', stream, (window.myUser && (window.myUser.display_name || window.myUser.username)) || 'You');
            void me;
        }).catch(function () {});
    }

    function detachSelf() {
        if (!_selfStream) return;
        detach('self');
        try { _selfStream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
        _selfStream = null;
    }

    // ─── rendering (display-only) ────────────────────────────────────────

    function panel() {
        var el = document.getElementById('captions-panel');
        if (el) return el;
        el = document.createElement('div');
        el.id = 'captions-panel';
        el.className = 'captions-panel';
        el.innerHTML = '<div class="captions-head"><span class="captions-title">Captions — on this device</span>' +
            '<span class="captions-badge" id="captions-mode"></span></div>' +
            '<div class="captions-live" id="captions-live"></div>' +
            '<div class="captions-lines" id="captions-lines"></div>';
        document.body.appendChild(el);
        return el;
    }

    function renderLines() {
        var el = document.getElementById('captions-lines');
        if (!el) return;
        var html = '';
        for (var i = 0; i < _lines.length; i++) {
            var l = _lines[i];
            html += '<div class="captions-line' + (l.final ? '' : ' captions-line-live') + '">' +
                '<span class="captions-who">' + window.escapeHtml(l.who) + '</span>' +
                '<span class="captions-text">' + window.escapeHtml(l.text) + '</span></div>';
        }
        el.innerHTML = html;
        el.scrollTop = el.scrollHeight;
        var mode = document.getElementById('captions-mode');
        if (mode) mode.textContent = language().toUpperCase() + ' · local';
        updatePanelStatus();
    }

    /**
     * The one line inside the panel that says what the engine is doing. Without
     * it, turning captions on produced an empty overlay that was identical to
     * captions being broken — the model loading, waiting for call audio, and a
     * failure all looked the same (nothing).
     */
    function updatePanelStatus() {
        var el = document.getElementById('captions-live');
        if (!el) return;
        if (!_running) { el.textContent = ''; return; }
        if (_modelState === 'loading') {
            el.textContent = 'Loading the on-device speech model' + (_modelProgress ? ' (' + _modelProgress + '%)' : '') + '…';
            return;
        }
        if (_modelState === 'failed') {
            el.textContent = 'Speech model could not start: ' + (_modelError || 'unknown error');
            return;
        }
        var n = Object.keys(_speakers).length;
        var decoded = 0;
        Object.keys(_speakers).forEach(function (uid) { decoded += _speakers[uid].windows; });
        if (!n) {
            el.textContent = 'Listening — no call audio yet. Captions appear when someone speaks.';
            return;
        }
        el.textContent = 'Listening to ' + n + ' participant' + (n === 1 ? '' : 's') +
            (decoded ? ' · ' + decoded + ' window' + (decoded === 1 ? '' : 's') + ' decoded' : ' · waiting for speech');
    }

    function pushLine(who, text, isFinal) {
        if (!text) return;
        var last = _lines[_lines.length - 1];
        if (last && last.who === who && !last.final) {
            last.text = String(text).slice(0, MAX_TEXT);
            last.final = !!isFinal;
        } else {
            _lines.push({ who: who, text: String(text).slice(0, MAX_TEXT), final: !!isFinal, at: Date.now() });
        }
        while (_lines.length > MAX_LINES) _lines.shift();
        panel();
        renderLines();
        var p = document.getElementById('captions-panel');
        if (p) p.classList.add('captions-open');
    }

    function refreshUi() {
        var t = document.getElementById('captions-toggle');
        var selfToggle = document.getElementById('captions-self-toggle');
        var langSel = document.getElementById('captions-language');
        var line = document.getElementById('captions-status');
        if (t) t.checked = _running;
        if (selfToggle) { selfToggle.checked = includeSelf(); selfToggle.disabled = !_running; }
        if (langSel) langSel.value = language();
        if (line) line.textContent = statusText();
        var panelEl = document.getElementById('captions-panel');
        if (panelEl) panelEl.classList.toggle('captions-open', _running || _lines.length > 0);
        updatePanelStatus();
    }

    function renderStatus() { refreshUi(); }

    function statusText() {
        if (_modelState === 'loading') {
            var pct = _modelProgress ? ' (' + _modelProgress + '%)' : '';
            return 'Loading the offline speech model' + pct + ' — it ships with the app, nothing is downloaded from the internet.';
        }
        if (_modelState === 'failed') return 'The offline speech model could not start: ' + (_modelError || 'unknown error') + '.';
        if (!_running) {
            return 'Captions run fully on this device with the speech model bundled in the app. ' +
                'Nothing — no audio and no text — is sent to anyone, including the other people on the call.';
        }
        var n = Object.keys(_speakers).length;
        var total = 0;
        Object.keys(_speakers).forEach(function (uid) { total += _speakers[uid].windows; });
        return 'Transcribing ' + n + ' participant' + (n === 1 ? '' : 's') + ' on this device (' + language().toUpperCase() +
            '). ' + total + ' window' + (total === 1 ? '' : 's') + ' decoded. Nothing leaves this device.';
    }

    // ─── start / stop ────────────────────────────────────────────────────

    function start() {
        if (_running) return true;
        _running = true;
        worker();                 // begins loading the model (cached by the webview)
        attachAll();
        panel().classList.add('captions-open');
        renderStatus();
        renderLines();
        return true;
    }

    function stop() {
        _running = false;
        detachAll();
        detachSelf();
        var el = document.getElementById('captions-panel');
        if (el) el.classList.remove('captions-open');
        // Captions are the most sensitive thing this file touches: dropping them
        // on stop is the point (they were never written down in the first place).
        _lines = [];
        renderLines();
        renderStatus();
        return true;
    }

    window.__captions = {
        start: start,
        stop: stop,
        isRunning: function () { return _running; },
        attach: attach,
        detach: detach,
        lines: function () { return _lines.slice(); },
        language: language,
        languages: LANGUAGES,
        setLanguage: function (code) {
            saveSetting('language', code);
            refreshUi();
        },
        includeSelf: includeSelf,
        setIncludeSelf: function (on) {
            saveSetting('includeSelf', on ? '1' : '0');
            if (on && _running) attachSelf();
            if (!on) detachSelf();
            refreshUi();
        },
        modelState: function () { return { state: _modelState, progress: _modelProgress, error: _modelError }; },
        speakers: function () { return Object.keys(_speakers); },
        // Test hook: push PCM through the exact path a real participant's tap
        // uses (energy gate -> worker -> labelled line) without needing a live
        // call. Used by tests/captions-local.spec.ts.
        _feedForTest: function (uid, name, audio, sampleRate) {
            var s = _speakers[uid];
            if (!s) { s = { uid: uid, name: name || uid, stream: null, windows: 0, inflight: false, buf: [] }; _speakers[uid] = s; }
            s.name = name || s.name;
            if (rms(audio) < MIN_SPEECH_RMS) return false;
            return transcribe(uid, audio, sampleRate || 16000);
        },
        _setModelReadyForTest: function () { _modelState = 'ready'; },
    };

    document.addEventListener('DOMContentLoaded', function () {
        var t = document.getElementById('captions-toggle');
        var selfToggle = document.getElementById('captions-self-toggle');
        var langSel = document.getElementById('captions-language');

        if (langSel) {
            langSel.innerHTML = LANGUAGES.map(function (l) {
                return '<option value="' + l[0] + '">' + l[1] + '</option>';
            }).join('');
            langSel.value = language();
            langSel.addEventListener('change', function () { window.__captions.setLanguage(this.value); });
        }
        if (t) {
            t.addEventListener('change', function () {
                if (this.checked) {
                    saveSetting('enabled', '1');
                    start();
                } else {
                    saveSetting('enabled', '0');
                    stop();
                }
            });
        }
        if (selfToggle) {
            selfToggle.addEventListener('change', function () { window.__captions.setIncludeSelf(this.checked); });
        }
        // Honour a previous "on", but never before the user is in the app.
        if (enabledByDefault()) {
            var t2 = document.getElementById('captions-toggle');
            if (t2) t2.checked = true;
            start();
        }
        refreshUi();
    });
})();
