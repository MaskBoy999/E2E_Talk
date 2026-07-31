@echo off
rem Dev loop one-shot: kill old server -> rebuild -> restart.
cd /d "%~dp0"

echo ==^> Stopping old e2e-chat server...
taskkill /f /im e2e-chat.exe >nul 2>&1
rem Only kill LISTENING sockets so we never taskkill client processes (browser/Playwright)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 " ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3443 " ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1
timeout /t 1 /nobreak >nul

echo ==^> Building server...
cd server
cargo build
if errorlevel 1 (
    echo BUILD FAILED
    pause
    exit /b 1
)

echo ==^> Starting server...
echo     HTTP:  http://localhost:3000
echo     HTTPS: https://localhost:3443
rem Stay in server\ so the CWD-relative e2e_chat.db resolves to server\e2e_chat.db
rem (same as start-server.bat and Playwright's webServer).
start "E2E Chat Server" cmd /c "target\debug\e2e-chat.exe 2>&1 & pause"
timeout /t 3 /nobreak >nul
echo.
echo Server starting...
