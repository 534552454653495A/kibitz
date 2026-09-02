#!/usr/bin/env bash
# Structural check on AGENTS.md, run by ci.yml.
#
# Why this exists: the file is what the fix agent is told to read completely, and six
# separate line-anchored edits during 2026-09-02 landed inside continuation lines instead of
# between entries — leaving bullets that ended mid-sentence and, once, an orphaned tail that
# silently attached itself to the previous entry. A corrupted constitution is read as ground
# truth by an agent that cannot tell the difference, so the shape is now enforced.
#
# Checks:
#   1. every §12 entry starts with the `- **<date> — <title>.**` form
#   2. no entry (including its continuation lines) ends mid-sentence
#   3. no continuation line appears where no entry is open
#   4. section numbering in §3 is contiguous
set -euo pipefail

cd "$(dirname "$0")/../.."
file="AGENTS.md"
failures=0

python3 - "$file" <<'PY' || failures=1
import re
import sys

path = sys.argv[1]
lines = open(path, encoding="utf-8").read().split("\n")
problems = []

start = next(i for i, l in enumerate(lines) if l.startswith("## 12."))


def close(entry: tuple[int, str] | None) -> None:
    """Validate a finished entry: the bold `**<date> — <title>**` header may wrap onto the
    continuation lines, so both checks run on the accumulated text, not on the first line."""
    if entry is None:
        return
    number, text = entry
    if not re.match(r"- \*\*\d{4}-\d{2}-\d{2} — .+?\*\*", text):
        problems.append(f"{path}:{number}: entry has no '**<date> — <title>**' header: {text[:70]!r}")
    if not text.rstrip().endswith((".", ")", "`")):
        problems.append(f"{path}:{number}: entry ends mid-sentence: …{text.rstrip()[-60:]!r}")


entry: tuple[int, str] | None = None
for i in range(start + 1, len(lines)):
    line = lines[i]
    if line.startswith("- "):
        close(entry)
        entry = (i + 1, line)
    elif line.startswith("  ") and line.strip():
        if entry is None:
            problems.append(f"{path}:{i + 1}: continuation line with no open entry (a clipped header?): {line.strip()[:70]!r}")
        else:
            # The signature of the corruption this file keeps suffering: an edit deletes a
            # bullet's header line, so its tail merges into the entry above. The merge point
            # is a finished sentence followed by a line that starts lowercase — which never
            # happens in wrapped prose.
            previous = entry[1].rstrip()
            joins_badly = (
                previous.endswith(".")
                and not previous.endswith(("e.g.", "i.e.", "etc.", "vs."))
                and re.match(r"[a-z]", line.strip())
            )
            if joins_badly:
                problems.append(
                    f"{path}:{i + 1}: continuation starts lowercase after a finished sentence — a bullet header was probably deleted: {line.strip()[:70]!r}",
                )
            entry = (entry[0], entry[1] + " " + line.strip())
    elif not line.strip():
        close(entry)
        entry = None
close(entry)

numbers = [int(m.group(1)) for l in lines for m in [re.match(r"### 3\.(\d+) ", l)] if m]
expected = list(range(1, len(numbers) + 1))
if numbers != expected:
    problems.append(f"{path}: §3 subsections are {numbers}, expected {expected}")

entries = sum(1 for l in lines[start:] if l.startswith("- **"))
if entries < 10:
    problems.append(f"{path}: only {entries} entries in §12 — did an edit delete history?")

for p in problems:
    print(p)
print(f"AGENTS.md: {entries} ledger entries, {len(numbers)} §3 subsections, {len(problems)} problem(s)")
sys.exit(1 if problems else 0)
PY

[ "$failures" -eq 0 ] || { echo "AGENTS.md structure check failed"; exit 1; }
