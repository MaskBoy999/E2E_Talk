//! `call-service` — keeps a voice call alive with the screen off on Android.
//!
//! Android will happily suspend (and eventually kill) the WebView process that
//! owns the WebRTC connection once the app is backgrounded. The fix is a
//! **foreground service**: while it runs, Android keeps the process alive and
//! lets our microphone + socket keep working, and the user sees a persistent
//! "In voice call" notification they can tap to come back.
//!
//! The service and its controller are plain Kotlin (`android/src/main/java/…`)
//! because that's where the Android APIs live. This crate exists so the plugin
//! is registered with Tauri, which is what makes those Kotlin commands reachable
//! from the webview:
//!
//! ```js
//! // from static/voice.js, guarded on `window.__TAURI__`
//! await tauri.core.invoke('plugin:call-service|start', { channelName: 'Voice call' });
//! await tauri.core.invoke('plugin:call-service|stop');
//! ```
//!
//! There are deliberately **no Rust commands**: a `#[tauri::command]` written
//! here could only reach an event loop in the webview, not Android's
//! `ServiceManager`. Going straight to the Kotlin command avoids that hop, and
//! on desktop the plugin is inert — calls already survive window minimise there.
//!
//! Not supported on iOS: `UIBackgroundModes: audio` (see the master plan §A3.4)
//! is declarative, so there is nothing to invoke at runtime.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Register the plugin. Call from `tauri::Builder::plugin(…)`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("call-service").build()
}
