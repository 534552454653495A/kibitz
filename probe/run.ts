/**
 * Probe entry point (`npm run probe`): loads dist/ into Chrome, logs a throwaway account
 * into Discord, and runs probe/checks.ts in order against a real channel.
 *
 * Decisions embodied here:
 * - It always writes probe-report.json and, on failure, dom.html / dom-outline.txt /
 *   screenshot.png / console.json. The fix agent gets nothing else, so the artefacts are
 *   the whole evidence trail (AGENTS.md 7).
 * - Every wait is bounded (per-check timeouts plus a global cap) because a hung Discord
 *   must produce a red report, not a cancelled CI job with no artefacts.
 * - The page helper is bundled from probe/page-helper.ts at run time so the probe drives
 *   the bridge through the same RPC client the extension ships.
 * - `--fixture <html>` (`npm run probe:selftest`) serves a contract-shaped page at the real
 *   discord.com channel URL via request interception, so the SAME extension bundle and
 *   the SAME checks run without an account. It proves Kibitz matches the contract it wrote
 *   down; only the live run proves Discord still does.
 * - `--shell desktop` (`npm run probe:selftest:desktop`) runs the fixture with NO extension
 *   loaded: dist/desktop-renderer.js is injected over CDP exactly as the desktop companion
 *   does it, with an in-process request handler that has no settings. Same checks, so a
 *   green run proves the desktop bundle carries bridge + injector + panel end to end.
 *   Live Discord under the desktop shell is `npm run desktop`'s job, not the probe's.
 */
import * as esbuild from "esbuild";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { attachKibitz, deliver } from "../desktop/inject";
import { createDesktopRequestHandler } from "../desktop/request-handler";
import { HOSTS } from "../src/adapters/discord/selectors";
import { LOG_PREFIX } from "../src/shared/log";
import { CHECKS, ProbeSessionError, type ProbeContext } from "./checks";
import { installDiscordToken } from "./discord-session";
import { semanticOutline } from "./outline";
import { renderSummaryMarkdown, writeReport, type CheckResult, type FailureKind, type ProbeReport } from "./report";

type Branch = "stable" | "canary" | "ptb";
const HOST_BY_BRANCH: Record<Branch, (typeof HOSTS)[number]> = {
  stable: "discord.com",
  canary: "canary.discord.com",
  ptb: "ptb.discord.com",
};

type ShellKind = "extension" | "desktop";

/** Snowflake-shaped ids for fixture mode; the fixture page reads them back from the URL. */
const FIXTURE_CHANNEL = { guildId: "100000000000000001", channelId: "100000000000000002" } as const;
const DESKTOP_BUNDLE = "desktop-renderer.js";

interface ProbeConfig {
  /** "fixture" / "fixture-desktop" in self-test mode; the report and the output dir are labelled with it. */
  branch: Branch | "fixture" | "fixture-desktop";
  /** Which host runtime the page gets: the unpacked extension, or the CDP-injected desktop bundle. */
  shell: ShellKind;
  host: string;
  /** null in fixture mode: no login happens. */
  token: string | null;
  /** Absolute path of the fixture HTML in self-test mode. */
  fixture: string | null;
  guildId: string;
  channelId: string;
  outDir: string;
  distDir: string;
}

const root = path.resolve(import.meta.dirname, "..");
/** Boot (≤90s) + the sum of check budgets fits; anything longer is a hang, not slowness. */
const GLOBAL_TIMEOUT_MS = 6 * 60_000;
const NAVIGATION_TIMEOUT_MS = 60_000;
const ARTEFACT_TIMEOUT_MS = 15_000;
const CONSOLE_KEEP = 200;

function fail(message: string): never {
  console.error(`probe: ${message}`);
  process.exit(2);
}

