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

//! ## The registration call is not optional
//!
//! A plugin whose commands live in Kotlin **must** register that Kotlin class
//! with `api.register_android_plugin(package, ClassName)` in its setup hook —
//! that call is what instantiates the class through JNI and gives the plugin its
//! mobile `PluginHandle` (`tauri::plugin::mobile::register_android_plugin`).
//! Without it the class is never constructed, every
//! `plugin:call-service|…` invoke fails with a not-initialized error, and the
//! foreground service simply never starts.
//!
//! This crate shipped without it, so on Android the whole feature was inert:
//! no ongoing "In call" notification, no full-screen incoming ring, and — the
//! part that was actually reported — the call losing its microphone a few
//! seconds after the screen went off, because nothing was keeping the process
//! alive or claiming background capture. The JS side swallowed the rejected
//! invoke into a `console.warn`, which is why it looked like a phone problem
//! rather than a missing line of Rust.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Package of the Kotlin half (`android/src/main/java/com/e2echat/callservice`).
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.e2echat.callservice";

/// Register the plugin. Call from `tauri::Builder::plugin(…)`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R, ()>::new("call-service")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            api.register_android_plugin(PLUGIN_IDENTIFIER, "CallServicePlugin")
                // A failure here is fatal for the feature and must not look like
                // success: bubble it up so the app fails loudly at startup
                // instead of silently dropping every later invoke.
                .map_err(|e| format!("call-service: could not register the Android plugin: {e}"))?;
            #[cfg(not(target_os = "android"))]
            let _ = &api;
            Ok(())
        })
        .build()
}
