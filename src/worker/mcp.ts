import type { ApiDeps } from "./api.ts";
import * as Auth from "./auth.ts";
import * as DrawioLinks from "./drawioLinks.ts";
import * as PageLinks from "./pageLinks.ts";
import { MAX_DIAGRAM_XML_BYTES } from "../shared/drawio.ts";
import { MAX_PAGE_BYTES } from "../shared/htmlPages.ts";
import {
  callTool,
  drawioDownload,
  McpToolError,
  pageDownload,
  pageUpload,
  ToolResultWithImages,
  TOOLS,
} from "./mcpTools.ts";

/**
 * Agent MCP endpoint at `/mcp`: Streamable HTTP in its stateless JSON form.
 * Every request is one JSON-RPC message in a POST and gets a JSON reply; there
 * is no session and no server-initiated stream, so GET is refused. Tools read
 * through `docs.ts` and write through `deps.rooms`, so agent edits reach open
 * editors exactly like REST writes do.
 */

const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

/**
 * Clients cut long server instructions short (Claude Code keeps about 4,000
 * characters), so this stays under MAX_INSTRUCTIONS_LENGTH and the full format
 * specs live behind the format_guide tool (mcpGuide.ts).
 */
export const MAX_INSTRUCTIONS_LENGTH = 3_900;

export const MCP_INSTRUCTIONS = `UP Docs holds living markdown docs, Draw.io diagrams and sheets that the user watches update live.
Projects are T3 Code projects, identified by key: the git repository (github.com/owner/repo), or title:<name> for a project without a remote. Inside T3 Code, docs_cloud_project gives the current project's key.
What to make: decide from the user's words before anything else.
- "A diagram" (a flowchart, map, process or system drawing) on its own: one Draw.io diagram, create_drawio (topic "drawio"). No doc. Hand over its link.
- A doc, plan or write-up, with or without diagrams: a doc; its diagrams are \`\`\`t3-widget blocks inside it (topic "diagram").
- A doc with an editable or Draw.io diagram: create_drawio, then paste its block into the doc.
- A diagram plus a doc that explains it: one Draw.io diagram drawn in sections, and a doc that shows it whole, then one part per section beside its text (topic "diagram_doc").
Doc workflow:
1. Create it first: create_doc with projectKey (and projectName), the title and a skeleton (section headings, each with a one-line placeholder), before research. Omit projectKey only when the doc belongs to no project. Pass type (plan, spec, explainer, report, client) for a ready skeleton.
2. Give the user the URL right away, then work.
3. Fill sections one at a time with edit_tab (replace a placeholder with the finished section), so the user watches it build. write_tab only for a new or fully rewritten tab.
4. Tabs (create_tab) for distinct parts such as research, plan and decisions; nest with parentTabId.
5. Keep findings in the doc, not the chat. End with one line and the URL.
How to write: create_doc returns the user's writing rules; read them (topic "writing") before you write in a doc you did not create. In short: know the reader and the decision; foundation first; plain words, every term defined; draft small; a diagram beside every process, system or comparison.
Doc links read <origin>/d/<docId>/<tabId>: a pasted link's tabId is the tab the user is on, so read_doc with it first. Re-read a tab (read_doc with tabId) before editing it if the user may have changed it. Move a doc with move_doc (projectId: null for no project).
Project facts: create_doc and read_doc return the project's standing facts (tools, names, rules). Follow them over your own assumptions. When the user corrects a lasting fact, save it with add_project_fact, or with resolve_comment's lesson when it came from a comment.
Formats: call format_guide {topic} before you first write one. Malformed blocks are refused with the reason.
- Diagrams in a doc: \`\`\`t3-widget id=<slug> (topic "diagram"). Existing \`\`\`mermaid blocks keep working; edit them in place, never convert them.
- Draw.io diagrams (a library of their own, shown in docs whole or one part at a time): list_drawio, read_drawio, create_drawio, update_drawio; big files by link (topic "drawio").
- Rich tables (status chips, links, per-cell comments): \`\`\`t3-table (topic "table"). Plain markdown tables are fine for static data.
- Images: ![alt](https://...) links are copied into the doc on write; a local file goes up with prepare_image_upload (topic "image").
- Videos: \`\`\`t3-video (topic "video"). LinkedIn and X posts: \`\`\`t3-embed (topic "embed").
- Comments: when asked to address comments, list_comments, make the edits, reply_comment in each thread with what changed, then resolve_comment (topic "comments": anchors on table cells and diagram labels).
- Sheets (live shared spreadsheets): create_sheet, read_sheet, read_cells, edit_sheet (topic "sheet").
- Pages (uploaded HTML prototypes, private until shared): prepare_page_upload, list_pages, read_page; \`\`\`t3-page shows one in a doc (topic "page").
- Sharing: share_doc, list_members and unshare_doc (topic "sharing"). Pushing a tab to a Claude Doc: topic "claude_push".`;

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

