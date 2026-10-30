import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vitest";

import {
  LOCAL_COMMENTS_CHANGED_TYPE,
  LOCAL_COMMENTS_FEATURE,
  LOCAL_CREATE_FEATURE,
  LOCAL_FILES_CHANGED_TYPE,
  LOCAL_FILES_FEATURE,
  LOCAL_IMPORT_FEATURE,
  LOCAL_REQUEST_TYPE,
  LOCAL_RESPONSE_TYPE,
} from "../host/docsCloudLocal.ts";
import { NATIVE_HOST_EVENT, NATIVE_READY_TYPE } from "../host/docsCloudNative.ts";
import {
  EMBED_ORIGINS_META,
  EMBED_PROTOCOL_VERSION,
  isNewerEmbedHost,
  parseParentMessage,
  PUBLIC_ORIGIN_META,
  type EmbedFrameMessage,
  type EmbedParentMessage,
} from "../shared/embed.ts";

/**
 * T3 Code ships separately and matches these values byte for byte. A failure
 * here means the app stops working inside T3 Code: restore the value.
 */
const srcDir = NodeURL.fileURLToPath(new URL("..", import.meta.url));

const sourceFiles = (): ReadonlyArray<string> =>
  NodeFS.readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => NodeFS.readFileSync(`${srcDir}/${file}`, "utf8"));

const matches = (pattern: RegExp, text: string): ReadonlyArray<string> =>
  [...text.matchAll(pattern)].map((match) => match[0]);

