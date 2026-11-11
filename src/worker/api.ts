import {
  DOC_STATUSES,
  docGroupArg,
  type DocStatus,
  type DocSummary,
  type DocThreadLink,
  type Tab,
  type TabPlacement,
} from "../shared/protocol.ts";
import {
  isDocRole,
  type DocRole,
  type EmailDelivery,
} from "../shared/access.ts";
import {
  locateAnchor,
  markdownToText,
  parseStructuredAnchor,
  resolveStructuredAnchor,
} from "../shared/anchors.ts";
import { normalizeProjectKey } from "../shared/embed.ts";
import { SEARCH_MAX_QUERY, SEARCH_MIN_QUERY } from "../shared/home.ts";
import * as Access from "./access.ts";
import type { WidgetProblem } from "../shared/widget/check.ts";
import * as Auth from "./auth.ts";
import * as Comments from "./comments.ts";
import * as DocThreads from "./docThreads.ts";
import * as Docs from "./docs.ts";
import type { DocInvite } from "./email.ts";
import * as Export from "./export.ts";
import { docxResponse } from "./export/docx.ts";
import { linkedDiagrams } from "./export/linkedDiagrams.ts";
import * as Home from "./home.ts";
import * as Images from "./images.ts";
import * as ImageImport from "./imageImport.ts";
import { IMAGE_TYPES, isImageDocId } from "../shared/images.ts";
import { widgetProblems } from "./widgets.ts";
import { checkTablesIn } from "../shared/table.ts";
import {
  MAX_VIDEO_PARTS,
  VIDEO_PART_BYTES,
  videoFileType,
} from "../shared/video.ts";
import * as Videos from "./videos.ts";
import * as Embeds from "./embeds.ts";
import { matchEmbed } from "../shared/embeds.ts";
import * as DiagramComments from "./diagramComments.ts";
import * as Diagrams from "./diagrams.ts";
import {
  DEFAULT_DIAGRAM_TITLE,
  isDiagramId,
  isDiagramPictureFormat,
  MAX_DIAGRAM_REFRESH_IDS,
  MAX_DIAGRAM_TITLE_LENGTH,
} from "../shared/drawio.ts";
import { MAX_DIAGRAM_COMMENT_LENGTH } from "../shared/diagramComments.ts";
import { readDrawioLayout } from "../shared/drawioModel.ts";
import * as Sheets from "./sheets.ts";
import {
  DEFAULT_SHEET_TITLE,
  isSheetId,
  MAX_EDITS_PER_LIST,
  MAX_ORIGIN_LENGTH,
  MAX_SHEET_TITLE_LENGTH,
} from "../shared/sheets.ts";
import { workbookFromRecords, type Edit } from "../shared/sheet/index.ts";

/** The ordered write path for a doc; production routes it to the doc's DocRoom. */
export interface DocRooms {
  createTab(
    docId: string,
    input: {
      readonly parentTabId: string | null;
      readonly title: string;
      readonly markdown: string;
      readonly origin: string | null;
    },
  ): Promise<Tab>;
  writeTab(
    docId: string,
    input: {
      readonly tabId: string;
      readonly baseVersion: number;
      readonly markdown?: string;
      readonly title?: string;
      readonly origin: string | null;
    },
  ): Promise<Docs.TabWriteResult>;
  moveTab(
    docId: string,
    input: {
      readonly tabId: string;
      readonly parentTabId: string | null;
      readonly position: number;
      readonly origin: string | null;
    },
  ): Promise<ReadonlyArray<TabPlacement>>;
  /** Returns the ids of the tab and every descendant it took with it. */
  deleteTab(
    docId: string,
    input: { readonly tabId: string; readonly origin: string | null },
  ): Promise<ReadonlyArray<string>>;
  setDocStatus(
    docId: string,
    input: { readonly status: DocStatus; readonly origin: string | null },
  ): Promise<DocSummary>;
  renameDoc(
    docId: string,
    input: { readonly title: string; readonly origin: string | null },
  ): Promise<DocSummary>;
  /** Deletes the doc and closes every open socket on it. */
  deleteDoc(
    docId: string,
    input: { readonly origin: string | null },
  ): Promise<void>;
  setDocProject(
    docId: string,
    input: {
      readonly projectId: string | null;
      readonly origin: string | null;
    },
  ): Promise<DocSummary>;
  setDocGroup(
    docId: string,
    input: { readonly group: string | null; readonly origin: string | null },
  ): Promise<DocSummary>;
  commentOp(
    docId: string,
    input: { readonly op: Comments.CommentOp; readonly origin: string | null },
  ): Promise<Comments.CommentOpResult>;
  threadOp(
    docId: string,
    input: {
      readonly op: DocThreads.DocThreadOp;
      readonly origin: string | null;
    },
  ): Promise<ReadonlyArray<DocThreadLink>>;
  /** `userId` tags the socket so removing that person from the doc can close it. */
  openSocket(
    docId: string,
    request: Request,
    userId: string,
  ): Promise<Response>;
  closeSockets(docId: string, userId: string): Promise<void>;
}

export interface ApiDeps {
  readonly db: D1Database;
  /**
   * The app's public origin, for URLs handed out and the same-origin check:
   * PUBLIC_ORIGIN when set, else the request's own origin.
   */
  readonly publicOrigin: string;
  readonly owners: ReadonlySet<string>;
  readonly rooms: DocRooms;
  /** The ordered write path for a sheet; production routes it to the sheet's SheetRoom. */
  readonly sheetRooms: Sheets.SheetRooms;
  readonly images: Images.ImageStore;
  /** Null without an R2 bucket: uploads are refused, and video links still work. */
  readonly videos: Videos.VideoStore | null;
  /** Fetches provider pages for embedded posts: the Worker's own `fetch`. */
  readonly fetchRemote: Embeds.RemoteFetch;
  /** Whether sign-in codes and invites can reach anyone. */
  readonly emailEnabled: boolean;
  readonly adminPassword: string | undefined;
  readonly sendLoginCode: (email: string, code: string) => Promise<unknown>;
  readonly sendDocInvite: (invite: DocInvite) => Promise<EmailDelivery>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly now: () => number;
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });

const error = (status: number, code: string) => json({ error: code }, status);
const widgetInvalid = (problems: ReadonlyArray<WidgetProblem>) =>
  json({ error: "widget_invalid", problems }, 422);

const tableInvalid = (message: string) =>
  json({ error: "table_invalid", message }, 422);

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const str = (value: unknown, max = 200): string | null =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max
    ? value.trim()
    : null;

const MAX_MARKDOWN_LENGTH = 1_000_000;
/** One T3 Code environment's projects per sync call. */
const MAX_SYNCED_PROJECTS = 500;

/** `undefined` when absent, null for "no project", a string id, or `false` when malformed. */
function projectIdArg(value: unknown): string | null | undefined | false {
  if (value === undefined || value === null) return value;
  return str(value) ?? false;
}

function syncedProjects(
  value: unknown,
): ReadonlyArray<{ readonly key: string; readonly name: string }> | null {
  if (!Array.isArray(value) || value.length > MAX_SYNCED_PROJECTS) return null;
  const byKey = new Map<string, string>();
  for (const entry of value as Array<unknown>) {
    if (!entry || typeof entry !== "object") return null;
    const fields = entry as Record<string, unknown>;
    const key =
      typeof fields.key === "string" ? normalizeProjectKey(fields.key) : null;
    const name = str(fields.name);
    if (!key || !name) return null;
    // Two checkouts of one repository share a key; the last title wins.
    byKey.set(key, name);
  }
  return [...byKey].map(([key, name]) => ({ key, name }));
}

/**
 * Cookies are SameSite=None so the app works inside T3 Code's iframe, which
 * means the browser attaches them to cross-site requests too. Cookie-authed
 * mutations must come from this origin, and POSTs must be JSON, which a
 * cross-site form cannot send without a CORS preflight we never grant. Bearer
 * tokens are not ambient credentials and skip the check.
 */
