import { useCallback, useMemo, useState } from "react";

import type { DocAnchor, StructuredAnchor } from "../../shared/anchors.ts";
import type { Comment, RoomMessage } from "../../shared/protocol.ts";
import {
  cloudCommentSource,
  type CommentCapabilities,
  type CommentSource,
  type CommentUpdate,
} from "./commentSource.ts";

type CommentMessage = Extract<RoomMessage, { type: `comment.${string}` }>;

export const isCommentMessage = (message: RoomMessage): message is CommentMessage =>
  message.type.startsWith("comment.");

/** A cloud doc's comments, kept current from REST responses and DocRoom pushes. */
export function useComments(docId: string) {
  return useCommentSource(useMemo(() => cloudCommentSource(docId), [docId]));
}

/**
 * A page's comments from any source. Every update is an idempotent upsert,
 * delete or full replacement, so our own echoes apply harmlessly.
 */
export function useCommentSource(source: CommentSource) {
  const [comments, setComments] = useState<ReadonlyMap<string, Comment>>(new Map());
  const [capabilities, setCapabilities] = useState<CommentCapabilities | null>(null);

  const update = useCallback((change: CommentUpdate) => {
    if (change.kind === "replace") {
      setComments(new Map(change.comments.map((comment) => [comment.id, comment])));
      setCapabilities(change.capabilities);
      return;
    }
    if (change.kind === "remove") {
      setComments((current) => {
        if (!change.ids.some((id) => current.has(id))) return current;
        const next = new Map(current);
        for (const id of change.ids) next.delete(id);
        return next;
      });
      return;
    }
    const { comment } = change;
    setComments((current) => {
      const existing = current.get(comment.id);
      if (existing && existing.updatedAt > comment.updatedAt) return current;
      return new Map(current).set(comment.id, comment);
    });
  }, []);

  const load = useCallback(async () => update(await source.load()), [source, update]);

  const apply = useCallback(
    (message: CommentMessage) =>
      update(
        message.type === "comment.deleted"
          ? { kind: "remove", ids: message.commentIds }
          : { kind: "upsert", comment: message.comment },
      ),
    [update],
  );

  const actions = {
    create: async (
      tabId: string,
      anchor: DocAnchor,
      body: string,
      structured: StructuredAnchor | null = null,
      sendToAgent = false,
    ) => {
      const created = await source.create({ tabId, anchor, body, structured, sendToAgent });
      update(created.update);
      return created.comment;
    },
    reply: async (commentId: string, body: string, sendToAgent = false) =>
      update(await source.reply(commentId, body, sendToAgent)),
    setResolved: async (commentId: string, resolved: boolean) =>
      update(await source.setResolved(commentId, resolved)),
    delete: async (commentId: string) => update(await source.delete(commentId)),
  };

  return { comments, capabilities, load, apply, actions };
}

export type CommentActions = ReturnType<typeof useCommentSource>["actions"];
