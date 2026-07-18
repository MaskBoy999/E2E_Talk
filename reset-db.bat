@echo off
cd /d "%~dp0server"
echo ============================================
echo   WARNING: This will DELETE ALL DATA!
echo   All users, messages, servers, uploaded
echo   files, and the admin password will be
echo   permanently lost.
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

echo Deleting uploaded files...
if exist "uploads\" (
    rmdir /S /Q "uploads" 2>nul
    echo Uploads directory removed.
) else (
    echo No uploads directory found.
)

echo Verifying deletion...
if exist "e2e_chat.db" echo [!] WARNING: Could not delete e2e_chat.db - file may still be locked. Make sure the server is fully stopped and try again.
if exist "e2e_chat.db-wal" echo [!] WARNING: e2e_chat.db-wal still exists - deletion incomplete.
if exist "uploads\" echo [!] WARNING: Uploads directory still exists.
if not exist "e2e_chat.db" if not exist "e2e_chat.db-wal" if not exist "uploads\" echo All database files and uploaded content successfully deleted.

echo.
echo ============================================
echo   Database has been wiped clean!
echo   The application is now in factory-fresh
echo   state. Start the server and visit:
echo     http://localhost:3000/admin.html
echo   to set up a new admin password.
echo ============================================
pause
