#!/usr/bin/env bash
# Run release.yml's "Create release" and "Publish release assets" scripts for
# real, against a fake `gh`, and assert what they do under failure.
#
# These two steps are the ones that fail QUIETLY: v0.2.35 published a release
# object with zero assets because `gh release create` exited 1 on an HTTP 502 it
# had already acted on, so `build` (which `needs` it) never started; the re-run
# then died in the Arch step because GitHub had forced the release back to
# DRAFT (cli/cli#8458) and an anonymous download of its own .deb 404s. Neither
# failure is reproducible by reading YAML, so the logic is EXECUTED here:
#
#   1. create answers 502 twice, succeeds on the third try, and the release
#      arrives as a draft  -> the job must retry, create exactly ONE release,
#      publish the draft, and end "is live".
#   2. create always fails  -> non-zero exit, gh's own words in the annotation
#      (job logs need auth, so the annotation is the only visible explanation),
#      and no release object left behind.
#   3. the release already exists -> it must never be created again (a second
#      create is what gave v0.2.33 two release objects for one tag).
#   4. the release is forced back to DRAFT after creation -> the step that runs
#      just before the Arch download must republish it, or makepkg 404s.
#   5. it cannot be republished -> LOUD failure naming the root cause, instead
#      of a release whose assets 404 for every anonymous visitor.
#   6. the bundles carry the product name ("E2E Chat"), which GitHub rewrites
#      to dots on upload (cli/cli#10585) — the on-disk name, the published
#      asset name and the SHA256SUMS entry must therefore all be the dotted
#      one, or `sha256sum -c` fails on a pristine download (v0.2.45 shipped
#      exactly that). The fake gh applies GitHub's substitution to every
#      upload and the checksum list is verified against what it recorded.
#
# Usage: bash tools/release-workflow-sim.sh
set -u

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
steps="$work/steps"
bin="$work/bin"
mkdir -p "$bin" "$steps"

node "$root/tools/extract-workflow-steps.mjs" "$root/.github/workflows/release.yml" "$steps" \
  "Create release" "Publish release assets" "Generate checksums" "Attach checksums to release" > /dev/null || {
  echo "could not extract the release steps"; exit 1;
}
# `${{ matrix.label }}` is expanded by GitHub before bash ever runs; the
# checksum step is executed here from a Linux-shaped run.
sed 's/\${{ matrix.label }}/linux-x64/g' "$steps/generate-checksums.sh" > "$work/generate-checksums.sh"

# ---------------------------------------------------------------------------
# A fake `gh` that keeps its state in $FAKE_STATE. DRAFT_MODE drives when the
# release looks like a draft: never / always / after:<n> views (the last one is
# GitHub's asynchronous forced-draft).
# ---------------------------------------------------------------------------
cat > "$bin/gh" <<'GH'
#!/usr/bin/env bash
S="$FAKE_STATE"
bump() { local f="$S/$1" n=0; [ -f "$f" ] && n=$(cat "$f"); echo $((n + 1)) > "$f"; }
cmd="$1 $2"
case "$cmd" in
  "--version ") echo "gh version 2.62.0 (2025-01-01)"; exit 0 ;;
  "release view")
    bump view
    [ -f "$S/exists" ] || { echo "release not found" >&2; exit 1; }
    mode=$(cat "$S/draft_mode" 2>/dev/null || echo never)
    is_draft=false
    case "$mode" in
      always) is_draft=true ;;
      after:*) [ "$(cat "$S/view")" -ge "${mode#after:}" ] && is_draft=true ;;
    esac
    echo "$is_draft" > "$S/draft"
    for a in "$@"; do
      [ "$a" = isDraft ] && want_draft=1
      case "$a" in --json) want_json=1 ;; --jq) want_jq=1 ;; esac
    done
    if [ "${want_draft:-0}" = 1 ] && [ "${want_jq:-0}" = 1 ]; then cat "$S/draft"; else echo "title: E2E Chat"; fi
    ;;
  "release create")
    bump create_calls
    n=$(cat "$S/create_calls")
    case "${SCENARIO:-}" in
      create_always_fail) echo "HTTP 502: We had issues producing the response" >&2; exit 1 ;;
      create_502) [ "$n" -le 2 ] && { echo "HTTP 502: We had issues producing the response" >&2; exit 1; } ;;
    esac
    touch "$S/exists"; bump created
    ;;
  "release edit")
    bump edit_calls
    # Publishing a draft is the ONLY thing this step is allowed to do here.
    # A future edit that starts PATCHing notes/title/assets fails the scenario,
    # because those are exactly the calls this token has rejected before.
    case " $* " in
      *" --draft=false "*) ;;
      *) echo "gh release edit must only publish a draft, got: $*" >&2; exit 9 ;;
    esac
    case " $* " in
      *" --draft=true "*|*" --notes "*|*" --title "*|*" --target "*)
        echo "gh release edit must not change release fields: $*" >&2; exit 9 ;;
    esac
    if [ "${SCENARIO:-}" = edit_fails ]; then echo "Resource not accessible by integration" >&2; exit 1; fi
    echo never > "$S/draft_mode"; echo false > "$S/draft"
    ;;
  "release upload")
    bump uploads
    # GitHub's own upload sanitizes names — spaces (and a few other
    # characters) become dots. Record what the RELEASE would show, not the
    # name on disk, so a workflow that forgets to normalize is caught here.
    for a in "$@"; do
      [ -f "$a" ] || continue
      b="${a##*/}"
      printf '%s\n' "$(printf '%s' "$b" | tr ' ()~:' '.....')" >> "$S/assets"
    done
    ;;
  *) echo "fake gh: unexpected call: $*" >&2; exit 9 ;;
