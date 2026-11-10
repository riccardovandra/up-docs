import { describe, expect, it } from "vitest";

import {
  describeDrawio,
  drawioWarnings,
  LOOSE_END,
  MAX_DRAWIO_LABEL_LENGTH,
  readDrawio,
  UNLABELLED_SHAPE,
  type DrawioModel,
  type DrawioPage,
} from "./drawioModel.ts";

const model = (cells: string) =>
  `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`;
const box = (id: string, label: string, style = "rounded=1;whiteSpace=wrap;html=1;") =>
  `<mxCell id="${id}" value="${label}" style="${style}" vertex="1" parent="1">` +
  `<mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>`;
const edge = (id: string, ends: string, label = "", style = "endArrow=block;html=1;") =>
  `<mxCell id="${id}" value="${label}" style="${style}" edge="1" parent="1" ${ends}>` +
  `<mxGeometry relative="1" as="geometry"/></mxCell>`;

const ALL = { shapes: 1000, connections: 1000 };

async function pagesOf(xml: string): Promise<ReadonlyArray<DrawioPage>> {
  const read = await readDrawio(xml);
  if (!read.ok) throw new Error(read.error);
  return read.pages;
}

const errorOf = async (xml: string) => {
  const read = await readDrawio(xml);
  return read.ok ? null : read.error;
};

/** A page's content as Draw.io compresses it: URI-encoded, deflated, base64. */
async function compress(xml: string): Promise<string> {
  const stream = new Blob([encodeURIComponent(xml)])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return btoa(String.fromCharCode(...bytes));
}

