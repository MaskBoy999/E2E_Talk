# FEATURE RESEARCH — native things the Android + desktop box could do next

Researched 2026-09-23, while the box is at **v0.2.27** (PiP fix shipped).
Companion docs: `WEBSITE_IN_A_BOX_MASTER_PLAN.md` (what exists and why),
`MEDIA_SCALING_RESEARCH.md` (per-member video, simulcast, resolutions),
`VOICE_CALLS_SPEC.md`.

This is a menu, not a plan. Every row below was checked against the code as it
is today, so nothing here is already shipped.

---

## 0. Three constraints that decide the cost of everything

**1. The main window is a *remote* page, and Tauri refuses IPC to remote
origins by default.** The box works around it in
`grant_remote_ipc()` (`src-tauri/src/lib.rs:359`) by adding capabilities at
runtime with `CapabilityBuilder::new(..).remote(origin)`. The pattern is
already three deep (`remote-main`, `remote-call-service`, `remote-box-shell`).

> **So a new native feature costs:** the plugin/module + **one more dynamic
> capability** in `grant_remote_ipc()` + the JS call site. That is cheap and
> well-trodden — the expensive part of any item below is its *native* half
> (Kotlin service, Rust module), never the wiring.

**2. E2EE is the product.** Anything that wants plaintext must run **on the
device** or **on the user's own box**. This rules out the whole genre of
"cloud AI / cloud search / cloud transcription" features and, happily, makes
the better-privacy version of each of them the *interesting* version.

**3. Calls are a mesh.** `static/voice.js:41` configures Google STUN plus
whatever the server hands out; `server/src/config.rs:33` already reads
`TURN_URLS` / `TURN_USERNAME` / `TURN_PASSWORD`. So TURN is *plumbed but
unconfigured* — not a missing feature, a missing deployment step (see §7).

Effort key: **S** ≤ 1 day · **M** 2–5 days · **L** 1–2 weeks — each including
the tests and a release, which is the house standard.

---

## 1. Calls and audio — where the phone experience is still weakest

