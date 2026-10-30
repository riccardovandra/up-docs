import { useSyncExternalStore } from "react";

import {
  EMBED_ORIGINS_META,
  EMBED_PROTOCOL_VERSION,
  isNewerEmbedHost,
  parseParentMessage,
  titleProjectKey,
  type EmbedFeature,
  type EmbedFrameMessage,
  type EmbedParentMessage,
} from "../shared/embed.ts";
import { api } from "./api.ts";
import { setAddToChatHandler } from "./comments/addToChat.ts";
import { setEmbedProject } from "./embedContext.ts";
import { embedTransport, type EmbedTransport } from "./embedTransport.ts";
import { setTabsProject } from "./openTabs.ts";
import { navigate, parseRoute, subscribePathname } from "./router.ts";
import { applyTheme } from "./theme.ts";

let transport: EmbedTransport | null = null;
let parentOrigin: string | null = null;
/** What the T3 Code that said hello offers beyond navigation. */
let features: ReadonlyArray<EmbedFeature> = [];
let newerHost = false;
const parentListeners = new Set<() => void>();
const messageListeners = new Set<(message: EmbedParentMessage) => void>();
let removeAddToChat: (() => void) | null = null;

/**
 * True when T3 Code hosts this page (framed, or in the mobile app), known
 * from the start; features still wait for its hello.
 */
export function isEmbedded(): boolean {
  return transport !== null;
}

/** True inside the T3 Code mobile app, which has no web-only dialogs such as Copy to Claude Docs. */
export function isNativeEmbed(): boolean {
  return transport?.kind === "native";
}

/** True once T3 Code has said hello, so features that need it can show. */
export function hasEmbedParent(): boolean {
  return parentOrigin !== null;
}

export function subscribeEmbedParent(listener: () => void): () => void {
  parentListeners.add(listener);
  return () => parentListeners.delete(listener);
}

/** Sends to the T3 Code that said hello; a no-op outside T3 Code. */
export function postToEmbedParent(message: EmbedFrameMessage): void {
  if (transport && parentOrigin) transport.post(message, parentOrigin);
}

const embedFeatures = () => (parentOrigin === null ? null : features);

/** The embedding T3 Code's features; null outside T3 Code or before its hello. */
export function useEmbedFeatures(): ReadonlyArray<EmbedFeature> | null {
  return useSyncExternalStore(subscribeEmbedParent, embedFeatures);
}

const embedHostIsNewer = () => newerHost;

/** True when the T3 Code that said hello speaks a newer embed protocol than this app. */
export function useNewerEmbedHost(): boolean {
  return useSyncExternalStore(subscribeEmbedParent, embedHostIsNewer);
}

/** Parent messages a page reacts to (`threads`, `sent-to`). */
export function subscribeParentMessages(
  listener: (message: EmbedParentMessage) => void,
): () => void {
  messageListeners.add(listener);
  return () => messageListeners.delete(listener);
}

function installAddToChat(enabled: boolean): void {
  removeAddToChat?.();
  removeAddToChat = enabled
    ? setAddToChatHandler((comment) =>
        postToEmbedParent({ type: "t3-docs:add-comment-to-chat", ...comment }),
      )
    : null;
}

/**
 * Lets T3 Code drive this app: from the Docs panel that frames it on web and
 * desktop, or from the mobile app's WebView. See `embedTransport`.
 */
export function startEmbedBridge(): void {
  const sources = (
    document.querySelector(`meta[name="${EMBED_ORIGINS_META}"]`)?.getAttribute("content") ?? ""
  )
    .split(" ")
    .filter(Boolean);
  transport = embedTransport(window, sources);
  if (!transport) return;

  const postLocation = () => {
    const path = window.location.pathname;
    const route = parseRoute(path);
    postToEmbedParent({
      type: "t3-docs:location",
      path,
      docId: route.name === "doc" ? route.docId : null,
      tabId: route.name === "doc" ? route.tabId : null,
      localPath: route.name === "local" ? route.path : null,
      protocolVersion: EMBED_PROTOCOL_VERSION,
    });
  };

  transport.listen((data, origin) => {
    const message = parseParentMessage(data);
    if (!message) return;
    if (message.type === "t3-docs:hello") {
      const next = message.features ?? [];
      const newer = isNewerEmbedHost(message);
      const changed =
        parentOrigin !== origin || next.join(" ") !== features.join(" ") || newer !== newerHost;
      parentOrigin = origin;
      features = next;
      newerHost = newer;
      installAddToChat(next.includes("add-to-chat"));
      if (changed) for (const listener of parentListeners) listener();
      postLocation();
      return;
    }
    if (!parentOrigin) return;
    if (message.type === "t3-docs:navigate") {
      navigate(message.path);
    } else if (message.type === "t3-docs:context") {
      setEmbedProject(
        message.projectName === null
          ? null
          : { name: message.projectName, key: message.projectKey },
      );
      setTabsProject(
        message.projectName === null
          ? ""
          : (message.projectKey ?? titleProjectKey(message.projectName)),
      );
    } else if (message.type === "t3-docs:theme") {
      applyTheme(message);
    } else if (message.type === "t3-docs:link-thread") {
      const { docId, environmentId, threadId, title } = message;
      // Acknowledged only once stored, so T3 Code retries a link that failed.
      void api.linkThread(docId, { environmentId, threadId, title }).then(
        () => postToEmbedParent({ type: "t3-docs:thread-linked", docId, environmentId, threadId }),
        () => undefined,
      );
    }
    for (const listener of messageListeners) listener(message);
  });
  subscribePathname(postLocation);
}
