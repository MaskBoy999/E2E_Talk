# Website-in-a-Box (Tauri 2) + Mobile Session Persistence — Master Plan

Status: **feature-complete for Windows / Linux / Android** — Phase 0 (session persistence),
Phase 1 (desktop + Android scaffold), Phase 2 (background-call service wiring + full-screen
incoming call), Phase 3 (push: Web Push live, FCM server-side ready) and Phase 4 (cert
pinning, CI hardening) have all landed. There is deliberately **no auto-updater** —
desktop and Android builds update by re-downloading the new installer (§8.4). What is left is
(a) **external gates** that need *your* accounts/keys — a Firebase project (Android FCM) and
the signing certificates, including a **stable Android upload keystore** (§10.4) — and (b) the
**Android device run** plus the §5 proof artifacts. macOS/iOS stay out of scope by decision (§8).
Per-feature status, **how each is built**, and **where to debug it** are in §9;
downloads/installs are §10; the per-platform gap audit is §11.
Companion doc: `SECURITY_FIX_PLAN.md` (earlier, narrower Tauri scaffold plan — this
document supersedes it and adds the verification harness + the session-persistence workstream).

---

## 0. TL;DR / Definition of Done

Two workstreams, deliberately decoupled:

| Workstream                            | Goal                                                                                                                                                                                                    | Why now                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **A — Website in a Box**              | Ship the existing web app as a native desktop + mobile app (Tauri 2) that **demonstrably proves every feature** in the spec (notifications, calls, screen share, no browser, host-ID entry, tray, etc.) | Turns the PWA into something a non-technical user can install, and lifts mobile browser storage limits |
| **B — Session persistence on mobile** | A user who closes the browser/app and reopens **stays logged in** for the configured session length (`session_duration_seconds`, default 30 days)                                                       | Confirmed root cause found in `static/secure-storage.js` — see §3                                      |

**Definition of Done (A):** installers exist for **Windows, Linux and Android**
(macOS/iOS are out of scope by decision — §8), first-run setup points at a Tailscale
host, and the proof matrix in §5 is green with committed evidence
(logs/screenshots/video) per row.

**Definition of Done (B):** a cold start with cleared `sessionStorage` (simulating a
mobile browser restart) restores the session deterministically and never silently mints a
wrong storage key; covered by an automated regression test.

---

## 1. Ground truth (what exists in this repo today)

Verified by reading the code — the plan builds on these, it does not assume:

- **Server:** Rust (`server/`), Axum + SQLite (`e2e_chat.db`), TLS on `:3443`, auto-detects
  the Tailscale CGNAT range `100.64.0.0/10` (`server/src/main.rs`).
- **Frontend:** plain scripts in `static/` (`index.html`, `login.html`, `chat.js`
  ~33k lines, `voice.js`, `crypto.js`, `secure-storage.js`, `sw.js`, `manifest.json`).
- **Sessions:** JWT + an `auth_sessions` row per device (migration `053_auth_sessions.sql`:
  `id`=JWT `sid`, `user_id`, `device_id`, `device_name`, `created_at`, `last_active_at`,
  `expires_at`, `revoked`). Minted by `mint_session_token()` in `server/src/handlers.rs`.
  Duration is clamped **60 s – 30 days** by `session_duration_secs()`
  (`MAX_SESSION_SECS = 30 * 24 * 60 * 60`).
- **Client session lifetime setting:** `session_duration_seconds` in `localStorage`
  (Settings → Security), read by `getSessionDurationSecs()` in `static/auth.js`, sent as
  `duration_seconds` on login/register; default 30 days.
- **At-rest client encryption:** `static/secure-storage.js` intercepts
  `Storage.prototype.getItem/setItem` and transparently encrypts sensitive keys
  (`token`, `user`, `e2e_*`, `fkc_*`, `profile_key_cache`) with an XChaCha20-Poly1305 key.
  Bootstrap **plaintext** keys: `e2e_device_key`, `e2e_encrypted_password`,
  `e2e_friend_code`, `e2e_local_storage_key`.
- **Key derivation:** `_tryDeriveFromEncryptedPassword()` decrypts
  `e2e_encrypted_password` with `e2e_device_key` **using `E2ECrypto`**, then
  `_deriveKeyFromPassword()`. It explicitly returns `null` when `E2ECrypto` is not loaded
  yet ("secure-storage runs before crypto.js").
- **Existing push scaffolding:** `static/sw.js` already implements `push`,
  `notificationclick`, and background-sync handlers — the box can reuse the same payload
  contract.
- **Existing device pairing:** `static/pair.html`, `server/migrations/077_device_pairing.sql`
  (pairing tickets with 5-minute expiry) and `soundboard-pairing.js` — a foundation for
  "add this box as a device".
- **No `src-tauri/` yet.** Tauri has never been scaffolded.

---

## 2. Workstream A — Website in a Box (Tauri 2)

### A0. Guiding principles

1. **Wrap, don't fork.** `server/` and `static/` stay the shipping artifact; the box is a
   shell. Every feature must also keep working in a plain browser (graceful degradation).
2. **Capability-gated.** Use Tauri 2 capabilities (`src-tauri/capabilities/*.json`) with a
   minimal allowlist. No `shell:allow-execute`, no arbitrary navigation.
3. **Every feature has proof.** No feature is "done" until §5's row for it is green with an
   evidence artifact committed.
4. **The box is a client.** It points at a user-provided host (Tailscale IP / domain); it
   never bundles the server.

### A1. Architecture & trust boundaries

```
┌─ User device ───────────────────────────────────────────────────────┐
│  Tauri app (Rust, ~5–10 MB)                                          │
│   ├─ Native window → OS WebView (WebView2 / WebKitGTK /            │
│   │                   Android WebView)                                │
│   │     loads  https://<host>:3443  (static/ served by the Rust app) │
│   ├─ Native: tray, auto-start, notifications, keychain              │
│   └─ Android: foreground service (calls), FCM token                  │
│                                                                      │
│  Tailscale / WireGuard tunnel  ⇄  Rust server + SQLite (host machine) │
└──────────────────────────────────────────────────────────────────────┘
```

Trust boundaries to state explicitly in the security review:

- The WebView loads a **remote** origin (`https://<host>:3443`). Treat the host as
  trusted-by-configuration; still enforce a navigation allowlist so a compromised/typo'd
  host cannot make the box navigate to arbitrary origins.
- Self-signed certs (`certs/`) are expected — the box must ship a **pinned** trust path
  rather than `danger_accept_invalid_certs(true)` in release builds (the security fix plan
  used `danger_accept_invalid_certs`; we improve on that — see A3.11).
- E2EE keys never leave the WebView except optionally into the **OS keychain** we control
  (A3.9), never to our servers.

### A2. Repo layout & build

```
E2E_Talk/
├── server/                      # unchanged
├── static/                      # unchanged (plus small `window.__TAURI__` hooks)
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── capabilities/{default,desktop,mobile}.json
│   ├── icons/                    # .png/.ico
│   ├── src/{main.rs,lib.rs,config.rs,notify.rs,push.rs,keychain.rs,screen.rs}
│   └── gen/android/
├── .github/workflows/{release.yml,ci-tauri.yml}
└── tools/box/                    # proof harness scripts (see §5)
```

Build commands (documented in the plan, not run yet):
`cargo tauri dev`, `cargo tauri build`, `cargo tauri android build`.

### A3. Feature strategies

Each feature: **Goal / Strategy / Proof / Risk.**

#### A3.1 First-run setup — enter the host device ID

- **Goal:** On first launch the user enters the server's Tailscale address (e.g.
  `https://100.x.x.x:3443`), not a bundled config.
- **Strategy:** Ship a small `setup.html` inside the box bundle (separate window, loaded
  from `tauri://localhost`). It validates the URL, writes `config.json` via a Rust command
  (`save_config`), then navigates the main window to that origin. Config path per-OS via
  `tauri-plugin-store` or a hand-rolled `config.rs` (APPDATA / Application Support /
  `~/.config`).
- **Proof:** Fresh install → setup appears → enter Tailscale IP → app loads the real login
  page; screenshot committed; `config.json` contents asserted.
- **Risk:** Users pasting `http://` or a bare IP → normalize (add `https://`, keep port
  3443 default).

#### A3.2 Connection test + "warning if it doesn't exist"

- **Goal:** "Test Connection" proves reachability and gives actionable failure text.
- **Strategy:** Rust `test_connection(host)` does an HTTPS GET to `/api/health` (or the
  login page) with a timeout, and distinguishes DNS/TCP/TLS/auth failures. Return a typed
  error the UI renders into the troubleshooting checklist (server down / Tailscale not
  connected / wrong IP / port blocked).
- **Proof:** Table-driven test: (a) real host → ✓; (b) unused port → TCP error; (c) host
  that isn't the app → TLS/handshake error. Screenshots of each state.
- **Risk:** Tailscale not installed → the checklist must say so explicitly.

#### A3.3 System tray, auto-start, minimize-to-tray, global shortcut

