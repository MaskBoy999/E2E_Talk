@echo off
cd /d "%~dp0server"
start "" "target\debug\e2e-chat.exe"
echo E2E Chat server starting on http://localhost:3000
echo.
echo Open http://localhost:3000/login.html in your browser
