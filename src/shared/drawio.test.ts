import { describe, expect, it } from "vitest";

import {
  checkDiagramXml,
  checkDrawioIn,
  diagramPictureUrl,
  drawioBlock,
  drawioBlockBody,
  drawioBlocks,
  drawioDiagramIds,
  isDrawioLanguage,
  isPictureCurrent,
  MAX_DIAGRAM_PAGES,
  MAX_DIAGRAM_XML_BYTES,
  pageIndexOf,
  pagePicture,
  parseDrawioBlock,
} from "./drawio.ts";

const ID = "3f2c1a9e-5b7d-4c21-9e0f-6a8b7c5d4e3f";

describe("parseDrawioBlock", () => {
  it("reads the diagram id, and a caption when there is one", () => {
    expect(parseDrawioBlock(ID)).toEqual({ diagramId: ID, page: null, caption: null });
    expect(parseDrawioBlock(`  ${ID}  \n  How a client is onboarded  \n`)).toEqual({
      diagramId: ID,
      page: null,
      caption: "How a client is onboarded",
    });
    expect(parseDrawioBlock(`${ID}\n\n`)).toEqual({ diagramId: ID, page: null, caption: null });
  });

  it("reads a page line after the id, then the caption", () => {
    expect(parseDrawioBlock(`${ID}\npage: Sales detail`)).toEqual({
      diagramId: ID,
      page: "Sales detail",
      caption: null,
    });
    expect(parseDrawioBlock(`${ID}\n  page:   Sales   detail \nThe sales steps`)).toEqual({
      diagramId: ID,
      page: "Sales detail",
      caption: "The sales steps",
    });
    // An empty page line is the first page.
    expect(parseDrawioBlock(`${ID}\npage:\nCaption`)).toEqual({
      diagramId: ID,
      page: null,
      caption: "Caption",
    });
  });

  it("reads a caption that starts with page: as a page line, unless an empty page line comes first", () => {
    // The rule: the line after the id is the page line whenever it starts with "page:".
    expect(parseDrawioBlock(`${ID}\npage: one of three`)).toMatchObject({
      page: "one of three",
      caption: null,
    });
    // Such a caption is written after an empty page line, and reads back as written.
    const body = drawioBlockBody(ID, "page: one of three");
    expect(body).toBe(`${ID}\npage:\npage: one of three`);
    expect(parseDrawioBlock(body)).toEqual({
      diagramId: ID,
      page: null,
      caption: "page: one of three",
    });
    // "Page:" in another case, or later in the line, is a caption as before.
    expect(parseDrawioBlock(`${ID}\nPage: 3 of the flow`)).toMatchObject({
      page: null,
      caption: "Page: 3 of the flow",
    });
  });

  it("writes and reads back a page with a caption", () => {
    expect(drawioBlockBody(ID, "Flow", "Sales\n detail")).toBe(`${ID}\npage: Sales detail\nFlow`);
    expect(drawioBlock(ID, null, "Detail")).toBe(`\`\`\`t3-drawio\n${ID}\npage: Detail\n\`\`\``);
    expect(parseDrawioBlock(drawioBlockBody(ID, "Flow", "Detail"))).toEqual({
      diagramId: ID,
      page: "Detail",
      caption: "Flow",
    });
  });

  it.each([
    [""],
    ["\n"],
    [`diagram: ${ID}`],
    [`https://docs.example.com/diagrams/${ID}`],
    [`${ID} extra`],
    ["a".repeat(65)],
    [`${ID}\nCaption\nthird line`],
    [`${ID}\n${"c".repeat(301)}`],
    ["<mxfile></mxfile>"],
    [`${ID}\npage: A\nCaption\nthird line`],
    [`${ID}\npage: ${"p".repeat(201)}`],
    [`page: A\n${ID}`],
  ])("refuses %j", (body) => {
    expect(parseDrawioBlock(body)).toBeNull();
  });

  it("builds a body, and a whole block, with a one-line caption", () => {
    expect(drawioBlockBody(ID)).toBe(ID);
    expect(drawioBlockBody(ID, " Two\nlines ")).toBe(`${ID}\nTwo lines`);
    expect(drawioBlockBody(ID, "   ")).toBe(ID);
    expect(drawioBlock(ID, "Flow")).toBe(`\`\`\`t3-drawio\n${ID}\nFlow\n\`\`\``);
    expect(parseDrawioBlock(drawioBlockBody(ID, "Flow"))).toEqual({
      diagramId: ID,
      page: null,
      caption: "Flow",
    });
  });

  it("matches the language's first word", () => {
    expect(isDrawioLanguage("t3-drawio")).toBe(true);
    expect(isDrawioLanguage(" t3-drawio later-option")).toBe(true);
    expect(isDrawioLanguage("t3-drawios")).toBe(false);
    expect(isDrawioLanguage("drawio")).toBe(false);
    expect(isDrawioLanguage(null)).toBe(false);
  });
});

describe("drawioDiagramIds", () => {
  it("lists each linked diagram once, skipping bad blocks and other languages", () => {
    const markdown = [
      "Intro",
      drawioBlock("one"),
      "```t3-drawio\nnot an id!\n```",
      `\`\`\`t3-video\n${ID}\n\`\`\``,
      drawioBlock("two", "Caption"),
      `~~~t3-drawio\none\n~~~`,
      `Mentioned in text: ${ID}`,
    ].join("\n\n");
    expect(drawioDiagramIds(markdown)).toEqual(["one", "two"]);
    expect(drawioDiagramIds("No blocks here.")).toEqual([]);
  });
});

