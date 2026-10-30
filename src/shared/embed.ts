/**
 * T3 Code embeds UP Docs in an iframe and talks to it over postMessage.
 *
 * Parent -> frame: `hello` (sent on every iframe load; the frame answers with
 * `location`; `features` lists what this T3 Code can do for the doc),
 * `navigate` (an app path such as `/d/:docId/:tabId`), `link-thread` (record a
 * thread started from a doc), `threads` (which linked threads it can open, with
 * their current titles), `context`
 * (the T3 Code project the panel belongs to, by key and name, after hello and
 * on change), `theme` (T3 Code's appearance and resolved palette, after hello
 * and on change; the mobile app sends the same message to the top-level page)
 * and `sent-to` (how a `send-to` went, with the new page's URL).
 * Frame -> parent: `location` after hello and on every route change,
 * `copy-to-claude-doc` (recreate the doc in Claude Docs), `start-work`,
 * `resolve-threads`, `open-thread`, `thread-linked` (the link-thread record is
 * stored), `add-comment-to-chat` (put a comment in the open conversation's
 * composer) and `send-to` (copy the doc into Notion through T3 Code's MCP
 * hub). Frame actions are only offered once a parent has said hello and listed
 * the feature. Every message is additive: an older peer ignores unknown types.
 *
 * With `local-files`, the frame also opens the T3 project's markdown files:
 * `local-request` (frame -> parent), `local-response` and `local-files-changed`
 * (parent -> frame), defined in `src/host/docsCloudLocal.ts`. With
 * `local-comments` as well, those files take comments the same way, and the
 * parent sends `local-comments-changed` when they may have changed.
 *
 * Wire values never change: T3 Code ships separately and matches them byte for
 * byte, including those with `t3` in them. The frame states its protocol in
 * `location`; a parent may state its own in `hello`, and one that does not
 * counts as protocol 1.
 */
import { normalizeProjectKey } from "../host/docsCloudProjects.ts";
import type { StructuredAnchor } from "./anchors.ts";
import {
  LOCAL_COMMENTS_CHANGED_TYPE,
  LOCAL_FILES_CHANGED_TYPE,
  LOCAL_RESPONSE_TYPE,
  parseLocalResponseMessage,
  type LocalCommentsChangedMessage,
  type LocalFilesChangedMessage,
  type LocalRequestMessage,
  type LocalResponseMessage,
} from "../host/docsCloudLocal.ts";
import { THEME_COLOR_ROLES, type ThemeColorRole } from "../host/themePalettes.ts";

/** The protocol this app speaks; `location` carries it, and T3 Code ignores the extra field. */
export const EMBED_PROTOCOL_VERSION = 1;

export type EmbedFeature =
  | "start-work"
  | "add-to-chat"
  | "send-to"
  | "local-files"
  | "local-comments"
  | "local-create"
  | "local-import";

/** Apps T3 Code can copy a doc into. */
export type EmbedSendTarget = "notion";

/** T3 Code's resolved palette, by its theme colour roles. */
export type EmbedThemeColors = Readonly<Partial<Record<ThemeColorRole, string>>>;

export interface EmbedThemeMessage {
  readonly type: "t3-docs:theme";
  readonly appearance: "light" | "dark";
  /** Absent for a peer that sends only the appearance; this app's T3 defaults then apply. */
  readonly colors: EmbedThemeColors | null;
}

/** A T3 Code thread, by the environment that owns it. */
export interface EmbedThreadRef {
  readonly environmentId: string;
  readonly threadId: string;
}

export type EmbedParentMessage =
  | {
      readonly type: "t3-docs:hello";
      readonly features?: ReadonlyArray<EmbedFeature>;
      /** Absent from every T3 Code so far, which means protocol 1. */
      readonly protocolVersion?: number;
    }
  | { readonly type: "t3-docs:navigate"; readonly path: string }
  | {
      readonly type: "t3-docs:link-thread";
      readonly docId: string;
      readonly environmentId: string;
      readonly threadId: string;
      readonly title: string;
    }
  | {
      readonly type: "t3-docs:threads";
      readonly threads: ReadonlyArray<EmbedThreadRef & { readonly title: string }>;
    }
  | {
      readonly type: "t3-docs:context";
      /** The T3 Code project's title, for display and for peers that predate keys. */
      readonly projectName: string | null;
      /** Its UP Docs project key (see `normalizeProjectKey`); absent from older peers. */
      readonly projectKey: string | null;
    }
  | {
      readonly type: "t3-docs:sent-to";
      readonly requestId: string;
      /** The new page, when T3 Code learned it. */
      readonly url: string | null;
      /** Null when it worked, else a message for the user. */
      readonly error: string | null;
    }
  | LocalResponseMessage
  | LocalFilesChangedMessage
  | LocalCommentsChangedMessage
  | EmbedThemeMessage;

