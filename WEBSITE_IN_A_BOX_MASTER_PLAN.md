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

| Workstream | Goal | Why now |
|---|---|---|
| **A — Website in a Box** | Ship the existing web app as a native desktop + mobile app (Tauri 2) that **demonstrably proves every feature** in the spec (notifications, calls, screen share, no browser, host-ID entry, tray, etc.) | Turns the PWA into something a non-technical user can install, and lifts mobile browser storage limits |
| **B — Session persistence on mobile** | A user who closes the browser/app and reopens **stays logged in** for the configured session length (`session_duration_seconds`, default 30 days) | Confirmed root cause found in `static/secure-storage.js` — see §3 |

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

#### A3.10 Auto-update / release channel — ❌ **not adopted: manual updates**
- **Decision (2026-09, final):** there is **no** `tauri-plugin-updater`. Users update by
  downloading the new installer from the Releases page; the Android APK is re-installed, and
  the web app in any browser is always current by definition. This was briefly reversed and
  then reverted — an updater needs its own Ed25519 signing key, a `latest.json` release asset
  and a background check, which buys little for a self-hosted app that ships a few builds.
- **Consequence:** nothing to configure and no extra secrets, and one less background network
  call in the box. `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_UPDATER_PUBKEY` no longer exist
  anywhere (removed from `release.yml`, `lib.rs`, `Cargo.toml`, `tauri.conf.json`,
  `static/box-updater.js`).
- **To add it later:** register `tauri-plugin-updater`, generate keys with
  `cargo tauri signer generate`, publish `latest.json`, and turn `bundle.createUpdaterArtifacts`
  on in CI. The release job is structured so that is a purely additive change.

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

| Feature | Win | Linux | Android |
|---|---|---|---|
| Tray | ✅ | ✅(appindicator) | ❌ |
| Auto-start | ✅ | ✅ | ✅ |
| Native local notif (app running) | ✅ | ✅ | ✅ (`tauri-plugin-notification` shim over `window.Notification`; the WebView has no Web Notification API, and Android 13+ needs the POST_NOTIFICATIONS prompt) |
| Push (app **closed**) | ⚠️ Web Push *if* the WebView's Push API is available; otherwise: leave it in the tray | ⚠️ same as Windows | ✅ FCM — **needs your Firebase project** (§A3.5) |
| Full-screen incoming call | – (ring bar) | – (ring bar) | ✅ full-screen intent (device test owed) |
| Background call, screen off | tray | tray | ✅ `phoneCall` foreground service (+ `MANAGE_OWN_CALLS`) |
| Screen share | getDisplayMedia | ✅ | getDisplayMedia (API 29+) |
| Cert pinning (TOFU) | ✅ | ✅ | ✅ |
| Auto-update | ✖ manual re-download | ✖ manual re-download | ✖ re-install the APK |
| Session in keychain | ✅ | ✅(libsecret) | ✅ |

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

| Layer | Tooling | What it proves | Artifact |
|---|---|---|---|
| Web regression | Existing Playwright suite + new specs | chat/voice/notifications/session behavior in a browser | JUnit/HTML report, traces |
| Storage unit | `tests/test-secure-storage.html` runner (exists) | key derivation/round-trip, B3 cases | assertion log |
| Box integration | Rust `#[test]` + a `tauri::test` harness | config round-trip, conn-test errors, capabilities | `cargo test` output |
| Device matrix | Manual checklist + screen recordings | tray, notifications with app closed, background call, screen share | committed `.mp4`/screenshots under `visual-evidence/` |
| Release | GitHub Actions | installers build per platform; updater flow | Release assets + green checks |

Every row in §5 names its artifact path. A feature is only "proven" when that file exists.

---

## 5. Feature → proof matrix

