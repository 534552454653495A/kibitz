/**
 * A deliberately small markdown renderer for model output, built as Preact nodes.
 *
 * Why it exists at all: an LLM answers in markdown, and a wall of literal asterisks and
 * backticks is unreadable — code blocks in particular are the whole point when the question
 * was "explain this message".
 *
 * Why it is not a library and never touches innerHTML: model output is untrusted text (it
 * can and does echo whatever a Discord user wrote, including `<script>`), and the one rule
 * that makes injection impossible is that every character either becomes a text node or is
 * dropped by the parser. Producing VNodes instead of an HTML string means Preact does the
 * escaping and there is no code path where a string becomes markup.
 *
 * Scope is chosen by what models actually emit: fences, inline code, bold, italic, links,
 * line breaks. Anything else stays literal text, which is the honest failure mode — a
 * half-understood construct renders as what the model typed, never as a mangled tree.
 *
 * No `key`s: a streaming answer re-renders its whole text on every delta, so positional
 * diffing is exactly right, and keyed props would make the node type unassignable to the
 * plain `VNode[]` this module promises.
 */
import { h, type ComponentChild, type VNode } from "preact";

/** Requires a closing fence: an unterminated ``` is prose the model has not finished. */
const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;

/**
 * Order is the precedence: inline code wins over emphasis, so `` `**x**` `` keeps its
 * asterisks; `**` is tried before `*` so bold does not decay into two italics.
 *
 * Every emphasis run must start and end on a non-space character, which is what keeps
 * arithmetic ("2 * 3 * 4") and stray delimiters out of the parser — the CommonMark
 * left/right-flanking rule, reduced to the part that matters for chat text.
 */
const INLINE =
  /`([^`\n]+)`|\*\*([^\s](?:[^\n]*?[^\s])?)\*\*|\*([^\s*](?:[^*\n]*?[^\s*])?)\*|_([^\s_](?:[^_\n]*?[^\s_])?)_|\[([^\]\n]+)\]\(([^\s)]+)\)/g;

/** Only schemes that cannot execute in the page. A `javascript:` link stays literal text. */
const SAFE_SCHEMES = ["http:", "https:", "mailto:"];

const WORD = /\w/;

/** Splits one paragraph into text and inline elements; single newlines become <br>. */
function inlineChildren(text: string): ComponentChild[] {
  const out: ComponentChild[] = [];
  let cursor = 0;

  const pushText = (value: string): void => {
    for (const [index, line] of value.split("\n").entries()) {
      if (index > 0) out.push(h("br", null));
      if (line !== "") out.push(line);
    }
  };

  INLINE.lastIndex = 0;
  for (let match = INLINE.exec(text); match !== null; match = INLINE.exec(text)) {
    const [whole, code, bold, italicStar, italicUnderscore, linkLabel, linkHref] = match;
    const start = match.index;
    const before = text[start - 1];
    const after = text[start + whole.length];

    // `snake_case_names` are not emphasis: the underscore form only counts when it is not
    // glued to a word on either side. Checked here rather than with regex lookaround so the
    // rule stays readable.
    if (
      italicUnderscore !== undefined &&
      ((before !== undefined && WORD.test(before)) || (after !== undefined && WORD.test(after)))
    ) {
      pushText(text.slice(cursor, start + whole.length));
      cursor = start + whole.length;
      continue;
    }

    pushText(text.slice(cursor, start));
    cursor = start + whole.length;

    if (code !== undefined) out.push(h("code", null, code));
    else if (bold !== undefined) out.push(h("strong", null, bold));
    else if (italicStar !== undefined) out.push(h("em", null, italicStar));
    else if (italicUnderscore !== undefined) out.push(h("em", null, italicUnderscore));
    else if (linkLabel !== undefined && linkHref !== undefined) {
      let href: string | null = null;
      try {
        if (SAFE_SCHEMES.includes(new URL(linkHref).protocol)) href = linkHref;
      } catch {
        // Relative or malformed; there is no base URL that would be meaningful for chat output.
      }
      if (href === null) pushText(whole);
      // Panels live inside someone else's page: open in a new tab, and leave no
      // window.opener the target could use to navigate Discord away.
      else out.push(h("a", { href, target: "_blank", rel: "noreferrer noopener" }, linkLabel));
    }
  }

  pushText(text.slice(cursor));
  return out;
}

function proseBlocks(text: string): VNode[] {
  const out: VNode[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmed = paragraph.replace(/^\n+|\n+$/g, "");
    if (trimmed === "") continue;
    out.push(h("p", null, inlineChildren(trimmed)));
  }
  return out;
}

export function renderMarkdown(text: string): VNode[] {
  const blocks: VNode[] = [];
  let cursor = 0;

  FENCE.lastIndex = 0;
  for (let match = FENCE.exec(text); match !== null; match = FENCE.exec(text)) {
    const [whole, language, body] = match;
    blocks.push(...proseBlocks(text.slice(cursor, match.index)));
    cursor = match.index + whole.length;
    blocks.push(
      h("pre", null, h("code", { "data-language": language === undefined || language === "" ? null : language }, body ?? "")),
    );
  }

  blocks.push(...proseBlocks(text.slice(cursor)));
  return blocks;
}
