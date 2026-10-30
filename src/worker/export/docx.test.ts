import { describe, expect, it } from "vitest";

import type { DocWithTabs, Tab } from "../../shared/protocol.ts";
import { formatTable, type RichTable } from "../../shared/table.ts";
import { makeApiHarness } from "../testing/apiHarness.ts";
import { DOCX_TYPE, escapeXml, markdownToDocx } from "./docx.ts";
import { crc32, zipStored } from "./zip.ts";

/** Reads a stored zip through its central directory, checking each entry's CRC. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const files = new Map<string, string>();
  for (let index = 0; index < count; index++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    expect(view.getUint16(at + 10, true)).toBe(0); // stored
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    const dataStart = offset + 30 + view.getUint16(offset + 26, true);
    const data = bytes.subarray(dataStart, dataStart + size);
    expect(crc32(data)).toBe(crc);
    files.set(name, decoder.decode(data));
    at += 46 + nameLength;
  }
  return files;
}

/** Fails on unbalanced tags, so a part Word would refuse cannot pass. */
function expectWellFormed(xml: string) {
  const stack: Array<string> = [];
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, "");
  for (const [, closing, name, selfClosing] of body.matchAll(/<(\/?)([\w:]+)[^>]*?(\/?)>/g)) {
    if (selfClosing) continue;
    if (closing) expect(stack.pop()).toBe(name);
    else stack.push(name!);
  }
  expect(stack).toEqual([]);
  expect(body.replace(/<[^>]*>/g, "")).not.toMatch(/[<>]|&(?!(amp|lt|gt|quot|apos);)/);
}

const DOC_URL = "https://docs.test/d/doc";

function render(markdown: string) {
  const files = unzip(markdownToDocx({ title: "T & Co", markdown, docUrl: DOC_URL }));
  for (const xml of files.values()) expectWellFormed(xml);
  return {
    files,
    document: files.get("word/document.xml")!,
    rels: files.get("word/_rels/document.xml.rels")!,
    numbering: files.get("word/numbering.xml")!,
  };
}

describe("zip", () => {
  it("computes the standard CRC32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("round-trips entries in order", () => {
    const encoder = new TextEncoder();
    const files = unzip(
      zipStored([
        { name: "a.txt", data: encoder.encode("hello") },
        { name: "dir/b.txt", data: encoder.encode("wörld") },
      ]),
    );
    expect([...files]).toEqual([
      ["a.txt", "hello"],
      ["dir/b.txt", "wörld"],
    ]);
  });
});

