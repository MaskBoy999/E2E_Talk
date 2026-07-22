```markdown
# E2E Talk — Streamlined Zero-Knowledge Architecture (with E2EE Voice/Video)

## Overview
A simplified end-to-end encrypted chat application prioritizing ease of implementation while guaranteeing the server host and passive network attackers cannot read user data.

- **Crypto:** X25519 ECDH + XChaCha20-Poly1305 + HKDF-SHA256 (via `libsodium-wrappers`)
- **Identity:** One long-term X25519 keypair per user. Multi-device via password escrow.
- **Text/Files/Profiles:** Encrypted with a shared symmetric `channelKey`.
- **Voice/Video/Screen:** WebRTC with Insertable Streams, media frames encrypted with the `channelKey` before hitting the SFU.

---

## 1. THREAT MODEL & GUARANTEES

### What the Server Host CANNOT see:
- Message text (DMs and Server channels)
- Profile data (display names, descriptions, colors, PFP file keys)
- Server names and Channel names
- File contents, Stickers, GIFs, and Emojis (stored as encrypted chunks on disk)
- Identity private keys (stored as password-wrapped escrow)
- Voice / Video / Screen Share media (SFU only forwards ciphertext frames)

### What the Server Host CAN see:
- Usernames and account creation timestamps
- Who is in what server/DM (the social graph)
- Message timestamps and sender IDs
- File sizes and MIME types
- Public keys and opaque ciphertext blobs
- WebRTC connection metadata (IPs, packet sizes, codec types)

### Multi-Device Guarantee:
Adding a new device works instantly and automatically. The user simply logs in with their username and password. The new device downloads the password-encrypted Identity Private Key from the server, decrypts it, and immediately uses it to unwrap all existing server channel keys, derive all DM keys, and access all personal media (stickers/files). Full message history is then fetched and decrypted locally.

---

## 2. DATABASE SCHEMA (Target State)

### Table: `users`
| Column | Type | Encrypted | Notes |
|--------|------|-----------|-------|
| `id` | TEXT PK | No | UUIDv4 |
| `username` | TEXT UNIQUE | No | Login name |
| `password_hash` | TEXT | No (bcrypt) | |
| `identity_public_key` | BLOB | No | X25519 public key |
| `encrypted_identity_priv` | BLOB | **YES** | Password-wrapped private key |
| `escrow_salt` | BLOB | No | HKDF salt |
| `escrow_nonce` | BLOB | No | XChaCha20 nonce |
| `encrypted_profile_data` | BLOB | **YES** | Profile JSON encrypted with `profileKey` |
| `encrypted_profile_key` | BLOB | **YES** | `profileKey` envelope-encrypted to self |
| `profile_eph_pub` | BLOB | No | |
| `profile_nonce` | BLOB | No | |
| `friend_code_hash` | BLOB | No | HMAC-SHA256 of plaintext code |
| `encrypted_friend_code` | BLOB | **YES** | Password-wrapped code for backup |

### Table: `servers`
| Column | Type | Encrypted | Notes |
|--------|------|-----------|-------|
| `id` | TEXT PK | No | |
| `encrypted_name` | BLOB | **YES** | Encrypted with `channelKey` |
| `name_nonce` | BLOB | No | |
| `owner_id` | TEXT FK | No | |
| `invite_code_hash` | BLOB | No | HMAC-SHA256 of plaintext invite |
| `joins_disabled` | INTEGER | No | |

### Table: `channels`
| Column | Type | Encrypted | Notes |
|--------|------|-----------|-------|
| `id` | TEXT PK | No | |
| `server_id` | TEXT FK | No | |
| `encrypted_name` | BLOB | **YES** | Encrypted with `channelKey` |
| `name_nonce` | BLOB | No | |
| `type` | TEXT | No | 'text' or 'voice' |

### Table: `messages` (and `dm_messages`)
| Column | Type | Encrypted | Notes |
|--------|------|-----------|-------|
| `id` | TEXT PK | No | |
| `channel_id` | TEXT FK | No | |
| `sender_id` | TEXT FK | No | |
| `encrypted_content` | BLOB | **YES** | Encrypted with `channelKey` |
| `encrypted_profile_snapshot` | BLOB | **YES** | Sender's profile JSON encrypted with `channelKey` |
| `profile_snapshot_nonce` | BLOB | No | |
| `encrypted_file_key` | BLOB | **YES** | If message has a file/sticker, wrapped with `channelKey` |
| `file_key_nonce` | BLOB | No | |
| `nonce` | BLOB | No | |
| `timestamp` | DATETIME | No | |

### Table: `server_keys`
| Column | Type | Encrypted | Notes |
|--------|------|-----------|-------|
| `id` | INTEGER PK | | |
| `server_id` | TEXT FK | | |
| `user_id` | TEXT FK | | |
| `encrypted_key` | BLOB | **YES** | Channel key envelope-encrypted for user |
| `eph_pub` | BLOB | No | |
| `nonce` | BLOB | No | |

### Table: `user_media` (Stickers, GIFs, Custom Emojis)
Stores media uploaded by the user for their own use across all devices.
| Column | Type | Encrypted | Notes |
|--------|------|-----------|-------|
| `id` | TEXT PK | No | UUIDv4 |
| `user_id` | TEXT FK | No | Owner of the media |
| `file_id` | TEXT FK | No | Reference to the `files` table |
| `encrypted_file_key` | BLOB | **YES** | `fileKey` envelope-encrypted to user's identity key |
| `eph_pub` | BLOB | No | |
| `nonce` | BLOB | No | |
| `media_type` | TEXT | No | 'sticker', 'gif', 'emoji' |
| `created_at` | DATETIME | No | |

### Table: `voice_sessions`
| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUIDv4 |
| `channel_id` | TEXT FK | The voice channel |
| `started_at` | DATETIME | |
| `ended_at` | DATETIME | Null = active |

### Table: `voice_participants`
| Column | Type | Notes |
|--------|------|-------|
| `voice_session_id` | TEXT FK | PK composite |
| `user_id` | TEXT FK | PK composite |
| `joined_at` | DATETIME | |
| `left_at` | DATETIME | Null = still in call |
| `is_muted` | BOOLEAN | Mic muted? |
| `is_deafened` | BOOLEAN | Audio output muted? |
| `is_camera_on` | BOOLEAN | Webcam active? |
| `is_screen_sharing` | BOOLEAN | Screen share active? |

---

## 3. MIGRATION GUIDE: What to REMOVE, ADD, and CHANGE

### 3.1 What to REMOVE
**Database Tables to DROP:**
- `dm_keys` (Replaced by client-side ECDH derivation)
- `user_devices`, `user_device_escrow` (No per-device keys)
- `prekey_bundles`, `sessions` (No Signal protocol/ratchets)
- `notification_sounds`, `server_stickers`, `user_stickers` (Replaced by `user_media`)

**Database Columns to DROP:**
- `users`: `display_name`, `profile_picture_file_id`, `profile_picture_file_key`, `profile_banner_file_id`, `profile_banner_file_key`, `username_color`, `username_border_color`, `profile_background_color`, `description`, `nickname`, `profile_updated_at`
- `servers`: `name`, `invite_code`
- `channels`: `name`
- `messages` & `dm_messages`: `message_nonce`, `message_signature`, `encrypted_profile_key`, `profile_key_nonce`, `encrypted_banner_key`, `banner_key_nonce`
- `server_keys`: `device_id`

**Client-Side Crypto Functions to DELETE (`static/crypto.js`):**
- `deriveChannelKey()`, `deriveMetadataKey()`, `encryptWithKeyAndNonce()`
- `encrypt()`, `decrypt()` (The per-server-key HKDF chain versions)
- `encryptMetadata()`, `decryptMetadata()`, `encryptDm()`, `decryptDm()`
- `verifyKeyForUser()`, `trustCurrentKey()`, `fingerprintKey()` (No TOFU)
- `claimLegacyIdentityKey()`, `ratchetKey()`, `rotateDmKey()`
- `signMessage()`, `verifyMessage()`, `deriveSessionKey()`
- `encryptFileKeyForStorage()`, `decryptFileKeyFromStorage()`, `encodeEncryptedFileKey()`, `decodeEncryptedFileKey()`

### 3.2 What to ADD
**Database Tables to CREATE:**
- `voice_sessions`, `voice_participants`, `user_media`

**Database Columns to ADD:**
- `servers`: `encrypted_name` (BLOB), `name_nonce` (BLOB)
- `channels`: `encrypted_name` (BLOB), `name_nonce` (BLOB)
- `messages` & `dm_messages`: `key_version` (INTEGER DEFAULT 1), `encrypted_profile_snapshot` (BLOB), `profile_snapshot_nonce` (BLOB), `encrypted_file_key` (BLOB), `file_key_nonce` (BLOB)

**Client-Side Crypto Functions to ADD (`static/crypto.js`):**
- `generateIdentityKeyPair()` (Rename of `x25519GenerateKeyPair`)
- `aeadEncrypt(plaintext, key, aad?)` / `aeadDecrypt(ciphertext, key, nonce, aad?)` (Must explicitly support AAD)
- `generateSymmetricKey()`
- `encryptMediaFrame(frameData, key, frameId)` / `decryptMediaFrame(...)` (For WebRTC)

### 3.3 What to CHANGE
**Message Encryption Flow:**
- **BEFORE:** Per-message HKDF chain derivation.
- **AFTER:** `aeadEncrypt(plaintext, channelKey)`. Use the static 32-byte `channelKey` directly. Send `{ encrypted_content, nonce, key_version }`.

**DM Encryption Flow:**
- **BEFORE:** Per-message HKDF derivation. DM keys stored in `dm_keys` table.
- **AFTER:** Derive `dmKey = HKDF(ECDH(myPriv, theirPub), "dm-channel:" + dmChannelId)` client-side. Use `aeadEncrypt(plaintext, dmKey)`. No server storage of DM keys.

**Profile & Media Flow:**
- **BEFORE:** Plaintext fields sent to server. File keys stored in plaintext or legacy columns.
- **AFTER:** Client encrypts profile JSON with `profileKey`. Wraps `profileKey` and media `fileKey`s with identity key for self-storage (enabling multi-device). Bundles `encrypted_profile_snapshot` and `encrypted_file_key` (wrapped with `channelKey`) in messages.

---

## 4. DATA FLOWS: MEDIA, STICKERS & FORWARDING

### 4.1 Uploading & Syncing Stickers/GIFs (Multi-device)
1. Client selects an image. Generates random 32-byte `fileKey`.
2. Client chunks the file (64KB) and encrypts each chunk with `fileKey`.
3. Client uploads chunks to server via `/api/files/init` and `/api/files/{id}/chunk/{n}`.
4. Client wraps `fileKey` for self-storage: `encKey = envelopeEncrypt(fileKey, identity.pub, identity.priv)`.
5. Client sends `{ file_id, encrypted_file_key, eph_pub, nonce, media_type }` to `POST /api/user/media`.
6. **Multi-device:** When a new device logs in, it fetches `GET /api/user/media`. Because the `encKey` is wrapped for the identity key, the new device can decrypt the `fileKey` and instantly access all the user's stickers.

### 4.2 Sending Stickers/Media in a Chat
1. User clicks a sticker from their library.
2. Client fetches the `fileKey` (decrypting it locally with their identity key).
3. Client re-wraps the `fileKey` for the conversation: `msgFileKey = aeadEncrypt(fileKey, channelKey)`.
4. Client sends a message via WS: `{ channel_id, encrypted_content: aeadEncrypt("sticker", channelKey), file_id: "uuid", encrypted_file_key: msgFileKey }`.
5. Recipients decrypt `msgFileKey` with their `channelKey`, download the file chunks, and decrypt them.

### 4.3 Forwarding Messages
1. User receives a message in Server A. Client decrypts it locally using Server A's `channelKey` to get the `plaintext` and the `fileKey`.
2. User clicks "Forward" and selects DM B.
3. Client encrypts the `plaintext` using DM B's `dmKey`.
4. If the message contains a file, client re-encrypts the `fileKey` using DM B's `dmKey`.
5. Client sends the newly encrypted payload to DM B. The server only sees a standard new message being created.

---

## 5. IMPLEMENTATION STEPS (For AI Agent)

### STEP 1: Crypto Wrapper & Bug Fixes Setup
**Objective:** Implement the `E2ECrypto` object in `static/crypto.js` using `libsodium-wrappers-sumo`.
**Files:** `static/crypto.js`, `static/test-crypto.html`

**Detailed Instructions:**
1. Initialize sodium in `static/test-crypto.html` and `index.html`.
2. Implement `generateIdentityKeyPair()`: Returns `{ publicKey, privateKey }` using `sodium.crypto_box_keypair()`.
3. **CRITICAL FIX (Authenticated ECDH):** Implement `envelopeEncrypt(plaintext, recipientPub, senderPriv)`: Uses *static* ECDH (`sodium.crypto_scalarmult(senderPriv, recipientPub)`) instead of an ephemeral key. This provides implicit authentication. Derive a 32-byte key via HKDF-SHA256, then encrypt with `sodium.crypto_aead_xchacha20poly1305_ietf_encrypt`. Returns `{ ciphertext, nonce }`.
4. Implement `envelopeDecrypt(ciphertext, recipientPriv, senderPub, nonce)`: Inverse of above. Derives the same shared secret using the recipient's private key and the sender's public key.
5. **CRITICAL FIX (AAD Support):** Implement `aeadEncrypt(plaintext, key, aad?)` and `aeadDecrypt(ciphertext, key, nonce, aad?)`: Must explicitly pass the `aad` parameter to `sodium.crypto_aead_xchacha20poly1305_ietf_encrypt/decrypt`.
6. Implement `encryptMediaFrame(frameData, key, frameId)` and `decryptMediaFrame(...)`: Uses `aeadEncrypt` with `frameId` as the `aad`.
7. Implement `encryptWithPassword` and `decryptWithPassword` using `sodium.crypto_pwhash` (Argon2id) and `aeadEncrypt`.
8. **Bug Prevention (Invalid Codes):** Ensure `hmacHex(message, key)` is implemented and uses `sodium.crypto_generichash` (BLAKE2b) or `crypto_auth` (HMAC-SHA256). This will be used for friend/invite codes.

**Test (`tests/01-crypto.spec.js`):**
```js
const { test, expect } = require('@playwright/test');

