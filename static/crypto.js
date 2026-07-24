console.log('crypto.js v8 loaded - libsodium-wrappers-sumo (Streamlined E2EE)');
var E2ECrypto = (() => {
    // ---- sodium initialization ----
    // libsodium is loaded from static/libsodium-sumo.js and libsodium-wrappers.js BEFORE crypto.js.
    // sodium.ready resolves on the microtask queue, so by the time any
    // event handler runs, libsodium is fully initialized.

    // ---- Base64 helpers ----
    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }
    function base64ToArrayBuffer(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
    }
    function concatBuffers() {
        const bufs = [];
        for (let i = 0; i < arguments.length; i++) bufs.push(new Uint8Array(arguments[i]));
        let total = 0;
        for (const b of bufs) total += b.length;
        const r = new Uint8Array(total);
        let off = 0;
        for (const b of bufs) { r.set(b, off); off += b.length; }
        return r;
    }
    function equalBytes(a, b) {
        if (a.length !== b.length) return false;
        let diff = 0;
        for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
        return diff === 0;
    }

    // ---- Random bytes ----
    function randomBytes(n) {
        return sodium.randombytes_buf(n);
    }

    // ---- SHA-256 ----
    function sha256(message) {
        const msg = typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message);
        return sodium.crypto_hash_sha256(msg);
    }
    function sha256Hex(data) {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
        const hash = sha256(bytes);
        let hex = '';
        for (let i = 0; i < hash.length; i++) hex += hash[i].toString(16).padStart(2, '0');
        return hex;
    }

    // ---- HMAC-SHA256 (via libsodium) ----
    // libsodium's crypto_auth_hmacsha256 requires a 32-byte key.
    // If the key is shorter or longer, hash it down to 32 bytes first.
    function hmacSHA256(keyBytes, msgBytes) {
        let k = new Uint8Array(keyBytes);
        // Normalize key to 32 bytes (libsodium's one-shot API requires exactly 32 bytes)
        if (k.length !== 32) {
            k = sha256(k);
        }
        const m = new Uint8Array(msgBytes);
        return sodium.crypto_auth_hmacsha256(m, k);
    }

    // ---- HKDF-SHA256 (built on HMAC-SHA256) ----
    function hkdf(ikm, salt, info, len) {
        const prk = hmacSHA256(ikm, salt);
        const infoBytes = new TextEncoder().encode(info || '');
        let t = new Uint8Array(0);
        const lenNum = len || 32;
        const result = new Uint8Array(lenNum);
        let offset = 0;
        for (let i = 1; offset < lenNum; i++) {
            const input = new Uint8Array(t.length + infoBytes.length + 1);
            input.set(t);
            input.set(infoBytes, t.length);
            input[input.length - 1] = i;
            t = hmacSHA256(prk, input);
            const toCopy = Math.min(t.length, lenNum - offset);
            result.set(t.slice(0, toCopy), offset);
            offset += toCopy;
        }
        return result.slice(0, lenNum);
    }

    // ---- X25519 Key Generation ----
    function x25519GenerateKeyPair() {
        const kp = sodium.crypto_box_keypair();
        return { privateKey: new Uint8Array(kp.privateKey), publicKey: new Uint8Array(kp.publicKey) };
    }
    function x25519DerivePublicKey(privateKeyBytes) {
        return new Uint8Array(sodium.crypto_scalarmult_base(new Uint8Array(privateKeyBytes)));
    }
    function x25519SharedSecret(privateKeyBytes, publicKeyBytes) {
        return new Uint8Array(sodium.crypto_scalarmult(new Uint8Array(privateKeyBytes), new Uint8Array(publicKeyBytes)));
    }

    // ---- XChaCha20-Poly1305 AEAD (via libsodium) ----
    function _aeadEncryptRaw(plaintext, key, aad, nonce) {
        const p = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext);
        const k = key instanceof Uint8Array ? key : new Uint8Array(key);
        const ad = aad instanceof Uint8Array ? aad : (aad ? new TextEncoder().encode(String(aad)) : null);
        const n = nonce || randomBytes(24);
        const ctWithTag = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(p, ad, null, n, k);
        return { ciphertext: new Uint8Array(ctWithTag), nonce: new Uint8Array(n) };
    }

    function _aeadDecryptRaw(combinedCiphertext, key, aad, nonce) {
        const ct = combinedCiphertext instanceof Uint8Array ? combinedCiphertext : new Uint8Array(combinedCiphertext);
        const k = key instanceof Uint8Array ? key : new Uint8Array(key);
        const ad = aad instanceof Uint8Array ? aad : (aad ? new TextEncoder().encode(String(aad)) : null);
        const n = nonce instanceof Uint8Array ? nonce : new Uint8Array(nonce);
        return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, ad, n, k);
    }

    // ---- Envelope Encryption (Static ECDH — Authenticated) ----
    function envelopeEncryptRaw(plaintextBytes, recipientPublicKey) {
        // OLD ephemeral version — kept for backward compat with server_keys
        const eph = x25519GenerateKeyPair();
        const shared = x25519SharedSecret(eph.privateKey, recipientPublicKey);
        const key = hkdf(shared, shared, 'e2e-envelope-v1', 32);
        const enc = _aeadEncryptRaw(plaintextBytes, key, null, null);
        return {
            ciphertext: arrayBufferToBase64(enc.ciphertext),
            nonce: arrayBufferToBase64(enc.nonce),
            ephemeralPublicKey: arrayBufferToBase64(eph.publicKey)
        };
    }
    function envelopeDecryptRaw(ciphertextB64, nonceB64, ephemeralPublicKeyB64, recipientPrivateKey) {
        // OLD ephemeral version
        const ct = new Uint8Array(base64ToArrayBuffer(ciphertextB64));
        const n = new Uint8Array(base64ToArrayBuffer(nonceB64));
        const ephPub = new Uint8Array(base64ToArrayBuffer(ephemeralPublicKeyB64));
        const priv = new Uint8Array(recipientPrivateKey);
        const shared = x25519SharedSecret(priv, ephPub);
        const key = hkdf(shared, shared, 'e2e-envelope-v1', 32);
        return _aeadDecryptRaw(ct, key, null, n);
    }

    // NEW: Authenticated envelope (static ECDH)
    function envelopeEncrypt(plaintext, recipientPublicKey, senderPrivateKey) {
        const shared = x25519SharedSecret(senderPrivateKey, recipientPublicKey);
        const key = hkdf(shared, shared, 'e2e-envelope-v1', 32);
        const pt = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : new Uint8Array(plaintext);
        const enc = _aeadEncryptRaw(pt, key, null, null);
        return { ciphertext: arrayBufferToBase64(enc.ciphertext), nonce: arrayBufferToBase64(enc.nonce) };
    }

    function envelopeDecrypt(ciphertextB64, recipientPrivateKey, senderPublicKey, nonceB64) {
        const ct = new Uint8Array(base64ToArrayBuffer(ciphertextB64));
        const n = new Uint8Array(base64ToArrayBuffer(nonceB64));
        const shared = x25519SharedSecret(recipientPrivateKey, senderPublicKey);
        const key = hkdf(shared, shared, 'e2e-envelope-v1', 32);
        return _aeadDecryptRaw(ct, key, null, n);
    }

    // ---- Simplified AEAD with AAD support ----
    function aeadEncrypt(plaintext, key, aad) {
        const pt = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : new Uint8Array(plaintext);
        const k = key instanceof Uint8Array ? key : new Uint8Array(key);
        const enc = _aeadEncryptRaw(pt, k, aad || null, null);
        return { ciphertext: arrayBufferToBase64(enc.ciphertext), nonce: arrayBufferToBase64(enc.nonce) };
    }

    function aeadDecrypt(ciphertextB64, key, nonceB64, aad) {
        const ct = new Uint8Array(base64ToArrayBuffer(ciphertextB64));
        const k = key instanceof Uint8Array ? key : new Uint8Array(key);
        const n = new Uint8Array(base64ToArrayBuffer(nonceB64));
        return _aeadDecryptRaw(ct, k, aad || null, n);
    }

    // ---- Key Generation ----
    function generateIdentityKeyPair() { return x25519GenerateKeyPair(); }
    function generateSymmetricKey() { return randomBytes(32); }

    // ---- Media Frame Encryption (WebRTC Insertable Streams) ----
    function encryptMediaFrame(frameData, key, frameId) {
        const aad = typeof frameId === 'number'
            ? new Uint8Array([frameId & 0xff, (frameId >> 8) & 0xff])
            : new TextEncoder().encode(String(frameId));
        const enc = _aeadEncryptRaw(frameData, key, aad, null);
        return concatBuffers(enc.nonce, enc.ciphertext);
    }

    function decryptMediaFrame(encryptedFrame, key, frameId) {
        if (encryptedFrame.length < 40) throw new Error('Encrypted frame too short');
        const nonce = encryptedFrame.slice(0, 24);
        const ct = encryptedFrame.slice(24);
        const aad = typeof frameId === 'number'
            ? new Uint8Array([frameId & 0xff, (frameId >> 8) & 0xff])
            : new TextEncoder().encode(String(frameId));
        return _aeadDecryptRaw(ct, key, aad, nonce);
    }

    // ---- Encrypt with Password (Argon2id + AEAD) ----
    function encryptWithPassword(plaintext, password) {
        const salt = randomBytes(16);
        const pwdBytes = new TextEncoder().encode(password);
        const key = sodium.crypto_pwhash(
            32, pwdBytes, salt,
            sodium.crypto_pwhash_OPSLIMIT_MODERATE,
            sodium.crypto_pwhash_MEMLIMIT_MODERATE,
            sodium.crypto_pwhash_ALG_ARGON2ID13
        );
        const ptB64 = btoa(plaintext);
        const ptBytes = new TextEncoder().encode(ptB64);
        const enc = _aeadEncryptRaw(ptBytes, key, null, null);
        return {
            encrypted_private_key: arrayBufferToBase64(enc.ciphertext),
            salt: arrayBufferToBase64(salt),
            nonce: arrayBufferToBase64(enc.nonce)
        };
    }

    function decryptWithPassword(encryptedB64, password, saltB64, nonceB64) {
        const ct = new Uint8Array(base64ToArrayBuffer(encryptedB64));
        const n = new Uint8Array(base64ToArrayBuffer(nonceB64));
        const salt = new Uint8Array(base64ToArrayBuffer(saltB64));
        const pwdBytes = new TextEncoder().encode(password);
        const key = sodium.crypto_pwhash(
            32, pwdBytes, salt,
            sodium.crypto_pwhash_OPSLIMIT_MODERATE,
            sodium.crypto_pwhash_MEMLIMIT_MODERATE,
            sodium.crypto_pwhash_ALG_ARGON2ID13
        );
        try {
            const ptBytes = _aeadDecryptRaw(ct, key, null, n);
            return atob(new TextDecoder().decode(ptBytes));
        } catch (_) { return null; }
    }

    // ---- Profile Data Key (for sharing encrypted profile data) ----
    function generateProfileDataKey() {
        return randomBytes(32);
    }

    function encryptProfileData(jsonString, key) {
        const pt = new TextEncoder().encode(jsonString);
        const enc = _aeadEncryptRaw(pt, key, null, null);
        return { ciphertext: arrayBufferToBase64(enc.ciphertext), nonce: arrayBufferToBase64(enc.nonce) };
    }

    function decryptProfileData(ciphertextB64, nonceB64, key) {
        const ct = new Uint8Array(base64ToArrayBuffer(ciphertextB64));
        const n = new Uint8Array(base64ToArrayBuffer(nonceB64));
        const k = key instanceof Uint8Array ? key : new Uint8Array(key);
        const pt = _aeadDecryptRaw(ct, k, null, n);
        if (!pt) return null;
        return JSON.parse(new TextDecoder().decode(pt));
    }

    // ---- HMAC hex (for invite/friend codes) ----
    function hmacHex(keyBytesOrB64, dataString) {
        let keyBytes;
        if (typeof keyBytesOrB64 === 'string' && keyBytesOrB64.length > 32 && /[+\/=]/.test(keyBytesOrB64)) {
            // Base64-encoded key (contains base64-specific chars)
            keyBytes = new Uint8Array(base64ToArrayBuffer(keyBytesOrB64));
        } else if (keyBytesOrB64 instanceof Uint8Array) {
            keyBytes = keyBytesOrB64;
        } else {
            keyBytes = new TextEncoder().encode(keyBytesOrB64);
        }
        const dataBytes = new TextEncoder().encode(dataString);
        const hash = hmacSHA256(keyBytes, dataBytes);
        let hex = '';
        for (let i = 0; i < hash.length; i++) hex += hash[i].toString(16).padStart(2, '0');
        return hex;
    }

    // ---- Simplified Channel Encryption ----
    function encryptMessage(plaintext, channelKey) { return aeadEncrypt(plaintext, channelKey); }
    function decryptMessage(ciphertextB64, nonceB64, channelKey) {
        var raw = aeadDecrypt(ciphertextB64, channelKey, nonceB64);
        return new TextDecoder().decode(raw);
    }

    // ---- Simplified DM Encryption (ECDH + HKDF per-channel) ----
    function getDmKey(dmChannelId, myPrivateKey, otherPublicKey) {
        const shared = x25519SharedSecret(myPrivateKey, otherPublicKey);
        return hkdf(shared, shared, 'dm-channel:' + dmChannelId, 32);
    }
    function encryptDm(plaintext, dmChannelId, myPrivateKey, otherPublicKey) {
        const dmKey = getDmKey(dmChannelId, myPrivateKey, otherPublicKey);
        return aeadEncrypt(plaintext, dmKey);
    }
    function decryptDm(ciphertextB64, nonceB64, dmChannelId, myPrivateKey, otherPublicKey) {
        const dmKey = getDmKey(dmChannelId, myPrivateKey, otherPublicKey);
        var raw = aeadDecrypt(ciphertextB64, dmKey, nonceB64);
        return new TextDecoder().decode(raw);
    }

    // ---- File Encryption (XChaCha20-Poly1305 chunked) ----
    function generateFileKey() { return randomBytes(32); }
    function encryptFileChunk(fileKey, plaintextChunk) {
        const enc = _aeadEncryptRaw(plaintextChunk, fileKey, null, null);
        return concatBuffers(enc.nonce, enc.ciphertext);
    }
    function decryptFileChunk(fileKey, encryptedChunk) {
        if (encryptedChunk.length < 40) throw new Error('Encrypted chunk too short');
        const nonce = encryptedChunk.slice(0, 24);
        const ct = encryptedChunk.slice(24);
        return _aeadDecryptRaw(ct, fileKey, null, nonce);
    }

    // ---- Key storage in localStorage ----
    function identityStorageSuffix(accountId) {
        if (accountId) return accountId;
        try {
            const currentUser = JSON.parse(localStorage.getItem('user') || 'null');
            return currentUser && currentUser.id ? currentUser.id : null;
        } catch (_) { return null; }
    }
    function getIdentityKeyPair(accountId) {
        const suffix = identityStorageSuffix(accountId);
        if (!suffix) return null;
        const priv = localStorage.getItem('e2e_identity_private_' + suffix);
        const pub = localStorage.getItem('e2e_identity_public_' + suffix);
        if (!priv || !pub) return null;
        return { privateKey: new Uint8Array(base64ToArrayBuffer(priv)), publicKey: new Uint8Array(base64ToArrayBuffer(pub)) };
    }
    function saveIdentityKeyPair(kp, accountId) {
        const suffix = identityStorageSuffix(accountId);
        if (!suffix) throw new Error('Cannot save identity key without account id');
        localStorage.setItem('e2e_identity_private_' + suffix, arrayBufferToBase64(kp.privateKey));
        localStorage.setItem('e2e_identity_public_' + suffix, arrayBufferToBase64(kp.publicKey));
    }

    // ---- Server key storage ----
    function getServerKey(serverId) {
        const key = localStorage.getItem('e2e_server_' + serverId);
        if (!key) return null;
        return new Uint8Array(base64ToArrayBuffer(key));
    }
    function saveServerKey(serverId, key) {
        const oldKey = localStorage.getItem('e2e_server_' + serverId);
        if (oldKey) {
            const history = JSON.parse(localStorage.getItem('e2e_server_history_' + serverId) || '[]');
            history.push(oldKey);
            localStorage.setItem('e2e_server_history_' + serverId, JSON.stringify(history));
        }
        localStorage.setItem('e2e_server_' + serverId, arrayBufferToBase64(key));
    }
    function getAllServerKeys(serverId) {
        const keys = [];
        const current = getServerKey(serverId);
        if (current) keys.push(current);
        const history = JSON.parse(localStorage.getItem('e2e_server_history_' + serverId) || '[]');
        for (let i = 0; i < history.length; i++) keys.push(new Uint8Array(base64ToArrayBuffer(history[i])));
        return keys;
    }
    function removeServerKey(serverId) {
        localStorage.removeItem('e2e_server_' + serverId);
        localStorage.removeItem('e2e_server_history_' + serverId);
    }
    function decryptWithAnyServerKey(ciphertextB64, nonceB64, serverId) {
        const keys = getAllServerKeys(serverId);
        for (let i = 0; i < keys.length; i++) {
            try {
                const dec = aeadDecrypt(ciphertextB64, keys[i], nonceB64);
                if (dec) return dec;
            } catch (_) {}
        }
        return null;
    }

    // ---- File Key Storage helpers (backward compat for auth.js/chat.js) ----
    function encryptFileKeyForStorage(fileKeyB64, symmetricKey) {
        const fileKeyBytes = new Uint8Array(base64ToArrayBuffer(fileKeyB64));
        const enc = _aeadEncryptRaw(fileKeyBytes, symmetricKey, null, null);
        return { ciphertext: arrayBufferToBase64(enc.ciphertext), nonce: arrayBufferToBase64(enc.nonce) };
    }
    function decryptFileKeyFromStorage(ciphertextB64, nonceB64, symmetricKey) {
        const combined = new Uint8Array(base64ToArrayBuffer(ciphertextB64));
        const n = new Uint8Array(base64ToArrayBuffer(nonceB64));
        return arrayBufferToBase64(_aeadDecryptRaw(combined, symmetricKey, null, n));
    }
    function encodeEncryptedFileKey(fileKeyB64, symmetricKey) {
        const result = encryptFileKeyForStorage(fileKeyB64, symmetricKey);
        return result.nonce + ':' + result.ciphertext;
    }
    function decodeEncryptedFileKey(combinedB64, symmetricKey) {
        if (!combinedB64 || typeof combinedB64 !== 'string') return null;
        const parts = combinedB64.split(':');
        if (parts.length === 2 && parts[0].length > 20 && parts[1].length > 20) {
            try { return decryptFileKeyFromStorage(parts[1], parts[0], symmetricKey); }
            catch (_) {}
        }
        return null;
    }

    // ---- Key Escrow ----
    function deriveEscrowKey(password, salt) {
        const pwdBytes = new TextEncoder().encode(password);
        const saltBytes = salt instanceof Uint8Array ? salt : new Uint8Array(base64ToArrayBuffer(salt));
        return hkdf(pwdBytes, saltBytes, 'e2e-key-escrow-v1', 32);
    }
    function encryptKeyForEscrow(privateKeyB64, password) {
        const salt = randomBytes(16);
        const key = deriveEscrowKey(password, salt);
        const plaintext = new Uint8Array(base64ToArrayBuffer(privateKeyB64));
        const enc = _aeadEncryptRaw(plaintext, key, null, null);
        return {
            encrypted_private_key: arrayBufferToBase64(enc.ciphertext),
            salt: arrayBufferToBase64(salt),
            nonce: arrayBufferToBase64(enc.nonce)
        };
    }
    function decryptKeyFromEscrow(encryptedKeyB64, password, saltB64, nonceB64) {
        const combined = new Uint8Array(base64ToArrayBuffer(encryptedKeyB64));
        const n = new Uint8Array(base64ToArrayBuffer(nonceB64));
        const key = deriveEscrowKey(password, saltB64);
        try {
            const plaintext = _aeadDecryptRaw(combined, key, null, n);
            return plaintext ? arrayBufferToBase64(plaintext) : null;
        } catch (_) { return null; }
    }

    // ---- Build public API ----
    return {
        // Core primitives (Step 1)
        generateIdentityKeyPair: generateIdentityKeyPair,
        generateSymmetricKey: generateSymmetricKey,
        aeadEncrypt: aeadEncrypt,
        aeadDecrypt: aeadDecrypt,
        envelopeEncrypt: envelopeEncrypt,
        envelopeDecrypt: envelopeDecrypt,
        envelopeEncryptRaw: envelopeEncryptRaw,
        envelopeDecryptRaw: envelopeDecryptRaw,
        encryptMediaFrame: encryptMediaFrame,
        decryptMediaFrame: decryptMediaFrame,
        encryptWithPassword: encryptWithPassword,
        decryptWithPassword: decryptWithPassword,
        hmacHex: hmacHex,
        sha256Hex: sha256Hex,

        // Helper utilities
        arrayBufferToBase64: arrayBufferToBase64,
        base64ToArrayBuffer: base64ToArrayBuffer,
        randomBytes: randomBytes,

        // X25519
        x25519GenerateKeyPair: x25519GenerateKeyPair,
        x25519DerivePublicKey: x25519DerivePublicKey,
        x25519SharedSecret: x25519SharedSecret,

        // Simplified channel/DM encryption
        encryptMessage: encryptMessage,
        decryptMessage: decryptMessage,
        getDmKey: getDmKey,
        encryptDm: encryptDm,
        decryptDm: decryptDm,

        // Identity key storage
        getIdentityKeyPair: getIdentityKeyPair,
        saveIdentityKeyPair: saveIdentityKeyPair,

        // Server key storage
        getServerKey: getServerKey,
        getAllServerKeys: getAllServerKeys,
        saveServerKey: saveServerKey,
        removeServerKey: removeServerKey,
        decryptWithAnyServerKey: decryptWithAnyServerKey,

        // File encryption
        generateFileKey: generateFileKey,
        encryptFileChunk: encryptFileChunk,
        decryptFileChunk: decryptFileChunk,

        // File Key Storage
        encodeEncryptedFileKey: encodeEncryptedFileKey,
        decodeEncryptedFileKey: decodeEncryptedFileKey,

        // Profile Data Key
        generateProfileDataKey: generateProfileDataKey,
        encryptProfileData: encryptProfileData,
        decryptProfileData: decryptProfileData,

        // Sender username encryption (P3 — encrypt sender_username with channel/server key)
        encryptSenderUsername: function(username, channelKey) {
            return aeadEncrypt(username, channelKey);
        },
        decryptSenderUsername: function(ciphertextB64, nonceB64, channelKey) {
            try {
                var raw = aeadDecrypt(ciphertextB64, channelKey, nonceB64);
                return new TextDecoder().decode(raw);
            } catch (_) {
                return null;
            }
        },
    };
})();
