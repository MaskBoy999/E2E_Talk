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

echo Stopping any running server processes...
taskkill /f /im e2e-chat.exe 2>nul
taskkill /f /im e2e-chat 2>nul
timeout /t 2 /nobreak >nul

echo Deleting database files...
del /F /Q "e2e_chat.db" 2>nul
del /F /Q "e2e_chat.db-shm" 2>nul
del /F /Q "e2e_chat.db-wal" 2>nul

echo Verifying deletion...
if exist "e2e_chat.db" (
    echo [!] WARNING: Could not delete e2e_chat.db - file may still be locked.
    echo     Make sure the server is fully stopped and try again.
) else if exist "e2e_chat.db-wal" (
    echo [!] WARNING: e2e_chat.db-wal still exists - deletion incomplete.
) else (
    echo All database files successfully deleted.
)

echo.
echo ============================================
echo   Database has been wiped clean!
echo   Start the server and visit:
echo     http://localhost:3000/admin.html
echo   The admin password will need to be set
echo   again on first visit.
echo ============================================
pause
