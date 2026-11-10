// Draw.io diagrams: library items of their own. A doc links one with a
// ```t3-drawio block whose first line is the diagram's id and whose optional
// second line is a caption. The diagram (its Draw.io XML and the picture drawn
// from it) is stored once, so one save updates every doc that links it.

import { findFences } from "./table.ts";

export const DRAWIO_LANGUAGE = "t3-drawio";

export const MAX_DRAWIO_CAPTION_LENGTH = 300;
export const MAX_DIAGRAM_TITLE_LENGTH = 200;
export const DEFAULT_DIAGRAM_TITLE = "Untitled diagram";

/** The Draw.io source, in UTF-8 bytes. D1 caps a row at 2,000,000 bytes. */
export const MAX_DIAGRAM_XML_BYTES = 1_000_000;
/** Each stored picture (the SVG, the PNG), in bytes. */
export const MAX_DIAGRAM_PICTURE_BYTES = 10 * 1024 * 1024;

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

/** `GET /api/diagrams`: a diagram the caller manages, with the readable tabs that link it. */
export interface DiagramListItem extends DiagramSummary {
  readonly uses: ReadonlyArray<DiagramUse>;
}

/**
 * `GET /api/diagrams/:id`: the diagram as one caller may see it. Someone who
 * only reads a doc that links it gets the picture, never the source: `canEdit`
 * is false and `xml` is null.
 */
export interface DiagramView extends DiagramSummary {
  readonly canEdit: boolean;
  readonly xml: string | null;
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
): string {
  const version = pictureVersion == null ? "" : `?v=${pictureVersion}`;
  return `/api/diagrams/${diagramId}/picture.${format}${version}`;
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
  readonly caption: string | null;
}

/** Reads a block's text: a diagram id line and an optional caption line, nothing else. */
export function parseDrawioBlock(body: string): DrawioBlock | null {
  const [first = "", second = "", ...rest] = body.split("\n").map((line) => line.trim());
  if (rest.some((line) => line !== "")) return null;
  if (second.length > MAX_DRAWIO_CAPTION_LENGTH || !isDiagramId(first)) return null;
  return { diagramId: first, caption: second === "" ? null : second };
}

/** A block's language, ignoring anything after the first word of the info string. */
export const isDrawioLanguage = (language: string | null | undefined) =>
  language?.trim().split(/\s+/, 1)[0] === DRAWIO_LANGUAGE;

/** A block's text for a diagram and caption. A caption is one line. */
export function drawioBlockBody(diagramId: string, caption: string | null = null): string {
  const line = caption?.replace(/\s+/g, " ").trim();
  return line ? `${diagramId}\n${line}` : diagramId;
}

/** A whole fenced block, ready to put in a tab's markdown. */
export const drawioBlock = (diagramId: string, caption: string | null = null) =>
  `\`\`\`${DRAWIO_LANGUAGE}\n${drawioBlockBody(diagramId, caption)}\n\`\`\``;

/**
 * The id of every diagram `markdown` links, in order, each once.
 * Blocks that do not parse are skipped.
 */
export function drawioDiagramIds(markdown: string): ReadonlyArray<string> {
  const ids = new Set<string>();
  for (const fence of findFences(markdown)) {
    if (fence.language !== DRAWIO_LANGUAGE) continue;
    const block = parseDrawioBlock(fence.body);
    if (block) ids.add(block.diagramId);
  }
  return [...ids];
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
      `${which}: the first line must be the id of a diagram, and only a caption of up to ` +
      `${MAX_DRAWIO_CAPTION_LENGTH} characters may follow it.`
    );
  }
  return null;
}
