# Security review — what was fixed, how it is verified, and what is left

Scope: the 12-finding security review of the E2E_Talk app, plus the two extra
asks that came with it — (a) a cached web app whose server is gone must not be a
dead end, and (b) hardcoded CSS must live in `static/style.css` instead of
inline in HTML/JS.

Everything below was verified on `https://localhost:3443` with the Playwright
suite in `tests/` and `cargo test` in `server/`. The command list is at the end.

---

## 1. Status at a glance

| # / ask | What it is | Status |
|---|---|---|
| 1 | Critical — stored XSS in the Markdown renderer | Done — scheme allow-list + attribute escaping, `tests/markdown-xss.spec.ts` |
| 2 | High — the shell shipped with no CSP (`csp: null`) | Done — CSP in `tauri.conf.json`, pinned by `tests/supply-chain.spec.ts` |
| 3 | Replayable login credential | Done — nonce-signature logins only; every legacy fallback removed and the raw-password invariant pinned by tests (§2.1, §6.3); OPAQUE evaluated and declined (§6.3) |
| 4 | `/api/hmac-key` published the **master** HMAC key | Done — derived key + cache version |
| 5 | "Secure storage" is at-rest only | Advisory, stated honestly — no code change can fix it (§6.1) |
| 6 | DNS rebinding / cross-site requests / null `Origin` | Done |
| 7 | Rate + size limits hardcoded (all of them, in KB/MB/GB) | Done — admin panel, live |
| 8 | Document previews ran in a reachable origin | Done — `.docx` and `.xlsx` render in sandboxed frames; CSV/PPTX/PDF verified sink-by-sink (§6.2) |
| 9 | Supply chain: unpinned actions, no attestation | Done — SHA-pinned, least-privilege jobs, build provenance |
| 10 | Traffic analysis / metadata layer | Design gap — documented plan (§6.4); no app impact |
| 11 | No forward secrecy / no post-quantum plan | Design gap — the ASVS-11.1.4 plan is written down (§6.5) |
| 12 | Header/standards deltas (Permissions-Policy, CORP, X-Robots-Tag, HSTS preload, logout eviction) | Done — plus a regression this caused, fixed (§4.1) |
| ask A | Cached web app with no server: no way to change server | Done — Settings → Connection |
| ask B | Hardcoded CSS out of HTML/JS | Done — `static/style.css` + `tools/inline-style-to-class.mjs` |
| ask C | The "erase everything" control must be in the **app** and visible in every state (bad host, dead host, error page, grey page) | Done — native overlay window (§2.8), `tests/box-wipe-overlay.spec.ts` |

Findings 5, 10 and 11 are design/documentation items rather than bugs; §6
carries the review's own wording for each and what was (and was not) done.

---

## 2. What changed

### 2.1 Finding 3 — nonce-signed logins (no replayable credential)

The hole: the login credential was `HMAC-SHA256(hash_key, password)`, sent on
every login — a bearer value that could be replayed forever, and the only thing
standing between a captured request and the account.

Server (`server/src/`):

- `users.login_public_key` (migration **094**) stores a base64 Ed25519 public
  key. `db.rs` gained `get/set/clear_login_public_key`; `create_user` takes it
  as its 13th parameter.
- `POST /api/auth-params/{username}` returns `login_public_key` plus a
  **single-use** `login_nonce` (120 s TTL, at most 8 live per user).
- `POST /api/login` for a keyed account requires `{login_nonce,
  login_signature}` over `"e2e-login-v1|{username}|{nonce}"`, verified with
  `verify_strict`, then the nonce is consumed — a byte-for-byte replay fails.
- Legacy accounts (no key) still log in with the credential **once**, and the
  request may carry `login_public_key`, which retires the credential for good.
  This keeps the one-account/multi-device schema: the keypair is derived from
  the same secret on any device, and no per-device enrolment step exists.
- `change_password` rotates the stored key (or clears it).
- The session cookie is `__Host-e2e_token` (no `Domain`, `Secure`, `HttpOnly`,
  `Path=/`) at all three mint sites, plus extraction and clears.
- 2FA and kill-switch paths are unchanged and still work end to end.

Client (`static/crypto.js`, `auth.js`, `login.html`, `chat.js`):

- `deriveLoginKeypair/deriveLoginPublicKey` from
  `seed = HMAC-SHA256(key=K, msg="e2e:login-signing-seed:v1")`,
  `loginChallengeMessage`, `signLoginChallenge`, and an async
  `loginRequestBody()` that picks the signed path, the legacy-plus-upgrade path,
  or the kill-switch proof.