| # | Claim (from the spec) | Implementation (§) | Proof | Artifact |
|---|---|---|---|---|
| 1 | Notifications appear live on mobile even if the app hasn't been opened | A3.5 | Force-stop app, send msg → notification; tap → correct DM | `visual-evidence/push-closed.mp4` |
| 2 | Same with calls | A3.5/A3.6 | Call while closed → full-screen incoming → accept joins | `visual-evidence/push-call.mp4` |
| 3 | Mobile holds calls with screen off | A3.7 | Lock 5 min, verify two-way audio (peer recording) | `visual-evidence/bgcall-android.mp4` |
| 4 | Mobile screenshare when the harness is done | A3.8 | Android share → remote sees live frames | `visual-evidence/screen-android.mp4` |
| 5 | Notification looks a lot better on PC | A3.4 | Native banner with name/avatar/actions; click focuses | `visual-evidence/notif-desktop.png` ×3 OS |
| 6 | Doesn't have to open the browser to access it | A2/A3.3 | Launch app, standalone window, minimize to tray | `visual-evidence/standalone.png` |
| 7 | Input the host device ID to reach the right Tailscale page | A3.1 | First run → setup → real login page | `visual-evidence/setup.png` |
| 8 | Warning if it doesn't exist | A3.2 | Table-driven failure states | `visual-evidence/conn-test.png` ×3 |
| 9 | Possibility to change the host IP | A3.3 | Tray → Change Server Address → reconnect | `visual-evidence/change-host.mp4` |
| 10 | Session persists after closing/reopening (mobile) | B2/B3 | `session-persistence.spec.ts` + device check | Playwright report + `visual-evidence/session-restore.mp4` |
| 11 | Session honored for the configured length | B4 | Renewal test tracks chosen duration | `tests/session-persistence.spec.ts` |

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

| What | How |
|---|---|
| Type-check the Rust crate (no Tauri CLI needed) | `cargo check --manifest-path src-tauri/Cargo.toml` |
| Run with visible Rust logs | launch the binary **from a terminal** — `eprintln!` output (IPC/capability/tray errors) goes to that terminal. `./src-tauri/target/debug/e2e-chat-app.exe` (Win) / `src-tauri/target/debug/e2e-chat-app` (Linux) |
| Open the webview DevTools | In a **debug** build, right-click inside the app → *Inspect* (WebView2 = Chromium DevTools). The app's own pages also get `window.__TAURI__` (`withGlobalTauri`), so you can call commands from the console |
| Reset to first-run | delete the config file (below), then relaunch |
| Local installer build | `cargo install tauri-cli --locked` → `cargo tauri build` |

Config file (contains `server_url`, `auto_start`, `minimize_to_tray`):

| OS | Path |
|---|---|
| Windows | `%APPDATA%\com.e2echat.app\config.json` |
| Linux | `~/.config/com.e2echat.app/config.json` |

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

