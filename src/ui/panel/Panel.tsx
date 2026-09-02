/**
 * Panel view: a pure function of PanelModel plus the action callbacks mount.ts owns.
 *
 * Deliberately no local state beyond the composer's textarea: every observable state
 * lives in the reducer so the host attributes the probe reads and what the user sees
 * cannot drift apart. Assistant text is rendered as pre-wrapped plain text — a markdown
 * renderer would be a second place where untrusted model output meets the DOM.
 */
import { useEffect, useRef } from "preact/hooks";
import type { Platform, UniversalMessage } from "../../core/types";
import { ACTION_ATTR } from "../../shared/dom-markers";
import type { PanelModel, Turn } from "./state";

export interface PanelActions {
  close(): void;
  send(text: string): void;
  scan(): void;
  stop(): void;
  openOptions(): void;
}

export interface PanelProps {
  platform: Platform;
  model: PanelModel;
  actions: PanelActions;
}

function MessageCard({ message }: { message: UniversalMessage }) {
  const extras: string[] = [];
  if (message.attachments.length > 0) extras.push(`${message.attachments.length} attachment(s)`);
  if (message.embeds.length > 0) extras.push(`${message.embeds.length} embed(s)`);
  if (message.isSystem) extras.push("system notice");
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
        <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time>
      </div>
      <div class="content">{message.content}</div>
      {extras.length > 0 && <div class="extras">{extras.join(" · ")}</div>}
    </section>
  );
}

function Conversation({ turns }: { turns: Turn[] }) {
  const box = useRef<HTMLDivElement>(null);
  // Follow the stream: the newest token is what the reader is waiting for.
  useEffect(() => {
    const el = box.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [turns]);
  return (
    <div class="conversation" ref={box}>
      {turns.map((t, i) => (
        <div class={`turn ${t.role}`} key={i}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

function Composer({ actions, disabled }: { actions: PanelActions; disabled: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const submit = (): void => {
    const el = input.current;
    if (el === null) return;
    const text = el.value.trim();
    if (text === "") return;
    el.value = "";
    actions.send(text);
  };
  return (
    <div class="composer">
      <textarea
        ref={input}
        rows={1}
        placeholder="Ask a follow-up… (Enter to send)"
        disabled={disabled}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button class="button primary" {...{ [ACTION_ATTR]: "send" }} disabled={disabled} onClick={submit}>
        Send
      </button>
    </div>
  );
}

export function Panel({ platform, model, actions }: PanelProps) {
  const scanBusy = model.scan.state === "running";
  const scanLabel =
    model.scan.state === "running"
      ? `Scanning… ${model.scan.count}`
      : model.scan.state === "done"
        ? `Scanned ${model.scan.count} messages`
        : model.scan.state === "error"
          ? "Scan failed"
          : "";

  return (
    <div class="panel">
      <header class="header">
        <span class="title">
          Kibitz <span class="platform">· {platform}</span>
        </span>
        <button class="icon-button" {...{ [ACTION_ATTR]: "close" }} title="Close (Esc)" aria-label="Close" onClick={actions.close}>
          ×
        </button>
      </header>

      {model.status === "loading" && <div class="status">Reading message…</div>}
      {model.status === "error" && <div class="status error">Could not read this message.{"\n"}{model.error}</div>}
      {model.message !== null && <MessageCard message={model.message} />}

      {model.status === "ready" && model.configured === false && (
        <div class="cta">
          <p>Kibitz needs an API key before it can explain anything. Your key stays in this browser.</p>
          <button class="button primary" {...{ [ACTION_ATTR]: "open-options" }} onClick={actions.openOptions}>
            Configure API key
          </button>
        </div>
      )}

      {model.status === "ready" && <Conversation turns={model.turns} />}

      {model.status === "ready" && (
        <div class="toolbar">
          <button class="button" {...{ [ACTION_ATTR]: "scan" }} disabled={scanBusy || model.streaming} onClick={actions.scan}>
            Scan related messages
          </button>
          <span>{scanLabel}</span>
          <span class="spacer" />
          {model.streaming && (
            <button class="button" {...{ [ACTION_ATTR]: "stop" }} onClick={actions.stop}>
              Stop
            </button>
          )}
        </div>
      )}

      {model.status === "ready" && model.configured === true && (
        <Composer actions={actions} disabled={model.streaming} />
      )}
    </div>
  );
}
