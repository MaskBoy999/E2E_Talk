@echo off
rem Start the E2E Chat server.
rem Builds the release binary if it is missing, then launches it in its own window.
setlocal
cd /d "%~dp0server"

rem The build output lives at the REPO ROOT (.cargo\config.toml sets
rem build.target-dir = .cache/e2e-target), so server\target\release\e2e-chat.exe
rem is never produced. Name the directory explicitly and launch from it.
set "CARGO_TARGET_DIR=%~dp0.cache\e2e-target"

rem Kill any existing server instance
echo Checking for existing server processes...
taskkill /f /im e2e-chat.exe >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 " ^| findstr "LISTENING" 2^>nul') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3443 " ^| findstr "LISTENING" 2^>nul') do taskkill /f /pid %%a >nul 2>&1
timeout /t 1 /nobreak >nul

rem Auto-clean debug build artifacts
if exist "%CARGO_TARGET_DIR%\debug" (
    echo Cleaning debug build artifacts...
    rd /s /q "%CARGO_TARGET_DIR%\debug" >nul 2>&1
)

rem Auto-clean orphaned test databases
for %%f in (*.db-*) do (
    if not "%%f"=="e2e_chat.db-shm" if not "%%f"=="e2e_chat.db-wal" del /q "%%f" >nul 2>&1
)
for %%f in (admin-bk-*.db admin-panel-*.db admin-probe-*.db admin-wipe-*.db f-test-*.db g2-probe-*.db hardening-*.db ks-rl-*.db ks-user-*.db risky-probe-*.db runtime-test-*.db vault-test-*.db chat.db) do (
    if exist "%%f" del /q "%%f" >nul 2>&1
)

if not exist "%CARGO_TARGET_DIR%\release\e2e-chat.exe" (
    echo Building server (release)...
    cargo build --release
    if errorlevel 1 (
        rem The first failure may be a rustc internal error rather than a real
        rem compile error: retry from a fresh directory with opt-level=0, then put
        rem the binary where the launch line below expects it.
        echo First build failed - retrying from a clean directory with opt-level=0...
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
)

echo.
echo   Starting E2E Chat server...
echo   HTTP:  http://localhost:3000
echo   HTTPS: https://localhost:3443
echo.

rem Start in a new window. `%~dp0` keeps this independent of the CWD, and
rem `setlocal` above keeps CARGO_TARGET_DIR from leaking into that window.
start "E2E Chat Server" /d "%~dp0server" "%CARGO_TARGET_DIR%\release\e2e-chat.exe"

timeout /t 3 /nobreak >nul
echo Server started.
