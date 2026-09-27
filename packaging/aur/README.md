# Arch packaging — `e2e-chat-bin`

Arch users get a real pacman package on **every GitHub release**: download
`e2e-chat-bin-<version>-1-x86_64.pkg.tar.zst` from the release page and run

    sudo pacman -U e2e-chat-bin-<version>-1-x86_64.pkg.tar.zst

To update later, `pacman -U` the new file the same way. No AUR account, no
signing key, no `pacman.conf` edits: GitHub has no Arch runner, so
`release.yml` builds the package inside the official `archlinux:base-devel`
container — the standard pattern for Arch packaging in CI — from the same
`PKGBUILD.template` an AUR publish would use.

## How a release builds it

1. The Linux leg publishes the `.deb` with the release (as before).
2. `tools/aur-render.mjs` renders `PKGBUILD.template` for the tag: `pkgver`
   from the tag, `sha256sums` from the `.deb` the job just built.
3. In the container, `makepkg` downloads that `.deb` from its **release URL** —
   the identical fetch an Arch user performs, so the step doubles as proof the
   published asset exists — verifies the hash, and repacks it
   (`bsdtar` unwraps the `ar` container; Arch has no dpkg). It runs with
   `--nodeps`: the container has `base-devel`, not the GTK/webkit2gtk runtime
   stack, whose `depends` belong to the machine that installs the package.
4. CI reads the artifact back with **pacman itself**: `pacman -Qp` must report
   `e2e-chat-bin <tag>-1`, and `pacman -Qlp` prints the file list into the job
   log. Version drift (the v0.2.19 phantom-re-update lesson) fails the release
   instead of shipping.
5. Then the package is installed for real: `pacman -U` resolves and installs
   the declared `depends` from the official repos, and `ldd` has to resolve
   the installed binary. A single `not found` line fails the release — that is
   the "installs, then paints grey" release, stopped before it ships.
6. The package joins `SHA256SUMS-linux-x64.txt` and is attached to the
   release next to `.deb` / `.rpm` / `.AppImage`.

That container script is `packaging/aur/build-in-container.sh`, a **file**
rather than an inline `bash -ec '…'` argument — the v0.2.33 tag lost a whole
run to the `grep 'not found'` in step 5: its single quotes closed the
wrapper's quote, so the container received a *truncated* script and died with
`unexpected EOF while looking for matching `)'`. A file cannot be mangled by
its caller's quoting, and it can be parsed (`bash -n`) before it ever runs.
CI also strips CR on the way in — a `\r` at the end of every line is fatal in
the container — and `.gitattributes` pins the file to `eol=lf`.

`tests/arch-packaging.spec.ts` pins all of this — plus the render output — on
any OS, in milliseconds: including that the container script parses, that the
step mounts it instead of inlining it, and that no workflow ever hands bash a
multi-line single-quoted script again.

## Why not the AUR

The AUR route needs an account this project does not have, so the earlier
"push a PKGBUILD on every tag" step could only ever skip, and a reintroduced
push would fail every release on the missing key. The template deliberately
stays AUR-shaped and the renderer still emits `.SRCINFO`, so if an account
ever exists: re-add one workflow step, flip the `not.toContain` guards in the
spec, done.

## Testing locally

With Docker (mirrors CI exactly):

    node tools/aur-render.mjs --pkgver 0.2.33 --sha256 <64-hex> --outdir /tmp/arch
    mkdir -p dist
    docker run --rm \
      -v /tmp/arch:/pkgbuild:ro \
      -v "$PWD/packaging/aur/build-in-container.sh:/build.sh:ro" \
      -v "$PWD/dist:/dist" \
      -e PKGVER=0.2.33 \
      archlinux:base-devel bash /build.sh

The script is the same one CI runs, so it also installs the package and runs
`ldd` on it (a few hundred MB of webkit2gtk, a few minutes).

Without Docker, the extraction half still checks out on any OS — Windows' built-in
`tar.exe` (bsdtar) reads the `.deb` exactly like `package()` does:

    tar -xf E2E.Chat_0.2.22_amd64.deb    # ar container → data.tar.* + control.tar.*
    tar -tf data.tar.*                   # the files pacman would own

## Scope and known gaps

- `arch=('x86_64')` only: the release builds an amd64 `.deb`; an aarch64
  package needs an arm64 desktop build first.
- The template's `# Maintainer:` line is a placeholder (GitHub noreply) —
  edit `PKGBUILD.template` if the AUR route ever opens.
- `license=('ISC')` matches `package.json`, and the repo carries the matching
  `LICENSE` file at its root (the AUR submission guidelines ask upstream for
  one). `tests/arch-packaging.spec.ts` keeps the SPDX id, the file text and
  the copyright line in agreement.
- **Beyond `pacman -U`:** hosting these assets as a pacman *repository* (a
  `repo-add` database users add to `pacman.conf`) would give `pacman -Sy`
  updates, but needs a signing key users import once. Possible later on
  GitHub Pages; `pacman -U` is the smallest thing that works today.
