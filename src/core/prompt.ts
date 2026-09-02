/**
 * Prompt assembly: turns UniversalMessage/UniversalThread into the ChatMessage[] the
 * background relays to the provider.
 *
 * Prompt text lives in ../prompts/*.md and is rendered through `renderTemplate`, which is
 * strict in both directions (a placeholder the code forgot to fill, or a variable the
 * prompt no longer mentions, both throw). That strictness is what lets prompts be edited
 * as plain text without a silent "{{message}}" reaching the model.
 */
import type { ChatImage, ChatMessage } from "./messaging";
import { serializeMessage, serializeThread } from "./context";
import type { UniversalAttachment, UniversalMessage, UniversalThread } from "./types";
import explainTemplate from "./prompts/explain.md";
import synthesizeTemplate from "./prompts/synthesize.md";
import systemPrompt from "./prompts/system.md";

/** A synthesis prompt larger than this is mostly noise for the model and money for the user. */
const THREAD_CHAR_BUDGET = 24_000;

/**
 * Images are billed per picture and a chat message can carry ten screenshots; four is
 * enough for any explanation a reader actually asked for and bounds what one click costs.
 * The cap is applied by the prompt builders, not by the providers, because only the
 * builders know which images matter most (see buildSynthesisMessages).
 */
export const MAX_IMAGES_PER_REQUEST = 4;

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

/** `previewUrl` when the adapter offered a cheaper rendition; the original otherwise. */
function toChatImage(a: UniversalAttachment): ChatImage {
  return {
    url: a.previewUrl ?? a.url,
    ...(a.name === "" ? {} : { name: a.name }),
    ...(a.mimeType === undefined ? {} : { mimeType: a.mimeType }),
  };
}

function imagesOf(m: UniversalMessage): UniversalAttachment[] {
  return m.attachments.filter((a) => a.kind === "image");
}

/** Absent rather than empty: `images: []` would make every text-only turn look multimodal. */
function withImages(content: string, picked: UniversalAttachment[]): ChatMessage {
  if (picked.length === 0) return { role: "user", content };
  return { role: "user", content, images: picked.map(toChatImage) };
}

export function buildExplainMessages(m: UniversalMessage): ChatMessage[] {
  const picked = imagesOf(m).slice(0, MAX_IMAGES_PER_REQUEST);
  const attachedImageIds = new Set(picked.map((a) => a.id));
  const content = renderTemplate(explainTemplate, {
    platform: m.platform,
    message: serializeMessage(m, { attachedImageIds }),
  });
  return [{ role: "system", content: systemPrompt }, withImages(content, picked)];
}

/**
 * The anchor's images first and in full: it is the message the user clicked on, so its
 * pictures are the ones the question is about. The rest of the thread contributes at most
 * one image each, so a single image-dump message cannot crowd the context out — and the
 * whole selection still stops at MAX_IMAGES_PER_REQUEST.
 */
function threadImages(t: UniversalThread): UniversalAttachment[] {
  const picked = imagesOf(t.anchor).slice(0, MAX_IMAGES_PER_REQUEST);
  for (const m of t.messages) {
    if (picked.length >= MAX_IMAGES_PER_REQUEST) break;
    if (m.id === t.anchor.id) continue;
    const first = imagesOf(m)[0];
    if (first !== undefined) picked.push(first);
  }
  return picked;
}

export function buildSynthesisMessages(t: UniversalThread): ChatMessage[] {
  const picked = threadImages(t);
  const attachedImageIds = new Set(picked.map((a) => a.id));
  const content = renderTemplate(synthesizeTemplate, {
    platform: t.anchor.platform,
    anchor: serializeMessage(t.anchor, { attachedImageIds }),
    thread: serializeThread(t, { charBudget: THREAD_CHAR_BUDGET, attachedImageIds }),
  });
  return [{ role: "system", content: systemPrompt }, withImages(content, picked)];
}

/** Returns a new history; the caller keeps the old one as the "before" snapshot. */
export function appendFollowUp(history: ChatMessage[], userText: string): ChatMessage[] {
  return [...history, { role: "user", content: userText }];
}
