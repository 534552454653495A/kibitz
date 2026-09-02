/**
 * Prompt assembly: turns UniversalMessage/UniversalThread into the ChatMessage[] the
 * background relays to the provider.
 *
 * Prompt text lives in ../prompts/*.md and is rendered through `renderTemplate`, which is
 * strict in both directions (a placeholder the code forgot to fill, or a variable the
 * prompt no longer mentions, both throw). That strictness is what lets prompts be edited
 * as plain text without a silent "{{message}}" reaching the model.
 */
import type { ChatMessage } from "./messaging";
import { serializeMessage, serializeThread } from "./context";
import type { UniversalMessage, UniversalThread } from "./types";
import explainTemplate from "./prompts/explain.md";
import synthesizeTemplate from "./prompts/synthesize.md";
import systemPrompt from "./prompts/system.md";

/** A synthesis prompt larger than this is mostly noise for the model and money for the user. */
const THREAD_CHAR_BUDGET = 24_000;

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

export function renderTemplate(template: string, vars: Record<string, string>): string {
  // Validate against the template, not the rendered output: a variable's value may
  // legitimately contain "{{…}}" (a chat message quoting a template) and must not trip us.
  const referenced = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name === undefined) continue;
    if (!Object.hasOwn(vars, name)) throw new Error(`unresolved placeholder: ${name}`);
    referenced.add(name);
  }
  for (const name of Object.keys(vars)) {
    if (!referenced.has(name)) throw new Error(`unused variable: ${name}`);
  }
  return template.replace(PLACEHOLDER, (_whole, name: string) => vars[name] ?? "");
}

export function buildExplainMessages(m: UniversalMessage): ChatMessage[] {
  return [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: renderTemplate(explainTemplate, { platform: m.platform, message: serializeMessage(m) }),
    },
  ];
}

export function buildSynthesisMessages(t: UniversalThread): ChatMessage[] {
  return [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: renderTemplate(synthesizeTemplate, {
        platform: t.anchor.platform,
        anchor: serializeMessage(t.anchor),
        thread: serializeThread(t, { charBudget: THREAD_CHAR_BUDGET }),
      }),
    },
  ];
}

/** Returns a new history; the caller keeps the old one as the "before" snapshot. */
export function appendFollowUp(history: ChatMessage[], userText: string): ChatMessage[] {
  return [...history, { role: "user", content: userText }];
}
