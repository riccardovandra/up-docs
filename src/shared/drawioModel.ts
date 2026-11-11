// A Draw.io source read as text an agent can follow: each page's shapes (their
// labels) and its connections ("A -> B"). The Worker has no DOMParser, so the
// XML is parsed here by hand, and strictly: Draw.io opens a file with the
// browser's XML parser, so a source refused here would not open there either.

import { MAX_DIAGRAM_PAGES, MAX_DRAWIO_PAGE_NAME_LENGTH, pageNameLine } from "./drawio.ts";
import { layoutProblems, type LayoutBox, type LayoutEdge, type LayoutPoint } from "./drawioLayout.ts";

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
    const cell = cellOf(element);
    return cell ? [cell] : [];
  });
}

/** One child of `<root>` as a cell, with its `<mxGeometry>`; null when it holds no `<mxCell>`. */
function cellOf(
  element: XmlElement,
): (Cell & { readonly geometry: XmlElement | undefined; readonly value: string }) | null {
  const cell =
    element.name === "mxCell" ? element : element.children.find((child) => child.name === "mxCell");
  if (!cell) return null;
  const style = cell.attributes.get("style") ?? "";
  const value = element.attributes.get(element === cell ? "value" : "label") ?? "";
  return {
    id: element.attributes.get("id"),
    label: labelText(value, style),
    vertex: cell.attributes.get("vertex") === "1",
    edge: cell.attributes.get("edge") === "1",
    parent: cell.attributes.get("parent"),
    source: cell.attributes.get("source"),
    target: cell.attributes.get("target"),
    style,
    value,
    geometry: cell.children.find((child) => child.name === "mxGeometry"),
  };
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
  warnings.push(...pageLayoutProblems(model));
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

/** Reads one page's model into T, or says why the page is unreadable. */
interface PageReader<T> {
  readonly read: (head: PageHead, model: XmlElement) => T;
  readonly empty: (head: PageHead, unreadable?: string | null) => T;
}

const PAGE_READER: PageReader<DrawioPage> = { read: readPage, empty: emptyPage };

async function readDiagramElement<T>(
  diagram: XmlElement,
  budget: { left: number },
  reader: PageReader<T>,
): Promise<T> {
  const name = diagram.attributes.get("name") ?? null;
  const id = diagram.attributes.get("id") ?? null;
  const model = diagram.children.find((child) => child.name === "mxGraphModel");
  if (model) return reader.read({ name, id, compressed: false }, model);
  const content = diagram.text.trim();
  if (content === "") {
    // A page with elements but no model is not one Draw.io would draw.
    return diagram.children.length > 0
      ? reader.empty({ name, id, compressed: false }, "This page holds no <mxGraphModel>.")
      : reader.empty({ name, id, compressed: false });
  }
  const head = { name, id, compressed: true };
  const inner = await inflatePage(content, budget);
  if (inner === null) {
    return reader.empty(head, "This page is saved compressed and could not be decoded.");
  }
  try {
    const root = parseXml(inner);
    if (root.name === "mxGraphModel") return reader.read(head, root);
  } catch (cause) {
    if (!(cause instanceof XmlError)) throw cause;
  }
  return reader.empty(head, "This page is saved compressed and its content is not a Draw.io model.");
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
    if (diagram.name === "diagram") pages.push(await readDiagramElement(diagram, budget, PAGE_READER));
  }
  return { ok: true, pages };
}

