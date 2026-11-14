// Draw.io diagrams: library items of their own. A doc links one with a
// ```t3-drawio block whose first line is the diagram's id, then an optional
// `page: <name>` line, then an optional caption. The diagram (its Draw.io XML and the picture drawn
// from it) is stored once, so one save updates every doc that links it.

import type { DocRole } from "./access.ts";
import { findFences } from "./table.ts";

export const DRAWIO_LANGUAGE = "t3-drawio";

export const MAX_DRAWIO_CAPTION_LENGTH = 300;
export const MAX_DIAGRAM_TITLE_LENGTH = 200;
export const DEFAULT_DIAGRAM_TITLE = "Untitled diagram";

/** The Draw.io source, in UTF-8 bytes. D1 caps a row at 2,000,000 bytes. */
export const MAX_DIAGRAM_XML_BYTES = 1_000_000;
/** Each stored picture (the SVG, the PNG), in bytes. */
export const MAX_DIAGRAM_PICTURE_BYTES = 10 * 1024 * 1024;

/** A page name in a block's `page:` line. */
export const MAX_DRAWIO_PAGE_NAME_LENGTH = 200;
/**
 * The pages a diagram written over MCP may hold, and how many pages get a
 * picture. A person can draw more in the editor; pages past this have no picture.
 */
export const MAX_DIAGRAM_PAGES = 20;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export const isDiagramId = (value: string) => ID.test(value);

