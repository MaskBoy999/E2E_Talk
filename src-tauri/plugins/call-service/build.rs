const COMMANDS: &[&str] = &[
    "start",
    "updateMedia",
    "stop",
    // Native screen capture (Android WebView has no getDisplayMedia) — see
    // android/src/main/java/com/e2echat/callservice/ScreenCapture.kt.
    "startScreenCapture",
    "stopScreenCapture",
    // Native picture-in-picture (the Android WebView has no PiP API) — see
    // android/src/main/java/com/e2echat/callservice/Pip.kt.
    "enterPip",
    "pipState",
    "exitPip",
    // The phone's ringer mode + do-not-disturb state, so the page can stop its
    // own WebAudio ringtone on a muted phone — see AudioProfile.kt.
    "getAudioProfile",
];

fn main() {
    // The commands are implemented in Kotlin (`CallServicePlugin.kt`) and called
    // from JS as `plugin:call-service|start` / `|stop`. Listing them here is what
    // generates `allow-start` / `allow-stop`, which `permissions/default.toml`
    // then bundles into `call-service:default`.
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
