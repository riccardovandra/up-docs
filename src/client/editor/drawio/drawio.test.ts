import { Editor, flattenExtensions, getSchema } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { Node } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";

import { drawioBlock, type DiagramSummary, type DiagramUsage } from "../../../shared/drawio.ts";
import { ApiError } from "../../api.ts";
import { buildDocTextIndex } from "../../comments/editorAnchors.ts";
import { startEditorSession } from "../../diagrams/editorSession.ts";
import { fakeApi, fakeDrawio, summary, view } from "../../diagrams/testing/fakeDrawio.ts";
import { createEditorExtensions } from "../extensions.ts";
import {
  blockActions,
  blockDiagram,
  copyTitle,
  detachCopy,
  drawioNode,
  insertOnFirstSave,
  mergeDiagram,
  otherDocs,
  pickerLists,
  usageLine,
} from "./blockLogic.ts";
import {
  insertDrawioBlock,
  linkDiagramAtCaret,
  relinkBlockStep,
  relinkDrawioBlock,
  removeBlockStep,
  removeDrawioBlock,
} from "./drawioSupport.ts";
import { loadLinkedDiagrams } from "./linkedDiagrams.ts";

const extensions = flattenExtensions(createEditorExtensions());
const markdown = new MarkdownManager({ extensions });
const roundTrip = (source: string) => markdown.serialize(markdown.parse(source));

const ID = "0b6f3a52-6a3e-4b0c-9a55-2b1d1f4f2a10";
const OTHER = "7c1d2e3f-0000-4000-8000-000000000001";

/** A headless editor over one tab's markdown; nothing here needs a browser. */
const editorOn = (source: string, editable = true) =>
  new Editor({
    element: null,
    extensions: createEditorExtensions(),
    content: source,
    contentType: "markdown",
    editable,
  });

/** Where the first linked-diagram block sits. */
function blockPos(editor: Editor): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found === -1 && node.type.name === "codeBlock" && node.attrs.language === "t3-drawio") {
      found = pos;
    }
  });
  return found;
}

describe("t3-drawio markdown", () => {
  it.each([
    ["a link alone", drawioBlock(ID)],
    ["a link with a caption", drawioBlock(ID, "How a client starts")],
    ["a tilde fence", `~~~t3-drawio\n${ID}\nCaption\n~~~`],
    ["a longer fence", `\`\`\`\`t3-drawio\n${ID}\n\`\`\`\``],
    ["text around it", `Before\n\n${drawioBlock(ID, "Flow")}\n\nAfter`],
    ["two links to one diagram", `${drawioBlock(ID)}\n\n${drawioBlock(ID, "Again")}`],
    ["a block that does not parse, kept as written", "```t3-drawio\nnot an id!\n```"],
  ])("round-trips %s", (_name, source) => {
    expect(roundTrip(source)).toBe(source);
  });

  it("writes an inserted block exactly as the shared format does", () => {
    const doc = { type: "doc", content: [drawioNode(ID, "How a client starts")] };
    expect(markdown.serialize(doc)).toBe(drawioBlock(ID, "How a client starts"));
  });

  it("keeps the id and caption out of the text comments anchor to", () => {
    const parsed = markdown.parse(`Before\n\n${drawioBlock(ID, "Flow")}\n\nAfter`);
    const doc = Node.fromJSON(getSchema(extensions), parsed);
    expect(buildDocTextIndex(doc).text).toBe("Before\nAfter");
  });
});

