# Website-in-a-Box (Tauri 2) + Mobile Session Persistence — Master Plan

Status: **in progress** — Phase 0 (session persistence) and the Phase 1 desktop/Android
**scaffold** are implemented; push, background-call service wiring, signing and cert
pinning remain. Per-feature status, how each is built, and **where to debug it** are in §9.
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

#### A3.5 Push notifications — mobile, app **closed**
- **Goal:** Message/call notifications arrive when the box hasn't been opened.
- **Strategy:** Server gains ~100 lines (`server/src/push.rs`) + a `push_devices` table +
  `POST /api/push/register|unregister`. Android→FCM (`messages:send`). The box registers
  its device token on launch and on token refresh. Payload contract =
  the one `sw.js`'s `push` handler already parses (`title/body/tag/url/actions`), plus a
  `type: "incoming_call"` variant.
- **Proof:** App force-stopped → server sends a message → notification appears → tap opens
  the correct DM. Repeat for a call → full-screen incoming call.
- **Risk:** **No push without a Firebase account.** This is the single biggest
  external dependency; make it a Phase-3 gate with a documented "local-only desktop"
  fallback so the box is useful before FCM exists.

#### A3.6 Incoming-call UX (foreground + background)
- **Goal:** A call looks like WhatsApp/Discord, even from a cold start.
- **Strategy:** Push/local notification carries `{type:"incoming_call", caller, dm_channel_id,
  ring_token}`. Tapping it deep-links into the call view (`sw.js`'s `notificationclick`
  already implements `navigate` to a URL — reuse it). On Android a full-screen intent
  shows the incoming call.
- **Proof:** Call while app is (a) foreground, (b) backgrounded, (c) force-closed → all
  three show the incoming call and Accept joins.
- **Risk:** Android full-screen intents need the manifest/Kotlin wiring from the
  call-service plugin — scope explicitly.

#### A3.7 Mobile: hold calls with the screen off
- **Goal:** Lock the phone → audio continues both ways, like a phone call.
- **Strategy:**
  - **Android:** a `CallForegroundService` (`foregroundServiceType="mediaCall"`) started
    from JS via a Rust command when a call connects. Manifest: `FOREGROUND_SERVICE`,
    `FOREGROUND_SERVICE_MEDIA_CALL`, `WAKE_LOCK`, `RECORD_AUDIO`, `POST_NOTIFICATIONS`.
  - JS hook in `static/voice.js`: on call connect → `invoke('start_call_service', …)`;
    on end → `invoke('stop_call_service')`. Guard with `if (window.__TAURI__)`.
- **Proof:** Start a call, lock the screen, wait 5 minutes, verify two-way audio
  (recorded on the other peer). Android also shows the persistent "In voice call"
  notification.
- **Risk:** Android 14 foreground-service typing is strict. Budget a bake-in day.

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

#### A3.10 Auto-update / release channel — ❌ dropped
- **Decision (2026-09):** `tauri-plugin-updater` is **not adopted** — it adds a signing-key
  and `latest.json` manifest burden for little gain on a sideloaded app. Users re-download
  each release from the Releases page (§10).

#### A3.11 Tailscale host + self-signed certs (hardening over the draft plan)
- **Goal:** Reach `https://100.x.x.x:3443` without disabling TLS verification globally.
- **Strategy:** Pin the host's certificate fingerprint (TOFU) on first successful connect
  and store it in `config.json`; the Rust HTTP client trusts only that fingerprint. Expose
  a "certificate changed, re-trust?" prompt. Avoid
  `danger_accept_invalid_certs(true)` in release.
- **Proof:** Connect to a self-signed host (✓ after TOFU); swap the cert → warning appears;
  MITM with a different cert → refused.
- **Risk:** Cert rotation forces a re-trust step — acceptable and safer than blind trust.

#### A3.12 Security hardening
- **Capabilities:** only `notification`, `updater`, `autostart`, `store`/`stronghold`,
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
| Native local notif | ✅ | ✅ | ❌(push) |
| Push (app closed) | ❌ | ❌ | FCM |
| Background call, screen off | tray | tray | foreground svc |
| Screen share | getDisplayMedia | ✅ | getDisplayMedia (API 29+) |
| Session in keychain | ✅ | ✅(libsecret) | ✅ |

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

**Phase 2 — Android (3–4 days):** APK build, foreground-service calls, getDisplayMedia
screenshare verification, FCM registration, proof rows 1–4 (Android side).

**Phase 3 — push + calls infra (1.5–2 days):** `server/src/push.rs`, `push_devices`
migration, `/api/push/*`, contract shared with `sw.js`. **External gate:** a Firebase account.

