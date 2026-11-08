@echo off
rem Kill old server -> rebuild -> restart.
setlocal
cd /d "%~dp0server"

rem Build output lives at the REPO ROOT (.cargo\config.toml), not server\target.
set "CARGO_TARGET_DIR=%~dp0.cache\e2e-target"

rem Kill existing server
rem NOTE: `echo ==>` is a redirect in cmd.exe — it writes the rest of the line to
rem a file named after the next word (this is how stray "Building", "Cleaning",
rem "Starting" and "Stopping" files ended up committed). Always `^>` the angle
rem bracket, or use plain messages.
echo ==^> Stopping old e2e-chat server...
taskkill /f /im e2e-chat.exe >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 " ^| findstr "LISTENING" 2^>nul') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3443 " ^| findstr "LISTENING" 2^>nul') do taskkill /f /pid %%a >nul 2>&1
timeout /t 1 /nobreak >nul

rem Auto-clean debug build artifacts
if exist "%CARGO_TARGET_DIR%\debug" (
    echo ==^> Cleaning debug build artifacts...
    rd /s /q "%CARGO_TARGET_DIR%\debug" >nul 2>&1
)

rem Auto-clean orphaned test databases
echo ==^> Cleaning orphaned test databases...
for %%f in (*.db-*) do (
    if not "%%f"=="e2e_chat.db-shm" if not "%%f"=="e2e_chat.db-wal" del /q "%%f" >nul 2>&1
)
for %%f in (admin-bk-*.db admin-panel-*.db admin-probe-*.db admin-wipe-*.db f-test-*.db g2-probe-*.db hardening-*.db ks-rl-*.db ks-user-*.db risky-probe-*.db runtime-test-*.db vault-test-*.db chat.db) do (
    if exist "%%f" del /q "%%f" >nul 2>&1
)

echo ==^> Building server (release)...
rem Incremental on purpose: a restart should not recompile the world. A corrupt
rem staging is what the opt-level=0 retry below is for.
cargo build --release
if errorlevel 1 (
    echo ==^> First build failed - retrying from a clean directory with opt-level=0...
    set "RUSTFLAGS=-C opt-level=0"
    set "CARGO_TARGET_DIR=%~dp0.cache\e2e-target-retry"
    cargo build --release
    if errorlevel 1 (
        echo BUILD FAILED
        pause
        exit /b 1
    )
    if not exist "%~dp0.cache\e2e-target\release" mkdir "%~dp0.cache\e2e-target\release"
    copy /y "%~dp0.cache\e2e-target-retry\release\e2e-chat.exe" "%~dp0.cache\e2e-target\release\e2e-chat.exe" >nul
    set "CARGO_TARGET_DIR=%~dp0.cache\e2e-target"
)

echo ==^> Starting server...
echo     HTTP:  http://localhost:3000
echo     HTTPS: https://localhost:3443

rem Use an absolute path via %~dp0 to avoid CWD issues
start "E2E Chat Server" /d "%~dp0server" "%CARGO_TARGET_DIR%\release\e2e-chat.exe"

timeout /t 3 /nobreak >nul
echo.
echo Server started.
