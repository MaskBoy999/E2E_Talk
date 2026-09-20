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

/// Register the plugin. Call from `tauri::Builder::plugin(…)`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R, ()>::new("box-shell")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            api.register_android_plugin(PLUGIN_IDENTIFIER, "BoxShellPlugin")
                // A failure here is fatal for the feature and must not look like
                // success: bubble it up so the app fails loudly at startup
                // instead of silently dropping every later invoke.
                .map_err(|e| format!("box-shell: could not register the Android plugin: {e}"))?;
            #[cfg(not(target_os = "android"))]
            let _ = &api;
            Ok(())
        })
        .build()
}
