#!/bin/bash
# Build/run dependencies for the Arch Linux family (pacman):
# Arch, CachyOS, Manjaro, EndeavourOS, Garuda, Artix, ArcoLinux.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

DISTRO_FAMILY=arch
DISTRO_LABEL="Arch Linux family (pacman)"

deps_check() {
    need_cmd base-devel cc      # gcc — rusqlite (bundled) and other C deps
    need_cmd base-devel make
    need_cmd pkgconf pkg-config # locates the OpenSSL install
    need_openssl openssl        # reqwest/native-tls headers
    need_cmd lsof lsof          # start-server.sh frees ports 3000/3443
    need_cmd psmisc killall     # start-server.sh stops an old instance
    need_cmd coreutils timeout  # as_root() caps the sudo/doas prompt so a locked-out
                                # machine cannot hang the script indefinitely
}

deps_install() {
    if ! as_root pacman -S --needed --noconfirm "$@"; then
        warn "retrying after refreshing the package database"
        as_root pacman -Sy --noconfirm
        as_root pacman -S --needed --noconfirm "$@"
    fi
}

deps_main "$@"
