/**
 * Saved conversations: the list, an instant local filter, and one AI search over it.
 *
 * The owner asked for this in three sentences — "conversations should be saved", "I want to
 * switch back to one of them", and "Yunus'un AI ile ilgili konusu vardı, geçmişten bulabilir
 * misin?" (find it by asking, in prose). The third one is why there is an `Ask` button and
 * not only a text filter: nobody remembers the words that were actually typed months ago.
 *
 * Two decisions this view has to make visible rather than hide:
 *   - **Typing is free, asking is not.** The box filters locally on every keystroke with the
 *     same matcher the core uses; only `Ask` spends a request. So the button is separate,
 *     and the sentence under it says exactly what leaves this machine when it is pressed —
 *     this is the user's own conversation data going to their provider, and a search feature
 *     that quietly uploads a catalogue of everything they ever asked about would be a
 *     betrayal even when the key is theirs.
 *   - **Deleting is the only way anything disappears.** Retention is unlimited by the
 *     owner's decision, so "Delete all" is the one irreversible button in the panel and it
 *     is armed before it fires, with the count in the confirmation.
 *
 * The empty state names what will appear here instead of saying "nothing": at that moment
 * the user has never seen a saved conversation and cannot know what the list will contain.
 */
import { catalogueLine, matchesQuery, summarySearchText, type ConversationSummary } from "../../../core/history";
import { ACTION_ATTR } from "../../../shared/dom-markers";
import type { PanelActions } from "../actions";
import { renderMarkdown } from "../markdown";
import type { PanelContext, PanelView } from "../views";
import { relativeTime } from "./chat";

/**
 * How many catalogue lines the disclosure sentence shows verbatim. Enough to recognise what
 * is being sent without turning the sentence into the catalogue itself.
 */
const PREVIEW_LINES = 3;

/**
 * The machine line at the end of an AI-search answer. It exists so `parseMatches` can turn
 * the answer into buttons (core/prompts/find.md asks the model for it), and is hidden from
 * the prose because printing it would show a row of ids right above the buttons that already
 * say the same thing in words. Anchored exactly like `parseMatches`, so what is hidden from
 * the reader is what was read from the answer.
 */
const MACHINE_LINE = /^\s*MATCHES:.*$/im;

function Entry({ summary, actions }: { summary: ConversationSummary; actions: PanelActions }) {
  const people = summary.participants.map((participant) => participant.name).join(", ");
  const absolute = new Date(summary.updatedAt).toLocaleString();
  return (
    <li class="entry">
      <button
        class="entry-open"
        {...{ [ACTION_ATTR]: "history-open" }}
        title={`Open: ${summary.title}`}
        onClick={() => actions.openConversation(summary.id)}
      >
        <span class="entry-title">{summary.title}</span>
        <span class="entry-meta">
          {people !== "" && <span class="entry-people">{people}</span>}
          <time dateTime={summary.updatedAt} title={absolute}>
            {relativeTime(summary.updatedAt, Date.now())}
          </time>
          <span class="entry-count">
            {summary.messageCount} message{summary.messageCount === 1 ? "" : "s"}
          </span>
        </span>
      </button>
      <button
        class="icon-button"
        {...{ [ACTION_ATTR]: "history-delete" }}
        title={`Delete: ${summary.title}`}
        aria-label={`Delete ${summary.title}`}
        onClick={() => actions.deleteConversation(summary.id)}
      >
        ×
      </button>
    </li>
  );
}