export {
  MAX_PROJECT_KEY_LENGTH,
  normalizeProjectKey,
  projectNameFromKey,
  projectNameKey,
  titleProjectKey,
} from "../host/docsCloudProjects.ts";

export interface EmbedLocationMessage {
  readonly type: "t3-docs:location";
  readonly path: string;
  readonly docId: string | null;
  readonly tabId: string | null;
  /** The project file a local route shows, so T3 Code can tell it from a cloud doc. */
  readonly localPath: string | null;
  readonly protocolVersion: number;
}

export interface EmbedCopyToClaudeDocMessage {
  readonly type: "t3-docs:copy-to-claude-doc";
  readonly docId: string;
  readonly title: string;
  /** The doc's permanent URL. */
  readonly url: string;
}

/** A comment for the agent in the conversation the Docs panel sits beside. */
export interface EmbedCommentForChat {
  readonly docId: string;
  readonly tabId: string;
  readonly docTitle: string;
  /** Opens the doc at the comment's tab. */
  readonly url: string;
  /** The thread's root comment. */
  readonly commentId: string;
  readonly quote: string;
  readonly body: string;
  /** The cell or diagram label the comment is on, when it is not on a passage. */
  readonly anchor: StructuredAnchor | null;
}

export type EmbedFrameMessage =
  | EmbedLocationMessage
  | EmbedCopyToClaudeDocMessage
  | {
      readonly type: "t3-docs:start-work";
      readonly docId: string;
      readonly tabId: string | null;
      readonly title: string;
      readonly url: string;
    }
  | {
      readonly type: "t3-docs:send-to";
      readonly requestId: string;
      readonly target: EmbedSendTarget;
      readonly docId: string;
      readonly title: string;
      /** The doc's URL on the origin T3 Code framed. */
      readonly url: string;
    }
  | { readonly type: "t3-docs:resolve-threads"; readonly threads: ReadonlyArray<EmbedThreadRef> }
  | ({ readonly type: "t3-docs:open-thread" } & EmbedThreadRef)
  | ({ readonly type: "t3-docs:thread-linked"; readonly docId: string } & EmbedThreadRef)
  | ({ readonly type: "t3-docs:add-comment-to-chat" } & EmbedCommentForChat)
  | LocalRequestMessage;

const FEATURES: ReadonlyArray<EmbedFeature> = [
  "start-work",
  "add-to-chat",
  "send-to",
  "local-files",
  "local-comments",
  "local-create",
  "local-import",
];

type Fields = Record<string, unknown>;
const isObject = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown, max = 200): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const isThreadRef = (value: unknown): value is EmbedThreadRef =>
  isObject(value) && isText(value.environmentId) && isText(value.threadId);

const isProtocolVersion = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

/** True when a parent's hello states a protocol this app does not know yet. */
export function isNewerEmbedHost(hello: { readonly protocolVersion?: number }): boolean {
  return (hello.protocolVersion ?? 1) > EMBED_PROTOCOL_VERSION;
}

const THEME_ROLES: ReadonlySet<string> = new Set(THEME_COLOR_ROLES);
// Colours become CSS custom properties, which accept any token stream, so only
// literal colours pass: no url(), var() or anything that could close the rule.
const THEME_COLOR =
  /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([0-9a-z.,%/\s+-]{1,80}\))$/i;

/** The well formed colours of a theme message; unknown roles and values are dropped. */
function parseThemeColors(value: unknown): EmbedThemeColors | null {
  if (!isObject(value)) return null;
  const colors: Partial<Record<ThemeColorRole, string>> = {};
  for (const [role, color] of Object.entries(value)) {
    if (THEME_ROLES.has(role) && typeof color === "string" && THEME_COLOR.test(color.trim())) {
      colors[role as ThemeColorRole] = color.trim();
    }
  }
  return colors;
}

export function parseThemeMessage(data: unknown): EmbedThemeMessage | null {
  if (!isObject(data) || data.type !== "t3-docs:theme") return null;
  if (data.appearance !== "light" && data.appearance !== "dark") return null;
  return { type: data.type, appearance: data.appearance, colors: parseThemeColors(data.colors) };
}

/**
 * The parent's message when it is well formed, else null. The origin and
 * source are checked by the caller; this guards the shape, since the parent
 * is a different app that may be older or newer than this one.
 */
