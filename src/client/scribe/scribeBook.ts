// Turns a doc into the book the Send to Scribe extension emails to a Kindle:
// one chapter per tab in reading order, the first tab first. The extension
// cleans each chapter's HTML, converts images Kindle cannot show, adds the
// linked contents page and builds the EPUB. This half is pure, so it is tested
// without a browser; scribeAssets.ts fetches images and draws diagrams.

import { Marked, type Tokens } from "marked";

import { orderTabs } from "../doc/tabTree.ts";
import { embedsToLinks } from "../../shared/embeds.ts";
import { splitImageAlt } from "../../shared/images.ts";
import type { Tab } from "../../shared/protocol.ts";
import { richTablesToGfm } from "../../shared/table.ts";
import { videosToLinks } from "../../shared/video.ts";
import { widgetInfo } from "../../shared/widget/fence.ts";

export interface ScribeChapter {
  readonly title: string;
  /** HTML for the chapter body; the extension adds the title heading. */
  readonly html: string;
  /** The tab in UP Docs, linked at the end of the chapter. */
  readonly sourceUrl: string;
  /** Depth in the tab tree, so the contents page can indent sub-tabs. */
  readonly depth: number;
}

export interface ScribeImage {
  /** The image's URL in the chapter HTML. */
  readonly url: string;
  readonly mediaType: string;
  readonly base64: string;
}

/** What the extension receives. Images it is not given, it fetches itself. */
export interface ScribeBook {
  readonly title: string;
  readonly author: string;
  readonly language: string;
  readonly chapters: ReadonlyArray<ScribeChapter>;
  readonly images: ReadonlyArray<ScribeImage>;
}

export interface DiagramRequest {
  /** The placeholder URL the chapter HTML uses for this diagram. */
  readonly url: string;
  readonly kind: "mermaid" | "widget";
  readonly source: string;
}

export interface BookDraft {
  readonly book: Omit<ScribeBook, "images">;
  readonly diagrams: ReadonlyArray<DiagramRequest>;
  /** Images on this origin, which need the reader's session to fetch. */
  readonly sameOriginImages: ReadonlyArray<string>;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const normalizeTitle = (text: string): string => text.trim().toLowerCase();

/** Agents often open a tab with its own title; the chapter heading already says it. */
export function dropTitleHeading(markdown: string, title: string): string {
  const [firstLine = "", ...rest] = markdown.replace(/^\s+/, "").split("\n");
  const match = /^#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(firstLine);
  if (match && normalizeTitle(match[1] ?? "") === normalizeTitle(title)) return rest.join("\n");
  return markdown;
}

function absoluteUrl(href: string, origin: string): string | null {
  try {
    const url = new URL(href, origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Builds the chapters. `tabs` are the doc's tabs, or the one tab to send;
 * `docUrl(tabId)` is where a tab lives.
 */
export function draftScribeBook(input: {
  readonly title: string;
  readonly author: string;
  readonly tabs: ReadonlyArray<Tab>;
  readonly origin: string;
  readonly tabUrl: (tabId: string) => string;
}): BookDraft {
  const { origin } = input;
  const diagrams: Array<DiagramRequest> = [];
  const sameOrigin = new Set<string>();

  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      image({ href, text }: Tokens.Image) {
        const src = absoluteUrl(href, origin);
        const { alt } = splitImageAlt(text);
        if (!src) return escapeHtml(alt);
        if (new URL(src).origin === new URL(origin).origin) sameOrigin.add(src);
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`;
      },
      code({ text, lang }: Tokens.Code) {
        const info = (lang ?? "").trim();
        const kind =
          info.split(/\s/, 1)[0] === "mermaid" ? "mermaid" : widgetInfo(info) ? "widget" : null;
        if (!kind) return false;
        const url = `${origin}/scribe-diagram/${diagrams.length + 1}.svg`;
        diagrams.push({ url, kind, source: text });
        return `<figure><img src="${escapeHtml(url)}" alt="Diagram"></figure>`;
      },
      // The extension drops form inputs, so a task's state is kept as text.
      checkbox({ checked }: Tokens.Checkbox) {
        return checked ? "☑ " : "☐ ";
      },
    },
  });

  // A single tab is a book of one chapter, wherever it sits in the tree.
  const ordered =
    input.tabs.length === 1 ? [{ tab: input.tabs[0]!, depth: 0 }] : orderTabs(input.tabs);
  const chapters = ordered.map(({ tab, depth }) => {
    // Rich tables read as plain tables; videos and embeds as links to them.
    const markdown = embedsToLinks(videosToLinks(richTablesToGfm(tab.markdown), origin));
    const html = marked.parse(dropTitleHeading(markdown, tab.title), { async: false });
    return { title: tab.title, html, sourceUrl: input.tabUrl(tab.id), depth };
  });

  return {
    book: { title: input.title, author: input.author, language: "en", chapters },
    diagrams,
    sameOriginImages: [...sameOrigin],
  };
}
