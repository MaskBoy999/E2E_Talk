#!/bin/bash
# Build/run dependencies for the Debian/Ubuntu family (apt):
# Debian, Ubuntu, Linux Mint, Pop!_OS, Raspberry Pi OS, Elementary, Zorin, Kali.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

DISTRO_FAMILY=debian
DISTRO_LABEL="Debian/Ubuntu family (apt)"

deps_check() {
    need_cmd build-essential cc
    need_cmd build-essential make
    need_cmd pkg-config pkg-config
    need_openssl libssl-dev
    need_cmd lsof lsof
    need_cmd psmisc killall
    need_cmd curl curl # also used to fetch rustup
    need_cmd coreutils timeout # as_root() caps the sudo/doas prompt so a locked-out
                                # machine cannot hang the script indefinitely
}

deps_install() {
    as_root env DEBIAN_FRONTEND=noninteractive apt-get update
    as_root env DEBIAN_FRONTEND=noninteractive \
        apt-get install -y --no-install-recommends "$@"
}

deps_main "$@"
