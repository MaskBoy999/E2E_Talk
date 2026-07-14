#!/bin/bash
cd "$(dirname "$0")/server"
rm -f e2e_chat.db e2e_chat.db-shm e2e_chat.db-wal
echo "Database reset."
