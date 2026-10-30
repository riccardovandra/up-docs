import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

import type { CommentThread } from "../../shared/threads.ts";
import { authorLabel, CommentCard, CommentComposer, type ThreadHandlers } from "./CommentCard.tsx";
import { layoutCommentCards } from "./layout.ts";

export const DRAFT_COMMENT_ID = "draft";

/**
 * The comment column beside the editor. On wide layouts every open thread on
 * the tab is a card beside its passage; on narrow ones threads collapse to
 * markers and only the active thread (or the draft) opens as a card. Threads
 * whose passage is gone sit after the anchored ones.
 */
export function CommentMargin(props: {
  readonly threads: ReadonlyArray<CommentThread>;
  readonly tops: ReadonlyMap<string, number>;
  readonly activeId: string | null;
  readonly narrow: boolean;
  /**
   * Where to offer "Comment" in the margin, for picks the selection toolbar
   * does not cover (diagram labels).
   */
  readonly selectionTop: number | null;
  readonly draftOpen: boolean;
  /** Offers "Add to chat" on the draft, for a T3 Code that can take it. */
  readonly offerAddToChat: boolean;
  /** Offers "Send to agent" on the draft, for a source with a doc agent to ask. */
  readonly offerSendToAgent?: boolean;
  readonly onStartComment: () => void;
  readonly onSubmitDraft: (
    body: string,
    addToChat: boolean,
    sendToAgent: boolean,
  ) => Promise<unknown>;
  readonly onCancelDraft: () => void;
  readonly onActivate: (id: string | null) => void;
  readonly handlersFor: (thread: CommentThread) => ThreadHandlers;
}) {
  const marginRef = useRef<HTMLDivElement>(null);
  const lastAnchoredTop = Math.max(0, ...props.tops.values());
  const anchorTopOf = (id: string) => props.tops.get(id) ?? lastAnchoredTop + 1;

  // Cards are positioned after they render, since their heights decide the layout.
  const latest = useRef({ anchorTopOf, activeId: props.activeId });
  useLayoutEffect(() => {
    latest.current = { anchorTopOf, activeId: props.activeId };
  });
  const relayout = useRef(() => {
    const margin = marginRef.current;
    if (!margin) return;
    const cards = [...margin.querySelectorAll<HTMLElement>(":scope > [data-comment-id]")];
    const tops = layoutCommentCards(
      cards.map((card) => ({
        id: card.dataset.commentId!,
        anchorTop: latest.current.anchorTopOf(card.dataset.commentId!),
        height: card.offsetHeight,
      })),
      latest.current.activeId,
    );
    for (const card of cards) card.style.top = `${tops.get(card.dataset.commentId!) ?? 0}px`;
  });
  useLayoutEffect(() => relayout.current());
  useEffect(() => {
    const margin = marginRef.current;
    if (!margin) return;
    // Cards change height as replies are typed.
    const observer = new ResizeObserver(() => relayout.current());
    const observeCards = () => {
      observer.disconnect();
      for (const card of margin.querySelectorAll(":scope > [data-comment-id]")) {
        observer.observe(card);
      }
    };
    observeCards();
    const mutations = new MutationObserver(observeCards);
    mutations.observe(margin, { childList: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, []);

  const cards: Array<ReactNode> = [];
  if (props.draftOpen) {
    cards.push(
      <article
        key={DRAFT_COMMENT_ID}
        className="comment-card active"
        data-comment-id={DRAFT_COMMENT_ID}
      >
        <CommentComposer
          placeholder="Add a comment"
          submitLabel="Comment"
          autoFocus
          offerAddToChat={props.offerAddToChat}
          offerSendToAgent={!!props.offerSendToAgent}
          onSubmit={props.onSubmitDraft}
          onCancel={props.onCancelDraft}
        />
      </article>,
    );
  }
  for (const thread of props.threads) {
    const id = thread.root.id;
    if (props.narrow && id !== props.activeId) continue;
    cards.push(
      <CommentCard
        key={id}
        thread={thread}
        anchored={props.tops.has(id)}
        active={id === props.activeId}
        onActivate={() => props.onActivate(id)}
        {...props.handlersFor(thread)}
      />,
    );
  }

  return (
    <div
      ref={marginRef}
      className={props.narrow ? "comment-margin narrow" : "comment-margin"}
      aria-label="Comments"
    >
      {props.narrow
        ? props.threads.map((thread) => (
            <button
              key={`marker-${thread.root.id}`}
              type="button"
              className={
                thread.root.id === props.activeId ? "comment-marker active" : "comment-marker"
              }
              style={{ top: anchorTopOf(thread.root.id) }}
              aria-label={`Comment by ${authorLabel(thread.root.author)}`}
              onClick={() =>
                props.onActivate(thread.root.id === props.activeId ? null : thread.root.id)
              }
            >
              {thread.replies.length + 1}
            </button>
          ))
        : null}
      {props.selectionTop !== null && !props.draftOpen ? (
        <button
          type="button"
          className="comment-add"
          style={{ top: props.selectionTop }}
          aria-label="Comment (Cmd+Option+M)"
          // Keep the editor's selection: focus must not leave it before the click lands.
          onMouseDown={(event) => event.preventDefault()}
          onClick={props.onStartComment}
        >
          {props.narrow ? "+" : "Comment"}
        </button>
      ) : null}
      {cards}
    </div>
  );
}
