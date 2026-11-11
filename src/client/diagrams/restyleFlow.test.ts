import { describe, expect, it } from "vitest";

import { UPLIFTED_THEME } from "../../shared/diagramTheme.ts";
import { startRestyleFlow, type RestyleState } from "./restyleFlow.ts";
import { conflictError, fakeApi, fakeDrawio, view } from "./testing/fakeDrawio.ts";

const NEUTRAL_XML =
  '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="a" value="A" style="rounded=0;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1"><mxGeometry width="80" height="40" as="geometry"/></mxCell>' +
  '<mxCell id="b" value="B" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="200" width="80" height="40" as="geometry"/></mxCell>' +
  '<mxCell id="e" style="html=1;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>' +
  "</root></mxGraphModel>";

const settle = async () => {
  for (let turn = 0; turn < 40; turn += 1) await new Promise((done) => setTimeout(done, 0));
};

function open(
  xml = NEUTRAL_XML,
  options: { readonly loads?: boolean; readonly effective?: boolean } = {},
) {
  const api = fakeApi([view({ id: "g1", xml, version: 3 })]);
  const drawio = fakeDrawio(options);
  const states: Array<RestyleState> = [];
  let frames = 0;
  const flow = startRestyleFlow({
    api,
    createFrame: () => {
      frames += 1;
      queueMicrotask(() => drawio.emit({ event: "init" }));
      return drawio.frame;
    },
    diagramId: "g1",
    theme: UPLIFTED_THEME,
    effective: options.effective ?? false,
    onState: (state) => states.push(state),
  });
  const last = () => states.at(-1)!;
  return { api, drawio, flow, states, last, frames: () => frames };
}

describe("restyle with theme", () => {
  it("previews the restyled first page, then applies it from the version previewed", async () => {
    const run = open();
    await settle();
    expect(run.last()).toMatchObject({
      phase: "ready",
      unchanged: false,
      text: "2 boxes, 1 arrow: 3 items change.",
    });
    expect((run.last() as { afterSvg: string }).afterSvg).toContain("<svg");
    // The frame drew the restyled source, not the stored one.
    const loaded = run.drawio.posted.find((action) => action.action === "load") as { xml: string };
    expect(loaded.xml).toContain("#dbe5f7");
    // Nothing is saved before the person confirms.
    expect(run.api.calls).toEqual([]);

    run.flow.confirm();
    await settle();
    expect(run.api.calls).toEqual([["restyle", "g1", { baseVersion: 3, themeId: "uplifted" }]]);
    expect(run.last()).toMatchObject({ phase: "done" });
    expect(run.api.diagrams.get("g1")!.version).toBe(4);
  });

  it("leaves the effective theme to the server, so a project theme the person does not own applies", async () => {
    const run = open(NEUTRAL_XML, { effective: true });
    run.api.themes.set("g1", UPLIFTED_THEME);
    await settle();
    run.flow.confirm();
    await settle();
    expect(run.api.calls).toEqual([["restyle", "g1", { baseVersion: 3 }]]);
    expect(run.last()).toMatchObject({ phase: "done" });
  });

  it("says when someone saved in between, and previews again on retry", async () => {
    const run = open();
    await settle();
    // Someone saves version 4 after the preview.
    const current = run.api.diagrams.get("g1")!;
    run.api.diagrams.set("g1", { ...current, version: 4 });
    run.flow.confirm();
    await settle();
    expect(run.last()).toEqual({ phase: "conflict" });

    run.flow.retry();
    await settle();
    expect(run.last()).toMatchObject({ phase: "ready" });
    run.flow.confirm();
    await settle();
    expect(run.api.calls.at(-1)).toEqual(["restyle", "g1", { baseVersion: 4, themeId: "uplifted" }]);
    // One frame served both previews.
    expect(run.frames()).toBe(1);
  });

  it("undoes the restyle by saving the source from before", async () => {
    const run = open();
    await settle();
    run.flow.confirm();
    await settle();
    run.flow.undo();
    await settle();
    expect(run.last()).toEqual({ phase: "undone" });
    expect(run.api.calls.at(-1)).toEqual(["update", "g1", { xml: NEUTRAL_XML, baseVersion: 4 }]);
    expect(run.api.diagrams.get("g1")!.xml).toBe(NEUTRAL_XML);
  });

  it("does not undo over a later save", async () => {
    const run = open();
    await settle();
    run.flow.confirm();
    await settle();
    run.api.fail.update = conflictError(run.api.diagrams.get("g1")!);
    run.flow.undo();
    await settle();
    expect(run.last()).toMatchObject({ phase: "failed", message: expect.stringContaining("not undone") });
  });

  it("offers nothing to apply when the diagram is already in the theme", async () => {
    const first = open();
    await settle();
    first.flow.confirm();
    await settle();
    const themed = first.api.diagrams.get("g1")!.xml!;
    const run = open(themed);
    await settle();
    expect(run.last()).toMatchObject({ phase: "ready", unchanged: true, afterSvg: null });
    expect(run.frames()).toBe(0);
    run.flow.confirm();
    await settle();
    expect(run.api.calls).toEqual([]);
  });
});
