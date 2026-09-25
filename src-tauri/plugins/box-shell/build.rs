const COMMANDS: &[&str] = &[
    "enterImmersive",
    "exitImmersive",
    "setBackHandler",
    "exit",
    // Call comfort (FEATURE_PLAN.md 6.1/6.2): keep the screen on during a
    // call, and ask the system for the battery-optimization exemption.
    "keepScreenOn",
    "batteryStatus",
    "batteryRequest",
    // Call-audio routing (FEATURE_PLAN.md 1.3): list + pick the output device.
    "audioRoutes",
    "setAudioRoute",
    // Share-into-app FIFO (3.4): peek, read one file as base64, discard.
    "sharedPending",
    "sharedRead",
    "sharedDiscard",
    // On-device live captions (1.7): OFFLINE recogniser only — availability,
    // start (rejects rather than using the network recogniser), stop.
    "captionsAvailable",
    "captionsStart",
    "captionsStop",
    // Attachments (copy any file type to the OS clipboard). The WebView's own
    // clipboard API takes images and text only, so a real file has to go through
    // the shell: Windows CF_HDROP / macOS pasteboard / X11 text-uri-list in
    // Rust, ClipData + FileProvider in Kotlin. One command name for both.
    "copyFileToClipboard",
    // Saving a file to disk: the WebView drops an `<a download>` on a blob:
    // URL in every shell (desktop and Android), so a "Download"/"Save a
    // copy"/export has to be written by native code. Rust on desktop (the
    // user's Downloads dir), MediaStore in Kotlin on Android.
    "saveFile",
];

fn main() {
    // The commands are implemented in Kotlin (`BoxShellPlugin.kt`) and called
    // from JS as `plugin:box-shell|enterImmersive` etc. Listing them here is
    // what generates `allow-enterImmersive` / `allow-exitImmersive` /
    // `allow-setBackHandler` / `allow-exit`, which `permissions/default.toml`
    // then bundles into `box-shell:default`.
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
