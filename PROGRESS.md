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

## Complete Data Flow Analysis: Encrypted vs Plaintext

### Legend
- 🔒 **Encrypted** — data is encrypted before transmission; server never sees plaintext
- 🔑 **Key-encrypted** — data encrypted with a symmetric/asymmetric key, but the key may be shared
- 📄 **Plaintext** — data sent/received as-is, server can read it
- 🔐 **Hashed** — data is hashed (one-way); server can verify but not reverse
- 🔶 **Conditional** — encrypted in some contexts, plaintext in others

---

## API Endpoints — Request/Response Analysis

### Authentication & Account

| Endpoint | Outgoing from client | Incoming to client | Analysis |
|----------|--------------------|--------------------|----------|
| `POST /api/register` | 📄 `username`, `password`; 🔑 `identity_public_key`, `encrypted_friend_code` + `salt` + `nonce`, `encrypted_identity_priv` + `escrow_salt` + `escrow_nonce` | 📄 token, user id/username | Password sent in plaintext over TLS. Identity private key is Argon2id-wrapped with password before sending. Friend code is encrypted client-side with password. |
| `POST /api/login` | 📄 `username`, `password` | 📄 token, user id/username | Password in plaintext over TLS. |
| `POST /api/reauth` | 📄 `password` | 📄 new token | Password re-verified server-side. |
| `DELETE /api/me` | — (just auth) | 📄 ok/error | Deletes user and all associated data. |
| `GET /api/me` | — | 📄 `id`, `username` | Minimal profile info. |

### Profile

| Endpoint | Outgoing from client | Incoming to client | Analysis |
|----------|--------------------|--------------------|----------|
| `GET /api/profile/{userId}` | — | 📄 `id`, `username`, `profile_picture_file_id`, `profile_banner_file_id`; 🔒 `encrypted_profile_data` + `salt` + `nonce`; 🔶 `profile_picture_file_key`, `profile_banner_file_key` (friends/server-mates only) | All profile metadata (display_name, username_color, border_color, description, nickname) is **only** inside `encrypted_profile_data`. The API no longer returns plaintext display_name, username_color, etc. File decryption keys are only shared with friends/server-mates. **However**: the host (server admin) can see the `users` table which still stores `display_name`, `username_color`, etc. in plaintext columns. |
| `PATCH /api/profile` | 🔒 `encrypted_profile_data` + `salt` + `nonce`; 📄 profile picture file changes | 📄 ok/error | Profile data encrypted client-side before upload. |
| `PUT /api/profile/conversation` | 🔒 `encrypted_profile_data` + `nonce` per conversation (DM/server) | 📄 ok/error | Per-conversation profile data encrypted with channel key. |
| `GET /api/profile/{userId}/conversation/{type}/{id}` | — | 🔒 `encrypted_profile_data` + `nonce` | Server returns stored encrypted blob; decrypted client-side with channel key. |

### Friend Codes

| Endpoint | Outgoing from client | Incoming to client | Analysis |
|----------|--------------------|--------------------|----------|
| `GET /api/friend-code` | — | 🔒 `encrypted_friend_code` + `salt` + `nonce` | Encrypted with user's password (Argon2id). Server never sees plaintext friend code. |
| `POST /api/friend-code/store-encrypted` | 📄 `friend_code` (plaintext for hashing), 🔒 `encrypted_friend_code` + `salt` + `nonce` | 📄 ok/error | Friend code sent in plaintext so server can HMAC-hash it for lookup. The `encrypted_friend_code` is the password-encrypted copy. **⚠️ Friend code plaintext sent to server** for hash computation (needed for lookup by friend_code_hash). |
| `POST /api/friend-code/regen-with-password` | 📄 `password`, 📄 `friend_code` (plaintext), 🔒 encrypted version | 📄 ok/error | Server verifies password, hashes the plaintext code, stores encrypted. **⚠️ Plaintext friend code + password sent to server.** |
| `GET /api/hmac-key` | — | 📄 `hmac_key` (plaintext) | HMAC key sent to client as plaintext for client-side hashing. |

### Friends & DM Conversations

