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
  "Create release" "Publish release assets" > /dev/null || {
  echo "could not extract the release steps"; exit 1;
}

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
  "release upload") bump uploads ;;
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
  for f in view create_calls created edit_calls uploads; do : > "$FAKE_STATE/$f"; done
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

echo
echo "release-workflow-sim: passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
