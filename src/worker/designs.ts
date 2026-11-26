// Designs: OpenPencil (.fig) files, the store, who may see and change one,
// and the `/api/designs` routes. Owner: S2. S3 (agent tools) and S4 (designs
// in docs) call these and do not change them without asking.
//
// A design is shared like a Draw.io diagram: its people (design_members) hold
// the doc roles, and the admin owns every design. Seeing one through a doc
// that shows it is S4's to add.
//
// Every save is the whole .fig file plus a PNG picture of the editor's
// current page, and becomes the next version, refused when it was made from
// an older one (`baseVersion`), so two editors never overwrite each other
// silently. Each version's bytes are objects of their own, named by a random
// token, under designs/<designId>/. The last DESIGN_VERSIONS_KEPT versions are
// kept, plus the one the current picture came from; older ones are deleted on
// save.

import { canEdit, hasRole, isAdmin, type DocRole } from "../shared/access.ts";
import {
  DEFAULT_DESIGN_TITLE,
  DESIGN_VERSIONS_KEPT,
  isDesignId,
  MAX_DESIGN_FIG_BYTES,
  MAX_DESIGN_PICTURE_BYTES,
  MAX_DESIGN_TITLE_LENGTH,
  type DesignEditorConfig,
  type DesignListItem,
  type DesignSaveResult,
  type DesignSummary,
  type DesignView,
} from "../shared/design.ts";
import { canSeeProject, designOwnerStatement } from "./access.ts";
import { randomId } from "./crypto.ts";
import { getProject, NotFoundError } from "./docs.ts";
import { matchesType, type ImageStore } from "./images.ts";

/** The person can see the design, but their role does not allow what they asked. */
export class DesignForbiddenError extends Error {
  readonly required: DocRole;

  constructor(required: DocRole) {
    super(`forbidden: design ${required}`);
    this.required = required;
  }
}

/** A save the store refuses; `message` is written for the person or agent sending it. */
export class InvalidDesignError extends Error {
  readonly code: "design_too_large" | "invalid_design";

