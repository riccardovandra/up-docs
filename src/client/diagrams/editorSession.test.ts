import { describe, expect, it } from "vitest";

import { NEUTRAL_THEME, themeToDrawioConfig, UPLIFTED_THEME } from "../../shared/diagramTheme.ts";
import type { DiagramSummary } from "../../shared/drawio.ts";
import { ApiError } from "../api.ts";
import { subscribeDiagram } from "./diagramsApi.ts";
import {
  startEditorSession,
  type DiagramEditorTarget,
  type EditorSessionState,
} from "./editorSession.ts";
import { fakeApi, fakeDrawio, PNG_BASE64, SVG, view } from "./testing/fakeDrawio.ts";

const NEW_XML =
  '<mxfile><diagram name="Page-1" id="p1"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>';

/** Lets the session's promise chains settle: every answer here is a microtask away. */
const settle = async () => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

function open(
  target: DiagramEditorTarget,
  diagrams: Parameters<typeof fakeApi>[0] = [],
  options: Parameters<typeof fakeDrawio>[0] = {},
) {
  const api = fakeApi(diagrams);
  const drawio = fakeDrawio(options);
  const states: Array<EditorSessionState> = [];
  const saves: Array<DiagramSummary> = [];
  const closed: Array<DiagramSummary | null> = [];
  const session = startEditorSession({
    frame: drawio.frame,
    api,
    target,
    onState: (state) => states.push(state),
    onSaved: (diagram) => saves.push(diagram),
    onClose: (saved) => closed.push(saved),
  });
  const phase = () => states.at(-1)?.phase;
  return { api, drawio, states, saves, closed, session, phase };
}

const existing: DiagramEditorTarget = { kind: "existing", diagramId: "g1" };

describe("the theme", () => {
  it("answers Draw.io's configure with the diagram's theme, then loads", async () => {
    const api = fakeApi([view({ id: "g1", xml: "<mxGraphModel/>" })]);
    api.themes.set("g1", UPLIFTED_THEME);
    const drawio = fakeDrawio();
    startEditorSession({
      frame: drawio.frame,
      api,
      target: existing,
      onState: () => undefined,
      onClose: () => undefined,
    });
    drawio.emit({ event: "configure" });
    await settle();
    expect(drawio.posted).toEqual([
      { action: "configure", config: themeToDrawioConfig(UPLIFTED_THEME) },
    ]);
    drawio.emit({ event: "init" });
    await settle();
    expect(drawio.posted.at(-1)).toMatchObject({ action: "load" });
  });

  it("gives a new diagram its project's theme, and Neutral when the lookup fails", async () => {
    const { drawio } = open({ kind: "new", projectId: null });
    drawio.emit({ event: "configure" });
    await settle();
    expect(drawio.posted).toEqual([
      { action: "configure", config: themeToDrawioConfig(NEUTRAL_THEME) },
    ]);

    const failing = fakeApi([view({ id: "g1" })]);
    failing.theme = async () => {
      throw new ApiError(500, { error: "boom" });
    };
    const frame = fakeDrawio();
    startEditorSession({
      frame: frame.frame,
      api: failing,
      target: existing,
      onState: () => undefined,
      onClose: () => undefined,
    });
    frame.emit({ event: "configure" });
    await settle();
    expect(frame.posted).toEqual([
      { action: "configure", config: themeToDrawioConfig(NEUTRAL_THEME) },
    ]);
  });
});

