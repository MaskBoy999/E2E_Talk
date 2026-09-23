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
    // Per-channel screenshot blocking (FEATURE_PLAN.md 5.2): FLAG_SECURE.
    "setSecureMode",
];

fn main() {
    // The commands are implemented in Kotlin (`BoxShellPlugin.kt`) and called
    // from JS as `plugin:box-shell|enterImmersive` etc. Listing them here is
    // what generates `allow-enterImmersive` / `allow-exitImmersive` /
    // `allow-setBackHandler` / `allow-exit`, which `permissions/default.toml`
    // then bundles into `box-shell:default`.
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
