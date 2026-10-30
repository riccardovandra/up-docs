// Word export: Markdown to a minimal WordprocessingML package, written by
// hand so the worker needs no docx library. Headings use Word's built-in
// heading styles, so the navigation pane and Google Docs' outline work.

import { Lexer, type Token, type Tokens } from "marked";

import { isSafeUrl, parseTable, type ChipColor, type RichTable } from "../../shared/table.ts";
import { slugify } from "../export.ts";
import { zipStored } from "./zip.ts";

export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A4 width less two one-inch margins, in twentieths of a point. */
const TEXT_WIDTH = 11906 - 2 * 1440;
const LIST_INDENT = 720;
const DIAGRAM_LANGUAGES = new Set(["t3-widget", "mermaid"]);

/** Light fills that keep black text readable, after the editor's chip colours. */
const CHIP_FILLS: Record<ChipColor, string> = {
  gray: "E5E7EB",
  blue: "DBEAFE",
  green: "DCFCE7",
  yellow: "FEF9C3",
  orange: "FFEDD5",
  red: "FEE2E2",
  purple: "F3E8FF",
  pink: "FCE7F3",
};

// XML 1.0 refuses most control characters, even escaped.
const INVALID_XML = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

export const escapeXml = (text: string): string =>
  text
    .replace(INVALID_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** marked leaves entities in text as typed; Word wants the characters. */
const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });

interface RunFormat {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly strike?: boolean;
  readonly code?: boolean;
  readonly link?: boolean;
}

interface BlockContext {
  readonly quote: boolean;
  /** Nesting depth of the enclosing list item, 0 outside lists. */
  readonly indent: number;
}

const isLinkable = (href: string) => href !== "" && isSafeUrl(href);

function runProperties(format: RunFormat): string {
  const props = [
    format.link
      ? '<w:rStyle w:val="Hyperlink"/>'
      : format.code
        ? '<w:rStyle w:val="CodeChar"/>'
        : "",
    format.bold ? "<w:b/>" : "",
    format.italic ? "<w:i/>" : "",
    format.strike ? "<w:strike/>" : "",
  ].join("");
  return props ? `<w:rPr>${props}</w:rPr>` : "";
}

/** One run of text; tabs and line breaks become Word's own elements. */
function run(text: string, format: RunFormat = {}, breaks = false): string {
  if (text === "") return "";
  const parts = (breaks ? text : text.replace(/\r?\n/g, " ")).split(/(\t|\r?\n)/);
  const content = parts
    .map((part) => {
      if (part === "\t") return "<w:tab/>";
      if (part === "\n" || part === "\r\n") return "<w:br/>";
      return part ? `<w:t xml:space="preserve">${escapeXml(part)}</w:t>` : "";
    })
    .join("");
  return `<w:r>${runProperties(format)}${content}</w:r>`;
}

