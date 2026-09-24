/**
 * On-device live captions (1.7, FEATURE_PLAN.md).
 *
 * ===== THE RULE THIS FILE EXISTS TO KEEP =====
 *
 * A transcript of a call is a transcript of the call. The plan's exploit review
 * is explicit, and this module is built around it:
 *
 *   1. The engine must be OFFLINE. Android's SpeechRecognizer defaults to a
 *      NETWORK recogniser, which ships the audio to Google — that would break
 *      E2EE far worse than not having captions at all. So captions are only ever
 *      started through the Android box's on-device recogniser, which is asked to
 *      use EXTRA_PREFER_OFFLINE and is refused outright when the device has no
 *      on-device recogniser installed. Every other platform (desktop box, plain
 *      browser, iOS shell) reports "no offline engine" and captions stay OFF:
 *      there is no code path here that falls back to a remote engine.
 *
 *   2. Captions are DISPLAY-ONLY by default. Publishing them to the other
 *      people in the call is a second, separate toggle, off until asked for, and
 *      it goes out over the call's existing E2EE signal envelope
 *      (window.__voiceSendCaption → voice.js), never a new server route.
 *
 *   3. Captions never touch disk, notifications or logs. Lines live in this
 *      module's memory and in the DOM; stopping captions (or leaving the page)
 *      drops them. Nothing here writes to localStorage, and nothing here logs
 *      the text.
 *
 * What is honest about the coverage: the recogniser hears the MICROPHONE, i.e.
 * what this device's user is saying. Android only lets a system-privileged app
 * (CAPTURE_AUDIO_OUTPUT) capture the remote side of a call, so "captions of
 * everyone else" is not something this implementation claims.
 */