esac
exit 0
GH
chmod +x "$bin/gh"
# Backoffs in the workflow are real seconds; nothing here needs to wait.
printf '#!/usr/bin/env bash\nexit 0\n' > "$bin/sleep"
chmod +x "$bin/sleep"

pass=0
fail=0
out=""
check() {
  if [ "$2" = "$3" ]; then
    echo "  ok   $1 ($2)"; pass=$((pass + 1))
  else
    echo "  FAIL $1: expected [$3] got [$2]"; fail=$((fail + 1))
    printf '%s\n' "${out:-}" | sed 's/^/    | /'
  fi
}
r() { local v; v=$(cat "$FAKE_STATE/$1" 2>/dev/null); echo "${v:-0}"; }

run() { # <scenario> <script>
  FAKE_STATE="$work/state"
  rm -rf "$FAKE_STATE"; mkdir -p "$FAKE_STATE/tmp"
  echo "${DRAFT_MODE:-never}" > "$FAKE_STATE/draft_mode"
  for f in view create_calls created edit_calls uploads assets; do : > "$FAKE_STATE/$f"; done
  [ "${PRE_EXISTS:-0}" = 1 ] && touch "$FAKE_STATE/exists"
  export FAKE_STATE SCENARIO="$1"
  out=$(GITHUB_REF_NAME=v0.2.35 GITHUB_REPOSITORY=MaskBoy999/E2E_Talk RUNNER_TEMP="$FAKE_STATE/tmp" \
    PATH="$bin:$PATH" bash "$2" 2>&1)
  rc=$?
}

echo "=== create-release: 502 twice then success, and the release arrives as a draft ==="
DRAFT_MODE=after:3 PRE_EXISTS=0
run create_502 "$steps/create-release.sh"
check "exit code" "$rc" 0
check "releases created (never two)" "$(r created)" 1
check "create attempts" "$(r create_calls)" 3
check "draft publishes attempted" "$(r edit_calls)" 1
check "ends live" "$(echo "$out" | tail -1)" "release v0.2.35 is live"
check "no failure annotation" "$(echo "$out" | grep -c '::error::')" 0

echo "=== create-release: create keeps failing -> annotated, nothing left behind ==="
DRAFT_MODE=never PRE_EXISTS=0
run create_always_fail "$steps/create-release.sh"
check "non-zero exit" "$rc" 1
check "gh's own words in the annotation" "$(echo "$out" | tail -1 | grep -c '502')" 1
check "annotated" "$(echo "$out" | grep -c '::error::')" 1
check "no release created" "$(r created)" 0

echo "=== create-release: the release already exists -> never re-created ==="
DRAFT_MODE=never PRE_EXISTS=1
run "" "$steps/create-release.sh"
check "exit code" "$rc" 0
check "no create calls" "$(r create_calls)" 0

echo "=== create-release: the draft cannot be published -> loud, and names the cause ==="
# The release must be created HERE for its gate to run at all (an existing one
# short-circuits the step before the gate — the case above this one).
DRAFT_MODE=always PRE_EXISTS=0
run edit_fails "$steps/create-release.sh"
check "the release was created first" "$(r created)" 1
check "non-zero exit" "$rc" 1
check "names cli/cli#8458" "$(echo "$out" | grep -c 'cli/cli#8458')" 1

echo "=== publish-assets: forced back to draft BEFORE the Arch step downloads ==="
DRAFT_MODE=after:2 PRE_EXISTS=1
run "" "$steps/publish-release-assets.sh"
check "exit code" "$rc" 0
check "assets uploaded" "$(r uploads)" 1
check "draft republished" "$(r edit_calls)" 1
check "not left a draft" "$(r draft)" false

echo "=== publish-assets: cannot republish -> fail loudly instead of 404ing later ==="
DRAFT_MODE=always PRE_EXISTS=1
run edit_fails "$steps/publish-release-assets.sh"
check "non-zero exit" "$rc" 1
check "names cli/cli#8458" "$(echo "$out" | grep -c 'cli/cli#8458')" 1
check "annotated" "$(echo "$out" | grep -c '::error::')" 1

