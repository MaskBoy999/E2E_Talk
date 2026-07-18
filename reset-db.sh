#!/bin/bash
cd "$(dirname "$0")/server"

echo "============================================"
echo "  WARNING: This will DELETE ALL DATA!"
echo "  All users, messages, servers, uploaded"
echo "  files, and the admin password will be"
echo "  permanently lost."
echo "============================================"
echo ""
read -p "Type 'RESET' to confirm: " confirm
if [ "$confirm" != "RESET" ]; then
    echo "Reset cancelled."
    exit 1
fi

echo "Stopping any running server processes..."
pkill -f e2e-chat 2>/dev/null || true
sleep 1

echo "Deleting database files..."
rm -f e2e_chat.db e2e_chat.db-shm e2e_chat.db-wal

echo "Deleting uploaded files..."
if [ -d "uploads" ]; then
    rm -rf uploads
    echo "Uploads directory removed."
else
    echo "No uploads directory found."
fi

echo "Verifying deletion..."
HAS_ERROR=0
if [ -f "e2e_chat.db" ]; then
    echo "[!] WARNING: Could not delete e2e_chat.db - file may still be locked."
    echo "    Make sure the server is fully stopped and try again."
    HAS_ERROR=1
fi
if [ -f "e2e_chat.db-wal" ]; then
    echo "[!] WARNING: e2e_chat.db-wal still exists - deletion incomplete."
    HAS_ERROR=1
fi
if [ -d "uploads" ]; then
    echo "[!] WARNING: Could not remove uploads directory."
    HAS_ERROR=1
fi
if [ $HAS_ERROR -eq 0 ]; then
    echo "All database files and uploaded content successfully deleted."
fi

echo ""
echo "============================================"
echo "  Database has been wiped clean!"
echo "  The application is now in factory-fresh"
echo "  state. Start the server and visit:"
echo "    http://localhost:3000/admin.html"
echo "  to set up a new admin password."
echo "============================================"
