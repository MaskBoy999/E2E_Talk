# FEATURE PLAN — what each candidate means, whether it survives E2EE, and how it could be exploited

Companion to `FEATURE_RESEARCH.md` (the menu). That doc answers *"what could we
build"*; this one answers *"what does each thing actually mean, can it ship
without breaking encryption, and where would an attacker get at it"*. Every
verdict below was checked against the code as it stands, not assumed.

Research date: 2026-09-23 · box at v0.2.29.

---

## 0. The threat model that decides everything: notifications are OUTSIDE the boundary

**The case you named is real and recent.** The FBI forensically extracted
incoming Signal message previews from a defendant's iPhone *notification
database* — the plaintext survived after the app itself was deleted
(404 Media, Apr 2026; EFF wrote the general version the same week). Signal
never sent that plaintext to Apple; the app **decrypted locally and handed the
preview to the OS**, and the OS durably stored it. No crypto was broken — the
OS was simply on the wrong side of the wall.

The same class of surface exists on every platform we ship on:

| Platform | Durable OS-held copy | Lifetime |
|---|---|---|
| iOS (PWA web push) | Notification database, incl. previews | until purged, survives app deletion |
| Android | Notification history (11+), lock screen, OEM shade logs, wearables | ~24 h+ for history; shade until dismissed |
| Windows (desktop box) | Action Center toast DB | until the toast is dismissed/cleared |
| Android FGS / ring | the ongoing notification itself | for its whole lifetime |

**Rule zero:** a notification may carry **only metadata the server already
holds** (plaintext `@username`, counts, generic words like "a direct message").
Anything that exists only as decrypted E2EE data — message text, display
names/nicknames, server/channel/category names — must **never** cross into an
OS notification, widget, media session, tile, or car dashboard.

The web funnel already enforces this: `notifText()` (`static/chat.js:10646`)
is the single builder, `tests/notification-privacy.spec.ts` pins it (nickname
never leaks, channel/server names never leak, unknown senders degrade to
"Someone"), and `notifHidePreview` blanks everything to a generic card. The
findings below are the surfaces that **don't** go through that funnel.

---

## 1. P0 — pre-existing leaks to fix BEFORE building anything on top

These are not new features. They are live violations of rule zero, and every
feature in §2 that touches notifications would otherwise be built on them.

### F1. The ongoing Android call notification shows a decrypted channel name
- **Path:** chat.js builds the channel list from `tryDecryptWithAllKeys(encrypted_name)`
  → `VoiceManager.joinServerVoice(serverId, ch.id, chDisplayName)` (`chat.js:15804`)
  → `S.channelName = channelName` (`voice.js:1334`)
  → `_boxCallService('start', S.channelName)` (`voice.js:4089`)
  → Kotlin `buildNotification`: `"In call — $channelName"` (`CallForegroundService.kt:163`).
- **Why it's a leak:** the DB stores *only* `encrypted_name` + `name_nonce`
  (the plaintext `name` column was removed — `db.rs:2402`). Channel names are
  E2EE data. The shade, notification history and lock screen now hold a
  decrypted E2EE string for the whole call — the exact Signal/FBI pattern.
- **Fix (S):** pass a constant (`"Voice call"` / `"Direct call"` already exist
  as fallbacks at `voice.js:4089/1132`). Never a name. The FGS card is
  ambient status, not content.

### F2. The native incoming-call ring ignores hide-preview and is lock-screen public
- **Path:** `voice.js:1207` sends `callerName: call.callerUsername`
  → `IncomingCallNotifier.show()`: `"$callerName is calling…"` with
  `setVisibility(VISIBILITY_PUBLIC)` (`IncomingCallNotifier.kt`).
- **Verdict on the name itself:** `caller_username` arrives from the server
  (`voice.js:5092`) — it is *plaintext metadata the server already holds*, so
  naming it is within policy. Two problems remain:
  1. `VISIBILITY_PUBLIC` paints it on a **locked** phone — anyone who picks up
     the device learns who is calling, even though the user's settings say
     notifications should be hidden when locked.
  2. `notifHidePreview` ("Hide message content in notifications", Settings)
     is a *web* preference; the Kotlin notifier has no idea it exists. A user
     who opted out of previews still gets named rings in the shade + Android
     notification history.
