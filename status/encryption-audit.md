# E2E Talk — Encryption Coverage Map (Full Audit)

**Date:** 2026-07-23
**Scope:** Every API endpoint, WebSocket message, DB column, and client send path

---

## LEGEND

| Symbol | Meaning |
|--------|---------|
| 🟢 **Encrypted** | Data is ciphertext; server cannot read |
| 🟡 **Hashed** | One-way hash; server cannot reverse |
| 🔵 **Reference** | Opaque identifier, not the data itself |
| 🔴 **Plaintext** | Human-readable; server can read directly |
| ⚪ **Metadata** | Routing/structuring data, not content |

---

## 1. DATABASE SCHEMA — Column-by-Column Audit

### `users` table

| Column | Status | Notes |
|--------|--------|-------|
| `id` | ⚪ UUID | Opaque identifier |
| `username` | 🔴 Plaintext | Required for login - host can see all usernames |
| `password_hash` | 🟡 Argon2id hash | Can't reverse, but host can brute-force weak passwords |
| `identity_public_key` | 🟢 Public key only | Public by design (needed for ECDH key exchange) |
| `encrypted_profile_data` | 🟢 AES-256-GCM | Contains display_name, username_color, border_color, description, nickname, bg_color |
| `encrypted_profile_salt` | ⚪ Salt | Needed for profile decryption key derivation |
| `encrypted_profile_nonce` | ⚪ Nonce | AES-GCM IV for profile decryption |
| `profile_picture_file_id` | 🔵 File ref | Points to files table, not the picture itself |
| `profile_picture_file_key` | 🟢 Encrypted | Encrypted with identity key (AES-256-GCM envelope) |
| `profile_banner_file_id` | 🔵 File ref | Same as picture file_id |
| `profile_banner_file_key` | 🟢 Encrypted | Encrypted with identity key |
| `friend_code_hash` | 🟡 SHA-256 | Host can't reverse to get the friend code |
| `encrypted_friend_code` | 🟢 AES-256-GCM | Password-encrypted friend code for recovery |
| `friend_code_salt` | ⚪ Salt | For friend code key derivation |
| `friend_code_nonce` | ⚪ Nonce | AES-GCM IV for friend code encryption |
| `profile_updated_at` | ⚪ Timestamp | Cache invalidation metadata |
| `friend_requests_disabled` | 🔴 Plaintext | Boolean setting |
| `friend_code` | 🔴 Plaintext | **⚠️ Legacy column — still present on older DBs** |

### `servers` table

| Column | Status | Notes |
|--------|--------|-------|
| `id` | ⚪ UUID | Identifier |
| `encrypted_name` | 🟢 AES-256-GCM | Encrypted server name |
| `name_nonce` | ⚪ Nonce | AES-GCM IV |
| `owner_id` | 🔴 Plaintext | Host can see who owns each server |
| `invite_code_hash` | 🟡 SHA-256/HMAC | Can't reverse to get invite code |
| `joins_disabled` | 🔴 Plaintext | Boolean setting |

### `channels` table

| Column | Status | Notes |
|--------|--------|-------|
| `id` | ⚪ UUID | Identifier |
| `server_id` | 🔴 Plaintext | Host can see channel-server mapping |
| `encrypted_name` | 🟢 AES-256-GCM | Encrypted channel name |
| `name_nonce` | ⚪ Nonce | AES-GCM IV |
| `type` | 🔴 Plaintext | Channel type (text/voice) |
| `position` | 🔴 Plaintext | Sort order |

### `messages` table

| Column | Status | Notes |
|--------|--------|-------|
| `id` | ⚪ UUID | Identifier |
| `channel_id` | 🔴 Plaintext | **⚠️ Reveals communication patterns** |
| `sender_id` | 🔴 Plaintext | **⚠️ Reveals who talks to whom** |
| `encrypted_content` | 🟢 AES-256-GCM | Message body — fully encrypted |
| `nonce` | ⚪ Nonce | AES-GCM IV |
| `timestamp` | 🔴 Plaintext | **⚠️ Reveals when communication happens** |
| `message_nonce` | ⚪ Nonce | KDF ratchet counter |
| `message_signature` | 🟢 Ed25519 sig | Per-message signing |
| `edited_at` | 🔴 Plaintext | When message was edited |
| `encrypted_profile_key` | 🟢 Encrypted | Profile picture key (per-message) |
| `profile_key_nonce` | ⚪ Nonce | For profile key decryption |
| `encrypted_banner_key` | 🟢 Encrypted | Banner key (per-message) |
| `banner_key_nonce` | ⚪ Nonce | For banner key decryption |
| `encrypted_profile_snapshot` | 🟢 Encrypted | Full profile snapshot in message |
| `encrypted_file_key` | 🟢 Encrypted | Attached file key |
| `file_key_nonce` | ⚪ Nonce | For file key decryption |
| `key_version` | 🔴 Plaintext | Key rotation version |

