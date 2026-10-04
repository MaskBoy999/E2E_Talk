/* First-run setup screen logic.
   Moved out of an inline <script> in box-setup.html so the page has no inline
   script (the server's CSP no longer allows 'unsafe-inline'; the Tauri shell's
   own CSP never did). */
    var invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) || null;
    var urlInput = document.getElementById('server-url');
    var statusEl = document.getElementById('status');
    var troubleEl = document.getElementById('trouble');
    var testBtn = document.getElementById('test-btn');
    var saveBtn = document.getElementById('save-btn');
    var autoStartEl = document.getElementById('auto-start');
    var minTrayEl = document.getElementById('min-tray');
    var pinCertEl = document.getElementById('pin-cert');
    var certInfoEl = document.getElementById('cert-info');
    var launchErrEl = document.getElementById('launch-error');
    var pinHintEl = document.getElementById('pin-hint');

    // This server's certificate is self-signed, and the pin is the app's only
    // trust anchor for it on **every** platform: `check_pinned_cert` refuses a
    // host that presents a different one, and the sandboxed WebView (WebView2 on
    // Windows, the Android WebView) has to be told to accept the certificate it
    // already verified — otherwise it shows *"Your connection isn't private"*
    // instead of the app. With no pin there is nothing to accept and nothing to
    // compare against, so pinning is not an option the user can switch off.
    var IS_ANDROID = /Android/i.test(navigator.userAgent || '');

    function shortFp(fp) {
        return fp.slice(0, 8) + '…' + fp.slice(-8);
    }

    function setStatus(kind, text) {
        statusEl.className = kind;
        statusEl.textContent = text;
        statusEl.style.display = 'block';
        troubleEl.style.display = kind === 'err' ? 'block' : 'none';
    }

    // Normalize whatever was typed into a full origin. Accepts a bare IP
    // (`100.1.2.3`), an IP with a port, a Tailscale machine name, or a whole
    // pasted URL — and keeps only the origin, so a pasted path like
    // `https://100.1.2.3:3443/chat` becomes `https://100.1.2.3:3443`.
    function normalize(raw) {
        var input = (raw || '').trim();
        if (!input) return input;
        var v = /^https?:\/\//i.test(input) ? input : 'https://' + input;
        // The box's release build blocks cleartext (Android's WebView refuses
        // http:// outright), so an http address can never load here. Warn
        // loudly instead of leaving a blank screen to explain it.
        if (/^http:\/\//i.test(input)) {
            setStatus('err', 'This address uses http:// — the app can only load https://. '
                + 'The server needs its TLS certificate (certs/ next to the database).');
        }
        try {
            var u = new URL(v);
            // Default the port only when none was typed. This has to be tested
            // against the raw input: the URL parser erases an explicit :443
            // (and :80) because it equals the scheme's default, so `u.port`
            // cannot tell us — and we must not rewrite a deliberate :443 to
            // 3443.
            if (!/:[0-9]+(\/|$|\?|#)/.test(input)) u.port = '3443';
            return u.origin;
        } catch (_) {
            return v;
        }
    }

    if (!invoke) {
        setStatus('err', 'This setup screen only works inside the E2E Chat desktop app.');
        document.querySelectorAll('button, input').forEach(function (el) { el.disabled = true; });
    } else {
        // Prefill from any saved config.
        invoke('get_config').then(function (cfg) {
            if (cfg && cfg.server_url) urlInput.value = cfg.server_url;
            if (cfg && typeof cfg.auto_start === 'boolean') autoStartEl.checked = cfg.auto_start;
            if (cfg && typeof cfg.minimize_to_tray === 'boolean') minTrayEl.checked = cfg.minimize_to_tray;
            if (cfg && cfg.pinned_cert_sha256) {
                certInfoEl.style.display = 'block';
                certInfoEl.textContent = 'Trusted certificate: ' + shortFp(cfg.pinned_cert_sha256);
            }
            if (IS_ANDROID) {
                // No tray and no autostart on Android — those two toggles do nothing.
                var desktopOpts = document.getElementById('desktop-opts');
                if (desktopOpts) desktopOpts.style.display = 'none';
            }
            // Pinning is mandatory everywhere — see the note above `IS_ANDROID`.
            pinCertEl.checked = true;
            pinCertEl.disabled = true;
            if (pinHintEl) {
                pinHintEl.textContent = 'The server uses a self-signed certificate. ' +
                    'The app always pins its SHA-256 fingerprint: if the certificate ever ' +
                    'changes without you re-trusting it here, the app refuses to connect.';
            }
            urlInput.focus();
        }).catch(function () {});

        // If startup could not open the app (a changed certificate, a broken
        // address), the Rust side has already brought us back here — say why,
        // instead of looking like the app forgot everything. This only exists
        // because a phone has no console to read.
        invoke('get_startup_error').then(function (msg) {
            if (!msg) return;
            urlInput.value = urlInput.value || '';
            launchErrEl.style.display = 'block';
            launchErrEl.textContent = 'The app could not open the saved server: ' + msg;
        }).catch(function () {});
    }

    testBtn.addEventListener('click', function () {
        if (!invoke) return;
        var url = normalize(urlInput.value);
        urlInput.value = url;
        testBtn.disabled = true;
        setStatus('ok', 'Testing…');
        statusEl.className = '';
        invoke('test_connection', { url: url }).then(function (r) {
            if (r && r.ok) {
                setStatus('ok', r.detail || 'Connected.');
                // A successful test runs through the *pinned* client, so it also
                // proves the live certificate still matches the pin — the reason
                // this screen was shown no longer applies. A failing test must
                // NOT clear it: that message is the only explanation of why the
                // app refused to open, and losing it because the user pressed the
                // button the page invites them to press is worse than a stale line.
                launchErrEl.style.display = 'none';
            } else {
                setStatus('err', (r && r.detail) || 'Could not connect.');
            }
            // Show the fingerprint this host presents right now, so the user
            // can see (and later verify) exactly what they are pinning.
            if (r && r.ok) {
                invoke('probe_certificate', { url: url }).then(function (fp) {
                    certInfoEl.style.display = 'block';
                    certInfoEl.textContent = 'Certificate fingerprint (SHA-256): ' + shortFp(fp);
                }).catch(function () {});
            }
        }).catch(function (e) {
            setStatus('err', String(e && e.message ? e.message : e));
        }).finally(function () {
            testBtn.disabled = false;
        });
    });

    saveBtn.addEventListener('click', function () {
        if (!invoke) return;
        var url = normalize(urlInput.value);
        urlInput.value = url;
        if (!url) { setStatus('err', 'Enter the server address first.'); return; }
        if (/^http:\/\//i.test(url)) {
            setStatus('err', 'The app can only load https:// addresses.');
            return;
        }
        saveBtn.disabled = true;
        setStatus('ok', 'Saving… contacting the server to check its certificate.');
        statusEl.className = '';
        // The Rust side opens the app window and replaces this screen when it
        // succeeds, so this promise resolving is normally invisible. It must
        // never leave the button dead with no explanation, though: a phone has
        // no console to fall back on, so unstick it after the probe's own
        // worst-case timeout and say what happened.
        var done = false;
        var watchdog = setTimeout(function () {
            if (done) return;
            done = true;
            saveBtn.disabled = false;
            setStatus('err', 'The server did not answer in time. Check Tailscale and the '
                + 'address, then press Test connection.');
        }, 25000);
        // Clear all old/stale storage before saving a new server address.
        // This avoids carrying over bugged cookies, encrypted keys, or
        // session tokens from a previous server that can cause black
        // screens, wrong identities, or stale data on the new host.
        try { localStorage.clear(); } catch (_) {}
        try { sessionStorage.clear(); } catch (_) {}
        try { indexedDB.databases().then(function(dbs) { dbs.forEach(function(db) { indexedDB.deleteDatabase(db.name); }); }); } catch (_) {}
        invoke('save_config', {
            serverUrl: url,
            autoStart: autoStartEl.checked,
            minimizeToTray: minTrayEl.checked,
            pinCert: pinCertEl.checked
        }).then(function () {
            done = true;
            clearTimeout(watchdog);
            // The Rust side opens the main window and closes this one.
        }).catch(function (e) {
            done = true;
            clearTimeout(watchdog);
            setStatus('err', String(e && e.message ? e.message : e));
            saveBtn.disabled = false;
        });
    });

    document.getElementById('quit-btn').addEventListener('click', function () {
        if (invoke) invoke('quit_app').catch(function () {});
        else window.close();
    });

    // Echo the address we will actually use, so nobody has to guess whether
    // "100.101.102.103" means https or which port got picked.
    urlInput.addEventListener('blur', function () {
        if (urlInput.value.trim()) urlInput.value = normalize(urlInput.value);
    });

    urlInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') testBtn.click();
    });
