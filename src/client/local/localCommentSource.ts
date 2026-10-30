import {
  MAX_LOCAL_CONTEXT_LENGTH,
  MAX_LOCAL_QUOTE_LENGTH,
  type LocalDocComment,
  type LocalDocComments,
} from "../../host/docsCloudLocal.ts";

import type { Comment } from "../../shared/protocol.ts";
import { AGENT_AUTHOR_PREFIX } from "../../shared/threads.ts";
import type { CommentSource, CommentUpdate } from "../comments/commentSource.ts";
import type { LocalClient } from "./localClient.ts";

/** The doc agent's name in the margin. */
const AGENT_AUTHOR = `${AGENT_AUTHOR_PREFIX}Agent`;

/**
 * A project file's comment in the margin's shape. The file is its own doc and
 * only tab; a project file has no tables or diagrams to anchor to by id.
 */
export function toMarginComment(path: string, comment: LocalDocComment): Comment {
  return {
    id: comment.id,
    docId: path,
    tabId: path,
    parentId: comment.parentId,
    quote: comment.quote,
    prefix: comment.prefix,
    suffix: comment.suffix,
    anchor: null,
    body: comment.body,
    author: comment.author === "agent" ? AGENT_AUTHOR : "user",
    resolvedAt: comment.resolvedAt,
    createdAt: comment.createdAt,
    updatedAt: Math.max(comment.createdAt, comment.resolvedAt ?? 0),
  };
}

const replace = (path: string, state: LocalDocComments) =>
  ({
    kind: "replace",
    comments: state.comments.map((comment) => toMarginComment(path, comment)),
    capabilities: { comment: state.canComment, sendToAgent: state.canSendToAgent },
  }) satisfies CommentUpdate;

// The T3 server keeps shorter anchors than a long selection can make; a
// shortened quote still finds the start of its passage.
const clip = (text: string, max: number, fromEnd = false) =>
  text.length <= max ? text : fromEnd ? text.slice(-max) : text.slice(0, max);

/**
 * Comments on a project file, kept by the T3 server and reached through the
 * host. Every answer is the file's whole list, so the page just replaces it.
 */
export function localCommentSource(
  client: LocalClient,
  path: string,
): CommentSource & { readonly subscribe: (onChange: () => void) => () => void } {
  return {
    load: async () => replace(path, await client.request({ kind: "comments.list", path })),
    create: async ({ anchor, body, sendToAgent }) => {
      const result = await client.request({
        kind: "comment.create",
        path,
        quote: clip(anchor.quote, MAX_LOCAL_QUOTE_LENGTH),
        prefix: clip(anchor.prefix, MAX_LOCAL_CONTEXT_LENGTH, true),
        suffix: clip(anchor.suffix, MAX_LOCAL_CONTEXT_LENGTH),
        body,
        sendToAgent,
      });
      const update = replace(path, result);
      const comment = update.comments.find((entry) => entry.id === result.commentId);
      if (!comment) throw new Error("T3 Code did not return the new comment.");
      return { comment, update };
    },
    reply: async (commentId, body, sendToAgent) =>
      replace(
        path,
        await client.request({ kind: "comment.reply", path, commentId, body, sendToAgent }),
      ),
    setResolved: async (commentId, resolved) =>
      replace(path, await client.request({ kind: "comment.resolve", path, commentId, resolved })),
    delete: async (commentId) =>
      replace(path, await client.request({ kind: "comment.delete", path, commentId })),
    subscribe: client.onCommentsChanged,
  };
}