/** A shape's box on its page, in diagram coordinates (what Draw.io's geometry says, parents added). */
export interface DrawioShapeBox {
  readonly id: string;
  /** Its label as plain words, or "" when it has none. */
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DrawioPageLayout {
  readonly name: string | null;
  readonly id: string | null;
  /** The shapes (vertices) with a box, in file order: later ones are drawn on top. */
  readonly shapes: ReadonlyArray<DrawioShapeBox>;
  /** Every shape box and connection point, or null for a page with nothing drawn. */
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
}

const numberAttribute = (element: XmlElement, key: string) => {
  const value = Number(element.attributes.get(key) ?? "0");
  return Number.isFinite(value) ? value : 0;
};

function readLayout(head: PageHead, model: XmlElement): DrawioPageLayout {
  const root = model.children.find((child) => child.name === "root");
  interface Placed {
    readonly cell: Cell;
    readonly geometry: XmlElement | undefined;
  }
  const placed = new Map<string, Placed>();
  const order: Array<Placed> = [];
  for (const element of root?.children ?? []) {
    const cell = cellOf(element);
    if (!cell) continue;
    const entry = { cell, geometry: cell.geometry };
    order.push(entry);
    if (cell.id !== undefined && !placed.has(cell.id)) placed.set(cell.id, entry);
  }
  // A shape inside a group or container is placed relative to it.
  const originOf = (id: string | undefined, depth = 0): { x: number; y: number } => {
    const parent = id === undefined ? undefined : placed.get(id);
    if (!parent || !parent.cell.vertex || !parent.geometry || depth > 50) return { x: 0, y: 0 };
    const above = originOf(parent.cell.parent, depth + 1);
    return {
      x: above.x + numberAttribute(parent.geometry, "x"),
      y: above.y + numberAttribute(parent.geometry, "y"),
    };
  };
  const shapes: Array<DrawioShapeBox> = [];
  const points: Array<{ x: number; y: number }> = [];
  for (const { cell, geometry } of order) {
    // A relative vertex is a label placed along something else; an edge's geometry is always relative.
    if (!geometry || (cell.vertex && geometry.attributes.get("relative") === "1")) continue;
    const parent = cell.parent === undefined ? undefined : placed.get(cell.parent);
    if (parent?.cell.edge) continue;
    const origin = originOf(cell.parent);
    if (cell.vertex && cell.id !== undefined) {
      const box = {
        id: cell.id,
        label: cell.label,
        x: origin.x + numberAttribute(geometry, "x"),
        y: origin.y + numberAttribute(geometry, "y"),
        width: numberAttribute(geometry, "width"),
        height: numberAttribute(geometry, "height"),
      };
      shapes.push(box);
      points.push({ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y + box.height });
    } else if (cell.edge) {
      const all = [
        ...geometry.children,
        ...geometry.children.filter((child) => child.name === "Array").flatMap((list) => list.children),
      ];
      for (const point of all) {
        if (point.name !== "mxPoint") continue;
        points.push({
          x: origin.x + numberAttribute(point, "x"),
          y: origin.y + numberAttribute(point, "y"),
        });
      }
    }
  }
  if (points.length === 0) return { name: head.name, id: head.id, shapes, bounds: null };
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    name: head.name,
    id: head.id,
    shapes,
    bounds: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y },
  };
}

/** A label's lines as drawn: each line break in the text or the HTML starts one. */
function labelLines(value: string, style: string): ReadonlyArray<string> {
  const html = styleValue(style, "html") === "1";
  const broken = html ? value.replace(HIDDEN_HTML, " ").replace(BREAKING_TAG, "\n") : value;
  return broken
    .split("\n")
    .map((line) => (html ? htmlToText(line) : line).replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
}

const styleNumber = (style: string, key: string, fallback: number) => {
  const value = Number(styleValue(style, key));
  return styleValue(style, key) !== undefined && Number.isFinite(value) ? value : fallback;
};

/** Bare style names ("swimlane", "text") of a style string. */
const styleNames = (style: string) =>
  new Set(
    style
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part !== "" && !part.includes("=")),
  );