| # | Feature | Why it fits | How | Effort | E2EE |
|---|---------|-------------|-----|--------|------|
| 1.1 | **Call notification you can act on** — Mute / Deafen / Hang up buttons + a live duration | The FGS notification (`CallForegroundService.kt:175`) is a bare ongoing card with no actions; you must open the app to mute | `NotificationCompat.addAction` + `PendingIntent`s back into the service, which emits a plugin event the page listens for. Android 16 (API 36): `Notification.ProgressStyle` for Live Updates | S | none |
| 1.2 | **Media keys / headset buttons** (mute, deafen, hang up) | Bluetooth headsets and car stereos currently do nothing; play/pause on a headset during a call is the single most-expected mobile behaviour | A `MediaSession` (+ `MediaStyle` notification) in the call-service plugin; `onPlay/onPause/onSetMicrophoneMute` → existing events. Gives car + Wear + lock-screen control for free | M | none |
| 1.3 | **Audio output routing menu** — earpiece / speaker / wired / Bluetooth, with the current one shown | WebRTC on Android picks a route and the WebView gives no control; a laptop speaker stays the default in a pocket | `AudioManager.setCommunicationDevice` (API 31+) from the plugin; page reads/picks via events. Today `AudioProfile.kt` only reads ringer/DND | M | none |
| 1.4 | **Audio focus** — pause the user's music for a call, duck notifications | Currently the app talks over whatever is playing | `requestAudioFocus` with `AUDIOFOCUS_GAIN_TRANSIENT` in the call-service plugin, released on hang-up | S | none |
| 1.5 | **Self-managed `ConnectionService`** — the call appears in the system dialer, answers on car/Wear/headset | `MANAGE_OWN_CALLS` and the `phoneCall` FGS type are *already declared* (§A3.7) — the permission's real purpose is exactly this | `PhoneAccount` + `ConnectionService` in the plugin; the existing full-screen intent becomes the fallback | L | none |
| 1.6 | **Speak-while-open mic (VAD) and hold-to-talk on mobile** | RNNoise is already in the pipeline (`voice.js:76`); a VAD gate is a few lines away and beats a mute button on a phone | Energy/RMS gate in the existing audio worklet, settings toggle | S | none |
| 1.7 | **On-device live captions** | The differentiator nobody else can copy without giving up E2EE: no audio ever leaves the device | Desktop: `whisper-rs`/whisper.cpp in a Rust module (like `win_webview.rs`), streaming the *already decrypted* local audio. Android: on-device `SpeechRecognizer` (offline, API 31+) or sherpa-onnx. Captions are local-only by default; publishing them to peers is a second, explicit toggle over the existing E2EE data channel | L | **preserved** (and the reason it's a native feature) |
| 1.8 | **Connection quality overlay** — ping/jitter/loss/bitrate per peer | `getStats()` is already used in three places; the mesh hides its own problems and "it sounds bad" is hard to debug | Small panel reading the existing pollers; a one-line log for support | S | none |

---

## 2. Notifications and system presence

| # | Feature | Why it fits | How | Effort | E2EE |
|---|---------|-------------|-----|------|------|
| 2.1 | **Reply to a DM from the shade** | The single biggest phone-chat gap; every messenger has it, and the payload contract already exists (`sw.js` expects `title/body/tag/data`) | `RemoteInput` + a direct-reply action on the message notification, handed back over the existing plugin event bus → `sendMessage()` | M | none (reply is encrypted the normal way) |
| 2.2 | **Android home-screen widget** — unread count, "join voice", mute | One tap into a call beats unlocking + app + channel | Community `tauri-plugin-widgets` (AppWidgetManager) or a small native widget + the existing plugin bus | M | none |
| 2.3 | **Quick Settings tile** — mute/deafen, and "answer" during a ring | Exactly the muscle-memory place for call controls; zero UI to design | `TileService` in the call-service plugin | S | none |
| 2.4 | **Launcher app shortcuts** — long-press the icon → channels / "Join last voice" | Cheap discoverability, feels like a first-class app | Static `shortcuts.xml` in the generated Android app | S | none |
| 2.5 | **Push without Google** (UnifiedPush / self-hosted ntfy) | FCM needs a Firebase project, which cuts against a self-hosted, account-free box. ntfy is an existing UnifiedPush **distributor** and can be self-hosted next to the relay | Android: a UnifiedPush receiver in the plugin (the app registers, the box POSTs to the distributor endpoint). Server: one more `push.rs` sender alongside Web Push/FCM | M | none (payloads stay opaque, same as now) |
| 2.6 | **"Quiet hours" / per-channel notification policy on the native side** | The web layer can only do so much once the app is backgrounded | Notification channels per category + `setInterruptionFilter`-aware behaviour, reusing the `AudioProfile` reading that already exists | S | none |

---

## 3. Capture and media

| # | Feature | Why it fits | How | Effort | E2EE |
|---|---------|-------------|-----|------|------|
| 3.1 | **System audio in screen share (Windows/Android)** | Screen share is video-only today; "watch this with me" needs the sound | Desktop: `getDisplayMedia({audio:true})` on Windows/Chrome-derived; Android 10+: `AudioPlaybackCapture` behind the existing `MediaProjection` (`ScreenCapture.kt`) | M | none |
| 3.2 | **Per-app capture on Android 14+** | Sharing one app instead of the whole screen is the modern, safer default | `MediaProjection.createScreenCaptureIntent(MediaProjectionConfig)` — the UI is already a system picker | S | none |
| 3.3 | **Region screenshot + annotate, then send** | Faster than starting a share to show one thing; community `tauri-plugin-screenshots` grabs windows/monitors | Plugin + a small canvas annotator; file goes in through the existing attachment path | M | none |
| 3.4 | **Share *into* the app** (Gallery → Share → E2E Chat → channel) | Removes the download-upload dance entirely; the most-loved messenger integration there is | Community `tauri-plugin-mobile-sharetarget` / `sharesheet` (FIFO of inbound intents) + a channel picker | M | none |
| 3.5 | **Drag files out of the app** (macOS file-promise / desktop drag-out) | Pairs with drag-in, which the window already supports | Community `tauri-plugin-dragout` | S | none |

---

## 4. Desktop shell polish

| # | Feature | Why it fits | How | Effort | E2EE |
|---|---------|-------------|-----|------|------|
| 4.1 | **Push-to-talk global hotkey** | The desktop feature that makes a voice app feel professional; Discord's most-used keybind | Official `tauri-plugin-global-shortcut` (desktop) → same mute path the page already uses. Optional "hold to talk" | S | none |
| 4.2 | **Always-on-top mini call window** — the chosen tile in a small frameless window | The desktop twin of the Android PiP we just fixed; today you can only see the tile inside the app window | A second Tauri window (`always_on_top`, `decorations:false`) whose URL loads an existing standalone tile page | M | none |
| 4.3 | **OS media integration** — "In voice call" in the Windows media panel / MPRIS / macOS Now Playing, with media keys | The desktop analogue of 1.2; also makes OBS/stream decks see the call | No official plugin: a small Rust module per platform (the same shape as the existing `win_webview.rs` glue) | L | none |
| 4.4 | **Deep links** — `e2e-chat://channel/<id>`, plus `?dm=<id>` ring links already in push | Clicking a link in another app should land in the right channel, not the login screen | Official `tauri-plugin-deep-link` + the existing single-instance plugin (documented as the intended pair) | S | none |
| 4.5 | **Discord Rich Presence** — "E2E Chat — in General Voice" | Free social surface for a chat app; community `tauri-plugin-drpc` | Plugin, opt-in setting | S | none |
| 4.6 | **Parity of tray state** — tray icon reflects mute/deafen/unread | Tray exists (`build_tray()`); it does not yet say anything about the call | Tray item state + tooltip updates from the same events | S | none |
| 4.7 | **Revisit the auto-updater** (deliberately excluded, §A3.10) | Releases are signed, tags are automated, checksums published — the pipeline the updater needs now exists | Official `tauri-plugin-updater` with the release signature; needs a security decision, not just work — the update endpoint becomes a new trust root | M | none |

---

## 5. Privacy and crypto-adjacent — the ones only *this* app can ship

| # | Feature | Why it fits | How | Effort | E2EE |
|---|---------|-------------|-----|------|------|
| 5.1 | **Biometric unlock** | `secure-storage.js` already has a password bootstrap to derive the storage key; a fingerprint is the same flow with the OS holding the secret | Official `tauri-plugin-biometric` + Android Keystore-backed key release; falls back to the password path | M | **strengthens** |
| 5.2 | **Screen-capture blocking per channel** (`FLAG_SECURE`) | For the one server where "no screenshots" is the point | One flag on the window from a box-shell command; page asks for it per channel | S | none |
| 5.3 | **Panic wipe / auto-lock timer** | Standard for this class of app; a local wipe of token, keys and cache after N minutes idle or a hidden gesture | Reuses `_secDel`/secure storage + a timer | S | none |
| 5.4 | **Device verification (SAS / emoji fingerprint)** | `shared-keys` already compares keys between peers; showing *which device* holds which key turns a technical check into a user-facing one | Derive a short digest per device from existing key material; badge in the member/settings UI | M | **strengthens** |
| 5.5 | **Encrypted local export/backup** — messages + keys as one file | "Get your data out" without the server ever seeing it | `age`/libsodium sealed box in a Rust command, file via `tauri-plugin-dialog` | M | **preserved** |
| 5.6 | **Stronghold-style vault instead of the current key bootstrap** | Official `tauri-plugin-stronghold` (Argon2 + encrypted file) is a drop-in upgrade for the storage layer | Plugin + migration of the existing store | M | **strengthens** |
| 5.7 | **Local encrypted full-text search (SQLite FTS5)** | The server *cannot* search E2EE content, so search has to be client-side — which is both the constraint and the feature | Official `tauri-plugin-sql` (sqlx) with an FTS5 table over decrypted message text, keyed store, bounded size | L | **preserved** |
| 5.8 | **Native diagnostics panel** — ACL grants, plugin versions, cert pin, notification permission, FGS type, audio route, PiP state | The project's own history is a list of *silently* dead natives: the notification ACL twice, the in-app Change-server button (§11.1). One screen would have caught all of them | Rust command + a page section; reads what `grant_remote_ipc` and the plugins already know | S | none |

---

## 6. Reliability and ops

| # | Feature | Why it fits | How | Effort | E2EE |
|---|---------|-------------|-----|------|------|
| 6.1 | **Battery-optimization exemption prompt** | The #1 way an Android voice app dies in the background is Doze, and it looks like a bug to the user | Community `tauri-plugin-android-battery-optimization`; on the existing calling settings | S | none |
| 6.2 | **Keep-screen-on during a call** | Community `tauri-plugin-keep-screen-on`; smaller than a wake lock written by hand | Plugin + call join/leave | S | none |
| 6.3 | **Rotating local logs + "Copy diagnostics"** | Impossible to debug a phone without adb; `tauri-plugin-log`/`tracing` with rotation, then a paste-able bundle | Plugin, one button | S | none |
| 6.4 | **Opt-in crash/ANR reporting to a *self-hosted* Sentry (GlitchTip)** | Community `sentry-tauri` captures JS errors, Rust panics and native minidumps — but point it at your own instance, not sentry.io | Plugin + config; must be explicitly opt-in to fit the app's posture | M | none |
| 6.5 | **Network awareness** — "same Wi-Fi as the box, direct path possible" and better reconnect | The mesh already struggles with NAT; the client knowing its own network helps | Community `tauri-plugin-network` / device-info plugins | S | none |

---

## 7. Scaling the calls themselves

| # | Feature | Why it fits | How | Effort | E2EE |
|---|---------|-------------|-----|------|------|
| 7.1 | **TURN credentials that aren't a static secret** | The plumbing exists (`config.rs:33`) but `TURN_PASSWORD` is a shared constant — a leaked one relays anyone's traffic until it's rotated | coturn `use-auth-secret` + an HMAC time-limited credential minted per session by the relay server (TURN REST), handed to the page with the ICE list | S | none |
| 7.2 | **Documented coturn deployment** (§7.1's other half) | Mobile-data calls without TURN fail for a large share of users; this is the most common "the calls don't work" cause | A `certs/`-style recipe + a `TURN_*` block in the deployment docs; nothing in the app changes | S | none |
| 7.3 | **Mesh → SFU above ~6 members** | The honest end of `MEDIA_SCALING_RESEARCH`: simulcast helps, but a mesh's uplink is N-1 regardless | **LiveKit** self-hosted — a single Go binary/image, and its E2EE mode is insertable-streams exactly like the current per-stream transforms, so the key model survives; the box would issue room tokens instead of mesh signals | L | **preserved** (LiveKit has first-class E2EE, unlike most SFU vendors) |

---

## 8. What the integration catalog actually offers here

Checked rather than assumed:

- **TURN / SFU — no match.** The catalog has no WebRTC infrastructure; the
  recommended options for "self-hosted voice infra" come back as generic BaaS
  (Supabase, Appwrite) and video *hosting* (api.video), none of which relay
  WebRTC media. §7 is a self-hosted-deployment problem, not a vendor problem.
- **Push — no match either, and that's informative.** The nearest service is
  Knock (a notification *orchestration* product for SaaS lifecycle messaging:
  `KNOCK_API_KEY`, accounts, dashboards). For a self-hosted, account-free box
  the correct shape is UnifiedPush with ntfy (§2.5) — the box pushes to a
  distributor the user chose, with no third party in the middle.
- Everything else on this list is a **Tauri plugin or a native API**, which is
  the right shape for a product whose whole pitch is "no third party".

---

## 9. If we only do ten things

Ranked by (value to the phone experience) ÷ (effort), assuming tests and a
release for each:

| Rank | Feature | §  | Effort |
|------|---------|----|--------|
| 1 | Call notification with Mute / Deafen / Hang up (+ Live Updates on 16) | 1.1 | S |
| 2 | Audio routing + audio focus | 1.3, 1.4 | M |
| 3 | TURN credentials + coturn recipe (calls that work on mobile data) | 7.1, 7.2 | S |
| 4 | Native diagnostics panel | 5.8 | S |
| 5 | Push-to-talk global hotkey (desktop) | 4.1 | S |
| 6 | Media keys / headset buttons | 1.2 | M |
| 7 | Battery-optimization prompt + keep-screen-on | 6.1, 6.2 | S |
| 8 | Deep links + launcher shortcuts | 4.4, 2.4 | S |
| 9 | UnifiedPush / ntfy push (no Firebase) | 2.5 | M |
| 10 | Reply from the notification shade | 2.1 | M |

**Suggested sequencing**

- **Sprint 1 — "it feels like a phone app":** 1.1, 1.3, 1.4, 6.1, 6.2, 2.4, 4.4.
  All S, all user-visible, and they lean on the plugin/capability pattern that
  is already three instances deep.
- **Sprint 2 — "it never drops a call":** 7.1, 7.2, 1.2, 2.5, 5.8, 6.3.
  Reliability plus the first feature that needs a new server-side sender.
- **Sprint 3 — "nobody else can do this":** 5.1, 5.4, 5.7, 1.7, 7.3.
  The privacy-native and scale-native items. Each is L, each is a genuine
  differentiator, and each one is only possible because the media and the
  message store never leave the user's own devices.

---

## 10. Traps — plausible ideas that break this app's promises

- **Server-side search, transcription or AI summaries.** It is the easiest
  version and it destroys the whole proposition: the box would hold plaintext.
  Every such feature has to be client-side (§1.7, §5.7) or on the user's box.
- **Any vendor in the media path** (SFU SaaS, TURN SaaS, cloud AI): it sees
  who talks to whom and when, even with E2EE. Self-host or skip.
- **FCM as the only push path**: ties a self-hosted, account-free product to a
  Google project and a Play-Services device. Optional FCM plus UnifiedPush is
  the shape that keeps the promise.
- **An auto-updater wired to anything the app cannot pin.** Revisiting §4.7 is
  fine, but the update manifest is a new trust root for a product whose entire
  security story is TOFU pinning — treat it as a security change, not a
  convenience one.
- **`FLAG_SECURE` on everything.** It also blocks the user's own screenshots
  and Assist; make it per-channel, not global.
