import { nativeHostScript } from "../host/docsCloudNative.ts";
import { describe, expect, it } from "vitest";

import { parseParentMessage } from "../shared/embed.ts";
import { embedTransport, type EmbedWindow } from "./embedTransport.ts";

const PAGE_ORIGIN = "https://docs.example.com";

function fakeWindow(options: { framed?: boolean; native?: boolean } = {}) {
  const listeners = new Map<string, Array<(event: Event) => void>>();
  const nativePosts: Array<unknown> = [];
  const parentPosts: Array<[unknown, string]> = [];
  const parent = {
    postMessage: (message: unknown, origin: string) => parentPosts.push([message, origin]),
  };
  const win: EmbedWindow & { parent: unknown } = {
    parent: null,
    location: { origin: PAGE_ORIGIN },
    ...(options.native
      ? {
          ReactNativeWebView: { postMessage: (data: string) => nativePosts.push(JSON.parse(data)) },
        }
      : {}),
    addEventListener: (type, listener) =>
      listeners.set(type, [...(listeners.get(type) ?? []), listener]),
  };
  win.parent = options.framed ? parent : win;
  const emit = (type: string, event: object) => {
    for (const listener of listeners.get(type) ?? []) listener(event as Event);
  };
  return { win, parent, emit, nativePosts, parentPosts };
}

/** Runs the app's injected script against the fake window, as the WebView would. */
function inject(win: EmbedWindow, emit: (type: string, event: object) => void, script: string) {
  const fakeWin = {
    dispatchEvent: (event: { type: string; detail: unknown }) => emit(event.type, event),
  };
  function FakeCustomEvent(type: string, init: { detail: unknown }) {
    return { type, detail: init.detail };
  }
  new Function("window", "location", "CustomEvent", script)(fakeWin, win.location, FakeCustomEvent);
}

describe("embedTransport", () => {
  it("has no host in a plain browser tab", () => {
    expect(embedTransport(fakeWindow().win, [PAGE_ORIGIN])).toBeNull();
  });

  it("takes framed messages only from the parent at an allowed origin", () => {
    const { win, parent, emit, parentPosts } = fakeWindow({ framed: true, native: true });
    const transport = embedTransport(win, ["https://app.t3.codes"])!;
    expect(transport.kind).toBe("frame");
    const received: Array<[unknown, string]> = [];
    transport.listen((data, origin) => received.push([data, origin]));
    const hello = { type: "t3-docs:hello" };
    emit("message", { source: parent, origin: "https://app.t3.codes", data: hello });
    emit("message", { source: parent, origin: "https://evil.example", data: hello });
    emit("message", { source: {}, origin: "https://app.t3.codes", data: hello });
    expect(received).toEqual([[hello, "https://app.t3.codes"]]);
    transport.post({ type: "t3-docs:resolve-threads", threads: [] }, "https://app.t3.codes");
    expect(parentPosts).toEqual([
      [{ type: "t3-docs:resolve-threads", threads: [] }, "https://app.t3.codes"],
    ]);
  });

  it("talks to the mobile app through its WebView when loaded top-level there", () => {
    const { win, emit, nativePosts } = fakeWindow({ native: true });
    const transport = embedTransport(win, [])!;
    expect(transport.kind).toBe("native");
    const received: Array<[unknown, string]> = [];
    transport.listen((data, origin) => received.push([data, origin]));
    // The page says it listens, so the app can say hello.
    expect(nativePosts).toEqual([{ type: "t3-docs:ready" }]);

    const hello = { type: "t3-docs:hello", features: ["local-files", "local-comments"] };
    inject(win, emit, nativeHostScript(PAGE_ORIGIN, hello));
    expect(received).toEqual([[hello, PAGE_ORIGIN]]);
    expect(parseParentMessage(received[0]![0])).toEqual(hello);

    transport.post(
      { type: "t3-docs:local-request", requestId: "r1", request: { kind: "files.list" } },
      PAGE_ORIGIN,
    );
    expect(nativePosts.at(-1)).toEqual({
      type: "t3-docs:local-request",
      requestId: "r1",
      request: { kind: "files.list" },
    });
  });

  it("drops an injected message once the page has left the UP Docs origin", () => {
    const { win, emit } = fakeWindow({ native: true });
    const transport = embedTransport(win, [])!;
    const received: Array<unknown> = [];
    transport.listen((data) => received.push(data));
    inject(win, emit, nativeHostScript("https://other.example", { type: "t3-docs:hello" }));
    expect(received).toEqual([]);
  });
});
