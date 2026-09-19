# E2E Chat

An end-to-end encrypted chat app — direct messages, servers, voice/video calls and
screen share — that runs against **your own server** over Tailscale. Messages and calls
are encrypted on the client; the server never sees plaintext.

There are two ways to use it:

| | |
|---|---|
| **Desktop app (recommended)** | A native window with a tray, auto-start and native notifications — no browser required. |
| **Browser (PWA)** | Open your server's address directly. Works on phones too. |

---

## Install

Download from the **[latest release →](../../releases/latest)** (or, for a build that
isn't published yet, **Actions** → *Build Desktop Box* / *Build Android APK* →
**Run workflow** → download the artifact).

### Windows
1. Download `E2E-Chat_*_x64-setup.exe` (NSIS) or `*_x64_en-US.msi`.
2. Run it. If Windows SmartScreen warns (unsigned build): **More info → Run anyway**.
3. Launch **E2E Chat**. WebView2 is already present on Windows 10/11.

### Linux
- **AppImage** — `chmod +x E2E-Chat_*.AppImage && ./E2E-Chat_*.AppImage`
  (needs FUSE; on Ubuntu 22.04+: `sudo apt install libfuse2`).
- **Debian/Ubuntu** — `sudo apt install ./E2E-Chat_*_amd64.deb`.
- Both need `libwebkit2gtk-4.1` (installed automatically by the `.deb`).

### Android (no iOS yet)
1. Download `E2E-Chat_<version>_android.apk`
   (or `app-universal-release.apk` / `app-arm64-v8a-release.apk` for most phones)
   from the release, or the `e2e-chat-android` artifact from a manual Actions run.
2. On the phone: install the **Tailscale** app, sign in, and connect.
3. Open the APK. Android will ask to allow installs from this source — enable
   *Install unknown apps* for your browser/file manager, then install.
4. Requires **Android 10+** (minSdk 29).

### Verify your download (optional)
Each release also publishes `SHA256SUMS-<platform>.txt`. Check your file against it
and you never have to trust the download blindly:

```bash
# Linux / macOS / Git Bash on Windows
sha256sum -c SHA256SUMS-linux-x64.txt

# Windows PowerShell
Get-FileHash .\E2E-Chat_0.2.0_x64-setup.exe -Algorithm SHA256
```

### First launch (all platforms)
Enter your server's Tailscale address (for example `https://100.101.102.103:3443`),
click **Test connection**, then **Save & Launch**. Change it later from the tray
(desktop) or by re-opening the app's setup.

---

## Build from source

Prerequisites: Rust (stable), Node 18+, and — for the desktop app — the
[Tauri system dependencies](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
# Run the server (its own terminal; serves the web app on :3443)
cargo run --manifest-path server/Cargo.toml --release

# Desktop app — dev
cargo install tauri-cli --locked      # one time
cargo tauri dev

# Desktop app — installer for the current OS
cargo tauri build
```

`cargo check --manifest-path src-tauri/Cargo.toml` type-checks the desktop crate without
the Tauri CLI.

Run the end-to-end test suite (needs the server running):

```bash
npx playwright test
```

---

## Repository layout

```
server/     Rust backend (Axum + SQLite): auth, sessions, relay, encrypted storage
static/     Frontend: chat, voice, crypto, secure-storage (the app itself)
src-tauri/  Native desktop shell (Tauri 2) — see src-tauri/README.md
tests/      Playwright end-to-end suite
tools/      Small build helpers (icon generation, etc.)
```

Design docs: [`WEBSITE_IN_A_BOX_MASTER_PLAN.md`](WEBSITE_IN_A_BOX_MASTER_PLAN.md) (desktop +
mobile app plan, session persistence) and
[`VOICE_CALLS_SPEC.md`](VOICE_CALLS_SPEC.md) / [`SECURITY_FIX_PLAN.md`](SECURITY_FIX_PLAN.md).
