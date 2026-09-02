// @vitest-environment jsdom
import { h, render } from "preact";
import { beforeEach, describe, expect, it } from "vitest";
import { renderMarkdown } from "../../../src/ui/panel/markdown";

let container: HTMLElement;

/** Renders through Preact because that is the only way the panel ever uses this module. */
function show(markdown: string): HTMLElement {
  render(h("div", null, renderMarkdown(markdown)), container);
  const root = container.firstElementChild;
  if (!(root instanceof HTMLElement)) throw new Error("nothing rendered");
  return root;
}

beforeEach(() => {
  document.body.replaceChildren();
  container = document.createElement("main");
  document.body.append(container);
});

describe("renderMarkdown", () => {
  it("keeps a fenced block's newlines and indentation instead of collapsing them into prose", () => {
    const root = show("before\n\n```ts\nconst a = 1;\n  const b = 2;\n```\n\nafter");
    const code = root.querySelector("pre code");
    expect(code?.textContent).toBe("const a = 1;\n  const b = 2;\n");
    expect(code?.getAttribute("data-language")).toBe("ts");
    expect(root.querySelectorAll("p")).toHaveLength(2);
  });

  it("does not let a fence swallow the rest of the answer when it is never closed", () => {
    const root = show("here is code:\n```js\nconst a = 1;");
    expect(root.querySelector("pre")).toBeNull();
    expect(root.textContent).toContain("```js");
  });

  it("renders inline code as <code> and leaves markdown inside it literal", () => {
    const root = show("call `render(**x**)` first");
    const code = root.querySelector("code");
    expect(code?.textContent).toBe("render(**x**)");
    expect(root.querySelector("strong")).toBeNull();
  });

  it("renders bold and italic without leaking their delimiters into the text", () => {
    const root = show("**very** *quite* _also_ emphasised");
    expect(root.querySelector("strong")?.textContent).toBe("very");
    expect(Array.from(root.querySelectorAll("em")).map((el) => el.textContent)).toEqual(["quite", "also"]);
    expect(root.textContent).toBe("very quite also emphasised");
  });

  it("does not italicise the middle of snake_case_identifiers", () => {
    const root = show("see parse_settings_input for details");
    expect(root.querySelector("em")).toBeNull();
    expect(root.textContent).toBe("see parse_settings_input for details");
  });

  it("opens links in a new tab with no window.opener back to the page", () => {
    const root = show("read [the docs](https://example.com/a?b=1) now");
    const link = root.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/a?b=1");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
    expect(link?.textContent).toBe("the docs");
  });

  it("refuses to build a link for a javascript: URL and shows the markdown instead", () => {
    const root = show("[click me](javascript:alert(1))");
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent).toBe("[click me](javascript:alert(1))");
  });

  it("keeps markup in model output as text: a <script> tag never becomes an element", () => {
    const root = show("it said <script>alert('x')</script> and <img src=x onerror=y>");
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toBe("it said <script>alert('x')</script> and <img src=x onerror=y>");
  });

  it("keeps unmatched emphasis characters as typed", () => {
    const root = show("2 * 3 * 4 and a lone ** here");
    expect(root.querySelector("strong")).toBeNull();
    expect(root.textContent).toBe("2 * 3 * 4 and a lone ** here");
  });

  it("turns a single newline into a line break rather than joining the lines", () => {
    const root = show("first line\nsecond line");
    expect(root.querySelectorAll("p")).toHaveLength(1);
    expect(root.querySelectorAll("br")).toHaveLength(1);
    expect(root.textContent).toBe("first linesecond line");
  });
});
