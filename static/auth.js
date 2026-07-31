function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('token');
    if (token) {
        window.location.href = 'index.html';
        return;
    }

    // --- Toggle visibility for password inputs ---
    function setupToggleVisibility(btnId, inputId) {
        const btn = document.getElementById(btnId);
        const input = document.getElementById(inputId);
        if (btn && input) {
            let visible = false;
            btn.addEventListener('click', () => {
                visible = !visible;
                input.type = visible ? 'text' : 'password';
                btn.innerHTML = visible ? '&#128064;' : '&#128065;';
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
                }
            } catch (_) {}

            // Step 2: Determine password to send (hashed for new users, raw for legacy)
            var loginPassword;
            if (hashKeyBytes) {
                loginPassword = E2ECrypto.hmacHex(hashKeyBytes, password);
            } else {
                // Legacy fallback: auth-params not available (user registered before
                // client-side hashing). Send raw password — server detects Argon2 hash.
                loginPassword = password;
            }

            // Step 3: Attempt login
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password: loginPassword })
            });

            const data = await res.json();

            if (!res.ok) {
                showError(data.error || 'Wrong username or password');
                setLoading(loginForm, false);
                return;
            }

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
                            // (missing profile_key_cache etc.), the re-save below will
                            // create a fresh bundle with all local keys included.
                            if (blobData.needs_rebuild) {
                                console.log('auth: blob needs rebuild (flag from server) — Fix 6 will produce a complete bundle');
                            }
                        }
                    }
                }
            } catch (_) {}

            // Fallback: legacy escrow recovery (identity key only)
            if (!identityKeyPair) {
                try {
                    const escrowRes = await fetch('/api/identity/escrow', {
                        headers: { 'Authorization': 'Bearer ' + data.token }
                    });
                    if (escrowRes.ok) {
                        const escrowData = await escrowRes.json();
                        let privateKeyB64 = E2ECrypto.decryptWithPassword(
                            escrowData.encrypted_private_key,
                            password,
                            escrowData.salt,
                            escrowData.nonce
                        );
                        if (privateKeyB64) {
                            const privBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(privateKeyB64));
                            const pubBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(
                                (await (await fetch('/api/identity/' + data.user.id)).json()).identity_public_key
                            ));
                            identityKeyPair = { privateKey: privBytes, publicKey: pubBytes };
                            E2ECrypto.saveIdentityKeyPair(identityKeyPair, data.user.id);
                        }
                    }
                } catch (_) {}
            }

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
        } catch (err) {
            showError('Server is not running');
            setLoading(loginForm, false);
        }
    });

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
            let friendCode = '';
            for (let i = 0; i < 16; i++) friendCode += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
            const encryptedFC = E2ECrypto.encryptWithPassword(friendCode, password);

            const res = await fetch('/api/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username, password: hashedPassword,
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
