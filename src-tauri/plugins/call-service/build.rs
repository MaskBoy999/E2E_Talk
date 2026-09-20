const COMMANDS: &[&str] = &["start", "updateMedia", "stop"];

fn main() {
    // The commands are implemented in Kotlin (`CallServicePlugin.kt`) and called
    // from JS as `plugin:call-service|start` / `|stop`. Listing them here is what
    // generates `allow-start` / `allow-stop`, which `permissions/default.toml`
    // then bundles into `call-service:default`.
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
