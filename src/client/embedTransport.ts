import { NATIVE_HOST_EVENT, NATIVE_READY_TYPE } from "../host/docsCloudNative.ts";

import { isAllowedEmbedOrigin, type EmbedFrameMessage } from "../shared/embed.ts";

/** How messages reach the T3 Code that hosts this page, and how its messages arrive. */
export interface EmbedTransport {
  /** Framed on web and desktop, or the mobile app's WebView. */
  readonly kind: "frame" | "native";
  /**
   * Calls `onMessage` with each host message and the origin it came from;
   * delivery is already limited to the host this transport trusts.
   */
  readonly listen: (onMessage: (data: unknown, origin: string) => void) => void;
  /** Sends to the host at `origin`, the one that said hello. */
  readonly post: (message: EmbedFrameMessage, origin: string) => void;
}

interface NativeWebView {
  readonly postMessage: (data: string) => void;
}

/** The parts of `window` the transports use, so they can be tested without a DOM. */
export interface EmbedWindow {
  readonly parent: unknown;
  readonly location: { readonly origin: string };
  readonly ReactNativeWebView?: NativeWebView | undefined;
  readonly addEventListener: (type: string, listener: (event: Event) => void) => void;
}

/**
 * The transport for where this page runs: framed by T3 Code on web and
 * desktop, top-level in the T3 Code mobile app's WebView, or neither (a plain
 * browser tab), where there is no host and this returns null.
 */
export function embedTransport(
  win: EmbedWindow,
  frameSources: ReadonlyArray<string>,
): EmbedTransport | null {
  if (win.parent !== win) return frameTransport(win, frameSources);
  const native = win.ReactNativeWebView;
  return native && typeof native.postMessage === "function" ? nativeTransport(win, native) : null;
}

/**
 * The browser already refuses framing by origins outside FRAME_ANCESTORS;
 * messages are still checked against the same list, and replies go only to
 * the origin that said hello.
 */
function frameTransport(win: EmbedWindow, sources: ReadonlyArray<string>): EmbedTransport {
  const parent = win.parent as { postMessage: (message: unknown, origin: string) => void };
  return {
    kind: "frame",
    listen: (onMessage) =>
      win.addEventListener("message", (event) => {
        const { source, origin, data } = event as MessageEvent;
        if (source !== parent || !isAllowedEmbedOrigin(origin, sources)) return;
        onMessage(data, origin);
      }),
    post: (message, origin) => parent.postMessage(message, origin),
  };
}

/**
 * The mobile app injects its messages as a CustomEvent, which no other
 * window can raise; see `src/host/docsCloudNative.ts`. They count as
 * coming from this page's own origin.
 */
function nativeTransport(win: EmbedWindow, native: NativeWebView): EmbedTransport {
  return {
    kind: "native",
    listen: (onMessage) => {
      win.addEventListener(NATIVE_HOST_EVENT, (event) => {
        onMessage((event as CustomEvent).detail, win.location.origin);
      });
      // React Native's bridge takes one string; there is no target origin to give.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      native.postMessage(JSON.stringify({ type: NATIVE_READY_TYPE }));
    },
    post: (message) =>
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- React Native's bridge, not a window
      native.postMessage(JSON.stringify(message)),
  };
}
