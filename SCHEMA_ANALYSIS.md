# E2E Talk — Current Schema Complete Analysis
## Migration Guide: Current → Streamlined Zero-Knowledge Architecture

> **Purpose:** This document is a complete inventory of the current codebase so that another AI agent can precisely understand what to **remove**, **add**, and **change** to implement the Streamlined Zero-Knowledge Architecture (the simplified plan) on top of the existing "profile fixes" base (commit `e6b1fb2` on `develop`).

---

## Table of Contents

1. [Current Database Schema — Every Table & Column](#1-current-database-schema--every-table--column)
2. [Current Crypto Functions (`static/crypto.js`)](#2-current-crypto-functions-staticcryptojs)
3. [Current Client-Side Architecture](#3-current-client-side-architecture)
4. [Current Server-Side Architecture](#4-current-server-side-architecture)
5. [What to REMOVE — Tables, Columns, Code](#5-what-to-remove--tables-columns-code)
6. [What to ADD — New Columns & Code](#6-what-to-add--new-columns--code)
7. [What to CHANGE — Existing Components to Modify](#7-what-to-change--existing-components-to-modify)
8. [Complete Migration Steps](#8-complete-migration-steps)
9. [Reference: Current vs Streamlined Feature Matrix](#9-reference-current-vs-streamlined-feature-matrix)
10. [Potentially Dangerous Simplifications](#10-potentially-dangerous-simplifications)

---

## 1. Current Database Schema — Every Table & Column

### 1.1 `users` (the main user accounts table)

| Column | Type | Encrypted? | Streamlined plan keeps? | Notes |
|--------|------|-----------|------------------------|-------|
| `id` | TEXT PK | No | ✅ KEEP | UUIDv4 — routing |
| `username` | TEXT UNIQUE | No | ✅ KEEP | Login name |
| `password_hash` | TEXT | Hashed (Argon2id) | ✅ KEEP | One-way hash |
| `created_at` | DATETIME | No | ✅ KEEP | |
| `identity_public_key` | BLOB | No (public key) | ✅ KEEP | X25519 public key |
| `display_name` | TEXT | **No** ⚠️ | **CHANGE** | Currently plaintext. **Should be removed** in favor of `encrypted_profile_data` + encrypted snapshot approach |
| `profile_picture_file_id` | TEXT | No | **CHANGE** | Should be stored in encrypted profile |
| `profile_picture_file_key` | TEXT | Encrypted (identity-key) | **CHANGE** | Move to encrypted profile |
| `profile_banner_file_id` | TEXT | No | **CHANGE** | Move to encrypted profile |
| `profile_banner_file_key` | TEXT | Encrypted (identity-key) | **CHANGE** | Move to encrypted profile |
| `username_color` | TEXT | No | **CHANGE** | Move to encrypted profile |
| `username_border_color` | TEXT | No | **CHANGE** | Move to encrypted profile |
| `profile_background_color` | TEXT | No | **CHANGE** | Move to encrypted profile |
| `description` | TEXT | No ⚠️ | **CHANGE** | Move to encrypted profile |
| `nickname` | TEXT | No ⚠️ | **CHANGE** | Move to encrypted profile |
| `friend_code_hash` | TEXT | Hashed (SHA-256) | **CHANGE** | Keep as hashed lookup |
| `encrypted_friend_code` | TEXT | Encrypted (password) | **CHANGE** | Keep for friend code recovery |
| `friend_code_salt` | TEXT | Random salt | **CHANGE** | Keep |
| `friend_code_nonce` | TEXT | Random nonce | **CHANGE** | Keep |
| `encrypted_profile_data` | TEXT | Encrypted (password) | ✅ **KEEP — BUT ACTIVATE** | Currently UNUSED. Streamlined plan uses this! |
| `encrypted_profile_salt` | TEXT | Random salt | ✅ **KEEP — BUT ACTIVATE** | Currently UNUSED |
| `encrypted_profile_nonce` | TEXT | Random nonce | ✅ **KEEP — BUT ACTIVATE** | Currently UNUSED |
| `profile_updated_at` | TEXT | No | **REMOVE** | Not needed if profile snapshots piggyback on messages |
| `friend_requests_disabled` | INTEGER | No | ✅ KEEP | Privacy setting |

### 1.2 `servers`

| Column | Type | Encrypted? | Streamlined plan keeps? | Notes |
|--------|------|-----------|------------------------|-------|
| `id` | TEXT PK | No | ✅ KEEP | UUIDv4 |
| `name` | TEXT | No ⚠️ | **CHANGE** | Currently plaintext. Streamlined plan: store encrypted with channel key in `encrypted_name` |
| `encrypted_name` | BLOB | **YES** | **ADD** | Column doesn't exist yet in current schema! Must be added |
| `name_nonce` | BLOB | Random | **ADD** | Companion to encrypted_name |
| `owner_id` | TEXT FK | No | ✅ KEEP | |
| `invite_code_hash` | TEXT | Hashed (SHA-256) | ✅ KEEP | |
| `invite_code` | TEXT (nullable) | No | **REMOVE** | Legacy plaintext column |
| `joins_disabled` | INTEGER | No | ✅ KEEP | |
| `created_at` | DATETIME | No | ✅ KEEP | |

### 1.3 `channels`

| Column | Type | Encrypted? | Streamlined plan keeps? | Notes |
|--------|------|-----------|------------------------|-------|
| `id` | TEXT PK | No | ✅ KEEP | UUIDv4 |
| `server_id` | TEXT FK | No | ✅ KEEP | |
| `name` | TEXT | No ⚠️ | **CHANGE** | Currently plaintext. Should use encrypted_name |
| `encrypted_name` | BLOB | **YES** | **ADD** | Column doesn't exist yet! Must be added |
| `name_nonce` | BLOB | Random | **ADD** | Companion |
| `type` | TEXT | No | ✅ KEEP | 'text' or 'voice' |
| `position` | INTEGER | No | ✅ KEEP | Display ordering |
| `created_at` | DATETIME | No | ✅ KEEP | |

### 1.4 `messages`

| Column | Type | Encrypted? | Streamlined plan keeps? | Notes |
|--------|------|-----------|------------------------|-------|
| `id` | TEXT PK | No | ✅ KEEP | |
| `channel_id` | TEXT FK | No | ✅ KEEP | |
| `sender_id` | TEXT FK | No | ✅ KEEP | |
| `encrypted_content` | BLOB | **YES** | ✅ KEEP | Properly encrypted |
| `nonce` | BLOB | Random | ✅ KEEP | |
| `timestamp` | DATETIME | No | ✅ KEEP | |
| `message_nonce` | TEXT | Random | ✅ KEEP | Per-message key derivation |
| `edited_at` | DATETIME | No | ✅ KEEP | |
| `message_signature` | TEXT | HMAC-SHA256 | **REMOVE** | Never actually populated (always NULL). Remove column. |
| `encrypted_profile_key` | TEXT | Encrypted (channel key) | **REMOVE** | Streamlined plan: profile attached to message body instead |
| `profile_key_nonce` | TEXT | Random | **REMOVE** | Companion — remove with encrypted_profile_key |
| `encrypted_banner_key` | TEXT | Encrypted (channel key) | **REMOVE** | Remove |
| `banner_key_nonce` | TEXT | Random | **REMOVE** | Remove |
| `sender_username` | TEXT (in Rust struct) | No | ✅ KEEP | Needed for routing |

### 1.5 `dm_messages`

| Column | Type | Encrypted? | Streamlined plan keeps? | Notes |
|--------|------|-----------|------------------------|-------|
| `id` | TEXT PK | No | ✅ KEEP | |
| `dm_channel_id` | TEXT FK | No | ✅ KEEP | |
| `sender_id` | TEXT FK | No | ✅ KEEP | |
| `encrypted_content` | BLOB | **YES** | ✅ KEEP | Properly encrypted |
| `nonce` | BLOB | Random | ✅ KEEP | |
| `timestamp` | DATETIME | No | ✅ KEEP | |
| `message_nonce` | TEXT | Random | ✅ KEEP | |
| `edited_at` | DATETIME | No | ✅ KEEP | |
| `message_signature` | TEXT | HMAC-SHA256 | **REMOVE** | Never populated |
| `encrypted_profile_key` | TEXT | Encrypted (DM key) | **REMOVE** | Streamlined: profile in message body |
| `profile_key_nonce` | TEXT | Random | **REMOVE** | Remove |
| `encrypted_banner_key` | TEXT | Encrypted (DM key) | **REMOVE** | Remove |
| `banner_key_nonce` | TEXT | Random | **REMOVE** | Remove |

### 1.6 `server_keys` (channel key distribution)

| Column | Type | Encrypted? | Streamlined plan keeps? | Notes |
|--------|------|-----------|------------------------|-------|
| `id` | INTEGER PK | No | ✅ KEEP | |
| `server_id` | TEXT FK | No | ✅ KEEP | |
| `user_id` | TEXT FK | No | ✅ KEEP | |
| `encrypted_key` | BLOB | Envelope-encrypted | ✅ KEEP | Channel key wrapped for user |
| `sender_public_key` | BLOB | No (public key) | ✅ KEEP | Ephemeral key for envelope |
| `nonce` | BLOB | Random | ✅ KEEP | |
| `version` | INTEGER | No | ✅ KEEP | Key version for rotation |
| `device_id` | TEXT | No | **REMOVE** | Per-device keys not needed |
| `created_at` | DATETIME | No | ✅ KEEP | |

### 1.7 `dm_keys` (DM key distribution)

| Column | Type | Encrypted? | Streamlined plan keeps? | Notes |
|--------|------|-----------|------------------------|-------|
| `id` | INTEGER PK | No | **REMOVE whole table** | Streamlined plan: DM key derived via ECDH, no server storage needed |
| `dm_channel_id` | TEXT FK | No | **REMOVE** | |
| `user_id` | TEXT FK | No | **REMOVE** | |
| `encrypted_key` | BLOB | Envelope-encrypted | **REMOVE** | |
| `sender_public_key` | BLOB | No | **REMOVE** | |
| `nonce` | BLOB | Random | **REMOVE** | |
| `device_id` | TEXT | No | **REMOVE** | |
| `created_at` | DATETIME | No | **REMOVE** | |

### 1.8 `dm_channels` and `dm_members`

| Table | Streamlined plan keeps? | Notes |
|-------|------------------------|-------|
| `dm_channels` | ✅ KEEP | Needed for DM routing |
| `dm_members` | ✅ KEEP | Needed for access control |

### 1.9 `friend_requests` and `friendships`

| Table | Streamlined plan keeps? | Notes |
|-------|------------------------|-------|
| `friend_requests` | ✅ KEEP | Friend system |
| `friendships` | ✅ KEEP | Bidirectional link |

### 1.10 `files`

| Column | Type | Encrypted? | Streamlined plan keeps? | Notes |
|--------|------|-----------|------------------------|-------|
| `id` | TEXT PK | No | ✅ KEEP | |
| `uploader_id` | TEXT FK | No | ✅ KEEP | |
| `original_size` | INTEGER | No | ✅ KEEP | |
| `mime_type` | TEXT | No | ✅ KEEP | |
| `chunk_count` | INTEGER | No | ✅ KEEP | |
| `upload_complete` | BOOLEAN | No | ✅ KEEP | |
| `encrypted_file_key` | BLOB | Envelope-encrypted | ✅ KEEP | |
| `encrypted_sender_key` | BLOB | Envelope-encrypted | ✅ KEEP | |
| `created_at` | DATETIME | No | ✅ KEEP | |

### 1.11 `user_key_escrow` (identity key recovery)

| Column | Type | Encrypted? | Streamlined plan keeps? | Notes |
|--------|------|-----------|------------------------|-------|
| `user_id` | TEXT PK | No | ✅ KEEP | |
| `encrypted_private_key` | BLOB | Password-derived HKDF+XC20P | ✅ KEEP | |
| `salt` | BLOB | Random | ✅ KEEP | |
| `nonce` | BLOB | Random | ✅ KEEP | |
| `created_at` | DATETIME | No | ✅ KEEP | |
| `updated_at` | DATETIME | No | ✅ KEEP | |

### 1.12 Tables to REMOVE entirely

| Table | Reason for removal | Current usage |
|-------|-------------------|---------------|
| `user_devices` | Simplified: one identity key per user. No per-device keys or prekeys. | Stores device-specific identity keys, signed prekeys, one-time prekeys |
| `user_device_escrow` | Same as above — no per-device escrow needed | Per-device key recovery |
| `prekey_bundles` | No X3DH handshake needed | Signal prekey bundles — never actually used |
| `sessions` | No Double Ratchet needed | Signal session state — never actually used |
| `notification_sounds` | Not critical for v1 | Encrypted notification sounds |
| `server_stickers` | Feature bloat, remove | Stickers per server |
| `user_stickers` | Feature bloat, remove | Personal stickers/GIFs |
| `server_bans` | Keep? Actually this is useful. **→ KEEP** | Ban enforcement |
| `admin_config` | **→ KEEP** | Admin password |
| `voice_sessions` | Doesn't exist yet | Not yet implemented |
| `voice_participants` | Doesn't exist yet | Not yet implemented |
| `voice_sframe_keys` | Doesn't exist yet | Not yet implemented |
| `profile_versions` | Doesn't exist yet | Not yet implemented |

### 1.13 Current indexes (for reference)

```
idx_channels_server_id
idx_messages_channel_id, idx_messages_sender_id, idx_messages_timestamp
idx_server_members_user_id, idx_server_members_server_id
idx_server_keys_server_id, idx_server_keys_user_id
idx_server_bans_server_id, idx_server_bans_user_id
idx_friend_requests_to, idx_friend_requests_from
idx_dm_messages_channel_id, idx_dm_messages_sender_id
idx_dm_keys_channel_user
idx_servers_invite_code_hash
idx_users_friend_code_hash
idx_user_stickers_user
idx_user_devices_user_id
idx_user_devices_device_id (UNIQUE)
```

---

## 2. Current Crypto Functions (`static/crypto.js`)

### 2.1 What to KEEP (with modifications)

| Function | Streamlined equivalent | Changes needed |
|----------|----------------------|----------------|
| `x25519GenerateKeyPair()` | `E2ECrypto.generateIdentityKeyPair()` | Rename. Returns `{ publicKey, privateKey }` (correct) |
| `x25519SharedSecret()` | Internal to `envelopeEncrypt` | Keep as-is |
| `envelopeEncrypt(plaintext, recipientPublicKey)` | `E2ECrypto.envelopeEncrypt(plaintext, recipientPub, senderPriv?)` | Currently uses ephemeral. Streamlined: needs explicit sender private key for auth |
| `envelopeDecrypt(ciphertextB64, nonceB64, ephemeralPublicKeyB64, recipientPrivateKey)` | `E2ECrypto.envelopeDecrypt(ciphertext, recipientPriv, senderPub, eph_pub, nonce)` | Keep as-is |
| `envelopeEncryptRaw()` | Same as `envelopeEncrypt` but for bytes | Keep |
| `envelopeDecryptRaw()` | Same as `envelopeDecrypt` but for bytes | Keep |
| `xchacha20poly1305Encrypt()` | Internal to `aeadEncrypt` | Rename to `aeadEncrypt` |
| `xchacha20poly1305Decrypt()` | Internal to `aeadDecrypt` | Rename to `aeadDecrypt` |
| `encryptWithPassword()` / `decryptWithPassword()` | `E2ECrypto.encryptWithPassword()` | Keep — uses HKDF (good enough) |
| `generateServerKey()` | Internal | Keep |
| `encryptWithKey()` / `decryptWithKey()` | Internal | Keep |
| `getIdentityKeyPair()` / `saveIdentityKeyPair()` | Internal | Keep |
| `getServerKey()` / `saveServerKey()` / `getAllServerKeys()` / `removeServerKey()` | Internal | Keep |
| `arrayBufferToBase64()` / `base64ToArrayBuffer()` | Internal | Keep |
| `randomBytes()` | Internal | Keep |
| `sha256Hex()` | `E2ECrypto.sha256Hex()` | Keep |
| `hmacHex()` | `E2ECrypto.hmacHex()` | Keep |
| `encryptKeyForEscrow()` / `decryptKeyFromEscrow()` | Internal | Keep |

### 2.2 What to REMOVE entirely

| Function | Reason | Lines of code |
|----------|--------|--------------|
| `deriveChannelKey(serverKey, channelId, messageNonce)` | No per-message KDF chains | ~3 |
| `deriveMetadataKey(serverKey)` | No metadata key separation needed | ~3 |
| `encryptWithKeyAndNonce()` | No per-message nonce needed | ~10 |
| `encrypt(plaintext, channelId, serverId)` | Replace with simpler `aeadEncrypt(channelKey)` | ~10 |
| `decrypt(ciphertextB64, nonceB64, channelId, serverId, messageNonce)` | Replace with simpler `aeadDecrypt(channelKey)` | ~15 |
| `encryptMetadata()` / `decryptMetadata()` | No metadata encryption needed | ~15 |
| `encryptDm()` / `decryptDm()` | Replace with ECDH-derived key + `aeadEncrypt`/`aeadDecrypt` | ~15 |
| `generateFileKey()` | ✅ KEEP | |
| `encryptFileChunk()` / `decryptFileChunk()` | ✅ KEEP | |
| `verifyKeyForUser()` / `trustCurrentKey()` / `fingerprintKey()` / `getKnownFingerprints()` / `saveKnownFingerprints()` | TOFU not needed with ECDH auth | ~40 |
| `claimLegacyIdentityKey()` | Migration code — can remove | ~15 |
| `ratchetKey(currentKey)` | No key ratcheting | ~8 |
| `rotateDmKey()` | No key rotation | ~8 |
| `signMessage()` / `verifyMessage()` | No HMAC signing needed | ~10 |
| `deriveSessionKey()` | Not needed — just use password-derived key directly | ~5 |
| `encryptFileKeyForStorage()` / `decryptFileKeyFromStorage()` / `encodeEncryptedFileKey()` / `decodeEncryptedFileKey()` | No sticker file keys needed | ~25 |
| `hmacHex()` | ✅ KEEP (used for friend/invite codes) | |
| `identityStorageSuffix()` | ✅ KEEP | |

### 2.3 Functions to ADD

```js
// Simplified API per streamlined plan
globalThis.E2ECrypto = {
  // Identity
  generateIdentityKeyPair() → { publicKey, privateKey },  // Rename x25519GenerateKeyPair
  
  // Envelope encryption (key wrapping)
  envelopeEncrypt(plaintext, recipientPub, senderPriv) → { ciphertext, eph_pub, nonce },
  envelopeDecrypt(ciphertext, recipientPriv, senderPub, eph_pub, nonce) → Uint8Array,
  
  // AEAD
  aeadEncrypt(plaintext, key, aad?) → { ciphertext, nonce },
  aeadDecrypt(ciphertext, key, nonce, aad?) → Uint8Array,
  
  // Password-based (for escrow)
  encryptWithPassword(plaintext, password) → { ciphertext, salt, nonce },
  decryptWithPassword(ciphertext, password, salt, nonce) → Uint8Array,
  
  // Key generation
  generateSymmetricKey() → Uint8Array(32),
};
```

---

## 3. Current Client-Side Architecture

### 3.1 `static/auth.js` — Registration & Login

**Current flow:**
1. **Register:** Generate X25519 identity → save to localStorage → encrypt private key with password (HKDF-based) → POST to `/api/register` with identity public key, escrow data, friend code
2. **Login:** POST `/api/login` → GET `/api/identity/escrow` → decrypt private key with password → save to localStorage → fetch server keys + DM keys → recover all channel keys

**What to CHANGE for streamlined plan:**
- Current registration already streams identity keypair and escrows private key → ✅ Keep as-is
- Current login already recovers identity key via escrow → ✅ Keep as-is
- Remove: per-device key generation, prekey generation, device registration
- Remove: `claimLegacyIdentityKey()` call
- Simplify: after login, fetch all `server_keys` and `dm_keys` for user, decrypt with identity key

### 3.2 `static/chat.js` — Main Chat Logic

**Current message flow:**
1. User types message
2. `encrypt(plaintext, channelId, serverId)`:
   - Load `serverKey` from localStorage
   - Generate `msgNonce` (16 random bytes)
   - `key = HKDF(serverKey, serverKey, "e2e-channel-v1:" + channelId + ":" + msgNonce, 32)`
   - `ciphertext = XChaCha20-Poly1305(key, plaintext)`
   - Send: `{ encrypted_content, nonce, message_nonce }`
3. Recipient receives WS broadcast
4. `decrypt(ciphertextB64, nonceB64, channelId, serverId, messageNonce)`:
   - Try all keys in `getAllServerKeys(serverId)`
   - `key = HKDF(serverKey, serverKey, "e2e-channel-v1:" + channelId + ":" + messageNonce, 32)`
   - `plaintext = XChaCha20-Poly1305_Decrypt(key, ciphertext, tag, nonce)`

**Current DM flow:**
1. `encryptDm(plaintext, dmChannelId, myPrivateKey, otherPublicKey)`:
   - `sharedSecret = X25519(myPrivateKey, otherPublicKey)`
   - `msgNonce = randomBytes(16)`
   - `key = HKDF(sharedSecret, sharedSecret, "e2e-dm-v1:" + dmChannelId + ":" + msgNonce, 32)`
   - `ciphertext = XChaCha20-Poly1305(key, plaintext)`
2. `decryptDm(ciphertextB64, nonceB64, dmChannelId, myPrivateKey, otherPublicKey, messageNonce)`:
   - Same shared secret derivation
   - Same HKDF key derivation
   - Decrypt

**What to CHANGE for streamlined plan:**
- **Server messages:** Replace `encrypt()`/`decrypt()` with simple `aeadEncrypt(plaintext, channelKey)` where `channelKey` is the same 32-byte key for all messages (no per-message KDF). Include `key_version` field for rotation.
- **DM messages:** Replace `encryptDm()`/`decryptDm()` with same ECDH shared secret but simpler: `dmKey = HKDF(sharedSecret, sharedSecret, "dm-channel:" + dmChannelId, 32)` → then use `aeadEncrypt(plaintext, dmKey)`.
- **No message_nonce needed** if using static channel key (simplification: nonce is per-AEAD and random)
- **No message_signature** needed — AEAD auth tag is sufficient
- **Attach profile snapshots** to message payloads instead of separate `encrypted_profile_key`/`profile_key_nonce` fields

### 3.3 Current Profile Flow (Broken)

**Current:** Profile data (display_name, description, colors, picture file IDs) sent in **plaintext** via:
- `POST /api/profile/update` — stores in plaintext columns
- WebSocket broadcast `profile_updated` — sends plaintext to all friends + server members
- `GET /api/profile/{userId}` — returns all plaintext fields
- Message WS payload includes `sender_display_name`, `sender_profile_pic`, etc. in plaintext

**Streamlined fix:**
- Encrypt profile JSON with a random `profileKey` (32 bytes) → store as `encrypted_profile_data`
- `profileKey` is envelope-encrypted for self-viewing
- Attach `encrypted_profile_snapshot` (encrypted with channel/DM key) to messages
- Recipients decrypt snapshot with channel/DM key, cache in memory

### 3.4 Current Key Management (localStorage)

| Key | Streamlined plan keeps? |
|-----|------------------------|
| `e2e_identity_private_{uid}` | ✅ KEEP |
| `e2e_identity_public_{uid}` | ✅ KEEP |
| `e2e_server_{sid}` | ✅ KEEP |
| `e2e_server_history_{sid}` | ✅ KEEP (for key rotation backward compat) |
| `e2e_file_{fid}` | ✅ KEEP |
| `e2e_friend_code` | **REMOVE** — derive from escrow instead |
| `e2e_password` | Already replaced with encrypted version |
| `e2e_device_key` | **REMOVE** — no device keys |
| `e2e_encrypted_password` | ✅ KEEP |
| `known_key_fingerprints` | **REMOVE** — no TOFU |
| `known_key_fingerprints_v2` | **REMOVE** — no TOFU |
| `profile_key_cache` | **REMOVE** — profile snapshots in messages |
| `muted_servers`, `muted_channels`, `muted_dms` | ✅ KEEP |
| `dm_ratchet:*` | **REMOVE** — no DM ratchet |

---

## 4. Current Server-Side Architecture

### 4.1 `server/src/db.rs` — Database layer

Key structures and what to change:

| Struct | Streamlined plan | Changes |
|--------|-----------------|---------|
| `User` | ✅ KEEP | No change |
| `Server` | **CHANGE** | Add `encrypted_name`, `name_nonce`; remove `name` |  
| `Channel` | **CHANGE** | Add `encrypted_name`, `name_nonce`; remove `name` |
| `Message` | **CHANGE** | Remove `message_signature`, `encrypted_profile_key`, `profile_key_nonce`, `encrypted_banner_key`, `banner_key_nonce`, `sender_display_name`, `sender_profile_pic`, `sender_username_color` |
| `DmMessage` | **CHANGE** | Same removals as Message |
| `PreKeyBundle` | **REMOVE** entire struct | Not used |
| `Session` | **REMOVE** entire struct | Not used |
| `FriendRequestRow` | ✅ KEEP | No change |
| `FriendRow` | ✅ KEEP | No change |
| `FileRecord` | ✅ KEEP | No change |

Functions to **REMOVE** from db.rs:
- `save_prekey_bundle()`, `get_prekey_bundle()`, `consume_one_time_prekey()` — not used
- `save_session()`, `get_session()`, `delete_session()` — not used
- All `update_display_name()`, `update_username_color()`, `update_username_border_color()`, `update_profile_picture()`, `update_profile_banner()`, `update_description()`, `update_nickname()`, `update_profile_background_color()` — replace with single `save_encrypted_profile()`
- `get_encrypted_profile()` — ✅ KEEP (used by streamlined profile)
- All `update_*` functions that write plaintext profile fields → **REMOVE**
- `get_server_members_with_names()` — remove profile fields from return
- All sticker-related functions

Functions to **ADD**:
- `save_server_key_v2(server_id, user_id, encrypted_key, sender_public_key, nonce, version)` — drop `device_id`
- `save_dm_key()` — **REMOVE entirely** (DM key derived via ECDH)
- `get_server_encrypted_name()` / `set_server_encrypted_name()`
- `get_channel_encrypted_name()` / `set_channel_encrypted_name()`

### 4.2 `server/src/handlers.rs` — HTTP Handlers

| Handler | Streamlined plan | Changes |
|---------|-----------------|---------|
| `POST /api/register` | ✅ KEEP | Simplify: remove prekey registration, device registration |
| `POST /api/login` | ✅ KEEP | Simplify |
| `GET /api/profile/{userId}` | **CHANGE** | Return encrypted profile data instead of plaintext fields |
| `POST /api/profile/update` | **CHANGE** | Accept encrypted profile blob, store in `encrypted_profile_data`; stop updating plaintext fields |
| `POST /api/servers` | **CHANGE** | Accept `encrypted_name`, `name_nonce` |
| `POST /api/channels` | **CHANGE** | Accept `encrypted_name`, `name_nonce` |
| `GET /api/servers/{sid}` | **CHANGE** | Return encrypted fields |
| `GET /api/servers/{sid}/channels` | **CHANGE** | Return encrypted fields |
| `GET /api/servers/{sid}/members` | **CHANGE** | Don't include display_name, profile_pic in plaintext |
| `GET /api/channels/{cid}/messages` | **CHANGE** | Remove plaintext sender profile fields |
| `GET /api/dm/{dmcid}/messages` | **CHANGE** | Same |
| `POST /api/devices` | **REMOVE handler** | Not needed |
| `GET /api/devices` | **REMOVE handler** | Not needed |
| `DELETE /api/devices/{id}` | **REMOVE handler** | Not needed |
| `POST /api/keys/upload` | **REMOVE handler** | Not needed (prekeys) |
| Sticker upload/list handlers | **REMOVE** | Stickers removed |
| Notification sound handlers | **REMOVE** | Notifications simplified |
| `POST /api/servers/{id}/keys/rotate` | ✅ KEEP | Key rotation still useful |
| `POST /api/identity/escrow` | ✅ KEEP | Key recovery |
| `GET /api/identity/escrow` | ✅ KEEP | Key recovery |
| `POST /api/friend-code` | ✅ KEEP | |
| `GET /api/friend-code` | ✅ KEEP | |
| `POST /api/friend-requests/send` | ✅ KEEP | |
| `POST /api/friend-requests/accept` | ✅ KEEP | |
| `POST /api/servers/{sid}/join` | ✅ KEEP | |
| File upload/list/download | ✅ KEEP | |

### 4.3 `server/src/ws.rs` — WebSocket Handling

| Message type | Streamlined plan | Changes |
|-------------|-----------------|---------|
| `message_send` | ✅ KEEP | Simplify: remove `message_nonce`, `message_signature`, profile key fields |
| `message_edit` | ✅ KEEP | Same simplifications |
| `dm_send` | ✅ KEEP | Same simplifications |
| `dm_edit` | ✅ KEEP | Same simplifications |
| `profile_updated` | **CHANGE** | Send encrypted profile blob only; recipients decrypt locally |
| `member_joined` | ✅ KEEP | Needed for key distribution |
| `member_left` | ✅ KEEP | Needed |
| Device management messages | **REMOVE** | Not needed |
| Sticker/emoji messages | **REMOVE** | Stickers removed |

### 4.4 `server/src/auth.rs` — Authentication

- ✅ KEEP as-is — JWT-based authentication is fine
- No changes needed

### 4.5 `server/src/main.rs` — Server Setup

- ✅ KEEP as-is — routes, CORS, TLS setup fine
- Remove sticker routes, device routes, notification sound routes

---

## 5. What to REMOVE — Tables, Columns, Code

### 5.1 Database Tables to DROP

```sql
DROP TABLE IF EXISTS user_devices;
DROP TABLE IF EXISTS user_device_escrow;
DROP TABLE IF EXISTS prekey_bundles;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS notification_sounds;
DROP TABLE IF EXISTS server_stickers;
DROP TABLE IF EXISTS user_stickers;
```

### 5.2 Database Columns to DROP (via ALTER TABLE remakes)

```sql
-- messages: drop unused columns
-- (SQLite can't DROP COLUMN easily, need to recreate table)
ALTER TABLE messages DROP COLUMN message_signature;        -- SQLite 3.35+ supports this
ALTER TABLE messages DROP COLUMN encrypted_profile_key;
ALTER TABLE messages DROP COLUMN profile_key_nonce;
ALTER TABLE messages DROP COLUMN encrypted_banner_key;
ALTER TABLE messages DROP COLUMN banner_key_nonce;

-- dm_messages: same
ALTER TABLE dm_messages DROP COLUMN message_signature;
ALTER TABLE dm_messages DROP COLUMN encrypted_profile_key;
ALTER TABLE dm_messages DROP COLUMN profile_key_nonce;
ALTER TABLE dm_messages DROP COLUMN encrypted_banner_key;
ALTER TABLE dm_messages DROP COLUMN banner_key_nonce;

-- servers: drop legacy columns
ALTER TABLE servers DROP COLUMN name;                -- Only keep encrypted_name
ALTER TABLE servers DROP COLUMN invite_code;         -- Only keep invite_code_hash

-- channels: drop legacy columns
ALTER TABLE channels DROP COLUMN name;               -- Only keep encrypted_name

-- users: drop plaintext profile columns
ALTER TABLE users DROP COLUMN display_name;
ALTER TABLE users DROP COLUMN profile_picture_file_id;
ALTER TABLE users DROP COLUMN profile_picture_file_key;
ALTER TABLE users DROP COLUMN profile_banner_file_id;
ALTER TABLE users DROP COLUMN profile_banner_file_key;
ALTER TABLE users DROP COLUMN description;
ALTER TABLE users DROP COLUMN nickname;
ALTER TABLE users DROP COLUMN username_color;
ALTER TABLE users DROP COLUMN username_border_color;
ALTER TABLE users DROP COLUMN profile_background_color;
ALTER TABLE users DROP COLUMN profile_updated_at;

-- server_keys: drop device_id
ALTER TABLE server_keys DROP COLUMN device_id;

-- dm_keys: entire table DROP
DROP TABLE IF EXISTS dm_keys;
```

### 5.3 Crypto Functions to DELETE from `static/crypto.js`

```js
// Delete these entire functions:
deriveChannelKey()
deriveMetadataKey()
encryptWithKeyAndNonce()
encrypt()        // the per-server-key version
decrypt()        // the per-server-key version
encryptMetadata()
decryptMetadata()
encryptDm()
decryptDm()
verifyKeyForUser()
trustCurrentKey()
fingerprintKey()
getKnownFingerprints()
saveKnownFingerprints()
claimLegacyIdentityKey()
ratchetKey()
rotateDmKey()
signMessage()
verifyMessage()
deriveSessionKey()
encryptFileKeyForStorage()
decryptFileKeyFromStorage()
encodeEncryptedFileKey()
decodeEncryptedFileKey()
```

### 5.4 Client-Side Code to DELETE

From `static/auth.js`:
- `claimLegacyIdentityKey()` call after login
- `POST /api/identity/upload` fallback (not needed if escrow always exists)
- `POST /api/devices` flow
- `e2e_device_key` generation/storage

From `static/chat.js`:
- `sendDmMessage()` — rewrite to use simplified ECDH
- `sendMessage()` — rewrite to use simplified channel key
- All sticker/emoji loading functions
- Notification sound upload/download
- Device management UI
- `encrypted_profile_key`/`profile_key_nonce`/`encrypted_banner_key`/`banner_key_nonce` in message payloads
- Profile picture key sharing logic (replaced by profile snapshots in messages)
- `profileKeyCache` — replaced by in-memory snapshot cache
- `loadUserStickers()`, `loadEmojiCache()` — removed
- DM ratchet state management (`dm_ratchet:*` in localStorage)

### 5.5 Server-Side Code to DELETE

From `server/src/db.rs`:
- `PreKeyBundle` struct
- `Session` struct
- `save_prekey_bundle()`, `get_prekey_bundle()`, `consume_one_time_prekey()`
- `save_session()`, `get_session()`, `delete_session()`
- All individual `update_*` functions for plaintext profile fields (replace with single `save_encrypted_profile()`)
- `get_profile_background_color()`, `get_profile_updated_at()`
- `update_display_name()`, `update_username_color()`, `update_username_border_color()`, `update_profile_picture()`, `update_profile_banner()`, `update_description()`, `update_nickname()`, `update_profile_background_color()`

From `server/src/handlers.rs`:
- All device management handlers
- All prekey bundle handlers
- Sticker upload/list handlers
- Notification sound handlers
- Remove `sender_display_name`, `sender_profile_pic`, `sender_username_color` from message response structs

From `server/src/ws.rs`:
- Device management WebSocket handlers
- Sticker/emoji WebSocket handlers
- Remove `sender_display_name`, `sender_profile_pic`, `sender_username_color`, `sender_username_border_color` from message broadcast payloads
- Remove `encrypted_profile_key`, `profile_key_nonce`, `encrypted_banner_key`, `banner_key_nonce` from broadcast payloads

---

## 6. What to ADD — New Columns & Code

### 6.1 Database Columns to ADD

```sql
-- servers: encrypted server name (add these columns)
ALTER TABLE servers ADD COLUMN encrypted_name BLOB;
ALTER TABLE servers ADD COLUMN name_nonce BLOB;

-- channels: encrypted channel name
ALTER TABLE channels ADD COLUMN encrypted_name BLOB;
ALTER TABLE channels ADD COLUMN name_nonce BLOB;

-- messages: key_version for rotation tracking
ALTER TABLE messages ADD COLUMN key_version INTEGER DEFAULT 1;
ALTER TABLE dm_messages ADD COLUMN key_version INTEGER DEFAULT 1;
```

### 6.2 Crypto Functions to ADD to `static/crypto.js`

```js
// Rename existing x25519GenerateKeyPair:
function generateIdentityKeyPair() {
    return x25519GenerateKeyPair(); // same implementation
}

// New: explicit envelope encrypt taking sender priv key
function envelopeEncrypt(plaintext, recipientPub, senderPriv) {
    // Use ECDH(senderPriv, recipientPub) instead of ephemeral
    // This provides implicit authentication
    var sharedSecret = x25519SharedSecret(senderPriv, recipientPub);
    var key = hkdf(sharedSecret, sharedSecret, 'e2e-envelope-v1', 32);
    var enc = xchacha20poly1305Encrypt(key, plaintext);
    var combined = concatBuffers(enc.ciphertext, enc.tag);
    return {
        ciphertext: arrayBufferToBase64(combined),
        nonce: arrayBufferToBase64(enc.nonce),
        // No eph_pub needed since identity keys are known
    };
}

// Rename: wrap existing xchacha20poly1305Encrypt
function aeadEncrypt(plaintext, key, aad) {
    // Ignore aad for now (or incorporate as Poly1305 AAD)
    var enc = xchacha20poly1305Encrypt(key, plaintext);
    var combined = concatBuffers(enc.ciphertext, enc.tag);
    return {
        ciphertext: arrayBufferToBase64(combined),
        nonce: arrayBufferToBase64(enc.nonce),
    };
}

function aeadDecrypt(ciphertext, key, nonce, aad) {
    var combined = new Uint8Array(base64ToArrayBuffer(ciphertext));
    var nonceBytes = new Uint8Array(base64ToArrayBuffer(nonce));
    var ct = combined.slice(0, combined.length - 16);
    var tag = combined.slice(combined.length - 16);
    var plaintext = xchacha20poly1305Decrypt(key, ct, tag, nonceBytes);
    return new TextDecoder().decode(plaintext);
}

function generateSymmetricKey() {
    return randomBytes(32);
}
```

### 6.3 Profile Snapshot System (NEW)

Add to message sending flow — instead of separate `encrypted_profile_key`/`profile_key_nonce` fields:

```js
// When sending a message, optionally attach profile snapshot
function prepareMessagePayload(plaintext, channelKey, profileData) {
    var msg = { text: aeadEncrypt(plaintext, channelKey) };
    
    if (profileData) {
        // Encrypt profile snapshot with channel key
        var profileJson = JSON.stringify(profileData);
        msg.encrypted_profile_snapshot = aeadEncrypt(profileJson, channelKey);
        msg.profile_version = profileData.version;
    }
    
    return msg;
}
```

Profile data JSON format (encrypted blob):
```json
{
    "display_name": "Alice",
    "profile_picture_file_id": "uuid",
    "profile_picture_file_key": "base64...",
    "username_color": "#ff6600",
    "username_border_color": "#000000",
    "description": "Hello!",
    "version": 3
}
```

### 6.4 DM Key Derivation (SIMPLIFIED)

```js
// Replace current encryptDm/decryptDm with:
function getDmKey(dmChannelId, myPrivateKey, otherPublicKey) {
    var shared = x25519SharedSecret(myPrivateKey, otherPublicKey);
    return hkdf(shared, shared, 'dm-channel:' + dmChannelId, 32);
}

// Usage:
function sendDm(plaintext, dmChannelId, myPriv, theirPub) {
    var dmKey = getDmKey(dmChannelId, myPriv, theirPub);
    return aeadEncrypt(plaintext, dmKey);
}

function receiveDm(ciphertext, nonce, dmChannelId, myPriv, theirPub) {
    var dmKey = getDmKey(dmChannelId, myPriv, theirPub);
    return aeadDecrypt(ciphertext, dmKey, nonce);
}
```

---

## 7. What to CHANGE — Existing Components to Modify

### 7.1 Server Message Flow (chat.js)

**BEFORE (current):**
```
1. encrypt(plaintext, channelId, serverId):
   - serverKey = getServerKey(serverId)
   - msgNonce = randomBytes(16)
   - key = HKDF(serverKey, serverKey, "e2e-channel-v1:" + channelId + ":" + msgNonce, 32)
   - result = XChaCha20-Poly1305(key, plaintext)
   - send: { encrypted_content, nonce, message_nonce: msgNonce }
```

**AFTER (streamlined):**
```
1. channelKey = getServerKey(serverId)
2. result = aeadEncrypt(plaintext, channelKey)
3. send: { encrypted_content: result.ciphertext, nonce: result.nonce, key_version: 1 }
```

### 7.2 DM Message Flow (chat.js)

**BEFORE (current):**
```
1. sharedSecret = X25519(myPriv, theirPub)
2. msgNonce = randomBytes(16)
3. key = HKDF(sharedSecret, sharedSecret, "e2e-dm-v1:" + dmChannelId + ":" + msgNonce)
4. result = XChaCha20-Poly1305(key, plaintext)
5. send: { encrypted_content, nonce, message_nonce }
```

**AFTER (streamlined):**
```
1. dmKey = HKDF(sharedSecret, sharedSecret, "dm-channel:" + dmChannelId, 32)
2. result = aeadEncrypt(plaintext, dmKey)
3. send: { encrypted_content: result.ciphertext, nonce: result.nonce }
```

### 7.3 Profile Update (chat.js / auth.js)

**BEFORE (current):**
- POST /api/profile/update with all plaintext fields
- Server stores each field separately in plaintext columns
- Server broadcasts `profile_updated` with all plaintext fields

**AFTER (streamlined):**
1. User edits profile in UI
2. Encrypt profile JSON with `profileKey` (random per-user key):
   ```
   profileKey = getProfileKey() // stored in localStorage or derived from identity
   encryptedProfile = aeadEncrypt(JSON.stringify(profileData), profileKey)
   ```
3. POST /api/profile/update with ONLY `encrypted_profile_data`, `encrypted_profile_salt`, `encrypted_profile_nonce`
4. Server stores in existing `encrypted_profile_data` columns
5. When sending next message, include `encrypted_profile_snapshot` encrypted with channel/DM key:
   ```
   snapshot = aeadEncrypt(JSON.stringify(profileData), channelKey)
   ```
6. Recipients decrypt snapshot from message payload

### 7.4 Key Distribution (chat.js)

**BEFORE (current):**
- Server keys: envelope-encrypted via X25519 ephemeral
- DM keys: envelope-encrypted via X25519 ephemeral, stored in `dm_keys` table

**AFTER (streamlined):**
- Server keys: same envelope encryption (keep as-is)
- DM keys: **NOT stored on server** — derived client-side via ECDH
- Remove all `dm_keys` storage code

### 7.5 Server Join Flow

**BEFORE (current):**
1. User submits invite code
2. Server adds to `server_members`
3. WS broadcast `member_joined`
4. Owner's client envelope-encrypts channel key for new user
5. Uploads to `server_keys`

**AFTER (streamlined):** Same flow, but:
- Remove `device_id` from `server_keys`
- Keep everything else identical

---

## 8. Complete Migration Steps

### Step 1: Database Migration
**File:** `new_migration.sql`
**Actions:**
1. Add `encrypted_name` + `name_nonce` to `servers` and `channels`
2. Add `key_version` to `messages` and `dm_messages`
3. Drop unused columns from `messages`, `dm_messages` (signature, profile keys)
4. Drop tables: `user_devices`, `user_device_escrow`, `prekey_bundles`, `sessions`, `notification_sounds`, `server_stickers`, `user_stickers`
5. Drop plaintext profile columns from `users` (display_name, colors, etc.)
6. Drop `device_id` from `server_keys`
7. Drop `dm_keys` table

### Step 2: Crypto Simplification
**File:** `static/crypto.js`
**Actions:**
1. Rename `x25519GenerateKeyPair` → `generateIdentityKeyPair`
2. Add `aeadEncrypt`/`aeadDecrypt` wrappers
3. Add `generateSymmetricKey`
4. Remove all ratchet, KDF chain, per-message signing, TOFU, file-key-encryption functions
5. Keep envelope encryption, password escrow, base64 helpers

### Step 3: Profile Encryption
**Files:** `static/chat.js`, `static/auth.js`, `server/src/handlers.rs`, `server/src/db.rs`
**Actions:**
1. Remove all plaintext profile field updates from server handlers
2. Remove all plaintext profile columns from Rust structs
3. Add client-side profile JSON encryption with `profileKey`
4. Profile snapshot piggyback on messages

### Step 4: Message Encryption Simplification
**Files:** `static/chat.js`, `server/src/ws.rs`, `server/src/handlers.rs`
**Actions:**
1. Remove `message_nonce` from message send/recv flows
2. Remove `message_signature` from message send/recv flows
3. Remove `encrypted_profile_key`/`profile_key_nonce`/`encrypted_banner_key`/`banner_key_nonce` from message payloads
4. Use simple `aeadEncrypt(plaintext, channelKey)` instead of HKDF chain
5. Add `key_version` to message payloads

### Step 5: DM Simplification
**Files:** `static/chat.js`, `server/src/db.rs`, `server/src/handlers.rs`
**Actions:**
1. Remove `dm_keys` table and all associated code
2. Derive DM key client-side via ECDH + HKDF
3. Remove DM key upload/download from client
4. Remove DM key distribution from server

### Step 6: Remove Multi-Device & Prekeys
**Files:** `static/auth.js`, `static/chat.js`, `server/src/handlers.rs`, `server/src/db.rs`, `server/src/ws.rs`
**Actions:**
1. Remove device registration from registration flow
2. Remove prekey generation from registration flow
3. Remove device management handlers
4. Remove `user_devices`, `user_device_escrow` tables
5. Remove prekey bundle handlers
6. Remove `device_id` from all WebSocket messages

### Step 7: Remove Stickers & Notifications
**Files:** `static/chat.js`, `server/src/handlers.rs`, `server/src/db.rs`, `server/src/ws.rs`
**Actions:**
1. Remove all sticker handlers and UI
2. Remove notification sound handlers
3. Drop `server_stickers`, `user_stickers`, `notification_sounds` tables

### Step 8: Clean Up Server Response Structs
**Files:** `server/src/db.rs`, `server/src/handlers.rs`
**Actions:**
1. Remove `sender_display_name`, `sender_profile_pic`, `sender_username_color` from `Message` and `DmMessage` structs
2. Remove these fields from all SQL queries
3. Add `key_version` to message structs

---

## 9. Reference: Current vs Streamlined Feature Matrix

| Feature | Current Implementation | Streamlined Plan |
|---------|----------------------|-----------------|
| **Identity** | X25519 keypair per user | Same ✅ |
| **Multi-device** | Per-device keypairs, signed prekeys, one-time prekeys | Removed — one key per user, password escrow for recovery |
| **Key recovery** | Password-encrypted escrow | Same ✅ |
| **Server key distribution** | Envelope-encrypted via X25519 | Same ✅ |
| **DM key agreement** | Static ECDH + per-message HKDF | Static ECDH + single channel key HKDF |
| **Message encryption** | Per-message KDF chain (HKDF per message) | Simple AEAD with channel key |
| **Message signatures** | HMAC-SHA256 (unused) | Removed — AEAD auth tag is sufficient |
| **Forward secrecy** | None (static channel key) | None (static channel key) |
| **Profile encryption** | Partial (plaintext leak) | Full encryption + snapshot in messages |
| **Server/channel names** | Plaintext | Encrypted with channel key |
| **File encryption** | Chunked XChaCha20-Poly1305 | Same ✅ |
| **Voice/video** | Not implemented | Standard WebRTC (no SFrame) |
| **Stickers** | Full implementation | Removed |
| **Notification sounds** | Encrypted sound upload | Removed |
| **TOFU key verification** | SHA-256 fingerprint | Removed |

---

## 10. Potentially Dangerous Simplifications

These trade-offs from the streamlined plan should be explicitly noted for the implementing AI:

### 10.1 No Forward Secrecy
- **Risk:** If the channel key is compromised (server breach, stolen localStorage), ALL past messages are readable
- **Current:** Same risk (no forward secrecy)
- **Streamlined:** Same
- **Mitigation:** Key rotation on member leave/kick

### 10.2 No Per-Message Authentication
- **Risk:** Any member with the channel key can forge messages as any other member. The server could inject messages if it has the channel key.
- **Current:** HMAC signatures exist but are **never used**
- **Streamlined:** Removes HMAC entirely
- **Mitigation:** AEAD auth tag prevents ciphertext tampering. Channel key is shared among all members — members can indeed forge. Acceptable per the threat model.

### 10.3 No Message Nonces
- **Risk:** If the same plaintext is encrypted twice with the same key without unique nonces in AEAD, the ciphertexts will be identical (revealing message deduplication).
- **Current:** Uses unique per-message nonce (+ message-level nonce in HKDF)
- **Streamlined:** Uses random AEAD nonce per message (which is sufficient for XChaCha20's 192-bit nonce — collisions are statistically impossible)
- **Verdict:** Safe — XChaCha20's 192-bit nonce is large enough for random nonces

### 10.4 No Profile Sync (Attached to Messages)
- **Risk:** Profiles appear "stale" until a user sends a message. If a user changes their name and never speaks again, others never see the update.
- **Current:** Dedicated profile update broadcast
- **Streamlined:** Profile bundled with next message
- **Verdict:** Usability trade-off. Acceptable for v1.

### 10.5 No DM Key Storage on Server
- **Risk:** New devices must both be online simultaneously to derive the DM key. No history available if both have never spoken on these devices.
- **Current:** `dm_keys` table stores the key envelope-encrypted
- **Streamlined:** Key derived on-the-fly via ECDH — any device with both identity keys can derive it
- **Verdict:** Actually BETTER in some ways. But a new device joining a DM needs to know the other user's identity public key (which is stored on server).

---

> **End of document.** The implementing AI should start with the database migration, then proceed step-by-step through the migration steps in Section 8. Each step should be followed by running the existing test suite to ensure no regressions.
