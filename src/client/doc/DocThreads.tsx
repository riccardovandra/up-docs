import type { DocThreadLink } from "../../shared/protocol.ts";

export const threadKey = (thread: { environmentId: string; threadId: string }) =>
  `${thread.environmentId}\u0000${thread.threadId}`;

/**
 * T3 Code threads started from this doc. `openable` holds the ones the
 * embedding T3 Code can open, with their current titles; the rest show their
 * stored label only.
 */
export function DocThreads(props: {
  readonly threads: ReadonlyArray<DocThreadLink>;
  readonly openable: ReadonlyMap<string, string>;
  readonly onOpen: (thread: DocThreadLink) => void;
  readonly onUnlink: (linkId: string) => void;
}) {
  if (props.threads.length === 0) return null;
  return (
    <details className="export-menu doc-threads">
      <summary>Threads ({props.threads.length})</summary>
      <div className="export-menu-items doc-thread-list">
        {props.threads.map((thread) => {
          const liveTitle = props.openable.get(threadKey(thread));
          return (
            <div key={thread.id} className="doc-thread-item">
              {liveTitle === undefined ? (
                <span className="doc-thread-label">{thread.title}</span>
              ) : (
                <button type="button" onClick={() => props.onOpen(thread)}>
                  {liveTitle}
                </button>
              )}
              <button
                type="button"
                className="doc-thread-remove"
                aria-label={`Remove ${thread.title} from this doc`}
                onClick={() => props.onUnlink(thread.id)}
              >
                Remove
              </button>
            </div>
          );
        })}
      </div>
    </details>
  );
}
