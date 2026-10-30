import type { Tab } from "../../shared/protocol.ts";
import type { CommentThread } from "../../shared/threads.ts";
import { authorLabel } from "./CommentCard.tsx";

/** The doc's resolved threads, across tabs, with the way back (reopen) and out (delete). */
export function ResolvedComments(props: {
  readonly threads: ReadonlyArray<CommentThread>;
  /** Names the tab each thread is on; a page without tabs leaves it out. */
  readonly tabs?: ReadonlyMap<string, Tab>;
  readonly onReopen: (commentId: string) => void;
  readonly onDelete: (commentId: string) => void;
}) {
  if (props.threads.length === 0) return null;
  return (
    <details className="export-menu resolved-comments">
      <summary>Resolved ({props.threads.length})</summary>
      <div className="export-menu-items resolved-list">
        {props.threads.map(({ root, replies }) => (
          <div key={root.id} className="resolved-item">
            <p className="muted resolved-where">
              {props.tabs ? `${props.tabs.get(root.tabId)?.title ?? "Tab"} · ` : null}
              <q>{root.quote}</q>
            </p>
            <p className="comment-body">
              <strong>{authorLabel(root.author)}:</strong> {root.body}
            </p>
            {replies.length > 0 ? (
              <p className="muted">
                {replies.length === 1 ? "1 reply" : `${replies.length} replies`}
              </p>
            ) : null}
            <div className="comment-actions">
              <button type="button" onClick={() => props.onReopen(root.id)}>
                Reopen
              </button>
              <button type="button" onClick={() => props.onDelete(root.id)}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}