echo "=== publish-assets + checksums: on-disk, published and checksum names agree ==="
# GitHub rewrites spaces to dots on upload (cli/cli#10585), so the release
# shows `E2E.Chat_...` while the built file is `E2E Chat_...`. The checksum
# list is written from the ON-DISK name, which made v0.2.45's
# `sha256sum -c SHA256SUMS-<platform>.txt` fail on a pristine download. The
# fake gh above applies GitHub's own substitution to every upload, so if the
# workflow stops normalizing the bundle names this scenario fails here.
sandbox="$work/e2e"
rm -rf "$sandbox"
mkdir -p "$sandbox"/src-tauri/target/release/bundle/{nsis,msi,appimage,deb,rpm}
mkdir -p "$sandbox/dist" "$sandbox/verify"
for spec in \
  "nsis/E2E Chat_0.2.35_x64-setup.exe" \
  "msi/E2E Chat_0.2.35_x64_en-US.msi" \
  "appimage/E2E Chat_0.2.35_amd64.AppImage" \
  "deb/E2E Chat_0.2.35_amd64.deb" \
  "rpm/E2E Chat-0.2.35-1.x86_64.rpm"; do
  printf 'bundle %s\n' "$spec" > "$sandbox/src-tauri/target/release/bundle/$spec"
done
printf 'arch package\n' > "$sandbox/dist/e2e-chat-bin-0.2.35-1-x86_64.pkg.tar.zst"

FAKE_STATE="$work/state"
rm -rf "$FAKE_STATE"; mkdir -p "$FAKE_STATE/tmp"
echo never > "$FAKE_STATE/draft_mode"; touch "$FAKE_STATE/exists"
for f in view create_calls created edit_calls uploads assets; do : > "$FAKE_STATE/$f"; done
export FAKE_STATE SCENARIO=""
(cd "$sandbox" && GITHUB_REF_NAME=v0.2.35 GITHUB_REPOSITORY=MaskBoy999/E2E_Talk \
  RUNNER_TEMP="$FAKE_STATE/tmp" PATH="$bin:$PATH" bash "$steps/publish-release-assets.sh" > /dev/null 2>&1)
pub_rc=$?
(cd "$sandbox" && GITHUB_WORKSPACE="$sandbox" GITHUB_REF_NAME=v0.2.35 \
  bash "$work/generate-checksums.sh" > /dev/null 2>&1)
sum_rc=$?
(cd "$sandbox" && GITHUB_REF_NAME=v0.2.35 GITHUB_REPOSITORY=MaskBoy999/E2E_Talk \
  RUNNER_TEMP="$FAKE_STATE/tmp" PATH="$bin:$PATH" bash "$steps/attach-checksums-to-release.sh" > /dev/null 2>&1)
attach_rc=$?
sums="$sandbox/SHA256SUMS-linux-x64.txt"
check "publish exit code" "$pub_rc" 0
check "checksum exit code" "$sum_rc" 0
check "attach exit code" "$attach_rc" 0
check "bundles renamed before upload" "$(find "$sandbox/src-tauri/target/release/bundle" -name '* *' | wc -l | tr -d ' ')" 0
check "published names carry no spaces" "$(grep -c ' ' "$FAKE_STATE/assets" | tr -d ' ')" 0
check "checksum file lists all six artifacts" "$([ -f "$sums" ] && wc -l < "$sums" | tr -d ' ')" 6
missing=0
while IFS= read -r line; do
  name="${line#*  }"
  grep -qxF "$name" "$FAKE_STATE/assets" || { missing=$((missing + 1)); echo "  no such published asset: $name"; }
done < "$sums"
check "every checksum names a published asset" "$missing" 0
check "dotted .deb (the PKGBUILD's download name) published" "$(grep -cxF 'E2E.Chat_0.2.35_amd64.deb' "$FAKE_STATE/assets")" 1
check "both uploaders ran" "$(r uploads)" 2
# The verification line the release notes advertise, run for real: copy the
# published (dotted) files into one directory, as a downloader would have
# them, and check the list against those bytes.
find "$sandbox/src-tauri/target/release/bundle" -type f \
  \( -name '*.exe' -o -name '*.msi' -o -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' \) \
  -exec cp {} "$sandbox/verify/" \;
cp "$sandbox/dist/e2e-chat-bin-0.2.35-1-x86_64.pkg.tar.zst" "$sandbox/verify/"
check "sha256sum -c verifies the downloaded set" \
  "$(cd "$sandbox/verify" && sha256sum -c "$sums" >/dev/null 2>&1 && echo ok || echo fail)" "ok"

echo
echo "release-workflow-sim: passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
