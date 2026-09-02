/**
 * Build: bundles the four extension entry points into dist/ and copies static files.
 *
 * Why esbuild and a hand-written manifest instead of WXT/CRXJS: the maintenance
 * pipeline (AGENTS.md "Self-repair pipeline") is run by AI agents. Every layer of
 * framework magic is a layer an agent can misread. esbuild + one manifest file keeps
 * the whole build readable in one screen.
 *
 * Output layout is fixed by manifest.jsonc — each key in ENTRIES is the file name the
 * manifest references. Change one, change the other.
 */
import * as esbuild from "esbuild";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stripJsonComments } from "./jsonc";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "dist");
const watch = process.argv.includes("--watch");

const ENTRIES: Record<string, string> = {
  // isolated-world content script: observer, button injection, panel
  content: "src/content/index.ts",
  // MAIN-world script: reads React fiber, answers CustomEvent RPC (manifest world: "MAIN")
  "discord-bridge": "src/adapters/discord/bridge.main.ts",
  // service worker: the ONLY place that talks to LLM APIs
  background: "src/background/index.ts",
  // options page: API key / provider / model
  options: "src/ui/options/options.ts",
};

const STATIC_FILES: Record<string, string> = {
  "options.html": "src/ui/options/options.html",
  "options.css": "src/ui/options/options.css",
};

async function readManifest(): Promise<{ version: string; [key: string]: unknown }> {
  const raw = await fs.readFile(path.join(root, "manifest.jsonc"), "utf8");
  return JSON.parse(stripJsonComments(raw));
}

async function copyStatic(): Promise<void> {
  const manifest = await readManifest();
  // manifest.jsonc is the commented source of truth; Chrome gets plain JSON.
  await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  for (const [target, source] of Object.entries(STATIC_FILES)) {
    await fs.copyFile(path.join(root, source), path.join(outDir, target));
  }
}

async function main(): Promise<void> {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const manifest = await readManifest();

  const ctx = await esbuild.context({
    entryPoints: Object.fromEntries(
      Object.entries(ENTRIES).map(([name, file]) => [name, path.join(root, file)]),
    ),
    outdir: outDir,
    bundle: true,
    // IIFE for every entry: content scripts and MAIN-world scripts cannot be ES modules,
    // and one output shape means one mental model.
    format: "iife",
    target: ["chrome120"],
    sourcemap: watch ? "inline" : false,
    // Unminified on purpose: dist/ is what users load unpacked and what the probe
    // debugs against. Size is irrelevant for a locally installed extension.
    minify: false,
    define: { __KIBITZ_VERSION__: JSON.stringify(manifest.version) },
    loader: { ".md": "text", ".css": "text" },
    jsx: "automatic",
    jsxImportSource: "preact",
    logLevel: "info",
  });

  if (watch) {
    await ctx.watch();
    await copyStatic();
    console.log("watching src/ (static files and manifest.jsonc are copied once; rerun on change)");
    return;
  }

  await ctx.rebuild();
  await ctx.dispose();
  await copyStatic();
  console.log(`built kibitz ${manifest.version} → ${path.relative(root, outDir)}/`);
}

await main();
