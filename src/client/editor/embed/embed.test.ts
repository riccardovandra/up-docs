import { flattenExtensions, getSchema } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { history, undo } from "@tiptap/pm/history";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import { createEditorExtensions } from "../extensions.ts";
import { xFrameHeight } from "./EmbedView.ts";
import { pasteEmbed } from "./embedSupport.ts";

const extensions = flattenExtensions(createEditorExtensions());
const markdown = new MarkdownManager({ extensions });
const roundTrip = (source: string) => markdown.serialize(markdown.parse(source));
const schema = getSchema(extensions);

const LINKEDIN =
  "https://www.linkedin.com/posts/p_hooks-activity-7209442266791186432-uyzh?utm_source=share";

describe("t3-embed markdown", () => {
  it.each([
    ["a LinkedIn post with a caption", `\`\`\`t3-embed\n${LINKEDIN}\nHook: a number\n\`\`\``],
    ["an X post", "```t3-embed\nhttps://x.com/jack/status/20\n```"],
    ["a compact embed", "```t3-embed compact\nhttps://x.com/jack/status/20\nCaption\n```"],
    ["an unknown link", "```t3-embed\nhttps://example.com/a?b=c&d=e\n```"],
    [
      "an embed between paragraphs",
      "Before.\n\n```t3-embed\nhttps://x.com/jack/status/20\n```\n\nAfter.",
    ],
    ["a bare link, left as a link", "[https://x.com/jack/status/20](https://x.com/jack/status/20)"],
  ])("round-trips %s", (_name, source) => {
    expect(roundTrip(source)).toBe(source);
  });
});

function viewFor(doc: ReturnType<typeof schema.nodeFromJSON>, at: number) {
  let state = EditorState.create({ schema, doc, plugins: [history()] });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)));
  const view = {
    get state() {
      return state;
    },
    dispatch(tr: Transaction) {
      state = state.apply(tr);
    },
  };
  return view;
}

const emptyLine = () =>
  schema.nodeFromJSON({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Intro" }] },
      { type: "paragraph" },
    ],
  });

describe("pasting a post link", () => {
  it("turns it into an embed on an empty line, and undo brings back the link", () => {
    const view = viewFor(emptyLine(), 8);
    expect(pasteEmbed(view, `  ${LINKEDIN}\n`)).toBe(true);
    expect(markdown.serialize(view.state.doc.toJSON())).toBe(
      `Intro\n\n\`\`\`t3-embed\n${LINKEDIN}\n\`\`\`\n\n`,
    );
    expect(view.state.selection.$from.parent.type.name).toBe("paragraph");

    undo(view.state, (tr) => view.dispatch(tr));
    const restored = markdown.serialize(view.state.doc.toJSON());
    expect(restored).toContain(`](${LINKEDIN})`);
    expect(restored).not.toContain("t3-embed");
  });

  it("leaves other pastes to the editor", () => {
    expect(pasteEmbed(viewFor(emptyLine(), 8), "https://example.com/page")).toBe(false);
    expect(pasteEmbed(viewFor(emptyLine(), 8), `${LINKEDIN} and more`)).toBe(false);
    // Mid-sentence, the link stays a link.
    expect(pasteEmbed(viewFor(emptyLine(), 3), LINKEDIN)).toBe(false);
  });
});

describe("xFrameHeight", () => {
  const resize = (height: unknown) => ({
    "twttr.embed": { method: "twttr.private.resize", params: [{ width: 535, height }] },
  });

  it("reads X's resize message as an object or as JSON text", () => {
    expect(xFrameHeight(resize(755))).toBe(755);
    expect(xFrameHeight(JSON.stringify(resize(755.4)))).toBe(756);
  });

  it("ignores other messages and caps the height", () => {
    expect(
      xFrameHeight({ "twttr.embed": { method: "twttr.private.rendered", params: [{}] } }),
    ).toBeNull();
    expect(xFrameHeight(resize("755"))).toBeNull();
    expect(xFrameHeight(resize(-1))).toBeNull();
    expect(xFrameHeight("not json")).toBeNull();
    expect(xFrameHeight(resize(99_999))).toBe(4000);
  });
});