const rpcResult = (
  id: JsonRpcRequest["id"],
  result: unknown,
  headers: HeadersInit = {},
) =>
  Response.json(
    { jsonrpc: "2.0", id, result },
    { headers: { "Cache-Control": "no-store", ...headers } },
  );

/**
 * The endpoint keeps no sessions, so the client's name from `initialize` rides
 * in the session id the client echoes on every later request. It only names
 * the author of agent comments; the bearer token is still the credential.
 */
const SESSION_HEADER = "Mcp-Session-Id";
const SESSION_PREFIX = "c.";

function sessionIdFor(clientName: string): string {
  const bytes = new TextEncoder().encode(clientName.slice(0, 60));
  return (
    SESSION_PREFIX + btoa(String.fromCharCode(...bytes)).replace(/=+$/, "")
  );
}

function clientNameFrom(request: Request): string | null {
  const sessionId = request.headers.get(SESSION_HEADER);
  if (!sessionId?.startsWith(SESSION_PREFIX)) return null;
  try {
    const binary = atob(sessionId.slice(SESSION_PREFIX.length));
    const name = new TextDecoder().decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    );
    return name.trim() || null;
  } catch {
    return null;
  }
}

const rpcError = (
  id: JsonRpcRequest["id"] | null,
  code: number,
  message: string,
  status = 200,
) =>
  Response.json(
    { jsonrpc: "2.0", id, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );

function isRequest(body: unknown): body is JsonRpcRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const message = body as Record<string, unknown>;
  return message.jsonrpc === "2.0" && typeof message.method === "string";
}

export async function handleMcp(
  request: Request,
  deps: ApiDeps,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.replace(/\/+$/, "") !== "/mcp") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  // Only bearer tokens: a session cookie is ambient and SameSite=None, so a
  // cross-site text/plain POST could otherwise drive the tools.
  const principal = await Auth.authenticate(deps.db, request, {
    owners: deps.owners,
    now: deps.now(),
  });
  if (principal?.kind !== "token") {
    return Response.json(
      { error: "unauthorized" },
      {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="up-docs"' },
      },
    );
  }

  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
  if (!isRequest(body)) return rpcError(null, -32600, "Invalid request", 400);
  // Notifications (no id) and client responses need no reply.
  if (body.id === undefined) return new Response(null, { status: 202 });

  const params = body.params ?? {};
  switch (body.method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const clientInfo = params.clientInfo as { name?: unknown } | undefined;
      const clientName =
        typeof clientInfo?.name === "string" ? clientInfo.name.trim() : "";
      return rpcResult(
        body.id,
        {
          protocolVersion:
            typeof requested === "string" &&
            SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
              ? requested
              : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "up-docs", title: "UP Docs", version: "0.1.0" },
          instructions: MCP_INSTRUCTIONS,
        },
        clientName ? { [SESSION_HEADER]: sessionIdFor(clientName) } : {},
      );
    }
    case "ping":
      return rpcResult(body.id, {});
    case "tools/list":
      return rpcResult(body.id, { tools: TOOLS });
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string")
        return rpcError(body.id, -32602, "Missing tool name");
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const result = await callTool(name, args, {
          deps,
          origin: deps.publicOrigin,
          agentName: clientNameFrom(request) ?? principal.tokenName,
          principal,
        });
        const withImages = result instanceof ToolResultWithImages;
        return rpcResult(body.id, {
          content: [
            {
              type: "text",
              text: JSON.stringify(withImages ? result.body : result, null, 2),
            },
            // Pictures follow the JSON as MCP image content, so the agent can look at them.
            ...(withImages ? result.images : []).map((image) => ({
              type: "image",
              ...image,
            })),
          ],
        });
      } catch (cause) {
        if (cause instanceof McpToolError) {
          if (cause.unknownTool)
            return rpcError(body.id, -32602, cause.message);
          return rpcResult(body.id, {
            content: [
              { type: "text", text: JSON.stringify(cause.detail, null, 2) },
            ],
            isError: true,
          });
        }
        throw cause;
      }
    }
    default:
      return rpcError(body.id, -32601, `Method not found: ${body.method}`);
  }
}

const linkJson = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const LINK_INVALID = {
  error: "link_invalid",
  message: "This link is unknown, used, expired, or its API token was revoked. Ask for a new one.",
};

/** HTTP status for a refused upload; the JSON body is the tool's own error. */
function linkErrorStatus(error: unknown): number {
  if (error === "version_conflict") return 409;
  if (error === "forbidden") return 403;
  if (error === "not_found") return 404;
  if (error === "too_large") return 413;
  return 400;
}

/** The tool context a one-time link acts in: the API token that asked for it. */
async function linkContext(
  deps: ApiDeps,
  claim: { readonly userId: string; readonly apiTokenId: string; readonly agentName: string },
) {
  const tokenName = await deps.db
    .prepare("SELECT name FROM api_tokens WHERE id = ?1")
    .bind(claim.apiTokenId)
    .first<{ name: string }>();
  return {
    deps,
    origin: deps.publicOrigin,
    agentName: claim.agentName,
    principal: {
      kind: "token" as const,
      userId: claim.userId,
      tokenId: claim.apiTokenId,
      tokenName: tokenName?.name ?? claim.agentName,
    },
  };
}

