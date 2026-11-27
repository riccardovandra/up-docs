// The agent bridge's two app routes, and what MCP tools reach the open editor
// through. Owner: S3.
//
// - `POST /api/designs/:id/agent-ticket` (session, editor role, from the app's
//   own origin): a one-use ticket in the socket address the design page hands
//   the editor (`load {socketURL}`, or `connect {socketURL}` to reconnect).
//   `{ifDisconnected: true}` answers `{connected: true}` instead while an
//   editor holds the socket, so a page polling it never steals it.
// - `GET /api/designs/:id/agent?ticket=...` (WebSocket): the editor's socket.
//   It is the one app path a request from the editor's origin may reach
//   (designerHost.ts), so it is kept narrow: exact path, GET, Upgrade, the
//   editor's Origin, and a ticket that the room spends. It never reads the
//   session cookie: the ticket is the only credential, and the cookie is
//   dropped before the request goes on.

import { designAgentSocketPath, isDesignAgentSocketPath, isDesignId } from "../shared/design.ts";
import * as Auth from "./auth.ts";
import {
  isDesignTicket,
  type DesignBridgeAnswer,
  type DesignBridgeCommand,
} from "./designBridge.ts";
import { requireDesign, DesignForbiddenError } from "./designs.ts";
import { NotFoundError } from "./docs.ts";

/** What the routes and the MCP tools need of one design's room. */
export interface DesignRoomPort {
  issueTicket(): Promise<{ readonly ticket: string; readonly expiresAt: number }>;
  status(): Promise<{ readonly connected: boolean }>;
  command(command: string, args: unknown, expectedEditor?: string | null): Promise<DesignBridgeAnswer>;
  fetch(request: Request): Promise<Response>;
}

const TICKET_ROUTE = /^\/api\/designs\/([A-Za-z0-9_-]{1,64})\/agent-ticket$/;
export const isDesignAgentTicketPath = (pathname: string) => TICKET_ROUTE.test(pathname);

const plain = (status: number, text: string) =>
  new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** The socket address for one ticket, on the app's public origin. */
export function designAgentSocketUrl(publicOrigin: string, designId: string, ticket: string) {
  const url = new URL(designAgentSocketPath(designId), publicOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

/**
 * The editor's socket handshake, or null for any other path. `editorOrigin` is
 * DESIGNER_ORIGIN, or the app's own origin when the editor is served under
 * /designer/ there.
 */
export async function handleDesignAgentSocket(
  request: Request,
  deps: {
    readonly editorOrigin: string;
    readonly room: (designId: string) => DesignRoomPort;
  },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isDesignAgentSocketPath(url.pathname)) return null;
  if (request.method !== "GET") return plain(405, "Method not allowed");
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return plain(426, "Expected WebSocket");
  }
  // Browsers always send Origin on a socket handshake: only the editor's may open this one.
  if (request.headers.get("Origin") !== deps.editorOrigin) return plain(403, "Forbidden");
  const ticket = url.searchParams.get("ticket") ?? "";
  if (!isDesignTicket(ticket)) return plain(403, "Ticket refused");
  const designId = url.pathname.split("/")[3]!;
  // Nothing but the handshake goes on: no cookie, no other header the room could read.
  const headers = new Headers({ Upgrade: "websocket" });
  for (const name of [
    "Connection",
    "Sec-WebSocket-Key",
    "Sec-WebSocket-Version",
    "Sec-WebSocket-Extensions",
  ]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const forwarded = new URL(designAgentSocketPath(designId), url.origin);
  forwarded.searchParams.set("ticket", ticket);
  return deps.room(designId).fetch(new Request(forwarded, { method: "GET", headers }));
}

/** `POST /api/designs/:id/agent-ticket`, or null for any other path. */
export async function handleDesignAgentTicket(
  request: Request,
  deps: {
    readonly db: D1Database;
    readonly owners: ReadonlySet<string>;
    readonly publicOrigin: string;
    readonly now: () => number;
    readonly room: (designId: string) => DesignRoomPort;
  },
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = TICKET_ROUTE.exec(url.pathname);
  if (!match) return null;
  const designId = match[1]!;
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const principal = await Auth.authenticate(deps.db, request, {
    owners: deps.owners,
    now: deps.now(),
  });
  // The design page asks, signed in; an agent's token has no use for a ticket.
  if (principal?.kind !== "session") return json({ error: "unauthorized" }, 401);
  // A cookie-authed write: from the app's own origin, as JSON (no cross-site form can send it).
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== deps.publicOrigin && origin !== url.origin) {
    return json({ error: "forbidden_origin" }, 403);
  }
  if (!(request.headers.get("Content-Type") ?? "").startsWith("application/json")) {
    return json({ error: "unsupported_media_type" }, 415);
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // An empty body asks for a ticket.
  }
  if (!isDesignId(designId)) return json({ error: "not_found" }, 404);
  try {
    await requireDesign(deps.db, { designId, userId: principal.userId, need: "edit" });
  } catch (cause) {
    if (cause instanceof NotFoundError) return json({ error: "not_found" }, 404);
    if (cause instanceof DesignForbiddenError) {
      return json({ error: "forbidden", required: cause.required }, 403);
    }
    throw cause;
  }
  const room = deps.room(designId);
  if (body.ifDisconnected === true && (await room.status()).connected) {
    return json({ connected: true });
  }
  const { ticket, expiresAt } = await room.issueTicket();
  return json({
    connected: false,
    socketURL: designAgentSocketUrl(deps.publicOrigin, designId, ticket),
    expiresAt: new Date(expiresAt).toISOString(),
  });
}

