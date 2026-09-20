const COMMANDS: &[&str] = &["enterImmersive", "exitImmersive", "setBackHandler", "exit"];

fn main() {
    // The commands are implemented in Kotlin (`BoxShellPlugin.kt`) and called
    // from JS as `plugin:box-shell|enterImmersive` etc. Listing them here is
    // what generates `allow-enterImmersive` / `allow-exitImmersive` /
    // `allow-setBackHandler` / `allow-exit`, which `permissions/default.toml`
    // then bundles into `box-shell:default`.
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
