//! `box-shell` — Android full-screen shell behaviour.
//!
//! Two things the generated Android project cannot be asked for, because
//! `src-tauri/gen/android/` is regenerated (it is gitignored) on every
//! `tauri android init` — so anything edited there is lost before CI ever sees
//! it, and the fix has to live in a plugin's own committed source instead:
//!
//! 1. **Immersive system bars.** The status bar and the gesture/navigation bar
//!    sat on top of the app at all times, stealing the top and bottom strips of
//!    the screen from the chat UI. The Kotlin side hides both with
//!    `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`, which is exactly the gesture
//!    that was asked for: swipe down from the top (or up from the bottom) and
//!    the bar appears for a moment, then leaves again.
//! 2. **Back button.** The generated `TauriActivity` sets
//!    `handleBackNavigation = false`, so wry registers *no* back callback at
//!    all and Android's default — finish the activity — applies. Pressing Back
//!    therefore closed the app outright, and (with an unreachable host on the
//!    next launch) dropped the user back on the address screen with everything
//!    they were doing gone. The Kotlin side installs its own
//!    `OnBackPressedCallback` and emits `box:back` to the page, which closes
//!    the topmost open layer — or, when nothing is open, calls `exit`.
//!
//! 3. **Haptics.** Every cue in the app (incoming call, ring→waiting,
//!    notification, and the Settings "Test pattern" buttons) used to be
//!    `navigator.vibrate(...)` — which Chromium **disabled on Android in v79**
//!    while leaving the interface in place. The call was defined, unblocked,
//!    returned `true` while the page was visible, and did nothing, so every
//!    haptic worked in a browser and was silently dead inside the app. The
//!    `vibrate` command plays the same pattern on the real vibrator through
//!    `VibrationEffect.createWaveform` — one hardware waveform, no JS timers.
//! 4. **Notification hygiene.** Notifications already read used to stay in the
//!    shade forever (the notification plugin's shim posts a plain object with no
//!    `close()`), so `clearNotifications` empties the shade when the app comes
//!    back to the front — minus the ongoing call, which stays for as long as the
//!    call does.
//!
//! The commands are Kotlin (`android/src/main/java/com/e2echat/boxshell/`), so
//! this crate exists to register that class with Tauri. The registration call is
//! not optional: a plugin whose commands live in Kotlin that never calls
//! `api.register_android_plugin(…)` is never instantiated, every
//! `plugin:box-shell|…` invoke fails, and the feature is silently inert. The
//! `call-service` plugin next door shipped exactly that bug once — hence the
//! loud error below.
//!
//! On desktop the plugin has no commands and the JS side never invokes it: a
//! desktop window has no system bars to hide and its own title bar/back
//! semantics.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Package of the Kotlin half (`android/src/main/java/com/e2echat/boxshell`).
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.e2echat.boxshell";

/// Desktop-only: putting a *file* on the OS clipboard, which the WebView cannot
/// do for itself. See the module docs for why it has to exist at all.
#[cfg(not(target_os = "android"))]
mod clipboard;

/// Put a decrypted attachment on the OS clipboard.
///
/// One command name, two platforms: on Android the same call is handled by the
/// Kotlin half (`ClipData` + the app's `FileProvider`), which is why this one is
/// written in the plugin and declared in `build.rs` — a plugin command is
/// reachable from the remote app page through the `box-shell:default`
/// capability, while an *app* command is refused to a remote origin (see
/// `grant_remote_ipc` in the app crate).
///
/// The payload is the raw request body, not JSON: `[u32 LE name length][name
/// UTF-8][file bytes]`. An attachment may be hundreds of megabytes, and a
/// base64 string inside a JSON argument would mean two extra full-size copies
/// (and a JSON parse) on the way to disk for no benefit. The length-prefixed
/// name avoids sending it as a header, which would need its own escaping rules.
#[cfg(not(target_os = "android"))]
#[tauri::command]
#[allow(non_snake_case)]
fn copyFileToClipboard<R: Runtime>(
    app: tauri::AppHandle<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("copyFileToClipboard: expected the raw request body".to_string());
    };
    let (name, bytes) = split_body(body)?;
    clipboard::copy_file(&app, name, bytes)?;
    Ok(())
}

/// Split the raw body described on [`copyFileToClipboard`].
#[cfg(not(target_os = "android"))]
fn split_body(body: &[u8]) -> Result<(&str, &[u8]), String> {
    if body.len() < 4 {
        return Err("copyFileToClipboard: body is too short to hold a name".to_string());
    }
    let len = u32::from_le_bytes([body[0], body[1], body[2], body[3]]) as usize;
    if body.len() < 4 + len {
        return Err(format!(
            "copyFileToClipboard: body is {} bytes but claims a {len}-byte name",
            body.len()
        ));
    }
    let name = std::str::from_utf8(&body[4..4 + len])
        .map_err(|_| "copyFileToClipboard: name is not UTF-8".to_string())?;
    Ok((name, &body[4 + len..]))
}

/// Register the plugin. Call from `tauri::Builder::plugin(…)`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = Builder::<R, ()>::new("box-shell");
    // Desktop (and only desktop) adds a Rust command. On Android the clipboard
    // half is Kotlin — registering a Rust handler for the same name there would
    // shadow it, so the handler is compiled out instead of branched at runtime.
    #[cfg(not(target_os = "android"))]
    let builder = builder.invoke_handler(tauri::generate_handler![copyFileToClipboard]);
    builder
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            api.register_android_plugin(PLUGIN_IDENTIFIER, "BoxShellPlugin")
                // A failure here is fatal for the feature and must not look like
                // success: bubble it up so the app fails loudly at startup
                // instead of silently dropping every later invoke.
                .map_err(|e| format!("box-shell: could not register the Android plugin: {e}"))?;
            #[cfg(not(target_os = "android"))]
            {
                let _ = &api;
                // A clipboard entry is a *path*, so a copy made in an earlier
                // launch is a decrypted attachment sitting in the cache dir with
                // nothing on the clipboard left to explain it. Start empty.
                clipboard::clear(app);
            }
            Ok(())
        })
        .build()
}
