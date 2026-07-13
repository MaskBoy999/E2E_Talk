# E2E Encrypted Chat App - Master Plan

> This file is the source of truth for the project. Do not modify unless explicitly requested.

---

## 1. Project Overview

A Discord-like end-to-end encrypted chat application using Tailscale for networking (no port forwarding). The server runs in the background and users access the app through their browser (Chrome, Firefox, etc.). All messages, files, and media are encrypted client-side — the host stores only ciphertext and cannot decrypt any content.

### Core Principles
- **E2E Encryption**: All content encrypted with Signal Protocol (X3DH + Double Ratchet + Sender Keys)
- **Zero-Knowledge Host**: Server stores only encrypted data, cannot read messages/files
- **Tailscale Networking**: All devices on a virtual LAN, no port forwarding needed
- **Web-Based Client**: Plain HTML + vanilla JS served by the Rust server. No Electron, no build tools.
- **Feature Parity with Discord**: Servers, channels, DMs, voice, file sharing, roles, permissions

---

## 2. Tech Stack

| Layer | Technology | Version | Rationale |
|---|---|---|---|
| Host Server | Rust + Axum | axum 0.8 | Fast, memory-safe, excellent crypto ecosystem |
| Client | HTML + vanilla JS | ES2022 | Zero build step, served as static files by Axum |
| Encryption | Signal Protocol (libsignal) | v0.94.1 | Industry standard E2E with forward secrecy |
| Voice | WebRTC | browser native | Standard peer-to-peer voice via Tailscale |
| Database | SQLite (rusqlite) | v0.40 | Zero setup, bundled, sufficient for single-host |
| Networking | Tailscale VPN | latest | No port forwarding, all devices on virtual LAN |

---

## 3. Architecture

```
┌──────────────────────┐     Tailscale VPN      ┌──────────────────────┐
│     Host Device      │◄──────────────────────►│    User Device 1     │
│    (Rust Server)     │                         │   (Chrome Browser)   │
│                      │                         └──────────────────────┘
│  - HTTP Server       │     Tailscale VPN
│  - WebSocket Server  │◄──────────────────────►┌──────────────────────┐
│  - Signal Protocol   │                         │    User Device 2     │
│  - SQLite DB         │     Tailscale VPN      │   (Chrome Browser)   │
│  - File Storage      │◄──────────────────────►└──────────────────────┘
│  - Static Files      │                              ... more users
│  - WebRTC Signaling  │
└──────────────────────┘
```

### How it works
1. Rust server runs in background, serves web frontend + API + WebSocket
2. User opens browser, navigates to `http://[tailscale-ip]:3000`
3. Login/register page loads, user authenticates
4. WebSocket connects for real-time messaging
5. All crypto happens in browser (JS) — server never sees plaintext

---

## 4. Encryption Architecture

### 4.1 Signal Protocol Stack
```
Identity Key (Ed25519) ─── Long-term, per-user
       │
Signed PreKey (X25519) ─── Rotated periodically
       │
One-Time PreKeys (X25519) ─── Consumed on use
       │
X3DH Key Agreement ─── Initial session setup
       │
Double Ratchet ─── Per-message key evolution
       │
Sender Keys ─── Group message encryption
```

### 4.2 Key Flow
1. User generates Identity Key (Ed25519), uploads public key + Signed PreKey + batch of One-Time PreKeys to host
2. To start a session: X3DH key agreement using recipient's prekeys
3. Each message: Double Ratchet advances, deriving new message key
4. Group messages: Sender generates SenderKey, distributes to members encrypted with their sessions
5. Host stores only ciphertext — cannot decrypt

### 4.3 Symmetric Encryption
- **Messages**: XChaCha20-Poly1305 (via Signal Protocol)
- **Files**: XChaCha20-Poly1305 Streaming AEAD (chunk-based, bounded memory)
- **Local Storage**: AES-256-GCM for key storage encryption

---

## 5. Project Structure

