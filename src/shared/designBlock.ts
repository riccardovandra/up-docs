// Designs in docs (S4). A doc shows a design from the library with a
// ```t3-design block: the design's id, then an optional `frame: <name>` line,
// then an optional caption line. The same shape as ```t3-drawio. The design
// itself (its .fig file and picture) is stored once, so one save updates every
// doc that shows it.
//
// v1 shows the design's saved picture (the editor's first page) whole. A
// `frame:` line is kept and shown as a note under the picture; per-frame
// pictures need the editor to export each frame on save (later).

import type { DocRole } from "./access.ts";
import { designPath, isDesignId, type DesignSummary } from "./design.ts";
import { findFences } from "./table.ts";

export const DESIGN_LANGUAGE = "t3-design";
export const MAX_DESIGN_CAPTION_LENGTH = 300;
export const MAX_DESIGN_FRAME_NAME_LENGTH = 200;

export interface DesignBlock {
  readonly designId: string;
  /** The frame the block names, or null for the whole picture. */
  readonly frame: string | null;
  readonly caption: string | null;
}

const FRAME_LINE = "frame:";

/** A frame name as one line: inner whitespace runs become one space. */
const frameNameLine = (name: string) => name.replace(/\s+/g, " ").trim();

/**
 * Reads a block's text: a design id line, an optional `frame: <name>` line,
 * then an optional caption line, nothing else. The line after the id is the
 * frame line whenever it starts with "frame:" (lower case). An empty `frame:`
 * means the whole picture, which is how a caption that itself starts with
 * "frame:" is written: after an empty frame line.
 */
export function parseDesignBlock(body: string): DesignBlock | null {
  const lines = body.split("\n").map((line) => line.trim());
  const first = lines[0] ?? "";
  if (!isDesignId(first)) return null;
  let at = 1;
  let frame: string | null = null;
  if (lines[at]?.startsWith(FRAME_LINE)) {
    const name = frameNameLine(lines[at]!.slice(FRAME_LINE.length));
    if (name.length > MAX_DESIGN_FRAME_NAME_LENGTH) return null;
    frame = name === "" ? null : name;
    at += 1;
  }
  const caption = lines[at] ?? "";
  if (lines.slice(at + 1).some((line) => line !== "")) return null;
  if (caption.length > MAX_DESIGN_CAPTION_LENGTH) return null;
  return { designId: first, frame, caption: caption === "" ? null : caption };
}

/** A block's language, ignoring anything after the first word of the info string. */
export const isDesignLanguage = (language: string | null | undefined) =>
  language?.trim().split(/\s+/, 1)[0] === DESIGN_LANGUAGE;

/**
 * A block's text for a design, a caption and a frame (null: the whole
 * picture), each one line. A caption that starts with "frame:" goes after an
 * empty frame line, so it is never read as one.
 */
export function designBlockBody(
  designId: string,
  caption: string | null = null,
  frame: string | null = null,
): string {
  const line = caption?.replace(/\s+/g, " ").trim() ?? "";
  const frameName = frame === null ? "" : frameNameLine(frame);
  const lines = [designId];
  if (frameName !== "") lines.push(`${FRAME_LINE} ${frameName}`);
  else if (line.startsWith(FRAME_LINE)) lines.push(FRAME_LINE);
  if (line !== "") lines.push(line);
  return lines.join("\n");
}

/** A whole fenced block, ready to put in a tab's markdown. */
export const designBlock = (
  designId: string,
  caption: string | null = null,
  frame: string | null = null,
) => `\`\`\`${DESIGN_LANGUAGE}\n${designBlockBody(designId, caption, frame)}\n\`\`\``;

/** Every block in `markdown` that parses, in order. */
export function designBlocks(markdown: string): ReadonlyArray<DesignBlock> {
  const blocks: Array<DesignBlock> = [];
  for (const fence of findFences(markdown)) {
    if (fence.language !== DESIGN_LANGUAGE) continue;
    const block = parseDesignBlock(fence.body);
    if (block) blocks.push(block);
  }
  return blocks;
}

/** The id of every design `markdown` shows, in order, each once. Blocks that do not parse are skipped. */
export function designIdsIn(markdown: string): ReadonlyArray<string> {
  return [...new Set(designBlocks(markdown).map((block) => block.designId))];
}

/**
 * Every block a write adds or changes must parse; null when all do, else the
 * reason. A block left byte-identical to `previous` is not re-checked, so
 * older content never blocks an unrelated edit. Whether the design exists is
 * not checked here: that needs the database.
 */
export function checkDesignsIn(markdown: string, previous?: string): string | null {
  const blocks = findFences(markdown).filter((fence) => fence.language === DESIGN_LANGUAGE);
  const unchanged = new Set(
    findFences(previous ?? "")
      .filter((fence) => fence.language === DESIGN_LANGUAGE)
      .map((fence) => fence.body),
  );
  for (const [index, fence] of blocks.entries()) {
    if (unchanged.has(fence.body) || parseDesignBlock(fence.body)) continue;
    const which = blocks.length === 1 ? "The t3-design block" : `t3-design block ${index + 1}`;
    return (
      `${which}: the first line must be the id of a design. Only an optional ` +
      `"frame: <frame name>" line and then a caption of up to ${MAX_DESIGN_CAPTION_LENGTH} ` +
      "characters may follow it."
    );
  }
  return null;
}

