// Pages: uploaded HTML files, the store, who may see and change one, where one
// is embedded, and the sandboxed response that serves its HTML. The REST API
// and the MCP tools call these, so both share one behaviour.
//
// A page is shared like a Draw.io diagram: its people (page_members) hold the
// doc roles, and the admin owns every page. A doc that embeds it in a
// ```t3-page block also shows it to the people on that doc, as viewers, when
// someone who can edit the page can edit that doc (the rule of
// `diagramAccess`), so pasting an id one was never given shows nothing.
//
// The HTML is someone's own code and must never run with the app's rights.
// `pageContentResponse` serves it with a CSP `sandbox` that leaves out
// `allow-same-origin`: the browser gives the document an opaque origin, so it
// cannot read the app's cookies or storage, and the API answers its requests
// as it answers any other website (no CORS, and writes need the app's Origin).
// It is served only into a frame, so it never shows under the app's address
// as a page of its own.

import { canEdit as canEditDoc, hasRole, isAdmin, type DocRole } from "../shared/access.ts";
import {
  looksLikeHtml,
  MAX_PAGE_BYTES,
  PAGE_LANGUAGE,
  PAGE_SANDBOX,
  parsePageBlock,
  type PageListItem,
  type PageSummary,
  type PageUse,
  type PageVersion,
  type PageView,
} from "../shared/htmlPages.ts";
import { findFences } from "../shared/table.ts";
import { memberRole, pageOwnerStatement, pageScope } from "./access.ts";
import { randomId } from "./crypto.ts";
import { getProject, NotFoundError } from "./docs.ts";
import type { ImageStore } from "./images.ts";

/** The person can see the page, but their role does not allow what they asked. */
export class PageForbiddenError extends Error {
  readonly required: DocRole;

  constructor(required: DocRole) {
    super(`forbidden: page ${required}`);
    this.required = required;
  }
}

/** An upload the store refuses; `message` is written for the person or agent sending it. */
export class InvalidPageError extends Error {
  readonly code: "too_large" | "invalid_html";

