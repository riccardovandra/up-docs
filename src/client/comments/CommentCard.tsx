import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { Comment } from "../../shared/protocol.ts";
import { AGENT_AUTHOR_PREFIX, isAgentAuthor, type CommentThread } from "../../shared/threads.ts";

export const authorLabel = (author: string) =>
  isAgentAuthor(author) ? author.slice(AGENT_AUTHOR_PREFIX.length) : "You";

const formatTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

function CommentEntry(props: { readonly comment: Comment; readonly onDelete?: () => void }) {
  return (
    <div className="comment-entry">
      <div className="comment-meta">
        <span
          className={
            isAgentAuthor(props.comment.author) ? "comment-author agent" : "comment-author"
          }
        >
          {authorLabel(props.comment.author)}
        </span>
        <span className="muted">{formatTime(props.comment.createdAt)}</span>
        {props.onDelete ? (
          <button
            type="button"
            className="link-button comment-entry-delete"
            onClick={props.onDelete}
          >
            Delete
          </button>
        ) : null}
      </div>
      <p className="comment-body">{props.comment.body}</p>
    </div>
  );
}

/**
 * A textarea that submits on Cmd/Ctrl+Enter and cancels on Escape. With
 * `offerAddToChat`, an "Add to chat" box rides along; with `offerSendToAgent`,
 * a "Send to agent" box. Send to agent is ticked by default and then Add to
 * chat is not, so one comment does not reach two agents.
 */
export function CommentComposer(props: {
  readonly placeholder: string;
  readonly submitLabel: string;
  readonly autoFocus?: boolean;
  readonly offerAddToChat?: boolean;
  readonly offerSendToAgent?: boolean;
  readonly onSubmit: (body: string, addToChat: boolean, sendToAgent: boolean) => Promise<unknown>;
  readonly onCancel?: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [addToChat, setAddToChat] = useState(!props.offerSendToAgent);
  const [sendToAgent, setSendToAgent] = useState(true);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // Not the autoFocus attribute: it focuses during commit, before the margin has
  // positioned the card, so the browser scrolls to the card's unplaced spot at
  // the top of the doc. The card ends up beside the passage, which is on screen.
  useEffect(() => {
    if (props.autoFocus) textarea.current?.focus({ preventScroll: true });
  }, [props.autoFocus]);
  const submit = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await props.onSubmit(
        text,
        !!props.offerAddToChat && addToChat,
        !!props.offerSendToAgent && sendToAgent,
      );
      setBody("");
    } catch {
      // The page reports the failure; the text stays so it can be resent.
    } finally {
      setBusy(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape") {
      props.onCancel?.();
    }
  };
  return (
    <form
      className="comment-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={textarea}
        value={body}
        rows={2}
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {props.offerAddToChat ? (
        <label className="comment-add-to-chat">
          <input
            type="checkbox"
            checked={addToChat}
            onChange={(event) => setAddToChat(event.target.checked)}
          />
          Add to chat
        </label>
      ) : null}
      {props.offerSendToAgent ? (
        <label className="comment-add-to-chat">
          <input
            type="checkbox"
            checked={sendToAgent}
            onChange={(event) => setSendToAgent(event.target.checked)}
          />
          Send to agent
        </label>
      ) : null}
      <div className="comment-actions">
        <button type="submit" className="button small" disabled={busy || !body.trim()}>
          {props.submitLabel}
        </button>
        {props.onCancel ? (
          <button type="button" className="link-button" onClick={props.onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** Commenting actions; absent for readers who may only view the thread. */
export interface ThreadHandlers {
  readonly onReply?: (body: string, sendToAgent: boolean) => Promise<unknown>;
  /** Offers "Send to agent" on replies, for a source with a doc agent to ask. */
  readonly offerSendToAgent?: boolean;
  readonly onResolve?: () => void;
  readonly onDelete?: (commentId: string) => void;
  /** Present only when T3 Code can add the thread to its chat. */
  readonly onAddToChat?: () => void;
}

/** One thread in the margin. Inactive cards stay compact; the active one shows replies and actions. */
export function CommentCard(
  props: ThreadHandlers & {
    readonly thread: CommentThread;
    readonly anchored: boolean;
    readonly active: boolean;
    readonly onActivate: () => void;
  },
) {
  const { root, replies } = props.thread;
  return (
    <article
      className={props.active ? "comment-card active" : "comment-card"}
      data-comment-id={root.id}
      onClick={props.active ? undefined : props.onActivate}
    >
      {props.anchored ? null : (
        <p className="comment-detached">
          {root.anchor ? "Removed from the table" : "Text removed"}
          {root.quote ? (
            <>
              : <q>{root.quote}</q>
            </>
          ) : null}
        </p>
      )}
      <CommentEntry comment={root} />
      {props.active ? (
        <>
          {replies.map((reply) => (
            <CommentEntry
              key={reply.id}
              comment={reply}
              {...(props.onDelete ? { onDelete: () => props.onDelete?.(reply.id) } : {})}
            />
          ))}
          {props.onReply ? (
            <CommentComposer
              placeholder="Reply"
              submitLabel="Reply"
              offerSendToAgent={!!props.offerSendToAgent}
              onSubmit={(body, _addToChat, sendToAgent) => props.onReply!(body, sendToAgent)}
            />
          ) : null}
          <div className="comment-actions">
            {props.onResolve ? (
              <button type="button" className="link-button" onClick={props.onResolve}>
                Resolve
              </button>
            ) : null}
            {props.onAddToChat ? (
              <button type="button" className="link-button" onClick={props.onAddToChat}>
                Add to chat
              </button>
            ) : null}
            {props.onDelete ? (
              <button
                type="button"
                className="link-button danger"
                onClick={() => props.onDelete?.(root.id)}
              >
                Delete thread
              </button>
            ) : null}
          </div>
        </>
      ) : replies.length > 0 ? (
        <p className="comment-reply-count muted">
          {replies.length === 1 ? "1 reply" : `${replies.length} replies`}
        </p>
      ) : null}
    </article>
  );
}
