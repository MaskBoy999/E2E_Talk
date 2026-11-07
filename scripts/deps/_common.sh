#!/bin/bash
# Shared helpers for the per-distro dependency installers in this directory
# (arch.sh, debian.sh, ...). Sourced by them — never run directly.
#
# Contract: a distro script sets DISTRO_FAMILY / DISTRO_LABEL, defines
# deps_check() and deps_install(), then calls deps_main "$@".
# deps_check() only inspects: it reports what is missing through
# need_cmd() / need_openssl() / need_rust() and must never change the system.

say() { printf '    %s\n' "$*"; }
info() { printf '==> %s\n' "$*"; }
warn() { printf '    warning: %s\n' "$*" >&2; }
die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

MISSING_CMDS=()
MISSING_PKGS=()
NEED_RUST=0

# need_cmd <package> <command>...
# Every listed command must exist. If any is missing, <package> is added to the
# install list (an empty package means "no package can supply this; just report
# the command").
need_cmd() {
    local pkg="$1" c ok=1
    shift
    for c in "$@"; do
        if ! have "$c"; then
            ok=0
            MISSING_CMDS+=("$c")
        fi
    done
    if [ "$ok" -eq 0 ] && [ -n "$pkg" ]; then
        MISSING_PKGS+=("$pkg")
    fi
}

# need_openssl <package>
# The server links reqwest with native-tls, so building it needs the OpenSSL
# headers (not just the shared library).
need_openssl() {
    local pkg="$1"
    if have pkg-config && pkg-config --exists openssl >/dev/null 2>&1; then
        return 0
    fi
    if [ -f /usr/include/openssl/ssl.h ] || [ -f /usr/local/include/openssl/ssl.h ] \
        || [ -f /opt/homebrew/include/openssl/ssl.h ]; then
        return 0
    fi
    MISSING_CMDS+=("openssl headers")
    MISSING_PKGS+=("$pkg")
}

# Rust comes from rustup: user-local, identical on every distro, no root needed.
need_rust() {
    export PATH="$HOME/.cargo/bin:$PATH"
    if have cargo && have rustc; then
        return 0
    fi
    NEED_RUST=1
    MISSING_CMDS+=("cargo/rustc (Rust toolchain)")
}

# Run a command as root: direct if we are root, else $SUDO, sudo, or doas.
as_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
        return
    fi
    if [ -n "${SUDO:-}" ]; then
        # shellcheck disable=SC2086
        $SUDO "$@"
        return
    fi
    if have sudo; then
        sudo "$@"
        return
    fi
    if have doas; then
        doas "$@"
        return
    fi
    die "need root to install packages: run as root, install sudo/doas, or set SUDO"
}

install_rust() {
    export PATH="$HOME/.cargo/bin:$PATH"
    if have cargo; then
        return 0
    fi
    if ! have curl; then
        die "curl is required to download the Rust toolchain"
    fi
    info "Installing Rust (rustup, into ~/.cargo — no root needed)..."
    local tmp="${TMPDIR:-/tmp}/rustup-init.sh"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o "$tmp" \
        || die "could not download rustup"
    sh "$tmp" -y --profile minimal --default-toolchain stable \
        || die "rustup install failed"
    export PATH="$HOME/.cargo/bin:$PATH"
    have cargo || die "Rust installed but cargo is not on PATH — add ~/.cargo/bin to PATH"
}

dedupe() {
    local out=() p q dup
    for p in "$@"; do
        dup=0
        for q in "${out[@]:-}"; do
            if [ "$q" = "$p" ]; then
                dup=1
                break
            fi
        done
        if [ "$dup" -eq 0 ]; then
            out+=("$p")
        fi
    done
    printf '%s\n' "${out[@]:-}"
}

deps_main() {
    local mode="${1:-install}"
    case "$mode" in
        --check | check) mode=check ;;
        --install | install | "") mode=install ;;
        -h | --help | help)
            printf 'usage: %s [--check | --install]\n\n' "$(basename "$0")"
            printf '  --check    only report what is missing (changes nothing)\n'
            printf '  --install  install what is missing (default)\n'
            return 0
            ;;
        *) die "unknown option: $mode (use --check or --install)" ;;
    esac

    info "Dependencies for $DISTRO_LABEL"
    deps_check
    need_rust

    if [ ${#MISSING_CMDS[@]} -eq 0 ]; then
        say "everything needed is already installed."
        if have cargo; then
            say "$(cargo --version)"
        fi
        return 0
    fi

    say "missing: ${MISSING_CMDS[*]}"
    if [ "$mode" = check ]; then
        say "re-run without --check to install them."
        return 1
    fi

    local pkgs=() line
    if [ ${#MISSING_PKGS[@]} -gt 0 ]; then
        while IFS= read -r line; do
            if [ -n "$line" ]; then
                pkgs+=("$line")
            fi
        done < <(dedupe "${MISSING_PKGS[@]}")
    fi

    if [ ${#pkgs[@]} -gt 0 ]; then
        info "Installing: ${pkgs[*]}"
        deps_install "${pkgs[@]}"
    fi
    if [ "$NEED_RUST" -eq 1 ]; then
        install_rust
    fi

    # Verify instead of trusting the package manager's exit code.
    MISSING_CMDS=()
    MISSING_PKGS=()
    NEED_RUST=0
    deps_check
    need_rust
    if [ ${#MISSING_CMDS[@]} -gt 0 ]; then
        die "still missing after install: ${MISSING_CMDS[*]}"
    fi
    say "all dependencies are installed."
}
