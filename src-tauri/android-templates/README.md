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

## 3. Push notifications (FCM)

Needs a Firebase project (`google-services.json`) plus server-side sending. See the
master plan §A3.5. Not wired yet — this is the one feature that cannot work
without external credentials.

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