describe("linking, relinking and removing a block", () => {
  /** Applies a change the way the block does, and reports whether there was one. */
  const apply = (editor: Editor, tr: ReturnType<typeof removeBlockStep>) => {
    if (tr) editor.view.dispatch(tr);
    return tr !== null;
  };

  it("inserts the block at the caret with a line after it", () => {
    const editor = editorOn("Intro");
    expect(linkDiagramAtCaret(editor, ID, false)).toBe(true);
    expect(editor.getMarkdown()).toContain(drawioBlock(ID));
    // The caret is left outside the block, so the picture shows and not its source.
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    editor.destroy();
  });

  it("points a block at another diagram and keeps its caption", () => {
    const editor = editorOn(`Before\n\n${drawioBlock(ID, "The flow")}\n\nAfter`);
    expect(apply(editor, relinkBlockStep(editor.state, blockPos(editor), OTHER))).toBe(true);
    expect(editor.getMarkdown()).toBe(`Before\n\n${drawioBlock(OTHER, "The flow")}\n\nAfter`);
    editor.destroy();
  });

  it("removes only the block, and leaves an empty line when it was the whole tab", () => {
    const editor = editorOn(`Before\n\n${drawioBlock(ID)}\n\nAfter`);
    expect(apply(editor, removeBlockStep(editor.state, blockPos(editor)))).toBe(true);
    expect(editor.getMarkdown()).toBe("Before\n\nAfter");
    editor.destroy();

    const alone = editorOn(drawioBlock(ID));
    expect(apply(alone, removeBlockStep(alone.state, blockPos(alone)))).toBe(true);
    expect(alone.state.doc.childCount).toBe(1);
    expect(alone.getMarkdown()).not.toContain("t3-drawio");
    alone.destroy();
  });

  it("changes nothing where no linked diagram starts", () => {
    const editor = editorOn(`Before\n\n${drawioBlock(ID)}\n\n\`\`\`ts\ncode\n\`\`\``);
    // Position 0 is the paragraph; the last block is plain code.
    const code = editor.state.doc.content.size - editor.state.doc.lastChild!.nodeSize;
    for (const pos of [0, code, -1, 9999]) {
      expect(removeBlockStep(editor.state, pos)).toBeNull();
      expect(relinkBlockStep(editor.state, pos, OTHER)).toBeNull();
    }
    editor.destroy();
  });

  it("changes nothing in a tab that is read-only or no longer on the page", () => {
    const source = `Before\n\n${drawioBlock(ID)}`;
    const reader = editorOn(source, false);
    expect(insertDrawioBlock(reader, OTHER, { focus: false })).toBe(false);
    expect(removeDrawioBlock(reader, blockPos(reader))).toBe(false);
    expect(relinkDrawioBlock(reader, blockPos(reader), OTHER)).toBe(false);
    expect(reader.getMarkdown()).toBe(source);
    reader.destroy();
  });
});

describe("a change of the right to edit", () => {
  it("reaches the blocks through the empty transaction the tab editor sends", () => {
    const editor = editorOn("Intro");
    const heard: Array<boolean> = [];
    let updates = 0;
    editor.on("transaction", () => heard.push(editor.isEditable));
    editor.on("update", () => (updates += 1));

    // The page switches quietly, so nothing is saved; on its own that tells a block nothing.
    editor.setEditable(false, false);
    expect(heard).toEqual([]);
    editor.view.dispatch(editor.state.tr);
    expect(heard).toEqual([false]);
    // And it is not an edit: the tab is not saved for it.
    expect(updates).toBe(0);
    editor.destroy();
  });
});

describe("block actions", () => {
  const ids = (actions: ReturnType<typeof blockActions>) => actions.map((action) => action.id);

  it("gives someone who only reads the doc no actions, even on their own diagram", () => {
    expect(blockActions({ docEditable: false, diagram: { canEdit: true }, hosted: true })).toEqual(
      [],
    );
    expect(blockActions({ docEditable: false, diagram: null, hosted: true })).toEqual([]);
  });

  it("gives an editor who manages the diagram all four, in order", () => {
    const actions = blockActions({ docEditable: true, diagram: { canEdit: true }, hosted: true });
    expect(ids(actions)).toEqual(["edit", "open", "detach", "remove"]);
    expect(actions.every((action) => action.disabled === null)).toBe(true);
  });

  it("greys out Edit and Detach a copy, with the reason, for an editor who only views it", () => {
    const actions = blockActions({ docEditable: true, diagram: { canEdit: false }, hosted: true });
    expect(actions).toEqual([
      { id: "edit", label: "Edit", disabled: "Only the diagram's creator can edit it." },
      { id: "open", label: "Open in Diagrams", disabled: null },
      { id: "detach", label: "Detach a copy", disabled: "Only the diagram's creator can copy it." },
      { id: "remove", label: "Remove", disabled: null },
    ]);
  });

  it("offers only Remove for a diagram that is gone or not loaded", () => {
    expect(ids(blockActions({ docEditable: true, diagram: null, hosted: true }))).toEqual([
      "remove",
    ]);
  });

  it("offers no Edit or Detach where no page hosts the editor", () => {
    const actions = blockActions({ docEditable: true, diagram: { canEdit: true }, hosted: false });
    expect(ids(actions)).toEqual(["open", "remove"]);
  });
});

