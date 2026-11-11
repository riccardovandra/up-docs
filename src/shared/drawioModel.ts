// A Draw.io source read as text an agent can follow: each page's shapes (their
// labels) and its connections ("A -> B"). The Worker has no DOMParser, so the
// XML is parsed here by hand, and strictly: Draw.io opens a file with the
// browser's XML parser, so a source refused here would not open there either.

import { MAX_DIAGRAM_PAGES, MAX_DRAWIO_PAGE_NAME_LENGTH, pageNameLine } from "./drawio.ts";

/** The words standing in for a shape nobody labelled, and for an end attached to nothing. */
export const UNLABELLED_SHAPE = "(unlabelled shape)";
export const LOOSE_END = "(loose end)";
const ANOTHER_CONNECTION = "(another connection)";

/** A label longer than this is cut: some hold whole paragraphs or tables. */
export const MAX_DRAWIO_LABEL_LENGTH = 120;
/** The compressed pages of one file may inflate to this many bytes before they are given up on. */
const MAX_INFLATED_BYTES = 2_000_000;
const MAX_WARNINGS = 10;

export interface DrawioPage {
  /** The page's name in an `<mxfile>`; null for a bare `<mxGraphModel>`. */
  readonly name: string | null;
  /** The page's own id in an `<mxfile>` (Draw.io keeps it across renames); null when it has none. */
  readonly id: string | null;
  /** Whether the page's model is stored compressed inside its `<diagram>`. */
  readonly compressed: boolean;
  /** Every shape's label, in file order. */
  readonly shapes: ReadonlyArray<string>;
  /**
   * "A -> B", or "A -[label]-> B". The arrowheads are the ones drawn: "<->"
   * for both ends, "<-" for the start only, "--" for a line with none.
   */
  readonly connections: ReadonlyArray<string>;
  /** What Draw.io would drop or attach wrongly: ids that repeat or point at nothing. */
  readonly warnings: ReadonlyArray<string>;
  /** Why the page could not be read, or null. Its shapes and connections are then empty. */
  readonly unreadable: string | null;
}

export type DrawioModel =
  | { readonly ok: true; readonly pages: ReadonlyArray<DrawioPage> }
  /** The source is not XML Draw.io can open; `error` says where and why. */
  | { readonly ok: false; readonly error: string };

class XmlError extends Error {}

interface XmlElement {
  readonly name: string;
  attributes: Map<string, string>;
  children: Array<XmlElement>;
  text: string;
  /** Where the element starts in the source, where its opening tag ends, and where it ends. */
  start: number;
  openEnd: number;
  end: number;
}

// Shared by every element that has none, so a file of many empty elements stays small in memory.
const NO_ATTRIBUTES: Map<string, string> = new Map();
const NO_CHILDREN: Array<XmlElement> = [];
const element = (name: string, start = 0): XmlElement => ({
  name,
  attributes: NO_ATTRIBUTES,
  children: NO_CHILDREN,
  text: "",
  start,
  openEnd: start,
  end: start,
});

const XML_ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

const REFERENCE = /&(?:#(\d+)|#x([0-9a-fA-F]+)|([A-Za-z][\w.-]*));|&/g;

/** The character a numeric reference names, or null when it names none. */
function numbered(decimal: string | undefined, hex: string | undefined): string | null {
  const value = decimal ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? "", 16);
  return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : null;
}

/** XML has five named entities and no others; a bare "&" is an error. */
function decodeXml(raw: string, bad: (message: string) => never): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(REFERENCE, (match, decimal?: string, hex?: string, name?: string) => {
    if (decimal || hex) return numbered(decimal, hex) ?? bad(`${match} is not a character`);
    if (name === undefined) return bad('a bare "&": write &amp;');
    return (
      XML_ENTITIES[name] ??
      bad(`&${name}; is not an XML entity: write the character itself, or a number like &#160;`)
    );
  });
}