/** What a block says under its picture: the caption (or the design's title), then the frame. */
export function designCaption(block: DesignBlock, title: string | null): string | null {
  const lead = block.caption ?? title;
  const frame = block.frame === null ? null : `Frame: ${block.frame}`;
  const parts = [lead, frame].filter((part): part is string => part !== null && part !== "");
  return parts.length > 0 ? parts.join(" · ") : null;
}

// Where a design is shown, and re-reading designs by id.

/** A tab that shows a design through a ```t3-design block. */
export interface DesignUse {
  readonly docId: string;
  readonly docTitle: string;
  readonly tabId: string;
  readonly tabTitle: string;
}

/** Where a design is shown, as one person sees it. */
export interface DesignUsage {
  /** Tabs in docs the person can read. */
  readonly uses: ReadonlyArray<DesignUse>;
  /** How many more docs show it that the person is not on. */
  readonly otherDocs: number;
}

/** `GET /api/designs/:id/uses` (editors of the design). */
export const designUsesPath = (designId: string) => `/api/designs/${designId}/uses`;

/** How many designs one `GET /api/designs?ids=` may ask about. */
export const MAX_DESIGN_REFRESH_IDS = 20;

/** `GET /api/designs?ids=<id>,<id>`: designs as an open doc re-reads them. Never the file. */
export const designRefreshPath = (designIds: ReadonlyArray<string>) =>
  `/api/designs?ids=${designIds.map(encodeURIComponent).join(",")}`;

/** One design as a re-read returns it. One the person cannot see is left out. */
export interface DesignRefresh extends DesignSummary {
  readonly role: DocRole;
  readonly canEdit: boolean;
}

// Exports.

/** What an export needs to know about a design a doc shows. */
export type ExportDesign = Pick<DesignSummary, "id" | "title" | "pictureVersion">;

/** The designs a doc shows, by id. An id that is absent is a design that is gone or hidden. */
export type ExportDesigns = ReadonlyMap<string, ExportDesign>;

export const DESIGN_NOT_FOUND = "Design not found";

/** One block, ready to write in any format. */
export interface DesignExport {
  /** The design's title; null when the design is gone. */
  readonly title: string | null;
  /** The caption line under the picture (caption, then the frame), or null. */
  readonly caption: string | null;
  /** The picture's address; null when there is no picture to show. */
  readonly pictureUrl: string | null;
  /** The design's own page; null when the design is gone. */
  readonly pageUrl: string | null;
  /** What to say where the picture would be; null when there is a picture. */
  readonly note: string | null;
}

/** How one block comes out. `origin` makes the addresses absolute. */
export function designExport(
  block: DesignBlock,
  designs: ExportDesigns,
  origin: string,
): DesignExport {
  const design = designs.get(block.designId);
  const caption = block.caption === null && block.frame === null ? null : designCaption(block, null);
  if (!design) {
    return { title: null, caption, pictureUrl: null, pageUrl: null, note: `${DESIGN_NOT_FOUND}.` };
  }
  const pageUrl = `${origin}${designPath(design.id)}`;
  if (design.pictureVersion === null) {
    return {
      title: design.title,
      caption,
      pictureUrl: null,
      pageUrl,
      note: "Design: nothing has been saved in it yet.",
    };
  }
  return {
    title: design.title,
    caption,
    pictureUrl: `${origin}/api/designs/${design.id}/picture/${design.pictureVersion}`,
    pageUrl,
    note: null,
  };
}

const escapeLinkText = (text: string) => text.replace(/([\\[\]])/g, "\\$1");

/** One block as markdown: an image linked to the design, or the title and a note; then the caption. */
export function designExportMarkdown(out: DesignExport): string {
  const title = escapeLinkText(out.title ?? "");
  const lead =
    out.pictureUrl !== null
      ? `[![${title}](${out.pictureUrl})](${out.pageUrl})`
      : out.pageUrl !== null
        ? `[${title}](${out.pageUrl}) (${out.note})`
        : `*${out.note}*`;
  return out.caption ? `${lead}\n\n${out.caption}` : lead;
}

/** Every block in `markdown` as its picture (or its title and a note). A block that does not parse stays. */
export function designsToMarkdown(
  markdown: string,
  origin: string,
  designs: ExportDesigns,
): string {
  let result = "";
  let at = 0;
  for (const fence of findFences(markdown)) {
    if (fence.language !== DESIGN_LANGUAGE) continue;
    const block = parseDesignBlock(fence.body);
    if (!block) continue;
    result += `${markdown.slice(at, fence.start)}${designExportMarkdown(designExport(block, designs, origin))}`;
    at = fence.end;
  }
  return result + markdown.slice(at);
}