- Registration sends `login_public_key`; password change sends the new one.
- A client-side strength floor refuses obviously weak passwords before anything
  is sent (the server never sees the raw password, so this is the only place it
  can be enforced).

Tests (`tests/security-review-fixes.spec.ts`, `tests/_auth-helpers.ts`):
replay is rejected, the retired credential shape is rejected, a second device
still logs in with only the password and derives the same key, a register
request without a login key is refused (the dev-stage decision: a keyless
account could never log in), the `__Host-` cookie attributes are asserted, and
weak passwords are refused client-side.

A raw-password block pins the client-side-root constraint itself: register plus
correct / wrong-password / unknown-username / auth-params-outage logins keep the
raw password (and its base64 and percent-encoded forms) out of every
`/api/register` and `/api/login` body, the SQLite main file and WAL are scanned
for it in UTF-8 and UTF-16LE, and a stubbed auth-params response — including
one claiming the retired `legacy_raw_password` shape — proves nothing can talk
the client into sending it.

### 2.2 Finding 7 — every rate and size limit is admin-configurable

`RuntimeTuning` in `server/src/main.rs` holds every limit that used to be a bare
`env::var` read, each with a `sources` entry recording `db` / `env` / `default`.
`0` means unlimited/disabled. Covered values:

- mutations (per user, per IP), file storage quota, max file size
- WebSocket max message bytes, max frame bytes, per-socket byte budget + window,
  auth-message cap
- request body limits (default / import / vault) and request timeout
- login (IP, per user, per user failures), registration (per IP **and per
  username**), kill-switch, 2FA, login-failure notifications, auth-params,
  reauth (IP + user), create-server, **server joins (per account)**, admin
  login, hmac-key, client-config, search, friend requests (IP + user),
  **voice-media budget**
- **every rate-limit window** (mutation, login/2FA, kill-switch, reauth,
  auth-params, registration, server-join, friend request, hmac-key,
  client-config, search, WS auth, voice media, create-server, admin login,
  failed-login notify) — a "10 per 5 min" is not tunable while the window is
  fixed; windows are rejected if set to 0 seconds
- icon-pack slot cap (also served through `/api/client-config`, so the page
  checks the same number) and the per-chunk file-upload bound

Enforcement: `ws.rs` reads the tuning at handshake (and skips a cap that is 0);
`main.rs` uses `DefaultBodyLimit::max(usize::MAX)` plus `body_limit_mw`, which
picks the limit by path, rejects on `Content-Length` up front and on a streaming
counter mid-body (413); `request_timeout_mw` honours a 0 timeout;
`handlers.rs` reads `state.runtime_tuning` everywhere instead of the environment.

Admin UI (`static/admin.html`, `admin.js`): fields are generated from the
server's field list, with `B`/`KB`/`MB`/`GB` unit selects (1024-based), seconds
fields, count fields, and a source badge per field. Every change is audited.

Tests (`tests/admin-runtime-config.spec.ts`, isolated server on ports 3452/3453
with a temp DB): values propagate live (tighten → 413/429 on the next request →
restore), the public `/api/client-config` exposes the effective file size,
sources flip to `db` and persist, invalid values are rejected.

### 2.3 Finding 8 — document previews in an opaque origin

`static/doc-preview.js` renders previews inside a sandboxed frame with no
`allow-same-origin`, so the app's own origin cannot reach the rendered document
(and the document cannot reach the app). `.docx` and `.xlsx` both use it; for
XLSX, SheetJS parses the workbook and builds the table inside the frame, and
the app only receives sheet names, a rendered height and a truncation flag
over `postMessage` — the parent DOM never holds the document's table. Proved by
`tests/security-review-fixes.spec.ts` for both. CSV/PPTX/PDF were verified
sink by sink (§6.2).

### 2.4 Finding 4 — the published HMAC key is derived, not the master

The server derives the key it ships from `HMAC_KEY` in `server/.env`, so the
master can never be used to compute friend/invite hashes. Because a stale
derivation would silently break `isOwn` matching, sender resolution and the
blocked-friend-requests hash, the client caches it together with
`HMAC_KEY_CACHE_VERSION` (`static/chat.js`) and discards a mismatched cache.

### 2.5 Findings 1, 6, 12 — headers, cross-site requests, logout

- Finding 1: CSP + HSTS + the rest of the header set on static assets, API
  responses and 404s.
- Finding 6: an unknown `Host` is rejected (421), a null `Origin` and
  `Sec-Fetch-Site: cross-site` are rejected on state-changing endpoints, and the
  WebSocket handshake refuses a cross-site `Origin`.
- Finding 12: HSTS without `preload`, and logout evicts cookies, cached
  responses and origin storage (`Clear-Site-Data`). The login page's
  stale-cookie call must **not** do that — see §4.1.

