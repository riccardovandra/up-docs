import type { DocAnchor, StructuredAnchor } from "../../shared/anchors.ts";
import type { Comment } from "../../shared/protocol.ts";
import { api } from "../api.ts";

/** What a source may allow beyond the page's own rules; null when it leaves that to the page. */
export interface CommentCapabilities {
  readonly comment: boolean;
  /** Comments can be sent to the T3 Code conversation's doc agent. */
  readonly sendToAgent: boolean;
}

/** How one action changed the comments the page holds. */
export type CommentUpdate =
  | { readonly kind: "upsert"; readonly comment: Comment }
  | { readonly kind: "remove"; readonly ids: ReadonlyArray<string> }
  | {
      readonly kind: "replace";
      readonly comments: ReadonlyArray<Comment>;
      readonly capabilities: CommentCapabilities | null;
    };

export interface NewComment {
  readonly tabId: string;
  readonly anchor: DocAnchor;
  readonly body: string;
  readonly structured: StructuredAnchor | null;
  readonly sendToAgent: boolean;
}

/**
 * Where a page's comments live. A cloud doc's are in UP Docs and also
 * arrive as DocRoom pushes; a project file's are on the T3 server, reached
 * through the T3 Code window framing this app.
 */
export interface CommentSource {
  readonly load: () => Promise<Extract<CommentUpdate, { kind: "replace" }>>;
  readonly create: (
    input: NewComment,
  ) => Promise<{ readonly comment: Comment; readonly update: CommentUpdate }>;
  readonly reply: (commentId: string, body: string, sendToAgent: boolean) => Promise<CommentUpdate>;
  readonly setResolved: (commentId: string, resolved: boolean) => Promise<CommentUpdate>;
  readonly delete: (commentId: string) => Promise<CommentUpdate>;
}

export function cloudCommentSource(docId: string): CommentSource {
  return {
    load: async () => ({
      kind: "replace",
      comments: (await api.comments(docId)).comments,
      capabilities: null,
    }),
    create: async ({ tabId, anchor, body, structured }) => {
      const { comment } = await api.createComment(tabId, {
        ...anchor,
        body,
        ...(structured ? { anchor: structured } : {}),
      });
      return { comment, update: { kind: "upsert", comment } };
    },
    reply: async (commentId, body) => ({
      kind: "upsert",
      comment: (await api.replyComment(commentId, body)).comment,
    }),
    setResolved: async (commentId, resolved) => ({
      kind: "upsert",
      comment: (await api.setCommentResolved(commentId, resolved)).comment,
    }),
    delete: async (commentId) => ({
      kind: "remove",
      ids: (await api.deleteComment(commentId)).commentIds,
    }),
  };
}
