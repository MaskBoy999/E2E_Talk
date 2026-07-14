# E2E Talk - Security Documentation

## Table of Contents

- [Overview](#overview)
- [How It Works (Plain English)](#how-it-works-plain-english)
- [Cryptographic Primitives](#cryptographic-primitives)
- [End-to-End Encryption System](#end-to-end-encryption-system)
  - [Server Channel Messages](#server-channel-messages)
  - [Direct Messages](#direct-messages)
  - [File Encryption](#file-encryption)
  - [Envelope Encryption](#envelope-encryption)
  - [Per-Message Key Derivation](#per-message-key-derivation)
- [Key Management](#key-management)
  - [Identity Keys](#identity-keys)
  - [Server Keys](#server-keys)
  - [Prekey Bundles](#prekey-bundles)
  - [File Keys](#file-keys)
  - [Key Fingerprints (TOFU)](#key-fingerprints-tofu)
  - [Key Escrow (Multi-Device)](#key-escrow-multi-device)
- [Authentication & Sessions](#authentication--sessions)
  - [Password Hashing](#password-hashing)
  - [JWT Tokens](#jwt-tokens)
  - [Session Management](#session-management)
  - [Re-Authentication](#re-authentication)
  - [WebSocket Authentication](#websocket-authentication)
- [Transport Security (TLS/HTTPS)](#transport-security-tlshttps)
- [Rate Limiting](#rate-limiting)
- [Security Headers](#security-headers)
- [Input Validation & Injection Prevention](#input-validation--injection-prevention)
- [Access Control](#access-control)
  - [File Downloads](#file-downloads)
  - [Direct Messages](#direct-messages-access)
  - [Servers](#servers-access)
  - [Friend System](#friend-system)
  - [Admin Panel](#admin-panel)
- [Client Security](#client-security)
  - [Local Storage Keys](#local-storage-keys)
  - [XSS Prevention](#xss-prevention)
  - [WSS Enforcement](#wss-enforcement)
- [Known Limitations](#known-limitations)

---

## Overview

E2E Talk is a LAN chat application with end-to-end encryption. The server stores only ciphertext — it never sees the plaintext of your messages.

**Threat Model**: The server is considered untrusted with respect to message content. It can observe:
- Usernames and account IDs
- When messages were sent (timestamps)
- How big messages are (ciphertext sizes)
- Who is friends with whom (friendship graph)
- Who is in which server (membership)

It **cannot** observe:
- Message content
- File content
- Encryption keys
- Passwords

---

## How It Works (Plain English)

When you **register**, your browser generates a secret key pair (like a mailbox with a lock and key). The public part (the lock) is sent to the server. The private part (the key) stays on your device.

When you **send a message**, your browser encrypts it using a special key that only the intended recipients can derive. The encrypted gibberish is sent to the server, which stores it and forwards it to other members.

When someone **receives a message**, their browser decrypts it using the same special key. The server never had this key, so it can't read the message.

For **server channels** (group chats), there's a shared "room key" that all members have. Each message gets its own unique encryption key derived from the room key, so even if you know the room key, you can't work backwards to read old messages.

For **DMs** (private messages), the two users combine their secret keys mathematically (Diffie-Hellman) to create a shared secret that nobody else can compute.

When you **register on a new device**, your secret key is recovered from "escrow" — the server stores an encrypted copy of your key, and your password is the only thing that can decrypt it. This means you can log in on any device and read all your messages, without manually copying keys around.

---

## Cryptographic Primitives

All client-side cryptography is implemented from scratch in `static/crypto.js`. No external JavaScript libraries. No Web Crypto API. Everything runs in pure JavaScript in your browser.

| Primitive | What It Does | Used For |
|-----------|-------------|----------|
| **X25519** | Key exchange — two people each have a secret number and a public number. They exchange public numbers and combine them with their own secret to get a shared secret that nobody else can compute. | Identity keys, DM key agreement, envelope encryption |
| **HKDF-SHA-256** | Key derivation — takes a master key and some extra info ("salt" and "info") and produces a new key. The same master key + different info = different derived keys. | Deriving per-message keys, metadata keys, escrow keys |
| **XChaCha20-Poly1305** | Encryption — takes a key and plaintext, produces ciphertext + authentication tag. The tag lets the receiver verify the message wasn't tampered with. Uses a 24-byte random nonce. | All message encryption, file encryption |
| **HChaCha20** | Converts a 24-byte nonce into a 32-byte subkey for XChaCha20 | Part of XChaCha20-Poly1305 |
| **SHA-256** | Hash function — turns any input into a fixed 32-byte output. One-way: you can't reverse it. | HMAC, fingerprints, invite code hashing |
| **HMAC-SHA-256** | Authentication code — takes a key and a message, produces a tag that verifies the message hasn't been modified | Core of HKDF |
| **Poly1305** | Message authentication code — verifies data integrity | Part of XChaCha20-Poly1305 |
| **Argon2** | Password hashing — deliberately slow and memory-hard to make brute-force attacks impractical | Server-side password storage |

Server-side cryptography (in Rust):

| Primitive | Purpose |
|-----------|---------|
| **Argon2id** | Password hashing with random salt |
| **SHA-256** | Invite code and friend code hashing |
| **HS256 (HMAC-SHA-256)** | JWT token signing |

---

## End-to-End Encryption System

### Server Channel Messages

Server channels (group chats) use a symmetric "server key" that all members share. Here's how it works step by step:

1. **Owner creates a server**: A random 32-byte server key is generated. This key is the "master key" for all messages in this server.

2. **Key distribution**: When a new member joins, the server key is encrypted specifically for them using envelope encryption (see below). The encrypted copy is stored in the `server_keys` database table. Each member gets their own encrypted copy.

3. **Sending a message**:
   - Browser generates a random 16-byte `messageNonce`
   - Derives a unique message key: `HKDF(serverKey, serverKey, "e2e-channel-v1:<channelId>:<messageNonce>", 32)`
   - Encrypts: `ciphertext = XChaCha20-Poly1305(messageKey, plaintext)`
   - Sends `{ ciphertext, messageNonce }` to the server

4. **Receiving a message**:
   - Browser reads the `messageNonce` from the database
   - Derives the same message key using the same HKDF formula
   - Decrypts: `plaintext = XChaCha20-Poly1305_Decrypt(messageKey, ciphertext, nonce, tag)`

5. **Key rotation**: When someone is kicked or leaves, the server owner generates a new server key. Old keys are kept in `server_key_history` so old messages can still be decrypted.

**Why per-message keys?** Even though all members share the same server key, each message gets a unique encryption key. This means:
- Compromising one message's key doesn't affect other messages
- You can't tell which two messages were encrypted with the same server key
- It adds defense-in-depth

### Direct Messages

DMs use asymmetric cryptography (X25519 ECDH) so two users can communicate without sharing a pre-existing secret:

1. **Key agreement**: Each user has an X25519 identity key pair. To send a DM:
   - Sender computes: `sharedSecret = X25519(myPrivateKey, otherUserPublicKey)`
   - The shared secret is the same on both sides because `X25519(a, B) = X25519(b, A)`

2. **Message encryption**:
   - Generate random `messageNonce`
   - Derive key: `HKDF(sharedSecret, sharedSecret, "e2e-dm-v1:<dmChannelId>:<messageNonce>", 32)`
   - Encrypt: `ciphertext = XChaCha20-Poly1305(key, plaintext)`

3. **Multi-device support**: If a user has multiple devices, each device has its own identity key pair. Prekey bundles (stored in `prekey_bundles` table) let any device initiate a DM with any of the other user's devices.

### File Encryption

Files are encrypted before upload. The server never sees file contents.

1. **Key generation**: A random 32-byte `fileKey` is generated per file.

2. **Chunk encryption**: The file is split into chunks. Each chunk is encrypted independently:
   - `encryptedChunk = XChaCha20-Poly1305(fileKey, chunk)`
   - Each chunk gets its own random nonce (embedded in the ciphertext by XChaCha20-Poly1305)

3. **Key distribution**: The `fileKey` itself is encrypted:
   - For channel files: encrypted with the server key via envelope encryption
   - For DM files: encrypted with the recipient's public key via envelope encryption
   - The encrypted file key is stored in the `files` table

4. **Download**: The receiver decrypts the file key, then uses it to decrypt each chunk. Chunks are reassembled in order using `Blob` with `arrayBuffer` type.

5. **Access control**: Only the uploader, their friends, or shared-server members can download (see [File Downloads](#file-downloads)).

### Envelope Encryption

Envelope encryption is used to securely send a key to someone. It's like putting a letter in a locked box and giving the box to someone who has the only key.

```
To encrypt a key for recipient:
1. Generate an ephemeral (temporary) X25519 key pair
2. Compute shared secret: X25519(ephemeralPrivate, recipientPublic)
3. Derive encryption key: HKDF(sharedSecret, sharedSecret, "e2e-envelope-v1", 32)
4. Encrypt the actual key: XChaCha20-Poly1305(derivedKey, keyToSend)
5. Send: { ciphertext, nonce, ephemeralPublicKey }

To decrypt:
1. Compute shared secret: X25519(recipientPrivate, ephemeralPublic)
2. Derive same encryption key (same HKDF)
3. Decrypt: XChaCha20-Poly1305_Decrypt(derivedKey, ciphertext, nonce, tag)
```

Used for:
- Distributing server keys to new members
- Distributing file keys to recipients
- Distributing DM keys to other devices

### Per-Message Key Derivation

The `messageNonce` is the secret ingredient that makes each message's encryption key unique.

**Without per-message nonces:**
- All messages would use the same key
- If an attacker learns one key, they can read all messages

**With per-message nonces:**
- Each message gets `HKDF(serverKey, serverKey, "e2e-channel-v1:<channelId>:<nonce>", 32)`
- Different nonce = different key, even with the same server key
- Knowing one message's key tells you nothing about other messages

The nonce is:
- Generated randomly (16 bytes) for each message
- Stored in the database alongside the ciphertext
- Included in the HKDF info string to ensure uniqueness
- Sent with the message so the receiver can derive the same key

---

## Key Management

### Identity Keys

Every user has an X25519 identity key pair. This is the root of trust for all encryption.

| Property | Value |
|----------|-------|
| Algorithm | X25519 (Curve25519) |
| Key size | 32 bytes (256 bits) |
| Purpose | DM encryption, key distribution, account identity |

**Registration flow:**
1. Browser generates random 32-byte private key
2. Browser derives the 32-byte public key from the private key
3. Public key is sent to the server with registration
4. Private key is saved to localStorage: `e2e_identity_private_<userId>`
5. Public key is also saved locally: `e2e_identity_public_<userId>`

**Multi-device:**
- Each device generates its own identity key pair
- Additional public keys are uploaded via `POST /api/identity/add-key`
- Stored in `user_public_keys` table with a device ID
- Server returns all public keys for a user via `GET /api/identity/{userId}`

**Legacy migration:**
- Old versions stored keys in `e2e_identity_private` (not per-account)
- On login, if the old key's public half matches the account's stored key, it's migrated to the per-account format

### Server Keys

Each server (group) has a symmetric 32-byte key used to encrypt channel messages.

| Property | Value |
|----------|-------|
| Algorithm | Random 32 bytes (symmetric) |
| Purpose | Channel message encryption |
| Distribution | Envelope-encrypted per member |

**Lifecycle:**
1. Server owner generates key via `generateServerKey()`
2. Key is encrypted for each member via envelope encryption
3. Stored in `server_keys` table (one row per member)
4. On key rotation, old keys move to `server_key_history`
5. New keys are generated and distributed fresh

**Key rotation triggers:**
- Owner manually rotates keys
- Member is kicked from the server
- Member leaves the server

### Prekey Bundles

Prekey bundles enable asynchronous DM key establishment (similar to Signal's X3DH protocol).

| Field | Purpose |
|-------|---------|
| `identity_key_public` | User's identity public key |
| `signed_prekey_public` | Temporary public key for key agreement |
| `signed_prekey_signature` | Proof the prekey belongs to the user |
| `one_time_prekey_public` | Single-use key for perfect forward secrecy |

**Flow:**
1. User generates and uploads prekey bundles
2. When someone wants to start a DM, they fetch the target's prekey bundle
3. They use the prekeys to derive a shared secret
4. The shared secret is used to encrypt the first DM message

### File Keys

Each file gets its own random 32-byte encryption key.

| Property | Value |
|----------|-------|
| Algorithm | Random 32 bytes (symmetric) |
| Purpose | Encrypting file chunks |
| Distribution | Encrypted with server key or recipient's identity key |

**Storage:**
- `fileKey` is generated client-side
- Encrypted with server key (channel files) or recipient's public key (DM files)
- Stored in `files.encrypted_file_key` as a blob
- Client caches decrypted key in localStorage: `e2e_file_<fileId>`

### Key Fingerprints (TOFU)

Trust On First Use (TOFU) lets users verify they're communicating with the right person.

**How fingerprints work:**
1. Take the first 8 bytes of the Base64-decoded public key
2. Format as colon-separated hex: `aa:bb:cc:dd:ee:ff:01:02`
3. Store in localStorage: `known_key_fingerprints = { "userId": "aa:bb:..." }`

**Verification flow:**
1. **First time you see someone**: Their fingerprint is stored automatically. You trust them.
2. **Next time you load a DM with them**: Their current fingerprint is compared against what you stored.
3. **Match**: Everything is fine, no action needed.
4. **Mismatch**: An orange warning banner appears: "This user's identity key has changed." You can click "Trust New Key" if you recognize this (e.g., they got a new device), or investigate.

**Limitations:**
- Fingerprint is only 8 bytes (not a full SHA-256 hash)
- Only checked for DMs, not server channels
- No out-of-band verification (no QR code scanning of fingerprints)

### Key Escrow (Multi-Device)

**The problem:** If you register on Device A, then want to use Device B, Device B doesn't have your secret key. All your old encrypted messages on Device A are unreadable on Device B.

**The solution:** Key escrow. Your encrypted secret key is stored on the server, protected by your password.

**How it works step by step:**

**During registration:**
1. Browser generates your identity key pair (private + public)
2. Browser takes your private key and encrypts it using your password:
   ```
   salt = random 16 bytes
   escrowKey = HKDF-SHA-256(password, salt, "e2e-key-escrow-v1", 32)
   encryptedPrivateKey = XChaCha20-Poly1305(escrowKey, privateKey)
   ```
3. The encrypted blob is uploaded to the server: `POST /api/identity/escrow`
4. Server stores: `{ encrypted_private_key, salt, nonce }` in `user_key_escrow` table

**During login on a new device (no local key):**
1. Browser downloads the encrypted blob: `GET /api/identity/escrow`
2. Browser derives the same escrow key: `HKDF-SHA-256(password, salt, "e2e-key-escrow-v1", 32)`
3. Browser decrypts: `privateKey = XChaCha20-Poly1305_Decrypt(escrowKey, encryptedPrivateKey, nonce, tag)`
4. The decrypted private key is saved to localStorage
5. Now this device has the same key as Device A — all messages are readable

**Why this is secure:**
- The server only stores the encrypted blob
- Without your password, the blob is useless
- The password never reaches the server (it's only used client-side for HKDF)
- The salt is random per user, so two users with the same password get different escrow keys
- Even if the server database is leaked, the attacker needs your password to decrypt

**What happens if you forget your password:**
- You lose access to your identity key
- You cannot decrypt old messages
- You'd need to use "Connect with Local Key" from an existing device to import the key manually
- This is by design — there's no backdoor

**The escrow encryption formula:**
```
escrowKey = HKDF-SHA-256(
    ikm = password_bytes,
    salt = random_16_bytes,
    info = "e2e-key-escrow-v1",
    length = 32
)
encrypted = XChaCha20-Poly1305(escrowKey, privateKey)
// stored: { encrypted, salt, nonce }
```

---

## Authentication & Sessions

### Password Hashing

| Property | Value |
|----------|-------|
| Algorithm | Argon2id (via `argon2` crate v0.5) |
| Salt | Random via `SaltString::generate(&mut OsRng)` |
| Parameters | Library defaults (Argon2id variant) |
| Minimum length | 6 characters |

Passwords are hashed server-side during registration and verified during login. The plaintext password is never stored. The hash uses Argon2id, which is memory-hard and resistant to GPU/ASIC attacks.

### JWT Tokens

| Property | Value |
|----------|-------|
| Algorithm | HS256 (HMAC-SHA-256) |
| Expiry | 30 days |
| Secret source | `JWT_SECRET` env var, or auto-generated and persisted to `.env` |
| Claims | `sub` (user ID), `username`, `exp` (expiry timestamp) |

**Token lifecycle:**
1. **Created** during login or re-authentication
2. **Stored** in `localStorage` as `token` and as an `HttpOnly; Secure; SameSite=Strict` cookie
3. **Sent** with every API request via `Authorization: Bearer <token>` header
4. **Validated** server-side on every request (signature + expiry check)
5. **Expires** after 30 days, triggering auto-redirect to login
6. **Re-authentication** extends the session by another 30 days

**Secret management:**
- On first startup, a random 64-character alphanumeric secret is generated
- It's saved to `server/.env` as `JWT_SECRET=<secret>`
- On subsequent startups, the secret is loaded from `.env`
- If `JWT_SECRET` env var is set, it takes priority
- This prevents token invalidation on server restart

### Session Management

**Client-side session handling:**
1. On page load, `checkTokenExpiry()` decodes the JWT and checks the `exp` claim
2. If expired → token and user are removed from localStorage → redirect to login
3. If valid → a `setTimeout` is set to auto-redirect 5 seconds before expiry
4. The timeout is capped at 2^31-1 ms (max JavaScript timer value) to prevent overflow

**Session countdown:**
- Settings > Security shows "Your session expires in: Xd Xh Xm"
- Countdown updates every 60 seconds
- Users can see exactly how long they have before being kicked

**Cookie settings:**
```
HttpOnly  — JavaScript cannot read this cookie (prevents XSS theft)
Secure    — Only sent over HTTPS
SameSite=Strict — Not sent with cross-site requests (prevents CSRF)
Max-Age=2592000 — 30 days
Path=/    — Available on all paths
```

### Re-Authentication

If a user wants to extend their session without logging out:

1. Click "Re-authenticate" in Settings > Security
2. Enter password
3. Browser sends `POST /api/reauth` with the password
4. Server verifies the password against the stored Argon2 hash
5. If valid, a new 30-day JWT is issued
6. Old token is replaced in localStorage
7. Session countdown resets

**Why this exists:**
- Long-lived sessions (30 days) are convenient but risky on shared computers
- Re-authentication lets users manually extend their session
- The countdown timer gives transparency about session state

### WebSocket Authentication

WebSocket connections require authentication:

1. Client connects to `/ws`
2. **First message** must be: `{"type": "auth", "token": "<jwt>"}`
3. Server validates the JWT
4. On success: `{"type": "auth_ok", "user_id": "...", "username": "..."}`
5. On failure: `{"type": "auth_error", "error": "Invalid token"}` → connection closed
6. All subsequent messages are processed under the authenticated user context

**Message authorization:**
- `message_send`: Checks `is_member_of_server()` before broadcasting
- `dm_send`: Checks `is_dm_member()` before broadcasting
- `upload_key_bundle`: Saves prekey bundle for the authenticated user only

---

## Transport Security (TLS/HTTPS)

### Auto-Generated Certificates

On first startup, the server generates self-signed TLS certificates:

1. Uses `rcgen` crate to generate a self-signed certificate
2. Includes `localhost`, `127.0.0.1`, and `::1` as Subject Alternative Names
3. Saves to `server/certs/cert.pem` and `server/certs/key.pem`
4. Serves HTTPS on port 3443 (HTTP on port 3000)

**Limitation:** Self-signed certificates trigger browser warnings ("Not Secure"). Chrome shows a red warning. This is expected — the certificate isn't signed by a trusted Certificate Authority.

### Trusted Certificates with mkcert

For development, `mkcert` creates certificates signed by a local CA that your browser trusts:

```bash
# Install mkcert
mkcert -install              # Install local CA in system trust store
mkcert localhost 127.0.0.1 ::1  # Generate trusted cert

# Set env vars
export TLS_CERT_PATH=localhost+1.pem
export TLS_KEY_PATH=localhost+1-key.pem

# Start server — now HTTPS shows a lock icon
```

### Custom Certificates

For production, use real certificates (Let's Encrypt, etc.):

```bash
export TLS_CERT_PATH=/path/to/fullchain.pem
export TLS_KEY_PATH=/path/to/privkey.pem
```

### HTTP + HTTPS

The server serves both:
- **HTTP** on port 3000 (for development convenience)
- **HTTPS** on port 3443 (for secure connections)

The HSTS header (`max-age=31536000; includeSubDomains; preload`) tells browsers to always use HTTPS for this domain.

---

## Rate Limiting

| Endpoint | Limit | Window | Scope |
|----------|-------|--------|-------|
| `POST /api/login` | 10 attempts | 5 minutes | Per username |
| `POST /api/register` | 10 attempts | 5 minutes | Per username |

**Implementation:**
- In-memory `Mutex<HashMap<String, (u32, Instant)>>` via `LOGIN_RATE_LIMITER`
- Counter resets when the time window elapses
- Returns HTTP 429 with `"Too many login attempts. Try again in 5 minutes."`

**Limitations:**
- Resets on server restart
- Username-based only (not IP-based)
- Not applied to admin login or re-authentication

---

## Security Headers

Every static file response includes these headers:

| Header | Value | What It Does |
|--------|-------|-------------|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'` | Blocks inline scripts, external scripts, iframes, form hijacking |
| `X-Content-Type-Options` | `nosniff` | Browser won't guess file types (prevents MIME sniffing attacks) |
| `X-Frame-Options` | `DENY` | Page can't be embedded in iframes (prevents clickjacking) |
| `Referrer-Policy` | `no-referrer` | No URL information sent to other sites |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` | Forces HTTPS for 1 year |
| `Cache-Control` | `no-store, no-cache, must-revalidate` | Prevents caching of sensitive pages |
| `Pragma` | `no-cache` | HTTP/1.0 cache prevention |
| `Expires` | `0` | Expire immediately |

**CSP breakdown:**
- `script-src 'self'` — Only scripts from the same origin are allowed. This blocks XSS attacks that try to inject `<script>` tags or inline event handlers.
- `style-src 'self' 'unsafe-inline'` — Allows inline styles (needed for dynamic UI)
- `connect-src 'self' ws: wss:` — Allows WebSocket connections on both protocols
- `img-src 'self' data: blob:` — Allows data URIs and blob URLs (used for QR codes and media previews)
- `frame-ancestors 'none'` — Equivalent to `X-Frame-Options: DENY`

---

## Input Validation & Injection Prevention

### SQL Injection

All database queries use parameterized binding via `rusqlite`'s `params![]` macro. This means user input is never interpolated into SQL strings.

**Example:**
```rust
// Safe — parameterized
conn.execute("SELECT * FROM users WHERE username = ?1", params![username]);

// Would be unsafe — but never done in this codebase
conn.execute(&format!("SELECT * FROM users WHERE username = '{}'", username));
```

### XSS Prevention

- CSP `script-src 'self'` blocks inline JavaScript
- HTML escaping via `escapeHtml()` for all user-generated content displayed in the browser
- Admin panel uses `escapeHtml()` for usernames, message content, and all rendered data
- Chat display uses `escapeHtml()` for usernames and message text

### Input Validation

| Check | Where | What |
|-------|-------|------|
| Non-empty username/password | Registration | Prevents blank accounts |
| Password minimum 6 characters | Registration | Basic password strength |
| Non-empty server/channel names | Server/channel creation | Prevents empty names |
| File size positive, max 1 GB | File upload | Prevents abuse |
| Identity key must be 32 bytes | `add_device_key` | Validates key format |
| Banned user check | Server join | Prevents banned users from rejoining |
| Base64 decoding with error handling | All binary data | Prevents malformed input crashes |

---

## Access Control

### File Downloads

The `download_file` endpoint implements a three-tier authorization model:

```
Is the requesting user the file uploader?
├── Yes → Access granted
└── No → Are the requesting user and uploader friends?
    ├── Yes → Access granted
    └── No → Do they share at least one server?
        ├── Yes → Access granted
        └── No → HTTP 403 Forbidden
```

**Upload restrictions:**
- Only the uploader can upload chunks to their own file
- File must not be marked as complete
- File chunks are stored encrypted (`.enc` extension)

### Direct Messages Access

- **DM creation** requires active friendship (`are_friends()` check)
- **Sending messages** requires DM membership (`is_dm_member()` check)
- **Reading messages** requires DM membership
- **Key operations** (`upload_dm_key`, `get_dm_keys`) require DM membership
- **Self-add prevented**: Can't send a friend request to yourself
- **Duplicate request prevented**: Can't send two pending requests to the same person

### Servers Access

- **Joining**: Checked against server ban list
- **Sending messages**: Requires server membership (`is_member_of_server()`)
- **Key operations**: `get_server_keys` requires server membership
- **Kicking**: Only server owner can kick members
- **Banning**: Only server owner can ban members

### Friend System

- **Self-add prevented**: Can't friend yourself
- **Duplicate prevention**: Can't send two pending requests to the same person
- **Auto-mutual acceptance**: If B already requested A, and A sends to B, it auto-accepts
- **Declined requests**: Can be resent (the previous decline is cleared)
- **Unfriending**: Deletes the DM channel, all DM messages, all DM keys, and pending requests between the two users

### Admin Panel

- **First-time setup**: First password submitted becomes the admin password (hashed with Argon2)
- **Token generation**: UUID v4 token, stored in memory with 24-hour TTL
- **Session storage**: Token stored in `sessionStorage` (cleared on tab close)
- **All admin endpoints** require `Authorization: Bearer <token>` header
- **Capabilities**: View/delete all data (users, servers, channels, messages, keys, files, etc.)
- **Security note**: Admin can see ciphertext and nonces, but cannot decrypt messages without private keys

---

## Client Security

### Local Storage Keys

| Key | Type | Purpose |
|-----|------|---------|
| `e2e_identity_private_<userId>` | Base64 string | Your secret X25519 private key |
| `e2e_identity_public_<userId>` | Base64 string | Your X25519 public key |
| `e2e_server_<serverId>` | Base64 string | Current server encryption key |
| `e2e_server_history_<serverId>` | JSON array | Old server keys (for decrypting old messages) |
| `known_key_fingerprints` | JSON object | TOFU fingerprints: `{ "userId": "aa:bb:..." }` |
| `e2e_friend_code` | String | Your 8-character friend code |
| `e2e_file_<fileId>` | Base64 string | Decrypted file encryption key |
| `token` | String | JWT authentication token |
| `user` | JSON string | `{ "id": "...", "username": "..." }` |

### XSS Prevention

- CSP `script-src 'self'` blocks all inline JavaScript
- No `eval()`, no `innerHTML` with user data
- `escapeHtml()` converts `<`, `>`, `&`, `"`, `'` to HTML entities
- Admin panel escapes all rendered data
- Chat display escapes usernames and message content

### WSS Enforcement

The client detects the WebSocket protocol:
```javascript
const isSecure = window.location.protocol === 'https:';
if (!isSecure && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    console.warn('WARNING: WebSocket running over unencrypted ws://. Use HTTPS for secure connections.');
}
const protocol = isSecure ? 'wss:' : 'ws:';
ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
```

---

## Known Limitations

1. **No forward secrecy**: DMs use static ECDH — compromising a long-term private key exposes all past DMs. Server channels use symmetric keys — same issue.

2. **No post-compromise recovery**: If a key is compromised, there's no automatic way to revoke it and re-establish trust. Manual key rotation is required.

3. **Custom crypto implementation**: All JavaScript cryptography is written from scratch. It has not been audited by security professionals. The Web Crypto API (browser-native) would be more battle-tested.

4. **No IP-based rate limiting**: Rate limiting is username-based only. An attacker could try different usernames from the same IP.

5. **Admin tokens in memory**: Lost on server restart. No revocation mechanism beyond expiry. No multi-admin support.

6. **HSTS with self-signed cert**: The HSTS header is set and TLS is active, but the auto-generated self-signed certificate triggers browser warnings. Custom certs via `TLS_CERT_PATH`/`TLS_KEY_PATH` env vars are recommended for production.

7. **TOFU fingerprint is truncated**: Only 8 bytes of the public key are used for the fingerprint, not a full SHA-256 hash. This makes collisions more likely.

8. **No audit logging**: Admin actions (deleting users, clearing data) are not logged anywhere.

9. **Metadata visible**: The server observes usernames, timestamps, ciphertext sizes, friendship graphs, and server membership. This is inherent to the architecture — the server needs this information to route messages.

10. **Key escrow depends on password strength**: If an attacker gets the database AND the user has a weak password, they could brute-force the escrowed key.

11. **Single admin account**: No multi-admin support. The admin password is shared knowledge.

12. **No key verification for server channels**: TOFU verification only applies to DMs. Server channel messages are encrypted with a shared key, so there's no per-user identity to verify.
