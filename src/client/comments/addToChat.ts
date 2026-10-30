import type { EmbedCommentForChat } from "../../shared/embed.ts";

type Handler = (comment: EmbedCommentForChat) => void;

let handler: Handler | null = null;
const listeners = new Set<() => void>();

/**
 * The seam for adding a comment to the chat of the T3 Code conversation the
 * Docs panel sits beside. The embed bridge installs a handler when T3 Code
 * offers it; otherwise "Add to chat" stays hidden. Returns an unregister
 * function.
 */
export function setAddToChatHandler(next: Handler): () => void {
  handler = next;
  for (const listener of listeners) listener();
  return () => {
    if (handler !== next) return;
    handler = null;
    for (const listener of listeners) listener();
  };
}

export const hasAddToChatHandler = () => handler !== null;

export function subscribeAddToChat(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function addCommentToChat(comment: EmbedCommentForChat): void {
  handler?.(comment);
}
