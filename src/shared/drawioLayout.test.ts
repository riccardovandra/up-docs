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

  it("caps the list and counts the rest", async () => {
    const cells = Array.from({ length: 12 }, (_, i) =>
      box(`b${i}`, "A label far too long for this box", [i * 200, 0, 60, 20], "rounded=1;"),
    ).join("");
    const listed = await warnings(cells);
    expect(listed).toHaveLength(9);
    expect(listed[8]).toBe("4 more layout problems like these: fix the ones above and save again to see them.");
  });
});