export function parseParentMessage(data: unknown): EmbedParentMessage | null {
  if (!isObject(data)) return null;
  switch (data.type) {
    case "t3-docs:hello":
      return {
        type: data.type,
        features: Array.isArray(data.features)
          ? FEATURES.filter((feature) => (data.features as Array<unknown>).includes(feature))
          : [],
        ...(isProtocolVersion(data.protocolVersion)
          ? { protocolVersion: data.protocolVersion }
          : {}),
      };
    case "t3-docs:navigate":
      return typeof data.path === "string" &&
        data.path.startsWith("/") &&
        !data.path.startsWith("//")
        ? { type: data.type, path: data.path }
        : null;
    case "t3-docs:link-thread": {
      const { docId, title } = data;
      return isText(docId) && isText(title, 1_000) && isThreadRef(data)
        ? {
            type: data.type,
            docId,
            environmentId: data.environmentId,
            threadId: data.threadId,
            title,
          }
        : null;
    }
    case "t3-docs:threads":
      return Array.isArray(data.threads)
        ? {
            type: data.type,
            threads: data.threads
              .filter(
                (thread): thread is EmbedThreadRef & { title: string } =>
                  isObject(thread) && isText(thread.title, 1_000) && isThreadRef(thread),
              )
              .map(({ environmentId, threadId, title }) => ({ environmentId, threadId, title })),
          }
        : null;
    case "t3-docs:context": {
      if (data.projectName !== null && !isText(data.projectName, 1_000)) return null;
      const projectKey =
        typeof data.projectKey === "string" ? normalizeProjectKey(data.projectKey) : null;
      return {
        type: data.type,
        projectName: data.projectName === null ? null : data.projectName.trim() || null,
        projectKey,
      };
    }
    case "t3-docs:sent-to":
      // The URL becomes a link the user opens, so only https pages pass.
      return isText(data.requestId) &&
        (data.url === null || (isText(data.url, 2_000) && /^https:\/\//i.test(data.url))) &&
        (data.error === null || isText(data.error, 1_000))
        ? { type: data.type, requestId: data.requestId, url: data.url, error: data.error }
        : null;
    case "t3-docs:theme":
      return parseThemeMessage(data);
    case LOCAL_RESPONSE_TYPE:
      return parseLocalResponseMessage(data);
    case LOCAL_FILES_CHANGED_TYPE:
      return { type: LOCAL_FILES_CHANGED_TYPE };
    case LOCAL_COMMENTS_CHANGED_TYPE:
      return { type: LOCAL_COMMENTS_CHANGED_TYPE };
    default:
      return null;
  }
}

export const EMBED_ORIGINS_META = "t3-embed-origins";
/** The app's canonical origin, for links people share; the page may be served from another. */
export const PUBLIC_ORIGIN_META = "t3-docs-public-origin";

const SOURCE = /^([a-z][a-z0-9+.-]*):\/\/(\*\.)?([a-z0-9.-]+)(?::(\d+|\*))?$/i;
const ORIGIN = /^([a-z][a-z0-9+.-]*):\/\/([a-z0-9.-]+)(?::(\d+))?$/i;
const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443" };

/** Splits the FRAME_ANCESTORS var into CSP host-sources, dropping anything that is not one. */
export function parseEmbedOrigins(value: string | undefined): ReadonlyArray<string> {
  return (value ?? "").split(/[\s,]+/).filter((source) => SOURCE.test(source));
}

export function frameAncestorsPolicy(sources: ReadonlyArray<string>): string {
  return `frame-ancestors ${sources.length > 0 ? sources.join(" ") : "'none'"}`;
}

/**
 * Matches an origin against CSP host-sources the way the browser does for
 * frame-ancestors. Parsed by hand because `URL#origin` is opaque for custom
 * schemes such as the desktop app's `t3code://app`.
 */
export function isAllowedEmbedOrigin(origin: string, sources: ReadonlyArray<string>): boolean {
  const parsed = ORIGIN.exec(origin);
  if (!parsed) return false;
  const scheme = parsed[1]!.toLowerCase();
  const hostname = parsed[2]!.toLowerCase();
  const port = parsed[3] ?? DEFAULT_PORTS[scheme];
  return sources.some((source) => {
    const match = SOURCE.exec(source);
    if (!match || match[1]!.toLowerCase() !== scheme) return false;
    const host = match[3]!.toLowerCase();
    if (match[2] ? !hostname.endsWith(`.${host}`) : hostname !== host) return false;
    return match[4] === "*" || (match[4] ?? DEFAULT_PORTS[scheme]) === port;
  });
}
