# Tauri 2.0 Integration Plan — E2E Chat Desktop/Mobile App

Written 2026-09-18. This plan covers converting the E2E Chat web application into a
native desktop and mobile app using Tauri 2.0. The existing Rust server (`server/`) and
frontend (`static/`) remain **unchanged** — Tauri wraps them in a native window.

---

## 0. TL;DR

| # | Component | What to build | Effort |
|---|---|---|---|
| 1 | Scaffold Tauri project | `src-tauri/` with Cargo.toml, tauri.conf.json, lib.rs | 0.5 day |
| 2 | Config file + setup window | Server IP storage, first-launch setup screen | 1 day |
| 3 | System tray + auto-start | Tray icon, menu, minimize-to-tray, auto-start | 0.5 day |
| 4 | Native notifications | OS-level notifications via tauri-plugin-notification | 0.5 day |
| 5 | GitHub Actions workflow | CI to build installers for all platforms | 1 day |
| 6 | Android setup + APK | Android SDK, foreground service for background calls | 1.5 days |
| 7 | iOS setup + IPA | Xcode, audio background mode, ReplayKit screen capture | 2.5 days |
| 8 | Server push notifications | FCM/APNs integration, device token storage | 1 day |
| 9 | Testing on all platforms | Desktop + mobile verification | 2 days |
| | **Total** | | **~10 days** |

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    USER'S DEVICE                     │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │           Tauri App (Rust binary)             │  │
│  │           ~5-10 MB installer                  │  │
│  │                                               │  │
│  │  ┌─────────────────────────────────────────┐  │  │
│  │  │         Native Window (OS chrome)       │  │  │
│  │  │  ┌───────────────────────────────────┐  │  │  │
│  │  │  │         WebView                   │  │  │  │
│  │  │  │  ┌─────────────────────────────┐  │  │  │  │
│  │  │  │  │   Your existing /static     │  │  │  │  │
│  │  │  │  │   (index.html, chat.js,     │  │  │  │  │
│  │  │  │  │    voice.js, style.css,     │  │  │  │  │
│  │  │  │  │    icons.svg, etc.)         │  │  │  │  │
│  │  │  │  └─────────────────────────────┘  │  │  │  │
│  │  │  │                                   │  │  │  │
│  │  │  │  Connects to:                     │  │  │  │
│  │  │  │  https://100.x.x.x:3443          │  │  │  │
│  │  │  │  (your Rust server via Tailscale) │  │  │  │
│  │  │  └───────────────────────────────────┘  │  │  │
│  │  └─────────────────────────────────────────┘  │  │
│  │                                               │  │
│  │  Native features (Rust):                      │  │
│  │  ├── System tray icon + menu                  │  │
│  │  ├── Auto-start on boot                       │  │
│  │  ├── Local notifications (OS-level)           │  │
│  │  ├── Config file (server IP stored locally)   │  │
│  │  ├── Window management (minimize to tray)     │  │
│  │  ├── Background audio (calls with screen off) │  │
│  │  └── Screen capture API (mobile screenshare)  │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │        Your Rust Server (separate process)    │  │
│  │        Runs on Tailscale: 100.x.x.x:3443     │  │
│  │        (unchanged, same binary as before)     │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

**Key insight:** The Tauri app and the server are **separate things**. The server runs on
your machine (or wherever you host it). The Tauri app is just a native wrapper that points
at the server's URL.

---

## 2. Prerequisites