- **Fix (S):** page sends a `hideIdentity: boolean` flag with the ring
  (`notifContentHidden()` already exists); Kotlin then shows `"Incoming
  call"` only, and drops `VISIBILITY_PUBLIC` → `VISIBILITY_PRIVATE` when hidden
  (or always, with a `setPublicVersion` carrying the generic text).

### F3. Auto-close is a no-op through the plugin shim → desktop toasts linger in Action Center
- `showBrowserNotification()` schedules `notif.close()` after 10 s
  (`chat.js:10716`) but the plugin shim's object has no `close()` — the timer
  is guarded and therefore silently does nothing. On Windows the toast stays
  in the Action Center DB until the user clears it.
- **Verdict:** content is `notifText`-sanitized, so this is a *retention*
  issue, not a content issue — but retention is exactly what the FBI case
  exploited. **Fix (S):** give the desktop path a real close (use the
  plugin's remove API if it exposes one, else `expiresOn`/timeout in the
  notify options) so toasts don't accumulate in the OS database.

**Regression gate:** extend `tests/notification-privacy.spec.ts` with a native
assertion per fix (Kotlin notifiers receive only sanitized strings — unit-test
`buildNotification`/`show()` outputs).

---

## 2. The features — meaning, E2EE verdict, exploit review

Effort letters are from `FEATURE_RESEARCH.md`. Verdict key:
**✅ safe** · **⚠️ safe only with the listed rule** · **🛑 don't build that way**.

### §1 Calls and audio

| # | What it *means* (plain) | Verdict | Exploit review / required rule |
|---|---|---|---|
| 1.1 Call notification with Mute/Deafen/Hang up | The ongoing Android call card gets buttons so you don't open the app to mute; a live duration counter | ✅ | Buttons are **commands**, not content: PendingIntent actions carry only ids, must stay `FLAG_IMMUTABLE` (the pattern `IncomingCallNotifier` already uses) so no other app can rewrite the intent (R4). Card text subject to **F1** first: title stays generic. Duration = metadata. |
| 1.2 Media keys / headset buttons via MediaSession | Headset buttons and car stereos control mute/deafen/hang-up; the call shows in the OS Now Playing panel | ⚠️ | **The trap version of this feature:** MediaSession metadata is rendered by *other* apps — lock screen, Bluetooth car headunits, Wear watches — i.e. bystander-visible, durable, and outside every setting we control. Rule: `MediaMetadata` title = `"E2E Chat"`, subtitle = `"In a call"` — **never** channel name, partner name or nickname (R1). Controls themselves are id-less commands. |
| 1.3 Audio routing (earpiece/speaker/BT) | Pick which device the call comes out of, like a phone dialer | ✅ | Pure local device state via `setCommunicationDevice`; no data leaves the process. |
| 1.4 Audio focus | Your music pauses when a call starts, notifications duck | ✅ | OS audio-policy negotiation only. |
| 1.5 Self-managed ConnectionService | The call appears in the system dialer/recents and answers from car/Wear/headset buttons | ⚠️ | System recents now show *who called*. Only the plaintext `@username` may be used as the call's "number"/display — never a display name (R1). Self-managed accounts don't write the telephony call log; the Dialer's recents entry is still an OS-held copy of call metadata (caller + time), which is server-known and accepted. |
| 1.6 VAD / hold-to-talk | Mic only opens while you speak (energy gate in the existing worklet) | ✅ | Local DSP. Also *reduces* exposure: less ambient audio captured. |
| 1.7 On-device live captions | Whisper/`SpeechRecognizer` transcribes the call **on the device** — no audio ever leaves | ✅ (preserves E2EE — this is the point) | Exploit review: (a) engine must be **offline** — Android's `SpeechRecognizer` in network mode ships audio to Google → require `EXTRA_PREFER_OFFLINE`; whisper.cpp is local by nature. (b) Captions are display-only by default; **publishing** to peers is a second explicit toggle and rides the existing E2EE data channel. (c) Captions must never enter notifications or logs (R3). |
| 1.8 Connection-quality overlay | ping/jitter/loss per peer, to debug "it sounds bad" | ✅ | Reads `getStats()` locally. Don't put peer names into any OS notification — panel is in-app. |