describe("embed wire protocol", () => {
  it("pins the protocol version", () => {
    expect(EMBED_PROTOCOL_VERSION).toBe(1);
  });

  it("pins the meta names, native events and local constants", () => {
    expect({
      EMBED_ORIGINS_META,
      PUBLIC_ORIGIN_META,
      NATIVE_HOST_EVENT,
      NATIVE_READY_TYPE,
      LOCAL_REQUEST_TYPE,
      LOCAL_RESPONSE_TYPE,
      LOCAL_FILES_CHANGED_TYPE,
      LOCAL_COMMENTS_CHANGED_TYPE,
      LOCAL_FILES_FEATURE,
      LOCAL_COMMENTS_FEATURE,
      LOCAL_CREATE_FEATURE,
      LOCAL_IMPORT_FEATURE,
    }).toEqual({
      EMBED_ORIGINS_META: "t3-embed-origins",
      PUBLIC_ORIGIN_META: "t3-docs-public-origin",
      NATIVE_HOST_EVENT: "t3-docs:host",
      NATIVE_READY_TYPE: "t3-docs:ready",
      LOCAL_REQUEST_TYPE: "t3-docs:local-request",
      LOCAL_RESPONSE_TYPE: "t3-docs:local-response",
      LOCAL_FILES_CHANGED_TYPE: "t3-docs:local-files-changed",
      LOCAL_COMMENTS_CHANGED_TYPE: "t3-docs:local-comments-changed",
      LOCAL_FILES_FEATURE: "local-files",
      LOCAL_COMMENTS_FEATURE: "local-comments",
      LOCAL_CREATE_FEATURE: "local-create",
      LOCAL_IMPORT_FEATURE: "local-import",
    });
  });

  it("uses exactly the pinned type strings across the app", () => {
    const used = new Set(sourceFiles().flatMap((text) => matches(/t3-docs:[a-z-]+/g, text)));
    expect([...used].sort()).toEqual([
      "t3-docs:add-comment-to-chat",
      "t3-docs:context",
      "t3-docs:copy-to-claude-doc",
      "t3-docs:hello",
      "t3-docs:host",
      "t3-docs:link-thread",
      "t3-docs:local-comments-changed",
      "t3-docs:local-files-changed",
      "t3-docs:local-request",
      "t3-docs:local-response",
      "t3-docs:location",
      "t3-docs:navigate",
      "t3-docs:open-thread",
      "t3-docs:ready",
      "t3-docs:resolve-threads",
      "t3-docs:send-to",
      "t3-docs:sent-to",
      "t3-docs:start-work",
      "t3-docs:theme",
      "t3-docs:thread-linked",
      "t3-docs:threads",
    ]);
  });

  it("keeps every parent message's field names", () => {
    const thread = { environmentId: "e", threadId: "t" };
    const messages: ReadonlyArray<EmbedParentMessage> = [
      { type: "t3-docs:hello", features: ["start-work", "add-to-chat", "send-to"] },
      { type: "t3-docs:navigate", path: "/d/1" },
      { type: "t3-docs:link-thread", docId: "d", title: "T", ...thread },
      { type: "t3-docs:threads", threads: [{ ...thread, title: "T" }] },
      { type: "t3-docs:context", projectName: "P", projectKey: "github.com/o/r" },
      { type: "t3-docs:sent-to", requestId: "r", url: "https://example.com/p", error: null },
      { type: "t3-docs:theme", appearance: "dark", colors: { canvas: "#000000" } },
      { type: LOCAL_RESPONSE_TYPE, requestId: "r", ok: true, result: 1 },
      { type: LOCAL_RESPONSE_TYPE, requestId: "r", ok: false, error: "no" },
      { type: LOCAL_FILES_CHANGED_TYPE },
      { type: LOCAL_COMMENTS_CHANGED_TYPE },
    ];
    for (const message of messages) expect(parseParentMessage(message)).toEqual(message);
  });

  it("keeps every frame message's field names", () => {
    const thread = { environmentId: "e", threadId: "t" };
    // Typed samples: renaming or adding a required field fails `bun run typecheck`.
    const messages: ReadonlyArray<EmbedFrameMessage> = [
      {
        type: "t3-docs:location",
        path: "/",
        docId: null,
        tabId: null,
        localPath: null,
        protocolVersion: 1,
      },
      { type: "t3-docs:copy-to-claude-doc", docId: "d", title: "T", url: "u" },
      { type: "t3-docs:start-work", docId: "d", tabId: null, title: "T", url: "u" },
      { type: "t3-docs:send-to", requestId: "r", target: "notion", docId: "d", title: "T", url: "u" },
      { type: "t3-docs:resolve-threads", threads: [thread] },
      { type: "t3-docs:open-thread", ...thread },
      { type: "t3-docs:thread-linked", docId: "d", ...thread },
      {
        type: "t3-docs:add-comment-to-chat",
        docId: "d",
        tabId: "t",
        docTitle: "T",
        url: "u",
        commentId: "c",
        quote: "q",
        body: "b",
        anchor: null,
      },
      { type: LOCAL_REQUEST_TYPE, requestId: "r", request: { kind: "files.list" } },
    ];
    expect(messages.map((message) => Object.keys(message).sort().join(" "))).toEqual([
      "docId localPath path protocolVersion tabId type",
      "docId title type url",
      "docId tabId title type url",
      "docId requestId target title type url",
      "threads type",
      "environmentId threadId type",
      "docId environmentId threadId type",
      "anchor body commentId docId docTitle quote tabId type url",
      "request requestId type",
    ]);
  });

  it("pins the local request kinds", () => {
    const file = NodeFS.readFileSync(`${srcDir}/host/docsCloudLocal.ts`, "utf8");
    const union = file.slice(
      file.indexOf("export type LocalDocRequest ="),
      file.indexOf("export interface LocalRequestMessage"),
    );
    expect(matches(/(?<=kind: ")[a-z.]+(?=")/g, union)).toEqual([
      "files.list",
      "file.read",
      "file.write",
      "file.create",
      "file.import",
      "comments.list",
      "comment.create",
      "comment.reply",
      "comment.resolve",
      "comment.delete",
      "comment.chat",
    ]);
  });
});

describe("embed version check", () => {
  it("treats a parent that states no version as protocol 1", () => {
    expect(isNewerEmbedHost({})).toBe(false);
    expect(parseParentMessage({ type: "t3-docs:hello", features: [] })).toEqual({
      type: "t3-docs:hello",
      features: [],
    });
  });

  it("flags a newer parent and keeps its features working", () => {
    const hello = parseParentMessage({
      type: "t3-docs:hello",
      features: ["add-to-chat"],
      protocolVersion: EMBED_PROTOCOL_VERSION + 1,
    });
    expect(hello).toEqual({
      type: "t3-docs:hello",
      features: ["add-to-chat"],
      protocolVersion: 2,
    });
    expect(isNewerEmbedHost(hello as { protocolVersion?: number })).toBe(true);
  });

  it("does not flag the same protocol, and ignores malformed versions", () => {
    expect(isNewerEmbedHost({ protocolVersion: EMBED_PROTOCOL_VERSION })).toBe(false);
    for (const protocolVersion of ["2", 0, -1, 1.5, null, Number.POSITIVE_INFINITY]) {
      expect(parseParentMessage({ type: "t3-docs:hello", protocolVersion })).toEqual({
        type: "t3-docs:hello",
        features: [],
      });
    }
  });
});
