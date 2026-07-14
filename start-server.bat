@echo off
cd /d "%~dp0server"

:: Kill any existing server instance to free both ports
echo Checking for existing server processes...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 "') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3443 "') do taskkill /f /pid %%a >nul 2>&1
taskkill /f /im e2e-chat.exe >nul 2>&1
timeout /t 2 /nobreak >nul

if not exist "target\debug\e2e-chat.exe" (
    echo Building server...
    cargo build
    if errorlevel 1 (
        echo BUILD FAILED
        pause
        exit /b 1
    )
)

start "E2E Chat Server" cmd /c "target\debug\e2e-chat.exe 2>&1 & pause"
timeout /t 3 /nobreak >nul

echo.
echo   E2E Chat server starting...
echo.
echo   HTTP:  http://localhost:3000
echo   HTTPS: https://localhost:3443
echo.
echo   For remote access via Tailscale, use https://100.109.151.38:3443
echo   (Accept the self-signed cert warning in your browser)
echo.