test('crypto round-trips work perfectly with auth ECDH and AAD', async ({ page }) => {
  await page.goto('http://localhost:3000/test-crypto.html');
  const results = await page.evaluate(async () => {
    const E = globalThis.E2ECrypto;
    const sender = E.generateIdentityKeyPair();
    const recipient = E.generateIdentityKeyPair();
    const msg = new TextEncoder().encode("hello world");
    
    // Envelope (Authenticated ECDH)
    const enc = E.envelopeEncrypt(msg, recipient.publicKey, sender.privateKey);
    const dec = E.envelopeDecrypt(enc.ciphertext, recipient.privateKey, sender.publicKey, enc.nonce);
    
    // AEAD (With AAD)
    const symKey = E.generateSymmetricKey();
    const aad = new TextEncoder().encode("frame-123");
    const aeadEnc = E.aeadEncrypt(msg, symKey, aad);
    const aeadDec = E.aeadDecrypt(aeadEnc.ciphertext, symKey, aeadEnc.nonce, aad);
    
    // HMAC (for invite/friend codes)
    const hash1 = E.hmacHex("CODE123", "server_hmac_key");
    const hash2 = E.hmacHex("CODE123", "server_hmac_key");

    return {
      envelope: new TextDecoder().decode(dec) === "hello world",
      aead: new TextDecoder().decode(aeadDec) === "hello world",
      hmac_match: hash1 === hash2
    };
  });
  expect(results.envelope).toBe(true);
  expect(results.aead).toBe(true);
  expect(results.hmac_match).toBe(true);
});
```

### STEP 2: Database Migration
**Objective:** Migrate the database to the streamlined schema.
**Files:** `migrations/001_simplified_e2e.sql`, `src/db.rs`, `src/handlers/servers.rs`, `src/handlers/channels.rs`

**Detailed Instructions:**
1. **CRITICAL FIX (Column Updates):** Before dropping legacy columns, ensure `src/handlers/servers.rs` (`create_server`) and `src/handlers/channels.rs` (`create_channel`) are updated to accept `encrypted_name` and `name_nonce` from the client and write them to the database.
2. Write SQL to drop legacy tables: `user_devices`, `user_device_escrow`, `prekey_bundles`, `sessions`, `dm_keys`, `notification_sounds`, `server_stickers`, `user_stickers`.
3. Write SQL to drop legacy columns from `users`, `servers`, `channels`, `messages`, `dm_messages` (remove `display_name`, `name`, `message_signature`, `encrypted_profile_key`, etc.).
4. Write SQL to add `encrypted_name`, `name_nonce` to `servers` and `channels`.
5. Write SQL to add `key_version`, `encrypted_profile_snapshot`, `profile_snapshot_nonce`, `encrypted_file_key`, `file_key_nonce` to `messages` and `dm_messages`.
6. Write SQL to create `voice_sessions`, `voice_participants`, and `user_media` tables.
7. Update `src/db.rs` structs to match the new schema. Remove fields that no longer exist.

**Test (`tests/02-schema.spec.js`):**
```js
const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');

