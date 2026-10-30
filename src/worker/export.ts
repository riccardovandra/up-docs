// Markdown export: one tab, or a whole doc with its tabs in reading order.

// Shared with the tab rail so export reads the doc in the order the user sees it.
// It is pure and imports only shared types, so the worker can use it.
import { orderTabs } from "../client/doc/tabTree.ts";
import type { DocWithTabs, Tab } from "../shared/protocol.ts";
import { richTablesToGfm } from "../shared/table.ts";
import { videosToLinks } from "../shared/video.ts";

const MAX_HEADING_LEVEL = 6;

const normalizeTitle = (text: string): string => text.trim().toLowerCase();

/** Agents often open a tab with its own title as a heading; repeating it reads as a stutter. */
function startsWithTitle(body: string, title: string): boolean {
  const firstLine = body.split("\n", 1)[0] ?? "";
  const match = /^#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(firstLine);
  return match !== null && normalizeTitle(match[1] ?? "") === normalizeTitle(title);
}

function section(tab: Tab, depth: number, origin: string | null): string {
  const level = Math.min(depth + 1, MAX_HEADING_LEVEL);
  const heading = `${"#".repeat(level)} ${tab.title}`;
  // Downloads are for reading, so rich tables become GFM tables and videos become links.
  const body = (
    origin === null ? tab.markdown : videosToLinks(richTablesToGfm(tab.markdown), origin)
  ).trim();
  if (body && startsWithTitle(body, tab.title)) return `${body}\n`;
  return body ? `${heading}\n\n${body}\n` : `${heading}\n`;
}

/** `origin` makes links to uploaded videos absolute. */
export const tabMarkdown = (tab: Tab, origin = ""): string => section(tab, 0, origin);

/** Every tab as a section whose heading level follows its depth in the tree. */
export const docMarkdown = (doc: DocWithTabs, origin = ""): string =>
  orderTabs(doc.tabs)
    .map(({ tab, depth }) => section(tab, depth, origin))
    .join("\n");

/**
 * The same sections as `tabMarkdown` and `docMarkdown`, with rich tables and
 * videos left as fences for writers that render them natively, such as Word.
 */
export const tabSourceMarkdown = (tab: Tab): string => section(tab, 0, null);

export const docSourceMarkdown = (doc: DocWithTabs): string =>
  orderTabs(doc.tabs)
    .map(({ tab, depth }) => section(tab, depth, null))
    .join("\n");

/** An ASCII file stem, so it is safe in a quoted Content-Disposition filename. */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 80)
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

export const markdownResponse = (markdown: string, title: string): Response =>
  new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slugify(title)}.md"`,
      "Cache-Control": "no-store",
    },
  });