```
E2E-Chat/
├── PLAN.md                              # This file - master reference
├── server/                              # Rust host server
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs                      # Entry point, server startup, routes
│   │   ├── config.rs                    # Configuration (port, DB path, JWT secret, admin password)
│   │   ├── db.rs                        # All DB logic (users, channels, messages, admin)
│   │   ├── auth.rs                      # Registration, login, JWT
│   │   ├── handlers.rs                  # HTTP handlers (register, login, admin, channels, messages)
│   │   ├── ws.rs                        # WebSocket connection manager, message routing, broadcast
│   │   └── crypto.rs                    # Server-side crypto helpers (Phase 2+)
│   └── migrations/
│       └── 001_initial.sql
│
├── static/                              # Web frontend (served by Axum)
│   ├── index.html                       # Main chat UI
│   ├── login.html                       # Login/register page
│   ├── admin.html                       # Host admin panel (password-protected)
│   ├── style.css                        # All styles
│   ├── app.js                           # Main app logic
│   ├── auth.js                          # Login/register API calls
│   ├── chat.js                          # Chat functionality (WebSocket, messages)
│   ├── admin.js                         # Admin panel logic (list users, delete)
│   └── crypto.js                        # Signal Protocol client-side (Phase 2+)
```

---

## 6. Database Schema (SQLite)

```sql
-- Users & Authentication
CREATE TABLE users (
    id TEXT PRIMARY KEY,                -- UUID
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,        -- Argon2id
    identity_key_public BLOB,           -- Ed25519 public key (Phase 2+)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Signal Protocol PreKeys (Phase 2+)
CREATE TABLE prekey_bundles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    signed_prekey_public BLOB NOT NULL,
    signed_prekey_signature BLOB NOT NULL,
    one_time_prekey_public BLOB,
    one_time_prekey_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sessions (Signal Protocol) (Phase 2+)
CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    our_user_id TEXT NOT NULL REFERENCES users(id),
    their_user_id TEXT NOT NULL REFERENCES users(id),
    session_data BLOB NOT NULL,
    ratchet_counter INTEGER DEFAULT 0,
    UNIQUE(our_user_id, their_user_id)
);

-- Servers (Phase 3+)
CREATE TABLE servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Channels within servers (Phase 3+)
CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id),
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('text', 'voice')),
    encrypted_channel_key BLOB,
    position INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Server members (Phase 3+)
CREATE TABLE server_members (
    user_id TEXT NOT NULL REFERENCES users(id),
    server_id TEXT NOT NULL REFERENCES servers(id),
    role TEXT DEFAULT 'member',
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, server_id)
);

-- Messages (Phase 1: plaintext, Phase 2+: encrypted)
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id),
    sender_id TEXT NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,              -- Phase 1: plaintext. Phase 2+: encrypted_content BLOB + nonce
    content_type TEXT DEFAULT 'text',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Direct messages (Phase 4+)
CREATE TABLE dm_channels (
    id TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE dm_members (
    dm_channel_id TEXT NOT NULL REFERENCES dm_channels(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    PRIMARY KEY (dm_channel_id, user_id)
);

-- Encrypted files (Phase 5+)
CREATE TABLE files (
    id TEXT PRIMARY KEY,
    uploader_id TEXT NOT NULL REFERENCES users(id),
    channel_id TEXT,
    dm_channel_id TEXT,
    encrypted_filename TEXT NOT NULL,
    encrypted_file_key BLOB NOT NULL,
    file_size INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    upload_complete BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Voice channel participants (Phase 6+)
CREATE TABLE voice_participants (
    channel_id TEXT NOT NULL REFERENCES channels(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (channel_id, user_id)
);
```

---

## 7. WebSocket Protocol & API

All real-time communication uses a single WebSocket connection per client with typed JSON messages.

### REST API

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | /api/register | No | Create account (username + password) |
| POST | /api/login | No | Login, returns JWT |
| GET | /api/channels | No | List all channels |
| GET | /api/channels/:id/messages | No | List messages in channel |
| POST | /api/admin/login | No | Admin login (password only) |
| GET | /api/admin/users | No | List all users (admin) |
| DELETE | /api/admin/users/:id | No | Delete user + messages (admin) |

