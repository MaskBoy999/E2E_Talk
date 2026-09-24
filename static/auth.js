function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Device identity (getDeviceId / getWsDeviceId / getDeviceName) now lives in
// crypto.js, which BOTH login.html and index.html load. It used to be defined
// only here, so the app page had no getWsDeviceId and silently fell back to
// sending the raw device key while the session row held the HMAC.

// Custom session duration chosen in Settings → Security (seconds). Applies to
// login, registration, and re-authentication. Defaults to 30 days; floored at
// 1 minute; capped at 30 days (the server re-clamps defensively).
function getSessionDurationSecs() {
    var v = localStorage.getItem('session_duration_seconds');
    if (v === null) v = localStorage.getItem('reauth_duration_seconds');
    var s = parseInt(v, 10);
    if (!s || s < 60) s = 2592000;
    if (s > 2592000) s = 2592000;
    return s;
}

document.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('token');
    if (token) {
        window.location.href = 'index.html';
        return;
    }

    // --- Wipe ALL leftover client data when arriving on the login page
    // without a session. A stale account's keys/cache must never leak into a
    // new account on this browser: identity keys, server keys, friend codes,
    // ringtone/notification audio cache (IndexedDB), themes, settings, unread
    // markers — none of it is needed when nobody is logged in, and it causes
    // cross-account data leakage (e.g. the ringtone/cache-owner bug). The
    // login/register handlers below recreate everything after auth.
    function wipeAllClientData() {
        // 1) Secure-storage-aware clear: removes sensitive keys, the
        //    in-memory encryption key, and the session key (bypasses the
        //    interceptor). The media caches (fkc_* file keys + profile_key_cache)
        //    survive: same trust level as user_display_name_cache (downloads are
        //    server-gated by friendship/membership), and losing them on a forced
        //    re-login breaks every avatar/banner/emoji until conversation
        //    profiles re-sync. Because the wipe rotates the encryption key, we
        //    must read the plaintexts BEFORE the clear and re-write them AFTER
        //    so they re-encrypt under the new key (and _secReKey migrates them
        //    to the password key on login).
        var _mediaCachePlain = {};
        try {
            if (window._secClearAll) {
                for (var _mi = 0; _mi < localStorage.length; _mi++) {
                    var _mk = localStorage.key(_mi);
                    // user_display_name_cache matches the 'user' sensitive prefix,
                    // so it's removed by the clear like the other media caches.
                    if (_mk && (_mk.indexOf('fkc_') === 0 || _mk === 'profile_key_cache'
                        || _mk === 'user_display_name_cache')) {
                        try {
                            var _mv = window._secGet ? window._secGet(_mk) : localStorage.getItem(_mk);
                            if (_mv !== null) _mediaCachePlain[_mk] = _mv;
                        } catch (_e2) {}
                    }
                }
                window._secClearAll();
                // Re-write the preserved media caches with the post-wipe key.
                for (var _mk2 in _mediaCachePlain) {
                    if (_mediaCachePlain.hasOwnProperty(_mk2)) {
                        try { localStorage.setItem(_mk2, _mediaCachePlain[_mk2]); } catch (_e3) {}
                    }
                }
            }
        } catch (_e) {}
        // 2) Remove EVERYTHING else (non-sensitive keys: themes, settings,
        //    mute flags, volume, invite codes, etc.) via the raw API.
        try {
            var keys = [];
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (k) keys.push(k);
            }
            for (var j = 0; j < keys.length; j++) {
                var wipeKey = keys[j];
                // Preserve the session-duration preference (Settings → Security):
                // a benign browser preference (a plain number, never keys or
                // identity data) that users shouldn't have to re-enter on every
                // login. It survives the wipe and is sent with login/register.
                if (wipeKey === 'session_duration_seconds' || wipeKey === 'reauth_duration_seconds') continue;
                // Preserve the MEDIA caches (fkc_* file keys + user display-name
                // cache) so a forced re-login — session expiry, a server restart
                // that invalidates the token, a remote sign-out — doesn't wipe
                // profile pictures, banners, emojis and stickers. These keys are
                // useless without server-side download authorization (downloads
                // are gated by uploader/friend/server membership), so keeping
                // them leaks no file content to a new account; it only avoids
                // re-deriving/refetching what the previous session already had.
                // Identity keys, server keys, and account state are still wiped.
                if (wipeKey === 'user_display_name_cache') continue;
                if (wipeKey.indexOf('fkc_') === 0) continue;
                // profile_key_cache holds raw decrypted file keys (pfp/banner/
                // profile-data keys) — same download-gated trust level as fkc_*,
                // and losing it on a forced re-login breaks every avatar/banner
                // until the conversation profiles re-sync.
                if (wipeKey === 'profile_key_cache') continue;
                // 5.7: the device-only-search preference is a privacy setting,
                // like the session duration above — a plain flag, carrying no
                // message content. The 5.7 INDEX (e2e_local_search) is NOT
                // preserved: it holds decrypted message text, so it is dropped
                // by _secClearAll() with the rest of the e2e_ keys.
                if (wipeKey === 'localSearchOnly') continue;
                // The "ask for my password after a restart" preference is a
                // one-character flag (see VAULT_ASK_KEY in secure-storage.js),
                // carrying no key material — a re-login should not silently
                // flip an annoyed-by-passwords user back to the lock screen.
                // The KEY COPY it controls is e2e_-prefixed and IS wiped here,
                // and re-written by the login flow when the preference is off.
                if (wipeKey === 'vaultAskPassword') continue;
                Storage.prototype.removeItem.call(localStorage, wipeKey);
            }
        } catch (_) {}
        // 3) Session storage (secure-storage session key + anything else).
        try { sessionStorage.clear(); } catch (_) {}
        // 4) IndexedDB audio cache (ringtone + notification sound blobs).
        try { indexedDB.deleteDatabase('e2e_notif_sound'); } catch (_) {}
    }
    wipeAllClientData();

    // --- Toggle visibility for password inputs ---
    function setupToggleVisibility(btnId, inputId) {
        const btn = document.getElementById(btnId);
        const input = document.getElementById(inputId);
        if (btn && input) {
            let visible = false;
            btn.addEventListener('click', () => {
                visible = !visible;
                input.type = visible ? 'text' : 'password';
                btn.innerHTML = visible ? '<svg class="ui-icon" width="14" height="14"><use href="#icon-eye-off"/></svg>' : '<svg class="ui-icon" width="14" height="14"><use href="#icon-eye"/></svg>';
                btn.classList.toggle('active', visible);
            });
        }
    }
    setupToggleVisibility('toggle-login-password', 'login-password');
    setupToggleVisibility('toggle-register-password', 'register-password');
    setupToggleVisibility('toggle-register-confirm-password', 'register-confirm-password');


    // --- Auto-clear stale HttpOnly cookies from a previous session ---
    // JS cannot read or clear HttpOnly cookies, so we ask the server to clear them.
    // Also clear any client-side non-HttpOnly cookies by overwriting with expired dates.
    function clearClientCookies() {
        document.cookie.split(';').forEach(function(c) {
            document.cookie = c.replace(/^ +/, '').replace(/=.*/, '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/');
        });
    }

    // --- Always clear stale cookies on login page load ---
    // A stale HttpOnly token cookie from a previous session can interfere
    // with admin password setup on a fresh DB (the auto-filled cookie causes
    // the server to behave differently). Since JS can't read HttpOnly cookies,
    // we ask the server to clear them unconditionally on every page load.
    // The /api/logout endpoint handles this safely even without a valid token
    // (it ignores auth errors with let _ = extract_user(...)).
    function clearStaleCookies() {
        // Clear client-side non-HttpOnly cookies first
        clearClientCookies();
        // Then ask the server to clear the HttpOnly cookie
        fetch('/api/logout', { method: 'POST', credentials: 'include' }).catch(function() {});
    }
    clearStaleCookies();

    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const showRegister = document.getElementById('show-register');
    const showLogin = document.getElementById('show-login');
    const errorDiv = document.getElementById('error-message');

    showRegister.addEventListener('click', (e) => {
        e.preventDefault();
        // Clear stale data to avoid FK constraint issues on new registration
        localStorage.removeItem('e2e_friend_code');
        // Remove old E2E identity keys tied to the previous account
        // (keys are account-scoped by user ID suffix, but stale ones may conflict)
        var oldUser = JSON.parse(localStorage.getItem('user') || '{}');
        if (oldUser && oldUser.id) {
            localStorage.removeItem('e2e_identity_private_' + oldUser.id);
            localStorage.removeItem('e2e_identity_public_' + oldUser.id);
        }
        // Clear theme colors so a new user doesn't inherit the previous account's theme
        localStorage.removeItem('theme_color');
        localStorage.removeItem('theme_bg_color');
        loginForm.style.display = 'none';
        registerForm.style.display = 'block';
        errorDiv.style.display = 'none';
    });

    showLogin.addEventListener('click', (e) => {
        e.preventDefault();
        registerForm.style.display = 'none';
        loginForm.style.display = 'block';
        errorDiv.style.display = 'none';
    });

    function showError(msg) {
        errorDiv.textContent = msg;
        errorDiv.style.display = 'block';
    }

    function setLoading(form, loading) {
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = loading;
        btn.textContent = loading ? 'Please wait...' : (form === loginForm ? 'Login' : 'Register');
    }

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorDiv.style.display = 'none';

        const username = document.getElementById('login-username').value.trim();
        const password = document.getElementById('login-password').value;

        if (!username || !password) {
            showError('Please fill in all fields');
            return;
        }

        setLoading(loginForm, true);

        try {
            // Step 1: Fetch encrypted hash_key from server
            let hashKeyBytes = null;
            let ksVerifier = null;
            try {
                const paramsRes = await fetch('/api/auth-params/' + encodeURIComponent(username));
                if (paramsRes.ok) {
                    const params = await paramsRes.json();
                    if (params.encrypted_hash_key && params.hash_key_salt && params.hash_key_nonce) {
                        const hashKeyB64 = E2ECrypto.decryptWithPassword(
                            params.encrypted_hash_key, password,
                            params.hash_key_salt, params.hash_key_nonce
                        );
                        if (hashKeyB64) {
                            hashKeyBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(hashKeyB64));
                            // Cache for reauth — stored AFTER _secReKey below
                            // so secure-storage encrypts with the password-derived key.
                            window._loginAuthKeyB64 = hashKeyB64;
                        }
                    }
                    // Kill Switch: the real password didn't decrypt the hash_key,
                    // so try the kill-switch verifier (Argon2id-wrapped with the
                    // kill-switch password). The raw kill-switch password is NEVER
                    // sent to the server — only this client-decrypted verifier.
                    if (!hashKeyBytes && params.has_kill_switch
                        && params.kill_switch_verifier_encrypted
                        && params.kill_switch_wrap_salt
                        && params.kill_switch_wrap_nonce) {
                        const v = E2ECrypto.decryptWithPassword(
                            params.kill_switch_verifier_encrypted, password,
                            params.kill_switch_wrap_salt, params.kill_switch_wrap_nonce
                        );
                        if (v) ksVerifier = v;
                    }
                }
            } catch (_) {}

            // Step 2: Determine password to send (hashed for new users, raw for legacy)
            var loginPassword;
            if (hashKeyBytes) {
                loginPassword = E2ECrypto.hmacHex(hashKeyBytes, password);
            } else if (ksVerifier) {
                // Kill-switch attempt — send an empty password plus the proof;
                // the server must never see the raw kill-switch password.
                loginPassword = '';
            } else {
                // Legacy fallback: auth-params not available (user registered before
                // client-side hashing). Send raw password — server detects Argon2 hash.
                loginPassword = password;
            }

            // Step 3: Attempt login
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password: loginPassword, kill_switch_proof: ksVerifier || undefined, duration_seconds: getSessionDurationSecs(), device_id: getWsDeviceId(), device_name: getDeviceName() })
            });

            const data = await res.json();

            if (!res.ok) {
                showError(data.error || 'Wrong username or password');
                setLoading(loginForm, false);
                return;
            }

            // 2FA-enabled account: the password step earned a pending token; show
            // the code step — the verified code completes login via /api/login/2fa.
            if (data.two_factor_required) {
                _pending2fa = { pending_token: data.pending_token, password: password, username: username };
                show2FaLoginForm();
                setLoading(loginForm, false);
                return;
            }

            await completeLogin(data, password);
        } catch (err) {
            showError('Server is not running');
            setLoading(loginForm, false);
        }
    });

    // Pending 2FA state while the code step is shown (login + settings flows).
    let _pending2fa = null;

    // Show the 2FA code step and hide the password form.
    function show2FaLoginForm() {
        document.getElementById('login-form').style.display = 'none';
        document.getElementById('login-2fa-form').style.display = 'block';
        const codeInput = document.getElementById('login-2fa-code');
        codeInput.value = '';
        codeInput.focus();
        document.getElementById('login-2fa-error').style.display = 'none';
    }

    // Finalize a successful login: restore keys from the server blob, persist
    // the password/key material locally, and navigate to the app.
    async function completeLogin(data, password) {
        // Clear any friend code left over from a previous account on this
        // browser so a stale code can never be shown for the logged-in user.
        // The correct code is re-established below from the server's encrypted
        // backup (or the key blob bundle), and loadMyFriendCode shows a
        // 'recover with password' prompt if neither is available.
        localStorage.removeItem('e2e_friend_code');

        // Try to restore full key bundle from server (password-encrypted backup)
        let identityKeyPair = E2ECrypto.getIdentityKeyPair(data.user.id);
        let blobRestored = false;
        try {
            const blobRes = await fetch('/api/key-blob', {
                headers: { 'Authorization': 'Bearer ' + data.token }
            });
            if (blobRes.ok) {
                const blobData = await blobRes.json();
                if (blobData.encrypted_blob && blobData.salt && blobData.nonce) {
                    const bundle = E2ECrypto.decryptKeyBundle(
                        blobData.encrypted_blob, password, blobData.salt, blobData.nonce
                    );
                    if (bundle) {
                        E2ECrypto.restoreKeyBundle(bundle);
                        identityKeyPair = E2ECrypto.getIdentityKeyPair(data.user.id);
                        blobRestored = true;
                        // If the server flagged this blob as needing a rebuild
                        // (missing profile_key_cache etc.), or the blob was saved
                        // by an older client without the newest key types (lower
                        // bundle version), the unconditional re-save at the end
                        // of this handler rebuilds it with ALL current keys
                        // (identity, server, file, invite, auth_key, ...).
                        const blobVer = typeof bundle.v === 'number' ? bundle.v : 0;
                        if (blobData.needs_rebuild || blobVer < (window._BUNDLE_VERSION || 2)) {
                            console.log('auth: blob is stale (needs_rebuild=' + !!blobData.needs_rebuild +
                                ', bundle v' + blobVer + ') — will rebuild with complete key set');
                        }
                    }
                }
            }
        } catch (_) {}

        // Store password encrypted at rest with a device-specific key
        try {
            var devKey = localStorage.getItem('e2e_device_key');
            if (!devKey) {
                devKey = E2ECrypto.arrayBufferToBase64(E2ECrypto.randomBytes(32));
                localStorage.setItem('e2e_device_key', devKey);
            }
            var dk = new Uint8Array(E2ECrypto.base64ToArrayBuffer(devKey));
            var encrypted = E2ECrypto.encodeEncryptedFileKey(btoa(password), dk);
            localStorage.setItem('e2e_encrypted_password', encrypted);
            localStorage.removeItem('e2e_password');
        } catch (_) {}

        // Re-key secure-storage from the now-available password so subsequent
        // writes (token, user) use the password-derived key instead of the
        // random fallback key from _secInit()'s pre-login run.
        try { if (window._secReKey) window._secReKey(); } catch (_) {}

        // ── 5.6: migrate the key bootstrap into the Argon2id vault ─────────
        // The password-derived key is active at this point, so it can be sealed
        // for the next cold start. _kvMigrate() proves the vault opens before it
        // deletes the old bootstrap (the plan's "must not leave the old
        // bootstrap readable alongside the new vault"), and it fails closed: if
        // the vault cannot be written and re-opened, the old bootstrap stays and
        // the session continues exactly as before.
        try { if (window._kvMigrate) await window._kvMigrate(password); } catch (_) {}

        // Store auth_key AFTER rekey so it's encrypted with the right key
        if (window._loginAuthKeyB64) {
            localStorage.setItem('e2e_auth_key', window._loginAuthKeyB64);
            delete window._loginAuthKeyB64;
        }

        localStorage.setItem('token', data.token);
        localStorage.setItem('user', JSON.stringify(data.user));

        // Try to recover encrypted friend code from server and decrypt with password
        if (!blobRestored) {
            try {
                const fcRes = await fetch('/api/friend-code', {
                    headers: { 'Authorization': 'Bearer ' + data.token }
                });
                if (fcRes.ok) {
                    const fcData = await fcRes.json();
                    if (fcData.encrypted_friend_code && fcData.salt && fcData.nonce) {
                        const decryptedFC = E2ECrypto.decryptWithPassword(
                            fcData.encrypted_friend_code,
                            password,
                            fcData.salt,
                            fcData.nonce
                        );
                        if (decryptedFC) {
                            localStorage.setItem('e2e_friend_code', decryptedFC);
                        }
                    }
                }
            } catch (_) {}
        }

        // Fetch HMAC key for hashing friend codes and invite codes
        if (!blobRestored) {
            try {
                const hmacRes = await fetch('/api/hmac-key', {
                    headers: { 'Authorization': 'Bearer ' + data.token }
                });
                if (hmacRes.ok) {
                    const hmacData = await hmacRes.json();
                    if (hmacData.hmac_key) {
                        localStorage.setItem('e2e_hmac_key', hmacData.hmac_key);
                    }
                }
            } catch (_) {}
        }

        // Save/update the key blob on the server (ensures backup is current)
        try {
            // Ensure profile_key_cache is present in localStorage before building the bundle,
            // so the blob includes it for future recovery. Even an empty cache entry is better
            // than a missing one — the empty entry seeds localStorage after restore, and
            // subsequent WS profile_key_sync messages populate it.
            if (!localStorage.getItem('profile_key_cache')) {
                localStorage.setItem('profile_key_cache', '{}');
            }
            const bundle = E2ECrypto.buildKeyBundle();
            const enc = E2ECrypto.encryptKeyBundle(bundle, password);
            await fetch('/api/key-blob', {
                method: 'PUT',
                headers: {
                    'Authorization': 'Bearer ' + data.token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    encrypted_blob: enc.encrypted_private_key,
                    salt: enc.salt,
                    nonce: enc.nonce,
                })
            });
        } catch (_) {}

        window.location.href = 'index.html';
    }

    // Two-factor code step: verify and complete the login.
    const login2FaForm = document.getElementById('login-2fa-form');
    if (login2FaForm) {
        login2FaForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const code = document.getElementById('login-2fa-code').value.trim();
            const errEl = document.getElementById('login-2fa-error');
            if (!_pending2fa || !code) return;
            const submitBtn = login2FaForm.querySelector('button[type="submit"]');
            submitBtn.disabled = true;
            try {
                const res = await fetch('/api/login/2fa', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pending_token: _pending2fa.pending_token, code: code })
                });
                const data = await res.json();
                if (!res.ok) {
                    errEl.textContent = data.error || 'Invalid code';
                    errEl.style.display = 'block';
                    submitBtn.disabled = false;
                    // A server-side failure (e.g. a kill-switch deletion just
                    // completed) must not leave the pending token replayable —
                    // the next attempt starts a fresh login instead.
                    if (res.status >= 500 && _pending2fa) {
                        _pending2fa = null;
                        document.getElementById('login-2fa-form').style.display = 'none';
                        document.getElementById('login-form').style.display = 'block';
                        showError(data.error || 'Internal server error');
                    }
                    return;
                }
                const pendingPassword = _pending2fa.password;
                _pending2fa = null;
                await completeLogin(data, pendingPassword);
            } catch (err) {
                errEl.textContent = 'Server is not running';
                errEl.style.display = 'block';
                submitBtn.disabled = false;
            }
        });
        document.getElementById('login-2fa-back').addEventListener('click', () => {
            _pending2fa = null;
            document.getElementById('login-2fa-form').style.display = 'none';
            document.getElementById('login-form').style.display = 'block';
        });
    }

    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorDiv.style.display = 'none';

        const username = document.getElementById('register-username').value.trim();
        const password = document.getElementById('register-password').value;
        const confirmPassword = document.getElementById('register-confirm-password').value;

        if (!username || !password || !confirmPassword) {
            showError('Please fill in all fields');
            return;
        }

        if (password.length < 6) {
            showError('Password must be at least 6 characters');
            return;
        }

        if (password !== confirmPassword) {
            showError('Passwords do not match');
            return;
        }

        setLoading(registerForm, true);

        try {
            // STEP 1: Generate random hash_key (32 bytes) for client-side password hashing
            // The hash_key is encrypted with the raw password and stored on the server.
            // On login, the client fetches the encrypted hash_key, decrypts it with the
            // raw password, derives the pre-hashed password, and sends the hash.
            // The server never sees the raw password.
            const hashKey = E2ECrypto.randomBytes(32);
            const hashKeyB64 = E2ECrypto.arrayBufferToBase64(hashKey);
            const encryptedHashKey = E2ECrypto.encryptWithPassword(hashKeyB64, password);
            const hashedPassword = E2ECrypto.hmacHex(hashKey, password);

            // Cache for later use (reauth, etc.) — stored AFTER _secReKey below
            // so secure-storage encrypts with the password-derived key.
            var _authKeyB64 = hashKeyB64;

            // STEP 2: Fetch the server's HMAC key BEFORE computing friend_code_hash
            // This ensures we always use HMAC-SHA256 (not plain SHA-256 fallback)
            let hmacKey = null;
            try {
                const hmacRes = await fetch('/api/hmac-key');
                if (hmacRes.ok) {
                    const hmacData = await hmacRes.json();
                    if (hmacData.hmac_key) {
                        hmacKey = hmacData.hmac_key;
                    }
                }
            } catch (_) {}

            // Generate identity keypair for E2E
            const keypair = E2ECrypto.x25519GenerateKeyPair();
            const publicKeyB64 = E2ECrypto.arrayBufferToBase64(keypair.publicKey);

            // Encrypt identity private key for escrow (using Argon2id encryptWithPassword)
            const privB64 = E2ECrypto.arrayBufferToBase64(keypair.privateKey);
            const identityEscrow = E2ECrypto.encryptWithPassword(privB64, password);

            // Generate friend code client-side, encrypt with password, send raw code (server salts & hashes)
            const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            const rnd = crypto.getRandomValues(new Uint8Array(16));
            let friendCode = '';
            for (let i = 0; i < 16; i++) friendCode += ALPHABET[rnd[i] % ALPHABET.length];
            const encryptedFC = E2ECrypto.encryptWithPassword(friendCode, password);

            const res = await fetch('/api/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username, password: hashedPassword,
                    duration_seconds: getSessionDurationSecs(),
                    device_id: getWsDeviceId(),
                    device_name: getDeviceName(),
                    encrypted_hash_key: encryptedHashKey.encrypted_private_key,
                    hash_key_salt: encryptedHashKey.salt,
                    hash_key_nonce: encryptedHashKey.nonce,
                    identity_public_key: publicKeyB64,
                    friend_code: friendCode,
                    encrypted_friend_code: encryptedFC.encrypted_private_key,
                    friend_code_salt: encryptedFC.salt,
                    friend_code_nonce: encryptedFC.nonce,
                    // Password-wrapped identity key escrow (Argon2id)
                    encrypted_identity_priv: identityEscrow.encrypted_private_key,
                    escrow_salt: identityEscrow.salt,
                    escrow_nonce: identityEscrow.nonce,
                })
            });

            const data = await res.json();

            if (!res.ok) {
                showError(data.error || 'Registration failed');
                setLoading(registerForm, false);
                return;
            }

            // Clear stale notification state from any previous account on this browser
            localStorage.removeItem('mention_unread_dms');
            localStorage.removeItem('mention_unread_server');
            localStorage.removeItem('mention_unread_channel');
            localStorage.removeItem('mention_items');
            // Store password encrypted at rest with a device-specific key
            try {
                var devKey = localStorage.getItem('e2e_device_key');
                if (!devKey) {
                    devKey = E2ECrypto.arrayBufferToBase64(E2ECrypto.randomBytes(32));
                    localStorage.setItem('e2e_device_key', devKey);
                }
                var dk = new Uint8Array(E2ECrypto.base64ToArrayBuffer(devKey));
                var encrypted = E2ECrypto.encodeEncryptedFileKey(btoa(password), dk);
                localStorage.setItem('e2e_encrypted_password', encrypted);
                localStorage.removeItem('e2e_password');
            } catch (_) {}

            // Re-key secure-storage from the now-available password so subsequent
            // writes use the password-derived key (not the pre-login random fallback).
            try { if (window._secReKey) window._secReKey(); } catch (_) {}

            // 5.6: seal that key into the Argon2id vault and drop the old
            // plaintext bootstrap (see the login handler for the full note).
            try { if (window._kvMigrate) await window._kvMigrate(password); } catch (_) {}

            // Persist ALL e2e_* keys AFTER rekey so secure-storage encrypts them
            // with the password-derived key, making them decryptable on index.html.
            E2ECrypto.saveIdentityKeyPair(keypair, data.user.id);
            if (_authKeyB64) localStorage.setItem('e2e_auth_key', _authKeyB64);
            if (hmacKey) localStorage.setItem('e2e_hmac_key', hmacKey);
            localStorage.setItem('e2e_friend_code', friendCode);
            localStorage.setItem('token', data.token);
            localStorage.setItem('user', JSON.stringify(data.user));

            // Save initial key blob on registration
            try {
                const bundle = E2ECrypto.buildKeyBundle();
                const enc = E2ECrypto.encryptKeyBundle(bundle, password);
                await fetch('/api/key-blob', {
                    method: 'PUT',
                    headers: {
                        'Authorization': 'Bearer ' + data.token,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        encrypted_blob: enc.encrypted_private_key,
                        salt: enc.salt,
                        nonce: enc.nonce,
                    })
                });
            } catch (_) {}

            window.location.href = 'index.html';
        } catch (err) {
            showError('Server is not running');
            setLoading(registerForm, false);
        }
    });

});
