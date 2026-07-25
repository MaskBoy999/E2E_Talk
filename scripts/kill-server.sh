#!/bin/bash
# Kill any stale e2e-chat server processes so Playwright's webServer
# can start fresh on ports 3000 (HTTP) and 3443 (HTTPS).

# 1. Kill by process name (works on both Windows Git Bash and Unix)
if command -v taskkill &>/dev/null; then
    # Windows — taskkill /f is forceful
    taskkill -f -im e2e-chat.exe 2>/dev/null
else
    # Unix — pkill with SIGKILL
    pkill -9 -f e2e-chat 2>/dev/null
fi

# 2. Kill any process occupying port 3000 (HTTP)
if command -v fuser &>/dev/null; then
    # Linux
    fuser -k 3000/tcp 2>/dev/null
    fuser -k 3443/tcp 2>/dev/null
elif command -v lsof &>/dev/null; then
    # macOS / Linux
    lsof -ti:3000 | xargs kill -9 2>/dev/null || true
    lsof -ti:3443 | xargs kill -9 2>/dev/null || true
fi

# Give the OS a moment to release the sockets
sleep 1

exit 0
