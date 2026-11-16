import { describe, expect, it } from "vitest";

import {
  checkDiagramXml,
  checkDrawioIn,
  diagramPictureUrl,
  drawioBlock,
  drawioBlockBody,
  drawioBlocks,
  drawioDiagramIds,
  findPart,
  isDrawioLanguage,
  isPictureCurrent,
  MAX_DIAGRAM_PAGES,
  MAX_DIAGRAM_XML_BYTES,
  pageIndexOf,
  pagePicture,
  parseDrawioBlock,
  partLine,
  partOptions,
  partPicture,
} from "./drawio.ts";

const ID = "3f2c1a9e-5b7d-4c21-9e0f-6a8b7c5d4e3f";

describe("parseDrawioBlock", () => {
  it("reads the diagram id, and a caption when there is one", () => {
    expect(parseDrawioBlock(ID)).toEqual({ diagramId: ID, page: null, part: null, caption: null });
    expect(parseDrawioBlock(`  ${ID}  \n  How a client is onboarded  \n`)).toEqual({
      diagramId: ID,
      page: null,
      part: null,
      caption: "How a client is onboarded",
    });
    expect(parseDrawioBlock(`${ID}\n\n`)).toEqual({ diagramId: ID, page: null, part: null, caption: null });
  });

  it("reads a page line after the id, then the caption", () => {
    expect(parseDrawioBlock(`${ID}\npage: Sales detail`)).toEqual({
      diagramId: ID,
      page: "Sales detail",
      part: null,
      caption: null,
    });
    expect(parseDrawioBlock(`${ID}\n  page:   Sales   detail \nThe sales steps`)).toEqual({
      diagramId: ID,
      page: "Sales detail",
      part: null,
      caption: "The sales steps",
    });
    // An empty page line is the first page.
    expect(parseDrawioBlock(`${ID}\npage:\nCaption`)).toEqual({
      diagramId: ID,
      page: null,
      part: null,
      caption: "Caption",
    });
  });

  it("reads a caption that starts with page: as a page line, unless an empty page line comes first", () => {
    // The rule: the line after the id is the page line whenever it starts with "page:".
    expect(parseDrawioBlock(`${ID}\npage: one of three`)).toMatchObject({
      page: "one of three",
      part: null,
      caption: null,
    });
    // Such a caption is written after an empty page line, and reads back as written.
    const body = drawioBlockBody(ID, "page: one of three");
    expect(body).toBe(`${ID}\npage:\npage: one of three`);
    expect(parseDrawioBlock(body)).toEqual({
      diagramId: ID,
      page: null,
      part: null,
      caption: "page: one of three",
    });
    // "Page:" in another case, or later in the line, is a caption as before.
    expect(parseDrawioBlock(`${ID}\nPage: 3 of the flow`)).toMatchObject({
      page: null,
      part: null,
      caption: "Page: 3 of the flow",
    });
  });

  it("writes and reads back a page with a caption", () => {
    expect(drawioBlockBody(ID, "Flow", "Sales\n detail")).toBe(`${ID}\npage: Sales detail\nFlow`);
    expect(drawioBlock(ID, null, "Detail")).toBe(`\`\`\`t3-drawio\n${ID}\npage: Detail\n\`\`\``);
    expect(parseDrawioBlock(drawioBlockBody(ID, "Flow", "Detail"))).toEqual({
      diagramId: ID,
      page: "Detail",
      part: null,
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
      part: null,
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
      { diagramId: "one", page: null, part: null, caption: null },
      { diagramId: "two", page: "Detail", part: null, caption: "Caption" },
    ]);
    expect(checkDrawioIn(markdown)).toBeNull();
  });
});