### §2 Notifications and system presence

| # | What it *means* | Verdict | Exploit review / required rule |
|---|---|---|---|
| 2.1 Reply from the shade | Type a DM reply in the notification and hit send without opening the app | ⚠️ | The typed reply is plaintext **on the user's own device** — identical exposure to typing it in the composer (the keyboard already sees it; E2EE protects against the *server*, not the user's IME). Rules: (a) the reply text lives in the RemoteInput extras only until our receiver consumes it → **cancel the notification immediately after enqueueing** (R5); (b) the reply is encrypted by the normal `sendMessage()` path client-side — the server sees ciphertext only; (c) **never echo the reply back into any notification body**, even ours (that would put fresh plaintext into notification history); (d) under `notifHidePreview` the notification stays generic but the Reply action remains — action ≠ content. |
| 2.2 Home-screen widget | Unread badge + "join voice" + mute, without opening the app | ⚠️ | Widgets are glancable by anyone holding the phone and are rendered by the launcher process. Show **counts only** — no names, no last-message snippet (server knows counts) (R1/R2). Hide-preview must blank it to an app icon. |
| 2.3 Quick Settings tile | Mute/deafen from the pull-down shade; "answer" while ringing | ✅ | Tile labels are static app-defined strings ("Mute"); state booleans only. |
| 2.4 Launcher shortcuts | Long-press the icon → recent channels / "Join last voice" | ⚠️ | Static `shortcuts.xml` labels are safe **only if generic** ("Join last voice"), because shortcut labels are indexed by the launcher and shown without unlocking. Dynamic per-channel shortcuts would publish decrypted channel names to the launcher DB → keep them static or id-only (R1). |
| 2.5 Push without Google (UnifiedPush / self-hosted ntfy) | Android gets background notifications with no Firebase project — the box posts to a push distributor you host yourself | ⚠️ | Payload contract stays **exactly** what FCM already uses: the FCM leg is deliberately identity-free ("E2E Chat"/"New message" — `handlers.rs:10499`, because FCM notification blocks travel plaintext through Google). Rules: (a) **self-host ntfy** — a public ntfy.sh server sees every message's timing + payload, which is the same bargain as FCM but with *no* reputable processor behind it; (b) UnifiedPush **topics are capability URLs** — anyone who learns the topic can subscribe → topics must be ≥32-char random, regenerated per device, treated as bearer secrets (R6); (c) since the payload is metadata-only and the distributor is the user's own box, no extra encryption layer is required — but keep the identity-free wording so a distributor compromise leaks nothing beyond timing. |
| 2.6 Quiet hours / per-channel policy native-side | Do-not-disturb-aware behavior when backgrounded | ✅ | Reads ringer/DND state (already done in `AudioProfile.kt`); changes *whether* we notify, never *what*. |

### §3 Capture and media

| # | What it *means* | Verdict | Exploit review |
|---|---|---|---|
| 3.1 System audio in screen share | Share a video *with sound*, not silent video | ✅ | Captured frames enter the existing pipeline → E2EE worker encrypts before send, same as video today. OS-level capture (`AudioPlaybackCapture`) excludes DRM/protected content by platform rule. |
| 3.2 Per-app capture (Android 14+) | Share one app window, not your whole screen | ✅ | Strictly *less* exposure than the current whole-screen share; system picker UI. |
| 3.3 Region screenshot + annotate | Snip part of the screen and send it | ✅ | Snip exists only in app memory → attachment path → encrypted like any upload. Nothing written outside the app sandbox (avoid saving to shared MediaStore). |
| 3.4 Share-into-app (Gallery → Share) | Send a photo straight into a channel | ✅ | Plaintext arrives *from* another app (user-initiated import — same trust as pasting) and is encrypted before it leaves. No new egress. The inbound intent FIFO holds file URIs only, never message text. |
| 3.5 Drag files out | Drag a file from the app to the desktop | ✅ | User-initiated export; the file is decrypted locally on request — same as Save-as. No automation surface if the drop target is OS-blessed. |

### §4 Desktop shell

