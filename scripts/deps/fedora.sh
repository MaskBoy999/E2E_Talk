#!/bin/bash
# Build/run dependencies for the Fedora/RHEL family (dnf/yum):
# Fedora, RHEL, CentOS Stream, Rocky, AlmaLinux, Oracle Linux, Amazon Linux.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

DISTRO_FAMILY=fedora
DISTRO_LABEL="Fedora/RHEL family (dnf)"

deps_check() {
    need_cmd gcc gcc
    need_cmd make make
    need_cmd pkgconf-pkg-config pkg-config
    need_openssl openssl-devel
    need_cmd lsof lsof
    need_cmd psmisc killall
    need_cmd curl curl
    need_cmd coreutils timeout # as_root() caps the sudo/doas prompt so a locked-out
                                # machine cannot hang the script indefinitely
}

deps_install() {
    if have dnf; then
        as_root dnf install -y "$@"
    else
        as_root yum install -y "$@"
    fi
}

deps_main "$@"
