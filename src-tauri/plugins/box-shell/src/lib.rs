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

/// Desktop-only: writing a decrypted file to disk, which an `<a download>`
/// cannot do inside the WebView (see `save.rs`). Android implements the same
/// command in Kotlin.
#[cfg(not(target_os = "android"))]
mod save;

/// Ceiling for a clipboard copy: a copy is a *paste*, not a file transfer.
///
/// Mirrors the Kotlin half (`MAX_SHARED_FILE_BYTES`), so both platforms refuse
/// the same file with the same sentence.
#[cfg(not(target_os = "android"))]
const MAX_CLIPBOARD_BYTES: usize = 25 * 1024 * 1024;

/// Ceiling for a save. Mirrors the Kotlin half (`MAX_SAVE_FILE_BYTES`): the
/// bytes cross the IPC as a single base64 string, so this cap is what turns a
/// huge attachment into a clear refusal instead of an out-of-memory.
#[cfg(not(target_os = "android"))]
const MAX_SAVE_BYTES: usize = 100 * 1024 * 1024;

/// How the page hands a decrypted file to the shell, and why it looks like this.
///
/// **JSON, with the bytes in base64, on every platform** — the page builds one
/// payload shape and one command name for desktop and Android alike.
///
/// The raw request body (`[u32 LE name length][name UTF-8][bytes]`) has a real
/// advantage — it is the file, once, with no 4/3 expansion and no string — and
/// that is what the page used to send on desktop. It cannot be relied on. The
/// page is served by a *server-supplied* CSP, and this app's own server sends
/// `connect-src 'self' ws: wss:`; the Tauri IPC endpoint (`http://ipc.localhost`)
/// is not the page's own origin, so the engine blocks the custom-protocol IPC —
/// Tauri sees the blocked fetch, logs "IPC custom protocol failed", and falls
/// back to the `postMessage` interface, which serialises the whole message as
/// JSON and **cannot carry a request body at all**. Every copy and every save
/// therefore arrived here as `InvokeBody::Json`, this command answered
/// "expected the raw request body", and the page could only tell the user that
/// copying a file "needs the app" — while they were using the app.
///
/// Base64 over JSON is the one shape that survives both IPC paths, so it is the
/// shape the page sends now. The raw form is still accepted, because the page
/// ships from the *server*: an older page can meet a newer shell.
#[cfg(not(target_os = "android"))]
fn file_payload(body: &tauri::ipc::InvokeBody) -> Result<(String, Vec<u8>), String> {
    match body {
        tauri::ipc::InvokeBody::Raw(raw) => {
            let (name, bytes) = split_body(raw)?;
            Ok((name.to_string(), bytes.to_vec()))
        }
        tauri::ipc::InvokeBody::Json(value) => {
            let name = value
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("attachment")
                .to_string();
            let encoded = value
                .get("data")
                .and_then(|v| v.as_str())
                .ok_or("file command: the request carries no base64 `data`")?;
            Ok((name, decode_base64(encoded)?))
        }
    }
}

/// Standard base64 → bytes.
///
/// Base64 is 4/3 of the file on the wire; the alternative JSON offers for bytes
/// (a number per byte) is ~4x *and* far slower to parse.
#[cfg(not(target_os = "android"))]
fn decode_base64(encoded: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("file command: the payload is not base64: {e}"))
}

/// Put a decrypted attachment on the OS clipboard.
///
/// One command name, two platforms: on Android the same call is handled by the
/// Kotlin half (`ClipData` + the app's `FileProvider`), which is why this one is
/// written in the plugin and declared in `build.rs` — a plugin command is
/// reachable from the remote app page through the `box-shell:default`
/// capability, while an *app* command is refused to a remote origin (see
/// `grant_remote_ipc` in the app crate).
///
/// The payload shape is [`file_payload`]'s: JSON with base64 `data`, exactly
/// what the Kotlin half takes.
#[cfg(not(target_os = "android"))]
#[tauri::command]
#[allow(non_snake_case)]
fn copyFileToClipboard<R: Runtime>(
    app: tauri::AppHandle<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let (name, bytes) = file_payload(request.body())?;
    if bytes.is_empty() {
        return Err("copyFileToClipboard: nothing to copy".to_string());
    }
    if bytes.len() > MAX_CLIPBOARD_BYTES {
        return Err(format!(
            "copyFileToClipboard: too large to copy (over {} MB)",
            MAX_CLIPBOARD_BYTES / (1024 * 1024)
        ));
    }
    clipboard::copy_file(&app, &name, &bytes)?;
    Ok(())
}