test('database schema is perfectly migrated', async () => {
  const db = new Database('data/e2e_talk.db');
  const usersCols = db.pragma('table_info(users)').map(c => c.name);
  expect(usersCols).not.toContain('display_name');
  expect(usersCols).toContain('encrypted_profile_data');

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  expect(tables).not.toContain('dm_keys');
  expect(tables).toContain('voice_sessions');
  expect(tables).toContain('voice_participants');
  expect(tables).toContain('user_media');
  db.close();
});
```

### STEP 3: Auth, Escrow, & Friend Code Fixes
**Objective:** Implement registration and login. Fix the invalid friend code bug.
**Files:** `static/auth.js`, `src/handlers/auth.rs`

**Detailed Instructions:**
1. **Registration Flow:**
   - Client generates `identityKeyPair`.
   - Client generates plaintext friend code (8 chars).
   - **Bug Fix:** Client fetches server HMAC key. Client calculates `friend_code_hash = HMAC-SHA256(plaintextCode, hmacKey)`.
   - Client encrypts plaintext code for backup: `encBackup = encryptWithPassword(plaintextCode, password)`.
   - Client escrows identity private key: `encPriv = encryptWithPassword(identity.priv, password)`.
   - Client sends `{ username, password, identity_pub, encPriv, escrow_salt, escrow_nonce, friend_code_hash, encBackup }` to `POST /api/register`.
2. **Login Flow (Multi-device):**
   - `POST /api/login` returns JWT.
   - Client fetches escrow, decrypts `identity.priv` with password, saves to localStorage.
3. **Server-side:** Ensure `src/handlers/auth.rs` stores only the `friend_code_hash` and `encBackup`. Never store the plaintext code.

**Test (`tests/03-auth.spec.js`):**
```js
const { test, expect } = require('@playwright/test');

