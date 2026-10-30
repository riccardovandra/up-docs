import { describe, expect, it } from "vitest";

import * as Docs from "./docs.ts";
import { handleMcp } from "./mcp.ts";
import { makeApiHarness, ORIGIN } from "./testing/apiHarness.ts";
import { FLOW_EXAMPLE } from "../shared/widget/testing/examples.ts";

/** `requestOrigin` stands in for what request.url reports, which `wrangler dev` rewrites. */
async function makeMcpHarness(requestOrigin = ORIGIN) {
  const api = makeApiHarness();
  const cookie = await api.signIn();
  const created = await api.call("POST", "/api/tokens", {
    body: { name: "agent" },
    headers: { Cookie: cookie },
  });
  const { token } = (await created.json()) as { token: string };
  let nextId = 1;
  // Echoed like a real client, once initialize hands one out.
  let sessionId: string | null = null;

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    handleMcp(
      new Request(`${requestOrigin}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      api.deps,
    );

  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await post(
      { jsonrpc: "2.0", id: nextId++, method, params },
      { Authorization: `Bearer ${token}`, ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) },
    );
    sessionId = response.headers.get("Mcp-Session-Id") ?? sessionId;
    return (await response.json()) as {
      result?: Record<string, unknown> & {
        content?: Array<{ text: string }>;
        isError?: boolean;
      };
      error?: { code: number; message: string };
    };
  };

  const tool = async (name: string, args: Record<string, unknown>) => {
    const { result } = await rpc("tools/call", { name, arguments: args });
    return {
      isError: result?.isError === true,
      body: JSON.parse(result!.content![0]!.text) as any,
    };
  };

  const seedDoc = async (markdown?: string) => {
    const project = await tool("create_project", { name: "Acme" });
    const doc = await tool("create_doc", {
      projectId: project.body.projectId,
      title: "Plan",
      ...(markdown === undefined ? {} : { markdown }),
    });
    return doc.body as { doc: { docId: string; url: string }; tab: { tabId: string } };
  };

  return { api, cookie, token, post, rpc, tool, seedDoc };
}

describe("MCP transport", () => {
  it("requires a bearer token, not a session cookie", async () => {
    const mcp = await makeMcpHarness();
    const message = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await mcp.post(message)).status).toBe(401);
    expect((await mcp.post(message, { Cookie: mcp.cookie })).status).toBe(401);
    expect((await mcp.post(message, { Authorization: "Bearer dct_forged" })).status).toBe(401);
    expect((await mcp.post(message, { Authorization: `Bearer ${mcp.token}` })).status).toBe(200);
  });

  it("negotiates the protocol, sends instructions and lists tools", async () => {
    const mcp = await makeMcpHarness();
    const init = await mcp.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.result?.protocolVersion).toBe("2025-06-18");
    expect(init.result?.instructions).toContain("edit_tab");
    const notified = await mcp.post(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { Authorization: `Bearer ${mcp.token}` },
    );
    expect(notified.status).toBe(202);
    const list = await mcp.rpc("tools/list");
    const names = (list.result!.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toContain("edit_tab");
    expect((await mcp.rpc("nope")).error?.code).toBe(-32601);
  });
});

describe("MCP tools", () => {
  it("creates a doc with a skeleton, returns its URL and pushes edits to editors", async () => {
    const mcp = await makeMcpHarness();
    const { doc, tab } = await mcp.seedDoc("# Plan\n\n## Goals\n\nTBD\n");
    expect(doc.url).toBe(`${ORIGIN}/d/${doc.docId}/${tab.tabId}`);

    const edit = await mcp.tool("edit_tab", {
      tabId: tab.tabId,
      find: "## Goals\n\nTBD",
      replace: "## Goals\n\nShip $& the MCP endpoint.",
    });
    expect(edit.isError).toBe(false);
    expect(edit.body.tab.url).toBe(`${ORIGIN}/d/${doc.docId}/${tab.tabId}`);
    expect(mcp.api.broadcasts.at(-1)).toMatchObject({ type: "tab.updated" });
    // The replacement is literal, not a String.replace pattern.
    expect(await Docs.getTabMarkdown(mcp.api.db, tab.tabId)).toBe(
      "# Plan\n\n## Goals\n\nShip $& the MCP endpoint.\n",
    );
  });

  it("refuses an edit_tab whose find text is missing or not unique", async () => {
    const mcp = await makeMcpHarness();
    const { tab } = await mcp.seedDoc("## A\n\nTBD\n\n## B\n\nTBD\n");
    const missing = await mcp.tool("edit_tab", { tabId: tab.tabId, find: "## C", replace: "x" });
    expect(missing).toMatchObject({ isError: true, body: { error: "no_match" } });
    const ambiguous = await mcp.tool("edit_tab", { tabId: tab.tabId, find: "TBD", replace: "x" });
    expect(ambiguous).toMatchObject({ isError: true, body: { error: "ambiguous_match" } });
    expect(ambiguous.body.message).toContain("2 times");
    expect(await Docs.getTabMarkdown(mcp.api.db, tab.tabId)).toBe("## A\n\nTBD\n\n## B\n\nTBD\n");
  });

  it("re-applies edit_tab on top of a concurrent write", async () => {
    const mcp = await makeMcpHarness();
    const { tab } = await mcp.seedDoc("## A\n\nTBD\n\n## B\n\nlater\n");
    const writeTab = mcp.api.deps.rooms.writeTab;
    let raced = false;
    // The user saves between the agent's read and its write.
    mcp.api.deps.rooms.writeTab = async (docId, input) => {
      if (!raced) {
        raced = true;
        const current = await Docs.getTab(mcp.api.db, input.tabId);
        await writeTab(docId, {
          tabId: input.tabId,
          baseVersion: current.version,
          markdown: current.markdown.replace("later", "user text"),
          origin: "editor",
        });
      }
      return writeTab(docId, input);
    };
    const edit = await mcp.tool("edit_tab", { tabId: tab.tabId, find: "TBD", replace: "done" });
    expect(edit.isError).toBe(false);
    expect(await Docs.getTabMarkdown(mcp.api.db, tab.tabId)).toBe(
      "## A\n\ndone\n\n## B\n\nuser text\n",
    );
  });

  it("returns the current version when write_tab conflicts", async () => {
    const mcp = await makeMcpHarness();
    const { tab } = await mcp.seedDoc("v2");
    const stale = await mcp.tool("write_tab", { tabId: tab.tabId, markdown: "x", baseVersion: 1 });
    expect(stale).toMatchObject({
      isError: true,
      body: { error: "version_conflict", currentVersion: 2 },
    });
    const fresh = await mcp.tool("write_tab", { tabId: tab.tabId, markdown: "x", baseVersion: 2 });
    expect(fresh.body.tab.version).toBe(3);
  });

  it("reads nested tabs in reading order, or one tab", async () => {
    const mcp = await makeMcpHarness();
    const { doc, tab } = await mcp.seedDoc("root");
    const second = await mcp.tool("create_tab", { docId: doc.docId, title: "Second" });
    const child = await mcp.tool("create_tab", {
      docId: doc.docId,
      title: "Child",
      parentTabId: tab.tabId,
      markdown: "nested",
    });
    expect(child.body.tab.url).toBe(`${ORIGIN}/d/${doc.docId}/${child.body.tab.tabId}`);

    const all = await mcp.tool("read_doc", { docId: doc.docId });
    expect(all.body.tabs.map((entry: { title: string }) => entry.title)).toEqual([
      "Plan",
      "Child",
      "Second",
    ]);
    const one = await mcp.tool("read_doc", { docId: doc.docId, tabId: second.body.tab.tabId });
    expect(one.body.tab).toMatchObject({ title: "Second", markdown: "", version: 1 });
  });

  it("renames tabs, sets status and lists docs by project", async () => {
    const mcp = await makeMcpHarness();
    const { doc, tab } = await mcp.seedDoc();
    const renamed = await mcp.tool("rename_tab", { tabId: tab.tabId, title: "Overview" });
    expect(renamed.body.tab.title).toBe("Overview");
    const status = await mcp.tool("set_doc_status", { docId: doc.docId, status: "plan" });
    expect(status.body.doc.status).toBe("plan");
    expect(mcp.api.broadcasts.at(-1)).toMatchObject({
      type: "doc.updated",
      doc: { id: doc.docId, status: "plan" },
    });
    const invalid = await mcp.tool("set_doc_status", { docId: doc.docId, status: "shipped" });
    expect(invalid.isError).toBe(true);

    const other = await mcp.tool("create_project", { name: "Other" });
    const listed = await mcp.tool("list_docs", { projectId: other.body.projectId });
    expect(listed.body.docs).toEqual([]);
    const everything = await mcp.tool("list_docs", {});
    expect(everything.body.docs[0]).toMatchObject({ docId: doc.docId, status: "plan" });
  });

  it("files docs by project key, creating the project once, or in no project", async () => {
    const mcp = await makeMcpHarness();
    const key = "github.com/acme/app";
    const first = await mcp.tool("create_doc", {
      projectKey: key,
      projectName: "T3 Code",
      title: "Plan",
    });
    expect(first.isError).toBe(false);
    const second = await mcp.tool("create_doc", {
      projectKey: key,
      projectName: "Renamed by an agent",
      title: "Notes",
    });
    expect(second.body.doc.projectId).toBe(first.body.doc.projectId);
    const loose = await mcp.tool("create_doc", { title: "Loose" });
    expect(loose.body.doc.projectId).toBeNull();

    const projects = await mcp.tool("list_projects", {});
    expect(projects.body).toEqual({
      projects: [{ projectId: first.body.doc.projectId, key, name: "T3 Code", docCount: 2 }],
      noProjectDocCount: 1,
    });
    const byKey = await mcp.tool("list_docs", { projectKey: key });
    expect(byKey.body.docs).toHaveLength(2);
    const unfiled = await mcp.tool("list_docs", { noProject: true });
    expect(unfiled.body.docs.map((doc: { docId: string }) => doc.docId)).toEqual([
      loose.body.doc.docId,
    ]);

    const both = await mcp.tool("create_doc", {
      projectKey: key,
      projectId: first.body.doc.projectId,
      title: "x",
    });
    expect(both.isError).toBe(true);
    const unknownId = await mcp.tool("create_doc", { projectId: "missing", title: "x" });
    expect(unknownId.body.error).toBe("not_found");
  });

  it("moves a doc by key, by id and to no project", async () => {
    const mcp = await makeMcpHarness();
    const { doc } = await mcp.seedDoc();
    const toKey = await mcp.tool("move_doc", {
      docId: doc.docId,
      projectKey: "title:Acme Netherlands",
    });
    expect(toKey.isError).toBe(false);
    const projects = await mcp.tool("list_projects", {});
    const acme = projects.body.projects.find(
      (project: { key: string }) => project.key === "title:acme netherlands",
    );
    expect(acme).toMatchObject({ name: "acme netherlands", docCount: 1 });
    expect(mcp.api.broadcasts.at(-1)).toMatchObject({
      type: "doc.updated",
      doc: { id: doc.docId, projectId: acme.projectId },
    });

    const toNone = await mcp.tool("move_doc", { docId: doc.docId, projectId: null });
    expect(toNone.body.doc.projectId).toBeNull();
    const nowhere = await mcp.tool("move_doc", { docId: doc.docId });
    expect(nowhere.isError).toBe(true);
    const missing = await mcp.tool("move_doc", { docId: "missing", projectId: null });
    expect(missing.body.error).toBe("not_found");
  });

  it("builds URLs from the public origin, not the request URL", async () => {
    const mcp = await makeMcpHarness("https://docs.example.com");
    const { doc, tab } = await mcp.seedDoc();
    expect(doc.url).toBe(`${ORIGIN}/d/${doc.docId}/${tab.tabId}`);
  });

  it("lists the threads started from a doc in read_doc", async () => {
    const mcp = await makeMcpHarness();
    const { doc } = await mcp.seedDoc();
    await mcp.api.call("POST", `/api/docs/${doc.docId}/threads`, {
      body: { environmentId: "env-1", threadId: "thread-1", title: "Build it" },
      headers: { Cookie: mcp.cookie },
    });
    const read = await mcp.tool("read_doc", { docId: doc.docId });
    expect(read.body.startedThreads).toEqual([
      { environmentId: "env-1", threadId: "thread-1", title: "Build it" },
    ]);
  });

  it("moves and deletes tabs through the room, with clear errors", async () => {
    const mcp = await makeMcpHarness();
    const { doc, tab } = await mcp.seedDoc("root");
    const second = await mcp.tool("create_tab", { docId: doc.docId, title: "Second" });
    const secondId = second.body.tab.tabId;

    const moved = await mcp.tool("move_tab", { tabId: secondId, parentTabId: tab.tabId });
    expect(moved.body.tab).toMatchObject({ parentTabId: tab.tabId, position: 0 });
    expect(mcp.api.broadcasts.at(-1)).toMatchObject({ type: "tab.moved" });
    const cycle = await mcp.tool("move_tab", { tabId: tab.tabId, parentTabId: secondId });
    expect(cycle).toMatchObject({ isError: true, body: { error: "invalid_move" } });

    const last = await mcp.tool("delete_tab", { tabId: tab.tabId });
    expect(last).toMatchObject({ isError: true, body: { error: "last_tab" } });
    const deleted = await mcp.tool("delete_tab", { tabId: secondId });
    expect(deleted.body.deletedTabIds).toEqual([secondId]);
    expect(mcp.api.broadcasts.at(-1)).toMatchObject({ type: "tab.deleted" });
  });

  it("comments on a quote, replies and resolves, authored by the MCP client", async () => {
    const mcp = await makeMcpHarness();
    await mcp.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "1" },
    });
    const { doc, tab } = await mcp.seedDoc(
      "# Plan\n\nShip **v1** by Friday.\n\n## Risks\n\nNone yet.\n",
    );

    const created = await mcp.tool("create_comment", {
      tabId: tab.tabId,
      quote: "**v1** by Friday",
      body: "Is Friday realistic?",
    });
    expect(created.body.comment).toMatchObject({
      author: "agent:claude-code",
      quote: "v1 by Friday",
    });
    expect(mcp.api.broadcasts.at(-1)).toMatchObject({ type: "comment.created" });
    const threadId = created.body.comment.commentId;

    const reply = await mcp.tool("reply_comment", {
      commentId: threadId,
      body: "Moved to Monday.",
    });
    expect(reply.body.reply).toMatchObject({ threadId, author: "agent:claude-code" });

    // The quoted words are rewritten; the thread follows the passage.
    await mcp.tool("edit_tab", { tabId: tab.tabId, find: "by Friday", replace: "by Monday" });
    const open = await mcp.tool("list_comments", { docId: doc.docId });
    expect(open.body.threads).toEqual([
      expect.objectContaining({
        commentId: threadId,
        anchor: null,
        status: "anchored",
        resolved: false,
        replies: [expect.objectContaining({ body: "Moved to Monday." })],
      }),
    ]);

    const resolved = await mcp.tool("resolve_comment", { commentId: threadId });
    expect(resolved.body).toEqual({ threadId, resolved: true });
    expect((await mcp.tool("list_comments", { docId: doc.docId })).body.threads).toEqual([]);

    await mcp.tool("write_tab", { tabId: tab.tabId, markdown: "Rewritten.", baseVersion: 3 });
    const all = await mcp.tool("list_comments", { docId: doc.docId, includeResolved: true });
    expect(all.body.threads[0]).toMatchObject({ resolved: true, status: "text_removed" });
  });

  it("names the token as author without clientInfo, and refuses a missing or ambiguous quote", async () => {
    const mcp = await makeMcpHarness();
    const { tab } = await mcp.seedDoc("TBD here.\n\nTBD there.\n");
    const missing = await mcp.tool("create_comment", {
      tabId: tab.tabId,
      quote: "Done",
      body: "?",
    });
    expect(missing).toMatchObject({ isError: true, body: { error: "quote_not_found" } });
    const ambiguous = await mcp.tool("create_comment", {
      tabId: tab.tabId,
      quote: "TBD",
      body: "?",
    });
    expect(ambiguous).toMatchObject({ isError: true, body: { error: "ambiguous_quote" } });
    expect(ambiguous.body.message).toContain("2 times");

    const created = await mcp.tool("create_comment", {
      tabId: tab.tabId,
      quote: "TBD there",
      body: "Fill this in.",
    });
    expect(created.body.comment.author).toBe("agent:agent");
    const unknown = await mcp.tool("reply_comment", { commentId: "nope", body: "x" });
    expect(unknown).toMatchObject({ isError: true, body: { error: "not_found" } });
  });
});

const TABLE = {
  id: "requests",
  columns: [
    { id: "req", name: "Request", type: "text" },
    {
      id: "status",
      name: "Status",
      type: "select",
      options: [
        { value: "Not started", color: "gray" },
        { value: "Done", color: "green" },
      ],
    },
    { id: "ticket", name: "Tickets", type: "link" },
  ],
  rows: [
    { id: "r1", cells: { req: "Fix Zebra MCP", status: "Not started" } },
    { id: "r2", cells: { req: "GitHub group", status: "Done" } },
  ],
};
const tableMarkdown = (table: unknown = TABLE) =>
  `# Requests\n\n\`\`\`t3-table\n${JSON.stringify(table)}\n\`\`\`\n\nAfter.\n`;

describe("MCP table tools", () => {
  it("rejects writes whose t3-table JSON is invalid, with the reason", async () => {
    const mcp = await makeMcpHarness();
    const { tab } = await mcp.seedDoc("Start.");
    const broken = await mcp.tool("write_tab", {
      tabId: tab.tabId,
      markdown: '```t3-table\n{"id": "t", "columns": [}\n```',
      baseVersion: 2,
    });
    expect(broken).toMatchObject({ isError: true, body: { error: "table_invalid" } });
    expect(broken.body.message).toContain("not valid JSON");

    const badOption = await mcp.tool("edit_tab", {
      tabId: tab.tabId,
      find: "Start.",
      replace: tableMarkdown({ ...TABLE, rows: [{ id: "r1", cells: { status: "Blocked" } }] }),
    });
    expect(badOption).toMatchObject({ isError: true, body: { error: "table_invalid" } });
    expect(badOption.body.message).toContain('"Blocked", which is not one of its options');

    const created = await mcp.tool("create_tab", {
      docId: (await mcp.tool("list_docs", {})).body.docs[0].docId,
      title: "T",
      markdown: tableMarkdown({ ...TABLE, columns: [{ id: "a", name: "A", type: "money" }] }),
    });
    expect(created.body.message).toContain('"type" must be one of');
  });

  it("updates a cell and adds rows through the room, so open editors get the tab", async () => {
    const mcp = await makeMcpHarness();
    const { tab } = await mcp.seedDoc(tableMarkdown());
    const before = mcp.api.broadcasts.length;

    const updated = await mcp.tool("update_table_cell", {
      tabId: tab.tabId,
      tableId: "requests",
      rowId: "r1",
      colId: "ticket",
      value: { text: "TASK-5575", url: "https://example.test/TASK-5575" },
    });
    expect(updated.isError).toBe(false);
    expect(mcp.api.broadcasts.length).toBe(before + 1);
    expect(mcp.api.broadcasts.at(-1)).toMatchObject({ type: "tab.updated", origin: null });

    const added = await mcp.tool("add_table_row", {
      tabId: tab.tabId,
      tableId: "requests",
      cells: { Request: "Add Iterable", status: "Done" },
      afterRowId: "r1",
    });
    const rowId = added.body.row.rowId as string;

    const { markdown } = await Docs.getTab(mcp.api.db, tab.tabId);
    expect(markdown.startsWith("# Requests\n\n```t3-table\n{\n")).toBe(true);
    expect(markdown.endsWith("\n```\n\nAfter.\n")).toBe(true);
    const body = JSON.parse(markdown.slice(markdown.indexOf("{"), markdown.lastIndexOf("}") + 1));
    expect(body.rows.map((row: { id: string }) => row.id)).toEqual(["r1", rowId, "r2"]);
    expect(body.rows[0].cells.ticket).toEqual({
      text: "TASK-5575",
      url: "https://example.test/TASK-5575",
    });
    expect(body.rows[1].cells).toEqual({ req: "Add Iterable", status: "Done" });
  });

  it("explains a bad id or value and writes nothing", async () => {
    const mcp = await makeMcpHarness();
    const { tab } = await mcp.seedDoc(tableMarkdown());
    const before = await Docs.getTab(mcp.api.db, tab.tabId);
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ tableId: "nope", rowId: "r1", colId: "req", value: "x" }, "table_not_found", "requests"],
      [{ tableId: "requests", rowId: "r9", colId: "req", value: "x" }, "invalid_value", '"r1"'],
      [
        { tableId: "requests", rowId: "r1", colId: "status", value: "Late" },
        "invalid_value",
        "Done",
      ],
      [
        {
          tableId: "requests",
          rowId: "r1",
          colId: "ticket",
          value: { text: "x", url: "javascript:1" },
        },
        "invalid_value",
        "http(s)",
      ],
    ];
    for (const [args, error, hint] of cases) {
      const result = await mcp.tool("update_table_cell", { tabId: tab.tabId, ...args });
      expect(result).toMatchObject({ isError: true, body: { error } });
      expect(result.body.message).toContain(hint);
    }
    const unknownColumn = await mcp.tool("add_table_row", {
      tabId: tab.tabId,
      tableId: "requests",
      cells: { Owner: "me" },
    });
    expect(unknownColumn.body.message).toContain("not a column id");
    expect((await Docs.getTab(mcp.api.db, tab.tabId)).version).toBe(before.version);
  });

  it("comments on a cell, keeps it through other edits, and orphans it with its row", async () => {
    const mcp = await makeMcpHarness();
    const { doc, tab } = await mcp.seedDoc(tableMarkdown());
    const anchor = { kind: "cell", blockId: "requests", rowId: "r2", colId: "req" };
    const created = await mcp.tool("create_comment", {
      tabId: tab.tabId,
      anchor,
      body: "Who owns this?",
    });
    expect(created.body.comment).toMatchObject({ quote: "GitHub group", anchor });
    const missing = await mcp.tool("create_comment", {
      tabId: tab.tabId,
      anchor: { ...anchor, rowId: "r9" },
      body: "?",
    });
    expect(missing).toMatchObject({ isError: true, body: { error: "anchor_not_found" } });

    // Other cells change and the rows swap; the thread keeps its cell.
    const current = await Docs.getTab(mcp.api.db, tab.tabId);
    await mcp.tool("write_tab", {
      tabId: tab.tabId,
      baseVersion: current.version,
      markdown: tableMarkdown({
        ...TABLE,
        rows: [
          { id: "r2", cells: { req: "GitHub marketing group" } },
          { id: "r1", cells: { req: "Fix Zebra", status: "Done" } },
        ],
      }),
    });
    const listed = await mcp.tool("list_comments", { docId: doc.docId });
    expect(listed.body.threads).toEqual([
      expect.objectContaining({ anchor, status: "anchored", quote: "GitHub group" }),
    ]);

    await mcp.tool("reply_comment", { commentId: created.body.comment.commentId, body: "Me." });
    const after = await Docs.getTab(mcp.api.db, tab.tabId);
    await mcp.tool("write_tab", {
      tabId: tab.tabId,
      baseVersion: after.version,
      markdown: tableMarkdown({ ...TABLE, rows: [TABLE.rows[0]] }),
    });
    const orphaned = await mcp.tool("list_comments", { docId: doc.docId });
    expect(orphaned.body.threads[0]).toMatchObject({
      status: "orphaned",
      replies: [expect.anything()],
    });
  });
});