/** The page's layout problems: labels that overflow, boxes that overlap, lines through boxes. */
function pageLayoutProblems(model: XmlElement): ReadonlyArray<string> {
  const root = model.children.find((child) => child.name === "root");
  const cells = (root?.children ?? []).flatMap((element) => {
    const cell = cellOf(element);
    return cell ? [cell] : [];
  });
  const byId = new Map<string, (typeof cells)[number]>();
  for (const cell of cells) if (cell.id !== undefined && !byId.has(cell.id)) byId.set(cell.id, cell);
  const originOf = (id: string | undefined, depth = 0): LayoutPoint => {
    const parent = id === undefined ? undefined : byId.get(id);
    if (!parent || !parent.vertex || !parent.geometry || depth > 50) return { x: 0, y: 0 };
    const above = originOf(parent.parent, depth + 1);
    return {
      x: above.x + numberAttribute(parent.geometry, "x"),
      y: above.y + numberAttribute(parent.geometry, "y"),
    };
  };

  const boxes: Array<LayoutBox> = [];
  const edges: Array<LayoutEdge> = [];
  for (const cell of cells) {
    const { geometry, style } = cell;
    if (!geometry || cell.id === undefined) continue;
    const parent = cell.parent === undefined ? undefined : byId.get(cell.parent);
    if (parent?.edge) continue;
    const origin = originOf(cell.parent);
    if (cell.vertex) {
      if (geometry.attributes.get("relative") === "1") continue;
      const names = styleNames(style);
      const shape = styleValue(style, "shape");
      if (names.has("edgeLabel") || names.has("image") || shape === "image" || styleValue(style, "image")) {
        continue;
      }
      // Turned shapes and labels: the estimate would be wrong, so they are left alone.
      if (styleNumber(style, "rotation", 0) !== 0 || styleValue(style, "horizontal") === "0") continue;
      const swimlane = names.has("swimlane") || shape === "swimlane";
      const container =
        swimlane || names.has("group") || styleValue(style, "container") === "1" || shape === "table";
      const spacing = styleNumber(style, "spacing", 2);
      const fontStyle = styleNumber(style, "fontStyle", 0);
      const html = styleValue(style, "html") === "1";
      const centred = (key: string, value: string) => (styleValue(style, key) ?? value) === value;
      boxes.push({
        id: cell.id,
        name: labelLines(cell.value, style)[0]?.slice(0, 40) ?? "",
        x: origin.x + numberAttribute(geometry, "x"),
        y: origin.y + numberAttribute(geometry, "y"),
        width: numberAttribute(geometry, "width"),
        height: numberAttribute(geometry, "height"),
        parent: parent?.vertex ? parent.id : undefined,
        kind: container ? "container" : names.has("text") ? "text" : "box",
        lines: labelLines(cell.value, style),
        fontSize: styleNumber(style, "fontSize", 12),
        fontFamily: styleValue(style, "fontFamily") ?? "",
        bold: (fontStyle & 1) === 1,
        wrap: html && styleValue(style, "whiteSpace") === "wrap",
        padding: {
          left: spacing + styleNumber(style, "spacingLeft", 0),
          right: spacing + styleNumber(style, "spacingRight", 0),
          top: spacing + styleNumber(style, "spacingTop", 0),
          bottom: spacing + styleNumber(style, "spacingBottom", 0),
        },
        labelInside:
          centred("labelPosition", "center") &&
          centred("verticalLabelPosition", "middle") &&
          styleValue(style, "overflow") !== "width" &&
          styleValue(style, "noLabel") !== "1",
        header: swimlane ? styleNumber(style, "startSize", 23) : 0,
      });
    } else if (cell.edge) {
      const point = (element: XmlElement): LayoutPoint => ({
        x: origin.x + numberAttribute(element, "x"),
        y: origin.y + numberAttribute(element, "y"),
      });
      const named = (as: string) => {
        const found = geometry.children.find((child) => child.name === "mxPoint" && child.attributes.get("as") === as);
        return found ? point(found) : undefined;
      };
      const list = geometry.children.find((child) => child.name === "Array" && child.attributes.get("as") === "points");
      const fraction = (x: string, y: string) =>
        styleValue(style, x) !== undefined && styleValue(style, y) !== undefined
          ? { x: styleNumber(style, x, 0.5), y: styleNumber(style, y, 0.5) }
          : undefined;
      const router = styleValue(style, "edgeStyle") ?? "";
      edges.push({
        id: cell.id,
        source: cell.source,
        target: cell.target,
        sourcePoint: named("sourcePoint"),
        targetPoint: named("targetPoint"),
        exit: fraction("exitX", "exitY"),
        entry: fraction("entryX", "entryY"),
        points: (list?.children ?? []).filter((child) => child.name === "mxPoint").map(point),
        orthogonal: router !== "" && router !== "none",
      });
    }
  }
  return layoutProblems(boxes, edges);
}

