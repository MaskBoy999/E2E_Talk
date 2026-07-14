@echo off
cd /d "%~dp0server"

:: Kill any existing server instance to free port 3000
taskkill /f /im e2e-chat.exe >nul 2>&1
timeout /t 1 /nobreak >nul

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
timeout /t 2 /nobreak >nul

echo.
echo   E2E Chat server starting on http://localhost:3000
echo   Open http://localhost:3000/login.html in your browser
echo.
