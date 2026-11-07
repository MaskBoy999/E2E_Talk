#!/bin/bash
# Build/run dependencies for the openSUSE/SUSE family (zypper):
# openSUSE Tumbleweed/Leap, SLES, SLED.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

DISTRO_FAMILY=opensuse
DISTRO_LABEL="openSUSE/SUSE family (zypper)"

deps_check() {
    need_cmd gcc gcc
    need_cmd make make
    need_cmd pkg-config pkg-config
    need_openssl libopenssl-devel
    need_cmd lsof lsof
    need_cmd psmisc killall
    need_cmd curl curl
    need_cmd coreutils timeout # as_root() caps the sudo/doas prompt so a locked-out
                                # machine cannot hang the script indefinitely
}

deps_install() {
    as_root zypper --non-interactive install --no-recommends "$@"
}

deps_main "$@"
