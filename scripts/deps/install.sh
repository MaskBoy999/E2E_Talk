#!/bin/bash
# Detect the distribution family and hand off to its dependency installer.
#
#   scripts/deps/install.sh            install whatever is missing
#   scripts/deps/install.sh --check    only report (exit 1 if something is missing)
#
# start-server.sh runs this on every launch: on a machine that already has the
# toolchain it just checks and continues, so it is safe to leave in the path.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OS_RELEASE="${OS_RELEASE_FILE:-/etc/os-release}"

ids=""
if [ -r "$OS_RELEASE" ]; then
    # shellcheck disable=SC1090
    . "$OS_RELEASE"
    ids="${ID:-} ${ID_LIKE:-}"
fi

family=""
for id in $ids; do
    case "$id" in
        arch | archarm | arch32 | cachyos | manjaro | endeavouros | garuda | artix | arcolinux)
            family=arch
            ;;
        debian | ubuntu | raspbian | linuxmint | pop | elementary | zorin | kali | mx | devuan)
            family=debian
            ;;
        fedora | rhel | centos | rocky | almalinux | ol | amzn | nobara)
            family=fedora
            ;;
        opensuse* | suse* | sled | sles)
            family=opensuse
            ;;
        alpine | postmarketos)
            family=alpine
            ;;
    esac
    if [ -n "$family" ]; then
        break
    fi
done

# /etc/os-release can be missing or unhelpful (containers, derivatives not
# listed above), so fall back to whichever package manager is actually present.
if [ -z "$family" ]; then
    for pair in pacman:arch apt-get:debian dnf:fedora yum:fedora zypper:opensuse apk:alpine; do
        if command -v "${pair%%:*}" >/dev/null 2>&1; then
            family="${pair##*:}"
            break
        fi
    done
fi

if [ -z "$family" ] || [ ! -f "$HERE/$family.sh" ]; then
    printf 'ERROR: unsupported distribution%s — no known package manager found.\n' \
        "${ids:+ ($ids)}" >&2
    printf 'Install these manually, then re-run:\n' >&2
    printf '  - a C compiler (gcc or clang) and make\n' >&2
    printf '  - pkg-config and OpenSSL headers (libssl-dev / openssl-devel)\n' >&2
    printf '  - lsof and psmisc (killall), curl\n' >&2
    printf '  - Rust stable: https://rustup.rs\n' >&2
    exit 1
fi

exec bash "$HERE/$family.sh" "$@"