| # | What it *means* | Verdict | Exploit review |
|---|---|---|---|
| 4.1 Push-to-talk global hotkey | Hold a key to talk, from anywhere in the OS | ✅ | Key state → local mute flag. The shortcut registration holds no content. |
| 4.2 Always-on-top mini call window | A small frame showing just the chosen tile | ✅ | Renders the same decrypted media the main window does, on the user's own screen — same exposure as the app being visible. No new surface beyond desktop screen-sharing/shoulder-surfing (which `FLAG_SECURE` can't help on desktop anyway). |
| 4.3 OS media integration (Now Playing / MPRIS) | The call appears in the Windows media panel; media keys work | ⚠️ | Same trap as 1.2: whatever metadata we hand the OS is shown by the OS, to cars and lock screens. Generic labels only (R1). |
| 4.4 Deep links (`e2e-chat://channel/<id>`) | Clicking a link lands in the right channel | ✅ | Carries ids only — the server already knows every id mapping. Watch out: the link target must be validated as an in-scope id, never a URL the shell will load (no open-redirect into the remote-origin IPC grant). |
| 4.5 Discord Rich Presence | Discord shows "in General Voice" | 🛑 as default / ⚠️ opt-in | This ships activity metadata **to a third party** — the exact posture the product rejects. Only as a default-off, clearly-labeled opt-in, and it may name only the app ("E2E Chat"), never channel/partner names (R6). |
| 4.6 Tray parity (mute/unread) | Tray icon reflects call state | ✅ | Local UI state, counts only. |
| 4.7 Auto-updater | In-app updates | ⚠️ | Not a crypto break but a **new trust root**: whoever signs the manifest can ship code that reads all decrypted data. Treat as a security change: pinned signing key in the binary, signed manifest, fail closed — same posture as the TOFU cert pin (`cert_probe.rs`). |

### §5 Privacy and crypto-adjacent

