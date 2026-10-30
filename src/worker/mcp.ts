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

export const MCP_INSTRUCTIONS = `UP Docs holds living markdown docs that the user watches update live in their editor.
Projects are T3 Code projects, identified by key: the git repository (github.com/owner/repo), or title:<name> for a project without a remote. Inside T3 Code, docs_cloud_project gives the current project's key.
Workflow:
1. When asked for a doc, plan or write-up, create it first: create_doc with projectKey (and projectName), the title and a skeleton (the section headings, each with a one-line placeholder). Do this before research. Omit projectKey only when the doc belongs to no project.
2. Give the user the doc URL from the response right away, then work.
3. Fill sections one at a time with edit_tab (replace a placeholder with the finished section), so the user watches the doc build. Use write_tab only for a new or fully rewritten tab.
4. Use tabs (create_tab) for distinct parts such as research, plan and decisions; nest with parentTabId.
5. Draw diagrams as \`\`\`t3-widget blocks (below). Existing \`\`\`mermaid blocks keep working; edit them in place, never convert them.
6. Keep findings in the doc, not the chat. End with one line and the URL.
Move a doc with move_doc (projectId: null for no project).
Re-read a tab (read_doc with tabId) before editing it if the user may have changed it.
Rich tables (status chips, links, per-cell comments): a \`\`\`t3-table block whose body is JSON. Ids are yours to pick (letters, digits, _ and -) and must stay stable. Column types: text, select (cells hold one of its options' values; colors gray, blue, green, yellow, orange, red, purple, pink), link (cells are {"text","url"}), number, date ("YYYY-MM-DD"). Example:
\`\`\`t3-table
{"id":"requests","columns":[{"id":"req","name":"Request","type":"text"},{"id":"status","name":"Status","type":"select","options":[{"value":"Not started","color":"gray"},{"value":"Done","color":"green"}]},{"id":"ticket","name":"Ticket","type":"link"}],"rows":[{"id":"r1","cells":{"req":"Fix Zebra MCP","status":"Not started","ticket":{"text":"TASK-5575","url":"https://example.atlassian.net/browse/TASK-5575"}}}]}
\`\`\`
Change one cell with update_table_cell and add rows with add_table_row rather than rewriting the block. Plain markdown tables still work for static data.
Videos play inside the doc from a \`\`\`t3-video block. Its first line is the source and its optional second line is the title, nothing else. The source is a YouTube link (watch, youtu.be, shorts, embed), a Loom link (share, embed), or a /api/videos/<docId>/<file> URL already uploaded in the editor; agents cannot upload files. Bare links stay plain links. Example:
\`\`\`t3-video
https://www.youtube.com/watch?v=dQw4w9WgXcQ
Release walkthrough
\`\`\`
Comments: when asked to review or address comments, list_comments, make the requested edits in the doc, reply_comment in each thread saying what changed (or answering the question), and resolve_comment once a thread is fully handled. To raise a point on a passage, create_comment with a short exact quote from the tab; on a table cell, pass anchor {"kind":"cell","blockId":<table id>,"rowId","colId"} instead, and on a diagram label {"kind":"label","blockId":<diagram id>,"textId"}.
Sharing: docs are private to the people on them. share_doc gives someone access by email (owner, editor, commenter or viewer); list_members and unshare_doc manage it. You act with the role of the person whose token you use.
Diagrams use Claude's widget format: a fenced block \`\`\`t3-widget id=<slug>\` whose body is ONE JS/JSX module, \`export default () => <svg viewBox='0 0 760 H' role='img' aria-label='<title words>'>…</svg>;\` (a block body with consts and lowercase helpers is fine). The id names the diagram in its tab and never changes. Writes with an invalid diagram are refused with rule names and line:col.
- Every <text> or <tspan> whose words you type carries its own LITERAL data-claude-text-id='<slug>' (letters, digits, _ -, max 64, unique). Words are literal JSX text, written out one by one, never computed or inside .map()/helpers. Two lines = two <tspan data-claude-text-id>; no id on a <text> that holds tspans. The first <text> is the title: say the finding, not the topic.
- Wrap each box with its labels in <g data-claude-anchor='<slug>'> (a literal, or a template literal in a loop).
- Colours are tokens only, never hex or names: var(--cds-text-primary), --cds-text-secondary, --cds-chart-axis (borders, connectors, arrowheads), --cds-chart-grid, --cds-chart-reference-tint, --cds-chart-categorical-1..8, --cds-chart-status-good|warning|critical. Every <text> sets fill. Box fill 'none'; one accent = categorical-1 at fillOpacity 0.12.
- Refused: <style>, <use>, <foreignObject>, event handlers, href; the names top, parent, self, window; computed indexes xs[i] (use xs.at(i) or pos.commit); Math.random, Date.now, timers; claude.Visualize data charts.
- Frame: viewBox width 760, height = drawing + ~24. fontSize ≥ 10.5 (13 to read, 15 for the title, names fontWeight 600), rx 8, strokeWidth 1 to 1.25. SVG does not wrap: break lines yourself (a 13px line is ~7 units a character).
- To change words, edit_diagram_label {tabId, diagramId, textId, value}; read_diagram returns the code and its text ids. Redraw with edit_tab only for layout changes, keeping every text id and the words as read (people edit them).
Example (five boxes, one decision, a loop back):
\`\`\`t3-widget id=release-flow
export default () => { const W = 156, H = 48, rowA = 110, rowB = 230, c1 = 102, c2 = 290, cd = 456, c3 = 634; const edge = 'var(--cds-chart-axis)', accent = 'var(--cds-chart-categorical-1)', ink = 'var(--cds-text-primary)', quiet = 'var(--cds-text-secondary)'; const box = (cx, cy, main) => <rect x={cx - W / 2} y={cy - H / 2} width={W} height={H} rx='8' fill={main ? accent : 'none'} fillOpacity={main ? 0.12 : 1} stroke={main ? accent : edge} strokeWidth={main ? 2 : 1.25}/>; return <svg viewBox='0 0 760 280' role='img' aria-label='Only a green build reaches production' fontSize='13'><defs><marker id='flow-arrow' viewBox='0 0 10 10' refX='9' refY='5' markerWidth='6' markerHeight='6' orient='auto-start-reverse'><path d='M0 0L10 5L0 10z' fill={edge}/></marker></defs><text data-claude-text-id='title' x='24' y='34' fontSize='15' fontWeight='600' fill={ink}>Only a green build reaches production</text><g data-claude-anchor='connectors' fill='none' stroke={edge} strokeWidth='1.25'><path d={\`M\${c1 + W / 2} \${rowA}H\${c2 - W / 2}\`} markerEnd='url(#flow-arrow)'/><path d={\`M\${c2 + W / 2} \${rowA}H\${cd - 64}\`} markerEnd='url(#flow-arrow)'/><path d={\`M\${cd + 64} \${rowA}H\${c3 - W / 2}\`} markerEnd='url(#flow-arrow)'/><path d={\`M\${cd} \${rowA + 40}V\${rowB - H / 2}\`} markerEnd='url(#flow-arrow)'/><path d={\`M\${c3} \${rowA + H / 2}V\${rowB - H / 2}\`} markerEnd='url(#flow-arrow)'/><path d={\`M\${cd - W / 2} \${rowB}H\${c1}V\${rowA + H / 2}\`} markerEnd='url(#flow-arrow)'/></g><g data-claude-anchor='step-commit'>{box(c1, rowA, false)}<text data-claude-text-id='commit' x={c1} y={rowA + 4} textAnchor='middle' fill={ink}>Commit lands</text></g><g data-claude-anchor='step-build'>{box(c2, rowA, false)}<text data-claude-text-id='build' x={c2} y={rowA + 4} textAnchor='middle' fill={ink}>Build and test</text></g><g data-claude-anchor='decision-tests'><polygon points={\`\${cd - 64},\${rowA} \${cd},\${rowA - 40} \${cd + 64},\${rowA} \${cd},\${rowA + 40}\`} fill='none' stroke={edge} strokeWidth='1.25'/><text data-claude-text-id='tests-pass' x={cd} y={rowA + 4} textAnchor='middle' fill={ink}>Tests pass?</text></g><g data-claude-anchor='step-staging'>{box(c3, rowA, false)}<text data-claude-text-id='staging' x={c3} y={rowA + 4} textAnchor='middle' fill={ink}>Deploy to staging</text></g><g data-claude-anchor='step-ship'>{box(c3, rowB, true)}<text data-claude-text-id='ship' x={c3} y={rowB + 4} textAnchor='middle' fontWeight='600' fill={ink}>Ship to production</text></g><g data-claude-anchor='step-notify'>{box(cd, rowB, false)}<text data-claude-text-id='notify' x={cd} y={rowB + 4} textAnchor='middle' fill={ink}>Notify the author</text></g><text data-claude-text-id='yes' x={cd + 82} y={rowA - 8} textAnchor='middle' fontSize='11.5' fill={quiet}>yes</text><text data-claude-text-id='no' x={cd + 10} y={rowA + 72} fontSize='11.5' fill={quiet}>no</text><text data-claude-text-id='smoke' x={c3 - 10} y={rowA + 72} textAnchor='end' fontSize='11.5' fill={quiet}>smoke checks pass</text><text data-claude-text-id='fix-and-push' x={(c1 + cd - W / 2) / 2} y={rowB - 8} textAnchor='middle' fontSize='11.5' fill={quiet}>fix and push</text></svg>; };
\`\`\``;

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