async function readConfig(): Promise<ProbeConfig> {
  const { values } = parseArgs({
    options: { branch: { type: "string" }, fixture: { type: "string" }, shell: { type: "string" } },
    strict: false,
  });
  const branchArg = typeof values.branch === "string" ? values.branch : (process.env.DISCORD_BRANCH ?? "stable");
  if (!(branchArg in HOST_BY_BRANCH)) fail(`--branch must be one of ${Object.keys(HOST_BY_BRANCH).join("|")}, got "${branchArg}"`);
  const branch = branchArg as Branch;
  const fixture = typeof values.fixture === "string" ? path.resolve(root, values.fixture) : null;
  const shellArg = typeof values.shell === "string" ? values.shell : "extension";
  if (shellArg !== "extension" && shellArg !== "desktop") fail(`--shell must be extension|desktop, got "${shellArg}"`);
  const shell: ShellKind = shellArg;
  if (shell === "desktop" && !fixture) fail("--shell desktop is fixture-only here; for live Discord use `npm run desktop`");

  const distDir = path.resolve(root, process.env.KIBITZ_DIST ?? "dist");
  try {
    await fs.access(path.join(distDir, "manifest.json"));
  } catch {
    fail(`${path.relative(root, distDir)}/manifest.json not found — run \`npm run build\` first (or set KIBITZ_DIST)`);
  }

  if (shell === "desktop") {
    try {
      await fs.access(path.join(distDir, DESKTOP_BUNDLE));
    } catch {
      fail(`${path.relative(root, distDir)}/${DESKTOP_BUNDLE} not found — run \`npm run build\` first (or set KIBITZ_DIST)`);
    }
  }

  if (fixture) {
    try {
      await fs.access(fixture);
    } catch {
      fail(`fixture not found: ${fixture}`);
    }
    const branchLabel = shell === "desktop" ? "fixture-desktop" : "fixture";
    return {
      branch: branchLabel,
      shell,
      host: HOST_BY_BRANCH.stable,
      token: null,
      fixture,
      ...FIXTURE_CHANNEL,
      outDir: path.resolve(root, process.env.PROBE_OUT ?? path.join("probe-out", branchLabel)),
      distDir,
    };
  }

  const token = process.env.DISCORD_PROBE_TOKEN;
  if (!token) fail("DISCORD_PROBE_TOKEN is required (token of a THROWAWAY account, see AGENTS.md 7.2)");
  const channel = process.env.DISCORD_PROBE_CHANNEL ?? "";
  const m = /^(\d+)\/(\d+)$/.exec(channel);
  if (!m) fail('DISCORD_PROBE_CHANNEL must be "<guildId>/<channelId>"');

  return {
    branch,
    shell,
    host: HOST_BY_BRANCH[branch],
    token,
    fixture: null,
    guildId: m[1]!,
    channelId: m[2]!,
    outDir: path.resolve(root, process.env.PROBE_OUT ?? path.join("probe-out", branch)),
    distDir,
  };
}

/**
 * Fixture mode: answer the channel document request with the fixture and refuse every
 * other request. Chrome injects content scripts by frame URL, so the real bundles run
 * exactly as they would on Discord; no network means no accidental dependence on it.
 */
async function serveFixture(page: Page, url: string, fixturePath: string): Promise<void> {
  const html = await fs.readFile(fixturePath, "utf8");
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url() === url && request.resourceType() === "document") {
      void request.respond({ status: 200, contentType: "text/html; charset=utf-8", body: html });
    } else {
      void request.abort("blockedbyclient");
    }
  });
}

/**
 * Desktop fixture mode: what desktop/companion.ts does to a real Discord window, minus
 * settings — `loadSettings` yields null so the panel takes the not-configured path and no
 * provider is ever constructed. Attached before navigation, so the bundle reaches the
 * fixture document through evaluateOnNewDocument like it reaches a reloaded Discord.
 */
