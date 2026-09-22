/**
 * Android shell bridge — immersive system bars + a Back button that closes the
 * current layer instead of the app.
 *
 * Talks to the committed `box-shell` plugin
 * (`src-tauri/plugins/box-shell/`), whose Kotlin half does the two things the
 * generated Android project cannot be asked for (edits in `src-tauri/gen/`
 * are lost the next time the project is generated):
 *
 *   1. hides the status bar and the navigation/gesture bar, with
 *      `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` — so dragging a finger down from
 *      the top of the screen (or up from the bottom) brings the bar in for a
 *      moment and then it leaves again, instead of the two strips sitting over
 *      the app's top and bottom buttons for good;
 *   2. routes the hardware Back button to the page. Back is *"click outside my
 *      current focus"*: the page closes its topmost open layer, and only when
 *      there is nothing left to close does it leave the app.
 *
 * It also installs the two device bridges the WebView cannot provide, both
 * served by the same plugin:
 *
 *   3. `window.boxHaptic(pattern)` — buzz the phone's **real vibrator**.
 *      Chromium **disabled the Vibration API on Android in v79** and left the
 *      interface in place: `navigator.vibrate` is defined, is not blocked,
 *      returns `true` while the page is visible, and does nothing at all. Every
 *      cue in the app (incoming call, ring→waiting, notifications, and the
 *      Settings → "Test pattern" buttons — exactly where a user goes to check)
 *      therefore worked in a browser and was silently dead in the Android app.
 *      `VibrationEffect.createWaveform` plays the configured pattern as one
 *      hardware waveform.
 *   4. `window.boxClearNotifications()` — empty the shade when the app comes
 *      back to the front. Notifications the user had already read used to stay
 *      there for good, because the notification plugin's shim posts a plain
 *      object with no `close()`. An ongoing call's notification is deliberately
 *      kept: while a call is up it *is* the call's presence in the shade.
 *
 * Unlike 1 and 2, the haptics helper is installed on **every** page — the box
 * needs the plugin, while a browser and the desktop box fall back to the web
 * Vibration API — because it is the app's one haptic entry point. Otherwise a
 * plain browser and the desktop box are no-ops: `window.__TAURI__` is absent in
 * a browser, and the desktop has its own window chrome and no hardware Back.
 */
(function () {
    'use strict';

    var PLUGIN = 'plugin:box-shell|';

    // Read the bridge live rather than capturing it: a page that gains
    // `window.__TAURI__` after this file has run still reaches the plugin.
    function bridge() {
        var t = window.__TAURI__;
        return (t && t.core && typeof t.core.invoke === 'function') ? t : null;
    }

    // The box is the *Android* box: the bridge is present AND the shell is
    // Android. Desktop has the bridge but no Android shell, and a browser has
    // neither — the UA guard is what keeps both out of the way.
    function isAndroidBox() {
        return !!bridge() && /Android/i.test(navigator.userAgent || '');
    }

    function call(command, args) {
        var t = bridge();
        if (!t) return Promise.resolve();
        return t.core.invoke(PLUGIN + command, args || {}).catch(function (e) {
            // Not fatal: a rejected invoke means the bars stay visible / Back
            // keeps its default behaviour / the phone does not buzz, which is
            // the pre-plugin state.
            console.warn('[box-shell] ' + command + ' failed:', e);
        });
    }

    // ── 3. Haptics ───────────────────────────────────────────────────────
    //
    // The single entry point for every haptic cue in the app, installed on every
    // page. Inside the box it goes through the plugin's vibrator; everywhere else
    // — a browser, the desktop box, and the test suite — it uses
    // `navigator.vibrate`, which is what the call sites used before. `pattern` is
    // a `navigator.vibrate` array: [buzz, pause, buzz, …]. Returns true when
    // something was actually asked to buzz.
    window.boxHaptic = function (pattern) {
        if (isAndroidBox()) {
            call('vibrate', { pattern: pattern || [] });
            return true;
        }
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
            try { navigator.vibrate(pattern); return true; } catch (_) {}
        }
        return false;
    };

    // One short tap, for the plain UI affordances that used to call
    // `navigator.vibrate(30)` inline (a long press arming a drag, a role pick):
    // the same bridge, with no configurable pattern behind it.
    window.boxBuzz = function (ms) {
        return window.boxHaptic([ms || 30]);
    };

    // ── 4. Notification hygiene ───────────────────────────────────────────
    //
    // Same "the box is in front again" events the immersive re-apply below uses
    // (Android is inconsistent about which one it delivers after a lock-screen
    // cycle or a task switch, and re-running this is free). On desktop and in a
    // browser this is a no-op by construction.
    window.boxClearNotifications = function () {
        if (isAndroidBox()) call('clearNotifications');
    };
    window.addEventListener('focus', window.boxClearNotifications);
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) window.boxClearNotifications();
    });

    if (!isAndroidBox()) return;

    // ── 1. Immersive bars ────────────────────────────────────────────────
    //
    // Android re-shows the system bars on its own after a screen-off/on cycle,
    // a task switch and a rotation, and it drops the very first request if the
    // activity is not focused yet — which is exactly the case while the page is
    // still loading. So this is applied on load (with a couple of retries for
    // the not-yet-focused case) and again whenever the page comes back to the
    // front. The Kotlin plugin also re-applies on resume; re-applying is
    // idempotent.
    function enterImmersive() { call('enterImmersive'); }

    enterImmersive();
    setTimeout(enterImmersive, 300);
    setTimeout(enterImmersive, 1200);
    window.addEventListener('focus', enterImmersive);
    window.addEventListener('resize', enterImmersive);
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) enterImmersive();
    });

    // ── 2. Back button ───────────────────────────────────────────────────
    //
    // `setBackHandler` installs the native callback; from then on Back arrives
    // here as `box:back` instead of finishing the activity.
    var backBridge = bridge();
    if (backBridge && backBridge.event && typeof backBridge.event.listen === 'function') {
        backBridge.event.listen('box:back', function () {
            var closed = false;
            try {
                // Defined in chat.js: the same function Escape uses, so the two
                // can never disagree about what "the top layer" is. Absent on
                // pages without chat.js (the setup screen), where there is
                // nothing to close either.
                closed = typeof window._boxCloseTopLayer === 'function' && window._boxCloseTopLayer() === true;
            } catch (e) {
                console.warn('[box-shell] closing the top layer failed:', e);
            }
            if (!closed) call('exit');
        });
    }
    call('setBackHandler', { active: true });
})();