  constructor(code: InvalidPageError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

interface SummaryRow {
  id: string;
  project_id: string | null;
  title: string;
  version: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

interface VersionRow {
  version: number;
  bytes: number;
  sha256: string;
  note: string | null;
  created_by: string | null;
  created_at: number;
}

const SUMMARY_COLUMNS = "id, project_id, title, version, created_by, created_at, updated_at";

const toSummary = (row: SummaryRow): PageSummary => ({
  id: row.id,
  projectId: row.project_id,
  title: row.title,
  version: row.version,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toVersion = (row: VersionRow): PageVersion => ({
  version: row.version,
  bytes: row.bytes,
  sha256: row.sha256,
  note: row.note,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

/** What one person may do with a page. `member` is false for someone who sees it through a doc. */
export interface PageAccess {
  readonly role: DocRole;
  readonly member: boolean;
}

export const PAGE_OWNER_ACCESS: PageAccess = { role: "owner", member: true };

/** What each ask on a page needs: see it, change it, or share, move and delete it. */
export type PageNeed = "view" | "edit" | "owner";

const NEED_ROLE: Readonly<Record<PageNeed, DocRole>> = {
  view: "viewer",
  edit: "editor",
  owner: "owner",
};

/** Objects are keyed by version and content, so a racing upload never overwrites another. */
export const pagesPrefix = (pageId: string) => `pages/${pageId}/`;
export const pageObjectKey = (pageId: string, version: number, sha256: string) =>
  `${pagesPrefix(pageId)}${version}.${sha256.slice(0, 16)}.html`;

interface LinkRow {
  tab_id: string;
  tab_title: string;
  markdown: string;
  doc_id: string;
  doc_title: string;
  readable: number;
  by_editor: number;
}

/**
 * Every ```t3-page block in the tabs, read from their markdown: there is no
 * index table. `pageId` narrows the scan to tabs that mention that id.
 * `readable`: `userId` is on the doc. `byEditor`: someone who can edit the
 * page is an owner or editor of that doc (only with `pageId`).
 */
async function linkedTabs(
  db: D1Database,
  input: { readonly pageId?: string | undefined; readonly userId?: string | undefined },
): Promise<ReadonlyArray<{ pageId: string; use: PageUse; readable: boolean; byEditor: boolean }>> {
  const { results } = await db
    .prepare(
      `SELECT t.id AS tab_id, t.title AS tab_title, t.markdown, t.doc_id, d.title AS doc_title,
         (m.user_id IS NOT NULL) AS readable,
         (?3 IS NOT NULL AND EXISTS (
           SELECT 1 FROM doc_members c
           JOIN page_members g ON g.user_id = c.user_id
           WHERE c.doc_id = t.doc_id AND c.role IN ('owner', 'editor')
             AND g.page_id = ?3 AND g.role IN ('owner', 'editor'))) AS by_editor
       FROM tabs t JOIN docs d ON d.id = t.doc_id
       LEFT JOIN doc_members m ON m.doc_id = t.doc_id AND m.user_id = ?1
       WHERE instr(t.markdown, ?2) > 0 AND (?3 IS NULL OR instr(t.markdown, ?3) > 0)
       ORDER BY d.title COLLATE NOCASE, d.id, t.position, t.id`,
    )
    .bind(input.userId ?? null, PAGE_LANGUAGE, input.pageId ?? null)
    .all<LinkRow>();
  return results.flatMap((row) => {
    const ids = new Set<string>();
    for (const fence of findFences(row.markdown)) {
      if (fence.language !== PAGE_LANGUAGE) continue;
      const block = parsePageBlock(fence.body);
      if (block && (input.pageId === undefined || block.pageId === input.pageId)) {
        ids.add(block.pageId);
      }
    }
    const use: PageUse = {
      docId: row.doc_id,
      docTitle: row.doc_title,
      tabId: row.tab_id,
      tabTitle: row.tab_title,
    };
    return [...ids].map((pageId) => ({
      pageId,
      use,
      readable: row.readable === 1,
      byEditor: row.by_editor === 1,
    }));
  });
}

/**
 * What the person may do with the page, or null when they may not see it:
 * the admin owns every page; anyone on its people list has their role there;
 * otherwise someone on a doc that embeds it views it, where a person who can
 * edit the page can also edit that doc.
 */
export async function pageAccess(
  db: D1Database,
  pageId: string,
  userId: string,
): Promise<PageAccess | null> {
  if (isAdmin(userId)) return PAGE_OWNER_ACCESS;
  const role = await memberRole(db, pageScope(pageId), userId);
  if (role) return { role, member: true };
  const links = await linkedTabs(db, { pageId, userId });
  return links.some((link) => link.readable && link.byEditor)
    ? { role: "viewer", member: false }
    : null;
}

export async function getPage(db: D1Database, pageId: string): Promise<PageSummary> {
  const row = await db
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM pages WHERE id = ?`)
    .bind(pageId)
    .first<SummaryRow>();
  if (!row) throw new NotFoundError("page");
  return toSummary(row);
}

/**
 * The page, once `userId` is known to have the access asked for. A page the
 * person cannot see at all is NotFoundError, as with docs, so ids do not
 * reveal what exists; one whose role falls short is PageForbiddenError.
 */
export async function requirePage(
  db: D1Database,
  input: { readonly pageId: string; readonly userId: string; readonly need: PageNeed },
): Promise<{ readonly page: PageSummary; readonly access: PageAccess }> {
  const page = await getPage(db, input.pageId);
  const access = await pageAccess(db, page.id, input.userId);
  if (!access) throw new NotFoundError("page");
  const required = NEED_ROLE[input.need];
  if (!hasRole(access.role, required)) throw new PageForbiddenError(required);
  return { page, access };
}

export async function listVersions(
  db: D1Database,
  pageId: string,
): Promise<ReadonlyArray<PageVersion>> {
  const { results } = await db
    .prepare(
      `SELECT version, bytes, sha256, note, created_by, created_at FROM page_versions
       WHERE page_id = ? ORDER BY version DESC`,
    )
    .bind(pageId)
    .all<VersionRow>();
  return results.map(toVersion);
}

export async function getVersion(
  db: D1Database,
  pageId: string,
  version: number,
): Promise<PageVersion | null> {
  const row = await db
    .prepare(
      `SELECT version, bytes, sha256, note, created_by, created_at FROM page_versions
       WHERE page_id = ? AND version = ?`,
    )
    .bind(pageId, version)
    .first<VersionRow>();
  return row ? toVersion(row) : null;
}

/** The page as one caller may see it, with every version, newest first. */
export async function pageView(
  db: D1Database,
  page: PageSummary,
  access: PageAccess,
): Promise<PageView> {
  return {
    ...page,
    role: access.role,
    member: access.member,
    canEdit: canEditDoc(access.role),
    versions: await listVersions(db, page.id),
  };
}

/**
 * The pages a person is on, newest change first, with their role on each and
 * the size of the current version: every page for the admin. `projectId`
 * narrows to one project, or to pages in no project when null.
 */
export async function listPages(
  db: D1Database,
  input: { readonly userId: string; readonly projectId?: string | null | undefined },
): Promise<ReadonlyArray<Omit<PageListItem, "uses">>> {
  const { results } = await db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS},
         (SELECT m.role FROM page_members m WHERE m.page_id = pages.id AND m.user_id = ?2) AS role,
         (SELECT v.bytes FROM page_versions v
            WHERE v.page_id = pages.id AND v.version = pages.version) AS bytes
       FROM pages
       WHERE (?1 OR EXISTS (SELECT 1 FROM page_members m
           WHERE m.page_id = pages.id AND m.user_id = ?2))
         AND (?3 OR project_id IS ?4)
       ORDER BY updated_at DESC, id`,
    )
    .bind(
      isAdmin(input.userId) ? 1 : 0,
      input.userId,
      input.projectId === undefined ? 1 : 0,
      input.projectId ?? null,
    )
    .all<SummaryRow & { role: DocRole | null; bytes: number | null }>();
  return results.map((row) => ({
    ...toSummary(row),
    role: isAdmin(input.userId) ? "owner" : (row.role ?? "viewer"),
    bytes: row.bytes ?? 0,
  }));
}

/** For every embedded page, the tabs that embed it in docs `userId` is on. */
export async function pageUsesById(
  db: D1Database,
  userId: string,
): Promise<ReadonlyMap<string, ReadonlyArray<PageUse>>> {
  const byId = new Map<string, Array<PageUse>>();
  for (const link of await linkedTabs(db, { userId })) {
    if (!link.readable) continue;
    const uses = byId.get(link.pageId) ?? [];
    uses.push(link.use);
    byId.set(link.pageId, uses);
  }
  return byId;
}

/** The docs and tabs that embed the page, as `userId` may know them. */
export async function pageUsage(
  db: D1Database,
  input: { readonly pageId: string; readonly userId: string },
): Promise<{ readonly uses: ReadonlyArray<PageUse>; readonly otherDocs: number }> {
  const links = await linkedTabs(db, input);
  const hidden = new Set(links.filter((link) => !link.readable).map((link) => link.use.docId));
  return { uses: links.filter((link) => link.readable).map((link) => link.use), otherDocs: hidden.size };
}

/** Checks an upload and returns its bytes and their SHA-256. */
export async function checkPageHtml(
  body: ArrayBuffer,
): Promise<{ readonly bytes: ArrayBuffer; readonly sha256: string }> {
  if (body.byteLength > MAX_PAGE_BYTES) {
    throw new InvalidPageError(
      "too_large",
      `The file is over the ${MAX_PAGE_BYTES / (1024 * 1024)} MB limit for a page.`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new InvalidPageError("invalid_html", "The file is not UTF-8 text. Save the page as UTF-8 HTML.");
  }
  if (!looksLikeHtml(text)) {
    throw new InvalidPageError(
      "invalid_html",
      "The file is not an HTML document: it must start with <!doctype html>, <html>, <head> or <body>.",
    );
  }
  const digest = await crypto.subtle.digest("SHA-256", body);
  const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { bytes: body, sha256 };
}

/**
 * Creates a page with its first version. The caller checks the person may
 * use `projectId` (Access.canSeeProject), as for a new doc.
 */
export async function createPage(
  db: D1Database,
  store: ImageStore,
  input: {
    readonly projectId: string | null;
    readonly title: string;
    readonly html: ArrayBuffer;
    readonly note?: string | null | undefined;
    readonly createdBy: string;
    readonly now: number;
  },
): Promise<PageSummary> {
  const { bytes, sha256 } = await checkPageHtml(input.html);
  if (input.projectId !== null) await getProject(db, input.projectId);
  const id = randomId();
  // The row first: without R2, the stored chunks belong to it.
  await db.batch([
    db
      .prepare(
        `INSERT INTO pages (id, project_id, title, version, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`,
      )
      .bind(id, input.projectId, input.title, input.createdBy, input.now, input.now),
    pageOwnerStatement(db, { pageId: id, userId: input.createdBy, now: input.now }),
  ]);
  try {
    await store.put(pageObjectKey(id, 1, sha256), bytes, "text/html; charset=utf-8");
    await db
      .prepare(
        `INSERT INTO page_versions (page_id, version, bytes, sha256, note, created_by, created_at)
         VALUES (?, 1, ?, ?, ?, ?, ?)`,
      )
      .bind(id, bytes.byteLength, sha256, input.note ?? null, input.createdBy, input.now)
      .run();
  } catch (cause) {
    await store.deletePrefix(pagesPrefix(id));
    await db.prepare("DELETE FROM pages WHERE id = ?").bind(id).run();
    throw cause;
  }
  return {
    id,
    projectId: input.projectId,
    title: input.title,
    version: 1,
    createdBy: input.createdBy,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/**
 * Adds the next version and makes it current. Earlier versions stay as they
 * are. Two uploads at once each get their own number.
 */
export async function addPageVersion(
  db: D1Database,
  store: ImageStore,
  input: {
    readonly pageId: string;
    readonly html: ArrayBuffer;
    readonly note?: string | null | undefined;
    /** A new title, set in the same write as the version. */
    readonly title?: string | undefined;
    readonly createdBy: string;
    readonly now: number;
  },
): Promise<PageSummary> {
  const { bytes, sha256 } = await checkPageHtml(input.html);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await getPage(db, input.pageId);
    const version = current.version + 1;
    const key = pageObjectKey(input.pageId, version, sha256);
    await store.put(key, bytes, "text/html; charset=utf-8");
    try {
      const [, updated] = await db.batch<SummaryRow>([
        db
          .prepare(
            `INSERT INTO page_versions (page_id, version, bytes, sha256, note, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(input.pageId, version, bytes.byteLength, sha256, input.note ?? null, input.createdBy, input.now),
        db
          .prepare(
            `UPDATE pages SET version = MAX(version, ?1), updated_at = ?2, title = COALESCE(?4, title)
             WHERE id = ?3
             RETURNING ${SUMMARY_COLUMNS}`,
          )
          .bind(version, input.now, input.pageId, input.title ?? null),
      ]);
      const row = updated?.results[0];
      if (!row) throw new NotFoundError("page");
      return toSummary(row);
    } catch (cause) {
      if (cause instanceof NotFoundError) throw cause;
      // Someone else took this number: try the next one. Only our own object goes.
      const taken = await getVersion(db, input.pageId, version);
      if (!taken) {
        // Not a lost race (the page went, or the write failed): our object goes.
        await store.delete(key);
        throw cause;
      }
      if (taken.sha256 !== sha256) await store.delete(key);
    }
  }
  throw new Error("page version kept changing");
}

/** Renames a page, or moves it to another project (or none), which clears its folder. */
export async function updatePage(
  db: D1Database,
  input: {
    readonly pageId: string;
    readonly title?: string | undefined;
    readonly projectId?: string | null | undefined;
    readonly now: number;
  },
): Promise<PageSummary> {
  if (input.projectId != null) await getProject(db, input.projectId);
  const row = await db
    .prepare(
      `UPDATE pages SET
         title = COALESCE(?1, title),
         folder_id = CASE WHEN ?2 AND project_id IS NOT ?3 THEN NULL ELSE folder_id END,
         project_id = CASE WHEN ?2 THEN ?3 ELSE project_id END,
         updated_at = ?4
       WHERE id = ?5
       RETURNING ${SUMMARY_COLUMNS}`,
    )
    .bind(
      input.title ?? null,
      input.projectId === undefined ? 0 : 1,
      input.projectId ?? null,
      input.now,
      input.pageId,
    )
    .first<SummaryRow>();
  if (!row) throw new NotFoundError("page");
  return toSummary(row);
}

/** When a project's docs move out, its pages go with them. */
export async function moveProjectPages(
  db: D1Database,
  input: { readonly from: string; readonly to: string | null },
): Promise<void> {
  await db
    .prepare("UPDATE pages SET project_id = ?1, folder_id = NULL WHERE project_id = ?2")
    .bind(input.to, input.from)
    .run();
}

/** Deletes the page and every version. Docs that embed it keep their block, which shows as missing. */
export async function deletePage(db: D1Database, store: ImageStore, pageId: string): Promise<void> {
  // The row first, so an upload still under way fails its version insert and
  // removes its own object; then the objects, which R2 does not cascade.
  const row = await db.prepare("DELETE FROM pages WHERE id = ? RETURNING id").bind(pageId).first();
  if (!row) throw new NotFoundError("page");
  await store.deletePrefix(pagesPrefix(pageId));
}

/** One version's HTML as text, or null when it is missing. */
export async function readPageHtml(
  db: D1Database,
  store: ImageStore,
  input: { readonly pageId: string; readonly version: number },
): Promise<{ readonly html: string; readonly version: PageVersion } | null> {
  const version = await getVersion(db, input.pageId, input.version);
  if (!version) return null;
  const object = await store.get(pageObjectKey(input.pageId, version.version, version.sha256));
  if (!object) return null;
  const html = await new Response(object.body).text();
  return { html, version };
}

/**
 * The headers that keep a page's HTML in its sandbox. `frameAncestors` are
 * the origins allowed to frame the app (FRAME_ANCESTORS): the app's own page
 * frames the HTML, and T3 Code may frame the app around it.
 */
export function pageContentHeaders(frameAncestors: ReadonlyArray<string>): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `sandbox ${PAGE_SANDBOX}; frame-ancestors ${["'self'", ...frameAncestors].join(" ")}`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    // Versions never change, but access can: keep it private and check every load.
    "Cache-Control": "private, no-cache",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

/**
 * Whether the browser is loading the HTML into a frame. Opened as a tab of
 * its own, the page would show under the app's address, where it could pass
 * for the app (a fake sign-in form), so only frames get it.
 */
export const isFrameLoad = (request: Request) => request.headers.get("Sec-Fetch-Dest") === "iframe";

/** Serves one version's HTML in its sandbox. The caller has checked the viewer role. */
export async function pageContentResponse(
  db: D1Database,
  store: ImageStore,
  input: {
    readonly pageId: string;
    readonly version: number;
    readonly frameAncestors: ReadonlyArray<string>;
  },
): Promise<Response | null> {
  const version = await getVersion(db, input.pageId, input.version);
  if (!version) return null;
  const object = await store.get(pageObjectKey(input.pageId, version.version, version.sha256));
  if (!object) return null;
  return new Response(object.body, {
    headers: { ...pageContentHeaders(input.frameAncestors), ETag: `"${version.sha256}"` },
  });
}
