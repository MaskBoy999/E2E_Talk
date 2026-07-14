# Distribution & Setup Guide

## Quick Start (Development)

### Prerequisites
- **Rust** (latest stable) — https://rustup.rs
- **Node.js** (v18+) — for Playwright tests only
- **mkcert** (optional) — for trusted local HTTPS certificates

### Setup
```bash
git clone https://github.com/MaskBoy999/E2E_Talk.git
cd E2E_Talk
```

### Start Server
**Windows:**
```cmd
start-server.bat
```
**Linux/macOS:**
```bash
chmod +x start-server.sh
./start-server.sh
```

Server starts on:
- HTTP: `http://localhost:3000`
- HTTPS: `https://localhost:3443` (auto-generated self-signed cert)

### Reset Database
**Windows:**
```cmd
reset-db.bat
```
**Linux/macOS:**
```bash
chmod +x reset-db.sh
./reset-db.sh
```

---

## HTTPS / TLS

The server auto-generates self-signed TLS certificates on first start (saved to `server/certs/`). Chrome will show "Not Secure" for self-signed certs.

### Trusted HTTPS with mkcert
```bash
# Install mkcert (https://github.com/FiloSottile/mkcert)
mkcert -install              # Install local CA
mkcert localhost 127.0.0.1 ::1  # Generate trusted cert

# Set env vars before starting server
set TLS_CERT_PATH=localhost+1.pem
set TLS_KEY_PATH=localhost+1-key.pem
```

---

## Building Distributable Packages

### Windows Installer (NSIS)

**Requirements:** [NSIS](https://nsis.sourceforge.io/) or [Inno Setup](https://jrsoftware.org/isinfo.php)

**Steps:**
1. Build the release binary:
   ```cmd
   cd server
   cargo build --release
   ```
   Binary: `server/target/release/e2e-chat.exe`

2. Create an NSIS installer script (`installer.nsi`):
   ```nsis
   Name "E2E Chat"
   OutFile "E2E-Chat-Setup.exe"
   InstallDir "$LOCALAPPDATA\E2E-Chat"
   
   Section
       SetOutPath $INSTDIR
       File "server\target\release\e2e-chat.exe"
       File /r "static"
       File /r "migrations"
       File "start-server.bat"
       File "reset-db.bat"
       
       CreateShortCut "$DESKTOP\E2E Chat.lnk" "$INSTDIR\start-server.bat"
       CreateDirectory "$SMPROGRAMS\E2E Chat"
       CreateShortCut "$SMPROGRAMS\E2E Chat\Start Server.lnk" "$INSTDIR\start-server.bat"
       CreateShortCut "$SMPROGRAMS\E2E Chat\Reset Database.lnk" "$INSTDIR\reset-db.bat"
       CreateShortCut "$SMPROGRAMS\E2E Chat\Uninstall.lnk" "$INSTDIR\uninstall.exe"
       
       WriteUninstaller "$INSTDIR\uninstall.exe"
   SectionEnd
   
   Section "Uninstall"
       Delete "$INSTDIR\e2e-chat.exe"
       Delete "$INSTDIR\*.*"
       RMDir /r "$INSTDIR\static"
       RMDir /r "$INSTDIR\migrations"
       RMDir "$INSTDIR"
       Delete "$DESKTOP\E2E Chat.lnk"
       RMDir /r "$SMPROGRAMS\E2E Chat"
   SectionEnd
   ```

3. Compile with `makensis installer.nsi`

### Linux Package (tar.gz)

**Steps:**
1. Build for Linux:
   ```bash
   cd server
   cargo build --release
   ```

2. Create package structure:
   ```bash
   mkdir -p e2e-chat/{static,migrations}
   cp server/target/release/e2e-chat e2e-chat/
   cp -r static/* e2e-chat/static/
   cp migrations/*.sql e2e-chat/migrations/
   cp start-server.sh e2e-chat/
   cp reset-db.sh e2e-chat/
   chmod +x e2e-chat/e2e-chat e2e-chat/start-server.sh e2e-chat/reset-db.sh
   tar -czf e2e-chat-linux-x64.tar.gz e2e-chat/
   ```

3. Users extract and run:
   ```bash
   tar -xzf e2e-chat-linux-x64.tar.gz
   cd e2e-chat
   ./start-server.sh
   ```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `JWT_SECRET` | auto-generated (persisted to `.env`) | JWT signing secret |
| `DATABASE_URL` | `e2e_chat.db` | SQLite database path |
| `TLS_CERT_PATH` | auto-generated | Path to TLS certificate PEM |
| `TLS_KEY_PATH` | auto-generated | Path to TLS private key PEM |

---

## Dependencies

### Server (Rust)
All dependencies are managed by Cargo and bundled in the binary:
- `axum` — HTTP framework
- `axum-server` — TLS support (rustls)
- `tokio` — Async runtime
- `rusqlite` — SQLite (bundled)
- `argon2` — Password hashing
- `jsonwebtoken` — JWT auth
- `sha2` — SHA-256 hashing
- `rcgen` — Self-signed cert generation
- `base64`, `rand`, `serde`, `uuid`, `chrono`

### Client (JavaScript)
Zero external runtime dependencies. All crypto is implemented from scratch in `static/crypto.js`:
- X25519 (ECDH)
- HKDF-SHA-256
- XChaCha20-Poly1305
- SHA-256

### Test Dependencies (development only)
```bash
npm install
npx playwright install chromium
```