| Endpoint | Outgoing from client | Incoming to client | Analysis |
|----------|--------------------|--------------------|----------|
| `POST /api/friends/request` | 📄 `friend_code` (plaintext) | 📄 ok + target user info | **⚠️ Plaintext friend code sent to server.** Server re-hashes it (HMAC then SHA-256 fallback) to look up the user. |
| `POST /api/friends/requests/accept` | 📄 `request_id` | 📄 ok | Simple status change. |
| `GET /api/friends/requests/incoming` | — | 📄 list of `{id, from_user_id, from_username, status, created_at}` | All plaintext sender info. |
| `GET /api/friends` | — | 📄 list of friend `{id, username}` | All plaintext. |
| `GET /api/dm/conversations` | — | 📄 `dm_channel_id`, `other_user_id`, `other_username`, `other_display_name`, `other_profile_picture_file_id`, `other_public_key`; 🔒 `last_message.encrypted_content` + `nonce` + `message_nonce` | DM metadata is plaintext. Message content is end-to-end encrypted (server cannot read it). |

### Server Messages

| Endpoint | Outgoing from client | Incoming to client | Analysis |
|----------|--------------------|--------------------|----------|
| `GET /api/channels/{id}/messages` | — | 📄 `sender_id`, `sender_username`, `sender_display_name`, `sender_profile_pic`, `sender_username_color`, `sender_username_border_color`, `timestamp`; 🔒 `encrypted_content` + `nonce` + `message_nonce`; 🔒 `encrypted_profile_key`, `encrypted_banner_key`, `encrypted_file_key` + nonces; 🔒 `conversation_profile.encrypted_profile_data` | **⚠️ Message metadata is all plaintext** (sender_display_name, sender_username_color, etc.). Only the actual message content is encrypted end-to-end. Server could see who sent what and when. |
| WebSocket `message_send` | 📄 channel_id; 🔒 encrypted_content + nonce + message_nonce; 🔒 optional profile/banner/file keys | 📄 same + id, sender metadata as plaintext | The real-time broadcast also carries sender metadata in plaintext. Message body is always encrypted. |

### DM Messages (WebSocket)

| WS Message Type | Outgoing from client | Incoming to client | Analysis |
|-----------------|--------------------|--------------------|----------|
| `dm_send` | 📄 dm_channel_id; 🔒 encrypted_content + nonce + message_nonce; 🔒 optional keys | 📄 same + sender metadata | End-to-end encrypted content; sender profile metadata is plaintext. |
| `profile_key_sync` | 📄 dm_channel_id; 🔒 encrypted_profile_key + nonces | 📄 same + user_id | File encryption keys shared via DM encryption (re-encrypted with DM key). |
| `profile_key_server_sync` | 📄 server_id; 🔒 encrypted_profile_key + nonce | 📄 same + user_id | File keys shared across server, encrypted with server symmetric key. |
| `message_edit` / `dm_edit` | 📄 message_id; 🔒 new encrypted_content + new nonce | 📄 same as message_send | Edited content is re-encrypted. |
| `friend_request_accepted` | — | 📄 `by_user_id`, `from_user_id` (plaintext IDs) | Server broadcasts user IDs to notify both parties. |
| `member_joined` | — | 📄 `server_id`, `user_id` (plaintext) | New member ID broadcast to server members. |

### Server & Channel Data

| Endpoint | Outgoing from client | Incoming to client | Analysis |
|----------|--------------------|--------------------|----------|
| `POST /api/servers` | 📄 `name` (plaintext), 🔒 `encrypted_name` + `name_nonce`; 📄 `invite_code_hash` | 📄 `id`, `name` | Server name is sent both encrypted and plaintext. The plaintext name is used for display before the key is available. |
| `GET /api/servers` | — | 📄 `id`, `name`; 🔒 `encrypted_name` + `name_nonce` | Same dual approach. |
| `POST /api/servers/{id}/channels` | 📄 `name` (plaintext); 🔒 `encrypted_name` + `name_nonce` | 📄 `id`, `name` | Channel names follow same pattern as server names. |
| `GET /api/servers/{id}/keys` | — | 🔒 encrypted_key + sender_public_key + nonce | Server keys are envelope-encrypted (identity key-based). Server stores but cannot decrypt them. |
| `POST /api/servers/{id}/keys` | 📄 target user_id; 🔒 encrypted_key + sender_public_key + nonce | 📄 ok/error | Owner uploads key encrypted for each member. |

### File Sharing

| Endpoint | Outgoing from client | Incoming to client | Analysis |
|----------|--------------------|--------------------|----------|
| `POST /api/files/init` | 📄 `file_name`, `mime_type`, `file_size` | 📄 `file_id`, upload URLs | File metadata is plaintext. |
| `POST /api/files/{id}/chunk/{index}` | 📄 binary chunk (file data encrypted client-side before upload) | 📄 ok/error | **⚠️ File data is NOT encrypted by the server** — encryption is the client's responsibility. The client encrypts files with a random symmetric key, which is then encrypted for recipients with their public key or the channel key. The server stores the encrypted blob but has no way to decrypt it (the key is never sent to the server). |