test('registration and login work, friend code is hashed', async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('http://localhost:3000');
  await page.fill('#username', 'alice');
  await page.fill('#password', 'password123');
  await page.click('#register-btn');
  await page.waitForSelector('#chat-ui');

  const db = require('better-sqlite3')('data/e2e_talk.db');
  const user = db.prepare("SELECT * FROM users WHERE username = 'alice'").get();
  expect(user.friend_code_hash).toBeTruthy();
  expect(user.encrypted_friend_code).toBeTruthy();
  // Ensure no plaintext friend code exists
  expect(user.friend_code_hash).not.toMatch(/^[A-Z0-9]{8}$/);
  db.close();
});
```

### STEP 4: Server, Channel, & Invite Code Encryption
**Objective:** Encrypt server/channel names. Fix the invalid invite code bug.
**Files:** `static/chat.js`, `src/handlers/servers.rs`

**Detailed Instructions:**
1. **Server Creation:**
   - Client generates 32-byte `channelKey`.
   - Client encrypts server name: `encName = aeadEncrypt(name, channelKey)`.
   - Client wraps `channelKey` for self: `encKey = envelopeEncrypt(channelKey, identity.pub, identity.priv)`.
   - Client generates plaintext invite code.
   - **Bug Fix:** Client calculates `invite_hash = HMAC-SHA256(plaintextInvite, hmacKey)`.
   - Client sends `{ encrypted_name, name_nonce, owner_id, invite_code_hash, encrypted_key }` to `POST /api/servers`.
2. **Channel Creation:** Same pattern. Encrypt name with `channelKey`.
3. **Join Server:**
   - User inputs plaintext invite code.
   - Client hashes it and sends to `POST /api/invites/join`.
   - Server matches hash, adds user to `server_members`.
   - Server broadcasts `member_joined`. Owner envelope-encrypts `channelKey` for the new user and uploads to `server_keys`.

**Test (`tests/04-servers.spec.js`):**
```js
const { test, expect } = require('@playwright/test');

