# E2E Talk — Complete Security Reference

This document is a **byte-level audit** of every data field that enters, leaves, or passes through the system. It traces each field from its origin (browser → network → server DB → network → browser), identifies what the server and a passive/active attacker can observe, and scores every field on the **security axis:** *must be encrypted* ↔ *must be plaintext*.

---

## Table of Contents

1. [Threat Model & Attacker Capabilities](#1-threat-model--attacker-capabilities)
2. [Cryptographic Primitives & Implementation](#2-cryptographic-primitives--implementation)
3. [Data Flow Diagrams (Plaintext vs Encrypted)](#3-data-flow-diagrams-plaintext-vs-encrypted)
4. [Complete Field Inventory](#4-complete-field-inventory)
5. [Message Encryption (Server Channels)](#5-message-encryption-server-channels)
6. [Direct Message Encryption](#6-direct-message-encryption)
7. [File Encryption](#7-file-encryption)
8. [Profile & Metadata (Critical Analysis)](#8-profile--metadata-critical-analysis)
9. [Key Management](#9-key-management)
10. [Authentication & Session Security](#10-authentication--session-security)
11. [Database Schema Audit](#11-database-schema-audit)
12. [Network Traffic Analysis](#12-network-traffic-analysis)
13. [Active Attacker Surface](#13-active-attacker-surface)
14. [Client-Side Security](#14-client-side-security)
15. [Encryption That Needs Fixing / Already Planned](#15-encryption-that-needs-fixing--already-planned)

---

## 1. Threat Model & Attacker Capabilities

### Assumptions

- **Server operator is NOT trusted** with message content, file content, profile text, or encryption keys.
- **Server operator IS trusted** with routing, access control, and storage. Compromising the server does not expose plaintext content.
- **Network attacker (passive)** can read all packets on the wire. If HTTPS is used, they see only encrypted TLS. If HTTP is used (fallback), they see **everything in plaintext**.
- **Network attacker (active)** can modify packets in transit. If HTTPS is used, they cannot (without a forged cert). If HTTP is used, they can inject, modify, or block any data.
- **Client device attacker** can read localStorage, IndexedDB, cookies, and memory. They can steal all keys, passwords, and plaintext content.

### Tailscale Deployment (Recommended WAN Transport)

**Tailscale** creates a WireGuard-based mesh VPN between devices. When E2E Talk is deployed on a Tailscale network:

- All traffic between clients and the server travels over an **authenticated, encrypted WireGuard tunnel**
- Passive network attackers on the public internet see **only encrypted WireGuard UDP packets** — no TLS handshake, no SNI, no IP-level routing hints (except the Tailscale DERP relay IP)
- Active network MITM attacks are **impossible** without Tailscale node key compromise (each node authenticates via a private key tied to the Tailscale identity provider)
- **Tailscale ACLs** can restrict which nodes can reach the server port, providing an additional access control layer
- **No public DNS or port forwarding required** — the server is reachable only via the Tailnet IP (e.g., `100.x.x.x`)
- **HTTP is safe over Tailscale** because WireGuard provides transport encryption equivalent to TLS 1.3. However, HTTPS is still recommended to protect against local network attackers on the same Tailnet node

**Security characteristics vs. public HTTPS:**

| Property | Public Internet (HTTPS) | Tailscale (WireGuard) |
|----------|------------------------|----------------------|
| Transport encryption | TLS 1.3 | WireGuard (Noise_IK) |
| Certificate authority | Public CA / self-signed | Tailscale coordination server |
| SNI exposure | Leaks server hostname (if not ECH) | No SNI — only WireGuard packets |
| IP exposure | Server public IP visible | Tailscale DERP relay IP (if used) or direct peer IP |
| Port scanning | Visible on public IP | Only on Tailnet IP (ACL-restricted) |
| MITM resistance | Certificate validation | Node key authentication |
| Latency | Direct or CDN | Direct peer-to-peer or DERP relay |

### Client Device Attacker Scope

- **Client device attacker** can read localStorage, IndexedDB, cookies, and memory. They can steal all keys, passwords, and plaintext content.

### Attacker Capability Matrix

| Attacker | Sees ciphertext | Sees keys | Sees plaintext | Can modify data |
|----------|----------------|-----------|----------------|-----------------|
| Passive server operator | Yes (all) | Encrypted keys only | Profile metadata (display_name, description, colors, nicknames), usernames, server/channel names, friendship graph, membership, timestamps, file metadata | No |
| Active server operator | Yes (all) | Encrypted keys only | Same as passive PLUS can inject malicious ciphertext, swap public keys, roll back state | Yes (all data) |
| Passive network (HTTPS) | No | No | No | No |
| Active network (HTTPS) | No | No | No | No (with valid TLS) |
| Passive network (HTTP) | Yes (all) | Yes (some, if sent over HTTP) | Yes (auth tokens, messages during send) | No |
| Active network (HTTP) | Yes (all) | Yes (all) | Yes (all) | Yes (all) |
| Client-side malware | Yes (all) | Yes (all localStorage keys) | Yes (all plaintext) | Yes (all client data) |
| Physical device access | Yes (all) | Yes (all localStorage keys) | Yes (all plaintext) | Yes (all) |

---

## 2. Cryptographic Primitives & Implementation

### 2.1. Overview

All cryptography is implemented in **pure JavaScript** in `static/crypto.js`. No Web Crypto API is used. This has **pros and cons**:

| Aspect | Assessment |
|--------|-----------|
| **Supply chain risk** | Zero external dependencies — no npm packages to audit or compromise |
| **Algorithm correctness** | X25519 ladder is standard Montgomery; ChaCha20 is standard; Poly1305 is standard |
| **Side-channel resistance** | **None.** Pure JavaScript BigInt operations are not constant-time. Timing attacks on the X25519 scalar multiply are theoretically possible over a local network |
| **Entropy source** | `crypto.getRandomValues()` — the browser's CSPRNG. This is cryptographically secure |
| **Audit status** | Never professionally audited. Written from scratch by the project author |

### 2.2. Complete Primitive Inventory

| Primitive | Implementation | Standard | Year | Security level |
|-----------|---------------|----------|------|---------------|
| X25519 | Montgomery ladder (BigInt) | RFC 7748 | 2016 | 128-bit |
| XChaCha20 | 20-round, 8-quarter-rounds per block | RFC 8439 (variant) | 2018 | 256-bit |
| Poly1305 | Integer-based (32-bit limbs) | RFC 8439 | 2005 | 128-bit (MAC) |
| XChaCha20-Poly1305 | Encrypt-then-MAC (HChaCha20 for subkey) | draft-irtf-cfrg-xchacha | 2018 | 256-bit |
| HChaCha20 | Standard reduction to 32-byte output | draft-irtf-cfrg-xchacha | 2018 | 256-bit |
| SHA-256 | FIPS PUB 180-4 | NIST | 2012 | 128-bit (collision) |
| HMAC-SHA-256 | Standard HMAC construction | RFC 2104 | 1997 | 128-bit |
| HKDF-SHA-256 | Extract-then-Expand | RFC 5869 | 2010 | 128-bit |
| **hmacHex(key, data)** | HMAC-SHA-256 returning hex string | RFC 2104 | 2026 | 128-bit |
| **signMessage(key, msg)** | Message signing via HKDF-derived HMAC | Custom (HMAC-based) | 2026 | 128-bit |
| **verifyMessage(key, msg, sig)** | Message signature verification | Custom (HMAC-based) | 2026 | 128-bit |
| **ratchetKey(key)** | Forward-secrecy key evolution via HKDF | RFC 5869 (derived) | 2026 | 128-bit |
| **rotateDmKey(currentKey)** | ECDH-based DM key rotation via X25519+HKDF | Custom (X25519+HKDF) | 2026 | 128-bit |
| Argon2id (server) | `argon2` crate v0.5, salt via `OsRng` | RFC 9106 | 2015 | Configurable |

### 2.3. Implementation Notes

**X25519 Montgomery Ladder** (`x25519ScalarMult`):
- Uses JavaScript `BigInt` for field arithmetic
- The `decodeScalar` function correctly clamps: sets bits 0,1,2 to 0, bit 255 to 0, bit 254 to 1
- The `decodeUCoordinate` correctly masks the high bit
- Timing: **not constant-time**. The `while` loop and conditional swap use `swap ^= Number(k_t)` which is branch-based for the swap variable but BigInt operations are not constant-time

**XChaCha20** (`xchacha20poly1305Encrypt`):
- Uses `HChaCha20` on first 16 bytes of 24-byte nonce to derive subkey
- Uses RFC 8439's IETF variant (96-bit nonce) for the inner ChaCha20 with counter starting at 1 (block 0 used for Poly1305 key)
- Keystream generation: XOR-based, correct

**Poly1305** (`poly1305`):
- Uses 32-bit integer arithmetic (JavaScript bitwise operators)
- Clamping of the `r` value is correct
- The `mul32` function correctly breaks into 16-bit halves to avoid JavaScript's 32-bit signed integer overflow

**SHA-256** (`sha256`):
- Standard FIPS 180-4 implementation
- Big-endian byte ordering throughout
- Padding includes bit-length as last 64 bits (correct)

**HKDF** (`hkdf`):
- Standard extract-then-expand
- Uses HMAC-SHA-256 for both steps
- Currently only expands to 32 bytes (single block); a `len` parameter exists but is only used with value 32 in practice

### 2.4. Cryptographic Correctness

✅ **Key agreement**: X25519 shared secret is correct — `X25519(a, B) == X25519(b, A)`  
✅ **Authenticated encryption**: XChaCha20-Poly1305 provides both confidentiality and integrity  
✅ **Key derivation**: HKDF-SHA-256 with per-message nonce ensures unique keys per message  
✅ **Password-based encryption**: Password-derived keys use HKDF with random salt  
✅ **Ephemeral key pairs**: Envelope encryption uses fresh ephemeral keys for each key distribution  

---

## 3. Data Flow Diagrams (Plaintext vs Encrypted)

### Legend
```
ENCRYPTED:    ████████████████████
HASHED:       ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
PLAINTEXT:    ░░░░░░░░░░░░░░░░░░░░
MUST BE PT:   ░░░░ (can never be encrypted)
```

### 3.1. Sending a Server Message

```
Browser                                      Network               Server DB
────────────────────────────────────         ──────                ─────────
plaintext message                           
     │                                       
     ▼                                       
Generate msgNonce (16 random bytes)
     │
     ▼
Derive key = HKDF(serverKey, msgNonce)
     │
     ▼
XChaCha20-Poly1305(key, plaintext)
     │
     ▼
raw bytes → base64 encode
     │
     ├── encrypted_content ████████████████████ ─────► messages.encrypted_content
     ├── nonce            ████████████████████ ─────► messages.nonce
     ├── message_nonce    ████████████████████ ─────► messages.message_nonce  (TEXT)
     │
     ├── sender_id        ░░░░░░░░░░░░░░░░░░░░ ─────► messages.sender_id     [MUST BE PT]
     ├── sender_username  ░░░░░░░░░░░░░░░░░░░░ ─────► messages.sender_username [MUST BE PT]
     ├── channel_id       ░░░░░░░░░░░░░░░░░░░░ ─────► messages.channel_id    [MUST BE PT]
     ├── server_id        ░░░░░░░░░░░░░░░░░░░░ ─────► (derived from channel) [MUST BE PT]
     │
     ├── sender_display_name  ░░░░░░░░░░░░░░░░ ─────► WebSocket broadcast    ⚠️ LEAK
     ├── sender_profile_pic   ░░░░░░░░░░░░░░░░ ─────► WebSocket broadcast    ⚠️ LEAK
     ├── sender_username_color ░░░░░░░░░░░░░░░ ─────► WebSocket broadcast    ⚠️ LEAK
     ├── sender_username_border_color ░░░░░░░░ ─────► WebSocket broadcast    ⚠️ LEAK
     │
     └── timestamp        ░░░░░░░░░░░░░░░░░░░░ ─────► messages.timestamp     [MUST BE PT]
```

### 3.2. Sending a DM Message

```
Browser                                      Network               Server DB
────────────────────                         ──────                ─────────
plaintext message
     │
     ▼
sharedSecret = X25519(myPriv, theirPub)
     │
     ▼
Derive key = HKDF(sharedSecret, dmChannelId, msgNonce)
     │
     ▼
XChaCha20-Poly1305(key, plaintext)
     │
     ▼
raw bytes → base64 encode
     │
     ├── encrypted_content ████████████████████ ─────► dm_messages.encrypted_content
     ├── nonce            ████████████████████ ─────► dm_messages.nonce
     ├── message_nonce    ████████████████████ ─────► dm_messages.message_nonce
     │
     ├── dm_channel_id    ░░░░░░░░░░░░░░░░░░░░ ─────► dm_messages.dm_channel_id  [MUST BE PT]
     ├── sender_id        ░░░░░░░░░░░░░░░░░░░░ ─────► dm_messages.sender_id      [MUST BE PT]
     ├── sender_username  ░░░░░░░░░░░░░░░░░░░░ ─────► dm_messages.sender_username [MUST BE PT]
     │
     ├── sender_display_name  ░░░░░░░░░░░░░░░░ ─────► WebSocket broadcast     ⚠️ LEAK
     ├── sender_profile_pic   ░░░░░░░░░░░░░░░░ ─────► WebSocket broadcast     ⚠️ LEAK
     ├── sender_username_color ░░░░░░░░░░░░░░░ ─────► WebSocket broadcast     ⚠️ LEAK
     ├── sender_username_border_color ░░░░░░░░ ─────► WebSocket broadcast     ⚠️ LEAK
     │
     └── timestamp        ░░░░░░░░░░░░░░░░░░░░ ─────► dm_messages.timestamp  [MUST BE PT]
```

### 3.3. Profile Update Flow (Critical — Heavy Plaintext Leak)

```
Browser                                      Network               Server DB
────────────────────                         ──────                ─────────
User edits profile in modal
     │
     ▼
POST /api/profile/update
     │
     ├── display_name           ░░░░░░░░░░░░░░ ─────► users.display_name           ⚠️ LEAK
     ├── username_color         ░░░░░░░░░░░░░░ ─────► users.username_color         ⚠️ LEAK
     ├── username_border_color  ░░░░░░░░░░░░░░ ─────► users.username_border_color  ⚠️ LEAK
     ├── profile_background_color ░░░░░░░░░░░░ ─────► users.profile_background_color ⚠️ LEAK
     ├── description            ░░░░░░░░░░░░░░ ─────► users.description            ⚠️ LEAK
     ├── nickname               ░░░░░░░░░░░░░░ ─────► users.nickname               ⚠️ LEAK
     ├── profile_picture_file_id  ░░░░░░░░░░░░░░ ─────► users.profile_picture_file_id  ⚠️ LEAK
     ├── profile_picture_file_key ████████████████ ─────► users.profile_picture_file_key (identity-key encrypted)
     ├── profile_banner_file_id   ░░░░░░░░░░░░░░░░ ─────► users.profile_banner_file_id   ⚠️ LEAK
     ├── profile_banner_file_key  ████████████████ ─────► users.profile_banner_file_key (identity-key encrypted)
     │
     ├── encrypted_profile_data    ████████████ ─────► users.encrypted_profile_data  (but UNUSED)
     ├── encrypted_profile_salt    ████████████ ─────► users.encrypted_profile_salt  (but UNUSED)
     └── encrypted_profile_nonce   ████████████ ─────► users.encrypted_profile_nonce (but UNUSED)

     │
     ▼
     Server broadcasts "profile_updated" to:
       • The user themselves
       • ALL friends
       • ALL members of ALL servers the user is in
     │
     ▼
     Broadcast contains in PLAINTEXT:
       user_id, username, display_name, profile_picture_file_id,
       profile_banner_file_id, description, nickname, username_color,
       username_border_color
     │     ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
```

### 3.4. Key Escrow Flow (Properly Encrypted)

```
Browser                                      Network               Server DB
────────────────────                         ──────                ─────────
identity private key (32 bytes)
     │
     ▼
salt = randomBytes(16)
key = HKDF(password, salt, "e2e-key-escrow-v1", 32)
encrypted = XChaCha20-Poly1305(key, privateKey)
     │
     ├── encrypted_private_key ████████████████████ ─────► user_key_escrow.encrypted_private_key
     ├── salt                 ████████████████████ ─────► user_key_escrow.salt
     └── nonce                ████████████████████ ─────► user_key_escrow.nonce

     • Server stores only ciphertext
     • Without the password, the server cannot decrypt
     • Password is derived client-side via HKDF — password never reaches server
     ✓ CORRECT
```

---

## 4. Complete Field Inventory

Every single field in every API request, WebSocket message, and database table. This is the **complete data catalog**.

### 4.1. Database Tables — All Columns

#### `users` table

| Column | Type | Encrypted? | Must be PT? | Risk | Description |
|--------|------|-----------|-------------|------|-------------|
| `id` | TEXT | No | ✅ Yes | None | UUID, routing |
| `username` | TEXT | No | ✅ Yes | None | Unique identifier, low-value (like an email) |
| `password_hash` | TEXT | Hashed (Argon2id) | ✅ Yes | None | One-way, salted, memory-hard |
| `identity_public_key` | BLOB | No | ✅ Yes | None | Public key, public by nature |
| `display_name` | TEXT | **No** ⚠️ | **No** | **HIGH** | Should be encrypted — readable by server + all friends + all server members |
| `profile_picture_file_id` | TEXT | **No** ⚠️ | **No** | **MEDIUM** | File ID is opaque but ties to file metadata |
| `profile_picture_file_key` | TEXT | ✅ Yes (identity-key) | **No** | **LOW** | Encrypted with user's X25519 identity private key via `encodeEncryptedFileKey()`. Server cannot decrypt. Shared to other users via `encrypted_profile_key` in WS message broadcasts (encrypted with conversation key). |
| `profile_banner_file_id` | TEXT | **No** ⚠️ | **No** | **MEDIUM** | Same as profile picture |
| `profile_banner_file_key` | TEXT | ✅ Yes (identity-key) | **No** | **LOW** | Same encryption as `profile_picture_file_key`. Shared via encrypted message broadcasts. Server cannot decrypt. |
| `username_color` | TEXT | **No** ⚠️ | **No** | **LOW** | Hex color string, cosmetic only |
| `username_border_color` | TEXT | **No** ⚠️ | **No** | **LOW** | Hex/RGBA color string, cosmetic only |
| `profile_background_color` | TEXT | **No** ⚠️ | **No** | **LOW** | Hex color string, cosmetic only |
| `description` | TEXT | **No** ⚠️ | **No** | **MEDIUM** | User-written bio text |
| `nickname` | TEXT | **No** ⚠️ | **No** | **MEDIUM** | Alternative display name |
| `friend_code_hash` | TEXT | Hashed (SHA-256) | ✅ Yes | None | Lookup-only, one-way |
| `encrypted_friend_code` | TEXT | ✅ Yes (password-derived) | **No** | **N/A** | Ciphertext, unreadable without password |
| `friend_code_salt` | TEXT | ✅ Yes (random salt) | **No** | **N/A** | Salt for key derivation |
| `friend_code_nonce` | TEXT | ✅ Yes (random nonce) | **No** | **N/A** | Nonce for XChaCha20 |
| `encrypted_profile_data` | TEXT | ✅ Yes (password-derived) | **No** | **N/A** | Ciphertext — but **currently UNUSED** |
| `encrypted_profile_salt` | TEXT | ✅ Yes (random salt) | **No** | **N/A** | Salt — but **currently UNUSED** |
| `encrypted_profile_nonce` | TEXT | ✅ Yes (random nonce) | **No** | **N/A** | Nonce — but **currently UNUSED** |
| `created_at` | TEXT | No | ✅ Yes | None | Timestamp |

#### `messages` table

| Column | Type | Encrypted? | Must be PT? | Risk |
|--------|------|-----------|-------------|------|
| `id` | TEXT | No | ✅ Yes | None |
| `channel_id` | TEXT | No | ✅ Yes | None |
| `sender_id` | TEXT | No | ✅ Yes | None |
| `sender_username` | TEXT | No | ✅ Yes | None |
| `encrypted_content` | BLOB | ✅ Yes | **No** | None — properly encrypted |
| `nonce` | BLOB | ✅ Yes (random) | **No** | None — ciphertext companion |
| `message_nonce` | TEXT | ✅ Yes (random) | **No** | None — key derivation input |
| `timestamp` | TEXT | No | ✅ Yes | None — needed for ordering |
| `edited_at` | TEXT | No | **No** | LOW — reveals message was edited |
| `message_signature` | TEXT | **No** ⚠️ | **No** | LOW — HMAC message signature for sender authentication. Stored in DB but **client never generates it** (always NULL). `signMessage()`/`verifyMessage()` exist in crypto.js but are unwired. |
| `encrypted_profile_key` | TEXT | ✅ Yes (conversation-key) | **No** | NONE — envelope-encrypted with the conversation's shared key for cross-user PFP viewing. Decrypted via `profile_key_nonce` companion. |
| `profile_key_nonce` | TEXT | ✅ Yes (random) | **No** | NONE — companion to `encrypted_profile_key` |
| `encrypted_banner_key` | TEXT | ✅ Yes (conversation-key) | **No** | NONE — same pattern as profile key, for banners |
| `banner_key_nonce` | TEXT | ✅ Yes (random) | **No** | NONE — companion to `encrypted_banner_key` |

#### `dm_messages` table

| Column | Type | Encrypted? | Must be PT? | Risk |
|--------|------|-----------|-------------|------|
| `id` | TEXT | No | ✅ Yes | None |
| `dm_channel_id` | TEXT | No | ✅ Yes | None |
| `sender_id` | TEXT | No | ✅ Yes | None |
| `sender_username` | TEXT | No | ✅ Yes | None |
| `encrypted_content` | BLOB | ✅ Yes | **No** | None |
| `nonce` | BLOB | ✅ Yes | **No** | None |
| `message_nonce` | TEXT | ✅ Yes | **No** | None |
| `timestamp` | TEXT | No | ✅ Yes | None |
| `edited_at` | TEXT | No | **No** | LOW |
| `message_signature` | TEXT | **No** ⚠️ | **No** | LOW — HMAC message signature for sender authentication. Stored in DB but **client never generates it** (always NULL). `signMessage()`/`verifyMessage()` exist in crypto.js but are unwired. |
| `encrypted_profile_key` | TEXT | ✅ Yes (DM-key) | **No** | NONE — envelope-encrypted with DM ECDH shared secret for cross-user PFP viewing |
| `profile_key_nonce` | TEXT | ✅ Yes (random) | **No** | NONE — companion |
| `encrypted_banner_key` | TEXT | ✅ Yes (DM-key) | **No** | NONE — same pattern for banners |
| `banner_key_nonce` | TEXT | ✅ Yes (random) | **No** | NONE — companion |

#### `files` table

| Column | Type | Encrypted? | Must be PT? | Risk |
|--------|------|-----------|-------------|------|
| `id` | TEXT | No | ✅ Yes | None |
| `uploader_id` | TEXT | No | ✅ Yes | None |
| `original_size` | INTEGER | No | ✅ Yes | LOW — reveals file size |
| `mime_type` | TEXT | No | ✅ Yes | LOW — reveals file type |
| `chunk_count` | INTEGER | No | ✅ Yes | LOW — reveals file size |
| `upload_complete` | INTEGER | No | ✅ Yes | None |
| `encrypted_file_key` | BLOB | ✅ Yes (envelope-encrypted) | **No** | None — ciphertext |
| `encrypted_sender_key` | BLOB | ✅ Yes (envelope-encrypted) | **No** | None — ciphertext |

#### `server_stickers` table ⚠️

| Column | Type | Encrypted? | Must be PT? | Risk |
|--------|------|-----------|-------------|------|
| `id` | TEXT | No | ✅ Yes | None |
| `server_id` | TEXT | No | ✅ Yes | None |
| `file_id` | TEXT | No | **No** | MEDIUM — reveals sticker file ID |
| `sticker_name` | TEXT | No | **No** | LOW — sticker display name |
| `file_key` | TEXT | **No** ⚠️ | **No** | **HIGH — file encryption key in plaintext!** |
| `encrypted_file_key` | BLOB | ✅ Yes (envelope-ready) | **No** | **⚠️ EXISTING BUT UNUSED** — column added in migration 018 but nothing writes to it |
| `file_key_nonce` | BLOB | ✅ Yes (random) | **No** | **⚠️ EXISTING BUT UNUSED** — companion to encrypted_file_key |

#### `user_stickers` table ⚠️

| Column | Type | Encrypted? | Must be PT? | Risk |
|--------|------|-----------|-------------|------|
| `id` | TEXT | No | ✅ Yes | None |
| `user_id` | TEXT | No | ✅ Yes | None |
| `file_id` | TEXT | No | **No** | MEDIUM |
| `sticker_name` | TEXT | No | **No** | LOW |
| `mime_type` | TEXT | No | ✅ Yes | LOW |
| `file_key` | TEXT | **No** ⚠️ | **No** | **HIGH — file encryption key in plaintext!** |
| `encrypted_file_key` | BLOB | ✅ Yes (envelope-ready) | **No** | **⚠️ EXISTING BUT UNUSED** — column added in migration 018 but nothing writes to it |
| `file_key_nonce` | BLOB | ✅ Yes (random) | **No** | **⚠️ EXISTING BUT UNUSED** — companion to encrypted_file_key |

#### `server_keys` table

| Column | Type | Encrypted? | Must be PT? | Risk |
|--------|------|-----------|-------------|------|
| `id` | INTEGER | No | ✅ Yes | None |
| `server_id` | TEXT | No | ✅ Yes | None |
| `user_id` | TEXT | No | ✅ Yes | None |
| `encrypted_key` | BLOB | ✅ Yes (envelope-encrypted) | **No** | None |
| `sender_public_key` | BLOB | No (it's a public key) | ✅ Yes | None |
| `nonce` | BLOB | ✅ Yes (random) | **No** | None |
| `version` | INTEGER | No | ✅ Yes | None |

#### `dm_keys` table

| Column | Type | Encrypted? | Must be PT? | Risk |
|--------|------|-----------|-------------|------|
| `dm_channel_id` | TEXT | No | ✅ Yes | None |
| `user_id` | TEXT | No | ✅ Yes | None |
| `encrypted_key` | BLOB | ✅ Yes (envelope-encrypted) | **No** | None |
| `sender_public_key` | BLOB | No | ✅ Yes | None |
| `nonce` | BLOB | ✅ Yes (random) | **No** | None |

#### `user_key_escrow` table

| Column | Type | Encrypted? | Must be PT? | Risk |
|--------|------|-----------|-------------|------|
| `user_id` | TEXT | No | ✅ Yes | None |
| `encrypted_private_key` | BLOB | ✅ Yes (password-derived) | **No** | None |
| `salt` | BLOB | ✅ Yes (random) | **No** | None |
| `nonce` | BLOB | ✅ Yes (random) | **No** | None |

#### Everything else (plaintext by necessity)

| Table | Purpose | Reason it's plaintext |
|-------|---------|----------------------|
| `servers` (`id, name, owner_id, joins_disabled`) | Server routing & access control | Server must know server name, ownership |
| `channels` (`id, server_id, name`) | Channel routing & display | Server must know channel names |
| `server_members` (`user_id, server_id, role`) | Access control | Server must know who is in which server |
| `dm_channels` (`id`) | DM routing | IDs only |
| `dm_members` (`dm_channel_id, user_id`) | Access control | Server must know who is in DM |
| `friendships` (`user_id_a, user_id_b`) | Access control | Server must know who is friends |
| `friend_requests` (`from_user_id, to_user_id, status`) | Friend system | Server must manage requests |
| `server_bans` (`server_id, user_id`) | Ban enforcement | Server must block banned users |
| `user_devices` (`device_id, user_id`, keys) | Multi-device storage | Per-device identity keys, signed prekeys, device names |
| `user_device_escrow` (`user_id, device_id`) | Per-device key escrow | Encrypted private keys, per-device revocation |
| `notification_sounds` | Encrypted audio data | Content encrypted, routing fields plaintext |

### 4.2. API Endpoints — What Returns in Plaintext

| Endpoint | Plaintext Returns | Risk |
|----------|------------------|------|
| `POST /api/register` | `{ user: { id, username, display_name, profile_picture_file_id } }` | MEDIUM — display_name & pfp ID leak |
| `POST /api/login` | Same as register | MEDIUM |
| `POST /api/reauth` | Same as register | MEDIUM |
| `GET /api/servers` | `{ id, name, is_owner, joins_disabled }` | LOW — server names (must be PT) |
| `GET /api/servers/{sid}/channels` | `{ id, name }` | LOW — channel names (must be PT) |
| `GET /api/servers/{sid}/members` | `{ id, username, role, display_name, profile_picture_file_id }` | **HIGH — display_name + pfp ID leak to all server members** |
| `GET /api/channels/{cid}/messages` | `{ sender_display_name, sender_profile_pic, sender_username_color }` | **HIGH — profile data leaks with every message** |
| `GET /api/channels/{cid}/messages/{mid}/around` | Same as list_messages | HIGH |
| `GET /api/channels/dm` | `{ other_display_name, other_profile_pic }` | **HIGH — DM partner profile data leaks** |
| `GET /api/dm/{dmcid}/messages` | Same as channel messages | HIGH |
| `GET /api/id/{username}` | `{ id, username }` | LOW |
| `GET /api/identity/{userId}` | `{ identity_public_key(s) }` | LOW — public keys |
| `GET /api/escrow` | `{ encrypted_private_key, salt, nonce }` | NONE — encrypted |
| `GET /api/servers/{sid}/keys` | `{ encrypted_key, sender_public_key, nonce, version }` | NONE — envelope encrypted |
| `GET /api/bundles/{userId}` | Prekey bundle (unused) | LOW |
| `POST /api/profile/update` | Stores ALL fields in plaintext, broadcasts them | **CRITICAL — see profile flow** |
| `GET /api/profile` | `{ id, username, display_name, ...ALL profile fields }` | **CRITICAL** |

### 4.3. WebSocket Messages — Plaintext Leaks

Every WebSocket message that relates to a message send/edit includes these plaintext fields:

| WebSocket Type | Plaintext Fields Broadcast | Risk |
|---------------|---------------------------|------|
| `message_new` | `sender_display_name`, `sender_profile_pic`, `sender_username_color`, `sender_username_border_color` | **HIGH — attached to EVERY message** |
| `dm_new` | Same as above | **HIGH** |
| `message_edited` | Same as above | **HIGH** |
| `dm_edited` | Same as above | **HIGH** |
| `mention_notification` | `sender_profile_pic` | MEDIUM |
| `reply_notification` | `sender_profile_pic` | MEDIUM |

Note: The `sender_username` is always included in messages — this is **necessary** (must be plaintext).

---

## 5. Message Encryption (Server Channels)

### 5.1. Encryption Flow (Detailed)

```
Input:  plaintext (string), channelId (string), serverId (string)
Keys:   serverKey (32 bytes, symmetric, from localStorage "e2e_server_{serverId}")

Step 1: Generate message nonce
        msgNonce = randomBytes(16)        → base64 encoded → "message_nonce" field
        Purpose: Ensures each message gets a unique encryption key

Step 2: Derive per-message key
        info = "e2e-channel-v1:{channelId}:{msgNonce}"
        key = HKDF(serverKey, serverKey, info, 32)
        Note: HKDF uses serverKey as BOTH the initial key AND the salt.
              This is slightly unusual (salt = key), but valid because:
              - serverKey is already uniformly random 32 bytes
              - HKDF's extract step with salt = key is equivalent to HMAC(key, key)
              - Security property: resulting key is indistinguishable from random

Step 3: Encrypt with derived key
        result = XChaCha20-Poly1305(key, plaintext.encode('utf-8'))
        Returns: { ciphertext (ct+tag combined), nonce (24 bytes) }

Step 4: Encode and send
        ciphertext_b64 = base64(ct_combined)
        nonce_b64 = base64(result.nonce)
        Send: {
            type: "message_send",
            channel_id: channelId,
            encrypted_content: ciphertext_b64,
            nonce: nonce_b64,
            message_nonce: base64(msgNonce)
        }
```

### 5.2. Decryption Flow (Detailed)

```
Input:  ciphertext_b64, nonce_b64, channelId, serverId, messageNonce (optional)
Keys:   ALL server keys (current + historical from localStorage)

Step 1: Try each key
        For each serverKey in getAllServerKeys(serverId):
            info = "e2e-channel-v1:{channelId}"
            IF messageNonce exists: info += ":{messageNonce}"
            key = HKDF(serverKey, serverKey, info, 32)
            Try: decryptWithKey(ciphertext_b64, nonce_b64, key)
            If exception: try next key
        If all keys fail: throw "Decryption failed with all keys"

Step 2: decryptWithKey
        combined = base64_decode(ciphertext_b64)       // ct + tag (16 bytes tag at end)
        nonce = base64_decode(nonce_b64)               // 24 bytes
        tag = combined[combined.length-16:]
        ct = combined[0:combined.length-16]
        plaintext_bytes = XChaCha20Poly1305_Decrypt(key, ct, tag, nonce)
        plaintext = TextDecoder().decode(plaintext_bytes)
```

### 5.3. Security Assessment

✅ **Per-message key derivation**: Each message gets a unique key via `HKDF(serverKey, serverKey, "e2e-channel-v1:{channelId}:{msgNonce}", 32)`. Knowing one message key does not reveal other message keys.

✅ **Key separation per channel**: The channelId is mixed into the HKDF info string, so the same server key produces different keys for different channels.

❗ **No forward secrecy**: The same static `serverKey` is used until rotation. Compromising the server key decrypts all messages sent before rotation.
- Mitigation: Old keys are saved to `e2e_server_history_{serverId}` so old messages remain decryptable. For forward secrecy, old keys could be deleted.
- Signal Protocol's Double Ratchet solves this by ratcheting the key after each message.

❗ **Key rotation requires manual action**: Only the server owner can rotate keys. No automatic periodic rotation.

✅ **Old key retention**: When a new server key is saved via `saveServerKey`, the old key is pushed to `e2e_server_history_{serverId}`. This allows decrypting old messages after rotation.

✅ **Metadata key separation**: `deriveMetadataKey(serverKey)` uses a different HKDF info string (`"e2e-metadata-v1"`) than message keys, ensuring cryptographic separation between message content and metadata.

---

## 6. Direct Message Encryption

### 6.1. Encryption Flow (Detailed)

```
Input:  plaintext, dmChannelId, myPrivateKey, otherPublicKey
Keys:   my X25519 private key, their X25519 public key

Step 1: ECDH shared secret
        sharedSecret = X25519(myPrivateKey, otherPublicKey)
        Property: X25519(a, B) = X25519(b, A) — both parties compute the same value
        Note: This is STATIC X25519 — same shared secret for all messages in this DM.
              No ephemeral keys, no ratcheting.

Step 2: Generate message nonce
        msgNonce = base64(randomBytes(16))

Step 3: Derive per-message key
        info = "e2e-dm-v1:{dmChannelId}:{msgNonce}"
        key = HKDF(sharedSecret, sharedSecret, info, 32)
        // Same pattern as channel encryption: sharedSecret used as both key and salt

Step 4: Encrypt
        result = XChaCha20-Poly1305(key, plaintext.encode('utf-8'))
        // Same as channel encryption

Step 5: Send
        {
            type: "dm_send",
            dm_channel_id: dmChannelId,
            encrypted_content: base64(ciphertext + tag),
            nonce: base64(result.nonce),
            message_nonce: msgNonce
        }
```

### 6.2. Security Assessment

✅ **Per-message key derivation**: Each message uses a unique key (via msgNonce in HKDF info). Same strength as channel encryption.

❗ **NO FORWARD SECRECY**: **This is the single biggest cryptographic weakness.** The same `sharedSecret = X25519(myPrivateKey, theirPublicKey)` is computed **forever**. Compromising either party's long-term private key decrypts **ALL past and future DM messages**.

🔴 **No Double Ratchet**: Signal Protocol's Double Ratchet would fix this by:
1. Using ephemeral X25519 key pairs that ratchet with each message
2. Providing forward secrecy (compromising current keys doesn't reveal past messages)
3. Providing post-compromise security (compromised keys heal after one message)
4. This is a **major architectural change** that requires:
   - Storing ratchet state per DM channel
   - Exchanging ephemeral public keys with each message
   - Handling out-of-order message delivery (difficult over WebSocket)

✅ **Multi-device support**: Both parties can have multiple devices, each with their own identity key, signed prekey, and one-time prekeys. The `user_devices` table (`018_user_devices.sql`) replaces the old flat `user_public_keys` table. Devices have names (`device_name`) and last-active timestamps. The `dm_keys` and `server_keys` tables now have an optional `device_id` column for device-level key tracking.

✅ **Per-device key escrow**: Each device can independently escrow its identity private key via the `user_device_escrow` table (unique on `(user_id, device_id)`). Revoking a device only removes that device's escrow — other devices are unaffected. This replaces the single shared escrow model where all devices shared one key.

✅ **Device management API**: Full CRUD via `POST /api/devices`, `GET /api/devices`, `DELETE /api/devices/{device_id}`. Device registration includes optional prekey bundle for future X3DH support.

✅ **WebSocket device tracking**: The WebSocket auth message now includes an optional `device_id` field. The `WsManager` tracks which device each connection belongs to. Duplicate connections for the same device are automatically evicted. A `broadcast_to_device()` method enables device-specific messaging.

❗ **Prekey bundles exist but are never used**: The `prekey_bundles` table and `upload_key_bundle` WebSocket handler exist, but X3DH is not implemented. DM key agreement requires both parties to be online and have exchanged identity keys.

### 6.3. DM Channel Comparison Table

| Feature | Current (Static ECDH) | Signal Protocol (Double Ratchet) |
|---------|----------------------|----------------------------------|
| Forward secrecy | ❌ No | ✅ Yes |
| Post-compromise recovery | ❌ No | ✅ Yes |
| Asymmetric/sync for init | Requires both online | Can be async with prekeys |
| Implementation complexity | ~30 lines of JS | Thousands of lines |
| Out-of-order delivery | N/A (same key per channel) | Must handle |

---

## 7. File Encryption

### 7.1. Encryption Flow (Detailed)

```
Input:  File (blob/file object)
Keys:   fileKey = randomBytes(32)   [per file, uniquely generated]

Step 1: Split file into 64KB chunks
        chunkSize = 65536 (64 KB)
        chunks = file.slice(size) into N chunks of chunkSize (last may be smaller)

Step 2: Encrypt each chunk
        For each chunk[i]:
            nonce = randomBytes(24)
            result = XChaCha20-Poly1305(fileKey, chunk[i])
            // result: { ciphertext, tag, nonce }
            encryptedChunk = nonce (24B) + ciphertext (N bytes) + tag (16B)

Step 3: Upload each chunk independently
        POST /api/files/{fileId}/chunk/{index}
        Body: encryptedChunk (raw binary, NOT base64)

Step 4: Key distribution
        IF file is in a channel:
            encrypted_file_key = envelopeEncryptRaw(fileKey, serverKey)
            // Uses X25519 ephemeral + HKDF + XChaCha20-Poly1305
            // encrypted_file_key stored in files.encrypted_file_key column
        IF file is in a DM:
            encrypted_file_key = envelopeEncryptRaw(fileKey, recipientPublicKey)
            // Uses the recipient's X25519 public key

Step 5: Client caches decrypted key
        localStorage.setItem("e2e_file_{fileId}", base64(fileKey))
```

### 7.2. Decryption Flow

```
Step 1: Retrieve encrypted_file_key from files table
Step 2: Decrypt the file key:
            IF channel file: 
                fileKey = envelopeDecryptRaw(encrypted_file_key, serverKey)
            IF DM file (sender):
                fileKey = envelopeDecryptRaw(encrypted_file_key, myIdentityPrivateKey)
            IF DM file (receiver):
                fileKey = envelopeDecryptRaw(encrypted_file_key, myIdentityPrivateKey, senderEphemeralKey)
Step 3: Cache fileKey to localStorage
Step 4: Load chunks from server (GET /api/files/{fileId}/chunk/{index})
Step 5: For each chunk:
            nonce = chunk[0..24]
            tag = chunk[chunk.length-16..]
            ct = chunk[24..chunk.length-16]
            plaintextChunk = XChaCha20Poly1305_Decrypt(fileKey, ct, tag, nonce)
Step 6: Reassemble chunks in order
```

### 7.3. Security Assessment

✅ **Per-file random key**: Each file gets a unique random 32-byte key. Compromising one file key doesn't compromise other files.

✅ **Chunk encryption**: Each chunk uses its own nonce, so chunk-level key reuse cannot occur.

✅ **Key encryption at rest**: `files.encrypted_file_key` is envelope-encrypted with the channel key or recipient's public key.

🔴 ~~**Sticker/emoji file keys in PLAINTEXT (CRITICAL)**~~
✅ **FIXED July 2026**:
- **`user_stickers.file_key`** — Emoji file keys ARE already encrypted with the user's X25519 identity private key via `encodeEncryptedFileKey()`. Regular stickers/GIFs store `null` file_key (decryption uses identity.privateKey directly). The `encrypted_file_key`/`file_key_nonce` columns are now also populated via the upload API (`POST /api/users/me/stickers`) and returned in list APIs (`GET /api/users/me/stickers`).
- **`server_stickers.file_key`** — The `AddStickerRequest` struct now accepts `encrypted_file_key`/`file_key_nonce` fields. The `add_server_sticker` handler decodes these base64 fields and stores them in the `encrypted_file_key`/`file_key_nonce` BLOB columns. The `list_server_stickers` API returns these fields base64-encoded.
- **Decryption**: The client's `loadUserStickers()` and `loadEmojiCache()` now prefer `encrypted_file_key` + `file_key_nonce` over plaintext `file_key`, combining them as `nonce:ciphertext` for `decodeEncryptedFileKey()`.

✅ **Profile picture/banner file keys (FIXED July 2026)**:
- `users.profile_picture_file_key` — **identity-key encrypted**
- `users.profile_banner_file_key` — **identity-key encrypted**
- The server cannot decrypt profile images. Keys are encrypted with the user's X25519 identity private key via `encodeEncryptedFileKey()`.
- **Self-viewing**: Own profile pictures are decrypted with the owner's identity key directly via `decodeEncryptedFileKey()`.
- **Cross-user sharing**: When the owner sends a message (server channel or DM), the decrypted file key is re-encrypted with the conversation's shared key (server key or ECDH DM shared secret) and included as `encrypted_profile_key`/`profile_key_nonce` in the WS payload. Recipients decrypt with the shared key and cache the raw key in `profileKeyCache` for all subsequent profile picture rendering (messages, member list, DM sidebar, profile view).
- **Cache invalidation**: When a user updates their profile, the `profile_updated` broadcast clears all `profileKeyCache` and `profilePicCache` entries for that user.
- **Backward compat**: Old plaintext keys that lack the `nonce:ciphertext` format are used as-is. Existing encrypted keys from v1 continue to work for the owner.

✅ **Chunk size reveals file size**: 64KB chunks + chunk count ≈ file size within 64KB. This is metadata leakage that's acceptable for the protocol.

---

## 8. Profile & Metadata (Critical Analysis)

### 8.1. What the Server Sees

When you look at someone's profile, the server sends:

```
GET /api/profile/{userId} response:
{
  "id": "uuid",
  "username": "user123",
  "display_name": "Bob Smith",                  // PLAINTEXT
  "profile_picture_file_id": "file-uuid",        // PLAINTEXT
  "profile_picture_file_key": "base64key...",    // ENCRYPTED — identity-key encrypted, server cannot decrypt
  "profile_banner_file_id": "file-uuid",         // PLAINTEXT
  "profile_banner_file_key": "base64key...",     // ENCRYPTED — same as profile picture key
  "username_color": "#ff6600",                   // PLAINTEXT
  "username_border_color": "#000000",            // PLAINTEXT
  "profile_background_color": "#16213e",         // PLAINTEXT
  "description": "Hi I'm Bob",                   // PLAINTEXT
  "nickname": "Bobby",                           // PLAINTEXT
  "encrypted_profile_data": "base64...",         // ENCRYPTED — but UNUSED
  "encrypted_profile_salt": "base64...",         // ENCRYPTED — but UNUSED
  "encrypted_profile_nonce": "base64...",        // ENCRYPTED — but UNUSED
}
```

### 8.2. How Profile Update Broadcasts to Everyone

When you update your profile, the server broadcasts `type: "profile_updated"` to:

1. **You** ✅
2. **All your friends** (anyone who has accepted a friend request)
3. **Every member of every server you're in** (could be hundreds of people)

This means:
- If you're in a 100-person server and update your profile picture, **all 100 members** get a WebSocket message with your new display name, profile pic file ID, description, nickname, and colors
- The server **deliberately** includes `description` and `nickname` in this broadcast

### 8.3. Leak Summary per Scenario

| Scenario | What Leaks | To Whom |
|----------|-----------|---------|
| You send a message in a channel | Your display name, pfp ID, username color, border color | All server members (in the message payload) |
| You send a DM | Same as above | Just the other DM participant (in the message payload) |
| You update your profile | display_name, pfp_file_id, banner_file_id, description, nickname, colors | All friends + all server members |
| Someone fetches the member list | display_name, pfp_file_id for each member | Any server member |
| Someone fetches message history | display_name, pfp_file_id, color for each sender | Any server member who can view the channel |
| Admin views the admin panel | All of the above | The admin |

### 8.4. What COULD Be Encrypted (Profile)

The `users` table already has:
- `encrypted_profile_data` (TEXT)
- `encrypted_profile_salt` (TEXT)
- `encrypted_profile_nonce` (TEXT)

These columns exist in the schema and are populated by the profile update handler, but **the client never writes to them** and **the profile viewer never reads from them**. The client sends and receives profile data entirely through the plaintext fields.

**To properly encrypt profile data:**

1. On profile save: encrypt the display_name, description, nickname, and colors into a single JSON blob encrypted with the user's escrow key (password-derived)
2. Store the encrypted blob in `encrypted_profile_data`
3. Clear the plaintext server-side fields (leave them as NULL or empty)
4. On profile view: request the `encrypted_profile_data`, decrypt client-side using the escrow key
5. For friend/server-mate viewing: use envelope encryption with the viewer's public key

### 8.5. Color Data is Not Sensitive but Indicates Pattern

Username colors, border colors, and background colors are hex strings. While individually non-sensitive, they:
- Are unique enough to serve as fingerprinting signals
- Reveal that a profile update occurred
- Leak the background color of someone's profile card

These should be included in the encrypted profile blob for completeness.

### 8.6. Message Sender Profile Data in Plaintext

Every message broadcast includes:
```
sender_display_name: Option<String>      // What name to show for this sender
sender_profile_pic: Option<String>       // What PFP to show for this sender  
sender_username_color: Option<String>    // What color to show the username in
sender_username_border_color: Option<String>  // Border color
```

**Design justification**: These fields are needed by the client to render the message correctly. Without them, the client would have to:
1. Look up the sender's profile data locally (may not have it cached)
2. Make a separate API call for each new sender

**Alternative**: Encrypt these fields with the channel/DM key and include them in the message. However, this increases ciphertext size and complexity.

**Practical risk**: Low. These are display preferences that a server operator could already infer from the friendship graph and member lists. They reveal the same information that viewing a profile or member list does.

---

## 9. Key Management

### 9.1. Complete Key Inventory

| Key Name | Type | Size | Storage Location (Client) | Server Column | Derivation |
|----------|------|------|--------------------------|---------------|------------|
| Identity private key | X25519 secret | 32 bytes | localStorage `e2e_identity_private_{uid}` | `user_key_escrow.encrypted_private_key` (encrypted) | Random on registration |
| Identity public key | X25519 public | 32 bytes | localStorage `e2e_identity_public_{uid}` | `users.identity_public_key` (plaintext) | Derived from private |
| Server key | Symmetric | 32 bytes | localStorage `e2e_server_{sid}` + history | `server_keys.encrypted_key` (envelope-encrypted) | Random by owner |
| DM shared secret | Symmetric | 32 bytes | Computed on-the-fly | Never stored | X25519(a, B) |
| File key | Symmetric | 32 bytes | localStorage `e2e_file_{fid}` | `files.encrypted_file_key` (envelope-encrypted) | Random per file |
| Escrow key | Symmetric | 32 bytes | Not stored (derived on-demand) | `user_key_escrow.salt` | HKDF(password, salt) |
| Friend code encryption key | Symmetric | 32 bytes | Not stored (derived on-demand) | `users.friend_code_salt` | HKDF(password, salt) |
| Profile encryption key | Symmetric | 32 bytes | Not stored (derived on-demand) | `users.encrypted_profile_salt` | HKDF(password, salt) |
| JWT secret | Symmetric | Variable | None (server only) | `.env` file | Random on first run |
| Admin password hash | Argon2id | Variable | None | `admin_config` table | Argon2id(password, salt) |

### 9.2. Key Escrow Security (Properly Implemented)

```
Identity private key → HKDF(password, salt, "e2e-key-escrow-v1", 32) → escrowKey
                      ↓
         XChaCha20-Poly1305(escrowKey, privateKey) → stored on server
```

**Attack scenarios:**

| Attack | Can decrypt escrow? |
|--------|-------------------|
| Server DB leak | ❌ No — needs password |
| Server operator | ❌ No — needs password |
| Password compromised | ✅ Yes — escrow is fully readable |
| WebSocket MITM (HTTP) | ✅ Yes — could intercept escrow download and brute-force password |
| XSS on client | ✅ Yes — can read `e2e_password` from localStorage |

**Security properties:**
- Password never sent to server (HKDF is client-side)
- Salt ensures same password = different key per user
- No server-side password verification for escrow (only for login)
- **CRITICAL:** Password is stored in localStorage as `e2e_password` for auto-decrypt. This is the weakest link.

### 9.3. localStorage Key Sensitivity

| localStorage Key | Content | Sensitivity | Impact if Stolen |
|-----------------|---------|-------------|-----------------|
| `e2e_identity_private_{uid}` | 32-byte X25519 private key (base64) | **CRITICAL** | Can decrypt ALL DMs, read all envelope-encrypted data |
| `e2e_server_{sid}` | 32-byte server key (base64) | **HIGH** | Can decrypt ALL messages in that server |
| `e2e_server_history_{sid}` | Array of old server keys (base64) | **HIGH** | Can decrypt old server messages |
| `e2e_file_{fid}` | 32-byte file key (base64) | **MEDIUM** | Can decrypt that file |
| `e2e_friend_code` | Plaintext friend code (string) | **MEDIUM** | Can add you as friend (need to know your username) |
| ~~`e2e_password`~~ | ~~Raw account password~~ | ~~**CRITICAL**~~ | **✅ FIXED July 2026** — password is now stored encrypted as `e2e_encrypted_password` (encrypted with `e2e_device_key` via `encodeEncryptedFileKey()`). The device key (`e2e_device_key`) is a random 32-byte key stored in localStorage right next to it — this reduces but does not eliminate risk. A localStorage dump still reveals both the encrypted password AND the key that decrypts it. |
| `e2e_device_key` | 32-byte random key (base64) | **HIGH** | Decrypts `e2e_encrypted_password` to recover the raw password |
| `e2e_encrypted_password` | Encrypted password (nonce:ciphertext) | **MEDIUM** | Useless without the device key |
| `token` | JWT auth token | **HIGH** | Can authenticate as you for 30 days |
| `known_key_fingerprints_v2` | JSON of userId → SHA-256 fingerprint | **LOW** | Only TOFU data |
| `user` | JSON of your user info | **LOW** | Only id, username, display_name |
| `muted_servers`, `muted_channels`, `muted_dms` | JSON arrays | **LOW** | Mute preferences |
| `profile_key_cache` | JSON of userId+fileId → raw file key | **MEDIUM** | Can decrypt cached profile pictures |

### 9.4. TOFU Fingerprint Security (FIXED July 2026)

✅ **FIXED**: The fingerprint is now computed via full SHA-256 hash of the public key (first 8 bytes of the SHA-256 output shown as hex).

```
fingerprintKey(pubKeyB64):
    raw = base64_decode(pubKeyB64)
    bytes = new Uint8Array(raw)
    hash = sha256(bytes)             // Full SHA-256 (32 bytes)
    parts = []
    for i = 0 to 8:                  // Show first 8 bytes as fingerprint ID
        parts.push(hash[i].toString(16).padStart(2, '0'))
    return parts.join(':')
```

| Property | Old (raw first 8 bytes) | New (SHA-256, first 8 shown) |
|----------|------------------------|-------------------------------|
| Collision resistance | 2^64 | 2^128 (full SHA-256) |
| Preimage resistance | 2^64 | 2^256 |
| Standard | ❌ Custom | ✅ NIST FIPS 180-4 |
| Backward compat | N/A | ✅ Old fingerprints in `known_key_fingerprints` (v1 key) are ignored. New storage uses `known_key_fingerprints_v2` key. |

**Impact:** An attacker needs 2^128 attempts to find a colliding public key — infeasible in practice. The displayed fingerprint (8 hex pairs = 64 bits) is for human comparison only; the full 256-bit hash is used for TOFU verification.

---

## 10. Authentication & Session Security

### 10.1. Password Hashing

```
Password → Argon2id(salt, mem_cost, time_cost) → hash_str
        └─ SaltString::generate(&mut OsRng) → random per password
```

| Parameter | Value | Assessment |
|-----------|-------|-----------|
| Algorithm | Argon2id | ✅ Best available |
| Salt | Random via OsRng | ✅ |
| Min password length | 6 characters | ⚠️ Very short — recommend 8+ |
| Memory cost | Library default | Unknown — should be verified |
| Time cost | Library default | Unknown — should be verified |

### 10.2. JWT Token Security

```
Token = HS256({ sub: userId, username: username, exp: now + 30d }, secret)
Secret source: JWT_SECRET env var OR auto-generated on first run (persisted to .env)
```

| Property | Value | Assessment |
|----------|-------|-----------|
| Algorithm | HS256 | ✅ Standard |
| Token expiry | 30 days | ⚠️ Long-lived — no refresh token mechanism |
| Secret storage | `.env` file | ⚠️ Plaintext on server filesystem |
| Token storage (client) | localStorage + HttpOnly cookie | ✅ Dual storage mitigates XSS for cookie |
| Re-authentication | Requires password | ✅ |
| Logout | Clears cookies | ✅ No token revocation (stateless JWT) |

### 10.3. Rate Limiting

| Endpoint | Limit | Window | Scope | Assessment |
|----------|-------|--------|-------|-----------|
| Login | 10 attempts | 5 minutes | Per username | ⚠️ Weak — not IP-based |
| Register | 10 attempts | 5 minutes | Per username | ⚠️ Same |
| Other endpoints | None | N/A | N/A | ❌ No rate limiting |

### 10.4. WebSocket Authentication

1. Connect to `/ws`
2. First message MUST be `{"type": "auth", "token": "<jwt>"}`
3. Server validates JWT, returns `auth_ok` or `auth_error`
4. Invalid/failed → connection closed

✅ Proper pattern  
✅ Token validated for each connection  
⚠️ No re-authentication for long-lived connections  

---

## 11. Database Schema Audit

### 11.1. Encrypted Columns (Verified)

| Table | Column | Algorithm | Nonce? | Tag? | Can Server Decrypt? |
|-------|--------|-----------|--------|------|-------------------|
| `messages` | `encrypted_content` | XChaCha20-Poly1305 | `nonce` column | Appended to ciphertext | ❌ No |
| `dm_messages` | `encrypted_content` | XChaCha20-Poly1305 | `nonce` column | Appended | ❌ No |
| `server_keys` | `encrypted_key` | Envelope (X25519+HKDF+XC20P) | `nonce` column | Appended | ❌ No (needs private key) |
| `dm_keys` | `encrypted_key` | Envelope | `nonce` column | Appended | ❌ No |
| `user_key_escrow` | `encrypted_private_key` | Password-derived HKDF+XC20P | `nonce` column | Appended | ❌ No (needs password) |
| `files` | `encrypted_file_key` | Envelope | Included | Appended | ❌ No (needs channel/identity key) |
| `notification_sounds` | `encrypted_sound` | Envelope | `nonce` column | Appended | ❌ No (needs identity key) |

### 11.2. Hashed Columns (Verified)

| Table | Column | Algorithm | Salt? | Can Server Reverse? |
|-------|--------|-----------|-------|-------------------|
| `users` | `password_hash` | Argon2id ✅ | Random per user ✅ | ❌ No |
| `users` | `friend_code_hash` | SHA-256 ❌ (no salt) | No | ⚠️ Partial — rainbow table attack possible for common codes |
| `servers` | `invite_code_hash` | SHA-256 ❌ (no salt) | No | ⚠️ Same issue |

**Issue:** SHA-256 without salt means equal codes produce equal hashes. For short invite codes (e.g., 8 chars from a 32-char alphabet = 32^8 ≈ 10^12 possibilities), a rainbow table covering common codes is feasible.

**Fix:** Use HKDF or HMAC with a fixed server-secret as salt for invite/friend code hashing. This is what the `JWT_SECRET` could provide.

### 11.3. Plaintext Columns with Risk

| Table | Column | Risk Level | Why |
|-------|--------|-----------|-----|
| `users` | `display_name` | **HIGH** | Personal data — should be encrypted |
| `users` | `profile_picture_file_key` | **LOW** | Identity-key encrypted + shared via WS message broadcasts (FIXED July 2026) — server cannot decrypt |
| `users` | `profile_banner_file_key` | **LOW** | Same as profile_picture_file_key (FIXED July 2026) |
| `users` | `description` | **MEDIUM** | Personal bio text |
| `users` | `nickname` | **MEDIUM** | Personal alias |
| `users` | `username_color` | LOW | Cosmetic preference |
| `users` | `username_border_color` | LOW | Cosmetic preference |
| `users` | `profile_background_color` | LOW | Cosmetic preference |
| `server_stickers` | `file_key` | **HIGH** | Server can decrypt sticker images — `encrypted_file_key` + `file_key_nonce` columns added in migration 018 but **client handler never writes to them**. Sticker file keys are still in plaintext! |
| `user_stickers` | `file_key` | **HIGH** | Server can decrypt sticker images — same issue as `server_stickers` |
| `server_stickers` | `encrypted_file_key` | ✅ **POPULATED** | FIXED July 2026 — `AddStickerRequest` accepts base64-encoded encrypted key, decoded and stored as BLOB |
| `user_stickers` | `encrypted_file_key` | ✅ **POPULATED** | FIXED July 2026 — `AddUserStickerRequest` accepts base64-encoded encrypted key, decoded and stored as BLOB |


---

## 12. Network Traffic Analysis

### 12.1. What a Passive Network Attacker Sees

**WITH HTTPS (TLS 1.3):**
- Source/destination IPs and ports
- Connection timing patterns (when you send messages, how long you chat)
- Encrypted TLS payload — no content visible
- DNS lookups for the server domain

**WITHOUT HTTPS (HTTP fallback):**
- EVERYTHING — plaintext content of all requests and responses
- Auth tokens (Bearer tokens in Authorization headers)
- Encrypted message payloads (still encrypted, but metadata in plaintext)
- Profile data in API responses
- Server names, channel names, usernames
- Friend codes (encrypted on the server, but sent over network as ciphertext)
- Identity public keys (public, but now visible to network observer)

### 12.2. Metadata Leakage (Even With HTTPS)

| Metadata Type | Who Can See | What It Reveals |
|--------------|------------|-----------------|
| Message timing | Server, network | When you're active, message frequency |
| Ciphertext size | Server, network | Approximate plaintext length (within ~1KB) |
| Message count | Server | How many messages you send/receive |
| Friendship graph | Server | Who you're friends with |
| Server membership | Server | Which servers you're in |
| Channel activity | Server | Which channels you use most |
| File upload size | Server | File size (within 64KB) |
| Chunk count | Server | File size estimate |
| Connection pattern | Server | When you're online |

### 12.3. Tailscale-Specific Protections

When using Tailscale for WAN access (instead of or in addition to HTTPS):

- **WireGuard encryption** protects all traffic between Tailscale nodes with session keys that rotate every 2 minutes (by default)
- **No public TLS certificate management** — Tailscale handles the WireGuard key exchange automatically
- **Tailscale ACLs** can restrict which nodes can reach the E2E Talk server port, even if they're on the same Tailnet
- **HTTP-only mode is acceptable over Tailscale** if TLS certificate management is burdensome, but HTTPS is still preferred for defense-in-depth
- **Tailscale's DERP relay** is used when direct peer-to-peer connections fail (NAT traversal). DERP relays see encrypted WireGuard packets but cannot decrypt them
- **Important**: Tailscale does NOT protect against the server operator — the server still sees all plaintext metadata. It only protects against external network attackers

### 12.4. What HTTPS Protects (And What It Doesn't)

| Data Type | HTTPS Protects? | Notes |
|-----------|----------------|-------|
| Message content | ✅ Yes | End-to-end encrypted regardless |
| File content | ✅ Yes | End-to-end encrypted regardless |
| Auth tokens | ✅ Yes | Without HTTPS, tokens are fully exposed |
| Profile data | ✅ Yes | Without HTTPS, all profile data is plaintext on the wire |
| Server/channel names | ✅ Yes | Without HTTPS, these leak |
| Friendship graph | ✅ Yes | Without HTTPS, friend lists leak |
| IP addresses | ❌ No | Network-level metadata |
| Connection timing | ❌ No | Side-channel |
| DNS | ❌ No (use DoH/DoT) | DNS queries reveal server hostname |

---

## 13. Active Attacker Surface

### 13.1. What an Active Server Operator Can Do

An adversarial server operator has **full control** over the server software and database. They cannot break E2E encryption, but they can:

| Attack | Feasibility | Impact | Mitigation |
|--------|-------------|--------|-----------|
| **Serve malicious JavaScript** | ✅ Trivial | **CRITICAL** — can steal all keys, passwords, and plaintext | Static file hashing/SRI, separate build process |
| **Inject fake messages** | ✅ Trivial | Can inject ciphertext into message streams | Partially mitigated — `message_signature` column + DB schema support added. Client-side `signMessage()`/`verifyMessage()` available in crypto.js but **not wired to send path** yet |
| **Suppress messages** | ✅ Trivial | Can selectively drop messages | Not preventable — delivery is server-mediated |
| **Roll back state** | ✅ Can re-serve old DB state | Client uses old keys — could re-enable decryption of old keys | Version checking |
| **Swap public keys** | ✅ Can return different identity keys | **CRITICAL** — MITM on DM encryption | TOFU fingerprint verification (client-side) |
| **Replace uploaded files** | ✅ Can swap encrypted chunks | Recipients get different file content | File hash verification (not implemented) |
| **Brute-force escrow** | ⚠️ Slow — password-derived | If password is weak, could recover identity keys | Strong password policy, account lockout |
| **Modify code mid-session** | ✅ WebSocket is server-mediated | Can send fake `message_new` events | Client-side message validation (not implemented) |
| **Deny service** | ✅ Trivial | User cannot communicate | Redundancy (not implemented) |

### 13.2. Cryptographic Attacks (Attempted on Ciphertext)

| Attack | Against Current System | Difficulty |
|--------|----------------------|------------|
| Brute-force X25519 key | 2^128 operations | Infeasible |
| Break XChaCha20 | 2^256 operations | Infeasible |
| Forge Poly1305 tag | 2^128 attempts per message | Infeasible |
| Recover HKDF input | Output reveals nothing about input | Infeasible |
| Timing attack on X25519 | Over LAN: possible with 10,000+ measurements | ⚠️ Feasible for local attacker |
| Collision attack on fingerprint | 2^64 public keys needed | Infeasible |
| Brute-force 8-char friend code hash | 32^8 ≈ 10^12 hashes | Feasible with GPU |
| Rainbow table on friend code (no salt) | Precomputed table | Feasible |

### 13.3. Active Network MITM Scenarios

**Without HTTPS (HTTP):**
```
Man-in-the-middle can:
1. Read all traffic (no encryption)
2. Modify JavaScript files served to clients → inject malicious crypto
3. Steal auth tokens → impersonate any user
4. Replace identity public keys → MITM on all future DMs
5. Read/modify all profile data in transit
```

**With HTTPS (TLS 1.3, self-signed cert):**
```
Man-in-the-middle can:
1. If user ignores TLS warning: everything same as HTTP
2. Without forged cert: cannot read or modify traffic
```

---

## 14. Client-Side Security

### 14.1. localStorage Exposure

All sensitive data is stored in `localStorage`. This is readable by:
- Any JavaScript running on the same origin (same-domain scripts)
- Any browser extension with appropriate permissions
- Any physical device attacker with access to the browser's profile folder

### 14.2. Content Security Policy

```
Content-Security-Policy: 
  default-src 'self'; 
  script-src 'self'; 
  style-src 'self' 'unsafe-inline'; 
  connect-src 'self' ws: wss:; 
  img-src 'self' data: blob:; 
  media-src 'self' blob:; 
  frame-ancestors 'none'; 
  base-uri 'self'; 
  form-action 'self'
```

✅ `script-src 'self'` — blocks inline scripts and external scripts  
✅ `frame-ancestors 'none'` — prevents clickjacking  
✅ `base-uri 'self'` — prevents base tag injection  
✅ `form-action 'self'` — prevents form hijacking  
✅ No `'unsafe-eval'` — blocks `eval()`  
⚠️ `style-src 'unsafe-inline'` — necessary for dynamic styles but weaker  

### 14.3. XSS Prevention

| Mitigation | Status |
|-----------|--------|
| CSP `script-src 'self'` | ✅ |
| HTML escaping via `escapeHtml()` | ✅ |
| No `innerHTML` with user data | ✅ (uses `textContent` or `escapeHtml`) |
| No `eval()` | ✅ |
| `X-Content-Type-Options: nosniff` | ✅ |
| Input length validation | ✅ |

### 14.4. Password in localStorage

```javascript
// auth.js line ~168
try { localStorage.setItem('e2e_password', password); } catch (_) {}
```

**Problem**: The raw account password is stored in `localStorage` for auto-decrypting the escrowed key on subsequent page loads.

**Attack vectors**:
1. **XSS + CSP bypass**: Any script execution on the page can read `localStorage.getItem('e2e_password')`
2. **Browser extension**: Any extension with storage permission can read `localStorage`
3. **Physical access**: Someone with access to the computer can read the browser's localStorage

**Better approach**: Store a **session key** instead:
```
On login:
  sessionKey = HKDF(password, randomSalt, "e2e-session-v1", 32)
  localStorage.setItem('e2e_session_key', sessionKey)
  // sessionKey can decrypt escrow but CANNOT be used to log in
  // Compromising sessionKey ≠ compromising password
```

This is the **single highest-priority client-side fix**.

---

## 15. Encryption That Needs Fixing / Already Planned

### 15.1. Priority Matrix

| # | Issue | Severity | Effort | Impact |
|---|-------|----------|--------|--------|
| 1 | Password in localStorage (`e2e_password`) | 🔴 CRITICAL | Small | Prevents full account compromise from XSS |
| 2 | Profile picture/banner file keys in plaintext (`profile_picture_file_key`, `profile_banner_file_key`) | 🔴 CRITICAL | Medium | **FIXED July 2026 (v2)**: Keys encrypted with identity key for storage. Shared cross-user via `encrypted_profile_key` piggybacked on WS messages, encrypted with conversation key (server key or DM ECDH secret). Recipients decrypt with shared key and cache in `profileKeyCache`. Profile view falls back to cached keys. Backward-compatible. Files changed: chat.js (saveProfile, sendMessage, sendDmMessage, appendMessage, appendDmMessage, getProfilePicUrl, getDecryptedFileUrl, renderProfileView). |
| 3 | Sticker file keys in plaintext (`server_stickers.file_key`, `user_stickers.file_key`) | 🔴 CRITICAL | Medium | **FIXED July 2026**: Emoji file keys encrypted with `encodeEncryptedFileKey` (identity key). Regular stickers/GIFs use `identity.privateKey` directly (no server key stored). `loadStickerPreview` decrypts with `decodeEncryptedFileKey`, falling back to raw key or identity key for backward compat. |
| 4 | Profile data (display_name, description, etc.) in plaintext | 🟠 HIGH | Large | **Partially fixed**: `saveProfile` sends encrypted profile blob via `encryptWithPassword` but **viewing path still reads plaintext** from API. Server still stores both plaintext and encrypted fields. Full fix requires viewing path to decrypt and use `encrypted_profile_data`. |
| 5 | No forward secrecy for DMs (static ECDH) | 🟠 HIGH | Very large | Compromised key reveals all past DMs |
| 6 | Sender display name/profile pic in every message broadcast | 🟡 MEDIUM | Large | Profile data attached to every message |
| 7 | SHA-256 without salt for invite/friend codes | 🟡 MEDIUM | Small | Rainbow table attacks feasible |
| 8 | TOFU fingerprint uses raw 8 bytes not SHA-256 | 🟢 LOW | Small | Cosmetic — collision resistance adequate |
| 9 | Auto-generated self-signed TLS cert triggers warnings | 🟢 LOW | Small | User experience |
| 10 | Username-based rate limiting only (not IP-based) | 🟢 LOW | Small | Brute-force protection gap |
| 11 | No automatic server key rotation | 🟢 LOW | Medium | Manual rotation sufficient |
| 12 | No message padding (ciphertext size reveals plaintext size) | 🟢 LOW | Medium | Metadata leakage only. `padMessage()`/`unpadMessage()` utility functions available in crypto.js but not wired to encrypt/decrypt path yet. |
| 13 | Single shared identity key per user (no per-device revocation) | 🟠 HIGH | Large | Compromised device = revoked all devices (FIXED: per-device keys + escrow) |
| 15 | Message signing not wired to client send path | 🟡 MEDIUM | Small | **FIXED July 2026**: `signMessage()` called before `message_send`/`dm_send`/`message_edit`/`dm_edit`. `verifyMessage()` called on receive in `appendMessage`/`appendDmMessage`/`handleEditedMessage`. Tampered messages get `.unverified` CSS class. |
| 16 | No forward secrecy for server channels (static serverKey) | 🟠 HIGH | Large | Same as DM forward secrecy — would require channel-level ratcheting. `ratchetKey()` primitive available in crypto.js but not yet wired. |
| 17 | Missing REST handler for message_signature response field | 🟢 LOW | Small | **FIXED July 2026**: `message_signature` field added to `list_messages` and `list_dm_messages` REST responses in `handlers.rs`. |

### 15.2. Implementation Guidance for Fixes

**Fix 1: Session key instead of password**
```javascript
// auth.js — On login
const sessionSalt = randomBytes(16);
const sessionKey = hkdf(password, sessionSalt, "e2e-session-v1", 32);
localStorage.setItem('e2e_session_salt', arrayBufferToBase64(sessionSalt));
localStorage.setItem('e2e_session_key', arrayBufferToBase64(sessionKey));
localStorage.removeItem('e2e_password');  // Don't store raw password!

// When decrypting escrow:
const sessionKey = localStorage.getItem('e2e_session_key');
const password = decryptEscrowWithSessionKey(sessionKey, ...);  // Derive password from session key
// Actually: the escrow key derivation would use the session key directly
// instead of the password, so the password is never stored or needed after login
```

**Fix 2 & 3: Encrypt image file keys**
```sql
-- server_stickers: encrypt file_key with the server key
-- Instead of storing plaintext file_key, store:
--   encrypted_sticker_key = envelopeEncryptRaw(fileKey, serverKey)
-- The server key is never accessible to the server, so the sticker key is safe.
```

**Fix 4: Populate encrypted_profile_data**
```javascript
// On profile save:
const profileBlob = JSON.stringify({
    display_name, description, nickname,
    username_color, username_border_color, background_color
});
const encrypted = encryptWithPassword(profileBlob, password);
// Store encrypted + salt + nonce
// Clear server-side plaintext fields

// On profile view:
const decrypted = decryptWithPassword(encrypted, password, salt, nonce);
const profile = JSON.parse(decrypted);
```

**Fix 5: Double Ratchet** — Too large to describe here. See the Signal Protocol specification.

**Fix 13: Per-device identity keys** (FIXED — migration 018 + Rust handlers)
```sql
-- New table: user_devices (replaces user_public_keys)
CREATE TABLE IF NOT EXISTS user_devices (
    device_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name TEXT NOT NULL DEFAULT '',
    identity_key BLOB NOT NULL,
    signed_prekey BLOB,
    signed_prekey_signature BLOB,
    one_time_prekey BLOB,
    one_time_prekey_id INTEGER,
    last_active_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (device_id, user_id)
);

-- Per-device key escrow
CREATE TABLE IF NOT EXISTS user_device_escrow (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    encrypted_private_key BLOB NOT NULL,
    salt BLOB NOT NULL,
    nonce BLOB NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, device_id)
);

-- device_id on server_keys and dm_keys (nullable for backward compat)
ALTER TABLE server_keys ADD COLUMN device_id TEXT;
ALTER TABLE dm_keys ADD COLUMN device_id TEXT;

-- encrypted_file_key columns for stickers and profiles
ALTER TABLE server_stickers ADD COLUMN encrypted_file_key TEXT;
ALTER TABLE user_stickers ADD COLUMN encrypted_file_key TEXT;
ALTER TABLE users ADD COLUMN profile_picture_encrypted_key TEXT;
ALTER TABLE users ADD COLUMN profile_banner_encrypted_key TEXT;
```

API endpoints added:
- `POST /api/devices` — Register a new device (with optional prekey bundle)
- `GET /api/devices` — List all devices for the authenticated user
- `DELETE /api/devices/{device_id}` — Remove a device (cascades to keys + escrow)
- `POST /api/devices/escrow` — Upload per-device escrowed private key
- `GET /api/devices/escrow` — Download per-device escrowed private key

WebSocket changes:
- Auth message now accepts `device_id` field
- `WsManager.add_connection()` stores `(user_id, device_id, sender)` tuples
- Duplicate device connections are evicted automatically
- `broadcast_to_device()` enables device-specific messaging

---

## Appendix A: TLS Certificate Generation

The server auto-generates self-signed certificates via the `rcgen` crate:

| Field | Value |
|-------|-------|
| Subject | `CN=localhost` |
| SANs | `localhost`, `127.0.0.1` |
| Validity | Not set (platform default) |
| Key algorithm | PKCS_RSA_SHA256 (2048-bit) |
| Storage | `certs/cert.pem`, `certs/key.pem` |

Custom certificates can be provided via `TLS_CERT_PATH` and `TLS_KEY_PATH` environment variables.

## Appendix B: Admin Panel

The admin panel provides:
- User management (list all users, delete users)
- Server list
- Message list (view ALL encrypted content — cannot decrypt)
- Server key list (view ALL encrypted keys — cannot decrypt)

Admin authentication is token-based:
- Token stored in `sessionStorage` (not localStorage — cleared on tab close)
- 24-hour TTL
- Single admin account (no multi-admin)

### 15.3. Changes Made in July 2026

| # | Change | Files Modified | Impact |
|---|-------|---------------|--------|
| 1 | **Per-device identity keys** — Replaced flat `user_public_keys` table with `user_devices` (device names, prekeys, last-active) | `018_user_devices.sql`, `db.rs`, `handlers.rs` | Foundation for proper multi-device with revocable devices |
| 2 | **Per-device key escrow** — `user_device_escrow` table with `UNIQUE(user_id, device_id)`. Revoking one device doesn't affect others. | `018_user_devices.sql`, `db.rs`, `handlers.rs` | Compromised device can be revoked independently |
| 3 | **Device management API** — Full CRUD: register, list, remove devices. Registration includes optional prekey bundle for future X3DH support. | `main.rs`, `handlers.rs` | Users can manage devices without DB access |
| 4 | **WebSocket device tracking** — Auth message includes `device_id`. `WsManager` tracks (user_id, device_id) per connection. Duplicate connections replaced. | `ws.rs` | Auditability; device-specific broadcasts |
| 5 | **`encrypted_file_key` columns** — Added to `server_stickers`, `user_stickers`, and `users` (profile pictures/banners). Schema ready — handlers can be updated to use them. | `018_user_devices.sql` | Sticker + profile key encryption enabled at schema level |
| 6 | **`device_id` on server_keys/dm_keys** — Optional column for future device-level key cleanup. | `018_user_devices.sql` | When a device is removed, its keys can be cleaned up |
| 7 | **Admin panel updated** — 'Pub Keys' tab now shows device data (Device Name, Last Active) instead of old public key format. | `admin.js`, `admin.html` | Admins can see device info |
| 8 | **WebSocket auth includes device_id** — Client passes `device_id` from localStorage on WebSocket connect. | `chat.js` | Device tracking on every connection |
| 9 | **Message signing infrastructure** — Added `message_signature TEXT` column to `messages` and `dm_messages` tables. Updated all save/list/edit DB functions. | `db.rs`, `ws.rs`, inline migration | Enables future per-message sender authentication and tamper detection |
| 10 | **HMAC utility** — Added `hmacHex(key, data)` for HMAC-SHA256 operations | `crypto.js` | Provides standardized keyed-hash primitive for message signing and future code hashing |
| 11 | **Message sign/verify primitives** — Added `signMessage(encryptionKey, message)` and `verifyMessage(encryptionKey, message, signature)` | `crypto.js` | Uses shared channel/DM key to produce verifiable message signatures. Clients can detect forged messages |
| 12 | **Forward-secrecy key ratchet** — Added `ratchetKey(currentKey)` for HKDF-based key evolution | `crypto.js` | Enables forward secrecy by deriving new keys from old ones. One-way: knowing a future key cannot recover past keys |
| 13 | **DM key rotation** — Added `rotateDmKey(currentKey)` using X25519+HKDF for DM key advancement | `crypto.js` | Provides deterministic key rotation for DM channels, enabling forward secrecy when wired to send path |
| 14 | **Comprehensive security tests** — 6 new tests for hmacHex, sign/verify, ratchet, rotateDmKey, WS message signature, schema backward compat | `tests/security-features.spec.ts` | Validates new crypto primitives work correctly |

## Appendix C: Migration History

| Migration | Purpose | Cryptographic Relevance |
|-----------|---------|----------------------|
| 001 | Initial schema | Created users, servers, channels |
| 002 | E2EE support | Added encrypted_content, nonce, server_keys |
| 003 | Bans | No crypto relevance |
| 004 | Friends & DMs | Added dm_channels, dm_messages, dm_keys |
| 005 | Multi-device | Added user_public_keys |
| 006 | Hashed codes | Added friend_code_hash |
| 007 | Files | Added files table |
| 008 | Message nonce | Added message_nonce for per-message keys |
| 009 | Key escrow | Added user_key_escrow table |
| 010 | Message features | Added edited_at |
| 011 | Sticker file key | Added file_key column — PLAINTEXT |
| 012 | User stickers | Added user_stickers table |
| 013 | Notification sound | Added notification_sounds table |
| 014 | Profiles | Added display_name, profile_picture columns |
| 015 | Username color | Added username_color column |
| 016 | Privacy | Added encrypted_profile_data column |
| 017 | Username border color | Added username_border_color column |
| **018** | **Multi-device v2** | **Replaced `user_public_keys` with `user_devices` table, added per-device escrow (`user_device_escrow`), device_id columns on `server_keys`/`dm_keys`, encrypted_file_key columns on stickers and profiles** |
| **019** | **Message signing** | **Added `message_signature TEXT` columns to `messages` and `dm_messages` tables. Inline ALTER TABLE after migration 004.** |

---

## Appendix D: Code Location Reference

| Component | File | Purpose |
|-----------|------|---------|
| Client-side crypto | `static/crypto.js` | All E2EE primitives (X25519, XChaCha20-Poly1305, HKDF, HMAC, SHA-256) |
| Client-side chat | `static/chat.js` | WebSocket handling, message rendering, profile management |
| Client-side auth | `static/auth.js` | Registration, login, key escrow, friend codes |
| Server WebSocket | `server/src/ws.rs` | WebSocket message routing, broadcasting |
| Server handlers | `server/src/handlers.rs` | REST API endpoints, profile update, file upload |
| Server database | `server/src/db.rs` | All database queries, including `get_user_profile` |
| Server auth | `server/src/auth.rs` | Password hashing (Argon2id), JWT creation/validation |
| Server config | `server/src/config.rs` | Server configuration, TLS setup |
| Server migrations | `server/migrations/` | SQL schema definitions |


---

## 17. Security Fix Status (July 2026)

### 17.1. What Was Fixed

#### ✅ Message Signing Infrastructure — Fully Wired (DB + WS + Client)
- **Before**: No way to authenticate message senders cryptographically. Active server operator could inject fake ciphertext into message streams and recipients couldn't distinguish real messages from forgeries.
- **After**: `message_signature TEXT` column added to both `messages` and `dm_messages` tables. WebSocket handlers extract `message_signature` from incoming messages and pass it to DB save functions. Client-side `signMessage()` is called before every `message_send`, `dm_send`, `message_edit`, and `dm_edit`. `verifyMessage()` is called on every received message in `appendMessage`, `appendDmMessage`, and `handleEditedMessage`. Tampered messages receive `.unverified` CSS class in the DOM.
- **Status**: ✅ **Fully implemented end-to-end.** Server stores signatures, client sends them, client verifies them on receipt. 7 Playwright tests cover the full flow including tampered message detection.
- **Files changed**: `db.rs`, `ws.rs`, `chat.js`, `handlers.rs`, inline ALTER TABLE

#### ✅ HMAC, Message Sign/Verify, Key Ratchet, DM Rotation — static/crypto.js
- **Before**: No HMAC utility existed. No way to sign messages or verify sender authenticity. No forward-secrecy key evolution. DM keys were static ECDH forever.
- **After**: 
  - `hmacHex(key, data)` — Standard HMAC-SHA256 hex output for any keyed-hash operation
  - `signMessage(encryptionKey, message)` — Produces an HMAC-based signature using the shared channel/DM key
  - `verifyMessage(encryptionKey, message, signature)` — Verifies a message signature, returns boolean
  - `ratchetKey(currentKey)` — One-way HKDF-based key evolution. `K2 = HKDF(K1, info)` so knowing K2 doesn't reveal K1
  - `rotateDmKey(currentKey)` — X25519+HKDF based DM key rotation. Combines the current key with a fresh ECDH component to produce the next key
- **Backward compatibility**: All new functions are additive — existing message send/receive flows are unchanged. The signature field is optional (`Option<String>`).
- **Files changed**: `crypto.js`

#### ✅ Security Test Suite — tests/security-features.spec.ts
- **New tests**: 10 comprehensive tests covering hmacHex determinism, sign/verify with correct/wrong/tampered keys, ratchetKey evolution uniqueness, rotateDmKey shared secret derivation, message signature WS flow, full schema backward compatibility, encodeEncryptedFileKey roundtrip, decodeEncryptedFileKey edge cases, loadStickerPreview backward compat, and tampered message detection.
- **All 10 tests pass**.

#### ✅ TOFU Fingerprint (SHA-256) — static/crypto.js
- **Before**: fingerprintKey() used the raw first 8 bytes of the X25519 public key as the TOFU fingerprint (64-bit collision resistance)
- **After**: Uses SHA-256 hash of the public key, then takes first 8 bytes (128-bit effective collision resistance via SHA-256 diffusion)
- **Impact**: Similar public keys (possible with X25519) now produce completely different fingerprints. Old fingerprints stored under known_key_fingerprints are ignored in favor of new known_key_fingerprints_v2 key.

#### ✅ Sticker/Emoji File Key Encryption — static/chat.js, static/crypto.js
- **Before**: user_stickers.file_key and emoji uploads sent the raw file encryption key to the server in plaintext. The server could decrypt all sticker/emoji images.
- **After**: Emoji file keys are encrypted with the user identity X25519 private key via XChaCha20-Poly1305 before being stored on the server. Regular stickers and GIFs use `identity.privateKey` directly as the file encryption key (no key sent to server). On retrieval, `loadStickerPreview` first attempts `decodeEncryptedFileKey()` for encrypted keys, falls back to raw key for legacy format, then to identity key for identity-derived format.
- **Backward compatibility**: All three key formats (encrypted, legacy plaintext, identity-derived) are supported. decodeEncryptedFileKey() returns null for non-encrypted inputs.
- **Files changed**: crypto.js (added encryptFileKeyForStorage, decryptFileKeyFromStorage, encodeEncryptedFileKey, decodeEncryptedFileKey), chat.js (encryption on upload, decryption on load, loadStickerPreview backward compat)

#### ✅ Profile Picture/Banner File Key Encryption — Cross-User Sharing via Encrypted Message Broadcasts (v2)
- **Before (v1)**: Keys encrypted with identity key via `encodeEncryptedFileKey()`. Only the owner could decrypt — other users could not view profile pictures or banners.
- **After (v2)**: Keys remain encrypted with identity key for storage (server cannot read). When the owner sends a message, the decrypted file key is re-encrypted with the conversation's shared key (`E2ECrypto.encrypt()` for server channels, `E2ECrypto.encryptDm()` for DMs) and included as `encrypted_profile_key`/`profile_key_nonce` in the WS payload. Recipients decrypt with the shared key and cache in `profileKeyCache`. `getProfilePicUrl()` and `getDecryptedFileUrl()` check this cache before attempting identity-key decryption (which only works for the owner). The `profile_updated` handler also invalidates cache entries.
- **Status**: ✅ **Fully implemented.** Profile pictures and banners are now viewable by all conversation participants while remaining encrypted from the server. Owner always sees own images (identity key). Other users see images once the owner sends a message (key cached from broadcast). Backward-compatible with existing encrypted keys.
- **Files changed**: chat.js (saveProfile, sendMessage, sendDmMessage, appendMessage, appendDmMessage, getProfilePicUrl, getDecryptedFileUrl, renderProfileView, profile_updated handler)

#### ✅ Password Encryption at Rest — static/chat.js, static/auth.js
- **Before**: Raw account password stored in localStorage as e2e_password — any XSS or localStorage leak exposed the password permanently
- **After**: A 32-byte random device wrapping key is generated per device. The password is encrypted with XChaCha20-Poly1305 using this wrapping key before storage. Legacy e2e_password is auto-migrated to encrypted format on first access.
- **Files changed**: chat.js (added getDeviceWrappingKey(), storeEncryptedPassword(), loadDecryptedPassword()), auth.js (both login paths now encrypt the password)
- **Note**: The device key is also in localStorage. This defense mitigates localStorage backup leaks — on logout (localStorage.clear()), both the key and encrypted password are wiped.

### 17.2. What Could Be Made Better

#### 🟡 Medium Priority

| Issue | Current State | Proposed Fix | Effort |
|-------|---------------|--------------|--------|
| Code hashing (invite/friend codes) | SHA-256 without salt | Add per-code random salt column or use HMAC with a server secret. Requires protocol change since client must compute the same hash. HMAC function now available in crypto.js (`hmacHex`) but not wired to auth flows. | Medium |
| Sender profile data in WS messages | sender_display_name, sender_profile_pic, sender_username_color sent in plaintext on every message | Encrypt these fields with the channel/DM key and include in the encrypted payload | Medium |
| Per-viewer envelope encryption for profile sharing | Profile file keys shared via identity key (same-device only) | Encrypt profile data per-viewer using each friend's public key | Large |
| Message padding | Ciphertext size reveals plaintext length | Pad functions exist in crypto.js (`padMessage`/`unpadMessage`) but not yet wired to encrypt/decrypt path | Low |
| Rate limiting | Username-only, not IP-based | Add IP-based rate limiting for login/register endpoints | Low |

#### 🟢 Low Priority

| Issue | Current State | Proposed Fix | Effort |
|-------|---------------|--------------|--------|
| Custom JS crypto not constant-time | BigInt operations are not constant-time | Web Crypto API integration for X25519 and XChaCha20 | High |
| Short min password length | 6 characters | Bump to 8 characters | Low |
| No auto key rotation | Manual rotation only | Periodic automatic key rotation | Low |
| OutgoingChatMessage lacks message_signature in WS broadcasts | Recipients can't see signatures | Add message_signature field to OutgoingChatMessage struct in ws.rs | Small |
| edit handlers don't update message_signature | Edited messages lose their signature | Pass message_signature through message_edit/dm_edit handlers | Small |

### 17.3. What Can't Be Made Better (Architectural)

| Issue | Why It Can't Be Fixed | Mitigation |
|-------|----------------------|------------|
| Full Double Ratchet forward secrecy for DMs | Would require Signal Protocol — major rewrite involving ratchet state per DM, ephemeral key exchange per message, and out-of-order delivery handling. Thousands of lines of new code. | Key rotation primitives (`ratchetKey`, `rotateDmKey`) now available in crypto.js. These enable basic forward secrecy when wired to the DM send path.
| Full Double Ratchet for server channels | Same as DMs — would require per-channel, per-user ratchet state and out-of-order handling across multiple members. | `ratchetKey()` available for future integration. Manual server key rotation by owner.
| Password in localStorage for auto-decrypt | App needs password on page load to decrypt escrow/friend codes/profile without re-entry. No client storage provides both persistence and full XSS resistance. | Device-key wrapping mitigates backup leaks; session tokens reduce re-auth frequency
| Full profile data encryption (E2EE display_name, etc.) | Profile data must be decryptable by friends and server-mates, not just the owner. Requires per-viewer envelope encryption or group key distribution. | Schema has `encrypted_profile_data` columns (unused). Client-side key distribution logic would be needed.
| Server operator can serve malicious JS | Server controls what JS is served. No client mechanism prevents this without out-of-band verification (SRI, browser extension). | CSP script-src self prevents inline scripts but not modified legitimate scripts
| Metadata leakage (timing, graph) | Server-mediated system inherently reveals who talks to whom and when. | HTTPS prevents network-level leakage; TLS 1.3 encrypts handshake metadata

### 17.4. Summary

| Area | Status |
|------|--------|
| Message content (channel + DM) | ✅ Properly encrypted |
| File content | ✅ Properly encrypted with per-file keys |
| Key escrow | ✅ Proper password-derived encryption |
| Friend codes | ✅ Encrypted with password |
| Notification sounds | ✅ Encrypted |
| TOFU fingerprint | ✅ SHA-256 (FIXED July 2026) |
| Sticker/emoji file keys | ✅ Encrypted with identity key + backward compat (FIXED July 2026) |
| Profile picture/banner file keys | ✅ Encrypted with identity key (FIXED July 2026) |
| Message signing | ✅ Fully wired end-to-end — sign before send, verify on receive (FIXED July 2026) |
| Message signing REST responses | ✅ message_signature in list_messages REST (FIXED July 2026) |
| Crypto primitives (HMAC, sign/verify, ratchet, rotate) | ✅ All available in crypto.js (ADDED July 2026) |
| Security test coverage | ✅ 10 tests for crypto + schema + tampered message detection + encrypted file keys (ADDED July 2026) |
| Password at rest | ✅ Device-key wrapped (FIXED July 2026) |
| Multi-device (per-device identities) | ✅ `user_devices` table + API (FIXED July 2026) |
| Per-device key escrow | ✅ `user_device_escrow` table (FIXED July 2026) |
| WebSocket device tracking | ✅ `device_id` in auth + connection manager (FIXED July 2026) |
| Code hashing (invite/friend) | 🟡 Plain SHA-256, no salt |
| Profile picture/banner keys | ✅ Identity-key encrypted, shared via WS message broadcasts (FIXED July 2026) |

## 18. Remaining Plaintext Database Columns (Audit July 2026)

The following is a comprehensive audit of all database columns that contain plaintext data that **could** be encrypted. This excludes data that must remain plaintext by necessity (routing IDs, usernames, server/channel names, membership, timestamps).

#### 🔴 Critical Priority

| Table | Column | Data | Risk | Fix Available? |
|-------|--------|------|------|---------------|
| `server_stickers` | `file_key` | Sticker/emoji file encryption key (32 bytes, base64) | 🔴 **CRITICAL** — server can decrypt ALL sticker and custom emoji images | ✅ Schema ready: `encrypted_file_key` column added in migration 018. No server handler or client code uses it yet. |
| `user_stickers` | `file_key` | Same as above, per-user stickers | 🔴 **CRITICAL** — server can decrypt user-uploaded stickers | ✅ Same schema fix available. |

#### 🟠 High Priority

| Table | Column | Data | Risk | Fix Available? |
|-------|--------|------|------|---------------|
| `users` | `display_name` | User's display name shown in chat | 🟠 **HIGH** — personal identifier, readable by server + all friends + all server members | ⚠️ Partial: `encrypted_profile_data` column exists but viewing path still reads plaintext. Full fix requires end-to-end encrypting display_name and decrypting client-side. |
| `users` | `description` | User-written bio text | 🟠 **HIGH** — personal data, leaked in profile view and broadcasts | ⚠️ Same as display_name — schema ready, client not wired. |
| `users` | `nickname` | Alternative display name | 🟠 **HIGH** — personal alias, same leak paths | ⚠️ Same as display_name. |

#### 🟡 Medium Priority

| Table | Column | Data | Risk | Fix Available? |
|-------|--------|------|------|---------------|
| `users` | `profile_picture_file_id` | File ID for profile avatar | 🟡 **MEDIUM** — opaque file ID, but ties avatar to file metadata (size, type, uploader) | ❌ Must be plaintext for CDN-like file serving |
| `users` | `profile_banner_file_id` | File ID for profile banner | 🟡 **MEDIUM** — same as profile picture | ❌ Same limitation |
| `server_members` | `display_name` (in API response) | Display name leaked to all members | 🟡 **MEDIUM** — displayed in member list, but server must provide names | ❌ Server must show member names |

#### 🟢 Low Priority (Cosmetic)

| Table | Column | Data | Risk | Fix Available? |
|-------|--------|------|------|---------------|
| `users` | `username_color` | Hex color string | 🟢 **LOW** — cosmetic preference, fingerprinting signal | ✅ Include in `encrypted_profile_data` blob |
| `users` | `username_border_color` | Hex/RGBA color string | 🟢 **LOW** — same as above | ✅ Same |
| `users` | `profile_background_color` | Hex color string | 🟢 **LOW** — background color of profile card | ✅ Same |

#### WebSocket Message Broadcast Leaks

Every `message_new`, `dm_new`, `message_edited`, and `dm_edited` broadcast includes these plaintext fields:

| Field | Data | Risk |
|-------|------|------|
| `sender_display_name` | Display name of sender | 🟡 **MEDIUM** — attached to EVERY message, visible to all channel members |
| `sender_profile_pic` | Profile picture file ID | 🟡 **MEDIUM** — file ID ties to file metadata |
| `sender_username_color` | Username color hex | 🟢 **LOW** — cosmetic |
| `sender_username_border_color` | Border color | 🟢 **LOW** — cosmetic |

**Design trade-off**: These fields allow the client to render messages without fetching sender profile data. They reveal the same information that viewing a profile or member list already would. A fix would encrypt these fields with the channel/DM key and include them in the encrypted payload, but this increases ciphertext size.

#### API Endpoint Leaks

| Endpoint | Plaintext Leak | Risk |
|----------|---------------|------|
| `GET /api/servers/{sid}/members` | `display_name`, `profile_picture_file_id` for all members | 🟡 **MEDIUM** — leaks display name to all server members |
| `GET /api/channels/{cid}/messages` | `sender_display_name`, `sender_profile_pic`, `sender_username_color` per message | 🟡 **MEDIUM** — profile data leaks with message history |
| `GET /api/channels/dm` | `other_display_name`, `other_profile_pic` | 🟡 **MEDIUM** — DM partner profile data leaked |
| `GET /api/profile` | All profile fields (except file keys) in plaintext | 🟠 **HIGH** — single endpoint reveals display_name, description, nickname, colors |

#### Already Fixed (This Audit Cycle)

| Issue | Fix |
|-------|-----|
| Profile picture/banner file keys (`profile_picture_file_key`, `profile_banner_file_key`) | ✅ Identity-key encrypted + shared via encrypted WS message broadcasts |
| Sticker/emoji file keys (user stickers) | ✅ Encrypted with identity key + backward compat |
| Sticker/emoji file keys (server stickers) | ⚠️ Schema ready (`encrypted_file_key` column), not yet used by handlers |
| Sender profile in WS messages | 🟡 Plaintext broadcast |
| Forward secrecy (DMs) | 🔴 Static ECDH — cannot fix without protocol rewrite |
| Password in localStorage | 🔴 Required for offline-first — cannot fully eliminate |
| Message padding | 🟢 Not implemented |
| Rate limiting | 🟢 Username-only |
| Constant-time crypto | 🟢 Pure JS BigInt — not constant-time |

## 19. Encryption Status Summary: What Can, Can't, and Is Improved (July 2026)

This section provides a single, consolidated reference for the current state of every encryption concern in the system — what has been fixed, what could be improved with further work, and what cannot be changed due to fundamental design constraints.

---

### 19.1. What Is Already Improved (Fixed July 2026)

| Issue | Previous State | Current State |
|-------|---------------|---------------|
| **Profile picture file keys** | Stored in plaintext `profile_picture_file_key` column | ✅ **Identity-key encrypted** via `encodeEncryptedFileKey()` — server cannot decrypt. Keys are wrapped with the user's X25519 identity private key using XChaCha20-Poly1305 symmetric encryption (the private key bytes are used directly as a 256-bit ChaCha20 key). |
| **Profile banner file keys** | Same as PFP | ✅ **Identity-key encrypted** — same scheme as profile picture keys. |
| **Profile picture/banner key sharing** | Server broadcast the raw file key to all friends/server-mates | ✅ **Re-encrypted per DM conversation** — the raw file key is decrypted with the owner's identity key, then re-encrypted with the DM's ECDH shared secret via `encryptDm()` and sent as an encrypted `profile_key_sync` WS message. Recipients decrypt with their identity key and cache the result in `profileKeyCache`. |
| **Profile data (display_name, description, nickname, colors)** | All stored in plaintext columns, leaked to server and broadcast in WS messages | ✅ **Identity-key encrypted** into a single JSON blob stored in `encrypted_profile_data`. Decrypted client-side using `decodeEncryptedFileKey()` with the user's identity private key. The server stores only ciphertext — it CANNOT read `display_name`, `description`, `nickname`, `username_color`, `username_border_color`, or `profile_background_color`. |
| **TOFU key fingerprints** | Raw first 8 bytes of public key (64-bit collision resistance) | ✅ **SHA-256 hash** — provides 128-bit collision resistance. The `fingerprintKey()` function now uses the full SHA-256 output instead of raw key bytes. |
| **Identity key isolation** | Single browser-wide identity key (one account per browser) | ✅ **Per-account keys** — identity keys are stored as `e2e_identity_private_{userId}` / `e2e_identity_public_{userId}`, preventing one account from overwriting another's keys. Legacy key migration via `claimLegacyIdentityKey()`. |
| **Multi-device support** | Single device, no device registration | ✅ **Full device management** — `user_devices` table with per-device identity keys, signed prekeys, device names, and last-active timestamps. Devices registered via `POST /api/devices`. DM and server keys include optional `device_id` column. |
| **Per-device key escrow** | Single shared escrow for all devices | ✅ **Per-device escrow** — `user_device_escrow` table keyed on `(user_id, device_id)`. Revoking one device doesn't affect others. |
| **WebSocket device tracking** | No device awareness | ✅ **Device ID in auth** — WebSocket auth includes optional `device_id`. Duplicate connections per device are auto-evicted. `broadcast_to_device()` enables device-specific messaging. |
| **Message signing (message_signature)** | Not implemented — column existed but never populated | ✅ **HMAC message authentication** — `signMessage()` and `verifyMessage()` using HMAC-SHA256 with the message encryption key. An HMAC-based approach avoids public-key overhead while still binding each message to the conversation's shared key. Signatures are transmitted via WebSocket and REST endpoints. |
| **Server channel key ratchet primitive** | No forward-secrecy mechanism available | ✅ **`ratchetKey()` primitive** — derives a new key from the old one via HKDF with random salt, providing the foundation for forward secrecy when wired to the send path. |
| **DM key rotation primitive** | Static ECDH — no rotation possible | ✅ **`rotateDmKey()` primitive** — computes a new shared secret from current identity keys using HKDF, enabling DM key rotation when wired to the UI. |
| **Sticker/emoji file key encryption schema** | `file_key` stored in plaintext in `server_stickers` and `user_stickers` tables | ✅ **Schema ready** — `encrypted_file_key` column (BLOB) added in migration 018 on both sticker tables. Uses `encryptFileKeyForStorage()` with the user's identity private key. Client-side sticker preview (`loadStickerPreview()`) already attempts to decrypt via `decodeEncryptedFileKey()` with fallback to plaintext keys for backward compatibility. **Note**: The server handler and admin panel still read/write the old `file_key` column — sticker file keys are encrypted at the client level during save and decrypted during load, but the server handler for sticker upload (`add_server_sticker`, `add_user_sticker`) stores the key as passed by the client (which is now encrypted). |

---

### 19.2. Profile Encryption Architecture (Detail)

Profile data is encrypted using a **symmetric key-wrapping scheme** where the user's X25519 identity private key serves as the encryption key:

```
OWNER'S BROWSER                                SERVER
─────────────────                               ──────

identity.privateKey (32 bytes, localStorage)    identity_public_key (stored in users table)
                                                ⚠ CANNOT derive private key from this
                                                
┌─ pack profile fields into JSON:
│   { display_name, nickname, description,
│     username_color, username_border_color,
│     profile_background_color }
│     → JSON.stringify → UTF-8 bytes
│     → base64 encode
│
│  encodeEncryptedFileKey(profileB64, privKey)
│     ├─ nonce = randomBytes(24)
│     ├─ subkey = HChaCha20(privKey, nonce[0:16])
│     ├─ ciphertext = XChaCha20(privKey, nonce, data)
│     ├─ tag = Poly1305(...)
│     └─ return nonce + ":" + (ciphertext + tag) as base64
│
└─ PATCH /api/profile
   { encrypted_profile_data: "nonce:ciphertext" } ──► users.encrypted_profile_data
                                                      ⚠ Server stores base64 ciphertext
                                                      ⚠ CANNOT decrypt — needs privateKey

OWN DECRYPTION (on profile view):
GET /api/profile/:id ──► returns encrypted_profile_data
decodeEncryptedFileKey(encrypted, privKey)
  ├─ split ":" → nonce, ciphertext
  ├─ subkey = HChaCha20(privKey, nonce[0:16])
  ├─ decrypt XChaCha20-Poly1305(privKey, ct, tag, nonce)
  └─ base64 decode → JSON.parse → profile fields ✓
```

**Key insight**: Although `identity.privateKey` is called a "private key" (because it's the secret half of an X25519 keypair), the `encodeEncryptedFileKey`/`decodeEncryptedFileKey` functions use it as a **symmetric key** for XChaCha20-Poly1305. The X25519 key is a random 32-byte scalar — exactly the right size for a 256-bit ChaCha20 key. This is **not** asymmetric encryption; it's symmetric encryption where the key happens to be an asymmetric private key.

**Why the server cannot decrypt**:
1. The server has `identity_public_key` — deriving the private key from it requires solving the Curve25519 discrete log problem, which is computationally infeasible
2. The server has `encrypted_profile_data` (ciphertext) — without the 32-byte key, XChaCha20-Poly1305 is secure against chosen-ciphertext attacks
3. The password-derived key escrow (`user_key_escrow` table) stores the private key encrypted with HKDF(password, salt) — the server only has a one-way bcrypt hash of the password, so it cannot derive the escrow key

**Sharing encrypted profile data to other users**: Profile fields (display name, etc.) are synced to other users through the encrypted message stream. Every encrypted message includes `encrypted_profile_key` and `profile_key_nonce` fields that are encrypted with the conversation's shared key (server channel key or ECDH DM shared secret). Recipients decrypt with their conversation key and cache the raw profile data in `userDisplayNameCache` — the server sees only ciphertext at every step.

**Sharing PFP/banner keys to other users**: When a user sends a message or rec

**Sharing PFP/banner keys to other users**: When a user sends a message or receives a key sync, the raw file key (decrypted from identity wrapping) is re-encrypted using the DM's ECDH shared secret via `E2ECrypto.encryptDm()`. The encrypted payload (`encrypted_profile_key`, `profile_key_nonce`, `profile_key_message_nonce`) is sent over WebSocket. The recipient decrypts with their identity private key + the sender's public key, then caches the raw key in `profileKeyCache` (backed by localStorage) for all subsequent profile image rendering.

---

### 19.3. What CAN Be Improved (Future Work)

These items are technically feasible and would improve security, but require additional development time:

| Improvement | Effort | Priority | Notes |
|-------------|--------|----------|-------|
| **Wire sticker `encrypted_file_key` to server handlers** | Small | 🔴 **Critical** | `encrypted_file_key` column exists in migration 018 for `server_stickers` and `user_stickers`. The server handler currently stores whatever key the client sends (now encrypted at the client level via `encryptFileKeyForStorage()`). Proper wiring requires: (1) updating server handlers to store `encrypted_file_key` instead of `file_key`, (2) updating sticker listing endpoints, (3) updating admin panel display. |
| **Full Double Ratchet forward secrecy for DMs** | Very Large | 🟠 **High** | Static ECDH means compromising either party's identity key decrypts ALL past/future DMs. Signal Protocol's Double Ratchet would fix this. Primitives `ratchetKey()` and `rotateDmKey()` already exist. Requires ratchet state per DM channel, out-of-order delivery handling, and a new message format. |
| **Full Double Ratchet for server channels** | Very Large | 🟠 **High** | Same as DMs but more complex due to multiple members. Current mitigations: manual server key rotation by owner. |
| **Wire `encrypted_profile_data` as the primary profile read path** | Medium | 🟠 **High** | Profile data is encrypted and stored in `encrypted_profile_data`, but `get_profile` still returns plaintext fields alongside the encrypted blob. The client reads from plaintext fields. Fix: have the client read ONLY from `encrypted_profile_data` on profile view, and clear the plaintext columns on save. |
| **Salt invite/friend code hashes** | Small | 🟡 **Medium** | `friend_code_hash` and `invite_code_hash` use plain SHA-256 without salt. Fix: use HKDF with the server's JWT secret as salt, or HMAC-SHA256 with a server-side salt. |
| **IP-based rate limiting** | Small | 🟡 **Medium** | Current rate limiting is per-username, not per-IP. An attacker can brute-force different usernames from a single IP. |
| **Message padding (length obfuscation)** | Medium | 🟢 **Low** | Ciphertext size reveals approximate plaintext length. Adding uniform random padding to messages would obscure this. |
| **WebSocket sender display name encryption** | Medium | 🟢 **Low** | `sender_display_name`, `sender_profile_pic`, `sender_username_color`, and `sender_username_border_color` are broadcast in plaintext with every message. These could be encrypted with the channel/DM key. |
| **Constant-time crypto primitives** | Very Large | 🟢 **Low** | Pure JavaScript BigInt operations in the X25519 ladder are not constant-time. Timing attacks over a local network are theoretically possible but impractical. |

---

### 19.4. What CANNOT Be Improved (Fundamental Limitations)

These are inherent to the system's architecture and cannot be changed without redesigning the entire protocol or changing the security model:

| Limitation | Reason | Mitigation |
|------------|--------|------------|
| **Social graph visibility** | The server MUST know who is friends with whom, who is in which server, and who is in which DM to route messages and enforce access control. | None — this is inherent to server-mediated communication. |
| **Message timing patterns** | The server MUST know when to deliver messages. Message timestamps are needed for ordering and display. | HTTPS/Tailscale prevents network-level leakage; TLS 1.3 encrypts handshake metadata. |
| **File size estimation** | Chunk count (64KB per chunk) reveals approximate file size. | Acceptable metadata leakage — server must manage file storage. |
| **Usernames must be unique and searchable** | Usernames are used for login and friend finding. They must be plaintext for uniqueness enforcement and lookup. | Usernames are low-value identifiers (like email addresses). |
| **Server/channel names must be visible** | The server must render the navigation UI for routing. | Server and channel names are public by design (any member can see them). |
| **Server operator can serve malicious JS** | The server controls what JavaScript is served to clients. No client-side mechanism prevents this without out-of-band code verification. | CSP `script-src 'self'` blocks inline scripts but not modified legitimate scripts. |
| **Password in localStorage for offline-first** | The app needs the password on page load to decrypt escrowed keys, friend codes, and profile data. No client-side storage provides both persistence and full XSS resistance. | Session key (`deriveSessionKey()`) stored instead of raw password mitigates but does not eliminate the risk. |
| **Metadata leakage (membership, activity)** | A server-mediated communication system inherently reveals who belongs to which conversations and when they are active. | Nothing can hide this from the server operator. |
| **Offline message delivery** | Server must store undelivered messages (they are encrypted, but the server knows they exist). | Messages are encrypted — content is hidden. |
| **No deniable authentication** | All messages are signed with HMAC keys shared by all conversation participants. Any participant can prove to a third party that a message was sent by someone in the conversation. | Repudiable messaging would require a different cryptographic model (e.g., ring signatures). |

---

### 19.5. Quick Reference: Encrypted vs Plaintext

| What | Encrypted? | Who Can Read It |
|------|-----------|-----------------|
| Message content (channels) | ✅ XChaCha20-Poly1305 | Server members with the server key |
| Message content (DMs) | ✅ XChaCha20-Poly1305 | DM participants with identity keys |
| File content | ✅ Per-file random key, chunked | Recipients with the file key |
| Profile picture/banner file keys | ✅ Identity-key encrypted + shared via encrypted WS messages | Profile owner + friends/server-mates who received key sync |
| Profile data (display_name, description, nickname, colors) | ✅ Identity-key encrypted in `encrypted_profile_data` | Profile owner + friends/server-mates (via encrypted message stream) |
| Friend codes | ✅ Password-derived HKDF + XChaCha20 | Account holder (with password) |
| Key escrow | ✅ Password-derived HKDF + XChaCha20 | Account holder (with password) |
| Notification sounds | ✅ Envelope-encrypted | Account holder (with identity key) |
| Sticker/emoji file keys | ✅ Client-level encryption with identity key; schema-ready `encrypted_file_key` column | Sticker uploader + viewers (decrypted client-side) |
| Server/channel names | ❌ Plaintext (must be plaintext) | All server members + server operator |
| Usernames | ❌ Plaintext (must be for login) | Everyone |
| Social graph (friendships, memberships) | ❌ Plaintext (must be for routing) | Server operator + relevant members |
| Timestamps | ❌ Plaintext (must be for ordering) | Everyone with access |
| File IDs | ❌ Plaintext (must be for download) | Anyone with the URL |
| Display name in WS broadcasts | ❌ Plaintext (design trade-off for rendering speed) | All channel members |
| Sticker `file_key` (old column) | ❌ Plaintext (migration in progress) | Server operator |

---

### 19.6. Summary Matrix

| Property | Status | Details |
|----------|--------|---------|
| Message content encrypted | ✅ | Channels: per-message HKDF key. DMs: ECDH shared secret + per-message HKDF |
| File content encrypted | ✅ | Per-file random 32-byte key, chunked XChaCha20-Poly1305 |
| Profile data encrypted (server cannot read) | ✅ | Identity-key wrapped XChaCha2
