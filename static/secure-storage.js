/**
 * Secure Storage — transparent localStorage encryption via prototype interception.
 *
 * ===== XSS PROTECTION + CROSS-DEVICE SUPPORT =====
 *
 * HOW IT WORKS
 * ────────────────────────────────────────────────────────────
 * On every page load, the encryption key is DERIVED from the user's PASSWORD
 * (via e2e_encrypted_password + e2e_device_key). Since the same password is
 * used on ALL devices, the same encryption key is produced everywhere.
 *
 * Key derivation chain:
 *   1. Read e2e_encrypted_password (encrypted with e2e_device_key)
 *   2. Read e2e_device_key (random 32 bytes, per-device)
 *   3. Decrypt e2e_encrypted_password → actual password (base64)
 *   4. Derive storage key: HKDF( password, salt="e2e-local-storage-v1" )
 *   5. Cache in sessionStorage for tab-scoped persistence
 *
 * The bootstrap keys (e2e_device_key, e2e_encrypted_password) are NOT
 * re-encrypted — they already provide their own protection and are needed
 * to bootstrap the key derivation on every page/tab/device.
 *
 * FALLBACK (pre-login / first-time)
 * ───────────────────────────────────
 * If no encrypted password exists yet (before login, or fresh browser),
 * a random 32-byte key is generated and stored in sessionStorage. Once the
 * user logs in on this device, _secInit() will be called again with
 * encrypted password available, and the key will be re-derived deterministically.
 *
 * STORED FORMAT
 * ─────────────
 * v2 format:  ~v2.<base64(nonce24 || XChaCha20-Poly1305(utf8))>
 * legacy:     ~<8-char-hex-tag>.<xor-base64>  (read-only, upgrade on next write)
 *
 * PLAINTEXT MIGRATION
 * ───────────────────
 * On first _secInit(), any existing plaintext values for sensitive keys are
 * transparently encrypted in-place. The migration uses the original
 * Storage.prototype methods to avoid double-encrypting through the interceptor.
 *
 * CIPHER: v2 XChaCha20-Poly1305 (AEAD) via libsodium
 * ─────────────────────────────────────────────────────
 * v2 uses libsodium's XChaCha20-Poly1305 AEAD for authenticated encryption.
 * libsodium is already loaded on every page and is synchronous once `sodium.ready`
 * resolves — which is exactly why the old XOR existed (WebCrypto is async).
 * Legacy XOR values are still readable; _secUpgradeToAead() re-writes them
 * once sodium is ready.
 *
 * USAGE
 * ─────
 *   <script src="secure-storage.js"></script>
 *   <script>_secInit();</script>  <!-- synchronous, runs immediately -->
 *   <script src="auth.js"></script>
 */
