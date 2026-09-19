// Push notification registration.
//
// Loaded by index.html after login. Two transports, one server endpoint:
//
//  * Web Push (VAPID) — browsers and the desktop box. Asks the server for its
//    VAPID public key, subscribes the service worker, and registers the
//    subscription (endpoint + ECDH keys) so the server can wake this device
//    with a metadata-only payload while the app is closed.
//  * FCM (Android) — the Android WebView has no Web Push/Push API, so the
//    native box side hands us a Firebase registration token instead. The token
//    arrives either as `window.__BOX_FCM_TOKEN__` (set by the native plugin) or
//    from `plugin:push-service|getToken`; both are optional and their absence
//    is a silent no-op (Android push simply stays off until a Firebase project
//    is configured — see WEBSITE_IN_A_BOX_MASTER_PLAN.md §A3.5).
//
// In every case the banner says "New message" and tapping opens the app, which
// then syncs over the normal end-to-end encrypted channel. Message plaintext
// never travels through push.
//
// Browser support: Chrome/Edge/Firefox desktop + Android. iOS Safari ≥16.4 in
// "installed to home screen" mode. Unsupported browsers: silent no-op.
(function () {
    'use strict';

    var LS_KEY = 'push_endpoint';
    var LS_FCM = 'push_fcm_token';

    function token() {
        try { return localStorage.getItem('token'); } catch (_) { return null; }
    }

    function b64ToUint8(base64) {
        var padding = '='.repeat((4 - (base64.length % 4)) % 4);
        var b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
        var raw = atob(b64);
        var out = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }

    function postRegister(body) {
        var t = token();
        if (!t) return Promise.resolve(false);
        return fetch('/api/push/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t },
            body: JSON.stringify(body)
        }).then(function (r) { return r.ok; }).catch(function (e) {
            console.warn('[push] register failed:', e);
            return false;
        });
    }

    function unregisterWithServer(tok) {
        var t = token();
        if (!t) return;
        fetch('/api/push/unregister', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t },
            body: JSON.stringify({ token: tok })
        }).catch(function () {});
    }

    // ── Web Push ─────────────────────────────────────────────────────────

    function regWithServer(sub) {
        var j = sub.toJSON();
        return postRegister({
            platform: 'web',
            token: sub.endpoint,
            p256dh: j.keys && j.keys.p256dh,
            auth: j.keys && j.keys.auth
        }).then(function (ok) {
            if (ok) { try { localStorage.setItem(LS_KEY, sub.endpoint); } catch (_) {} }
        });
    }

    function subscribe(swReg) {
        if (!('pushManager' in swReg) || !window.isSecureContext) return;
        fetch('/api/push/vapid-public-key')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                if (!data || !data.publicKey) return;
                return swReg.pushManager.getSubscription().then(function (existing) {
                    if (existing) {
                        // Re-register on every boot: keeps the server's user
                        // mapping fresh after re-login and re-syncs keys.
                        return regWithServer(existing);
                    }
                    return swReg.pushManager.subscribe({
                        userVisibleOnly: true,
                        applicationServerKey: b64ToUint8(data.publicKey)
                    }).then(regWithServer);
                });
            })
            .catch(function (e) { console.warn('[push] subscribe failed:', e); });
    }

    function startWebPush() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window) || !token()) return;
        navigator.serviceWorker.ready
            .then(function (swReg) { subscribe(swReg); })
            .catch(function () {});
    }

    // ── FCM (Android box) ────────────────────────────────────────────────

    function isAndroidBox() {
        var tauri = window.__TAURI__;
        return !!(tauri && tauri.core && tauri.core.invoke) &&
            /Android/i.test(navigator.userAgent || '');
    }

    // Resolve the current FCM token, preferring the value the native side
    // already injected, else asking the optional push-service plugin.
    function fcmToken() {
        if (window.__BOX_FCM_TOKEN__) return Promise.resolve(window.__BOX_FCM_TOKEN__);
        if (!isAndroidBox()) return Promise.resolve(null);
        return window.__TAURI__.core
            .invoke('plugin:push-service|getToken')
            .catch(function () { return null; });
    }

    function startFcm() {
        if (!isAndroidBox() || !token()) return;
        fcmToken().then(function (tok) {
            if (!tok || tok === localStorage.getItem(LS_FCM)) return;
            postRegister({ platform: 'android', token: tok }).then(function (ok) {
                if (ok) { try { localStorage.setItem(LS_FCM, tok); } catch (_) {} }
            });
        });
    }

    // A native plugin can announce a refreshed token at any time.
    window.addEventListener('box-fcm-token', function (ev) {
        var tok = ev && ev.detail;
        if (!tok) return;
        postRegister({ platform: 'android', token: tok }).then(function (ok) {
            if (ok) { try { localStorage.setItem(LS_FCM, tok); } catch (_) {} }
        });
    });

    // ── Lifecycle ────────────────────────────────────────────────────────

    function start() {
        startWebPush();
        startFcm();
    }

    // Re-run after login/logout cycles: token() changes.
    window.addEventListener('focus', function () {
        try {
            var t = token();
            if (t && !localStorage.getItem(LS_KEY)) start();
            if (t) startFcm();
            if (!t) {
                if (localStorage.getItem(LS_KEY)) {
                    unregisterWithServer(localStorage.getItem(LS_KEY));
                    localStorage.removeItem(LS_KEY);
                }
                if (localStorage.getItem(LS_FCM)) {
                    unregisterWithServer(localStorage.getItem(LS_FCM));
                    localStorage.removeItem(LS_FCM);
                }
            }
        } catch (_) {}
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