(function () {
    'use strict';

    var PLUGIN = 'plugin:box-shell|';
    var MAX_LINES = 6;
    var MAX_TEXT = 240;

    var _lines = [];          // { who, text, final, at } — memory only
    var _running = false;
    var _status = { available: false, reason: 'unknown', onDevice: false };
    var _unlisten = null;

    function bridge() {
        var t = window.__TAURI__;
        return (t && t.core && typeof t.core.invoke === 'function') ? t : null;
    }

    function isAndroidBox() {
        return !!bridge() && /Android/i.test(navigator.userAgent || '');
    }

    function invoke(cmd, args) {
        var b = bridge();
        if (!b) return Promise.reject(new Error('no bridge'));
        return b.core.invoke(PLUGIN + cmd, args || {});
    }

    function publishEnabled() {
        try { return localStorage.getItem('captionsPublish') === '1'; } catch (_) { return false; }
    }

    function rememberEnabled() {
        try { return localStorage.getItem('captionsEnabled') === '1'; } catch (_) { return false; }
    }

    // ─── Rendering (display-only) ────────────────────────────────────────

    function panel() {
        var el = document.getElementById('captions-panel');
        if (el) return el;
        el = document.createElement('div');
        el.id = 'captions-panel';
        el.className = 'captions-panel';
        el.innerHTML = '<div class="captions-head"><span class="captions-title">On-device captions</span>' +
            '<span class="captions-badge" id="captions-mode"></span></div>' +
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
        var mode = document.getElementById('captions-mode');
        if (mode) mode.textContent = publishEnabled() ? 'published to the call' : 'this device only';
    }

    function pushLine(who, text, isFinal) {
        if (!text) return;
        var last = _lines[_lines.length - 1];
        // The recogniser re-sends a growing hypothesis for the same utterance;
        // replace it rather than stacking a line per keystroke of speech.
        if (last && last.who === who && !last.final) {
            last.text = String(text).slice(0, MAX_TEXT);
            last.final = !!isFinal;
        } else {
            _lines.push({ who: who, text: String(text).slice(0, MAX_TEXT), final: !!isFinal, at: Date.now() });
        }
        while (_lines.length > MAX_LINES) _lines.shift();
        // The panel must exist for ANY line, including a peer's published
        // caption: receiving needs no engine on this device (their publish is
        // their opt-in; hiding it behind our own mic would make publishing
        // useless to anyone without an offline recogniser).
        panel();
        renderLines();
        if (_lines.length) {
            var p = document.getElementById('captions-panel');
            if (p) p.classList.add('captions-open');
        }
    }

    /** Called by voice.js for a caption another member published. */
    window.__captionsShowRemote = function (fromUid, signal) {
        if (!signal || !signal.text) return;
        var name = 'Someone';
        try {
            var cache = window.userDisplayNameCache || {};
            var c = cache[fromUid];
            name = (c && (c.display_name || c.username)) || (fromUid ? String(fromUid).slice(0, 6) : 'Someone');
        } catch (_) {}
        pushLine(name, signal.text, signal.final);
    };

    // ─── Engine gate ─────────────────────────────────────────────────────

    /**
     * Ask the box whether an OFFLINE recogniser exists. Everything that is not
     * the Android box answers "no": there is no desktop engine in this build
     * (a bundled whisper.cpp module is what the plan calls for and it is not
     * part of this implementation), and saying so is the only honest answer.
     */
    async function engineStatus(force) {
        if (!force && _status.reason !== 'unknown') return _status;
        if (!isAndroidBox()) {
            _status = {
                available: false,
                onDevice: false,
                reason: /Android/i.test(navigator.userAgent || '') ? 'no-offline-recognizer' : 'not-android',
            };
            return _status;
        }
        try {
            var r = await invoke('captionsAvailable');
            _status = {
                available: !!(r && r.available),
                onDevice: !!(r && r.onDevice),
                reason: (r && r.reason) || ((r && r.available) ? '' : 'no-offline-recognizer'),
            };
        } catch (_) {
            _status = { available: false, onDevice: false, reason: 'bridge-error' };
        }
        return _status;
    }

    function reasonText(s) {
        if (s.available) return 'On-device speech recognition is available. Captions stay on this device unless you publish them.';
        if (s.reason === 'not-android') return 'On-device captions need the Android app (this build has no offline speech engine for this platform, and captions are never sent to an online one).';
        if (s.reason === 'bridge-error') return 'The on-device recogniser could not be reached.';
        return 'This device has no offline speech recogniser installed, so captions cannot run without sending audio off the device — which this app will not do.';
    }

    async function start() {
        var st = await engineStatus(true);
        if (!st.available) return false;   // fail closed: no offline engine, no listening
        try {
            await invoke('captionsStart');
        } catch (_) {
            return false;
        }
        _running = true;
        var el = panel();
        el.classList.add('captions-open');
        renderLines();
        // Recognised text arrives as plugin events; no polling, no persistence.
        try {
            var b = bridge();
            if (b && b.event && typeof b.event.listen === 'function' && !_unlisten) {
                _unlisten = await b.event.listen('box:caption', function (ev) {
                    var p = ev && ev.payload;
                    if (!p || !p.text) return;
                    pushLine('You', p.text, p.final);
                    // Publishing is a SEPARATE opt-in; the default is display-only.
                    if (p.final && publishEnabled() && typeof window.__voiceSendCaption === 'function') {
                        window.__voiceSendCaption(p.text, true);
                    }
                });
            }
        } catch (_) {}
        refreshUi();
        return true;
    }

    async function stop() {
        _running = false;
        try {
            if (isAndroidBox()) await invoke('captionsStop');
        } catch (_) {}
        try { if (typeof _unlisten === 'function') _unlisten(); } catch (_) {}
        _unlisten = null;
        var el = document.getElementById('captions-panel');
        if (el) el.classList.remove('captions-open');
        // Captions are the most sensitive thing this file touches: dropping them
        // on stop is the point (they are never written down in the first place).
        _lines = [];
        renderLines();
        refreshUi();
        return true;
    }

    function refreshUi() {
        var t = document.getElementById('captions-toggle');
        var p = document.getElementById('captions-publish-toggle');
        var line = document.getElementById('captions-status');
        if (t) t.checked = _running;
        if (p) {
            p.checked = publishEnabled();
            p.disabled = !_running;
        }
        if (line) {
            var s = _status;
            line.textContent = _running
                ? 'Listening on this device — ' + (publishEnabled() ? 'your lines are published to the call.' : 'your lines are shown to you only.')
                : reasonText(s);
        }
        var panelEl = document.getElementById('captions-panel');
        // Open while listening OR while there are lines to read (a published
        // line from a peer shows even when this device's engine is off).
        if (panelEl) panelEl.classList.toggle('captions-open', _running || _lines.length > 0);
    }

    window.__captions = {
        status: function () { return _status; },
        probe: function () { return engineStatus(true).then(function (s) { refreshUi(); return s; }); },
        start: start,
        stop: stop,
        isRunning: function () { return _running; },
        lines: function () { return _lines.slice(); },
        publishEnabled: publishEnabled,
        refreshUi: refreshUi,
    };

    document.addEventListener('DOMContentLoaded', function () {
        var t = document.getElementById('captions-toggle');
        var p = document.getElementById('captions-publish-toggle');
        if (t) {
            t.addEventListener('change', async function () {
                try { localStorage.setItem('captionsEnabled', this.checked ? '1' : '0'); } catch (_) {}
                if (this.checked) {
                    var ok = await start();
                    if (!ok) {
                        this.checked = false;
                        try { localStorage.setItem('captionsEnabled', '0'); } catch (_) {}
                        if (typeof showToast === 'function') showToast(reasonText(_status));
                    }
                } else {
                    await stop();
                }
                refreshUi();
            });
        }
        if (p) {
            p.addEventListener('change', function () {
                try { localStorage.setItem('captionsPublish', this.checked ? '1' : '0'); } catch (_) {}
                renderLines();
                refreshUi();
            });
        }
        // Probe once so the toggle starts with the truth, and honour a previous
        // "on" only when an offline engine is actually there.
        engineStatus(true).then(function (s) {
            if (t) t.disabled = false;
            refreshUi();
            if (rememberEnabled() && s.available) start();
        });
    });
})();
