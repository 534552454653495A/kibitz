#!/usr/bin/env bash
# Rejects a working tree that touches anything outside .github/ai/allowed-paths.txt.
# Second line of defence after the agent's tool allowlist (AGENTS.md 7.1): the tool
# allowlist is a prompt-level control; this is a diff-level one, and only the diff is truth.
# Exit 0 = clean, exit 1 = violators printed one per line on stdout.
set -euo pipefail

allowlist="${ALLOWLIST_FILE:-.github/ai/allowed-paths.txt}"
[ -f "$allowlist" ] || { echo "allowlist not found: $allowlist" >&2; exit 2; }

# Prefixes: strip comments and blank lines.
prefixes=$(sed -e 's/#.*$//' -e 's/[[:space:]]*$//' -e '/^$/d' "$allowlist")

# Everything that differs from HEAD (staged or not) plus untracked files. .ai-fix/ is the
# workflow's scratch dir and is gitignored, but exclude it explicitly in case that changes.
changed=$( { git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u )

violations=""
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in .ai-fix/*) continue ;; esac
  allowed=0
  while IFS= read -r prefix; do
    [ -z "$prefix" ] && continue
    case "$file" in "$prefix"*) allowed=1; break ;; esac
  done <<< "$prefixes"
  [ "$allowed" -eq 1 ] || violations="${violations}${file}"$'\n'
done <<< "$changed"

if [ -n "$violations" ]; then
  echo "files outside the allowlist ($allowlist):" >&2
  printf '%s' "$violations"
  exit 1
fi
echo "allowlist ok"
