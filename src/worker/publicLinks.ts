// Public links. The token is the only credential: it opens one item (a doc,
// a diagram or a page), read-only. Everything here runs before the API's
// sign-in check, so it never reads a cookie or bearer token, and every route
// resolves the item from the token on the server; no route takes an item id
// from the visitor without checking it against the token's item.

import { isDiagramId, isDiagramPictureFormat, type DiagramSummary } from "../shared/drawio.ts";
import { imageFileType } from "../shared/images.ts";
import { matchEmbed } from "../shared/embeds.ts";
import {
  isPublicToken,
  publicDocPath,
  type PublicDiagram,
  type PublicDoc,
  type PublicKind,
  type PublicLink,
  type PublicPage,
} from "../shared/publicLinks.ts";
import { videoFileType } from "../shared/video.ts";
import { randomToken } from "./crypto.ts";
import * as Diagrams from "./diagrams.ts";
import * as Docs from "./docs.ts";
import * as Embeds from "./embeds.ts";
import * as HtmlPages from "./htmlPages.ts";
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

/** The item a public link belongs to. */
export interface PublicTarget {
  readonly kind: PublicKind;
  readonly id: string;
}

/** The column of `public_links` that holds a kind's item id. */
const COLUMNS: Readonly<Record<PublicKind, string>> = {
  doc: "doc_id",
  diagram: "diagram_id",
  page: "page_id",
  sheet: "sheet_id",
};

export async function getPublicLink(
  db: D1Database,
  target: PublicTarget,
  publicOrigin: string,
): Promise<PublicLink | null> {
  const row = await db
    .prepare(`SELECT token, created_at FROM public_links WHERE ${COLUMNS[target.kind]} = ?`)
    .bind(target.id)
    .first<{ token: string; created_at: number }>();
  return row ? toLink(row.token, row.created_at, publicOrigin) : null;
}

/** Turns the link on with a new token; an earlier link for the item stops working. */
export async function createPublicLink(
  db: D1Database,
  input: {
    readonly target: PublicTarget;
    readonly userId: string;
    readonly now: number;
    readonly publicOrigin: string;
  },
): Promise<PublicLink> {
  const token = randomToken(32);
  const { target } = input;
  const column = COLUMNS[target.kind];
  await db.batch([
    db.prepare(`DELETE FROM public_links WHERE ${column} = ?`).bind(target.id),
    db
      .prepare(
        `INSERT INTO public_links (token, kind, ${column}, created_by, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(token, target.kind, target.id, input.userId, input.now),
    ...legacyDocLink(db, target, { token, userId: input.userId, now: input.now }),
  ]);
  return toLink(token, input.now, input.publicOrigin);
}

export async function deletePublicLink(db: D1Database, target: PublicTarget): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM public_links WHERE ${COLUMNS[target.kind]} = ?`).bind(target.id),
    ...legacyDocLink(db, target, null),
  ]);
}

/**
 * Keeps doc_public_links (the table before 0026) the same as public_links for
 * docs, so a rollback to a Worker that still reads it never revives a link
 * that was turned off or reset. Drop this with that table.
 */
const legacyDocLink = (
  db: D1Database,
  target: PublicTarget,
  link: { readonly token: string; readonly userId: string; readonly now: number } | null,
): Array<D1PreparedStatement> => {
  if (target.kind !== "doc") return [];
  const clear = db.prepare("DELETE FROM doc_public_links WHERE doc_id = ?").bind(target.id);
  if (!link) return [clear];
  return [
    clear,
    db
      .prepare(
        "INSERT INTO doc_public_links (doc_id, token, created_by, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(target.id, link.token, link.userId, link.now),
  ];
};

const toLink = (token: string, createdAt: number, publicOrigin: string): PublicLink => ({
  token,
  url: `${publicOrigin}${publicDocPath(token)}`,
  createdAt,
});

/** The item a token opens, or null for a malformed, unknown or revoked token. */
export async function resolvePublicToken(
  db: D1Database,
  token: string,
): Promise<PublicTarget | null> {
  if (!isPublicToken(token)) return null;
  const row = await db
    .prepare(
      "SELECT kind, doc_id, diagram_id, page_id, sheet_id FROM public_links WHERE token = ?",
    )
    .bind(token)
    .first<{
      kind: PublicKind;
      doc_id: string | null;
      diagram_id: string | null;
      page_id: string | null;
      sheet_id: string | null;
    }>();
  if (!row) return null;
  const id = { doc: row.doc_id, diagram: row.diagram_id, page: row.page_id, sheet: row.sheet_id }[
    row.kind
  ];
  return id ? { kind: row.kind, id } : null;
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
    kind: "doc",
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
    diagrams: diagrams.map(anonymous),
  };
}

/** A diagram as a visitor sees it: no project, no creator, no source. */
const anonymous = (diagram: DiagramSummary): DiagramSummary => ({
  ...Diagrams.diagramSummary(diagram),
  projectId: null,
  createdBy: null,
});