const LAYOUT_READER: PageReader<DrawioPageLayout> = {
  read: readLayout,
  empty: (head) => ({ name: head.name, id: head.id, shapes: [], bounds: null }),
};

/**
 * Where each page's shapes sit, for placing comment pins: one layout per page,
 * in order. Null when the source is not XML Draw.io can open.
 */
export async function readDrawioLayout(
  xml: string,
): Promise<ReadonlyArray<DrawioPageLayout> | null> {
  if (xml.trim() === "") return [];
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (cause) {
    if (cause instanceof XmlError) return null;
    throw cause;
  }
  if (root.name === "mxGraphModel") return [readLayout(BARE_PAGE, root)];
  if (root.name !== "mxfile") return null;
  const budget = { left: MAX_INFLATED_BYTES };
  const pages: Array<DrawioPageLayout> = [];
  for (const diagram of root.children) {
    if (diagram.name === "diagram") {
      pages.push(await readDiagramElement(diagram, budget, LAYOUT_READER));
    }
  }
  return pages;
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

/** One cell as a rewrite sees it: what it is and its style. */
export interface DrawioCellTarget {
  readonly vertex: boolean;
  readonly edge: boolean;
  readonly style: string;
  /** A label placed along a connection: a vertex whose parent is an edge. */
  readonly parentIsEdge: boolean;
}

/** What `rewriteDrawio` changes: each cell's style, and each page's model attributes. */
export interface DrawioRewrite {
  /** The cell's new style, or null to leave the cell exactly as written. */
  readonly cell: (cell: DrawioCellTarget) => string | null;
  /** Attributes to set on a page's `<mxGraphModel>`, or null to leave it. */
  readonly model?: (attributes: ReadonlyMap<string, string>) => Readonly<
    Record<string, string>
  > | null;
}

export type DrawioRewriteResult =
  | {
      readonly ok: true;
      readonly xml: string;
      /** Pages rewritten, and pages left as they were because they could not be read. */
      readonly pages: number;
      readonly unreadablePages: number;
    }
  | { readonly ok: false; readonly error: string };

/** The opening tag `tag` with `key` set to `value`, in place when it has one, else appended. */
function setTagAttribute(tag: string, key: string, value: string): string {
  const written = `${key}="${escapeAttribute(value)}"`;
  TAG_NAME.lastIndex = 1;
  TAG_NAME.exec(tag);
  let at = TAG_NAME.lastIndex;
  for (;;) {
    ATTRIBUTE.lastIndex = at;
    const attribute = ATTRIBUTE.exec(tag);
    if (!attribute) break;
    if (attribute[1] === key) {
      const start = attribute.index + attribute[0].indexOf(key);
      return `${tag.slice(0, start)}${written}${tag.slice(ATTRIBUTE.lastIndex)}`;
    }
    at = ATTRIBUTE.lastIndex;
  }
  const end = tag.endsWith("/>") ? tag.length - 2 : tag.length - 1;
  return `${tag.slice(0, end).replace(/\s+$/, "")} ${written}${tag.slice(end)}`;
}

/** One model's source with the rewrite applied to its cells' and its own opening tags. */
function rewriteModel(xml: string, model: XmlElement, rewrite: DrawioRewrite): string {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const setAll = (target: XmlElement, values: Readonly<Record<string, string>>) => {
    let tag = xml.slice(target.start, target.openEnd);
    for (const [key, value] of Object.entries(values)) tag = setTagAttribute(tag, key, value);
    edits.push({ start: target.start, end: target.openEnd, text: tag });
  };
  const modelValues = rewrite.model?.(model.attributes);
  if (modelValues) setAll(model, modelValues);
  const root = model.children.find((child) => child.name === "root");
  const cells = (root?.children ?? []).flatMap((element) => {
    const cell =
      element.name === "mxCell"
        ? element
        : element.children.find((child) => child.name === "mxCell");
    return cell ? [{ id: element.attributes.get("id"), cell }] : [];
  });
  const edgeIds = new Set(
    cells.filter(({ cell }) => cell.attributes.get("edge") === "1").map(({ id }) => id),
  );
  for (const { cell } of cells) {
    const parent = cell.attributes.get("parent");
    const style = rewrite.cell({
      vertex: cell.attributes.get("vertex") === "1",
      edge: cell.attributes.get("edge") === "1",
      style: cell.attributes.get("style") ?? "",
      parentIsEdge: parent !== undefined && edgeIds.has(parent),
    });
    if (style !== null) setAll(cell, { style });
  }
  let result = xml.slice(model.start, model.end);
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    result =
      result.slice(0, edit.start - model.start) + edit.text + result.slice(edit.end - model.start);
  }
  return result;
}