### 2.6 ask A — a cached web app is not a dead end

Settings → Connection shows the current server address and a working change
flow in a plain browser (no shell): the new address is normalised (scheme
defaults to `https`, port to `3443` only when omitted), and a different origin
navigates there for a fresh login, since it has its own storage and session.
Covered by the `web connection tab` test in
`tests/security-review-fixes.spec.ts`.

### 2.7 ask B — hardcoded CSS moved into `static/style.css`

Inline `style="…"` blocks and `<style>` blocks in `static/index.html` and the
JS that builds markup were extracted into classes in `static/style.css`
(`tools/inline-style-to-class.mjs` does the extraction; the `u-XXXXXXXX` class
names are content-addressed). Every app file has now been run through it:
`index.html`, `admin.html`, `login.html`, `pair.html`, `chat.js`, `admin.js`,
`voice.js`, `roles.js`, `doc-preview.js`, `icon-packs.js`,
`thread_categories_shortcuts.js`, `soundboard-pairing.js`, `app-overlay.js`
(204 further attributes → 134 classes), and `admin.html`'s two `<style>` blocks
(plus the `css-spin` keyframes from `thread_categories_shortcuts.js`) moved into
`style.css` verbatim.

What is deliberately **not** extracted: `display:` values, because both the app
(46 sites) and the suite (347 assertions) read `element.style.display` as a
visibility flag and a class-backed value reads as `''` there — that needs an
accessor refactor first; values built at runtime with `+`/`${}`; and the three
standalone pages that do not load `style.css` at all (`box-setup.html`,
`test-secure-storage.html`, `test-secure-minimal.html`), where a class would
resolve to nothing. `doc-preview.js`'s sandboxed frame keeps its own `<style>`
by design: that document is isolated and cannot see `style.css`.

`tests/custom-css.spec.ts` was rewritten for the
current 2-slot server-side UI (it still described the removed preset-era UI) and
now covers rendering, saving, reload persistence, slot independence, live
preview, export (plain and password-encrypted), import, and clearing —
10 tests, all passing.

### 2.8 ask C — the "erase everything" control is part of the app, not the page

The control used to be page chrome: `static/app-overlay.js` drew it inside the
main WebView. That is enough while a page runs, and useless in exactly the states
the control exists for — the WebView's own error page (`ERR_CONNECTION_REFUSED`)
runs no script at all, and a blank/grey boot may never run one, so the button
vanished whenever the host did or the app was half-updated. The watchdog
workaround (navigate the window back to the bundled address screen —
`watch_closed_host` / `watch_page_alive` in `src-tauri/src/lib.rs`) worked, but it
moved the user and still depended on a page running somewhere.

Desktop now owns a second, tiny, always-on-top window for it.
`src-tauri/src/wipe_overlay.rs` creates `static/box-wipe.html` at launch, anchors
it to the bottom-left of whichever app window is on screen (main first, then the
setup window), follows that window's moves/resizes/focus through window events
plus a one-second backstop tick, hides with it when it is minimized or hidden to
the tray, and never navigates it. Nothing the main window does can remove it:
the error page, a blank document, a dead host, an updated-but-stale cache.

- The **page half** of a wipe is still the page's: the shell emits
  `box:wipe-requested` to the main window and `static/app-overlay.js` signs out
  server-side while the token still exists and drops what JS can reach. A page
  that is not running simply never answers — expected, and the case the native
  control exists for.
