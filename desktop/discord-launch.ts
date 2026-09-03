/**
 * Finding, launching, detecting and quitting the Discord desktop app, per OS.
 *
 * The one decision here: Discord is launched as a plain child with
 * `--remote-debugging-port=<port>` (Electron forwards Chromium switches), detached and
 * unref'd so the companion can exit without taking Discord down. Nothing in Discord's
 * install is patched — a Discord update cannot break anything on disk, only the launch path.
 *
 * Only Windows has been exercised by the owner; the macOS and Linux entries encode the
 * documented install layouts and are marked untested in the table. An unsupported
 * platform fails with a message, not a mystery.
 */
import { execFile as execFileCb, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export interface DiscordInstall {
  /** Executable (or launcher such as `open` / `flatpak`) to spawn. */
  command: string;
  /** Arguments that precede the debugging flag. */
  args: string[];
  /** Shown to the user so they can tell which install was picked. */
  description: string;
}

export interface PlatformOps {
  find(): Promise<DiscordInstall | null>;
  isRunning(): Promise<boolean>;
  quit(): Promise<void>;
  /** Printed when `find` returns null. */
  installHint: string;
  /** Owner-verified or not; surfaces in the report and the CLI's first line. */
  tested: boolean;
}

/** `app-1.0.9100` → [1, 0, 9100]; anything else → null. Squirrel's per-version app directories. */
const APP_DIR = /^app-(\d+(?:\.\d+)*)$/;

/**
 * Newest Squirrel app directory by numeric version. Lexical order would rank
 * `app-1.0.9` above `app-1.0.10`, and Discord's build numbers pass 9999 regularly.
 */
export function pickNewestAppDir(names: string[]): string | null {
  let best: { name: string; parts: number[] } | null = null;
  for (const name of names) {
    const m = APP_DIR.exec(name);
    if (m === null || m[1] === undefined) continue;
    const parts = m[1].split(".").map(Number);
    if (best === null || compareVersions(parts, best.parts) > 0) best = { name, parts };
  }
  return best?.name ?? null;
}

function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** True when the command exits 0; ENOENT (tool not installed) and non-zero both count as false. */
async function succeeds(command: string, args: string[]): Promise<boolean> {
  try {
    await execFile(command, args);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(names: string[]): Promise<string | null> {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir.length > 0);
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

const OPS: Record<"win32" | "darwin" | "linux", PlatformOps> = {
  win32: {
    tested: true,
    installHint: "Expected %LOCALAPPDATA%\\Discord\\app-<version>\\Discord.exe (the standard per-user installer).",
    async find() {
      const root = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Discord");
      let entries: string[];
      try {
        entries = await fs.readdir(root);
      } catch {
        return null;
      }
      const newest = pickNewestAppDir(entries);
      if (newest === null) return null;
      const exe = path.join(root, newest, "Discord.exe");
      return (await exists(exe)) ? { command: exe, args: [], description: exe } : null;
    },
    async isRunning() {
      // /NH drops the header so a match means a real row; /FI with no match prints an INFO line.
      const { stdout } = await execFile("tasklist", ["/FI", "IMAGENAME eq Discord.exe", "/NH"]);
      return /Discord\.exe/i.test(stdout);
    },
    async quit() {
      // Discord is several Discord.exe processes (main, renderer, gpu…); /IM takes them all.
      await execFile("taskkill", ["/F", "/IM", "Discord.exe", "/T"]);
    },
  },
  darwin: {
    tested: false,
    installHint: "Expected /Applications/Discord.app or ~/Applications/Discord.app.",
    async find() {
      for (const app of ["/Applications/Discord.app", path.join(os.homedir(), "Applications", "Discord.app")]) {
        // `open --args` hands the flag to the app while letting LaunchServices start it normally.
        if (await exists(app)) return { command: "open", args: ["-a", app, "--args"], description: app };
      }
      return null;
    },
    isRunning: () => succeeds("pgrep", ["-x", "Discord"]),
    async quit() {
      await execFile("osascript", ["-e", 'quit app "Discord"']);
    },
  },
  linux: {
    tested: false,
    installHint: "Expected `discord` on PATH (deb/tar.gz install) or the flatpak com.discordapp.Discord.",
    async find() {
      const onPath = await findOnPath(["discord", "Discord"]);
      if (onPath !== null) return { command: onPath, args: [], description: onPath };
      if (await succeeds("flatpak", ["info", "com.discordapp.Discord"])) {
        return { command: "flatpak", args: ["run", "com.discordapp.Discord"], description: "flatpak com.discordapp.Discord" };
      }
      return null;
    },
    // The binary is `Discord` while the wrapper script is `discord`; -i covers both.
    isRunning: () => succeeds("pgrep", ["-xi", "discord"]),
    async quit() {
      await execFile("pkill", ["-xi", "discord"]);
    },
  },
};

/** The current OS's entry, or a clear error on a platform nobody has mapped yet. */
export function discordPlatform(): PlatformOps {
  const found = OPS[process.platform as keyof typeof OPS];
  if (found === undefined) {
    throw new Error(`kibitz-desktop does not know how to launch Discord on ${process.platform} (supported: ${Object.keys(OPS).join(", ")})`);
  }
  return found;
}

export function findDiscordExecutable(): Promise<DiscordInstall | null> {
  return discordPlatform().find();
}

export function isDiscordRunning(): Promise<boolean> {
  return discordPlatform().isRunning();
}

/** Graceful where the OS offers it (macOS), forced elsewhere. Only used behind `--relaunch`. */
export function quitDiscord(): Promise<void> {
  return discordPlatform().quit();
}

export function launchDiscord(install: DiscordInstall, port: number): void {
  const child = spawn(install.command, [...install.args, `--remote-debugging-port=${port}`], {
    detached: true,
    stdio: "ignore",
  });
  // Discord must outlive the companion: it is the user's app, we are the guest.
  child.unref();
}