function HistoryView({ ctx }: { ctx: PanelContext }) {
  const { actions } = ctx;
  const { list, query, busy, asking, answer, matches, error, confirmingClear } = ctx.model.saved;
  const summaries = list ?? [];
  const filtered = summaries.filter((summary) => matchesQuery(summarySearchText(summary), query));
  /**
   * What `Ask` would send, computed here so the disclosure sentence and the request cannot
   * disagree: the same rule mount.ts uses — the local filter narrows the catalogue only when
   * it actually found something, because a question asked in prose ("Yunus'un AI ile ilgili
   * konusu vardı") matches no line literally and an empty catalogue makes the request
   * pointless.
   */
  const outgoing = filtered.length > 0 ? filtered : summaries;
  const named = matches.flatMap((id) => {
    const found = summaries.find((summary) => summary.id === id);
    // A named id the list no longer has (deleted between the answer and the click) simply
    // has no button: an id is not something a user can act on.
    return found === undefined ? [] : [found];
  });
  // The prose the user reads; the ids the model appended for us are shown as buttons instead.
  const spoken = answer.replace(MACHINE_LINE, "").trimEnd();

  return (
    <div class="view history">
      <div class="search">
        <input
          type="search"
          class="search-input"
          value={query}
          spellcheck={false}
          placeholder="Filter, or ask in your own words…"
          aria-label="Search saved conversations"
          {...{ [ACTION_ATTR]: "history-search" }}
          onInput={(event) => actions.searchConversations(event.currentTarget.value)}
        />
        <button
          class="button"
          {...{ [ACTION_ATTR]: "history-ask" }}
          disabled={asking || query.trim() === "" || outgoing.length === 0}
          title="Let the model look through your saved conversations"
          onClick={() => actions.askConversations(query.trim())}
        >
          {asking ? "Asking…" : "Ask"}
        </button>
      </div>

      {/* Nothing saved means nothing to send: the sentence would only say "0 lines", and the
          empty state below already explains what will end up here. */}
      {summaries.length > 0 && (
        <p class="disclose">
          <strong>Ask</strong> sends {outgoing.length} line{outgoing.length === 1 ? "" : "s"} to your provider — one
          per conversation, each holding its id, date, the people in it, its title and the first message's opening
          words — plus your question. The answers and the rest of the messages stay on this machine.
          <span class="disclose-sample">
            {outgoing.slice(0, PREVIEW_LINES).map((summary) => (
              <code key={summary.id}>{catalogueLine(summary)}</code>
            ))}
            {outgoing.length > PREVIEW_LINES && <code>…and {outgoing.length - PREVIEW_LINES} more</code>}
          </span>
        </p>
      )}

      {error !== null && <p class="status error">{error}</p>}

      {(asking || spoken !== "") && (
        <div class="find">
          {spoken === "" ? (
            <span class="dots" aria-label="waiting for the model">
              ···
            </span>
          ) : (
            renderMarkdown(spoken)
          )}
          {named.length > 0 && (
            <div class="find-matches">
              {named.map((summary) => (
                <button
                  class="button"
                  key={summary.id}
                  {...{ [ACTION_ATTR]: "history-match" }}
                  title={`Open: ${summary.title}`}
                  onClick={() => actions.openConversation(summary.id)}
                >
                  {summary.title}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {list === null ? (
        <p class="status">{busy ? "Reading your saved conversations…" : ""}</p>
      ) : summaries.length === 0 ? (
        <p class="status">
          Every conversation you have with Kibitz is kept here: the messages you asked about, the answers, and your
          follow-ups. Ask about a message and the first answer saves it — nothing is ever removed unless you delete it.
        </p>
      ) : filtered.length === 0 ? (
        <p class="status">
          Nothing in your saved conversations contains those words. Press <strong>Ask</strong> to have the model look
          for what you mean instead.
        </p>
      ) : (
        <ul class="entries">
          {filtered.map((summary) => (
            <Entry summary={summary} actions={actions} key={summary.id} />
          ))}
        </ul>
      )}

      {summaries.length > 0 && (
        <div class="toolbar">
          <span class="scan-label">
            {filtered.length === summaries.length
              ? `${summaries.length} saved`
              : `${filtered.length} of ${summaries.length} saved`}
          </span>
          <span class="spacer" />
          {confirmingClear ? (
            <>
              <span class="scan-label">Delete all {summaries.length}? This cannot be undone.</span>
              <button
                class="button danger"
                {...{ [ACTION_ATTR]: "history-clear-confirm" }}
                onClick={actions.clearConversations}
              >
                Delete all
              </button>
              <button
                class="button"
                {...{ [ACTION_ATTR]: "history-clear-cancel" }}
                onClick={() => actions.confirmClearConversations(false)}
              >
                Keep them
              </button>
            </>
          ) : (
            <button
              class="button"
              {...{ [ACTION_ATTR]: "history-clear" }}
              onClick={() => actions.confirmClearConversations(true)}
            >
              Delete all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export const historyView: PanelView = {
  id: "history",
  title: "History",
  icon: "🕘",
  available: () => true,
  render: (ctx) => <HistoryView ctx={ctx} />,
};
