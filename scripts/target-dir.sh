#!/bin/bash
# Shared build-directory and release-build logic for the launcher scripts.
# Sourced by start-server.sh and restart-server.sh — never run on its own.
#
# Every launcher has to agree on TWO things, or it either runs a stale binary or
# no binary at all:
#
#   1. where cargo puts its output, in order of precedence
#        CARGO_TARGET_DIR      the user's explicit override, always honored
#        .cargo/config.toml    build.target-dir (this repo: .cache/e2e-target)
#        ./target              cargo's own default
#   2. that the build can actually FINISH there.
#
# (2) is the exFAT problem. exFAT/vfat/msdos corrupt the .rmeta/.o/.so files
# cargo writes, which surfaces as rustc 1.99.x internal errors —
# "assertion failed: bytes[len] == STR_SENTINEL", or "found invalid metadata
# files for crate ... corrupt metadata encountered in .../lib*.rmeta". A retry in
# a different subdirectory of the SAME filesystem fails the same way, because the
# corruption happens on write. So the build is redirected to a native-disk
# directory instead. That check is best-effort: if the filesystem cannot be
# identified, the chosen directory is left exactly as it was.

# Filesystems where Rust artifact writes have been observed to corrupt here.
_E2E_CORRUPTING_FSTYPES="exfat vfat msdos"

# 0 when $1 — a path that need not exist yet — looks like it lives on one of them.
_e2e_fs_corrupts_artifacts() {
    local dir="${1:-}"
    [ -n "$dir" ] || return 1

    # cargo creates the target dir, so walk up to the nearest ancestor that
    # exists to find the mount the build would land on.
    while [ ! -d "$dir" ] && [ "$dir" != "/" ] && [ "$dir" != "." ]; do
        dir=$(cd "$dir/.." 2>/dev/null && pwd) || dir=/
    done
    [ -d "$dir" ] || return 1

    local fstype=""
    # GNU coreutils first, then the BSD/musl form, then give up (not corrupting:
    # an unanswered question must not move somebody's build).
    fstype=$(df --output=fstype "$dir" 2>/dev/null | tail -n 1) || fstype=""
    if [ -z "$fstype" ]; then
        fstype=$(stat -f -c '%T' "$dir" 2>/dev/null) || fstype=""
    fi
    [ -n "$fstype" ] || return 1
    fstype=$(printf '%s' "$fstype" | tr '[:upper:]' '[:lower:]')

    local bad
    for bad in $_E2E_CORRUPTING_FSTYPES; do
        [ "$fstype" = "$bad" ] && return 0
    done
    return 1
}

# Print a writable native-disk build directory: a persistent cache dir first, a
# fresh temp dir second. Returns 1 when neither is available.
_e2e_native_target_dir() {
    local candidate=""

    if [ -n "${HOME:-}" ]; then
        for candidate in "$HOME/.cache/e2e-target" "$HOME/.cargo/e2e-target"; do
            if mkdir -p "$candidate" 2>/dev/null && touch "$candidate/.write-test" 2>/dev/null; then
                rm -f "$candidate/.write-test"
                printf '%s' "$candidate"
                return 0
            fi
        done
    fi

    for candidate in /tmp /var/tmp; do
        if candidate=$(mktemp -d "$candidate/e2e-target.XXXXXX" 2>/dev/null); then
            printf '%s' "$candidate"
            return 0
        fi
    done

    return 1
}

