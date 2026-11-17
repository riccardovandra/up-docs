import * as NodeFS from "node:fs";

import { describe, expect, it } from "vitest";

import { drawioWarnings, readDrawio } from "./drawioModel.ts";

const model = (cells: string) =>
  `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`;
const BOX = "rounded=1;whiteSpace=wrap;html=1;";
const box = (
  id: string,
  label: string,
  [x, y, width, height]: [number, number, number, number],
  style = BOX,
  parent = "1",
) =>
  `<mxCell id="${id}" value="${label}" style="${style}" vertex="1" parent="${parent}">` +
  `<mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry"/></mxCell>`;
const edge = (
  id: string,
  source: string,
  target: string,
  points: ReadonlyArray<[number, number]> = [],
  style = "edgeStyle=orthogonalEdgeStyle;html=1;",
) =>
  `<mxCell id="${id}" style="${style}" edge="1" parent="1" source="${source}" target="${target}">` +
  `<mxGeometry relative="1" as="geometry">${
    points.length === 0
      ? ""
      : `<Array as="points">${points.map(([x, y]) => `<mxPoint x="${x}" y="${y}"/>`).join("")}</Array>`
  }</mxGeometry></mxCell>`;

const warnings = async (cells: string) => drawioWarnings(await readDrawio(model(cells)));

