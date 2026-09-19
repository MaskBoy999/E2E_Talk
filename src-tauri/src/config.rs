//! Box configuration: which server to connect to and the window preferences.
//!
//! Stored as JSON under the OS per-app config directory:
//!   Windows: %APPDATA%/com.e2echat.app/config.json
//!   Linux:   ~/.config/com.e2echat.app/config.json

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Config {
    /// The host's Tailscale address, e.g. `https://100.101.102.103:3443`.
    pub server_url: Option<String>,
    /// Start the app when the user logs in.
    pub auto_start: bool,
    /// Closing the window hides it to the tray instead of quitting.
    pub minimize_to_tray: bool,
    /// TOFU: SHA-256 of the host's leaf certificate (DER, hex), captured on the
    /// first successful "Save & Launch" and checked on every launch after.
    /// The server uses a self-signed cert, so pinning the fingerprint is what
    /// lets us reject a swapped/MITM certificate instead of trusting anything.
    pub pinned_cert_sha256: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            server_url: None,
            auto_start: false,
            minimize_to_tray: true,
            pinned_cert_sha256: None,
        }
    }
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

/// Load the config, falling back to defaults when it is missing or malformed.
pub fn load(app: &tauri::AppHandle) -> Config {
    config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Persist the config as pretty JSON.
pub fn save(app: &tauri::AppHandle, cfg: &Config) -> Result<(), String> {
    let path = config_path(app)?;
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}
