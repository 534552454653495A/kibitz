import { defineConfig, type Plugin } from "vitest/config";

// Mirrors esbuild's `loader: { ".md": "text", ".css": "text" }` so modules that import
// prompts/styles as strings behave identically under test and in the bundle.
const textAssets: Plugin = {
  name: "text-assets",
  enforce: "pre",
  transform(code, id) {
    if (/\.(md|css)$/.test(id)) {
      return { code: `export default ${JSON.stringify(code)};`, map: null };
    }
    return null;
  },
};

export default defineConfig({
  plugins: [textAssets],
  define: { __KIBITZ_VERSION__: JSON.stringify("test") },
  test: {
    include: ["tests/**/*.test.ts"],
    // Node by default; DOM-dependent tests opt in per file with `// @vitest-environment jsdom`.
    environment: "node",
  },
});