describe("MCP diagrams", () => {
  const diagram = (id: string, code: string) => `\`\`\`t3-widget id=${id}\n${code}\n\`\`\``;
  const invalid = FLOW_EXAMPLE.replace("fill={ink}>Commit lands", "fill='#123456'>Commit lands");

  it("refuses writes that add an invalid diagram, naming the rule and position", async () => {
    const mcp = await makeMcpHarness();
    const { doc, tab } = await mcp.seedDoc("# Plan\n\nTODO");
    const created = await mcp.tool("create_tab", {
      docId: doc.docId,
      title: "Flow",
      markdown: diagram("flow", invalid),
    });
    expect(created.isError).toBe(true);
    expect(created.body.error).toBe("widget_invalid");
    expect(created.body.message).toMatch(/diagram 'flow' .* 1:\d+ colour:/);
    expect(created.body.problems[0].diagnostics[0]).toMatchObject({ rule: "colour", line: 1 });

    const edited = await mcp.tool("edit_tab", {
      tabId: tab.tabId,
      find: "TODO",
      replace: diagram("flow", invalid),
    });
    expect(edited.body.error).toBe("widget_invalid");
    const written = await mcp.tool("write_tab", {
      tabId: tab.tabId,
      markdown: diagram("", FLOW_EXAMPLE),
      baseVersion: 1,
    });
    expect(written.body.problems[0].diagnostics[0].rule).toBe("diagram-id");
    const read = await mcp.tool("read_doc", { docId: doc.docId, tabId: tab.tabId });
    expect(read.body.tab.markdown).toBe("# Plan\n\nTODO");
  });

  it("reads a diagram's code and text ids, and edits one label in place", async () => {
    const mcp = await makeMcpHarness();
    const markdown = `# Plan\n\n${diagram("release-flow", FLOW_EXAMPLE)}\n\nAfter.`;
    const { tab } = await mcp.seedDoc(markdown);

    const read = await mcp.tool("read_diagram", { tabId: tab.tabId, diagramId: "release-flow" });
    expect(read.body).toMatchObject({
      code: FLOW_EXAMPLE,
      title: "Only a green build reaches production",
      diagnostics: [],
    });
    expect(read.body.texts).toContainEqual({
      textId: "ship",
      text: "Ship to production",
      anchor: "step-ship",
    });

    const edit = await mcp.tool("edit_diagram_label", {
      tabId: tab.tabId,
      diagramId: "release-flow",
      textId: "ship",
      value: "THIS IS CHANGED",
    });
    expect(edit.body).toMatchObject({ changed: true, previous: "Ship to production" });
    const after = await mcp.tool("read_doc", {
      docId: (await mcp.tool("list_docs", {})).body.docs[0].docId,
      tabId: tab.tabId,
    });
    expect(after.body.tab.markdown).toBe(markdown.replace("Ship to production", "THIS IS CHANGED"));

    const missing = await mcp.tool("edit_diagram_label", {
      tabId: tab.tabId,
      diagramId: "release-flow",
      textId: "nope",
      value: "x",
    });
    expect(missing.body.error).toBe("unknown_text_id");
    expect(missing.body.textIds).toContain("ship");
    const noDiagram = await mcp.tool("read_diagram", { tabId: tab.tabId, diagramId: "other" });
    expect(noDiagram.body).toMatchObject({ error: "not_found", diagramIds: ["release-flow"] });
  });

  it("documents the format with an example that passes the validator", async () => {
    const { MCP_INSTRUCTIONS } = await import("./mcp.ts");
    const { findWidgetFences } = await import("../shared/widget/fence.ts");
    const { analyzeWidget } = await import("../shared/widget/validate.ts");
    const [example] = findWidgetFences(MCP_INSTRUCTIONS);
    expect(example?.id).toBe("release-flow");
    expect(analyzeWidget(example!.source).diagnostics).toEqual([]);
  });

  it("comments on a diagram label, and orphans the thread when the label goes", async () => {
    const mcp = await makeMcpHarness();
    const { doc, tab } = await mcp.seedDoc(diagram("release-flow", FLOW_EXAMPLE));
    const anchor = { kind: "label", blockId: "release-flow", textId: "notify" };
    const created = await mcp.tool("create_comment", { tabId: tab.tabId, anchor, body: "Who?" });
    expect(created.body.comment).toMatchObject({ anchor, quote: "Notify the author" });
    const missing = await mcp.tool("create_comment", {
      tabId: tab.tabId,
      anchor: { ...anchor, textId: "gone" },
      body: "?",
    });
    expect(missing.body.error).toBe("anchor_not_found");

    const withoutLabel = FLOW_EXAMPLE.replace(
      /<text data-claude-text-id='notify'[^>]*>Notify the author<\/text>/,
      "",
    );
    const current = await Docs.getTab(mcp.api.db, tab.tabId);
    const written = await mcp.tool("write_tab", {
      tabId: tab.tabId,
      baseVersion: current.version,
      markdown: diagram("release-flow", withoutLabel),
    });
    expect(written.isError).toBe(false);
    const listed = await mcp.tool("list_comments", { docId: doc.docId });
    expect(listed.body.threads[0]).toMatchObject({ anchor, status: "orphaned" });
  });
});
