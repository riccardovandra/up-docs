import { getSchema } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import type { LocalDocComment, LocalDocRequest } from "../../host/docsCloudLocal.ts";
import { describe, expect, it } from "vitest";

import { buildDocTextIndex, resolveDocAnchor } from "../comments/editorAnchors.ts";
import { authorLabel } from "../comments/CommentCard.tsx";
import { createEditorExtensions } from "../editor/extensions.ts";
import { localCommentSource } from "./localCommentSource.ts";
import type { LocalClient } from "./localClient.ts";

const root: LocalDocComment = {
  id: "c1",
  parentId: null,
  quote: "ships Friday",
  prefix: "Intro line\nThe plan ",
  suffix: ".",
  body: "Thursday?",
  author: "user",
  resolvedAt: null,
  createdAt: 1_000,
};
const reply: LocalDocComment = {
  ...root,
  id: "c2",
  parentId: "c1",
  quote: "",
  prefix: "",
  suffix: "",
  body: "Done.",
  author: "agent",
  createdAt: 2_000,
};

function fakeClient() {
  const requests: Array<LocalDocRequest> = [];
  const state = { comments: [root, reply], canComment: true, canSendToAgent: true };
  const client: LocalClient = {
    request: async (request) => {
      requests.push(request);
      return (request.kind === "comment.create" ? { ...state, commentId: "c1" } : state) as never;
    },
    onFilesChanged: () => () => undefined,
    onCommentsChanged: () => () => undefined,
  };
  return { client, requests };
}

describe("localCommentSource", () => {
  it("shows the host's comments in the margin's shape", async () => {
    const { client } = fakeClient();
    const loaded = await localCommentSource(client, "docs/plan.md").load();
    expect(loaded.capabilities).toEqual({ comment: true, sendToAgent: true });
    const [first, second] = loaded.comments;
    expect(first).toMatchObject({ id: "c1", tabId: "docs/plan.md", anchor: null, parentId: null });
    expect(second).toMatchObject({ id: "c2", parentId: "c1" });
    expect(authorLabel(first!.author)).toBe("You");
    expect(authorLabel(second!.author)).toBe("Agent");
  });

  it("returns the new thread and clips anchors to what the T3 server keeps", async () => {
    const { client, requests } = fakeClient();
    const created = await localCommentSource(client, "docs/plan.md").create({
      tabId: "docs/plan.md",
      anchor: {
        quote: "q".repeat(3_000),
        prefix: `${"x".repeat(300)}end`,
        suffix: "s".repeat(300),
      },
      body: "Why?",
      structured: null,
      sendToAgent: true,
    });
    expect(created.comment.id).toBe("c1");
    const sent = requests[0];
    expect(sent?.kind === "comment.create" && sent).toMatchObject({ sendToAgent: true });
    if (sent?.kind !== "comment.create") throw new Error("expected a create");
    expect(sent.quote).toHaveLength(2_000);
    expect(sent.prefix).toHaveLength(200);
    expect(sent.prefix.endsWith("end")).toBe(true);
    expect(sent.suffix).toHaveLength(200);
  });

  it("anchors a comment from the old Docs panel in the editor", () => {
    const extensions = createEditorExtensions();
    const markdown = new MarkdownManager({ extensions });
    const doc = getSchema(extensions).nodeFromJSON(
      markdown.parse("Intro line\n\nThe plan ships Friday.\n"),
    );
    const index = buildDocTextIndex(doc);
    const range = resolveDocAnchor(index, root);
    expect(range).not.toBeNull();
    expect(doc.textBetween(range!.from, range!.to)).toBe("ships Friday");
  });
});
