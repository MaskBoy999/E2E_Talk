#!/bin/bash
# Start the E2E Chat server.
# Installs any missing build dependencies for this distro, kills any existing
# instance, cleans artifacts, builds release if needed, then starts.
#
# System packages (C compiler, make, pkg-config, OpenSSL headers, lsof, psmisc)
# are installed with sudo/doas when missing. The sudo password prompt is local to
# the machine's terminal — it is never sent over the network or written to disk.
# Rust is installed via rustup into ~/.cargo with no root needed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Detect what's missing before doing anything, so we can tell the user what sudo
# will be asked for (if anything) and give them a chance to pre-install manually.
_missing_report="$ROOT/.start-server-missing"
trap 'rm -f "$_missing_report"' EXIT

# rustup drops cargo in ~/.cargo/bin; keep it on PATH even when the shell
# profile (or a desktop launcher) did not load it. Re-export after the dep
# install too, because scripts/deps/install.sh runs in a subshell.
export PATH="$HOME/.cargo/bin:$PATH"

echo "==> Checking build dependencies..."

# --check only reports; it never calls sudo. We use it to discover whether
# any system packages would be installed (which needs root) vs. only Rust
# (which rustup installs into ~/.cargo with no root).
if ! bash "$ROOT/scripts/deps/install.sh" --check >"$_missing_report" 2>&1; then
    # --check exits non-zero when something is missing. Show the report.
    echo "==> The following are missing and will be installed:"
    sed -n 's/^    //p' "$_missing_report"
    echo ""

    # Decide whether we will need root. Rustup installs the Rust toolchain into
    # ~/.cargo with no root, but C compiler/make/pkg-config/OpenSSL headers/lsof/
    # killall/curl/timeout all need sudo/doas.
    if grep -qE '^\s+missing:' "$_missing_report" 2>/dev/null; then
        # grep may return non-zero if no line matches; guard with || true because
        # we already know at least one line matches from the -q above.
        missing_line=$(grep -E '^\s+missing:' "$_missing_report" | head -1 || true)
        # If the missing list contains anything other than the Rust toolchain,
        # we will need root. The Rust-only case looks like:
        #   missing: cargo/rustc (Rust toolchain)
        if echo "$missing_line" | grep -qvE 'missing:\s+cargo/rustc\s*\(Rust toolchain\)'; then
            echo "==> Some system packages need root (sudo/doas) to install."
            echo "    The sudo/doas password prompt is local to this machine only —"
            echo "    it never sends the password over the network or writes it to"
            echo "    disk. Press Ctrl-C now to install them yourself, or wait and"
            echo "    enter your password when prompted."
            echo ""
        fi
    fi
fi

# Now install whatever was missing (this is where sudo may prompt).
if ! bash "$ROOT/scripts/deps/install.sh"; then
    echo "DEPENDENCY INSTALL FAILED"
    exit 1
fi

cd "$ROOT/server" || exit 1

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

    # A previous failed/partial build can leave corrupted metadata that trips
    # rustc 1.99.x internal errors (ICEs). Clean the release staging area so
    # every clone starts from a reproducible state.
    rm -rf target/release/deps target/release/build target/release/.fingerprint/release

    if ! cargo build --release 2>&1; then
        echo "==> First build failed — retrying with opt-level=0 (rustc ICE workaround)..."
        RUSTFLAGS="-C opt-level=0" cargo build --release 2>&1
        if [ $? -ne 0 ]; then
            echo "BUILD FAILED"
            exit 1
        fi
    fi
fi

echo ""
echo "  Starting E2E Chat server..."
echo "  HTTP:  http://localhost:3000"
echo "  HTTPS: https://localhost:3443"
echo ""

exec ./target/release/e2e-chat
