// Draw.io diagrams: the store, who may see and change one, and where one is
// linked. The REST API and the MCP tools call these, so both share one
// behaviour. A diagram is managed by its creator and the admin. A doc that links
// it shows it to the people on that doc only when its creator can edit that doc
// (see `canViewDiagram`); they see its picture and what it shows, never its source.

import { canEdit as canEditDoc, isAdmin, type DocRole } from "../shared/access.ts";
import {
  checkDiagramXml,
  DIAGRAM_PICTURE_TYPES,
  DRAWIO_LANGUAGE,
  MAX_DIAGRAM_PICTURE_BYTES,
  parseDrawioBlock,
  type Diagram,
  type DiagramPictureFormat,
  type DiagramRefresh,
  type DiagramSourceProblem,
  type DiagramSummary,
  type DiagramUsage,
  type DiagramUse,
  type DiagramView,
} from "../shared/drawio.ts";
import { findFences } from "../shared/table.ts";
import { randomId } from "./crypto.ts";
import { getProject, NotFoundError } from "./docs.ts";
import { matchesType, type ImageStore } from "./images.ts";

/** The person can see the diagram's picture but does not manage the diagram. */
export class DiagramForbiddenError extends Error {
  constructor() {
    super("forbidden: diagram");
  }
}

/** A source or picture the store refuses; `message` is written for the person or agent saving. */
export class InvalidDiagramError extends Error {
  readonly code: DiagramSourceProblem["code"] | "invalid_picture";

