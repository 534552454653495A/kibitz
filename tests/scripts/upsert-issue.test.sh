#!/usr/bin/env bash
# Contract test for .github/scripts/upsert-issue.sh — run by ci.yml on Linux (needs bash + jq).
#
# Failure modes defended, each one observed or nearly shipped on 2026-09-02:
#   - a missing/empty artefact directory must exit 0 without touching GitHub (the report job
#     went red in production when `find` failed under pipefail);
#   - failureKind routing: contract anywhere → auto:broken-selector (starts the fix agent),
#     session/setup only → auto:probe-session (no agent);
#   - an existing issue is EDITED, never created twice and never commented on;
#   - all-green files nothing.
# `gh` is a stub on PATH that logs its argv; nothing here reaches the network.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
script="$root/.github/scripts/upsert-issue.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin"
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "gh $*" >> "$GH_LOG"
case "$1 $2" in
  "issue list") echo "${EXISTING_ISSUE:-}" ;;
esac
EOF
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH" GH_TOKEN=stub GH_REPO=stub/stub GITHUB_RUN_ID=1

# report <dir> <branch> <ok:true|false> <failureKind>
report() {
  mkdir -p "$1/probe-$2"
  jq -n --arg branch "$2" --argjson ok "$3" --arg kind "$4" '{
    branch: $branch, host: "discord.com", url: "https://discord.com/channels/1/2",
    extensionVersion: "test", startedAt: "t", finishedAt: "t", ok: $ok, failureKind: $kind,
    checks: [{id: "list-root", description: "d", ok: $ok, detail: (if $ok then "found" else "ProbeSessionError: away" end)}],
    consoleErrors: ["Failed to load resource"], kibitzErrors: []
  }' > "$1/probe-$2/probe-report.json"
}

failures=0
expect() { # expect <scenario> <pattern-or-'-' for none> <exit>
  local name="$1" pattern="$2" want_exit="$3" got_exit
  export GH_LOG="$work/$name.log"
  : > "$GH_LOG"
  set +e
  bash "$script" "$work/$name" > "$work/$name.out" 2>&1
  got_exit=$?
  set -e
  if [ "$got_exit" != "$want_exit" ]; then
    echo "FAIL $name: exit $got_exit, expected $want_exit"; cat "$work/$name.out"; failures=$((failures + 1)); return
  fi
  if grep -q "issue comment" "$GH_LOG"; then
    echo "FAIL $name: the script commented on an issue"; failures=$((failures + 1)); return
  fi
  if [ "$pattern" = "-" ]; then
    if grep -qE "issue (create|edit)" "$GH_LOG"; then
      echo "FAIL $name: expected no issue write"; cat "$GH_LOG"; failures=$((failures + 1)); return
    fi
  elif ! grep -qE "$pattern" "$GH_LOG"; then
    echo "FAIL $name: expected /$pattern/ in gh calls"; cat "$GH_LOG"; failures=$((failures + 1)); return
  fi
  echo "ok   $name"
}

# 1. download-artifact created no directory at all (probe skipped or died).
expect missing-dir - 0

# 2. directory exists, no report inside.
mkdir -p "$work/empty-dir/probe-stable"
expect empty-dir - 0

# 3. both branches green.
report "$work/green" stable true none
report "$work/green" canary true none
expect green - 0

# 4. session + setup only → account/infra label, never the fix-agent label.
report "$work/session-only" stable false session
report "$work/session-only" canary false setup
expect session-only 'issue create .*--label auto:probe-session' 0
if grep -E "issue create" "$work/session-only.log" | grep -q "auto:broken-selector"; then
  echo "FAIL session-only: fix-agent label applied to a session failure"; failures=$((failures + 1))
fi

# 5. one contract failure anywhere wins.
report "$work/mixed" stable false session
report "$work/mixed" canary false contract
expect mixed 'issue create .*--label auto:broken-selector' 0

# 6. an open issue is edited in place, not duplicated.
report "$work/existing" stable false contract
EXISTING_ISSUE=17 expect existing 'issue edit 17 ' 0
if grep -q "issue create" "$work/existing.log"; then
  echo "FAIL existing: created a second issue"; failures=$((failures + 1))
fi

[ "$failures" -eq 0 ] || { echo "$failures scenario(s) failed"; exit 1; }
echo "upsert-issue.sh: all scenarios passed"