/** A linked diagram: its title and what its pictures need. */
export async function publicDiagram(db: D1Database, diagramId: string): Promise<PublicDiagram> {
  const diagram = await Diagrams.getDiagram(db, diagramId);
  return {
    kind: "diagram",
    title: diagram.title,
    updatedAt: diagram.updatedAt,
    diagram: anonymous(diagram),
  };
}

/** A linked page: its title and latest version, never who made it or where it lives. */
export async function publicPage(db: D1Database, pageId: string): Promise<PublicPage> {
  const page = await HtmlPages.getPage(db, pageId);
  return { kind: "page", title: page.title, updatedAt: page.updatedAt, version: page.version };
}

export interface PublicDeps {
  readonly db: D1Database;
  readonly images: ImageStore;
  readonly videos: VideoStore | null;
  /** Origins allowed to frame the app (FRAME_ANCESTORS); a page's HTML may sit inside them. */
  readonly frameAncestors: ReadonlyArray<string>;
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
 * `/api/public/:token[/...]`, GET and HEAD only. `` is the item itself
 * (PublicDoc, PublicDiagram or PublicPage); what else a link serves depends
 * on what it opens:
 * - a doc: `images/:file`, `videos/:file` (its own uploads),
 *   `diagrams/:id/picture.svg|png[?page=n]` (a diagram the doc may show) and
 *   `embeds?url=` (its saved copy of a post; never fetched from the web here)
 * - a diagram: `diagrams/:id/picture.svg|png[?page=n]`, its own id only
 * - a page: `content`, its latest version's HTML, sandboxed, into a frame only
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
  const target = await resolvePublicToken(deps.db, token);
  if (!target) return notFound();
  try {
    const at = { kind, first, second };
    const response =
      target.kind === "doc"
        ? await routeDoc(request, { docId: target.id, ...at }, deps)
        : target.kind === "diagram"
          ? await routeDiagram(request, { diagramId: target.id, ...at }, deps)
          : target.kind === "page"
            ? await routePage(request, { pageId: target.id, ...at }, deps)
            : null;
    return response ? withPublicHeaders(response) : notFound();
  } catch (cause) {
    if (cause instanceof Docs.NotFoundError) return notFound();
    throw cause;
  }
}

interface At {
  readonly kind: string | undefined;
  readonly first: string | undefined;
  readonly second: string | undefined;
}

/** `diagrams/:id/picture.<format>[?page=n]` for a diagram `allowed` returns, or null. */
async function pictureRoute(
  request: Request,
  at: At,
  deps: PublicDeps,
  allowed: (diagramId: string) => Promise<DiagramSummary | null>,
): Promise<Response | null> {
  const { first, second } = at;
  if (at.kind !== "diagrams" || !first || !second) return null;
  const format = /^picture\.([a-z]+)$/.exec(second)?.[1];
  if (!isDiagramId(first) || !isDiagramPictureFormat(format)) return null;
  const page = new URL(request.url).searchParams.get("page");
  const pageIndex = page === null ? 0 : /^(0|[1-9]\d{0,3})$/.test(page) ? Number(page) : -1;
  if (pageIndex < 0) return null;
  const diagram = await allowed(first);
  if (!diagram) return null;
  return Diagrams.diagramPictureResponse(deps.images, { diagram, format, request, pageIndex });
}

async function routeDoc(
  request: Request,
  at: At & { readonly docId: string },
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

  if (kind === "diagrams") {
    return pictureRoute(request, at, deps, async (diagramId) => {
      const { tabs } = await Docs.getDoc(deps.db, docId);
      const allowed = await Diagrams.publicDocDiagrams(
        deps.db,
        docId,
        tabs.map((tab) => tab.markdown),
      );
      return allowed.find((each) => each.id === diagramId) ?? null;
    });
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

async function routeDiagram(
  request: Request,
  at: At & { readonly diagramId: string },
  deps: PublicDeps,
): Promise<Response | null> {
  const { diagramId } = at;
  if (at.kind === undefined) return Response.json(await publicDiagram(deps.db, diagramId));
  return pictureRoute(request, at, deps, async (id) =>
    id === diagramId ? Diagrams.getDiagram(deps.db, diagramId) : null,
  );
}

async function routePage(
  request: Request,
  at: At & { readonly pageId: string },
  deps: PublicDeps,
): Promise<Response | null> {
  const { pageId, kind, first } = at;
  if (kind === undefined) return Response.json(await publicPage(deps.db, pageId));
  if (kind !== "content" || first !== undefined) return null;
  // Only into a frame, as for signed-in readers: as a tab of its own the HTML
  // would show under the app's address, where it could pass for the app.
  if (!HtmlPages.isFrameLoad(request)) {
    return new Response("This page opens inside UP Docs.", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const page = await HtmlPages.getPage(deps.db, pageId);
  return HtmlPages.pageContentResponse(deps.db, deps.images, {
    pageId,
    version: page.version,
    frameAncestors: deps.frameAncestors,
  });
}