  constructor(code: InvalidDiagramError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

interface SummaryRow {
  id: string;
  project_id: string | null;
  title: string;
  version: number;
  picture_version: number | null;
  has_source: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

interface DiagramRow extends SummaryRow {
  xml: string;
}

// The source can be a megabyte, so lists never read it.
const SUMMARY_COLUMNS = `id, project_id, title, version, picture_version, (xml <> '') AS has_source,
  created_by, created_at, updated_at`;

const toSummary = (row: SummaryRow): DiagramSummary => ({
  id: row.id,
  projectId: row.project_id,
  title: row.title,
  version: row.version,
  pictureVersion: row.picture_version,
  hasSource: row.has_source === 1,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toDiagram = (row: DiagramRow): Diagram => ({ ...toSummary(row), xml: row.xml });

/** A diagram without its source, for a caller that already holds the whole one. */
export function diagramSummary(diagram: DiagramSummary): DiagramSummary {
  const { id, projectId, title, version, pictureVersion, hasSource } = diagram;
  const { createdBy, createdAt, updatedAt } = diagram;
  return {
    id,
    projectId,
    title,
    version,
    pictureVersion,
    hasSource,
    createdBy,
    createdAt,
    updatedAt,
  };
}

/** The diagram as one caller may see it: the source only for someone who manages it. */
export const diagramView = (diagram: Diagram, canEdit: boolean): DiagramView => ({
  ...diagramSummary(diagram),
  canEdit,
  xml: canEdit ? diagram.xml : null,
});

function assertSource(xml: string): void {
  const problem = checkDiagramXml(xml);
  if (problem) throw new InvalidDiagramError(problem.code, problem.message);
}

/** The creator and the admin manage a diagram: edit, rename, move and delete it. */
export const canEditDiagram = (diagram: Pick<DiagramSummary, "createdBy">, userId: string) =>
  isAdmin(userId) || (diagram.createdBy !== null && diagram.createdBy === userId);

interface LinkRow {
  tab_id: string;
  tab_title: string;
  markdown: string;
  doc_id: string;
  doc_title: string;
  readable: number;
  creator_role: DocRole | null;
}

/**
 * Every ```t3-drawio block in the tabs, read from their markdown: there is no
 * index table. `diagramId` narrows the scan to tabs that mention that id.
 * `readable` says whether `userId` is on the tab's doc, and `byCreator` whether
 * `creatorId` is a member of it who can edit it.
 */
async function linkedTabs(
  db: D1Database,
  input: {
    readonly diagramId?: string | undefined;
    readonly userId?: string | undefined;
    readonly creatorId?: string | undefined;
  },
): Promise<
  ReadonlyArray<{ diagramId: string; use: DiagramUse; readable: boolean; byCreator: boolean }>
> {
  const { results } = await db
    .prepare(
      `SELECT t.id AS tab_id, t.title AS tab_title, t.markdown, t.doc_id, d.title AS doc_title,
         (m.user_id IS NOT NULL) AS readable, c.role AS creator_role
       FROM tabs t JOIN docs d ON d.id = t.doc_id
       LEFT JOIN doc_members m ON m.doc_id = t.doc_id AND m.user_id = ?1
       LEFT JOIN doc_members c ON c.doc_id = t.doc_id AND c.user_id = ?4
       WHERE instr(t.markdown, ?2) > 0 AND (?3 IS NULL OR instr(t.markdown, ?3) > 0)
       ORDER BY d.title COLLATE NOCASE, d.id, t.position, t.id`,
    )
    .bind(
      input.userId ?? null,
      DRAWIO_LANGUAGE,
      input.diagramId ?? null,
      input.creatorId ?? null,
    )
    .all<LinkRow>();
  return results.flatMap((row) => {
    const ids = new Set<string>();
    for (const fence of findFences(row.markdown)) {
      if (fence.language !== DRAWIO_LANGUAGE) continue;
      const block = parseDrawioBlock(fence.body);
      if (block && (input.diagramId === undefined || block.diagramId === input.diagramId)) {
        ids.add(block.diagramId);
      }
    }
    const use: DiagramUse = {
      docId: row.doc_id,
      docTitle: row.doc_title,
      tabId: row.tab_id,
      tabTitle: row.tab_title,
    };
    const byCreator = canEditDoc(row.creator_role);
    return [...ids].map((diagramId) => ({
      diagramId,
      use,
      readable: row.readable === 1,
      byCreator,
    }));
  });
}

/**
 * The docs and tabs whose markdown links the diagram, as `userId` may know
 * them: tabs in docs they are on, and a count of the other docs.
 */
export async function diagramUsage(
  db: D1Database,
  input: { readonly diagramId: string; readonly userId: string },
): Promise<DiagramUsage> {
  const links = await linkedTabs(db, input);
  const hidden = new Set(links.filter((link) => !link.readable).map((link) => link.use.docId));
  return {
    uses: links.filter((link) => link.readable).map((link) => link.use),
    otherDocs: hidden.size,
  };
}

/**
 * For every linked diagram, the tabs that link it in docs `userId` is on. One scan serves a
 * whole list.
 */
export async function diagramUsesById(
  db: D1Database,
  userId: string,
): Promise<ReadonlyMap<string, ReadonlyArray<DiagramUse>>> {
  const byId = new Map<string, Array<DiagramUse>>();
  for (const link of await linkedTabs(db, { userId })) {
    if (!link.readable) continue;
    const uses = byId.get(link.diagramId) ?? [];
    uses.push(link.use);
    byId.set(link.diagramId, uses);
  }
  return byId;
}

/**
 * Whether the person may see the diagram: they manage it, or they are on a doc
 * that links it and that the diagram's creator can edit. Anyone who edits a doc
 * can put any diagram's id in a block, so a link counts only where the creator
 * is a member who could have put it there. Membership is the doc's own list:
 * the admin manages every diagram, but being on a doc counts only for the ones
 * the admin created. A diagram whose creator is gone is the admin's alone.
 */
export async function canViewDiagram(
  db: D1Database,
  diagram: Pick<DiagramSummary, "id" | "createdBy">,
  userId: string,
): Promise<boolean> {
  if (canEditDiagram(diagram, userId)) return true;
  if (diagram.createdBy === null) return false;
  const links = await linkedTabs(db, {
    diagramId: diagram.id,
    userId,
    creatorId: diagram.createdBy,
  });
  return links.some((link) => link.readable && link.byCreator);
}

export async function getDiagram(db: D1Database, diagramId: string): Promise<Diagram> {
  const row = await db
    .prepare(`SELECT ${SUMMARY_COLUMNS}, xml FROM diagrams WHERE id = ?`)
    .bind(diagramId)
    .first<DiagramRow>();
  if (!row) throw new NotFoundError("diagram");
  return toDiagram(row);
}

/**
 * The diagram, once `userId` is known to have the access asked for. A diagram
 * the person cannot see at all is NotFoundError, as with docs, so ids do not
 * reveal what exists; one they can only view is DiagramForbiddenError when
 * `need` is "edit". A viewer must never be handed `diagram.xml`.
 */
export async function requireDiagram(
  db: D1Database,
  input: { readonly diagramId: string; readonly userId: string; readonly need: "view" | "edit" },
): Promise<{ readonly diagram: Diagram; readonly canEdit: boolean }> {
  const diagram = await getDiagram(db, input.diagramId);
  const canEdit = canEditDiagram(diagram, input.userId);
  if (!canEdit && !(await canViewDiagram(db, diagram, input.userId))) {
    throw new NotFoundError("diagram");
  }
  if (input.need === "edit" && !canEdit) throw new DiagramForbiddenError();
  return { diagram, canEdit };
}

/**
 * The diagrams among `diagramIds` that `userId` may see, as they are now and
 * without their source, for an open page to re-read. The rule is
 * `requireDiagram`'s: one the person cannot see is left out, like one that is
 * gone. Someone who manages a diagram is also told where it is linked.
 */
export async function refreshDiagrams(
  db: D1Database,
  input: { readonly diagramIds: ReadonlyArray<string>; readonly userId: string },
): Promise<ReadonlyArray<DiagramRefresh>> {
  const { userId } = input;
  const ids = [...new Set(input.diagramIds)];
  if (ids.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM diagrams WHERE id IN (${ids.map(() => "?").join(", ")})`,
    )
    .bind(...ids)
    .all<SummaryRow>();
  const seen = await Promise.all(
    results.map(toSummary).map(async (diagram): Promise<DiagramRefresh | null> => {
      if (canEditDiagram(diagram, userId)) {
        const usage = await diagramUsage(db, { diagramId: diagram.id, userId });
        return { ...diagram, canEdit: true, usage };
      }
      return (await canViewDiagram(db, diagram, userId))
        ? { ...diagram, canEdit: false, usage: null }
        : null;
    }),
  );
  return seen.filter((diagram) => diagram !== null);
}

/**
 * The diagrams a person manages, newest edit first: their own, or every
 * diagram for the admin. `projectId` narrows to one project, or to diagrams in
 * no project when null.
 */
export async function listDiagrams(
  db: D1Database,
  input: { readonly userId: string; readonly projectId?: string | null | undefined },
): Promise<ReadonlyArray<DiagramSummary>> {
  const { results } = await db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM diagrams
       WHERE (?1 OR created_by = ?2) AND (?3 OR project_id IS ?4)
       ORDER BY updated_at DESC, id`,
    )
    .bind(
      isAdmin(input.userId) ? 1 : 0,
      input.userId,
      input.projectId === undefined ? 1 : 0,
      input.projectId ?? null,
    )
    .all<SummaryRow>();
  return results.map(toSummary);
}

/**
 * Creates a diagram, drawn already when `xml` is given. The caller checks the
 * person may use `projectId` (Access.canSeeProject), as for a new doc.
 */
export async function createDiagram(
  db: D1Database,
  input: {
    readonly projectId: string | null;
    readonly title: string;
    readonly xml?: string | undefined;
    readonly createdBy: string;
    readonly now: number;
  },
): Promise<Diagram> {
  const xml = input.xml ?? "";
  assertSource(xml);
  if (input.projectId !== null) await getProject(db, input.projectId);
  const diagram: Diagram = {
    id: randomId(),
    projectId: input.projectId,
    title: input.title,
    xml,
    version: 1,
    pictureVersion: null,
    hasSource: xml !== "",
    createdBy: input.createdBy,
    createdAt: input.now,
    updatedAt: input.now,
  };
  await db
    .prepare(
      `INSERT INTO diagrams (id, project_id, title, xml, version, picture_version, created_by,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, NULL, ?, ?, ?)`,
    )
    .bind(
      diagram.id,
      diagram.projectId,
      diagram.title,
      diagram.xml,
      diagram.createdBy,
      diagram.createdAt,
      diagram.updatedAt,
    )
    .run();
  return diagram;
}

export type DiagramWriteResult =
  | { readonly ok: true; readonly diagram: Diagram }
  /** Someone saved since `baseVersion`: the diagram as it is now, to overwrite or reload. */
  | { readonly ok: false; readonly conflict: DiagramSummary };

/**
 * Changes a diagram's title, project or source. With `baseVersion` the write
 * applies only if that is still the current version; without it, the last
 * write wins. A new source bumps `version`, which leaves the picture behind
 * until someone uploads one for the new version.
 */
export async function updateDiagram(
  db: D1Database,
  input: {
    readonly diagramId: string;
    readonly title?: string | undefined;
    /** Null moves the diagram out of every project. */
    readonly projectId?: string | null | undefined;
    readonly xml?: string | undefined;
    readonly baseVersion?: number | undefined;
    readonly now: number;
  },
): Promise<DiagramWriteResult> {
  if (input.xml !== undefined) assertSource(input.xml);
  if (input.projectId != null) await getProject(db, input.projectId);
  const row = await db
    .prepare(
      `UPDATE diagrams SET
         title = COALESCE(?1, title),
         project_id = CASE WHEN ?2 THEN ?3 ELSE project_id END,
         version = version + (CASE WHEN ?4 IS NOT NULL AND ?4 <> xml THEN 1 ELSE 0 END),
         xml = COALESCE(?4, xml),
         updated_at = ?5
       WHERE id = ?6 AND (?7 IS NULL OR version = ?7)
       RETURNING ${SUMMARY_COLUMNS}, xml`,
    )
    .bind(
      input.title ?? null,
      input.projectId === undefined ? 0 : 1,
      input.projectId ?? null,
      input.xml ?? null,
      input.now,
      input.diagramId,
      input.baseVersion ?? null,
    )
    .first<DiagramRow>();
  if (row) return { ok: true, diagram: toDiagram(row) };
  return { ok: false, conflict: diagramSummary(await getDiagram(db, input.diagramId)) };
}

/** When a project's docs move out, its diagrams go with them. */
export async function moveProjectDiagrams(
  db: D1Database,
  input: { readonly from: string; readonly to: string | null },
): Promise<void> {
  await db
    .prepare("UPDATE diagrams SET project_id = ?1 WHERE project_id = ?2")
    .bind(input.to, input.from)
    .run();
}

export const diagramPicturesPrefix = (diagramId: string) => `diagrams/${diagramId}/`;
/**
 * Each picture is kept under the version it was drawn from, so an upload for an
 * older version can never overwrite the one `picture_version` points to, and a
 * version uploaded without a PNG has none.
 */
export const diagramPictureKey = (
  diagramId: string,
  version: number,
  format: DiagramPictureFormat,
) => `${diagramPicturesPrefix(diagramId)}${version}.${format}`;

/**
 * Deletes the diagram and its pictures. Docs that link it keep their block, which shows as missing.
 */
export async function deleteDiagram(
  db: D1Database,
  images: ImageStore,
  diagramId: string,
): Promise<void> {
  // Pictures first: the D1 store's rows would cascade, but R2 objects would not.
  await images.deletePrefix(diagramPicturesPrefix(diagramId));
  const row = await db
    .prepare("DELETE FROM diagrams WHERE id = ? RETURNING id")
    .bind(diagramId)
    .first();
  if (!row) throw new NotFoundError("diagram");
}

const SVG_START = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i;

export type DiagramPictureResult =
  | { readonly ok: true; readonly diagram: DiagramSummary }
  /** The source changed since `version`: the picture is of an older drawing and is not kept. */
  | { readonly ok: false; readonly conflict: DiagramSummary };

/**
 * Stores the picture Draw.io drew from the source at `version`: the SVG people
 * see, and the PNG agents are handed when the browser could make one. It is
 * kept only while `version` is still the current one.
 */
export async function saveDiagramPicture(
  db: D1Database,
  images: ImageStore,
  input: {
    readonly diagramId: string;
    readonly version: number;
    readonly svg: string;
    readonly png: ArrayBuffer | null;
  },
): Promise<DiagramPictureResult> {
  const svg = new TextEncoder().encode(input.svg);
  if (!SVG_START.test(input.svg)) {
    throw new InvalidDiagramError("invalid_picture", "The picture's SVG is not an SVG document.");
  }
  const png = input.png;
  if (png && !matchesType(new Uint8Array(png, 0, Math.min(12, png.byteLength)), "image/png")) {
    throw new InvalidDiagramError("invalid_picture", "The picture's PNG is not a PNG image.");
  }
  if (
    svg.byteLength > MAX_DIAGRAM_PICTURE_BYTES ||
    (png?.byteLength ?? 0) > MAX_DIAGRAM_PICTURE_BYTES
  ) {
    throw new InvalidDiagramError(
      "too_large",
      `The diagram's picture is over the ${MAX_DIAGRAM_PICTURE_BYTES / (1024 * 1024)} MB limit.`,
    );
  }
  const current = await getDiagram(db, input.diagramId);
  if (current.version !== input.version) return { ok: false, conflict: diagramSummary(current) };
  const key = (format: DiagramPictureFormat) =>
    diagramPictureKey(input.diagramId, input.version, format);
  await images.put(
    key("svg"),
    svg.buffer.slice(svg.byteOffset, svg.byteOffset + svg.byteLength) as ArrayBuffer,
    DIAGRAM_PICTURE_TYPES.svg,
  );
  if (png) await images.put(key("png"), png, DIAGRAM_PICTURE_TYPES.png);
  // A repeat upload for this version may come without the PNG the first one had.
  else await images.delete(key("png"));
  const row = await db
    .prepare(
      `UPDATE diagrams SET picture_version = ?1 WHERE id = ?2 AND version = ?1
       RETURNING ${SUMMARY_COLUMNS}`,
    )
    .bind(input.version, input.diagramId)
    .first<SummaryRow>();
  if (!row) return { ok: false, conflict: diagramSummary(await getDiagram(db, input.diagramId)) };
  // The picture this one replaces is no longer served.
  const previous = current.pictureVersion;
  if (previous !== null && previous !== input.version) {
    await Promise.all(
      (["svg", "png"] as const).map((format) =>
        images.delete(diagramPictureKey(input.diagramId, previous, format)),
      ),
    );
  }
  return { ok: true, diagram: toSummary(row) };
}

/**
 * The stored picture's bytes, or null when there is none in that format. Check
 * `pictureVersion` against `version` to know whether it shows the current source.
 */
export async function diagramPicture(
  images: ImageStore,
  diagram: Pick<DiagramSummary, "id" | "pictureVersion">,
  format: DiagramPictureFormat,
): Promise<{ readonly body: ReadableStream | ArrayBuffer; readonly contentType: string } | null> {
  if (diagram.pictureVersion === null) return null;
  const object = await images.get(diagramPictureKey(diagram.id, diagram.pictureVersion, format));
  return object ? { body: object.body, contentType: DIAGRAM_PICTURE_TYPES[format] } : null;
}

/**
 * The policy doc images are served with, so a picture opened on its own runs
 * nothing. Draw.io lays its labels out with inline styles and embeds pasted
 * pictures as data URIs; a browser that applies this policy to an SVG shown in
 * an <img> would otherwise drop both, so the SVG alone may use them.
 */
const PICTURE_POLICY: Readonly<Record<DiagramPictureFormat, string>> = {
  png: "default-src 'none'; sandbox",
  svg: "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
};

/**
 * Serves a diagram's picture. The caller has checked the person may view it.
 * A URL that names the picture's version is cached for good; any other is
 * revalidated against the version, so it never shows an older picture.
 */
export async function diagramPictureResponse(
  images: ImageStore,
  input: {
    readonly diagram: Pick<DiagramSummary, "id" | "pictureVersion">;
    readonly format: DiagramPictureFormat;
    readonly request: Request;
  },
): Promise<Response | null> {
  const { diagram, format, request } = input;
  if (diagram.pictureVersion === null) return null;
  const etag = `"${format}-${diagram.pictureVersion}"`;
  const pinned = new URL(request.url).searchParams.get("v") === String(diagram.pictureVersion);
  const headers = {
    "Content-Type": DIAGRAM_PICTURE_TYPES[format],
    "Cache-Control": pinned ? "private, max-age=31536000, immutable" : "private, no-cache",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": PICTURE_POLICY[format],
  };
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  const picture = await diagramPicture(images, diagram, format);
  return picture ? new Response(picture.body, { headers }) : null;
}
