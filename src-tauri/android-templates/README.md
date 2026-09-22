# Android-specific additions

Two different things live here:

- **`plugins/call-service/`** — the real, committed Tauri mobile plugin that keeps
  a voice call alive with the screen off (Rust + Kotlin + manifest). It is already
  registered by `src-tauri/src/lib.rs`.
- **This file** — the one-time wiring into the *generated* Android project, which
  only exists after `cargo tauri android init` (needs Android SDK + NDK + Java 17).

## 1. Background calls (screen off) — plugin is done, 3 wiring steps left

The plugin starts a `phoneCall` foreground service for the duration of a call.
`static/voice.js` already calls `plugin:call-service|start` when a call connects
and `|stop` from `teardownRoom()` (every exit path).

The plugin manifest also declares the permissions a call needs to capture anything
(`RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `CAMERA`). That matters more than it looks: wry's
`RustWebChromeClient.onPermissionRequest` turns the WebView's `AUDIO_CAPTURE` / `VIDEO_CAPTURE`
request into the matching Android runtime prompt, but for an **undeclared** permission the
prompt is auto-denied — so `getUserMedia` fails and the call connects with no audio, no video.

**Step 1 — register the plugin with the generated app.** Tauri finds the plugin's
`android/` folder automatically once the crate is a dependency, but the generated
Gradle build must include it. After `cargo tauri android init`:

```bash
# The generated project lives at src-tauri/gen/android/
# Confirm the plugin module is wired in: src-tauri/gen/android/settings.gradle
```

Tauri adds plugin Android modules automatically for plugins that ship an
`android/` folder; if `settings.gradle` doesn't list it, add:

```gradle
include ':tauri-plugin-call-service'
project(':tauri-plugin-call-service').projectDir =
    new File('../plugins/call-service/android')
```

**Step 2 — grant the permission.** The plugin's commands are ACL-gated, and the
app window loads a *remote* origin (the user's Tailscale host), so the grant is
runtime. It is already done in `grant_remote_ipc()` (`lib.rs`) via a second
capability named `remote-call-service` carrying `call-service:default`. If the
start call is rejected with a permissions error, that capability failed to
resolve — check `adb logcat` for `grant_remote_ipc: call-service … failed`.

**Step 3 — runtime notification permission (Android 13+) — done in the web app.**
`POST_NOTIFICATIONS` is declared by the plugin manifest, but from API 33 it must also be
*requested*, and nothing used to ask. `static/chat.js` now does, once per install, from
`initBoxNotificationPermission()` on the box's first page load — called through the **shim's
own** `Notification.requestPermission()`, which is both the plugin call *and* the only thing
that repairs the shim's cached `permission` (it caches `"denied"` on Windows and `"default"`
on Android until this runs, and `showBrowserNotification()` gates on it). `notification:default`
is what makes the call reachable from the remote origin. It has to happen while the app is in the foreground, which is why it is at
load time rather than on the first call. A denial is not fatal — the service still runs and
keeps the call alive, only the "tap to return" notification is missing.

On **Android 14+** there is a second, separate grant: *Full screen notifications* (Settings →
Apps → E2E Chat → Special app access). Without it the incoming-call ring degrades to a
heads-up notification instead of taking over the lock screen.

### Verifying it

```bash
adb install -r dist/E2E-Chat-*-android.apk
adb logcat | grep -iE 'e2echat|callservice|RustStdoutStderr'
```

Start a call → lock the screen → wait 5 minutes → two-way audio should continue,
and:

```bash
adb shell dumpsys activity services | grep -i CallForegroundService
```

should list the service while the call is up, and nothing after hanging up.

## 2. Screen share

Nothing to add — Android WebView (API 29+, which is why `bundle.android.minSdkVersion`
is 29) supports `navigator.mediaDevices.getDisplayMedia()`, and `static/voice.js`
already uses it. The system picker offers "Share entire screen" / "Share one app".

## 3. Notifications, haptics, and staying alive

### 3a. Haptics — wired through the plugin, not the WebView

Every cue in the app (incoming call, ring→waiting, notification, and the
Settings → "Test pattern" buttons) goes through `window.boxHaptic`
(`static/box-shell.js`), which calls this plugin's `vibrate` command on the box
and `navigator.vibrate` everywhere else.

That indirection is the whole fix, not a style choice: **Chromium disabled the
Vibration API on Android in v79** and left the interface in place.
`navigator.vibrate` in the box is defined, is not blocked, returns `true` while
the page is visible — and does nothing. So every haptic worked in a browser and
was silently dead in the app, including the Test buttons, which are exactly where
a user goes to check. `VibrationEffect.createWaveform` now plays the configured
pulse/gap/pulse pattern on the real vibrator as one hardware waveform, and the
`VIBRATE` permission ships in the plugin manifest (install-time; no prompt).

### 3b. Notification hygiene

* While the app is **in front**, it posts no system notification at all: the
  badge, toast and sound have already said what a shade notification would, and
  one posted anyway outlives the visit (the notification plugin's shim posts a
  plain object with no `close()`).
* Coming **back to the app** empties the shade (`clearNotifications`), so
  notifications that were read do not pile up. The ongoing "In call"
  notification is deliberately kept — while a call is up, it *is* the call's
  presence in the shade and the way back into it.

### 3c. What "the app was closed" can and cannot do (research)

**Calls with the screen off — done.** `call-service` keeps the process (and so
the WebRTC connection and the mic) alive for the duration of a call. Note the
direction of that: a call cannot *start* while the app is gone, because the app
is what knows the call exists.

**"Tell me about a message while the app is closed" — impossible without push.**
The socket lives in the WebView. Once Android kills the process (it decides, not
the app — a removed task is enough), the socket dies with it, and nothing can
wake the app to say a message arrived. Nothing inside the app can get around
that:

* **A permanent foreground service** is the only way to keep the process (and so
  the socket) alive with the app "closed". It costs a notification the user
  cannot dismiss, continuous battery use, and — since Android 12 — it can only be
  *started* while the app is visible, so it must be an explicit, revocable user
  setting and needs a boot receiver to come back. Android 14+ also requires one
  of the platform's approved service types with its matching permission, and
  Google Play asks for the use case to be declared; "keep my chat socket open"
  has no approved type. OEM battery managers (Xiaomi, Huawei, Samsung, Oppo)
  kill it anyway unless the user exempts the app. This is why chat apps do not do
  it.
* **Push (FCM)** is the sanctioned answer: the server tells Google, Google wakes
  the app even if it is dead, the app posts the notification. No persistent
  service, no battery cost, survives a force-stop. It needs the one thing this
  project cannot make for itself — a Firebase project (`google-services.json`)
  plus a server-side sender. That is work on both sides (a push plugin in the
  app, a token registry and send path in `server/`), untestable without those
  credentials, and tracked in the master plan §A3.5.

Until then the app does what it can: it reconnects when opened and surfaces what
was missed (`showMissedActivityNotification`), and a call that arrives while the
app is alive-but-backgrounded rings through the foreground service.

The credential-free middle ground, if it is ever wanted: an opt-in "stay
connected" toggle starting a `dataSync`-typed foreground service for as long as
the user leaves it on — accepting the permanent notification and the battery cost
in exchange for message notifications while the app is closed. Still subject to
Play's use-case declaration.

## 3b. In-app server address change — nothing to wire

*Settings → Connection → Change server address…* works on Android without any native setup:
the page emits the `box:change-server` event, `src-tauri/src/lib.rs` calls `open_setup()`, and
because a second Tauri window on Android needs an extra `TauriActivity` subclass, an activity
embedding property, split rules and `core:webview:allow-create-webview-window` (Tauri's
*Multi-Window on Mobile* guide) — for a screen that would only cover the app anyway — the
setup page **takes over the main window** instead (`open_setup_in_main`). Saving navigates
that same window to the new address. Do not "fix" this by adding the Activities back.

A saved host that is **unreachable** also lands here: startup probes it (`host_reachable`) and
shows this setup screen rather than the WebView's error page, which on a phone left no way out
at all — no tray, no back button, no address bar. Desktop keeps its error page and its tray
entry. Because `open_setup_in_main` can be the thing that *creates* the main window, it also
attaches the navigation allowlist (`nav_allowlist`); without it the app would follow any
external link away from the host with no way back.

## 4. Reset the Android project

`gen/android/` is generated and disposable: delete it and re-run
`cargo tauri android init` to start clean. Any manual manifest edits there are lost,
which is why the plugin ships its own manifest instead.