### Development Machine
- **Rust** (via rustup): `rustup update stable`
- **Node.js** 18+: for frontend build tooling
- **Tauri CLI**: `cargo install tauri-cli --locked`
- **Platform-specific:**
  - **Windows:** Microsoft C++ Build Tools + WebView2 (pre-installed on Win 10/11)
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`)
  - **Linux:** `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf`
  - **Android:** Android SDK + NDK, Java JDK 17
  - **iOS:** Xcode 15+, Apple Developer account

### Verify Installation
```bash
cargo tauri --version    # Should print 2.x.x
rustc --version          # Should print 1.77+
node --version           # Should print 18+
```

---

## 3. Phase 1: Scaffold the Tauri Project (Day 1)

### 3.1 Project Structure

The Tauri project lives alongside the existing `server/` and `static/` directories:

```
E2E_Talk/
├── server/               # Existing Rust server (unchanged)
├── static/               # Existing frontend (unchanged)
├── src-tauri/            # NEW: Tauri app
│   ├── Cargo.toml        # Rust dependencies
│   ├── tauri.conf.json   # App configuration
│   ├── build.rs          # Tauri build script
│   ├── icons/            # App icons (PNG, ICO, ICNS)
│   │   ├── icon.png
│   │   ├── icon.ico
│   │   └── icon.icns
│   ├── capabilities/     # Permission definitions
│   │   └── default.json
│   └── src/
│       ├── main.rs       # Entry point
│       └── lib.rs        # Commands + config logic
├── package.json          # Optional: for JS plugin bindings
└── Cargo.toml            # Workspace root (optional)
```

### 3.2 Initialize Tauri

```bash
# From the project root (E2E_Talk/)
cargo tauri init

# When prompted:
#   Window title: E2E Chat
#   Frontend dev server: (leave empty — we serve static files directly)
#   Frontend dist directory: ../static
#   Development URL: https://localhost:3443
```

This creates `src-tauri/` with the basic structure.

### 3.3 src-tauri/Cargo.toml

```toml
[package]
name = "e2e-chat-app"
version = "0.2.0"
description = "E2E Chat — Encrypted desktop and mobile app"
authors = ["E2E Chat"]
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-notification = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
```

### 3.4 src-tauri/build.rs

```rust
fn main() {
    tauri_build::build()
}
```

### 3.5 src-tauri/tauri.conf.json

```json
{
  "$schema": "https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-config-schema/schema.json",
  "productName": "E2E Chat",
  "version": "0.2.0",
  "identifier": "com.e2echat.app",
  "build": {
    "frontendDist": "../static",
    "devUrl": "https://localhost:3443",
    "beforeDevCommand": "",
    "beforeBuildCommand": ""
  },
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "E2E Chat",
        "width": 1200,
        "height": 800,
        "minWidth": 400,
        "minHeight": 300,
        "center": true,
        "resizable": true,
        "decorations": true,
        "transparent": false,
        "visible": false
      }
    ],
    "security": {
      "csp": "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: https:; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; object-src 'none'; frame-src 'none'"
    }
  },
  "bundle": {
    "active": true,
    "icon": [
      "icons/icon.png",
      "icons/icon.ico",
      "icons/icon.icns"
    ],
    "windows": {
      "nsis": {
        "displayLanguageSelector": true
      }
    },
    "linux": {
      "deb": {
        "depends": ["libwebkit2gtk-4.1-0"]
      }
    },
    "macOS": {
      "minimumSystemVersion": "10.15"
    }
  },
  "plugins": {
    "notification": {}
  }
}
```

### 3.6 src-tauri/src/lib.rs

```rust
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::Manager;

/// Persistent configuration stored at:
///   Windows: %APPDATA%/com.e2echat.app/config.json
///   macOS:   ~/Library/Application Support/com.e2echat.app/config.json
///   Linux:   ~/.config/com.e2echat.app/config.json
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub server_url: String,
    pub auto_start: bool,
    pub minimize_to_tray: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            server_url: String::new(),
            auto_start: false,
            minimize_to_tray: true,
        }
    }
}

struct AppState {
    config: Mutex<AppConfig>,
}

