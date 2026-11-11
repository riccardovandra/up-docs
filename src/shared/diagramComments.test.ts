import { describe, expect, it } from "vitest";

import {
  diagramCommentChatText,
  diagramToPicture,
  parseDiagramAnchor,
  pictureFrame,
  pictureToDiagram,
  pinPlacement,
  shapeAt,
  type DiagramCommentChat,
} from "./diagramComments.ts";
import { readDrawioLayout, type DrawioPageLayout } from "./drawioModel.ts";
import { diagramCommentForChat } from "./embed.ts";

const page = (cells: string, name = "Flow") =>
  `<diagram name="${name}" id="${name}-id"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel></diagram>`;
const shape = (id: string, label: string, x: number, y: number, w = 140, h = 60, parent = "1", style = "rounded=1;html=1;") =>
  `<mxCell id="${id}" value="${label}" style="${style}" vertex="1" parent="${parent}"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`;

const FILE =
  "<mxfile>" +
  page(
    shape("a", "Agent", 120, 80) +
    shape("b", "UP Docs", 420, 80) +
    '<mxCell id="e" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="340" y="20"/></Array></mxGeometry></mxCell>' +
    shape("grp", "Store", 120, 220, 440, 160, "1", "swimlane;html=1;") +
    shape("d1", "D1 database", 40, 50, 160, 80, "grp", "ellipse;html=1;"),
  ) +
  page(shape("z", "Only shape", -50, -30, 120, 50), "Second") +
  "</mxfile>";

async function layouts(): Promise<ReadonlyArray<DrawioPageLayout>> {
  const read = await readDrawioLayout(FILE);
  if (!read) throw new Error("unreadable");
  return read;
}

describe("diagram layout", () => {
  it("places shapes inside a container relative to it, and bounds edges' points too", async () => {
    const [flow, second] = await layouts();
    expect(flow!.name).toBe("Flow");
    expect(flow!.shapes.find((box) => box.id === "d1")).toEqual({
      id: "d1",
      label: "D1 database",
      x: 160,
      y: 270,
      width: 160,
      height: 80,
    });
    // The waypoint at y=20 lies above every shape.
    expect(flow!.bounds).toEqual({ x: 120, y: 20, width: 440, height: 360 });
    expect(second!.shapes.map((box) => box.id)).toEqual(["z"]);
    expect(await readDrawioLayout("<nope")).toBeNull();
  });
});

describe("diagram comment anchors", () => {
  it("reads a shape anchor, a point anchor, and refuses the rest", () => {
    expect(parseDiagramAnchor({ page: "Flow", shapeId: "a" })).toEqual({
      page: "Flow",
      shapeId: "a",
      x: null,
      y: null,
    });
    expect(parseDiagramAnchor({ x: 1.5, y: -2 })).toEqual({ page: null, shapeId: null, x: 1.5, y: -2 });
    for (const bad of [null, [], {}, { x: 1 }, { shapeId: "no spaces" }, { page: 3, x: 1, y: 1 }, { x: Infinity, y: 0 }]) {
      expect(parseDiagramAnchor(bad)).toBeNull();
    }
  });

  it("follows the shape, keeps a deleted shape's pin at its point, and snaps to the topmost shape", async () => {
    const [flow] = await layouts();
    expect(pinPlacement({ page: "Flow", shapeId: "d1", x: 1, y: 1 }, flow!)).toMatchObject({
      x: 320,
      y: 270,
      status: "shape",
    });
    expect(pinPlacement({ page: "Flow", shapeId: "gone", x: 7, y: 9 }, flow!)).toMatchObject({
      x: 7,
      y: 9,
      status: "shape_removed",
      shape: null,
    });
    expect(pinPlacement({ page: "Flow", shapeId: null, x: 3, y: 4 }, flow!).status).toBe("point");
    // Inside the container and the ellipse: the ellipse, drawn later, wins.
    expect(shapeAt(flow!, 200, 300)?.id).toBe("d1");
    expect(shapeAt(flow!, 500, 360)?.id).toBe("grp");
    expect(shapeAt(flow!, 0, 0)).toBeNull();
  });
});

describe("picture frame", () => {
  it("lines the picture up from a shape Draw.io drew, and maps both ways", async () => {
    const [flow] = await layouts();
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="442px" height="362px" viewBox="0 0 442 362"><g><g data-cell-id="0"><g data-cell-id="1">' +
      '<g data-cell-id="a"><g transform="translate(0.5,0.5)"><rect x="0" y="60" width="140" height="60" rx="9"/></g></g>' +
      "</g></g></g></svg>";
    const frame = pictureFrame(svg, flow!)!;
    expect(frame).toMatchObject({ width: 442, height: 362, dx: -120, dy: -20 });
    const fractions = diagramToPicture(frame, 320, 270);
    expect(pictureToDiagram(frame, fractions.fx, fractions.fy)).toEqual({ x: 320, y: 270 });
  });

  it("uses an ellipse when that is the first shape it can match", async () => {
    const [flow] = await layouts();
    const only = { ...flow!, shapes: flow!.shapes.filter((box) => box.id === "d1") };
    const svg =
      '<svg width="10" height="10" viewBox="0 0 442 362"><g data-cell-id="d1"><ellipse cx="120" cy="290" rx="80" ry="40"/></g></svg>';
    expect(pictureFrame(svg, only)).toMatchObject({ dx: -120, dy: -20 });
  });

  it("falls back on the drawing's bounds, and refuses a picture with no size", async () => {
    const [flow] = await layouts();
    expect(pictureFrame('<svg width="442px" height="362px"></svg>', flow!)).toMatchObject({
      viewX: 0,
      width: 442,
      dx: -120,
      dy: -20,
    });
    expect(pictureFrame("<svg></svg>", flow!)).toBeNull();
    expect(pictureFrame("not svg", flow!)).toBeNull();
  });
});

describe("diagram comments in the chat", () => {
  const chat: DiagramCommentChat = {
    diagramId: "d-1",
    diagramTitle: "Sales flow",
    url: "https://docs.test/diagrams/d-1",
    page: "Flow",
    commentId: "c-1",
    quote: "Proposal",
    body: "Split this step",
  };

  it("rides the add-to-chat message with empty doc ids and the diagram fields", () => {
    expect(diagramCommentForChat(chat)).toEqual({
      docId: "",
      tabId: "",
      docTitle: "Sales flow",
      url: "https://docs.test/diagrams/d-1",
      commentId: "c-1",
      quote: "Proposal",
      body: "Split this step",
      anchor: null,
      diagramId: "d-1",
      diagramTitle: "Sales flow",
      diagramPage: "Flow",
    });
  });

  it("writes a pasteable text that names the diagram, the shape and the loop", () => {
    const text = diagramCommentChatText(chat);
    expect(text).toContain('"Sales flow" (https://docs.test/diagrams/d-1), page "Flow", shape "Proposal"');
    expect(text).toContain("Split this step");
    expect(text).toContain('reply_comment {diagramId: "d-1", commentId: "c-1"}');
    expect(diagramCommentChatText({ ...chat, page: null, quote: "" })).toContain(
      "(https://docs.test/diagrams/d-1):",
    );
  });
});