### WebSocket Messages

##### Client → Server
```json
{ "type": "auth", "token": "jwt..." }
{ "type": "message_send", "channel_id": "...", "content": "hello" }
{ "type": "dm_send", "dm_channel_id": "...", "content": "hello" }
{ "type": "file_init", "channel_id": "...", "filename": "...", "size": 1234, "mime": "image/png" }
{ "type": "file_chunk", "file_id": "...", "chunk_index": 0, "data": "base64..." }
{ "type": "file_complete", "file_id": "..." }
{ "type": "key_upload", "prekey_bundle": {} }
{ "type": "session_request", "target_user_id": "..." }
{ "type": "voice_offer", "target_user_id": "...", "offer": "..." }
{ "type": "voice_answer", "target_user_id": "...", "answer": "..." }
{ "type": "voice_ice", "target_user_id": "...", "candidate": "..." }
{ "type": "presence_update", "status": "online" }
```

> **Phase 2 change**: `content` will become `encrypted` + `nonce` fields. Server never sees plaintext.

#### Server → Client
```json
{ "type": "auth_ok", "user_id": "...", "username": "..." }
{ "type": "auth_error", "error": "..." }
{ "type": "message_new", "channel_id": "...", "message": { "id", "channel_id", "sender_id", "sender_username", "content", "timestamp" } }
{ "type": "dm_new", "dm_channel_id": "...", "message": {} }
{ "type": "file_available", "file": {} }
{ "type": "file_chunk_ready", "file_id": "...", "chunk_index": 0, "data": "..." }
{ "type": "key_bundle", "user_id": "...", "bundle": {} }
{ "type": "session_created", "target_user_id": "...", "session": {} }
{ "type": "voice_offer", "from_user_id": "...", "offer": "..." }
{ "type": "voice_answer", "from_user_id": "...", "answer": "..." }
{ "type": "voice_ice", "from_user_id": "...", "candidate": "..." }
{ "type": "presence", "user_id": "...", "status": "..." }
{ "type": "error", "code": "...", "message": "..." }
```

> **Phase 2 change**: `message.content` will be ciphertext. Client decrypts locally. Server only forwards it.

---

## 8. Implementation Phases

> **Design rule**: Each phase ends with a working, testable application. Never leave things in a broken state. Complete one phase fully before starting the next.
>
> **Encryption note**: In Phase 1, messages are stored as plaintext on the server for simplicity. Phase 2 will switch to E2E encryption where the server only stores ciphertext and sender info (who sent it, when), never the actual message content. All future phases must keep this in mind — the `content` field in messages will become `encrypted_content` and the server will never be able to read it.

### Phase 1: Plaintext Chat + Host Admin ← COMPLETE
> Goal: Two users with accounts can send and see plaintext messages in real time. Host can manage accounts.

- [x] 1.1 Initialize Rust project (Cargo.toml, main.rs, Axum server serving static files)
- [x] 1.2 SQLite setup: users table, run migrations
- [x] 1.3 POST /register — create user with Argon2id password hash (username + password, no email)
- [x] 1.4 POST /login — verify credentials, return JWT
- [x] 1.5 WebSocket endpoint — client authenticates with JWT, stays connected
- [x] 1.6 WebSocket message routing — broadcast messages to all connected clients
- [x] 1.7 HTML/JS: login page (login.html), register form, store JWT in localStorage
- [x] 1.8 HTML/JS: chat page (index.html) — message input, message list, send/receive in real time
- [x] 1.9 Default "general" channel auto-created on first run
- [x] 1.10 Host admin panel (admin.html) — password-protected, lists all users, delete user + messages with confirmation
- [x] 1.11 Multiple connections per user (multiple tabs/browsers work)
- [x] 1.12 Mobile responsive UI — slide-out sidebar, hamburger menu, touch-friendly, iOS zoom prevention
- [x] 1.13 Admin link accessible from login page (no account needed)
- [x] **TEST**: Two browser tabs, two users, messages appear in real time. Admin can delete users. Works on phone via Tailscale.
- [ ] **TODO for Phase 2**: Change `content TEXT` to `encrypted_content BLOB` in messages table. Server stores only ciphertext + sender ID. Client encrypts before send, decrypts after receive.

