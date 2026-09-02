#!/usr/bin/env bash
# Turns downloaded probe artefacts into exactly ONE open issue per failure kind:
#   contract  → auto:broken-selector  (starts the fix agent via ai-fix.yml)
#   session   → auto:probe-session    (token rejected / login challenge / channel unreadable;
#                                       a human must fix the account — an agent cannot, and
#                                       evidence without a message list would only burn rounds)
#   setup     → auto:probe-session    (browser/launch died before any check; same handling)
# Edit-in-place, never comment: the issue is a status board, not a conversation, and an
# unattended pipeline that comments every 6 hours is the failure mode AGENTS.md 7.1 exists
# to prevent. Deterministic (jq only); the AI runs later, on the label event.
#
# Usage: upsert-issue.sh <dir containing probe-*/probe-report.json>
# Env:   GH_TOKEN (AI_FIX_TOKEN so the `labeled` event triggers ai-fix; with GITHUB_TOKEN the
#        issue is still created but nothing downstream fires — GitHub's recursion guard),
#        GH_REPO, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID.
set -euo pipefail

dir="${1:?usage: upsert-issue.sh <artifacts-dir>}"
: "${GH_TOKEN:?GH_TOKEN is required}"
run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown/unknown}/actions/runs/${GITHUB_RUN_ID:-0}"

reports=$(find "$dir" -name probe-report.json | sort)
if [ -z "$reports" ]; then
  echo "no probe-report.json under $dir — the probe job died before reporting; nothing to file" >&2
  exit 0
fi

failed_branches=""
contract_failed=""
body=$(mktemp)
for report in $reports; do
  branch=$(jq -r '.branch' "$report")
  if [ "$(jq -r '.ok' "$report")" = "true" ]; then
    echo "$branch: ok"
    continue
  fi
  echo "$branch: FAILED ($(jq -r '.failureKind' "$report"))"
  failed_branches="${failed_branches:+$failed_branches, }$branch"
  if [ "$(jq -r '.failureKind' "$report")" = "contract" ]; then contract_failed="yes"; fi
  {
    echo "### $branch (\`$(jq -r '.host' "$report")\`, extension $(jq -r '.extensionVersion' "$report"), failure kind: $(jq -r '.failureKind' "$report"))"
    echo
    jq -r 'first(.checks[] | select(.ok == false)) | "- **Failed check:** `" + .id + "` — " + .description + "\n- **Detail:** " + .detail' "$report"
    echo "- **Checks passed before it:** $(jq -r '[.checks[] | select(.ok == true) | .id] | join(", ") | if . == "" then "none" else . end' "$report")"
    echo "- **Artefact:** \`probe-$branch\` (probe-report.json, dom-outline.txt, dom.html, screenshot.png, console.json)"
    echo
    n=$(jq -r '.consoleErrors | length' "$report")
    if [ "$n" -gt 0 ]; then
      echo "<details><summary>Console errors (first 10 of $n; $(jq -r '.kibitzErrors | length' "$report") from Kibitz)</summary>"
      echo
      jq -r '.consoleErrors[:10][] | "- `" + (. | .[0:300] | gsub("`"; "'"'"'") | gsub("\n"; " ")) + "`"' "$report"
      echo
      echo "</details>"
      echo
    fi
  } >> "$body"
done

if [ -z "$failed_branches" ]; then
  echo "all branches passed; no issue to file"
  rm -f "$body"
  exit 0
fi

# One contract failure anywhere is a selector problem worth an agent round; only when every
# red branch is a session/setup failure is it filed as an account/infra problem instead.
if [ -n "$contract_failed" ]; then
  label="auto:broken-selector"
  title_prefix="[auto] Discord selector contract broken"
  footer="The \`auto:broken-selector\` label starts the fix agent (\`.github/workflows/ai-fix.yml\`); \`needs-human\` means it gave up."
else
  label="auto:probe-session"
  title_prefix="[auto] Discord probe session failed"
  footer="Session/setup failure: the probe never saw a channel. Check DISCORD_PROBE_TOKEN (rejected? challenged from the runner's IP?) and DISCORD_PROBE_CHANNEL. No fix agent runs on this label."
fi

title="$title_prefix ($failed_branches)"
final=$(mktemp)
{
  echo "The canary probe failed on **$failed_branches**. Run: $run_url"
  echo
  echo "Last updated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  cat "$body"
  echo "---"
  echo "Do not edit this issue by hand; it is overwritten by the next run. $footer"
} > "$final"

# Labels must exist before they can be applied; --force makes this idempotent.
gh label create "auto:broken-selector" --force --color B60205 --description "Filed by canary-probe; edited in place, never commented" >/dev/null
gh label create "auto:probe-session" --force --color D93F0B --description "Probe could not log in / reach the channel; fix the account, no agent runs" >/dev/null
gh label create "ai-fix" --force --color 5319E7 --description "Pull request produced by the fix agent" >/dev/null
gh label create "needs-human" --force --color FBCA04 --description "The fix agent stopped; a maintainer must look" >/dev/null

existing=$(gh issue list --label "$label" --state open --limit 20 --json number,title \
  --jq "[.[] | select(.title | startswith(\"$title_prefix\"))] | .[0].number // empty")

if [ -n "$existing" ]; then
  gh issue edit "$existing" --title "$title" --body-file "$final" >/dev/null
  echo "updated issue #$existing ($label)"
else
  gh issue create --title "$title" --body-file "$final" --label "$label"
  echo "created issue ($label)"
fi
rm -f "$body" "$final"
