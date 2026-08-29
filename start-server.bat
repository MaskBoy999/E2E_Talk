@echo off
cd /d "%~dp0server"

:: Kill any existing server instance
echo Checking for existing server processes...
taskkill /f /im e2e-chat.exe >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 " ^| findstr "LISTENING" 2^>nul') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3443 " ^| findstr "LISTENING" 2^>nul') do taskkill /f /pid %%a >nul 2>&1
timeout /t 1 /nobreak >nul

:: Auto-clean debug build artifacts
if exist "target\debug" (
    echo Cleaning debug build artifacts...
    rd /s /q target\debug >nul 2>&1
)

:: Auto-clean orphaned test databases
for %%f in (*.db-*) do (
    if not "%%f"=="e2e_chat.db-shm" if not "%%f"=="e2e_chat.db-wal" del /q "%%f" >nul 2>&1
)
for %%f in (admin-bk-*.db admin-panel-*.db admin-probe-*.db admin-wipe-*.db f-test-*.db g2-probe-*.db hardening-*.db ks-rl-*.db ks-user-*.db risky-probe-*.db runtime-test-*.db vault-test-*.db chat.db) do (
    if exist "%%f" del /q "%%f" >nul 2>&1
)

echo Building server (release)...
cargo build --release
if errorlevel 1 (
    echo BUILD FAILED
    pause
    exit /b 1
)

echo.
echo   Starting E2E Chat server...
echo   HTTP:  http://localhost:3000
echo   HTTPS: https://localhost:3443
echo.

:: Start in a new window — use absolute path via %~dp0 to avoid CWD issues
start "E2E Chat Server" /d "%~dp0server" "%~dp0server\target\release\e2e-chat.exe"

timeout /t 3 /nobreak >nul
echo Server started.
