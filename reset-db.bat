@echo off
cd /d "%~dp0server"
echo ============================================
echo   WARNING: This will DELETE ALL DATA!
echo   All users, messages, servers, and the
echo   admin password will be permanently lost.
echo ============================================
echo.
set /p confirm="Type 'RESET' to confirm: "
if not "%confirm%"=="RESET" (
    echo Reset cancelled.
    pause
    exit /b
)

echo Stopping any running server...
taskkill /f /im e2e-chat.exe 2>nul

echo Deleting database files...
if exist "e2e_chat.db" del /q "e2e_chat.db"
if exist "e2e_chat.db-shm" del /q "e2e_chat.db-shm"
if exist "e2e_chat.db-wal" del /q "e2e_chat.db-wal"

echo.
echo ============================================
echo   Database has been wiped clean!
echo   Start the server and visit:
echo     http://localhost:3000/admin.html
echo   The admin password will need to be set
echo   again on first visit.
echo ============================================
pause
