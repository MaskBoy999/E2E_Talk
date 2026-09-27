#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Build the pacman package for one E2E Chat release, inside Arch itself.
#
# Run by the "Build Arch package (pacman)" step in
# .github/workflows/release.yml, which mounts this file plus the rendered
# PKGBUILD and runs it in the official archlinux container:
#
#   docker run --rm -v "$out":/pkgbuild:ro -v <this file>:/build.sh:ro \
#     -v "$PWD/dist":/dist -e PKGVER="$pkgver" \
#     archlinux:base-devel bash /build.sh
#
# WHY THIS IS A FILE and not an inline `bash -ec '...'` argument — the v0.2.33
# tag run failed exactly because of the inline form, so do not restore it:
# wrapping the script in single quotes means the FIRST single quote inside it
# closes the wrapper. The line `grep 'not found'` below did that, so the
# container received a truncated script (ending mid-`ldd` pipeline) with the
# remainder passed as a positional argument. bash ran everything it had —
# makepkg built the package and `pacman -Qp` printed the right version — then
# died parsing the truncated tail with "unexpected EOF while looking for
# matching `)'", exit 2. Nothing about that was visible in the step, only in
# the re-emitted annotation.
#
# A file cannot be mangled by its caller's quoting, and — unlike the inline
# string, which is only ever syntax-checked by the container — it can be
# checked by `bash -n` on every test run. tests/arch-packaging.spec.ts does
# that, and asserts this step keeps using a mounted file.
# ---------------------------------------------------------------------------
set -euo pipefail

# makepkg refuses to run as root — build as an unprivileged user (sudo ships
# in the base-devel group this image is built from).
useradd -m builder
echo "builder ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/builder
cp /pkgbuild/PKGBUILD /pkgbuild/e2e-chat-bin.install /home/builder/
chown -R builder:builder /home/builder

# -Syu, never -Sy: syncing without upgrading against a stale image snapshot
# can leave versioned dependencies unsatisfiable (the classic partial-upgrade
# transaction failure). curl is not in the image either — pacman links
# libcurl, it does not ship the tool makepkg downloads with.
pacman -Syu --noconfirm --needed curl

# The image sets no WORKDIR, so the container starts in / — and makepkg only
# ever reads ./PKGBUILD from the current directory. Without this cd it dies
# with "PKGBUILD does not exist" while the rendered file sits in
# /home/builder. This is what failed the first v0.2.22 tag run.
cd /home/builder

# --nodeps: this image carries base-devel, not the GTK / webkit2gtk runtime
# stack the package depends on. Installing that whole desktop tree just to
# repack a prebuilt .deb is pointless, and the makepkg dependency check
# otherwise fails the build with "Could not resolve all dependencies" — which
# is what failed the second v0.2.22 run (after the cd above fixed the first).
# The depends stay declared for the machine that installs the package, and
# pacman -Qp / -Qlp below still read the produced artifact back.
sudo -u builder makepkg --nodeps --force --noconfirm
cp /home/builder/*.pkg.tar.zst /dist/

info="$(pacman -Qp /dist/*.pkg.tar.zst)"
echo "pacman reads back: $info"
case "$info" in
  "e2e-chat-bin $PKGVER-"*) ;;
  *) echo "::error::built package [$info] does not match tag v$PKGVER"; exit 1 ;;
esac
echo "--- package contents ---"
pacman -Qlp /dist/*.pkg.tar.zst | sed -n "1,40p"

# Prove the declared depends are ENOUGH on a real Arch userland: install the
# package we just built (pacman resolves and installs its depends from the
# official repos) and then ask the dynamic linker to resolve the installed
# binary. A "not found" line here IS the broken-on-Arch report — the app
# starts and paints nothing. Heavy (the webkit/gtk stack is ~400 MB) but this
# runs on tag pushes only, and it is the one check no other job can make.
if pacman -U --noconfirm --needed --noprogressbar /dist/*.pkg.tar.zst; then
  missing="$(ldd /usr/bin/e2e-chat-app | grep 'not found' || true)"
  if [ -n "$missing" ]; then
    echo "::error::the installed Arch package has unresolved libraries:%0A$missing"
    exit 1
  fi
  echo "dependency check: every shared library of the installed binary resolves"
else
  echo "::warning::could not install the built package in the container — its dependency closure was NOT verified"
fi
