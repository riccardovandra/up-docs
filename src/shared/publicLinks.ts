// Public links: anyone with `/p/<token>` reads one doc, every tab, read-only
// and without signing in. Shared by the Worker's public routes and the SPA.

import type { DiagramSummary } from "./drawio.ts";
import type { Tab } from "./protocol.ts";

/** A token as `randomToken(32)` issues it: 32 bytes, base64url, no padding. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const isPublicToken = (value: string): boolean => TOKEN.test(value);

/** The app page a public link opens. */
export const publicDocPath = (token: string) => `/p/${token}`;

/** Where the public API for one link lives. */
export const publicApiBase = (token: string) => `/api/public/${token}`;

/** `GET /api/docs/:id/public-link`: the doc's link, or null when it has none. */
export interface PublicLink {
  readonly token: string;
  readonly url: string;
  readonly createdAt: number;
}

/**
 * `GET /api/public/:token`: what a visitor may see, and nothing more. No
 * owner, members, project, comments or threads. `diagrams` are the linked
 * diagrams the link may show, without their source.
 */
export interface PublicDoc {
  readonly docId: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly tabs: ReadonlyArray<Tab>;
  readonly diagrams: ReadonlyArray<DiagramSummary>;
}
