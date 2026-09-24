/**
 * Key Vault (5.6, FEATURE_PLAN.md) — an Argon2id + AEAD container for the
 * storage key, replacing the plaintext "password bootstrap".
 *
 * ===== WHAT IT REPLACES, AND WHY =====
 *
 * secure-storage.js derives the localStorage encryption key from the user's
 * password, which it kept on the device as `e2e_encrypted_password`: the
 * password wrapped by `e2e_device_key`. BOTH halves sat in localStorage in
 * plaintext, so anyone who could read the device's storage (a stolen laptop, a
 * copied browser profile, a backup) could unwrap the password and then re-derive
 * the key with the (fast, hand-rolled) mixer in secure-storage.js. File access
 * alone was enough to read the session token and every message at rest.
 *
 * This vault replaces that bootstrap with ONE self-protecting blob:
 *
 *     e2e_key_vault = { v, kdf:"argon2id", ops, mem, salt, n, c }
 *
 * `c` is the storage key sealed with XChaCha20-Poly1305 under a key derived from
 * the password with **Argon2id** (memory-hard, so offline guessing is
 * expensive), and nothing else on the device holds the password any more:
 * `_kvMigrate()` deletes the old bootstrap only AFTER the vault has been read
 * back and opened successfully (plan rule: "migration must not leave the old
 * bootstrap readable alongside the new vault").
 *
 * The consequence is deliberate: a cold start must be unlocked with the
 * password (or the 5.1 fingerprint seal, which the lock screen offers when it
 * exists). A key that could be recovered without the password would be the old
 * bootstrap again.
 *
 * The vault blob is a BOOTSTRAP key in secure-storage.js — it is stored as
 * written, because it needs no key from secure-storage to be understood (it
 * carries its own), and because secure-storage cannot be asked to encrypt the
 * very thing that produces its key.
 *
 * API (all async — libsodium's KDF is synchronous only once it is ready):
 *   _kvExists()                      → boolean
 *   _kvInfo()                        → { exists, v, ops, mem } | { exists:false }
 *   _kvCreate(password, keyB64, who) → boolean (proven by reading it back)
 *   _kvUnlock(password)              → { k, u, at } | null
 *   _kvMigrate(password)             → boolean (create + delete old bootstrap)
 *   _kvDestroy()                     → boolean
 */