const isOwnOrigin = (origin: string, request: Request, deps: ApiDeps) =>
  origin === deps.publicOrigin || origin === new URL(request.url).origin;

function isSameOriginWrite(request: Request, deps: ApiDeps): boolean {
  const origin = request.headers.get("Origin");
  if (origin !== null && !isOwnOrigin(origin, request, deps)) return false;
  if (request.method !== "POST") return true;
  const type = request.headers.get("Content-Type") ?? "";
  // Image uploads send raw bytes; image types are not CORS-safelisted either.
  return (
    type.startsWith("application/json") || Object.hasOwn(IMAGE_TYPES, type)
  );
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** What an image import needs: never fetch this app's own hosts. */
export function importDeps(
  deps: ApiDeps,
  requestUrl: string,
): ImageImport.ImportDeps {
  const ownHosts = new Set(
    [deps.publicOrigin, requestUrl].map((origin) =>
      new URL(origin).hostname.toLowerCase(),
    ),
  );
  return {
    db: deps.db,
    images: deps.images,
    fetchRemote: deps.fetchRemote,
    now: deps.now,
    ownHosts,
  };
}

/**
 * `PUT /api/image-uploads/:token`: an agent sends one image file to the link
 * prepare_image_upload gave it. The token is the only credential; it works
 * once, for one doc, while its user is still an editor there.
 */
async function handleImageUploadLink(
  request: Request,
  token: string,
  deps: ApiDeps,
): Promise<Response> {
  if (request.method !== "PUT" && request.method !== "POST")
    return error(405, "method_not_allowed");
  const claim = await ImageImport.claimUploadToken(deps.db, {
    token,
    now: deps.now(),
  });
  if (!claim) return error(404, "upload_link_invalid");
  try {
    await Access.requireDocRole(deps.db, claim.docId, claim.userId, "editor");
  } catch (cause) {
    if (
      cause instanceof Docs.NotFoundError ||
      cause instanceof Access.ForbiddenError
    ) {
      return error(403, "forbidden");
    }
    throw cause;
  }
  const result = await Images.uploadImage(deps.images, {
    docId: claim.docId,
    request,
  });
  if (!result.ok) {
    await claim.release();
    return error(result.status, result.error);
  }
  return json(
    { url: result.url, markdown: ImageImport.imageMarkdown(result.url, "") },
    201,
  );
}

/**
 * `PATCH /api/projects/:id` renames, `POST /api/projects/:id/move-docs` moves
 * every doc, diagram and sheet to `projectId` (null for no project), and `DELETE`
 * removes an empty project. A project with docs is never deleted with them.
 */
async function handleProject(
  request: Request,
  route: {
    readonly id: string;
    readonly sub: string | undefined;
    readonly method: string;
    readonly segments: ReadonlyArray<string>;
  },
  deps: ApiDeps,
): Promise<Response | null> {
  const { id, sub, method } = route;
  if (!sub && method === "PATCH") {
    const name = str((await readJson(request)).name);
    if (!name) return error(400, "invalid_name");
    return json({
      project: await Docs.renameProject(deps.db, { projectId: id, name }),
    });
  }
  if (sub === "move-docs" && route.segments.length === 3 && method === "POST") {
    const body = await readJson(request);
    const projectId = projectIdArg(body.projectId);
    if (projectId === false || projectId === undefined)
      return error(400, "invalid_project");
    if (projectId === id) return error(400, "same_project");
    if (projectId !== null) await Docs.getProject(deps.db, projectId);
    const origin = str(body.clientId);
    const docIds = await Docs.projectDocIds(deps.db, id);
    // Through each DocRoom, so pages open on a moved doc hear about it.
    for (const docId of docIds)
      await deps.rooms.setDocProject(docId, { projectId, origin });
    await Diagrams.moveProjectDiagrams(deps.db, { from: id, to: projectId });
    await Sheets.moveProjectSheets(deps.db, { from: id, to: projectId });
    return json({ moved: docIds.length });
  }
  if (!sub && method === "DELETE") {
    await Docs.deleteEmptyProject(deps.db, id);
    return json({ ok: true });
  }
  return null;
}

export async function handleApi(
  request: Request,
  deps: ApiDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;
  const now = deps.now();

  if (path.startsWith("/api/auth/")) return handleAuth(request, path, deps);
  const uploadLink = /^\/api\/image-uploads\/([^/]+)$/.exec(path);
  if (uploadLink) return handleImageUploadLink(request, uploadLink[1]!, deps);

  const principal = await Auth.authenticate(deps.db, request, {
    owners: deps.owners,
    now,
  });
  if (!principal) return error(401, "unauthorized");
  const need = (docId: string, role: DocRole) =>
    Access.requireDocRole(deps.db, docId, principal.userId, role);

  const segments = path.split("/").slice(2); // drop "", "api"
  const [resource, id, sub, subId] = segments;

  // Socket handshakes carry the SameSite=None cookie cross-site too, so a
  // cookie-authed socket must come from this origin.
  if (resource === "docs" && id && sub === "ws" && method === "GET") {
    const origin = request.headers.get("Origin");
    if (
      principal.kind === "session" &&
      origin !== null &&
      !isOwnOrigin(origin, request, deps)
    ) {
      return error(403, "forbidden_origin");
    }
    if (request.headers.get("Upgrade") !== "websocket")
      return error(426, "expected_websocket");
    try {
      // Sockets only receive; every role may listen, and writes are checked on REST.
      await need(id, "viewer");
    } catch (cause) {
      if (cause instanceof Docs.NotFoundError) return error(404, "not_found");
      throw cause;
    }
    return deps.rooms.openSocket(id, request, principal.userId);
  }

  if (resource === "sheets" && id && sub === "ws" && segments.length === 3 && method === "GET") {
    const origin = request.headers.get("Origin");
    if (principal.kind === "session" && origin !== null && !isOwnOrigin(origin, request, deps)) {
      return error(403, "forbidden_origin");
    }
    if (request.headers.get("Upgrade") !== "websocket") return error(426, "expected_websocket");
    if (!isSheetId(id)) return error(404, "not_found");
    try {
      await Sheets.requireSheet(deps.db, { sheetId: id, userId: principal.userId });
    } catch (cause) {
      if (cause instanceof Docs.NotFoundError) return error(404, "not_found");
      throw cause;
    }
    return deps.sheetRooms.openSocket(id, request, principal.userId);
  }

  if (
    principal.kind === "session" &&
    !SAFE_METHODS.has(method) &&
    !isSameOriginWrite(request, deps)
  ) {
    return error(403, "forbidden_origin");
  }

  try {
    if (path === "/api/me" && method === "GET") {
      return json(await Access.getMe(deps.db, principal.userId, deps.owners));
    }

    if (path === "/api/me" && method === "PATCH") {
      const body = await readJson(request);
      const name = typeof body.name === "string" ? body.name.trim() : null;
      if (name === null || name.length > 100) return error(400, "invalid_name");
      await Access.setUserName(deps.db, principal.userId, name);
      return json(await Access.getMe(deps.db, principal.userId, deps.owners));
    }

    if (path === "/api/people" && method === "GET") {
      return json({
        people: await Access.listPeople(deps.db, principal.userId, deps.owners),
      });
    }

    if (resource === "tokens") {
      // A leaked agent token must not be able to mint or revoke tokens.
      if (principal.kind !== "session") return error(403, "session_required");
      const userId = principal.userId;
      if (!id && method === "GET") {
        return json({ tokens: await Auth.listApiTokens(deps.db, userId) });
      }
      if (!id && method === "POST") {
        const body = await readJson(request);
        const name = str(body.name, 100);
        if (!name) return error(400, "invalid_name");
        return json(
          await Auth.createApiToken(deps.db, { name, userId, now }),
          201,
        );
      }
      if (id && method === "DELETE") {
        return (await Auth.revokeApiToken(deps.db, { id, userId, now }))
          ? json({ ok: true })
          : error(404, "not_found");
      }
    }

    if (path === "/api/library" && method === "GET") {
      const library = Access.scopeLibrary(deps.db, {
        library: Docs.listLibrary(deps.db),
        userId: principal.userId,
        owners: deps.owners,
      });
      return json(await Home.homeLibrary(deps.db, library, principal.userId));
    }

    if (path === "/api/search" && method === "GET") {
      const query = (url.searchParams.get("q") ?? "").trim();
      if (query.length < SEARCH_MIN_QUERY || query.length > SEARCH_MAX_QUERY) {
        return error(400, "invalid_query");
      }
      return json({
        hits: await Home.searchTabs(deps.db, {
          userId: principal.userId,
          query,
        }),
      });
    }

    if (path === "/api/projects" && method === "POST") {
      if (!Access.isAdmin(principal.userId)) return error(403, "forbidden");
      const body = await readJson(request);
      const name = str(body.name);
      if (!name) return error(400, "invalid_name");
      if (body.key === undefined) {
        return json(
          { project: await Docs.createProject(deps.db, name, now) },
          201,
        );
      }
      const key =
        typeof body.key === "string" ? normalizeProjectKey(body.key) : null;
      if (!key) return error(400, "invalid_key");
      return json(
        { project: await Docs.ensureProject(deps.db, { key, name, now }) },
        201,
      );
    }

    // T3 Code upserts its environment's projects here, so every machine converges on one list.
    if (path === "/api/projects/sync" && method === "POST") {
      if (!Access.isAdmin(principal.userId)) return error(403, "forbidden");
      const projects = syncedProjects((await readJson(request)).projects);
      if (!projects) return error(400, "invalid_projects");
      const synced = await Docs.syncProjects(deps.db, projects, now);
      return json({
        projects: synced.map(({ id, key, name }) => ({ id, key, name })),
      });
    }

    // Project housekeeping from Settings. Admin only, like creating projects.
    if (resource === "projects" && id && id !== "sync") {
      if (!Access.isAdmin(principal.userId)) return error(403, "forbidden");
      const response = await handleProject(
        request,
        { id, sub, method, segments },
        deps,
      );
      if (response) return response;
    }

    if (path === "/api/docs" && method === "POST") {
      const body = await readJson(request);
      const projectId = projectIdArg(body.projectId);
      const title = str(body.title);
      const group = docGroupArg(body.group);
      if (projectId === false || !title || group === false)
        return error(400, "invalid_doc");
      if (
        projectId &&
        !(await Access.canSeeProject(deps.db, projectId, principal.userId))
      ) {
        return error(404, "not_found");
      }
      const ownerId = principal.userId;
      return json(
        await Docs.createDoc(deps.db, {
          projectId: projectId ?? null,
          title,
          ownerId,
          now,
          group: group ?? null,
        }),
        201,
      );
    }

    if (resource === "docs" && id && !sub && method === "GET") {
      const role = await need(id, "viewer");
      // Agents read docs all the time; only a person opening one moves "Opened".
      if (principal.kind === "session") {
        await Home.recordOpen(deps.db, {
          docId: id,
          userId: principal.userId,
          now,
        });
      }
      const owner = await Access.docOwner(deps.db, id, deps.owners);
      return json({ ...(await Docs.getDoc(deps.db, id)), role, owner });
    }

    if (resource === "docs" && id && sub === "members") {
      const response = await handleMembers(
        request,
        { id, subId, method, principal },
        deps,
      );
      if (response) return response;
    }

    if (resource === "docs" && id && !sub && method === "PATCH") {
      await need(id, "editor");
      const body = await readJson(request);
      const origin = str(body.clientId);
      if (body.title !== undefined) {
        const title = str(body.title);
        if (!title) return error(400, "invalid_title");
        if (body.status !== undefined || body.projectId !== undefined) {
          return error(400, "one_change_at_a_time");
        }
        return json({ doc: await deps.rooms.renameDoc(id, { title, origin }) });
      }
      if (body.group !== undefined) {
        const group = docGroupArg(body.group);
        if (group === false || group === undefined)
          return error(400, "invalid_group");
        if (body.status !== undefined || body.projectId !== undefined) {
          return error(400, "one_change_at_a_time");
        }
        return json({
          doc: await deps.rooms.setDocGroup(id, { group, origin }),
        });
      }
      const status = body.status;
      if (status !== undefined && !DOC_STATUSES.includes(status as DocStatus)) {
        return error(400, "invalid_status");
      }
      const projectId = projectIdArg(body.projectId);
      if (projectId === false) return error(400, "invalid_project");
      if (status === undefined && projectId === undefined)
        return error(400, "empty_write");
      let doc: DocSummary | undefined;
      if (projectId !== undefined) {
        if (
          projectId &&
          !(await Access.canSeeProject(deps.db, projectId, principal.userId))
        ) {
          return error(404, "not_found");
        }
        doc = await deps.rooms.setDocProject(id, { projectId, origin });
      }
      if (status !== undefined) {
        doc = await deps.rooms.setDocStatus(id, {
          status: status as DocStatus,
          origin,
        });
      }
      return json({ doc });
    }

    if (resource === "docs" && id && !sub && method === "DELETE") {
      await need(id, "owner");
      await deps.rooms.deleteDoc(id, {
        origin: url.searchParams.get("clientId"),
      });
      deps.waitUntil(deps.images.deletePrefix(Images.docImagesPrefix(id)));
      if (deps.videos)
        deps.waitUntil(deps.videos.deletePrefix(Videos.docVideosPrefix(id)));
      return json({ ok: true });
    }

    if (
      resource === "docs" &&
      id &&
      sub === "images" &&
      !subId &&
      method === "POST"
    ) {
      await need(id, "editor");
      const result = await Images.uploadImage(deps.images, {
        docId: id,
        request,
      });
      return result.ok
        ? json({ url: result.url }, 201)
        : error(result.status, result.error);
    }

    // Copies an image link into the doc (a pasted link, or one already in it).
    if (
      resource === "docs" &&
      id &&
      sub === "images" &&
      subId === "import" &&
      method === "POST"
    ) {
      await need(id, "editor");
      const body = await readJson(request);
      if (typeof body.url !== "string") return error(400, "invalid_url");
      const result = await ImageImport.importImage(
        importDeps(deps, request.url),
        {
          docId: id,
          link: body.url,
        },
      );
      if (result.ok) return json({ url: result.src }, 201);
      return error(
        result.error === "too_many_imports" ? 429 : 422,
        result.error,
      );
    }

    if (resource === "images" && id && sub && !subId && method === "GET") {
      if (!isImageDocId(id)) return error(404, "not_found");
      await need(id, "viewer");
      return (
        (await Images.imageResponse(deps.images, { docId: id, file: sub })) ??
        error(404, "not_found")
      );
    }

    // The doc's saved copy of an embedded post, taken on first request.
    // Any reader may ask for a missing copy; only an editor may retake one.
    if (
      resource === "docs" &&
      id &&
      sub === "embeds" &&
      !subId &&
      method === "POST"
    ) {
      const body = await readJson(request);
      const target = typeof body.url === "string" ? matchEmbed(body.url) : null;
      if (!target) return error(400, "embed_unsupported");
      const refresh = body.refresh === true;
      await need(id, refresh ? "editor" : "viewer");
      const result = await Embeds.loadEmbed(
        {
          db: deps.db,
          images: deps.images,
          fetchRemote: deps.fetchRemote,
          now: deps.now,
        },
        { docId: id, target, refresh },
      );
      return result.ok
        ? json({ embed: result.snapshot })
        : error(result.status, result.error);
    }

    if (resource === "docs" && id && sub === "videos" && segments.length <= 4) {
      const response = await handleVideoUpload(
        request,
        { id, file: subId, method, url },
        deps,
        need,
      );
      if (response) return response;
    }

    if (
      resource === "videos" &&
      id &&
      sub &&
      segments.length === 3 &&
      SAFE_METHODS.has(method)
    ) {
      if (!isImageDocId(id)) return error(404, "not_found");
      await need(id, "viewer");
      const served = deps.videos
        ? await Videos.videoResponse(deps.videos, {
            docId: id,
            file: sub,
            request,
          })
        : null;
      return served ?? error(404, "not_found");
    }

    if (resource === "docs" && id && sub === "threads") {
      const response = await handleDocThreads(
        request,
        { id, subId, method, url, principal },
        deps,
      );
      if (response) return response;
    }

    if (resource === "docs" && id && sub === "export.md" && method === "GET") {
      await need(id, "viewer");
      const doc = await Docs.getDoc(deps.db, id);
      const diagrams = await linkedDiagrams(deps.db, doc.tabs, principal.userId);
      return Export.markdownResponse(
        Export.docMarkdown(doc, deps.publicOrigin, diagrams),
        doc.doc.title,
      );
    }

    if (
      resource === "docs" &&
      id &&
      sub === "export.docx" &&
      method === "GET"
    ) {
      await need(id, "viewer");
      const doc = await Docs.getDoc(deps.db, id);
      return docxResponse({
        title: doc.doc.title,
        markdown: Export.docSourceMarkdown(doc),
        docUrl: `${deps.publicOrigin}/d/${id}`,
        diagrams: await linkedDiagrams(deps.db, doc.tabs, principal.userId),
      });
    }

    if (resource === "docs" && id && sub === "tabs" && method === "POST") {
      const body = await readJson(request);
      const title = str(body.title) ?? "Untitled";
      const parentTabId =
        body.parentTabId === undefined ? null : body.parentTabId;
      if (parentTabId !== null && typeof parentTabId !== "string") {
        return error(400, "invalid_parent");
      }
      const markdown = typeof body.markdown === "string" ? body.markdown : "";
      if (markdown.length > MAX_MARKDOWN_LENGTH) return error(413, "too_large");
      await need(id, "editor");
      const problems = widgetProblems(markdown);
      if (problems) return widgetInvalid(problems);
      const tableProblem = checkTablesIn(markdown);
      if (tableProblem) return tableInvalid(tableProblem);
      const tab = await deps.rooms.createTab(id, {
        parentTabId,
        title,
        markdown,
        origin: str(body.clientId),
      });
      return json({ tab }, 201);
    }

    if (resource === "tabs" && id && !sub && method === "GET") {
      const tab = await Docs.getTab(deps.db, id);
      await need(tab.docId, "viewer");
      return json({ tab });
    }

    if (resource === "tabs" && id && sub === "export.md" && method === "GET") {
      const tab = await Docs.getTab(deps.db, id);
      await need(tab.docId, "viewer");
      const diagrams = await linkedDiagrams(deps.db, [tab], principal.userId);
      return Export.markdownResponse(
        Export.tabMarkdown(tab, deps.publicOrigin, diagrams),
        tab.title,
      );
    }

    if (
      resource === "tabs" &&
      id &&
      sub === "export.docx" &&
      method === "GET"
    ) {
      const tab = await Docs.getTab(deps.db, id);
      await need(tab.docId, "viewer");
      return docxResponse({
        title: tab.title,
        markdown: Export.tabSourceMarkdown(tab),
        docUrl: `${deps.publicOrigin}/d/${tab.docId}/${tab.id}`,
        diagrams: await linkedDiagrams(deps.db, [tab], principal.userId),
      });
    }

    if (resource === "tabs" && id && !sub && method === "PATCH") {
      const body = await readJson(request);
      const baseVersion = body.baseVersion;
      if (typeof baseVersion !== "number" || !Number.isInteger(baseVersion)) {
        return error(400, "invalid_base_version");
      }
      const markdown =
        typeof body.markdown === "string" ? body.markdown : undefined;
      if (markdown !== undefined && markdown.length > MAX_MARKDOWN_LENGTH) {
        return error(413, "too_large");
      }
      const title = body.title === undefined ? undefined : str(body.title);
      if (title === null) return error(400, "invalid_title");
      if (markdown === undefined && title === undefined)
        return error(400, "empty_write");
      const current = await Docs.getTab(deps.db, id);
      await need(current.docId, "editor");
      const problems =
        markdown === undefined
          ? null
          : widgetProblems(markdown, current.markdown);
      if (problems) return widgetInvalid(problems);
      const tableProblem =
        markdown === undefined
          ? null
          : checkTablesIn(markdown, current.markdown);
      if (tableProblem) return tableInvalid(tableProblem);
      const result = await deps.rooms.writeTab(current.docId, {
        tabId: id,
        baseVersion,
        ...(markdown === undefined ? {} : { markdown }),
        ...(title === undefined ? {} : { title }),
        origin: str(body.clientId),
      });
      return result.ok
        ? json({ tab: result.tab })
        : json({ error: "version_conflict", tab: result.conflict }, 409);
    }

    if (resource === "tabs" && id && sub === "move" && method === "POST") {
      const body = await readJson(request);
      const parentTabId =
        body.parentTabId === undefined ? null : body.parentTabId;
      if (parentTabId !== null && typeof parentTabId !== "string") {
        return error(400, "invalid_parent");
      }
      const position = body.position;
      if (
        typeof position !== "number" ||
        !Number.isInteger(position) ||
        position < 0
      ) {
        return error(400, "invalid_position");
      }
      const current = await Docs.getTab(deps.db, id);
      await need(current.docId, "editor");
      const placements = await deps.rooms.moveTab(current.docId, {
        tabId: id,
        parentTabId,
        position,
        origin: str(body.clientId),
      });
      return json({ placements });
    }

    if (resource === "tabs" && id && !sub && method === "DELETE") {
      const current = await Docs.getTab(deps.db, id);
      await need(current.docId, "editor");
      const tabIds = await deps.rooms.deleteTab(current.docId, {
        tabId: id,
        origin: url.searchParams.get("clientId"),
      });
      return json({ tabIds });
    }

    if (resource === "diagrams" && segments.length <= 3) {
      const response = await handleDiagrams(
        request,
        { id, sub, method, url, principal },
        deps,
      );
      if (response) return response;
    }

    if (resource === "sheets" && segments.length <= 3) {
      const response = await handleSheets(request, { id, sub, method, url, principal }, deps);
      if (response) return response;
    }

    if (resource === "diagram-comments" && id && segments.length === 3) {
      const response = await handleDiagramComment(request, { id, sub, principal }, deps);
      if (response) return response;
    }

    const response = await handleComments(
      request,
      { resource, id, sub, method, url, principal },
      deps,
    );
    if (response) return response;

    return error(404, "not_found");
  } catch (cause) {
    if (cause instanceof Docs.NotFoundError) return error(404, "not_found");
    if (cause instanceof Diagrams.DiagramForbiddenError)
      return error(403, "forbidden");
    if (cause instanceof Diagrams.InvalidDiagramError) {
      const tooLarge = cause.code === "too_large";
      return json(
        {
          error: tooLarge ? "diagram_too_large" : cause.code,
          message: cause.message,
        },
        tooLarge ? 413 : 400,
      );
    }
    if (cause instanceof DiagramComments.InvalidDiagramCommentError) {
      return json({ error: cause.code, message: cause.message }, 400);
    }
    if (cause instanceof Access.ForbiddenError) {
      return json({ error: "forbidden", required: cause.required }, 403);
    }
    if (cause instanceof Access.LastOwnerError) return error(409, "last_owner");
    if (cause instanceof Access.SelfShareError) return error(409, "self");
    if (cause instanceof Access.ReservedEmailError)
      return error(400, "invalid_email");
    if (cause instanceof Docs.InvalidMoveError)
      return error(400, "invalid_move");
    if (cause instanceof Docs.LastTabError) return error(409, "last_tab");
    if (cause instanceof Docs.ProjectNotEmptyError)
      return error(409, "project_not_empty");
    throw cause;
  }
}

/** One page's `{svg, png}` from a picture upload: the SVG text and the PNG in base64. */
function pagePictureArg(value: unknown): Diagrams.PagePictureUpload | null {
  if (!value || typeof value !== "object") return null;
  const { svg, png } = value as { readonly svg?: unknown; readonly png?: unknown };
  if (typeof svg !== "string" || (png != null && typeof png !== "string")) return null;
  if (typeof png !== "string") return { svg, png: null };
  try {
    return { svg, png: Uint8Array.fromBase64(png).buffer as ArrayBuffer };
  } catch {
    return null;
  }
}

const versionConflict = (conflict: { readonly version: number }) =>
  json({ error: "version_conflict", version: conflict.version, diagram: conflict }, 409);

/**
 * Draw.io diagrams, under `/api/diagrams`. Their creator and the admin list
 * and change them. Someone on a doc that shows one (`Diagrams.canViewDiagram`)
 * may fetch its picture and the diagram without its source, one at a time or
 * several by id. Returns null when the path is not one of these routes.
 */
async function handleDiagrams(
  request: Request,
  route: {
    readonly id: string | undefined;
    readonly sub: string | undefined;
    readonly method: string;
    readonly url: URL;
    readonly principal: Auth.Principal;
  },
  deps: ApiDeps,
): Promise<Response | null> {
  const { id, sub, method, url } = route;
  const userId = route.principal.userId;
  const now = deps.now();

  if (!id && method === "GET") {
    // `?ids=<id>,<id>`: an open page re-reading the diagrams it shows. Never their source.
    const ids = url.searchParams.get("ids");
    if (ids !== null) {
      const diagramIds = ids === "" ? [] : ids.split(",");
      if (diagramIds.length > MAX_DIAGRAM_REFRESH_IDS || !diagramIds.every(isDiagramId))
        return error(400, "invalid_ids");
      return json({ diagrams: await Diagrams.refreshDiagrams(deps.db, { diagramIds, userId }) });
    }
    // `?projectId=<id>` for one project, `?projectId=none` for diagrams in no project.
    const param = url.searchParams.get("projectId");
    const projectId = param === null ? undefined : param === "none" ? null : param;
    const [diagrams, uses, openComments] = await Promise.all([
      Diagrams.listDiagrams(deps.db, { userId, projectId }),
      Diagrams.diagramUsesById(deps.db, userId),
      DiagramComments.openThreadCounts(deps.db),
    ]);
    return json({
      diagrams: diagrams.map((diagram) => ({
        ...diagram,
        uses: uses.get(diagram.id) ?? [],
        openComments: openComments.get(diagram.id) ?? 0,
      })),
    });
  }

  if (!id && method === "POST") {
    const body = await readJson(request);
    const projectId = projectIdArg(body.projectId);
    const title =
      body.title === undefined
        ? DEFAULT_DIAGRAM_TITLE
        : str(body.title, MAX_DIAGRAM_TITLE_LENGTH);
    const xml = body.xml;
    if (projectId === false || !title || (xml !== undefined && typeof xml !== "string"))
      return error(400, "invalid_diagram");
    if (projectId && !(await Access.canSeeProject(deps.db, projectId, userId))) {
      return error(404, "not_found");
    }
    const diagram = await Diagrams.createDiagram(deps.db, {
      projectId: projectId ?? null,
      title,
      xml,
      createdBy: userId,
      now,
    });
    return json({ diagram: Diagrams.diagramView(diagram, true) }, 201);
  }

  if (!id) return null;
  if (!isDiagramId(id)) return error(404, "not_found");
  const need = (access: "view" | "edit") =>
    Diagrams.requireDiagram(deps.db, { diagramId: id, userId, need: access });

  // `picture.svg` is what people see, `picture.png` what agents are handed.
  const format = /^picture\.([a-z]+)$/.exec(sub ?? "")?.[1];
  if (isDiagramPictureFormat(format) && SAFE_METHODS.has(method)) {
    // `?page=<n>`: page n, counted from 0. Without it, the first page.
    const page = url.searchParams.get("page");
    const pageIndex = page === null ? 0 : /^(0|[1-9]\d{0,3})$/.test(page) ? Number(page) : -1;
    if (pageIndex < 0) return error(400, "invalid_page");
    const { diagram } = await need("view");
    return (
      (await Diagrams.diagramPictureResponse(deps.images, {
        diagram,
        format,
        request,
        pageIndex,
      })) ?? error(404, "not_found")
    );
  }

  // The pictures Draw.io drew in the browser, for the source at `version`: `svg`
  // and `png` for the first page, `pageNames` for every page and `morePages`
  // ({svg, png}) for the second page on. Without `pageNames`, the first page only.
  if (sub === "picture" && method === "PUT") {
    const body = await readJson(request);
    const { version } = body;
    if (typeof version !== "number" || !Number.isInteger(version))
      return error(400, "invalid_version");
    const pageNames = body.pageNames;
    const morePages = body.morePages ?? [];
    if (
      (pageNames != null &&
        (!Array.isArray(pageNames) ||
          !pageNames.every((name) => name === null || typeof name === "string"))) ||
      !Array.isArray(morePages)
    )
      return error(400, "invalid_picture");
    const pages: Array<Diagrams.PagePictureUpload> = [];
    for (const each of [body, ...morePages]) {
      const page = pagePictureArg(each);
      if (!page) return error(400, "invalid_picture");
      pages.push(page);
    }
    await need("edit");
    const result = await Diagrams.saveDiagramPicture(deps.db, deps.images, {
      diagramId: id,
      version,
      pages,
      pageNames: (pageNames as Array<string | null> | null | undefined) ?? null,
    });
    return result.ok ? json({ diagram: result.diagram }) : versionConflict(result.conflict);
  }

  // Comment threads: anyone who sees the diagram reads them; its managers start them.
  // `pages`: where each page's shapes sit, so pins follow their shapes. Not the source.
  if (sub === "comments" && method === "GET") {
    const { diagram } = await need("view");
    const [threads, pages] = await Promise.all([
      DiagramComments.listDiagramThreads(deps.db, id),
      readDrawioLayout(diagram.xml),
    ]);
    return json({ threads, pages: pages ?? [] });
  }

  if (sub === "comments" && method === "POST") {
    const body = await readJson(request);
    const text = str(body.body, MAX_DIAGRAM_COMMENT_LENGTH);
    if (!text) return error(400, "invalid_body");
    const { diagram } = await need("edit");
    const { anchor, quote } = await DiagramComments.resolveNewAnchor(diagram.xml, body.anchor);
    const thread = await DiagramComments.createDiagramThread(deps.db, {
      diagramId: id,
      anchor,
      quote,
      body: text,
      author: diagramCommentAuthor(route.principal),
      now,
    });
    return json({ thread }, 201);
  }

  if (sub === "uses" && method === "GET") {
    await need("edit");
    return json(await Diagrams.diagramUsage(deps.db, { diagramId: id, userId }));
  }

  if (sub) return null;

  if (method === "GET") {
    const { diagram, canEdit } = await need("view");
    return json({ diagram: Diagrams.diagramView(diagram, canEdit) });
  }

  if (method === "PATCH") {
    const body = await readJson(request);
    const title =
      body.title === undefined ? undefined : str(body.title, MAX_DIAGRAM_TITLE_LENGTH);
    if (title === null) return error(400, "invalid_title");
    const projectId = projectIdArg(body.projectId);
    if (projectId === false) return error(400, "invalid_project");
    const xml = body.xml;
    if (xml !== undefined && typeof xml !== "string") return error(400, "invalid_xml");
    const baseVersion = body.baseVersion;
    // A new source always says which version it was drawn from.
    if (
      baseVersion === undefined
        ? xml !== undefined
        : typeof baseVersion !== "number" || !Number.isInteger(baseVersion)
    ) {
      return error(400, "invalid_base_version");
    }
    if (title === undefined && projectId === undefined && xml === undefined)
      return error(400, "empty_write");
    await need("edit");
    if (projectId && !(await Access.canSeeProject(deps.db, projectId, userId))) {
      return error(404, "not_found");
    }
    const result = await Diagrams.updateDiagram(deps.db, {
      diagramId: id,
      title,
      projectId,
      xml,
      baseVersion: baseVersion as number | undefined,
      now,
    });
    return result.ok
      ? json({ diagram: Diagrams.diagramView(result.diagram, true) })
      : versionConflict(result.conflict);
  }

  if (method === "DELETE") {
    await need("edit");
    await Diagrams.deleteDiagram(deps.db, deps.images, id);
    return json({ ok: true });
  }

  return null;
}

/** Who writes a diagram comment: the signed-in person's email, or the token's agent. */
const diagramCommentAuthor = (principal: Auth.Principal) =>
  Comments.actorAuthor(
    principal.kind === "session"
      ? { kind: "person", email: principal.email }
      : { kind: "agent", name: principal.tokenName },
  );

/**
 * One diagram comment thread, under `/api/diagram-comments/:commentId`:
 * `POST .../replies` {body} answers it, `POST .../resolve` and `.../reopen`
 * change its state. Only the diagram's managers write. Null for other paths.
 */
async function handleDiagramComment(
  request: Request,
  route: {
    readonly id: string;
    readonly sub: string | undefined;
    readonly principal: Auth.Principal;
  },
  deps: ApiDeps,
): Promise<Response | null> {
  const method = request.method;
  if (method !== "POST" || !["replies", "resolve", "reopen"].includes(route.sub ?? "")) {
    return null;
  }
  const existing = await DiagramComments.getDiagramComment(deps.db, route.id);
  await Diagrams.requireDiagram(deps.db, {
    diagramId: existing.diagramId,
    userId: route.principal.userId,
    need: "edit",
  });
  const now = deps.now();
  if (route.sub === "replies") {
    const body = await readJson(request);
    const text = str(body.body, MAX_DIAGRAM_COMMENT_LENGTH);
    if (!text) return error(400, "invalid_body");
    const reply = await DiagramComments.replyDiagramThread(deps.db, {
      commentId: route.id,
      body: text,
      author: diagramCommentAuthor(route.principal),
      now,
    });
    const thread = await DiagramComments.getDiagramThread(deps.db, reply.id);
    return json({ reply, thread }, 201);
  }
  const thread = await DiagramComments.resolveDiagramThread(deps.db, {
    commentId: route.id,
    resolved: route.sub === "resolve",
    now,
  });
  return json({ thread });
}

/** `null` when the client sent none; `false` when malformed. */
function originArg(value: unknown): string | null | false {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && value.length <= MAX_ORIGIN_LENGTH ? value : false;
}

/**
 * Sheets, under `/api/sheets`. Their creator and the admin list, read, edit,
 * rename, move and delete them; anyone else gets 404. Edit lists go through
 * the sheet's room (`Sheets.applySheetEdits`), which orders them against
 * `base`. Returns null when the path is not one of these routes.
 */
async function handleSheets(
  request: Request,
  route: {
    readonly id: string | undefined;
    readonly sub: string | undefined;
    readonly method: string;
    readonly url: URL;
    readonly principal: Auth.Principal;
  },
  deps: ApiDeps,
): Promise<Response | null> {
  const { id, sub, method, url, principal } = route;
  const userId = principal.userId;

  if (!id && method === "GET") {
    // `?projectId=<id>` for one project, `?projectId=none` for sheets in no project.
    const param = url.searchParams.get("projectId");
    const projectId = param === null ? undefined : param === "none" ? null : param;
    return json({ sheets: await Sheets.listSheets(deps.db, { userId, projectId }) });
  }

  if (!id && method === "POST") {
    const body = await readJson(request);
    const projectId = projectIdArg(body.projectId);
    const title =
      body.title === undefined ? DEFAULT_SHEET_TITLE : str(body.title, MAX_SHEET_TITLE_LENGTH);
    if (projectId === false || !title) return error(400, "invalid_sheet");
    if (projectId && !(await Access.canSeeProject(deps.db, projectId, userId))) {
      return error(404, "not_found");
    }
    const created = await Sheets.createSheet(deps.db, {
      projectId: projectId ?? null,
      title,
      createdBy: userId,
      now: deps.now(),
    });
    return json(created, 201);
  }

  if (!id) return null;
  if (!isSheetId(id)) return error(404, "not_found");
  const need = () => Sheets.requireSheet(deps.db, { sheetId: id, userId });

  if (sub === "edits" && method === "POST") {
    const body = await readJson(request);
    const { base, edits } = body;
    if (typeof base !== "number" || !Number.isInteger(base) || base < 0)
      return error(400, "invalid_base");
    if (!Array.isArray(edits) || edits.length > MAX_EDITS_PER_LIST)
      return error(400, "invalid_edits");
    const origin = originArg(body.origin);
    if (origin === false) return error(400, "invalid_origin");
    await need();
    const result = await Sheets.applySheetEdits(deps.sheetRooms, id, {
      base,
      edits: edits as ReadonlyArray<Edit>,
      origin,
      by: await Sheets.sheetAuthor(deps.db, principal),
    });
    if (result.ok) return json({ revision: result.revision });
    return json(
      { error: "edits_refused", ...result.refusal, revision: result.revision },
      result.refusal.refusal === "baseIsNotTheRevision" ? 409 : 400,
    );
  }

  if (sub === "export.csv" && SAFE_METHODS.has(method)) {
    await need();
    const { sheet, records } = await Sheets.loadSheet(deps.db, id);
    const tab = Sheets.sheetCsv(workbookFromRecords(records), url.searchParams.get("tab"));
    if (!tab) return error(404, "unknown_tab");
    return new Response(tab.csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${Export.slugify(`${sheet.title} ${tab.name}`)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  if (sub) return null;

  if (method === "GET") {
    await need();
    return json(await Sheets.loadSheet(deps.db, id));
  }

  if (method === "PATCH") {
    const body = await readJson(request);
    const title =
      body.title === undefined ? undefined : str(body.title, MAX_SHEET_TITLE_LENGTH);
    if (title === null) return error(400, "invalid_title");
    const projectId = projectIdArg(body.projectId);
    if (projectId === false) return error(400, "invalid_project");
    if (title === undefined && projectId === undefined) return error(400, "empty_write");
    const origin = originArg(body.origin);
    if (origin === false) return error(400, "invalid_origin");
    await need();
    if (projectId && !(await Access.canSeeProject(deps.db, projectId, userId))) {
      return error(404, "not_found");
    }
    const sheet = await deps.sheetRooms.updateMeta(id, { title, projectId, origin });
    return json({ sheet });
  }

  if (method === "DELETE") {
    const origin = originArg(url.searchParams.get("origin"));
    if (origin === false) return error(400, "invalid_origin");
    await need();
    await deps.sheetRooms.deleteSheet(id, { origin });
    return json({ ok: true });
  }

  return null;
}

function videoParts(value: unknown): ReadonlyArray<Videos.VideoPart> | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_VIDEO_PARTS
  )
    return null;
  const parts: Array<Videos.VideoPart> = [];
  for (const [index, entry] of (value as Array<unknown>).entries()) {
    if (!entry || typeof entry !== "object") return null;
    const { partNumber, etag } = entry as Record<string, unknown>;
    if (partNumber !== index + 1 || typeof etag !== "string" || etag === "")
      return null;
    parts.push({ partNumber, etag });
  }
  return parts;
}

/** Uploading a video in parts; returns null when the method is not one of these routes. */
async function handleVideoUpload(
  request: Request,
  route: {
    readonly id: string;
    readonly file: string | undefined;
    readonly method: string;
    readonly url: URL;
  },
  deps: ApiDeps,
  need: (docId: string, role: DocRole) => Promise<DocRole>,
): Promise<Response | null> {
  const { id, file, method, url } = route;
  const routed = file
    ? ["PUT", "POST", "DELETE"].includes(method)
    : method === "POST";
  if (!routed) return null;
  await need(id, "editor");
  if (!deps.videos) return error(503, "video_storage_unavailable");

  if (!file) {
    const body = await readJson(request);
    const started = await Videos.startVideoUpload(deps.videos, {
      docId: id,
      type: body.type,
      size: body.size,
    });
    if (!started.ok) return error(started.status, started.error);
    const { file: name, uploadId, partBytes } = started;
    return json({ file: name, uploadId, partBytes }, 201);
  }

  if (!videoFileType(file)) return error(404, "not_found");
  const key = Videos.videoKey(id, file);

  if (method === "PUT") {
    const uploadId = url.searchParams.get("uploadId");
    const partNumber = Number(url.searchParams.get("part"));
    if (!uploadId) return error(400, "invalid_upload");
    if (
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > MAX_VIDEO_PARTS
    ) {
      return error(400, "invalid_part");
    }
    const length = Number(request.headers.get("Content-Length") ?? "0");
    if (length > VIDEO_PART_BYTES) return error(413, "too_large");
    if (!Number.isInteger(length) || length <= 0 || !request.body) {
      return error(400, "invalid_part");
    }
    const etag = await deps.videos.uploadPart(
      key,
      uploadId,
      partNumber,
      request.body,
    );
    return etag === null
      ? error(404, "upload_not_found")
      : json({ partNumber, etag });
  }

  if (method === "POST") {
    const body = await readJson(request);
    const uploadId = str(body.uploadId, 2048);
    const parts = videoParts(body.parts);
    if (!uploadId) return error(400, "invalid_upload");
    if (!parts) return error(400, "invalid_parts");
    const result = await Videos.completeVideoUpload(deps.videos, {
      docId: id,
      file,
      uploadId,
      parts,
    });
    return result.ok
      ? json({ url: result.url }, 201)
      : error(result.status, result.error);
  }

  const uploadId = url.searchParams.get("uploadId");
  if (!uploadId) return error(400, "invalid_upload");
  await deps.videos.abort(key, uploadId);
  return json({ ok: true });
}

/**
 * Threads started from a doc. Only an editor's session links or unlinks them:
 * links come from T3 Code's embed of this app, and an agent token has no
 * T3 Code thread of its own to vouch for.
 */
async function handleDocThreads(
  request: Request,
  route: {
    readonly id: string;
    readonly subId: string | undefined;
    readonly method: string;
    readonly url: URL;
    readonly principal: Auth.Principal;
  },
  deps: ApiDeps,
): Promise<Response | null> {
  const { id, subId, method } = route;
  if (!subId && method === "GET") {
    await Access.requireDocRole(deps.db, id, route.principal.userId, "viewer");
    return json({ threads: await DocThreads.listDocThreads(deps.db, id) });
  }
  if (method !== "POST" && method !== "DELETE") return null;
  if (route.principal.kind !== "session") return error(403, "session_required");
  await Access.requireDocRole(deps.db, id, route.principal.userId, "editor");

  if (!subId && method === "POST") {
    const body = await readJson(request);
    const environmentId = str(body.environmentId);
    const threadId = str(body.threadId);
    // Thread titles can run long; the label only needs a recognisable start.
    const title =
      typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
    if (!environmentId || !threadId || !title)
      return error(400, "invalid_thread");
    const threads = await deps.rooms.threadOp(id, {
      op: { kind: "link", environmentId, threadId, title },
      origin: str(body.clientId),
    });
    return json({ threads }, 201);
  }

  if (subId && method === "DELETE") {
    const threads = await deps.rooms.threadOp(id, {
      op: { kind: "unlink", linkId: subId },
      origin: route.url.searchParams.get("clientId"),
    });
    return json({ threads });
  }
  return null;
}

async function commentActor(
  deps: ApiDeps,
  principal: Auth.Principal,
  docId: string,
  minimum: DocRole,
): Promise<Comments.CommentActor> {
  const docRole = await Access.requireDocRole(
    deps.db,
    docId,
    principal.userId,
    minimum,
  );
  return principal.kind === "session"
    ? {
        kind: "person",
        email: principal.email,
        // A password session writes as ADMIN_SESSION_EMAIL, whatever OWNER_EMAILS says.
        emails: [
          ...(await Access.userEmails(deps.db, principal.userId, deps.owners)),
          ...(Access.isAdmin(principal.userId)
            ? [Access.ADMIN_SESSION_EMAIL]
            : []),
        ],
        docRole,
      }
    : { kind: "agent", name: principal.tokenName, docRole };
}

/** Exact text, not trimmed: anchors must match the tab character for character. */
const anchorText = (
  value: unknown,
  max: number,
  required: boolean,
): string | null => {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.length > max) return null;
  return required && value.trim().length === 0 ? null : value;
};

/** Comment routes; returns null when the path is not one of them. */
async function handleComments(
  request: Request,
  route: {
    readonly resource: string | undefined;
    readonly id: string | undefined;
    readonly sub: string | undefined;
    readonly method: string;
    readonly url: URL;
    readonly principal: Auth.Principal;
  },
  deps: ApiDeps,
): Promise<Response | null> {
  const { resource, id, sub, method, url } = route;
  const actorOn = (docId: string, minimum: DocRole) =>
    commentActor(deps, route.principal, docId, minimum);

  if (resource === "docs" && id && sub === "comments" && method === "GET") {
    await actorOn(id, "viewer");
    const tabId = url.searchParams.get("tabId") ?? undefined;
    return json({
      comments: await Comments.listComments(deps.db, { docId: id, tabId }),
    });
  }

  if (resource === "tabs" && id && sub === "comments" && method === "POST") {
    const body = await readJson(request);
    // A cell or label anchor; the quote then only labels the thread.
    const structured =
      body.anchor == null ? null : parseStructuredAnchor(body.anchor);
    if (body.anchor != null && structured === null)
      return error(400, "invalid_anchor");
    const quote = anchorText(
      body.quote,
      Comments.MAX_QUOTE_LENGTH,
      structured === null,
    );
    const prefix = anchorText(body.prefix, Comments.MAX_CONTEXT_LENGTH, false);
    const suffix = anchorText(body.suffix, Comments.MAX_CONTEXT_LENGTH, false);
    if (quote === null || prefix === null || suffix === null)
      return error(400, "invalid_anchor");
    const text = str(body.body, Comments.MAX_COMMENT_LENGTH);
    if (!text) return error(400, "invalid_body");
    const tab = await Docs.getTab(deps.db, id);
    const actor = await actorOn(tab.docId, "commenter");
    const target = structured
      ? resolveStructuredAnchor(tab.markdown, structured)
      : null;
    // A structured anchor must name a part that exists; there is no text to fall back on.
    if (structured && !target) return error(409, "anchor_not_found");
    // Imports ask for this so a comment whose passage is gone is reported, not stored detached.
    if (
      !structured &&
      body.requireAnchor === true &&
      !locateAnchor(markdownToText(tab.markdown), { quote, prefix, suffix })
    ) {
      return error(409, "anchor_not_found");
    }
    const result = await deps.rooms.commentOp(tab.docId, {
      op: {
        kind: "create",
        tabId: id,
        anchor: target
          ? {
              quote: Comments.structuredQuote(target, quote),
              prefix: "",
              suffix: "",
            }
          : { quote, prefix, suffix },
        structuredAnchor: structured,
        body: text,
        author: Comments.actorAuthor(actor),
      },
      origin: str(body.clientId),
    });
    return json(result, 201);
  }

  if (resource !== "comments" || !id) return null;
  const existing = await Comments.getComment(deps.db, id);
  const actor = await actorOn(existing.docId, "commenter");

  if (sub === "replies" && method === "POST") {
    const body = await readJson(request);
    const text = str(body.body, Comments.MAX_COMMENT_LENGTH);
    if (!text) return error(400, "invalid_body");
    const result = await deps.rooms.commentOp(existing.docId, {
      op: {
        kind: "reply",
        commentId: id,
        body: text,
        author: Comments.actorAuthor(actor),
      },
      origin: str(body.clientId),
    });
    return json(result, 201);
  }

  if (!sub && method === "PATCH") {
    if (!Comments.canEditComment(actor, existing))
      return error(403, "forbidden");
    const body = await readJson(request);
    const text = str(body.body, Comments.MAX_COMMENT_LENGTH);
    if (!text) return error(400, "invalid_body");
    const result = await deps.rooms.commentOp(existing.docId, {
      op: { kind: "edit", commentId: id, body: text },
      origin: str(body.clientId),
    });
    return json(result);
  }

  if ((sub === "resolve" || sub === "reopen") && method === "POST") {
    const body = await readJson(request);
    const result = await deps.rooms.commentOp(existing.docId, {
      op: { kind: "resolve", commentId: id, resolved: sub === "resolve" },
      origin: str(body.clientId),
    });
    return json(result);
  }

  if (!sub && method === "DELETE") {
    if (!Comments.canDeleteComment(actor, existing))
      return error(403, "forbidden");
    const result = await deps.rooms.commentOp(existing.docId, {
      op: { kind: "delete", commentId: id },
      origin: url.searchParams.get("clientId"),
    });
    return json(result);
  }

  return null;
}

const MAX_EMAIL_LENGTH = 320;

/** People on a doc. Any member sees the list; owners change it, and anyone may leave. */
async function handleMembers(
  request: Request,
  route: {
    readonly id: string;
    readonly subId: string | undefined;
    readonly method: string;
    readonly principal: Auth.Principal;
  },
  deps: ApiDeps,
): Promise<Response | null> {
  const { id, subId, method, principal } = route;
  const role = await Access.requireDocRole(
    deps.db,
    id,
    principal.userId,
    "viewer",
  );
  const members = () => Access.listMembers(deps.db, id, deps.owners);

  if (!subId && method === "GET") return json({ members: await members() });

  if (!subId && method === "POST") {
    if (role !== "owner") throw new Access.ForbiddenError("owner");
    const body = await readJson(request);
    const email = str(body.email, MAX_EMAIL_LENGTH);
    if (!email || !email.includes("@")) return error(400, "invalid_email");
    if (!isDocRole(body.role)) return error(400, "invalid_role");
    const { member, created } = await Access.shareDoc(deps.db, {
      docId: id,
      email,
      role: body.role,
      addedBy: principal.userId,
      owners: deps.owners,
      now: deps.now(),
    });
    // Awaited so the response can say whether the email went out.
    const emailDelivery = created
      ? await inviteByEmail(deps, { docId: id, to: member.email, principal })
      : null;
    return json(
      { member, members: await members(), emailDelivery },
      created ? 201 : 200,
    );
  }

  if (subId && method === "PATCH") {
    if (role !== "owner") throw new Access.ForbiddenError("owner");
    const body = await readJson(request);
    if (!isDocRole(body.role)) return error(400, "invalid_role");
    const member = await Access.setMemberRole(deps.db, {
      docId: id,
      memberId: subId,
      role: body.role,
      owners: deps.owners,
    });
    return json({ member, members: await members() });
  }

  if (subId && method === "DELETE") {
    const { userId } = await Access.removeMember(deps.db, {
      docId: id,
      memberId: subId,
      by: { userId: principal.userId, role },
    });
    if (userId) await deps.rooms.closeSockets(id, userId);
    return json({ members: await members() });
  }
  return null;
}

/** Tells a newly added person the doc is theirs to open. The share stands whatever this returns. */
export async function inviteByEmail(
  deps: ApiDeps,
  input: {
    readonly docId: string;
    readonly to: string;
    readonly principal: Auth.Principal;
  },
): Promise<EmailDelivery> {
  const [inviter, { doc, tabs }] = await Promise.all([
    Access.getUser(deps.db, input.principal.userId, deps.owners),
    Docs.getDoc(deps.db, input.docId),
  ]);
  const firstTab = tabs.find((tab) => tab.parentTabId === null);
  return deps.sendDocInvite({
    to: input.to,
    inviterName: inviter.name.trim() || inviter.email,
    docTitle: doc.title,
    url: `${deps.publicOrigin}/d/${doc.id}${firstTab ? `/${firstTab.id}` : ""}`,
  });
}

async function handleAuth(
  request: Request,
  path: string,
  deps: ApiDeps,
): Promise<Response> {
  if (path === "/api/auth/config" && request.method === "GET") {
    return json({
      emailEnabled: deps.emailEnabled,
      passwordEnabled: Auth.isUsableAdminPassword(deps.adminPassword),
    });
  }
  if (request.method !== "POST") return error(405, "method_not_allowed");
  if (!isSameOriginWrite(request, deps)) return error(403, "forbidden_origin");
  const body = await readJson(request);
  const now = deps.now();

  if (path === "/api/auth/request-code") {
    const email = str(body.email, 320);
    if (!email) return error(400, "invalid_email");
    // Answers the same for every address, so it reveals nothing about who has access.
    if (!deps.emailEnabled) return error(503, "email_not_configured");
    const code = await Auth.issueLoginCode(deps.db, {
      email,
      owners: deps.owners,
      now,
    });
    // Delivery happens after the response so owners and strangers answer alike.
    if (code)
      deps.waitUntil(deps.sendLoginCode(Auth.normalizeEmail(email), code));
    return json({ ok: true });
  }

  if (path === "/api/auth/verify") {
    const email = str(body.email, 320);
    const code = str(body.code, 12);
    if (!email || !code) return error(401, "invalid_code");
    const token = await Auth.verifyLoginCode(deps.db, {
      email,
      code,
      owners: deps.owners,
      now,
    });
    if (!token) return error(401, "invalid_code");
    return json({ email: Auth.normalizeEmail(email) }, 200, {
      "Set-Cookie": Auth.sessionCookie(token, Auth.SESSION_TTL_MS),
    });
  }

  if (path === "/api/auth/password") {
    if (!Auth.isUsableAdminPassword(deps.adminPassword)) {
      return error(503, "password_not_configured");
    }
    // Not `str`: a password is compared exactly, spaces included.
    const candidate = typeof body.password === "string" ? body.password : "";
    if (!candidate) return error(401, "invalid_password");
    const result = await Auth.verifyAdminPassword(deps.db, {
      password: deps.adminPassword,
      candidate,
      now,
    });
    if (!result.ok) {
      return result.locked
        ? error(429, "too_many_attempts")
        : error(401, "invalid_password");
    }
    return json({ email: Access.ADMIN_SESSION_EMAIL }, 200, {
      "Set-Cookie": Auth.sessionCookie(result.token, Auth.SESSION_TTL_MS),
    });
  }

  if (path === "/api/auth/logout") {
    const token = Auth.readCookie(request, Auth.SESSION_COOKIE);
    if (token) await Auth.deleteSession(deps.db, token);
    return json({ ok: true }, 200, { "Set-Cookie": Auth.sessionCookie("", 0) });
  }

  return error(404, "not_found");
}