describe("editing a diagram", () => {
  it("loads the stored source once Draw.io is ready", async () => {
    const { drawio, phase, states } = open(existing, [
      view({ id: "g1", title: "Onboarding", xml: "<mxfile>stored</mxfile>" }),
    ]);
    expect(drawio.posted).toEqual([]);
    drawio.emit({ event: "init" });
    await settle();
    expect(drawio.posted).toEqual([
      { action: "load", xml: "<mxfile>stored</mxfile>", title: "Onboarding" },
    ]);
    expect(phase()).toBe("ready");
    expect(states.at(-1)?.title).toBe("Onboarding");
  });

  it("on Save & Exit takes the picture, saves from its version, then uploads it", async () => {
    const { api, drawio, saves, closed } = open(existing, [view({ id: "g1", version: 4 })]);
    drawio.emit({ event: "init" });
    await settle();
    drawio.emit({ event: "save", xml: NEW_XML, exit: true });
    await settle();

    expect(drawio.posted.map((action) => action.action)).toEqual([
      "load",
      "export",
      "export",
      "status",
    ]);
    expect(api.calls).toEqual([
      ["update", "g1", { xml: NEW_XML, baseVersion: 4 }],
      ["uploadPicture", "g1", { version: 5, svg: SVG, png: PNG_BASE64, pageNames: ["Page-1"], morePages: [] }],
    ]);
    expect(saves).toHaveLength(1);
    expect(closed).toEqual([expect.objectContaining({ id: "g1", version: 5, pictureVersion: 5 })]);
  });

  it("saves a file of several pages without a canvas picture, for each page to be drawn on its own", async () => {
    const { api, drawio, closed } = open(existing, [view({ id: "g1", version: 4 })]);
    drawio.emit({ event: "init" });
    await settle();
    const twoPages =
      '<mxfile><diagram name="A"><mxGraphModel><root/></mxGraphModel></diagram>' +
      '<diagram name="B"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>';
    drawio.emit({ event: "save", xml: twoPages, exit: true });
    await settle();
    // The canvas holds only the page the person was on: it is not taken as the diagram's picture.
    expect(drawio.posted.map((action) => action.action)).toEqual(["load", "status"]);
    expect(api.calls).toEqual([["update", "g1", { xml: twoPages, baseVersion: 4 }]]);
    expect(closed).toEqual([expect.objectContaining({ version: 5, pictureVersion: null })]);
  });

  it("stays open after a plain Save, and saves the next one from the new version", async () => {
    const { api, drawio, closed, phase } = open(existing, [view({ id: "g1", version: 1 })]);
    drawio.emit({ event: "init" });
    await settle();
    drawio.emit({ event: "save", xml: NEW_XML, exit: false });
    await settle();
    expect(closed).toEqual([]);
    expect(phase()).toBe("ready");
    drawio.emit({ event: "save", xml: "<mxfile>again</mxfile>", exit: false });
    await settle();
    expect(api.calls.filter((call) => call[0] === "update").map((call) => call[2])).toEqual([
      { xml: NEW_XML, baseVersion: 1 },
      { xml: "<mxfile>again</mxfile>", baseVersion: 2 },
    ]);
  });

  it("changes nothing on Exit without saving", async () => {
    const { api, drawio, closed } = open(existing, [view({ id: "g1" })]);
    drawio.emit({ event: "init" });
    await settle();
    drawio.emit({ event: "exit" });
    expect(api.calls).toEqual([]);
    expect(closed).toEqual([null]);
  });

  it("still saves the source when no picture could be taken", async () => {
    const api = fakeApi([view({ id: "g1" })]);
    const drawio = fakeDrawio();
    const closed: Array<DiagramSummary | null> = [];
    // A frame that loads but never answers an export, cut short instead of waiting out the timeout.
    const post = drawio.frame.post;
    drawio.frame.post = (action) => {
      if (action.action === "export") {
        drawio.posted.push(action);
        queueMicrotask(() => drawio.emit({ event: "export", format: "svg", data: "data:," }));
      } else post(action);
    };
    startEditorSession({
      frame: drawio.frame,
      api,
      target: existing,
      onState: () => undefined,
      onClose: (saved) => closed.push(saved),
    });
    drawio.emit({ event: "init" });
    await settle();
    drawio.emit({ event: "save", xml: NEW_XML, exit: true });
    await settle();
    expect(api.calls).toEqual([["update", "g1", { xml: NEW_XML, baseVersion: 1 }]]);
    // The picture is behind: redraw on demand draws it when the diagram is next shown.
    expect(closed).toEqual([expect.objectContaining({ version: 2, pictureVersion: null })]);
  });

  it("keeps the drawing open and says why when the save is refused", async () => {
    const { api, drawio, closed, states } = open(existing, [view({ id: "g1" })]);
    api.fail.update = new ApiError(413, {
      error: "diagram_too_large",
      message: "The diagram is too large to save.",
    } as never);
    drawio.emit({ event: "init" });
    await settle();
    drawio.emit({ event: "save", xml: NEW_XML, exit: true });
    await settle();
    expect(closed).toEqual([]);
    expect(states.at(-1)).toMatchObject({
      phase: "ready",
      message: "Not saved. The diagram is too large to save.",
    });
    // The same drawing can be saved again once the cause is gone.
    drawio.emit({ event: "save", xml: NEW_XML, exit: true });
    await settle();
    expect(closed).toHaveLength(1);
  });

  it("does not open a diagram for someone who only views it", async () => {
    const { drawio, states } = open(existing, [view({ id: "g1", canEdit: false, xml: null })]);
    drawio.emit({ event: "init" });
    await settle();
    expect(drawio.posted).toEqual([]);
    expect(states.at(-1)).toMatchObject({
      phase: "failed",
      message: "Only the diagram's creator can change it.",
    });
  });
});

