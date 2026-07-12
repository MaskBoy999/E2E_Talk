document.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('token');
    if (token) {
        window.location.href = 'index.html';
        return;
    }

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
            E2ECrypto.saveIdentityKeyPair(keypair);
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

            localStorage.setItem('token', data.token);
            localStorage.setItem('user', JSON.stringify(data.user));
            window.location.href = 'index.html';
        } catch (err) {
            showError('Server is not running');
            setLoading(registerForm, false);
        }
    });

    // --- Connect with Local Key ---
    const showConnectKey = document.getElementById('show-connect-key');
    const connectKeySection = document.getElementById('connect-key-section');
    const connectKeyError = document.getElementById('connect-key-error');
    const connectKeyBtn = document.getElementById('connect-key-btn');

    showConnectKey.addEventListener('click', (e) => {
        e.preventDefault();
        const isVisible = connectKeySection.style.display !== 'none';
        connectKeySection.style.display = isVisible ? 'none' : 'block';
        connectKeyError.style.display = 'none';
        if (!isVisible) {
            loginForm.style.display = 'none';
            registerForm.style.display = 'none';
        } else {
            loginForm.style.display = 'block';
        }
    });

    connectKeyBtn.addEventListener('click', async () => {
        connectKeyError.style.display = 'none';
        const username = document.getElementById('connect-username').value.trim();
        const password = document.getElementById('connect-password').value;
        const keyInput = document.getElementById('connect-key-input').value.trim();

        if (!username || !password || !keyInput) {
            connectKeyError.textContent = 'Please fill in all fields';
            connectKeyError.style.display = 'block';
            return;
        }

        // Validate and import the private key
        let privateKeyBytes;
        try {
            const binary = atob(keyInput);
            privateKeyBytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) privateKeyBytes[i] = binary.charCodeAt(i);
            if (privateKeyBytes.length !== 32) throw new Error('Key must be 32 bytes');
        } catch (_) {
            connectKeyError.textContent = 'Invalid key format. Must be a base64-encoded 32-byte key.';
            connectKeyError.style.display = 'block';
            return;
        }

        connectKeyBtn.disabled = true;
        connectKeyBtn.textContent = 'Connecting...';

        try {
            // Login first
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            if (!res.ok) {
                connectKeyError.textContent = data.error || 'Wrong username or password';
                connectKeyError.style.display = 'block';
                connectKeyBtn.disabled = false;
                connectKeyBtn.textContent = 'Connect with Key';
                return;
            }

            // Import keypair
            const publicKey = E2ECrypto.x25519DerivePublicKey(privateKeyBytes);
            E2ECrypto.saveIdentityKeyPair({ privateKey: privateKeyBytes, publicKey: publicKey });

            // Upload public key to server
            const publicKeyB64 = E2ECrypto.arrayBufferToBase64(publicKey);
            await fetch('/api/identity/upload', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + data.token,
                },
                body: JSON.stringify({ identity_public_key: publicKeyB64 }),
            });

            localStorage.setItem('token', data.token);
            localStorage.setItem('user', JSON.stringify(data.user));
            window.location.href = 'index.html';
        } catch (err) {
            connectKeyError.textContent = 'Server is not running';
            connectKeyError.style.display = 'block';
            connectKeyBtn.disabled = false;
            connectKeyBtn.textContent = 'Connect with Key';
        }
    });
});
