#!/bin/bash
# Build/run dependencies for Alpine Linux (apk) and other musl systems.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

DISTRO_FAMILY=alpine
DISTRO_LABEL="Alpine Linux (apk)"

deps_check() {
    need_cmd build-base cc
    need_cmd build-base make
    need_cmd pkgconf pkg-config
    need_openssl openssl-dev
    need_cmd lsof lsof   # busybox has killall, so psmisc is optional here
    need_cmd curl curl
}

deps_install() {
    as_root apk add --no-cache "$@"
}

deps_main "$@"
