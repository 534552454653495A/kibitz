/**
 * Probe report: the machine-readable result (probe-report.json) and the human summary.
 *
 * The JSON is the contract with `.github/scripts/upsert-issue.sh` and
 * `.github/scripts/build-task.sh` — they read it with jq, so the shape is flat and every
 * field is always present (no optionals) to keep those scripts free of null-handling.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface CheckResult {
  id: string;
  description: string;
  ok: boolean;
  ms: number;
  /** Human detail: what was observed on success, the error on failure. */
  detail: string;
}

/**
 * Why the run is red. `session` = never reached a usable channel (auth); `contract` = a
 * selector check failed on a real channel view; `setup` = browser/launch/navigation died.
 * upsert-issue.sh files `session` under auto:probe-session (no fix agent) and only
 * `contract` under auto:broken-selector.
 */
export type FailureKind = "none" | "session" | "contract" | "setup";

export interface ProbeReport {
  branch: string;
  host: string;
  url: string;
  extensionVersion: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  failureKind: FailureKind;
  checks: CheckResult[];
  /** Last console errors + uncaught page errors, Discord's and ours mixed. */
  consoleErrors: string[];
  /** The subset prefixed by our logger — what points at Kibitz rather than Discord. */
  kibitzErrors: string[];
}

export const REPORT_FILE = "probe-report.json";

export async function writeReport(outDir: string, report: ProbeReport): Promise<string> {
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, REPORT_FILE);
  await fs.writeFile(file, JSON.stringify(report, null, 2));
  return file;
}

/** Markdown for stdout and $GITHUB_STEP_SUMMARY; pipes in cells are escaped for the table. */
export function renderSummaryMarkdown(report: ProbeReport): string {
  const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const lines: string[] = [];
  lines.push(`## Kibitz probe — ${report.branch} (${report.host}) ${report.ok ? "✅ passed" : `❌ failed (${report.failureKind})`}`);
  lines.push("");
  lines.push(`Extension ${report.extensionVersion} · ${report.url} · ${report.startedAt} → ${report.finishedAt}`);
  lines.push("");
  lines.push("| Check | Result | ms | Detail |");
  lines.push("| --- | --- | ---: | --- |");
  for (const c of report.checks) {
    lines.push(`| \`${c.id}\` — ${cell(c.description)} | ${c.ok ? "✅" : "❌"} | ${c.ms} | ${cell(c.detail)} |`);
  }
  const failed = report.checks.find((c) => !c.ok);
  if (failed) {
    lines.push("");
    lines.push(`### Failed check: \`${failed.id}\``);
    lines.push("");
    lines.push("```");
    lines.push(failed.detail);
    lines.push("```");
  }
  if (report.consoleErrors.length > 0) {
    lines.push("");
    lines.push(`### Console errors (first 10 of ${report.consoleErrors.length}; ${report.kibitzErrors.length} from Kibitz)`);
    lines.push("");
    for (const e of report.consoleErrors.slice(0, 10)) lines.push(`- ${cell(e).slice(0, 300)}`);
  }
  lines.push("");
  return lines.join("\n");
}
