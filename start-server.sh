#!/bin/bash
# Start the E2E Chat server.
# Kills any existing instance, cleans artifacts, builds release if needed, then starts.
cd "$(dirname "$0")/server"

echo "==> Checking for existing server processes..."
killall e2e-chat 2>/dev/null || true
for port in 3000 3443; do
    pids=$(lsof -ti :"$port" 2>/dev/null || true)
    for pid in $pids; do
        [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
    done
done
sleep 1

# Auto-clean debug build artifacts
if [ -d "target/debug" ]; then
    echo "==> Cleaning debug build artifacts..."
    rm -rf target/debug
fi

# Auto-clean orphaned test databases
echo "==> Cleaning orphaned test databases..."
rm -f *.db-shm *.db-wal
rm -f admin-bk-*.db admin-panel-*.db admin-probe-*.db admin-wipe-*.db
rm -f f-test-*.db g2-probe-*.db hardening-*.db ks-rl-*.db ks-user-*.db
rm -f risky-probe-*.db runtime-test-*.db vault-test-*.db chat.db

if [ ! -f "target/release/e2e-chat" ]; then
    echo "==> Building server (release)..."
    cargo build --release
    if [ $? -ne 0 ]; then
        echo "BUILD FAILED"
        exit 1
    fi
fi

echo ""
echo "  Starting E2E Chat server..."
echo "  HTTP:  http://localhost:3000"
echo "  HTTPS: https://localhost:3443"
echo ""

exec ./target/release/e2e-chat
