/**
 * The always-on "clear all app data" overlay.
 *
 * A single floating button that is present on every page of the app — the chat,
 * the login screen and the box's address screen — whether or not a connection
 * exists, and which erases **everything local** and then makes the user enter
 * the server address again. It exists so there is one deliberate control that
 * takes the device back to a clean slate without navigating a settings tree.
 *
 * What it erases, and why each one is here:
 *
 *   - localStorage     — token, keys, every setting, the appearance backup draft,
 *                        the icon-pack drafts, the local search index
 *   - sessionStorage   — per-tab state (including this overlay's own hidden flag)
 *   - cookies          — anything non-HttpOnly; the session cookie is cleared
 *                        server-side by the logout call the page makes first
 *   - IndexedDB        — the notification sounds, the ringtone, the animated
 *                        wallpaper, the offline message queue
 *   - Cache Storage    — the service worker's caches
 *   - in-memory state  — the page is navigated away (or reloaded) at the end, so
 *                        decrypted messages and the live socket die with it
 *   - the box's saved connection — server address and pinned certificate, through
 *                        the shell (see `CLEAR_CONNECTION_EVENT` in
 *                        src-tauri/src/lib.rs). This is the part a page cannot
 *                        do, and without it the next launch would open the app
 *                        window straight back at the old host.
 *
 * Two of those have a policy, and both are inherited from chat.js rather than
 * invented here:
 *
 *   - the **session-duration preference** survives (a plain number, no keys, no
 *     identity data — re-typing it after every wipe is pure friction), and
 *   - the native vault/session ticket dies with the storage it lives in.
 *
 * Hiding the button: pressing it opens a small panel, and "Hide" drops the
 * button for the rest of this *run of the app*. The flag rides in `window.name`,
 * which is the one piece of state that does exactly that: the browser keeps it
 * for the lifetime of the window (so in-app navigation and reloads keep the
 * button hidden, including the box's cross-origin hop between its local address
 * page and the server's page) and drops it when the window — i.e. the app — goes
 * away. Nothing is written to **localStorage** on purpose: a flag that survives a
 * restart would be a flag the user could not get rid of, the exact opposite of a
 * button that is always there when you need it. Backgrounding the app cannot
 * lose it either — nothing here is on a timer, and no `pagehide`/
 * `visibilitychange` handler touches it.
 *
 * sessionStorage carries it too, as a same-origin belt-and-braces, but it is
 * deliberately **not** the carrier that matters: the app's own login-page wipe
 * clears sessionStorage (auth.js, "wipes ALL leftover keys"), so a flag living
 * only there would die the moment the user landed on the login screen — the one
 * screen where "it stays hidden" matters most, because the wipe they just ran
 * sends them there.
 */
