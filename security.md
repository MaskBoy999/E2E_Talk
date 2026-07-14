# E2E Talk - Security Documentation

## Table of Contents

- [Overview](#overview)
- [Cryptographic Primitives](#cryptographic-primitives)
- [End-to-End Encryption System](#end-to-end-encryption-system)
- [Key Management](#key-management)
- [Server Security](#server-security)
- [Access Control](#access-control)
- [Client Security](#client-security)
- [Known Limitations](#known-limitations)

---

## Overview

E2E Talk implements a multi-layered security architecture combining end-to-end encryption, server-side access controls, and client-side protections. The server never sees plaintext messages — only ciphertext and nonces are stored.

**Threat Model**: The server is considered an untrusted party with respect to message content. It can observe usernames, timestamps, ciphertext sizes, friendship graphs, and server membership, but cannot decrypt message content without the users' private keys.

---

## Cryptographic Primitives

All cryptography is implemented from scratch in `static/crypto.js` (no external libraries, no Web Crypto API). All primitives are implemented in pure JavaScript.

| Primitive | Implementation | Purpose |
|-----------|---------------|---------|
| X25519 | Montgomery ladder (Curve25519 ECDH) | Identity key exchange, DM key agreement |
| HKDF-SHA-256 | HMAC-SHA-256 based KDF | Key derivation (channel, DM, envelope, metadata keys) |
| XChaCha20-Poly1305 | ChaCha20 stream cipher + Poly1305 MAC | Authenticated encryption for all messages and files |
| HChaCha20 | Subkey derivation from 24-byte nonce | XChaCha20 nonce extension |
| SHA-256 | Custom implementation | HMAC, HKDF, fingerprint generation |
| Argon2 | `argon2` crate (Rust, server-side) | Password hashing (Argon2id variant, random salt) |
| HMAC-SHA-256 | Custom implementation | Core of HKDF |
| Poly1305 | Custom implementation | MAC for XChaCha20-Poly1305 |

---

## End-to-End Encryption System

### Per-Message Key Derivation

Every message — whether in a server channel or DM — uses a unique per-message encryption key. This means even if two messages are encrypted with the same server key, their actual encryption keys differ.

**Channel messages**:
```
serverKey = localStorage["e2e_server_<serverId>"]
messageNonce = randomBytes(16)
key = HKDF-SHA-256(serverKey, serverKey, "e2e-channel-v1:<channelId>:<messageNonce>", 32)
ciphertext = XChaCha20-Poly1305_Encrypt(key, plaintext)
```

**DM messages**:
```
sharedSecret = X25519(myPrivateKey, otherPublicKey)
messageNonce = randomBytes(16)
key = HKDF-SHA-256(sharedSecret, sharedSecret, "e2e-dm-v1:<dmChannelId>:<messageNonce>", 32)
ciphertext = XChaCha20-Poly1305_Encrypt(key, plaintext)
```

The `messageNonce` is stored in the database alongside the ciphertext and used during decryption.

### Server Channel Encryption

Server channels use a symmetric server key distributed to all members via envelope encryption.

1. **Key generation**: Server owner generates a 32-byte random key via `generateServerKey()`
2. **Key distribution**: Server key is encrypted with each member's identity public key using envelope encryption and stored in `server_keys` table
3. **Message encryption**: Each message derives a unique key via HKDF with the server key, channel ID, and per-message nonce
4. **Key rotation**: Old server keys are preserved in `server_key_history` for decrypting historical messages

### Direct Message Encryption

DMs use X25519 ECDH to derive a shared secret between two users.

1. **Key agreement**: `sharedSecret = X25519(myPrivateKey, otherUserPublicKey)`
2. **Key derivation**: `key = HKDF-SHA-256(sharedSecret, sharedSecret, "e2e-dm-v1:<dmChannelId>:<messageNonce>", 32)`
3. **Encryption**: `ciphertext = XChaCha20-Poly1305_Encrypt(key, plaintext)`
4. **Multi-device**: Prekey bundles are stored in `prekey_bundles` table; each device uploads their identity key and prekeys

### File Encryption

Files are encrypted client-side before upload.

1. **Key generation**: `fileKey = randomBytes(32)`
2. **Chunk encryption**: Each chunk is independently encrypted with `XChaCha20-Poly1305(fileKey, chunk)`
3. **Key distribution**: The file key is encrypted with the server key (for channel files) or the recipient's public key (for DM files) and stored in the `files` table
4. **Reassembly**: Decrypted chunks are concatenated client-side using `Blob` with `arrayBuffer` type

### Envelope Encryption

Used for distributing server keys and file keys to specific recipients.

```
ephemeralKeyPair = X25519_GenerateKeyPair()
sharedSecret = X25519(ephemeralPrivateKey, recipientPublicKey)
derivedKey = HKDF-SHA-256(sharedSecret, sharedSecret, "e2e-envelope-v1", 32)
ciphertext = XChaCha20-Poly1305_Encrypt(derivedKey, plaintext)
// Output: { ciphertext, nonce, ephemeralPublicKey }
```

---

## Key Management

### Identity Keys

Each user has an X25519 key pair used for DM encryption and key distribution.

- **Registration**: Client generates a key pair; public key stored in `users.identity_public_key`, private key in localStorage
- **Multi-device**: Additional keys stored in `user_public_keys` table via `/api/identity/add-key`
- **Legacy migration**: Old global keys (`e2e_identity_private`) are migrated if public half matches server's stored key
- **Storage format**: `e2e_identity_private_<userId>` and `e2e_identity_public_<userId>` in localStorage (Base64-encoded)

### Server Keys

Symmetric 32-byte keys used for channel message encryption.

- **Generation**: `generateServerKey()` produces random 32 bytes
- **Distribution**: Encrypted with each member's identity key via envelope encryption, stored in `server_keys` table
- **History**: Old keys preserved in `server_key_history` for historical decryption
- **Rotation**: New key generated on owner action; old key retained for decryption
- **Storage**: `e2e_server_<serverId>` in localStorage (Base64-encoded)

### Prekey Bundles

Used for async DM key establishment (similar to Signal's X3DH).

- **Storage**: `prekey_bundles` table stores identity key, signed prekey, and one-time prekeys per user
- **Upload**: Client generates and uploads via WebSocket `upload_key_bundle` message
- **Retrieval**: `get_dm_keys` endpoint returns the target user's prekey bundle
- **DM key derivation**: `HKDF-SHA-256(ECDH(myIdentity, otherPrekey), ECDH(myEphemeral, otherIdentity), "e2e-dm-v1:<dmChannelId>:<messageNonce>", 32)`

### File Keys

Per-file 32-byte symmetric keys.

- **Generation**: `generateFileKey()` produces random 32 bytes
- **Storage**: Encrypted with server key (channel files) or recipient's identity key (DM files) in `files.encrypted_file_key`
- **Client storage**: `e2e_file_<fileId>` in localStorage (Base64-encoded)

### Key Fingerprints

TOFU (Trust On First Use) verification uses truncated key fingerprints.

- **Generation**: First 8 bytes of the Base64-decoded public key, formatted as colon-separated hex
- **Storage**: `known_key_fingerprints` in localStorage as `{ "userId": "aa:bb:cc:dd:ee:ff:01:02" }`
- **Verification**: On DM load, client compares the other user's current key fingerprint against the stored one
- **Trust model**: First encounter is automatically trusted; subsequent mismatches trigger a warning banner

---

## Server Security

### Password Hashing

- **Algorithm**: Argon2id (via `argon2` crate v0.5, default parameters)
- **Salt**: Cryptographically random via `SaltString::generate(&mut OsRng)`
- **Minimum length**: 6 characters (enforced at registration)

### Authentication

- **JWT**: HS256 (HMAC-SHA-256), 24-hour expiry
- **Secret**: `JWT_SECRET` env var or auto-generated 64-character alphanumeric string
- **WebSocket auth**: First message must be `{"type": "auth", "token": "<jwt>"}`; connection rejected on failure

### Rate Limiting

- **Login**: 10 attempts per 5 minutes per username
- **Registration**: 10 attempts per 5 minutes per username
- **Implementation**: In-memory `Mutex<HashMap<String, (u32, Instant)>>` via `LOGIN_RATE_LIMITER`
- **Limitation**: Resets on server restart; no IP-based limiting; not applied to admin login

### Security Headers

All static file responses include:

| Header | Value | Purpose |
|--------|-------|---------|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'` | Prevents XSS, clickjacking |
| `X-Content-Type-Options` | `nosniff` | Prevents MIME sniffing |
| `X-Frame-Options` | `DENY` | Prevents framing |
| `Referrer-Policy` | `no-referrer` | No referrer leakage |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` | Forces HTTPS (1 year) |
| `Cache-Control` | `no-store, no-cache, must-revalidate` | Prevents caching |
| `Pragma` | `no-cache` | HTTP/1.0 cache prevention |
| `Expires` | `0` | Expire immediately |

### SQL Injection Prevention

All queries use `rusqlite`'s `params![]` macro for parameterized binding. No string interpolation in SQL.

### XSS Prevention

- CSP `script-src 'self'` blocks inline scripts
- HTML escaping via `escapeHtml()` for user-generated content in admin panel and chat display

---

## Access Control

### File Downloads

Three-tier authorization in `download_file`:

1. **Uploader**: If requesting user is the file owner → access granted
2. **Friends**: If requesting user and uploader are friends → access granted
3. **Shared server**: If requesting user and uploader share at least one server → access granted
4. **Denied**: Otherwise → HTTP 403

Upload is restricted to the file uploader only.

### Direct Messages

- **Creation**: Requires active friendship (`are_friends()` check)
- **Messaging**: Requires DM membership (`is_dm_member()` check)
- **Key operations**: `upload_dm_key` and `get_dm_keys` require DM membership

### Servers

- **Join**: Checked against server ban list
- **Message send**: Requires server membership (`is_member_of_server()` check)
- **Key operations**: `get_server_keys` requires server membership

### Friend System

- Self-add prevented
- Duplicate pending requests prevented
- Auto-mutual acceptance: if B already requested A, and A sends to B, it auto-accepts
- Only recipient can accept/decline
- Unfriending deletes DM channel, messages, keys, and pending requests

### Admin Panel

- **Authentication**: Argon2 password, UUID v4 tokens with 24-hour TTL
- **Token storage**: In-memory (`ADMIN_TOKENS` mutex); lost on server restart
- **Session**: Client stores token in `sessionStorage` (cleared on tab close)
- **Capabilities**: View/delete all data; can see ciphertext but cannot decrypt without private keys
- **Limitation**: No multi-admin support; no audit logging; no rate limiting on admin login

---

## Client Security

### Local Storage Keys

| Key | Purpose |
|-----|---------|
| `e2e_identity_private_<userId>` | X25519 private key (Base64) |
| `e2e_identity_public_<userId>` | X25519 public key (Base64) |
| `e2e_server_<serverId>` | Current server key (Base64) |
| `e2e_server_history_<serverId>` | Old server keys (JSON array) |
| `known_key_fingerprints` | TOFU fingerprints (JSON object) |
| `e2e_friend_code` | Plaintext friend code (8 chars) |

### TOFU Key Verification

1. **First encounter**: Fingerprint stored automatically; marked as trusted
2. **Subsequent loads**: Fingerprint compared against stored value
3. **Mismatch**: Orange warning banner displayed with "Trust New Key" button
4. **Trust update**: User must manually click to accept changed key

### WSS Enforcement

Client detects WebSocket protocol and logs a warning when running over unencrypted `ws://` on non-localhost origins.

---

## Known Limitations

1. **No forward secrecy**: DMs use static ECDH; server channels use symmetric keys. Compromise of a long-term key exposes all past messages
2. **No post-compromise recovery**: Key rotation does not automatically revoke old keys
3. **Custom crypto implementation**: Not audited; no Web Crypto API usage
4. **No IP-based rate limiting**: Rate limiting is username-based only
5. **Admin tokens in memory**: Lost on server restart; no revocation mechanism
6. **HSTS without TLS**: HSTS header is set but server defaults to HTTP
7. **TOFU fingerprint is truncated**: Only 8 bytes, not a full hash
8. **No audit logging**: Admin actions are not logged
9. **Metadata visible**: Server observes usernames, timestamps, ciphertext sizes, friendship graphs, and membership