### Server Identity Keys

| Endpoint | Outgoing from client | Incoming to client | Analysis |
|----------|--------------------|--------------------|----------|
| `GET /api/identity/{userId}` | — | 📄 identity_public_key (plaintext) | Public keys are plaintext by nature. |

---

## WebSocket Messages — Detailed Plaintext Fields

These are the fields broadcast in **plaintext** over WebSocket (server can see, any WS-connected user in the target audience can see):

| Context | Plaintext fields broadcast |
|---------|--------------------------|
| **Channel message** (`message_new`) | `channel_id`, `server_id`, `sender_id`, `sender_username`, `sender_display_name`, `sender_profile_pic`, `sender_username_color`, `sender_username_border_color`, `timestamp`, `edited_at` |
| **DM message** (`dm_new`) | `dm_channel_id`, `sender_id`, `sender_username`, `sender_display_name`, `sender_profile_pic`, `sender_username_color`, `sender_username_border_color`, `timestamp` |
| **Friend request** (`friend_request_received`) | `from_user_id`, `from_username` |
| **Friend request accepted** (`friend_request_accepted`) | `by_user_id`, `from_user_id` |
| **Member joined** (`member_joined`) | `server_id`, `user_id` |
| **Member kicked/banned/left** | `server_id`, `user_id` |
| **Key rotation** (`server_key_rotated`) | `server_id` |

---

## Database Schema — What's Stored in Plaintext

The server database stores these fields where the **host can read them directly**:

| Table | Plaintext columns (host-readable) | Encrypted columns |
|-------|-----------------------------------|-------------------|
| `users` | `id`, `username`, `password_hash`, `display_name`, `username_color`, `username_border_color`, `profile_background_color`, `profile_picture_file_id`, `profile_banner_file_id`, `friend_code_hash`, `created_at`, `friend_requests_disabled` | `encrypted_profile_data`, `encrypted_profile_salt`, `encrypted_profile_nonce`, `encrypted_friend_code`, `friend_code_salt`, `friend_code_nonce`, `profile_picture_file_key`, `profile_banner_file_key` |
| `messages` | `id`, `channel_id`, `sender_id`, `sender_username`, `sender_display_name`, `sender_profile_pic`, `sender_username_color`, `sender_username_border_color`, `timestamp`, `edited_at` | `encrypted_content`, `nonce`, `message_nonce`, `encrypted_file_key`, `file_key_nonce`, `encrypted_profile_snapshot` |
| `dm_messages` | Same as messages (no channel_id, has dm_channel_id) | Same as messages |
| `server_keys` | `server_id`, `user_id`, `sender_public_key`, `version` | `encrypted_key`, `nonce` |
| `server_members` | `server_id`, `user_id`, `role`, `joined_at` | — (all plaintext) |
| `dm_channels` | `id`, `created_at` | — |
| `dm_members` | `dm_channel_id`, `user_id` | — |

---

## What the Host/Server Admin Can Discover

| Data the host can see | How |
|-----------------------|-----|
| ✅ Usernames of all users | Plaintext in `users` table |
| ✅ Display names, colors, descriptions | Plaintext in `users` table (columns exist but no longer returned via API) |
| ✅ Who is friends with whom | `friendships` table |
| ✅ Who is in which server | `server_members` table |
| ✅ Message timestamps, who sent what | `messages` table (all metadata is plaintext) |
| ✅ File names and types uploaded | `files` table |
| ✅ Invite codes (hashed) | `servers.invite_code_hash` — but these are HMAC-hashed |
| ❌ Message content | `encrypted_content` — encrypted end-to-end; server has no key |
| ❌ File content | Files encrypted client-side; key never sent to server |
| ❌ Profile data (since migration) | Stored in `encrypted_profile_data` — only readable with the encryption key |
| ❌ Friend codes (plaintext) | Only encrypted copy stored; server has HMAC hash for lookup |
| ❌ Identity private keys | Password-wrapped (Argon2id) escrow; server cannot unwrap |
| ❌ DM channel encryption keys | Stored encrypted with identity key; server cannot decrypt |

---

## Summary: Encryption Architecture

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

### What's Well-Protected
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
test
