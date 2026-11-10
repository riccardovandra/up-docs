// How a linked Draw.io diagram leaves the app. An export cannot show the live
// block, so a ```t3-drawio block comes out as the diagram's picture with its
// caption, the way an image does. A diagram with no picture yet comes out as
// its title and a short note, and a deleted one as "Diagram not found".

import {
  DRAWIO_LANGUAGE,
  diagramPath,
  diagramPictureUrl,
  parseDrawioBlock,
  type DiagramPictureFormat,
  type DiagramSummary,
  type DrawioBlock,
} from "./drawio.ts";
import { findFences } from "./table.ts";

/** What an export needs to know about a linked diagram. */
export type ExportDiagram = Pick<DiagramSummary, "id" | "title" | "pictureVersion" | "hasSource">;

/** The diagrams a doc links, by id. An id that is absent is a diagram that is gone. */
export type ExportDiagrams = ReadonlyMap<string, ExportDiagram>;

export const DIAGRAM_NOT_FOUND = "Diagram not found";

/** One block, ready to write in any format. */
export interface DrawioExport {
  /** The diagram's title; null when the diagram is gone. */
  readonly title: string | null;
  readonly caption: string | null;
  /** The picture's address; null when there is no picture to show. */
  readonly pictureUrl: string | null;
  /** The diagram's own page; null when the diagram is gone. */
  readonly pageUrl: string | null;
  /** What to say where the picture would be; null when there is a picture. */
  readonly note: string | null;
}

/**
 * How one block comes out. `origin` makes the addresses absolute. A picture
 * that is behind its source is still used: an older picture reads better than
 * none.
 */
export function drawioExport(
  block: DrawioBlock,
  diagrams: ExportDiagrams,
  origin: string,
  format: DiagramPictureFormat = "svg",
): DrawioExport {
  const diagram = diagrams.get(block.diagramId);
  if (!diagram) {
    return {
      title: null,
      caption: block.caption,
      pictureUrl: null,
      pageUrl: null,
      note: `${DIAGRAM_NOT_FOUND}.`,
    };
  }
  const pageUrl = `${origin}${diagramPath(diagram.id)}`;
  if (diagram.pictureVersion === null) {
    return {
      title: diagram.title,
      caption: block.caption,
      pictureUrl: null,
      pageUrl,
      note: diagram.hasSource
        ? "Diagram: its picture has not been drawn yet."
        : "Diagram: nothing has been drawn in it yet.",
    };
  }
  return {
    title: diagram.title,
    caption: block.caption,
    // Without a version the address always serves the latest picture.
    pictureUrl: `${origin}${diagramPictureUrl(diagram.id, format)}`,
    pageUrl,
    note: null,
  };
}

const escapeLinkText = (text: string) => text.replace(/([\\[\]])/g, "\\$1");

/** One block as markdown: an image, or the title and the note, then the caption. */
export function drawioExportMarkdown(out: DrawioExport): string {
  const title = escapeLinkText(out.title ?? "");
  const lead =
    out.pictureUrl !== null
      ? `![${title}](${out.pictureUrl})`
      : out.pageUrl !== null
        ? `[${title}](${out.pageUrl}) (${out.note})`
        : `*${out.note}*`;
  return out.caption ? `${lead}\n\n${out.caption}` : lead;
}

/**
 * Every block in `markdown` as an image (or its title and a note), for
 * downloads and books. A block that does not parse is left as it is.
 */
export function drawioToMarkdown(
  markdown: string,
  origin: string,
  diagrams: ExportDiagrams,
  format: DiagramPictureFormat = "svg",
): string {
  let result = "";
  let at = 0;
  for (const fence of findFences(markdown)) {
    if (fence.language !== DRAWIO_LANGUAGE) continue;
    const block = parseDrawioBlock(fence.body);
    if (!block) continue;
    const out = drawioExportMarkdown(drawioExport(block, diagrams, origin, format));
    result += `${markdown.slice(at, fence.start)}${out}`;
    at = fence.end;
  }
  return result + markdown.slice(at);
}