/// Save decrypted bytes to disk under their real name.
///
/// Same payload shape and same command name as [`copyFileToClipboard`], because
/// the page builds one payload and picks the command: the WebView's
/// `<a download>` is a silent no-op inside the shell, so every
/// "Download"/"Save a copy"/export has to go through native code to actually
/// produce a file. Returns the absolute path written (shown in a toast — there
/// is no save dialog to confirm it).
#[cfg(not(target_os = "android"))]
#[tauri::command]
#[allow(non_snake_case)]
fn saveFile<R: Runtime>(
    app: tauri::AppHandle<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let (name, bytes) = file_payload(request.body())?;
    if bytes.is_empty() {
        return Err("saveFile: nothing to save".to_string());
    }
    if bytes.len() > MAX_SAVE_BYTES {
        return Err(format!(
            "saveFile: too large to save (over {} MB)",
            MAX_SAVE_BYTES / (1024 * 1024)
        ));
    }
    let path = save::save_file(&app, &name, &bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Split the legacy raw body described on [`file_payload`].
#[cfg(not(target_os = "android"))]
fn split_body(body: &[u8]) -> Result<(&str, &[u8]), String> {
    if body.len() < 4 {
        return Err("file body is too short to hold a name".to_string());
    }
    let len = u32::from_le_bytes([body[0], body[1], body[2], body[3]]) as usize;
    if body.len() < 4 + len {
        return Err(format!(
            "file body is {} bytes but claims a {len}-byte name",
            body.len()
        ));
    }
    let name = std::str::from_utf8(&body[4..4 + len])
        .map_err(|_| "file body: name is not UTF-8".to_string())?;
    Ok((name, &body[4 + len..]))
}

#[cfg(all(test, not(target_os = "android")))]
mod payload_tests {
    use super::{decode_base64, file_payload};
    use tauri::ipc::InvokeBody;

    /// The shape the page actually sends (base64 over JSON) has to decode to the
    /// original bytes, with the name taken from the request.
    #[test]
    fn a_json_payload_decodes_to_the_file() {
        // "hello, box" in standard base64.
        let body = InvokeBody::Json(serde_json::json!({
            "name": "Protocol_cazare.docx",
            "mime": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "data": "aGVsbG8sIGJveA=="
        }));
        let (name, bytes) = file_payload(&body).expect("the JSON payload is understood");
        assert_eq!(name, "Protocol_cazare.docx");
        assert_eq!(bytes, b"hello, box");
    }

    /// The legacy raw body still has to work: the page ships from the server, so
    /// an older page can meet a newer shell.
    #[test]
    fn the_legacy_raw_payload_still_works() {
        let name = b"old.docx";
        let mut raw = Vec::new();
        raw.extend_from_slice(&(name.len() as u32).to_le_bytes());
        raw.extend_from_slice(name);
        raw.extend_from_slice(b"bytes");
        let (got_name, bytes) = file_payload(&InvokeBody::Raw(raw)).expect("raw body understood");
        assert_eq!(got_name, "old.docx");
        assert_eq!(bytes, b"bytes");
    }

    /// A request that carries neither shape must fail loudly, not save a file of
    /// zero bytes under a made-up name.
    #[test]
    fn a_payload_without_data_is_refused() {
        let body = InvokeBody::Json(serde_json::json!({ "name": "x.docx" }));
        assert!(file_payload(&body).is_err());
        assert!(decode_base64("not base64 !!*").is_err());
    }
}

/// Register the plugin. Call from `tauri::Builder::plugin(…)`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = Builder::<R, ()>::new("box-shell");
    // Desktop (and only desktop) adds a Rust command. On Android the clipboard
    // half is Kotlin — registering a Rust handler for the same name there would
    // shadow it, so the handler is compiled out instead of branched at runtime.
    #[cfg(not(target_os = "android"))]
    let builder =
        builder.invoke_handler(tauri::generate_handler![copyFileToClipboard, saveFile]);
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