| # | What it *means* | Verdict | Exploit review |
|---|---|---|---|
| 5.1 Biometric unlock | Fingerprint instead of typing the storage-password bootstrap | ✅ strengthens | The biometric **releases** a Keystore-wrapped key; the template never leaves the enclave and nothing is stored that a bypass of the app UI wouldn't equally expose. Must keep the password path as fallback, and failed-auth attempts must not reset to an unlocked state. |
| 5.2 `FLAG_SECURE` per channel | Block screenshots/screen-record for sensitive channels | ❌ removed | Removed by request: opt-in per-channel flag was "not really helping" (the OS already lets the user screenshot their own screen). JS + Kotlin + ACL fully stripped. |
| 5.3 Panic wipe / auto-lock | Wipe keys+cache after N idle minutes or a hidden gesture | ✅ strengthens | Wipe must cover *every* at-rest copy: secure storage, localStorage bundle, FTS5 index (5.7), cached images. Half-wipes that leave the search index are worse than none. |
| 5.4 Device verification (SAS/emoji) | Visually confirm you're talking to the right device key | ✅ strengthens | Digest shown **in-app only** — never in a notification/widget (a verification code on a lock screen defeats TOFU for a shoulder-surfer). |
| 5.5 Encrypted local export | Take your own data out as one encrypted file | ✅ preserves | Format pinned (age/libsodium), file via save dialog. The **file name/location** must not imply content (don't write `messages-decrypted.json` into Downloads silently — confirm dialog). |
| 5.6 Stronghold-style vault | Argon2 + encrypted file replaces the current key bootstrap | ✅ strengthens | Migration must not leave the old bootstrap readable alongside the new vault (delete-after-migrate). |
| 5.7 Local FTS5 search | Full-text search that runs on-device, because the server *can't* search E2EE content | ✅ preserves / ⚠️ at-rest | This is the honest design: search **must** be client-side. Exploit: the index is a durable plaintext copy of messages **on disk** — the same class as the notification DB. Rules: DB key lives in secure storage (not beside the file), index bounded/rotating, **disappearing messages never indexed**, panic wipe (5.3) drops the DB, exclude from cloud/device backups (R5). |
| 5.8 Diagnostics panel | One screen showing why a native feature is dead (the project's recurring failure mode) | ⚠️ | Incredibly useful, and dangerous by default: ACL grants, cert pin, versions, routes are fine — **keys, tokens, and decrypted strings are not**. Show hashes/prefixes only (R3). No "copy everything" button that dumps raw state. |

### §6 Reliability and ops

| # | What it *means* | Verdict | Exploit review |
|---|---|---|---|
| 6.1 Battery-optimization prompt | Stop Android Doze from killing calls (looks like a bug today) | ✅ | Permission prompt only. |
| 6.2 Keep screen on during calls | Screen doesn't sleep mid-call | ✅ | Wake-lock semantics only. |
| 6.3 Rotating local logs + "Copy diagnostics" | Debuggable phones without adb | ⚠️ | The log itself becomes an at-rest plaintext surface: any `console.log` that ever touches decrypted message data lands in a file. Rule: logs are metadata-only by construction (R3), and the copy bundle runs the same scrub before it leaves the device. |
| 6.4 Self-hosted crash reporting (GlitchTip), opt-in | JS errors + Rust panics go to *your own* instance | ⚠️ | Crash payloads are the classic accidental-plaintext channel: error `message`s and stack args can embed the very string that threw (often message text or names). Rules: explicit opt-in (default off), scrubber before send, self-hosted endpoint only (R6/R3). |
| 6.5 Network awareness | "Same Wi-Fi as the box" + smarter reconnect | ✅ | Local interface facts; don't push SSID/BSSID into notifications or logs verbatim if copied off-device. |

### §7 Scaling

| # | What it *means` | Verdict | Exploit review |
|---|---|---|---|
| 7.1 Time-limited TURN credentials | HMAC credentials minted per session instead of one static shared password | ✅ | A static `TURN_PASSWORD` is a standing secret that relays *anyone's* traffic until rotated; per-session credentials shrink the blast radius. TURN still sees IP metadata — accepted, it already does. |
| 7.2 Documented coturn recipe | Calls that survive mobile data actually work | ✅ | Deployment docs only; no code path. |
| 7.3 Mesh → LiveKit SFU above ~6 members | One self-hosted Go binary relays media for big calls | ✅ preserves (conditionally) | LiveKit's E2EE is insertable-streams — the same frame-transform model as today's `e2ee-worker.js`, so the key model survives; the SFU sees *who-talks-when* metadata, same as today's relay already does, and it's self-hosted (R6). **Condition:** verify our key derivation feeds LiveKit's `FrameCryptor` equivalent, and keep signaling E2EE as-is — a fallback to plaintext signaling during the migration would be a downgrade (the fail-closed + downgrade protection from the signaling E2EE work must be preserved). |

---

## 3. Universal rules (the gate every feature passes before it ships)

- **R1 — OS surfaces get server-known metadata only.** One funnel
  (`notifText`) for web/desktop; the Kotlin notifiers, widgets, tiles and
  MediaSessions each get their *sanitized string from the page* — plugins
  never receive decrypted names to display.
- **R2 — Hide-preview governs EVERY surface.** `notifHidePreview` must reach
  the native ring (F2), FGS card, widget, tile and shortcuts — not just the
  web funnel. A privacy toggle that only binds half the outputs is a trap.
- **R3 — No plaintext in logs, crash reports, or diagnostics.** Hashes and
  prefixes only; scrubbers run before anything leaves the device.
- **R4 — PendingIntents immutable, payloads id-only.** Existing
  `FLAG_IMMUTABLE` pattern; action intents carry ids/commands, never text.
- **R5 — Minimize durable OS copies.** Cancel notifications after actions,
  close toasts promptly (F3), bound/encrypt the FTS index, keep RemoteInput
  text ephemeral. The FBI case was *retention*, not interception.
- **R6 — No third party learns metadata without explicit opt-in.** FCM stays
  optional, ntfy self-hosted, Discord presence default-off, GlitchTip
  opt-in + self-hosted.
- **R7 — New trust roots are security changes.** Updater manifests get pinned
  keys and fail-closed verification, like the cert pin.
- **R8 — Every feature ships with a privacy regression test.** Extend
  `tests/notification-privacy.spec.ts` (web) + one native assertion per
  Kotlin notifier; a feature that can't be tested against leak regressions
  isn't done.

---

## 4. Sequenced plan

**Sprint 0 — "close the holes first" (all S, blocking):**
F1 (generic FGS text) · F2 (hide-preview + lock screen for the native ring) ·
F3 (desktop toast close) · write R1–R8 into the PR checklist · extend
notification-privacy tests to cover the native paths.

**Sprint 1 — "it feels like a phone app":** 1.1, 1.3, 1.4, 6.1, 6.2, 2.4, 4.4
— per the research ranking, each passing R1/R2/R4. Shortcut labels stay
static/generic (2.4).

**Sprint 2 — "it never drops a call":** 7.1, 7.2, 1.2, 2.5, 5.8, 6.3 —
MediaSession ships with generic metadata (R1); UnifiedPush ships self-hosted
with random topics (R6); diagnostics and logs ship scrubbed (R3).

**Sprint 3 — "nobody else can do this":** 5.1, 5.4, 5.7, 1.7, 7.3 — each L,
each strengthens or preserves E2EE, each needing its at-rest story (R5):
biometric via Keystore, verification codes in-app only, FTS5 bounded +
wipe-covered, captions offline + publish-is-opt-in, LiveKit with the
fail-closed signaling guarantee intact.

**Deferred / requires a security decision first:** 4.5 (Discord presence —
opt-in wording), 4.7 (updater — pin the key first), 1.5 (ConnectionService —
ship only after F2, since the dialer recents copy the ring's identity rules).

---

## 5. Implementation status — what is built, and what proves it

The verdicts above are the design record and are unchanged. This section is the
**build record**: each shipped item, the behaviour that actually matters, and
the spec that goes red if it regresses. Run one with
`npx playwright test tests/<file>` (the suite starts the server itself; see
`README.md`).

| Plan item | Shipped behaviour | Spec |
|---|---|---|
| **F1** | The ongoing-call card's text comes from the room *type* — a decrypted channel name never reaches the FGS notification | `notification-privacy.spec.ts` |
| **F2** | Hide-preview reaches the native ring, lock-screen clean in both states | `notification-privacy.spec.ts` |
| **F3** | Desktop asks Rust for an expiring toast; every Android card is cancelled by id when its time is up | `notification-privacy.spec.ts` |
| **1.1** | Call notification actions: Mute / Deafen / Hang up as id-only `FLAG_IMMUTABLE` PendingIntents, plus a duration counter — commands, never content | `notification-privacy.spec.ts`, `call-comfort.spec.ts` |
| **1.3** | The output picker is a real control over the OS output devices (`audioRoutes` / `setAudioRoute`) | `batch-b.spec.ts` |
| **1.4** | The call requests transient audio focus (music pauses, notifications duck) and abandons it on teardown | `android-plugin-startup.spec.ts` |
| **1.6** | Speak-only rides the existing RNNoise energy gate (never a second detector, never a mode it cannot gate); hold-to-talk keeps the mic track disabled until held — a gate, not a mute — and a server mute wins | `voice-activation.spec.ts` |
| **1.7** | On-device captions: an **offline** engine only (no engine ⇒ captions refuse and say why, and `captionsStart` is never invoked, so no recogniser is handed the mic); display-only by default; publishing a second opt-in over the call channel, finals only; never on disk, in the console or in notifications | `captions.spec.ts` |
| **1.8** | Per-peer ping / rtt / jitter beside frames, loss and E2EE transform counts in the diagnostics panel — in-app only, ids and numbers | `voice-diag.spec.ts` |
| **2.3** | Quick Settings tile: literal labels only ("Mute"/"Unmute"/"Answer"/"E2E Chat"), boolean state, forwards the same verbs as the notification buttons | `batch-b.spec.ts` |
| **2.6** | The message chime is ringer/DND-aware; Settings' "Test sound" deliberately bypasses the gate | `quiet-hours.spec.ts` |
| **3.1** | Screen share carries the app's own audio as native PCM on the same projection; a refused capture costs only the audio track, never the video | `screen-share-audio-mobile.spec.ts` |
| **3.2** | The Android 14+ projection intent requests the user-choice config, so the system picker offers a single app | `android-plugin-startup.spec.ts` |
| **3.3 / 3.4** | Snip overlay, and share-into-app staging consumed into the composer | `batch-b.spec.ts` |
| **3.5** | Drag-out hands the OS a DownloadURL, reusing the Save-as decryption (no new trust) | `drag-out.spec.ts` |
| **4.1** | Global push-to-talk hotkey: the accelerator is parsed and rejected in Rust, press/release reaches the page as a boolean (default `Ctrl+Shift+Space`) | `ptt-hotkey.spec.ts`, box `cargo test` |
| **4.2** | `?mini=1` renders only the controls view; the main window acts on its buttons | `batch-b.spec.ts` |
| **4.4** | Deep links accept only in-scope id routes | `batch-b.spec.ts` |
| **4.6** | Tray tooltip/status carry state and counts only — `in_call`/`muted`/`deafened`/`unread`, never a name | `tray-parity.spec.ts`, box `cargo test` |
| **5.1** | Biometric unlock: enabling seals the **real** password (never plaintext), a cancelled prompt seals nothing and never looks enabled, the seal survives the login-page wipe, and the password path stays as fallback | `biometric-unlock.spec.ts` |
| **5.2** | *Removed by request* — JS, Kotlin and ACL fully stripped, `setSecureMode` gone | `batch-b.spec.ts` (asserts absence) |
| **5.3** | Panic wipe / auto-lock: default OFF, clamps, fires only past the idle limit, the chord wipes with no confirmation, and the wipe is total (search index included) | `panic-wipe.spec.ts` |
| **5.4** | Device verification: both devices derive the SAME string, marking verified pins the key and a later key change warns, and the string never reaches a notification or a log | `device-verify.spec.ts` |
| **5.5** | Encrypted local export: round-trips, a wrong passphrase fails, bytes are opaque, and the payload carries no session credentials | `encrypted-export.spec.ts` |
| **5.6** | Stronghold-style vault: Argon2id, **delete-after-migrate**, migration fails closed, a cold start is LOCKED (no redirect, no wipe), unlocking restores the session, and the vault dies with the device | `key-vault.spec.ts` |
| **5.7** | On-device search: decrypted text indexed and matched locally with the query never sent, ciphertext at rest, bounded/rotating, disappearing messages never indexed, panic wipe takes the DB | `local-search.spec.ts` |
| **6.1** | Battery prompt asks once, opens Android's own exemption dialog, remembers for 30 days; already-exempt phones never see it | `call-comfort.spec.ts` |
| **6.2** | The screen stays on for exactly the call's lifetime and releases at teardown | `call-comfort.spec.ts` |
| **6.5** | Network awareness: same-LAN answered from local IP facts only, offline schedules no retry while `online` reconnects at once, diagnostics shows facts | `network-awareness.spec.ts` |

| **7.1** | `turn-config` requires auth and mints per-session TURN credentials; the client merges them into `iceServers` (static pair still supported) | `voice-turn.spec.ts`, server `cargo test` |
| **7.2** | Documented coturn recipe for calls that must survive mobile data — docs only, no code path | `COTURN.md` |

**7.3 (LiveKit SFU) is deliberately not started** — it needs its own session for
the key-derivation ↔ FrameCryptor check and the fail-closed signalling
guarantee.

### The 5.6 ↔ 5.1 seam: the session ticket

Deleting the password bootstrap removed the only thing that let **in-page**
flows wrap the key blob: the mirror wraps every save with the password, and
enabling biometrics (5.1) seals the password itself. Keeping it in page memory
alone died at the first navigation (login.html → index.html) or reload, which
broke 5.1 and silently stopped every key-blob save.

The middle ground is `e2e_vault_ticket`: the password written through
secure-storage's own interceptor, i.e. stored **encrypted under the live
session key** — the same protection the session token already has. It is only
readable while a session is unlocked; a cold start has no key, so it reads as
nothing and the lock screen asks for the password (or a fingerprint). It is
written in exactly two places — `_kvMigrate()` (login/register/recovery) and
`_secUnlockVault()` — and the writer proves the value landed as ciphertext
(read through `_secGetRaw`, since the interceptor's `getItem` would hand back
plaintext) before keeping it, so a failed encryption can never leave the
password in the clear.

### Known red, and NOT from this work

`tests/profile-sharing.spec.ts` — `SV1`/`SV2`/`SV3` fail on a checkout of `HEAD`
too (verified by stashing the `static/` diff and re-running). They are about
display-name propagation after a server join, not about keys or the vault, so
they belong to a dedicated fix rather than this plan.