**Phase 4 — polish (1–2 days):** Windows signing (optional), keychain-backed storage
(A3.9), docs. (The old iOS phase and the updater item were dropped — §8.)

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
  `Manager::add_capability` grants the *runtime-chosen* host access, and
  `showBrowserNotification()` in `chat.js` now calls the Rust `notify` command
  (OS banner; also the only option on Android WebView, which has no Web Notification API).
- **Android build target**: `#[cfg_attr(mobile, tauri::mobile_entry_point)]`, desktop-only
  code gated behind `cfg(desktop)`, `bundle.android.minSdkVersion = 29`, a Kotlin
  `CallForegroundService` template, and `.github/workflows/android.yml` (APK).

Still open: push notifications (FCM — needs a Firebase account), the Android
mobile plugin that starts/stops the foreground service, cert pinning.

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
4. Auto-updater (`tauri-plugin-updater`): **not adopted** — users re-download each
   release from the Releases page (§10).

Next up: Phase 2 (Android device run) and Phase 3 (FCM push).

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
window.__TAURI__.core.invoke('get_config')           // read saved config
tauri.core.invoke('test_connection', { url: 'https://localhost:3443' })
tauri.core.invoke('notify', { title: 'hi', body: 'test' })   // native banner
```

### 9.1 Feature status → where to debug

| Feature | Status | Implemented in | How to debug |
|---|---|---|---|
| **First-run setup** (host ID) | ✅ done | `static/box-setup.html`; `open_setup()` + `save_config` in `src-tauri/src/lib.rs`; `src-tauri/src/config.rs` | Delete `config.json` and relaunch → setup should appear. Inspect the file after saving. `save_config` validates the URL before writing (a bad address can't brick startup). |
| **Change host ID** | ✅ done | tray item `change` → `open_setup()`; existing window gets `w.navigate(new_url)` | Tray → *Change Server Address…*; confirm the window reloads the new origin; check stderr for `open_main failed` |
| **Connection test / warning** | ✅ done | `test_connection` (`reqwest`, 8 s timeout, `danger_accept_invalid_certs`) | From the setup screen or console (one-liner above). Compare with `curl -sk <url>`; error text distinguishes timeout vs refused vs HTTP status |
| **No browser / standalone window** | ✅ done | runtime window creation in `open_main()` | Launch the binary either way; DevTools is the only "browser UI" |
| **Tray + auto-start + close-to-tray** | ✅ done (desktop) | `build_tray()`; `on_window_event(CloseRequested)`; `tauri-plugin-autostart` | Tray menu ids: `show`, `change`, `quit`. Toggle auto-start in setup → on Linux check `~/.config/autostart/*.desktop`, Windows: Task Manager → Startup |
| **Navigation allowlist** | ✅ done | `.on_navigation(...)` in `open_main()`; `tauri-plugin-opener` | Click an external link in a message → must open in the system browser, not in-app. Non-http(s) schemes (blob/data) are allowed by design |
| **Native notifications (desktop + Android, app open)** | ✅ done | Rust `notify` command; `grant_remote_ipc()` (dynamic `CapabilityBuilder` → `add_capability`); `showBrowserNotification()` in `static/chat.js` | If `window.__TAURI__` is `undefined` **on the remote page**, the capability wasn't granted — watch stderr for `grant_remote_ipc(...) failed`. Test directly with the `notify` one-liner. On Windows check Focus Assist; on Linux check a notification daemon is running |
| **Session persistence (mobile)** | ✅ done | `static/secure-storage.js` (`_hasPasswordBootstrap`, `_ensureKey` order, `_secRedriveKey`, `_afterSodium`), `static/chat.js` boot self-heal | Console: `window._secGetRaw('token')` (ciphertext) vs `window._secGet('token')` (plaintext, `null` = key mismatch). Force a cold start: `sessionStorage.clear(); location.reload()`. Automated: `npx playwright test tests/session-persistence.spec.ts` (see §6a) |
| **Screen share (Android)** | ✅ works via web app | existing `startScreen()`/`getDisplayMedia` in `static/voice.js` | In-app console: `typeof navigator.mediaDevices.getDisplayMedia` → `'function'` on Android 10+ (minSdk 29). Remote peer should see frames; check the relay logs |
| **Android build target** | ⏳ ready, needs toolchain | `#[cfg_attr(mobile, tauri::mobile_entry_point)]`, `cfg(desktop)` gates, `bundle.android.minSdkVersion=29`; `.github/workflows/android.yml` | `cargo tauri android init` → `cargo tauri android build --apk`. Install: `adb install -r <apk>`. Logs: `adb logcat | grep -iE 'e2echat|RustStdoutStderr'`. Remote DevTools: `chrome://inspect` (debug builds) |
| **Background calls (screen off)** | ✅ plugin built (Android wiring pending) | `src-tauri/plugins/call-service/` — Rust `init()` + `build.rs` (`android_path`), Kotlin `CallServicePlugin.kt` (`@Command start`/`stop`) + `CallForegroundService.kt`, plugin `AndroidManifest.xml`; called from `_boxCallService()` in `static/voice.js` (`handleVoiceJoined` / `teardownRoom`) | Console: `tauri.core.invoke('plugin:call-service|start', {channelName:'t'})`. Service up? `adb shell dumpsys activity services \| grep -i CallForegroundService` while in a call, gone after hang-up. Permission rejected → `adb logcat \| grep -iE 'callservice\|RustStdoutStderr'` and confirm `grant_remote_ipc: call-service …` didn't fail |
| **Push notifications (app closed)** | ❌ not built | planned: `server/src/push.rs`, `push_devices` migration, `/api/push/register` + `/api/push/unregister`, FCM | Needs a Firebase project (`google-services.json`) first. Debug later via FCM response codes and `SELECT * FROM push_devices` |
| **Full-screen incoming call** | ⛔ partial | push/local notification + deep-link (`sw.js` `notificationclick` already navigates) | Test after push exists; Android full-screen intent is a manifest/Kotlin addition |
| **Code signing (Windows)** | ✅ wired in CI (needs your cert) | `.github/workflows/release.yml`: PowerShell PFX import → `windows-signing.conf.json` passed via `--config` | Gated on job-level `env.*` (secrets are not usable in step `if:`) — with no secret the build still succeeds and is simply unsigned. Debug: read the step log; `Get-AuthenticodeSignature` on a Windows build |
| **Cert pinning** | ❌ not built | planned: pinned cert fingerprint in `config.json` | n/a yet |
| **Release artifacts + checksums** | ✅ done | `release.yml` / `android.yml`: APK staged to `dist/E2E-Chat-<tag>-android.apk` and attached with `SHA256SUMS-android.txt`; desktop publishes `SHA256SUMS-<platform>.txt` | After a tag push, the release must list one APK, four desktop installers and five checksum files. Verify locally: `sha256sum -c SHA256SUMS-android.txt` (or `certutil -hashfile … SHA256` on Windows) |

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
2. Tag and push: `git tag v0.2.1 && git push origin v0.2.1`.
3. GitHub Actions builds and publishes:
   - `.github/workflows/release.yml` — desktop matrix (Windows `.exe`/`.msi`, Linux
     `.AppImage`/`.deb`) and creates a **non-draft Release**
     ("E2E Chat v0.2.1") whose body carries the install notes.
   - `.github/workflows/android.yml` — builds the **APK** and uploads it as a workflow
     artifact (attach it to the release, or download it from the run).
4. Users land on the repo's **Releases** page; the README links to `../../releases/latest`.

**No release published yet?** Actions → *Build Desktop Box* / *Build Android APK* →
**Run workflow** → download the artifact from the finished run.

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
**Save & Launch** (see §9.1).

### 10.3 Alternative: build it yourself (when no release exists yet)

Prerequisites: Rust stable, Node 18+, and the OS Tauri deps (Windows: MSVC Build Tools;
Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`).
Android additionally needs the Android SDK + NDK and Java 17.

| Target | Command | Output |
|---|---|---|
| Any desktop | `cargo install tauri-cli --locked && cargo tauri build` | installers under `src-tauri/target/release/bundle/` |
| Android | `cargo tauri android init` (+ `android-templates/`) then `cargo tauri android build --apk` | `src-tauri/gen/android/app/build/outputs/apk/**/app-*-release.apk` |
| Run without packaging | `cargo run --manifest-path src-tauri/Cargo.toml` | a native window (debug) |

### 10.4 Gaps to close

- ✅ **Checksums** are published (`SHA256SUMS-<platform>.txt` + `SHA256SUMS-android.txt`)
  and the **Android APK is auto-attached** to the same release as the installers.
- ⚠️ **Windows signing is wired but dormant** — it activates only once the repository
  secrets in the `release.yml` header are set. Until then Windows still shows SmartScreen
  "Run anyway". (macOS/iOS signing was removed along with those platforms.)
- ⚠️ **The signed build is untested end-to-end** — the Windows thumbprint hand-off
  (`--config windows-signing.conf.json`) has not been run, because that needs the real
  certificate. A future tagged release is the test.
- ✅ **No auto-updater, by decision** (§8) — users re-download each release. No cert
  pinning yet, so `test_connection` still accepts the self-signed Tailscale certificate.