describe("readDrawio", () => {
  it("reads a bare model: shapes by label, connections by the shapes they join", async () => {
    const [page] = await pagesOf(
      model(
        box("a", "Discovery call") +
          box("b", "Proposal") +
          box("c", "") +
          edge("e1", 'source="a" target="b"') +
          edge("e2", 'source="b" target="c"', "if signed"),
      ),
    );
    expect(page).toEqual({
      name: null,
      shapes: ["Discovery call", "Proposal", UNLABELLED_SHAPE],
      connections: ["Discovery call -> Proposal", `Proposal -[if signed]-> ${UNLABELLED_SHAPE}`],
      warnings: [],
      unreadable: null,
    });
  });

  it("reads a file as the hosted editor saves it, with the label a connection carries", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="embed.diagrams.net" agent="Mozilla/5.0 (Macintosh)" version="24.7.17">
  <diagram name="Page-1" id="kq3">
    <mxGraphModel dx="1026" dy="650" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <!-- the two steps -->
        <mxCell id="kq3-1" value="Signed?" style="rhombus;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="160" y="80" width="80" height="80" as="geometry" />
        </mxCell>
        <object label="Kickoff" owner="Delivery" id="kq3-2">
          <mxCell style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
            <mxGeometry x="320" y="90" width="120" height="60" as="geometry" />
          </mxCell>
        </object>
        <mxCell id="kq3-3" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;" edge="1" parent="1" source="kq3-1" target="kq3-2">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
        <mxCell id="kq3-4" value="yes" style="edgeLabel;html=1;align=center;verticalAlign=middle;resizable=0;points=[];" vertex="1" connectable="0" parent="kq3-3">
          <mxGeometry x="-0.2" relative="1" as="geometry">
            <mxPoint as="offset" />
          </mxGeometry>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
    expect(await pagesOf(xml)).toEqual([
      {
        name: "Page-1",
        shapes: ["Signed?", "Kickoff"],
        connections: ["Signed? -[yes]-> Kickoff"],
        warnings: [],
        unreadable: null,
      },
    ]);
  });

  it("returns HTML labels as plain words, and leaves plain labels alone", async () => {
    const html =
      "&lt;div style=&quot;font-size: 12px&quot;&gt;&lt;b&gt;Access&lt;/b&gt; check&lt;/div&gt;" +
      "&lt;div&gt;owner&amp;nbsp;&amp;amp; admin&lt;br&gt;only&lt;/div&gt;";
    const [page] = await pagesOf(
      model(
        box("a", html) +
          box("b", "a &lt; b and c &gt; d", "rounded=1;") +
          box("c", "Line one&#xa;line two", "rounded=1;") +
          box("d", `&lt;i&gt;${"long ".repeat(60)}&lt;/i&gt;`),
      ),
    );
    expect(page!.shapes.slice(0, 3)).toEqual([
      "Access check owner & admin only",
      "a < b and c > d",
      "Line one line two",
    ]);
    expect(page!.shapes[3]).toHaveLength(MAX_DRAWIO_LABEL_LENGTH);
    expect(page!.shapes[3]).toMatch(/^long long .*…$/);
  });

  it("says which ends are loose and draws the arrowheads the style has", async () => {
    const [page] = await pagesOf(
      model(
        box("a", "A") +
          box("b", "B") +
          edge("e1", 'source="a"') +
          edge("e2", 'target="b"', "in") +
          edge("e3", 'source="a" target="b"', "", "endArrow=none;") +
          edge("e4", 'source="a" target="b"', "sync", "startArrow=classic;endArrow=classic;") +
          edge("e5", 'source="a" target="b"', "", "startArrow=block;endArrow=none;") +
          edge("e6", 'source="e1" target="b"'),
      ),
    );
    expect(page!.connections).toEqual([
      `A -> ${LOOSE_END}`,
      `${LOOSE_END} -[in]-> B`,
      "A -- B",
      "A <-[sync]-> B",
      "A <- B",
      "(another connection) -> B",
    ]);
    expect(page!.warnings).toEqual([]);
  });

  it("reads each page of a file, compressed or not", async () => {
    const second = model(
      box("x", "Queue") + box("y", "Worker") + edge("e", 'source="x" target="y"'),
    );
    const xml =
      `<mxfile><diagram id="p1" name="Overview">${model(box("a", "Client"))}</diagram>` +
      `<diagram id="p2" name="Detail">${await compress(second)}</diagram>` +
      `<diagram id="p3" name="Empty"></diagram></mxfile>`;
    const read = await readDrawio(xml);
    expect(describeDrawio(read, ALL)).toEqual({
      pages: [
        { name: "Overview", shapes: ["Client"], connections: [] },
        { name: "Detail", shapes: ["Queue", "Worker"], connections: ["Queue -> Worker"] },
        { name: "Empty", shapes: [], connections: [] },
      ],
    });
  });

  it("says a compressed page could not be read instead of guessing", async () => {
    const good = await compress(model(box("a", "Client")));
    const pages = await pagesOf(
      `<mxfile><diagram name="Broken">${good.slice(0, 20)}</diagram>` +
        `<diagram name="Not base64">!!!!</diagram>` +
        `<diagram name="Other">${await compress("<html><body/></html>")}</diagram></mxfile>`,
    );
    for (const page of pages) {
      expect(page.shapes).toEqual([]);
      expect(page.unreadable).toContain("compressed");
    }
    const one = await readDrawio(`<mxfile><diagram name="Broken">!!!!</diagram></mxfile>`);
    expect(describeDrawio(one, ALL)).toEqual({
      unreadable: "This page is saved compressed and could not be decoded.",
    });
    expect(drawioWarnings(one)).toEqual([
      "This page is saved compressed and could not be decoded.",
    ]);
  });

  it("refuses XML that is not well-formed, with the line and the fix", async () => {
    expect(await errorOf(model(box("a", "Research & build")))).toBe(
      'line 1: a bare "&": write &amp;',
    );
    expect(await errorOf(model(box("a", "A&nbsp;B")))).toContain("&nbsp; is not an XML entity");
    expect(await errorOf(model(box("a", "x <b>y</b>")))).toContain('holds a "<": write &lt;');
    expect(await errorOf(model("\n\n<mxCell id=a/>"))).toBe(
      "line 3: the <mxCell> tag is not closed, or an attribute value is not in quotes",
    );
    expect(await errorOf("<mxGraphModel><root></mxGraphModel>")).toBe(
      "line 1: </mxGraphModel> where </root> was expected",
    );
    expect(await errorOf("<mxGraphModel><root>")).toBe("line 1: <root> is never closed");
    expect(await errorOf('<mxGraphModel a="1" a="2"/>')).toContain("attribute twice");
    expect(await errorOf("<mxGraphModel/><mxGraphModel/>")).toContain("a second root element");
    expect(await errorOf("<svg/>")).toBe("the root element must be <mxfile> or <mxGraphModel>");
    expect(await errorOf("not xml at all")).toContain("text outside the root element");
    const read = await readDrawio("<mxGraphModel><root>");
    expect(describeDrawio(read, ALL)).toEqual({
      unreadable: "The Draw.io XML could not be read: line 1: <root> is never closed.",
    });
  });

  it("accepts what an XML parser accepts: quotes, comments, CDATA, declarations", async () => {
    const xml =
      `<?xml version='1.0'?>\n<!-- saved by hand -->\n<mxGraphModel>\n<root>` +
      `<mxCell id='0'/><mxCell id="1" parent="0"/>` +
      `<mxCell id="a" value='He said "go" &gt; &#169;' vertex="1"\n  parent="1"></mxCell >` +
      `<![CDATA[ <ignored> & ]]></root></mxGraphModel>\n`;
    expect((await pagesOf(xml))[0]!.shapes).toEqual(['He said "go" > ©']);
    expect(await pagesOf("")).toEqual([]);
    expect(describeDrawio(await readDrawio("  "), ALL)).toEqual({ shapes: [], connections: [] });
  });

  it("stops inflating a file whose compressed pages are too large, and stays fast", async () => {
    const big = model(box("a", "Big") + `<!--${"x".repeat(1_200_000)}-->`);
    const packed = await compress(big);
    expect(packed.length).toBeLessThan(20_000);
    const pages = await pagesOf(
      `<mxfile><diagram name="One">${packed}</diagram><diagram name="Two">${packed}</diagram>` +
        `<diagram name="Three">${await compress(model(box("b", "Small")))}</diagram></mxfile>`,
    );
    expect(pages.map((page) => page.shapes)).toEqual([["Big"], [], []]);
    expect(pages[1]!.unreadable).toContain("could not be decoded");

    // Unclosed tags in a label must not make the reader crawl.
    const started = Date.now();
    const hostile = "&lt;style&lt;a&lt;!--".repeat(40_000);
    const [page] = await pagesOf(model(box("a", `Label${hostile}`)));
    expect(page!.shapes).toEqual(["Label"]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("warns about ids that repeat or point at nothing", async () => {
    const read = await readDrawio(
      model(
        box("a", "A") +
          box("a", "Again") +
          box("b", "Lost").replace('parent="1"', 'parent="layer"') +
          edge("e1", 'source="a" target="ghost"', "to nowhere"),
      ),
    );
    const warnings = drawioWarnings(read);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('More than one cell has the id "a"');
    expect(warnings[1]).toContain('"Lost": the parent is missing or names no cell');
    expect(warnings[2]).toBe(
      'Connection "to nowhere" has target="ghost", but no cell has that id: that end is left loose.',
    );
    const rootless = await readDrawio(`<mxGraphModel><root>${box("a", "A")}</root></mxGraphModel>`);
    expect(drawioWarnings(rootless)[0]).toContain('Keep <mxCell id="0"/>');
  });
});

describe("describeDrawio", () => {
  const page = (name: string, count: number): DrawioPage => ({
    name,
    shapes: Array.from({ length: count }, (_, index) => `${name} ${index}`),
    connections: Array.from({ length: count }, (_, index) => `${name} ${index} -> x`),
    warnings: [],
    unreadable: null,
  });

  it("keeps to the limits across pages and says what it left out", () => {
    const big: DrawioModel = { ok: true, pages: [page("One", 3), page("Two", 3)] };
    expect(describeDrawio(big, { shapes: 4, connections: 2 })).toEqual({
      pages: [
        {
          name: "One",
          shapes: ["One 0", "One 1", "One 2"],
          connections: ["One 0 -> x", "One 1 -> x"],
        },
        { name: "Two", shapes: ["Two 0"], connections: [] },
      ],
      truncated: "2 more shapes and 4 more connections are left out to keep this short.",
    });
    const single: DrawioModel = { ok: true, pages: [page("One", 2)] };
    expect(describeDrawio(single, ALL)).toEqual({
      shapes: ["One 0", "One 1"],
      connections: ["One 0 -> x", "One 1 -> x"],
    });
  });
});