(function () {
    'use strict';

    // ─── Configuration ─────────────────────────────────────────────────
    var SENSITIVE_PREFIXES = ['token', 'user', 'e2e_', 'admin_', 'fkc_', 'profile_key_cache'];

    // Keys that MUST stay in plaintext because they are needed to
    // bootstrap the key derivation on every page load.
    var BOOTSTRAP_KEYS = {
        'e2e_device_key': true,
        'e2e_encrypted_password': true,
        'e2e_friend_code': true,
        'e2e_local_storage_key': true,
    };

    var SESSION_KEY_NAME = '_ssk';
    // Persistent fallback key in localStorage so the random fallback survives
    // across tabs and page loads when no password-derived key is available.
    // This is a BOOTSTRAP key (kept unencrypted) so _ensureKey() can find it
    // even without the password.
    var LOCAL_KEY_NAME = 'e2e_local_storage_key';
    var MAGIC = '~';  // single magic byte prepended to encrypted values

    // Length of the plaintext checksum tag in hex chars (8 bytes → 16 nibbles)
    var TAG_HEX_LEN = 16;

    // Cached encryption/decryption key as a Uint8Array
    var _key = null;

    // S7 — Secure memory erasure: zero out sensitive buffers after use.
    // JavaScript doesn't guarantee memory zeroing, but fill(0) prevents
    // casual recovery via devtools memory snapshots.
    function _secureZero(arr) {
        if (!arr) return;
        if (arr instanceof ArrayBuffer) arr = new Uint8Array(arr);
        if (arr.fill) arr.fill(0);
    }

    // Whether we've already installed the prototype interceptors
    var _intercepted = false;

    // Guards against _secInit() running more than once
    var _initDone = false;

    // Saved reference to the REAL original Storage.prototype.getItem,
    // captured BEFORE interception. Used by _secGetRaw() to truly bypass
    // the interceptor and read raw stored values.
    var _realOrigGet = Storage.prototype.getItem;
    var _realOrigSet = Storage.prototype.setItem;
    var _realOrigRemove = Storage.prototype.removeItem;

    // ─── Helpers ───────────────────────────────────────────────────────

    function isSensitive(key) {
        if (typeof key !== 'string' || !key) return false;
        // Bootstrap keys are NOT encrypted — they're needed for key derivation
        if (BOOTSTRAP_KEYS[key]) return false;
        for (var i = 0; i < SENSITIVE_PREFIXES.length; i++) {
            if (key.indexOf(SENSITIVE_PREFIXES[i]) === 0) return true;
        }
        return false;
    }

    // ─── v2: authenticated encryption (libsodium, synchronous once ready) ────
    var V2_PREFIX = 'v2.';
    var AEAD_NONCE_LEN = 24;

    function _aeadReady() {
        return typeof sodium !== 'undefined'
            && typeof sodium.crypto_aead_xchacha20poly1305_ietf_encrypt === 'function'
            && typeof sodium.crypto_aead_xchacha20poly1305_ietf_decrypt === 'function';
    }

    function _aeadEncryptWithKey(plaintext, key) {
        var nonce = sodium.randombytes_buf(AEAD_NONCE_LEN);
        var msg = new TextEncoder().encode(plaintext);
        var ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(msg, null, null, nonce, key);
        var combined = new Uint8Array(nonce.length + ct.length);
        combined.set(nonce);
        combined.set(ct, nonce.length);
        return V2_PREFIX + _bytesToBase64(combined);
    }

    /** Returns undefined when `inner` is not v2, a string on success, null when v2 fails to open. */
    function _aeadDecryptWithKey(inner, key) {
        if (inner.indexOf(V2_PREFIX) !== 0) return undefined;
        if (!_aeadReady()) return null;
        try {
            var combined = _base64ToBytes(inner.substring(V2_PREFIX.length));
            if (combined.length <= AEAD_NONCE_LEN) return null;
            var nonce = combined.subarray(0, AEAD_NONCE_LEN);
            var ct = combined.subarray(AEAD_NONCE_LEN);
            var pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, null, nonce, key);
            return new TextDecoder().decode(pt);
        } catch (_) { return null; }   // wrong key or tampered — authenticated, so this is safe
    }

    /**
     * Deterministic 32-byte hash function for key derivation.
     * This is NOT cryptographic SHA-256 — it's a fast mixing function
     * that produces a deterministic 32-byte output from arbitrary input.
     * The actual secrecy comes from the password-derived key, not from
     * the hash function itself.
     */
    function _mixHash(bytes) {
        var a = 0x6a09e667, b = 0xbb67ae85, c = 0x3c6ef372, d = 0xa54ff53a;
        var e = 0x510e527f, f = 0x9b05688c, g = 0x1f83d9ab, h = 0x5be0cd19;
        for (var i = 0; i < bytes.length; i++) {
            a ^= bytes[i]; b ^= bytes[i]; c ^= bytes[i]; d ^= bytes[i];
            e ^= bytes[i]; f ^= bytes[i]; g ^= bytes[i]; h ^= bytes[i];
            a = ((a << 5) | (a >>> 27)) ^ (b + c);
            b = ((b << 11) | (b >>> 21)) ^ (c + d);
            c = ((c << 7) | (c >>> 25)) ^ (d + e);
            d = ((d << 3) | (d >>> 29)) ^ (e + f);
            e = ((e << 6) | (e >>> 26)) ^ (f + g);
            f = ((f << 19) | (f >>> 13)) ^ (g + h);
            g = ((g << 17) | (g >>> 15)) ^ (h + a);
            h = ((h << 13) | (h >>> 19)) ^ (a + b);
        }
        var hash = new Uint8Array(32);
        hash[0]  = a & 0xff; hash[1]  = (a >> 8) & 0xff;  hash[2]  = (a >> 16) & 0xff; hash[3]  = (a >> 24) & 0xff;
        hash[4]  = b & 0xff; hash[5]  = (b >> 8) & 0xff;  hash[6]  = (b >> 16) & 0xff; hash[7]  = (b >> 24) & 0xff;
        hash[8]  = c & 0xff; hash[9]  = (c >> 8) & 0xff;  hash[10] = (c >> 16) & 0xff; hash[11] = (c >> 24) & 0xff;
        hash[12] = d & 0xff; hash[13] = (d >> 8) & 0xff;  hash[14] = (d >> 16) & 0xff; hash[15] = (d >> 24) & 0xff;
        hash[16] = e & 0xff; hash[17] = (e >> 8) & 0xff;  hash[18] = (e >> 16) & 0xff; hash[19] = (e >> 24) & 0xff;
        hash[20] = f & 0xff; hash[21] = (f >> 8) & 0xff;  hash[22] = (f >> 16) & 0xff; hash[23] = (f >> 24) & 0xff;
        hash[24] = g & 0xff; hash[25] = (g >> 8) & 0xff;  hash[26] = (g >> 16) & 0xff; hash[27] = (g >> 24) & 0xff;
        hash[28] = h & 0xff; hash[29] = (h >> 8) & 0xff;  hash[30] = (h >> 16) & 0xff; hash[31] = (h >> 24) & 0xff;
        return hash;
    }

    /**
     * HKDF-like key derivation: derive a storage key from the user's password.
     *
     * Uses _mixHash in a chain to simulate HKDF extract-then-expand:
     *   1. Extract: prk = mixHash( password + context_salt )
     *   2. Expand:  key = mixHash( prk + info_tag )
     *
     * Same password + same salt → same key on every device.
     * Salt is a fixed domain-separation string (not secret — prevents
     * the same key from being used for other purposes).
     */
    function _deriveKeyFromPassword(password) {
        var pwdBytes = new TextEncoder().encode(password);
        var salt = new TextEncoder().encode('e2e-local-storage-v1');
        // Combine password + salt
        var combined = new Uint8Array(pwdBytes.length + salt.length);
        combined.set(pwdBytes);
        combined.set(salt, pwdBytes.length);
        _secureZero(pwdBytes);
        // Extract: deterministic 32-byte PRK
        var prk = _mixHash(combined);
        _secureZero(combined);
        // Expand with info tag for domain separation
        var info = new TextEncoder().encode('lokey');
        var expandInput = new Uint8Array(prk.length + info.length);
        expandInput.set(prk);
        expandInput.set(info, prk.length);
        _secureZero(prk);
        var result = _mixHash(expandInput);
        _secureZero(expandInput);
        return result;
    }

    /**
     * Try to derive the storage key from the user's encrypted password.
     *
     * Decrypts e2e_encrypted_password using e2e_device_key (original
     * Storage.prototype methods, bypassing any interceptor), then
     * derives a deterministic 32-byte key from the actual password.
     *
     * Returns the key if successful, or null if the required keys are
     * not available (pre-login state, fresh browser, etc.).
     */
    function _tryDeriveFromEncryptedPassword() {
        try {
            // Use _realOrigGet (saved before any interception) to avoid interception issues
            var encPw = _realOrigGet.call(localStorage, 'e2e_encrypted_password');
            var devKeyStr = _realOrigGet.call(localStorage, 'e2e_device_key');
            if (!encPw || !devKeyStr) return null;

            // The interceptor may have stored the password encrypted with the
            // current (random/bootstrap) key — e.g. right after a fresh login,
            // before _secReKey migrated the storage key to the password-derived
            // key. Decrypt it with that current key FIRST so the derivation can
            // proceed; otherwise split(':') fails on the '~'-prefixed ciphertext
            // and the migration never happens, leaving every later read to flip
            // to a password-derived key that the other values were never
            // encrypted under (identity keys become silently unreadable).
            if (encPw.charAt(0) === MAGIC) {
                try {
                    var cur = _currentKeyRaw();
                    var decrypted = cur ? _decryptWithKey(encPw.substring(1), cur) : null;
                    if (decrypted !== null) encPw = decrypted;
                } catch (_) {}
            }

            // Parse the encrypted password: format is nonce:ciphertext
            var parts = encPw.split(':');
            if (parts.length !== 2) return null;
            if (parts[0].length < 10 || parts[1].length < 10) return null;

            // We need the E2ECrypto module to decrypt. If it's not loaded yet
            // (secure-storage runs before crypto.js), we can't derive.
            if (typeof E2ECrypto === 'undefined' || !E2ECrypto.decodeEncryptedFileKey) return null;

            // Decrypt the password using the device key
            var devKeyBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(devKeyStr));
            var password = E2ECrypto.decodeEncryptedFileKey(encPw, devKeyBytes);
            _secureZero(devKeyBytes);
            if (!password) return null;

            // Derive storage key from the actual password
            var key = _deriveKeyFromPassword(password);
            return key;
        } catch (_) {
            return null;
        }
    }

    function _bytesToBase64(bytes) {
        var binary = '';
        for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }

    function _base64ToBytes(b64) {
        var binary = atob(b64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    /**
     * Compute a 16-hex-char integrity tag for a plaintext string.
     * Derived from the first 8 bytes of _mixHash(utf8 bytes).
     */
    function _computeTag(plaintext) {
        var bytes = new TextEncoder().encode(plaintext);
        var hash = _mixHash(bytes);
        var hex = '';
        for (var i = 0; i < 8; i++) {
            var b = hash[i];
            hex += '0123456789abcdef'[(b >> 4) & 0xf];
            hex += '0123456789abcdef'[b & 0xf];
        }
        return hex;
    }

    /**
     * XOR encrypt a string → tag.b64 (tag first, then ., then b64).
     * The tag allows decryption to detect a stale session key.
     */
    function _xorEncrypt(plaintext) {
        var key = _ensureKey();
        var bytes = new TextEncoder().encode(plaintext);
        var result = new Uint8Array(bytes.length);
        for (var i = 0; i < bytes.length; i++) {
            result[i] = bytes[i] ^ key[i % key.length];
        }
        var tag = _computeTag(plaintext);
        return tag + '.' + _bytesToBase64(result);
    }

    /**
     * Encrypt a value: produce v2 AEAD when libsodium is ready, else legacy XOR.
     * Legacy XOR is kept for the brief window between page load and sodium.ready.
     */
    function _encryptInner(plaintext) {
        var key = _ensureKey();
        if (_aeadReady()) return _aeadEncryptWithKey(String(plaintext), key);
        return _xorEncrypt(String(plaintext));
    }

    /**
     * Decrypt an inner value (without MAGIC prefix) with an explicit key.
     * Handles v2 AEAD, legacy tag.b64, and legacy bare b64.
     * Returns undefined when `inner` is not v2 (caller should try legacy).
     * Returns null on v2 failure (wrong key / tampered).
     * Returns the plaintext string on success.
     */
    function _decryptInnerWithKey(inner, key) {
        var v2 = _aeadDecryptWithKey(inner, key);
        if (v2 !== undefined) return v2;
        return _decryptWithKey(inner, key);      // legacy formats
    }

    /**
     * XOR decrypt tag.b64 with an EXPLICIT key (no _ensureKey call — safe to
     * use from _tryDeriveFromEncryptedPassword / _secReKey without recursion).
     * Verifies the integrity tag. If it doesn't match, the key has changed
     * since encryption — returns null. Also handles old-format values (bare
     * b64, no tag) which are decrypted without verification.
     */
    function _decryptWithKey(stored, key) {
        if (!stored || !key) return null;
        var cipherB64, expectedTag;
        // New format: tag.bbb...  (the separator at position TAG_HEX_LEN)
        if (stored.length > TAG_HEX_LEN && stored.charAt(TAG_HEX_LEN) === '.') {
            expectedTag = stored.substring(0, TAG_HEX_LEN);
            cipherB64 = stored.substring(TAG_HEX_LEN + 1);
        } else {
            // Old format: bare b64, no tag — decrypt without verification
            expectedTag = null;
            cipherB64 = stored;
        }

        var bytes = _base64ToBytes(cipherB64);
        var result = new Uint8Array(bytes.length);
        for (var i = 0; i < bytes.length; i++) {
            result[i] = bytes[i] ^ key[i % key.length];
        }
        _secureZero(bytes);
        var plaintext = new TextDecoder().decode(result);
        _secureZero(result);

        // Verify tag if this is new-format data
        if (expectedTag !== null) {
            var actualTag = _computeTag(plaintext);
            if (actualTag !== expectedTag) {
                return null;
            }
        }
        return plaintext;
    }

    /**
     * Current storage key WITHOUT triggering _ensureKey's password-derivation
     * path (which would recurse into _tryDeriveFromEncryptedPassword). Checks
     * the in-memory key, the sessionStorage cache, then the localStorage
     * bootstrap fallback. Returns null if none is available.
     */
    function _currentKeyRaw() {
        if (_key) return _key;
        try {
            var stored = sessionStorage.getItem(SESSION_KEY_NAME);
            if (stored) {
                var k = _base64ToBytes(stored);
                if (k.length === 32) return k;
            }
        } catch (_) {}
        try {
            var lsKey = _realOrigGet.call(localStorage, LOCAL_KEY_NAME);
            if (lsKey) {
                var k2 = _base64ToBytes(lsKey);
                if (k2.length === 32) return k2;
            }
        } catch (_) {}
        return null;
    }

    /**
     * XOR decrypt tag.b64 → string.
     * Verifies the integrity tag. If it doesn't match, the session key has
     * changed since encryption (password changed on another device) — returns null.
     *
     * Also handles old-format values (bare b64, no tag) for backward
     * compatibility. Those are decrypted without verification.
     */
    function _xorDecrypt(stored) {
        var cipherB64, expectedTag;
        // New format: tag.bbb...  (the separator at position TAG_HEX_LEN)
        if (stored.length > TAG_HEX_LEN && stored.charAt(TAG_HEX_LEN) === '.') {
            expectedTag = stored.substring(0, TAG_HEX_LEN);
            cipherB64 = stored.substring(TAG_HEX_LEN + 1);
        } else {
            // Old format: bare b64, no tag — decrypt without verification
            expectedTag = null;
            cipherB64 = stored;
        }

        var key = _ensureKey();
        var bytes = _base64ToBytes(cipherB64);
        var result = new Uint8Array(bytes.length);
        for (var i = 0; i < bytes.length; i++) {
            result[i] = bytes[i] ^ key[i % key.length];
        }
        _secureZero(bytes);
        var plaintext = new TextDecoder().decode(result);
        _secureZero(result);

        // Verify tag if this is new-format data
        if (expectedTag !== null) {
            var actualTag = _computeTag(plaintext);
            if (expectedTag !== actualTag) {
                // Key changed — old data is garbage (password changed on another device)
                return null;
            }
        }
        return plaintext;
    }

    /** Check if a stored value looks encrypted (starts with magic byte) */
    function _isEncrypted(val) {
        return typeof val === 'string' && val.charAt(0) === MAGIC;
    }

    /** Strip magic prefix and decrypt */
    function _decryptStored(val) {
        if (!_isEncrypted(val)) return val;
        try {
            return _decryptInnerWithKey(val.substring(1), _ensureKey());
        } catch (_) {
            return null;
        }
    }

    /** Encrypt and prepend magic prefix */
    function _encryptForStore(plaintext) {
        return MAGIC + _encryptInner(plaintext);
    }

    /**
     * True when this device holds the material needed to deterministically
     * re-derive the storage key: the password blob (`e2e_encrypted_password`)
     * and the device key that wraps it (`e2e_device_key`).
     *
     * When this is true the storage key MUST NEVER be replaced by a random
     * fallback — every sensitive value (the session `token` above all) is
     * encrypted under the password-derived key, so a random key makes all of
     * it permanently unreadable and the user is bounced to the login page on
     * every cold start.
     */
    function _hasPasswordBootstrap() {
        try {
            var encPw = _realOrigGet.call(localStorage, 'e2e_encrypted_password');
            var devKey = _realOrigGet.call(localStorage, 'e2e_device_key');
            return !!(encPw && devKey);
        } catch (_) { return false; }
    }

    /**
     * Ensure the encryption key is available.
     *
     * Priority order:
     *   1. Cached in-memory (fastest path, this page load)
     *   2. Derive from encrypted password — ONLY when a bootstrap is present,
     *      and BEFORE the caches, because it is the authoritative key the
     *      session was encrypted under
     *   3. Stored in sessionStorage (cross-page within same tab)
     *   4. Persistent localStorage fallback (only safe with no bootstrap)
     *   5. Generate random key (fallback for pre-login state only)
     */
    function _ensureKey() {
        if (_key) {
            // Always refresh sessionStorage cache in case it was cleared.
            // Wrapped in try/catch because sessionStorage operations can throw
            // (e.g., quota exceeded, sandboxed context), and this fast-path is
            // called from inside the interceptor's setItem before its try block.
            try {
                var cur = sessionStorage.getItem(SESSION_KEY_NAME);
                var curB64 = _bytesToBase64(_key);
                if (cur !== curB64) {
                    sessionStorage.setItem(SESSION_KEY_NAME, curB64);
                }
            } catch (_) {}
            return _key;
        }

        // A password bootstrap means the password-derived key is the ONLY key
        // that can open the stored session. Try it first, and never let the
        // random fallback win over it: a fallback minted by an earlier load
        // that lost the sodium-ready race would otherwise orphan the token
        // forever (the cold-start "logged out on mobile" bug).
        if (_hasPasswordBootstrap()) {
            var derivedNow = _tryDeriveFromEncryptedPassword();
            if (derivedNow) {
                _key = derivedNow;
                try { sessionStorage.setItem(SESSION_KEY_NAME, _bytesToBase64(_key)); } catch (_) {}
                try { _realOrigRemove.call(localStorage, LOCAL_KEY_NAME); } catch (_) {}
                window._secDerivationPending = false;
                return _key;
            }
            // Derivation is momentarily impossible (E2ECrypto/libsodium not
            // ready at parse time). Do NOT mint a random key — that would
            // permanently orphan the token. Reuse an already-cached key if one
            // exists and flag that a retry is needed once crypto is ready.
            window._secDerivationPending = true;
            var cachedKey = sessionStorage.getItem(SESSION_KEY_NAME);
            if (cachedKey) {
                try {
                    var ck = _base64ToBytes(cachedKey);
                    if (ck.length === 32) { _key = ck; return _key; }
                } catch (_) {}
            }
            try {
                var fbKey = _realOrigGet.call(localStorage, LOCAL_KEY_NAME);
                if (fbKey) {
                    var fk = _base64ToBytes(fbKey);
                    if (fk.length === 32) { _key = fk; return _key; }
                }
            } catch (_) {}
            return null;
        }

        // No password bootstrap (fresh device / pre-login): sessionStorage →
        // persistent fallback → a new random key are all safe here.
        var stored = sessionStorage.getItem(SESSION_KEY_NAME);
        if (stored) {
            try {
                _key = _base64ToBytes(stored);
                if (_key.length === 32) return _key;
                _key = null;
            } catch (_) {
                _key = null;
            }
        }

        if (!_key) {
            try {
                var lsKey = _realOrigGet.call(localStorage, LOCAL_KEY_NAME);
                if (lsKey) {
                    _key = _base64ToBytes(lsKey);
                    if (_key.length === 32) {
                        sessionStorage.setItem(SESSION_KEY_NAME, _bytesToBase64(_key));
                        return _key;
                    }
                    _key = null;
                }
            } catch (_) {
                _key = null;
            }
        }

        // Fallback: generate random key (pre-login state)
        _key = crypto.getRandomValues(new Uint8Array(32));
        var keyB64 = _bytesToBase64(_key);
        sessionStorage.setItem(SESSION_KEY_NAME, keyB64);
        // ALSO persist in localStorage so the same key is used across tabs and
        // survives page refreshes when sessionStorage is cleared (common on mobile).
        // This is a bootstrap key — stored as plaintext (not encrypted), just like
        // e2e_device_key and e2e_encrypted_password.
        try { _realOrigSet.call(localStorage, LOCAL_KEY_NAME, keyB64); } catch (_) {}
        return _key;
    }

    // ─── Prototype Interception (IN-PLACE encryption, same key names) ───

    function _intercept() {
        if (_intercepted) return;
        _intercepted = true;

        var proto = Storage.prototype;
        // Use the REAL originals saved before any interception
        var _origGet = _realOrigGet;
        var _origSet = _realOrigSet;
        var _origRemove = _realOrigRemove;

        /** getItem: for sensitive keys, transparently decrypt in-place */
        proto.getItem = function (key) {
            if (key && isSensitive(key)) {
                var val = _origGet.call(this, key);
                if (val !== null && _isEncrypted(val)) {
                    try {
                        return _decryptInnerWithKey(val.substring(1), _ensureKey());
                    } catch (_) {
                        // Decryption failed — return as-is (legacy plaintext)
                        return val;
                    }
                }
                return val; // Not encrypted, return as-is
            }
            return _origGet.call(this, key);
        };

        /** setItem: for sensitive keys, transparently encrypt in-place */
        proto.setItem = function (key, value) {
            if (key && isSensitive(key)) {
                _ensureKey();
                try {
                    var enc = MAGIC + _encryptInner(String(value));
                    _origSet.call(this, key, enc);
                    return;
                } catch (_) {
                    // Encryption failed — fallback to plaintext
                }
            }
            _origSet.call(this, key, value);
        };

        /** removeItem: for sensitive keys, clean up normally (same key name) */
        proto.removeItem = function (key) {
            _origRemove.call(this, key);
        };
    }

    // ─── Public API ─────────────────────────────────────────────────────

    /**
     * Initialize the secure storage layer.
     *
     * 1. Ensures a key exists (derived from password, or random fallback).
     * 2. Installs the Storage.prototype interceptors.
     * 3. Migrates any existing plaintext sensitive values to encrypted form.
     *
     * SYNCHRONOUS — safe to call before DOMContentLoaded.
     */
    window._secInit = function () {
        // Guard: only run once per page load to prevent double-encryption
        // NOTE: _initDone is set at the END of the function (after all setup),
        // NOT at the start. This ensures that if _secInit fails partway through,
        // it can be retried (e.g. if called from a <script> tag before external
        // dependencies like E2ECrypto are ready).
        if (_initDone) return true;

        // Save ORIGINAL Storage.prototype methods BEFORE installing interceptors,
        // so the migration loop doesn't double-encrypt through the interceptor.
        var _origGet = Storage.prototype.getItem;
        var _origSet = Storage.prototype.setItem;
        var _origRemove = Storage.prototype.removeItem;

        _ensureKey();

        // Repair bootstrap keys that the OLD secure-storage wrongly encrypted.
        // With e2e_local_storage_key persisting the random fallback, the current
        // key matches the one that encrypted them, so XOR-decrypt succeeds and
        // we recover the plaintext (nonce:ciphertext for the password, raw b64
        // for device_key, raw code for friend_code). If repair fails the key
        // has genuinely changed — delete so auth.js regenerates on login.
        ['e2e_device_key', 'e2e_encrypted_password', 'e2e_friend_code'].forEach(function(k) {
            var val = _origGet.call(localStorage, k);
            if (val !== null && val.charAt(0) === MAGIC) {
                try {
                    var plain = _decryptInnerWithKey(val.substring(1), _ensureKey());
                    if (plain !== null) { _origSet.call(localStorage, k, plain); return; }
                } catch (_) {}
                _origRemove.call(localStorage, k);
            }
        });

        // Set up interceptors
        _intercept();

        // Migrate existing plaintext values to encrypted.
        // Note: we intentionally use the ORIGINAL methods (saved above) here to
        // bypass the interceptor. Reading via the interceptor would still return
        // plaintext (since it's not prefixed with ~ yet), but writing via the
        // interceptor would encrypt AGAIN on top of our already-encrypted value.
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k && isSensitive(k)) {
                var val = _origGet.call(localStorage, k);
                if (val !== null && !_isEncrypted(val)) {
                    try {
                        // _encryptInner writes v2 AEAD once libsodium is ready and
                        // falls back to legacy XOR before that (upgraded later by
                        // _secUpgradeToAead()), so no value is written XOR-only
                        // when this migration runs with sodium available.
                        var enc = MAGIC + _encryptInner(String(val));
                        _origSet.call(localStorage, k, enc);
                    } catch (_) {}
                }
            }
        }

        // Mark initialization as complete — set AFTER all setup succeeds
        // so that if _secInit() fails partway, it can be retried.
        _initDone = true;

        return true;
    };

    /**
     * Re-encrypt every legacy XOR value under the v2 AEAD using the SAME key.
     * Idempotent; safe to call after every _secReKey/_secRekeyToPassword.
     */
    window._secUpgradeToAead = function () {
        if (!_aeadReady()) return false;
        var key = _currentKeyRaw();
        if (!key) return false;
        var changed = 0;
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (!k || !isSensitive(k)) continue;
            var raw = _realOrigGet.call(localStorage, k);
            if (raw === null || !_isEncrypted(raw)) continue;
            var inner = raw.substring(1);
            if (inner.indexOf(V2_PREFIX) === 0) continue;
            var plain = _decryptWithKey(inner, key);      // legacy formats only
            if (plain === null) continue;                 // stale key — leave it alone
            _realOrigSet.call(localStorage, k, MAGIC + _aeadEncryptWithKey(plain, key));
            changed++;
        }
        return changed > 0;
    };

    function _afterSodium(fn) {
        if (typeof sodium !== 'undefined' && sodium.ready && typeof sodium.ready.then === 'function') {
            sodium.ready.then(function () { try { fn(); } catch (_) {} });
        }
    }
    // Deferred so the first pass uses AEAD instead of XOR (sodium is not ready at parse time).
    _afterSodium(function () {
        // Self-heal: a cold start can run the parse-time _secInit() before
        // libsodium finishes initialising, so the password-derived key wasn't
        // available yet. Now that it is, re-derive it before anything reads the
        // session (the app's DOMContentLoaded check runs after this microtask).
        if (window._secDerivationPending && typeof window._secRedriveKey === 'function') {
            try { window._secRedriveKey(); } catch (_) {}
        }
        if (typeof window._secUpgradeToAead === 'function') window._secUpgradeToAead();
        if (typeof window._secInit === 'function') window._secInit();
    });

    /**
     * Check if the user has an active session (sessionStorage key + stored token).
     * SYNCHRONOUS fast-path for page redirect checks.
     */
    window._secHasSession = function () {
        var ssk = sessionStorage.getItem(SESSION_KEY_NAME);
        if (!ssk) return false;
        // Check if token exists (encrypted or plaintext)
        var val = Storage.prototype.getItem.call(localStorage, 'token');
        return val !== null;
    };

    /**
     * Completely clear all secure storage for "Clear All Data" flows.
     */
    window._secClearAll = function (preserve) {
        // Remove all sensitive keys. `preserve` (optional array of exact keys)
        // is kept — the login-page wipe uses it for the media caches
        // (fkc_* file keys + profile_key_cache): those decrypt only
        // server-gated downloads, so keeping them across a forced re-login
        // leaks nothing new and avoids every avatar/banner/emoji breaking.
        var preserveSet = null;
        if (preserve && preserve.length) {
            preserveSet = {};
            for (var pi = 0; pi < preserve.length; pi++) preserveSet[preserve[pi]] = true;
        }
        var toRemove = [];
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k && isSensitive(k) && !(preserveSet && preserveSet[k])) {
                toRemove.push(k);
            }
        }
        for (var j = 0; j < toRemove.length; j++) {
            Storage.prototype.removeItem.call(localStorage, toRemove[j]);
        }
        // Remove session key
        sessionStorage.removeItem(SESSION_KEY_NAME);
        _key = null;
    };

    /**
     * Read a decrypted value directly, bypassing the interceptor.
     * Returns null if the key doesn't exist or decryption fails (e.g.
     * session key changed since the value was stored).
     */
    window._secGet = function (key) {
        if (!key) return null;
        var val = _realOrigGet.call(localStorage, key);
        if (val !== null && _isEncrypted(val)) {
            try { return _decryptInnerWithKey(val.substring(1), _ensureKey()); } catch (_) { return null; }
        }
        return val; // Not encrypted, return as-is
    };

    /**
     * Read the raw stored value (with ~ prefix & tag), TRULY bypassing
     * the interceptor by using the original Storage.prototype.getItem
     * saved before interception.
     * Returns null if the key doesn't exist.
     * Useful for debugging / inspecting the on-disk format.
     */
    window._secGetRaw = function (key) {
        if (!key) return null;
        return _realOrigGet.call(localStorage, key);
    };

    /**
     * Force re-derive the encryption key from the password.
     * Called after login/register when a new encrypted password is stored.
     * Re-encrypts all existing sensitive values with the new key.
     */
    // Auto-initialize on load (inline scripts may be blocked by CSP)
    _secInit();

    // ─── Global XSS Escaping Utilities ─────────────────────────────────────
    //
    // These were previously defined only in auth.js and admin.js, but chat.js
    // (loaded by index.html) also calls them extensively (105+ calls). Since
    // secure-storage.js is loaded by ALL pages (index.html, login.html,
    // admin.html), it's the right place for these shared XSS-safe helpers.

    /**
     * Escape a string for safe insertion into HTML (text content).
     * Converts & < > " ' to their HTML entity equivalents.
     */
    window.escapeHtml = function (str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };

    /**
     * Escape a string for safe insertion into an HTML attribute (quoted context).
     */
    window.escapeAttr = window.escapeHtml;

    /**
     * Force one re-derivation of the storage key from the password bootstrap.
     *
     * Boot-time self-heal for the cold-start race: when the parse-time
     * _secInit() could not derive (E2ECrypto/libsodium not ready), the correct
     * key becomes available a moment later. This swaps the cached key to the
     * password-derived one so sensitive reads — starting with `token` — succeed
     * without forcing a re-login. Returns true when a password-derived key is
     * now active.
     */
    window._secRedriveKey = function () {
        if (!_hasPasswordBootstrap()) return false;
        var derived = _tryDeriveFromEncryptedPassword();
        if (!derived) return false;
        _key = derived;
        try { sessionStorage.setItem(SESSION_KEY_NAME, _bytesToBase64(_key)); } catch (_) {}
        // The random fallback is now definitively stale.
        try { _realOrigRemove.call(localStorage, LOCAL_KEY_NAME); } catch (_) {}
        window._secDerivationPending = false;
        return true;
    };

    window._secReKey = function () {
        // Capture the CURRENT key BEFORE clearing anything: the plaintexts must
        // be decrypted with the key they were encrypted under. _ensureKey()
        // must NOT be used here — once e2e_encrypted_password is derivable (e.g.
        // a fresh login stored it), _ensureKey would flip to the password-derived
        // key mid-collection and every old-key value would be lost.
        var oldKey = _currentKeyRaw();

        // Clear in-memory and sessionStorage caches
        _key = null;
        sessionStorage.removeItem(SESSION_KEY_NAME);

        // Derive new key from the now-available encrypted password
        var newKey = _tryDeriveFromEncryptedPassword();
        if (!newKey) return false;

        // Collect current plaintext values for all sensitive keys
        var plaintexts = {};
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k && isSensitive(k)) {
                var raw = _realOrigGet.call(localStorage, k);
                if (raw !== null) {
                    // Decrypt with the OLD key if it's encrypted. MUST use the
                    // v2/legacy-aware decryptor: values written after libsodium
                    // is ready are ~v2 AEAD, and _decryptWithKey() only handles
                    // the legacy XOR format, so it would silently skip them and
                    // the rekey would orphan them under the discarded old key
                    // (identity keys and server keys become undecryptable — see
                    // the fresh-device login path).
                    if (_isEncrypted(raw)) {
                        try {
                            var decrypted = oldKey ? _decryptInnerWithKey(raw.substring(1), oldKey) : null;
                            if (decrypted !== null) plaintexts[k] = decrypted;
                        } catch (_) {}
                    } else {
                        plaintexts[k] = raw;
                    }
                }
            }
        }

        // Set the new key
        _key = newKey;
        sessionStorage.setItem(SESSION_KEY_NAME, _bytesToBase64(_key));

        // Remove any stale localStorage fallback key (we now have a proper
        // password-derived key that will be found first by _ensureKey).
        try { _realOrigRemove.call(localStorage, LOCAL_KEY_NAME); } catch (_) {}

        // Re-encrypt all values with the new key using AEAD.
        // Use _realOrigSet (saved before interception) to bypass the interceptor.
        for (var key in plaintexts) {
            if (plaintexts.hasOwnProperty(key)) {
                try {
                    var enc = MAGIC + _aeadEncryptWithKey(String(plaintexts[key]), newKey);
                    _realOrigSet.call(localStorage, key, enc);
                } catch (_) {}
            }
        }

        return true;
    };

    /**
     * Re-key every sensitive localStorage value from the CURRENT key to a new
     * password-derived key, then swap the stored password. Used by the
     * password-change flow: old values are only decryptable with the OLD
     * password, so plaintexts are collected BEFORE the stored password is
     * replaced (unlike _secReKey, which is meant for same-password rekeys).
     * Returns true on success.
     */
    window._secRekeyToPassword = function (newPassword) {
        try {
            // 1. Collect plaintexts with the CURRENT key (the old password is
            //    still stored). Decrypt with the key captured NOW — _ensureKey
            //    must not run mid-collection and flip to a derivable key.
            var oldKey = _currentKeyRaw();
            var plaintexts = {};
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (k && isSensitive(k)) {
                    var raw = _realOrigGet.call(localStorage, k);
                    if (raw !== null) {
                        if (_isEncrypted(raw)) {
                            try {
                                var decrypted = oldKey ? _decryptInnerWithKey(raw.substring(1), oldKey) : null;
                                if (decrypted !== null) plaintexts[k] = decrypted;
                            } catch (_) {}
                        } else {
                            plaintexts[k] = raw;
                        }
                    }
                }
            }

            // 2. Swap the stored password to the new one (bootstrap key, plaintext).
            var devKeyStr = _realOrigGet.call(localStorage, 'e2e_device_key');
            if (!devKeyStr) return false;
            var devKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(devKeyStr));
            _realOrigSet.call(localStorage, 'e2e_encrypted_password',
                E2ECrypto.encodeEncryptedFileKey(btoa(newPassword), devKey));
            _secureZero(devKey);

            // 3. Derive the NEW key and drop the old caches.
            _key = null;
            sessionStorage.removeItem(SESSION_KEY_NAME);
            if (!_tryDeriveFromEncryptedPassword()) return false;
            try { _realOrigRemove.call(localStorage, LOCAL_KEY_NAME); } catch (_) {}

            // 4. Re-write the collected plaintexts using AEAD.
            for (var key in plaintexts) {
                if (plaintexts.hasOwnProperty(key)) {
                    try {
                        _realOrigSet.call(localStorage, key, MAGIC + _aeadEncryptWithKey(String(plaintexts[key]), _key));
                    } catch (_) {}
                }
            }
            return true;
        } catch (_) {
            return false;
        }
    };

})();
