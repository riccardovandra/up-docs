// Public mode: the page a public link opens (`/p/<token>`). Set once, before
// the editor mounts, by PublicDocPage; the page never turns into the signed-in
// app in the same load. While it is on, every asset the editor shows goes
// through the link's own routes, and only the shared doc's assets load.

import type { DiagramSummary } from "../shared/drawio.ts";
import { publicApiBase } from "../shared/publicLinks.ts";

interface PublicShare {
  readonly token: string;
  readonly docId: string;
  /** The linked diagrams the link may show, by id. */
  readonly diagrams: ReadonlyMap<string, DiagramSummary>;
  /** Shows another tab of the shared doc. */
  readonly openTab: (tabId: string) => void;
}

let current: PublicShare | null = null;

export function setPublicShare(share: PublicShare | null): void {
  current = share;
}

export const publicShare = (): PublicShare | null => current;

const IMAGE = /^\/api\/images\/([A-Za-z0-9_-]{1,64})\/([^/?#]+)$/;
const VIDEO = /^\/api\/videos\/([A-Za-z0-9_-]{1,64})\/([^/?#]+)$/;
const PICTURE = /^\/api\/diagrams\/([^/?#]+)\/(picture\.[a-z]+)(\?[^#]*)?$/;

/**
 * Where the page should load an asset from. Outside public mode, `src` as is.
 * In public mode, the shared doc's uploads and allowed diagram pictures move
 * under the link's routes; anything else is null, so it is not loaded.
 */
export function assetSrc(src: string): string | null {
  const share = current;
  if (!share) return src;
  const base = publicApiBase(share.token);
  const image = IMAGE.exec(src);
  if (image) return image[1] === share.docId ? `${base}/images/${image[2]}` : null;
  const video = VIDEO.exec(src);
  if (video) return video[1] === share.docId ? `${base}/videos/${video[2]}` : null;
  const picture = PICTURE.exec(src);
  if (picture && share.diagrams.has(picture[1]!)) {
    return `${base}/diagrams/${picture[1]}/${picture[2]}${picture[3] ?? ""}`;
  }
  return null;
}

/**
 * Follows a link to a page of the app from a public page. Another tab of the
 * shared doc opens in place; anything else is a full page load, since the
 * app behind it asks the visitor to sign in. Returns false outside public mode.
 */
export function followPublicLink(appPath: string, url: string): boolean {
  const share = current;
  if (!share) return false;
  const [first, docId, tabId] = appPath.split("/").filter(Boolean);
  if (first === "d" && docId === share.docId && tabId) share.openTab(tabId);
  else window.location.assign(url);
  return true;
}