describe("the caption's note on other docs", () => {
  const use = (docId: string, tabId: string) => ({
    docId,
    docTitle: docId,
    tabId,
    tabTitle: tabId,
  });

  it("counts every other doc once, and the docs the person is not on", () => {
    const usage: DiagramUsage = {
      uses: [use("here", "t1"), use("here", "t2"), use("there", "t3"), use("there", "t4")],
      otherDocs: 2,
    };
    expect(otherDocs(usage, "here")).toBe(3);
    expect(usageLine(usage, "here")).toBe("Also in 3 other docs");
    expect(usageLine({ uses: [use("there", "t3")], otherDocs: 0 }, "here")).toBe(
      "Also in 1 other doc",
    );
  });

  it("says so when only this doc links it, saved or not yet", () => {
    expect(usageLine({ uses: [use("here", "t1")], otherDocs: 0 }, "here")).toBe("Only in this doc");
    // Just inserted: the tab is not saved yet, so the server lists no use at all.
    expect(usageLine({ uses: [], otherDocs: 0 }, "here")).toBe("Only in this doc");
  });
});

describe("what a block knows about its diagram", () => {
  it("never keeps the source", () => {
    expect(blockDiagram(view({ xml: "<mxGraphModel/>" }))).not.toHaveProperty("xml");
  });

  it("takes a fetched diagram's word on who manages it", () => {
    expect(mergeDiagram(null, view({ canEdit: false, xml: null })).canEdit).toBe(false);
    const known = mergeDiagram(null, view({ canEdit: true }));
    expect(mergeDiagram(known, view({ canEdit: false, xml: null })).canEdit).toBe(false);
  });

  it("follows a save heard from the page and keeps who manages it", () => {
    const known = mergeDiagram(null, view({ version: 1, pictureVersion: 1 }));
    const saved = mergeDiagram(known, summary({ version: 2, pictureVersion: 2, title: "Renamed" }));
    expect(saved).toMatchObject({ version: 2, pictureVersion: 2, title: "Renamed", canEdit: true });
  });

  it("does not let a slow fetch undo a newer save", () => {
    const saved = mergeDiagram(null, view({ version: 3, pictureVersion: 3 }));
    const stale = mergeDiagram(saved, view({ version: 2, pictureVersion: 2 }));
    expect(stale).toMatchObject({ version: 3, pictureVersion: 3 });
  });
});

