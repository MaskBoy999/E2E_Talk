@echo off
REM Kill any stale e2e-chat server processes so Playwright's webServer
REM can start fresh on ports 3000 (HTTP) and 3443 (HTTPS).
REM Uses the same pattern as start-server.bat.

REM Kill by process name (catches orphaned instances regardless of port)
taskkill /f /im e2e-chat.exe >nul 2>&1

REM Kill processes holding port 3000 (HTTP)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 "') do taskkill /f /pid %%a >nul 2>&1

REM Kill processes holding port 3443 (HTTPS)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3443 "') do taskkill /f /pid %%a >nul 2>&1

REM Give the OS a moment to release the sockets
timeout /t 1 /nobreak >nul

exit /b 0
