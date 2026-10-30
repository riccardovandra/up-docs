import { isSafeUrl } from "../shared/table.ts";
import { navigate, parseRoute } from "./router.ts";

export interface DocLink {
  /** The absolute address, for opening outside the app. */
  readonly url: string;
  /** The app path that shows it in place; null when it lies outside this app. */
  readonly appPath: string | null;
}

/**
 * Where a link in a doc leads, from the page at `here`. Agents write absolute
 * tab URLs, so an app path counts only on this app's origin. A link to the doc
 * on screen stays in place from any origin: doc ids are unique, and an instance
 * can move or answer on a second domain. Returns null for an address that is
 * not a web or mail link.
 */
export function resolveDocLink(
  href: string,
  here: { readonly origin: string; readonly pathname: string },
): DocLink | null {
  const page = `${here.origin}${here.pathname}`;
  if (!URL.canParse(href, page)) return null;
  const url = new URL(href, page);
  if (!isSafeUrl(url.href)) return null;
  const route = parseRoute(url.pathname);
  const current = parseRoute(here.pathname);
  const sameDoc = route.name === "doc" && current.name === "doc" && route.docId === current.docId;
  const appRoute =
    url.origin === here.origin && (route.name !== "library" || url.pathname === "/");
  return { url: url.href, appPath: sameDoc || appRoute ? url.pathname : null };
}

/**
 * Follows the link a click landed on, and says whether it did. A drag that
 * selected text, Shift and Alt are left to the caller, so link text stays
 * selectable and editable. Cmd/Ctrl+click opens a new tab. The panel's iframe
 * allows popups, so `window.open` works inside T3 Code too. A click reaches the
 * rich table first and then the editor, so one already handled is skipped.
 */
export function followClickedLink(event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.altKey || event.shiftKey) return false;
  const anchor = (event.target as Element).closest?.("a[href]");
  if (!anchor) return false;
  if (window.getSelection()?.isCollapsed === false) return false;
  event.preventDefault();
  const link = resolveDocLink(anchor.getAttribute("href") ?? "", window.location);
  if (!link) return true;
  if (link.appPath !== null && !event.metaKey && !event.ctrlKey) navigate(link.appPath);
  else window.open(link.url, "_blank", "noopener,noreferrer");
  return true;
}
