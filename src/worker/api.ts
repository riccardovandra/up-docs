import {
  DOC_STATUSES,
  type DocStatus,
  type DocSummary,
  type DocThreadLink,
  type Tab,
  type TabPlacement,
} from "../shared/protocol.ts";
import { isDocRole, type DocRole } from "../shared/access.ts";
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
import * as Home from "./home.ts";
import * as Images from "./images.ts";
import { IMAGE_TYPES, isImageDocId } from "../shared/images.ts";
import { widgetProblems } from "./widgets.ts";
import { checkTablesIn } from "../shared/table.ts";

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
  deleteDoc(docId: string, input: { readonly origin: string | null }): Promise<void>;
  setDocProject(
    docId: string,
    input: { readonly projectId: string | null; readonly origin: string | null },
  ): Promise<DocSummary>;
  commentOp(
    docId: string,
    input: { readonly op: Comments.CommentOp; readonly origin: string | null },
  ): Promise<Comments.CommentOpResult>;
  threadOp(
    docId: string,
    input: { readonly op: DocThreads.DocThreadOp; readonly origin: string | null },
  ): Promise<ReadonlyArray<DocThreadLink>>;
  /** `userId` tags the socket so removing that person from the doc can close it. */
  openSocket(docId: string, request: Request, userId: string): Promise<Response>;
  closeSockets(docId: string, userId: string): Promise<void>;
}