// ---- the tool list ----

/** One editor tool as the release's up-docs-tools.json lists it. */
export interface DesignToolDef {
  readonly name: string;
  readonly description: string;
  readonly mutates: boolean;
  readonly evaluatesCode: boolean;
  readonly category: DesignToolCategory;
  /** The schema agents see: without `fileArgs`. */
  readonly inputSchema: Record<string, unknown>;
  /**
   * Arguments that write the result to a file through the bridge's file
   * server (`path` on the export tools), which UP Docs has no use for: left
   * out of the schema and dropped from calls.
   */
  readonly fileArgs: ReadonlyArray<string>;
}

/** Splits off the arguments that write to the bridge's file server. */
function withoutFileArgs(schema: Record<string, unknown>) {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object") return { schema, fileArgs: [] };
  const fileArgs = Object.entries(properties as Record<string, { description?: unknown }>)
    .filter(([, prop]) => /OPENPENCIL_MCP_ROOT/.test(String(prop?.description ?? "")))
    .map(([name]) => name);
  if (fileArgs.length === 0) return { schema, fileArgs };
  const kept = Object.fromEntries(
    Object.entries(properties).filter(([name]) => !fileArgs.includes(name)),
  );
  return { schema: { ...schema, properties: kept }, fileArgs };
}

export const DESIGN_TOOL_CATEGORIES = [
  "read",
  "analyze",
  "export",
  "view",
  "create",
  "edit",
  "components",
  "variables",
  "comments",
] as const;
export type DesignToolCategory = (typeof DESIGN_TOOL_CATEGORIES)[number];

/** Groups tools for design_tools; the release lists capabilities, not categories. */
export function designToolCategory(tool: {
  readonly name: string;
  readonly mutates: boolean;
  readonly capabilities: ReadonlyArray<string>;
}): DesignToolCategory {
  const { name } = tool;
  if (/comment|status/.test(name)) return "comments";
  if (/variable|collection|design_tokens/.test(name)) return "variables";
  if (/^export_/.test(name)) return "export";
  const writes = tool.capabilities.includes("document:write");
  if (!writes && tool.mutates) return "view";
  if (!writes) return /^(analyze_|lint$|diff_|preview_)/.test(name) ? "analyze" : "read";
  if (/component|instance|variant|slot|behaviour|library/.test(name)) return "components";
  if (/^(create_|import_|render$|clone_nodes$)/.test(name)) return "create";
  return "edit";
}