/**
 * Rewrites the cells of every page of a source, keeping everything else as
 * written: ids, geometry, labels, the attributes the rewrite does not set. A
 * compressed page comes back written out as its `<mxGraphModel>`. A page that
 * cannot be read is left as it is and counted.
 */
export async function rewriteDrawio(
  xml: string,
  rewrite: DrawioRewrite,
): Promise<DrawioRewriteResult> {
  if (xml.trim() === "") return { ok: true, xml, pages: 0, unreadablePages: 0 };
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (cause) {
    if (cause instanceof XmlError) return { ok: false, error: cause.message };
    throw cause;
  }
  if (root.name === "mxGraphModel") {
    const rewritten = rewriteModel(xml, root, rewrite);
    return {
      ok: true,
      xml: xml.slice(0, root.start) + rewritten + xml.slice(root.end),
      pages: 1,
      unreadablePages: 0,
    };
  }
  if (root.name !== "mxfile") {
    return { ok: false, error: "the root element must be <mxfile> or <mxGraphModel>" };
  }
  const budget = { left: MAX_INFLATED_BYTES };
  let result = xml;
  let pages = 0;
  let unreadablePages = 0;
  // From the last page back, so the offsets of the pages before stay right.
  const diagrams = root.children.filter((child) => child.name === "diagram").reverse();
  for (const diagram of diagrams) {
    const model = diagram.children.find((child) => child.name === "mxGraphModel");
    if (model) {
      result = result.slice(0, model.start) + rewriteModel(xml, model, rewrite) + result.slice(model.end);
      pages += 1;
      continue;
    }
    const content = diagram.text.trim();
    if (content === "" || diagram.children.length > 0) {
      if (content === "" && diagram.children.length === 0) pages += 1;
      else unreadablePages += 1;
      continue;
    }
    const inner = await inflatePage(content, budget);
    let innerRoot: XmlElement | null = null;
    if (inner !== null) {
      try {
        innerRoot = parseXml(inner);
      } catch (cause) {
        if (!(cause instanceof XmlError)) throw cause;
      }
    }
    if (inner === null || innerRoot?.name !== "mxGraphModel") {
      unreadablePages += 1;
      continue;
    }
    const close = diagram.end - "</diagram>".length;
    result = `${result.slice(0, diagram.openEnd)}${rewriteModel(inner, innerRoot, rewrite)}${result.slice(close)}`;
    pages += 1;
  }
  return { ok: true, xml: result, pages, unreadablePages };
}