describe("parts", () => {
  it("reads a part line after the page line, or straight after the id", () => {
    expect(parseDrawioBlock(`${ID}\npage: Workflows\npart: Workflow 3\nThe receipts`)).toEqual({
      diagramId: ID,
      page: "Workflows",
      part: "Workflow 3",
      caption: "The receipts",
    });
    expect(parseDrawioBlock(`${ID}\npart:  Workflow   3 `)).toEqual({
      diagramId: ID,
      page: null,
      part: "Workflow 3",
      caption: null,
    });
    expect(parseDrawioBlock(`${ID}\npart:\nCaption`)).toMatchObject({ part: null, caption: "Caption" });
    expect(parseDrawioBlock(`${ID}\npart: ${"p".repeat(201)}`)).toBeNull();
    // Out of order: a page line after the part line is a caption, and a third line is refused.
    expect(parseDrawioBlock(`${ID}\npart: A\npage: B\nmore`)).toBeNull();
  });

  it("writes a part, and keeps captions that start with page: or part: as captions", () => {
    expect(drawioBlockBody(ID, null, "Workflows", "Workflow 3")).toBe(
      `${ID}\npage: Workflows\npart: Workflow 3`,
    );
    expect(drawioBlock(ID, null, null, "Seller")).toBe(`\`\`\`t3-drawio\n${ID}\npart: Seller\n\`\`\``);
    for (const [caption, page, part] of [
      ["part: one", null, null],
      ["page: one", null, null],
      ["page: one", null, "Seller"],
      ["part: one", "Detail", null],
      ["part: one", "Detail", "Seller"],
    ] as const) {
      expect(parseDrawioBlock(drawioBlockBody(ID, caption, page, part))).toEqual({
        diagramId: ID,
        page,
        part,
        caption,
      });
    }
    expect(drawioBlockBody(ID, "part: one")).toBe(`${ID}\npart:\npart: one`);
  });

  const parts = [
    { name: "Workflow 1 · Email intake · Live" },
    { name: "Workflow 10 · Alerts · Live" },
    { name: "Workflow 3 · Received today · Studied, not built" },
    { name: "seller" },
    { name: "seller_offer" },
    { name: `Long ${"x".repeat(113)}…` },
  ];

  it("finds a part by its name, or by the start of it up to a word's end", () => {
    expect(findPart(parts, "workflow 3 · RECEIVED today · studied, not built")).toBe(parts[2]);
    expect(findPart(parts, "Workflow 3")).toBe(parts[2]);
    // Not "Workflow 10": the name goes on with a digit there.
    expect(findPart(parts, "Workflow 1")).toBe(parts[0]);
    expect(findPart(parts, "seller")).toBe(parts[3]);
    expect(findPart(parts, "Workflow")).toBeNull();
    expect(findPart(parts, "Workflow 9")).toBeNull();
    expect(findPart(parts, "")).toBeNull();
    // A label cut for length matches the whole of it.
    expect(findPart(parts, `Long ${"x".repeat(150)}`)).toBe(parts[5]);
    // Two parts may share a name: each is found by its id, and offered by it.
    const twinTables = [
      { id: "db_product", name: "product" },
      { id: "v3db_product", name: "product" },
      { id: "wf3", name: "Workflow 3 · Receipts · Live" },
    ];
    expect(findPart(twinTables, "product")).toBe(twinTables[0]);
    expect(findPart(twinTables, "v3db_product")).toBe(twinTables[1]);
    expect(partOptions(twinTables)).toEqual([
      { id: "db_product", label: "product (id db_product)", line: "db_product" },
      { id: "v3db_product", label: "product (id v3db_product)", line: "v3db_product" },
      { id: "wf3", label: "Workflow 3 · Receipts · Live", line: "Workflow 3" },
    ]);
    expect(partLine(parts, parts[2]!.name)).toBe("Workflow 3");
    expect(partLine(parts, "seller_offer")).toBe("seller_offer");
    // "Workflow" alone would not find it: the whole name stays.
    const twins = [{ name: "Intake · email" }, { name: "Intake · upload" }];
    expect(partLine(twins, "Intake · upload")).toBe("Intake · upload");
  });

  it("crops to a part with a margin, kept inside the picture", () => {
    const pictureParts = [
      {
        width: 800,
        height: 600,
        parts: [
          { id: "l", name: "Left", x: 5, y: 20, width: 200, height: 100 },
          { id: "r", name: "Right", x: 500, y: 300, width: 300, height: 300 },
        ],
      },
      null,
    ];
    expect(partPicture({ pictureParts }, 0, "Left")).toEqual({
      kind: "part",
      width: 800,
      height: 600,
      box: { x: 0, y: 8, width: 217, height: 124 },
    });
    expect(partPicture({ pictureParts }, 0, "Right")).toMatchObject({
      box: { x: 488, y: 288, width: 312, height: 312 },
    });
    expect(partPicture({ pictureParts }, 0, "Gone")).toEqual({ kind: "not_found" });
    expect(partPicture({ pictureParts }, 1, "Left")).toEqual({ kind: "not_found" });
    expect(partPicture({ pictureParts: null }, 0, "Left")).toEqual({ kind: "unknown" });
  });
});
