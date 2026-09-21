const COMMANDS: &[&str] = &[
    "start",
    "updateMedia",
    "stop",
    // Native screen capture (Android WebView has no getDisplayMedia) — see
    // android/src/main/java/com/e2echat/callservice/ScreenCapture.kt.
    "startScreenCapture",
    "stopScreenCapture",
];

fn main() {
    // The commands are implemented in Kotlin (`CallServicePlugin.kt`) and called
    // from JS as `plugin:call-service|start` / `|stop`. Listing them here is what
    // generates `allow-start` / `allow-stop`, which `permissions/default.toml`
    // then bundles into `call-service:default`.
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