const TAG_NAME = /[A-Za-z_:][^\s/>"'=<]*/y;
const ATTRIBUTE = /\s+([^\s=/>"'<]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
const TAG_END = /\s*(\/?)>/y;

function lineOf(xml: string, at: number): number {
  let line = 1;
  for (let next = xml.indexOf("\n"); next !== -1 && next < at; next = xml.indexOf("\n", next + 1)) {
    line += 1;
  }
  return line;
}

/** The document's root element. Throws XmlError for anything an XML parser refuses. */
function parseXml(xml: string): XmlElement {
  const document = element("");
  const stack = [document];
  let at = 0;
  const bad = (message: string, where = at): never => {
    throw new XmlError(`line ${lineOf(xml, where)}: ${message}`);
  };
  const skipPast = (end: string, what: string): number => {
    const close = xml.indexOf(end, at);
    return close === -1 ? bad(`${what} is never closed`) : close + end.length;
  };
  const addText = (text: string) => {
    const top = stack.at(-1)!;
    if (top !== document) top.text += text;
    else if (text.trim() !== "") bad("text outside the root element");
  };

  while (at < xml.length) {
    const open = xml.indexOf("<", at);
    addText(decodeXml(xml.slice(at, open === -1 ? xml.length : open), bad));
    if (open === -1) break;
    at = open;
    if (xml.startsWith("<!--", at)) {
      at = skipPast("-->", "a comment");
    } else if (xml.startsWith("<![CDATA[", at)) {
      const end = skipPast("]]>", "a CDATA section");
      addText(xml.slice(at + 9, end - 3));
      at = end;
    } else if (xml.startsWith("<?", at)) {
      at = skipPast("?>", "a processing instruction");
    } else if (xml.startsWith("<!", at)) {
      bad("a DOCTYPE or other declaration is not supported");
    } else if (xml.startsWith("</", at)) {
      const end = skipPast(">", "a closing tag");
      const name = xml.slice(at + 2, end - 1).trim();
      const top = stack.at(-1)!;
      if (top === document) bad(`</${name}> closes nothing`);
      if (top.name !== name) bad(`</${name}> where </${top.name}> was expected`);
      top.end = end;
      stack.pop();
      at = end;
    } else {
      TAG_NAME.lastIndex = at + 1;
      const name = TAG_NAME.exec(xml)?.[0];
      if (name === undefined) return bad('a "<" that starts no tag: write &lt;');
      const opened = element(name, open);
      at = TAG_NAME.lastIndex;
      for (;;) {
        ATTRIBUTE.lastIndex = at;
        const attribute = ATTRIBUTE.exec(xml);
        if (!attribute) break;
        const key = attribute[1]!;
        const raw = attribute[2] ?? attribute[3] ?? "";
        if (raw.includes("<")) bad(`the ${key} attribute of <${name}> holds a "<": write &lt;`);
        if (opened.attributes.has(key)) bad(`<${name}> has the ${key} attribute twice`);
        if (opened.attributes === NO_ATTRIBUTES) opened.attributes = new Map();
        // An XML parser turns a literal line break or tab inside an attribute into a space.
        opened.attributes.set(key, decodeXml(raw.replace(/[\t\n\r]/g, " "), bad));
        at = ATTRIBUTE.lastIndex;
      }
      TAG_END.lastIndex = at;
      const end = TAG_END.exec(xml);
      if (!end) {
        return bad(`the <${name}> tag is not closed, or an attribute value is not in quotes`);
      }
      const parent = stack.at(-1)!;
      if (parent === document && document.children.length > 0) {
        bad("a second root element", open);
      }
      if (parent.children === NO_CHILDREN) parent.children = [];
      parent.children.push(opened);
      at = TAG_END.lastIndex;
      opened.openEnd = at;
      opened.end = at;
      if (end[1] === "") stack.push(opened);
    }
  }
  if (stack.length > 1) bad(`<${stack.at(-1)!.name}> is never closed`, xml.length);
  return document.children[0] ?? bad("there is no root element", 0);
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  ...XML_ENTITIES,
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  larr: "←",
  rarr: "→",
};

// A tag, comment or style block that never closes runs to the end, as in a browser. It also keeps
// these linear in the label's length.
const HIDDEN_HTML = /<(style|script)\b[^>]*(?:>|$)[\s\S]*?(?:<\/\1\s*>|$)|<!--[\s\S]*?(?:-->|$)/gi;
/** Tags that end a line or a cell: the words on either side are separate. */
const BREAKING_TAG =
  /<\/?(?:br|div|p|li|ul|ol|tr|td|th|table|h[1-6]|hr|blockquote|pre)\b[^>]*(?:>|$)/gi;
const ANY_TAG = /<\/?[A-Za-z][^>]*(?:>|$)/g;

/** The words of an HTML label. Unknown entities stay as written. */
function htmlToText(html: string): string {
  return html
    .replace(HIDDEN_HTML, " ")
    .replace(BREAKING_TAG, " ")
    .replace(ANY_TAG, "")
    .replace(REFERENCE, (match, decimal?: string, hex?: string, name?: string) => {
      if (decimal || hex) return numbered(decimal, hex) ?? match;
      return (name === undefined ? undefined : HTML_ENTITIES[name]) ?? match;
    });
}

/** One `key=value` of a Draw.io style string ("rounded=1;html=1;endArrow=block;"). */
function styleValue(style: string, key: string): string | undefined {
  for (const part of style.split(";")) {
    const at = part.indexOf("=");
    if (at !== -1 && part.slice(0, at).trim() === key) return part.slice(at + 1).trim();
  }
  return undefined;
}

/** A label as plain words on one line. Only a cell styled `html=1` holds HTML. */
function labelText(value: string, style: string): string {
  const text = (styleValue(style, "html") === "1" ? htmlToText(value) : value)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_DRAWIO_LABEL_LENGTH
    ? `${text.slice(0, MAX_DRAWIO_LABEL_LENGTH - 1)}…`
    : text;
}

interface Cell {
  readonly id: string | undefined;
  readonly label: string;
  readonly vertex: boolean;
  readonly edge: boolean;
  readonly parent: string | undefined;
  readonly source: string | undefined;
  readonly target: string | undefined;
  readonly style: string;
}

/**
 * The cells of a model, in file order. A cell with custom data is wrapped in
 * an `<object>` or `<UserObject>` that carries its id and its label.
 */
function cellsOf(model: XmlElement): ReadonlyArray<Cell> {
  const root = model.children.find((child) => child.name === "root");
  return (root?.children ?? []).flatMap((element) => {
    const cell =
      element.name === "mxCell"
        ? element
        : element.children.find((child) => child.name === "mxCell");
    if (!cell) return [];
    const style = cell.attributes.get("style") ?? "";
    const value = element.attributes.get(element === cell ? "value" : "label") ?? "";
    return [
      {
        id: element.attributes.get("id"),
        label: labelText(value, style),
        vertex: cell.attributes.get("vertex") === "1",
        edge: cell.attributes.get("edge") === "1",
        parent: cell.attributes.get("parent"),
        source: cell.attributes.get("source"),
        target: cell.attributes.get("target"),
        style,
      },
    ];
  });
}

/** The line between two shapes, with the arrowheads Draw.io draws for the style. */
function arrow(style: string, label: string): string {
  const start = (styleValue(style, "startArrow") ?? "none") === "none" ? "" : "<";
  const end = (styleValue(style, "endArrow") ?? "classic") === "none" ? "" : ">";
  const line = label ? `-[${label}]-` : start || end ? "-" : "--";
  return `${start}${line}${end}`;
}

const quoted = (cells: ReadonlyArray<Cell>) =>
  cells
    .slice(0, 3)
    .map((cell) => `"${cell.label || cell.id || "?"}"`)
    .join(", ") + (cells.length > 3 ? ` and ${cells.length - 3} more` : "");

/** What names a page, read from its `<diagram>` element. */
interface PageHead {
  readonly name: string | null;
  readonly id: string | null;
  readonly compressed: boolean;
}

const BARE_PAGE: PageHead = { name: null, id: null, compressed: false };

function readPage(head: PageHead, model: XmlElement): DrawioPage {
  const cells = cellsOf(model);
  const byId = new Map<string, Cell>();
  const repeated = new Set<string>();
  for (const cell of cells) {
    if (cell.id === undefined) continue;
    if (byId.has(cell.id)) repeated.add(cell.id);
    byId.set(cell.id, cell);
  }
  const find = (id: string | undefined) => (id === undefined ? undefined : byId.get(id));

  // A label placed along a connection is a cell of its own, with the connection as its parent.
  const edgeLabels = new Map<string, Array<string>>();
  const shapes: Array<Cell> = [];
  for (const cell of cells) {
    if (!cell.vertex) continue;
    if (cell.parent !== undefined && find(cell.parent)?.edge) {
      const labels = edgeLabels.get(cell.parent) ?? [];
      if (cell.label) labels.push(cell.label);
      edgeLabels.set(cell.parent, labels);
    } else {
      shapes.push(cell);
    }
  }
  const endName = (id: string | undefined) => {
    const cell = find(id);
    if (cell?.edge) return ANOTHER_CONNECTION;
    return cell?.vertex ? cell.label || UNLABELLED_SHAPE : LOOSE_END;
  };
  const edges = cells.filter((cell) => cell.edge);
  const connections = edges.map((edge) => {
    const labels = [edge.label, ...(edgeLabels.get(edge.id ?? "") ?? [])].filter(Boolean);
    return `${endName(edge.source)} ${arrow(edge.style, labels.join(", "))} ${endName(edge.target)}`;
  });

  const warnings: Array<string> = [];
  if (repeated.size > 0) {
    const ids = [...repeated].slice(0, 3).map((id) => `"${id}"`);
    warnings.push(
      `More than one cell has the id ${ids.join(", ")}: give every cell its own id, or ` +
        `connections attach to the wrong shape.`,
    );
  }
  const orphans = [...shapes, ...edges].filter((cell) => !find(cell.parent));
  if (orphans.length > 0) {
    warnings.push(
      `${quoted(orphans)}: the parent is missing or names no cell, so Draw.io will not show ` +
        `${orphans.length === 1 ? "it" : "them"}. Keep <mxCell id="0"/> and ` +
        `<mxCell id="1" parent="0"/>, and put shapes and connections on parent="1".`,
    );
  }
  for (const edge of edges) {
    for (const end of ["source", "target"] as const) {
      const id = edge[end];
      if (id === undefined || byId.has(id) || warnings.length >= MAX_WARNINGS) continue;
      warnings.push(
        `Connection "${edge.label || edge.id || "?"}" has ${end}="${id}", but no cell has that ` +
          `id: that end is left loose.`,
      );
    }
  }
  return {
    ...head,
    shapes: shapes.map((cell) => cell.label || UNLABELLED_SHAPE),
    connections,
    warnings,
    unreadable: null,
  };
}

const emptyPage = (head: PageHead, unreadable: string | null = null): DrawioPage => ({
  ...head,
  shapes: [],
  connections: [],
  warnings: [],
  unreadable,
});

/**
 * A page Draw.io saved compressed: its XML is URI-encoded, deflated and
 * base64-encoded. Throws when any of those steps fails, or when the file's
 * pages inflate past `budget`, which this page's bytes are taken from.
 */
async function inflate(content: string, budget: { left: number }): Promise<string> {
  const bytes = Uint8Array.from(atob(content.replace(/\s+/g, "")), (char) => char.charCodeAt(0));
  const reader = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    budget.left -= value.byteLength;
    if (budget.left < 0) {
      await reader.cancel();
      throw new Error("too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return decodeURIComponent(text + decoder.decode());
}

/** A compressed page's XML, or null when it cannot be decoded. */
async function inflatePage(content: string, budget: { left: number }): Promise<string | null> {
  try {
    return await inflate(content, budget);
  } catch {
    return null;
  }
}

async function readDiagramElement(
  diagram: XmlElement,
  budget: { left: number },
): Promise<DrawioPage> {
  const name = diagram.attributes.get("name") ?? null;
  const id = diagram.attributes.get("id") ?? null;
  const model = diagram.children.find((child) => child.name === "mxGraphModel");
  if (model) return readPage({ name, id, compressed: false }, model);
  const content = diagram.text.trim();
  if (content === "") return emptyPage({ name, id, compressed: false });
  const head = { name, id, compressed: true };
  const inner = await inflatePage(content, budget);
  if (inner === null) {
    return emptyPage(head, "This page is saved compressed and could not be decoded.");
  }
  try {
    const root = parseXml(inner);
    if (root.name === "mxGraphModel") return readPage(head, root);
  } catch (cause) {
    if (!(cause instanceof XmlError)) throw cause;
  }
  return emptyPage(head, "This page is saved compressed and its content is not a Draw.io model.");
}

/**
 * Reads a Draw.io source: a bare `<mxGraphModel>`, or an `<mxfile>` with one
 * `<diagram>` per page, each holding a model or its compressed form. An empty
 * source has no pages. A page that cannot be read says so and lists nothing,
 * rather than guessing.
 */
export async function readDrawio(xml: string): Promise<DrawioModel> {
  if (xml.trim() === "") return { ok: true, pages: [] };
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (cause) {
    if (cause instanceof XmlError) return { ok: false, error: cause.message };
    throw cause;
  }
  if (root.name === "mxGraphModel") return { ok: true, pages: [readPage(BARE_PAGE, root)] };
  if (root.name !== "mxfile") {
    return { ok: false, error: "the root element must be <mxfile> or <mxGraphModel>" };
  }
  const pages: Array<DrawioPage> = [];
  const budget = { left: MAX_INFLATED_BYTES };
  for (const diagram of root.children) {
    if (diagram.name === "diagram") pages.push(await readDiagramElement(diagram, budget));
  }
  return { ok: true, pages };
}

export interface DrawioPageDescription {
  readonly name: string | null;
  readonly shapes?: ReadonlyArray<string>;
  readonly connections?: ReadonlyArray<string>;
  readonly unreadable?: string;
}

/**
 * A diagram as an agent is told it: `shapes` and `connections` for a file of
 * one page, `pages` for several, `unreadable` when there is nothing to trust.
 */
export interface DrawioDescription {
  readonly shapes?: ReadonlyArray<string>;
  readonly connections?: ReadonlyArray<string>;
  readonly pages?: ReadonlyArray<DrawioPageDescription>;
  readonly unreadable?: string;
  /** Present when the limits left something out. */
  readonly truncated?: string;
}

/** Describes a model, listing at most `limits` shapes and connections over all its pages. */
export function describeDrawio(
  model: DrawioModel,
  limits: { readonly shapes: number; readonly connections: number },
): DrawioDescription {
  if (!model.ok) return { unreadable: `The Draw.io XML could not be read: ${model.error}.` };
  const left = { ...limits };
  const omitted = { shapes: 0, connections: 0 };
  const take = (kind: "shapes" | "connections", items: ReadonlyArray<string>) => {
    const kept = items.slice(0, left[kind]);
    left[kind] -= kept.length;
    omitted[kind] += items.length - kept.length;
    return kept;
  };
  const pages = model.pages.map(
    (page): DrawioPageDescription =>
      page.unreadable === null
        ? {
            name: page.name,
            shapes: take("shapes", page.shapes),
            connections: take("connections", page.connections),
          }
        : { name: page.name, unreadable: page.unreadable },
  );
  const truncated =
    omitted.shapes + omitted.connections === 0
      ? {}
      : {
          truncated:
            `${omitted.shapes} more shapes and ${omitted.connections} more connections are ` +
            `left out to keep this short.`,
        };
  if (pages.length > 1) return { pages, ...truncated };
  const [only] = pages;
  if (only?.unreadable !== undefined) return { unreadable: only.unreadable };
  return { shapes: only?.shapes ?? [], connections: only?.connections ?? [], ...truncated };
}

/** Every page's warnings, each naming its page when the file has several. */
export function drawioWarnings(model: DrawioModel): ReadonlyArray<string> {
  if (!model.ok) return [];
  const several = model.pages.length > 1;
  return model.pages.flatMap((page, index) => {
    const where = several ? `Page ${index + 1}${page.name ? ` ("${page.name}")` : ""}: ` : "";
    const notes = page.unreadable === null ? page.warnings : [page.unreadable];
    return notes.map((note) => `${where}${note}`);
  });
}

/** One page of a source as Draw.io can open it on its own, for drawing that page's picture. */
export interface DrawioPageSource {
  readonly name: string | null;
  readonly id: string | null;
  /** A whole source holding only this page: the bare model, or an `<mxfile>` with one `<diagram>`. */
  readonly xml: string;
}

/**
 * The pages of a source, in order, each as a source of its own. The page's
 * text is copied as written, compressed or not, so Draw.io reads it as it
 * would the whole file. Null when the source is not one Draw.io can open.
 */
export function drawioPageSources(xml: string): ReadonlyArray<DrawioPageSource> | null {
  if (xml.trim() === "") return [];
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (cause) {
    if (cause instanceof XmlError) return null;
    throw cause;
  }
  if (root.name === "mxGraphModel") return [{ name: null, id: null, xml }];
  if (root.name !== "mxfile") return null;
  const open = xml.slice(root.start, root.openEnd).replace(/\/>$/, ">");
  return root.children
    .filter((child) => child.name === "diagram")
    .map((diagram) => ({
      name: diagram.attributes.get("name") ?? null,
      id: diagram.attributes.get("id") ?? null,
      xml: `${open}${xml.slice(diagram.start, diagram.end)}</mxfile>`,
    }));
}

/**
 * The source with every compressed page written out as its `<mxGraphModel>`,
 * so an agent can read and change it. Pages that are not compressed, or that
 * cannot be decoded, stay as they are; a source that does not parse is returned unchanged.
 */
export async function uncompressedDrawio(xml: string): Promise<string> {
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (cause) {
    if (cause instanceof XmlError) return xml;
    throw cause;
  }
  if (root.name !== "mxfile") return xml;
  const budget = { left: MAX_INFLATED_BYTES };
  let result = xml;
  // From the last page back, so the offsets of the pages before stay right.
  const pages = root.children.filter((child) => child.name === "diagram").reverse();
  for (const diagram of pages) {
    const content = diagram.text.trim();
    if (diagram.end === diagram.openEnd || content === "") continue;
    if (diagram.children.some((child) => child.name === "mxGraphModel")) continue;
    const inner = await inflatePage(content, budget);
    if (inner === null || !/^\s*<mxGraphModel[\s>/]/.test(inner)) continue;
    const close = diagram.end - "</diagram>".length;
    result = `${result.slice(0, diagram.openEnd)}${inner}${result.slice(close)}`;
  }
  return result;
}

const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/**
 * A bare `<mxGraphModel>` source as the one page of an `<mxfile>`, named and
 * numbered as given, so replacing a one-page file's drawing keeps its page name.
 */
export function asNamedPage(modelXml: string, page: { readonly name: string; readonly id: string | null }): string {
  const model = modelXml.replace(/^\s*<\?xml[^>]*\?>\s*/, "");
  const id = page.id === null ? "" : ` id="${escapeAttribute(page.id)}"`;
  return `<mxfile><diagram name="${escapeAttribute(page.name)}"${id}>${model}</diagram></mxfile>`;
}

/** How a page is named in a message: "Page 2 ("Flow")", or "Page 2" when it has no name. */
export const pageLabel = (index: number, name: string | null) =>
  `Page ${index + 1}${name ? ` ("${name}")` : ""}`;

/**
 * What stops a source an agent sends from being saved, page by page; empty when
 * nothing does. An `<mxfile>` must hold 1 to MAX_DIAGRAM_PAGES pages, each named
 * (docs pick a page by its name), no two alike, and each one readable.
 */
export function drawioPageProblems(model: DrawioModel, isFile: boolean): ReadonlyArray<string> {
  if (!model.ok) return [];
  if (!isFile) return model.pages.flatMap((page) => (page.unreadable ? [page.unreadable] : []));
  if (model.pages.length === 0) {
    return ['The <mxfile> has no pages: put each page in a <diagram name="..."> element.'];
  }
  const problems: Array<string> = [];
  if (model.pages.length > MAX_DIAGRAM_PAGES) {
    problems.push(
      `The file has ${model.pages.length} pages; at most ${MAX_DIAGRAM_PAGES} fit in one ` +
        `diagram. Split it into several diagrams.`,
    );
  }
  const seen = new Map<string, number>();
  for (const [index, page] of model.pages.entries()) {
    const where = pageLabel(index, page.name);
    const name = page.name === null ? "" : pageNameLine(page.name);
    if (name === "") {
      problems.push(`${where}: give its <diagram> a name attribute; docs pick a page by name.`);
    } else if (name.length > MAX_DRAWIO_PAGE_NAME_LENGTH) {
      problems.push(`${where}: the name is over ${MAX_DRAWIO_PAGE_NAME_LENGTH} characters.`);
    } else if (seen.has(name)) {
      problems.push(
        `${where}: page ${seen.get(name)! + 1} has the same name; give every page its own.`,
      );
    } else {
      seen.set(name, index);
    }
    if (page.unreadable) problems.push(`${where}: ${page.unreadable}`);
  }
  return problems;
}