test('server and invite codes are encrypted/hashed', async ({ page }) => {
  // Login as alice
  await page.goto('http://localhost:3000');
  await page.fill('#username', 'alice');
  await page.fill('#password', 'password123');
  await page.click('#login-btn');
  await page.waitForSelector('#chat-ui');

  // Create server
  await page.click('#new-server-btn');
  await page.fill('#server-name-input', 'Secret Club');
  await page.click('#create-server-btn');

  const db = require('better-sqlite3')('data/e2e_talk.db');
  const server = db.prepare("SELECT * FROM servers").get();
  expect(server.encrypted_name).toBeTruthy();
  expect(server.encrypted_name.toString('utf8')).not.toContain('Secret Club');
  expect(server.invite_code_hash).toBeTruthy();
  // Verify invite code is not stored in plaintext
  expect(server.invite_code).toBeUndefined(); // column dropped
  db.close();
});
```

### STEP 5: Text Messages & History Decryption (Fixing Bug 1)
**Objective:** Implement E2EE text messages. Fix the bug where messages appear as "[message sent]" or ciphertext after page reload.
**Files:** `static/chat.js`, `src/handlers/messages.rs`

**Detailed Instructions:**
1. **Sending:**
   - `encMsg = aeadEncrypt(plaintext, channelKey)`.
   - Send `{ channel_id, encrypted_content, nonce }` via WS.
2. **Receiving (Real-time):**
   - Receive WS broadcast. Decrypt with `channelKey`. Render in UI.
3. **Loading History (CRITICAL BUG FIX):**
   - When `loadHistory(channelId)` is called, it MUST ensure the `channelKey` is fetched and available in localStorage *before* attempting to decrypt the REST response.
   - If `channelKey` is missing, fetch it from `/api/servers/{id}/keys` and decrypt it first.
   - Loop through history messages, decrypt each one. If decryption fails, render "[Decryption Failed]" instead of raw ciphertext or "[message sent]".

**Test (`tests/05-messages.spec.js`):**
```js
const { test, expect } = require('@playwright/test');

