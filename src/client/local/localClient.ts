import {
  LOCAL_COMMENTS_CHANGED_TYPE,
  LOCAL_FILES_CHANGED_TYPE,
  LOCAL_REQUEST_TYPE,
  LOCAL_RESPONSE_TYPE,
  parseLocalResult,
  type LocalDocRequest,
  type LocalDocRequestKind,
  type LocalDocResults,
} from "../../host/docsCloudLocal.ts";

import type { EmbedFrameMessage, EmbedParentMessage } from "../../shared/embed.ts";

/** How long the host has to answer before the request fails, so a stuck save never hangs. */
export const LOCAL_REQUEST_TIMEOUT_MS = 30_000;
// An import copies the file and each comment to UP Docs through the T3 server.
const IMPORT_TIMEOUT_MS = 120_000;

export class LocalRequestError extends Error {}

export interface LocalClient {
  readonly request: <K extends LocalDocRequestKind>(
    request: Extract<LocalDocRequest, { kind: K }>,
  ) => Promise<LocalDocResults[K]>;
  /** The host's notice that project files may have changed on disk. */
  readonly onFilesChanged: (listener: () => void) => () => void;
  /** The host's notice that comments on project files may have changed, e.g. an agent replied. */
  readonly onCommentsChanged: (listener: () => void) => () => void;
}

interface Pending {
  readonly kind: LocalDocRequestKind;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Requests to the T3 Code window over the embed bridge, matched to answers by id. */
export function createLocalClient(bridge: {
  readonly post: (message: EmbedFrameMessage) => void;
  readonly subscribe: (listener: (message: EmbedParentMessage) => void) => () => void;
}): LocalClient {
  const pending = new Map<string, Pending>();
  const changeListeners = new Set<() => void>();
  const commentListeners = new Set<() => void>();
  let unsubscribe: (() => void) | null = null;
  let counter = 0;

  const listen = () => {
    unsubscribe ??= bridge.subscribe((message) => {
      if (message.type === LOCAL_FILES_CHANGED_TYPE) {
        for (const listener of changeListeners) listener();
        return;
      }
      if (message.type === LOCAL_COMMENTS_CHANGED_TYPE) {
        for (const listener of commentListeners) listener();
        return;
      }
      if (message.type !== LOCAL_RESPONSE_TYPE) return;
      const waiting = pending.get(message.requestId);
      if (!waiting) return;
      pending.delete(message.requestId);
      clearTimeout(waiting.timer);
      if (!message.ok) {
        waiting.reject(new LocalRequestError(message.error));
        return;
      }
      const result = parseLocalResult(waiting.kind, message.result);
      if (result === null)
        waiting.reject(new LocalRequestError("T3 Code sent an unreadable answer."));
      else waiting.resolve(result);
    });
  };

  return {
    request: (request) => {
      listen();
      counter += 1;
      const requestId = `local-${counter}-${Math.random().toString(36).slice(2, 10)}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => {
            pending.delete(requestId);
            reject(new LocalRequestError("T3 Code did not answer. Try again."));
          },
          request.kind === "file.import" ? IMPORT_TIMEOUT_MS : LOCAL_REQUEST_TIMEOUT_MS,
        );
        pending.set(requestId, {
          kind: request.kind,
          resolve: resolve as (result: unknown) => void,
          reject,
          timer,
        });
        bridge.post({ type: LOCAL_REQUEST_TYPE, requestId, request });
      });
    },
    onFilesChanged: (listener) => {
      listen();
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    onCommentsChanged: (listener) => {
      listen();
      commentListeners.add(listener);
      return () => commentListeners.delete(listener);
    },
  };
}