describe("layout warnings", () => {
  it("reports a label that runs outside its box, and not one that fits", async () => {
    const long = "Received, shipped, container emails and more";
    const [overflow] = await warnings(box("a", long, [0, 0, 120, 40], "rounded=1;"));
    expect(overflow).toContain('"Received, shipped, container emails and');
    expect(overflow).toContain("runs outside its box");
    expect(overflow).toContain("whiteSpace=wrap");
    expect(await warnings(box("a", long, [0, 0, 300, 40], "rounded=1;"))).toEqual([]);
    // Wrapped, it fits in a taller box but not a short one.
    expect(await warnings(box("a", long, [0, 0, 120, 70]))).toEqual([]);
    const lines = "&lt;b&gt;Reader&lt;/b&gt;&lt;br&gt;one line&lt;br&gt;two line&lt;br&gt;three line&lt;br&gt;four line";
    expect((await warnings(box("a", lines, [0, 0, 160, 50])))[0]).toContain('"Reader"');
    expect(await warnings(box("a", lines, [0, 0, 160, 90]))).toEqual([]);
  });

  it("checks a container's header only, and leaves labels drawn outside a shape alone", async () => {
    const title = "BACKGROUND WORK (Render, Frankfurt)";
    expect(await warnings(box("c", title, [0, 0, 300, 400], "swimlane;startSize=30;html=1;"))).toEqual([]);
    expect((await warnings(box("c", title, [0, 0, 120, 400], "swimlane;startSize=30;html=1;")))[0]).toContain(
      "runs outside its box",
    );
    expect(
      await warnings(box("i", title, [0, 0, 40, 40], "rounded=1;verticalLabelPosition=bottom;")),
    ).toEqual([]);
  });

  it("reports boxes that overlap or stick out of their container, and not a badge on a box", async () => {
    const overlap = await warnings(box("a", "n8n", [0, 0, 200, 100]) + box("b", "OpenRouter", [20, 80, 200, 60]));
    expect(overlap).toEqual(['"n8n" and "OpenRouter" overlap: move one so they have a gap between them.']);
    expect(
      await warnings(box("a", "n8n", [0, 0, 200, 100]) + box("b", "!", [180, -10, 30, 20])),
    ).toHaveLength(1);
    expect(await warnings(box("a", "n8n", [0, 0, 200, 100]) + box("b", "!", [170, 10, 20, 20]))).toEqual([]);
    const lane = box("lane", "Lane", [0, 0, 200, 200], "swimlane;startSize=30;html=1;");
    const poking = await warnings(lane + box("b", "Box", [150, 50, 100, 40], BOX, "lane"));
    expect(poking).toEqual(['"Box" sticks out of "Lane": move it fully inside, or make "Lane" bigger.']);
    expect(await warnings(lane + box("b", "Box", [20, 50, 100, 40], BOX, "lane"))).toEqual([]);
  });

  it("reports a line through a box that is neither of its ends", async () => {
    const row = box("a", "A", [0, 0, 100, 60]) + box("m", "Middle", [200, 0, 100, 60]) + box("b", "B", [400, 0, 100, 60]);
    const [through] = await warnings(row + edge("e", "a", "b"));
    expect(through).toContain('The connection "A" -> "B" runs through "Middle".');
    // Bend points that go around it are fine.
    expect(await warnings(row + edge("e", "a", "b", [[50, 120], [450, 120]]))).toEqual([]);
    // Bend points that lead back through it are not.
    const [back] = await warnings(
      box("a", "A", [0, 0, 100, 60]) +
        box("t", "Target", [400, 0, 100, 60]) +
        box("u", "Under", [400, 150, 100, 60]) +
        edge("e", "a", "t", [[50, 300], [450, 300]]),
    );
    expect(back).toContain('runs through "Under"');
  });

  it("lets lines cross containers and the frames drawn behind boxes", async () => {
    const lanes =
      box("l1", "Lane one", [0, 0, 200, 300], "swimlane;startSize=30;html=1;") +
      box("l2", "Lane two", [250, 0, 200, 300], "swimlane;startSize=30;html=1;") +
      box("a", "A", [40, 60, 120, 60], BOX, "l1") +
      box("b", "B", [40, 60, 120, 60], BOX, "l2");
    expect(await warnings(lanes + edge("e", "a", "b"))).toEqual([]);
    // A plain rectangle drawn around boxes, without being their parent, counts as a frame too.
    const framed =
      box("f", "", [0, 0, 600, 200], "rounded=1;fillColor=#fff2cc;") +
      box("a", "A", [20, 60, 100, 60]) +
      box("b", "B", [400, 60, 100, 60]);
    expect(await warnings(framed + edge("e", "a", "b"))).toEqual([]);
  });

  it("reports two connections drawn on top of each other, and not lines that fan into one shape", async () => {
    const boxes =
      box("a", "A", [0, 0, 100, 60]) +
      box("b", "B", [400, 300, 100, 60]) +
      box("c", "C", [0, 150, 100, 60]) +
      box("d", "D", [400, 450, 100, 60]);
    const ab = edge("e1", "a", "b", [[250, 30], [250, 330]]);
    expect(await warnings(boxes + ab + edge("e2", "c", "d", [[250, 180], [250, 480]]))).toEqual([
      'The connections "A" -> "B" and "C" -> "D" run on top of each other for 150 px. Move one with bend points.',
    ]);
    // 30 px apart, they read as two lines.
    expect(await warnings(boxes + ab + edge("e2", "c", "d", [[280, 180], [280, 480]]))).toEqual([]);
    // Into the same shape, the shared run is one bus.
    expect(await warnings(boxes + ab + edge("e2", "c", "b", [[250, 180], [250, 330]]))).toEqual([]);
  });

  it("reports a line that runs along the edge of a box that is not one of its ends", async () => {
    const ends = box("a", "A", [0, 0, 100, 60]) + box("b", "B", [500, 0, 100, 60]) + edge("e", "a", "b");
    const [hug] = await warnings(ends + box("m", "Middle", [200, 34, 100, 60]));
    expect(hug).toBe(
      'The connection "A" -> "B" runs along the edge of "Middle", so it reads as part of the box. ' +
        "Give it bend points that keep it 20 px or more away, or move the box.",
    );
    expect(await warnings(ends + box("m", "Middle", [200, 50, 100, 60]))).toEqual([]);
  });

  // A table: a swimlane whose rows are text cells that take lines on their left and right only.
  const ROW = "text;html=1;align=left;spacingLeft=8;whiteSpace=wrap;portConstraint=eastwest;";
  const table = (id: string, label: string, [x, y]: [number, number], rows: ReadonlyArray<string>, rowStyle = ROW) =>
    box(id, label, [x, y, 200, 30 + rows.length * 20], "swimlane;childLayout=stackLayout;startSize=30;html=1;") +
    rows.map((row, i) => box(`${id}_r${i}`, row, [0, 30 + i * 20, 200, 20], rowStyle, id)).join("");

  it("places a table's rows inside it, and counts the table as solid", async () => {
    const tables =
      table("items", "items", [0, 0], ["id", "format_id → formats"]) +
      table("insights", "insights", [300, 0], ["id", "text"]) +
      box("formats", "formats", [600, 20, 160, 60]);
    // The row sits at y 50 to 70: the line leaves its right side and crosses the middle table.
    const [through] = await warnings(tables + edge("e", "items_r1", "formats"));
    expect(through).toContain('The connection "format_id → formats" (in "items") -> "formats" runs through "insights".');
    // Routed under the tables, it is fine.
    expect(await warnings(tables + edge("e", "items_r1", "formats", [[250, 60], [250, 150], [680, 150]]))).toEqual([]);
    // A row whose points list only its two sides takes lines the same way.
    const sides = "text;html=1;whiteSpace=wrap;points=[[0,0.5],[1,0.5]];";
    const pointed =
      table("items", "items", [0, 0], ["id", "format_id → formats"], sides) +
      table("insights", "insights", [300, 0], ["id", "text"], sides) +
      box("formats", "formats", [600, 20, 160, 60]);
    expect((await warnings(pointed + edge("e", "items_r1", "formats")))[0]).toContain('runs through "insights"');
  });

  it("warns about the row arrows of a real tables page, and not the routed map that replaced them", async () => {
    const read = async (name: string) =>
      drawioWarnings(await readDrawio(NodeFS.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")));
    const crossing = await read("table-row-arrows.drawio");
    expect(crossing).toHaveLength(9);
    expect(crossing[0]).toBe(
      'The connection "format_id → formats" (in "discover_posts · Signal") -> "formats" runs through ' +
        '"items · Source or Reference" and "concept_insights". Give it bend points (<Array as="points">) that go ' +
        "around, through the gaps between boxes, or move the boxes.",
    );
    expect(crossing.some((w) => w.includes("runs along the edge of"))).toBe(true);
    expect(crossing[8]).toBe("11 more layout problems like these: fix the ones above and save again to see them.");
    expect(await read("table-links-routed.drawio")).toEqual([]);
  });

  it("caps the list and counts the rest", async () => {
    const cells = Array.from({ length: 12 }, (_, i) =>
      box(`b${i}`, "A label far too long for this box", [i * 200, 0, 60, 20], "rounded=1;"),
    ).join("");
    const listed = await warnings(cells);
    expect(listed).toHaveLength(9);
    expect(listed[8]).toBe("4 more layout problems like these: fix the ones above and save again to see them.");
  });
});
