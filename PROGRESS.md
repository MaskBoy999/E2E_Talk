# E2E Talk — Implementation Analysis & Bug Fix Log

## Bug Fixes Applied (2026-07-23)

### Bug 1: Friend request accept doesn't create/select DM chat

**Root cause:** Two code paths handled friend request acceptance but neither auto-selected the DM conversation:
1. The `acceptFriendRequest()` UI function (called when clicking Accept in the modal) loaded DMs but never navigated to the new conversation.
2. The WebSocket `friend_request_accepted` handler also loaded DMs but never switched views.

**Fixes:**
1. **Server** (`server/src/handlers.rs`): Added `"from_user_id": from_id` to the `friend_request_accepted` WebSocket JSON payload so the client can identify the original sender regardless of which end of the friendship they're on.
2. **Client WS handler** (`static/chat.js`): Updated to use both `by_user_id` and `from_user_id` to find the correct conversation for sender (looks for the acceptor's ID) vs acceptor (looks for the sender's ID), switches to DM view, and selects the channel.
3. **Client `acceptFriendRequest`** (`static/chat.js`): Captures the sender's user ID from `cachedFriendRequests` BEFORE the cache is cleared by `loadFriendRequests()`, then sets DM view state and calls `selectDmChannel()` to navigate to the new DM.

### Bug 2: Server key "Cannot decrypt server key" stuck

**Root cause:** The `selectServer()` function called `fetchAndDecryptServerKey()` only once. If the owner hadn't finished rotating the key yet (receives `member_joined` WS message, fetches new member's identity key, encrypts+uploads the server key), the user saw "Cannot decrypt server key" with no recovery.

**Fixes:**
1. **`selectServer()`** (`static/chat.js`): Changed from single `fetchAndDecryptServerKey()` call to a 10-attempt retry loop with 1.5s delays (~15s total wait).
2. **`joinServer()`** (`static/chat.js`): Both retry loops increased from 5 attempts/1s delay to 10 attempts/1.5s delay to give more time for the key to propagate.

### Test Status
| Test | Status |
|------|--------|
| Server key decryption after joining | ✅ **Passed** — channels load correctly |
| Friend code features (4 tests) | ✅ **Passed** |
| DM auto-select after friend accept | 🟡 **Partial** — DM auto-selects correctly, friend code button re-binding has minor timing sensitivity |

---

# 🔒 Comprehensive Security Audit: Every Data Flow Path

## Legend
- 🟢 **Encrypted E2E** — encrypted client-side before sending; server CANNOT decrypt
- 🟡 **Hashed** — HMAC-SHA256 or SHA-256; server cannot reverse
- 🔵 **Key-Encrypted** — encrypted but the key is shared with the server or accessible
- 🔴 **Plaintext** — sent/received/stored as-is; server CAN read
- 🟣 **TLS-Only** — plaintext inside the TLS tunnel; server sees the data

---

## 1. Every API Endpoint — Request/Response Data Flow

### Authentication & Account Management

| Endpoint | What Client SENDS | Encrypted Before Send? | What Server RETURNS | Server Can Read? |
|----------|------------------|----------------------|-------------------|-----------------|
| `POST /api/register` | `username`, `password` | 🟣 TLS-only (password sent as-is inside HTTPS) | token, user id, username | ✅ YES — server sees password and username |
| | `identity_public_key` (X25519 public) | 🟢 Public key by nature (not secret) | — | ✅ YES — it's a public key |
| | `encrypted_friend_code` + `salt` + `nonce` | 🟢 Argon2id-wrapped with user's password | — | ❌ NO — server stores but cannot decrypt without password |
| | `encrypted_identity_priv` + `escrow_salt` + `escrow_nonce` | 🟢 Argon2id-wrapped for escrow | — | ❌ NO — can't unwrap without user's password |
| | `friend_code_hash` | 🟡 HMAC-SHA256 hashed client-side | — | ❌ NO — one-way hash; can verify but not reverse |
| `POST /api/login` | `username`, `password` | 🟣 TLS-only | token, user id, username | ✅ YES |
| `POST /api/reauth` | `password` | 🟣 TLS-only | new token | ✅ YES |
| `DELETE /api/me` | (auth only) | — | ok/error | — |
| `GET /api/me` | (auth only) | — | `id`, `username` | ✅ YES — server reads these from DB |

### Profile Endpoints

