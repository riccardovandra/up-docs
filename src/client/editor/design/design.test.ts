import { Editor, flattenExtensions } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { describe, expect, it } from "vitest";

import { designBlock, type DesignRefresh } from "../../../shared/designBlock.ts";
import { createEditorExtensions } from "../extensions.ts";
import { insertDesignBlock, linkDesignAtCaret, removeDesignStep } from "./designBlockSteps.ts";
import { usedInLabel } from "./DesignUsedIn.tsx";
import { createDesignRefresher, DESIGN_REFRESH_MS } from "./designRefresh.ts";

const design = (id: string, version: number): DesignRefresh => ({
  id,
  projectId: null,
  title: id,
  version,
  pictureVersion: version,
  createdBy: null,
  createdAt: 0,
  updatedAt: 0,
  role: "viewer",
  canEdit: false,
});

function harness() {
  let clock = 0;
  let tick: (() => void) | null = null;
  let wake: (() => void) | null = null;
  const asked: Array<ReadonlyArray<string>> = [];
  let answer: ReadonlyArray<DesignRefresh> = [];
  let visible = true;
  const refresher = createDesignRefresher({
    reread: async (ids) => {
      asked.push(ids);
      return answer;
    },
    visible: () => visible,
    onWake: (fn) => {
      wake = fn;
      return () => (wake = null);
    },
    now: () => clock,
    setTimer: (fn, ms) => {
      expect(ms).toBe(DESIGN_REFRESH_MS);
      tick = fn;
      return () => (tick = null);
    },
  });
  return {
    refresher,
    asked,
    answer: (next: ReadonlyArray<DesignRefresh>) => (answer = next),
    advance: (ms: number) => (clock += ms),
    hide: () => (visible = false),
    tick: () => tick?.(),
    wake: () => wake?.(),
    running: () => tick !== null && wake !== null,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("re-reading the designs a page shows", () => {
  it("asks for every watched design at once and tells each block what it found", async () => {
    const page = harness();
    const heard: Array<[string, number | null]> = [];
    const stopA = page.refresher.watch("a", (next) => heard.push(["a", next?.version ?? null]));
    page.refresher.watch("b", (next) => heard.push(["b", next?.version ?? null]));
    page.answer([design("a", 3)]);
    page.advance(5_000);
    page.tick();
    await settle();
    expect(page.asked).toEqual([["a", "b"]]);
    // "b" was not returned: gone, or no longer shown to the person.
    expect(heard).toEqual([
      ["a", 3],
      ["b", null],
    ]);
    stopA();
    page.advance(5_000);
    page.wake();
    await settle();
    expect(page.asked.at(-1)).toEqual(["b"]);
  });

  it("runs its timer only while something is watched, and only asks while the page is seen", async () => {
    const page = harness();
    expect(page.running()).toBe(false);
    const stop = page.refresher.watch("a", () => undefined);
    expect(page.running()).toBe(true);
    page.hide();
    page.advance(DESIGN_REFRESH_MS);
    page.tick();
    await settle();
    expect(page.asked).toEqual([]);
    stop();
    expect(page.running()).toBe(false);
  });
});

describe("Used in", () => {
  it("counts each doc once, including the ones the person is not on", () => {
    const use = (docId: string, tabId: string) => ({ docId, docTitle: docId, tabId, tabTitle: tabId });
    expect(usedInLabel({ uses: [], otherDocs: 0 })).toBe("Not in any doc");
    expect(usedInLabel({ uses: [use("d1", "t1"), use("d1", "t2")], otherDocs: 0 })).toBe(
      "Used in 1 doc",
    );
    expect(usedInLabel({ uses: [use("d1", "t1")], otherDocs: 2 })).toBe("Used in 3 docs");
  });
});

describe("a design block in a tab", () => {
  const markdown = new MarkdownManager({ extensions: flattenExtensions(createEditorExtensions()) });
  const editorOn = (source: string, editable = true) =>
    new Editor({
      element: null,
      extensions: createEditorExtensions(),
      content: source,
      contentType: "markdown",
      editable,
    });
  const blockPos = (editor: Editor) => {
    let at = -1;
    editor.state.doc.forEach((node, pos) => {
      if (at === -1 && node.type.name === "codeBlock") at = pos;
    });
    return at;
  };

  it.each([
    ["a bare block", designBlock("d1")],
    ["a frame and a caption", designBlock("d1", "The home screen", "Hero")],
    ["text around it", `Before\n\n${designBlock("d1", "Cap")}\n\nAfter`],
  ])("round-trips %s through markdown", (_name, source) => {
    expect(markdown.serialize(markdown.parse(source))).toBe(source);
  });

  it("inserts at the caret with a line after it, and only where the tab can change", () => {
    const editor = editorOn("Before");
    expect(linkDesignAtCaret(editor, "d1", false)).toBe(true);
    expect(editor.getMarkdown()).toContain(designBlock("d1"));
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    editor.destroy();
    const readOnly = editorOn("Before", false);
    expect(insertDesignBlock(readOnly, "d1")).toBe(false);
    readOnly.destroy();
  });

  it("removes only the block, and leaves an empty line when it was the whole tab", () => {
    const editor = editorOn(`Before\n\n${designBlock("d1")}\n\nAfter`);
    editor.view.dispatch(removeDesignStep(editor.state, blockPos(editor))!);
    expect(editor.getMarkdown()).toBe("Before\n\nAfter");
    expect(removeDesignStep(editor.state, 0)).toBeNull();
    editor.destroy();
    const alone = editorOn(designBlock("d1"));
    alone.view.dispatch(removeDesignStep(alone.state, blockPos(alone))!);
    expect(alone.state.doc.childCount).toBe(1);
    expect(alone.getMarkdown()).not.toContain("t3-design");
    alone.destroy();
  });
});
