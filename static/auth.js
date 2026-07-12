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

            // Safely claim a key from the pre-account-scoped storage used by
            // older versions, but only if its public half matches this account.
            try {
                const keyRes = await fetch('/api/identity/' + data.user.id);
                if (keyRes.ok) {
                    const keyData = await keyRes.json();
                    E2ECrypto.claimLegacyIdentityKey(data.user.id, keyData.identity_public_key);
                }
            } catch (_) {}

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
    const scanQrBtn = document.getElementById('scan-qr-btn');
    const qrScannerSection = document.getElementById('qr-scanner-section');
    const qrVideo = document.getElementById('qr-video');
    const stopScanBtn = document.getElementById('stop-scan-btn');
    let qrStream = null;
    let qrScanInterval = null;
    let scannerOriginatedError = false;

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

    // QR Code Scanner
    async function startQrScanner() {
        // Check for secure context (camera requires HTTPS or localhost)
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
            connectKeyError.textContent = isLocalhost
                ? 'Camera not available. Try https://localhost:3443 or grant camera permission in your browser settings.'
                : 'Camera requires HTTPS. Try https://localhost:3443 or paste the key manually.';
            connectKeyError.style.display = 'block';
            scannerOriginatedError = true;
            return;
        }
        try {
            // Try back camera first, fallback to any camera
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment' }
            }).catch(() => navigator.mediaDevices.getUserMedia({ video: true }));
            qrStream = stream;
            qrVideo.srcObject = stream;
            qrScannerSection.style.display = 'block';
            scanQrBtn.style.display = 'none';
            connectKeyError.style.display = 'none';
            // Register cleanup handler when scanner starts
            window.addEventListener('beforeunload', beforeUnloadHandler);

            // Check for BarcodeDetector API support
            if ('BarcodeDetector' in window) {
                try {
                    const detector = new BarcodeDetector({ formats: ['qr_code'] });
                    qrScanInterval = setInterval(async () => {
                        try {
                            const barcodes = await detector.detect(qrVideo);
                            if (barcodes.length > 0) {
                                const key = barcodes[0].rawValue;
                                document.getElementById('connect-key-input').value = key;
                                stopQrScanner();
                                connectKeyError.textContent = 'QR code scanned successfully!';
                                connectKeyError.style.color = '#4caf50';
                                connectKeyError.style.display = 'block';
                                scannerOriginatedError = true;
                            }
                        } catch (e) {
                            // Continue scanning
                        }
                    }, 500);
                } catch (e) {
                    // BarcodeDetector constructor threw - unsupported format
                    connectKeyError.textContent = 'QR code detection not supported in this browser. Please paste the key manually.';
                    connectKeyError.style.color = '#ff9800';
                    connectKeyError.style.display = 'block';
                    scannerOriginatedError = true;
                }
            } else {
                // Fallback: display message that QR scanning needs a modern browser
                connectKeyError.textContent = 'QR scanning requires a modern browser. Please paste the key manually.';
                connectKeyError.style.color = '#ff9800';
                connectKeyError.style.display = 'block';
                scannerOriginatedError = true;
            }
        } catch (err) {
            console.error('Camera access denied:', err);
            connectKeyError.textContent = 'Camera access denied. Please allow camera permission and try again.';
            connectKeyError.style.display = 'block';
            scannerOriginatedError = true;
        }
    }

    // Handler to clean up scanner on navigation
    function beforeUnloadHandler() {
        if (qrStream) stopQrScanner();
    }

    function stopQrScanner() {
        if (qrScanInterval) {
            clearInterval(qrScanInterval);
            qrScanInterval = null;
        }
        if (qrStream) {
            qrStream.getTracks().forEach(track => track.stop());
            qrStream = null;
        }
        qrVideo.srcObject = null;
        qrScannerSection.style.display = 'none';
        scanQrBtn.style.display = '';
        // Reset error styling and hide only scanner-originated errors
        connectKeyError.style.removeProperty('color');
        if (scannerOriginatedError) {
            connectKeyError.style.display = 'none';
            scannerOriginatedError = false;
        }
        window.removeEventListener('beforeunload', beforeUnloadHandler);
    }

    if (scanQrBtn) {
        scanQrBtn.addEventListener('click', startQrScanner);
    }
    if (stopScanBtn) {
        stopScanBtn.addEventListener('click', stopQrScanner);
    }

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

            // Import the account's already-established identity. The private
            // key stays on this device; only a matching public key is accepted.
            const publicKey = E2ECrypto.x25519DerivePublicKey(privateKeyBytes);
            const publicKeyB64 = E2ECrypto.arrayBufferToBase64(publicKey);
            const identityRes = await fetch('/api/identity/' + data.user.id);
            const identityData = await identityRes.json();
            if (!identityRes.ok || identityData.identity_public_key !== publicKeyB64) {
                throw new Error('This local key does not belong to that account');
            }

            E2ECrypto.saveIdentityKeyPair({ privateKey: privateKeyBytes, publicKey: publicKey }, data.user.id);

            localStorage.setItem('token', data.token);
            localStorage.setItem('user', JSON.stringify(data.user));
            window.location.href = 'index.html';
        } catch (err) {
            connectKeyError.textContent = err.message || 'Server is not running';
            connectKeyError.style.display = 'block';
            connectKeyBtn.disabled = false;
            connectKeyBtn.textContent = 'Connect with Key';
        }
    });
});
