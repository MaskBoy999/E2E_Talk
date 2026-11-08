#!/bin/bash
# Restart the E2E Chat server.
# Kills any existing instance, cleans artifacts, rebuilds release, then starts.
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/server"

echo "==> Stopping old e2e-chat server..."
killall e2e-chat 2>/dev/null || true
for port in 3000 3443; do
    pids=$(lsof -ti :"$port" 2>/dev/null || true)
    for pid in $pids; do
        [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
    done
done
sleep 1

# Same build directory and build rules as start-server.sh — one implementation,
# so this script cannot build into ./target while start-server.sh execs
# .cache/e2e-target (or the other way round), and so an exFAT checkout builds
# off-mount here too.
. "$ROOT/scripts/target-dir.sh"
e2e_resolve_target_dir "$ROOT"

# Auto-clean debug build artifacts
if [ -d "$TARGET_DIR/debug" ]; then
    echo "==> Cleaning debug build artifacts..."
    rm -rf "$TARGET_DIR/debug"
fi

# Auto-clean orphaned test databases
echo "==> Cleaning orphaned test databases..."
rm -f *.db-shm *.db-wal
rm -f admin-bk-*.db admin-panel-*.db admin-probe-*.db admin-wipe-*.db
rm -f f-test-*.db g2-probe-*.db hardening-*.db ks-rl-*.db ks-user-*.db
rm -f risky-probe-*.db runtime-test-*.db vault-test-*.db chat.db

if ! e2e_build_server_release "$ROOT"; then
    echo "BUILD FAILED" >&2
    exit 1
fi

echo "==> Starting server..."
echo "    HTTP:  http://localhost:3000"
echo "    HTTPS: https://localhost:3443"
echo "    (Ctrl+C to stop)"

exec "${TARGET_DIR}/release/e2e-chat"