describe("checkDrawioIn", () => {
  it("passes valid blocks and names the bad one", () => {
    expect(checkDrawioIn(drawioBlock(ID, "Caption"))).toBeNull();
    expect(checkDrawioIn("No blocks.")).toBeNull();
    const problem = checkDrawioIn(`${drawioBlock(ID)}\n\n\`\`\`t3-drawio\ndiagram: ${ID}\n\`\`\``);
    expect(problem).toContain("t3-drawio block 2");
    expect(problem).toContain("the first line must be the id of a diagram");
  });

  it("does not re-check a block left as it was", () => {
    const old = "```t3-drawio\nnot an id!\n```";
    expect(checkDrawioIn(`${old}\n\nNew line.`, old)).toBeNull();
    expect(checkDrawioIn(old)).toContain("The t3-drawio block");
  });
});

describe("checkDiagramXml", () => {
  it("takes an empty source, an mxfile and a bare graph model", () => {
    expect(checkDiagramXml("")).toBeNull();
    expect(checkDiagramXml('<mxfile host="embed.diagrams.net"><diagram/></mxfile>')).toBeNull();
    expect(checkDiagramXml("<mxGraphModel><root/></mxGraphModel>")).toBeNull();
    expect(checkDiagramXml('<?xml version="1.0"?>\n<mxfile></mxfile>')).toBeNull();
  });

  it("refuses anything that is not Draw.io XML", () => {
    expect(checkDiagramXml("<svg></svg>")?.code).toBe("invalid_xml");
    expect(checkDiagramXml("graph TD; A-->B")?.code).toBe("invalid_xml");
    expect(checkDiagramXml("<mxfileish/>")?.code).toBe("invalid_xml");
  });

  it("caps the source by its size in bytes, not characters", () => {
    const wrap = (filler: string) => `<mxGraphModel>${filler}</mxGraphModel>`;
    const overhead = wrap("").length;
    expect(checkDiagramXml(wrap("a".repeat(MAX_DIAGRAM_XML_BYTES - overhead)))).toBeNull();
    const over = checkDiagramXml(wrap("a".repeat(MAX_DIAGRAM_XML_BYTES - overhead + 1)));
    expect(over?.code).toBe("too_large");
    expect(over?.message).toContain("1 MB limit");
    // Three bytes each in UTF-8.
    expect(checkDiagramXml(wrap("€".repeat(MAX_DIAGRAM_XML_BYTES / 3)))?.code).toBe(
      "too_large",
    );
  });
});

describe("pictures", () => {
  it("names the picture's version in the URL when it is known", () => {
    expect(diagramPictureUrl(ID, "svg")).toBe(`/api/diagrams/${ID}/picture.svg`);
    expect(diagramPictureUrl(ID, "png", 4)).toBe(`/api/diagrams/${ID}/picture.png?v=4`);
    expect(diagramPictureUrl(ID, "svg", null)).toBe(`/api/diagrams/${ID}/picture.svg`);
  });

  it("is current when drawn from this version, or when there is nothing to draw", () => {
    expect(isPictureCurrent({ hasSource: true, version: 3, pictureVersion: 3 })).toBe(true);
    expect(isPictureCurrent({ hasSource: true, version: 3, pictureVersion: 2 })).toBe(false);
    expect(isPictureCurrent({ hasSource: true, version: 1, pictureVersion: null })).toBe(false);
    expect(isPictureCurrent({ hasSource: false, version: 1, pictureVersion: null })).toBe(true);
  });
});

describe("a block's page", () => {
  const pages = ["Overview", "Sales  detail", null, "Overview"];

  it("finds a page by name, the first of that name, with spaces collapsed", () => {
    expect(pageIndexOf(pages, "Overview")).toBe(0);
    expect(pageIndexOf(pages, "Sales detail")).toBe(1);
    expect(pageIndexOf(pages, "overview")).toBe(-1);
  });

  it("picks the stored picture of the page, or says why there is none", () => {
    expect(pagePicture({ picturePages: pages }, null)).toEqual({ kind: "picture", index: 0 });
    expect(pagePicture({ picturePages: pages }, "Sales detail")).toEqual({
      kind: "picture",
      index: 1,
    });
    expect(pagePicture({ picturePages: pages }, "Gone")).toEqual({ kind: "not_found" });
    // A picture from before pages shows the first page, and cannot tell any other.
    expect(pagePicture({ picturePages: null }, null)).toEqual({ kind: "picture", index: 0 });
    expect(pagePicture({ picturePages: null }, "Overview")).toEqual({ kind: "unknown" });
    const many = Array.from({ length: MAX_DIAGRAM_PAGES + 1 }, (_, index) => `P${index}`);
    expect(pagePicture({ picturePages: many }, `P${MAX_DIAGRAM_PAGES}`)).toEqual({
      kind: "no_picture",
    });
  });

  it("serves the first page at the address it always had, and other pages by number", () => {
    expect(diagramPictureUrl("g1", "svg", 3)).toBe("/api/diagrams/g1/picture.svg?v=3");
    expect(diagramPictureUrl("g1", "svg", 3, 2)).toBe("/api/diagrams/g1/picture.svg?page=2&v=3");
    expect(diagramPictureUrl("g1", "png", null, 1)).toBe("/api/diagrams/g1/picture.png?page=1");
  });

  it("lists every block with its page", () => {
    const markdown = [drawioBlock("one"), drawioBlock("two", "Caption", "Detail")].join("\n\n");
    expect(drawioBlocks(markdown)).toEqual([
      { diagramId: "one", page: null, caption: null },
      { diagramId: "two", page: "Detail", caption: "Caption" },
    ]);
    expect(checkDrawioIn(markdown)).toBeNull();
  });
});