| Feature | Status | Implemented in | How to debug |
|---|---|---|---|
| **First-run setup** (host ID) | ✅ done | `static/box-setup.html`; `open_setup()` + `save_config` in `src-tauri/src/lib.rs`; `src-tauri/src/config.rs`; `open_main_at_setup()` is the single-window fallback (Android below 12L cannot open a second window) | Delete `config.json` and relaunch → setup should appear. Inspect the file after saving. `save_config` validates the URL before writing (a bad address can't brick startup). |
| **Change host ID** | ✅ done — tray (desktop) **and** in-app (both platforms); the in-app button was silently dead until 2026-09-20 (§11.1) | tray item `change` → `open_setup()`; **Settings → Connection** tab (`static/index.html` + `initConnectionSettings()` in `static/chat.js`) shows `location.origin` and emits `box:change-server`; the listener in `run()` calls `open_setup()`, which opens the setup **window** on desktop and takes over the **main window** on mobile (`open_setup_in_main`, with `app_page_url()`/`is_app_page()` so the navigation allowlist lets the bundled page through); `save_config()` then navigates that same window to the new origin | Tray → *Change Server Address…*, or in-app Settings → Connection → *Change server address…*. Any host **and port** are accepted (`normalize()` in `box-setup.html` only defaults a missing scheme / the port to `3443`). **Why an event and not `invoke('show_setup')`:** this page is served by the *host*, and Tauri refuses app commands to a remote origin — §9.2. Confirm the window reloads the new origin; check stderr for `open_main failed` or `box:change-server: could not open setup` |
| **Dead saved host (mobile fallback)** | ✅ done — new 2026-09-20 (§11.1 #8) | `host_reachable()` + the `saved_url` filter in `run()` | Point the config at a host that is off, then launch **on Android**: the setup screen must appear (prefilled with the dead address) instead of a blank error page, and stderr logs `saved host unreachable (<url>); showing setup`. Desktop is deliberately unaffected — use the tray. Fix the address with Test connection → Save & Launch, which navigates the same window back |
| **Connection test / warning** | ✅ done | `test_connection` (`reqwest`, 8 s timeout, `danger_accept_invalid_certs`) | From the setup screen or console (one-liner above). Compare with `curl -sk <url>`; error text distinguishes timeout vs refused vs HTTP status |
| **No browser / standalone window** | ✅ done | runtime window creation in `open_main()` | Launch the binary either way; DevTools is the only "browser UI" |
| **Tray + auto-start + close-to-tray** | ✅ done (desktop) | `build_tray()`; `on_window_event(CloseRequested)`; `tauri-plugin-autostart` | Tray menu ids: `show`, `change`, `quit`. Toggle auto-start in setup → on Linux check `~/.config/autostart/*.desktop`, Windows: Task Manager → Startup |
| **Navigation allowlist** | ✅ done | `nav_allowlist()` in `src-tauri/src/lib.rs`, attached by **both** main-window builders (`open_main_window` and the mobile `open_setup_in_main` — the latter was missing it until 2026-09-20, §11.1 #9); the decision is `nav_allowed()`, unit-tested; `tauri-plugin-opener` for the hand-off | Click an external link in a message → must open in the system browser, not in-app. Non-http(s) schemes (blob/data) are allowed by design |
| **Native notifications (desktop + Android, app open)** | ✅ done — but it was silently dead in the box until 2026-09-20 (§11.1) | `tauri-plugin-notification`: its init script replaces `window.Notification` with a shim that posts `plugin:notification|notify`, which `remote-main` grants through `notification:default`; `showBrowserNotification()` in `static/chat.js` just calls `new Notification(...)` | The page must have `window.__TAURI__` **and** the capability must have been granted (stderr: `grant_remote_ipc(...) failed`). Console: `Notification.permission`, `tauri.core.invoke('plugin:notification|notify', { options: { title: 'hi', body: 'test' } })`. Android also needs POST_NOTIFICATIONS (the box asks once on first page load) and, on Android 14+, *Full screen notifications* in system settings for the incoming-call ring. On Windows check Focus Assist; on Linux a notification daemon |
| **Session persistence (mobile)** | ✅ done | `static/secure-storage.js` (`_hasPasswordBootstrap`, `_ensureKey` order, `_secRedriveKey`, `_afterSodium`), `static/chat.js` boot self-heal | Console: `window._secGetRaw('token')` (ciphertext) vs `window._secGet('token')` (plaintext, `null` = key mismatch). Force a cold start: `sessionStorage.clear(); location.reload()`. Automated: `npx playwright test tests/session-persistence.spec.ts` (see §6a) |
| **Screen share (Android)** | ✅ works via web app | existing `startScreen()`/`getDisplayMedia` in `static/voice.js` | In-app console: `typeof navigator.mediaDevices.getDisplayMedia` → `'function'` on Android 10+ (minSdk 29). Remote peer should see frames; check the relay logs |
| **Android build target** | ⏳ ready, needs toolchain | `#[cfg_attr(mobile, tauri::mobile_entry_point)]`, `cfg(desktop)` gates, `bundle.android.minSdkVersion=29`; `.github/workflows/android.yml` | `cargo tauri android init` → `cargo tauri android build --apk` (CI then **signs** the output with `apksigner`, because an unsigned release APK is uninstallable; locally add `--debug` for an installable build). Install: `adb install -r <apk>`. Logs: `adb logcat | grep -iE 'e2echat|RustStdoutStderr'`. Remote DevTools: `chrome://inspect` (debug builds) |
| **Background calls (screen off)** | ✅ done (Android wiring wired, device test owed) | `src-tauri/plugins/call-service/` — Rust `init()` + `build.rs` (`android_path`), Kotlin `CallServicePlugin.kt`/`CallForegroundService.kt`, plugin `AndroidManifest.xml`; started/stopped from `_boxCallService()` in `static/voice.js` (call join → `start`, every `teardownRoom` → `stop`) | Console: `tauri.core.invoke('plugin:call-service|start', {channelName:'t'})`. Service up? `adb shell dumpsys activity services \| grep -i CallForegroundService` while in a call, gone after hang-up. Permission rejected → `adb logcat \| grep -iE 'callservice\|RustStdoutStderr'` and confirm `grant_remote_ipc: call-service …` didn't fail |
| **Push notifications (app closed)** | ✅ done (Web Push live; FCM awaits your Firebase project) | `server/src/push.rs` (VAPID self-bootstrap, RFC 8291 encryption, ES256 JWT, FCM sender), `server/migrations/091_push_devices.sql`, `db.rs` helpers, `/api/push/vapid-public-key\|register\|unregister` (`handlers.rs`), fan-out from `ws.rs` (`handlers::push_to_users`), `static/push-client.js` | `tests/push-notifications.spec.ts`. Live: `curl -k https://<host>:3443/api/push/vapid-public-key`; check `vapid_private.pem` appeared next to the DB on first boot. FCM needs a Firebase service-account key in `FCM_SERVICE_ACCOUNT_JSON` (raw JSON or a path) — a missing key just disables the Android leg. Crypto: `cargo test push` (RFC 8291 test vector + round-trip) |
| **Full-screen incoming call** | ✅ done (device test owed) | `static/voice.js` `_boxIncomingCall()` (called from `showIncomingCall` when `document.hidden`, cancelled in `hideIncomingCall`); Kotlin `IncomingCallNotifier.kt` (high-importance channel, ringtone, full-screen intent, Decline receiver); `USE_FULL_SCREEN_INTENT` in the plugin manifest; the `dm_call_ring` push carries `/?dm=<id>` | `adb logcat \| grep -iE 'incomingCall\|IncomingCallNotifier\|RustStdoutStderr'`. Confirm the notification permission was granted (Android 13+) — without it the native ring is silently dropped and only the in-app bar shows |
| **Updates** | ❌ **not adopted — manual re-download** (§A3.10) | nothing to configure: no `tauri-plugin-updater`, no signing key, no `latest.json` | Grab the newest installer from <https://github.com/MaskBoy999/E2E_Talk/releases> (Android: re-install the APK). A browser never needs updating |
| **Code signing (Windows)** | ✅ wired in CI **and auto-verified** (needs your cert) | `.github/workflows/release.yml`: the PowerShell PFX import merges `bundle.windows` into `ci-signing.conf.json`, passed via a single `--config`; a later step runs `Get-AuthenticodeSignature` over every bundled `.exe`/`.msi` and **fails the job** if any is not `Valid` — so a silent signing misconfiguration can no longer ship | Gated on job-level `env.*` (secrets are not usable in step `if:`) — with no secret the build still succeeds and is simply unsigned. Debug: read the step log; `Get-AuthenticodeSignature` on a Windows build |
| **Cert pinning (TOFU)** | ✅ done for the Rust client (WebView TLS is out of reach — see §A3.11) | `src-tauri/src/cert_probe.rs` (rustls fingerprint verifier + leaf-cert capture), `pinned_cert_sha256` in `src-tauri/src/config.rs`, enforcement in `open_main`, trust checkbox + `probe_certificate` in `static/box-setup.html` | Delete `config.json` → setup → *Test connection* shows the fingerprint → *Save & Launch* pins it. Swap the server cert and relaunch: startup must refuse with the "certificate changed" message (`open_main failed` on stderr). If the app window shows a certificate error instead of the login page, that is the WebView (not the pin) — use a Tailscale-issued cert or trust `certs/` in the OS store |
| **Release artifacts + checksums** | ✅ done (+ a guard so an empty release can't happen silently) | `release.yml` / `android.yml`: APK staged to `dist/E2E-Chat-<tag>-android.apk` and attached with `SHA256SUMS-android.txt`; desktop publishes `SHA256SUMS-<platform>.txt`. New: `permissions: contents: write` (so publishing can't 403), a **Verify installers were produced** step that fails the job when the bundle is empty, and a **Verify Windows signature** step when a certificate is present | After a tag push, the release must list one APK, the desktop installers and the checksum files. Verify locally: `sha256sum -c SHA256SUMS-android.txt` (or `certutil -hashfile … SHA256` on Windows) |

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

| Platform | Download | Install | Notes |
|---|---|---|---|
| **Windows** | `E2E-Chat_<ver>_x64-setup.exe` (NSIS) or `E2E-Chat_<ver>_x64_en-US.msi` | Run the installer | SmartScreen (unsigned): **More info → Run anyway**. WebView2 is pre-installed on Win 10/11 |
| **Linux — AppImage** | `E2E-Chat_<ver>_amd64.AppImage` | `chmod +x` then run it | Needs FUSE (`sudo apt install libfuse2` on Ubuntu 22.04+) |
| **Linux — Debian/Ubuntu** | `E2E-Chat_<ver>_amd64.deb` | `sudo apt install ./E2E-Chat_<ver>_amd64.deb` | Pulls in `libwebkit2gtk-4.1` automatically |
| **Android** | `app-universal-release.apk` (all ABIs) or `app-arm64-v8a-release.apk` (most phones) | Enable *Install unknown apps* for the browser/file manager, open the APK | Requires **Android 10+** (minSdk 29); install + connect the **Tailscale** app first |

> **No macOS/iOS builds by design** (§8): Apple distribution needs paid certificates and
> heavy native work. On an iPhone or Mac, use the web app in Safari — it's the same
> codebase the box wraps.

First launch on every platform: enter `https://100.x.x.x:3443` → **Test connection** →
**Save & Launch** (see §9.1). That first save also **pins the server's certificate**
(TOFU), so a later certificate swap is refused until you re-trust it.

#### Opening the app after it is installed

| Platform | How you launch it every day | Notes |
|---|---|---|
| **Windows** | Start menu / desktop shortcut **E2E Chat**, or the tray icon after you close the window | The installer creates both shortcuts. Closing the window **hides to the tray** (it is still running) — use the tray's *Quit* to exit, or re-open from the tray |
| **Linux (AppImage)** | Double-click the `.AppImage`, or run `./E2E-Chat_<ver>_amd64.AppImage` from a terminal | `chmod +x` once after download; needs FUSE (`libfuse2`) |
| **Linux (.deb)** | Launcher entry **E2E Chat** (installed system-wide), or run `e2e-chat-app` | `sudo apt install ./E2E-Chat_<ver>_amd64.deb` |
| **Android** | App drawer icon **E2E Chat** | Sideload the APK, allow *Install unknown apps*; connect the **Tailscale** app first, and grant notification + microphone permissions so background calls and the full-screen ring work |

If the window opens but the app says it cannot connect, it is almost always the host
address (see §9.1, *Connection test / warning*), not the install.

### 10.3 Alternative: build it yourself (when no release exists yet)

Prerequisites: Rust stable, Node 18+, and the OS Tauri deps (Windows: MSVC Build Tools;
Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`).
Android additionally needs the Android SDK + NDK and Java 17.

| Target | Command | Output |
|---|---|---|
| Any desktop | `cargo install tauri-cli --locked && cargo tauri build` | installers under `src-tauri/target/release/bundle/` |
| Android | `npm install` (installs the pinned `@tauri-apps/cli` **and** provides `node_modules/.bin/tauri`, which the generated Gradle project invokes) → `npx tauri android init` (+ `android-templates/`) → `npx tauri android build --apk --target aarch64` | `src-tauri/gen/android/app/build/outputs/apk/**/app-*-release.apk` |
| Run without packaging | `cargo run --manifest-path src-tauri/Cargo.toml` | a native window (debug) |

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

| # | Symptom | Root cause (in the code) | Fix |
|---|---|---|---|
| 1 | **The APK never built** — eight red CI runs, v0.2.1–v0.2.8 | `plugins/call-service/android/.../AndroidManifest.xml` declared `android:foregroundServiceType="mediaCall"`, which is not a foreground-service type; AAPT fails the resource link ("`mediaCall` is incompatible with attribute foregroundServiceType") and the whole build dies | `phoneCall` + `FOREGROUND_SERVICE_PHONE_CALL` + `MANAGE_OWN_CALLS` (the documented prerequisite), and `ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL` in Kotlin |
| 2 | **Settings → Connection did nothing** in the box (the address showed "…") | The tab lives in the *host-served* page, and Tauri refuses **app** commands (`get_config`, `show_setup`) to a remote origin — `remote-main` only grants plugin permissions, so both calls came back `Command … not allowed by ACL` | the tab shows `location.origin` (no IPC at all) and the button emits `box:change-server`; the Rust listener opens the setup screen |
| 3 | **Change-server on Android** would still have failed after (2) | A second window on Android needs extra Activities declared in the generated project (Tauri's multi-window guide) and this app has none — so `open_setup()` could not work there | `open_setup_in_main()`: on mobile the setup page takes over the **main** window; `app_page_url()` + `is_app_page()` stop the navigation allowlist from punting that bundled page to the system browser |
| 4 | **No notifications at all inside the box** | `showBrowserNotification()` invoked the app-level `notify` command from the remote page — rejected by the same ACL rule, and the rejected promise was never handled, so nothing appeared anywhere | dropped that branch: the notification plugin's shim already handles `new Notification(...)`. The now-dead `notify` command was deleted rather than left as a trap |
| 5 | **Calls could not capture audio or video on Android** | `RECORD_AUDIO` / `MODIFY_AUDIO_SETTINGS` / `CAMERA` were never declared anywhere — the plan asked for `RECORD_AUDIO` in A3.7 but the manifest never carried it. wry's `RustWebChromeClient.onPermissionRequest` maps the WebView's capture request onto the Android runtime prompt, but an **undeclared** permission is auto-denied | declared in the plugin manifest (which is the only manifest this repo controls — `gen/android/` is generated) |
| 6 | **Native notifications dropped on Android 13+** | `POST_NOTIFICATIONS` was declared but never *requested*; nothing prompted, and the incoming-call notifier silently skips when it is not granted | the box asks once per install (via the plugin's `is_permission_granted` → `request_permission`, both granted to the remote origin) on the first page load |
| 7 | **Gradle's Rust task could not run at all** — in CI too, hidden behind #1 because Gradle runs the two in parallel | `gen/android/buildSrc/…/BuildTask.kt` (written by `android init`) builds Rust by shelling out to `npm run -- tauri android android-studio-script`, and this repo had neither a `tauri` npm script nor an installed `@tauri-apps/cli` → every attempt ended in `npm error Missing script: "tauri"`, so the `.so` was never built at all | `@tauri-apps/cli` 2.11.2 + a `"tauri": "tauri"` script in the root `package.json` (lockfile updated), and CI now installs it with `npm ci` instead of `cargo install tauri-cli` — which also removes a ~6-minute compile from every run |
| 8 | **Android: a saved host that is switched off was a dead end** — the WebView sat on its own error page with no tray, no address bar and nothing to press, so the only route back to the setup screen was clearing the app's data | startup treated an unreachable host as fine: `check_pinned_cert` compares a pin only when the host answers at all (deliberately, so an offline launch still opens the window), and `open_main_window` then opened a window that could never load | mobile startup probes the saved host first (`host_reachable`) and shows the setup screen when it does not answer — that page prefills the saved address (`get_config`), so correcting a typo is one edit. Desktop is untouched: it has the tray's *Change Server Address…* |
| 9 | **Android: the main window's navigation allowlist was never active** | the first run on mobile creates the main window from `open_setup_in_main`, which built it *without* `.on_navigation` — so "a link in a message opens in the system browser" never applied there, and a phone has no tray, address bar or back button to escape with | the allowlist is now one shared function (`nav_allowlist`), attached by **both** places that build the main window, with its decision half split out as `nav_allowed` so it is unit-tested |

**Verified locally, not just reasoned about** (Windows, SDK 36 + NDK 27):
`npx tauri android build --apk --target aarch64` exits 0 and produces a 15 MB
`app-universal-release-unsigned.apk` containing `lib/arm64-v8a/libe2e_chat_app_lib.so`; the
manifest compiled *into the APK* carries `foregroundServiceType=0x4` (`phoneCall`) plus
`RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `CAMERA`, `POST_NOTIFICATIONS` and
`USE_FULL_SCREEN_INTENT`; the signed artifact verifies with `apksigner` against the upload key;
and `cargo test` covers the pin re-check and the navigation allowlist. The build half is no
longer guesswork; what remains unproven is everything that needs a device.

> **Deploy both halves.** `static/` is served by **your server**, not shipped inside the APK, so
> #2/#4/#6 only reach a device once the updated `static/` is deployed there — while the APK
> carries the other half of #2 (the `box:change-server` listener and `open_setup_in_main`).
> Updating one alone leaves the button dead: an old APK has no listener, and an old server
> still calls the app commands the ACL rejects.

### 11.2 Windows / Linux (desktop)

| | Item |
|---|---|
| ❌ | **§5 proof artifacts** — `standalone.png`, `setup.png`, `conn-test.png` ×3, `notif-desktop.png` ×3, `change-host.mp4`. `visual-evidence/` holds only unrelated `T1…T8` screenshots, so the "Definition of Done" in §0 is unmet even though the features themselves are in. |
| ⚠️ | **Windows code-signing certificate** (PFX + secrets) — wired into `release.yml` and auto-verified, but dormant until the secret exists; SmartScreen shows "Run anyway" until then. External gate. |
| ⚠️ | **A self-signed host certificate stops the app window loading at all** (already documented in A3.11): TOFU covers our HTTP client only — the WebView does its own TLS validation. Fix is `tailscale cert` on the host (or trusting `certs/` in the OS store). Worth repeating in the download notes, because it looks like a broken install rather than a certificate prompt. |
| ⚠️ | **A3.9 keychain-backed storage is still deferred** — on desktop a WebView data wipe costs the local key material; the session survives only through the server-side encrypted key backup. |
| ➖ | Web Push inside the WebView stays best-effort by design (A5 note) — the intended desktop mode is "leave the box running in the tray". |

### 11.3 Android

| | Item |
|---|---|
| ❌ | **The release APK is signed with a throwaway debug key whenever `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` are unset.** Each CI run generates a *fresh random* keystore, so every release has a different signature: installing an update in place fails (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`) and the user must uninstall first — which wipes the WebView's local keys. **Set those three secrets (and update them in no more than one place) before telling anyone to update**; §10.1's "re-install the APK" wording hides this. |
| ❌ | **Never run on a device.** Everything in the Android column of §9.1 marked "device test owed": background call with the screen off, the full-screen incoming ring, screen share, session persistence across a real restart, and the new in-app change-server flow. |
| ❌ | **FCM push while the app is closed** — external gate: a Firebase project, `google-services.json` into `src-tauri/gen/android/app/`, and the `firebase-messaging` dependency (A3.5). |
| ⚠️ | **Was: no escape hatch when the saved host is unreachable** — closed in code (§11.1 #8): mobile startup probes the saved host and falls back to the setup screen, which prefills the saved address. Desktop keeps the tray. *The fallback itself has not been seen on a device yet* — it is the first thing to check when you install the APK, because it is the one path that can only be reached with a deliberately broken address. |
| ⚠️ | **Android 14+ gates `USE_FULL_SCREEN_INTENT`** behind "Full screen notifications" in system settings for apps whose core function is not calling/alarms (targetSdk here is 36). Sideloaded, so nothing blocks — but the incoming-call ring degrades to a heads-up notification until the user grants it. Needs a device check, and probably a one-time hint in the app. |
| ⚠️ | **`minSdkVersion` is 29 (Android 10), but a second window needs API 32+ (12L).** Handled — `open_setup_in_main` avoids the second window entirely on mobile — noted so nobody "simplifies" it back. |
| ⚠️ | **Android screen share** rides on `getDisplayMedia` + the system picker; A3.8's OEM-variation risk is still unverified. |

### 11.4 Web (plain browser)

Nothing box-specific outstanding: the Connection tab stays hidden without `window.__TAURI__`
(`initConnectionSettings` returns early), and Workstream B is covered by
`tests/session-persistence.spec.ts`.

### 11.5 Documentation debt

- `SECURITY_FIX_PLAN.md` is **superseded** by this document (its own header says so), yet it
  still contains the `FOREGROUND_SERVICE_MEDIA_CALL` / `foregroundServiceType="mediaCall"`
  snippet that broke the APK build for eight runs. Left as-is on purpose — it is a historical
  record, not a spec — but **do not copy manifest lines out of it**; the committed plugin
  manifest is the source of truth.
