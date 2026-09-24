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
];

fn main() {
    // The commands are implemented in Kotlin (`BoxShellPlugin.kt`) and called
    // from JS as `plugin:box-shell|enterImmersive` etc. Listing them here is
    // what generates `allow-enterImmersive` / `allow-exitImmersive` /
    // `allow-setBackHandler` / `allow-exit`, which `permissions/default.toml`
    // then bundles into `box-shell:default`.
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