test('messages decrypt correctly after page reload', async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('http://localhost:3000');
  await page.fill('#username', 'alice');
  await page.fill('#password', 'password123');
  await page.click('#login-btn');
  await page.waitForSelector('#chat-ui');

  // Send a message
  await page.click('.server-item');
  await page.click('.channel-item');
  await page.fill('#message-input', 'Hello World');
  await page.click('#send-btn');
  await page.waitForSelector('text=Hello World');

  // Reload the page
  await page.reload();
  await page.waitForSelector('#chat-ui');
  await page.click('.server-item');
  await page.click('.channel-item');

  // Verify message is still decrypted
  await page.waitForSelector('text=Hello World', { timeout: 5000 });
  
  // Verify DB has ciphertext
  const db = require('better-sqlite3')('data/e2e_talk.db');
  const msg = db.prepare("SELECT encrypted_content FROM messages LIMIT 1").get();
  expect(msg.encrypted_content.toString('utf8')).not.toContain('Hello World');
  db.close();
});
```

### STEP 6: DMs & Friend System
**Objective:** Implement E2EE DMs using ECDH.
**Files:** `static/chat.js`, `src/handlers/dm.rs`

**Detailed Instructions:**
1. **Friend Request:** Client sends `friend_code_hash` to server. Server matches and creates `friend_requests` row.
2. **DM Key Derivation:**
   - When a DM is created/accepted, derive the key client-side.
   - `sharedSecret = ECDH(myPriv, theirPub)`
   - `dmKey = HKDF(sharedSecret, "dm-channel:" + dmChannelId)`
   - Do NOT store `dmKey` on the server.
3. **Sending/Receiving DMs:** Use `aeadEncrypt(plaintext, dmKey)` and `aeadDecrypt(...)`.

**Test (`tests/06-dms.spec.js`):**
```js
const { test, expect } = require('@playwright/test');

test('DMs are encrypted via ECDH', async ({ browser }) => {
  // Setup: Alice and Bob are registered and have each other's friend codes
  // Alice sends friend request, Bob accepts
  // Alice sends DM to Bob
  // Bob receives and decrypts DM
  // Verify DB has ciphertext, no dm_keys table exists
  const db = require('better-sqlite3')('data/e2e_talk.db');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dm_keys'").all();
  expect(tables.length).toBe(0);
  const dmMsg = db.prepare("SELECT encrypted_content FROM dm_messages LIMIT 1").get();
  expect(dmMsg.encrypted_content.toString('utf8')).not.toMatch(/hello|test/i);
  db.close();
});
```

### STEP 7: Profiles, Files, & Stickers (Multi-device & Sharing)
**Objective:** Implement encrypted file uploads, user media (stickers), and profile snapshots.
**Files:** `static/chat.js`, `src/handlers/files.rs`, `src/handlers/media.rs`, `src/handlers/profile.rs`

**Detailed Instructions:**
1. **File Uploads:** Client splits file into 64KB chunks, generates `fileKey`, encrypts chunks, uploads to server.
2. **User Media (Stickers/GIFs):** Client wraps `fileKey` with identity key. `POST /api/user/media` stores `encrypted_file_key`. `GET /api/user/media` returns them so new devices can sync stickers.
3. **Sending Media:** When sending a sticker/file in a message, wrap the `fileKey` with the `channelKey` using `aeadEncrypt`. Include `file_id` and `encrypted_file_key` in the message WS payload.
4. **Profile Snapshots:** Bundle `display_name`, `colors`, and PFP `file_id`/`fileKey` into a JSON snapshot. Encrypt with `channelKey` and attach to messages.
5. **Auto-Update:** When a user updates their profile, they send a `profile_updated` WS event to the server containing the new `encrypted_profile_snapshot` (encrypted with the relevant `channelKey`). The server broadcasts this to all friends/server members. Clients decrypt and update `window.profileCache[user_id]` and the DOM immediately.

**Test (`tests/07-media-profiles.spec.js`):**
```js
const { test, expect } = require('@playwright/test');

test('stickers sync across devices and send e2ee', async ({ browser }) => {
  // Alice uploads a sticker on Device 1
  // Alice logs into Device 2, verifies sticker appears in library
  // Alice sends sticker to Bob in a DM
  // Bob receives sticker, decrypts fileKey, downloads and views image
});

