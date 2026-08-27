#!/bin/bash
# Dev loop one-shot: kill old server -> rebuild -> restart.
# Usage: ./restart-server.sh   (run from anywhere; script locates the project root)
set -e
cd "$(dirname "$0")"

echo "==> Stopping old e2e-chat server..."
taskkill //f //im e2e-chat.exe >/dev/null 2>&1 || true
for port in 3000 3443; do
    pids=$(netstat -ano | grep ":$port " | grep -i listening | awk '{print $NF}' | sort -u)
    for pid in $pids; do
        [ -n "$pid" ] && taskkill //f //pid "$pid" >/dev/null 2>&1 || true
    done
done
sleep 1

# Auto-clean debug build artifacts to reclaim disk space
if [ -d "server/target/debug" ]; then
    echo "==> Cleaning debug build artifacts..."
    rm -rf server/target/debug
    echo "Debug artifacts cleaned."
fi

# Auto-clean orphaned test databases (leave e2e_chat.db and its WAL/SHM)
echo "==> Cleaning orphaned test databases..."
cd server
rm -f *.db-shm *.db-wal  # remove all WAL/SHM first
rm -f admin-bk-*.db admin-panel-*.db admin-probe-*.db admin-wipe-*.db
rm -f f-test-*.db g2-probe-*.db hardening-*.db ks-rl-*.db ks-user-rl-*.db
rm -f risky-probe-*.db runtime-test-*.db vault-test-*.db chat.db
# Now recreate only e2e_chat.db WAL/SHM if the main DB exists (it will be created on start)
cd ..

echo "==> Building server (release)..."
# Conditional is exempt from set -e, so BUILD FAILED actually prints
if ! ( cd server && cargo build --release ); then
    echo "BUILD FAILED" >&2
    exit 1
fi

echo "==> Starting server..."
echo "    HTTP:  http://localhost:3000"
echo "    HTTPS: https://localhost:3443"
echo "    (Ctrl+C to stop)"
# Launch from server/ so the CWD-relative e2e_chat.db resolves to
# server/e2e_chat.db (same as start-server.bat and Playwright's webServer).
cd server
exec ./target/release/e2e-chat