/** A diagram without its source: what lists and pictures need. */
export interface DiagramSummary {
  readonly id: string;
  /** Null for a diagram in no project. */
  readonly projectId: string | null;
  readonly title: string;
  /** Goes up by one on every change to the source. */
  readonly version: number;
  /**
   * The version the stored picture was drawn from, or null when there is no
   * picture. Behind `version`, the picture is out of date and must be redrawn.
   */
  readonly pictureVersion: number | null;
  /**
   * The name of every page (null for a page with none), in order, as the
   * picture at `pictureVersion` was drawn: one picture per page, up to
   * MAX_DIAGRAM_PAGES. Null for a picture drawn before pages were known (it
   * shows the first page), and when there is no picture.
   */
  readonly picturePages: ReadonlyArray<string | null> | null;
  /** False for a diagram nobody has drawn in yet. */
  readonly hasSource: boolean;
  /** The user who created it; null once that account is gone. */
  readonly createdBy: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Diagram extends DiagramSummary {
  /** Draw.io XML: an `<mxfile>` or a bare `<mxGraphModel>`. Empty until first drawn. */
  readonly xml: string;
}

/** A tab that links a diagram through a ```t3-drawio block. */
export interface DiagramUse {
  readonly docId: string;
  readonly docTitle: string;
  readonly tabId: string;
  readonly tabTitle: string;
}

/** Where a diagram is linked, as one person sees it. */
export interface DiagramUsage {
  /** Tabs in docs the person can read. */
  readonly uses: ReadonlyArray<DiagramUse>;
  /** How many more docs link it that the person is not on. */
  readonly otherDocs: number;
}

/** `GET /api/diagrams`: a diagram the caller is on, with the readable tabs that link it. */
export interface DiagramListItem extends DiagramSummary {
  /** The caller's role on it. */
  readonly role: DocRole;
  readonly uses: ReadonlyArray<DiagramUse>;
  /** How many comment threads on it are open. */
  readonly openComments: number;
}

/**
 * `GET /api/diagrams/:id`: the diagram as one caller may see it. Viewers and
 * commenters get the picture, never the source: `canEdit` is false and `xml`
 * is null. `member` is false for someone who sees it only through a doc that
 * links it (role "viewer"): they are not on its people list.
 */
export interface DiagramView extends DiagramSummary {
  readonly canEdit: boolean;
  readonly role: DocRole;
  readonly member: boolean;
  readonly xml: string | null;
}

/**
 * How many diagrams one `GET /api/diagrams?ids=` may ask about. Each costs a
 * query or two, and a Worker on the free plan may make 50 per request.
 */
export const MAX_DIAGRAM_REFRESH_IDS = 20;

/**
 * `GET /api/diagrams?ids=<id>,<id>`: a diagram as an open page re-reads it,
 * never with its source. `usage` is null for someone who only views it.
 */
export interface DiagramRefresh extends DiagramSummary {
  readonly canEdit: boolean;
  readonly role: DocRole;
  readonly usage: DiagramUsage | null;
}

export type DiagramPictureFormat = "svg" | "png";

export const DIAGRAM_PICTURE_TYPES: Readonly<Record<DiagramPictureFormat, string>> = {
  svg: "image/svg+xml",
  png: "image/png",
};

export const isDiagramPictureFormat = (value: unknown): value is DiagramPictureFormat =>
  value === "svg" || value === "png";

/** The app page for a diagram. */
export const diagramPath = (diagramId: string) => `/diagrams/${diagramId}`;

/**
 * Where a diagram's picture is served. Pass the picture's version so a browser
 * caches it for good and asks again only when the picture changes.
 */
export function diagramPictureUrl(
  diagramId: string,
  format: DiagramPictureFormat,
  pictureVersion?: number | null,
  /** Which page, counted from 0. The first page's address has no `page`. */
  pageIndex = 0,
): string {
  const query = new URLSearchParams();
  if (pageIndex > 0) query.set("page", String(pageIndex));
  if (pictureVersion != null) query.set("v", String(pictureVersion));
  const search = query.toString();
  return `/api/diagrams/${diagramId}/picture.${format}${search === "" ? "" : `?${search}`}`;
}

/** A page name as a block's `page:` line holds it: one line, spaces collapsed, trimmed. */
export const pageNameLine = (name: string) => name.replace(/\s+/g, " ").trim();

/** Where page `page` is among `names` (the first of that name), or -1. Spaces are collapsed. */
export function pageIndexOf(names: ReadonlyArray<string | null>, page: string): number {
  const wanted = pageNameLine(page);
  return names.findIndex((name) => name !== null && pageNameLine(name) === wanted);
}

/** What a block's page shows from the stored picture. */
export type PagePicture =
  /** The picture of the page at `index`. */
  | { readonly kind: "picture"; readonly index: number }
  /** The diagram has no page of that name. */
  | { readonly kind: "not_found" }
  /** The page exists, past MAX_DIAGRAM_PAGES, and has no picture. */
  | { readonly kind: "no_picture" }
  /** The stored picture does not say which page is which: it must be drawn again. */
  | { readonly kind: "unknown" };

/**
 * Which stored picture shows `page` (null: the first page). Read against the
 * picture's own page list, so it is right whenever the picture is current.
 */
export function pagePicture(
  diagram: Pick<DiagramSummary, "picturePages">,
  page: string | null,
): PagePicture {
  if (page === null) return { kind: "picture", index: 0 };
  const names = diagram.picturePages;
  if (names === null) return { kind: "unknown" };
  const index = pageIndexOf(names, page);
  if (index === -1) return { kind: "not_found" };
  return index < MAX_DIAGRAM_PAGES ? { kind: "picture", index } : { kind: "no_picture" };
}

/** Whether the stored picture shows the current source. */
export const isPictureCurrent = (
  diagram: Pick<DiagramSummary, "version" | "pictureVersion" | "hasSource">,
) => !diagram.hasSource || diagram.pictureVersion === diagram.version;

export interface DiagramSourceProblem {
  readonly code: "too_large" | "invalid_xml";
  readonly message: string;
}

const XML_START = /^\s*(?:<\?xml[^>]*\?>\s*)?<(mxfile|mxGraphModel)[\s>/]/;

/** A source's root element: an `<mxfile>` of pages or one bare `<mxGraphModel>`; null for anything else. */
export function drawioRoot(xml: string): "mxfile" | "mxGraphModel" | null {
  const root = XML_START.exec(xml)?.[1];
  return root === "mxfile" || root === "mxGraphModel" ? root : null;
}

/**
 * Why a Draw.io source cannot be saved, or null when it can. Empty is fine: a
 * diagram starts with no source. Only the size and the root element are
 * checked; Draw.io itself reports a file it cannot open.
 */
export function checkDiagramXml(xml: string): DiagramSourceProblem | null {
  if (xml === "") return null;
  if (new TextEncoder().encode(xml).length > MAX_DIAGRAM_XML_BYTES) {
    return {
      code: "too_large",
      message:
        `The diagram is too large to save: its Draw.io source is over the ` +
        `${MAX_DIAGRAM_XML_BYTES / 1_000_000} MB limit. Split it into smaller diagrams, ` +
        `or remove pictures pasted into it.`,
    };
  }
  if (!XML_START.test(xml)) {
    return {
      code: "invalid_xml",
      message:
        "The diagram source must be Draw.io XML: a document whose root is <mxfile> or " +
        "<mxGraphModel>.",
    };
  }
  return null;
}

export interface DrawioBlock {
  readonly diagramId: string;
  /** The page the block shows, by name; null for the first page. */
  readonly page: string | null;
  readonly caption: string | null;
}

const PAGE_LINE = "page:";

/**
 * Reads a block's text: a diagram id line, an optional `page: <name>` line,
 * then an optional caption line, nothing else. The line after the id is the
 * page line whenever it starts with "page:" (lower case); an empty `page:`
 * means the first page, which is how a caption that itself starts with
 * "page:" is written: on the line after an empty `page:`.
 */
export function parseDrawioBlock(body: string): DrawioBlock | null {
  const lines = body.split("\n").map((line) => line.trim());
  const first = lines[0] ?? "";
  if (!isDiagramId(first)) return null;
  let at = 1;
  let page: string | null = null;
  if (lines[at]?.startsWith(PAGE_LINE)) {
    const name = pageNameLine(lines[at]!.slice(PAGE_LINE.length));
    if (name.length > MAX_DRAWIO_PAGE_NAME_LENGTH) return null;
    page = name === "" ? null : name;
    at += 1;
  }
  const caption = lines[at] ?? "";
  if (lines.slice(at + 1).some((line) => line !== "")) return null;
  if (caption.length > MAX_DRAWIO_CAPTION_LENGTH) return null;
  return { diagramId: first, page, caption: caption === "" ? null : caption };
}

/** A block's language, ignoring anything after the first word of the info string. */
export const isDrawioLanguage = (language: string | null | undefined) =>
  language?.trim().split(/\s+/, 1)[0] === DRAWIO_LANGUAGE;

/**
 * A block's text for a diagram, a page (null: the first) and a caption, each
 * one line. A caption that starts with "page:" goes after an empty page line,
 * so it is never read as one.
 */
export function drawioBlockBody(
  diagramId: string,
  caption: string | null = null,
  page: string | null = null,
): string {
  const line = caption?.replace(/\s+/g, " ").trim() ?? "";
  const name = page === null ? "" : pageNameLine(page);
  const lines = [diagramId];
  if (name !== "" || line.startsWith(PAGE_LINE)) lines.push(name === "" ? PAGE_LINE : `${PAGE_LINE} ${name}`);
  if (line !== "") lines.push(line);
  return lines.join("\n");
}

/** A whole fenced block, ready to put in a tab's markdown. */
export const drawioBlock = (
  diagramId: string,
  caption: string | null = null,
  page: string | null = null,
) => `\`\`\`${DRAWIO_LANGUAGE}\n${drawioBlockBody(diagramId, caption, page)}\n\`\`\``;

/**
 * The id of every diagram `markdown` links, in order, each once.
 * Blocks that do not parse are skipped.
 */
export function drawioDiagramIds(markdown: string): ReadonlyArray<string> {
  return [...new Set(drawioBlocks(markdown).map((block) => block.diagramId))];
}

/** Every block in `markdown` that parses, in order. */
export function drawioBlocks(markdown: string): ReadonlyArray<DrawioBlock> {
  const blocks: Array<DrawioBlock> = [];
  for (const fence of findFences(markdown)) {
    if (fence.language !== DRAWIO_LANGUAGE) continue;
    const block = parseDrawioBlock(fence.body);
    if (block) blocks.push(block);
  }
  return blocks;
}

/**
 * Every block a write adds or changes must parse. A block left byte-identical
 * to `previous` is not re-checked, so older content never blocks an unrelated edit.
 * Whether the diagram exists is not checked here: that needs the database.
 */
export function checkDrawioIn(markdown: string, previous?: string): string | null {
  const blocks = findFences(markdown).filter((fence) => fence.language === DRAWIO_LANGUAGE);
  const unchanged = new Set(
    findFences(previous ?? "")
      .filter((fence) => fence.language === DRAWIO_LANGUAGE)
      .map((fence) => fence.body),
  );
  for (const [index, fence] of blocks.entries()) {
    if (unchanged.has(fence.body) || parseDrawioBlock(fence.body)) continue;
    const which = blocks.length === 1 ? "The t3-drawio block" : `t3-drawio block ${index + 1}`;
    return (
      `${which}: the first line must be the id of a diagram. Only an optional ` +
      `"page: <page name>" line and then a caption of up to ${MAX_DRAWIO_CAPTION_LENGTH} ` +
      `characters may follow it.`
    );
  }
  return null;
}
