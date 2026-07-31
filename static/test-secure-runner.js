(async function() {
    const resultsDiv = document.getElementById('results');
    const summaryDiv = document.getElementById('summary');
    const statusDiv = document.getElementById('sec-status');

    await sodium.ready;
    await new Promise(r => setTimeout(r, 100));

    let passed = 0;
    let failed = 0;

    function addResult(name, ok, detail) {
        const div = document.createElement('div');
        div.className = 'result ' + (ok ? 'pass' : 'fail');
        div.textContent = (ok ? '\u2713' : '\u2717') + ' ' + name + (detail ? ': ' + detail : '');
        resultsDiv.appendChild(div);
        if (ok) passed++; else failed++;
    }

    function addInfo(msg) {
        const div = document.createElement('div');
        div.className = 'info';
        div.textContent = '\u2139 ' + msg;
        resultsDiv.appendChild(div);
    }

    statusDiv.textContent = '\u2705 _secInit() completed';
    statusDiv.className = 'info';

    try {
        // Test 1: Bootstrap keys are NOT encrypted
        try {
            var devKey = Storage.prototype.getItem.call(localStorage, 'e2e_device_key');
            var encPw = Storage.prototype.getItem.call(localStorage, 'e2e_encrypted_password');
            var devKeyOk = devKey === null || (devKey.length > 0 && devKey.charAt(0) !== '~');
            var encPwOk = encPw === null || (encPw.length > 0 && encPw.charAt(0) !== '~');
            addResult('Bootstrap keys NOT encrypted', devKeyOk && encPwOk,
                (devKey === null && encPw === null) ? '(both absent — pre-login state)' : 'OK');
        } catch (e) { addResult('Bootstrap keys not encrypted', false, e.message); }

        // Test 2: Writing a sensitive key transparently encrypts it
        try {
            var testVal = 'secret-jwt-token-abc123';
            localStorage.setItem('token_test', testVal);
            var raw = window._secGetRaw('token_test');
            var isEncrypted = raw !== null && raw.charAt(0) === '~';
            var viaInterceptor = localStorage.getItem('token_test');
            localStorage.removeItem('token_test');
            addResult('Sensitive value encrypted on write', isEncrypted,
                isEncrypted ? 'Raw: ' + raw.slice(0, 50) + '...' : 'NOT encrypted!');
            addResult('Transparent decrypt via interceptor', viaInterceptor === testVal,
                viaInterceptor === testVal ? 'Round-trip OK' : 'Expected "' + testVal + '", got "' + viaInterceptor + '"');
        } catch (e) { addResult('Sensitive encryption test', false, e.message); }

        // Test 3: Non-sensitive keys stored as plaintext
        try {
            var testVal = 'plaintext-data';
            localStorage.setItem('_plain_test_data', testVal);
            var raw = Storage.prototype.getItem.call(localStorage, '_plain_test_data');
            localStorage.removeItem('_plain_test_data');
            addResult('Non-sensitive key stored as plaintext', raw === testVal,
                raw === testVal ? 'OK' : 'WRONG: ' + String(raw).slice(0, 40));
        } catch (e) { addResult('Non-sensitive key test', false, e.message); }

        // Test 4: Encrypted format validation: ~<tag>.<b64>
        try {
            localStorage.setItem('e2e_test_format', 'format-check');
            var raw2 = window._secGetRaw('e2e_test_format');
            localStorage.removeItem('e2e_test_format');
            var hasMagic = raw2 !== null && raw2.charAt(0) === '~';
            var afterMagic = raw2 ? raw2.substring(1) : '';
            var dotIdx = afterMagic.indexOf('.');
            var hasDot = dotIdx > 0;
            var tagPart = hasDot ? afterMagic.substring(0, dotIdx) : '';
            var tagIs8Hex = /^[0-9a-f]{8}$/.test(tagPart);
            addResult('Encrypted format ~<tag>.<b64>', hasMagic && hasDot && tagIs8Hex,
                (hasMagic && hasDot && tagIs8Hex) ? 'Format OK, tag=' + tagPart : 'Format WRONG');
        } catch (e) { addResult('Encrypted format check', false, e.message); }

        // Test 5: Reading back via public API (_secGet)
        try {
            var testVal = 'api-test-value';
            localStorage.setItem('token_test_api', testVal);
            var fromSecGet = window._secGet('token_test_api');
            var fromRaw = window._secGetRaw('token_test_api');
            localStorage.removeItem('token_test_api');
            addResult('_secGet returns decrypted value', fromSecGet === testVal,
                fromSecGet === testVal ? 'OK' : 'Got: ' + fromSecGet);
            addResult('_secGetRaw shows encrypted form', fromRaw !== null && fromRaw.charAt(0) === '~',
                fromRaw ? 'Raw starts with ~' : 'null');
        } catch (e) { addResult('Public API tests', false, e.message); }

    } catch (e) {
        addResult('Test setup', false, e.message);
    }

    var total = passed + failed;
    var allPass = failed === 0;
    summaryDiv.className = 'summary ' + (allPass ? 'all-pass' : 'has-fail');
    summaryDiv.textContent = allPass
        ? '\uD83C\uDF89 All ' + total + ' tests PASSED!'
        : '\u26A0 ' + passed + '/' + total + ' passed, ' + failed + ' failed';

    // Wire up manual XSS simulation button
    document.getElementById('simulate-xss-btn').addEventListener('click', function() {
        var output = document.getElementById('xss-output');
        var lines = [];
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            var rawVal = Storage.prototype.getItem.call(localStorage, k);
            if (k && rawVal !== null) {
                var display = rawVal.length > 80 ? rawVal.slice(0, 80) + '...' : rawVal;
                var note = '';
                if (display.charAt(0) === '~') {
                    note = ' ← ENCRYPTED (XSS-safe)';
                } else if (k === 'e2e_device_key' || k === 'e2e_encrypted_password') {
                    note = ' ← bootstrap key (needed for key derivation)';
                }
                lines.push(k + ' = ' + display + note);
            }
        }
        output.value = lines.join('\n') || '(no localStorage entries)';
        output.style.color = '#a5d6a7';
    });

    // Wire up storage key fingerprint button
    document.getElementById('show-key-btn').addEventListener('click', function() {
        var output = document.getElementById('key-output');
        try {
            var sskB64 = sessionStorage.getItem('_ssk');
            if (sskB64) {
                var binary = atob(sskB64);
                var fp = '';
                for (var i = 0; i < Math.min(4, binary.length); i++) {
                    fp += binary.charCodeAt(i).toString(16).padStart(2, '0');
                }
                var hasEncPw = Storage.prototype.getItem.call(localStorage, 'e2e_encrypted_password') !== null;
                output.value = 'Storage key fingerprint: ' + fp + '...\n'
                    + 'Key source: ' + (hasEncPw ? 'password-derived ✓ (cross-device)' : 'random fallback (pre-login)');
            } else {
                output.value = 'No storage key in sessionStorage.\nReload the page to initialize.';
            }
        } catch (e) {
            output.value = 'Error: ' + e.message;
        }
    });
})();