async function attachDesktopBundle(page: Page, distDir: string): Promise<void> {
  const bundle = await fs.readFile(path.join(distDir, DESKTOP_BUNDLE), "utf8");
  const handler = createDesktopRequestHandler({
    loadSettings: async () => null,
    deliver: (json) => deliver(page, json),
    openOptions: () => {},
  });
  await attachKibitz(page, { bundle, onRequest: handler.handle });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function bundleHelper(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [path.join(root, "probe/page-helper.ts")],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "KibitzProbeHelper",
    platform: "browser",
    target: ["chrome120"],
    logLevel: "silent",
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error("esbuild produced no output for probe/page-helper.ts");
  return file.text;
}

async function runChecks(ctx: ProbeContext, results: CheckResult[]): Promise<FailureKind> {
  for (const check of CHECKS) {
    const started = Date.now();
    try {
      const detail = await withTimeout(check.run(ctx), check.timeoutMs, `check ${check.id}`);
      results.push({ id: check.id, description: check.description, ok: true, ms: Date.now() - started, detail });
      console.log(`  ✅ ${check.id}: ${detail}`);
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      const detail = `${err.name}: ${err.message}`;
      results.push({ id: check.id, description: check.description, ok: false, ms: Date.now() - started, detail });
      console.log(`  ❌ ${check.id}: ${detail}`);
      return err instanceof ProbeSessionError ? "session" : "contract";
    }
  }
  return "none";
}

/** Best effort, each bounded: a page that hung the checks may hang these too. */
async function captureFailure(page: Page, outDir: string, consoleErrors: string[]): Promise<void> {
  const attempts: Array<[string, () => Promise<unknown>]> = [
    ["dom.html", async () => fs.writeFile(path.join(outDir, "dom.html"), await page.evaluate(() => document.documentElement.outerHTML))],
    ["dom-outline.txt", async () => fs.writeFile(path.join(outDir, "dom-outline.txt"), await semanticOutline(page))],
    ["screenshot.png", () => page.screenshot({ path: `${path.join(outDir, "screenshot")}.png`, fullPage: false })],
    ["console.json", () => fs.writeFile(path.join(outDir, "console.json"), JSON.stringify(consoleErrors, null, 2))],
  ];
  for (const [name, capture] of attempts) {
    try {
      await withTimeout(capture(), ARTEFACT_TIMEOUT_MS, name);
    } catch (e: unknown) {
      console.error(`probe: could not write ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function main(): Promise<number> {
  const config = await readConfig();
  const url = `https://${config.host}/channels/${config.guildId}/${config.channelId}`;
  const manifest = JSON.parse(await fs.readFile(path.join(config.distDir, "manifest.json"), "utf8")) as { version?: string };
  await fs.mkdir(config.outDir, { recursive: true });

  const consoleErrors: string[] = [];
  const results: CheckResult[] = [];
  const startedAt = new Date().toISOString();
  // Both are assigned inside the timed closure, which control-flow analysis cannot see: a
  // plain `let x: T = init` is narrowed to the initializer's literal type after the block.
  // Object properties keep their declared type, so the run state lives in one object.
  // failureKind starts as "setup": a launch/navigation death must never read as a pass.
  const session: { browser: Browser | null; page: Page | null; failureKind: FailureKind } = {
    browser: null,
    page: null,
    failureKind: "setup",
  };

  console.log(`probe: ${config.branch} → ${url} (extension ${manifest.version ?? "?"})`);
  try {
    await withTimeout(
      (async () => {
        session.browser = await puppeteer.launch({
          headless: true,
          ...(config.shell === "extension" ? { enableExtensions: [config.distDir] } : {}),
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
          defaultViewport: { width: 1400, height: 1000 },
        });
        const page = await session.browser.newPage();
        session.page = page;
        page.on("console", (msg) => {
          if (msg.type() !== "error") return;
          consoleErrors.push(msg.text());
          if (consoleErrors.length > CONSOLE_KEEP) consoleErrors.shift();
        });
        page.on("pageerror", (err) => {
          consoleErrors.push(`pageerror: ${err instanceof Error ? err.message : String(err)}`);
          if (consoleErrors.length > CONSOLE_KEEP) consoleErrors.shift();
        });

        if (config.fixture) await serveFixture(page, url, config.fixture);
        else if (config.token) await installDiscordToken(page, config.token);
        if (config.shell === "desktop") await attachDesktopBundle(page, config.distDir);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
        const helperCode = await bundleHelper();
        await page.evaluate(`${helperCode}\nKibitzProbeHelper.installProbeHelper();`);

        const ctx: ProbeContext = {
          page,
          host: config.host,
          guildId: config.guildId,
          channelId: config.channelId,
          helperCode,
          clickedMessageId: null,
        };
        session.failureKind = await runChecks(ctx, results);
      })(),
      GLOBAL_TIMEOUT_MS,
      "probe",
    );
  } catch (e: unknown) {
    // Setup or the global cap failed outside a check; record it as a synthetic check so the
    // report never says "ok: false" without naming what died.
    const err = e instanceof Error ? e : new Error(String(e));
    results.push({ id: "setup", description: "browser launch, login and navigation", ok: false, ms: 0, detail: `${err.name}: ${err.message}` });
    session.failureKind = "setup";
  }
  const failureKind = session.failureKind;
  const ok = failureKind === "none";

  // PROBE_ARTEFACTS=always keeps the same evidence on a green run — how a human eyeballs
  // the injected UI (screenshot.png) without waiting for something to break.
  if (session.page && (!ok || process.env.PROBE_ARTEFACTS === "always")) {
    await captureFailure(session.page, config.outDir, consoleErrors);
  }

  const report: ProbeReport = {
    branch: config.branch,
    host: config.host,
    url,
    extensionVersion: manifest.version ?? "unknown",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok,
    failureKind,
    checks: results,
    consoleErrors,
    kibitzErrors: consoleErrors.filter((line) => line.startsWith(LOG_PREFIX)),
  };
  const reportFile = await writeReport(config.outDir, report);
  const summary = renderSummaryMarkdown(report);
  console.log(`\n${summary}\nreport: ${path.relative(root, reportFile)}`);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

  if (session.browser) {
    try {
      await withTimeout(session.browser.close(), ARTEFACT_TIMEOUT_MS, "browser.close");
    } catch (e: unknown) {
      console.error(`probe: browser did not close cleanly: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return ok ? 0 : 1;
}

// Explicit exit: a wedged Chrome child or a dangling CDP socket must not keep CI alive.
process.exit(await main());