### Phase 2: E2E Encryption (Signal Protocol) ← COMPLETE
> Goal: Same chat as Phase 1, but all messages are encrypted. Server stores only ciphertext + sender identity, never the actual message content.

**Critical**: When implementing this, the server's `messages` table will change from storing plaintext `content` to storing `encrypted_content` (BLOB) + `nonce`. The server will never see the actual message — only who sent it and when.

- [x] 2.1 DB schema: `encrypted_content BLOB` + `nonce BLOB` columns, prekey_bundles table, sessions table
- [x] 2.2 Server: `save_encrypted_message()`, `save_prekey_bundle()`, `get_prekey_bundle()`, `consume_one_time_prekey()`, `save_session()`, `get_session()`, `update_session_ratchet()`
- [x] 2.3 Server: WebSocket handler accepts `encrypted_content` + `nonce` (base64), stores raw bytes, broadcasts to all clients
- [x] 2.4 Server: REST endpoints `GET /api/keys/{user_id}`, `GET /api/user/{username}`
- [x] 2.5 Client-side: `crypto.js` — ECDH key pair generation, AES-256-GCM encrypt/decrypt, HKDF key derivation
- [x] 2.6 Client-side: `chat.js` — encrypts on send, decrypts on receive, key bundle upload via WebSocket
- [ ] 2.7 **TEST**: Two users exchange encrypted messages. Verify server DB shows ciphertext, not plaintext.
- [ ] 2.8 Verify: all existing tests still pass with encrypted message format

### Phase 3: Servers and Channels ← COMPLETE
> Goal: Discord-like server/channel system. Users can create servers, add channels, switch between them.

- [x] 3.1 Server CRUD: create server, join server, leave server, list servers
- [x] 3.2 Channel CRUD: create text channel, delete channel, list channels in server
- [x] 3.3 Server member management: invite user, kick user
- [x] 3.4 HTML/JS: server sidebar (list of servers)
- [x] 3.5 HTML/JS: channel list (channels within selected server)
- [x] 3.6 HTML/JS: channel switching — load messages for selected channel
- [x] 3.7 Channel permissions (read/write)
- [x] **TEST**: Create a server, add channels, invite another user, switch channels. Messages load per channel.

### Phase 4: Direct Messages ← COMPLETE
> Goal: Users can DM each other privately.

- [x] 4.1 DM channel creation between two users
- [x] 4.2 DM message send/receive (reuse Signal sessions)
- [x] 4.3 HTML/JS: DM conversation list (sidebar)
- [x] 4.4 HTML/JS: DM chat view
- [x] **TEST**: Open DM with another user, send messages back and forth.

### Phase 5: File Sharing
> Goal: Users can share encrypted files in channels and DMs.

- [ ] 5.1 File upload with XChaCha20-Poly1305 encryption (chunked)
- [ ] 5.2 File download + decrypt
- [ ] 5.3 HTML/JS: upload button, progress bar, download button
- [ ] 5.4 Image/video preview in chat
- [ ] **TEST**: Upload an image, see it in chat, download and verify.

### Phase 6: HTTPS with mkcert
> Goal: Serve the app over HTTPS using a local CA (mkcert) for secure WebRTC, microphone access, and clipboard APIs.

- [ ] 6.1 Install mkcert automatically via script (detect OS, install if missing)
- [ ] 6.2 Generate and trust local CA certificate via mkcert
- [ ] 6.3 Generate server certificate for the Tailscale IP / hostname
- [ ] 6.4 Update Rust server to load TLS certs and serve HTTPS
- [ ] 6.5 Update start-server.bat to run mkcert setup before launching
- [ ] 6.6 Update WebSocket endpoint to use WSS (secure WebSocket)
- [ ] **TEST**: Server serves HTTPS, browser connects without security warning, WebSocket works over WSS.