describe("Detach a copy", () => {
  it("makes a new diagram in the doc's project with the same source, and leaves the original", async () => {
    const original = view({
      id: "g1",
      projectId: "elsewhere",
      title: "Flow",
      xml: "<mxfile>a</mxfile>",
    });
    const api = fakeApi([original]);
    const copy = await detachCopy(api, { diagramId: "g1", projectId: "doc-project" });

    expect(api.calls).toEqual([
      ["create", { projectId: "doc-project", title: "Flow (copy)", xml: "<mxfile>a</mxfile>" }],
    ]);
    expect(copy.id).not.toBe("g1");
    expect(copy).toMatchObject({ projectId: "doc-project", title: "Flow (copy)" });
    // No write went to the original.
    expect(api.diagrams.get("g1")).toBe(original);
  });

  it("files the copy in no project for a doc in none", async () => {
    const api = fakeApi([view({ id: "g1" })]);
    const copy = await detachCopy(api, { diagramId: "g1", projectId: null });
    expect(copy.projectId).toBeNull();
  });

  it("refuses someone who only views the diagram, and creates nothing", async () => {
    const api = fakeApi([view({ id: "g1", canEdit: false, xml: null })]);
    await expect(detachCopy(api, { diagramId: "g1", projectId: "p" })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(api.calls).toEqual([]);
    expect(api.diagrams.size).toBe(1);
  });

  it("fails without creating anything when the diagram is gone", async () => {
    const api = fakeApi();
    await expect(detachCopy(api, { diagramId: "gone", projectId: "p" })).rejects.toMatchObject({
      status: 404,
    });
    expect(api.calls).toEqual([]);
  });

  it("keeps the copy's title within the limit", () => {
    expect(copyTitle("Flow")).toBe("Flow (copy)");
    const long = copyTitle("x".repeat(200));
    expect(long).toHaveLength(200);
    expect(long.endsWith(" (copy)")).toBe(true);
  });
});

describe("a new diagram drawn from a doc", () => {
  /** The overlay's session, wired the way the doc page wires it. */
  function draw() {
    const drawio = fakeDrawio();
    const api = fakeApi();
    const linked: Array<string> = [];
    const saved = insertOnFirstSave((diagram) => linked.push(diagram.id));
    const closed: Array<DiagramSummary | null> = [];
    startEditorSession({
      frame: drawio.frame,
      api,
      target: { kind: "new", projectId: "doc-project" },
      onState: () => undefined,
      onSaved: saved,
      onClose: (diagram) => {
        saved(diagram);
        closed.push(diagram);
      },
    });
    drawio.emit({ event: "init" });
    return { drawio, api, linked, closed };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("leaves no diagram and no block when the person exits without saving", async () => {
    const { drawio, api, linked, closed } = draw();
    await settle();
    drawio.emit({ event: "exit" });
    await settle();

    expect(closed).toEqual([null]);
    expect(api.calls).toEqual([]);
    expect(api.diagrams.size).toBe(0);
    expect(linked).toEqual([]);
  });

  it("creates the diagram in the doc's project and links it once, on Save & Exit", async () => {
    const { drawio, api, linked, closed } = draw();
    await settle();
    drawio.emit({ event: "save", xml: "<mxGraphModel/>", exit: true });
    await settle();

    expect(api.calls[0]).toEqual([
      "create",
      { projectId: "doc-project", title: "Untitled diagram", xml: "<mxGraphModel/>" },
    ]);
    expect(closed).toHaveLength(1);
    // `onSaved` and `onClose` both report the save; the block still goes in once.
    expect(linked).toEqual([closed[0]!.id]);
  });

  it("links on the first Save and not again on later saves or the exit", async () => {
    const { drawio, linked } = draw();
    await settle();
    drawio.emit({ event: "save", xml: "<mxGraphModel/>", exit: false });
    await settle();
    expect(linked).toHaveLength(1);
    drawio.emit({ event: "save", xml: "<mxGraphModel><root/></mxGraphModel>", exit: false });
    await settle();
    drawio.emit({ event: "exit" });
    await settle();
    expect(linked).toHaveLength(1);
  });
});

describe("the Insert diagram picker", () => {
  const diagrams = [
    { id: "a", projectId: "other" },
    { id: "b", projectId: "mine" },
    { id: "c", projectId: null },
    { id: "d", projectId: "mine" },
  ];
  const shown = (lists: ReturnType<typeof pickerLists<(typeof diagrams)[number]>>) =>
    lists.shown.map((diagram) => diagram.id);

  it("opens on the doc's project", () => {
    const lists = pickerLists(diagrams, { projectId: "mine", scope: "project", locked: false });
    expect(shown(lists)).toEqual(["b", "d"]);
    expect(lists.scopes).toEqual([
      { scope: "project", count: 2 },
      { scope: "all", count: 4 },
    ]);
  });

  it("lists the doc's project first under All projects, then the rest in the order given", () => {
    const lists = pickerLists(diagrams, { projectId: "mine", scope: "all", locked: false });
    expect(shown(lists)).toEqual(["b", "d", "a", "c"]);
  });

  it("treats a doc in no project as its own group", () => {
    const lists = pickerLists(diagrams, { projectId: null, scope: "project", locked: false });
    expect(shown(lists)).toEqual(["c"]);
    expect(shown(pickerLists(diagrams, { projectId: null, scope: "all", locked: false }))).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });

  it("offers only the locked project, whatever scope is asked for", () => {
    for (const scope of ["project", "all"] as const) {
      const lists = pickerLists(diagrams, { projectId: "mine", scope, locked: true });
      expect(shown(lists)).toEqual(["b", "d"]);
      expect(lists.scopes).toEqual([{ scope: "project", count: 2 }]);
    }
  });

  it("still offers the project when it has no diagrams yet", () => {
    const lists = pickerLists(diagrams, { projectId: "empty", scope: "project", locked: false });
    expect(lists.shown).toEqual([]);
    expect(lists.scopes[0]).toEqual({ scope: "project", count: 0 });
  });
});

describe("loading linked diagrams for a book", () => {
  const tabs = [
    { markdown: `${drawioBlock("g1")}\n\n${drawioBlock("gone")}` },
    { markdown: drawioBlock("g1", "Again") },
  ];

  it("fetches each linked diagram once and leaves out one that is gone", async () => {
    const api = fakeApi([view({ id: "g1", title: "Flow", pictureVersion: 1 })]);
    const asked: Array<string> = [];
    const loaded = await loadLinkedDiagrams(tabs, {
      get: (id) => {
        asked.push(id);
        return api.get(id);
      },
    });
    expect(asked.toSorted()).toEqual(["g1", "gone"]);
    expect([...loaded.values()]).toEqual([
      { id: "g1", title: "Flow", pictureVersion: 1, hasSource: true },
    ]);
  });

  it("fails rather than call a diagram missing when the server cannot be reached", async () => {
    const get = () => Promise.reject(new ApiError(500, { error: "boom" }));
    await expect(loadLinkedDiagrams(tabs, { get })).rejects.toMatchObject({ status: 500 });
  });
});
