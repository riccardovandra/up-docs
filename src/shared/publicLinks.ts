// Public links: anyone with `/p/<token>` sees one item, read-only and without
// signing in. Every kind of item shares the same link: a doc (every tab), a
// Draw.io diagram (its pictures), a page (its HTML, sandboxed) or a sheet.
// Shared by the Worker's public routes and the SPA.

import type { DiagramSummary } from "./drawio.ts";
import type { Tab } from "./protocol.ts";

/** A token as `randomToken(32)` issues it: 32 bytes, base64url, no padding. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const isPublicToken = (value: string): boolean => TOKEN.test(value);

/** What a public link can open. */
export type PublicKind = "doc" | "diagram" | "page" | "sheet";

/** The app page a public link opens. */
export const publicDocPath = (token: string) => `/p/${token}`;

/** Where the public API for one link lives. */
export const publicApiBase = (token: string) => `/api/public/${token}`;

/** The REST collection an item kind lives under: `/api/<collection>/:id/public-link`. */
export const PUBLIC_COLLECTIONS: Readonly<Record<PublicKind, string>> = {
  doc: "docs",
  diagram: "diagrams",
  page: "pages",
  sheet: "sheets",
};

/** `GET /api/<collection>/:id/public-link`: the item's link, or null when it has none. */
export interface PublicLink {
  readonly token: string;
  readonly url: string;
  readonly createdAt: number;
}

/**
 * `GET /api/public/:token` for a doc: what a visitor may see, and nothing
 * more. No owner, members, project, comments or threads. `diagrams` are the
 * linked diagrams the link may show, without their source.
 */
export interface PublicDoc {
  readonly kind: "doc";
  readonly docId: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly tabs: ReadonlyArray<Tab>;
  readonly diagrams: ReadonlyArray<DiagramSummary>;
}

/** `GET /api/public/:token` for a Draw.io diagram: its pictures, never its source. */
export interface PublicDiagram {
  readonly kind: "diagram";
  readonly title: string;
  readonly updatedAt: number;
  readonly diagram: DiagramSummary;
}

/** `GET /api/public/:token` for a page: the latest version, served at `${base}/content`. */
export interface PublicPage {
  readonly kind: "page";
  readonly title: string;
  readonly updatedAt: number;
  readonly version: number;
}

export type PublicItem = PublicDoc | PublicDiagram | PublicPage;

/** A page's HTML under a link: always the latest version, sandboxed, into a frame only. */
export const publicPageContentPath = (token: string) => `${publicApiBase(token)}/content`;
