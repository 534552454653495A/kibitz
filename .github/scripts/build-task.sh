#!/usr/bin/env bash
# Assembles .ai-fix/task.md — the fix agent's user prompt — from evidence already on disk.
# Deterministic and AI-free: the same artefacts always yield the same task, so a failed
# round can be reproduced locally by re-running this script on the downloaded evidence.
# The system prompt (.github/ai/fix-prompt.md) carries the rules; this file carries facts.
set -euo pipefail

issue="${1:?usage: build-task.sh <issue-number> <round>}"
round="${2:?usage: build-task.sh <issue-number> <round>}"
dir="${AI_FIX_DIR:-.ai-fix}"
evidence="$dir/evidence"
out="$dir/task.md"
mkdir -p "$evidence"

{
  echo "# Fix task: issue #$issue, round $((round + 1)) of 5"
  echo
  echo "The canary probe (probe/checks.ts) failed against live Discord. Repair the selector"
  echo "contract following the procedure in your system prompt. Evidence is under \`$evidence/\`."
  echo
  echo "## Issue"
  echo
  if [ -s "$dir/issue.md" ]; then cat "$dir/issue.md"; else echo "(issue text unavailable)"; fi
  echo
  echo "## Probe reports"
  echo

  reports=$(find "$evidence" -name probe-report.json | sort)
  if [ -z "$reports" ]; then
    echo "No probe-report.json in this round's evidence. A review-triggered round carries only the"
    echo "review findings below; the issue text above describes the original probe failure. If neither"
    echo "is enough to act on, report needs-human with reason \"no probe evidence\"."
  fi
  for report in $reports; do
    rdir=$(dirname "$report")
    branch=$(jq -r '.branch' "$report")
    ok=$(jq -r '.ok' "$report")
    echo "### Branch: $branch (host $(jq -r '.host' "$report"), extension $(jq -r '.extensionVersion' "$report"), ok=$ok)"
    echo
    echo "- report: \`$report\`"
    [ -f "$rdir/dom-outline.txt" ] && echo "- DOM outline (read this, not dom.html): \`$rdir/dom-outline.txt\`"
    [ -f "$rdir/screenshot.png" ] && echo "- screenshot: \`$rdir/screenshot.png\`"
    echo
    if [ "$ok" = "true" ]; then
      echo "This branch passed; use it as the known-good reference."
      echo
      continue
    fi
    echo "Checks (in order; the probe stops at the first failure):"
    echo
    jq -r '.checks[] | "- " + (if .ok then "PASS" else "FAIL" end) + " `" + .id + "` — " + .description + (if .ok then "" else "\n  detail: " + .detail end)' "$report"
    echo
    kib=$(jq -r '.kibitzErrors | length' "$report")
    if [ "$kib" -gt 0 ]; then
      echo "Kibitz console errors ($kib):"
      echo
      jq -r '.kibitzErrors[:10][] | "- " + .' "$report"
      echo
    fi
    echo "Console errors, first 10 of $(jq -r '.consoleErrors | length' "$report") (Discord's own noise included):"
    echo
    jq -r '.consoleErrors[:10][] | "- " + (. | .[0:300])' "$report"
    echo
  done

  review=$(find "$evidence" -name review.json | head -n 1)
  if [ -n "$review" ]; then
    echo "## Previous review round (ai-review verdict: $(jq -r '.verdict' "$review"))"
    echo
    jq -r '.summary' "$review"
    echo
    jq -r '.findings[] | "- [" + .severity + "] " + .file + (if .line then ":" + (.line|tostring) else "" end) + " — " + .issue + "\n  suggestion: " + .suggestion' "$review"
    echo
  fi

  echo "## Allowed paths"
  echo
  echo "You may only change files under these prefixes; anything else is discarded by the workflow:"
  echo
  sed -e 's/#.*$//' -e '/^[[:space:]]*$/d' -e 's/^/- `/' -e 's/$/`/' .github/ai/allowed-paths.txt
  echo
  echo "## Required output"
  echo
  echo "Finish with a single JSON object matching this schema (it is enforced):"
  echo
  echo '```json'
  cat .github/ai/fix-output.schema.json
  echo '```'
} > "$out"

echo "wrote $out ($(wc -l < "$out") lines)"
