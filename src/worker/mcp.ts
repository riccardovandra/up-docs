import type { ApiDeps } from "./api.ts";
import * as Auth from "./auth.ts";
import { callTool, McpToolError, TOOLS } from "./mcpTools.ts";

/**
 * Agent MCP endpoint at `/mcp`: Streamable HTTP in its stateless JSON form.
 * Every request is one JSON-RPC message in a POST and gets a JSON reply; there
 * is no session and no server-initiated stream, so GET is refused. Tools read
 * through `docs.ts` and write through `deps.rooms`, so agent edits reach open
 * editors exactly like REST writes do.
 */

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/**
 * Clients cut long server instructions short (Claude Code keeps about 4,000
 * characters), so this stays under MAX_INSTRUCTIONS_LENGTH and the full format
 * specs live behind the format_guide tool (mcpGuide.ts).
 */
export const MAX_INSTRUCTIONS_LENGTH = 3_900;

export const MCP_INSTRUCTIONS = `UP Docs holds living markdown docs that the user watches update live in their editor.
Projects are T3 Code projects, identified by key: the git repository (github.com/owner/repo), or title:<name> for a project without a remote. Inside T3 Code, docs_cloud_project gives the current project's key.
Workflow:
1. When asked for a doc, plan or write-up, create it first: create_doc with projectKey (and projectName), the title and a skeleton (the section headings, each with a one-line placeholder). Do this before research. Omit projectKey only when the doc belongs to no project.
2. Give the user the doc URL from the response right away, then work.
3. Fill sections one at a time with edit_tab (replace a placeholder with the finished section), so the user watches the doc build. Use write_tab only for a new or fully rewritten tab.
4. Use tabs (create_tab) for distinct parts such as research, plan and decisions; nest with parentTabId.
5. Keep findings in the doc, not the chat. End with one line and the URL.
Re-read a tab (read_doc with tabId) before editing it if the user may have changed it. Move a doc with move_doc (projectId: null for no project).
How to write (what the user keeps asking for):
- Before drafting, know the reader, the purpose and the decision the doc should drive. If one is unclear, ask one or two short questions first.
- Foundation first: say what the doc is for and the end state, then the parts. A plan reads: purpose and reader; end state, with a diagram; components, each with its goal, when it is done and how it fits; order of work, easiest or first-needed first; open decisions.
- Plain words, full depth. Define every term, acronym and ID where it first appears; no bare F1, R5, D3 or PR numbers in a doc a person reads.
- Draft small: no filler, restating, closing summaries or invented sections. Grow a section when the user asks. Do not guess facts about the user's business: ask, or mark it as an assumption.
- Draw to explain: every process, loop, system, data model or comparison of options gets a diagram beside the text it explains. One idea per diagram, its title says what to take from it. Actions: input, system, output. Roadmaps: a cascade. Data models: before and after. Options: side by side. Keep each label line under about 24 characters.
Formats: call format_guide {topic} before you first write one. Writes with a malformed block are refused with the reason.
- Diagrams: \`\`\`t3-widget id=<slug> blocks (topic "diagram"). Existing \`\`\`mermaid blocks keep working; edit them in place, never convert them.
- Rich tables with status chips, links and per-cell comments: \`\`\`t3-table (topic "table"). Plain markdown tables are fine for static data.
- Videos: \`\`\`t3-video (topic "video"). LinkedIn and X posts: \`\`\`t3-embed (topic "embed").
- Comments: when asked to address comments, list_comments, make the edits, reply_comment in each thread saying what changed, and resolve_comment once handled (topic "comments" for anchors on table cells and diagram labels).
- Sharing: share_doc, list_members and unshare_doc (topic "sharing"). Pushing a tab to a Claude Doc: topic "claude_push".`;

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

const rpcResult = (id: JsonRpcRequest["id"], result: unknown, headers: HeadersInit = {}) =>
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
  return SESSION_PREFIX + btoa(String.fromCharCode(...bytes)).replace(/=+$/, "");
}

function clientNameFrom(request: Request): string | null {
  const sessionId = request.headers.get(SESSION_HEADER);
  if (!sessionId?.startsWith(SESSION_PREFIX)) return null;
  try {
    const binary = atob(sessionId.slice(SESSION_PREFIX.length));
    const name = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    return name.trim() || null;
  } catch {
    return null;
  }
}

const rpcError = (id: JsonRpcRequest["id"] | null, code: number, message: string, status = 200) =>
  Response.json(
    { jsonrpc: "2.0", id, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );

function isRequest(body: unknown): body is JsonRpcRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const message = body as Record<string, unknown>;
  return message.jsonrpc === "2.0" && typeof message.method === "string";
}

export async function handleMcp(request: Request, deps: ApiDeps): Promise<Response> {
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
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="up-docs"' } },
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
      const clientName = typeof clientInfo?.name === "string" ? clientInfo.name.trim() : "";
      return rpcResult(
        body.id,
        {
          protocolVersion:
            typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
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
      if (typeof name !== "string") return rpcError(body.id, -32602, "Missing tool name");
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
        return rpcResult(body.id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (cause) {
        if (cause instanceof McpToolError) {
          if (cause.unknownTool) return rpcError(body.id, -32602, cause.message);
          return rpcResult(body.id, {
            content: [{ type: "text", text: JSON.stringify(cause.detail, null, 2) }],
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
