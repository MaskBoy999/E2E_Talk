(async function() {
    const resultsDiv = document.getElementById('results');
    const summaryDiv = document.getElementById('summary');
    const statusDiv = document.getElementById('sodium-status');

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

    function equalBytes(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    try {
        // Wait for sodium to be ready
        await sodium.ready;
        statusDiv.textContent = '\u2705 libsodium initialized (v' + sodium.sodium_version_string() + ')';
        statusDiv.className = 'sodium-status info';

        // Wait a tick for E2ECrypto to be defined
        await new Promise(function(r) { setTimeout(r, 50); });

        if (typeof E2ECrypto === 'undefined') {
            throw new Error('E2ECrypto not defined after sodium.ready');
        }

        var E = E2ECrypto;

        // Test 1: generateIdentityKeyPair
        try {
            var kp = E.generateIdentityKeyPair();
            var ok = kp && kp.publicKey && kp.privateKey && kp.publicKey.length === 32 && kp.privateKey.length === 32;
            addResult('generateIdentityKeyPair', ok, ok ? 'keys generated' : 'invalid keypair');
        } catch (e) { addResult('generateIdentityKeyPair', false, e.message); }

        // Test 2: generateSymmetricKey
        try {
            var k = E.generateSymmetricKey();
            var ok = k && k.length === 32;
            addResult('generateSymmetricKey', ok, ok ? '32 bytes' : 'invalid key');
        } catch (e) { addResult('generateSymmetricKey', false, e.message); }

        // Test 3: Envelope (Authenticated ECDH)
        try {
            var sender = E.generateIdentityKeyPair();
            var recipient = E.generateIdentityKeyPair();
            var msg = new TextEncoder().encode('hello world');
            var enc = E.envelopeEncrypt(msg, recipient.publicKey, sender.privateKey);
            var dec = E.envelopeDecrypt(enc.ciphertext, recipient.privateKey, sender.publicKey, enc.nonce);
            var decStr = new TextDecoder().decode(dec);
            var ok = decStr === 'hello world';
            addResult('envelopeEncrypt/Decrypt (static ECDH)', ok, ok ? 'round-trip OK' : 'mismatch: ' + decStr);
        } catch (e) { addResult('envelopeEncrypt/Decrypt (static ECDH)', false, e.message); }

        // Test 4: AEAD with AAD
        try {
            var symKey = E.generateSymmetricKey();
            var aad = new TextEncoder().encode('frame-123');
            var msg = new TextEncoder().encode('hello world');
            var aeadEnc = E.aeadEncrypt(msg, symKey, aad);
            var aeadDec = E.aeadDecrypt(aeadEnc.ciphertext, symKey, aeadEnc.nonce, aad);
            var aeadStr = new TextDecoder().decode(aeadDec);
            var ok = aeadStr === 'hello world';
            addResult('aeadEncrypt/Decrypt (with AAD)', ok, ok ? 'round-trip OK' : 'mismatch');
        } catch (e) { addResult('aeadEncrypt/Decrypt (with AAD)', false, e.message); }

        // Test 5: AEAD without AAD
        try {
            var symKey = E.generateSymmetricKey();
            var msg = 'plain text without aad';
            var msgBytes = new TextEncoder().encode(msg);
            var enc = E.aeadEncrypt(msgBytes, symKey);
            var dec = E.aeadDecrypt(enc.ciphertext, symKey, enc.nonce);
            var decStr = new TextDecoder().decode(dec);
            var ok = decStr === msg;
            addResult('aeadEncrypt/Decrypt (no AAD)', ok, ok ? 'round-trip OK' : 'mismatch');
        } catch (e) { addResult('aeadEncrypt/Decrypt (no AAD)', false, e.message); }

        // Test 6: AEAD wrong AAD fails
        try {
            var symKey = E.generateSymmetricKey();
            var aad1 = new TextEncoder().encode('correct-aad');
            var aad2 = new TextEncoder().encode('wrong-aad');
            var enc = E.aeadEncrypt('secret data', symKey, aad1);
            var caught = false;
            try { E.aeadDecrypt(enc.ciphertext, symKey, enc.nonce, aad2); }
            catch (_) { caught = true; }
            addResult('AEAD wrong AAD rejected', caught, caught ? 'correctly rejected' : 'WRONG: decrypted with wrong AAD');
        } catch (e) { addResult('AEAD wrong AAD rejected', false, e.message); }

        // Test 7: HMAC
        try {
            var hash1 = E.hmacHex('CODE123', 'server_hmac_key');
            var hash2 = E.hmacHex('CODE123', 'server_hmac_key');
            var hash3 = E.hmacHex('CODE456', 'server_hmac_key');
            var ok = hash1 === hash2 && hash1 !== hash3 && hash1.length === 64;
            addResult('hmacHex', ok, ok ? 'consistent 64-char hex' : 'mismatch');
        } catch (e) { addResult('hmacHex', false, e.message); }

        // Test 8: encryptWithPassword / decryptWithPassword
        try {
            var plaintext = 'my-friend-code-ABCD1234';
            var escrow = E.encryptWithPassword(plaintext, 'correct-horse-battery-staple');
            var decrypted = E.decryptWithPassword(escrow.encrypted_private_key, 'correct-horse-battery-staple', escrow.salt, escrow.nonce);
            var ok = decrypted === plaintext;
            addResult('encryptWithPassword/decryptWithPassword', ok, ok ? 'round-trip OK' : 'mismatch: ' + decrypted);
        } catch (e) { addResult('encryptWithPassword/decryptWithPassword', false, e.message); }

        // Test 9: encryptWithPassword wrong password
        try {
            var escrow = E.encryptWithPassword('secret-code', 'correct-password');
            var decrypted = E.decryptWithPassword(escrow.encrypted_private_key, 'wrong-password', escrow.salt, escrow.nonce);
            var ok = decrypted === null;
            addResult('Wrong password rejected', ok, ok ? 'correctly returned null' : 'WRONG: decrypted with wrong password');
        } catch (e) { addResult('Wrong password rejected', false, e.message); }

        // Test 10: encryptMediaFrame / decryptMediaFrame
        try {
            var key = E.generateSymmetricKey();
            var frameData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
            var encrypted = E.encryptMediaFrame(frameData, key, 123);
            var decrypted = E.decryptMediaFrame(encrypted, key, 123);
            var ok = decrypted.length === frameData.length && decrypted[0] === 1 && decrypted[7] === 8;
            addResult('encryptMediaFrame/decryptMediaFrame', ok, ok ? 'round-trip OK' : 'mismatch');
        } catch (e) { addResult('encryptMediaFrame/decryptMediaFrame', false, e.message); }

        // Test 11: x25519GenerateKeyPair
        try {
            var kp = E.x25519GenerateKeyPair();
            var ok = kp && kp.publicKey.length === 32 && kp.privateKey.length === 32;
            addResult('x25519GenerateKeyPair', ok, ok ? 'keys generated' : 'invalid');
        } catch (e) { addResult('x25519GenerateKeyPair', false, e.message); }

        // Test 12: x25519SharedSecret consistency
        try {
            var alice = E.x25519GenerateKeyPair();
            var bob = E.x25519GenerateKeyPair();
            var secret1 = E.x25519SharedSecret(alice.privateKey, bob.publicKey);
            var secret2 = E.x25519SharedSecret(bob.privateKey, alice.publicKey);
            var ok = secret1.length === 32 && secret2.length === 32 && equalBytes(secret1, secret2);
            addResult('x25519SharedSecret (ECDH symmetry)', ok, ok ? 'shared secrets match' : 'mismatch');
        } catch (e) { addResult('x25519SharedSecret (ECDH symmetry)', false, e.message); }

        // Test 14: Random bytes
        try {
            var r1 = E.randomBytes(16);
            var r2 = E.randomBytes(16);
            var ok = r1.length === 16 && r2.length === 16 && (r1[0] !== r2[0] || r1[5] !== r2[5]);
            addResult('randomBytes', ok, ok ? '16 bytes, seemingly random' : 'not random');
        } catch (e) { addResult('randomBytes', false, e.message); }

        // Test 15: Base64 round-trip
        try {
            var original = new Uint8Array([0, 1, 255, 128, 64, 32, 16, 8, 4, 2]);
            var b64 = E.arrayBufferToBase64(original);
            var restored = new Uint8Array(E.base64ToArrayBuffer(b64));
            var ok = restored.length === original.length && restored[2] === 255;
            addResult('Base64 round-trip', ok, ok ? 'OK' : 'mismatch');
        } catch (e) { addResult('Base64 round-trip', false, e.message); }

        // Test 16: encryptDm / decryptDm
        try {
            var alice = E.generateIdentityKeyPair();
            var bob = E.generateIdentityKeyPair();
            var dmId = 'dm-test-123';
            var msg = 'Hello from Alice!';
            var enc = E.encryptDm(msg, dmId, alice.privateKey, bob.publicKey);
            var dec = E.decryptDm(enc.ciphertext, enc.nonce, dmId, bob.privateKey, alice.publicKey);
            var ok = dec === msg;
            addResult('encryptDm/decryptDm', ok, ok ? 'round-trip OK' : 'mismatch: ' + dec);
        } catch (e) { addResult('encryptDm/decryptDm', false, e.message); }

        // Test 18: encryptFileChunk / decryptFileChunk
        try {
            var key = E.generateFileKey();
            var chunk = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
            var encrypted = E.encryptFileChunk(key, chunk);
            var decrypted = E.decryptFileChunk(key, encrypted);
            var ok = decrypted.length === chunk.length && decrypted[0] === 72;
            addResult('encryptFileChunk/decryptFileChunk', ok, ok ? 'round-trip OK' : 'mismatch');
        } catch (e) { addResult('encryptFileChunk/decryptFileChunk', false, e.message); }

    } catch (e) {
        addResult('Sodium init', false, e.message);
    }

    // Summary
    var total = passed + failed;
    var allPass = failed === 0;
    summaryDiv.className = 'summary ' + (allPass ? 'all-pass' : 'has-fail');
    summaryDiv.textContent = allPass
        ? '\uD83C\uDF89 All ' + total + ' tests PASSED!'
        : '\u26A0 ' + passed + '/' + total + ' passed, ' + failed + ' failed';
})();
