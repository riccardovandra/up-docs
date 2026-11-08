// Talks to the Send to Scribe browser extension, which emails a book to a
// Kindle from the reader's own Gmail. Its content script marks the page when
// it is installed and relays window messages to the extension:
//
//   page -> extension  { source: "up-docs", type: "send-to-scribe:send", requestId, book }
//   extension -> page  { source: "send-to-scribe", type: "send-to-scribe:result", requestId, ok, error }

import type { ScribeBook } from "./scribeBook.ts";

const READY_ATTRIBUTE = "data-send-to-scribe";
const READY_EVENT = "send-to-scribe:ready";
/** Building the EPUB, converting images and the Gmail upload all happen before the reply. */
const SEND_TIMEOUT_MS = 180_000;

export const scribeAvailable = (): boolean =>
  typeof document !== "undefined" && document.documentElement.hasAttribute(READY_ATTRIBUTE);

/** For useSyncExternalStore: the content script can mark the page after the app renders. */
export function subscribeScribe(onChange: () => void): () => void {
  document.addEventListener(READY_EVENT, onChange);
  return () => document.removeEventListener(READY_EVENT, onChange);
}

interface ScribeResult {
  readonly source: "send-to-scribe";
  readonly type: "send-to-scribe:result";
  readonly requestId: string;
  readonly ok: boolean;
  readonly error?: string;
}

function readResult(data: unknown, requestId: string): ScribeResult | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as Partial<ScribeResult>;
  return message.source === "send-to-scribe" &&
    message.type === "send-to-scribe:result" &&
    message.requestId === requestId
    ? (message as ScribeResult)
    : null;
}

/** Resolves once the extension has emailed the book; rejects with its reason. */
export function sendToScribe(book: ScribeBook): Promise<void> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error: string | null) => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (error === null) resolve();
      else reject(new Error(error));
    };
    const timer = setTimeout(
      () => finish("Send to Scribe did not answer. Check the extension's popup."),
      SEND_TIMEOUT_MS,
    );
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const result = readResult(event.data, requestId);
      if (result) finish(result.ok ? null : (result.error ?? "Send to Scribe failed."));
    };
    window.addEventListener("message", onMessage);
    window.postMessage(
      { source: "up-docs", type: "send-to-scribe:send", requestId, book },
      window.location.origin,
    );
  });
}
