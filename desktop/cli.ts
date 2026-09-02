/**
 * `npm run desktop -- <command>`: the entry point for Kibitz on the Discord desktop app.
 *
 * `start` gets Discord listening on a DevTools port by whatever route is shortest —
 * already listening → attach; not running → launch with the flag; running without the
 * flag → refuse unless `--relaunch`, because Electron's single-instance lock silently
 * hands a second launch's arguments to the first instance and the flag would be lost.
 *
 * Exit codes are the contract with the user: 0 ok, 2 "you can fix this" (message says
 * how), 1 "this should not happen" (stack trace).
 */
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { log } from "../src/shared/log";
import { findFreePort, findListeningCdp, probeCdp, waitForCdp } from "./cdp";
import { readBundle, runCompanion, UserError } from "./companion";
import { discordPlatform, findDiscordExecutable, isDiscordRunning, launchDiscord, quitDiscord } from "./discord-launch";
import { loadFileSettings, settingsPath } from "./settings-store";
import { runSetup } from "./setup";

const root = path.resolve(import.meta.dirname, "..");
const DEFAULT_BUNDLE = path.join(root, "dist", "desktop-renderer.js");

/** A cold start includes the updater; 90s is generous but a hung Discord must still fail. */
const LAUNCH_CDP_TIMEOUT_MS = 90_000;
/** With --attach the user says Discord is already up; a short wait covers a still-booting one. */
const ATTACH_CDP_TIMEOUT_MS = 30_000;
const QUIT_TIMEOUT_MS = 15_000;
const QUIT_POLL_MS = 500;

export const USAGE = `kibitz-desktop — Kibitz inside the Discord desktop app

Usage: npm run desktop -- [command] [options]

Commands:
  start             Launch Discord with a DevTools port and attach Kibitz (default)
  setup             Configure provider, base URL, API key and model (interactive)
  help              Show this text

Options for start:
  --port <n>        DevTools port (default: a Discord already listening in 9300-9399,
                    else the first free port in that range)
  --attach          Do not launch; connect to a Discord you started yourself with
                    --remote-debugging-port=<port> (requires --port)
  --relaunch        If Discord is running without the flag, quit it and start it again
  --bundle <path>   Renderer bundle (default: dist/desktop-renderer.js — run \`npm run build\`)
  --settings <path> Settings file (default: ${settingsPath()})

Exit codes: 0 ok · 2 something you can fix (the message says how) · 1 unexpected failure
Ctrl+C disconnects Kibitz; Discord keeps running.`;

interface StartOptions {
  port: number | null;
  attach: boolean;
  relaunch: boolean;
  bundlePath: string;
  settingsPath: string;
}

function parseCli(argv: string[]): { command: string; start: StartOptions } {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        port: { type: "string" },
        attach: { type: "boolean" },
        relaunch: { type: "boolean" },
        bundle: { type: "string" },
        settings: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
    const command = values.help === true ? "help" : (positionals[0] ?? "start");
    let port: number | null = null;
    if (values.port !== undefined) {
      port = Number(values.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError(`--port must be a port number, got "${values.port}"`);
    }
    return {
      command,
      start: {
        port,
        attach: values.attach === true,
        relaunch: values.relaunch === true,
        bundlePath: values.bundle === undefined ? DEFAULT_BUNDLE : path.resolve(values.bundle),
        settingsPath: values.settings === undefined ? settingsPath() : path.resolve(values.settings),
      },
    };
  } catch (err) {
    if (err instanceof UserError) throw err;
    // parseArgs rejects unknown flags and missing values with a TypeError; that is user input.
    throw new UserError(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  }
}

async function waitUntilDiscordGone(): Promise<void> {
  const deadline = Date.now() + QUIT_TIMEOUT_MS;
  while (await isDiscordRunning()) {
    if (Date.now() > deadline) throw new UserError(`Discord did not exit within ${QUIT_TIMEOUT_MS / 1000}s; quit it by hand and rerun`);
    await sleep(QUIT_POLL_MS);
  }
}

/** Resolves with the port a Discord DevTools server answers on, launching Discord if needed. */
async function ensureDiscordListening(opts: StartOptions): Promise<number> {
  if (opts.attach) {
    if (opts.port === null) throw new UserError("--attach needs --port <n>: the port you gave Discord in --remote-debugging-port");
    log.info(`waiting for Discord on port ${opts.port}`);
    await waitForCdp(opts.port, ATTACH_CDP_TIMEOUT_MS);
    return opts.port;
  }

  const listening = opts.port === null ? await findListeningCdp() : (await probeCdp(opts.port)) === null ? null : opts.port;
  if (listening !== null) {
    log.info(`Discord is already listening on port ${listening}; attaching`);
    return listening;
  }

  const platform = discordPlatform();
  if (!platform.tested) log.warn(`${process.platform} support has not been exercised yet — please report what happens`);

  if (await isDiscordRunning()) {
    if (!opts.relaunch) {
      throw new UserError("Discord is already running without the debugging flag (check the tray icon too); quit it and rerun, or pass --relaunch to let Kibitz quit and restart it");
    }
    log.info("quitting the running Discord (--relaunch)");
    await quitDiscord();
    await waitUntilDiscordGone();
  }

  const install = await findDiscordExecutable();
  if (install === null) throw new UserError(`Discord desktop not found. ${platform.installHint}`);
  const port = opts.port ?? (await findFreePort());
  log.info(`launching ${install.description} --remote-debugging-port=${port}`);
  launchDiscord(install, port);
  await waitForCdp(port, LAUNCH_CDP_TIMEOUT_MS);
  return port;
}

async function start(opts: StartOptions): Promise<void> {
  // Everything that can fail without Discord's help fails here, before a window opens.
  const bundle = await readBundle(opts.bundlePath);
  const settings = await loadFileSettings(opts.settingsPath);
  log.info(`settings: ${opts.settingsPath} — ${settings === null ? "NOT configured (run `npm run desktop -- setup`)" : `${settings.provider} / ${settings.model}`}`);
  const port = await ensureDiscordListening(opts);
  await runCompanion({ port, bundle, bundlePath: opts.bundlePath, settingsPath: opts.settingsPath });
}

const COMMANDS: Record<string, (opts: StartOptions) => Promise<void>> = {
  start,
  setup: (opts) => runSetup(opts.settingsPath),
  help: async () => console.log(USAGE),
};

async function main(argv: string[]): Promise<number> {
  try {
    const { command, start: opts } = parseCli(argv);
    const run = COMMANDS[command];
    if (run === undefined) throw new UserError(`unknown command "${command}"\n\n${USAGE}`);
    await run(opts);
    // setup sets exitCode 2 when it refused to save; everything else is a thrown UserError.
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (err) {
    if (err instanceof UserError) {
      console.error(`kibitz-desktop: ${err.message}`);
      return 2;
    }
    log.error("unexpected failure", err);
    return 1;
  }
}

process.exit(await main(process.argv.slice(2)));