### `dm_messages` table — same encryption coverage as `messages`

### `dm_channels` table

| Column | Status | Notes |
|--------|--------|-------|
| `id` | ⚪ UUID | Identifier |
| `user1_id` | 🔴 Plaintext | Host sees all DM pairs |
| `user2_id` | 🔴 Plaintext | Host sees all DM pairs |
| `created_at` | 🔴 Plaintext | Timestamp metadata |

### `server_keys` table

| Column | Status | Notes |
|--------|--------|-------|
| `encrypted_key` | 🟢 Envelope | E2EE server key, envelope-encrypted per member |
| `sender_public_key` | 🟢 Public key | Ephemeral key for envelope decryption |
| `nonce` | ⚪ Nonce | AES-GCM IV |

### `dm_keys` table

| Column | Status | Notes |
|--------|--------|-------|
| `encrypted_key` | 🟢 Envelope | DM shared key, envelope-encrypted |
| `sender_public_key` | 🟢 Public key | Ephemeral key |
| `nonce` | ⚪ Nonce | AES-GCM IV |

### `conversation_profile_data` table

| Column | Status | Notes |
|--------|--------|-------|
| `encrypted_profile_data` | 🟢 AES-256-GCM | Per-conversation profile data |
| `nonce` | ⚪ Nonce | AES-GCM IV |

### `files` table

| Column | Status | Notes |
|--------|--------|-------|
| `uploader_id` | 🔴 Plaintext | Who uploaded |
| `mime_type` | 🔴 Plaintext | File type metadata |
| `chunk_count` | ⚪ Metadata | File size estimate |
| File chunks | 🟢 Client-encrypted | Content encrypted before upload |

---

## 2. API ENDPOINTS — Response Audit

| Endpoint | Returns | Status |
|----------|---------|--------|
| `POST /api/register` | token, user.id, username, display_name(null), profile_pic | 🟢 Mostly safe |
| `POST /api/login` | token, user.id, username, display_name(null), profile_pic | 🟢 Mostly safe |
| `GET /api/profile/{id}` | id, username, display_name(null), profile_pic_file_id, profile_pic_file_key, color(null), border(null), banner_id, banner_key | 🟢 Profile data is nulled or encrypted keys |
| `GET /api/user/{username}` | id, username | 🔴 Username exposed (needed for lookup) |
| `GET /api/identity/{id}` | identity_public_key, user_id | 🟢 Public key only |
| `POST /api/servers` | id, encrypted_name(base64), name_nonce | 🟢 Encrypted |
| `GET /api/servers` | [{id, encrypted_name, name_nonce, is_owner, joins_disabled}] | 🟢 Encrypted |
| `GET /api/servers/{id}/channels` | [{id, encrypted_name, name_nonce}] | 🟢 Encrypted |
| `POST /api/servers/{id}/channels` | {id, encrypted_name, name_nonce} | 🟢 Encrypted |
| `POST /api/invites/join` | {id} | 🟢 Just server ID |
| `GET /api/servers/{id}/members` | [{id, username, role, display_name(null), profile_pic}] | 🔴 Usernames exposed (needed for member list) |
| `GET /api/servers/{id}/messages` | [{sender_id, sender_username, encrypted_content, nonce, ...}] | 🟢 Content encrypted, sender_username is plaintext though |
| `GET /api/servers/{id}/keys` | [{encrypted_key, sender_public_key, nonce}] | 🟢 Keys are envelope-encrypted |
| `GET /api/dm/conversations` | [{dm_channel_id, other_id, other_username, ...}] | 🔴 DM pairs revealed |
| `GET /api/dm/{id}/messages` | [{encrypted_content, nonce, sender_id, ...}] | 🟢 Content encrypted |
| `GET /api/friend-code` | encrypted_friend_code, salt, nonce | 🟢 Encrypted |
| `POST /api/friends/request` | {ok} with friend_code (hashed lookup) | 🟡 Hashed lookup |
| `GET /api/friends/requests/incoming` | [{id, from_username, ...}] | 🔴 Reveals who sent request |
| `POST /api/friends/requests/accept` | DM channel created | 🟢 No sensitive data in response |

---

## 3. WEB SOCKET MESSAGES — Broadcast Audit

