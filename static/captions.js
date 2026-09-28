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
 *     energy, and hands the worker a rolling 30 s window — whisper's own
 *     window — so every line is labelled with who said it.
 *   - There is NO publish path any more, and no caption message type: the
 *     `voice_signal` envelope no longer carries transcripts, so nothing derived
 *     from a call can be read by anyone but the account that turned captions on.
 *   - Captions are still never written to disk, never logged, never put in a
 *     notification: lines live in this module's memory and the DOM, and stopping
 *     captions (or leaving the page) drops them.
 *
 * ===== THE WINDOWS (why 30 s, why a stride)
 *
 * This used to hand the model ISOLATED 5-second slices. That is close to the
 * worst possible way to run whisper: the encoder always processes a full 30 s
 * mel frame no matter how much audio arrived, so a 5-second slice cost nearly
 * the same as a 30-second one while throwing away 25 seconds of context — and
 * context is most of what makes whisper accurate. No context for a homophone,
 * no context to finish the sentence, and a hard chop every five seconds in the
 * middle of a word. The word-level errors people complained about came from
 * those chops and from whisper-tiny's own small vocabulary.
 *
 * So a speaker's audio now accumulates into a rolling CONTEXT_SECONDS (30 s)
 * window that is re-decoded every STRIDE_SECONDS (5 s) of new speech, and when
 * they pause. The window is not cleared after a decode: the overlap is the
 * point — a word that was half-cut before the boundary is decoded again with
 * its other half present. To stop that overlap from repeating itself on screen,
 * each decode is compared with the words already shown for that speaker
 * (stripCommitted) and only the new tail is committed. Lines stay "live" until
 * a pause ends the utterance, so a later, better-informed decode of the same
 * audio corrects the line instead of adding a second, slightly different one.
 *
 * Cost, stated honestly: one decode per 5 s of speech per participant, and each
 * decode is a full 30 s window. That is roughly what the old code already spent
 * (one decode per 5 s slice, same encoder cost, less to show for it), and the
 * wasm backend now runs on 4 threads because the app's own headers make the
 * page cross-origin isolated. A speaker who talks while their own previous
 * window is still decoding keeps their audio in the window and is decoded the
 * moment the worker is free — nothing is thrown away mid-sentence.
 */
