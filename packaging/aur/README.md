# AUR packaging — `e2e-chat-bin`

The Arch Linux package. It is a **binary package** (`-bin` suffix, required by
the [AUR submission guidelines](https://wiki.archlinux.org/title/AUR_submission_guidelines)
for prebuilt deliverables): it downloads the `E2E.Chat_<version>_amd64.deb`
that every release already publishes, unwraps the `ar` container with bsdtar
(Arch has no dpkg) and unpacks `data.tar.*` into `$pkgdir`, so pacman ends up
owning every installed file. Arch users then install with:

```sh
yay -S e2e-chat-bin      # or paru -S e2e-chat-bin
```

## How it is maintained

- `PKGBUILD.template` is the source of truth in this repo. Do **not** edit the
  AUR copy by hand: the next `v*` tag re-renders it and pushes, overwriting
  manual changes. If only the *packaging* changes for an already-released
  version, bump `pkgrel` in the template so the AUR sees a real revision.
- On every tag push, `release.yml` (Linux leg) runs
  `tools/aur-render.mjs`, which fills `@PKGVER@`/`@SHA256@`, derives the
  `.SRCINFO` the AUR insists on from the rendered PKGBUILD, and pushes both to
  `ssh://aur@aur.archlinux.org/e2e-chat-bin.git`. The sha256 comes from
  `SHA256SUMS-linux-x64.txt` — the file users verify — and a `.deb` missing
  from that list aborts the publish.
- Cloning a package name that does not exist yet returns an empty repo (an
  explicitly documented AUR behaviour), so the **first push creates the
  package** — no manual bootstrap step.

## One-time setup

1. Create an account at <https://aur.archlinux.org> and confirm the e-mail.
2. Create a **dedicated** key (the ArchWiki recommends one key per purpose so
   it can be revoked selectively):

   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/aur-e2e-chat -C "e2e-chat AUR publishing"
   ```

3. Paste the **public** key (`~/.ssh/aur-e2e-chat.pub`) into *My Account →
   SSH Public Keys* on the AUR.
4. Store the **private** key as the repository secret `AUR_SSH_KEY`
   (*Settings → Secrets and variables → Actions*). Paste the whole key
   including the `-----BEGIN/END ...-----` lines. A key pasted with literal
   `\n` instead of real line breaks also works.
5. Push the next `v*` tag. Without the secret the AUR step is skipped and the
   release is unaffected; with it, the package appears at
   <https://aur.archlinux.org/packages/e2e-chat-bin>.

If a push fails after the release is already published, the release itself is
fine — fix the key/secret and re-run the failed job.

## Testing locally (on an Arch machine)

```sh
node tools/aur-render.mjs \
  --pkgver 0.2.21 \
  --sha256 "$(sha256sum E2E.Chat_0.2.21_amd64.deb | cut -d' ' -f1)" \
  --outdir /tmp/aur
cd /tmp/aur && makepkg -si     # builds, installs, lets you launch the app
```

`tests/aur-packaging.spec.ts` runs the same render on any OS (with a fake
version/checksum) and asserts the PKGBUILD ↔ `.SRCINFO` pair stays consistent,
so CI catches template edits that would otherwise only fail at push time.

## Scope and known gaps

- `arch=('x86_64')` only: the release builds an amd64 `.deb`. An aarch64
  package needs an arm64 desktop build first.
- The template's `# Maintainer:` line is a placeholder (GitHub noreply) —
  change it in `PKGBUILD.template` to your AUR identity if you want it to
  show properly on the package page.
- `license=('ISC')` matches `package.json`, and the repo carries the
  matching `LICENSE` file at its root (the AUR submission guidelines ask
  upstream for one). `tests/aur-packaging.spec.ts` keeps the SPDX id, the
  file text and the copyright line in agreement.
