/* Pairing page logic.
   Moved out of an inline <script> in pair.html so the server's
   Content-Security-Policy no longer needs 'unsafe-inline' for scripts. The
   inline onclick= attributes the old markup generated are now real listeners,
   and server-supplied text (ticket errors) is set with textContent instead of
   innerHTML so a hostile string cannot become markup. */
(function () {
    var params = new URLSearchParams(window.location.search);
    var ticketId = params.get('ticket');
    var statusEl = document.getElementById('pairing-status');
    var resultEl = document.getElementById('pairing-result');
    var pwForm = document.getElementById('pairing-password-form');
    var errEl = document.getElementById('pairing-restore-error');
    var _ticketData = null;

    function para(text, cls) {
        var p = document.createElement('p');
        if (cls) p.className = cls;
        p.textContent = text;
        return p;
    }

    function setStatus(text, cls) {
        statusEl.textContent = '';
        statusEl.appendChild(para(text, cls));
    }

    if (!ticketId) {
        setStatus('No pairing ticket found in URL.', 'u-ba86eb68');
        return;
    }

    setStatus('Fetching pairing ticket...');

    fetch('/api/pairing/' + encodeURIComponent(ticketId))
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (data.error) {
                setStatus(data.error, 'u-ba86eb68');
                return;
            }
            if (data.claimed) {
                setStatus('This pairing link has already been used.', 'u-ba86eb68');
                return;
            }
            _ticketData = data;
            var mins = Math.round((new Date(data.expires_at) - Date.now()) / 60000);
            setStatus('Ready to pair. This ticket will expire in ' + mins + ' minutes.');
            var btn = document.createElement('button');
            btn.className = 'u-7158c113';
            btn.type = 'button';
            btn.textContent = 'Claim & Login';
            btn.addEventListener('click', claimTicket);
            statusEl.appendChild(btn);
        })
        .catch(function (e) {
            setStatus('Error: ' + e.message, 'u-ba86eb68');
        });

    function claimTicket() {
        setStatus('Claiming ticket...');
        fetch('/api/pairing/' + encodeURIComponent(ticketId), { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.error) {
                    setStatus(data.error, 'u-ba86eb68');
                    return;
                }
                if (data.token) {
                    localStorage.setItem('token', data.token);
                    // If the server returned the encrypted key blob, prompt for password
                    if (data.encrypted_key_blob && data.key_blob_nonce) {
                        _ticketData = data;
                        setStatus('Paired! Now restore your encryption keys.');
                        pwForm.style.display = '';
                    } else {
                        // No key blob — just redirect
                        statusEl.style.display = 'none';
                        resultEl.style.display = 'block';
                    }
                }
            })
            .catch(function (e) {
                setStatus('Error: ' + e.message, 'u-ba86eb68');
            });
    }

    function restoreKeys() {
        var pw = document.getElementById('pairing-password').value;
        if (!pw) { errEl.textContent = 'Enter your password'; errEl.style.display = ''; return; }
        errEl.style.display = 'none';
        setStatus('Decrypting keys...');
        pwForm.style.display = 'none';

        try {
            // Decrypt the key blob using the password
            var encBlob = _ticketData.encrypted_key_blob;
            var blobNonce = _ticketData.key_blob_nonce;
            var decrypted = E2ECrypto.decryptKeyBundle(encBlob, pw, '', blobNonce);
            if (!decrypted) {
                errEl.textContent = 'Wrong password. Please try again.';
                errEl.style.display = '';
                statusEl.textContent = '';
                pwForm.style.display = '';
                return;
            }
            E2ECrypto.restoreKeyBundle(decrypted);
            setStatus('Keys restored! Redirecting...');
            setTimeout(function () { window.location.href = 'index.html'; }, 1000);
        } catch (e) {
            console.error('Key restoration failed:', e);
            errEl.textContent = 'Failed to restore keys: ' + e.message;
            errEl.style.display = '';
            statusEl.textContent = '';
            pwForm.style.display = '';
        }
    }

    var restoreBtn = document.getElementById('pairing-restore-btn');
    if (restoreBtn) restoreBtn.addEventListener('click', restoreKeys);
})();