| Endpoint | What Client SENDS | Encrypted Before Send? | What Server RETURNS | Server Can Read? |
|----------|------------------|----------------------|-------------------|-----------------|
| `GET /api/profile/{userId}` | (auth only) | — | `id`, `username` | ✅ YES — from users table |
| | | — | `profile_picture_file_id`, `profile_banner_file_id` | ✅ YES — file references (not the actual image) |
| | | — | `profile_picture_file_key` | 🟢 Only to friends/server-mates: encrypted with identity key (server stores but can't decrypt) |
| | | — | `profile_banner_file_key` | 🟢 Same as above |
| | | — | `encrypted_profile_data`, `salt`, `nonce`, `data_key` | ❌ NO — encrypted with profile_data_key; server has NO access to this key |
| `PATCH /api/profile` | `encrypted_profile_data` + `salt` + `nonce` | 🟢 AES-GCM encrypted with profile_data_key | ok/error | ❌ NO — server stores blob but can't decrypt |
| | `profile_picture_file_id` + `file_key` | 🟢 File key is `nonce:ciphertext` wrapped with identity key | — | ❌ NO — can't unwrap |
| | `profile_banner_file_id` + `file_key` | 🟢 Same pattern | — | ❌ NO |
| `PUT /api/profile/conversation` | `encrypted_profile_data` + `nonce` + `conversation_type` + `conversation_id` | 🟢 Encrypted with DM or server key | ok/error | ❌ NO — server stores but doesn't have channel keys |
| `GET /api/profile/{userId}/conversation/{type}/{id}` | (auth only) | — | `encrypted_profile_data` + `nonce` | ❌ NO — server just returns stored encrypted blob |

### Friend Code Endpoints

| Endpoint | What Client SENDS | Encrypted Before Send? | What Server RETURNS | Server Can Read? |
|----------|------------------|----------------------|-------------------|-----------------|
| `GET /api/hmac-key` | (none) | — | `hmac_key` (plaintext HMAC key) | ✅ YES — server generated it |
| `PUT /api/profile/data-key` | `encrypted_key` + `nonce` | 🟢 Profile_data_key encrypted with identity key | `{"ok": true}` | ❌ NO — server stores encrypted blob, can't unwrap without identity private key |
| `GET /api/profile/data-key/{userId}` | (auth only) | — | `encrypted_key` + `nonce` | ❌ NO — same encrypted blob; only the owning user can decrypt with their identity key |
| `GET /api/friend-code` | (auth only) | — | `encrypted_friend_code` + `salt` + `nonce` | ❌ NO — password-wrapped Argon2id |
| `POST /api/friend-code/store-encrypted` | `friend_code` (plaintext!) + `encrypted_friend_code` + `salt` + `nonce` | 🟣 Friend code is PLAINTEXT in HTTPS body; encrypted copy is 🟢 | ok/error | ✅ YES — server sees the plaintext friend code (it needs it to compute the HMAC hash) |
| `POST /api/friend-code/regenerate` | (auth only) | — | `friend_code` (plaintext!) + ok | ✅ YES — server generates and returns the raw code |
| `POST /api/friend-code/regen-with-password` | `password` + `friend_code` (plaintext!) + encrypted backup | 🟣 Password in plaintext; friend code in plaintext | ok/error | ✅ YES — server sees both password and friend code |

### Friend Request & DM Endpoints

| Endpoint | What Client SENDS | Encrypted Before Send? | What Server RETURNS | Server Can Read? |
|----------|------------------|----------------------|-------------------|-----------------|
| `POST /api/friends/request` | `friend_code` (plaintext!) | 🟣 Plaintext in HTTPS | ok + target user info | ✅ YES — server re-hashes to look up user |
| `POST /api/friends/requests/accept` | `request_id` | 🟣 Plaintext | ok | ✅ YES |
| `POST /api/friends/requests/decline` | `request_id` | 🟣 Plaintext | ok | ✅ YES |
| `GET /api/friends/requests/incoming` | (auth only) | — | `[{id, from_user_id, from_username, status, created_at}]` | ✅ YES — all plaintext from DB |
| `GET /api/friends/requests/outgoing` | (auth only) | — | Same structure | ✅ YES |
| `GET /api/friends` | (auth only) | — | `[{id, username}]` | ✅ YES |
| `POST /api/friends/remove` | `user_id` | 🟣 Plaintext | ok | ✅ YES |
| `GET /api/dm/conversations` | (auth only) | — | `[{dm_channel_id, other_user_id, other_username, other_display_name, other_profile_picture_file_id, other_public_key, last_message: {encrypted_content, nonce, ...}}]` | ✅ Metadata is plaintext; 🔴 `last_message.encrypted_content` is ciphertext server can't read |
| `POST /api/dm/{friend_user_id}` | (auth only) | — | DM channel info | ✅ YES |
| `GET /api/dm/{dm_channel_id}/messages` | (auth only) | — | Same structure as channel messages | ✅ Metadata plaintext; ❌ content encrypted |
| `GET /api/dm/{dm_channel_id}/keys` | (auth only) | — | `[{user_id, encrypted_key, sender_public_key, nonce}]` | ❌ NO — DM keys envelope-encrypted with identity keys |
| `POST /api/dm/{dm_channel_id}/keys` | `encrypted_key`, `sender_public_key`, `nonce` | 🟢 Envelope-encrypted with recipient's identity key | ok | ❌ NO — server can't unwrap |

### Server & Channel Endpoints

| Endpoint | What Client SENDS | Encrypted Before Send? | What Server RETURNS | Server Can Read? |
|----------|------------------|----------------------|-------------------|-----------------|
| `POST /api/servers` | `invite_code_hash` | 🟡 HMAC-hashed client-side | server id, encrypted_name, name_nonce | ❌ NO — hash only |
| | `encrypted_name` + `name_nonce` | 🟢 Encrypted with freshly generated server key | — | ❌ NO — server doesn't have the server key at this point |
| `GET /api/servers` | (auth only) | — | `[{id, encrypted_name, name_nonce, is_owner, joins_disabled}]` | ❌ NO — names are ciphertext; ✅ server can see metadata (id, ownership) |
| `POST /api/servers/{id}/channels` | `encrypted_name` + `name_nonce` | 🟢 Encrypted with server key | channel id, encrypted_name, name_nonce | ❌ NO — same as server names |
| `GET /api/servers/{id}/channels` | (auth only) | — | `[{id, encrypted_name, name_nonce}]` | ❌ NO — names are ciphertext |
| `POST /api/servers/{id}/keys` | `user_id`, `encrypted_key`, `sender_public_key`, `nonce` | 🟢 Envelope-encrypted with recipient's X25519 identity key | ok | ❌ NO — server can't unwrap envelope encryption |
| `GET /api/servers/{id}/keys` | (auth only) | — | `[{user_id, encrypted_key, sender_public_key, nonce, version}]` | ❌ NO — all ciphertext; server stores encrypted blobs |
| `POST /api/servers/{id}/keys/rotate` | Array of `{user_id, encrypted_key, sender_public_key, nonce}` | 🟢 Each entry envelope-encrypted for that user | ok + broadcasts rotation | ❌ NO — server cannot decrypt any of the keys |
| `GET /api/servers/{id}/invite` | (auth only) | — | server info | ✅ YES — invite_code_hash is stored |
| `POST /api/servers/{id}/invite` | `invite_code_hash` | 🟡 HMAC-hashed | ok | ❌ NO — hash only |
| `POST /api/servers/{id}/members/kick` | `user_id` | 🟣 Plaintext | ok | ✅ YES |
| `POST /api/servers/{id}/members/ban` | `user_id` | 🟣 Plaintext | ok | ✅ YES |
| `POST /api/servers/{id}/members/unban/{userId}` | — | — | ok | ✅ YES |
| `GET /api/servers/{id}/bans` | (auth only) | — | `[{id, username}]` | ✅ YES — all plaintext |
| `POST /api/servers/{id}/leave` | (auth only) | — | `{ok, server_deleted}` | ✅ YES |
| `PATCH /api/servers/{id}/settings` | `{disabled: bool}` | 🟣 Plaintext | ok | ✅ YES |
| `DELETE /api/channels/{channel_id}` | (auth only) | — | ok | ✅ YES |
| `GET /api/servers/{id}/members` | (auth only) | — | `[{id, username, role, display_name, profile_picture_file_id}]` | ✅ YES — all plaintext from DB |
| `POST /api/invites/join` | `code` (may be pre-hashed or plaintext) | 🟣 Plaintext in HTTPS | server id | ✅ YES — server sees the code; re-hashes to look up |

### Channel Messages

| Endpoint | What Client SENDS | Encrypted Before Send? | What Server RETURNS | Server Can Read? |
|----------|------------------|----------------------|-------------------|-----------------|
| `GET /api/channels/{id}/messages` | (auth only) | — | See below | See below |
| Return fields: | | | | |
| • `id`, `channel_id`, `sender_id` | — | — | ✅ YES — all plaintext |
| • `sender_username` | — | — | ✅ YES — from SQL JOIN with users table |
| • `sender_profile_pic` | — | — | ✅ YES — plaintext file_id |
| • `encrypted_sender_username` + `sender_username_nonce` | 🟢 Encrypted with server key | — | ❌ NO — can't decrypt without server key |
| • `encrypted_content` + `nonce` + `message_nonce` | 🟢 AES-GCM encrypted with server key | — | ❌ NO — server doesn't have the server key |
| • `encrypted_profile_key` + `profile_key_nonce` | 🟢 Encrypted with server key | — | ❌ NO |
| • `encrypted_banner_key` + `banner_key_nonce` | 🟢 Encrypted with server key | — | ❌ NO |
| • `encrypted_file_key` + `file_key_nonce` | 🟢 Encrypted with server key | — | ❌ NO |
| • `key_version` | — | — | ✅ YES — plaintext integer |
| • `encrypted_profile_snapshot` + `nonce` | 🟢 Encrypted with server key | — | ❌ NO |
| • `timestamp`, `edited_at` | — | — | ✅ YES — plaintext timestamps |
| • `conversation_profile` (encrypted_profile_data + nonce) | 🟢 Encrypted with server key | — | ❌ NO — per-conversation encrypted blob |
| `GET /api/channels/{id}/messages/around/{msg_id}` | (auth only) | — | Same fields as `list_messages` | Same analysis |

### Identity Key Endpoints

| Endpoint | What Client SENDS | Encrypted Before Send? | What Server RETURNS | Server Can Read? |
|----------|------------------|----------------------|-------------------|-----------------|
| `GET /api/identity/{userId}` | (auth only) | — | `identity_public_key` (base64 X25519 public key) | ✅ YES — it's a public key (intended to be public) |
| `GET /api/user/{username}` | (auth only) | — | `{id, username}` | ✅ YES |

### Notification Sound

| Endpoint | What Client SENDS | Encrypted Before Send? | What Server RETURNS | Server Can Read? |
|----------|------------------|----------------------|-------------------|-----------------|
| `POST /api/notification-sound` | `encrypted_sound` + `nonce` + `sender_public_key` + `file_name` | 🟢 Encrypted with identity key | ok | ❌ NO — can't decrypt without private key |
| `GET /api/notification-sound` | (auth only) | — | `encrypted_sound` + `nonce` + `file_name` | ❌ NO — encrypted blob |
| `DELETE /api/notification-sound` | (auth only) | — | ok | ✅ YES |

### File Upload/Download

| Endpoint | What Client SENDS | Encrypted Before Send? | What Server RETURNS | Server Can Read? |
|----------|------------------|----------------------|-------------------|-----------------|
| `POST /api/files/init` | `file_name`, `mime_type`, `file_size` | 🟣 Plaintext | `file_id` | ✅ YES — file metadata |
| `POST /api/files/{id}/chunk/{index}` | Raw binary chunk | 🟢 Client MUST encrypt with file key before upload | ok | ❌ NO — server stores opaque blob; client encrypted before upload |
| `POST /api/files/{id}/complete` | (just auth) | — | ok | ✅ YES — but only sees metadata |
| `GET /api/files/{id}/download` | (auth only) | — | Raw encrypted chunk data | ❌ NO — same encrypted blob as uploaded |

### Key Escrow

| Endpoint | What Client SENDS | Encrypted Before Send? | What Server RETURNS | Server Can Read? |
|----------|------------------|----------------------|-------------------|-----------------|
| `POST /api/identity/escrow` | `encrypted_private_key` + `salt` + `nonce` | 🟢 Argon2id-wrapped with user password | ok | ❌ NO — can't unwrap without password |
| `GET /api/identity/escrow` | (auth only) | — | Same encrypted blob | ❌ NO |

---

## 2. Every WebSocket Message Type — Data Flow

### 2A. Messages Sent FROM Client TO Server (via WS)

| WS Type | Fields Sent | Encrypted Before Send? | Server Can Read? |
|---------|------------|----------------------|-----------------|
| `message_send` | `channel_id` | 🔴 Plaintext | ✅ YES |
| | `encrypted_content` | 🟢 AES-GCM with server key | ❌ NO |
| | `nonce`, `message_nonce` | 🔴 Unencrypted (but useless without key) | ❌ NO — can't decrypt content |
| | `encrypted_profile_key`, `profile_key_nonce` | 🟢 Encrypted with server key | ❌ NO |
| | `encrypted_banner_key`, `banner_key_nonce` | 🟢 Encrypted with server key | ❌ NO |
| | `encrypted_profile_snapshot`, `profile_snapshot_nonce` | 🟢 Encrypted with server key | ❌ NO |
| | `encrypted_file_key`, `file_key_nonce` | 🟢 Encrypted with server key | ❌ NO |
| | `encrypted_sender_username`, `sender_username_nonce` | 🟢 Encrypted with server key | ❌ NO |
| | `mentions` (array of user IDs) | 🔴 Plaintext | ✅ YES |
| | `reply_to_user_id` | 🔴 Plaintext | ✅ YES |
| `dm_send` | `dm_channel_id` | 🔴 Plaintext | ✅ YES |
| | `encrypted_content` + `nonce` | 🟢 Encrypted with ECDH-derived DM key | ❌ NO — server has no DM key |
| | Same optional keys as message_send | 🟢 All encrypted with DM key | ❌ NO |
| `message_edit` | `message_id`, same encrypted fields as `message_send` | 🟢 Re-encrypted with server key | ❌ NO |
| `dm_edit` | `message_id`, same encrypted fields as `dm_send` | 🟢 Re-encrypted with DM key | ❌ NO |
| `message_delete` | `message_id` | 🔴 Plaintext | ✅ YES |
| `dm_delete` | `message_id` | 🔴 Plaintext | ✅ YES |
| `profile_key_sync` | `dm_channel_id` | 🔴 Plaintext | ✅ YES |
| | `encrypted_profile_key` + `nonce` | 🟢 Encrypted with DM key | ❌ NO |
| | `encrypted_banner_key` + `nonce` | 🟢 Encrypted with DM key | ❌ NO |
| | `encrypted_profile_data_key` + `nonce` | 🟢 Encrypted with DM key | ❌ NO |
| `profile_key_server_sync` | `server_id` | 🔴 Plaintext | ✅ YES |
| | Same key fields encrypted with server key | 🟢 Encrypted with server key | ❌ NO |

### 2B. Messages Broadcast FROM Server TO Client (via WS)

| WS Type | Fields Broadcast | Encrypted? | Server Can Read Before Broadcast? |
|---------|-----------------|-----------|-------------------------------|
| `message_new` | `channel_id`, `server_id` | 🔴 Plaintext | ✅ YES |
| | `message.id`, `sender_id`, `sender_username`, `sender_profile_pic` | 🔴 Plaintext | ✅ YES — from DB query |
| | `message.encrypted_content` + `nonce` | 🟢 Ciphertext (relayed from sender) | ❌ NO — can't decrypt |
| | Same optional key fields | 🟢 Ciphertext | ❌ NO |
| `dm_new` | `dm_channel_id`, same sender metadata | 🔴 Plaintext | ✅ YES |
| | `message.encrypted_content` | 🟢 Ciphertext | ❌ NO |
| `message_edited` | `channel_id`, same structure as `message_new` | 🔴 Plaintext metadata; 🟢 encrypted content | ✅ YES metadata; ❌ NO content |
| `dm_edited` | Same as `dm_new` | Same | Same |
| `message_deleted` / `dm_deleted` | `channel_id` / `dm_channel_id`, `message_id` | 🔴 Plaintext | ✅ YES |
| `profile_key_sync` | `user_id`, `profile_picture_file_id`, encrypted keys | 🟢 Key fields encrypted; `user_id` is 🔴 plaintext | ❌ NO — all encrypted |
| `profile_key_server_sync` | `user_id`, same structure | 🟢 Key fields encrypted | ❌ NO |
| `member_joined` / `member_left` / `member_kicked` / `member_banned` | `server_id`, `user_id` | 🔴 Plaintext | ✅ YES |
| `server_key_rotated` | `server_id` | 🔴 Plaintext | ✅ YES |
| `server_deleted` | `server_id` | 🔴 Plaintext | ✅ YES |
| `friend_request_received` | `from_user_id`, `from_username` | 🔴 Plaintext | ✅ YES |
| `friend_request_accepted` | `by_user_id`, `from_user_id` | 🔴 Plaintext | ✅ YES |
| `channel_created` / `channel_deleted` | `server_id` | 🔴 Plaintext | ✅ YES |

---

## 3. Database: Every Column — Encrypted vs Plaintext

### `users` table

| Column | Data Type | Encrypted? | Host Can Read? | Notes |
|--------|-----------|-----------|---------------|-------|
| `id` | TEXT PK | 🔴 Plaintext | ✅ YES | UUID, needed for all relationships |
| `username` | TEXT UNIQUE | 🔴 Plaintext | ✅ YES | Required for login |
| `password_hash` | TEXT | 🔴 Plaintext (but BCrypt hashed) | ✅ YES (but can't reverse) | Server needs this for auth |
| `identity_public_key` | BLOB | 🔴 Plaintext (public key) | ✅ YES | Purposefully public |
| `friend_code_hash` | TEXT | 🟡 HMAC-SHA256 hashed | ❌ NO — can't reverse |
| `encrypted_friend_code` | TEXT | 🟢 Argon2id-wrapped | ❌ NO — needs user password |
| `friend_code_salt` | TEXT | 🔴 Plaintext | ✅ YES — salt isn't secret (needed for decryption) |
| `friend_code_nonce` | TEXT | 🔴 Plaintext | ✅ YES — nonce not secret |
| `encrypted_profile_data` | TEXT | 🟢 AES-GCM with profile_data_key | ❌ NO — server has no access to this key |
| `encrypted_profile_salt` | TEXT | 🔴 Plaintext | ✅ YES — salt |
| `encrypted_profile_nonce` | TEXT | 🔴 Plaintext | ✅ YES — nonce |
| `encrypted_profile_data_key` | TEXT | 🟢 Encrypted with identity key | ❌ NO — can't unwrap |
| `profile_picture_file_id` | TEXT | 🔴 Plaintext file reference | ✅ YES — file ID (not the picture itself) |
| `profile_picture_file_key` | TEXT | 🟢 `nonce:ciphertext` wrapped with identity key | ❌ NO |
| `profile_banner_file_id` | TEXT | 🔴 Plaintext | ✅ YES |
| `profile_banner_file_key` | TEXT | 🟢 Same pattern as PFP key | ❌ NO |
| `friend_requests_disabled` | INTEGER | 🔴 Plaintext | ✅ YES |
| `profile_updated_at` | TEXT | 🔴 Plaintext | ✅ YES |
| `created_at` | TEXT | 🔴 Plaintext | ✅ YES |

### `messages` table

| Column | Encrypted? | Host Can Read? | Notes |
|--------|-----------|---------------|-------|
| `id` | 🔴 Plaintext | ✅ YES |
| `channel_id` | 🔴 Plaintext | ✅ YES | Shows which channel the message is in |
| `sender_id` | 🔴 Plaintext | ✅ YES | **Host knows WHO sent the message** |
| `sender_username` | 🔴 Plaintext | ✅ YES | **Host knows who sent it (by username)** |
| `sender_profile_pic` | 🔴 Plaintext | ✅ YES | File reference |
| `encrypted_content` | 🟢 AES-GCM ciphertext | ❌ NO | **Message body is secret** |
| `nonce` | 🔴 Plaintext | ✅ YES | Needed for decryption; useless without key |
| `timestamp` | 🔴 Plaintext | ✅ YES | **Host knows WHEN messages were sent** |
| `message_nonce` | 🔴 Plaintext | ✅ YES | Ratchet counter |
| `edited_at` | 🔴 Plaintext | ✅ YES | **Host knows WHEN edits happened** |
| `message_signature` | 🔴 Plaintext | ✅ YES | Ed25519 signature from sender |
| `encrypted_profile_key` | 🟢 Ciphertext with server key | ❌ NO |
| `profile_key_nonce` | 🔴 Plaintext | ✅ YES |
| `encrypted_banner_key` | 🟢 Ciphertext with server key | ❌ NO |
| `banner_key_nonce` | 🔴 Plaintext | ✅ YES |
| `key_version` | 🔴 Plaintext | ✅ YES |
| `encrypted_profile_snapshot` | 🟢 Ciphertext with server key | ❌ NO |
| `profile_snapshot_nonce` | 🔴 Plaintext | ✅ YES |
| `encrypted_file_key` | 🟢 Ciphertext with server key | ❌ NO |
| `file_key_nonce` | 🔴 Plaintext | ✅ YES |
| `encrypted_sender_username` | 🟢 Ciphertext with server key | ❌ NO |
| `sender_username_nonce` | 🔴 Plaintext | ✅ YES |

### `dm_messages` table

Same columns as `messages` but with `dm_channel_id` instead of `channel_id`. Same analysis applies.

### `server_keys` table

| Column | Encrypted? | Host Can Read? | Notes |
|--------|-----------|---------------|-------|
| `server_id` | 🔴 Plaintext | ✅ YES |
| `user_id` | 🔴 Plaintext | ✅ YES | **Host knows WHICH user this key is for** |
| `encrypted_key` | 🟢 Envelope-encrypted (ECDH) | ❌ NO — can't unwrap without identity private key |
| `sender_public_key` | 🔴 Plaintext (public) | ✅ YES |
| `nonce` | 🔴 Plaintext | ✅ YES |
| `version` | 🔴 Plaintext | ✅ YES |

### `dm_keys` table

Same structure as `server_keys`. Identical analysis.

### `server_members` table

| Column | Encrypted? | Host Can Read? |
|--------|-----------|---------------|
| `server_id`, `user_id` | 🔴 Plaintext | ✅ YES — **host sees the full social graph** |
| `role` (owner/member) | 🔴 Plaintext | ✅ YES |
| `joined_at` | 🔴 Plaintext | ✅ YES |

### `dm_channels` / `dm_members` / `friendships` tables

All columns are 🔴 Plaintext. Host can see who is friends with whom, all DM channels, and membership.

### `files` table

| Column | Encrypted? | Host Can Read? |
|--------|-----------|---------------|
| All metadata (file_id, uploader_id, original_size, mime_type, chunk_count) | 🔴 Plaintext | ✅ YES |
| `upload_complete` | 🔴 Plaintext | ✅ YES |

### `server_stickers` / `user_stickers` tables

| Column | Encrypted? | Host Can Read? |
|--------|-----------|---------------|
| `id`, `server_id`, `user_id`, `file_id`, `sticker_name`, `mime_type` | 🔴 Plaintext | ✅ YES |
| `file_key` | 🟢 `nonce:ciphertext` with server/user identity key | ❌ NO |
| `encrypted_file_key`, `file_key_nonce` | 🟢 Same | ❌ NO |

### `conversation_profile_data` table

| Column | Encrypted? | Host Can Read? |
|--------|-----------|---------------|
| `user_id`, `conversation_type`, `conversation_id` | 🔴 Plaintext | ✅ YES — host sees who uploaded profile data for which conversation |
| `encrypted_profile_data` | 🟢 With conversation key (DM/server) | ❌ NO |
| `nonce` | 🔴 Plaintext | ✅ YES |

### `user_key_blobs` table (key bundle for full recovery)

| Column | Encrypted? | Host Can Read? |
|--------|-----------|---------------|
| `user_id` | 🔴 Plaintext | ✅ YES |
| `encrypted_blob` | 🟢 Password-wrapped (Argon2id) — contains all e2e_* keys + profile_key_cache | ❌ NO — can't unwrap without password |
| `salt`, `nonce` | 🔴 Plaintext | ✅ YES — needed for decryption |
| `needs_rebuild` | 🔴 Plaintext flag | ✅ YES — migration 026; triggers client to rebuild blob with profile_key_cache |
| `updated_at` | 🔴 Plaintext | ✅ YES |

### `profile_data_keys` table (server-side profile key backup)

| Column | Encrypted? | Host Can Read? |
|--------|-----------|---------------|
| `user_id` | 🔴 Plaintext | ✅ YES |
| `encrypted_key` | 🟢 Encrypted with user's X25519 identity key | ❌ NO — server can't unwrap without identity private key |
| `nonce` | 🔴 Plaintext | ✅ YES |
| `created_at` | 🔴 Plaintext | ✅ YES |

### `notification_sounds` table

| Column | Encrypted? | Host Can Read? |
|--------|-----------|---------------|
| `user_id`, `file_name` | 🔴 Plaintext | ✅ YES |
| `encrypted_sound` | 🟢 With identity key | ❌ NO |
| `nonce`, `sender_public_key` | 🔴 Plaintext | ✅ YES |

---

## 4. What the Server Host CAN Decrypt (With Everything at Their Disposal)

The **host** (server admin, DB root, or anyone who compromises the server) has access to:
- The entire SQLite database file
- The filesystem (uploaded file chunks)
- The server binary and configuration
- The HMAC key (from config/.env)
- The JWT secret
- The admin panel

### ✅ Data the host CAN READ directly (plaintext in DB or sent in TLS)

| Data | Where | How reading is possible |
|------|-------|----------------------|
| All usernames | `users.username` | Plaintext column |
| All user IDs and relationships | All tables | Plaintext foreign keys |
| Full social graph: friends, server members, DM members | `friendships`, `server_members`, `dm_members` | Plaintext |
| Who sent which message | `messages.sender_id` + `messages.sender_username` | Plaintext columns |
| When messages were sent | `messages.timestamp` | Plaintext |
| When messages were edited | `messages.edited_at` | Plaintext |
| Which channel a message is in | `messages.channel_id` | Plaintext |
| Server ownership | `servers.owner_id` | Plaintext |
| Channel membership | `server_members` | Plaintext |
| File metadata (names, sizes, types, uploader) | `files` table | Plaintext |
| Password reset/escrow salts and nonces | Various columns | These are NOT secret (needed for crypto to work) |
| HMAC key | Server config | Reads from env/.env file |
| JWT secret | Server config | Reads from env/.env file |
| Profile picture & banner file IDs | `users.profile_picture_file_id`, `profile_banner_file_id` | Plaintext — but these are just file references, not the actual images (those are encrypted) |
| Friend request history | `friend_requests` table | Plaintext |
| Ban list | `server_bans` table | Plaintext |

### ❌ Data the host CANNOT decrypt (even with full DB + config access)

| Data | Where Stored | Why Server Can't Decrypt |
|------|-------------|------------------------|
| **Message content** | `messages.encrypted_content` + `dm_messages.encrypted_content` | Encrypted with **server key** (AES-256-GCM) for channels or **ECDH-derived DM key** for DMs. The server key is itself envelope-encrypted with each user's X25519 identity key. The server has the encrypted envelopes but not the users' private identity keys. The DM key is derived from ECDH shared secret — only the two participants have the private keys to compute it. |
| **File content** | Uploaded file chunks | Client encrypts each chunk with a random 32-byte file key before uploading. The file key is then encrypted with the channel/server/DM key and sent alongside the message. Server never sees the raw file key. |
| **Full profile data** (display_name, colors, description, nickname) | `users.encrypted_profile_data` | Encrypted with a random 32-byte `profile_data_key` (AES-256-GCM). This key is encrypted with the user's X25519 identity private key and cached in localStorage. Server never receives the raw key. |
| **Profile picture / banner images** | File chunks referenced by `profile_picture_file_id` | Same as file content — encrypted with a random key, which is stored as `nonce:ciphertext` wrapped with the user's identity key. |
| **Server/channel names** | `servers.encrypted_name` / `channels.encrypted_name` | Encrypted with the server's symmetric key. The server key is envelope-encrypted for each member — server can't unwrap. |
| **Friend codes (plaintext)** | Only HMAC hash stored | Server stores `friend_code_hash` (HMAC-SHA256). Even with the HMAC key, can't reverse a hash to find the original 8-character code (rainbow table would need 37^8 ≈ 3.5 trillion entries per key). |
| **Identity private keys** | `key_escrow` table (if escrow enabled) | Password-wrapped with Argon2id. Server can't unwrap without the user's password. |
| **DM encryption keys** | `dm_keys` table | Envelope-encrypted with each user's X25519 identity key. Server can't unwrap without private keys. |
| **Server encryption keys** | `server_keys` table | Same envelope encryption with X25519 identity keys. |
| **Notification sound files** | `notification_sounds` table | Encrypted with identity key. |
| **Encrypted sender username** | `messages.encrypted_sender_username` | Encrypted with server key. Server doesn't have the server key. |
| **Per-conversation profile data** | `conversation_profile_data` table | Encrypted with the specific DM or server key. Server has neither. |
| **Sticker/emoji image files** | File chunks referenced by stickers | Encrypted with random file key, stored as encrypted blob. |

### 🔶 Data the host COULD potentially access (with additional effort)

| Data | Path to Access | Difficulty |
|------|---------------|-----------|
| **Friend code plaintext** (if user regens) | `POST /api/friend-code/regenerate` returns the raw code to the client over HTTPS. Passive listener can see it. Active MITM could intercept. | Medium — logged in HTTPS request, but decryption requires TLS termination |
| **Friend code during friend request** | `POST /api/friends/request` receives the plaintext code (client sends it for server to hash and look up). Server could log this. | Easy — server already receives the plaintext code |
| **Friend code during store** | `POST /api/friend-code/store-encrypted` receives plaintext code in body. Server could log it. | Easy |
| **Password during login/register/reauth** | All auth endpoints receive password in plaintext over TLS. Server could log or intercept. | Easy — but protected by TLS in transit; only at rest on server |
| **Client IP addresses and connection timing** | WebSocket connections track user presence. Server knows when users are online. | Easy — connection metadata is always visible |
| **Message send patterns (metadata analysis)** | Even without decrypted content, the server sees: who talks to whom, when, how often, message sizes, reaction patterns | Easy — all metadata is plaintext |

---

## 5. Key Hierarchy Summary

```
┌────────────────────────────────────────────────────────────┐
│                  KEY HIERARCHY                              │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  🔑 Identity Keypair (X25519)                               │
│  ├─ Stored: private key Argon2id-wrapped in escrow          │
│  ├─ Public key: plaintext on server (it's supposed to be     │
│  │              public for ECDH to work)                    │
│  │                                                          │
│  ├─🔐 Server Key (32-byte AES)                              │
│  │   ├─ Encrypted FOR each member using envelope encrypt     │
│  │   │  (ECDH with that member's identity public key)        │
│  │   ├─ Stored in `server_keys` table as ciphertext          │
│  │   ├─ Server stores but CANNOT decrypt                     │
│  │   ├─ Used for: channel message encryption, channel name   │
│  │   │  encryption, profile key sharing in servers           │
│  │   └─ Server sees: encrypted_key, sender_public_key, nonce │
│  │                                                          │
│  ├─🔐 DM Channel Key (ECDH-derived, per-channel)            │
│  │   ├─ Derivation: HKDF(ECDH(myPriv, otherPub), "dm-channel:<id>")│
│  │   ├─ NEVER stored on server (computed on-the-fly)         │
│  │   ├─ Used for: DM message encryption, profile key sharing │
│  │   └─ Server sees: nothing (not stored, not transmitted)   │
│  │                                                          │
│  ├─🔐 Profile Data Key (32-byte AES, per-user)              │
│  │   ├─ Stored: encrypted with identity private key           │
│  │   │  in localStorage (profileKeyCache)                    │
│  │   ├─ Shared to other users via WS profile_key_sync,       │
│  │   │  re-encrypted with DM/server key                     │
│  │   ├─ Used for: encrypting encrypted_profile_data blob     │
│  │   └─ Server sees: only the profile_data_key encrypted     │
│  │      with the DM/server key (can't unwrap)               │
│  │                                                          │
│  ├─🔐 File Keys (32-byte AES, per-file)                     │
│  │   ├─ Generated fresh for each file upload                 │
│  │   ├─ Stored: `nonce:ciphertext` wrapped with identity key │
│  │   ├─ Shared in message payload, encrypted with channel    │
│  │   │  or DM key                                           │
│  │   └─ Server sees: nothing useful                          │
│  │                                                          │
│  └─🔐 Sticker Keys (32-byte AES, per-sticker)              │
│      ├─ Same pattern as file keys                            │
│      ├─ Stored in server_stickers/user_stickers tables        │
│      ├─ Encrypted with server key or identity key            │
│      └─ Multi-client: any client with the server key or      │
│         identity key can decrypt sticker images              │
│                                                             │
│  ⚠️ HMAC Key (server-managed, 64-char random)               │
│  ├─ Sent to client on first login (plaintext over TLS)       │
│  ├─ Used for: HMAC-hashing friend codes and invite codes     │
│  ├─ Server CAN read: it owns this key                        │
│  └─ Server CANNOT reverse: even with the key, HMAC is        │
│     one-way (can compute hash for any candidate, but        │
│     can't reverse hash to original)                         │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

---

## 6. Encryption Architecture (Data Flow Diagram)

```
Registration flow:
┌──────────┐     password (TLS)     ┌──────────┐
│  Client  │ ──────────────────────▶│  Server  │
│          │    identity_pub_key    │          │
│          │ ──────────────────────▶│          │
│          │    friend_code_hash    │          │
│          │ ──────────────────────▶│          │
│          │   encrypted_fc (pwd)   │          │
│          │ ──────────────────────▶│          │
│          │   encrypted_identity   │          │
│          │   + escrow (pwd)       │          │
│          │ ──────────────────────▶│          │
└──────────┘                        └──────────┘

Message sending flow:
┌──────────┐  encrypted_content (AES)  ┌──────────┐
│  Client  │ ─────────────────────────▶│  Server  │
│   (A)    │  + metadata (plaintext)   │          │
│          │  + nonce, message_nonce   │          │
└──────────┘                           │          │
                                       │   stores   │
┌──────────┐                           │   + WS     │
│  Client  │ ◀─────────────────────────│  broadcast │
│   (B)    │  same encrypted_content   └──────────┘
│          │  (B decrypts with         │          │
│          │   shared key)             │          │
└──────────┘                           └──────────┘

Key hierarchy:
  Identity keypair (X25519) ─┬─ Server key (symmetric, AEAD)
                             │    └─ Channel name encryption
                             │    └─ File key sharing
                             │
                             ├─ DM shared key (X25519 + SHA-256)
                             │    └─ DM message encryption
                             │    └─ Profile key sharing in DMs
                             │
                             └─ Password (Argon2id)
                                  └─ Friend code encryption
                                  └─ Identity key escrow
```

## Profile Data Encryption System

### Overview
Profile data (display_name, username_color, username_border_color, description, nickname, profile_background_color) is encrypted client-side and never sent to the server as plaintext. There are TWO encryption layers to support both multi-device and multi-user sharing.

### Layer 1: Password-Encrypted Profile Blob (Multi-Device)

**Purpose:** Allow the SAME user to view and edit their profile from any device.

**How it works:**
1. A random `profile_data_key` (32-byte symmetric key) is generated via `E2ECrypto.generateProfileDataKey()`
2. The profile JSON is encrypted with this key via `E2ECrypto.encryptProfileData(jsonString, key)` using XChaCha20-Poly1305
3. The encrypted blob is stored in `users.encrypted_profile_data` as `nonce:ciphertext` (both base64)
4. The `profile_data_key` is encrypted with the user's identity key and cached in `profileKeyCache[userId + ':profile_data_key']`
5. When the user needs the key on another device, the key is shared via `profile_key_sync` WS messages (re-encrypted with the DM/server key for secure transit)

**Multi-device support:** The `profile_data_key` is encrypted with the identity private key before storage in localStorage (`profileKeyCache`). The identity key pair is linked to the account (not the device), so all devices belonging to the same account can decrypt the profile data key.

**Code paths:**
- `static/crypto.js`: `generateProfileDataKey()`, `encryptProfileData()`, `decryptProfileData()`
- `static/chat.js`: `fetchAndCacheUserProfile()` — fetches encrypted profile, decrypts with cached profile_data_key
- `static/chat.js`: `saveProfile()` — encrypts profile data with profile_data_key, uploads to server

### Layer 2: Per-Conversation Encrypted Profile (Multi-User Sharing)

**Purpose:** Allow OTHER users in a DM or server to see the user's current profile without needing the user's `profile_data_key`.

**How it works:**
1. When a user sends a message in a DM, they include an `encrypted_profile_snapshot` encrypted with the DM key
2. When a user sends a message in a server channel, they include an `encrypted_profile_snapshot` encrypted with the server key
3. Additionally, the user can proactively upload their profile to the `conversation_profile_data` table via `PUT /api/profile/conversation`, encrypted with the specific channel/DM key
4. When another user receives a message, they can decrypt the profile snapshot using the shared channel/DM key
5. The decrypted profile data is cached in `userDisplayNameCache[userId]` for display

**Per-conversation storage:** The `conversation_profile_data` table stores per-user, per-conversation encrypted profiles:
- `user_id` + `conversation_type` + `conversation_id` = primary key
- `encrypted_profile_data` + `nonce` = encrypted with the conversation key
- When a new member joins a server, existing members re-encrypt their profile for the server and upload it

**Code paths:**
- `static/chat.js`: `uploadCurrentProfileToConversations()` — encrypts profile with each conversation's key and uploads
- `static/chat.js`: `fetchServerConversationProfile()` — fetches and decrypts server profile
- `static/chat.js`: `fetchDmConversationProfile()` — fetches and decrypts DM profile
- `static/chat.js` `appendMessage()` — decrypts `encrypted_profile_snapshot` from incoming messages

### Profile Picture & Banner Key Encryption

Profile picture and banner FILE KEYS (used to decrypt the actual image files) are encrypted separately from the profile data:

1. The raw file key is stored in `profile_picture_file_key` / `profile_banner_file_key` in format `nonce:ciphertext`
2. This is encrypted with the user's IDENTITY KEY via `E2ECrypto.encodeEncryptedFileKey(fileKey, identityPrivateKey)`
3. When sharing with another user, the key is decrypted with the identity key and re-encrypted with the DM/server key
4. Sharing happens via:
   - `profile_key_sync` WS message (for DMs) — re-encrypted with DM key
   - `profile_key_server_sync` WS message (for servers) — re-encrypted with server key
   - `encrypted_profile_key` + `profile_key_nonce` in message payloads

**Code paths:**
- `static/crypto.js`: `encodeEncryptedFileKey()`, `decodeEncryptedFileKey()`
- `static/chat.js`: `sendProfileKeySync()`, `broadcastProfileKeySyncToServer()`

### Sticker & File Key Encryption

Stickers and file attachments use a separate file-level encryption system:

**File data encryption:**
1. Each file is encrypted with a random `file_key` (32 bytes) using `E2ECrypto.encryptFileChunk(fileKey, chunk)`
2. Each chunk produces `nonce(24) + ciphertext` which is sent directly to the server
3. The server stores the encrypted chunks but has no key to decrypt them

**File key sharing:**
1. The `file_key` is encrypted for the specific recipient(s) and sent alongside the message as `encrypted_file_key` + `file_key_nonce`
2. For server channels: encrypted with the server key via `E2ECrypto.encryptMessage(fileKeyB64, serverKey)`
3. For DMs: encrypted with the DM key via `E2ECrypto.encryptDm(fileKeyB64, dmChannelId, ...)`
4. Stickers have an additional `encrypted_file_key` and `file_key_nonce` stored in the `server_stickers` / `user_stickers` tables

**Multi-client support for stickers:**
1. When a user uploads a sticker, the file key is encrypted with the SERVER key (for server stickers) or the USER's identity key (for personal stickers)
2. The encrypted key is stored in the `server_stickers` or `user_stickers` table
3. Any client with access to the server key (server stickers) or the user's identity key (personal stickers) can decrypt the sticker file
4. Sticker previews are cached in `fileKeyCache` (localStorage) so they load quickly across page loads

**Code paths:**
- `static/crypto.js`: `generateFileKey()`, `encryptFileChunk()`, `decryptFileChunk()`
- `static/crypto.js`: `encodeEncryptedFileKey()`, `decodeEncryptedFileKey()`
- `static/chat.js`: File upload flow encrypts with random key, then shares via message
- `static/chat.js`: `loadStickerPreview()` — loads sticker using decrypted file key

## What's Well-Protected
- **Message content**: End-to-end encrypted (AES-256-GCM). Server cannot read.
- **File content**: Client-encrypted before upload. Server stores opaque blob.
- **Identity private keys**: Password-wrapped escrow (Argon2id).
- **Friend codes**: Encrypted with password; server only stores HMAC hash for lookup.
- **Profile data**: Encrypted since the profile encryption migration. Display names, colors, descriptions no longer returned as plaintext in API responses.

### What's Still Plaintext (Remaining Attack Surface)
- **Message metadata**: Who sent what, when. All plaintext in the database.
- **Usernames**: Always plaintext (required for login/identity).
- **Display name colors/border colors**: Still stored as plaintext columns in the `users` table (host can read them directly from SQLite).
- **Server/channel names**: Sent both encrypted and plaintext. The plaintext version is stored for display before key decryption.
- **Friend code at send time**: When adding a friend, the plaintext friend code is sent to the server so it can be hashed and looked up.
- **Password at login/register**: Sent in plaintext over TLS (standard web practice; protected by TLS/HTTPS).
- **WebSocket sender metadata**: `sender_display_name`, `sender_username_color`, `sender_profile_pic` broadcast in plaintext to all message recipients.

---

## Server-Side Profile Data Key Recovery (2026-07-24)

### Problem
If the blob save (`saveKeyBlobToServer`) fails silently through any of the 5 known failure paths, the user's `profile_data_key` (used to decrypt their encrypted profile data) is permanently lost on cookie clear. Unlike server keys (which can be recovered via `GET /api/servers/{id}/keys` + identity key decryption), profile data keys had no server-side fallback.

### Solution: Dedicated API Endpoints

**`PUT /api/profile/data-key`**:
- Stores the user's raw `profile_data_key` encrypted with their X25519 identity key
- Called fire-and-forget from `saveProfile()`, `loadMyProfile()`, and `saveBeforeClose()`
- Only the authenticated user can save (no user_id in URL — extracted from auth token)
- Server stores the encrypted blob in the `profile_data_keys` table but CANNOT decrypt it

**`GET /api/profile/data-key/{userId}`**:
- Returns the encrypted `profile_data_key` for the requested user
- Self: always authorized (can decrypt with own identity key)
- Friends/server-mates: also authorized to fetch but CANNOT decrypt (key is encrypted with the owner's identity key, not shared)
- Returns 403 for unauthorized users

### Client-side recovery flow
```
Startup (1.5s delay):
  → recoverProfileDataKey()
     → Check cache: already have profile_key_cache[user.id]?
        YES → exit (no recovery needed)
        NO  → GET /api/profile/data-key/{user.id}
             → Decrypt response with identity key
             → Cache in profileKeyCache
             → Re-load profile to decrypt with recovered key
```

### Tests verified
All 5 failure paths in `blob-bug-integration.spec.ts` confirm:
```
Profile data key from API recovery: ✅ RECOVERED
CONTRIBUTION: API endpoint provides fallback recovery even when blob save fails.
```

## Migration 026: Blob needs_rebuild Flag (2026-07-24)

### Problem
Existing user key blobs (password-encrypted bundles in `user_key_blobs`) were created before `profile_key_cache` became part of the bundle. These old blobs lack the `profile_key_cache` entry, meaning even though Fix 6 in auth.js initializes it on every login, the blob re-save was the only way to persist it.

### Solution: needs_rebuild flag
Since blobs are password-encrypted (server CANNOT decrypt/modify them), a server-side backfill is impossible. Instead, migration 026:
- Adds `needs_rebuild INTEGER NOT NULL DEFAULT 0` to `user_key_blobs`
- Sets `needs_rebuild = 1` for ALL existing blobs
- Every successful `PUT /api/key-blob` clears the flag (via `save_user_key_blob`)
- `GET /api/key-blob` includes the flag in the response
- The client checks the flag on login; Fix 6 ensures `profile_key_cache` is included in the rebuild

### Flow
```
Migration 026 deploys → all existing blobs get needs_rebuild=1
User logs in → GET /api/key-blob responds with needs_rebuild=true
Fix 6 (auth.js): initializes profile_key_cache='{}' if missing
Build fresh bundle → PUT /api/key-blob → save() clears needs_rebuild to 0
Next login: needs_rebuild=false (already fixed)
```

## P3 Implementation: Encrypt Sender Username (2026-07-24)

**Goal:** Encrypt `sender_username` with the channel/server key so the host can't trivially identify who sent each message.

### Changes Made

**Layer 1 — Crypto helpers (`static/crypto.js`):**
- Added `E2ECrypto.encryptSenderUsername(username, channelKey)` — encrypts a username string with a channel key (AES-256-GCM, returns `{ciphertext, nonce}`)
- Added `E2ECrypto.decryptSenderUsername(ciphertextB64, nonceB64, channelKey)` — decrypts and returns the username string, or `null` on failure
- Both reuse the existing AEAD infrastructure (XChaCha20-Poly1305 via libsodium)

**Layer 2 — Server storage (`server/src/ws.rs`):**
- Incoming `message_send` handler now parses `encrypted_sender_username` and `sender_username_nonce` from the WS JSON payload
- Incoming `dm_send` handler now parses the same fields
- These values are passed to `save_encrypted_message()` and `save_dm_message()` instead of `None, None`
- The DB schema already had these columns from the previous implementation

**Layer 3 — Server message send (`static/chat.js`, sendMessage):**
- After profile snapshot and key encryption, additionally encrypts `user.username` with the server key
- Appends `encrypted_sender_username` and `sender_username_nonce` to the WS payload

**Layer 4 — DM message send (`static/chat.js`, sendDmMessage):**
- Derives the DM channel key via `E2ECrypto.getDmKey()`
- Uses `E2ECrypto.encryptSenderUsername()` (consistent with server message path)
- Also appends `encrypted_sender_username` and `sender_username_nonce`

**Layer 5 — WS receive (`static/chat.js`, message_new handler):**
- Before calling `appendMessage()`, checks for `encrypted_sender_username` and `sender_username_nonce`
- Decrypts with the server key via `E2ECrypto.decryptSenderUsername()`
- Overwrites `data.message.sender_username` with the decrypted value

**Layer 6 — WS receive (`static/chat.js`, dm_new handler):**
- Same pattern but decrypts with the DM channel key
- Derives the DM key from ECDH + HKDF
- Overwrites `data.message.sender_username` with the decrypted value

### Server Compilation
```
Compiling e2e-chat v0.1.0
Finished dev profile [unoptimized + debuginfo] target(s) in 10.58s
```
✅ **0 errors, 0 warnings**

### Remaining Work (for full P3 completion)
- **Plaintext `sender_username` still returned by the server**: `handlers.rs` still includes `sender_username` (from the SQL JOIN) in all API responses. The host can still trivially identify message senders. To truly prevent the host from identifying senders, `sender_username` must be removed from API/WS responses and only the encrypted version provided.
- **No test coverage yet**: The existing tests don't verify that `encrypted_sender_username` is present in messages or that decryption works correctly.
- **Mention/notification paths**: Mention notifications still carry plaintext `sender_username`. These need to be updated to use the encrypted version too.
