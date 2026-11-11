import { describe, expect, it } from "vitest";

import { drawioBlock } from "./drawio.ts";
import {
  drawioExport,
  drawioToMarkdown,
  type ExportDiagram,
  type ExportDiagrams,
} from "./drawioExport.ts";

const ORIGIN = "https://docs.test";

const diagram = (overrides: Partial<ExportDiagram> = {}): ExportDiagram => ({
  id: "g1",
  title: "Onboarding flow",
  pictureVersion: 3,
  picturePages: null,
  hasSource: true,
  ...overrides,
});

const having = (...diagrams: Array<ExportDiagram>): ExportDiagrams =>
  new Map(diagrams.map((each) => [each.id, each]));

describe("a linked diagram in an export", () => {
  it("is its picture and its caption", () => {
    expect(
      drawioExport({ diagramId: "g1", page: null, caption: "How a client starts" }, having(diagram()), ORIGIN),
    ).toEqual({
      title: "Onboarding flow",
      caption: "How a client starts",
      pictureUrl: "https://docs.test/api/diagrams/g1/picture.svg",
      pageUrl: "https://docs.test/diagrams/g1",
      note: null,
    });
  });

  it("links the PNG when asked, and never pins a version, so the link shows later saves", () => {
    const out = drawioExport({ diagramId: "g1", page: null, caption: null }, having(diagram()), ORIGIN, "png");
    expect(out.pictureUrl).toBe("https://docs.test/api/diagrams/g1/picture.png");
  });

  it("is the title and a note while there is no picture", () => {
    const undrawn = drawioExport(
      { diagramId: "g1", page: null, caption: null },
      having(diagram({ pictureVersion: null })),
      ORIGIN,
    );
    expect(undrawn).toMatchObject({
      title: "Onboarding flow",
      pictureUrl: null,
      pageUrl: "https://docs.test/diagrams/g1",
      note: "Diagram: its picture has not been drawn yet.",
    });
    const empty = drawioExport(
      { diagramId: "g1", page: null, caption: null },
      having(diagram({ pictureVersion: null, hasSource: false })),
      ORIGIN,
    );
    expect(empty.note).toBe("Diagram: nothing has been drawn in it yet.");
  });

  it("says so when the diagram is gone, and keeps the caption", () => {
    expect(drawioExport({ diagramId: "gone", page: null, caption: "The flow" }, having(), ORIGIN)).toEqual({
      title: null,
      caption: "The flow",
      pictureUrl: null,
      pageUrl: null,
      note: "Diagram not found.",
    });
  });
});

describe("linked diagrams as markdown", () => {
  it("writes each block as an image with its caption under it", () => {
    const markdown = `Before\n\n${drawioBlock("g1", "How a client starts")}\n\nAfter\n`;
    expect(drawioToMarkdown(markdown, ORIGIN, having(diagram()))).toBe(
      "Before\n\n![Onboarding flow](https://docs.test/api/diagrams/g1/picture.svg)\n\n" +
        "How a client starts\n\nAfter\n",
    );
  });

  it("writes the title and a note for a diagram with no picture, and for one that is gone", () => {
    const markdown = `${drawioBlock("g1")}\n\n${drawioBlock("gone", "Old flow")}\n`;
    expect(drawioToMarkdown(markdown, ORIGIN, having(diagram({ pictureVersion: null })))).toBe(
      "[Onboarding flow](https://docs.test/diagrams/g1) " +
        "(Diagram: its picture has not been drawn yet.)\n\n*Diagram not found.*\n\nOld flow\n",
    );
  });

  it("escapes brackets in a title, so the image stays one image", () => {
    const out = drawioToMarkdown(
      drawioBlock("g1"),
      ORIGIN,
      having(diagram({ title: "Flow [v2]" })),
    );
    expect(out).toBe("![Flow \\[v2\\]](https://docs.test/api/diagrams/g1/picture.svg)");
  });

  it("leaves other blocks, and a block that does not parse, as they are", () => {
    const markdown = "```ts\nconst a = 1;\n```\n\n```t3-drawio\nnot an id!\nx\ny\n```\n";
    expect(drawioToMarkdown(markdown, ORIGIN, having(diagram()))).toBe(markdown);
  });

  it("handles a tilde fence and the same diagram linked twice", () => {
    const markdown = `~~~t3-drawio\ng1\n~~~\n\n${drawioBlock("g1")}`;
    const image = "![Onboarding flow](https://docs.test/api/diagrams/g1/picture.svg)";
    expect(drawioToMarkdown(markdown, ORIGIN, having(diagram()))).toBe(`${image}\n\n${image}`);
  });
});

describe("a block that names a page, in an export", () => {
  const paged = diagram({ picturePages: ["Overview", "Sales detail"] });

  it("is that page's picture", () => {
    const out = drawioExport({ diagramId: "g1", page: "Sales detail", caption: null }, having(paged), ORIGIN);
    expect(out.pictureUrl).toBe("https://docs.test/api/diagrams/g1/picture.svg?page=1");
    const first = drawioExport({ diagramId: "g1", page: "Overview", caption: null }, having(paged), ORIGIN);
    expect(first.pictureUrl).toBe("https://docs.test/api/diagrams/g1/picture.svg");
  });

  it("says the page is not found, or that its picture is not drawn yet", () => {
    const gone = drawioExport({ diagramId: "g1", page: "Pricing", caption: "P" }, having(paged), ORIGIN);
    expect(gone).toMatchObject({
      pictureUrl: null,
      caption: "P",
      note: 'Page not found: the diagram has no page "Pricing".',
    });
    const unknown = drawioExport({ diagramId: "g1", page: "Overview", caption: null }, having(diagram()), ORIGIN);
    expect(unknown.note).toBe('Diagram page "Overview": its picture has not been drawn yet.');
  });
});