- **Goal:** Feels like Discord/Slack; closing hides to tray.
- **Strategy:** `tauri-plugin-autostart` + built-in tray API. Tray menu:
  *Show*, *Change Server Address…*, *Start on Startup ☑*, *Quit*. On `CloseRequested`,
  `api.prevent_close()` + `hide()` when "minimize to tray" is on. Optionally a global
  shortcut (Ctrl/Cmd+Shift+`) to toggle.
- **Proof:** Automated: assert config round-trips; manual checklist on each desktop OS with
  a short screen recording. Tray menu screenshot.
- **Risk:** Linux tray needs `libappindicator`; document it.

#### A3.4 Native notifications (desktop), richer than browser banners

- **Goal:** OS-level notifications with title/body/(avatar)/actions instead of the plain
  Web Notification API.
- **Strategy:** `tauri-plugin-notification`. Add a thin bridge: `static/chat.js` already
  funnels every notification through ~3 call sites (`new Notification(...)` at chat.js
  ~10318, plus the mention/reply/dm dispatcher ~30159). Introduce
  `window.__showNotif(title, body, {icon, tag, actions})` that prefers
  `window.__TAURI__.notification` when present, else falls back to the web API. Reuse the
  **same payload shape `sw.js` already expects** so push and local desktop notifications
  share one contract.
- **Proof:** Trigger a DM while the box is in the tray → native banner with the sender's
  name; click focuses the right channel. Screenshot per OS + unit test of the bridge
  dispatch.
- **Risk:** Windows banners depend on Focus Assist; Linux needs a notification daemon (libnotify).

#### A3.5 Push notifications — mobile, app **closed** — ✅ implemented (FCM needs your Firebase project)

- **Goal:** Message/call notifications arrive when the box hasn't been opened.
- **How it's built:**
  - **Server (`server/src/push.rs`, new):** self-bootstrapping **Web Push** — generates a
    VAPID P-256 keypair on first boot (`vapid_private.pem` next to the DB, gitignored) and
    serves the public half at `GET /api/push/vapid-public-key`. Includes a hand-rolled
    RFC 8291 `aes128gcm` payload encryption + ES256 VAPID JWT (no extra HTTP stack), and an
    **FCM** sender for Android via the **HTTP v1** API, authenticating with an
    OAuth2 token minted from a Firebase *service account* key
    (`FCM_SERVICE_ACCOUNT_JSON`, raw JSON or a path) and caching it until expiry.
    (The old `/fcm/send` server-key endpoint was retired by Google, so it is not used.)
  - **Correctness:** the RFC 8291 derivation is pinned by the spec's own test
    vector — `cargo test push` asserts the intermediate CEK/NONCE and the full
    144-octet body for "When I grow up, I want to be a watermelon", plus a
    receiver-side decrypt round-trip. Hand-rolled crypto without that vector is
    how a push silently never renders.
  - **DB:** migration `091_push_devices.sql` + `db.rs` upsert/delete/query helpers.
  - **API:** `POST /api/push/register` (auth required; validates platform + web ECDH keys),
    `POST /api/push/unregister`.
  - **Fan-out:** `handlers::push_to_users` is called from `ws.rs` after a channel message, a
    DM, and a `dm_call_ring`. It **skips any user with a live websocket** (they get the
    in-app notification) and prunes dead subscriptions (HTTP 404/410).
  - **Payload:** metadata only — `{title, body, tag, url}` — the exact contract `static/sw.js`'s
    `push` handler already parses. Message plaintext never leaves the E2EE layer.
  - **Client (`static/push-client.js`, new):** subscribes the service worker with the
    server's VAPID key and registers/unregisters the subscription; on the Android box it
    registers an FCM token instead (see the Firebase gate below).
- **Proof:** `tests/push-notifications.spec.ts` (5/5 green against a real server) covers the
  VAPID endpoint, auth/platform/ECDH validation, upsert + unregister, FCM registration, and
  that `index.html` loads each client script exactly once. `cargo test push` (2/2) proves the
  payload encryption against the RFC 8291 test vector.
- **Firebase gate (the one remaining external step):** Android WebView has **no** Push API,
  so Android push needs FCM — create a Firebase project, drop `google-services.json` into
  `src-tauri/gen/android/app/` and add the `firebase-messaging` Gradle dependency. Until
  then Android push is simply off; the desktop box and browsers get Web Push today.

#### A3.6 Incoming-call UX (foreground + background) — ✅ implemented

- **Goal:** A call looks like WhatsApp/Discord, even from a cold start.
- **How it's built:** an incoming `dm_call_ring` now also pushes `{tag:"call:<dm>",
  url:"/?dm=<dm>"}` to callees with no live socket, so a cold-started app gets the ring.
  When the WebView is backgrounded, `static/voice.js` `showIncomingCall()` additionally
  invokes the native `plugin:call-service|incomingCall`, which posts a high-importance
  notification with a **full-screen intent** (+ ringtone/vibration, and a *Decline* action
  receiver) — `IncomingCallNotifier.kt`. `hideIncomingCall()` calls `cancelIncoming`.
  Foreground rings keep using the in-app bar (`showIncomingCall`), unchanged.
- **Proof (device):** call while the app is (a) foreground, (b) backgrounded, (c)
  force-closed → all three ring; Accept joins. Needs an Android device (see §10.3).

#### A3.7 Mobile: hold calls with the screen off — ✅ implemented (device test owed)

- **Goal:** Lock the phone → audio continues both ways, like a phone call.
- **How it's built:** a `CallForegroundService` declaring
  `android:foregroundServiceType="phoneCall"` — **not** `mediaCall`, which is not a
  foreground-service type at all and failed the whole APK build in AAPT until it was
  corrected (2026-09-20 — §11.1). Manifest: `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_PHONE_CALL`, `MANAGE_OWN_CALLS` (the documented prerequisite of the
  `phoneCall` type; a normal permission, so no prompt), `WAKE_LOCK`, `POST_NOTIFICATIONS`,
  `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `CAMERA`.
  JS hook: `_boxCallService('start'|'stop')` in `static/voice.js` invokes
  `plugin:call-service|start` / `|stop` on call join and from every `teardownRoom()` exit
  path, guarded by `window.__TAURI__` + an Android user-agent test.
- **Proof:** Start a call, lock the screen, wait 5 minutes, verify two-way audio
  (recorded on the other peer). Android also shows the persistent "In voice call"
  notification. **Still owed** — no device run yet (§11.3).
- **Risk (unchanged):** Android 14 foreground-service typing is strict.

#### A3.8 Mobile screen share

- **Goal:** Share the phone screen into the existing relay pipeline.
- **Strategy:** Android WebView (Chromium, API 29+) supports
  `navigator.mediaDevices.getDisplayMedia()` — the existing `startScreen()` in `voice.js`
  works unchanged, feeding the **same canvas → encrypt → WebSocket relay path** already
  used on desktop (reuse `relay-encode-worker.js`, don't invent a second pipeline).
- **Proof:** Share screen on Android (system picker) → the remote peer sees live frames;
  assert frames arrive through the relay (counter/log).
- **Risk:** Android picker behaviour varies by OEM/version — gate it behind a UI flag:
  hide the button when capture isn't available rather than failing.

#### A3.9 Persistent session & key storage inside the box (bridges to Workstream B)

- **Goal:** WebView storage can be cleared by the OS; the box must not lose the session
  before its configured expiry.
- **Strategy (layered):**
  1. Fix the web bug (Workstream B) — the box inherits a correct bootstrap.
  2. Add `tauri-plugin-stronghold` (or the OS keychain) holding the *storage bootstrap
     material* (`e2e_device_key`, `e2e_encrypted_password`) so a WebView data wipe can
     restore it. Keychain access is Rust-gated, so it is strictly stronger than
     `localStorage` at rest.
  3. Never wipe WebView data on app update (`tauri.conf.json` must not set a
     clearing-on-update policy).
- **Proof:** Clear the WebView's `localStorage` out-of-band → relaunch → session restored
  from the keychain without re-login.
- **Risk:** Extra native surface; keep it optional and feature-flagged.

#### A3.11 Tailscale host + self-signed certs (hardening over the draft plan)

- **Goal:** Reach `https://100.x.x.x:3443` without disabling TLS verification globally.
- **Strategy:** Pin the host's certificate fingerprint (TOFU) on first successful connect
  and store it in `config.json`; the Rust HTTP client trusts only that fingerprint. Expose
  a "certificate changed, re-trust?" prompt. Avoid
  `danger_accept_invalid_certs(true)` in release.
- **Proof:** Connect to a self-signed host (✓ after TOFU); swap the cert → warning appears;
  MITM with a different cert → refused.
- **Risk:** Cert rotation forces a re-trust step — acceptable and safer than blind trust.
- **Important scope limit (be honest about this):** pinning covers *our* HTTP client
  (`test_connection`, `probe_certificate`, every launch check). The **main window is a
  WebView**, and WebView2 / Android WebView / WebKitGTK do their own TLS validation —
  Tauri exposes no per-request certificate hook, so the pin does not extend to the page
  load. Consequence: with a **self-signed** cert the WebView shows its own certificate
  error and never reaches the app UI. Practical fix, pick one:
  1. put a *trusted* cert behind the host — `tailscale cert <name>.ts.net` and point
     `TLS_CERT_PATH`/`TLS_KEY_PATH` at it (real Let's Encrypt cert, valid in every
     WebView); or
  2. install the server's `certs/` CA/leaf into the OS trust store on each client.
     Recommended: (1). This is a documented limitation, not a silent one.

#### A3.12 Security hardening

- **Capabilities:** only `notification`, `autostart`, `store`/`stronghold`,
  `dialog`. No shell.
- **Navigation allowlist:** the WebView may only navigate to the configured origin; external
  links open in the system browser.
- **CSP:** tight `default-src 'self' https://<host>`; the host is config-time, so build the
  CSP at runtime from config.
- **Evidence:** a capabilities diff in the PR + a negative test that navigation to
  `https://example.com` is blocked.

### A4. CI/CD

- `release.yml`: matrix build (windows-msvc, ubuntu-22.04, macos x86_64 + aarch64,
  android, ios), driven by tag `v*`; upload bundles to the GitHub Release.
- `ci-tauri.yml` (PRs): `cargo check`, `cargo test` for the box, and the proof harness
  smoke subset.
- Reuse the existing Playwright suite against a locally started server for the web layer.

### A5. Platform matrix & limitations

| Feature                          | Win                                                                                  | Linux                | Android                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tray                             | ✅                                                                                    | ✅(appindicator)      | ❌                                                                                                                                                             |
| Auto-start                       | ✅                                                                                    | ✅                    | ✅                                                                                                                                                             |
| Native local notif (app running) | ✅                                                                                    | ✅                    | ✅ (`tauri-plugin-notification` shim over `window.Notification`; the WebView has no Web Notification API, and Android 13+ needs the POST_NOTIFICATIONS prompt) |
| Push (app **closed**)            | ⚠️ Web Push *if* the WebView's Push API is available; otherwise: leave it in the tray | ⚠️ same as Windows    | ✅ FCM — **needs your Firebase project** (§A3.5)                                                                                                               |
| Full-screen incoming call        | – (ring bar)                                                                         | – (ring bar)         | ✅ full-screen intent (device test owed)                                                                                                                       |
| Background call, screen off      | tray                                                                                 | tray                 | ✅ `phoneCall` foreground service (+ `MANAGE_OWN_CALLS`)                                                                                                       |
| Screen share                     | getDisplayMedia                                                                      | ✅                    | getDisplayMedia (API 29+)                                                                                                                                     |
| Cert pinning (TOFU)              | ✅                                                                                    | ✅                    | ✅                                                                                                                                                             |
| Auto-update                      | ✖ manual re-download                                                                 | ✖ manual re-download | ✖ re-install the APK                                                                                                                                          |
| Session in keychain              | ✅                                                                                    | ✅(libsecret)         | ✅                                                                                                                                                             |

> **Read the push row carefully.** Web Push is implemented and works in a real
> browser (Chrome/Edge/Firefox). The *desktop box* is a WebView: WebView2 often
> lacks the Push API, so treat "notified while the box is fully closed" as
> best-effort there — the intended desktop behaviour is to leave the box running
> in the tray, where the WebSocket delivers notifications natively. Android has no
> Push API at all and therefore genuinely requires FCM.

### A6. Effort & phasing (see §6 for sequencing)

Rough: scaffold 0.5d · setup+config+conn-test 1.5d · tray/autostart 0.5d · desktop
notifications 0.5d · CI 1d · Android (bg calls + screenshare verify) 2d · push 1.5d ·
proof harness 1.5d ≈ **~8–10 days**. (macOS/iOS work removed from scope — §8.)

---

## 3. Workstream B — Mobile session persistence ("logged out after closing the browser")

### B1. Symptom

On a phone, closing the browser (or the OS evicting the tab) and reopening the app lands on
the login page, even though the session's server-side `expires_at` is 30 days out.

### B2. Root cause (code-referenced)

`static/secure-storage.js`:

1. `_secInit()` runs at parse time (line 779) and calls `_ensureKey()`.
2. `_ensureKey()` resolution order: in-memory `_key` → `sessionStorage['_ssk']` →
   `localStorage['e2e_local_storage_key']` → `_tryDeriveFromEncryptedPassword()` →
   **generate a random key and persist it to `e2e_local_storage_key`** (lines ~500–552).
3. `_tryDeriveFromEncryptedPassword()` **returns `null` whenever `E2ECrypto` isn't loaded**
   (lines ~257–259) — and `E2ECrypto` is only defined after `sodium.ready` resolves.
4. Crucially, `_secReKey()` (run after login/register) **deletes**
   `e2e_local_storage_key` (lines ~845–848), having re-encrypted every sensitive value,
   including `token`, under the **password-derived** key.

So on a cold start (mobile browser restart ⇒ `sessionStorage` gone, and the password-derived
fallback was intentionally removed):

- If derivation can't run *at that instant* (libsodium/E2ECrypto not ready yet — more likely
  on slow mobile devices), `_ensureKey()` **silently generates a random key and persists it**.
- Every subsequent `getItem('token')` decrypts under the wrong key → returns `null` → the
  app concludes "no session" → login page.
- Worse, the random key is now in `e2e_local_storage_key`, and `_ensureKey()` checks that
  key **before** trying derivation — so the wrong key sticks across later loads until a
  successful login calls `_secReKey()` again, which "heals" it — until the next cold start.

This is consistent with the report: desktop rarely full-restarts mid-session (sessionStorage
survives), mobile restarts constantly — and the failure is intermittent because it depends
on whether `E2ECrypto` is ready at the exact parse-order moment.

### B3. Fix strategy (layered, safe by default)

1. **Never mint a random key while a password bootstrap exists.**
   In `_ensureKey()`, if `e2e_encrypted_password` + `e2e_device_key` are present, an
   inability to derive is a *temporary* state, not a fresh device. Options (pick one,
   prefer A):
   - **A. Lazy/retry derivation:** when `E2ECrypto` isn't ready, don't finalize a key —
     queue a re-derivation on `sodium.ready` and re-run `_secInit`/`_secReKey` before any
     sensitive read matters (the app already redirects based on `localStorage.getItem('token')`,
     so gate that decision behind "derivation attempt completed").
   - **B. Persist the derived key, encrypted under `e2e_device_key`,** in a new bootstrap
     key (e.g. `e2e_storage_key_wrapped`). Then `_ensureKey()` can recover it synchronously
     with WebCrypto/sodium-free logic and there is no timing hole. Slightly weaker than pure
     password-derivation at rest, but the device key already gates the password blob, so the
     marginal risk is small and the reliability win is large.
2. **Make the fallback non-destructive:** only persist `e2e_local_storage_key` when there is
   genuinely no `e2e_encrypted_password` (true pre-login state). If a bootstrap exists but
   derivation failed, leave storage untouched and surface a "locked" state instead of
   generating a key that orphans the token.
3. **Prefer derivation over the fallback key:** reorder `_ensureKey()` so a present password
   bootstrap is attempted before consulting `e2e_local_storage_key` (the current order is
   what lets a stale random key win forever).
4. **Self-heal on boot:** in `static/chat.js`/`auth.js`, if `e2e_encrypted_password` exists
   but `token` doesn't decrypt, attempt one `_secReKey()`-style re-derivation **before**
   redirecting to login; only redirect if that fails.
5. **Fix load-order for real:** define `E2ECrypto` synchronously (or expose a synchronous
   `decodeEncryptedFileKey` path that awaits `sodium.ready` only when needed), so the
   parse-time `_secInit()` isn't racing the crypto module.

### B4. Honor the configured session length (sliding expiry)

- The server already clamps to 30 days and stores `expires_at` per device. Add a
  **sliding renewal**: on meaningful activity (or a heartbeat), call the existing
  re-auth endpoint to mint a fresh token **retaining the originally chosen duration**, and
  re-arm `checkTokenExpiry()` (chat.js ~1234). This guarantees an actively-used session
  never dies early, matching "hold it as long as required by the session length set in
  settings or on first login".
- If sliding renewal is undesirable, at minimum document that expiry is absolute, and make
  the client-wide logout reason explicit (so a real expiry is never confused with the B2 bug).

### B5. Verification (regression tests — these are the "proof")

New `tests/session-persistence.spec.ts` (Playwright, `serviceWorkers: 'block'`):

1. Register → login → capture raw `token` at rest.
2. **Simulate a mobile cold start:** clear only `sessionStorage` (leave `localStorage`),
   reload `index.html` → expect **no** redirect to `login.html`, and `window._secGet('token')`
   to equal the captured token.
3. Simulate the race: stub `E2ECrypto` as `undefined` during parse, then restore it and
   confirm the boot self-heal restores the token (guards against regression of the
   `_tryDeriveFromEncryptedPassword` timing hole).
4. Assert `e2e_local_storage_key` is **not** created when `e2e_encrypted_password` exists.
5. Session-length: set `session_duration_seconds` to a small value, trigger renewal, assert
   the new token's expiry tracks the chosen duration.

Manual Android browser + box checks are listed in §5.

### B6. Risks

- Changing the storage-key scheme can orphan values written by older builds. Migration must
  read old formats (the code already keeps legacy XOR readability) and must be covered by a
  test that loads an old-format fixture.
- A "locked" state that pauses boot must have a bounded timeout and a visible retry, or a
  crypto failure could hang the app.

---

## 4. Proof harness ("prove all features mentioned here")

| Layer           | Tooling                                          | What it proves                                                     | Artifact                                              |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------- |
| Web regression  | Existing Playwright suite + new specs            | chat/voice/notifications/session behavior in a browser             | JUnit/HTML report, traces                             |
| Storage unit    | `tests/test-secure-storage.html` runner (exists) | key derivation/round-trip, B3 cases                                | assertion log                                         |
| Box integration | Rust `#[test]` + a `tauri::test` harness         | config round-trip, conn-test errors, capabilities                  | `cargo test` output                                   |
| Device matrix   | Manual checklist + screen recordings             | tray, notifications with app closed, background call, screen share | committed `.mp4`/screenshots under `visual-evidence/` |
| Release         | GitHub Actions                                   | installers build per platform; updater flow                        | Release assets + green checks                         |

Every row in §5 names its artifact path. A feature is only "proven" when that file exists.

---

## 5. Feature → proof matrix

| #   | Claim (from the spec)                                                  | Implementation (§) | Proof                                                     | Artifact                                                  |
| --- | ---------------------------------------------------------------------- | ------------------ | --------------------------------------------------------- | --------------------------------------------------------- |
| 1   | Notifications appear live on mobile even if the app hasn't been opened | A3.5               | Force-stop app, send msg → notification; tap → correct DM | `visual-evidence/push-closed.mp4`                         |
| 2   | Same with calls                                                        | A3.5/A3.6          | Call while closed → full-screen incoming → accept joins   | `visual-evidence/push-call.mp4`                           |
| 3   | Mobile holds calls with screen off                                     | A3.7               | Lock 5 min, verify two-way audio (peer recording)         | `visual-evidence/bgcall-android.mp4`                      |
| 4   | Mobile screenshare when the harness is done                            | A3.8               | Android share → remote sees live frames                   | `visual-evidence/screen-android.mp4`                      |
| 5   | Notification looks a lot better on PC                                  | A3.4               | Native banner with name/avatar/actions; click focuses     | `visual-evidence/notif-desktop.png` ×3 OS                 |
| 6   | Doesn't have to open the browser to access it                          | A2/A3.3            | Launch app, standalone window, minimize to tray           | `visual-evidence/standalone.png`                          |
| 7   | Input the host device ID to reach the right Tailscale page             | A3.1               | First run → setup → real login page                       | `visual-evidence/setup.png`                               |
| 8   | Warning if it doesn't exist                                            | A3.2               | Table-driven failure states                               | `visual-evidence/conn-test.png` ×3                        |
| 9   | Possibility to change the host IP                                      | A3.3               | Tray → Change Server Address → reconnect                  | `visual-evidence/change-host.mp4`                         |
| 10  | Session persists after closing/reopening (mobile)                      | B2/B3              | `session-persistence.spec.ts` + device check              | Playwright report + `visual-evidence/session-restore.mp4` |
| 11  | Session honored for the configured length                              | B4                 | Renewal test tracks chosen duration                       | `tests/session-persistence.spec.ts`                       |

---

## 6. Milestones & sequencing

Decisions taken: **Phase 0 first, then the desktop box**; target **Windows, Linux and
Android** (macOS/iOS dropped — §8); adopt **FCM** for push.

**Phase 0 — stop the bleeding:** ✅ **IMPLEMENTED** — see §6a.

**Phase 1 — desktop box:** ✅ **implemented** (scaffold, setup/conn-test, tray/auto-start,
close-to-tray, navigation allowlist, native-notification bridge, CI) — see §6b. Remaining:
the proof-harness evidence rows (screen recordings/screenshots).

**Phase 2 — Android:** ✅ **implemented** — APK build (CI), foreground-service calls
(`plugins/call-service` + the `_boxCallService()` hook in `voice.js`), full-screen
incoming call (Kotlin `IncomingCallNotifier` + the `_boxIncomingCall()` hook),
getDisplayMedia screenshare (works via the web app). **Device verification still owed.**

**Phase 3 — push + calls infra:** ✅ **implemented** — `server/src/push.rs`, the
`push_devices` migration, `/api/push/*`, and the `sw.js`-shared payload contract, covered by
`tests/push-notifications.spec.ts`. **External gate:** a Firebase account for Android FCM
(Web Push works today without one).

**Phase 4 — polish:** ✅ **implemented** — TOFU cert pinning (A3.11, `src-tauri/src/cert_probe.rs`

+ the trust checkbox in `box-setup.html`) and CI hardening (loud "no installers were
  bundled" guard + a Windows signature verification step). Auto-update was **not adopted**
  (A3.10): updates are manual re-downloads.
  Keychain-backed storage (A3.9) remains optional/deferred; the session-persistence fix (Phase 0)
  solved the actual reported symptom.

The old iOS phase and the macOS target remain dropped — §8.

### 6b. Phase 1 — desktop scaffold (implemented)

Created `src-tauri/` (compiles clean — `cargo check`, no warnings, against Tauri 2.11):

- `Cargo.toml` — `tauri` (tray-icon feature), `tauri-plugin-notification`,
  `tauri-plugin-autostart`, `reqwest` (rustls), serde.
- `tauri.conf.json` — `frontendDist: ../static`, `withGlobalTauri: true`, empty static
  `windows` (created at runtime).
- `capabilities/default.json` — minimal allowlist: `core:default`, `notification:default`,
  `autostart:default`.
- `src/lib.rs` — startup routing (setup vs. main), tray (Show / Change Server Address… /
  Quit), close-to-tray, and IPC commands `get_config`, `test_connection`, `save_config`,
  `show_setup`, `quit_app`.
- `src/config.rs` — server URL + preferences persisted under the OS per-app config dir.
- `icons/icon.png` + `icon.ico` — generated by `tools/box/make-icons.mjs`.
- `static/box-setup.html` — first-run setup screen (address + Test connection + troubleshooting).
- `.github/workflows/release.yml` — desktop installer matrix (Win/Linux) via `tauri-action`.

Follow-ups landed since:

- **Navigation allowlist** (`on_navigation`): the main window may only show the configured
  origin; anything else opens in the system browser (via `tauri-plugin-opener`).
- **Native-notification bridge**: the remote-origin IPC gap is solved with tauri's
  `dynamic-acl` feature — `CapabilityBuilder::new(..).remote(host).window("main")` + 
  `Manager::add_capability` grants the *runtime-chosen* host the *plugin* permissions it
  needs (`core:event:default`, `notification:default`, `call-service:default`).
  `showBrowserNotification()` in `chat.js` keeps calling `new Notification(...)`;
  `tauri-plugin-notification`'s init script has replaced `window.Notification` with a shim
  that posts `plugin:notification|notify` — the OS banner, and the only option on Android
  WebView, which has no Web Notification API. (An app-level `notify` command existed here
  and could never be called from the remote page; removed — §11.1.)
- **Android build target**: `#[cfg_attr(mobile, tauri::mobile_entry_point)]`, desktop-only
  code gated behind `cfg(desktop)`, `bundle.android.minSdkVersion = 29`, a Kotlin
  `CallForegroundService` template, and `.github/workflows/android.yml` (APK).

Since then (this pass): push (Web Push live + FCM server-side), the Android
foreground-service JS wiring, the full-screen incoming call, TOFU cert pinning, the in-app
**Connection** settings tab (change the server address without a tray), and CI hardening all
landed — see §9.1 for the per-feature detail.
Still open: **external** gates only (a Firebase project for Android FCM, the Windows signing
certificate), plus device verification on real hardware.

### 6a. Phase 0 — implemented

Changed:

- `static/secure-storage.js`
  - New `_hasPasswordBootstrap()` (device key + password blob present).
  - `_ensureKey()` now derives the key from the password bootstrap **before** the
    sessionStorage/localStorage caches, and **never mints a random fallback key while a
    bootstrap exists** — the previous behaviour orphaned the encrypted `token` whenever
    derivation lost the sodium-ready race.
  - New `window._secRedriveKey()` re-derives on demand and drops the stale fallback.
  - `_afterSodium` self-heals at load: if derivation was still pending when the parse-time
    `_secInit()` ran, it re-derives before the app's DOMContentLoaded session check.
- `static/chat.js` — the boot session check calls `_secRedriveKey()` and re-reads
  `token`/`user` once before redirecting to the login page.
- `tests/session-persistence.spec.ts` — 3 tests: session survives clearing
  `sessionStorage`; no fallback key is minted with a bootstrap present; a pre-existing
  poisoned fallback key is ignored and the session still restores.

Verified: the 3 new tests pass; `tests/secure-storage.spec.ts` and
`tests/clear-data-signout.spec.ts` still pass. (`tests/login-wipe-blob.spec.ts` has two
**pre-existing** failures asserting bundle `version === 3` while `crypto.js` sets
`BUNDLE_VERSION = 4` — unrelated to this change.)

---

## 7. Risks & open questions

- **External account** (Firebase) gates push. Desktop + Android can ship without it; the
  plan must not block on it.
- **Platform scope:** macOS/iOS builds are intentionally out of scope (§8) — Apple users
  use the web app in a browser.
- **Storage-key migration** (B6) is the main way Workstream B could regress existing users.
- **Cert pinning** (A3.11) vs the server's self-signed cert rotation UX.

## 8. Decisions (resolved)

1. Sequence: **Phase 0 (session fix) first, then the desktop box.** ✅
2. Platforms: **Windows, Linux and Android.** macOS and iOS were **dropped** (2026-09):
   both require paid Apple Developer certificates and heavy native machinery
   (code signing + notarization, CallKit, ReplayKit) — too much hassle and money for a
   self-hosted, sideload-distributed app. The web app itself still runs in any browser
   (including Safari), so Apple users keep a supported path.
3. Push: **FCM (Android).** ✅ APNs/iOS dropped along with the platform.
4. Auto-updater (`tauri-plugin-updater`): **not adopted — manual updates** (A3.10). Desktop
   users re-download the installer, Android re-installs the APK, and the web app in any
   browser is always current. Keeps the release pipeline key-free.
5. Cert trust: **TOFU fingerprint pinning**, not a bundled CA or blanket
   `danger_accept_invalid_certs` — see A3.11.

Next up: the external gates — a Firebase project for Android FCM and the Windows
code-signing certificate — and the Android device verification run (§10.3).

---

## 9. Implementation status & debugging guide

This section is the single source of truth for **what exists, how it works, and how to
debug it**. Keep it updated as phases land.

### 9.0 Running & debugging the box in general

| What                                            | How                                                                                                                                                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type-check the Rust crate (no Tauri CLI needed) | `cargo check --manifest-path src-tauri/Cargo.toml`                                                                                                                                                               |
| Run with visible Rust logs                      | launch the binary **from a terminal** — `eprintln!` output (IPC/capability/tray errors) goes to that terminal. `./src-tauri/target/debug/e2e-chat-app.exe` (Win) / `src-tauri/target/debug/e2e-chat-app` (Linux) |
| Open the webview DevTools                       | In a **debug** build, right-click inside the app → *Inspect* (WebView2 = Chromium DevTools). The app's own pages also get `window.__TAURI__` (`withGlobalTauri`), so you can call commands from the console      |
| Reset to first-run                              | delete the config file (below), then relaunch                                                                                                                                                                    |
| Local installer build                           | `cargo install tauri-cli --locked` → `cargo tauri build`                                                                                                                                                         |

Config file (contains `server_url`, `auto_start`, `minimize_to_tray`):

| OS      | Path                                    |
| ------- | --------------------------------------- |
| Windows | `%APPDATA%\com.e2echat.app\config.json` |
| Linux   | `~/.config/com.e2echat.app/config.json` |

Handy console one-liners (inside the app, or a local page):

```js
window.__TAURI__                                     // defined? → IPC available
window.__TAURI__.core.invoke('get_config')           // app command: LOCAL pages only
// Plugin commands DO work from the remote app page (see §9.2):
tauri.core.invoke('plugin:notification|notify', { options: { title: 'hi', body: 'test' } })
tauri.core.invoke('plugin:call-service|start', { channelName: 't' })
tauri.event.emit('box:change-server')                // ask for the setup screen
```

### 9.1 Feature status → where to debug

| Feature                                                | Status                                                                                                                                               | Implemented in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | How to debug                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **First-run setup** (host ID)                          | ✅ done                                                                                                                                               | `static/box-setup.html`; `open_setup()` + `save_config` in `src-tauri/src/lib.rs`; `src-tauri/src/config.rs`; `open_main_at_setup()` is the single-window fallback (Android below 12L cannot open a second window)                                                                                                                                                                                                                                                                                                                 | Delete `config.json` and relaunch → setup should appear. Inspect the file after saving. `save_config` validates the URL before writing (a bad address can't brick startup).                                                                                                                                                                                                                                                                                                                        |
| **Change host ID**                                     | ✅ done — tray (desktop) **and** in-app (both platforms); the in-app button was silently dead until 2026-09-20 (§11.1)                                | tray item `change` → `open_setup()`; **Settings → Connection** tab (`static/index.html` + `initConnectionSettings()` in `static/chat.js`) shows `location.origin` and emits `box:change-server`; the listener in `run()` calls `open_setup()`, which opens the setup **window** on desktop and takes over the **main window** on mobile (`open_setup_in_main`, with `app_page_url()`/`is_app_page()` so the navigation allowlist lets the bundled page through); `save_config()` then navigates that same window to the new origin | Tray → *Change Server Address…*, or in-app Settings → Connection → *Change server address…*. Any host **and port** are accepted (`normalize()` in `box-setup.html` only defaults a missing scheme / the port to `3443`). **Why an event and not `invoke('show_setup')`:** this page is served by the *host*, and Tauri refuses app commands to a remote origin — §9.2. Confirm the window reloads the new origin; check stderr for `open_main failed` or `box:change-server: could not open setup` |
| **Dead saved host (mobile fallback)**                  | ✅ done — new 2026-09-20 (§11.1 #8)                                                                                                                   | `host_reachable()` + the `saved_url` filter in `run()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Point the config at a host that is off, then launch **on Android**: the setup screen must appear (prefilled with the dead address) instead of a blank error page, and stderr logs `saved host unreachable (<url>); showing setup`. Desktop is deliberately unaffected — use the tray. Fix the address with Test connection → Save & Launch, which navigates the same window back                                                                                                                   |
| **Connection test / warning**                          | ✅ done                                                                                                                                               | `test_connection` (`reqwest`, 8 s timeout, `danger_accept_invalid_certs`)                                                                                                                                                                                                                                                                                                                                                                                                                                                          | From the setup screen or console (one-liner above). Compare with `curl -sk <url>`; error text distinguishes timeout vs refused vs HTTP status                                                                                                                                                                                                                                                                                                                                                      |
| **No browser / standalone window**                     | ✅ done                                                                                                                                               | runtime window creation in `open_main()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Launch the binary either way; DevTools is the only "browser UI"                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Tray + auto-start + close-to-tray**                  | ✅ done (desktop)                                                                                                                                     | `build_tray()`; `on_window_event(CloseRequested)`; `tauri-plugin-autostart`                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Tray menu ids: `show`, `change`, `quit`. Toggle auto-start in setup → on Linux check `~/.config/autostart/*.desktop`, Windows: Task Manager → Startup                                                                                                                                                                                                                                                                                                                                              |
| **Navigation allowlist**                               | ✅ done                                                                                                                                               | `nav_allowlist()` in `src-tauri/src/lib.rs`, attached by **both** main-window builders (`open_main_window` and the mobile `open_setup_in_main` — the latter was missing it until 2026-09-20, §11.1 #9); the decision is `nav_allowed()`, unit-tested; `tauri-plugin-opener` for the hand-off                                                                                                                                                                                                                                       | Click an external link in a message → must open in the system browser, not in-app. Non-http(s) schemes (blob/data) are allowed by design                                                                                                                                                                                                                                                                                                                                                           |
| **Native notifications (desktop + Android, app open)** | ✅ done — but it was silently dead in the box twice over: first the ACL (§11.1 #4), then the shim's cached `permission` (§11.1 #10, fixed 2026-09-20) | `tauri-plugin-notification`: its init script replaces `window.Notification` with a shim that posts `plugin:notification                                                                                                                                                                                                                                                                                                                                                                                                            | notify`, which `remote-main` grants through `notification:default`; `initBoxNotificationPermission()` primes the shim's cached permission with `Notification.requestPermission()`, and `showBrowserNotification()` in `static/chat.js` just calls `new Notification(...)`                                                                                                                                                                                                                          |
| **Session persistence (mobile)**                       | ✅ done                                                                                                                                               | `static/secure-storage.js` (`_hasPasswordBootstrap`, `_ensureKey` order, `_secRedriveKey`, `_afterSodium`), `static/chat.js` boot self-heal                                                                                                                                                                                                                                                                                                                                                                                        | Console: `window._secGetRaw('token')` (ciphertext) vs `window._secGet('token')` (plaintext, `null` = key mismatch). Force a cold start: `sessionStorage.clear(); location.reload()`. Automated: `npx playwright test tests/session-persistence.spec.ts` (see §6a)                                                                                                                                                                                                                                  |
| **Screen share (Android)**                             | ✅ works via web app                                                                                                                                  | existing `startScreen()`/`getDisplayMedia` in `static/voice.js`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | In-app console: `typeof navigator.mediaDevices.getDisplayMedia` → `'function'` on Android 10+ (minSdk 29). Remote peer should see frames; check the relay logs                                                                                                                                                                                                                                                                                                                                     |
| **Android build target**                               | ⏳ ready, needs toolchain                                                                                                                             | `#[cfg_attr(mobile, tauri::mobile_entry_point)]`, `cfg(desktop)` gates, `bundle.android.minSdkVersion=29`; `.github/workflows/android.yml`                                                                                                                                                                                                                                                                                                                                                                                         | `cargo tauri android init` → `cargo tauri android build --apk` (CI then **signs** the output with `apksigner`, because an unsigned release APK is uninstallable; locally add `--debug` for an installable build). Install: `adb install -r <apk>`. Logs: `adb logcat                                                                                                                                                                                                                               |
| **Background calls (screen off)**                      | ✅ done (Android wiring wired, device test owed)                                                                                                      | `src-tauri/plugins/call-service/` — Rust `init()` + `build.rs` (`android_path`), Kotlin `CallServicePlugin.kt`/`CallForegroundService.kt`, plugin `AndroidManifest.xml`; started/stopped from `_boxCallService()` in `static/voice.js` (call join → `start`, every `teardownRoom` → `stop`)                                                                                                                                                                                                                                        | Console: `tauri.core.invoke('plugin:call-service                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Push notifications (app closed)**                    | ✅ done (Web Push live; FCM awaits your Firebase project)                                                                                             | `server/src/push.rs` (VAPID self-bootstrap, RFC 8291 encryption, ES256 JWT, FCM sender), `server/migrations/091_push_devices.sql`, `db.rs` helpers, `/api/push/vapid-public-key\|register\|unregister` (`handlers.rs`), fan-out from `ws.rs` (`handlers::push_to_users`), `static/push-client.js`                                                                                                                                                                                                                                  | `tests/push-notifications.spec.ts`. Live: `curl -k https://<host>:3443/api/push/vapid-public-key`; check `vapid_private.pem` appeared next to the DB on first boot. FCM needs a Firebase service-account key in `FCM_SERVICE_ACCOUNT_JSON` (raw JSON or a path) — a missing key just disables the Android leg. Crypto: `cargo test push` (RFC 8291 test vector + round-trip)                                                                                                                       |
| **Full-screen incoming call**                          | ✅ done (device test owed)                                                                                                                            | `static/voice.js` `_boxIncomingCall()` (called from `showIncomingCall` when `document.hidden`, cancelled in `hideIncomingCall`); Kotlin `IncomingCallNotifier.kt` (high-importance channel, ringtone, full-screen intent, Decline receiver); `USE_FULL_SCREEN_INTENT` in the plugin manifest; the `dm_call_ring` push carries `/?dm=<id>`                                                                                                                                                                                          | `adb logcat \| grep -iE 'incomingCall\|IncomingCallNotifier\|RustStdoutStderr'`. Confirm the notification permission was granted (Android 13+) — without it the native ring is silently dropped and only the in-app bar shows                                                                                                                                                                                                                                                                      |
| **Updates**                                            | ❌ **not adopted — manual re-download** (§A3.10)                                                                                                      | nothing to configure: no `tauri-plugin-updater`, no signing key, no `latest.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Grab the newest installer from <https://github.com/MaskBoy999/E2E_Talk/releases> (Android: re-install the APK). A browser never needs updating                                                                                                                                                                                                                                                                                                                                                     |
| **Code signing (Windows)**                             | ✅ wired in CI **and auto-verified** (needs your cert)                                                                                                | `.github/workflows/release.yml`: the PowerShell PFX import merges `bundle.windows` into `ci-signing.conf.json`, passed via a single `--config`; a later step runs `Get-AuthenticodeSignature` over every bundled `.exe`/`.msi` and **fails the job** if any is not `Valid` — so a silent signing misconfiguration can no longer ship                                                                                                                                                                                               | Gated on job-level `env.*` (secrets are not usable in step `if:`) — with no secret the build still succeeds and is simply unsigned. Debug: read the step log; `Get-AuthenticodeSignature` on a Windows build                                                                                                                                                                                                                                                                                       |
| **Cert pinning (TOFU)**                                | ✅ done for the Rust client (WebView TLS is out of reach — see §A3.11)                                                                                | `src-tauri/src/cert_probe.rs` (rustls fingerprint verifier + leaf-cert capture), `pinned_cert_sha256` in `src-tauri/src/config.rs`, enforcement in `open_main`, trust checkbox + `probe_certificate` in `static/box-setup.html`                                                                                                                                                                                                                                                                                                    | Delete `config.json` → setup → *Test connection* shows the fingerprint → *Save & Launch* pins it. Swap the server cert and relaunch: startup must refuse with the "certificate changed" message (`open_main failed` on stderr). If the app window shows a certificate error instead of the login page, that is the WebView (not the pin) — use a Tailscale-issued cert or trust `certs/` in the OS store                                                                                           |
| **Release artifacts + checksums**                      | ✅ done (+ a guard so an empty release can't happen silently)                                                                                         | `release.yml` / `android.yml`: APK staged to `dist/E2E-Chat-<tag>-android.apk` and attached with `SHA256SUMS-android.txt`; desktop publishes `SHA256SUMS-<platform>.txt`. New: `permissions: contents: write` (so publishing can't 403), a **Verify installers were produced** step that fails the job when the bundle is empty, and a **Verify Windows signature** step when a certificate is present                                                                                                                             | After a tag push, the release must list one APK, the desktop installers and the checksum files. Verify locally: `sha256sum -c SHA256SUMS-android.txt` (or `certutil -hashfile … SHA256` on Windows)                                                                                                                                                                                                                                                                                                |

### 9.2 Debugging the two trickiest areas

**Remote-origin IPC (why the notification bridge works at all).** The main window loads a
user-chosen host, and Tauri denies IPC to remote origins by default. `grant_remote_ipc()`
builds a capability at runtime and adds it with `Manager::add_capability`. If notifications
silently fall back to the browser path (or nothing happens), check, in order:

1. Run from a terminal and look for `grant_remote_ipc(<host>) failed: …`.
2. In the app console, `typeof window.__TAURI__` — `undefined` means the capability for
   that host didn't match. Note it matches on **host only** (not scheme/port).
3. Confirm the command allowlist in the capability includes `notification:default` and
   `core:event:default` (added in `src-tauri/src/lib.rs`).

**App commands are unreachable from the app's own page.** The ACL check in tauri's
`webview/mod.rs` rejects a request when
`plugin_command.is_some() || has_app_acl_manifest || !is_local` and the command resolved to
no capability entry. The main window's page is **remote**, so *everything* it calls has to
be covered by `remote-main` — and `remote-main` can only list *plugin* permissions
(`core:event:default`, `notification:default`, `call-service:default`). A command defined in
this crate (`get_config`, `save_config`, `show_setup`, …) therefore can never be called from
the web app, whatever a comment or an older doc claims; the page just gets
`Command … not allowed by ACL` (an unhandled promise rejection, i.e. silently nothing).
What *does* work from the remote page:

1. a **plugin** command whose permission is granted — `plugin:notification|notify`,
   `plugin:notification|request_permission`, `plugin:notification|is_permission_granted`,
   `plugin:call-service|start|stop|incomingCall|cancelIncoming`;
2. **events** — `core:event:default` includes `emit`, and a JS `emit` reaches every Rust
   listener registered for that event name (`RuntimeManager::emit` → `Listeners::emit` with
   no target filter). *Settings → Connection* is built on this (`box:change-server`).
   Local pages (the setup window, or `open_setup_in_main`) are unaffected: `is_local`
   short-circuits the whole check, which is why the app's own commands are fine there.
   Adding an **app-level** permission manifest (`src-tauri/permissions/`) would make app
   commands grantable — and would also switch every app command to ACL-enforced mode for
   *local* windows, so the setup screen would need grants too. Not worth it for one button.

**Storage-key derivation (why a session can look "expired").** The key is
password-derived; `_ensureKey()` order matters. To debug a "logged out on reopen":

1. `window._secGetRaw('e2e_encrypted_password')` — present? (bootstrap exists ⇒ the key must
   be derivable).
2. `window._secGetRaw('e2e_local_storage_key')` — should be **absent** once logged in
   (its presence after login means the old bug's poisoning).
3. `window._secGet('token')` — ciphertext intact but this returns `null` ⇒ wrong key.
   `window._secRedriveKey()` then re-read; a `true` return + a valid token means the
   self-heal worked.
4. Reproduce deterministically with `tests/session-persistence.spec.ts` rather than by
   hand.

### 9.3 Debugging a release (signing, checksums, the APK)

Everything in this section runs only on a **tag push**. `workflow_dispatch` builds and
uploads *artifacts* but publishes nothing, so use it to test the build before tagging.**Dependency installs.** `release.yml` needs no extra setup; the plugin crate adds none to
the main build. (macOS/iOS signing and notarization were removed with those platforms.)
Local equivalent of the whole CI run:

```bash
cargo check --manifest-path src-tauri/plugins/call-service/Cargo.toml   # plugin alone
cargo check --manifest-path src-tauri/Cargo.toml                        # app + plugin
node --check static/voice.js                                            # JS hooks
```

**Signing did not happen** (SmartScreen still appears on Windows):

1. Secrets are read into **job-level `env`** because GitHub does not expose `secrets` inside
   step `if:` — so a mismatch between the secret *name* and the `env:` key silently disables
   signing instead of failing.
2. Windows: the import step must print `Signing with thumbprint …`. If it is absent the
   secret was empty. `windows-signing.conf.json` is consumed via `--config`; a malformed
   thumbprint surfaces as a Tauri build error, not a warning.
3. Verify a build: Windows `Get-AuthenticodeSignature <file>`.

**A file is missing from the release.** Checksums are generated globally per platform
(`find … -name '*.exe' -o -name '*.dmg' …`), so a missing entry means the bundle produced a
different artifact name — add it to that `find`. `fail_on_unmatched_files: false` means a
missing checksum will not fail the job either; read the `Generate checksums` log, which
prints the final file.

**The APK is not on the release.** `android.yml` runs in parallel with the desktop matrix;
its attach step uses `softprops/action-gh-release@v2`, which creates the release if it gets
there first and appends otherwise. If the APK is missing, check that the `Stage APK for
release` step actually copied a file (the `find … -exec cp` prints `No such file` when the
APK path was wrong).

---

## 10. Distribution — how users download & install on each platform

### 10.1 How a release is produced (the download pipeline)

1. Bump the version in `src-tauri/tauri.conf.json` (and commit).
2. Tag and push: `git tag v0.2.2 && git push origin v0.2.2`.
3. GitHub Actions builds and publishes:
   - `.github/workflows/release.yml` — desktop matrix (Windows `.exe`/`.msi`, Linux
     `.AppImage`/`.deb`) and creates a **non-draft Release**
     ("E2E Chat v0.2.2") whose body carries the install notes. Needs
     `permissions: contents: write` (now set) or publishing 403s.
   - `.github/workflows/android.yml` — builds the **APK** and attaches it to the *same*
     release as `E2E-Chat-<tag>-android.apk` plus `SHA256SUMS-android.txt`.
4. **Where to find them:** the repo's **Releases** page —
   `https://github.com/<owner>/<repo>/releases` (this repo:
   `https://github.com/MaskBoy999/E2E_Talk/releases`). The README links to
   `../../releases/latest`.

> **"I only see a target zip in Releases."** That zip is *not* an app. Two things can
> look like this and neither is a shipped release:
>
> 1. **The auto-generated source archives** GitHub adds to every release
>    (*Source code (zip)* / *(tar.gz)*) — they are on the page even when the build job
>    produced no installers.
> 2. **A workflow artifact** from a manual *Run workflow*, which `actions/upload-artifact`
>    zips out of `src-tauri/target/**` — visible under the finished run's
>    **Artifacts** section, **not** on the Releases page.
>
> The fix that now makes this loud instead of silent: the release job ends with a
> **Verify installers were produced** step that fails when no `.exe`/`.msi`/`.AppImage`/`.deb`
> was bundled, and `android.yml` fails when no `.apk` was found. So the next tag either
> publishes real installers or shows a red run to debug.

**No release published yet?** Actions → *Build Desktop Box* / *Build Android APK* →
**Run workflow** → download the artifact from the finished run (or re-run after a tag push
if the first attempt failed, e.g. on the missing `icon.png`).

### 10.2 Per-platform download & install

| Platform                  | Download                                                                            | Install                                                                  | Notes                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| **Windows**               | `E2E-Chat_<ver>_x64-setup.exe` (NSIS) or `E2E-Chat_<ver>_x64_en-US.msi`             | Run the installer                                                        | SmartScreen (unsigned): **More info → Run anyway**. WebView2 is pre-installed on Win 10/11 |
| **Linux — AppImage**      | `E2E-Chat_<ver>_amd64.AppImage`                                                     | `chmod +x` then run it                                                   | Needs FUSE (`sudo apt install libfuse2` on Ubuntu 22.04+)                                  |
| **Linux — Debian/Ubuntu** | `E2E-Chat_<ver>_amd64.deb`                                                          | `sudo apt install ./E2E-Chat_<ver>_amd64.deb`                            | Pulls in `libwebkit2gtk-4.1` automatically                                                 |
| **Android**               | `app-universal-release.apk` (all ABIs) or `app-arm64-v8a-release.apk` (most phones) | Enable *Install unknown apps* for the browser/file manager, open the APK | Requires **Android 10+** (minSdk 29); install + connect the **Tailscale** app first        |

> **No macOS/iOS builds by design** (§8): Apple distribution needs paid certificates and
> heavy native work. On an iPhone or Mac, use the web app in Safari — it's the same
> codebase the box wraps.

First launch on every platform: enter `https://100.x.x.x:3443` → **Test connection** →
**Save & Launch** (see §9.1). That first save also **pins the server's certificate**
(TOFU), so a later certificate swap is refused until you re-trust it.

#### Opening the app after it is installed

| Platform             | How you launch it every day                                                             | Notes                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Windows**          | Start menu / desktop shortcut **E2E Chat**, or the tray icon after you close the window | The installer creates both shortcuts. Closing the window **hides to the tray** (it is still running) — use the tray's *Quit* to exit, or re-open from the tray                         |
| **Linux (AppImage)** | Double-click the `.AppImage`, or run `./E2E-Chat_<ver>_amd64.AppImage` from a terminal  | `chmod +x` once after download; needs FUSE (`libfuse2`)                                                                                                                                |
| **Linux (.deb)**     | Launcher entry **E2E Chat** (installed system-wide), or run `e2e-chat-app`              | `sudo apt install ./E2E-Chat_<ver>_amd64.deb`                                                                                                                                          |
| **Android**          | App drawer icon **E2E Chat**                                                            | Sideload the APK, allow *Install unknown apps*; connect the **Tailscale** app first, and grant notification + microphone permissions so background calls and the full-screen ring work |

If the window opens but the app says it cannot connect, it is almost always the host
address (see §9.1, *Connection test / warning*), not the install.

### 10.3 Alternative: build it yourself (when no release exists yet)

Prerequisites: Rust stable, Node 18+, and the OS Tauri deps (Windows: MSVC Build Tools;
Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`).
Android additionally needs the Android SDK + NDK and Java 17.

| Target                | Command                                                                                                                                                                                                                                             | Output                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Any desktop           | `cargo install tauri-cli --locked && cargo tauri build`                                                                                                                                                                                             | installers under `src-tauri/target/release/bundle/`                |
| Android               | `npm install` (installs the pinned `@tauri-apps/cli` **and** provides `node_modules/.bin/tauri`, which the generated Gradle project invokes) → `npx tauri android init` (+ `android-templates/`) → `npx tauri android build --apk --target aarch64` | `src-tauri/gen/android/app/build/outputs/apk/**/app-*-release.apk` |
| Run without packaging | `cargo run --manifest-path src-tauri/Cargo.toml`                                                                                                                                                                                                    | a native window (debug)                                            |

### 10.4 Gaps to close

- ✅ **Checksums** are published (`SHA256SUMS-<platform>.txt` + `SHA256SUMS-android.txt`)
  and the **Android APK is auto-attached** to the same release as the installers.
- ✅ **The APK is signed in CI** (`android.yml` → *Sign the APK*): a Tauri release
  build is unsigned, and Android refuses to install an unsigned APK, so the step
  runs `zipalign` + `apksigner` (your upload keystore when `ANDROID_KEYSTORE_BASE64`,
  `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` are set — otherwise a throwaway
  debug keystore) and then `apksigner verify` so an uninstallable file can never be
  published silently. Skipping this step is what would produce an APK that downloads
  fine and then refuses to install.
- ✅ **Android APK signing is live** — `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_ALIAS`, and
  `ANDROID_KEY_PASSWORD` are set in GitHub Secrets. v0.2.12 was the first release signed
  with the upload key. The workflow refuses to publish a tagged release without them.
- ⚠️ **Windows signing is wired but dormant** — it activates only once the repository
  secrets in the `release.yml` header are set. Until then Windows still shows SmartScreen
  "Run anyway". (macOS/iOS signing was removed along with those platforms.)
- ⚠️ **The signed build is verified in CI but has not been run for real** — that needs the
  actual certificate. The **Verify Windows signature** step makes the next tagged release
  the test: it fails unless every bundled `.exe`/`.msi` reports `Valid`.
- ✅ **No auto-updater, by decision** (§A3.10) — no update-signing secrets exist. Users
  re-download the installer from Releases; there is nothing to configure.
- ⚠️ **Android FCM is the last real external gate** — needs a Firebase project
  (`google-services.json`). Web Push (browsers + desktop) already works without it.
- ✅ **Cert pinning is in** (§A3.11): `test_connection` and every launch verify the
  host's pinned fingerprint instead of blindly accepting the self-signed Tailscale cert.
- ✅ **Auto-updater stays out** (§A3.10) — manual re-download, by decision.
- ✅ **One required repo setting:** the release jobs set `permissions: contents: write`;
  without it tauri-action / `action-gh-release` cannot publish and the run fails.

---

## 11. Per-platform gap audit — 2026-09-20

A read of the code against this plan, per platform, of what is **still** missing. Everything
not listed here is implemented; the Android column is where the remaining work is, because
none of it has been run on a device yet.

### 11.1 Found and fixed in this pass

| #   | Symptom                                                                                                                                                                                                                         | Root cause (in the code)                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Fix                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **The APK never built** — eight red CI runs, v0.2.1–v0.2.8                                                                                                                                                                      | `plugins/call-service/android/.../AndroidManifest.xml` declared `android:foregroundServiceType="mediaCall"`, which is not a foreground-service type; AAPT fails the resource link ("`mediaCall` is incompatible with attribute foregroundServiceType") and the whole build dies                                                                                                                                                                                                       | `phoneCall` + `FOREGROUND_SERVICE_PHONE_CALL` + `MANAGE_OWN_CALLS` (the documented prerequisite), and `ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL` in Kotlin                                                                                                                               |
| 2   | **Settings → Connection did nothing** in the box (the address showed "…")                                                                                                                                                       | The tab lives in the *host-served* page, and Tauri refuses **app** commands (`get_config`, `show_setup`) to a remote origin — `remote-main` only grants plugin permissions, so both calls came back `Command … not allowed by ACL`                                                                                                                                                                                                                                                    | the tab shows `location.origin` (no IPC at all) and the button emits `box:change-server`; the Rust listener opens the setup screen                                                                                                                                                             |
| 3   | **Change-server on Android** would still have failed after (2)                                                                                                                                                                  | A second window on Android needs extra Activities declared in the generated project (Tauri's multi-window guide) and this app has none — so `open_setup()` could not work there                                                                                                                                                                                                                                                                                                       | `open_setup_in_main()`: on mobile the setup page takes over the **main** window; `app_page_url()` + `is_app_page()` stop the navigation allowlist from punting that bundled page to the system browser                                                                                         |
| 4   | **No notifications at all inside the box**                                                                                                                                                                                      | `showBrowserNotification()` invoked the app-level `notify` command from the remote page — rejected by the same ACL rule, and the rejected promise was never handled, so nothing appeared anywhere                                                                                                                                                                                                                                                                                     | dropped that branch: the notification plugin's shim already handles `new Notification(...)`. The now-dead `notify` command was deleted rather than left as a trap                                                                                                                              |
| 5   | **Calls could not capture audio or video on Android**                                                                                                                                                                           | `RECORD_AUDIO` / `MODIFY_AUDIO_SETTINGS` / `CAMERA` were never declared anywhere — the plan asked for `RECORD_AUDIO` in A3.7 but the manifest never carried it. wry's `RustWebChromeClient.onPermissionRequest` maps the WebView's capture request onto the Android runtime prompt, but an **undeclared** permission is auto-denied                                                                                                                                                   | declared in the plugin manifest (which is the only manifest this repo controls — `gen/android/` is generated)                                                                                                                                                                                  |
| 6   | **Native notifications dropped on Android 13+**                                                                                                                                                                                 | `POST_NOTIFICATIONS` was declared but never *requested*; nothing prompted, and the incoming-call notifier silently skips when it is not granted                                                                                                                                                                                                                                                                                                                                       | the box asks once per install (via the plugin's `is_permission_granted` → `request_permission`, both granted to the remote origin) on the first page load                                                                                                                                      |
| 7   | **Gradle's Rust task could not run at all** — in CI too, hidden behind #1 because Gradle runs the two in parallel                                                                                                               | `gen/android/buildSrc/…/BuildTask.kt` (written by `android init`) builds Rust by shelling out to `npm run -- tauri android android-studio-script`, and this repo had neither a `tauri` npm script nor an installed `@tauri-apps/cli` → every attempt ended in `npm error Missing script: "tauri"`, so the `.so` was never built at all                                                                                                                                                | `@tauri-apps/cli` 2.11.2 + a `"tauri": "tauri"` script in the root `package.json` (lockfile updated), and CI now installs it with `npm ci` instead of `cargo install tauri-cli` — which also removes a ~6-minute compile from every run                                                        |
| 8   | **Android: a saved host that is switched off was a dead end** — the WebView sat on its own error page with no tray, no address bar and nothing to press, so the only route back to the setup screen was clearing the app's data | startup treated an unreachable host as fine: `check_pinned_cert` compares a pin only when the host answers at all (deliberately, so an offline launch still opens the window), and `open_main_window` then opened a window that could never load                                                                                                                                                                                                                                      | mobile startup probes the saved host first (`host_reachable`) and shows the setup screen when it does not answer — that page prefills the saved address (`get_config`), so correcting a typo is one edit. Desktop is untouched: it has the tray's *Change Server Address…*                     |
| 9   | **Android: the main window's navigation allowlist was never active**                                                                                                                                                            | the first run on mobile creates the main window from `open_setup_in_main`, which built it *without* `.on_navigation` — so "a link in a message opens in the system browser" never applied there, and a phone has no tray, address bar or back button to escape with                                                                                                                                                                                                                   | the allowlist is now one shared function (`nav_allowlist`), attached by **both** places that build the main window, with its decision half split out as `nav_allowed` so it is unit-tested                                                                                                     |
| 10  | **No notifications on PC at all — and on Android none until the next launch** — even though §11.1 #4 had just "fixed" that path                                                                                                 | the plugin's init script computes `Notification.permission` **once**, at script-init, and caches it — and that cache was wrong on both platforms. On Windows the shim is built with the plugin's Windows template flag set, so it never asks the plugin and resolves to `"denied"` (proved by running the shipped shim script in Node, and then on the real app). On Android it caches `"default"` from the pre-dialog `Prompt` state, and the box asked through `plugin:notification | request_permission` **directly** — which bypasses the shim, so the cache could never be corrected. `showBrowserNotification()` gates on that value, so every native notification was dropped, and Settings reported notifications "blocked — enable in browser settings", a setting no box has |

**Verified locally, not just reasoned about** (Windows, SDK 36 + NDK 27):
`npx tauri android build --apk --target aarch64` exits 0 and produces a 15 MB
`app-universal-release-unsigned.apk` containing `lib/arm64-v8a/libe2e_chat_app_lib.so`; the
manifest compiled *into the APK* carries `foregroundServiceType=0x4` (`phoneCall`) plus
`RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `CAMERA`, `POST_NOTIFICATIONS` and
`USE_FULL_SCREEN_INTENT`; the signed artifact verifies with `apksigner` against the upload key;
and `cargo test` covers the pin re-check and the navigation allowlist. The notification fix
was exercised through the real desktop app on Windows (probe page → shim → plugin → OS).
The build half is no longer guesswork; what remains unproven is everything that needs a
device, plus the release-signing gap in §11.3.

> **Deploy both halves.** `static/` is served by **your server**, not shipped inside the APK, so
> #2/#4/#6 only reach a device once the updated `static/` is deployed there — while the APK
> carries the other half of #2 (the `box:change-server` listener and `open_setup_in_main`).
> Updating one alone leaves the button dead: an old APK has no listener, and an old server
> still calls the app commands the ACL rejects.

### 11.2 Windows / Linux (desktop)

|     | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ❌   | **§5 proof artifacts** — `standalone.png`, `setup.png`, `conn-test.png` ×3, `notif-desktop.png` ×3, `change-host.mp4`. `visual-evidence/` holds only unrelated `T1…T8` screenshots, so the "Definition of Done" in §0 is unmet even though the features themselves are in.                                                                                                                                                                                                                                                                                                                                                                                                     |
| ⚠️   | **Windows code-signing certificate** (PFX + secrets) — wired into `release.yml` and auto-verified, but dormant until the secret exists; SmartScreen shows "Run anyway" until then. External gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ✅   | **Self-signed host certificate — Windows now honoured, via a WebView2 hook.** A3.11's caveat was real and worse than recorded: on Windows the app window showed Chromium's *"Your connection isn't private"* page on **every launch** (read out of a running box: `chrome-error://chromewebdata/`, title *Privacy error*, `NET::ERR_CERT_AUTHORITY_INVALID`) and the app only worked if the user clicked through it. wry never handles WebView2's `ServerCertificateErrorDetected`; `src-tauri/src/win_webview.rs` now does, gated on a pin existing (which `check_pinned_cert` has already verified). See §11.6 for the whole matrix — Linux is still unfixable from the app. |
| ✅   | **Camera / microphone / notification prompts.** wry only auto-allows `CLIPBOARD_READ`, so WebView2 asked the user to allow the microphone on every call, for their own server. `win_webview.rs` now grants exactly the kinds the app uses (`CAMERA`, `MICROPHONE`, `NOTIFICATIONS`, `AUTOPLAY`, `CLIPBOARD_READ`) and leaves everything else to WebView2.                                                                                                                                                                                                                                                                                                                      |
| ⚠️   | **A3.9 keychain-backed storage is still deferred** — on desktop a WebView data wipe costs the local key material; the session survives only through the server-side encrypted key backup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ➖   | Web Push inside the WebView stays best-effort by design (A5 note) — the intended desktop mode is "leave the box running in the tray".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### 11.3 Android

|     | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅   | **APK release signing — FIXED (2026-09-20).** The v0.2.9 APK was debug-signed because the secrets were missing from the workflow. Root cause: the three secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`) were added to GitHub **Secrets** (not Variables) and the tag was re-pushed. v0.2.12 built and signed successfully with the upload key (`CN=E2E Chat Upload Key`). **Lesson learned:** v0.2.1–v0.2.9 were all debug-signed with different throwaway keys — any user who installed one must uninstall before installing v0.2.12+ (different signatures = `INSTALL_FAILED_UPDATE_INCOMPATIBLE`). Future tagged releases will always refuse to publish without the secrets (the guard in `android.yml`), so this cannot happen silently again. |
| ❌   | **Never run on a device.** Everything in the Android column of §9.1 marked "device test owed": background call with the screen off, the full-screen incoming ring, screen share, session persistence across a real restart, and the new in-app change-server flow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ❌   | **FCM push while the app is closed** — external gate: a Firebase project, `google-services.json` into `src-tauri/gen/android/app/`, and the `firebase-messaging` dependency (A3.5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ⚠️   | **Was: no escape hatch when the saved host is unreachable** — closed in code (§11.1 #8): mobile startup probes the saved host and falls back to the setup screen, which prefills the saved address. Desktop keeps the tray. *The fallback itself has not been seen on a device yet* — it is the first thing to check when you install the APK, because it is the one path that can only be reached with a deliberately broken address.                                                                                                                                                                                                                                                                                                                                              |
| ⚠️   | **Android 14+ gates `USE_FULL_SCREEN_INTENT`** behind "Full screen notifications" in system settings for apps whose core function is not calling/alarms (targetSdk here is 36). Sideloaded, so nothing blocks — but the incoming-call ring degrades to a heads-up notification until the user grants it. Needs a device check, and probably a one-time hint in the app.                                                                                                                                                                                                                                                                                                                                                                                                             |
| ⚠️   | **`minSdkVersion` is 29 (Android 10), but a second window needs API 32+ (12L).** Handled — `open_setup_in_main` avoids the second window entirely on mobile — noted so nobody "simplifies" it back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ⚠️   | **Android screen share** rides on `getDisplayMedia` + the system picker; A3.8's OEM-variation risk is still unverified.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### 11.4 Web (plain browser)

Nothing box-specific outstanding: the Connection tab stays hidden without `window.__TAURI__`
(`initConnectionSettings` returns early), and Workstream B is covered by
`tests/session-persistence.spec.ts`.

### 11.6 The Android blank screen, and the per-platform TLS matrix — 2026-09-20

**The symptom:** on a phone, *Test connection* resolved and validated the address, then **Save & Launch
left a blank window forever** — and every launch after that was blank too. No tray, no address bar, no
back button, no message. The only way out was clearing the app's data. Every published APK had this;
the desktop side was never affected.

**The cause:** the server auto-generates a **self-signed** certificate (`main.rs` →
`generate_self_signed_cert`, `CN=rcgen self signed cert`). The box's Rust client trusts it by pinning
the leaf fingerprint (`cert_probe.rs`), but the WebView does its own WebPKI validation and knows nothing
about that pin — and wry's generated Android `RustWebViewClient` **does not override
`onReceivedSslError`**, so Android's default cancels the load. In other words `test_connection` succeeds
(it goes through Rust) while the window it opens can never render anything. The two halves of the app
trusted different things.

**The fix:** wry builds its Android Kotlin from templates and substitutes `{{class-extension}}` from
`WRY_<FILESTEM>_CLASS_EXTENSION` (`wry-*/build.rs`), so `.cargo/config.toml` sets
`WRY_RUSTWEBVIEWCLIENT_CLASS_EXTENSION` to an `onReceivedSslError` override that logs and calls
`handler.proceed()`. That is the supported extension point, so the disposable `gen/android/` project
(regenerated by CI on every run) is never patched. Two guards keep it honest:

- the consumer ProGuard rules in `plugins/call-service/android/` keep the framework-invoked
  `WebViewClient` callbacks, because R8 cannot see the framework calling them and would otherwise be
  free to strip the override *only in the minified release build* — the one that gets published;
- `android.yml` fails the job when the override is missing from the generated Kotlin **or** from the
  release dex, since neither is checkable after the fact.

Proceeding is bounded by the pin rather than "trust anything": `check_pinned_cert` still refuses to
open or navigate a window when the host presents a different certificate, the setup screen **forces the
pin on** on a box (it is the WebView's only trust anchor), and the host is a Tailscale address, so the
transport is already an end-to-end-encrypted WireGuard tunnel.

**The matrix, as it actually is — this is the thing to know before debugging "the app won't load".**

| Platform               | Self-signed host                | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Windows (WebView2)** | ✅ loads, no warning page        | WebView2's `ServerCertificateErrorDetected` → `ALWAYS_ALLOW`, installed by `src-tauri/src/win_webview.rs` on a window that is created hidden on `about:blank` and only then pointed at the server (the event is per-navigation, so it cannot be installed after the first remote load). Gated: with no pin the hook is *not* installed and the warning page is left alone.                                                                                     |
| **Android**            | ✅ after the injection           | `onReceivedSslError` → `proceed()`, injected via `.cargo/config.toml`. **Verified by construction + artifact inspection only** — no device or emulator is attached to this machine. Device check: `adb logcat \| grep E2EChat` must show `accepting the pinned server certificate for …`.                                                                                                                                                                      |
| **Linux (webkit2gtk)** | ❌ refuses, and there is no hook | wry exposes no certificate-error callback for WebKitGTK and `additional_browser_args` is unsupported there, so this cannot be fixed from the app. A Linux user must make the host's certificate trusted at the OS level (`tailscale cert` on the host, or install `certs/cert.pem` into `/usr/local/share/ca-certificates/` and run `update-ca-certificates`). Documented rather than guessed: this is the one platform where a certificate error is expected. |

**A box must never ask its user to trust its own server.** Both fixes are the WebView being told what Rust already decided: the fingerprint is pinned on the setup screen (ticked by default, forced on Android), `check_pinned_cert` refuses to open or navigate a window when the live certificate no longer matches, and only then does the WebView honour the certificate. The permission grants are the same idea for a calling app — the answer to "may I use the microphone?" is always yes when the page came from the user's own Tailscale host and `nav_allowlist` keeps it there.

**Debug affordances added while finding this (both off by default):**

- `E2E_BOX_DEBUG_PORT=9333` on the box exposes a remote debugging port so the WebView can be attached to
  with `chrome://inspect` or Playwright's `connectOverCDP` — `tests/box-desktop.spec.ts` uses it to assert
  the window is really showing the configured origin with the app's UI rather than Chromium's certificate
  interstitial. It is a **run-time** env var and never a build switch, because an open debugging port lets
  anything on the machine drive the app.
- `tools/box/capture-window.ps1` captures the native window and prints the percentage of near-black
  pixels. A screenshot alone cannot tell "login screen" from "certificate error" — both are
  non-black — which is exactly how an Android bug survives a "verified" release.

**Also closed in the same pass** (each was silent in the box): Save & Launch could hang with a dead
button (now reports progress and has a 25 s watchdog); a startup fallback back to setup had no
*explanation* (now `get_startup_error` → the setup screen shows it, which on a phone is the only channel
that exists); `http://` addresses are refused instead of saved (release builds block cleartext, so they
were another guaranteed blank screen); and the desktop-only autostart/tray toggles are hidden on
Android. Tests: `tests/box-setup.spec.ts` (7, **5 of which fail with `static/box-setup.html` stashed to
HEAD**).

### 11.5 Documentation debt

- `SECURITY_FIX_PLAN.md` is **superseded** by this document (its own header says so), yet it
  still contains the `FOREGROUND_SERVICE_MEDIA_CALL` / `foregroundServiceType="mediaCall"`
  snippet that broke the APK build for eight runs. Left as-is on purpose — it is a historical
  record, not a spec — but **do not copy manifest lines out of it**; the committed plugin
  manifest is the source of truth.

---

## 12. Building the Android APK from Windows — complete research

This section documents the full process, every problem encountered, and its solution for building the
Tauri Android APK on a Windows machine. It is written so the next person (or the CI runner) can follow
it without repeating the debugging.

### 12.1 Prerequisites

| Requirement | Version | Notes                                                                          |
| ----------- | ------- | ------------------------------------------------------------------------------ |
| Node.js     | 18+     | `node -v`                                                                      |
| Rust        | stable  | `rustup target add aarch64-linux-android`                                      |
| Android SDK | 34+     | Installed via Android Studio or command-line tools                             |
| Android NDK | 27+     | Installed via `sdkmanager "ndk;27.0.12077973"`                                 |
| Java JDK    | 21      | Oracle or OpenJDK; must be a **full JDK**, not just a JRE or symlink directory |

### 12.2 Environment variables

```bash
# Windows (PowerShell)
$env:ANDROID_HOME = "C:\Users\<user>\AppData\Local\Android\Sdk"
$env:JAVA_HOME = "C:\Program Files\Java\jdk-21.0.11"

# Linux / macOS
export ANDROID_HOME="$HOME/Android/Sdk"
export JAVA_HOME="/usr/lib/jvm/java-21-openjdk"
```

**Critical:** `JAVA_HOME` must point to a **full JDK installation**, not a symlink directory.
Oracle's `C:\Program Files\Common Files\Oracle\Java\javapath` contains only symlinks to `java.exe`
and is **not** a valid `JAVA_HOME`. The correct path is typically:

```
C:\Program Files\Java\jdk-21.0.11
```

Find it with:

```bash
find "/c/Program Files/Java" -name "java.exe" 2>/dev/null
```

### 12.3 Build commands

#### Method 1: Single command (recommended for first build)

```bash
cd src-tauri
npx tauri android build
```

This runs two phases:

1. **Phase 1 — Rust compilation:** Compiles the Rust library for `aarch64-linux-android`, produces
   `libe2e_chat_app_lib.so`, and symlinks it into `jniLibs/arm64-v8a/`.
2. **Phase 2 — APK assembly:** Invokes Gradle to package Kotlin/Java code, resources, and native
   libraries into an APK.

Phase 1 always succeeds (given the NDK is installed). Phase 2 is where JAVA_HOME and Gradle issues
manifest.

#### Method 2: Gradle directly (when Rust library is already compiled)

If Phase 1 succeeded but Phase 2 failed, skip the Rust build tasks:

```bash
cd src-tauri/gen/android
gradlew.bat assembleRelease --no-daemon \
  -x app:rustBuildArm64Release \
  -x app:rustBuildArmRelease \
  -x app:rustBuildX86Release \
  -x app:rustBuildX86_64Release \
  -x app:rustBuildUniversalRelease
```

### 12.4 Problems and solutions

#### Problem 1: `JAVA_HOME` invalid

**Error:** `ERROR: JAVA_HOME is set to an invalid directory: C:/Program Files/Android/Android Studio/jbr`

**Cause:** Android Studio is not installed, or installed in a non-default path.

**Fix:** Find the actual JDK:

```bash
find "/c/Program Files/Java" -name "java.exe" 2>/dev/null
# → /c/Program Files/Java/jdk-21.0.11/bin/java.exe
```

Set `JAVA_HOME` to `C:\Program Files\Java\jdk-21.0.11`.

---

#### Problem 2: `--release` passed twice

**Error:** `error: the argument '--release' cannot be used multiple times`

**Cause:** `npx tauri android build -- --release` passes `--release` twice (once by Tauri CLI,
once by `-- --release`).

**Fix:** Run without the extra flag:

```bash
npx tauri android build  # Release flag is added automatically
```

---

#### Problem 3: Gradle `rustBuild*` fails with WebSocket connection refused

**Error:** `failed to read CLI options: Context("failed to build WebSocket client", ConnectionRefused)`

**Cause:** Tauri's Gradle plugin invokes `npx tauri android android-studio-script --release`, which
tries to connect to a WebSocket dev server. In a standalone build, this server is not running.

**Fix:** Skip the Rust build tasks (the `.so` is already compiled):

```bash
gradlew.bat assembleRelease --no-daemon \
  -x app:rustBuildArm64Release \
  -x app:rustBuildArmRelease \
  -x app:rustBuildX86Release \
  -x app:rustBuildX86_64Release \
  -x app:rustBuildUniversalRelease
```

---

#### Problem 4: First build hangs for 10+ minutes

**Behavior:** No output for 10+ minutes, then times out.

**Cause:** The first Gradle build downloads dependencies (Gradle wrapper, Android SDK components,
Kotlin compiler, etc.).

**Fix:** Wait for the first build to complete. Subsequent builds are faster (cached).
Use `--no-daemon` to avoid background Gradle processes.

---

#### Problem 5: ARM-only APK (x86/x86_64 missing)

**Output:**

```
> Task :app:packageX86Release
There are no .so files available to package in the APK for x86.
```

**Cause:** Tauri's default Android build only targets `aarch64-linux-android` (ARM64).

**Impact:** APK will not run on x86 Android emulators. It will run on 99%+ of real devices.

**Fix:** For emulator support, add targets:

```bash
npx tauri android build --target x86_64-linux-android --target i686-linux-android
```

---

#### Problem 6: ProGuard strips `onReceivedSslError` from release DEX

**Context:** The `onReceivedSslError` override in `RustWebViewClient.kt` must survive R8/ProGuard
in release builds, otherwise the SSL bypass is removed.

**Fix:** Add ProGuard keep rules in
`src-tauri/plugins/call-service/android/consumer-proguard-rules.pro`:

```proguard
-keep class com.e2echat.app.RustWebViewClient {
    public void onReceivedSslError(...);
}
```

Reference in `build.gradle.kts`:

```kotlin
android {
    defaultConfig {
        consumerProguardFiles("consumer-proguard-rules.pro")
    }
}
```

---

#### Problem 7: `--no-daemon` still forks a daemon

**Output:** `To honour the JVM settings for this build a single-use Daemon process will be forked.`

**Cause:** This is informational, not an error. `--no-daemon` prevents long-lived daemons but
still forks a single-use process.

**Fix:** Ignore the message. The build proceeds correctly.

### 12.5 Verification checklist

After building, verify the APK:

```bash
# 1. Check file exists and size
ls -la src-tauri/gen/android/app/build/outputs/apk/universal/release/*.apk
# Expected: ~15MB unsigned APK

# 2. Verify permissions
BT=$(ls -d "$ANDROID_HOME/build-tools/"* | tail -1)
"$BT/aapt2" dump permissions src-tauri/gen/android/app/build/outputs/apk/universal/release/*.apk \
  | grep -E "RECORD_AUDIO|CAMERA|POST_NOTIFICATIONS"
# Expected: all three present

# 3. Verify SSL override in DEX
unzip -o src-tauri/gen/android/app/build/outputs/apk/universal/release/*.apk classes*.dex -d /tmp/dex
grep -rla "onReceivedSslError" /tmp/dex
# Expected: found in classes.dex

# 4. Verify version
"$BT/aapt2" dump badging src-tauri/gen/android/app/build/outputs/apk/universal/release/*.apk \
  | grep -E "^package|versionName|versionCode"
# Expected: versionName='0.2.12', versionCode='212'
```

### 12.6 Key files for Android builds

| File                                                                  | Purpose                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `src-tauri/plugins/call-service/android/consumer-proguard-rules.pro`  | Keep `onReceivedSslError` from R8                                         |
| `src-tauri/plugins/call-service/android/build.gradle.kts`             | Reference ProGuard rules, declare permissions                             |
| `src-tauri/plugins/call-service/android/src/main/AndroidManifest.xml` | Source of RECORD_AUDIO, CAMERA, POST_NOTIFICATIONS                        |
| `.github/workflows/android.yml`                                       | CI guard: verify SSL override survives ProGuard                           |
| `.cargo/config.toml`                                                  | Android cross-compilation config, `WRY_RUSTWEBVIEWCLIENT_CLASS_EXTENSION` |

### 12.7 CI/CD for Android

The GitHub Actions workflow (`android.yml`) builds the APK on every push to `test`/`main` when
`src-tauri/**` files change. It includes:

1. **Rust compilation** for `aarch64-linux-android`
2. **Gradle assembly** with `JAVA_HOME` set correctly
3. **ProGuard verification** — extracts DEX and checks for `onReceivedSslError`
4. **APK upload** as a GitHub Actions artifact

The workflow uses `setup-java@v4` with `distribution: 'temurin'` to ensure a consistent JDK,
avoiding the `JAVA_HOME` issues encountered during local builds.

---

## 13. First real device report — 2026-09-20

The first feedback from an actual phone, with this repo's answers. Each item is
"what the user saw" → "what in the code does that" → "what fixes it". Items are
marked **fixed in code**, **designed (not written)**, or **needs device logcat** —
the last one is not a dodge: three of these can only be told apart by watching the
phone, and guessing between them is how the `mediaCall` build break survived eight
CI runs (§11.1 #1).

### 13.1 Status and navigation bars are always visible

*Symptom:* the system bars sit on top of the app permanently and steal taps from
the buttons along the top and bottom edges. Expected: hidden by default, revealed
transiently by swiping **down from the top edge** (notification bar) / **up from
the bottom edge** (navigation bar).

*Cause:* nothing hides them. `gen/android/.../MainActivity.kt` calls
`enableEdgeToEdge()` — which makes the app draw **under** the bars — and neither it
nor the generated `TauriActivity`/`WryActivity` ever calls a
`WindowInsetsController`. Tauri has no API for this, so it was never done.

*Fix (designed):* the app already owns a Kotlin Android module (the `call-service`
plugin, `src-tauri/plugins/call-service/android`), which is the pattern this repo
uses for anything `gen/android/` would lose (that tree is regenerated by CI —
see §11.6). Add a small **system-bars** module (its own plugin, so a problem in it
cannot take calls down) whose Kotlin runs on `onActivityCreate` + `onResume`:

```kotlin
WindowCompat.setDecorFitsSystemWindows(activity.window, false)
WindowInsetsControllerCompat(activity.window, activity.window.decorView).apply {
    systemBarsBehavior = BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    hide(WindowInsetsCompat.Type.systemBars())
}
```

`BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` is exactly the requested gesture: swiping
the edge in reveals the bar as an overlay that fades again, instead of pinning it.
It has to be re-applied on resume, because the system re-shows the bars when the
activity comes back from the background.

### 13.2 Back closes the app instead of the thing that is open

*Symptom:* pressing back exits the app (and the next launch asks for the server
address again). Expected: back acts like "tap outside the current focus" — close
the open modal / context menu / picker; only exit the app when nothing is open.

*Cause:* `gen/android/app/src/main/java/com/e2echat/app/generated/TauriActivity.kt`
declares `override val handleBackNavigation: Boolean = false`. `WryActivity` builds
its back callback only when that is true, so **no callback is registered at all**
and the system default runs: `Activity.finish()`. Nothing in the web app can see
the press, which is why every modal ignores it.

*Fix (designed):* register an `OnBackPressedCallback` on the activity from our own
plugin Kotlin (`activity.onBackPressedDispatcher.addCallback(activity) {}`).
Callbacks are consulted last-registered-first, so ours wins while wry's is disabled
by the flag above. On back: emit `box:back`; the page closes its topmost layer
(AZ-order: context menu → modal → emoji/sticker panel → sidebar on mobile) and
answers. If the page reports "nothing to close", call a plugin command that
disables our callback, calls `activity.onBackPressed()` (→ finish), and re-enables
it. This keeps the "which layer is open" knowledge where it belongs — in the page —
and gives the phone a back button that behaves like the browser's.

### 13.3 Re-entering the app asks for the server address again

*Symptom:* after back-exit, launching the app shows the *address* screen again.
Expected: only when there is genuinely no page at the saved IP/port, or when the
user asks to change it in Settings.

*Cause (two, independent):*

1. **Startup probing.** On mobile, `run()`'s setup filters the saved URL through
   `host_reachable()` (a full TCP+TLS probe with connect/read timeouts) and falls
   back to the setup screen when it fails — the escape hatch from §11.1 #8, which
   is right for a *dead* address but also fires for a host that is merely slow to
   answer (Tailscale still bringing the tunnel up after a cold boot is the normal
   case on a phone that has just been unlocked). The user then sees the address
   screen even though the address was fine a second later.
2. **Key material.** The E2E identity key lives in WebView storage. On Android
   that storage is a cache the system may clear, and A3.9's keychain-backed store
   is still deferred (§11.2 ⚠️) — that is the "the key isn't really persisted"
   half of the report, and it is the same root cause as Workstream B (§3).

*Fix (designed):* (a) split "no page at that address" from "slow": open the app
window and let the page show its own connection error **with a retry**, and keep the
setup fallback only for a probe that fails outright (connection refused / TLS
refused / DNS), not one that times out — with one retry before falling back;
(b) finish A3.9: a plugin command that stores the identity key in
`EncryptedSharedPreferences` (Android Keystore-backed) so clearing WebView data
cannot cost the key.

### 13.4 Notifications (desktop content + Android bar) — 2026-09-20

*Desktop (symptom):* notifications arrive but say only the title, with no sender,
no channel, no server, and clicking one does nothing. *Android (symptom):* the
ringtone is heard but **nothing appears in the notification bar** — for messages
and for calls.

*Cause (desktop):* the box's path is `new Notification(title, { body })` through
the notification plugin's `window.Notification` shim; the call sites pass no
sender/channel/server and there is no click handler anywhere, so the plugin has
nothing to route a tap to.

*Cause (Android) for the **call** half — already found, see 13.5 cause 1:* the
`call-service` plugin never registered its Kotlin class, so the call foreground
service (and with it the ongoing call notification and the full-screen ring) never
existed. What the user heard was the web app's own ringtone, which is why "call is
heard but nothing appears in the bar" looked like a notification-permission
problem.

*Cause (Android) for the **message** half, ranked by what a logcat will show:* (1) `POST_NOTIFICATIONS`
denied — Android 13+ then drops **every** notification silently, including the
ongoing call notification, while the in-app ringtone keeps playing: sound with an
empty bar is the signature of this one; (2) the plugin's default channel missing
or created at IMPORTANCE_LOW, so posts do not surface; (3) `USE_FULL_SCREEN_INTENT`
not granted (Android 14+, §11.3 ⚠️) — affects only the lock-screen ring.

*Fix (implemented in the web app, 2026-09-20):* one helper builds every message
notification — `notifText(kind, {sender, channel, server, text})` in
`static/chat.js` — so a notification reads **who** it is from and, for a channel,
**which channel in which server**: `"New DM from Alice" / "Direct message"`,
`"Mentioned by Alice" / "You were mentioned in #general · My Server"`,
`"Reply from Alice" / "in #general · My Server"` (that separator is the channel
and server, in that order). All five raise-sites (live DM, live mention, live
reply, and the offline-replay pair) now go through it, and each one's click target
is the existing `navigateToMessage(serverId, channelId, dmChannelId, messageId)` —
the same jump the mentions inbox uses — which focuses the box first and then opens
the DM conversation or the server's channel at that message. The DM raise-sites
previously had **no** click handler at all; two of them also had no `onClick`
argument, so clicking did nothing even in a plain browser.

**Streamer mode is handled in the same helper, not at the call sites.** With
`streamerMode` on, the helper returns `E2E Chat` plus one of "New direct message",
"You were mentioned in a server", "New reply in a server", "New message in a
server", "Call activity" — no name, no channel, no server, no content. Putting the
redaction in the builder is what makes it complete: a call site cannot forget it,
and no future raise-site can leak a name by building a body itself.

*Still open:*

- **Message text in the body** (`— <what they said>`) is supported by the helper
  (`{ text }`) but not yet passed by any call site: the message body is E2E
  ciphertext at those points, and decrypting it there would add a second
  decryption path next to the renderer's. Doing that needs the key handling
  reviewed, not guessed — so it is a deliberate `text`-less first cut.
- **Call notifications** need the same wording pass (`notifText('call', …)` exists;
  the incoming-call raise-sites in `static/voice.js` still pass their own text).
- **Desktop click delivery is unproven.** `showBrowserNotification` wires
  `notif.onclick`, which works in a plain browser — but the box goes through the
  notification plugin's `window.Notification` shim, and tauri-plugin-notification
  2.4 does not document a desktop click/action callback (its `guest-js` is not even
  shipped in the crate, so this could not be settled locally). If the shim drops
  the handler, the desktop click cannot navigate and the fallback is to post from
  Rust with a click listener. **Check this on the box first** — it decides whether
  any Rust work is needed at all.
- **Android:** request `POST_NOTIFICATIONS` and **surface a visible, actionable
  state when it is denied** (with a shortcut into the system notification
  settings — silently no-op'ing is what made this look like "installs fine,
  nothing works"), create our own message channel (`e2e_messages`,
  IMPORTANCE_DEFAULT/HIGH) instead of depending on the plugin's default, and note
  that the *call* half of this item was the missing plugin registration above.
  Message notifications with the app **killed** still need FCM (external gate,
  §11.3 ❌).

*Status:* content, streamer redaction and click wiring are in the web app
(`static/chat.js`; `node --check` clean). Desktop click delivery and the Android
bar need the device/box check described above.

### 13.5 Voice stops sending audio with the screen off — **fixed in code**

*Symptom:* with the screen off, received audio keeps playing, but about **ten
seconds** in we stop sending audio; after a longer stretch the mic never comes back
even with the screen on again, and only a rejoin restores it.

*Cause 1 (the big one): the foreground service never ran at all.* A plugin whose
commands live in Kotlin has to instantiate that class explicitly —
`api.register_android_plugin(package, "ClassName")` in its setup hook is what
creates the JNI object and the plugin's mobile handle
(`tauri::plugin::mobile::register_android_plugin`; compare
`tauri-plugin-notification/src/mobile.rs` and `tauri-plugin-opener/src/lib.rs`,
which both do exactly this). `plugins/call-service/src/lib.rs` was
`Builder::new("call-service").build()` and nothing else, so
`CallServicePlugin` was **never constructed** and every
`plugin:call-service|…` invoke from `static/voice.js` failed — logged as a
`console.warn` and otherwise ignored. On Android that means: no ongoing "In call"
notification, no full-screen incoming-call ring (13.4's "call is heard, nothing in
the bar" — the ring came from the web app, the notification never existed), and
no foreground service keeping the process alive or holding background capture.
This is fixed in the same change: `init()` now registers
`com.e2echat.callservice/CallServicePlugin` in its setup hook and turns a
registration failure into a startup error instead of silence.

*Cause 2 (why the audio specifically died): the service claimed the **wrong type**.* For Android 14
targetSdk (this app targets 36) each foreground-service type needs its own
`FOREGROUND_SERVICE_<TYPE>` permission, and `phoneCall` — the type the plugin
declared — means "continue an ongoing call through Telecom's ConnectionService",
not "keep capturing the microphone". Microphone and camera access are subject to
the *while-in-use* restriction: when the app stops being the foreground app,
Android revokes capture unless a running foreground service claims
`microphone`. So the service did its job (process alive, notification shown, remote
audio still playing) while the OS had already cut our mic — precisely "we hear them,
they stop hearing us". The no-recovery-after-a-long-pause is the same cut taking the
`MediaStreamTrack` with it, which the existing sleep/wake recovery (§5 in
`static/voice.js`) cannot re-open because nothing re-acquires the device.

*Fix (implemented):*

| Where                                                             | Change                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugins/call-service/src/lib.rs`                                 | register the Kotlin class (`register_android_plugin("com.e2echat.callservice", "CallServicePlugin")`) — without this none of the rows below can run                                                                          |
| `plugins/call-service/android/.../AndroidManifest.xml`             | declare `FOREGROUND_SERVICE_MICROPHONE` / `_CAMERA` / `_MEDIA_PROJECTION`; the service now declares `foregroundServiceType="phoneCall|microphone|camera|mediaProjection"`                                                     |
| `…/CallForegroundService.kt`                                      | `buildTypeMask(mediaTypes)` + `applyTypes()`: `startForeground(id, notif, mask)` with a fallback chain (`requested` → `phoneCall|microphone` → `phoneCall`), because a type can be refused at runtime (permission revoked mid-call, an OEM that dislikes a combination) and losing one type beats losing the service that holds the WebRTC process |
| `…/CallServicePlugin.kt`                                          | `start` takes `mediaTypes`, and a new `updateMedia` command re-applies the mask without restarting the service                                                                                                              |
| `plugins/call-service/build.rs`, `permissions/default.toml`        | the new command is ACL-granted (`call-service:default` → `allow-updateMedia`), so the remote page may call it                                                                                                               |
| `static/voice.js`                                                 | `_boxCallMediaTypes()` (audio + camera/screen from `S.cameraOn`/`S.screenOn`) passed on `start`, and `_boxSyncCallServiceTypes()` after every camera/screen start/stop, so the declared types always match the call's real media   |

*Verified locally:* `cargo check` for **both** the host and `--target aarch64-linux-android` (the target
where the registration call is actually compiled — the host build cfg's it out, so a host-only check would
have proved nothing), `:tauri-plugin-call-service:compileReleaseKotlin` (BUILD SUCCESSFUL against
compileSdk 34) and `:app:processArm64ReleaseResources` — the aapt2 link step that is what actually rejects
a bogus `foregroundServiceType` — plus the merged manifest shows
`foregroundServiceType="phoneCall|microphone|camera|mediaProjection"` and carries
`FOREGROUND_SERVICE_MICROPHONE`. *Not verified:* the phone.

**The device check that now proves it:** with the new APK, start a call and

```bash
adb shell dumpsys activity services | grep -i CallForegroundService   # must list the service
adb logcat | grep -iE 'E2ECallService|e2echat'                        # no "could not register" / "failed"
```

Before this change the first command listed nothing at all, during a call.

**Follow-up still open:** when the mic is cut (or the screen is off long enough that the
track ends), re-acquire it on `visibilitychange` → visible during a call
(`getUserMedia({audio})` + `RTCRtpSender.replaceTrack`, falling back to a peer renegotiation)
instead of requiring a rejoin. The FGS type stops the cut; this makes the call self-heal when
something else causes it.

### 13.6 Screen share does not work on Android

*Cause candidates (a logcat separates them):* (a) Android WebView's `getDisplayMedia`
needs the activity's `WebChromeClient` to grant the *display capture* permission
request; wry's generated `RustWebChromeClient` only maps `AUDIO_CAPTURE` /
`VIDEO_CAPTURE`, so a screen-capture request may be auto-denied exactly the way an
undeclared runtime permission is (§11.1 #5); (b) the `mediaProjection`
foreground-service type was missing (now declared, above) — Android 14 wants it for
any long-lived projection.

*Fix (designed):* if it is (a), inject the grant the same way the certificate
override is injected — `WRY_RUSTWEBCHROME_CLIENT_CLASS_EXTENSION` in
`.cargo/config.toml` (§11.6 established that mechanism, and it survives CI's
`gen/android` regeneration).

### 13.7 Desktop icon vs the mobile icon

*Symptom:* the desktop app's icon is not the icon the phone shows.

*Cause (measured, not guessed):* they are two different pieces of artwork.
`src-tauri/icons/icon.png` (+ the 256 px PNG inside `icon.ico`) is a light-blue
rounded square with a white chat bubble. The launcher icon inside the built APK
(`res/o-.png` = `mipmap-*/ic_launcher.png`) is a **green** line-art logo — and that
artwork exists **nowhere in the repo**: only in `gen/android/`, which is gitignored
and regenerated by CI (`if [ ! -d gen/android ]; then npx tauri android init; fi`),
and in the already-built APKs in `dist/`. So the two cannot stay in sync, and the
next CI build will ship whichever artwork `icons/icon.png` holds.

*Fix (designed):* commit **one** source image, generate every platform's set from
it (`npx tauri icon <source>.png` → desktop `icons/` + `icons/android/mipmap-*`),
and document the one-liner in §12. Then "change the icon later" is one command, and
desktop/Android/iOS can never drift again. `tools/png-ascii.mjs` renders any icon
file as ASCII (it is how the mismatch above was measured, and it is the quickest way
to confirm all three sets really came from one source).

### 13.8 What is needed from the phone (the honest list)

| Item                        | What settles it                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 13.4 Android notifications  | `adb logcat \| grep -iE 'E2EChat\|Notification'` while a message arrives and while a call rings; and Settings → Apps → E2E Chat → Notifications to see whether `POST_NOTIFICATIONS` was ever granted |
| 13.6 Screen share           | the same logcat, filtered for `E2EScreenCapture`                                                             |
| 13.5 Background voice       | after installing the new APK: `adb shell dumpsys activity services \| grep -i CallForegroundService` during a screen-off call (should list `types=microphone\|phoneCall`) |
| 13.1 / 13.2 / 13.3          | eyes and a back button — no logs needed. **Now implemented** (§13.9); a phone confirms them, nothing here can. |

### 13.9 The Android shell: bars, Back, and the relaunch rule — **implemented**, v0.2.13

Three reports, one root cause each, all three fixed without touching the
generated project (`src-tauri/gen/android/` is gitignored and rebuilt by CI, so
anything edited there is lost — every fix below lives in committed source).

**Hidden bars + Back button — new plugin `src-tauri/plugins/box-shell/`.**

The old shell had no way to reach either: `MainActivity` only called
`enableEdgeToEdge()`, and the generated `TauriActivity` sets
`handleBackNavigation = false`, which means *wry registers no back callback at
all* — Android's default (finish the activity) is what ran. So:

* Kotlin `BoxShellPlugin` hides both bars with
  `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` — the requested gesture, where a drag
  from the top (or up from the bottom) brings the bar in for a moment and it
  leaves again — re-applied on `onResume` (Android puts the bars back after a
  screen-off/on cycle or a task switch) and from the page.
* It also installs its own `OnBackPressedCallback` and emits `box:back` to the
  page. `static/box-shell.js` is the page half: it closes the top layer through
  `window._boxCloseTopLayer` — the *same* function the Escape key now uses
  (extracted in `chat.js`, so Back and Escape can never drift apart, and Back can
  never walk through a 2FA confirm) — and only when nothing was closed does it
  invoke `exit` (`finishAndRemoveTask`, so the task is gone from Recents too).
  A handler that throws is treated as "nothing closed", so a page bug can never
  trap the user in the app.
* The registration call in `box-shell/src/lib.rs` is load-bearing: this is the
  exact bug that made `call-service` inert (§13.5), so it is commented as such.
* Verified: `cargo check` (host **and** `aarch64-linux-android`, the target the
  registration actually compiles on), `:tauri-plugin-box-shell:compileReleaseKotlin`,
  `:tauri-plugin-box-shell:mergeReleaseResources`, and 6 Playwright tests
  (`tests/box-shell.spec.ts`) covering the immersive call, Back-with-a-layer,
  Back-with-nothing, the throwing handler, a plain browser, and a desktop box
  (UA guard keeps it inert).

One Kotlin dependency was needed that the first draft missed:
`androidx.appcompat`'s `AppCompatActivity.onBackPressedDispatcher`. The Android
module does not inherit the app module's dependencies, so naming the type failed
with "Unresolved reference: AppCompatActivity" until it was declared at the same
version the generated app uses (1.7.1).

**Relaunching asks for the address again.** The mobile launch gate was
`host_reachable(url)` — one TCP+TLS probe, and *any* failure meant the setup
screen, with the session gone because the app window never opened. On a phone the
usual failure is not "nothing is there" but "Tailscale has not finished starting".
Now the probe distinguishes the two (`cert_probe::ProbeFailure`):

* **Refused** → nothing is listening on that port → the address screen (this is
the reported "only if there's no page at that IP/port").
* **Unknown** (timeout, DNS, TLS) → open the app window *anyway*, exactly as
  reported, and a background watcher re-probes for ~30 s: the moment the host
  answers the window is pointed at it again and the app just loads. Only if it
  never answers does the address screen appear, with the reason in
  `startup_error`. The watcher stops as soon as the saved address changes or the
  window is showing a bundled page (so it can never yank the setup screen away
  from someone typing in it).
* Why the watcher exists at all: a phone has no tray and no address bar, so an
  app window sitting on the WebView's error page used to have no way out.
* Unit-tested (`saved_address_routing_never_strands_the_user`) plus two
  `cert_probe` tests that pin the classification (a refused port is `Refused`,
  a malformed address is `Unknown`) — 8/8 `cargo test`.

**Voice stayed silent after the screen went off — now self-heals.** §13.5 fixed
the cause (foreground-service *type* `microphone`, plus the registration that was
missing entirely). What remained is the aftermath: once Android has cut the mic,
the track comes back `muted` or `ended` while the WebRTC sender stays open,
`S.localStreams.mic` is still set, and `startMic()` early-returns — so the call
kept sending silence until a rejoin. `static/voice.js` now re-checks the track on
every return to the foreground (`visibilitychange` / `focus`), and when it is not
alive it rebuilds the mic (`stopMic()` → `startMic()`, the same path a manual
unmute takes, so no renegotiation and no extra transceiver) with one bounded
retry for a slow OS. It also re-applies the foreground-service types on wake, so a
camera/screen share toggled while frozen is reflected.

**Notifications: the Android "sound but nothing in the bar".** The sound is the
app's own (Web Audio, in the WebView); the notification was being discarded by
Android because `POST_NOTIFICATIONS` had been refused, and the permission primer
had a permanent once-per-install latch — so a refusal was invisible forever and
the app never said so. It now distinguishes "asked and refused" (Android will not
prompt again → a one-time toast pointing at Settings → Apps → E2E Chat →
Notifications) from "dismissed without an answer" (`default` → ask again next
launch, instead of latching itself into silence). The shade entry also used
Android's generic `ic_dialog_info` because no small icon was configured: the
plugin now ships `box_notification` (a white silhouette on transparent, which is
what Android tints) and `tauri.conf.json` points `plugins.notification.icon` at it.

### 13.10 Known gaps after this pass — and why they are still open

Not skipped for convenience; each needs something this machine cannot provide, and
they are the honest to-do list for the next session:

| Item | State | What unblocks it |
| ---- | ----- | ---------------- |
| 13.6 Android screen share | **superseded — see §13.13.** The `onPermissionRequest` override (v0.2.15) was necessary but not sufficient: Android WebView has no Screen Capture API at all, so that callback is never reached. Replaced by a native MediaProjection capture in v0.2.17. | Install the v0.2.17 APK, join a voice channel, press Share screen → the system picker must appear |
| Call/screen-share popup above other apps | **not built.** The desktop design is a second frameless always-on-top window (plus tray-way-back and a hide button) with a new bundled control page; the Android design is notification actions. Both were agreed in §13.4, neither is written. | nothing external — this is real work (new window, new page, new commands) |
| Key "not really persisted" | **not investigated.** `secure-storage.js` keeps the key in `sessionStorage` + `localStorage` bootstrapped by `e2e_device_key`; what Android's WebView does to that storage across a cold start (and whether the encrypted-password bootstrap path is what reinstates it) has not been measured. Workstream B's keychain storage is the durable fix either way. | a device + inspecting the app's storage after a cold start |
| Call notification with richer actions (mute / stop sharing) | **mostly impossible while frozen**, by design, not by omission: Android freezes the WebView when the app is backgrounded, so a notification action has no JS to act on — the honest implementation is "tap to return to the actions", which is what the existing ongoing notification already does. Anything more needs a native WebRTC path or a server-visible call state. | a decision on whether to add native call control |

**What is deliberately *not* done because it would break end-to-end encryption.**
Nothing in this pass touches plaintext outside the device; the hard line is:

* a notification whose *content* is composed by the server or by FCM (sender,
  channel, server, message text). The server sees ciphertext and ids today; a push
  payload carrying names would hand it that metadata (and Google's). While the app
  is **killed** the honest message is therefore "new activity" — no names;
* message *text* in a notification body is possible only through a second
  decryption path beside the renderer's, which is why it is still not done — it
  needs the renderer's key handling reused, not a shortcut;
* richer killed-app notifications *are* possible without breaking anything: push
  only ciphertext and let a native (Kotlin) side decrypt it with a key in the
  keychain — but that needs the keychain work above first.

### 13.11 One icon for every platform — **implemented**, v0.2.13

The finding in §13.7 was that the two icons were different artwork and the mobile
one existed nowhere in the repo. Both halves are now closed:

* `src-tauri/icons/source/box-icon.png` is the **single committed source** (the
  artwork the phone's launcher actually showed, copied out of the gitignored mipmap
  tree before it could be regenerated away).
* `npm run icon` (`tools/box-icon.mjs`) runs the pinned `tauri icon` from that file
  and installs the desktop set into `src-tauri/icons/` — and, when the generated
  Android project exists locally, refreshes `gen/android/.../mipmap-*` from the
  same file, so the phone and the desktop cannot drift apart again. Changing the
  icon later is: replace that one PNG, run `npm run icon`.
* Verified by rendering both files as ASCII (`tools/png-ascii.mjs`): the desktop
  `icon.png` now has the same artwork as the launcher mipmap (two different
  drawings before; identical shape after).

The source is 192×192 because that is the largest raster of the real mobile art
that existed. A 1024×1024 replacement would sharpen the desktop `.ico` and is a
drop-in for the same command.

### 13.12 Release v0.2.13 — shipped, both workflows green

Tagged `v0.2.13` (versionCode 213) from `79b002b`, and **both** workflows built
it successfully on the first attempt — no CI troubleshooting was needed:

| Workflow | Result | Run |
| -------- | ------ | --- |
| Build Android APK | success | `35535636193` |
| Build Desktop Box | success | `35535636172` |

For contrast, the immediately preceding v0.2.12 attempts on this repo failed the
Android job twice (`35518035821`, `35518399031`) while the desktop job passed —
which is the pattern this file's §12 notes describe: the Android job is where the
generated project, the plugin manifests and the NDK all have to agree at once.

**What changed in the verification story for this release.** Everything below was
run before the tag, not after:

* `cargo test` — 8/8 (the new launch-routing rule, the two `cert_probe`
  classification tests, and the pre-existing pin/navigation guards);
* `cargo check --tests --target aarch64-linux-android` — the only target where the
  mobile-only code (and `register_android_plugin`) is actually compiled. A
  host-only check proves nothing about it, which is how the missing registration
  call in §13.5 survived so long;
* Gradle: `:tauri-plugin-box-shell:compileReleaseKotlin`,
  `:tauri-plugin-box-shell:mergeReleaseResources`;
* Playwright: `tests/box-shell.spec.ts` + `tests/role-circle-and-rail.spec.ts` —
  9/9. The suite that needs a live server (`roles-permissions.spec.ts`) still
  cannot run against the dev server already listening on :3443, whose rate limits
  are not the suite's (registrations come back "Too many accounts created from
  this IP"); that is a local-environment limitation, not a regression.

**One release-mechanics trap worth remembering.** `git push --follow-tags` only
carries *annotated* tags, and this repo's tags are lightweight — so the first
push published the branch and silently left the tag behind, which would have
meant no release at all while everything looked fine. The tag needs its own
push (`git push origin vX.Y.Z`); check with
`git ls-remote --tags origin | grep vX.Y.Z` before assuming CI has been woken.

### 13.13 Android screen share, the real story — v0.2.17

**§13.6 was diagnosed one layer too high.** It concluded that wry's
`RustWebChromeClient.onPermissionRequest` was auto-denying the WebView's
display-capture request, and v0.2.15 changed that override to grant
MediaProjection before delegating to `super`. That fix is *correct* — it just
never runs, because there is no such request to answer.

**The actual cause.** `navigator.mediaDevices.getDisplayMedia()` is a **Chrome**
API. The Android **system WebView** — the only engine the box can render in — has
never implemented the Screen Capture API. `navigator.mediaDevices` exists (camera
and microphone work in the box, so `getUserMedia` is fine), but `getDisplayMedia`
is `undefined`. Hence the literal "screen sharing is not supported on this
device" the button produced. Web-search confirmation, and the reason Discord's
Android client does not use the WebView for capture either: the platform API is
the **only** route, and it is `MediaProjection`.

**The implementation (and why it reuses the whole pipeline).**

| Piece | Where | What it does |
| --- | --- | --- |
| Capture | `plugins/call-service/android/.../ScreenCapture.kt` (new) | System picker → `MediaProjection` → `VirtualDisplay` + `ImageReader` → downscale → JPEG → base64 → Tauri **channel** |
| Bridge | `CallServicePlugin.kt` `startScreenCapture` / `stopScreenCapture` | The commands; declared in the plugin's `build.rs` + `permissions/default.toml` so the remote page's `call-service:default` grant covers them |
| Glue | `static/voice.js` `_startNativeScreenCapture()` | Paints each frame onto a canvas, `captureStream(0)` + `requestFrame()` → a **real MediaStream** → the existing `_onScreenStream()` |

The choice that made this tractable: **hand the page an ordinary `MediaStream`.**
Because a canvas stream is indistinguishable from a `getDisplayMedia` stream, the
relay encoder, the AES-GCM per-peer encryption, the tiles, the per-member volume
and the screen-audio relay are all untouched — the two capture paths converge
immediately and cannot drift. Nothing about E2EE changed: frames are encrypted
downstream exactly as before.

**Android's rules, each of which had to be satisfied:**

1. A foreground service with `foregroundServiceType="mediaProjection"` must
   already be running when the projection starts — the page claims the type via
   `updateMedia` *before* opening the picker, and rolls it back if the user
   cancels.
2. `MediaProjection.registerCallback` must be called **before**
   `createVirtualDisplay` (API 34+; otherwise `SecurityException`). It is also
   how "the user pressed Stop in the system UI" reaches the page.
3. Every `Image` must be closed — the reader is created with a 2-deep queue and a
   missed close wedges capture permanently.
4. `registerForActivityResult` is only legal before the activity is STARTED, so
   the launcher lives in `ScreenCapture`'s initialiser (plugins are constructed
   during `onCreate`).
5. The plugin's Android module does not inherit the app module's dependencies —
   `androidx.appcompat` had to be declared for it (same trap as §13.9's
   box-shell).

**Status — honest.** Compile-verified: `cargo check` for both the host and
`aarch64-linux-android`, `:tauri-plugin-call-service:compileReleaseKotlin`, and
`tests/screen-share-fallback.spec.ts` (proves the branch: a browser uses
`getDisplayMedia` and never enters the native path; with `getDisplayMedia`
deleted the button takes the native path and cannot throw). **Not
device-verified** — no device or emulator is attached to this machine, and there
is still no emulator image installed. The one thing a phone must confirm is that
the system picker appears and frames arrive:
`adb logcat | grep E2EScreenCapture`.

**The desktop icon, same release.** §13.11 unified the artwork but the installed
`.exe` kept the old drawing: `tauri-build` emits `cargo:rerun-if-changed` for
`tauri.conf.json` but **never for the icons**, and because it emits *something*,
Cargo's "re-run on any file change" fallback is disabled — so regenerating the
icons no longer re-ran the build script, and the icon compiled into the binary
(which is what the desktop shortcut shows) stayed stale. `src-tauri/build.rs` now
declares the icon files. Verified by checking that the newly built binary contains
all six frames of the current `icons/icon.ico` byte-for-byte.

### 13.14 PiP, Decline, and the phone's ringer — v0.2.25

Three phone-only gaps, each of which is the same root cause as §13.13: **the
system WebView is not Chrome.** A feature that exists in the desktop box's WebView2
or in the browser can be missing, still-present-but-inert, or owned by the platform.

**1. Picture-in-picture needs *activity* PiP, not the web API.** WebView has no
`document.pictureInPictureEnabled` and no `requestPictureInPicture()` (Chrome for
Android got it in 105; it is a different embedding — caniwebview lists the web
feature as unsupported in WebView on every version). So the phone shrinks the whole
activity instead, and the page decides what that window shows: it lifts the chosen
tile into the very same `.voice-fs-wrap` the app's fullscreen button uses and hides
everything else with `body.e2e-pip-active`. That reuse is the whole design —
rotation, mirror and the contain-fit are the fullscreen path byte-for-byte, so PiP
cannot drift from it, and because it is a composited `<video>`/`<img>` rather than a
canvas loop the picture keeps updating while the activity is paused (wry calls
`WebView.onPause`).

*Rules that shaped it, each of which a phone must be the judge of:*

1. The activity must declare `android:supportsPictureInPicture="true"` or
   `enterPictureInPictureMode()` throws. `gen/android/` is generated and wiped by
   `tauri android init`, so the attribute is contributed by the **plugin's** manifest
   and merged in (the merged manifest was checked: one `MainActivity`, attribute
   present). The activity already declares `configChanges` covering
   `orientation|screenSize|smallestScreenSize|screenLayout`, so entering PiP does
   **not** recreate it and the WebView is not reloaded.
2. Aspect ratio is clamped to Android's 2.39:1 … 1:2.39 *inside* the limit, and
   computed from the tile **as seen** (a 90°/270° rotation swaps width and height),
   which is what keeps the window free of black bars.
3. There is no public "leave PiP". The user's own close button is the normal exit and
   it never arrives as a callback, so the page polls `pipState` (400 ms) — polling,
   not a callback, because PiP *pauses* the activity and that is the worst moment to
   depend on JS running. Programmatic exit raises the task with
   `FLAG_ACTIVITY_REORDER_TO_FRONT` (not a new task: the app is `singleTask`).
4. Entering and leaving PiP resizes the activity, so the contain-fit dimensions
   written a moment earlier are stale — the tile is re-fitted on resize (immediately,
   and again at 60 ms and 250 ms), or the picture would be cropped to the top-left
   corner of the window.
5. Hiding uses `visibility: hidden`, not `display: none`: the app keeps its layout,
   so nothing that measures a tile or a canvas sees a zero-sized world and re-renders
   into a broken state while the window is up. The wrapper is re-shown explicitly
   because visibility is inherited.

**2. The notification's Decline was cosmetic.** The action dismissed the
notification and nothing else — the socket, and therefore the call, belongs to the
page. A `BroadcastReceiver` has no plugin reference, so a `WeakReference` to the live
plugin (a strong one would keep a dead plugin and its activity alive) plus
`evaluateJavascript` is the hand-off; it works with the app backgrounded, and a
manifest-declared receiver is delivered to a cached process because Android
unfreezes it for `onReceive`. The page guards on there being an incoming call for
that channel id, so a tap on a stale notification cannot end a live one, and the id
is escaped into the JS literal by hand (no JSON dependency) so it cannot break out.

**3. A channel's vibration pattern is fixed at creation.** The phone was using *its*
default buzz instead of the cue from Settings → Voice → Haptics because the channel
had been created once with `enableVibration(true)` and no pattern, and Android does
not let an app change a channel's sound or vibration afterwards. The live pattern is
now sent with every ring and the channel id is derived from it (the previous
pattern's channel is deleted, so the list does not grow one entry per slider edit);
switching the cue off means a channel with no vibration at all. The channel keeps a
**ringtone as its sound** rather than alerting from our process, so SystemUI still
rings while the app is frozen and inherits the ringer mode and DND policy for free.

The app's **own** WebAudio ringtone and every haptic cue have no such knowledge, so
`getAudioProfile` reads the ringer mode and the interruption filter and the page
honours it: no sound in vibrate/silent, no buzz on silent, neither under DND, and
re-read at the moment a ring starts because a phone can be muted while the app is
backgrounded. Settings' "Test pattern" buttons bypass the gate deliberately. Unknown
state (browser, desktop box, setup screen) means *allow*.

**Status — honest.** Compile- and R8-verified: `compileReleaseKotlin`,
`:app:minifyUniversalReleaseWithR8` (mapping file shows every `com.e2echat.callservice.*`
class unrenamed), the manifest merge, `cargo check` host + `aarch64-linux-android`,
and the rebuilt desktop box over CDP. **Not device-verified** — no device or emulator
is attached, and the emulator image that was installed needs a hypervisor this
machine does not have enabled. What only a phone can confirm:

- pressing PiP in a call puts a **live, correctly-rotated** tile in an
  always-on-top window, and closing that window with the system button restores the
  tile to its row (`adb logcat | grep E2EPip`);
- **Decline in the notification shade ends the call for the caller too**;
- the buzz is the app's configured pattern, and setting the phone to silent stops the
  app ringing out loud.

### 13.15 The rest of the plan (minus LiveKit) — v0.2.29

*(0.2.26–0.2.28 shipped in between without their own sections here: the PiP
feed selection, waking the page the phone pauses for PiP, and the notification-
privacy audit F1–F3 with call comfort, voice activation, tray and PTT — see
PROGRESS.md for those.)*

This release closes everything FEATURE_PLAN.md still listed as open except
7.3. On top of the audit, it ships: the **Quick Settings tile** (literal
labels, boolean state, the same verbs the notification buttons use), **drag
files out**, **panic wipe / auto-lock** (default OFF, total wipe including the
search index), **network awareness** (same-LAN verdict from local facts only),
the **audio-routing picker** (earpiece/speaker/BT via the real OS devices),
**snip a screen region** and **share-into-app**, the **always-on-top mini call
window** (`?mini=1`), **biometric unlock**, **device verification (SAS)**,
**encrypted local export**, the **Stronghold-style Argon2id vault**
(delete-after-migrate, cold start LOCKED), **on-device FTS5 search** (query
never leaves the device, ciphertext at rest, wiped by the panic wipe),
**offline-only live captions**, and **`e2e-chat://` deep links** (ids only,
in-scope only, paired with single-instance so a cold-start link lands in the
running app). The owner-requested **FLAG_SECURE removal** rides along: JS,
Kotlin and ACL fully stripped, `setSecureMode` gone, `batch-b` asserts the
absence.

**7.3 (LiveKit SFU) is deferred by explicit owner decision for this release**
— the plan's condition stands: its own session for the key-derivation ↔
FrameCryptor check, with the fail-closed signalling guarantee intact. Nothing
else on the checklist remains.

**One compile-gate find:** `CallTileService.kt` referenced
`com.e2echat.app.MainActivity` by class from the standalone plugin module
(`Unresolved reference: app`); the ringing branch now opens through
`getLaunchIntentForPackage`, the same path the notification already uses.

**Verified:** cargo check host + aarch64-android, box cargo test (10),
Gradle compile + R8 (all `com.e2echat.callservice.*` unrenamed), 205 Playwright
tests green across the new and modified suites; the only reds are the three
re-proven pre-existing failures (voice-fullscreen ×2, dm-call-volume reset) —
stash-to-HEAD proof included in PROGRESS.md. `MANUAL_TESTING.md` gained
sections 13–19 covering every feature in this release for on-device passes.

### 13.16 Copying *any* file type to the clipboard — v0.2.30

*Copy file* on an attachment used to answer "this browser only allows images" —
true, and unfixable in the page: Chromium takes `text/plain`, `text/html` and
`image/png` from the async Clipboard API and refuses everything else inside the
engine. A clipboard file is a **path**, so the copy moved to the shell, behind the
existing `plugin:box-shell|copyFileToClipboard` command:

| platform | format | notes |
|---|---|---|
| Windows | `CF_HDROP` | real `DROPFILES` + UTF-16 list; no process spawn |
| macOS | file pasteboard | `osascript` `POSIX file`, unelevated |
| Linux | `text/uri-list` | `wl-copy`, else `xclip`; neither ⇒ honest error |
| Android | `ClipData` URI | `FileProvider`, already in the generated manifest |

The page routes **only non-images** to the shell; images keep using the page's own
clipboard so a sticker still pastes as a picture. The bytes land in
`<app cache>/clipboard/` — the app's own cache dir, one file at a time (a new copy
deletes the old, and startup clears the folder), under a sanitised name, with **no
read path**, so no page can use the clipboard to get at what the host copied.

### 13.17 The transport that was never there — v0.2.32

§13.16 shipped a clipboard command that worked and a caller that could not reach
it. Inside the app, *Copy file* still said "needs the app", and the reason was
below the API: the page is served with a **server-supplied** content-security
policy (`connect-src 'self' ws: wss:`), which makes the engine refuse Tauri's
custom-protocol IPC endpoint (`http://ipc.localhost`); Tauri notices, falls back
to its `postMessage` interface, and that interface serialises everything as JSON
and **cannot carry a request body**, which is precisely what the desktop half's
raw-body file commands required. The lesson is the one this plan keeps
re-learning: **the app must assume only what survives a hostile page's own
rules** — here, a plain JSON IPC call. Both file commands (`copyFileToClipboard`,
`saveFile`) now take their bytes as base64 in a JSON argument on *every*
platform, matching the shape Android always used, and the page checks the size
cap before it builds the string (25 MB copy / 100 MB save, mirroring the shell).

**The same release fixed three adjacent, user-visible defects.** The PDF editor
indexed pages by *array slot* in one place and by *page number* in another, so a
tool acted on the wrong page and the renderer received `undefined` —
`Error rendering page: Cannot read properties of undefined (reading 'node')` on
duplicate. Slots and page numbers are now converted explicitly at every boundary.
Document views reflow below 700px (a DOCX page carried its fixed 794px Word
geometry and was cropped; the *Loading document…* placeholder was never cleared,
giving a permanent spinner), and *Copy Text* strips the timestamp and *(edited)*
marker that live inside the message's own text element. Region snip, which never
worked, was deleted rather than left as a button that lies — consistent with §5's
rule that a capability that cannot be honoured is removed from the UI.

**The same rule, applied to the views themselves.** Four more tools and views
claimed a capability they did not have, and each is resolved in the direction its
nature allows:

| claim | reality | resolution |
|---|---|---|
| PDF **crop** | `setCropBox(x, y, width, height)` was called with the box's *edge* arithmetic (`width - right`), so every crop hung off the page and nothing moved | fixed — real margins, checked against the page's own size instead of US-Letter |
| PDF **draw** | listened for `mousedown`/`move`/`up` only, so a phone or a stylus could not draw at all | fixed — pointer events (mouse, finger, pen) and the page captured when the overlay opens |
| **`.tar`/`.gz`/`.tgz`** | listed as previewable, but `JSZip` is a *zip* reader and refuses both | fixed — a tar reader (the format's own header checksum) plus the engine's native `DecompressionStream` for gzip |
| **`.rar`/`.7z`**, Word 97-2003 **`.doc`/`.ppt`** | a real `.doc` reached a renderer that reads OOXML and threw; `.rar`/`.7z` matched a mime check on `"compressed"` | `.rar`/`.7z` are no longer claimed (downloads, not a Preview button that fails); a real OLE2 file gets a card naming the format and the way out, and a `.doc` that is really RTF shows its extracted text |

Two verification notes worth keeping. The tar sniffer had a real bug that only a
test fixture could find: a one-file tar (header + padding + the two zero blocks
that end an archive) was being listed as a single gzipped file, because the
sniffer required the *next* block to be another header. And the crop assertion
was checked against the pre-fix code to prove it fails (540pt instead of 468pt),
so the test cannot pass for the wrong reason.

**Desktop verification, in the app rather than a browser.** `desktop-smoke.spec.ts`
attaches to the real box window over CDP and drives the changed views — a real
DOCX through `docx-preview`, a `.tar`, a legacy `.doc`, an RTF `.doc`, and the
PDF editor's duplicate + crop — with a phone-sized viewport emulated, asserting
the app window reports **no console errors or uncaught exceptions** during any of
it and that the process is still alive afterwards. `clipboard-file-desktop.spec.ts`
closes §13.16's open gap: the copy is made from the app's own
`copyFileToOsClipboard` in the real window and verified with PowerShell's
`Get-Clipboard -Format FileDropList`, byte for byte, in the app's own clipboard
folder.