describe("a stale save", () => {
  /** Opens at version 1, then someone else saves version 2 before this editor does. */
  async function conflicted(exit: boolean) {
    const opened = open(existing, [view({ id: "g1", version: 1, xml: "<mxfile>mine</mxfile>" })]);
    opened.drawio.emit({ event: "init" });
    await settle();
    opened.api.diagrams.set("g1", view({ id: "g1", version: 2, xml: "<mxfile>theirs</mxfile>" }));
    opened.drawio.emit({ event: "save", xml: NEW_XML, exit });
    await settle();
    expect(opened.phase()).toBe("conflict");
    expect(opened.closed).toEqual([]);
    return opened;
  }

  it("overwrites from the version the conflict named, then finishes the exit", async () => {
    const { api, session, closed } = await conflicted(true);
    session.resolveConflict("overwrite");
    await settle();
    expect(api.calls.filter((call) => call[0] === "update").map((call) => call[2])).toEqual([
      { xml: NEW_XML, baseVersion: 1 },
      { xml: NEW_XML, baseVersion: 2 },
    ]);
    expect(api.diagrams.get("g1")).toMatchObject({ xml: NEW_XML, version: 3, pictureVersion: 3 });
    expect(closed).toEqual([expect.objectContaining({ version: 3 })]);
  });

  it("reloads their version into the editor and stays open", async () => {
    const { api, drawio, session, closed, phase } = await conflicted(true);
    session.resolveConflict("reload");
    await settle();
    expect(drawio.posted.at(-1)).toEqual({
      action: "load",
      xml: "<mxfile>theirs</mxfile>",
      title: "Flow",
    });
    expect(phase()).toBe("ready");
    expect(closed).toEqual([]);
    expect(api.diagrams.get("g1")?.xml).toBe("<mxfile>theirs</mxfile>");
    // The next save goes from their version.
    drawio.emit({ event: "save", xml: NEW_XML, exit: true });
    await settle();
    expect(api.calls.at(-2)).toEqual(["update", "g1", { xml: NEW_XML, baseVersion: 2 }]);
    expect(closed).toHaveLength(1);
  });
});

describe("the page under the overlay", () => {
  /** A block of the diagram on the page, as the notice board reaches it. */
  function block() {
    const heard: Array<DiagramSummary | null> = [];
    const stop = subscribeDiagram("g1", (diagram) => heard.push(diagram));
    return { heard, stop };
  }

  it("shows their version after Reload theirs and then Exit", async () => {
    const { heard, stop } = block();
    const opened = open(existing, [view({ id: "g1", version: 1, pictureVersion: 1 })]);
    opened.drawio.emit({ event: "init" });
    await settle();
    // An agent saves version 2 and a browser draws its picture, before this editor saves.
    opened.api.diagrams.set("g1", view({ id: "g1", version: 2, pictureVersion: 2 }));
    opened.drawio.emit({ event: "save", xml: NEW_XML, exit: true });
    await settle();
    expect(opened.phase()).toBe("conflict");
    expect(heard).toEqual([]);

    opened.session.resolveConflict("reload");
    await settle();
    // The editor took their version, and so did the page.
    expect(heard).toEqual([expect.objectContaining({ id: "g1", version: 2, pictureVersion: 2 })]);

    opened.drawio.emit({ event: "exit" });
    // Nothing was saved here, so the close reports nothing: the reload already told the page.
    expect(opened.closed).toEqual([null]);
    expect(heard.at(-1)).toMatchObject({ version: 2, pictureVersion: 2 });
    stop();
  });
});

describe("a new diagram", () => {
  const fresh: DiagramEditorTarget = { kind: "new", projectId: "p1" };

  it("opens empty and creates nothing when the person exits without saving", async () => {
    const { api, drawio, closed, states } = open(fresh);
    expect(states).toEqual([]);
    drawio.emit({ event: "init" });
    await settle();
    expect(drawio.posted).toEqual([{ action: "load", xml: "", title: "Untitled diagram" }]);
    drawio.emit({ event: "exit" });
    expect(api.calls).toEqual([]);
    expect(api.diagrams.size).toBe(0);
    expect(closed).toEqual([null]);
  });

  it("is created in its project by the first save, and updated by the next", async () => {
    const { api, drawio, closed } = open(fresh);
    drawio.emit({ event: "init" });
    await settle();
    drawio.emit({ event: "save", xml: NEW_XML, exit: false });
    await settle();
    expect(api.calls).toEqual([
      ["create", { projectId: "p1", title: "Untitled diagram", xml: NEW_XML }],
      [
        "uploadPicture",
        "new1",
        { version: 1, svg: SVG, png: PNG_BASE64, pageNames: ["Page-1"], morePages: [] },
      ],
    ]);
    drawio.emit({ event: "save", xml: "<mxfile>more</mxfile>", exit: true });
    await settle();
    expect(api.calls[2]).toEqual([
      "update",
      "new1",
      { xml: "<mxfile>more</mxfile>", baseVersion: 1 },
    ]);
    expect(closed).toEqual([expect.objectContaining({ id: "new1", version: 2 })]);
  });

  it("hears nothing more once disposed", async () => {
    const { api, drawio, session, closed } = open(fresh);
    drawio.emit({ event: "init" });
    await settle();
    session.dispose();
    drawio.emit({ event: "save", xml: NEW_XML, exit: true });
    drawio.emit({ event: "exit" });
    await settle();
    expect(api.calls).toEqual([]);
    expect(closed).toEqual([]);
  });
});