  constructor(code: InvalidDesignError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** A save made from a version that is no longer the latest. */
export class StaleDesignError extends Error {
  readonly current: DesignSummary;

  constructor(current: DesignSummary) {
    super("version_conflict");
    this.current = current;
  }
}

interface SummaryRow {
  id: string;
  project_id: string | null;
  title: string;
  version: number;
  picture_version: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

interface VersionRow {
  version: number;
  token: string;
  fig_bytes: number;
  picture_bytes: number | null;
}

const SUMMARY_COLUMNS =
  "id, project_id, title, version, picture_version, created_by, created_at, updated_at";

const toSummary = (row: SummaryRow): DesignSummary => ({
  id: row.id,
  projectId: row.project_id,
  title: row.title,
  version: row.version,
  pictureVersion: row.picture_version,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** What each ask on a design needs: see it, change it, or move and delete it. */
export type DesignNeed = "view" | "edit" | "owner";

const NEED_ROLE: Readonly<Record<DesignNeed, DocRole>> = {
  view: "viewer",
  edit: "editor",
  owner: "owner",
};

export const designsPrefix = (designId: string) => `designs/${designId}/`;
export const designFigKey = (designId: string, version: number, token: string) =>
  `${designsPrefix(designId)}${version}-${token}.fig`;
export const designPictureKey = (designId: string, version: number, token: string) =>
  `${designsPrefix(designId)}${version}-${token}.png`;

/** The person's role on the design, or null when they may not see it. The admin owns every design. */
export async function designRole(
  db: D1Database,
  designId: string,
  userId: string,
): Promise<DocRole | null> {
  if (isAdmin(userId)) return "owner";
  const row = await db
    .prepare("SELECT role FROM design_members WHERE design_id = ? AND user_id = ?")
    .bind(designId, userId)
    .first<{ role: DocRole }>();
  return row?.role ?? null;
}

export async function getDesign(db: D1Database, designId: string): Promise<DesignSummary> {
  const row = await db
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM designs WHERE id = ?`)
    .bind(designId)
    .first<SummaryRow>();
  if (!row) throw new NotFoundError("design");
  return toSummary(row);
}

/**
 * The design, once `userId` is known to have the access asked for. One the
 * person cannot see at all is NotFoundError, as with docs, so ids do not
 * reveal what exists; one whose role falls short is DesignForbiddenError.
 */
export async function requireDesign(
  db: D1Database,
  input: { readonly designId: string; readonly userId: string; readonly need: DesignNeed },
): Promise<{ readonly design: DesignSummary; readonly role: DocRole }> {
  const design = await getDesign(db, input.designId);
  const role = await designRole(db, design.id, input.userId);
  if (!role) throw new NotFoundError("design");
  const required = NEED_ROLE[input.need];
  if (!hasRole(role, required)) throw new DesignForbiddenError(required);
  return { design, role };
}

async function getVersion(
  db: D1Database,
  designId: string,
  version: number,
): Promise<VersionRow | null> {
  return db
    .prepare(
      `SELECT version, token, fig_bytes, picture_bytes FROM design_versions
       WHERE design_id = ? AND version = ?`,
    )
    .bind(designId, version)
    .first<VersionRow>();
}

/** The design as one caller may see it. */
export async function designView(
  db: D1Database,
  design: DesignSummary,
  role: DocRole,
  editor: DesignEditorConfig,
): Promise<DesignView> {
  const current = design.version > 0 ? await getVersion(db, design.id, design.version) : null;
  return { ...design, role, canEdit: canEdit(role), figBytes: current?.fig_bytes ?? 0, editor };
}

/** Which designs a list shows: all the person is on, those they made, or those shared with them. */
export type DesignFilter = "all" | "yours" | "shared";

/**
 * The designs a person is on, newest change first, with their role on each:
 * every design for the admin. `projectId` narrows to one project, or to
 * designs in no project when null. "yours" are the ones they created,
 * "shared" the others.
 */
export async function listDesigns(
  db: D1Database,
  input: {
    readonly userId: string;
    readonly projectId?: string | null | undefined;
    readonly filter?: DesignFilter | undefined;
  },
): Promise<ReadonlyArray<DesignListItem>> {
  const filter = input.filter ?? "all";
  const { results } = await db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS},
         (SELECT m.role FROM design_members m
            WHERE m.design_id = designs.id AND m.user_id = ?2) AS role
       FROM designs
       WHERE (?1 OR EXISTS (SELECT 1 FROM design_members m
           WHERE m.design_id = designs.id AND m.user_id = ?2))
         AND (?3 OR project_id IS ?4)
         AND (?5 = 'all' OR (?5 = 'yours') = (created_by IS ?2))
       ORDER BY updated_at DESC, id`,
    )
    .bind(
      isAdmin(input.userId) ? 1 : 0,
      input.userId,
      input.projectId === undefined ? 1 : 0,
      input.projectId ?? null,
      filter,
    )
    .all<SummaryRow & { role: DocRole | null }>();
  return results.map((row) => ({
    ...toSummary(row),
    role: isAdmin(input.userId) ? "owner" : (row.role ?? "viewer"),
  }));
}

/**
 * Creates an empty design (version 0: no file until the editor's first save).
 * The caller checks the person may use `projectId` (canSeeProject).
 */
export async function createDesign(
  db: D1Database,
  input: {
    readonly projectId: string | null;
    readonly title: string;
    readonly createdBy: string;
    readonly now: number;
  },
): Promise<DesignSummary> {
  if (input.projectId !== null) await getProject(db, input.projectId);
  const id = randomId();
  await db.batch([
    db
      .prepare(
        `INSERT INTO designs (id, project_id, title, version, picture_version, created_by,
           created_at, updated_at)
         VALUES (?, ?, ?, 0, NULL, ?, ?, ?)`,
      )
      .bind(id, input.projectId, input.title, input.createdBy, input.now, input.now),
    designOwnerStatement(db, { designId: id, userId: input.createdBy, now: input.now }),
  ]);
  return {
    id,
    projectId: input.projectId,
    title: input.title,
    version: 0,
    pictureVersion: null,
    createdBy: input.createdBy,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/** A .fig file is a zip container (current files) or a bare `fig-kiwi` archive (older ones). */
export function looksLikeFig(bytes: Uint8Array): boolean {
  const zip = [0x50, 0x4b, 0x03, 0x04].every((byte, index) => bytes[index] === byte);
  const kiwi = [..."fig-kiwi"].every((char, index) => bytes[index] === char.charCodeAt(0));
  return zip || kiwi;
}

/** Refuses a .fig that is empty, too large, or not a .fig file. */
export function checkFig(fig: ArrayBuffer): void {
  if (fig.byteLength > MAX_DESIGN_FIG_BYTES) {
    throw new InvalidDesignError(
      "design_too_large",
      `The design is over the ${MAX_DESIGN_FIG_BYTES / (1024 * 1024)} MB limit for a .fig file.`,
    );
  }
  if (fig.byteLength === 0 || !looksLikeFig(new Uint8Array(fig, 0, Math.min(8, fig.byteLength)))) {
    throw new InvalidDesignError("invalid_design", "The file is not a .fig design.");
  }
}

/** Whether a picture is kept, and why not. */
function checkPicture(png: ArrayBuffer | null): "ok" | "none" | "too_large" | "invalid" {
  if (png === null || png.byteLength === 0) return "none";
  if (png.byteLength > MAX_DESIGN_PICTURE_BYTES) return "too_large";
  return matchesType(new Uint8Array(png, 0, Math.min(8, png.byteLength)), "image/png")
    ? "ok"
    : "invalid";
}

/**
 * Stores a save as the next version, refused with StaleDesignError when
 * `baseVersion` is no longer the latest. A missing, too large or malformed
 * picture does not block the file: the design keeps its older picture and
 * the result says why.
 */
export async function saveDesignVersion(
  db: D1Database,
  store: ImageStore,
  input: {
    readonly designId: string;
    readonly baseVersion: number;
    readonly fig: ArrayBuffer;
    readonly png: ArrayBuffer | null;
    readonly createdBy: string;
    readonly now: number;
  },
): Promise<{ readonly design: DesignSummary; readonly pictureSkipped?: "too_large" | "invalid" }> {
  checkFig(input.fig);
  const picture = checkPicture(input.png);
  const current = await getDesign(db, input.designId);
  if (current.version !== input.baseVersion) throw new StaleDesignError(current);
  const version = input.baseVersion + 1;
  const token = randomId().slice(0, 16);
  const figKey = designFigKey(input.designId, version, token);
  const pictureKey = designPictureKey(input.designId, version, token);
  const withPicture = picture === "ok" && input.png !== null;
  const dropObjects = async () => {
    // Each on its own: one failing must not leave the other behind.
    await Promise.allSettled([
      store.delete(figKey),
      ...(withPicture ? [store.delete(pictureKey)] : []),
    ]);
  };
  let updated: SummaryRow | undefined;
  try {
    await store.put(figKey, input.fig, "application/octet-stream");
    if (withPicture) await store.put(pictureKey, input.png!, "image/png");
    // One transaction: the version row exists only when this save took the number.
    const [moved] = await db.batch<SummaryRow>([
      db
        .prepare(
          `UPDATE designs SET version = ?1, updated_at = ?2,
             picture_version = CASE WHEN ?3 THEN ?1 ELSE picture_version END
           WHERE id = ?4 AND version = ?5
           RETURNING ${SUMMARY_COLUMNS}`,
        )
        .bind(version, input.now, withPicture ? 1 : 0, input.designId, input.baseVersion),
      db
        .prepare(
          `INSERT INTO design_versions (design_id, version, token, fig_bytes, picture_bytes,
             created_by, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
           WHERE EXISTS (SELECT 1 FROM designs WHERE id = ?1 AND version = ?2)
             AND NOT EXISTS (SELECT 1 FROM design_versions WHERE design_id = ?1 AND version = ?2)`,
        )
        .bind(
          input.designId,
          version,
          token,
          input.fig.byteLength,
          withPicture ? input.png!.byteLength : null,
          input.createdBy,
          input.now,
        ),
    ]);
    updated = moved?.results[0];
  } catch (cause) {
    await dropObjects();
    throw cause;
  }
  if (!updated) {
    // Another save took this number first (or the design went): ours goes.
    await dropObjects();
    throw new StaleDesignError(await getDesign(db, input.designId));
  }
  // The save is stored: a failed cleanup must not report it as failed. Rows whose
  // objects could not go stay, so the next save tries them again.
  await pruneVersions(db, store, toSummary(updated)).catch((cause: unknown) => {
    console.error("design version cleanup failed", cause);
  });
  const design = toSummary(updated);
  return picture === "too_large" || picture === "invalid"
    ? { design, pictureSkipped: picture }
    : { design };
}

/** Deletes versions older than the kept ones, except the one the current picture came from. */
async function pruneVersions(db: D1Database, store: ImageStore, design: DesignSummary) {
  const { results } = await db
    .prepare(
      `SELECT version, token, fig_bytes, picture_bytes FROM design_versions
       WHERE design_id = ?1 AND version <= ?2 AND version IS NOT ?3`,
    )
    .bind(design.id, design.version - DESIGN_VERSIONS_KEPT, design.pictureVersion)
    .all<VersionRow>();
  // Objects first, then the row: a row is the only record of its objects' keys.
  for (const row of results) {
    await store.delete(designFigKey(design.id, row.version, row.token));
    if (row.picture_bytes !== null) {
      await store.delete(designPictureKey(design.id, row.version, row.token));
    }
    await db
      .prepare("DELETE FROM design_versions WHERE design_id = ? AND version = ?")
      .bind(design.id, row.version)
      .run();
  }
}

/** The versions still kept, newest first. */
export async function keptVersions(
  db: D1Database,
  designId: string,
): Promise<ReadonlyArray<number>> {
  const { results } = await db
    .prepare("SELECT version FROM design_versions WHERE design_id = ? ORDER BY version DESC")
    .bind(designId)
    .all<{ version: number }>();
  return results.map((row) => row.version);
}

/** One version's .fig bytes, or null when that version is not kept. */
export async function readDesignFig(
  db: D1Database,
  store: ImageStore,
  input: { readonly designId: string; readonly version: number },
): Promise<{ readonly body: ReadableStream | ArrayBuffer; readonly bytes: number } | null> {
  const row = await getVersion(db, input.designId, input.version);
  if (!row) return null;
  const object = await store.get(designFigKey(input.designId, row.version, row.token));
  return object ? { body: object.body, bytes: row.fig_bytes } : null;
}

/** One version's picture, or null when that version has none. */
export async function readDesignPicture(
  db: D1Database,
  store: ImageStore,
  input: { readonly designId: string; readonly version: number },
): Promise<{ readonly body: ReadableStream | ArrayBuffer } | null> {
  const row = await getVersion(db, input.designId, input.version);
  if (!row || row.picture_bytes === null) return null;
  return store.get(designPictureKey(input.designId, row.version, row.token));
}

/** Renames a design, or moves it to another project (or none). */
export async function updateDesign(
  db: D1Database,
  input: {
    readonly designId: string;
    readonly title?: string | undefined;
    readonly projectId?: string | null | undefined;
    readonly now: number;
  },
): Promise<DesignSummary> {
  if (input.projectId != null) await getProject(db, input.projectId);
  const row = await db
    .prepare(
      `UPDATE designs SET
         title = COALESCE(?1, title),
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
      input.designId,
    )
    .first<SummaryRow>();
  if (!row) throw new NotFoundError("design");
  return toSummary(row);
}

/** When a project's docs move out, its designs go with them. */
export async function moveProjectDesigns(
  db: D1Database,
  input: { readonly from: string; readonly to: string | null },
): Promise<void> {
  await db
    .prepare("UPDATE designs SET project_id = ?1 WHERE project_id = ?2")
    .bind(input.to, input.from)
    .run();
}

/** Deletes the design and every version. */
export async function deleteDesign(
  db: D1Database,
  store: ImageStore,
  designId: string,
): Promise<void> {
  // The row first, so a save under way fails its update and removes its own objects.
  const row = await db
    .prepare("DELETE FROM designs WHERE id = ? RETURNING id")
    .bind(designId)
    .first();
  if (!row) throw new NotFoundError("design");
  await store.deletePrefix(designsPrefix(designId));
}

// Routes.

/** What the design routes need from the API's dependencies. */
export interface DesignRouteDeps {
  readonly db: D1Database;
  readonly images: ImageStore;
  readonly now: () => number;
  /** The editor's own origin (DESIGNER_ORIGIN), or null to serve it under /designer/ here. */
  readonly designerOrigin?: string | null | undefined;
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const error = (status: number, code: string, message?: string) =>
  json(message === undefined ? { error: code } : { error: code, message }, status);

const tooLarge = () =>
  error(
    413,
    "design_too_large",
    `The design is over the ${MAX_DESIGN_FIG_BYTES / (1024 * 1024)} MB limit for a .fig file.`,
  );

function title(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_DESIGN_TITLE_LENGTH ? trimmed : null;
}

/** `undefined` when absent, null for "no project", a string id, or `false` when malformed. */
function projectIdArg(value: unknown): string | null | undefined | false {
  if (value === undefined || value === null) return value;
  return typeof value === "string" && value.trim() ? value.trim() : false;
}

const VERSION = /^(0|[1-9]\d{0,8})$/;

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Designs, under `/api/designs`:
 * - `GET /api/designs[?projectId=<id>|none][&filter=all|yours|shared]`: `{designs: DesignListItem[]}`.
 * - `POST /api/designs` `{title?, projectId?}`: `{design: DesignView}`, 201, an empty design.
 * - `GET /api/designs/:id`: `{design: DesignView}`.
 * - `PATCH /api/designs/:id` `{title?, projectId?}`: rename (editor) or move (owner).
 * - `DELETE /api/designs/:id` (owner): `{ok: true}`.
 * - `GET /api/designs/:id/fig[?version=n]`: the .fig bytes; 404 `no_file` before the first save.
 * - `GET /api/designs/:id/picture/:n`: version n's PNG.
 * - `POST /api/designs/:id/versions?baseVersion=&figBytes=` (editor), `application/octet-stream`
 *   body = .fig bytes then PNG bytes: `{design, pictureSkipped?}`, 201; 409 `version_conflict`
 *   `{design}` when `baseVersion` is not the latest; 413 `design_too_large`.
 * Null for other paths.
 */
export async function handleDesigns(
  request: Request,
  route: {
    readonly segments: ReadonlyArray<string>;
    readonly method: string;
    readonly url: URL;
    readonly userId: string;
  },
  deps: DesignRouteDeps,
): Promise<Response | null> {
  const [, id, sub, leaf] = route.segments;
  const { method, url, userId } = route;
  const editor: DesignEditorConfig = { origin: deps.designerOrigin ?? null };
  const view = async (design: DesignSummary, role: DocRole) =>
    designView(deps.db, design, role, editor);

  if (!id && method === "GET") {
    const param = url.searchParams.get("projectId");
    const projectId = param === null ? undefined : param === "none" ? null : param;
    const filterParam = url.searchParams.get("filter") ?? "all";
    if (filterParam !== "all" && filterParam !== "yours" && filterParam !== "shared") {
      return error(400, "invalid_filter");
    }
    return json({
      designs: await listDesigns(deps.db, { userId, projectId, filter: filterParam }),
    });
  }

  if (!id && method === "POST") {
    const body = await readJson(request);
    const name = body.title === undefined ? DEFAULT_DESIGN_TITLE : title(body.title);
    const projectId = projectIdArg(body.projectId);
    if (name == null) return error(400, "invalid_title");
    if (projectId === false) return error(400, "invalid_project");
    if (projectId && !(await canSeeProject(deps.db, projectId, userId))) {
      return error(404, "not_found");
    }
    const design = await createDesign(deps.db, {
      projectId: projectId ?? null,
      title: name,
      createdBy: userId,
      now: deps.now(),
    });
    return json({ design: await view(design, "owner") }, 201);
  }

  if (!id) return null;
  if (!isDesignId(id)) return error(404, "not_found");
  const need = (access: DesignNeed) =>
    requireDesign(deps.db, { designId: id, userId, need: access });

  if (sub === "versions" && !leaf && method === "POST") {
    const baseParam = url.searchParams.get("baseVersion") ?? "";
    const figParam = url.searchParams.get("figBytes") ?? "";
    if (!VERSION.test(baseParam) || !VERSION.test(figParam)) return error(400, "invalid_save");
    const type = (request.headers.get("Content-Type") ?? "").split(";")[0]!.trim();
    if (type !== "application/octet-stream") return error(415, "unsupported_type");
    await need("edit");
    const figBytes = Number(figParam);
    if (figBytes > MAX_DESIGN_FIG_BYTES) return tooLarge();
    const limit = MAX_DESIGN_FIG_BYTES + MAX_DESIGN_PICTURE_BYTES;
    if (Number(request.headers.get("Content-Length") ?? "0") > limit) return tooLarge();
    const body = await request.arrayBuffer();
    if (body.byteLength > limit) return tooLarge();
    if (figBytes > body.byteLength) return error(400, "invalid_save");
    try {
      const saved = await saveDesignVersion(deps.db, deps.images, {
        designId: id,
        baseVersion: Number(baseParam),
        fig: body.slice(0, figBytes),
        png: body.byteLength > figBytes ? body.slice(figBytes) : null,
        createdBy: userId,
        now: deps.now(),
      });
      const { role } = await need("edit");
      const result: DesignSaveResult = {
        design: await view(saved.design, role),
        ...(saved.pictureSkipped ? { pictureSkipped: saved.pictureSkipped } : {}),
      };
      return json(result, 201);
    } catch (cause) {
      if (cause instanceof StaleDesignError) {
        const { role } = await need("view");
        return json({ error: "version_conflict", design: await view(cause.current, role) }, 409);
      }
      if (cause instanceof InvalidDesignError) {
        return error(cause.code === "design_too_large" ? 413 : 400, cause.code, cause.message);
      }
      throw cause;
    }
  }

  if (sub === "fig" && !leaf && method === "GET") {
    const { design } = await need("view");
    const versionParam = url.searchParams.get("version");
    if (versionParam !== null && !VERSION.test(versionParam)) return error(404, "not_found");
    const version = versionParam === null ? design.version : Number(versionParam);
    if (version === 0) return error(404, "no_file");
    const fig = await readDesignFig(deps.db, deps.images, { designId: id, version });
    if (!fig) return error(404, "not_found");
    return new Response(fig.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(fig.bytes),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Design-Version": String(version),
      },
    });
  }

  if (sub === "picture" && leaf && method === "GET") {
    if (!VERSION.test(leaf)) return error(404, "not_found");
    await need("view");
    // A version's picture never changes, but access can: revalidate every load
    // (after the check above), and answer 304 when the browser has it.
    const etag = `"${id}-${leaf}"`;
    const cache = { "Cache-Control": "private, no-cache", ETag: etag };
    // The picture itself, not only its row: answer 304 only for one that still exists.
    const picture = await readDesignPicture(deps.db, deps.images, {
      designId: id,
      version: Number(leaf),
    });
    if (!picture) return error(404, "not_found");
    if (request.headers.get("If-None-Match") === etag) {
      if (picture.body instanceof ReadableStream) await picture.body.cancel();
      return new Response(null, { status: 304, headers: cache });
    }
    return new Response(picture.body, {
      headers: {
        "Content-Type": "image/png",
        ...cache,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }

  if (sub) return null;

  if (method === "GET") {
    const { design, role } = await need("view");
    return json({ design: await view(design, role) });
  }

  if (method === "PATCH") {
    const body = await readJson(request);
    const name = title(body.title);
    if (name === null) return error(400, "invalid_title");
    const projectId = projectIdArg(body.projectId);
    if (projectId === false) return error(400, "invalid_project");
    if (name === undefined && projectId === undefined) return error(400, "empty_write");
    // Editors rename; moving it to another project is the owner's.
    const { role } = await need(projectId === undefined ? "edit" : "owner");
    if (projectId && !(await canSeeProject(deps.db, projectId, userId))) {
      return error(404, "not_found");
    }
    const design = await updateDesign(deps.db, {
      designId: id,
      title: name,
      projectId,
      now: deps.now(),
    });
    return json({ design: await view(design, role) });
  }

  if (method === "DELETE") {
    await need("owner");
    await deleteDesign(deps.db, deps.images, id);
    return json({ ok: true });
  }

  return null;
}
