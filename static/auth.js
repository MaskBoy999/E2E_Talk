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


    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const showRegister = document.getElementById('show-register');
    const showLogin = document.getElementById('show-login');
    const errorDiv = document.getElementById('error-message');

    showRegister.addEventListener('click', (e) => {
        e.preventDefault();
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
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            const data = await res.json();

            if (!res.ok) {
                showError(data.error || 'Wrong username or password');
                setLoading(loginForm, false);
                return;
            }

            // Safely claim a key from the pre-account-scoped storage used by
            // older versions, but only if its public half matches this account.
            try {
                const keyRes = await fetch('/api/identity/' + data.user.id);
                if (keyRes.ok) {
                    const keyData = await keyRes.json();
                    E2ECrypto.claimLegacyIdentityKey(data.user.id, keyData.identity_public_key);
                }
            } catch (_) {}

            // If no local identity key exists, try to recover from escrow
            let identityKeyPair = E2ECrypto.getIdentityKeyPair(data.user.id);
            if (!identityKeyPair) {
                try {
                    const escrowRes = await fetch('/api/identity/escrow', {
                        headers: { 'Authorization': 'Bearer ' + data.token }
                    });
                    if (escrowRes.ok) {
                        const escrowData = await escrowRes.json();
                        const privateKeyB64 = E2ECrypto.decryptKeyFromEscrow(
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

            localStorage.setItem('token', data.token);
            localStorage.setItem('user', JSON.stringify(data.user));
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

        if (!username || !password) {
            showError('Please fill in all fields');
            return;
        }

        if (password.length < 6) {
            showError('Password must be at least 6 characters');
            return;
        }

        setLoading(registerForm, true);

        try {
            // Generate identity keypair for E2E
            const keypair = E2ECrypto.x25519GenerateKeyPair();
            const publicKeyB64 = E2ECrypto.arrayBufferToBase64(keypair.publicKey);

            // Generate friend code client-side, send only the hash
            const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            let friendCode = '';
            for (let i = 0; i < 8; i++) friendCode += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
            const friendCodeHash = E2ECrypto.sha256Hex(friendCode);
            localStorage.setItem('e2e_friend_code', friendCode);

            const res = await fetch('/api/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password, identity_public_key: publicKeyB64, friend_code_hash: friendCodeHash })
            });

            const data = await res.json();

            if (!res.ok) {
                showError(data.error || 'Registration failed');
                setLoading(registerForm, false);
                return;
            }

            // Only persist a new private key after the account has actually
            // been created, and bind it to that account.
            E2ECrypto.saveIdentityKeyPair(keypair, data.user.id);

            localStorage.setItem('token', data.token);
            localStorage.setItem('user', JSON.stringify(data.user));

            // Upload escrowed key in background (non-blocking)
            try {
                const privB64 = E2ECrypto.arrayBufferToBase64(keypair.privateKey);
                const escrow = E2ECrypto.encryptKeyForEscrow(privB64, password);
                fetch('/api/identity/escrow', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + data.token
                    },
                    body: JSON.stringify(escrow)
                });
            } catch (_) {}

            window.location.href = 'index.html';
        } catch (err) {
            showError('Server is not running');
            setLoading(registerForm, false);
        }
    });


});