(function () {
    'use strict';

    var WORKER_URL = 'captions-asr-worker.js?v=2';
    var CONTEXT_SECONDS = 30;     // the window the model sees (whisper's own)
    var STRIDE_SECONDS = 5;       // new speech that triggers the next decode
    var SILENCE_SECONDS = 0.7;    // a pause this long ends the utterance
    var MIN_UTTERANCE_SECONDS = 1.2;  // too short to be worth a decode on a pause
    var MIN_SPEECH_RMS = 0.006;   // below this the audio is silence, not speech
    var MAX_LINES = 30;
    var MAX_TEXT = 240;
    var MAX_COMMITTED = 400;      // characters kept to de-duplicate the overlap
    var BENCH_RUNS = 3;           // decodes per engine when benchmarking
    var BENCH_TIMEOUT_MS = 240000;

    // Whisper is multilingual but needs to be told which language to decode:
    // transformers.js defaults to English when none is given, so this is a
    // setting rather than a guess. The list is the languages the model supports
    // that are plausible for this app's users.
    //
    // 'auto' is the first entry on purpose: a wrong language is the single
    // biggest source of unusable captions — whisper decoded as English when the
    // speaker is Romanian does not produce "a few wrong words", it produces
    // nonsense. With 'auto' the first decode of the call detects the language
    // and the result is pinned for the rest of it (see effectiveLanguage), so
    // it neither flips mid-sentence nor has to be set by hand.
    var LANGUAGES = [
        ['auto', 'Detect automatically'],
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
    var _engine = '';             // 'wasm' | 'webgpu' — what the worker actually got
    var _speakers = {};           // uid -> Speaker
    var _selfStream = null;       // optional mic tap
    var _nextId = 1;
    var _pending = {};            // request id -> uid
    var _detectedLanguage = '';   // what the first decode of 'auto' came back as
    var _threads = 0;             // wasm threads the worker actually got
    var _isolated = null;         // cross-origin isolation, as the worker sees it
    var _workerModel = '';        // the model id the worker actually loaded
    var _lastWindow = null;       // { samples, sampleRate } — benchmarks real audio
    var _bench = null;            // the last benchmark readout
    var _benchRunning = false;
    var _benchStatus = '';

    function setting(key, fallback) {
        try { return localStorage.getItem('captions_' + key) || fallback; } catch (_) { return fallback; }
    }
    function saveSetting(key, value) {
        try { localStorage.setItem('captions_' + key, value); } catch (_) {}
    }
    function enabledByDefault() { return setting('enabled', '0') === '1'; }
    function language() { return setting('language', 'auto'); }
    /**
     * The language to send with a decode: '' means "work it out yourself",
     * which is what whisper does when it is not told. 'auto' therefore detects
     * on the first decode and pins the answer for the rest of the call, so the
     * text cannot flip between languages mid-sentence.
     */
    function effectiveLanguage() {
        var s = language();
        if (s === 'auto') return _detectedLanguage || '';
        return s;
    }
    // Settings → Live Captions → "Speech model". whisper-tiny by default: it is
    // the one that keeps up on a phone. whisper-base is markedly more accurate
    // (fewer wrong words, not just different ones) at roughly twice the work.
    function modelSetting() {
        var m = setting('model', 'tiny');
        return m === 'base' ? 'base' : 'tiny';
    }
    function modelLabel() { return modelSetting() === 'base' ? 'Base' : 'Tiny'; }
    function includeSelf() { return setting('includeSelf', '0') === '1'; }
    // Settings → Live Captions → "Use the GPU": off by default, because it is
    // the CPU path that always works. It buys speed, not accuracy.
    function useGpu() { return setting('gpu', '0') === '1'; }
    function gpuSupported() {
        try { return !!(navigator.gpu && navigator.gpu.requestAdapter); } catch (_) { return false; }
    }
    /** " · GPU" when the card is doing the work, " · CPU" when it is not. */
    function engineLabel() {
        if (_engine === 'webgpu') return ' · GPU';
        if (_engine !== 'wasm') return '';
        return ' · CPU' + (_threads > 1 ? ' ×' + _threads : '');
    }
    /** 'RO', or 'auto (ro)' once the first decode has worked the language out. */
    function languageLabel() {
        var s = language();
        if (s !== 'auto') return s.toUpperCase();
        return _detectedLanguage ? 'auto (' + _detectedLanguage.toUpperCase() + ')' : 'auto';
    }

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
                _engine = m.device === 'webgpu' ? 'webgpu' : 'wasm';
                if (typeof m.threads === 'number') _threads = m.threads;
                if (typeof m.isolated === 'boolean') _isolated = m.isolated;
                if (m.model) _workerModel = m.model;
                _modelError = '';
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
                if (m.language && language() === 'auto' && !_detectedLanguage) {
                    // Announce the detected language instead of silently using it:
                    // a wrong detection is visible here before it becomes a
                    // transcript full of nonsense.
                    _detectedLanguage = m.language;
                    renderStatus();
                }
                if (!m.text) { if (s) s.commitPending = false; return; }
                if (!s) { pushLine(m.speaker || 'Someone', m.text, true); return; }
                var shown = stripCommitted(s, m.text);
                if (!shown) { s.commitPending = false; return; }
                // Live until the pause that ends the utterance: a later decode of
                // the same audio (with more of the sentence in the window)
                // replaces the line instead of adding a second, nearly identical
                // one, and the pause is what makes it final.
                pushLine(s.name || displayName(s.uid), shown, !!s.commitPending);
                if (s.commitPending) {
                    s.committed = shown.slice(-MAX_COMMITTED);
                    s.commitPending = false;
                }
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
        _worker.postMessage({
            type: 'warm',
            device: useGpu() && gpuSupported() ? 'webgpu' : 'wasm',
            model: modelSetting(),
        });
        return _worker;
    }

    /**
     * Throw the model away so the next start() rebuilds it.
     *
     * Only used when the *device* changes: the backend is chosen while the model
     * is built, so switching between CPU and GPU means a new worker (and another
     * read of the bundled model from the app's own server — an HTTP cache hit).
     * Participant taps are deliberately left alone: they are audio plumbing, not
     * model state, and re-attaching every one of them would drop a live call's
     * captions.
     */
    function stopWorker() {
        if (_worker) { try { _worker.terminate(); } catch (_) {} }
        _worker = null;
        _modelState = 'cold';
        _modelProgress = 0;
        _modelError = '';
        _engine = '';
        _threads = 0;
        _isolated = null;
        _workerModel = '';
        Object.keys(_speakers).forEach(function (uid) {
            _speakers[uid].inflight = false;
            _speakers[uid].commitPending = false;
        });
    }

    function rms(samples) {
        var sum = 0;
        for (var i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        return Math.sqrt(sum / (samples.length || 1));
    }

    // ─── overlap de-duplication ──────────────────────────────────────────
    //
    // A 30 s window re-decoded every 5 s repeats almost everything it said last
    // time. These two functions turn "what the model just decoded" into "what is
    // new for the person reading it": the run of words already on screen that
    // also starts this decode is dropped, and only the tail is committed.
    var WORD_STRIP = /[^\w\u00C0-\u024F\u0400-\u04FF]+/g;
    function words(text) { return String(text || '').split(/\s+/).filter(Boolean); }
    function normWord(w) { return String(w).toLowerCase().replace(WORD_STRIP, ''); }
    function sameWords(a, b) {
        for (var i = 0; i < a.length; i++) if (normWord(a[i]) !== normWord(b[i])) return false;
        return true;
    }
    /**
     * The part of `text` that has not been shown yet.
     *
     * A small offset is allowed because the model sometimes re-words the very
     * start of a sentence once it can hear how the sentence ends. A one-word
     * match is deliberately not enough to strip: "and" is not evidence.
     */
    function stripCommitted(s, text) {
        var prev = words(s.committed);
        var next = words(text);
        if (!prev.length) return text;
        var maxWords = Math.min(60, next.length);
        for (var off = 0; off <= 3 && off < next.length; off++) {
            var k = Math.min(prev.length, maxWords - off);
            for (; k >= 2; k--) {
                if (sameWords(prev.slice(prev.length - k), next.slice(off, off + k))) {
                    return next.slice(off + k).join(' ');
                }
            }
        }
        return text;
    }

    // ─── the rolling window ──────────────────────────────────────────────

    /** Everything in this speaker's window, as one buffer, oldest first. */
    function windowSamples(s) {
        var total = 0, i;
        for (i = 0; i < s.buf.length; i++) total += s.buf[i].length;
        var out = new Float32Array(total);
        var off = 0;
        for (i = 0; i < s.buf.length; i++) { out.set(s.buf[i], off); off += s.buf[i].length; }
        return out;
    }

    /** Hold the window at whisper's own 30 s by dropping the oldest audio. */
    function trimWindow(s, rate) {
        var max = Math.round(CONTEXT_SECONDS * (rate || 16000));
        var total = 0, i;
        for (i = 0; i < s.buf.length; i++) total += s.buf[i].length;
        while (s.buf.length > 1 && total > max) {
            var first = s.buf[0];
            var excess = total - max;
            if (first.length <= excess) {
                total -= first.length;
                s.buf.shift();
            } else {
                s.buf[0] = first.subarray(excess);
                total -= excess;
            }
        }
    }

    /**
     * Hand one window of one speaker's audio to the worker.
     *
     * `commit` says the utterance this window ends in is over (a pause ended
     * it), which is what makes the line on screen final instead of live.
     */
    function transcribe(uid, samples, sampleRate, commit) {
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
        // Keep the window we just sent (the caller's array; `buf` is the copy
        // that gets transferred): the benchmark prefers a REAL window from the
        // call over a synthesised one, which makes its number mean something.
        _lastWindow = { samples: samples, sampleRate: sampleRate || 16000 };
        var id = _nextId++;
        s.inflight = true;
        s.commitPending = !!commit;
        _pending[id] = uid;
        s.windows++;
        _worker.postMessage({
            type: 'transcribe', id: id, speaker: s.name,
            device: useGpu() && gpuSupported() ? 'webgpu' : 'wasm',
            model: modelSetting(),
            audio: buf, sampleRate: sampleRate || 16000, language: effectiveLanguage(),
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

        var speaker = {
            uid: uid, name: name || displayName(uid), stream: stream,
            windows: 0, inflight: false, pending: null,
            // The rolling window and what has already been shown from it.
            buf: [], sinceDecode: 0, voiced: false, silence: 0,
            committed: '', commitPending: false,
            ctx: null, node: null, src: null, sink: null,
        };
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
            var rate = ctx.sampleRate;
            node.onaudioprocess = function (ev) {
                if (!_running) return;
                // getChannelData hands back a view into a buffer the audio thread
                // reuses, so every block is copied before it is kept.
                var block = new Float32Array(ev.inputBuffer.getChannelData(0));
                speaker.buf.push(block);
                var seconds = block.length / rate;
                if (rms(block) >= MIN_SPEECH_RMS) {
                    speaker.voiced = true;
                    speaker.silence = 0;
                    // "New speech since the last decode" is measured in speech,
                    // not wall clock: five seconds of noisy room must not trigger
                    // a decode that has nothing to transcribe.
                    speaker.sinceDecode += seconds;
                } else {
                    speaker.silence += seconds;
                }
                trimWindow(speaker, rate);
                if (!speaker.voiced) { speaker.sinceDecode = 0; return; }
                // Decode when the stride is up, or when a pause has plainly ended
                // the utterance — waiting the full stride would leave the last
                // words of a sentence off screen for up to five seconds.
                var pause = speaker.silence >= SILENCE_SECONDS && speaker.sinceDecode >= MIN_UTTERANCE_SECONDS;
                if (speaker.sinceDecode < STRIDE_SECONDS && !pause) return;
                // A decode is still running: the audio stays in the window and is
                // handed over the moment the worker is free, instead of being
                // dropped mid-sentence.
                if (!transcribe(uid, windowSamples(speaker), rate, pause)) return;
                speaker.sinceDecode = 0;
                speaker.voiced = false;
                speaker.silence = 0;
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
        if (mode) mode.textContent = languageLabel() + ' · local' + engineLabel();
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

    /**
     * The line for a speaker, capped at MAX_TEXT characters.
     *
     * The cap keeps the END of the text, not the beginning. A 30-second window
     * of continuous speech can decode to several hundred characters, and a later
     * decode of the same audio only ever contributes text past what has been
     * committed — so trimming the front of a line throws away the newest words,
     * which are the ones the reader has not seen, while the words already read
     * are the ones that can afford to scroll off. (This is exactly what a word
     * error rate measurement caught: scoring a 20-second window made both models
     * look like they lost whole sentences, because the panel had dropped them.)
     */
    function cappedText(text) {
        var s = String(text);
        return s.length > MAX_TEXT ? '…' + s.slice(s.length - MAX_TEXT + 1) : s;
    }

    function pushLine(who, text, isFinal) {
        if (!text) return;
        var last = _lines[_lines.length - 1];
        if (last && last.who === who && !last.final) {
            last.text = cappedText(text);
            last.final = !!isFinal;
        } else {
            _lines.push({ who: who, text: cappedText(text), final: !!isFinal, at: Date.now() });
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
        var gpuToggle = document.getElementById('captions-gpu-toggle');
        var line = document.getElementById('captions-status');
        if (t) t.checked = _running;
        if (selfToggle) { selfToggle.checked = includeSelf(); selfToggle.disabled = !_running; }
        if (langSel) langSel.value = language();
        if (gpuToggle) {
            gpuToggle.checked = useGpu();
            // A webview without WebGPU (WebKitGTK, or a machine with no driver)
            // gets a disabled switch and a sentence saying why, rather than a
            // control that silently does nothing.
            gpuToggle.disabled = !gpuSupported();
            var gpuHint = document.getElementById('captions-gpu-hint');
            if (gpuHint) gpuHint.textContent = gpuSupported()
                ? (useGpu() ? 'Running on the GPU.' + (_engine === 'wasm' && _modelState === 'ready' ? ' The GPU refused this model, so it fell back to the CPU.' : '')
                            : 'Running on the CPU.') 
                : 'This webview has no WebGPU support, so captions run on the CPU.';
        }
        var modelSel = document.getElementById('captions-model');
        if (modelSel) modelSel.value = modelSetting();
        if (line) line.textContent = statusText();
        renderBench();
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
        return 'Transcribing ' + n + ' participant' + (n === 1 ? '' : 's') + ' on this device (whisper-' +
            modelLabel().toLowerCase() + ', ' + languageLabel() + engineLabel() + '), ' + CONTEXT_SECONDS +
            ' s windows. ' + total + ' window' + (total === 1 ? '' : 's') + ' decoded. Nothing leaves this device.';
    }

    // ─── benchmark (Settings → Live Captions) ────────────────────────────
    //
    // The switch says which engine to use; it does not say whether the GPU is
    // faster — and on this class of machine it varies enormously (an integrated
    // card, a driver that refuses an int8 model, a laptop on battery can all be
    // slower than four wasm threads). So the switch comes with a measurement
    // next to it: the SAME window is decoded on both engines, in throwaway
    // workers, and the readout shows milliseconds per window, how far ahead of
    // real time that is, and the ratio between them.
    //
    // It never touches the live worker, so it is safe to run during a call, and
    // the audio is either the last real window from the call or a locally
    // generated signal. Nothing is sent anywhere — the model is the bundled one.
    var SAMPLE_RATE = 16000;

    /** A deterministic speech-shaped signal for when no call audio exists yet. */
    function synthWindow(seconds) {
        var n = Math.round(seconds * SAMPLE_RATE);
        var out = new Float32Array(n);
        var seed = 12345;
        for (var i = 0; i < n; i++) {
            var t = i / SAMPLE_RATE;
            // A 3.5 Hz syllable envelope over a few harmonics, plus a little
            // noise: not speech, but the right shape to make the decoder do real
            // work rather than stopping after one token.
            var env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3.5 * t);
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            var noise = (seed / 0x7fffffff - 0.5) * 0.06;
            out[i] = 0.22 * env * (Math.sin(2 * Math.PI * 160 * t) +
                0.6 * Math.sin(2 * Math.PI * 320 * t) +
                0.3 * Math.sin(2 * Math.PI * 640 * t)) + noise;
        }
        return out;
    }

    function benchAudio() {
        if (_lastWindow && _lastWindow.samples && _lastWindow.samples.length >= SAMPLE_RATE) {
            return { samples: _lastWindow.samples, sampleRate: _lastWindow.sampleRate || SAMPLE_RATE, source: 'call' };
        }
        return { samples: synthWindow(CONTEXT_SECONDS), sampleRate: SAMPLE_RATE, source: 'test-signal' };
    }

    /** One engine, one throwaway worker: load, decode `runs` times, report. */
    function benchOne(device, audio, model, lang) {
        return new Promise(function (resolve) {
            var worker;
            try { worker = new Worker(WORKER_URL, { type: 'module' }); }
            catch (e) { resolve({ engine: device, median: 0, timings: [], error: (e && e.message) || 'could not start a worker' }); return; }
            var done = false;
            var timer = setTimeout(function () {
                finish({ engine: device, median: 0, timings: [], error: 'timed out after ' + Math.round(BENCH_TIMEOUT_MS / 1000) + ' s' });
            }, BENCH_TIMEOUT_MS);
            function finish(res) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                try { worker.terminate(); } catch (_) {}
                resolve(res);
            }
            worker.onmessage = function (ev) {
                var m = ev && ev.data;
                if (!m) return;
                if (m.type === 'bench-result') finish(m);
                else if (m.type === 'error' && !m.id) finish({ engine: device, median: 0, timings: [], error: m.message || 'the model would not start' });
            };
            worker.onerror = function (e) { finish({ engine: device, median: 0, timings: [], error: (e && e.message) || 'the worker failed to start' }); };
            var copy = new Float32Array(audio.samples);
            worker.postMessage({
                type: 'bench', id: 1, engine: device, model: model, runs: BENCH_RUNS,
                audio: copy, sampleRate: audio.sampleRate, language: lang || '',
            }, [copy.buffer]);
        });
    }

    /**
     * Decode the same window on the CPU and (if this webview has one) the GPU.
     * Exposed as `__captions.benchmark()` so the settings button and the tests
     * drive the same code, and so the numbers can be reproduced from a console.
     */
    function benchmark(opts) {
        opts = opts || {};
        if (_benchRunning) return Promise.resolve(_bench);
        var audio = opts.audio ? { samples: opts.audio, sampleRate: opts.sampleRate || SAMPLE_RATE, source: 'supplied' } : benchAudio();
        var result = {
            at: Date.now(), model: opts.model || modelSetting(),
            audioSeconds: audio.samples.length / (audio.sampleRate || SAMPLE_RATE),
            source: audio.source,
        };
        _bench = result;
        result.cpu = null;
        result.gpu = null;
        _benchRunning = true;
        _benchStatus = 'Running: each engine loads the model first, so this takes a minute or two…';
        renderBench();
        var devices = (opts.devices || (gpuSupported() ? ['wasm', 'webgpu'] : ['wasm']));
        var chain = Promise.resolve();
        devices.forEach(function (d) {
            chain = chain.then(function () {
                _benchStatus = d === 'wasm' ? 'Measuring the CPU (wasm)…' : 'Measuring the GPU (WebGPU)…';
                renderBench();
                return benchOne(d, audio, result.model, effectiveLanguage()).then(function (res) {
                    result[d === 'wasm' ? 'cpu' : 'gpu'] = res;
                    renderBench();
                });
            });
        });
        return chain.then(function () {
            var cpu = result.cpu, gpu = result.gpu;
            if (cpu && gpu && cpu.median && gpu.median) result.speedup = cpu.median / gpu.median;
            _benchRunning = false;
            _benchStatus = '';
            renderBench();
            return result;
        });
    }

    function fmtMs(ms) { return ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms'; }

    /** The readout under the benchmark button. Plain text, escaped by the DOM. */
    function renderBench() {
        var el = document.getElementById('captions-bench-result');
        var status = document.getElementById('captions-bench-status');
        if (status) status.textContent = _benchStatus || '';
        if (!el) return;
        if (!_bench) { el.style.display = 'none'; el.textContent = ''; return; }
        var window2 = Math.round(_bench.audioSeconds || 0) + ' s window';
        var lines = [];
        function engineLine(label, res) {
            if (!res) return label + ': not run';
            if (res.error) return label + ': not usable here — ' + res.error;
            if (!res.median) return label + ': no timing returned';
            var rt = _bench.audioSeconds ? '  (' + (_bench.audioSeconds / (res.median / 1000)).toFixed(1) + '× real time)' : '';
            return label + ': ' + fmtMs(res.median) + ' per ' + window2 + rt;
        }
        lines.push('Model: whisper-' + _bench.model + ' · ' + window2);
        lines.push(engineLine('CPU (wasm, ' + ((_bench.cpu && _bench.cpu.threads) || '?') + ' thread' + ((_bench.cpu && _bench.cpu.threads) === 1 ? '' : 's') + ')', _bench.cpu));
        if (_bench.gpu) lines.push(engineLine('GPU (WebGPU)', _bench.gpu));
        else if (!gpuSupported()) lines.push('GPU (WebGPU): this webview has no WebGPU, so there is nothing to compare');
        if (_bench.speedup) {
            lines.push('The GPU decodes a window ' + _bench.speedup.toFixed(1) + '× faster than the CPU here.');
        } else if (_bench.cpu && _bench.gpu && _bench.cpu.median && _bench.gpu.median) {
            var ratio = _bench.cpu.median / _bench.gpu.median;
            lines.push('The GPU is ' + ratio.toFixed(2) + '× the CPU speed here (it was not faster).');
        } else if (_bench.cpu && _bench.cpu.median && _bench.gpu && _bench.gpu.error) {
            lines.push('The GPU could not take this model, so the CPU number is the one that counts.');
        }
        var isolated = _bench.cpu && _bench.cpu.isolated;
        if (isolated === false) lines.push('This page is not cross-origin isolated, so the wasm path is single-threaded.');
        lines.push(_bench.source === 'call'
            ? 'Audio: the last window captured from this call, decoded on this device.'
            : 'Audio: a signal generated locally for the measurement — nothing was sent anywhere.');
        el.style.display = '';
        el.textContent = lines.join('\n');
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
        // The detected language is per call (a different call can be a different
        // language), and the last captured window is decrypted call audio: a
        // benchmark may re-derive it, but stopping captions must not keep it.
        _detectedLanguage = '';
        _lastWindow = null;
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
        modelState: function () {
            return {
                state: _modelState, progress: _modelProgress, error: _modelError,
                engine: _engine, model: _workerModel || modelSetting(),
                threads: _threads, isolated: _isolated,
            };
        },
        useGpu: useGpu,
        gpuSupported: gpuSupported,
        setUseGpu: function (on) {
            saveSetting('gpu', on ? '1' : '0');
            refreshUi();
            // The backend is decided when the model is built, so a change needs a
            // fresh worker. Only when captions are actually running: otherwise the
            // next start() picks it up anyway.
            if (_running) { stopWorker(); worker(); }
        },
        engine: function () { return _engine; },
        threads: function () { return _threads; },
        isolated: function () { return _isolated; },
        model: modelSetting,
        setModel: function (name) {
            saveSetting('model', name === 'base' ? 'base' : 'tiny');
            refreshUi();
            // whisper-tiny and whisper-base are different graphs: a change means
            // building the other one from the bundled files (an HTTP cache hit).
            if (_running) { stopWorker(); worker(); }
        },
        detectedLanguage: function () { return _detectedLanguage; },
        // De-duplication of the rolling window is what makes long-form decoding
        // readable, so it is worth being able to check directly.
        _strip: function (committed, text) { return stripCommitted({ committed: committed }, text); },
        // The display cap, so the rule (keep the NEWEST words, mark the cut with
        // an ellipsis) can be pinned without decoding a minute of audio.
        _capped: function (text) { return cappedText(text); },
        _maxText: MAX_TEXT,
        // Push a line exactly as a decode does, so the cap's effect on a LIVE line
        // (replaced in place, newest words kept) can be checked without a call.
        _pushLine: function (who, text, isFinal) { pushLine(who, text, isFinal); return _lines.slice(); },
        benchmark: benchmark,
        benchResult: function () { return _bench; },
        benchRunning: function () { return _benchRunning; },
        speakers: function () { return Object.keys(_speakers); },
        // Test hook: push PCM through the exact path a real participant's tap
        // uses (energy gate -> window -> worker -> labelled line) without needing
        // a live call. Used by tests/captions-local.spec.ts.
        _feedForTest: function (uid, name, audio, sampleRate) {
            var s = _speakers[uid];
            if (!s) {
                s = {
                    uid: uid, name: name || uid, stream: null, windows: 0, inflight: false, pending: null,
                    buf: [], sinceDecode: 0, voiced: false, silence: 0, committed: '', commitPending: false,
                };
                _speakers[uid] = s;
            }
            s.name = name || s.name;
            if (rms(audio) < MIN_SPEECH_RMS) return false;
            var rate = sampleRate || SAMPLE_RATE;
            s.buf.push(new Float32Array(audio));
            trimWindow(s, rate);
            s.sinceDecode += audio.length / rate;
            s.voiced = true;
            // An utterance handed over whole: decode it now, and let the line be
            // final, exactly as a pause-ended utterance would be.
            var ok = transcribe(uid, windowSamples(s), rate, true);
            if (ok) { s.sinceDecode = 0; s.voiced = false; }
            return ok;
        },
        _setModelReadyForTest: function () { _modelState = 'ready'; },
    };

    document.addEventListener('DOMContentLoaded', function () {
        var t = document.getElementById('captions-toggle');
        var selfToggle = document.getElementById('captions-self-toggle');
        var langSel = document.getElementById('captions-language');
        var gpuToggle = document.getElementById('captions-gpu-toggle');
        var modelSel = document.getElementById('captions-model');
        var benchBtn = document.getElementById('captions-bench-btn');

        if (gpuToggle) {
            gpuToggle.addEventListener('change', function () { window.__captions.setUseGpu(this.checked); });
        }
        if (modelSel) {
            modelSel.value = modelSetting();
            modelSel.addEventListener('change', function () { window.__captions.setModel(this.value); });
        }
        if (benchBtn) {
            benchBtn.addEventListener('click', function () {
                if (window.__captions.benchRunning()) return;
                window.__captions.benchmark().catch(function (e) {
                    if (typeof showToast === 'function') showToast('Benchmark failed: ' + ((e && e.message) || e));
                });
            });
        }
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
