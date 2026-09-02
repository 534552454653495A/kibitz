/**
 * The chat view: the message being asked about, the conversation, and the composer.
 *
 * It owns the message card and the loading/error status *inside the view* rather than in
 * the frame, because the frame is shared with every other view (settings today, more
 * later) and "reading message…" is a fact about this view's subject, not about the panel.
 *
 * Two details are the whole reason the panel was rewritten:
 *   - the composer stays enabled while an answer streams (typing your next question while
 *     reading the current answer is the normal way to use a chat); only sending is blocked,
 *     so a half-typed follow-up is never destroyed by a race with the stream;
 *   - keystrokes never leave our shadow host (see ui/shadow-host.ts), which is what stops
 *     Discord from stealing them.
 */
import { useEffect, useRef } from "preact/hooks";
import type { UniversalMessage } from "../../../core/types";
import { ACTION_ATTR } from "../../../shared/dom-markers";
import type { PanelActions } from "../actions";
import { renderMarkdown } from "../markdown";
import type { Turn } from "../state";
import type { PanelContext, PanelView } from "../views";

/** Auto-grow ceiling: past this the composer eats the conversation it is answering. */
const COMPOSER_MAX_HEIGHT = 160;
/** How far from the bottom the reader may be and still be considered "following". */
const FOLLOW_SLACK_PX = 80;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Coarse buckets on purpose: a chat message's age is context, not a measurement. */
function relativeTime(iso: string, now: number): string {
  const age = now - Date.parse(iso);
  if (!Number.isFinite(age) || age < MINUTE) return "just now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h ago`;
  return `${Math.floor(age / DAY)}d ago`;
}

function MessageCard({ message }: { message: UniversalMessage }) {
  const chips: string[] = [];
  // Images are called out separately from the rest: with the image toggle on they are the
  // one attachment kind whose *content* leaves for the provider, so a user glancing at the
  // card should be able to see how many pictures this question will carry.
  const images = message.attachments.filter((attachment) => attachment.kind === "image");
  if (images.length > 0) chips.push(`${images.length} image${images.length === 1 ? "" : "s"}`);
  for (const attachment of message.attachments) {
    if (attachment.kind !== "image") chips.push(`${attachment.kind}: ${attachment.name}`);
  }
  for (const embed of message.embeds) chips.push(embed.provider ?? embed.title ?? "embed");
  if (message.isSystem) chips.push("system notice");
  if (message.editedAt !== undefined) chips.push("edited");
  const absolute = new Date(message.createdAt).toLocaleString();

  return (
    <section class="card">
      {message.replyTo !== undefined && (
        <div class="reply">
          ↳ reply to {message.replyTo.authorName ?? "unknown"}
          {message.replyTo.excerpt !== undefined ? `: ${message.replyTo.excerpt}` : ""}
        </div>
      )}
      <div class="meta">
        <span class="author">{message.author.name}</span>
        {message.author.isBot && <span class="badge">bot</span>}
        <time dateTime={message.createdAt} title={absolute}>
          {relativeTime(message.createdAt, Date.now())}
        </time>
        <span class="absolute">{absolute}</span>
      </div>
      <div class="content">{message.content}</div>
      {chips.length > 0 && (
        <div class="chips">
          {chips.map((chip) => (
            <span class="chip" key={chip}>
              {chip}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function Conversation({ turns, actions }: { turns: Turn[]; actions: PanelActions }) {
  const box = useRef<HTMLDivElement>(null);
  // Follow the stream only while the reader is at the bottom; yanking the viewport away
  // from someone who scrolled up to re-read is the classic chat-UI insult.
  const following = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el !== null && following.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const lastIndex = turns.length - 1;
  return (
    <div
      class="conversation"
      ref={box}
      onScroll={(event) => {
        const el = event.currentTarget;
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;
      }}
    >
      {turns.map((turn, index) => (
        <div class={`turn ${turn.role}`} key={index}>
          {turn.role === "assistant" ? (
            turn.text === "" ? (
              <span class="dots" aria-label="waiting for the model">
                ···
              </span>
            ) : (
              renderMarkdown(turn.text)
            )
          ) : (
            turn.text
          )}
          {turn.role === "assistant" && turn.text !== "" && (
            <button
              class="turn-action"
              {...{ [ACTION_ATTR]: "copy-turn" }}
              title="Copy this answer"
              aria-label="Copy this answer"
              onClick={() => actions.copyTurn(index)}
            >
              ⧉
            </button>
          )}
          {turn.role === "error" && index === lastIndex && (
            <button class="turn-action" {...{ [ACTION_ATTR]: "retry" }} title="Try again" onClick={actions.retry}>
              ↻ Retry
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function Composer({ actions, streaming }: { actions: PanelActions; streaming: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const submit = (): void => {
    const el = input.current;
    if (el === null || streaming) return;
    const text = el.value.trim();
    if (text === "") return;
    el.value = "";
    el.style.height = "auto";
    actions.send(text);
  };
  return (
    <div class="composer">
      <textarea
        ref={input}
        rows={1}
        placeholder={streaming ? "Type your next question…" : "Ask a follow-up… (Enter to send)"}
        onInput={(event) => {
          const el = event.currentTarget;
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <button
        class="button primary"
        {...{ [ACTION_ATTR]: "send" }}
        disabled={streaming}
        title={streaming ? "Waiting for the current answer" : "Send (Enter)"}
        onClick={submit}
      >
        Send
      </button>
    </div>
  );
}

function ChatView({ ctx }: { ctx: PanelContext }) {
  const { model, actions, capabilities } = ctx;
  const scanLabel =
    model.scan.state === "running"
      ? `Scanning… ${model.scan.count}`
      : model.scan.state === "done"
        ? `Scanned ${model.scan.count} messages`
        : model.scan.state === "error"
          ? "Scan failed"
          : "";

  return (
    <div class="view chat">
      {model.status === "loading" && <div class="status">Reading message…</div>}
      {model.status === "error" && (
        <div class="status error">
          Could not read this message.{"\n"}
          {model.error}
        </div>
      )}
      {model.message !== null && <MessageCard message={model.message} />}

      {model.status === "ready" && model.configured === false && (
        <div class="cta">
          <p>Kibitz needs an API key before it can explain anything. {ctx.keyStorageHint}</p>
          <button
            class="button primary"
            {...{ [ACTION_ATTR]: "view-settings" }}
            onClick={() => actions.showView("settings")}
          >
            Add your API key
          </button>
          {capabilities.canOpenOptionsPage && (
            <button class="link" {...{ [ACTION_ATTR]: "open-options" }} onClick={actions.openOptions}>
              or open the extension's settings page
            </button>
          )}
        </div>
      )}

      {model.status === "ready" && <Conversation turns={model.turns} actions={actions} />}

      {model.status === "ready" && (
        <div class="toolbar">
          <button
            class="button"
            {...{ [ACTION_ATTR]: "scan" }}
            disabled={model.scan.state === "running" || model.streaming}
            onClick={actions.scan}
          >
            Scan related messages
          </button>
          <span class="scan-label">{scanLabel}</span>
          <span class="spacer" />
          {model.streaming && (
            <button class="button" {...{ [ACTION_ATTR]: "stop" }} onClick={actions.stop}>
              Stop
            </button>
          )}
        </div>
      )}

      {model.status === "ready" && model.configured === true && (
        <Composer actions={actions} streaming={model.streaming} />
      )}
    </div>
  );
}

export const chatView: PanelView = {
  id: "chat",
  title: "Chat",
  icon: "✦",
  available: () => true,
  render: (ctx) => <ChatView ctx={ctx} />,
};