| WS Type | Fields | Status |
|---------|--------|--------|
| `message` | channel_id, sender_id, sender_username, encrypted_content, nonce, ... | 🟢 Content encrypted; 🔴 sender_username, sender_id plaintext |
| `message_edited` | message_id, channel_id, encrypted_content, nonce | 🟢 Content encrypted |
| `dm_message` | dm_channel_id, sender_id, encrypted_content, nonce, ... | 🟢 Content encrypted |
| `profile_updated` | user_id, encrypted_profile_data | 🟢 Profile data encrypted |
| `profile_key_sync` | user_id, file_key, file_id | 🟢 Key is pre-decrypted by sender for the specific conversation |
| `member_joined` | server_id, user_id | 🔴 Membership metadata |
| `member_left` | server_id, user_id | 🔴 Membership metadata |
| `member_kicked` | server_id, user_id | 🔴 Membership metadata |
| `member_banned` | server_id, user_id | 🔴 Membership metadata |
| `server_key_rotated` | server_id | ⚪ Trigger event |
| `server_deleted` | server_id | ⚪ Server deleted |
| `friend_request_received` | from_username, from_user_id | 🔴 Reveals who sent request |
| `friend_request_accepted` | to_username, from_user_id | 🔴 Reveals who accepted |
| `channel_created` | server_id | ⚪ Trigger event |
| `channel_deleted` | server_id | ⚪ Trigger event |

---

## 4. CLIENT-SIDE SENDS — What Leaves the Browser

| Send Path | Data Sent | Status |
|-----------|-----------|--------|
| Registration | username, password, identity_public_key, friend_code_hash, encrypted_friend_code, escrow | 🟢 Password never stored; keys encrypted |
| Login | username, password | 🟢 Password sent to server (needed for auth) |
| Message send | encrypted_content, nonce, message_nonce, signature | 🟢 Fully encrypted before send |
| DM send | encrypted_content, nonce, message_nonce | 🟢 Fully encrypted |
| Profile save | encrypted_profile_data (AES-256-GCM blob) | 🟢 All profile data inside encrypted blob |
| Profile picture upload | encrypted file key + file data | 🟢 File key encrypted with identity key |
| PFP key sync | decrypted key, re-encrypted for conversation | 🟢 Key is decrypted then re-encrypted per-conversation |
| File upload | encrypted chunks | 🟢 Client-encrypted before upload |
| Server create | encrypted_name + nonce | 🟢 Name encrypted before send |
| Channel create | encrypted_name + nonce | 🟢 Name encrypted before send |
| Invite code join | plaintext code (hashed client-side before send) | 🟡 Hashed before send; SHA-256 fallback on server |

---

## 5. WHAT THE HOST CAN STILL SEE

### Eyes-On Data (Host can read directly)

| Data | Severity | Notes |
|------|----------|-------|
| Usernames | 🔴 High | All usernames stored/transmitted in plaintext |
| Communication graph | 🔴 High | Who DMs whom, who's in which server, message timestamps |
| Message frequency | 🔴 Medium | When users message, how often |
| Server membership | 🔴 Medium | Who's in each server, roles |
| Friend graph | 🔴 Medium | Who's friends with whom |
| File metadata (size, type) | 🔴 Medium | But NOT file content (client-encrypted) |
| Profile picture file IDs | 🔴 Low | Can't decrypt the picture without the key |
| Password hashes | 🟡 Low-Med | Argon2id — slow to crack, but weak passwords vulnerable |
| DM existence | 🔴 Medium | Host knows which pairs of users have DMs |
| Message sender identity | 🔴 Medium | Host knows who sent each message, but not the content |

### What the Host CANNOT See

| Data | Why |
|------|-----|
| Message content | AES-256-GCM, key never touches server |
| Server/channel names | Encrypted with E2EE server key |
| Profile display_name, colors, bio | Inside encrypted_profile_data blob |
| Profile pictures/banners | File key encrypted with identity key |
| File content | Client-encrypted in chunks |
| DM encryption keys | ECDH-derived, never stored on server |
| Identity private keys | Password-wrapped via Argon2id |
| Friend codes | Stored as hash + encrypted for recovery |
| Invite codes | Stored as hash only |

---

## 6. SUMMARY STATS

| Category | Encrypted 🟢 | Hashed 🟡 | Plaintext 🔴 | Reference 🔵 | Metadata ⚪ |
|----------|:-----------:|:--------:|:-----------:|:----------:|:----------:|
| DB Columns | 16 | 3 | 18 | 3 | 10 |
| API Response Fields | ~20 | 0 | ~8 | ~4 | ~5 |
| WS Broadcast Fields | ~8 | 0 | ~12 | 0 | ~6 |
| Client Send Fields | ~10 | ~1 | ~3 | 0 | ~2 |

**Overall Protection: Strong** ✅ — All content data (messages, profiles, names, files, keys) is encrypted. The host sees metadata only (who talks to whom, when, how often).

---

## 7. RECOMMENDED PRIORITY IMPROVEMENTS

| Priority | Improvement | Effort | Impact |
|----------|------------|--------|--------|
| P2 | Encrypt profile_picture_file_id + banner_file_id | Low | Prevents host from linking profile pics to users on storage |
| P3 | Encrypt message sender_username with channel key | Medium | Hides identity of message senders from host |
| P3 | RTC (Real-Time Communication) encryption | Medium | End-to-end encrypted voice/video |
| P4 | Obfuscate message timestamps (relative ordering) | High | Reveals communication patterns |
| P4 | Encrypt DM channel participant IDs | High | Hides social graph from host |