#[tauri::command]
fn get_config(state: tauri::State<AppState>) -> AppConfig {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
fn save_config(state: tauri::State<AppState>, config: AppConfig) -> Result<(), String> {
    *state.config.lock().unwrap() = config.clone();
    // Persist to disk
    let config_dir = dirs::config_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join(".config")))
        .ok_or("Cannot find config directory")?;
    let app_dir = config_dir.join("com.e2echat.app");
    std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    let config_path = app_dir.join("config.json");
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn test_connection(url: String) -> Result<String, String> {
    // Simple HTTPS check — try to fetch the URL and return status
    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    rt.block_on(async {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .danger_accept_invalid_certs(true) // Tailscale uses self-signed certs
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
        if resp.status().is_success() || resp.status().as_u16() == 301 || resp.status().as_u16() == 302 {
            Ok(format!("Connected to {}", url))
        } else {
            Err(format!("Server returned status {}", resp.status()))
        }
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load config from disk
    let config = load_config_from_disk();

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            config: Mutex::new(config),
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            test_connection,
        ])
        .setup(|app| {
            // Set up system tray
            use tauri::{
                menu::{Menu, MenuItem},
                tray::TrayIconBuilder,
            };

            let show_i = MenuItem::with_id(app, "show", "Show E2E Chat", true, None::<&str>)?;
            let change_server_i = MenuItem::with_id(app, "change_server", "Change Server Address...", true, None::<&str>)?;
            let auto_start_i = MenuItem::with_id(app, "auto_start", "Start on Startup", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &change_server_i, &tauri::menu::PredefinedMenuItem::separator(app)?, &auto_start_i, &tauri::menu::PredefinedMenuItem::separator(app)?, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "change_server" => {
                        // Emit event to frontend to show setup screen
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("show-setup", ());
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Show the main window once loaded
            if let Some(window) = app.get_webview_window("main") {
                window.show()?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn load_config_from_disk() -> AppConfig {
    let config_dir = dirs::config_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join(".config")))
        .unwrap_or_default();
    let config_path = config_dir.join("com.e2echat.app").join("config.json");
    if let Ok(data) = std::fs::read_to_string(&config_path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        AppConfig::default()
    }
}
```

### 3.7 src-tauri/src/main.rs

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    e2e_chat_app::run()
}
```

### 3.8 Capabilities (Permissions)

Create `src-tauri/capabilities/default.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/nicegram/nicegram-tauri/refs/heads/main/capabilities-schema.json",
  "identifier": "default",
  "description": "Default capabilities for E2E Chat",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "notification:default",
    "notification:allow-send-notification",
    "notification:allow-is-permission-granted",
    "notification:allow-request-permission"
  ]
}
```

### 3.9 Verify Scaffold

```bash
cd E2E_Talk
cargo tauri dev
# Should open a native window loading https://localhost:3443
```

---

## 4. Phase 2: Config File + Setup Window (Days 2-3)

### 4.1 Config Storage

The config file is stored at:
- **Windows:** `%APPDATA%/com.e2echat.app/config.json`
- **macOS:** `~/Library/Application Support/com.e2echat.app/config.json`
- **Linux:** `~/.config/com.e2echat.app/config.json`

```json
{
  "server_url": "https://100.64.0.1:3443",
  "auto_start": true,
  "minimize_to_tray": true
}
```

### 4.2 Setup Screen (Frontend)

Create `static/setup.html` — shown on first launch when no `server_url` is configured:

```html
<!DOCTYPE html>
<html>
<head>
    <title>E2E Chat — Setup</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <div class="setup-container">
        <h1>E2E Chat — Setup</h1>
        <p>Enter your server's Tailscale address.</p>
        <input type="text" id="server-url" placeholder="https://100.64.0.1:3443">
        <button id="test-btn">Test Connection</button>
        <div id="status"></div>
        <label><input type="checkbox" id="auto-start"> Start on system startup</label>
        <label><input type="checkbox" id="minimize-tray" checked> Minimize to tray on close</label>
        <button id="save-btn">Save & Launch</button>
    </div>
    <script>
        // Use window.__TAURI__ to call Rust commands
        document.getElementById('test-btn').onclick = async () => {
            const url = document.getElementById('server-url').value;
            const status = document.getElementById('status');
            try {
                const result = await window.__TAURI__.core.invoke('test_connection', { url });
                status.textContent = '✓ ' + result;
                status.style.color = 'green';
            } catch (e) {
                status.textContent = '✗ ' + e;
                status.style.color = 'red';
            }
        };
        document.getElementById('save-btn').onclick = async () => {
            const config = {
                server_url: document.getElementById('server-url').value,
                auto_start: document.getElementById('auto-start').checked,
                minimize_to_tray: document.getElementById('minimize-tray').checked,
            };
            await window.__TAURI__.core.invoke('save_config', { config });
            window.location.href = '/index.html';
        };
    </script>
</body>
</html>
```

### 4.3 Routing Logic

In `lib.rs`, the `setup` handler checks if `server_url` is empty. If so, load
`setup.html` instead of `index.html`. The Tauri window's `url` field can be set
dynamically:

```rust
// In setup:
if config.server_url.is_empty() {
    window.navigate("setup.html".parse().unwrap());
} else {
    window.navigate(config.server_url.parse().unwrap());
}
```

---

## 5. Phase 3: System Tray + Auto-Start (Day 4)

### 5.1 System Tray

Already implemented in Phase 1 (§3.6). The tray menu provides:
- **Show E2E Chat** — unminimize and focus the window
- **Change Server Address...** — reopen the setup screen
- **Start on Startup** — toggle auto-start
- **Quit** — exit the app

### 5.2 Minimize to Tray

Override the window close event to minimize instead of quit:

```rust
// In lib.rs setup:
if let Some(window) = app.get_webview_window("main") {
    let window_clone = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // Prevent close, minimize to tray instead
            api.prevent_close();
            let _ = window_clone.hide();
        }
    });
}
```

### 5.3 Auto-Start

Use `tauri-plugin-autostart` or a platform-specific approach:

```toml
# Cargo.toml
tauri-plugin-autostart = "2"
```

```rust
// In lib.rs:
.plugin(tauri_plugin_autostart::init(
    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
    Some(vec!["--autostart"]),
))
```

Toggle from the tray menu:
```rust
"auto_start" => {
    let state = app.state::<AppState>();
    let mut config = state.config.lock().unwrap();
    config.auto_start = !config.auto_start;
    // Toggle autostart plugin
}
```

---

## 6. Phase 4: Native Notifications (Day 4)

### 6.1 Plugin Setup

Already added in Phase 1 (`tauri-plugin-notification`).

### 6.2 Desktop Notifications

On desktop, the Tauri app must be running (in system tray). Notifications are
local OS-level banners:

```javascript
// In chat.js — when a new message arrives:
if (window.__TAURI__) {
    window.__TAURI__.core.invoke('plugin:notification|send_notification', {
        title: senderName,
        body: messagePreview,
    });
}
```

### 6.3 Mobile Push Notifications (Server-Side)

For Android/iOS, the server sends push notifications via FCM/APNs. This requires:

1. **New database table:**
```sql
CREATE TABLE push_devices (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,  -- 'android', 'ios', 'desktop'
    token TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, token)
);
```

2. **New server endpoints:**
```
POST /api/push/register    — store device token
POST /api/push/unregister  — remove device token
```

3. **Push sending logic** (~100 lines of Rust):
```rust
// server/src/push.rs
pub async fn send_push(token: &str, platform: &str, payload: PushPayload) -> Result<(), String> {
    match platform {
        "android" => send_fcm(token, payload).await,
        "ios" => send_apns(token, payload).await,
        _ => Err("unsupported platform".into()),
    }
}
```

---

## 7. Phase 5: GitHub Actions Workflow (Day 5)

### 7.1 Release Workflow

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags: ['v*']

jobs:
  build:
    strategy:
      matrix:
        include:
          - platform: windows-latest
            target: x86_64-pc-windows-msvc
          - platform: ubuntu-22.04
            target: x86_64-unknown-linux-gnu
          - platform: macos-latest
            target: x86_64-apple-darwin
          - platform: macos-latest
            target: aarch64-apple-darwin

    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}
      - name: Install Tauri CLI
        run: cargo install tauri-cli --locked
      - name: Install dependencies (Linux)
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
      - name: Build
        run: cargo tauri build --target ${{ matrix.target }}
      - name: Upload to GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: |
            src-tauri/target/${{ matrix.target }}/release/bundle/**/*
```

### 7.2 Result

When you push a tag like `v0.2.0`, installers appear automatically:
```
GitHub Release: v0.2.0
├── E2E-Chat_0.2.0_x64-setup.exe      (Windows)
├── E2E-Chat_0.2.0_amd64.deb          (Debian/Ubuntu)
├── E2E-Chat_0.2.0_amd64.AppImage     (Linux universal)
├── E2E-Chat_0.2.0_x64.dmg            (macOS Intel)
└── E2E-Chat_0.2.0_aarch64.dmg        (macOS Apple Silicon)
```

---

## 8. Phase 6: Android (Days 6-7)

### 8.1 Initialize Android

```bash
# Prerequisites: Android SDK + NDK, Java JDK 17
cargo tauri android init
```

This creates `src-tauri/gen/android/` with the Android project structure.

### 8.2 AndroidManifest.xml Additions

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_CALL" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

### 8.3 Foreground Service for Background Calls

Create `src-tauri/gen/android/app/src/main/java/com/e2echat/app/CallForegroundService.kt`:

```kotlin
class CallForegroundService : Service() {
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = NotificationCompat.Builder(this, "call_channel")
            .setContentTitle("E2E Chat")
            .setContentText("In voice call")
            .setSmallIcon(R.drawable.ic_call)
            .setOngoing(true)
            .build()
        startForeground(1, notification)
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
```

### 8.4 Build APK

```bash
cargo tauri android build --target aarch64
# Output: app-arm64-v8a-release.apk
```

### 8.5 Android-Specific Features
- Push notifications via FCM (Firebase Cloud Messaging)
- Background WebSocket (app stays connected when minimized)
- **Foreground service for calls with screen off** (persistent notification)
- **Screen share via `getDisplayMedia()`** (Android 10+ WebView supports natively)
- Works with Tailscale Android app

---

## 9. Phase 7: iOS (Days 8-10)

### 9.1 Initialize iOS

```bash
# Prerequisites: Xcode 15+, Apple Developer account
cargo tauri ios init
```

### 9.2 Info.plist Additions

```xml
<key>UIBackgroundModes</key>
<array>
    <string>audio</string>
</array>
```

### 9.3 Audio Background Mode for Calls

iOS keeps the WebRTC connection alive when the screen is off via the audio
background mode. The app shows in the app switcher with a "return to call" indicator.

### 9.4 ReplayKit Screen Capture

iOS WKWebView doesn't support `getDisplayMedia()`. Use Tauri's screen capture
plugin or a custom ReplayKit integration:

```toml
# Cargo.toml (iOS-specific)
[dependencies]
# tauri-plugin-screen-capture = "2"  # or custom implementation
```

```rust
#[tauri::command]
async fn start_screen_capture(app: AppHandle) -> Result<String, String> {
    #[cfg(target_os = "ios")]
    {
        // Start ReplayKit broadcast
        Ok("ios_screen_stream".to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        Ok("use_getDisplayMedia".to_string())
    }
}
```

### 9.5 Build IPA

```bash
cargo tauri ios build --target aarch64-apple-ios
# Output: .ipa file — sideloadable via AltStore or TestFlight
```

### 9.6 iOS Limitations
- Screen share requires user to start a "Broadcast" (system picker)
- Background call limited to ~30 seconds without foreground service (but audio mode keeps it alive)
- App may be killed by iOS after ~7 days of no foreground use
- No system tray (iOS doesn't have one)

---

## 10. Platform Comparison

| Feature | Windows | Linux | macOS | Android | iOS |
|---------|---------|-------|-------|---------|-----|
| Installer | `.msi` / `.exe` | `.deb` / `.AppImage` | `.dmg` | `.apk` (sideload) | `.ipa` (AltStore/TestFlight) |
| System tray | ✅ | ✅ | ✅ (menu bar) | ❌ | ❌ |
| Auto-start | ✅ | ✅ | ✅ | ✅ (background service) | ❌ |
| Local notifications | ✅ WinRT | ✅ libnotify | ✅ NotificationCenter | ❌ (use FCM) | ❌ (use APNs) |
| Push notifications | ❌ (local only) | ❌ (local only) | ❌ (local only) | ✅ FCM | ✅ APNs |
| Background calls | ✅ (tray) | ✅ (tray) | ✅ (tray) | ✅ foreground service | ✅ audio background mode |
| Screen share | ✅ getDisplayMedia | ✅ getDisplayMedia | ✅ getDisplayMedia | ✅ getDisplayMedia (10+) | ✅ ReplayKit |
| Bundle size | ~5-8 MB | ~5-10 MB | ~8-12 MB | ~10-15 MB | ~12-18 MB |
| Tailscale | ✅ | ✅ | ✅ | ✅ (Tailscale app) | ✅ (Tailscale app) |

---

## 11. File Summary

| File | Status | Purpose |
|------|--------|---------|
| `server/` | **No changes** | Your existing backend |
| `static/` | **No changes** | Your existing frontend |
| `src-tauri/Cargo.toml` | **New** | Tauri dependencies |
| `src-tauri/tauri.conf.json` | **New** | App configuration |
| `src-tauri/src/main.rs` | **New** | Tauri entry point (~5 lines) |
| `src-tauri/src/lib.rs` | **New** | Commands + config + tray (~150 lines) |
| `src-tauri/capabilities/default.json` | **New** | Permission definitions |
| `src-tauri/icons/` | **New** | App icons (PNG, ICO, ICNS) |
| `.github/workflows/release.yml` | **New** | CI to build installers |
| `static/setup.html` | **New** | First-launch setup screen |
| `server/src/push.rs` | **New** | Push notification sending (~100 lines) |
| `server/migrations/0XX_push_devices.sql` | **New** | Device token storage |
| `src-tauri/gen/android/` | **New** | Android project + foreground service |
| `src-tauri/gen/ios/` | **New** | iOS project + audio background mode |

---

## 12. Mobile-Specific Behaviors

| Scenario | Android | iOS |
|----------|---------|-----|
| **Screen off during call** | Foreground service keeps WebRTC alive. Persistent notification "In voice call". Audio through earpiece/speaker. | Audio background mode keeps WebRTC alive. App shows in app switcher with "return to call". |
| **Screen share** | System picker shows "Share entire screen" or "Share single app". Works natively via getDisplayMedia(). | System broadcast picker (ReplayKit). Tauri plugin captures frames → feeds to canvas relay pipeline. |
| **App killed during call** | Foreground service prevents killing. If somehow killed, call drops (same as desktop). | iOS may kill after ~7 days. Foreground notification helps prevent this. |
| **Background mic** | Foreground service allows mic access in background. | Audio background mode allows mic access in background. |
| **Notification when app closed** | FCM push wakes app. Full-screen incoming call UI. | APNs push wakes app. Full-screen incoming call UI. |

---

## 13. What Users Download

**GitHub Releases page:**

```
Release v0.2.0 — Latest

Assets:
  E2E-Chat-0.2.0-x64-Setup.exe       6.2 MB   Windows
  E2E-Chat-0.2.0-amd64.deb           5.8 MB   Debian/Ubuntu
  E2E-Chat-0.2.0-x86_64.AppImage     8.1 MB   Linux (universal)
  E2E-Chat-0.2.0-x64.dmg            10.3 MB   macOS (Intel)
  E2E-Chat-0.2.0-arm64.dmg            9.8 MB   macOS (Apple Silicon)
  E2E-Chat-0.2.0-arm64.apk           12.4 MB   Android (sideload)
  E2E-Chat-0.2.0-arm64.ipa           14.1 MB   iOS (AltStore/TestFlight)
```

User downloads the right file, runs it, enters their Tailscale IP, and they
have a native app.

---

## 14. Effort Estimate

| Task | Time |
|------|------|
| Scaffold Tauri project | 0.5 day |
| Config file + setup window | 1 day |
| System tray + auto-start | 0.5 day |
| GitHub Actions workflow | 1 day |
| Android setup + APK build | 1-2 days |
| Android: foreground service for background calls | 1 day |
| Android: screen share verification | 0.5 day |
| iOS setup + IPA build | 2-3 days |
| iOS: audio background mode for calls | 0.5 day |
| iOS: ReplayKit screen capture plugin | 2 days |
| Server push notification endpoint | 1 day |
| Testing on all platforms | 2-3 days |
| **Total** | **~10-14 days** |

---

## 15. Commands Cheat Sheet

```bash
# Install Tauri CLI (one-time)
cargo install tauri-cli --locked

# Development mode (opens WebView with hot-reload)
cargo tauri dev

# Build for current platform
cargo tauri build

# Build for specific targets
cargo tauri build --target x86_64-pc-windows-msvc    # Windows
cargo tauri build --target x86_64-unknown-linux-gnu   # Linux
cargo tauri build --target x86_64-apple-darwin         # macOS Intel
cargo tauri build --target aarch64-apple-darwin        # macOS Apple Silicon

# Android
cargo tauri android init                               # One-time setup
cargo tauri android build --target aarch64             # Build APK

# iOS
cargo tauri ios init                                   # One-time setup
cargo tauri ios build --target aarch64-apple-ios       # Build IPA

# JS syntax check
cd static && node --check chat.js && node --check roles.js

# Rust typecheck
cd server && cargo check
```