(function () {
    'use strict';

    // Plaintext name on purpose: the VALUE is what carries the protection, and
    // secure-storage must be able to find it before any key exists.
    var VAULT_KEY = 'e2e_key_vault';
    var VERSION = 1;
    var SALT_LEN = 16;      // sodium.crypto_pwhash_SALTBYTES is 16; not read from
    var NONCE_LEN = 24;     // the library so this stays answerable without it

    // ─── small helpers (no dependency on E2ECrypto load order) ───────────

    function _b64(bytes) {
        var s = '';
        for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s);
    }

    function _unb64(str) {
        var bin = atob(str);
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function _kdfReady() {
        return typeof sodium !== 'undefined'
            && typeof sodium.crypto_pwhash === 'function'
            && typeof sodium.crypto_aead_xchacha20poly1305_ietf_encrypt === 'function'
            && typeof sodium.crypto_pwhash_ALG_ARGON2ID13 !== 'undefined';
    }

    function _read() {
        try {
            var raw = Storage.prototype.getItem.call(localStorage, VAULT_KEY);
            if (!raw) return null;
            var blob = JSON.parse(raw);
            if (!blob || blob.v !== VERSION || !blob.salt || !blob.n || !blob.c) return null;
            return blob;
        } catch (_) { return null; }
    }

    function _write(blob) {
        try {
            Storage.prototype.setItem.call(localStorage, VAULT_KEY, JSON.stringify(blob));
            return true;
        } catch (_) { return false; }
    }

    /** Argon2id(password, salt) → 32-byte key. The whole point of the vault. */
    function _derive(password, salt, ops, mem) {
        return sodium.crypto_pwhash(
            32,
            password,
            salt,
            ops || sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
            mem || sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
            sodium.crypto_pwhash_ALG_ARGON2ID13
        );
    }

    function _userLabel() {
        try {
            var u = JSON.parse(localStorage.getItem('user') || 'null');
            return (u && (u.username || u.id)) || null;
        } catch (_) { return null; }
    }

    window._kvExists = function () { return !!_read(); };

    window._kvInfo = function () {
        var b = _read();
        if (!b) return { exists: false };
        // The sealed payload (and so the account label) is only readable with
        // the password, so it is not exposed here — the lock screen names the
        // account from the 5.1 seal (`e2e_bio_user`), which is already public.
        return { exists: true, v: b.v, kdf: b.kdf, ops: b.ops, mem: b.mem };
    };

    // Internal: open a parsed blob with a password. Returns the payload object
    // or null. Used by both _kvUnlock() and _kvCreate()'s read-back proof.
    function _openWith(blob, password) {
        if (!_kdfReady()) return null;
        try {
            var salt = _unb64(blob.salt);
            var key = _derive(password, salt, blob.ops, blob.mem);
            var plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
                null, _unb64(blob.c), null, _unb64(blob.n), key
            );
            if (typeof key.fill === 'function') key.fill(0);
            var payload = JSON.parse(new TextDecoder().decode(plain));
            if (typeof plain.fill === 'function') plain.fill(0);
            if (!payload || typeof payload.k !== 'string') return null;
            return payload;
        } catch (_) {
            // Wrong password or tampered blob — AEAD makes these the same thing.
            return null;
        }
    }

    /**
     * Seal `keyB64` under `password`.
     *
     * Fail-closed by construction: the blob is written and then READ BACK and
     * OPENED before this reports success. A caller may only discard the old
     * bootstrap after a true return, so a quota error or a bad write can never
     * take the key with it.
     */
    window._kvCreate = async function (password, keyB64, who) {
        if (!password || typeof keyB64 !== 'string' || !keyB64) return false;
        if (typeof sodium === 'undefined' || !sodium.ready) return false;
        await sodium.ready;
        if (!_kdfReady()) return false;
        try {
            var salt = sodium.randombytes_buf(SALT_LEN);
            var nonce = sodium.randombytes_buf(NONCE_LEN);
            var ops = sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE;
            var mem = sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE;
            var key = _derive(password, salt, ops, mem);
            var payload = JSON.stringify({
                k: keyB64,
                u: who || _userLabel(),
                at: Date.now(),
            });
            var ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
                new TextEncoder().encode(payload), null, null, nonce, key
            );
            if (typeof key.fill === 'function') key.fill(0);
            var blob = {
                v: VERSION,
                kdf: 'argon2id',
                ops: ops,
                mem: mem,
                salt: _b64(salt),
                n: _b64(nonce),
                c: _b64(ct),
            };
            if (!_write(blob)) return false;
            // Proof of write AND of openability with this exact password.
            var proof = _openWith(blob, password);
            if (!proof || proof.k !== keyB64) return false;
            return true;
        } catch (_) { return false; }
    };

    window._kvUnlock = async function (password) {
        var blob = _read();
        if (!blob || !password) return null;
        if (typeof sodium === 'undefined' || !sodium.ready) return null;
        await sodium.ready;
        return _openWith(blob, password);
    };

    /**
     * Delete the legacy bootstrap — the half of 5.6 the plan calls out
     * explicitly. Only ever called after _kvCreate() has proven the vault opens.
     *
     * `e2e_device_key` is deliberately KEPT: it is the per-device key that
     * wrapped the password blob, so with the blob gone it wraps nothing (and the
     * password-change flow still needs it to write the new blob, which
     * _kvMigrate() then folds back into the vault).
     */
    function _destroyLegacyBootstrap() {
        var removed = [];
        try {
            if (Storage.prototype.getItem.call(localStorage, 'e2e_encrypted_password') !== null) {
                Storage.prototype.removeItem.call(localStorage, 'e2e_encrypted_password');
                removed.push('e2e_encrypted_password');
            }
        } catch (_) {}
        try {
            // The pre-login random fallback key: with the vault holding the real
            // key it is a plaintext key copy with nothing left to open.
            if (Storage.prototype.getItem.call(localStorage, 'e2e_local_storage_key') !== null) {
                Storage.prototype.removeItem.call(localStorage, 'e2e_local_storage_key');
                removed.push('e2e_local_storage_key');
            }
        } catch (_) {}
        // Deliberately NOT e2e_-prefixed: secure-storage treats that prefix as
        // sensitive and would encrypt this marker in place, so a plain read of
        // it would come back as ciphertext. It is a timestamp, not a secret.
        try { Storage.prototype.setItem.call(localStorage, 'vault_migrated_at', String(Date.now())); } catch (_) {}
        return removed;
    }
    window._kvDestroyLegacyBootstrap = _destroyLegacyBootstrap;

    // ─── The session ticket ─────────────────────────────────────────────────
    // The vault makes the password the only way in — yet two IN-PAGE flows
    // need the password itself while a session is already unlocked:
    //
    //   • the key-blob mirror (every key change must be re-wrapped with the
    //     password for the server backup), and
    //   • loadDecryptedPassword() consumers (recovery, reauth, 5.1 sealing).
    //
    // Without a session copy those flows silently no-op after every reload —
    // backups stop for anything the user does between logins. The ticket is
    // the password stored THROUGH secure-storage's interceptor, which encrypts
    // it under the storage key in place (it matches the `e2e_` sensitive
    // prefix). That is exactly the protection the session token already has:
    //
    //   • at rest it is ciphertext — readable only with an UNLOCKED session;
    //   • while the vault is locked (cold start) there IS no key, so the
    //     ticket decrypts to nothing — it cannot bootstrap anything;
    //   • it is wiped with everything else on logout / "Clear All" / panic.
    //
    // This is NOT the old bootstrap: `e2e_encrypted_password` sat in plaintext
    // NEXT TO its own key (`e2e_device_key`) and worked while locked — file
    // access alone recovered the password. The ticket needs the live session
    // key, which the vault put behind Argon2id. Delete-after-migrate still
    // holds: the legacy blob is gone and nothing on disk reads without a
    // password or a live unlocked session.
    var TICKET_KEY = 'e2e_vault_ticket';

    /**
     * Write the ticket, PROVING it stored ciphertext we can read back.
     * The interceptor falls back to plaintext when encryption fails, so a
     * blind write could leave the password in the clear — check the raw
     * value is magic-prefixed (encrypted) and decrypts to exactly this
     * password, and drop the key otherwise. Fail-closed by construction.
     */
    window._kvTicketWrite = function (password) {
        try {
            if (!password) return false;
            // Refuse while there is no active storage key: with no key the
            // interceptor's plaintext fallback would store the password raw.
            if (typeof window._secKeyB64 !== 'function' || !window._secKeyB64()) return false;
            localStorage.setItem(TICKET_KEY, password);
            // Read TRULY raw: secure-storage patches Storage.prototype.getItem,
            // so calling it here would hand back the DECRYPTED plaintext and
            // look exactly like a failed encryption (which would make us delete
            // a perfectly good ticket). _secGetRaw() was captured before
            // interception and bypasses it.
            var raw = (typeof window._secGetRaw === 'function')
                ? window._secGetRaw(TICKET_KEY)
                : Storage.prototype.getItem.call(localStorage, TICKET_KEY);
            if (!raw || raw.charAt(0) !== '~') {
                // Encryption did not happen — never leave a plaintext password.
                try { Storage.prototype.removeItem.call(localStorage, TICKET_KEY); } catch (_) {}
                return false;
            }
            var back = (typeof window._secGet === 'function') ? window._secGet(TICKET_KEY) : null;
            if (back !== password) {
                try { Storage.prototype.removeItem.call(localStorage, TICKET_KEY); } catch (_) {}
                return false;
            }
            return true;
        } catch (_) { return false; }
    };

    /**
     * Read the ticket back, or null. Belt-and-braces: a locked session can
     * only ever produce null or an undecryptable `~v2…` blob — neither may
     * ever be handed to a caller as if it were the password.
     */
    window._kvTicketRead = function () {
        try {
            var v = (typeof window._secGet === 'function') ? window._secGet(TICKET_KEY) : null;
            if (typeof v !== 'string' || !v || v.charAt(0) === '~') return null;
            return v;
        } catch (_) { return null; }
    };

    /**
     * Called from the login/register handlers once the password-derived key is
     * active. Idempotent: re-running with the same password and key only makes
     * sure the legacy blob is gone.
     */
    window._kvMigrate = async function (password) {
        if (!password) return false;
        // The password is now the ONLY way into the vault, so the flows that
        // need it in memory for the rest of this page load (key-blob backup and
        // recovery) get it from here — see loadDecryptedPassword().
        window._vaultSessionPassword = password;
        var keyB64 = (typeof window._secKeyB64 === 'function') ? window._secKeyB64() : null;
        if (!keyB64) return false;
        var opened = await window._kvUnlock(password);
        if (opened && opened.k === keyB64) {
            window._kvTicketWrite(password);
            _destroyLegacyBootstrap();
            return true;
        }
        var created = await window._kvCreate(password, keyB64);
        if (!created) return false;   // fail closed: no vault, no deletion
        window._kvTicketWrite(password);
        _destroyLegacyBootstrap();
        return true;
    };

    window._kvDestroy = function () {
        try {
            if (Storage.prototype.getItem.call(localStorage, VAULT_KEY) === null) return false;
            Storage.prototype.removeItem.call(localStorage, VAULT_KEY);
            return true;
        } catch (_) { return false; }
    };
})();
