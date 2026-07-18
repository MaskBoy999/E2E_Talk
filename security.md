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
     ├── profile_picture_file_id  ░░░░░░░░░░░░ ─────► users.profile_picture_file_id  ⚠️ LEAK
     ├── profile_picture_file_key ░░░░░░░░░░░░ ─────► users.profile_picture_file_key ⚠️ LEAK
     ├── profile_banner_file_id   ░░░░░░░░░░░░ ─────► users.profile_banner_file_id   ⚠️ LEAK
     ├── profile_banner_file_key  ░░░░░░░░░░░░ ─────► users.profile_banner_file_key  ⚠️ LEAK
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
| `profile_picture_file_key` | TEXT | **No** ⚠️ | **No** | **HIGH** | File encryption key — server can decrypt profile picture! |
| `profile_banner_file_id` | TEXT | **No** ⚠️ | **No** | **MEDIUM** | Same as profile picture |
| `profile_banner_file_key` | TEXT | **No** ⚠️ | **No** | **HIGH** | File encryption key — server can decrypt banner! |
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

#### `user_stickers` table ⚠️

| Column | Type | Encrypted? | Must be PT? | Risk |
|--------|------|-----------|-------------|------|
| `id` | TEXT | No | ✅ Yes | None |
| `user_id` | TEXT | No | ✅ Yes | None |
| `file_id` | TEXT | No | **No** | MEDIUM |
| `sticker_name` | TEXT | No | **No** | LOW |
| `mime_type` | TEXT | No | ✅ Yes | LOW |
| `file_key` | TEXT | **No** ⚠️ | **No** | **HIGH — file encryption key in plaintext!** |

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
| `user_public_keys` (`user_id, public_key`) | Multi-device key storage | Public keys |
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

✅ **Multi-device support**: Both parties can have multiple public keys. The `dm_keys` table stores envelope-encrypted copies for each device. Since all devices share the same primary identity key (via escrow), any device can decrypt.

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

⚠️ **Sticker/emoji file keys in PLAINTEXT**:
- `server_stickers.file_key` — **stored in plaintext!**
- `user_stickers.file_key` — **stored in plaintext!**
- The `file_key` column in these tables stores the 32-byte file encryption key as-is (base64 encoded plaintext)
- **Fix**: Envelope-encrypt these keys with the server key (for `server_stickers`) or the user's identity key (for `user_stickers`)

⚠️ **Profile picture/banner file keys in PLAINTEXT**:
- `users.profile_picture_file_key` — **stored in plaintext!**
- `users.profile_banner_file_key` — **stored in plaintext!**
- The server can decrypt all profile pictures and banners using these keys
- **Fix**: Encrypt these keys per-viewer or use a separate, server-inaccessible encryption layer

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
  "profile_picture_file_key": "base64key...",    // PLAINTEXT — server can decrypt PFP!
  "profile_banner_file_id": "file-uuid",         // PLAINTEXT
  "profile_banner_file_key": "base64key...",     // PLAINTEXT — server can decrypt banner!
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
| `e2e_password` | Raw account password | **CRITICAL** | Can log in, decrypt escrow, change password |
| `token` | JWT auth token | **HIGH** | Can authenticate as you for 30 days |
| `known_key_fingerprints` | JSON of userId → fingerprint | **LOW** | Only TOFU data |
| `user` | JSON of your user info | **LOW** | Only id, username, display_name |
| `muted_servers`, `muted_channels`, `muted_dms` | JSON arrays | **LOW** | Mute preferences |

### 9.4. TOFU Fingerprint Security

```
fingerprintKey(pubKeyB64):
    raw = base64_decode(pubKeyB64)
    bytes = new Uint8Array(raw)
    hash = []
    for i = 0 to min(bytes.length, 8):
        hash.push(bytes[i].toString(16).padStart(2, '0'))
    return hash.join(':')
```

**Issue:** The fingerprint is the **raw first 8 bytes** of the public key, NOT a SHA-256 hash.

| Property | Current | SHA-256 |
|----------|---------|---------|
| Length | 8 bytes (64 bits) | 32 bytes (256 bits) |
| Collision resistance | 2^64 ≈ 10^19 | 2^128 ≈ 10^38 |
| Preimage resistance | 2^64 | 2^256 |
| Standard | ❌ Custom | ✅ HKDF/HMAC output |

**Impact:** 8 bytes provides 64-bit collision resistance. An attacker would need 2^64 ≈ 10^19 public keys to find a collision — infeasible. However, using a full SHA-256 hash is the standard approach and provides cryptographic certainty.

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
| `users` | `profile_picture_file_key` | **CRITICAL** | Server can decrypt profile pictures |
| `users` | `profile_banner_file_key` | **CRITICAL** | Server can decrypt banners |
| `users` | `description` | **MEDIUM** | Personal bio text |
| `users` | `nickname` | **MEDIUM** | Personal alias |
| `users` | `username_color` | LOW | Cosmetic preference |
| `users` | `username_border_color` | LOW | Cosmetic preference |
| `users` | `profile_background_color` | LOW | Cosmetic preference |
| `server_stickers` | `file_key` | **HIGH** | Server can decrypt sticker images |
| `user_stickers` | `file_key` | **HIGH** | Server can decrypt sticker images |

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

### 12.3. What HTTPS Protects (And What It Doesn't)

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
| **Inject fake messages** | ✅ Trivial | Can inject ciphertext into message streams | Not preventable — clients should verify message signing |
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
| 2 | Profile picture/banner file keys in plaintext (`profile_picture_file_key`, `profile_banner_file_key`) | 🔴 CRITICAL | Medium | Server can decrypt profile images |
| 3 | Sticker file keys in plaintext (`server_stickers.file_key`, `user_stickers.file_key`) | 🔴 CRITICAL | Medium | Server can decrypt sticker images |
| 4 | Profile data (display_name, description, etc.) in plaintext | 🟠 HIGH | Large | Server can read all profile text content |
| 5 | No forward secrecy for DMs (static ECDH) | 🟠 HIGH | Very large | Compromised key reveals all past DMs |
| 6 | Sender display name/profile pic in every message broadcast | 🟡 MEDIUM | Large | Profile data attached to every message |
| 7 | SHA-256 without salt for invite/friend codes | 🟡 MEDIUM | Small | Rainbow table attacks feasible |
| 8 | TOFU fingerprint uses raw 8 bytes not SHA-256 | 🟢 LOW | Small | Cosmetic — collision resistance adequate |
| 9 | Auto-generated self-signed TLS cert triggers warnings | 🟢 LOW | Small | User experience |
| 10 | Username-based rate limiting only (not IP-based) | 🟢 LOW | Small | Brute-force protection gap |
| 11 | No automatic server key rotation | 🟢 LOW | Medium | Manual rotation sufficient |
| 12 | No message padding (ciphertext size reveals plaintext size) | 🟢 LOW | Medium | Metadata leakage only |

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
