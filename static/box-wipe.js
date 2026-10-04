/**
 * The native "clear all app data" overlay — the page half.
 *
 * Loaded only by the shell's own always-on-top overlay window
 * (src-tauri/src/lib.rs, `WIPE_LABEL` / `WIPE_PAGE`). It renders two states:
 *
 *   * the **button** — a small floating control anchored to the bottom-left of
 *     whatever window the app is showing, present from the moment the app
 *     starts, whatever is in the main window (the host's chat page, an error
 *     page, a blank page, the address screen);
 *   * the **panel** — the same "Erase everything / Hide this button / Cancel"
 *     flow the in-page overlay used to offer, with the same two-press arming so
 *     an accidental click cannot erase a device.
 *
 * It owns no state that matters and no wipe logic at all: hiding, geometry and
 * the wipe itself are the shell's (see `WIPE_*` in src-tauri/src/lib.rs). This
 * file emits four events and switches two views, which is why the shell can
 * grant it nothing but the event channel
 * (`src-tauri/capabilities/wipe-overlay.json`).
 *
 * Outside the shell it does nothing: the file is served by the website too, and
 * a browser has no `window.__TAURI__` and no connection for the shell to forget
 * — there, Settings → Clear All Local Data and the `Alt+Shift+W` chord are the
 * same job.
 */
(function () {
    'use strict';

    var T = window.__TAURI__;
    if (!T || !T.event || typeof T.event.emit !== 'function' || typeof T.event.listen !== 'function') {
        return; // a plain browser: nothing here applies
    }

    var ARM_TIMEOUT_MS = 12000;
    var armed = false;
    var armTimer = null;

    var erase = document.getElementById('wipe-erase');
    var status = document.getElementById('wipe-status');

    function emit(name) {
        try {
            var p = T.event.emit(name);
            if (p && typeof p.catch === 'function') p.catch(function () {});
        } catch (_) {}
    }

    function disarm() {
        armed = false;
        if (armTimer) { clearTimeout(armTimer); armTimer = null; }
        erase.textContent = 'Erase everything';
    }

    /** Switch to the button (false) or the panel (true); the shell sizes us. */
    function setOpen(open) {
        document.body.setAttribute('data-open', open ? '1' : '0');
        // A panel that closed for any reason (Cancel, Escape, the wipe itself)
        // must not leave the next open armed: the second press would then erase
        // on a single click.
        disarm();
        status.textContent = '';
        status.style.color = '#949ba4';
        erase.disabled = false;
        if (open) {
            try { document.getElementById('wipe-cancel').focus(); } catch (_) {}
        }
    }

    // The shell tells us which view we are in — including after it decided the
    // panel must close (the wipe navigates the app back to the address screen).
    try {
        var listening = T.event.listen('box:wipe-view', function (event) {
            var payload = event && event.payload;
            setOpen(!!(payload && payload.open));
        });
        if (listening && typeof listening.catch === 'function') listening.catch(function () {});
    } catch (_) {}

    document.getElementById('wipe-button').addEventListener('click', function () {
        emit('box:wipe-open');
    });

    document.getElementById('wipe-cancel').addEventListener('click', function () {
        emit('box:wipe-close');
    });

    document.getElementById('wipe-hide').addEventListener('click', function () {
        // Hides the button for the rest of this run of the app (the shell keeps
        // that in memory, so the next launch always brings it back).
        emit('box:wipe-hide');
    });

    erase.addEventListener('click', function () {
        if (!armed) {
            armed = true;
            erase.textContent = 'Really erase everything?';
            status.style.color = '#ed4245';
            status.textContent = 'Press again to erase. Everything local is deleted and you sign in from scratch.';
            armTimer = setTimeout(disarm, ARM_TIMEOUT_MS);
            return;
        }
        disarm();
        erase.disabled = true;
        erase.textContent = 'Erasing…';
        status.style.color = '#949ba4';
        status.textContent = 'Signing out and erasing everything on this device…';
        emit('box:wipe-run');
    });

    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') emit('box:wipe-close');
    });
})();