export interface ApiDeps {
  readonly db: D1Database;
  /**
   * The app's public origin, for URLs handed out and the same-origin check.
   * `wrangler dev` rewrites request.url to the custom domain, so the request
   * cannot tell us where the app is really served from.
   */
  readonly publicOrigin: string;
  readonly owners: ReadonlySet<string>;
  readonly rooms: DocRooms;
  readonly images: Images.ImageStore;
  readonly sendLoginCode: (email: string, code: string) => Promise<void>;
  readonly sendDocInvite: (invite: DocInvite) => Promise<void>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly now: () => number;
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

const error = (status: number, code: string) => json({ error: code }, status);
const widgetInvalid = (problems: ReadonlyArray<WidgetProblem>) =>
  json({ error: "widget_invalid", problems }, 422);

const tableInvalid = (message: string) => json({ error: "table_invalid", message }, 422);

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (value: unknown, max = 200): string | null =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max ? value.trim() : null;

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
    const key = typeof fields.key === "string" ? normalizeProjectKey(fields.key) : null;
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
  return type.startsWith("application/json") || Object.hasOwn(IMAGE_TYPES, type);
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

export async function handleApi(request: Request, deps: ApiDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;
  const now = deps.now();

  if (path.startsWith("/api/auth/")) return handleAuth(request, path, deps);

  const principal = await Auth.authenticate(deps.db, request, { owners: deps.owners, now });
  if (!principal) return error(401, "unauthorized");
  const need = (docId: string, role: DocRole) =>
    Access.requireDocRole(deps.db, docId, principal.userId, role);

  const segments = path.split("/").slice(2); // drop "", "api"
  const [resource, id, sub, subId] = segments;

  // Socket handshakes carry the SameSite=None cookie cross-site too, so a
  // cookie-authed socket must come from this origin.
  if (resource === "docs" && id && sub === "ws" && method === "GET") {
    const origin = request.headers.get("Origin");
    if (principal.kind === "session" && origin !== null && !isOwnOrigin(origin, request, deps)) {
      return error(403, "forbidden_origin");
    }
    if (request.headers.get("Upgrade") !== "websocket") return error(426, "expected_websocket");
    try {
      // Sockets only receive; every role may listen, and writes are checked on REST.
      await need(id, "viewer");
    } catch (cause) {
      if (cause instanceof Docs.NotFoundError) return error(404, "not_found");
      throw cause;
    }
    return deps.rooms.openSocket(id, request, principal.userId);
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
      return json({ people: await Access.listPeople(deps.db, principal.userId, deps.owners) });
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
        return json(await Auth.createApiToken(deps.db, { name, userId, now }), 201);
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
      return json({ hits: await Home.searchTabs(deps.db, { userId: principal.userId, query }) });
    }

    if (path === "/api/projects" && method === "POST") {
      if (!Access.isAdmin(principal.userId)) return error(403, "forbidden");
      const body = await readJson(request);
      const name = str(body.name);
      if (!name) return error(400, "invalid_name");
      if (body.key === undefined) {
        return json({ project: await Docs.createProject(deps.db, name, now) }, 201);
      }
      const key = typeof body.key === "string" ? normalizeProjectKey(body.key) : null;
      if (!key) return error(400, "invalid_key");
      return json({ project: await Docs.ensureProject(deps.db, { key, name, now }) }, 201);
    }

    // T3 Code upserts its environment's projects here, so every machine converges on one list.
    if (path === "/api/projects/sync" && method === "POST") {
      if (!Access.isAdmin(principal.userId)) return error(403, "forbidden");
      const projects = syncedProjects((await readJson(request)).projects);
      if (!projects) return error(400, "invalid_projects");
      const synced = await Docs.syncProjects(deps.db, projects, now);
      return json({ projects: synced.map(({ id, key, name }) => ({ id, key, name })) });
    }

    if (path === "/api/docs" && method === "POST") {
      const body = await readJson(request);
      const projectId = projectIdArg(body.projectId);
      const title = str(body.title);
      if (projectId === false || !title) return error(400, "invalid_doc");
      if (projectId && !(await Access.canSeeProject(deps.db, projectId, principal.userId))) {
        return error(404, "not_found");
      }
      const ownerId = principal.userId;
      return json(
        await Docs.createDoc(deps.db, { projectId: projectId ?? null, title, ownerId, now }),
        201,
      );
    }

    if (resource === "docs" && id && !sub && method === "GET") {
      const role = await need(id, "viewer");
      // Agents read docs all the time; only a person opening one moves "Opened".
      if (principal.kind === "session") {
        await Home.recordOpen(deps.db, { docId: id, userId: principal.userId, now });
      }
      const owner = await Access.docOwner(deps.db, id, deps.owners);
      return json({ ...(await Docs.getDoc(deps.db, id)), role, owner });
    }

    if (resource === "docs" && id && sub === "members") {
      const response = await handleMembers(request, { id, subId, method, principal }, deps);
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
      const status = body.status;
      if (status !== undefined && !DOC_STATUSES.includes(status as DocStatus)) {
        return error(400, "invalid_status");
      }
      const projectId = projectIdArg(body.projectId);
      if (projectId === false) return error(400, "invalid_project");
      if (status === undefined && projectId === undefined) return error(400, "empty_write");
      let doc: DocSummary | undefined;
      if (projectId !== undefined) {
        if (projectId && !(await Access.canSeeProject(deps.db, projectId, principal.userId))) {
          return error(404, "not_found");
        }
        doc = await deps.rooms.setDocProject(id, { projectId, origin });
      }
      if (status !== undefined) {
        doc = await deps.rooms.setDocStatus(id, { status: status as DocStatus, origin });
      }
      return json({ doc });
    }

    if (resource === "docs" && id && !sub && method === "DELETE") {
      await need(id, "owner");
      await deps.rooms.deleteDoc(id, { origin: url.searchParams.get("clientId") });
      deps.waitUntil(deps.images.deletePrefix(Images.docImagesPrefix(id)));
      return json({ ok: true });
    }

    if (resource === "docs" && id && sub === "images" && !subId && method === "POST") {
      await need(id, "editor");
      const result = await Images.uploadImage(deps.images, { docId: id, request });
      return result.ok ? json({ url: result.url }, 201) : error(result.status, result.error);
    }

    if (resource === "images" && id && sub && !subId && method === "GET") {
      if (!isImageDocId(id)) return error(404, "not_found");
      await need(id, "viewer");
      return (
        (await Images.imageResponse(deps.images, { docId: id, file: sub })) ??
        error(404, "not_found")
      );
    }

    if (resource === "docs" && id && sub === "threads") {
      const response = await handleDocThreads(request, { id, subId, method, url, principal }, deps);
      if (response) return response;
    }

    if (resource === "docs" && id && sub === "export.md" && method === "GET") {
      await need(id, "viewer");
      const doc = await Docs.getDoc(deps.db, id);
      return Export.markdownResponse(Export.docMarkdown(doc), doc.doc.title);
    }

    if (resource === "docs" && id && sub === "export.docx" && method === "GET") {
      await need(id, "viewer");
      const doc = await Docs.getDoc(deps.db, id);
      return docxResponse({
        title: doc.doc.title,
        markdown: Export.docSourceMarkdown(doc),
        docUrl: `${deps.publicOrigin}/d/${id}`,
      });
    }

    if (resource === "docs" && id && sub === "tabs" && method === "POST") {
      const body = await readJson(request);
      const title = str(body.title) ?? "Untitled";
      const parentTabId = body.parentTabId === undefined ? null : body.parentTabId;
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
      return Export.markdownResponse(Export.tabMarkdown(tab), tab.title);
    }

    if (resource === "tabs" && id && sub === "export.docx" && method === "GET") {
      const tab = await Docs.getTab(deps.db, id);
      await need(tab.docId, "viewer");
      return docxResponse({
        title: tab.title,
        markdown: Export.tabSourceMarkdown(tab),
        docUrl: `${deps.publicOrigin}/d/${tab.docId}/${tab.id}`,
      });
    }

    if (resource === "tabs" && id && !sub && method === "PATCH") {
      const body = await readJson(request);
      const baseVersion = body.baseVersion;
      if (typeof baseVersion !== "number" || !Number.isInteger(baseVersion)) {
        return error(400, "invalid_base_version");
      }
      const markdown = typeof body.markdown === "string" ? body.markdown : undefined;
      if (markdown !== undefined && markdown.length > MAX_MARKDOWN_LENGTH) {
        return error(413, "too_large");
      }
      const title = body.title === undefined ? undefined : str(body.title);
      if (title === null) return error(400, "invalid_title");
      if (markdown === undefined && title === undefined) return error(400, "empty_write");
      const current = await Docs.getTab(deps.db, id);
      await need(current.docId, "editor");
      const problems = markdown === undefined ? null : widgetProblems(markdown, current.markdown);
      if (problems) return widgetInvalid(problems);
      const tableProblem =
        markdown === undefined ? null : checkTablesIn(markdown, current.markdown);
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
      const parentTabId = body.parentTabId === undefined ? null : body.parentTabId;
      if (parentTabId !== null && typeof parentTabId !== "string") {
        return error(400, "invalid_parent");
      }
      const position = body.position;
      if (typeof position !== "number" || !Number.isInteger(position) || position < 0) {
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

    const response = await handleComments(
      request,
      { resource, id, sub, method, url, principal },
      deps,
    );
    if (response) return response;

    return error(404, "not_found");
  } catch (cause) {
    if (cause instanceof Docs.NotFoundError) return error(404, "not_found");
    if (cause instanceof Access.ForbiddenError) {
      return json({ error: "forbidden", required: cause.required }, 403);
    }
    if (cause instanceof Access.LastOwnerError) return error(409, "last_owner");
    if (cause instanceof Access.SelfShareError) return error(409, "self");
    if (cause instanceof Docs.InvalidMoveError) return error(400, "invalid_move");
    if (cause instanceof Docs.LastTabError) return error(409, "last_tab");
    throw cause;
  }
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
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
    if (!environmentId || !threadId || !title) return error(400, "invalid_thread");
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
  const docRole = await Access.requireDocRole(deps.db, docId, principal.userId, minimum);
  return principal.kind === "session"
    ? {
        kind: "person",
        email: principal.email,
        emails: await Access.userEmails(deps.db, principal.userId, deps.owners),
        docRole,
      }
    : { kind: "agent", name: principal.tokenName, docRole };
}

/** Exact text, not trimmed: anchors must match the tab character for character. */
const anchorText = (value: unknown, max: number, required: boolean): string | null => {
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
    return json({ comments: await Comments.listComments(deps.db, { docId: id, tabId }) });
  }

  if (resource === "tabs" && id && sub === "comments" && method === "POST") {
    const body = await readJson(request);
    // A cell or label anchor; the quote then only labels the thread.
    const structured = body.anchor == null ? null : parseStructuredAnchor(body.anchor);
    if (body.anchor != null && structured === null) return error(400, "invalid_anchor");
    const quote = anchorText(body.quote, Comments.MAX_QUOTE_LENGTH, structured === null);
    const prefix = anchorText(body.prefix, Comments.MAX_CONTEXT_LENGTH, false);
    const suffix = anchorText(body.suffix, Comments.MAX_CONTEXT_LENGTH, false);
    if (quote === null || prefix === null || suffix === null) return error(400, "invalid_anchor");
    const text = str(body.body, Comments.MAX_COMMENT_LENGTH);
    if (!text) return error(400, "invalid_body");
    const tab = await Docs.getTab(deps.db, id);
    const actor = await actorOn(tab.docId, "commenter");
    const target = structured ? resolveStructuredAnchor(tab.markdown, structured) : null;
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
          ? { quote: Comments.structuredQuote(target, quote), prefix: "", suffix: "" }
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
      op: { kind: "reply", commentId: id, body: text, author: Comments.actorAuthor(actor) },
      origin: str(body.clientId),
    });
    return json(result, 201);
  }

  if (!sub && method === "PATCH") {
    if (!Comments.canEditComment(actor, existing)) return error(403, "forbidden");
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
    if (!Comments.canDeleteComment(actor, existing)) return error(403, "forbidden");
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
  const role = await Access.requireDocRole(deps.db, id, principal.userId, "viewer");
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
    if (created) deps.waitUntil(inviteByEmail(deps, { docId: id, to: member.email, principal }));
    return json({ member, members: await members() }, created ? 201 : 200);
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

/** Tells a newly added person the doc is theirs to open. Failures only log: the share stands. */
export async function inviteByEmail(
  deps: ApiDeps,
  input: { readonly docId: string; readonly to: string; readonly principal: Auth.Principal },
): Promise<void> {
  const [inviter, { doc, tabs }] = await Promise.all([
    Access.getUser(deps.db, input.principal.userId, deps.owners),
    Docs.getDoc(deps.db, input.docId),
  ]);
  const firstTab = tabs.find((tab) => tab.parentTabId === null);
  await deps.sendDocInvite({
    to: input.to,
    inviterName: inviter.name.trim() || inviter.email,
    docTitle: doc.title,
    url: `${deps.publicOrigin}/d/${doc.id}${firstTab ? `/${firstTab.id}` : ""}`,
  });
}

async function handleAuth(request: Request, path: string, deps: ApiDeps): Promise<Response> {
  if (request.method !== "POST") return error(405, "method_not_allowed");
  if (!isSameOriginWrite(request, deps)) return error(403, "forbidden_origin");
  const body = await readJson(request);
  const now = deps.now();

  if (path === "/api/auth/request-code") {
    const email = str(body.email, 320);
    if (!email) return error(400, "invalid_email");
    const code = await Auth.issueLoginCode(deps.db, { email, owners: deps.owners, now });
    // Delivery happens after the response so owners and strangers answer alike.
    if (code) deps.waitUntil(deps.sendLoginCode(Auth.normalizeEmail(email), code));
    return json({ ok: true });
  }

  if (path === "/api/auth/verify") {
    const email = str(body.email, 320);
    const code = str(body.code, 12);
    if (!email || !code) return error(401, "invalid_code");
    const token = await Auth.verifyLoginCode(deps.db, { email, code, owners: deps.owners, now });
    if (!token) return error(401, "invalid_code");
    return json({ email: Auth.normalizeEmail(email) }, 200, {
      "Set-Cookie": Auth.sessionCookie(token, Auth.SESSION_TTL_MS),
    });
  }

  if (path === "/api/auth/logout") {
    const token = Auth.readCookie(request, Auth.SESSION_COOKIE);
    if (token) await Auth.deleteSession(deps.db, token);
    return json({ ok: true }, 200, { "Set-Cookie": Auth.sessionCookie("", 0) });
  }

  return error(404, "not_found");
}