### Phase 7: Voice Channels
> Goal: Users can join voice channels and talk to each other.

- [ ] 7.1 WebRTC signaling through host (offer/answer/ICE candidates via WebSocket over WSS)
- [ ] 7.2 Audio capture (browser getUserMedia) + playback
- [ ] 7.3 HTML/JS: voice channel join/leave, mute/unmute
- [ ] **TEST**: Two users in same voice channel can hear each other.

### Phase 8: Polish
> Goal: Production-quality experience.

- [ ] Online status (online, idle, do not disturb, offline)
- [ ] Typing indicators
- [ ] Message reactions (emoji)
- [ ] Message editing and deletion
- [ ] User profiles and avatars (encrypted)
- [ ] Notifications (browser notifications)
- [ ] Search messages (client-side, decrypted)
- [ ] Dark/light theme
- [ ] Channel permissions (admin, moderator, member roles)

---

## 9. Dependencies

### Rust (server/Cargo.toml)
```toml
[dependencies]
axum = { version = "0.8", features = ["ws"] }
tokio = { version = "1", features = ["full"] }
rusqlite = { version = "0.40", features = ["bundled"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
uuid = { version = "1", features = ["v4"] }
chrono = { version = "0.4", features = ["serde"] }
jsonwebtoken = "9"
argon2 = "0.5"
tower-http = { version = "0.6", features = ["cors", "fs"] }
tracing = "0.1"
tracing-subscriber = "0.3"
```

### Client (static/)
No dependencies. Plain HTML + vanilla JS. Served as static files by Axum.

---

## 10. Security Properties

| Property | Guarantee |
|---|---|
| **Confidentiality** | All messages encrypted with XChaCha20-Poly1305, keys never leave clients |
| **Forward Secrecy** | Double Ratchet ensures compromise of current key doesn't expose past messages |
| **Future Secrecy** | Ratcheting also protects future messages if a key is compromised |
| **Group Security** | Sender Keys with per-member distribution, key rotation on member leave |
| **File Security** | Each file encrypted with unique key, key distributed to authorized recipients only |
| **At-Rest Security** | Host database contains only ciphertext, useless without client keys |
| **Authentication** | Argon2id password hashing, JWT tokens for session management |
| **Identity** | Ed25519 identity keys bound to user accounts |

---

## 11. Decisions Log

| Date | Decision | Reason |
|---|---|---|
| 2026-07-11 | Rust for backend | Best crypto libraries, speed, memory safety |
| 2026-07-11 | Plain HTML + vanilla JS for client | Zero build step, no Node.js, fastest to iterate |
| 2026-07-11 | SQLite for DB | Zero setup, bundled, sufficient for single-host |
| 2026-07-11 | Signal Protocol for E2E | Industry standard, forward secrecy, group support |
| 2026-07-11 | Axum for web framework | Tokio-team recommended, built-in WebSocket support |
| 2026-07-11 | Tailscale for networking | No port forwarding, virtual LAN |
| 2026-07-11 | Web-based client (no Electron) | Smaller app, no packaging, runs in any browser |
| 2026-07-11 | Incremental phases | Previous approach crashed from doing too much at once |
| 2026-07-11 | Host admin panel | Password-protected, manage users, delete accounts + messages |
| 2026-07-11 | No email required | LAN app with friends, username is enough |
| 2026-07-11 | Phase 1 plaintext first | Get messaging working before adding encryption complexity |
| 2026-07-11 | Phase 2 server stores ciphertext only | `encrypted_content BLOB` + `nonce BLOB` columns, server never sees plaintext |
| 2026-07-11 | Per-channel AES-256-GCM encryption | Simplified model: channel key derived from channel ID + identity salt |
