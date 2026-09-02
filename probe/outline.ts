/**
 * Semantic DOM outline: the ONLY view of Discord's DOM the fix agent gets — by design.
 *
 * `dom.html` is also saved, but the agent's task file points it at this outline. It lists
 * exactly the things a selector is allowed to bind to (AGENTS.md 3.1: id, role, aria-*,
 * data-*, landmark tags) and nothing else. Class names are stripped so the agent cannot
 * even be tempted: a fix that needs a class is not a fix, and the reviewer would reject it.
 *
 * Runs inside the page; the constants are passed as arguments because the function is
 * serialised and cannot close over module scope.
 */
import type { Page } from "puppeteer";

/** Tags listed even without attributes: they carry structure a selector may anchor to. */
const STRUCTURAL_TAGS: Record<string, true> = {
  main: true, nav: true, section: true, article: true, ol: true, ul: true, li: true,
  form: true, header: true, footer: true, aside: true, dialog: true,
};
/** Subtrees that never contain anything selectable. */
const SKIPPED_TAGS: Record<string, true> = { script: true, style: true, svg: true };
const MAX_LINES = 6000;
const MAX_VALUE = 60;

export async function semanticOutline(page: Page): Promise<string> {
  return page.evaluate(
    (structural: Record<string, true>, skipped: Record<string, true>, maxLines: number, maxValue: number) => {
      // No inner named functions on purpose: tsx runs esbuild with keepNames, which wraps
      // `const f = () => …` in a `__name()` helper that does not exist inside the page.
      const lines: string[] = [];
      // Explicit stack (not recursion): Discord nests 40+ levels and we want the walk to be
      // immune to a pathological page. Indent by outline depth, not DOM depth, so the
      // result reads as a tree of semantic nodes rather than a wall of whitespace.
      const stack: Array<{ node: Element | ShadowRoot; depth: number }> = [{ node: document.body, depth: 0 }];
      while (stack.length > 0) {
        if (lines.length >= maxLines) {
          lines.push("… truncated");
          break;
        }
        const { node, depth } = stack.pop()!;
        let childDepth = depth;
        if (node instanceof ShadowRoot) {
          lines.push(`${" ".repeat(depth)}#shadow-root`);
          childDepth = depth + 1;
        } else {
          const tag = node.tagName.toLowerCase();
          if (skipped[tag] === true) continue;
          let line = tag;
          let semantic = structural[tag] === true;
          if (node.id) {
            line += `#${node.id.length > maxValue ? `${node.id.slice(0, maxValue)}…` : node.id}`;
            semantic = true;
          }
          for (const attr of node.attributes) {
            const n = attr.name;
            if (n === "role" || n.startsWith("aria-") || n.startsWith("data-")) {
              line += `[${n}=${attr.value.length > maxValue ? `${attr.value.slice(0, maxValue)}…` : attr.value}]`;
              semantic = true;
            }
          }
          if (semantic) {
            lines.push(`${" ".repeat(depth)}${line}`);
            childDepth = depth + 1;
          }
        }
        // Children pushed in reverse so they pop in document order.
        const children = Array.from(node.children);
        for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i]!, depth: childDepth });
        // Our own UI lives in open shadow roots; seeing its state next to Discord's DOM tells
        // the agent whether the button was injected at all.
        if (node instanceof Element && node.shadowRoot) stack.push({ node: node.shadowRoot, depth: childDepth });
      }
      return lines.join("\n");
    },
    STRUCTURAL_TAGS,
    SKIPPED_TAGS,
    MAX_LINES,
    MAX_VALUE,
  );
}
