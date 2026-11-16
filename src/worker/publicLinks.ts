// Public links. The token is the only credential: it opens one doc, every
// tab, read-only. Everything here runs before the API's sign-in check, so it
// never reads a cookie or bearer token, and every route resolves the doc from
// the token on the server; no route takes a doc id from the visitor.

import { isDiagramId, isDiagramPictureFormat } from "../shared/drawio.ts";
import { imageFileType } from "../shared/images.ts";
import { matchEmbed } from "../shared/embeds.ts";
import {
  isPublicToken,
  publicDocPath,
  type PublicDoc,
  type PublicLink,
} from "../shared/publicLinks.ts";
import { videoFileType } from "../shared/video.ts";
import { randomToken } from "./crypto.ts";
import * as Diagrams from "./diagrams.ts";
import * as Docs from "./docs.ts";
import * as Embeds from "./embeds.ts";
import * as Images from "./images.ts";
import type { ImageStore } from "./images.ts";
import * as Videos from "./videos.ts";
import type { VideoStore } from "./videos.ts";

/** Headers every public response carries: never cached, never indexed, and the link never leaks as a Referer. */
export const PUBLIC_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
};

export async function getPublicLink(
  db: D1Database,
  docId: string,
  publicOrigin: string,
): Promise<PublicLink | null> {
  const row = await db
    .prepare("SELECT token, created_at FROM doc_public_links WHERE doc_id = ?")
    .bind(docId)
    .first<{ token: string; created_at: number }>();
  return row ? toLink(row.token, row.created_at, publicOrigin) : null;
}

/** Turns the link on with a new token; an earlier link for the doc stops working. */
export async function createPublicLink(
  db: D1Database,
  input: {
    readonly docId: string;
    readonly userId: string;
    readonly now: number;
    readonly publicOrigin: string;
  },
): Promise<PublicLink> {
  const token = randomToken(32);
  await db
    .prepare(
      `INSERT INTO doc_public_links (doc_id, token, created_by, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (doc_id) DO UPDATE SET token = excluded.token,
         created_by = excluded.created_by, created_at = excluded.created_at`,
    )
    .bind(input.docId, token, input.userId, input.now)
    .run();
  return toLink(token, input.now, input.publicOrigin);
}

export async function deletePublicLink(db: D1Database, docId: string): Promise<void> {
  await db.prepare("DELETE FROM doc_public_links WHERE doc_id = ?").bind(docId).run();
}

const toLink = (token: string, createdAt: number, publicOrigin: string): PublicLink => ({
  token,
  url: `${publicOrigin}${publicDocPath(token)}`,
  createdAt,
});

/** The doc a token opens, or null for a malformed, unknown or revoked token. */
export async function resolvePublicToken(db: D1Database, token: string): Promise<string | null> {
  if (!isPublicToken(token)) return null;
  const row = await db
    .prepare("SELECT doc_id FROM doc_public_links WHERE token = ?")
    .bind(token)
    .first<{ doc_id: string }>();
  return row?.doc_id ?? null;
}

/** What a visitor sees: an allowlist of fields, never the owner, members or comments. */
export async function publicDoc(db: D1Database, docId: string): Promise<PublicDoc> {
  const { doc, tabs } = await Docs.getDoc(db, docId);
  const diagrams = await Diagrams.publicDocDiagrams(
    db,
    docId,
    tabs.map((tab) => tab.markdown),
  );
  return {
    docId: doc.id,
    title: doc.title,
    updatedAt: doc.updatedAt,
    tabs: tabs.map((tab) => ({
      id: tab.id,
      docId: tab.docId,
      parentTabId: tab.parentTabId,
      position: tab.position,
      title: tab.title,
      markdown: tab.markdown,
      version: tab.version,
      updatedAt: tab.updatedAt,
    })),
    diagrams: diagrams.map((diagram) => ({
      ...diagram,
      projectId: null,
      createdBy: null,
    })),
  };
}

export interface PublicDeps {
  readonly db: D1Database;
  readonly images: ImageStore;
  readonly videos: VideoStore | null;
}

const withPublicHeaders = (response: Response): Response => {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(PUBLIC_HEADERS)) headers.set(name, value);
  headers.delete("Set-Cookie");
  return new Response(response.body, { status: response.status, headers });
};

const publicJson = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: PUBLIC_HEADERS });

const notFound = () => publicJson({ error: "not_found" }, 404);

/**
 * `/api/public/:token[/...]`, GET and HEAD only:
 * - `` the doc (PublicDoc)
 * - `images/:file`, `videos/:file` the doc's own uploads
 * - `diagrams/:id/picture.svg|png[?page=n]` a diagram the doc may show
 * - `embeds?url=` the doc's saved copy of a post; never fetched from the web here
 * Anything else, and any unknown or revoked token, is the same 404.
 */
export async function handlePublic(
  request: Request,
  segments: ReadonlyArray<string>,
  deps: PublicDeps,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return withPublicHeaders(
      Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "GET, HEAD" } }),
    );
  }
  const [token, kind, first, second, ...rest] = segments;
  if (!token || rest.length > 0) return notFound();
  const docId = await resolvePublicToken(deps.db, token);
  if (!docId) return notFound();
  try {
    const response = await route(request, { docId, kind, first, second }, deps);
    return response ? withPublicHeaders(response) : notFound();
  } catch (cause) {
    if (cause instanceof Docs.NotFoundError) return notFound();
    throw cause;
  }
}

async function route(
  request: Request,
  at: {
    readonly docId: string;
    readonly kind: string | undefined;
    readonly first: string | undefined;
    readonly second: string | undefined;
  },
  deps: PublicDeps,
): Promise<Response | null> {
  const { docId, kind, first, second } = at;
  if (kind === undefined) return Response.json(await publicDoc(deps.db, docId));

  if (kind === "images" && first && second === undefined) {
    if (imageFileType(first) === null) return null;
    return Images.imageResponse(deps.images, { docId, file: first });
  }

  if (kind === "videos" && first && second === undefined) {
    if (!deps.videos || videoFileType(first) === null) return null;
    return Videos.videoResponse(deps.videos, { docId, file: first, request });
  }

  if (kind === "diagrams" && first && second) {
    const format = /^picture\.([a-z]+)$/.exec(second)?.[1];
    if (!isDiagramId(first) || !isDiagramPictureFormat(format)) return null;
    const page = new URL(request.url).searchParams.get("page");
    const pageIndex = page === null ? 0 : /^(0|[1-9]\d{0,3})$/.test(page) ? Number(page) : -1;
    if (pageIndex < 0) return null;
    const { tabs } = await Docs.getDoc(deps.db, docId);
    const allowed = await Diagrams.publicDocDiagrams(
      deps.db,
      docId,
      tabs.map((tab) => tab.markdown),
    );
    const diagram = allowed.find((each) => each.id === first);
    if (!diagram) return null;
    return Diagrams.diagramPictureResponse(deps.images, { diagram, format, request, pageIndex });
  }

  if (kind === "embeds" && first === undefined) {
    const url = new URL(request.url).searchParams.get("url") ?? "";
    const target = matchEmbed(url);
    if (!target) return null;
    const snapshot = await Embeds.savedEmbed(deps.db, docId, target.canonicalUrl);
    return snapshot ? Response.json({ embed: snapshot }) : null;
  }

  return null;
}