# Resolve TARGET_DIR for the project rooted at $1, redirecting it off an
# artifact-corrupting filesystem when necessary. Sets TARGET_DIR in the caller
# and exports CARGO_TARGET_DIR whenever the result is absolute, so the cargo
# invocation and the exec line can never disagree about where the binary is.
e2e_resolve_target_dir() {
    local root="${1:-.}"
    local configured="" native=""

    if [ -n "${CARGO_TARGET_DIR:-}" ]; then
        # The user's explicit choice — honored even on a corrupting filesystem.
        TARGET_DIR="$CARGO_TARGET_DIR"
        return 0
    fi

    if [ -f "$root/.cargo/config.toml" ]; then
        # Both legal spellings: `build.target-dir = ...` at top level, or
        # `target-dir = ...` inside a [build] section. Taking the last one matches
        # cargo (the later assignment wins), and missing it would silently fall
        # back to ./target — which on this very filesystem is the broken place.
        configured=$(awk '
            /^[[:space:]]*\[/ { in_build = ($0 ~ /^[[:space:]]*\[build\][[:space:]]*$/); next }
            in_build && /^[[:space:]]*target-dir[[:space:]]*=/ { value = $0 }
            /^[[:space:]]*build\.target-dir[[:space:]]*=/ { value = $0 }
            END { if (value != "") print value }
        ' "$root/.cargo/config.toml" 2>/dev/null) || configured=""
        if [ -n "$configured" ]; then
            configured="${configured#*=}"       # drop the key and its `=`
            configured="${configured//[[:space:]]/}"
            configured="${configured//\"/}"     # drop quoting
            configured="${configured//\'/}"
        fi
    fi
    [ -n "$configured" ] || configured="target"

    if _e2e_fs_corrupts_artifacts "$root/$configured"; then
        if native=$(_e2e_native_target_dir); then
            echo "==> Build directory is on a filesystem that corrupts Rust artifacts ($configured)."
            echo "    Redirecting the build to a native-disk directory: $native"
            echo "    (Set CARGO_TARGET_DIR explicitly to override this.)"
            configured="$native"
        else
            echo "==> WARNING: the build directory is on a filesystem that corrupts Rust"
            echo "    artifacts ($configured), and no native-disk build directory could be"
            echo "    selected automatically. Set CARGO_TARGET_DIR to a native path to fix."
        fi
    fi

    TARGET_DIR="$configured"
    case "$TARGET_DIR" in
        /*) export CARGO_TARGET_DIR="$TARGET_DIR" ;;
    esac
    return 0
}

# Build server/ in release mode, leaving the binary at
# $TARGET_DIR/release/e2e-chat. Returns non-zero when it could not be produced.
#
# Pass `clean` as the second argument to wipe the release staging first. That is
# only worth it where the binary is missing anyway (start-server.sh), because it
# throws away every incremental artefact — restart-server.sh has nothing to gain
# and everything to lose from it, least of all a 90-second full rebuild on every
# restart. Corrupted staging is handled by the retry below, not by pre-cleaning.
#
# The retry exists because the FIRST failure may be a rustc 1.99.x ICE rather
# than a real compile error: retrying from a fresh target dir with opt-level=0
# sidesteps the ICE paths that the release optimisation pipeline hits. On an
# artifact-corrupting filesystem TARGET_DIR has already been redirected to a
# native disk by e2e_resolve_target_dir, so the retry runs somewhere that works.
e2e_build_server_release() {
    local root="${1:-.}"
    local mode="${2:-}"
    local target_dir="${TARGET_DIR:?TARGET_DIR must be resolved first}"
    local retry_dir="$target_dir/retry-opt0"

    echo "==> Building server (release)..."

    if [ "$mode" = "clean" ]; then
        # A previous failed or partial build can leave corrupted metadata behind
        # that trips the same ICEs, so a from-scratch build starts from a clean
        # release staging.
        rm -rf "$target_dir/release/deps" "$target_dir/release/build" "$target_dir/release/.fingerprint/release"
    fi

    if ( cd "$root/server" && CARGO_TARGET_DIR="$target_dir" cargo build --release ); then
        return 0
    fi

    echo "==> First build failed — retrying from a clean target dir with opt-level=0 (rustc ICE workaround)..."
    rm -rf "$retry_dir"
    if ( cd "$root/server" && CARGO_TARGET_DIR="$retry_dir" RUSTFLAGS="-C opt-level=0" cargo build --release ); then
        mkdir -p "$target_dir/release"
        mv "$retry_dir/release/e2e-chat" "$target_dir/release/e2e-chat"
        rm -rf "$retry_dir"
        # Drop the failed attempt's staging so the next run does not reuse it.
        rm -rf "$target_dir/release/deps" "$target_dir/release/build" "$target_dir/release/.fingerprint/release"
        echo "==> Retry succeeded — binary promoted to $target_dir/release/e2e-chat"
        return 0
    fi

    return 1
}