describe("docx package", () => {
  it("has the parts Word needs, wired together", () => {
    const { files } = render("Hello");
    expect([...files.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/core.xml",
      "word/document.xml",
      "word/_rels/document.xml.rels",
      "word/styles.xml",
      "word/numbering.xml",
    ]);
    const types = files.get("[Content_Types].xml")!;
    expect(types).toContain(
      'PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"',
    );
    expect(types).toContain('PartName="/word/numbering.xml"');
    expect(files.get("_rels/.rels")).toContain('Target="word/document.xml"');
    const rels = files.get("word/_rels/document.xml.rels")!;
    expect(rels).toContain('Target="styles.xml"');
    expect(rels).toContain('Target="numbering.xml"');
    expect(files.get("docProps/core.xml")).toContain("<dc:title>T &amp; Co</dc:title>");
    expect(files.get("word/styles.xml")).toContain('<w:name w:val="heading 1"/>');
    expect(files.get("word/document.xml")).toContain("<w:sectPr>");
  });

  it("escapes XML and drops characters XML cannot carry", () => {
    expect(escapeXml(`<a href="x">&'\u0001`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
    const { document } = render('Tom & Jerry <say> "hi" &amp; \u0007bye');
    expect(document).toContain("Tom &amp; Jerry ");
    expect(document).toContain(" &quot;hi&quot; &amp; bye");
  });
});

describe("markdown to Word", () => {
  it("uses Word heading styles with outline levels", () => {
    const { document, files } = render("# One\n\n### Three\n\n###### Six");
    expect(document).toContain(
      '<w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">One',
    );
    expect(document).toContain('<w:pStyle w:val="Heading3"/>');
    expect(document).toContain('<w:pStyle w:val="Heading6"/>');
    expect(files.get("word/styles.xml")).toContain('<w:outlineLvl w:val="5"/>');
  });

  it("formats bold, italic, strikethrough, code and links", () => {
    const { document, rels } = render(
      "**b** *i* ~~s~~ `c` [site](https://example.com/?a=1&b=2) [bad](javascript:alert(1))",
    );
    expect(document).toContain('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">b</w:t>');
    expect(document).toContain('<w:rPr><w:i/></w:rPr><w:t xml:space="preserve">i</w:t>');
    expect(document).toContain('<w:rPr><w:strike/></w:rPr><w:t xml:space="preserve">s</w:t>');
    expect(document).toContain(
      '<w:rStyle w:val="CodeChar"/></w:rPr><w:t xml:space="preserve">c</w:t>',
    );
    expect(document).toContain(
      '<w:hyperlink r:id="rIdLink1" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t xml:space="preserve">site',
    );
    expect(rels).toContain(
      'Id="rIdLink1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/?a=1&amp;b=2" TargetMode="External"',
    );
    expect(rels).not.toContain("javascript");
    expect(document).toContain(">bad</w:t>");
  });

  it("numbers lists, restarting each ordered list and nesting levels", () => {
    const { document, numbering } = render("- a\n  - nested\n\n1. x\n2. y\n\ntext\n\n3. z");
    expect(document).toContain(
      '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">a',
    );
    expect(document).toContain('<w:ilvl w:val="1"/><w:numId w:val="1"/>');
    expect(document).toContain(
      '<w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">x',
    );
    expect(document).toContain(
      '<w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">z',
    );
    expect(numbering).toContain('<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>');
    expect(numbering).toContain(
      '<w:num w:numId="3"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"/>',
    );
    expect(numbering).toContain('<w:numFmt w:val="bullet"/><w:lvlText w:val="•"/>');
  });

  it("shows task items as ballot boxes without numbering", () => {
    const { document } = render("- [ ] todo\n- [x] done");
    expect(document).toContain(
      '<w:t xml:space="preserve">☐ </w:t></w:r><w:r><w:t xml:space="preserve">todo',
    );
    expect(document).toContain(
      '<w:t xml:space="preserve">☑ </w:t></w:r><w:r><w:t xml:space="preserve">done',
    );
    expect(document).not.toContain("<w:numPr>");
  });

  it("writes quotes, code blocks and rules", () => {
    const { document } = render("> quoted\n\n```ts\nconst a = 1;\n\tb\n```\n\n---");
    expect(document).toContain(
      '<w:pStyle w:val="Quote"/></w:pPr><w:r><w:t xml:space="preserve">quoted',
    );
    expect(document).toContain(
      '<w:pStyle w:val="CodeBlock"/></w:pPr><w:r><w:t xml:space="preserve">const a = 1;</w:t></w:r></w:p>',
    );
    expect(document).toContain("<w:tab/>");
    expect(document).toContain('<w:bottom w:val="single"');
  });

  it("writes GFM tables with a repeating bold header row and alignment", () => {
    const { document } = render("| a | b |\n|---|--:|\n| 1 | **2** |");
    expect(document).toContain('<w:tblStyle w:val="TableGrid"/>');
    expect(document.match(/<w:gridCol /g)).toHaveLength(2);
    expect(document).toContain("<w:trPr><w:tblHeader/></w:trPr>");
    expect(document).toContain('<w:jc w:val="right"/>');
    expect(document.match(/<w:tc>/g)).toHaveLength(4);
  });

  it("writes rich tables as Word tables with select shading and link cells", () => {
    const table: RichTable = {
      id: "t",
      columns: [
        { id: "name", name: "Name", type: "text" },
        {
          id: "status",
          name: "Status",
          type: "select",
          options: [{ value: "Done", color: "green" }],
        },
        { id: "site", name: "Site", type: "link" },
        { id: "n", name: "N", type: "number" },
      ],
      rows: [
        {
          id: "r1",
          cells: {
            name: "Alpha",
            status: "Done",
            site: { text: "Home", url: "https://a.test" },
            n: 3,
          },
        },
        { id: "r2", cells: { name: "Beta" } },
      ],
    };
    const { document, rels } = render(`Before\n\n\`\`\`t3-table\n${formatTable(table)}\n\`\`\`\n`);
    expect(document).not.toContain("t3-table");
    expect(document.match(/<w:tr>/g)).toHaveLength(3);
    expect(document).toContain('<w:shd w:val="clear" w:color="auto" w:fill="DCFCE7"/>');
    expect(document).toContain(">Done</w:t>");
    expect(rels).toContain('Target="https://a.test"');
    expect(document).toContain(">Home</w:t>");
    expect(document.match(/<w:tc>/g)).toHaveLength(12);
  });

  it("turns a video into a link paragraph, with uploaded files made absolute", () => {
    const file = "00000000-0000-4000-8000-000000000000.mp4";
    const { document, rels } = render(
      `\`\`\`t3-video\nhttps://youtu.be/dQw4w9WgXcQ\nThe walkthrough\n\`\`\`\n\n\`\`\`t3-video\n/api/videos/d/${file}\n\`\`\`\n`,
    );
    expect(document).not.toContain("t3-video");
    expect(document).toContain(">The walkthrough</w:t>");
    expect(rels).toContain('Target="https://www.youtube.com/watch?v=dQw4w9WgXcQ"');
    expect(rels).toContain(`Target="${new URL(`/api/videos/d/${file}`, DOC_URL).href}"`);
  });

  it("keeps an invalid video as a code block", () => {
    const { document, rels } = render("```t3-video\njavascript:alert(1)\n```");
    expect(document).toContain("CodeBlock");
    expect(rels).not.toContain("javascript:");
  });

  it("keeps an invalid rich table as a code block", () => {
    const { document } = render("```t3-table\n{nope\n```");
    expect(document).toContain(
      '<w:pStyle w:val="CodeBlock"/></w:pPr><w:r><w:t xml:space="preserve">{nope',
    );
  });

  it("replaces diagrams with a captioned link to the doc", () => {
    const { document, rels } = render(
      "```mermaid\ngraph TD\n```\n\n```t3-widget\nexport default 1\n```",
    );
    expect(document.match(/<w:pStyle w:val="Caption"\/>/g)).toHaveLength(2);
    expect(document).not.toContain("graph TD");
    expect(rels).toContain(`Target="${DOC_URL}"`);
  });
});

describe("docx export routes", () => {
  async function setup() {
    const api = makeApiHarness();
    const owner = await api.signIn();
    const headers = { Cookie: owner };
    const project = await api.call("POST", "/api/projects", { body: { name: "P" }, headers });
    const { project: created } = (await project.json()) as { project: { id: string } };
    const makeDoc = async (title: string) =>
      (await (
        await api.call("POST", "/api/docs", { body: { projectId: created.id, title }, headers })
      ).json()) as DocWithTabs;
    const shared = await makeDoc("Launch Plan");
    const root = shared.tabs[0]!;
    await api.call("PATCH", `/api/tabs/${root.id}`, {
      body: { baseVersion: 1, markdown: "Intro" },
      headers,
    });
    const child = (await (
      await api.call("POST", `/api/docs/${shared.doc.id}/tabs`, {
        body: { title: "Risks", parentTabId: root.id, markdown: "- none" },
        headers,
      })
    ).json()) as { tab: Tab };
    const other = await makeDoc("Private");
    await api.call("POST", `/api/docs/${shared.doc.id}/members`, {
      body: { email: "viewer@example.com", role: "viewer" },
      headers,
    });
    const viewer = await api.signIn("viewer@example.com");
    return {
      api,
      owner,
      viewer,
      docId: shared.doc.id,
      childId: child.tab.id,
      otherId: other.doc.id,
    };
  }

  it("downloads the doc in tab order and one tab, for viewers too", async () => {
    const { api, viewer, docId, childId } = await setup();
    const whole = await api.call("GET", `/api/docs/${docId}/export.docx`, {
      headers: { Cookie: viewer },
    });
    expect(whole.status).toBe(200);
    expect(whole.headers.get("Content-Type")).toBe(DOCX_TYPE);
    expect(whole.headers.get("Content-Disposition")).toBe(
      'attachment; filename="launch-plan.docx"',
    );
    const document = unzip(new Uint8Array(await whole.arrayBuffer())).get("word/document.xml")!;
    const order = ["Launch Plan", "Intro", "Risks", "none"].map((text) =>
      document.indexOf(`>${text}<`),
    );
    expect(order.every((index, i) => index > (order[i - 1] ?? -1))).toBe(true);
    expect(document).toContain(
      '<w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t xml:space="preserve">Risks',
    );

    const one = await api.call("GET", `/api/tabs/${childId}/export.docx`, {
      headers: { Cookie: viewer },
    });
    expect(one.headers.get("Content-Disposition")).toBe('attachment; filename="risks.docx"');
    const tabXml = unzip(new Uint8Array(await one.arrayBuffer())).get("word/document.xml")!;
    expect(tabXml).toContain(
      '<w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">Risks',
    );
  });

  it("refuses callers without access", async () => {
    const { api, viewer, docId, childId, otherId } = await setup();
    expect((await api.call("GET", `/api/docs/${docId}/export.docx`)).status).toBe(401);
    expect((await api.call("GET", `/api/tabs/${childId}/export.docx`)).status).toBe(401);
    const denied = await api.call("GET", `/api/docs/${otherId}/export.docx`, {
      headers: { Cookie: viewer },
    });
    expect([403, 404]).toContain(denied.status);
    const missing = await api.call("GET", "/api/tabs/nope/export.docx", {
      headers: { Cookie: viewer },
    });
    expect(missing.status).toBe(404);
  });
});