(function () {
    'use strict';

    var HIDDEN_KEY = 'e2eOverlayHidden';
    var NAME_PREFIX = 'e2echat-overlay:';
    // The only two keys a wipe keeps. Both are plain numbers set in
    // Settings → Security, and both are worthless to an attacker.
    var KEEP_KEYS = { 'session_duration_seconds': 1, 'reauth_duration_seconds': 1 };

    var _panel = null;
    var _button = null;

    // ── the hidden flag ──────────────────────────────────────────────────

    /**
     * Whether the user hid the button during *this* run of the app.
     *
     * `kind` exists so the tests (and the panel's own messaging) can be honest
     * about where the answer came from: 'session' is the normal path, 'name' is
     * the cross-origin hop, and 'none' means "show it".
     */
    function hiddenState() {
        try {
            if (sessionStorage.getItem(HIDDEN_KEY) === '1') return 'session';
        } catch (_) {}
        try {
            if (window.name && window.name.indexOf(NAME_PREFIX) === 0) {
                return window.name.slice(NAME_PREFIX.length) === 'hidden' ? 'name' : 'none';
            }
        } catch (_) {}
        return 'none';
    }

    function setHidden(hidden) {
        try {
            if (hidden) sessionStorage.setItem(HIDDEN_KEY, '1');
            else sessionStorage.removeItem(HIDDEN_KEY);
        } catch (_) {}
        try {
            // The carrier that counts (see the file header): a plain string owned
            // by the browsing context, preserved across every navigation in this
            // window — including the box's local→remote hop — and gone when the
            // app is restarted. Nothing else in the app uses it (checked).
            if (hidden) window.name = NAME_PREFIX + 'hidden';
            else if (window.name && window.name.indexOf(NAME_PREFIX) === 0) window.name = '';
        } catch (_) {}
    }

    // ── the wipe ─────────────────────────────────────────────────────────

    /** Everything local, synchronously where it can be, awaited where it cannot. */
    function wipeLocalData() {
        // localStorage: iterate-and-skip, never `clear()` — the same shape the
        // login-page wipe uses, so a full quota cannot make the wipe throw
        // halfway through.
        var keys = [];
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k) keys.push(k);
        }
        for (var j = 0; j < keys.length; j++) {
            if (KEEP_KEYS[keys[j]]) continue;
            try { Storage.prototype.removeItem.call(localStorage, keys[j]); } catch (_) {}
        }
        try { sessionStorage.clear(); } catch (_) {}
        try {
            document.cookie.split(';').forEach(function (c) {
                document.cookie = c.replace(/^ +/, '').replace(/=.*/, '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/');
            });
        } catch (_) {}

        var done = [];

        // Every IndexedDB database, by name where the browser can list them and
        // by name explicitly where it cannot (older WebKitGTK has no
        // `indexedDB.databases()`), so the audio, the wallpaper and the offline
        // queue all go.
        var known = ['e2e_notif_sound', 'e2e_app_bg', 'e2e-chat-queue'];
        try {
            if (typeof indexedDB.databases === 'function') {
                done.push(indexedDB.databases().then(function (dbs) {
                    (dbs || []).forEach(function (db) {
                        if (db && db.name && known.indexOf(db.name) === -1) known.push(db.name);
                    });
                }, function () {}));
            }
        } catch (_) {}
        known.forEach(function (name) {
            done.push(new Promise(function (resolve) {
                var req;
                try { req = indexedDB.deleteDatabase(name); } catch (_) { return resolve(); }
                // A database another tab still holds open never fires anything, so
                // this must not be able to hang the wipe.
                var timer = setTimeout(resolve, 1500);
                req.onsuccess = req.onerror = req.onblocked = function () {
                    clearTimeout(timer);
                    resolve();
                };
            }));
        });

        try {
            if (window.caches && caches.keys) {
                done.push(caches.keys().then(function (names) {
                    return Promise.all(names.map(function (n) {
                        return caches.delete(n).catch(function () {});
                    }));
                }, function () {}));
            }
        } catch (_) {}

        return Promise.all(done).catch(function () {});
    }

    /** Tell the server to drop this session, while the token still exists. */
    function serverLogout() {
        try {
            var t = localStorage.getItem('token');
            if (!t) return Promise.resolve();
            return fetch('/api/logout', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + t },
            }).catch(function () {});
        } catch (_) {
            return Promise.resolve();
        }
    }

    // ── the shell ────────────────────────────────────────────────────────

    function tauri() {
        try { return window.__TAURI__ || null; } catch (_) { return null; }
    }

    /**
     * Ask the box to forget the saved connection (address + pinned certificate)
     * and put the address screen back in front of the user.
     *
     * The event channel, not `invoke`: the app page is served by the *server*,
     * and Tauri refuses app commands from a remote origin whose capability does
     * not list them (`get_config`/`show_setup` are exactly such commands). The
     * `core:event:default` permission *is* granted to that origin, which is why
     * every other native request in this app (change server, toasts, tray state,
     * the mini window) travels the same way.
     *
     * Returns whether the shell was asked at all; a browser has no connection to
     * forget — its "connection" is the page it was already on.
     */
    function clearNativeConnection() {
        var t = tauri();
        if (!t) return false;
        try {
            if (t.event && t.event.emit) {
                t.event.emit('box:clear-connection');
                return true;
            }
            if (t.core && t.core.invoke) {
                t.core.invoke('reset_connection').catch(function () {});
                return true;
            }
        } catch (_) {}
        return false;
    }

    // ── the overlay itself ───────────────────────────────────────────────

    function el(tag, css, html) {
        var e = document.createElement(tag);
        if (css) e.style.cssText = css;
        if (html != null) e.innerHTML = html;
        return e;
    }

    var BTN = 'font:inherit;font-size:13px;font-weight:600;padding:9px 14px;border-radius:8px;' +
        'cursor:pointer;border:1px solid #3f4147;background:#2b2d31;color:#dbdee1;';

    function buildButton() {
        _button = el('button',
            'position:fixed;left:14px;bottom:14px;z-index:3000;width:42px;height:42px;border-radius:50%;' +
            'border:1px solid #3f4147;background:rgba(43,45,49,0.92);color:#dbdee1;cursor:pointer;' +
            'display:flex;align-items:center;justify-content:center;padding:0;opacity:.72;' +
            'transition:opacity .15s,transform .15s;box-shadow:0 6px 18px rgba(0,0,0,0.45);' +
            '-webkit-app-region:no-drag;');
        _button.id = 'app-wipe-button';
        _button.type = 'button';
        _button.title = 'Clear all app data (and hide this button)';
        _button.setAttribute('aria-label', 'Clear all app data');
        // A shield-with-slash: "wipe", not "delete a message".
        _button.innerHTML = '<svg class="ui-icon" width="19" height="19" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M12 3l7 3v6c0 4-3 7.4-7 9-4-1.6-7-5-7-9V6l7-3z"/><line x1="4" y1="20" x2="20" y2="4"/></svg>';
        _button.addEventListener('mouseenter', function () { _button.style.opacity = '1'; });
        _button.addEventListener('mouseleave', function () { _button.style.opacity = '.72'; });
        _button.addEventListener('click', openPanel);
        document.body.appendChild(_button);
    }

    function closePanel() {
        if (_panel && _panel.parentNode) _panel.parentNode.removeChild(_panel);
        _panel = null;
    }

    function openPanel() {
        closePanel();
        var root = el('div',
            'position:fixed;inset:0;z-index:3001;background:rgba(0,0,0,0.45);display:flex;' +
            'align-items:flex-end;justify-content:flex-start;padding:14px;');
        var panel = el('div',
            'max-width:380px;background:#1e1f22;border:1px solid #3f4147;border-radius:12px;' +
            'padding:16px 16px 14px;color:#dbdee1;box-shadow:0 18px 50px rgba(0,0,0,0.55);' +
            'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px;line-height:1.5;');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Clear all app data');
        panel.setAttribute('data-app-wipe-panel', '');
        panel.innerHTML =
            '<div style="font-size:14px;font-weight:700;margin-bottom:6px">Clear all app data</div>' +
            '<div style="color:#949ba4;margin-bottom:12px">Erases every login, key, setting and cached file ' +
            'stored on this device, and forgets the saved server connection — you will have to enter the ' +
            'address again. Messages stay on the server; they are not deleted. This cannot be undone.</div>' +
            '<div data-app-wipe-status style="min-height:16px;margin-bottom:10px;font-size:12px;color:#949ba4"></div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button type="button" data-app-wipe-erase style="' + BTN +
            'border-color:#ed4245;background:rgba(237,66,69,0.12);color:#ed4245">Erase everything</button>' +
            '<button type="button" data-app-wipe-hide style="' + BTN + '">Hide this button</button>' +
            '<button type="button" data-app-wipe-cancel style="' + BTN + '">Cancel</button>' +
            '</div>';
        root.appendChild(panel);
        root.setAttribute('data-app-wipe-overlay', '');
        // Clicking the backdrop is the same as Cancel.
        root.addEventListener('click', function (e) { if (e.target === root) closePanel(); });
        document.addEventListener('keydown', function esc(e) {
            if (e.key === 'Escape') { closePanel(); document.removeEventListener('keydown', esc); }
        });
        document.body.appendChild(root);
        _panel = root;

        var status = panel.querySelector('[data-app-wipe-status]');
        var erase = panel.querySelector('[data-app-wipe-erase]');
        var armed = false;

        panel.querySelector('[data-app-wipe-cancel]').addEventListener('click', function () {
            closePanel();
        });

        panel.querySelector('[data-app-wipe-hide]').addEventListener('click', function () {
            setHidden(true);
            closePanel();
            if (_button && _button.parentNode) _button.parentNode.removeChild(_button);
            _button = null;
        });

        // Two presses, never one: this is irreversible and the button lives in a
        // corner where a mis-click is easy. The first press arms it, and the
        // arming expires so a random click tomorrow cannot finish the job.
        erase.addEventListener('click', function () {
            if (!armed) {
                armed = true;
                erase.textContent = 'Really erase everything?';
                status.style.color = '#ed4245';
                status.textContent = 'Press again to erase. Everything local is deleted and you sign in from scratch.';
                setTimeout(function () {
                    if (!armed) return;
                    armed = false;
                    erase.textContent = 'Erase everything';
                    status.style.color = '#949ba4';
                    status.textContent = '';
                }, 12000);
                return;
            }
            armed = false;
            erase.disabled = true;
            erase.textContent = 'Erasing…';
            status.style.color = '#949ba4';
            status.textContent = 'Signing out…';

            // 1. drop the socket/call first, so nothing new arrives mid-wipe. The
            //    page is navigated away at the end regardless, but a live call
            //    should not keep talking to the server while it is being erased.
            try { if (window.VoiceManager && VoiceManager.leaveVoiceChannel) VoiceManager.leaveVoiceChannel(); } catch (_) {}
            try {
                var w = window.ws;
                if (w && w.close) w.close();
            } catch (_) {}

            // 2. server-side logout while the token still exists, 3. the local wipe.
            serverLogout().then(wipeLocalData).then(function () {
                status.textContent = 'Erasing…';
                // 4. the connection itself. On the box the shell takes the window
                //    back to the address screen; a browser just goes to login.
                var asked = clearNativeConnection();
                if (!asked) {
                    try { window.location.href = '/login.html?wiped=1'; } catch (_) {}
                    return;
                }
                // The shell closes or re-points this window; if it somehow does
                // not, land on the address screen anyway.
                setTimeout(function () {
                    try { window.location.href = '/login.html?wiped=1'; } catch (_) {}
                }, 2500);
            });
        });
    }

    function boot() {
        // The mini call-controls window is a 320x170 strip of buttons with no
        // chat, no storage of its own and no business offering a wipe.
        try {
            if (/[?&]mini=1\b/.test(window.location.search)) return;
        } catch (_) {}
        if (hiddenState() !== 'none') return;
        if (!document.body) return;
        buildButton();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    window.__appWipe = {
        wipe: wipeLocalData,
        logout: serverLogout,
        clearConnection: clearNativeConnection,
        hidden: function () { return hiddenState(); },
        setHidden: setHidden,
        button: function () { return _button; },
    };
})();
