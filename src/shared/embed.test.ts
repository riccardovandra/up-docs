import { describe, expect, it } from "vitest";

import { parseParentMessage, parseThemeMessage, projectNameKey } from "./embed.ts";

describe("parseParentMessage", () => {
  it("keeps only the features this app knows from hello", () => {
    expect(parseParentMessage({ type: "t3-docs:hello" })).toEqual({
      type: "t3-docs:hello",
      features: [],
    });
    expect(
      parseParentMessage({ type: "t3-docs:hello", features: ["start-work", "teleport", 3] }),
    ).toEqual({ type: "t3-docs:hello", features: ["start-work"] });
  });

  it("knows the local-files feature and the local messages", () => {
    expect(
      parseParentMessage({ type: "t3-docs:hello", features: ["local-files", "add-to-chat"] }),
    ).toEqual({ type: "t3-docs:hello", features: ["add-to-chat", "local-files"] });
    expect(
      parseParentMessage({ type: "t3-docs:hello", features: ["local-import", "local-create"] }),
    ).toEqual({ type: "t3-docs:hello", features: ["local-create", "local-import"] });
    expect(parseParentMessage({ type: "t3-docs:local-files-changed", paths: 3 })).toEqual({
      type: "t3-docs:local-files-changed",
    });
    expect(
      parseParentMessage({
        type: "t3-docs:local-response",
        requestId: "r1",
        ok: false,
        error: "No access",
      }),
    ).toEqual({ type: "t3-docs:local-response", requestId: "r1", ok: false, error: "No access" });
    expect(
      parseParentMessage({ type: "t3-docs:local-response", requestId: "r1", ok: "yes" }),
    ).toBeNull();
  });

  it("accepts app paths only for navigate", () => {
    expect(parseParentMessage({ type: "t3-docs:navigate", path: "/d/doc-1" })).toEqual({
      type: "t3-docs:navigate",
      path: "/d/doc-1",
    });
    expect(parseParentMessage({ type: "t3-docs:navigate", path: "//evil.test" })).toBeNull();
    expect(parseParentMessage({ type: "t3-docs:navigate", path: "https://evil.test" })).toBeNull();
  });

  it("takes the project context as a trimmed name and a normalised key", () => {
    expect(
      parseParentMessage({
        type: "t3-docs:context",
        projectName: " Site ",
        projectKey: " github.com/acme/site ",
      }),
    ).toEqual({
      type: "t3-docs:context",
      projectName: "Site",
      projectKey: "github.com/acme/site",
    });
    // An older T3 Code sends only the name.
    expect(parseParentMessage({ type: "t3-docs:context", projectName: " Site " })).toEqual({
      type: "t3-docs:context",
      projectName: "Site",
      projectKey: null,
    });
    expect(parseParentMessage({ type: "t3-docs:context", projectName: "   " })).toEqual({
      type: "t3-docs:context",
      projectName: null,
      projectKey: null,
    });
    expect(parseParentMessage({ type: "t3-docs:context", projectName: 3 })).toBeNull();
    expect(projectNameKey("  Acme   SITE ")).toBe(projectNameKey("acme site"));
  });

  it("validates thread links and drops malformed thread entries", () => {
    const link = {
      type: "t3-docs:link-thread",
      docId: "doc-1",
      environmentId: "env-1",
      threadId: "thread-1",
      title: "Build it",
    };
    expect(parseParentMessage({ ...link, extra: true })).toEqual(link);
    expect(parseParentMessage({ ...link, title: "" })).toBeNull();
    expect(parseParentMessage({ ...link, threadId: 7 })).toBeNull();
    expect(
      parseParentMessage({
        type: "t3-docs:threads",
        threads: [
          { environmentId: "env-1", threadId: "thread-1", title: "Build it" },
          { environmentId: "env-1", threadId: "thread-2" },
          "nope",
        ],
      }),
    ).toEqual({
      type: "t3-docs:threads",
      threads: [{ environmentId: "env-1", threadId: "thread-1", title: "Build it" }],
    });
  });

  it("ignores unknown types, including the retired comment-sent", () => {
    expect(
      parseParentMessage({ type: "t3-docs:comment-sent", requestId: "r-1", error: null }),
    ).toBeNull();
    expect(parseParentMessage({ type: "t3-docs:other" })).toBeNull();
    expect(parseParentMessage("t3-docs:hello")).toBeNull();
  });

  it("validates send-to results, allowing only https page links", () => {
    const sent = { type: "t3-docs:sent-to", requestId: "r-1", url: null, error: null };
    expect(parseParentMessage(sent)).toEqual(sent);
    const page = { ...sent, url: "https://www.notion.so/Plan-1" };
    expect(parseParentMessage(page)).toEqual(page);
    expect(parseParentMessage({ ...sent, url: "javascript:alert(1)" })).toBeNull();
    expect(parseParentMessage({ ...sent, url: undefined })).toBeNull();
    const failed = { ...sent, error: "Connect Notion in Settings → MCP Servers." };
    expect(parseParentMessage(failed)).toEqual(failed);
    expect(
      parseParentMessage({ type: "t3-docs:hello", features: ["send-to", "add-to-chat"] }),
    ).toEqual({ type: "t3-docs:hello", features: ["add-to-chat", "send-to"] });
    // An older T3 Code's feature is dropped, so its comment button never shows.
    expect(parseParentMessage({ type: "t3-docs:hello", features: ["send-to-agent"] })).toEqual({
      type: "t3-docs:hello",
      features: [],
    });
  });

  it("takes the theme appearance and only literal colours for known roles", () => {
    expect(parseParentMessage({ type: "t3-docs:theme", appearance: "dark" })).toEqual({
      type: "t3-docs:theme",
      appearance: "dark",
      colors: null,
    });
    expect(
      parseParentMessage({
        type: "t3-docs:theme",
        appearance: "light",
        colors: {
          canvas: " #fcfcfc ",
          text: "oklch(0.325698 0.116116 325.037 / 50%)",
          surface: "rgba(255, 255, 255, 0.9)",
          border: "url(https://evil.test/x.png)",
          accent: "red;}body{display:none",
          focus: "var(--x)",
          sidebar: 3,
          notARole: "#000000",
        },
      }),
    ).toEqual({
      type: "t3-docs:theme",
      appearance: "light",
      colors: {
        canvas: "#fcfcfc",
        text: "oklch(0.325698 0.116116 325.037 / 50%)",
        surface: "rgba(255, 255, 255, 0.9)",
      },
    });
    expect(parseParentMessage({ type: "t3-docs:theme", appearance: "sepia" })).toBeNull();
    expect(parseThemeMessage({ type: "t3-docs:context", appearance: "dark" })).toBeNull();
  });
});
