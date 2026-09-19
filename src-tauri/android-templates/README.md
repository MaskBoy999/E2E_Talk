# Android-specific additions

Two different things live here:

- **`plugins/call-service/`** — the real, committed Tauri mobile plugin that keeps
  a voice call alive with the screen off (Rust + Kotlin + manifest). It is already
  registered by `src-tauri/src/lib.rs`.
- **This file** — the one-time wiring into the *generated* Android project, which
  only exists after `cargo tauri android init` (needs Android SDK + NDK + Java 17).

## 1. Background calls (screen off) — plugin is done, 3 wiring steps left

The plugin starts a `mediaCall` foreground service for the duration of a call.
`static/voice.js` already calls `plugin:call-service|start` when a call connects
and `|stop` from `teardownRoom()` (every exit path).

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

**Step 3 — runtime notification permission (Android 13+).** `POST_NOTIFICATIONS`
is declared by the plugin manifest, but from API 33 it must also be *requested*.
The ongoing call notification is `IMPORTANCE_LOW`, so a denial is not fatal — the
service still runs and keeps the call alive. To keep the "tap to return"
notification, grant it on first call (the plugin does not prompt automatically).

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

## 4. Reset the Android project

`gen/android/` is generated and disposable: delete it and re-run
`cargo tauri android init` to start clean. Any manual manifest edits there are lost,
which is why the plugin ships its own manifest instead.
