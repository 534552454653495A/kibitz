// Prompts (.md) and stylesheets (.css) are imported as strings.
// esbuild does this via `loader: { ".md": "text", ".css": "text" }` (scripts/build.ts);
// vitest does it via the `text-assets` plugin (vitest.config.ts). Keep both in sync.
declare module "*.md" {
  const text: string;
  export default text;
}

declare module "*.css" {
  const text: string;
  export default text;
}

// Injected by scripts/build.ts from manifest.json. Tests get the fallback in vitest.config.ts.
declare const __KIBITZ_VERSION__: string;