function paragraph(content: string, props = ""): string {
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${content}</w:p>`;
}

const styleProp = (style: string) => `<w:pStyle w:val="${style}"/>`;

interface TableCell {
  readonly content: string;
  readonly fill?: string | undefined;
  readonly align?: string | null | undefined;
}

class DocxWriter {
  private readonly body: Array<string> = [];
  private readonly links: Array<string> = [];
  /** Numbered lists after the shared bullet list (numId 1); each restarts its count. */
  private readonly orderedLists: Array<{ level: number; start: number }> = [];

  private readonly docUrl: string;

  constructor(docUrl: string) {
    this.docUrl = docUrl;
  }

  hyperlink(href: string, content: string): string {
    this.links.push(href);
    return `<w:hyperlink r:id="rIdLink${this.links.length}" w:history="1">${content}</w:hyperlink>`;
  }

  inline(tokens: ReadonlyArray<Token> | undefined, format: RunFormat = {}): string {
    if (!tokens) return "";
    return tokens.map((token) => this.inlineToken(token, format)).join("");
  }

  private inlineToken(token: Token, format: RunFormat): string {
    switch (token.type) {
      case "text":
        return "tokens" in token && token.tokens
          ? this.inline(token.tokens, format)
          : run(decodeEntities((token as Tokens.Text).text), format);
      case "escape":
        return run((token as Tokens.Escape).text, format);
      case "strong":
        return this.inline((token as Tokens.Strong).tokens, { ...format, bold: true });
      case "em":
        return this.inline((token as Tokens.Em).tokens, { ...format, italic: true });
      case "del":
        return this.inline((token as Tokens.Del).tokens, { ...format, strike: true });
      case "codespan":
        return run(decodeEntities((token as Tokens.Codespan).text), { ...format, code: true });
      case "br":
        return "<w:r><w:br/></w:r>";
      case "link": {
        const link = token as Tokens.Link;
        if (!isLinkable(link.href)) return this.inline(link.tokens, format);
        return this.hyperlink(link.href, this.inline(link.tokens, { ...format, link: true }));
      }
      case "image": {
        // Images are not embedded; the alt text links to the picture.
        const image = token as Tokens.Image;
        const label = run(`[${image.text || "Image"}]`, {
          ...format,
          link: isLinkable(image.href),
        });
        return isLinkable(image.href) ? this.hyperlink(image.href, label) : label;
      }
      case "html":
        return /^<br\s*\/?>$/i.test((token as Tokens.HTML).text.trim()) ? "<w:r><w:br/></w:r>" : "";
      case "checkbox":
        return "";
      default:
        return "raw" in token ? run(token.raw, format) : "";
    }
  }

  blocks(tokens: ReadonlyArray<Token>, context: BlockContext): void {
    for (const token of tokens) this.block(token, context);
  }

  private textProps(context: BlockContext): string {
    if (context.quote) return styleProp("Quote");
    if (context.indent > 0) {
      return `${styleProp("ListParagraph")}<w:ind w:left="${LIST_INDENT * context.indent}"/>`;
    }
    return "";
  }

  private block(token: Token, context: BlockContext): void {
    switch (token.type) {
      case "heading": {
        const heading = token as Tokens.Heading;
        const level = Math.min(Math.max(heading.depth, 1), 6);
        this.body.push(paragraph(this.inline(heading.tokens), styleProp(`Heading${level}`)));
        return;
      }
      case "paragraph":
      case "text": {
        const text = token as Tokens.Paragraph | Tokens.Text;
        const content = text.tokens ? this.inline(text.tokens) : run(decodeEntities(text.text));
        this.body.push(paragraph(content, this.textProps(context)));
        return;
      }
      case "blockquote":
        this.blocks((token as Tokens.Blockquote).tokens, { ...context, quote: true });
        return;
      case "list":
        this.list(token as Tokens.List, context);
        return;
      case "code":
        this.code(token as Tokens.Code, context);
        return;
      case "table":
        this.gfmTable(token as Tokens.Table);
        return;
      case "hr":
        this.body.push(
          paragraph(
            "",
            '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr>',
          ),
        );
        return;
      case "html": {
        const text = decodeEntities((token as Tokens.HTML).text.replace(/<[^>]*>/g, "")).trim();
        if (text) this.body.push(paragraph(run(text), this.textProps(context)));
        return;
      }
      default:
        return;
    }
  }

  private list(list: Tokens.List, context: BlockContext): void {
    const level = Math.min(context.indent, 8);
    let numId = 1;
    if (list.ordered) {
      this.orderedLists.push({ level, start: typeof list.start === "number" ? list.start : 1 });
      numId = this.orderedLists.length + 1;
    }
    const inner: BlockContext = { quote: context.quote, indent: context.indent + 1 };
    for (const item of list.items) {
      const tokens = item.tokens.filter((token) => token.type !== "checkbox");
      const [first, ...rest] = tokens;
      const lead = first && (first.type === "text" || first.type === "paragraph") ? first : null;
      const content = lead
        ? "tokens" in lead && lead.tokens
          ? this.inline(lead.tokens)
          : run(decodeEntities((lead as Tokens.Text).text))
        : "";
      if (item.task) {
        // A ballot box stands in for the checkbox; Word has no checklist numbering.
        const box = run(item.checked ? "☑ " : "☐ ");
        this.body.push(
          paragraph(
            box + content,
            `${styleProp("ListParagraph")}<w:ind w:left="${LIST_INDENT * (level + 1)}" w:hanging="360"/>`,
          ),
        );
      } else {
        this.body.push(
          paragraph(
            content,
            `${styleProp("ListParagraph")}<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`,
          ),
        );
      }
      this.blocks(lead ? rest : tokens, inner);
    }
  }

  private code(code: Tokens.Code, context: BlockContext): void {
    const language = (code.lang ?? "").trim().split(/\s+/)[0] ?? "";
    if (language === "t3-table") {
      const parsed = parseTable(code.text);
      if (parsed.ok) {
        this.richTable(parsed.table);
        return;
      }
    }
    if (DIAGRAM_LANGUAGES.has(language)) {
      const label = run("Diagram: open the doc to view it. ", { italic: true });
      const link = this.hyperlink(this.docUrl, run(this.docUrl, { italic: true, link: true }));
      this.body.push(paragraph(label + link, styleProp("Caption")));
      return;
    }
    const indent = context.indent > 0 ? `<w:ind w:left="${LIST_INDENT * context.indent}"/>` : "";
    for (const line of code.text.split("\n")) {
      this.body.push(paragraph(run(line, {}, true), `${styleProp("CodeBlock")}${indent}`));
    }
  }

  private table(
    header: ReadonlyArray<string>,
    rows: ReadonlyArray<ReadonlyArray<TableCell>>,
    align: ReadonlyArray<string | null>,
  ): void {
    const columns = Math.max(header.length, 1);
    const width = Math.floor(TEXT_WIDTH / columns);
    const cell = (content: string, fill: string | undefined, jc: string | null | undefined) =>
      `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${
        fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ""
      }</w:tcPr>${paragraph(content, `${styleProp("TableText")}${jc ? `<w:jc w:val="${jc}"/>` : ""}`)}</w:tc>`;
    const headerRow = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${header
      .map((content, index) => cell(content, "F2F2F2", align[index]))
      .join("")}</w:tr>`;
    const bodyRows = rows
      .map(
        (row) =>
          `<w:tr>${Array.from({ length: columns }, (_, index) => {
            const value = row[index];
            return cell(value?.content ?? "", value?.fill, value?.align ?? align[index]);
          }).join("")}</w:tr>`,
      )
      .join("");
    this.body.push(
      `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${`<w:gridCol w:w="${width}"/>`.repeat(columns)}</w:tblGrid>${headerRow}${bodyRows}</w:tbl>`,
      // Word merges tables that touch, and a cell-less gap reads better anyway.
      paragraph(""),
    );
  }

  private gfmTable(table: Tokens.Table): void {
    this.table(
      table.header.map((cell) => this.inline(cell.tokens, { bold: true })),
      table.rows.map((row) => row.map((cell) => ({ content: this.inline(cell.tokens) }))),
      table.align,
    );
  }

  private richTable(table: RichTable): void {
    this.table(
      table.columns.map((column) => run(column.name, { bold: true })),
      table.rows.map((row) =>
        table.columns.map((column) => {
          const value = row.cells[column.id];
          if (value === null || value === undefined) return { content: "" };
          if (typeof value === "object") {
            const text = run(value.text || value.url, { link: isLinkable(value.url) }, true);
            return { content: isLinkable(value.url) ? this.hyperlink(value.url, text) : text };
          }
          if (column.type === "select") {
            const option = column.options?.find((candidate) => candidate.value === value);
            return {
              content: run(String(value)),
              fill: option ? CHIP_FILLS[option.color] : undefined,
            };
          }
          if (column.type === "number") return { content: run(String(value)), align: "right" };
          return { content: run(String(value), {}, true) };
        }),
      ),
      table.columns.map(() => null),
    );
  }

  documentXml(): string {
    const body = this.body.length > 0 ? this.body.join("") : paragraph("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  }

  relationshipsXml(): string {
    const links = this.links
      .map(
        (href, index) =>
          `<Relationship Id="rIdLink${index + 1}" Type="${DOC_REL}/hyperlink" Target="${escapeXml(href)}" TargetMode="External"/>`,
      )
      .join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL_NS}"><Relationship Id="rIdStyles" Type="${DOC_REL}/styles" Target="styles.xml"/><Relationship Id="rIdNumbering" Type="${DOC_REL}/numbering" Target="numbering.xml"/>${links}</Relationships>`;
  }

  numberingXml(): string {
    const levels = (format: (level: number) => { fmt: string; text: string }) =>
      Array.from({ length: 9 }, (_, level) => {
        const { fmt, text } = format(level);
        return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${LIST_INDENT * (level + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
      }).join("");
    const bullets = ["•", "◦", "▪"];
    const numbers = ["decimal", "lowerLetter", "lowerRoman"];
    const ordered = this.orderedLists
      .map(
        ({ level, start }, index) =>
          `<w:num w:numId="${index + 2}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="${level}"><w:startOverride w:val="${start}"/></w:lvlOverride></w:num>`,
      )
      .join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W_NS}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels(
      (level) => ({ fmt: "bullet", text: bullets[level % 3]! }),
    )}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels(
      (level) => ({ fmt: numbers[level % 3]!, text: `%${level + 1}.` }),
    )}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>${ordered}</w:numbering>`;
  }
}

const HEADING_SIZES = [40, 32, 28, 24, 22, 22];

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${HEADING_SIZES.map(
  (size, index) =>
    `<w:style w:type="paragraph" w:styleId="Heading${index + 1}"><w:name w:val="heading ${index + 1}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${index < 2 ? 360 : 240}" w:after="80"/><w:outlineLvl w:val="${index}"/></w:pPr><w:rPr><w:b/>${index === 5 ? "<w:i/>" : ""}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`,
).join(
  "",
)}<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/></w:pBdr><w:ind w:left="360"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:rPr><w:i/><w:color w:val="595959"/><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="40" w:after="40" w:line="240" w:lineRule="auto"/></w:pPr></w:style><w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style><w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style><w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/></w:rPr></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/></w:tblBorders></w:tblPr></w:style></w:styles>`;

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${DOC_REL}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;

const coreXml = (title: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title></cp:coreProperties>`;

export interface DocxInput {
  readonly title: string;
  readonly markdown: string;
  /** Where the doc lives, for content Word cannot show such as diagrams. */
  readonly docUrl: string;
}

export function markdownToDocx(input: DocxInput): Uint8Array {
  const writer = new DocxWriter(input.docUrl);
  writer.blocks(new Lexer({ gfm: true }).lex(input.markdown), { quote: false, indent: 0 });
  const encoder = new TextEncoder();
  const part = (name: string, xml: string) => ({ name, data: encoder.encode(xml) });
  // The document is written first, so its hyperlinks and lists exist for the other parts.
  const documentXml = writer.documentXml();
  return zipStored([
    part("[Content_Types].xml", CONTENT_TYPES_XML),
    part("_rels/.rels", ROOT_RELS_XML),
    part("docProps/core.xml", coreXml(input.title)),
    part("word/document.xml", documentXml),
    part("word/_rels/document.xml.rels", writer.relationshipsXml()),
    part("word/styles.xml", STYLES_XML),
    part("word/numbering.xml", writer.numberingXml()),
  ]);
}

export const docxResponse = (input: DocxInput): Response =>
  new Response(markdownToDocx(input).buffer as ArrayBuffer, {
    headers: {
      "Content-Type": DOCX_TYPE,
      "Content-Disposition": `attachment; filename="${slugify(input.title)}.docx"`,
      "Cache-Control": "no-store",
    },
  });