/**
 * `PUT /api/diagram-uploads/:token` runs create_drawio or update_drawio with
 * the request body as `xml`; `GET /api/diagram-downloads/:token` returns a
 * diagram's whole file. Links come from prepare_drawio_upload and read_drawio
 * {downloadLink: true}; each works once, as the API token that asked for it,
 * so the same rights and checks apply as to the tool call itself.
 */
export async function handleDrawioLink(
  request: Request,
  deps: ApiDeps,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const match = /^\/api\/diagram-(uploads|downloads)\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  const kind = match[1] === "uploads" ? "upload" : "download";
  const method = request.method;
  if (kind === "upload" ? method !== "PUT" && method !== "POST" : method !== "GET")
    return linkJson(405, { error: "method_not_allowed" });

  let xml: string | undefined;
  if (kind === "upload") {
    // Read before claiming, so a slow or broken upload does not burn the link.
    const declared = Number(request.headers.get("Content-Length") ?? "0");
    if (declared > MAX_DIAGRAM_XML_BYTES)
      return linkJson(413, { error: "too_large", message: `The file is over ${MAX_DIAGRAM_XML_BYTES} bytes.` });
    xml = await request.text();
    if (new TextEncoder().encode(xml).length > MAX_DIAGRAM_XML_BYTES)
      return linkJson(413, { error: "too_large", message: `The file is over ${MAX_DIAGRAM_XML_BYTES} bytes.` });
  }

  const claim = await DrawioLinks.claimDrawioLink(deps.db, {
    token: match[2]!,
    kind,
    now: deps.now(),
  });
  if (!claim) return linkJson(404, LINK_INVALID);
  const ctx = await linkContext(deps, claim);
  try {
    if (claim.tool === "download") {
      const file = await drawioDownload(ctx, String(claim.args.diagramId));
      return new Response(file.xml, {
        status: 200,
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Diagram-Version": String(file.version),
        },
      });
    }
    const result = await callTool(claim.tool, { ...claim.args, xml }, ctx);
    const body = result instanceof ToolResultWithImages ? result.body : result;
    return linkJson(claim.tool === "create_drawio" ? 201 : 200, body);
  } catch (cause) {
    if (cause instanceof McpToolError) {
      // A version conflict can never succeed with the same link: keep it used.
      if (cause.detail.error !== "version_conflict") await claim.release();
      return linkJson(linkErrorStatus(cause.detail.error), cause.detail);
    }
    await claim.release();
    throw cause;
  }
}

/**
 * `PUT /api/page-uploads/:token` publishes the request body as a new page or
 * the next version of one; `GET /api/page-downloads/:token` returns one
 * version's HTML. Links come from prepare_page_upload and read_page
 * {downloadLink: true}, and act as the API token that asked for them.
 */
export async function handlePageLink(
  request: Request,
  deps: ApiDeps,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const match = /^\/api\/page-(uploads|downloads)\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  const kind = match[1] === "uploads" ? "upload" : "download";
  const method = request.method;
  if (kind === "upload" ? method !== "PUT" && method !== "POST" : method !== "GET")
    return linkJson(405, { error: "method_not_allowed" });

  let html: ArrayBuffer | undefined;
  if (kind === "upload") {
    const tooLarge = () =>
      linkJson(413, {
        error: "too_large",
        message: `The file is over the ${MAX_PAGE_BYTES / (1024 * 1024)} MB limit for a page.`,
        maxBytes: MAX_PAGE_BYTES,
      });
    // Read before claiming, so a slow or broken upload does not burn the link.
    if (Number(request.headers.get("Content-Length") ?? "0") > MAX_PAGE_BYTES) return tooLarge();
    html = await request.arrayBuffer();
    if (html.byteLength > MAX_PAGE_BYTES) return tooLarge();
  }

  const claim = await PageLinks.claimPageLink(deps.db, { token: match[2]!, kind, now: deps.now() });
  if (!claim) return linkJson(404, LINK_INVALID);
  const ctx = await linkContext(deps, claim);
  try {
    if (claim.tool === "download") {
      const version = claim.args.version;
      const file = await pageDownload(
        ctx,
        String(claim.args.pageId),
        typeof version === "number" ? version : undefined,
      );
      return new Response(file.html, {
        status: 200,
        headers: {
          // Plain text: a download is a file to save, never a page to run here.
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": "attachment",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
          "X-Page-Version": String(file.version),
        },
      });
    }
    const result = await pageUpload(ctx, claim.tool, claim.args, html!);
    return linkJson(claim.tool === "create_page" ? 201 : 200, result);
  } catch (cause) {
    if (cause instanceof McpToolError) {
      await claim.release();
      return linkJson(linkErrorStatus(cause.detail.error), cause.detail);
    }
    await claim.release();
    throw cause;
  }
}