test('profiles auto-update and display names appear', async ({ browser }) => {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alicePage = await aliceCtx.newPage();
  const bobPage = await bobCtx.newPage();

  // Login both in same server
  // ...
  
  // Alice updates her profile
  await alicePage.click('#settings-btn');
  await alicePage.fill('#display-name-input', 'Alice New Name');
  await alicePage.click('#save-profile-btn');

  // Bob should see the update automatically without a new message
  await bobPage.waitForSelector('text=Alice New Name', { timeout: 5000 });

  // Alice sends a message
  await alicePage.fill('#message-input', 'Hi Bob');
  await alicePage.click('#send-btn');

  // Bob sees the message with the correct display name
  const msgName = await bobPage.locator('.message-sender-name').last().textContent();
  expect(msgName.trim()).toBe('Alice New Name');
});
```

### STEP 8: Message Forwarding
**Objective:** Allow users to forward messages between conversations.
**Files:** `static/chat.js`

**Detailed Instructions:**
1. Add a "Forward" button to the message context menu.
2. When clicked, prompt user to select a target channel/DM.
3. Client decrypts the original message using the source `channelKey`/`dmKey`.
4. Client re-encrypts the content (and any `fileKey`) using the target `channelKey`/`dmKey`.
5. Client sends as a new standard message to the target that also has a link to the message in the channel it was sent if it was sent from a server, also rendering the pfp and display name and color and glow on the forwarded message, however when forwarding from a dm anywhere the pfp and display name wont be rendered

**Test (`tests/08-forwarding.spec.js`):**
```js
const { test, expect } = require('@playwright/test');

test('message forwarding decrypts and re-encrypts', async ({ browser }) => {
  // Alice sends "Secret Text" in Server A
  // Alice forwards the message to DM with Bob
  // Bob receives the message in DM and sees "Secret Text"
  // Verify DB: Server A message and DM message have DIFFERENT ciphertexts
  const db = require('better-sqlite3')('data/e2e_talk.db');
  const allMsgs = db.prepare("SELECT encrypted_content FROM messages UNION ALL SELECT encrypted_content FROM dm_messages").all();
  const uniqueCiphers = new Set(allMsgs.map(m => m.encrypted_content.toString('utf8')));
  expect(uniqueCiphers.size).toBe(allMsgs.length); // No two messages share the same ciphertext
});
```

### STEP 9: Voice Session Backend & Signaling
**Objective:** Implement the backend infrastructure for voice channels.
**Files:** `src/handlers/voice.rs`, `src/ws.rs`, `src/db.rs`

**Detailed Instructions:**
1. Implement `POST /api/voice/{channel_id}/join`:
   - Create or fetch active `voice_session`.
   - Add user to `voice_participants`.
   - Return `voice_session_id`, SFU WebSocket URL, and list of existing participants.
2. Implement WS signaling messages: `voice_sdp_offer`, `voice_sdp_answer`, `voice_ice_candidate`, `voice_state_update`.
3. Ensure `voice_state_update` updates the `is_muted`, `is_deafened`, `is_camera_on`, `is_screen_sharing` columns in `voice_participants`.

**Test (`tests/09-voice-backend.spec.js`):**
```js
const { test, expect } = require('@playwright/test');

test('voice session backend works', async ({ page }) => {
  // Login, join voice channel
  await page.goto('http://localhost:3000');
  await page.fill('#username', 'alice');
  await page.fill('#password', 'password123');
  await page.click('#login-btn');
  await page.waitForSelector('#chat-ui');
  await page.click('.voice-channel-item');
  
  // Verify DB
  const db = require('better-sqlite3')('data/e2e_talk.db');
  const session = db.prepare("SELECT * FROM voice_sessions WHERE ended_at IS NULL").get();
  expect(session).toBeTruthy();
  const participant = db.prepare("SELECT * FROM voice_participants WHERE voice_session_id = ?").get(session.id);
  expect(participant).toBeTruthy();
  expect(participant.is_muted).toBe(0);
  db.close();
});
```

### STEP 10: E2EE WebRTC Media (Insertable Streams)
**Objective:** Implement E2EE voice/video/screen share using native browser APIs.
**Files:** `static/voice.js`

**Detailed Instructions:**
1. Call `navigator.mediaDevices.getUserMedia({ audio: true, video: true })`.
2. Create `RTCPeerConnection`.
3. For each track, use `RTCRtpSender.setEncryptedTransform()`:
   - Provide a transform function that takes the frame data and calls `E2ECrypto.encryptMediaFrame(frame.data, channelKey, frame.id)`.
4. For receiving tracks, use `RTCRtpReceiver.setEncryptedTransform()`:
   - Provide a transform function that calls `E2ECrypto.decryptMediaFrame(...)`.
5. Render decrypted tracks to `<audio>` and `<video>` elements.

**Test (`tests/10-voice-media.spec.js`):**
```js
const { test, expect } = require('@playwright/test');

