#!/bin/bash
# Restart the E2E Chat server.
# Kills any existing instance, cleans artifacts, rebuilds release, then starts.
set -e
cd "$(dirname "$0")/server"

echo "==> Stopping old e2e-chat server..."
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

echo "==> Building server (release)..."
if ! cargo build --release; then
    echo "BUILD FAILED" >&2
    exit 1
fi

echo "==> Starting server..."
echo "    HTTP:  http://localhost:3000"
echo "    HTTPS: https://localhost:3443"
echo "    (Ctrl+C to stop)"

exec ./target/release/e2e-chat
