import type { Comment } from "./protocol.ts";

export interface CommentThread {
  readonly root: Comment;
  readonly replies: ReadonlyArray<Comment>;
}

export const AGENT_AUTHOR_PREFIX = "agent:";

export const isAgentAuthor = (author: string) => author.startsWith(AGENT_AUTHOR_PREFIX);

/** Threads in creation order, each root with its replies in creation order. */
export function groupThreads(comments: Iterable<Comment>): ReadonlyArray<CommentThread> {
  const sorted = [...comments].toSorted(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  const replies = new Map<string, Array<Comment>>();
  for (const comment of sorted) {
    if (comment.parentId === null) continue;
    const list = replies.get(comment.parentId) ?? [];
    list.push(comment);
    replies.set(comment.parentId, list);
  }
  return sorted
    .filter((comment) => comment.parentId === null)
    .map((root) => ({ root, replies: replies.get(root.id) ?? [] }));
}