test('E2EE media flows between two participants', async ({ browser }) => {
  // Two contexts join voice channel
  // Use Chrome flags: --use-fake-device-for-media-stream --use-fake-ui-for-media-stream
  // Verify ontrack fires on receiver
  // Verify <video> or <audio> element has a srcObject
});
```

### STEP 11: Mute, Deafen, Camera, Screen Share UI
**Objective:** Implement the voice UI controls.
**Files:** `static/voice.js`, `static/chat.js`, `index.html`

**Detailed Instructions:**
1. **Mute:** Button toggles `audioTrack.enabled = false`. Broadcasts `voice_state_update { is_muted: true }`. UI updates to show mic-slash icon.
2. **Camera:** Button toggles `videoTrack.enabled = true/false`. Broadcasts `voice_state_update { is_camera_on: true }`. UI adds/removes user from video grid.
3. **Deafen:** Button sets `audioElement.muted = true` for all incoming tracks. Broadcasts `voice_state_update { is_deafened: true }`. UI shows headphone-slash icon.
4. **Screen Share:** Button calls `navigator.mediaDevices.getDisplayMedia()`. Adds track to PeerConnection. Broadcasts `voice_state_update { is_screen_sharing: true }`. UI moves user's video to a larger "Screen Share" view.

**Test (`tests/11-voice-ui.spec.js`):**
```js
const { test, expect } = require('@playwright/test');

test('mute and screen share UI works', async ({ browser }) => {
  // Two contexts (Alice and Bob) in voice channel
  // Alice clicks mute button
  // Verify Bob's UI shows Alice as muted (mic-slash icon appears)
  // Alice clicks screen share
  // Verify Bob's UI shows Alice's screen share video element
});
```

### STEP 12: Final Security Audit
**Objective:** Ensure no plaintext leaks and all features work together.
**Files:** `tests/12-audit.spec.js`

**Test (`tests/12-audit.spec.js`):**
```js
const { test, expect } = require('@playwright/test');

test('server DB contains zero plaintext messages, names, profiles, or file keys', async () => {
  const db = require('better-sqlite3')('data/e2e_talk.db');
  // Check messages
  const msgs = db.prepare("SELECT encrypted_content FROM messages").all();
  for (const m of msgs) expect(m.encrypted_content.toString('utf8')).not.toMatch(/hello|secret/i);
  
  // Check user_media (file keys must be wrapped)
  const media = db.prepare("SELECT encrypted_file_key FROM user_media").all();
  for (const m of media) expect(m.encrypted_file_key).toBeTruthy();

  // Check that forwarded messages have different ciphertexts
  const allMsgs = db.prepare("SELECT encrypted_content FROM messages UNION ALL SELECT encrypted_content FROM dm_messages").all();
  const uniqueCiphers = new Set(allMsgs.map(m => m.encrypted_content.toString('utf8')));
  expect(uniqueCiphers.size).toBe(allMsgs.length); // No two messages share the same ciphertext
  
  const servers = db.prepare("SELECT encrypted_name FROM servers").all();
  for (const s of servers) expect(s.encrypted_name.toString('utf8')).not.toMatch(/server|club/i);

  const users = db.prepare("SELECT encrypted_profile_data FROM users").all();
  for (const u of users) expect(u.encrypted_profile_data.toString('utf8')).not.toMatch(/alice|bob/i);
});

test('full E2E flow: register, friend, DM, server, voice', async ({ browser }) => {
  // Comprehensive test that exercises all features
  // Two users, full conversation, voice join, etc.
});
```

---

## 6. SUMMARY OF SIMPLIFICATIONS
1. **No Per-Device Keys:** Identity key is shared across all devices via password escrow. New devices instantly decrypt history by downloading the escrowed identity key.
2. **No Ratchets:** One symmetric `channelKey` per channel. Simpler, but no forward secrecy if key leaks.
3. **No Profile Tables:** Profile updates are bundled into messages and broadcasted via WS `profile_updated`. New devices fetch the latest message in a channel to bootstrap the profile cache.
4. **Native WebRTC E2EE:** Instead of complex SFrame libraries, we use the browser's native `setEncryptedTransform` API to encrypt media frames directly with the `channelKey`. This achieves full E2EE for voice/video with a fraction of the code.
```