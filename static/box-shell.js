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
 * A plain browser and the desktop box are no-ops: `window.__TAURI__` is absent
 * in a browser, and the desktop has its own window chrome and no hardware Back.
 */
(function () {
    'use strict';

    var tauri = window.__TAURI__;
    if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') return;
    if (!/Android/i.test(navigator.userAgent || '')) return;

    var PLUGIN = 'plugin:box-shell|';
    function call(command, args) {
        return tauri.core.invoke(PLUGIN + command, args || {}).catch(function (e) {
            // Not fatal: a rejected invoke means the bars stay visible / Back
            // keeps its default behaviour, which is the pre-plugin state.
            console.warn('[box-shell] ' + command + ' failed:', e);
        });
    }

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
    if (tauri.event && typeof tauri.event.listen === 'function') {
        tauri.event.listen('box:back', function () {
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
