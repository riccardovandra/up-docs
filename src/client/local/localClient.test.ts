import { describe, expect, it, vi } from "vitest";

import type { EmbedFrameMessage, EmbedParentMessage } from "../../shared/embed.ts";
import { createLocalClient, LocalRequestError } from "./localClient.ts";

function fakeBridge() {
  const sent: Array<EmbedFrameMessage> = [];
  const listeners = new Set<(message: EmbedParentMessage) => void>();
  return {
    sent,
    bridge: {
      post: (message: EmbedFrameMessage) => sent.push(message),
      subscribe: (listener: (message: EmbedParentMessage) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    deliver: (message: EmbedParentMessage) => {
      for (const listener of listeners) listener(message);
    },
  };
}

const requestIdOf = (message: EmbedFrameMessage | undefined) =>
  message?.type === "t3-docs:local-request" ? message.requestId : "";

/** Fake timers for one test, restored when it ends. */
function fakeTimers() {
  vi.useFakeTimers();
  return { [Symbol.dispose]: () => vi.useRealTimers() };
}

describe("createLocalClient", () => {
  it("resolves a request with the matching, well formed answer", async () => {
    const host = fakeBridge();
    const client = createLocalClient(host.bridge);
    const pending = client.request({ kind: "files.list" });
    const requestId = requestIdOf(host.sent[0]);
    host.deliver({ type: "t3-docs:local-response", requestId: "other", ok: true, result: {} });
    host.deliver({
      type: "t3-docs:local-response",
      requestId,
      ok: true,
      result: { files: [{ path: "docs/a.md", title: "a" }] },
    });
    await expect(pending).resolves.toEqual({
      files: [{ path: "docs/a.md", title: "a", cloudDocId: null }],
    });
  });

  it("rejects an error reply and an answer of the wrong shape", async () => {
    const host = fakeBridge();
    const client = createLocalClient(host.bridge);
    const refused = client.request({ kind: "file.read", path: "docs/a.md" });
    host.deliver({
      type: "t3-docs:local-response",
      requestId: requestIdOf(host.sent[0]),
      ok: false,
      error: "This connection cannot read files.",
    });
    await expect(refused).rejects.toThrow("This connection cannot read files.");

    const malformed = client.request({ kind: "file.read", path: "docs/a.md" });
    host.deliver({
      type: "t3-docs:local-response",
      requestId: requestIdOf(host.sent[1]),
      ok: true,
      result: { path: ".repos/a.md", markdown: "", version: "v", readOnlyReason: null },
    });
    await expect(malformed).rejects.toBeInstanceOf(LocalRequestError);
  });

  it("fails a request the host never answers", async () => {
    using _timers = fakeTimers();
    const client = createLocalClient(fakeBridge().bridge);
    const pending = client.request({ kind: "files.list" });
    const settled = expect(pending).rejects.toThrow("did not answer");
    await vi.runAllTimersAsync();
    await settled;
  });

  it("passes on the host's files-changed notice", () => {
    const host = fakeBridge();
    const client = createLocalClient(host.bridge);
    const changed = vi.fn();
    const stop = client.onFilesChanged(changed);
    host.deliver({ type: "t3-docs:local-files-changed" });
    stop();
    host.deliver({ type: "t3-docs:local-files-changed" });
    expect(changed).toHaveBeenCalledOnce();
  });

  it("passes on the host's comments-changed notice to comment listeners only", () => {
    const host = fakeBridge();
    const client = createLocalClient(host.bridge);
    const files = vi.fn();
    const comments = vi.fn();
    client.onFilesChanged(files);
    client.onCommentsChanged(comments);
    host.deliver({ type: "t3-docs:local-comments-changed" });
    expect(comments).toHaveBeenCalledOnce();
    expect(files).not.toHaveBeenCalled();
  });
});