- The **shell half** needs no page at all: `clear_all_browsing_data()` (WebView2
  `ClearBrowsingDataAll`, WebKitGTK `WebsiteDataTypes::ALL`, WKWebView all data
  types, Android's own WebView call) erases the WebView's storage — HttpOnly
  cookies, every origin's localStorage, IndexedDB, caches — and then the saved
  address and pinned certificate are dropped and the address screen returns.
  On Android the same clearing now also runs behind the page-driven
  `box:clear-connection` wipe.
- "Hide this button" hides it for the rest of that run only (a memory-only flag),
  so reopening the app always brings the control back.
- The overlay page's capability (`src-tauri/capabilities/wipe-overlay.json`)
  grants `core:event:default` and nothing else; the window position is shell
  business, not page business.

Verified against a real build over the box's CDP port:
`tests/box-wipe-overlay.spec.ts` (the overlay target exists with its button,
survives the main window being blanked / reloaded against a dead host, opens,
arms twice and cancels without erasing; the real erase is opt-in with
`E2E_BOX_WIPE_DESTRUCTIVE=1`), plus `tests/app-wipe-overlay.spec.ts` for the page
half (the desktop rule: no page-drawn button, but the beacon and the
`box:wipe-requested` handler stay) and `cargo test` in `src-tauri/` for the anchor
geometry.

What the live run actually showed, with the saved host stopped (the user's own
scenario): the box comes up, notices nothing answers, puts the address screen in
the window — and the `box-wipe` window is there beside it, 46×46, visible, at
exactly `main.x + 14`, `main.y + main.height − 46 − 14` (checked against the OS
window list), with `WS_EX_TOPMOST` set. Its button stays visible and pressable
while the main window sits on Chromium's own error page or on a blanked
document, the panel opens and cancels, and `E2E_BOX_PROBE_HIDE=1` on
`tools/box/probe-wipe-overlay.mjs` shows "Hide this button" leaving the window
hidden through every resync until the app is reopened. The destructive half —
press erase, end up on the address screen — is the one thing left unrun here on
purpose, and it is exactly what `E2E_BOX_WIPE_DESTRUCTIVE=1` runs.

---

## 3. Test infrastructure changes

- `tests/_auth-helpers.ts`: `loginBody()` / `apiLogin()` build the current login
  protocol inside the page (the page has `E2ECrypto`), so specs never duplicate
  the crypto and always get a fresh nonce. The kill-switch, security-fixes,
  username-rate-limit, login-attempt-notification, password-change, twofa and
  heartbeat-reauth specs use it.
- The custom-CSS and runtime-config suites need the raised limit env vars, or
  registration/admin logins start returning 429 mid-suite. `admin-runtime-config.spec.ts`
  now passes `ADMIN_LOGIN_IP_MAX=0`, `REGISTER_IP_MAX`, `CLIENT_CONFIG_IP_MAX`
  and the reauth overrides to its isolated server, mirroring `playwright.config.ts`.
- Deleted stale/duplicate specs: `tests/css-e2e-test.spec.ts` (a standalone
  preset-era script with a top-level `process.exit`) and a scratch probe.

---

## 4. Bugs found and fixed while verifying

### 4.1 The finding-12 logout header wiped the login page's own storage (regression, this work)

`POST /api/logout` unconditionally sent `Clear-Site-Data: "cache", "cookies",
"storage"`. The login page calls that endpoint on **every** load to evict a
stale `HttpOnly` cookie, and `static/auth.js`'s own wipe deliberately preserves
a short allow-list across a forced re-login (session-duration preference, media
caches, `localSearchOnly`, `vaultAskPassword`). The browser deleted all of it, so
a custom session duration could never survive a re-login (and avatars/emojis
re-fetched every time).

Fix: `POST /api/logout?cookie_only=1` performs the cookie housekeeping without
the storage eviction; a plain `POST /api/logout` (and `GET`) is still a full,
destructive sign-out. `static/auth.js` and `static/admin.js` use the
housekeeping form. Regression test: "the login page's stale-cookie housekeeping
does NOT wipe origin storage" asserts no `"storage"` in the header while the
cookie is still cleared, and that the real sign-out stays destructive.

### 4.2 Password change orphaned the local session and identity keys (pre-existing)

`_secRekeyToPassword()` collected the plaintexts under the old key, wrote the
**new** password into `e2e_encrypted_password`, derived the new key — and threw
it away, leaving `_key` null. Step 4 then "rewrote" each value with a null key;
each write threw and was swallowed by the per-key `try/catch`, so every sensitive
value stayed encrypted under the old key while the stored password was already
the new one. On the device that changed the password, `token`, `user` and the
identity keys became unreadable — a 401 storm and a blank identity until a
re-login. (It reproduced on the pristine HEAD client, so it is not a regression
from this work.)

Fix: install the derived key (`_key = newKey`, sessionStorage cache,
`_settleLocalKeyCopy()`) before the rewrite, exactly as `_secReKey()` does.
`tests/password-change.spec.ts` — 4/4 passing, including "change keeps the
session, identity keys and key blob intact".

**Follow-up found while verifying (this work): a stale save could still replace
the re-wrapped blob.** Three independent holes, all closed:

- `loadDecryptedPassword()` reads `window._vaultSessionPassword` first, and
  nothing updated it on a password change — every save after the change was
  wrapped with the **old** password. `performPasswordChange()` now swaps it (and
  adopts the revision from the change response) before any queued save can run.
- The first save of a page load was **blind** (`base_rev: null`), and the server
  accepts a blind write whatever it overwrites — a save composed before the
  change landed after it and won. The mirror now reads the blob once to learn
  the revision, so every write is optimistic and a stale one gets 409 + merge.
- `server/src/db.rs::change_password_credentials()` now bumps `user_key_blobs.rev`
  in the same transaction as the new blob and returns the new revision, so a
  save that was already in flight is answered with 409 instead of being accepted.

The change flow also cancels the pending blob debounce before the POST.

### 4.3 The active CSS slot was never applied on startup (pre-existing)

`_loadActiveSlotCss()` lives inside `thread_categories_shortcuts.js`'s IIFE and
was never exported, so `chat.js`'s startup hook (`typeof _loadActiveSlotCss ===
"function"`) never saw it and fell back to the legacy localStorage key — the
slot CSS only appeared after opening the settings tab. The loader is now on
`window`, and `fetchCssSlots()` no longer caches a failure (a session token
still restoring from secure storage used to poison the cache for the whole
session); it retries briefly instead.

### 4.4 Two rules the app already had, broken by this work

- **No third-party origin anywhere** (`tests/security-hardening-f.spec.ts`): the
  advisory HIBP breach lookup added `https://api.pwnedpasswords.com` to
  `connect-src`. Removed — see §5.
- **No native `prompt()`/`confirm()` in app sources**
  (`tests/ui-dialogs.spec.ts`): the new connection-change flow had a defensive
  `prompt()` fallback. Replaced with `window.uiPrompt` and a toast if the
  in-page dialog helper is missing.

---

## 5. Deliberate trade-off: the breach check

The client-side HIBP lookup (k-anonymity, SHA-1 prefix only, 4 s timeout, fails
open) was removed with the CSP entry it needed. This app deliberately names no
external origin: it keeps working offline, and no outside party sits in the page's
request path. The strength floor — which is what actually blocks weak passwords
— stays. If the breach check is wanted back, the place for it is a server-side
proxy (`reqwest` is already a dependency, as web push shows), so the browser
still only talks to `'self'`.

---

## 6. What is left — the review's wording, and the state of each

### 6.1 Finding 5 — “secure storage” is at-rest only (Medium–High, advisory)

This is a documentation finding, and it is now stated where it belongs
(`static/secure-storage.js`'s header, the storage design text and this file):
the encryption defeats someone reading Local Storage's leveldb off disk or out
of a backup; it does **not** defeat code running in the origin. It must never be
counted as XSS defence when threat-modelling — which is exactly why finding 1,
the CSP work and the sandboxed previews are the layers that matter. No code
change “fixes” this one; the reachable-XSS surfaces are what gets reduced.

### 6.2 Finding 8 — XLSX is sandboxed too; PPTX / PDF / CSV checked

`.docx` and `.xlsx` render in sandboxed frames with no `allow-same-origin`
(§2.3). The spreadsheet's parser and its `sheet_to_html` sink both run inside
the frame; the app receives only the sheet names, the rendered height and a
truncation flag, so the table never enters the key-bearing origin. The height
report keeps the old sizing behaviour (the view grows with the sheet, and a
sheet switch re-reports its new height), and a sheet wider than the column
scrolls inside the frame the way the old `overflow-x` wrapper scrolled.

The other formats were checked sink by sink:

- **CSV** — builds `<table>` nodes with `textContent`; safe by construction.
- **PDF** — PDF.js renders to `<canvas>`; no document HTML reaches the DOM.
- **PPTX** — the app's own OOXML parser builds DOM nodes and sets slide text
  with `textContent`.

### 6.3 Finding 3 long term — OPAQUE (RFC 9807), considered and declined

**Decision (2026-10-04):** OPAQUE is not planned; the interim nonce-signature
design in §2.1 stands. It was evaluated as the standard fix for the verifier
problem and is compatible with the constraint below — it was declined as a
design choice, not as a conflict.

What it would have done, kept for the record:

- **Registration:** instead of a credential verifier, the client would upload an
  OPAQUE password file for a blind OPRF evaluation, so the server would still
  never see the password. Today it receives
  `K = HMAC-SHA256(hash_key, password)` once and stores `$e2e$Argon2id(K)`
  (64 MiB / 3 iterations, `server/src/auth.rs`).
- **Login:** a three-message exchange (KE1 blinded request → KE2 evaluated
  element + masked envelope → KE3 MAC) ending in the same session cookie; the
  2FA pending token, kill-switch path, rate limits and `__Host-e2e_token`
  plumbing hang off its successful end unchanged.
- **Multi-device:** unchanged. The password file lives server-side, so any
  device with the password can log in — no per-device enrolment — and the raw
  password still never leaves the device, so every client-side derivation
  (`hash_key` unwrap, `K`, identity escrow, the vault) keeps working as it does
  today.

Costs it would have carried: a wasm OPAQUE client vendored into `static/` (there
is no bundler; the server's CSP already allows wasm, the shell's would need the
same), a server protocol module and migration, and a one-time upgrade login per
existing account — the server cannot derive a password file on its own because
it never has the password.

The gain is narrower than it first looks, and worth stating honestly: what a
leaked database makes attackable here is not only the login verifier but also
`encrypted_hash_key`, the blob every device must unwrap with the raw password
before it can derive `K`. OPAQUE replaces the first with a record that needs the
server's OPRF key before guesses can even be tested; the second stays an offline
oracle unless it is re-anchored to the OPAQUE export key **and** the OPRF key is
kept out of the database. That re-anchoring is the real project, and it was not
worth taking on now.

**Constraint this area must keep honouring:** the raw password is the
client-side root of every key (message encryption, vault, escrow). A login
design may change what the server verifies, but it must keep the raw password in
the client's hands — which rules out device-bound/passwordless schemes
(passkeys, per-device keypairs) unless the password is still collected for key
derivation.

**Follow-up (2026-10-04): every legacy login fallback is removed.** The app is
pre-release and all accounts are test accounts, so nothing here carries
compatibility weight. `loginRequestBody()` used to fall through to the raw
password whenever the hash_key could not be decrypted — a typo'd password, an
unknown username, or an `/api/auth-params` outage all put the client-side root
on the wire (a probe captured `"password":"…-wrong"` verbatim). That fallback,
the keyless-account credential login with its in-place upgrade, the pre-hash
`$argon2id$` verifier, the bare-credential constant-time compare and the
self-healing upgrade are all gone. Login accepts **only** a nonce-bound
Ed25519 signature from the account's stored `login_public_key`; registration
and password change both require that key, so a keyless row is dead rather
than upgraded, and the auth-params response has no legacy flag left to lie
about. The raw password never crosses the wire on any path: the regression
block in `tests/security-review-fixes.spec.ts` asserts its absence in every
register / correct / wrong / unknown / outage login body and in
`server/e2e_chat.db*` (UTF-8 and UTF-16LE, with the fresh username as the
positive control), and a stubbed auth-params response (`legacy_raw_password:
true`, missing hash key) proves the client ignores anything that asks for it.
Rows left in retired formats — including accounts in old test databases —
simply cannot log in; a fresh registration is the way forward.

**Residual accepted:** if the database leaks, `$e2e$Argon2id(K)` and the
password-wrapped `encrypted_hash_key` blob are both offline-testable. Mitigated
by 64 MiB Argon2id on both, a password change that rotates the verifier and the
login key, nonce-signed logins (nothing on the wire is replayable), online rate
limits on `/api/auth-params` and `/api/login`, and the client-side password
strength floor. Revisit if the threat model changes.

**Operational note.** The server accepts **only** nonce-signed logins, and every
account carries a `login_public_key` (registration and password change require
one). The web client is served by the server, so it is never stale; a *native
app* that predates signed logins cannot sign in and has to be updated, and rows
left in the retired bare / `$argon2id$` formats cannot log in at all — anyone
holding such a test account re-registers.

### 6.4 Finding 10 — traffic analysis and the metadata layer

The finding stands: ciphertext sizes leak message-length buckets, timing leaks
activity, presence and group membership are visible, and TURN sees IPs, sizes
and timing. Nothing was rushed here on purpose — padding that leaks through the
length field, or jitter that batches nothing, is worse than no padding because it
looks like a fix. The intended order, when it is done:

1. Pad plaintext to fixed buckets (256 B / 1 KiB / 4 KiB) **before** encryption,
   with the bucket carried inside the encrypted envelope so the length field is
   always the bucket size.
2. Add a small random send delay per message, and batch typing/ACK noise.
3. Treat MLS (RFC 9420) as the long-term answer for groups — it also covers
   finding 11's group-key half.

None of this changes app behaviour today; it is a wire-format migration and
needs its own version byte and rollout plan.

### 6.5 Finding 11 — forward secrecy and a post-quantum plan (ASVS 5.0 11.1.4)

Current state: static identity keys and per-conversation symmetric keys, no
ratchet — a stolen identity key decrypts history, and harvest-now-decrypt-later
applies to a long-lived server holding ciphertext. The ASVS requirement is that
a crypto-agility and migration **plan** exists; this is it. For the full
post-quantum inventory — every hidden asset, its primitive, its exposure and
its fix, including the transport leg that is already hybrid
(X25519MLKEM768, verified live) — see `POST_QUANTUM_AUDIT.md`.

1. **Version the envelope first.** Every encrypted envelope gains (or already
   has) a scheme byte; new algorithms are added as a new version and old ones
   stay readable for a deprecation window.
2. **Hybrid identity envelopes — shipped in 0.2.44.** Identity/`crypto_box`-style
   envelopes are now X25519 + ML-KEM-768: the envelope carries the ML-KEM
   ciphertext and the KDF consumes both shared secrets (plus both public keys
   and the ciphertext) so security holds unless *both* algorithms are broken;
   envelopes without the ML-KEM part still verify under the old version. The
   deterministic ML-KEM identity key publishes at registration / first app
   load, the server's offline-notification escrow uses the same hybrid KEM,
   and login signatures are hybrid Ed25519 + ML-DSA-65 (verify both, re-key on
   registration and password change). Full status and remaining coverage (DM
   message envelopes, voice frame keys, ratchet/MLS) in
   `POST_QUANTUM_AUDIT.md` §1–§2.
3. **Forward secrecy for new conversations.** A Signal-style double ratchet
   (per-message keys, deleted after use) for 1:1, MLS (RFC 9420) for groups —
   MLS's epoch keys also give post-compromise security and a natural home for
   the finding-10 padding work.
4. **No implied algorithms.** The envelope names its algorithms, so a future
   migration is a new identifier, not a new file format.
5. **Sequencing.** MLS/ratchet is a protocol change, not a patch: it lands behind
   the version byte, conversations opt in once both peers support it, and the
   server (a dumb relay) needs no change beyond storing the new envelopes.

### 6.6 The two things the review could not verify

- Whether any of the ~150 routes has an IDOR: needs a per-route authz pass with
  evidence from the suite.
- Whether every one of the ~342 `innerHTML` sites in `chat.js` passes escaped
  data (the message body, markdown and highlighter paths were verified): a
  sink-by-sink audit of its own.

Both remain open as *verification* items, not known defects.

---

## 7. How to verify

The suites need a server started with the test env overrides, or
registration/admin-login suites hit their real per-IP limits (`playwright.config.ts`
lists them; the app's own `reuseExistingServer: true` does **not** add them to a
server you started by hand). Then, from the repository root:

```bash
npx playwright test tests/security-review-fixes.spec.ts       # 20 passed
npx playwright test tests/doc-preview.spec.ts \
  tests/doc-large-file.spec.ts tests/doc-view-phone.spec.ts \
  tests/doc-view-aspect.spec.ts                               # 21 passed
npx playwright test tests/admin-runtime-config.spec.ts        # 11 passed
npx playwright test tests/custom-css.spec.ts                  # 10 passed
npx playwright test tests/password-change.spec.ts             #  4 passed
npx playwright test tests/heartbeat-reauth.spec.ts \
  tests/kill-switch.spec.ts tests/twofa.spec.ts \
  tests/username-rate-limit.spec.ts \
  tests/login-attempt-notification.spec.ts \
  tests/security-fixes.spec.ts                                # 56 passed, 1 skipped
npx playwright test tests/security-hardening-f.spec.ts \
  tests/ui-dialogs.spec.ts                                    # 12 passed
npx playwright test tests/security-headers.spec.ts \
  tests/settings-polish.spec.ts                               # 11 passed, 1 skipped
cd server && cargo test --release                             # 19 passed

# ask C — the app-shell wipe overlay
npx playwright test tests/app-wipe-overlay.spec.ts           #  7 passed (page half)
cd src-tauri && cargo test                                   # 15 passed (anchor geometry + shell)
# against a real desktop build (see the spec's header):
E2E_BOX_DEBUG_PORT=9333 npx playwright test tests/box-wipe-overlay.spec.ts   # 2 passed, 1 skipped
#   (the skipped one is the real erase, opt-in: E2E_BOX_WIPE_DESTRUCTIVE=1)
# and a read-only live probe of a running box:
E2E_BOX_DEBUG_PORT=9333 node tools/box/probe-wipe-overlay.mjs

# finding 9 residual — vendored code is hash-pinned
npx playwright test tests/vendor-integrity.spec.ts           #  2 passed
node tools/vendor-checksums.mjs                              # regenerate after a vendor upgrade
```

---

## 8. Follow-up audit — 2026-10-05 (memory bounds, WebSocket backpressure, PQ registration)

A second pass asked two questions: *what can a client make the server hold
without bound?* and *what PQ hole was still open after the 0.2.44 envelope
rollout?* Everything below is in the working tree with a test.

| Area | Finding | Fix | Test |
|---|---|---|---|
| Rate limiters (21 statics, `handlers.rs`) | Entries were never evicted — one map entry per distinct key for the life of the process — and most keys are client-controlled (usernames, IP hashes). `ws.rs` evicted only *expired* keys above 1000 entries, which a flood of fresh keys defeats. | Shared `evict_stale_keys`: drop expired, then keep the newest 4096 with a 2× trim threshold (amortized; `select_nth_unstable`, not a sort). | `cargo test` → `a_flood_of_fresh_keys_is_capped`, `expired_keys_are_dropped_…`, `a_flood_of_fresh_ws_keys_is_capped` |
| WebSocket per-connection send queue | `mpsc::unbounded_channel`: a client that stops reading while subscribed to busy rooms made the server buffer messages without bound. | Bounded queue (`WS_SEND_QUEUE_CAPACITY = 1024`) + `try_send`; overflow is dropped, never buffered. | `cargo test` → `a_stalled_client_drops_messages_instead_of_buffering_them` |
| Admin tokens | Expired admin / pre-2FA tokens were only removed when that exact token was validated again — one dead entry per admin login for the process lifetime. | `prune_expired_admin_tokens` runs on every insert. | `cargo test` → `expired_tokens_are_pruned_and_live_ones_kept` |
| `/api/soundboard/temp-play` (RAM) | Decoded audio sat in process memory for 15 minutes with only the 64 MiB default body limit as a bound — one authenticated client could park gigabytes. | 8 MiB per entry (413), 64 MiB total with oldest-first eviction, TTL unchanged. | `cargo test` → `the_map_is_capped_by_total_bytes_oldest_first`, `expired_entries_are_dropped_…`; `tests/soundboard-spec.spec.ts` → *T6* |
| Soundboard clip upload (disk) | No size check either; every upload is a SQLite row. | Same 8 MiB ceiling, 413 before any write. | `tests/soundboard-spec.spec.ts` → *T6* |
| Registration (PQ) | `identity_public_key` could be sent without the ML-KEM half — an account every sender would address with the v1 X25519-only envelope. | Classical-only identity keys are refused; the X25519 half must be 32 bytes and the PQ half 1184. | `tests/pq-envelopes.spec.ts` → *a classical-only identity key is refused at registration* |
| Whole-server delete (`delete_server_rows_c`) | `conversation_profile_data` rows were only matched by `conversation_type` + id, so a row whose type said `channel` but whose conversation id was the server id survived the delete — a stale encrypted per-server profile snapshot keyed to a dead server (found by `leave-cleanup.spec.ts`). | Purge by `conversation_id` as well, whatever the row's type claims. | `tests/leave-cleanup.spec.ts` → *owner leaving deletes the whole server including tables with no FK to it* |

**Test-suite fallout found while verifying the above:**
`waitForLoadState('networkidle')` can never settle on the app's pages.
Chromium keeps the pages' own fire-and-forget requests listed as in-flight for
the life of the document — `POST /api/logout?cookie_only=1` on `admin.html`,
`GET /api/ringtone` and `GET /api/notification-sound` on `index.html` — even
though the server answers each in ~3 ms (a curl call and a later in-page fetch
of the same URL both complete; only the page's own request stays “pending”).
`networkidle` was therefore a 45 s timeout on 12 spec files, several of which
had silently aged into “known flaky”. They now wait for a real signal
(`#settings-btn` visible after the app loads; `domcontentloaded` for reloads).

Reviewed and deliberately unchanged: the raw IP inside the encrypted
failed-login notification payload (E2E-encrypted, addressed to the account
owner only, never stored in plaintext), `PENDING_2FA_ENROLL` (bounded per
account and pruned on insert), voice-room cleanup (empty rooms are removed), no
new SQL-injection sinks (identifiers come from `sqlite_master` or are
quote-doubled), and no secrets in logs.

### 8.1 Release assets: published names vs checksum names

GitHub's asset-upload endpoint rewrites spaces (and `( ) ~ :`) to dots, so the
v0.2.45 release published `E2E.Chat_…` files while `SHA256SUMS-*.txt` listed the
on-disk `E2E Chat_…` names: every hash matched, no name did, and `sha256sum -c`
failed on a pristine download. `release.yml` now normalizes the bundle names
*before* the upload and before the checksum list is generated, so disk name,
asset name and checksum name agree by construction (bytes untouched, so the
Arch PKGBUILD's dotted download name and the provenance attestation still
match). `tools/release-workflow-sim.sh` executes both steps against a fake `gh`
that sanitizes names exactly like GitHub does, asserts that every checksum line
names a real asset, and runs a real `sha256sum -c` over the downloaded set.

```bash
cd server && cargo test                       # 39 passed
npx playwright test tests/pq-envelopes.spec.ts tests/soundboard-spec.spec.ts \
  tests/heartbeat-reauth.spec.ts tests/rate-limiting.spec.ts \
  tests/security-hardening-f.spec.ts          # 32 passed
bash tools/release-workflow-sim.sh            # every check passed
npx playwright test tests/release-publishing.spec.ts \
  tests/arch-packaging.spec.ts tests/supply-chain.spec.ts   # 24 passed
```
