// The diagram view's page tabs, without React: which page the address asks
// for, the address for a page, the keys that switch pages, and which comment
// threads belong to a page.

import type { DiagramThread } from "../../shared/diagramComments.ts";
import { pageIndexOf } from "../../shared/drawio.ts";

/** The query parameter that names the shown page: its number, counted from 1. */
export const PAGE_PARAM = "page";

/** The keys that switch pages, as the tab bar's tooltip says them. */
export const PAGE_KEYS_HINT = "PageUp / PageDown switch pages";

/**
 * The page index (from 0) an address's query asks for. `?page=2` is the
 * second page; a page's name works too. Anything else, or a number past the
 * last page, is the first page.
 */
export function pageFromSearch(search: string, names: ReadonlyArray<string | null>): number {
  const asked = new URLSearchParams(search).get(PAGE_PARAM)?.trim();
  if (!asked) return 0;
  if (/^\d+$/.test(asked)) {
    const number = Number(asked);
    return number >= 1 && number <= names.length ? number - 1 : 0;
  }
  return Math.max(0, pageIndexOf(names, asked));
}

/** The query for showing page `index`, other parameters kept. The first page has no `page`. */
export function searchForPage(search: string, index: number): string {
  const query = new URLSearchParams(search);
  if (index > 0) query.set(PAGE_PARAM, String(index + 1));
  else query.delete(PAGE_PARAM);
  const text = query.toString();
  return text ? `?${text}` : "";
}

/** What of a keydown decides whether it switches pages. */
export interface PageKey {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly defaultPrevented: boolean;
  /** Where the key was pressed. */
  readonly target: EventTarget | null;
}

/** Whether keys pressed in `target` are typing: a field, a text area, or editable text. */
function isTyping(target: EventTarget | null): boolean {
  const closest = (target as Partial<Pick<Element, "closest">> | null)?.closest;
  if (typeof closest !== "function") return false;
  return (
    closest.call(target, "input, textarea, select, [contenteditable]:not([contenteditable='false'])") !==
    null
  );
}

/**
 * The page step a key asks for: -1 for PageUp, 1 for PageDown, 0 for anything
 * else. Keys with a modifier, keys something else already handled, and keys
 * typed into a field (a review comment, a dialog) do not switch pages.
 * Alt+arrows are left alone: they are Back and Forward in most browsers.
 */
export function pageStep(event: PageKey): -1 | 0 | 1 {
  if (event.defaultPrevented) return 0;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return 0;
  if (event.key !== "PageUp" && event.key !== "PageDown") return 0;
  if (isTyping(event.target)) return 0;
  return event.key === "PageUp" ? -1 : 1;
}

/** The page after stepping from `index`, held to the pages there are. */
export const steppedPage = (index: number, step: number, count: number) =>
  Math.min(Math.max(0, index + step), Math.max(0, count - 1));

/** The threads pinned to one page. */
export const threadsOnPage = (
  threads: ReadonlyArray<DiagramThread>,
  page: string | null,
): ReadonlyArray<DiagramThread> => threads.filter((thread) => thread.anchor.page === page);

/** How many open threads each page has, in page order. */
export const openCountsByPage = (
  threads: ReadonlyArray<DiagramThread>,
  names: ReadonlyArray<string | null>,
): ReadonlyArray<number> =>
  names.map(
    (name) =>
      threadsOnPage(threads, name).filter((thread) => thread.resolvedAt === null).length,
  );