/** The allowed editor tools, by name. */
export type DesignToolList = ReadonlyMap<string, DesignToolDef>;

/** Parses up-docs-tools.json; anything malformed is left out. */
export function parseDesignTools(raw: unknown): DesignToolList {
  const tools = new Map<string, DesignToolDef>();
  const list = (raw as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(list)) return tools;
  for (const entry of list as Array<Record<string, unknown>>) {
    if (!entry || typeof entry.name !== "string" || !/^[a-z0-9_]{1,64}$/.test(entry.name)) continue;
    if (typeof entry.description !== "string") continue;
    if (!entry.inputSchema || typeof entry.inputSchema !== "object") continue;
    const capabilities = Array.isArray(entry.capabilities)
      ? (entry.capabilities as Array<unknown>).filter((c): c is string => typeof c === "string")
      : [];
    const mutates = entry.mutates === true;
    const { schema, fileArgs } = withoutFileArgs(entry.inputSchema as Record<string, unknown>);
    tools.set(entry.name, {
      name: entry.name,
      description: entry.description,
      mutates,
      // Anything not explicitly false counts as compiling code.
      evaluatesCode: entry.evaluatesCode !== false,
      category: designToolCategory({ name: entry.name, mutates, capabilities }),
      inputSchema: schema,
      fileArgs,
    });
  }
  return tools;
}

/**
 * The tools an agent may run here. Without an editor origin of its own the
 * editor has no 'unsafe-eval' (designerHost.ts), so the ones that compile code
 * are left out, and refused.
 */
export function allowedDesignTools(all: DesignToolList, isolatedEditor: boolean): DesignToolList {
  if (isolatedEditor) return all;
  return new Map([...all].filter(([, tool]) => !tool.evaluatesCode));
}

const TOOL_LIST_PATH = "/designer/up-docs-tools.json";
let cachedTools: Promise<DesignToolList> | null = null;

/** The release's tool list from the static files, read once per isolate. */
export function loadDesignTools(assets: Fetcher, origin: string): Promise<DesignToolList> {
  cachedTools ??= assets
    .fetch(new Request(new URL(TOOL_LIST_PATH, origin)))
    .then(async (response) => {
      if (!response.ok) throw new Error(`up-docs-tools.json: ${response.status}`);
      const tools = parseDesignTools(await response.json());
      if (tools.size === 0) throw new Error("up-docs-tools.json lists no tools");
      return tools;
    })
    .catch((cause: unknown) => {
      cachedTools = null;
      throw cause;
    });
  return cachedTools;
}

/** What the MCP design tools reach the open editors through. */
export interface DesignAgentPort {
  readonly room: (designId: string) => DesignRoomPort;
  /** The tools agents may run, already without the code-compiling ones where they cannot run. */
  readonly tools: () => Promise<DesignToolList>;
  /** Whether the editor has an origin of its own (DESIGNER_ORIGIN), where every tool runs. */
  readonly isolatedEditor: boolean;
}

/**
 * Sends one command to a design's open editor. A `tool` command must name an
 * allowed tool: this is the Worker's own check, beside the editor's.
 */
export async function forwardDesignCommand(
  port: DesignAgentPort,
  designId: string,
  command: DesignBridgeCommand,
  args: Record<string, unknown>,
  /** Send only to this editor connection; `editor_changed` when another holds the socket. */
  expectedEditor?: string | null,
): Promise<DesignBridgeAnswer> {
  if (command !== "tool") return port.room(designId).command(command, args, expectedEditor);
  const name = args.name;
  const tool = typeof name === "string" ? (await port.tools()).get(name) : undefined;
  if (!tool) return { kind: "refused", error: `The tool "${String(name)}" is not available here.` };
  const toolArgs =
    args.args && typeof args.args === "object" && !Array.isArray(args.args)
      ? Object.fromEntries(
          Object.entries(args.args as Record<string, unknown>).filter(
            ([key]) => !tool.fileArgs.includes(key),
          ),
        )
      : {};
  return port.room(designId).command("tool", { name, args: toolArgs }, expectedEditor);
}
