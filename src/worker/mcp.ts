import type { ApiDeps } from "./api.ts";
import * as Auth from "./auth.ts";
import * as DrawioLinks from "./drawioLinks.ts";
import { MAX_DIAGRAM_XML_BYTES } from "../shared/drawio.ts";
import {
  callTool,
  drawioDownload,
  McpToolError,
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

export const MCP_INSTRUCTIONS = `UP Docs holds living markdown docs that the user watches update live in their editor.
Projects are T3 Code projects, identified by key: the git repository (github.com/owner/repo), or title:<name> for a project without a remote. Inside T3 Code, docs_cloud_project gives the current project's key.
Workflow:
1. When asked for a doc, plan or write-up, create it first: create_doc with projectKey (and projectName), the title and a skeleton (the section headings, each with a one-line placeholder). Do this before research. Omit projectKey only when the doc belongs to no project. Pass type (plan, spec, explainer, report, client) for a ready skeleton in the shape below.
2. Give the user the doc URL from the response right away, then work.
3. Fill sections one at a time with edit_tab (replace a placeholder with the finished section), so the user watches the doc build. Use write_tab only for a new or fully rewritten tab.
4. Use tabs (create_tab) for distinct parts such as research, plan and decisions; nest with parentTabId.
5. Keep findings in the doc, not the chat. End with one line and the URL.
Doc links read <origin>/d/<docId>/<tabId>: a pasted link's tabId is the tab the user is on, so read_doc with it first. Re-read a tab (read_doc with tabId) before editing it if the user may have changed it. Move a doc with move_doc (projectId: null for no project).
Project facts: create_doc and read_doc return the project's standing facts (tools, names, rules). Follow them over your own assumptions. When the user corrects a lasting fact, save it with add_project_fact, or with resolve_comment's lesson when it came from a comment.
How to write (what the user keeps asking for):
- Before drafting, know the reader, the purpose and the decision the doc should drive. If one is unclear, ask one or two short questions.
- Foundation first: say what the doc is for and the end state, then the parts. A plan reads: purpose and reader; end state, with a diagram; components, each with its goal, when it is done and how it fits; order of work, easiest or first-needed first; open decisions.
- Plain words, full depth. Define every term, acronym and ID where it first appears; no bare F1, R5, D3 or PR numbers.
- Draft small: no filler, restating, closing summaries or invented sections. Grow a section when the user asks. Do not guess facts about the user's business: ask, or mark it as an assumption.
- Draw to explain: every process, loop, system, data model or comparison of options gets a diagram beside its text. One idea per diagram, its title says what to take from it. Actions: input, system, output. Roadmaps: a cascade. Data models: before and after. Options: side by side. Keep each label line under about 24 characters.
Formats: call format_guide {topic} before you first write one. Malformed blocks are refused with the reason.
- Diagrams: \`\`\`t3-widget id=<slug> blocks (topic "diagram"). Existing \`\`\`mermaid blocks keep working; edit them in place, never convert them.
- Draw.io diagrams people edit by hand: list_drawio, read_drawio, create_drawio, update_drawio; big files by link (topic "drawio").
- Rich tables (status chips, links, per-cell comments): \`\`\`t3-table (topic "table"). Plain markdown tables are fine for static data.
- Images: ![alt](https://...) links are copied into the doc on write; a local file goes up with prepare_image_upload (topic "image").
- Videos: \`\`\`t3-video (topic "video"). LinkedIn and X posts: \`\`\`t3-embed (topic "embed").
- Comments: when asked to address comments, list_comments, make the edits, reply_comment in each thread with what changed, then resolve_comment (topic "comments": anchors on table cells and diagram labels).
- Sheets (live shared spreadsheets): create_sheet, read_sheet, read_cells, edit_sheet (topic "sheet").
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
  const tokenName = await deps.db
    .prepare("SELECT name FROM api_tokens WHERE id = ?1")
    .bind(claim.apiTokenId)
    .first<{ name: string }>();
  const ctx = {
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
