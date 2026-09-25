# E2E Chat

An end-to-end encrypted chat app — direct messages, servers, voice/video calls,
screen share and a soundboard — that runs against **your own server**. Messages,
files, profiles, calls and sounds are encrypted on your devices; the server is a
ciphertext relay that routes, stores and moderates — it never sees content.

| | |
|---|---|
| **Desktop app** (Windows / Linux) | A native Tauri window with a tray, auto-start, native notifications, a global push-to-talk key, deep links and an always-on-top mini call window. |
| **Android app** (Android 10+) | Background calls with the screen off, a full-screen incoming-call ring, a Quick Settings tile, picture-in-picture and on-device captions. |
| **Browser (PWA)** | Open your server's address directly — installable, with Web Push. Works everywhere, degrading gracefully where a native feature doesn't exist. |

---

## Security & encryption

**The model:** you run the server (typically over Tailscale with a self-signed
certificate). Everything a user *produces* — words, names, files, media — is
encrypted on the client before it leaves. The server's job is routing,
authorization, moderation and ordering; it does those on metadata, on
ciphertext, or on values the client derives for it. The sections below are
honest about both sides: what is hidden, what is not, and *why*.

### How your data is encrypted — layer by layer

| Layer | Protection | How it works |
|---|---|---|
| **Transport** | TLS to your server | The server serves TLS on `:3443` with a self-signed certificate. The desktop/Android box does **trust-on-first-use**: the first certificate's SHA-256 fingerprint is pinned in your config, every launch re-probes it, and a changed fingerprint **refuses to open the window** (with a re-trust path in Setup for deliberate rotations). |
| **Your password** | Argon2id + HMAC verifier | Your raw password is never stored, and for new accounts never even sent: the client derives a key from it (Argon2id, libsodium `crypto_pwhash`, moderate ops/memory) and sends an HMAC verifier; the server keeps only an Argon2id hash of that verifier plus your key material **encrypted under your password**. Legacy accounts are upgraded to this scheme on first login. |
| **Message content** | XChaCha20-Poly1305 AEAD | Every message is sealed under its conversation's key with a random nonce, associated data binding it to its channel, and **length padding** so ciphertext size doesn't leak message length. |
| **Key hierarchy** | X25519 identity root | One X25519 identity keypair per account is the root of trust. **DM key** = `HKDF(ECDH(you, peer), "dm-channel:<id>")` — the server never sees the shared secret. **Server key** = random 32 bytes per server with rotation history, shared to members. **Voice room key** = `HMAC(serverKey, "voice:<channelId>")` (or from the DM key). Keys are backed up in a password-encrypted blob you control. |
| **Files & attachments** | Per-file key, chunked AEAD | Files are (optionally compressed then) split into 64 KB chunks, each chunk encrypted under a fresh per-file key with the chunk index bound in; the key travels inside the encrypted message. Downloads use a **blind hash handle**, so the file-id↔uploader link isn't in the clear for new data. |
| **Profiles & display names** | Encrypted profile blobs | Display names, bios, avatars and banners are per-conversation encrypted blobs with profile-data keys shared through the same key exchange — the server stores `encrypted_pic_key`-style columns, never the readable value. **Channel, server and category names are stored as `encrypted_name`** — the plaintext columns were removed from the schema entirely. |
| **Voice / video / screen** | Per-frame AES-256-GCM | Every media track runs through WebRTC insertable streams (`e2ee-worker.js`): frames on the wire are `[12-byte nonce][AES-256-GCM]` under a key that only room members hold — the server relays media it cannot read. **SDP/ICE signaling is encrypted too**, under a *different* subkey, with **downgrade protection**: once a signaling key exists, plaintext signals are dropped, so the server can't strip the envelope. If a browser lacks transform support, the app says so out loud instead of silently sending clear media. |
| **Ringtones & notification sounds** | ECDH envelope | Uploaded sounds are sealed to your identity keys and their filenames are themselves encrypted (AES-GCM under `SHA-256(public key)`) — they sync across your devices without the server reading them. |
| **Push notifications** | RFC 8291 / identity-free FCM | Web Push payloads are additionally encrypted to your subscription key (the push service carries bytes it can't read). The optional Android FCM leg is deliberately identity-free ("E2E Chat" / "New message"), because FCM blocks travel plaintext through Google. Offline notification copies are sealed to your identity key. |
| **Search** | Blind tokens or nothing | Server-side search matches **HMAC tokens** (the server compares opaque tokens, never your words). With *Search only this device* on, queries go to a local FTS5 index and **nothing is transmitted at all** — no query tokens, no message ids. |
| **Storage on your device** | XChaCha20-Poly1305 + Argon2id vault | `secure-storage.js` transparently encrypts sensitive `localStorage` keys under a password/session-derived key. The password bootstrap was replaced by an **Argon2id key vault** (delete-after-migrate — no old readable copy is left beside the new one), with the live session's password sealed as ciphertext in a session ticket. The **password is the only way into that vault** — there is no biometric seal to release it — and whether the app asks for that password after a restart is itself a setting (Security → **Key Vault**, on by default). |
| **Sessions** | Per-device JWT + server-side rows | Each device gets its own revocable session (`auth_sessions`), duration clamped 60 s–30 days, renewed by a heartbeat — and listed in **Settings → Security → Devices** where any of them can be force-kicked, everywhere, including calls. |
| **Key backups** | Password-encrypted before upload | The key blob (identity, server keys, media caches, friend code) is auto-created at registration and encrypted under your password **before** upload; restoring needs the password. |

### What the server can NEVER see

- Message and DM content (text, edits, replies, polls, scheduled payloads)
- File and image contents (chunked AEAD; keys ride inside encrypted messages)
- Display names, bios, avatars, banners (per-conversation encrypted blobs)
- **Channel, server and category names** (encrypted at rest, plaintext column removed)
- Ringtone / notification-sound bytes *and their filenames*
- Voice, video and screen-share **frames** — and the SDP/ICE signaling itself
- Push payload content (RFC 8291) and offline notification payloads
- Your password (Argon2id of an HMAC verifier — not the password)
- Your search words in device-only mode (nothing is sent at all)
- Profile pictures' and banners' encryption keys (stored wrapped)
- Anything on your device: local search index (ciphertext, bounded, wiped by
  panic wipe), captions (display-only, never written or transmitted), the
  vault or the session ticket

### What the server DOES see — and why

This is the honest metadata boundary. Each row is visible **by necessity** —
the server's core job (routing, authorization, moderation, ordering) requires
reading the value; hiding it would mean redesigning the client-server model,
not a missing feature:

| Server sees | Why it must |
|---|---|
| **Your username** (`@name`) | It's your public handle — login needs a server-side index, and you type it at the login prompt, so the host receives it regardless. **Display names are E2EE**; the username is the only plaintext identity string. |
| User id, your **public** key | Public keys are meant to be public; ids are how the server addresses you. |
| The **social graph** (friendships, DM membership, friend requests) | The server is the authorization layer: it must decide "may these two users DM, call, see a profile" before routing anything. |
| **Routing ids** (channel / server / message ids) and **timestamps** | Routing, storage, pagination, ordering, "edited" rendering — every messenger keeps these. |
| **Presence & call state** (online, who is in which voice room, mute/deafen/camera/screen flags, ring/accept/decline) | Real-time member lists, moderation (server force-mute/deafen is enforced server-side) and call routing need it. |
| Channel **type** (text/voice), position, invite state | A voice join must be routed to a voice channel; lists must render. Invites are stored as **hash + salt**, never the code. |
| File size, chunk count, uploader, storage quota fields | Resumable uploads and quota enforcement. |
| Device names / session metadata in your Devices panel | You need the list to revoke sessions; the device id is the revoke key. |
| Notification *type* + recipient (not content) | Dispatching the notification. Payloads themselves are encrypted. |
| Moderation state (bans, roles, voice sanctions), admin audit rows (actor/action/target; **IPs behind a redaction toggle**) | The server enforces moderation and keeps its own audit. |
| IPs and timing (TLS endpoint, relay) | Unavoidable for delivery; a TURN relay correlates IPs by definition — standard WebRTC reality. |
| URLs you ask to preview | Link previews are fetched server-side (that fetch is the feature). |

### Security features

- **Two-factor (TOTP)** — authenticator apps, 8 one-time recovery codes,
  enforced at login; admins can enroll 2FA too and force-disable a user's.
- **Kill switch (decoy password)** — set a *second* password: entered instead
  of your real one, it **deletes the account and all its data on the spot**
  (with 2FA on, it still demands the code, so the login looks like a plain
  failure). Off by default.
- **Self-destruct** — auto-delete your account after N days of inactivity. Off
  by default.
- **Panic wipe / auto-lock** — `Alt+Shift+W` wipes *everything* instantly (no
  confirmation); an idle timer (default OFF) does the same past your chosen
  minutes — keys, logins, settings, caches **and the local search index**. The
  hand-operated routes are that chord and **Clear All Data & Sign Out**; there
  is no separate "wipe now" button, so there is nothing to be talked into
  clicking in a hurry.
- **Devices panel** — see every signed-in session; force-sign-out any of them,
  kicked everywhere immediately including voice calls.
- **Session & security log** — a record of account events in Settings.
- **Change password** — re-locks the same keys (identity unaffected), kicks
  every other device.
- **No biometric unlock** — deliberately removed. Sealing the storage
  password under the phone's secure hardware added a credential release path
  (and a Keystore key) outside the password, so the login page and the vault
  lock screen now take the password only. A seal left by an older build is
  wiped rather than honoured.
- **Key vault: ask after a restart, or don't** — the vault seals the storage
  key under your password (Argon2id + XChaCha20-Poly1305), so a new tab or a
  restarted app stops at **Unlock your key vault** and nothing is readable on
  the device until you type it. That is the default because it is the
  strongest, and it is now a **setting** (Security → Key Vault) for anyone who
  won't pay the password on every restart.
  Changing the setting is **password-gated in both directions**: a modal asks
  for your password, it is checked against this device's vault, and every value
  stored on the device is then re-encrypted with the key that password releases
  (a no-op when it is already that key) before the setting moves. A wrong or
  cancelled password changes nothing — no flag, no key, no re-encryption.
  Switched off, the app keeps that same key on the device, so a restart opens
  straight into the app: same socket, same session, and the flows that want the
  password itself still get it from the vault ticket without you typing it. The
  trade-off is stated in the panel and here — with it off, anyone who can read
  this browser profile / app storage (a local attacker, another app, a backup)
  can decrypt the stored session **without** your password. Turning it back on
  deletes that key copy and restores the lock screen; the copy never survives a
  sign-out (the login page's wipe takes it), and a panic wipe resets the
  preference to the safe default.
- **Device verification (SAS)** — both devices derive the same emoji+digit
  string so you can confirm you're talking to your own key; marking verified
  pins it and a later key change warns. Shown **in-app only** — never in a
  notification or on a lock screen.
- **Local export, with or without a passphrase** — pick in the export dialog:
  a sealed `e2e-chat-export.enc` (Argon2id + passphrase; opaque bytes, no
  session credentials inside), or a deliberately plain
  `e2e-chat-export.json` that says **UNENCRYPTED** inside the file itself. Both
  hold identity keys, settings, metadata and recent messages — the choice is
  the same one the appearance backup and the admin database export offer, and
  the plain path is offered with its consequence stated out loud.
- **Server-side data export** — a plain JSON copy of what the server holds
  (`/api/me/export`)
- **TOFU certificate pinning + navigation allowlist** — the box only ever
  loads your configured origin and its own bundled pages; external links open
  in your system browser; IPC is capability-gated (no shell execution, and
  commands are granted only to your server's origin).
- **No auto-updater — by design.** An update manifest is a new trust root for
  a product whose whole story is pinning; updates are manual re-downloads.
- **Rate limiting everywhere** — registration, login, 2FA, friend requests,
  search, admin, mutations, server creation; voice signaling 300 msgs/10 s.
- **XSS is escaped on every plaintext field** (audited by test), security
  headers are asserted by test, and the admin audit log supports IP
  redaction.
- **Block users**, **disable incoming friend requests**, and **hide message
  content in notifications** (blanks the sender too, and governs the native
  Android ring in both lock states).
- **Notification hygiene** — the notification funnel only ever carries
  server-known metadata (generic words, `@username`, counts): a decrypted
  channel name never reaches an OS notification, Android cards are cancelled
  by id when done, and desktop toasts expire instead of accumulating in the
  Action Center database.
- **Admin sees ciphertext for content** — the admin panel lists metadata and
  encrypted rows; you are the operator, so the host is trusted for
  availability, not for content.

---

## Features

### Messaging & conversations

- Direct messages (1:1) and **server text channels**, all end-to-end encrypted
- **Edit** and **delete** messages (edit state persists across reloads)
- **Reply** — with notification reply-redirect: tapping the notification lands
  you *on the replied-to message*, highlighted
- **Forward** messages (shown with channel/server badges; emoji references
  survive forwarding)
- **Reactions** and **custom emoji** (own emoji tab; forwarded custom emoji fixed)
- **@mentions** with autocomplete (by display name), a **mentions inbox** with
  sender avatars, and per-item sender tracking (`sender_id_hash` on the wire,
  not the raw id)
- **Typing indicators** (ephemeral — never stored)
- **Message pinning** — per channel and per DM (owner-only in servers), a
  pinned-state indicator and jump-to-pin that lands accurately
- **Threads** — per-parent thread view alongside categories
- **Polls** — created from the composer's `+` popup
- **Scheduled messages** — a schedule modal with validation; stored encrypted
  locally as pending messages you can cancel or delay; the scheduler sends
  them (encrypted) at the chosen time
- **Disappearing messages** — per-conversation TTL with a live countdown on
  both sides; the server **shreds the row** (and the attachment's file record
  + chunks) on expiry and every client removes it live; out-of-bounds TTLs are
  rejected; armed state shows a badge in the composer
- **Delivered ✓ / read ✓✓ status** — auto-acked when the recipient views the
  chat, three states, survives reload; hovering ✓✓ names the readers (DMs) or
  counts them (channels); Display setting switches always / hover (default) /
  off; non-member acks are dropped server-side
- **Message timestamps** — always / hover (default, no layout shift) / off
- **Unread badges and mention badges**, cleared on open; muted servers and
  channels don't update badges
- **Infinite scroll** (`loadOlderMessages`) and jump-to-message around any id
- **Search** — DM list search by display name, channel search, and a global
  palette (`Ctrl+K`) backed either by blind-token server search or the
  **device-only local index** (a Settings toggle; sends nothing)
- **Link previews** (server-side fetch) and **media previews** with a
  *Load preview* button mode for slow connections
- **Block users** and **disable incoming friend requests**

### Servers, channels, roles & moderation

- Create servers, join by **invite code** (stored as hash + salt), leave,
  delete; every new server gets a **default voice channel**
- **Categories** with ordered channels; **text and voice channel types**;
  right-click channel → **mute** (no notifications, no badges)
- **Server folders/groups** — group servers in the rail, expand/collapse, with
  a collapsed preview showing mini icons of the servers inside
- **Drag-to-reorder** for the server rail and the DM list
- **Roles & permission tiers** — role creation, permission matrix UI, drag
  ordering, role colors on the rail/avatars, a *grant all permissions* toggle;
  owner checks are enforced **server-side**, never trusted from the client
- **Moderation** — bans, kicks, channel deletion, **voice sanctions** (server
  force-mute/deafen that the relay enforces — a force-muted member's frames
  aren't forwarded), *disable new joins* server toggle, per-member soundboard
  disable (owner only)
- **Server settings** — icon/picture (encrypted key), join policy, member and
  role management

### Friends, profiles & privacy

- Friend requests (send/accept/decline), **remove friend**, online list
- **Friend code** — stored **encrypted** on the server, with password-protected
  recovery and password-based regeneration (never plaintext via the API)
- **Profile** — avatar with crop-modal upload, banner, bio, username **color
  picker** with contrast-aware glow; display name shown per conversation
- Profile modal opens from avatars anywhere (sidebar, messages, voice tiles,
  DM header), **live-refreshes** across devices, prefetches and persists
- **Conversation-specific profiles** — per-DM/server profile overrides, stored
  as encrypted blobs with shared data keys
- **QR code key transfer** and **device pairing** (short-lived 5-minute
  pairing tickets) — move keys to a new device without the server reading them

### Voice & video calls

- **Voice channels** (Discord-style: join/leave, live member facepile,
  sanctions persist) and **DM calls** — ring, accept, decline (the shade's
  Decline actually declines), wait/queue, **mutual callback auto-connects**,
  accept-while-busy handling, unfriending ends the call
- **Call indicators everywhere** — DM list, a persistent DM strip visible from
  any view, server rail, pulsing ring badge, haptic cues on new rings and
  waiting flips (patterns configurable)
- **Mesh WebRTC** with relay fallback; **per-member video loading** (don't
  load every feed unless you want it), per-receiver send gating
- **End-to-end encrypted at every layer** — per-frame AES-256-GCM media,
  encrypted SDP/ICE signaling with downgrade protection (see Security above)
- **Noise suppression (RNNoise)** with a hardened worklet, **echo cancellation**
  toggle, **Hear yourself** mic test, audio input device switch
- **Voice activation** — speak-only gate on the existing RNNoise chain: below
  the speech threshold your mic sends silence (keeps keyboards/TVs out of the
  room, saves bandwidth); needs an RNNoise mode
- **Hold to talk** — mic stays closed until you hold the call's mic button in
  any view; button lights while held; server mute wins over a held button
- **Global push-to-talk hotkey** (desktop) — default `Ctrl+Shift+Space`,
  configurable accelerator, validated in Rust, registers only while
  hold-to-talk is on
- **Mute / deafen** (local and server-enforced), per-member **volume control**
  0–100000% with custom boost input, reset buttons, right-click volume menu
  that stays open
- **Camera** — device picker, right-click per-viewer mirror/rotate, video-only
  view menu on your own tile, manual per-feed load/unload, **black-feed
  watchdog** (configurable) with a *Reconnecting video* indicator
- **Video quality settings** — per-direction resolution/FPS for camera and
  screen (capture follows Settings, 144p→4K), audio quality presets, screen
  audio quality presets
- **Screen share** — with **system audio** on desktop and Android
  (`AudioPlaybackCapture`; DRM apps exempt themselves), **per-app capture**
  picker on Android 14+, share sheet that asks *how* first, decode-artifact and
  keyframe-recovery handling, track classification
- **Fullscreen tiles** that survive re-renders, with right-click menus and a
  *Reset view* chip; **picture-in-picture** — desktop `?mini=1` always-on-top
  mini call window (main window drives its buttons) and Android's native
  activity PiP with correct rotation
- **Connection diagnostics** (Settings → Voice → Advanced) — live `getStats`:
  send/recv frames, packet loss, **E2EE transform counts**, per-peer
  **ping / rtt / jitter**, refreshable, reasons listed — no adb needed
- **Rejoin & heal** button, heartbeat refresh, grace-period + sweep lifecycle
  (refresh/tab close/server shutdown closes calls cleanly instead of ghosting)
- **Audio output routing** — speakers/headphones/wired/Bluetooth; on Android
  the phone's own call-audio routing (earpiece/speaker/BT), applied live
  without rejoining
- **Audio focus** — your music pauses when a call starts and resumes when it
  ends; **keep screen on** for exactly the call's length; **battery-optimization
  prompt** (once, via Android's own dialog) so Doze can't silently kill calls
- **Live captions** — an **offline** recogniser only (audio is never sent to an
  online speech service); display-only by default; publishing to the call is a
  separate opt-in riding the encrypted call channel; never written to disk,
  console or notifications
- **TURN relay with time-limited HMAC credentials** (per-session, expiring —
  not one standing shared password) plus a documented **coturn recipe**
  (`COTURN.md`) so calls survive mobile data
- **Incoming calls on Android** — full-screen ring over the lock screen with
  Answer/Decline, an **ongoing call card with Mute / Deafen / Hang up actions
  and a live duration**, ringer/DND-aware (no sound on silent, nothing under
  DND, re-read at ring start) with the app's own vibration pattern — and the
  card text comes from the room *type*, never a decrypted channel name

### Soundboard

- Upload audio **clips** and play them into the current voice room for everyone
- **Async playback** — survives mute/unmute (resumes), joining mid-play,
  **loop**, and stop; leaving the call stops your own sounds
- **Per-member mute and disable** — persists locally, syncs across reloads and
  devices, flips in place from the member menu; owners can disable a member's
  soundboard (non-owners can't)
- **Global disable** in Settings — blocks both sending and receiving (received
  plays are refused over the socket)
- **Device pairing** for clips on a second device (QR/pairing tickets), and a
  vault size display

### Notifications, sounds & haptics

- **Web Push** (VAPID, RFC 8291-encrypted payloads) for browsers and the PWA;
  service worker handles push, click-to-open and background sync; **optional
  Android FCM** (server-side ready, identity-free payloads) for app-closed
  delivery
- **Desktop native toasts** — expiring via a fixed tag + expiration time, so
  they leave the Action Center instead of accumulating; click focuses the
  right conversation
- **Android**: full-screen incoming-call intent (category CALL) with working
  Decline, ongoing call card with actions, per-id cancellation when done,
  silhouette icon, and the **Quick Settings tile** (literal labels only:
  Mute/Unmute/Answer — tile labels are an OS surface, so they're static by
  design)
- **Notification privacy is always on, on every device** — no setting, no
  toggle, nothing to leave switched off. Every notification says only *that*
  something happened (no sender, no channel or server, no message text), and it
  still deep-links to the right conversation. The same rule is enforced in the
  native layers: the Android ring card is name-free and lock-screen-private in
  **all** states, and the desktop toast gets the same generic text. The reason
  is durable: your OS stores what a notification says — Windows in its
  notification database, a phone in the shade and on the lock screen — so a
  decrypted preview handed over outlives the app.
- **Custom notification sound** — upload your own (30 s cap with a trim picker
  to choose the second to keep), **encrypted so it syncs across your devices**;
  same for **custom ringtones** for calls
- **Quiet hours** — chime and vibration obey the phone's ringer/DND state
  (silent phone: no sound, no buzz; DND: neither), re-read the moment a ring
  starts; Settings' *Test sound* deliberately bypasses the gate
- **Haptic patterns** — configurable vibration patterns for rings, waiting
  flips and notifications, with separate notification-vs-DM controls (Android
  uses the phone's real vibrator, since Chromium dropped the Vibration API in
  WebViews), battery-friendly cues
- **Background-only sound** mode, per-server/channel **mutes**, notification
  click → correct DM/channel (clearing badges + inbox), reply-redirect → the
  exact message

### Files, media & sharing

- **Chunked encrypted uploads** — compress → 64 KB AEAD chunks → resumable
  init/chunk/complete, storage quota enforced server-side, **by-hash
  download** as the public handle
- **Attach** — drag-and-drop, paste, file picker, **take photo** (with camera
  flash), **record video**, and **Snip screen region** (drag a region → lands
  in the composer queue, memory-only until you send)
- **Share into the app** (Android) — Gallery → Share → E2E Chat stages into
  the composer via a FIFO that's consumed once (empty FIFO = no-op)
- **Drag files out** (desktop) — drag an attachment to your desktop; the app
  hands the OS a download handle reusing the Save-as decryption (no new trust)
- **Copy any file to the clipboard** — right-click an attachment → *Copy file*
  puts the real decrypted file on your system clipboard, whatever its type (an
  `.exe`, `.zip`, `.pdf`). The app writes it into its own cache folder under its
  real name and hands the OS a file reference (Windows `CF_HDROP`, the macOS
  file pasteboard, X11/Wayland `text/uri-list`, an Android provider URI), because
  a browser's clipboard API accepts images and text only. One copy exists at a
  time — the next copy and the next launch delete the previous file — and there
  is deliberately **no** "paste a file from the clipboard": reading the host's
  clipboard would let any page in the app window see what you copied there
- **Photo/video editing** before send, **document preview**, image/video
  media previews with manual-load mode
- **Stickers & GIFs** — own sticker tab with upload, editable stickers (live
  edits propagate), GIF tab, emoji tab; downloaded media gets
  download/copy context menus
- **Appearance background photo** — a picture behind the whole app with
  per-section sliders, stored **only on that device**

### Search

- **Server-side E2EE search** — client builds blind HMAC tokens; the server
  matches tokens, never words
- **Device-only search** (`Search only this device`) — local FTS5 index:
  decrypted text indexed on-device, stored **ciphertext at rest**, bounded and
  rotating (oldest rotate out), **disappearing messages never indexed**,
  query never transmitted, and the index is destroyed by the panic wipe

### Appearance & customization

- **Theme mode** (dark/light), **accent color**, **background shade**, **app
  background photo** with per-section tuning
- **Appearance backup** — export accent/background/theme/background-photo to an
  **encrypted file** and import it; everything device-local, never on the
  server
- **Custom CSS** — textarea with save / preview / reset and **6 theme
  presets**, applied live, persisted locally
- **Streamer Mode** — hides all message content behind a *Reveal* button,
  disables DM sidebar previews and stops media auto-loading — for screenshares
  and streams
- **Display settings** — media previews, timestamp mode, message-status mode
- **A settings panel that matches itself** — the top tabs are spaced apart and
  scroll instead of squashing their labels into one word, and every checkbox
  and field in a panel comes from one shared style built on the theme tokens
  (the tokens those rows referenced used to be undefined, so they fell back to
  hard-coded greys and ignored your accent/background/folders entirely)
- **Keyboard shortcuts** tab — remap any action; **every mention of a shortcut
  re-renders from the live binding**, so the read-only list in Settings →
  Display and the search tooltip can never keep claiming an old key.
  `Ctrl+K` search palette, `Alt+Shift+W` panic chord, configurable PTT
  accelerator
- Per-user volume menus, per-viewer mirror/rotate, resizable call panel,
  fullscreen media viewer

### Accounts, sessions & data control

- Register / login (HMAC-verifier scheme above), per-username auth params
- **2FA** with 8 one-time recovery codes; admin 2FA; force-disable paths
- **Change password** (same keys, other devices kicked), **delete account**
  (with cascade stats confirmation), **logout wipes the login page's local
  state**
- **Session duration setting** (60 s–30 days, sliding renewal via heartbeat
  reauth), session expiry display, **Devices panel** with force-kick
- **Key blob** — auto-saved encrypted at login/registration, **multi-device
  sync** with stale-write rejection (converges, never last-write-wins),
  automatic rebuild when stale, **Restore from Server Backup** with your
  password (identity, server keys, media caches, friend code)
- **Kill switch**, **self-destruct**, **panic wipe / auto-lock** (see Security)
- **Export my data** (with or without a passphrase) + JSON data export (see
  Security)
- **Clear all local data** (keys, logins, settings, cookies) from Settings

### Desktop app — the "box"

- **First-run setup** — enter the server address (any host/port; defaults
  fill in), **Test connection** shows the certificate fingerprint, *Trust this
  server's certificate* pins it; later launches open directly; unreachable
  host on Android falls back to setup (never a blank error page)
- **System tray** — Show / Change Server Address… / Quit; the tooltip shows
  call state and unread **counts only** (never a name); close hides to tray
  (configurable); **auto-start** on login
- **In-app Settings → Connection** — change the server address from inside the
  app on any platform (opens the setup window on desktop, takes over the main
  window on Android)
- **Native notifications bridge** with the shim's cached-permission bug fixed
  (Windows resolves `denied`, Android staleness) — notifications actually
  appear and focus the window
- **Global push-to-talk hotkey**, **deep links** (`e2e-chat://channel/<id>` —
  ids only, in-scope only; rubbish routes and remote URLs are refused; paired
  with single-instance so a cold-start link lands in the running app),
  **always-on-top mini call window**, **drag files out**, **single instance**
- **Navigation allowlist** — the window only loads your configured origin, the
  app's own bundled pages, and local `blob:`/`data:`; anything else opens in
  your system browser
- Installers for **Windows (NSIS/MSI), Linux (AppImage, `.deb`, `.rpm`, Arch
  `.pkg.tar.zst`)**, each release with **SHA256SUMS** files; **manual updates
  by design** (no auto-updater)

### Android app

- **Universal APK** (arm64-v8a, armeabi-v7a, x86, x86_64), Android 10+ (minSdk 29)
- **Background calls** — a `phoneCall` foreground service keeps calls alive
  with the screen off (wake lock), the #1 way Android voice apps die is solved
- **Full-screen incoming-call ring** + Decline/Answer actions that really act,
  ongoing card with actions/duration, **Quick Settings tile**, **PiP**
- **Ringer/DND awareness** for every sound and haptic (see Notifications)
- **Battery-optimization prompt**, **keep-screen-on during calls**, **audio
  focus**, **audio routing** (earpiece/speaker/BT)
- **Screen share with system audio + per-app capture**, share sheet honoring
  Settings' resolution/FPS; **Share into the app** FIFO; take-photo flash
- **On-device captions**, **real-vibrator haptics**
- Media permissions (`RECORD_AUDIO`, `CAMERA`, `MODIFY_AUDIO_SETTINGS`),
  `POST_NOTIFICATIONS` runtime prompt, silhouette notification icons — all
  declared by the plugin, nothing to hand-edit in the generated project
- Settings→Connection works in-app (no tray there); setup pre-fills the saved
  address; CI signs the APK (`apksigner verify` runs before publish)

### Admin panel

- Separate admin login (2FA available for admins) — every tab loads live data
- Inspect **users, servers, channels, DMs, memberships, messages (ciphertext),
  friendships, requests, bans, voice sessions/participants, stickers, media,
  notification sounds, pending events/notifications, key blobs & escrow**
- **Full DB table browser** (list tables → read rows), **export/import the DB
  and uploads**, cascade-delete stats before destructive actions
- **Delete** users/servers/channels, **force-disable a user's 2FA**, admin
  **clear-all**
- **Audit log** with an **IP redaction toggle**, **rate-limit usage dashboard**,
  **runtime config** (kill-switch state, limits), all rendered **XSS-escaped**
  (payload tests prove it)

### Reliability & infrastructure

- **Offline detection** — no retry storm while offline; back online reconnects
  instantly; heartbeat re-auth keeps sessions alive
- **Rate limiting** on every sensitive surface (see Security), env-overridable
- **Chunked resumable uploads** with server-side storage quota
- **Mesh-by-default with relay fallback**, call grace/sweep lifecycle,
  black-feed watchdog, E2EE transform healing
- **TURN** time-limited credentials + `COTURN.md` deployment recipe
- **PWA** — installable manifest, service worker offline shell, background sync
- **Tailscale-aware** — auto-detects the CGNAT `100.64.0.0/10` range;
  self-signed TLS with TOFU pinning
- **CI/CD** — two GitHub workflows (*Build Desktop Box*, *Build Android APK*)
  produce installers, APK/AAB, and SHA256SUMS on every tag; APK signature is
  verified before publishing
- **293 Playwright spec files** — the feature suite is the proof: encryption,
  notifications, voice, soundboard, vault, search, admin, box and more

---

## Install

Download from the **[latest release →](../../releases/latest)** (or, for a build that
isn't published yet, **Actions** → *Build Desktop Box* / *Build Android APK* →
**Run workflow** → download the artifact).

### Windows
1. Download `E2E.Chat_<version>_x64-setup.exe` (NSIS) or `E2E.Chat_<version>_x64_en-US.msi`.
2. Run it. If Windows SmartScreen warns (unsigned build): **More info → Run anyway**.
3. Launch **E2E Chat**. WebView2 is already present on Windows 10/11.

### Linux
- **AppImage** — `chmod +x E2E.Chat_*.AppImage && ./E2E.Chat_*.AppImage`
  (needs FUSE; on Ubuntu 22.04+: `sudo apt install libfuse2`).
- **Debian/Ubuntu** — `sudo apt install ./E2E.Chat_*_amd64.deb`.
- **Fedora/RHEL** — `sudo rpm -i E2E.Chat-*.x86_64.rpm`.
- **Arch** — `pacman -U e2e-chat-bin-*.pkg.tar.zst`.
- The `.deb` installs `libwebkit2gtk-4.1` automatically; other formats need it present.

### Android
1. Download `E2E-Chat-v<version>-android.apk` from the release.
2. On the phone: install the **Tailscale** app, sign in, and connect
   (or point the app at any reachable server address).
3. Open the APK. Android will ask to allow installs from this source — enable
   *Install unknown apps* for your browser/file manager, then install.
4. Requires **Android 10+** (minSdk 29).

### Browser
Open your server's address (e.g. `https://100.101.102.103:3443`) — accept the
self-signed certificate once — and use it directly, or install it as a PWA.

### Verify your download (optional)
Each release publishes `SHA256SUMS-<platform>.txt`. Check your file against it
and you never have to trust the download blindly:

```bash
# Linux / Git Bash on Windows
sha256sum -c SHA256SUMS-linux-x64.txt

# Windows PowerShell
Get-FileHash .\E2E.Chat_0.2.29_x64-setup.exe -Algorithm SHA256
```

### First launch (all platforms)
Enter your server's address (for example `https://100.101.102.103:3443`),
click **Test connection** (which shows the certificate fingerprint — the box
pins it on save), then **Save & Launch**. Change it later from the tray
(desktop) or Settings → Connection (any platform).

---

## Build from source

Prerequisites: Rust (stable), Node 18+, and — for the desktop app — the
[Tauri system dependencies](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
# Run the server (its own terminal; serves the web app on :3443)
cargo run --manifest-path server/Cargo.toml --release

# Desktop app — dev
cargo install tauri-cli --locked      # one time
cargo tauri dev

# Desktop app — installer for the current OS
cargo tauri build
```

`cargo check --manifest-path src-tauri/Cargo.toml` type-checks the desktop crate without
the Tauri CLI.

**Android** (SDK 36 + NDK 27 + a JDK; `npm install` first — details in
`src-tauri/android-templates/README.md`):

```bash
npm run tauri -- android build        # universal release APK + AAB
# → src-tauri/gen/android/app/build/outputs/apk/universal/release/*.apk
```

Run the end-to-end test suite (starts the server itself on :3443):

```bash
npx playwright test                          # everything (293 spec files)
npx playwright test tests/key-vault.spec.ts  # or a single suite
```

---

## Repository layout

```
server/     Rust backend (Axum + SQLite): auth, sessions, relay, encrypted storage
static/     Frontend: chat, voice, crypto, secure-storage, captions, keyvault (the app itself)
src-tauri/  Native desktop + Android shell (Tauri 2) and the call-service/box-shell plugins
tests/      Playwright end-to-end suite (293 specs)
tools/      Small build helpers (icon generation, etc.)
packaging/  AUR and other packaging bits
```

---

## Documentation

| Document | What's in it |
|---|---|
| [`FEATURE_PLAN.md`](FEATURE_PLAN.md) | Every candidate feature: E2EE verdict, exploit review, and the implementation-status table (what's built + which spec proves it) |
| [`FEATURE_RESEARCH.md`](FEATURE_RESEARCH.md) | The feature menu — native things the box could do, with effort estimates |
| [`MANUAL_TESTING.md`](MANUAL_TESTING.md) | 19-section guide to testing every feature by hand, each with a *"try to break it"* check |
| [`WEBSITE_IN_A_BOX_MASTER_PLAN.md`](WEBSITE_IN_A_BOX_MASTER_PLAN.md) | The desktop/mobile shell design, session persistence, per-platform gap audits, Android build research |
| [`VOICE_CALLS_SPEC.md`](VOICE_CALLS_SPEC.md) | The voice/video specification: channels, DM calls, audio, video, screen share, E2EE, notifications |
| [`MEDIA_SCALING_RESEARCH.md`](MEDIA_SCALING_RESEARCH.md) | Per-member video, resolutions, simulcast, mesh cost model |
| [`SECURITY_FIX_PLAN.md`](SECURITY_FIX_PLAN.md) | The Tauri integration plan and security hardening record |
| [`COTURN.md`](COTURN.md) | Deploying coturn with time-limited HMAC credentials so calls survive mobile data |
| [`PROGRESS.md`](PROGRESS.md) | The full session-by-session development log, including the plaintext-metadata inventory |
| [`src-tauri/README.md`](src-tauri/README.md) | Desktop shell internals: commands, ACL, TOFU pinning, Android notes |
