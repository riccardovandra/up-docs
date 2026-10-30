import { describe, expect, it } from "vitest";

import type {
  AccessibleLibraryProject,
  DocMember,
  DocRole,
  LibraryDoc,
  Me,
} from "../shared/access.ts";
import type { DocWithTabs } from "../shared/protocol.ts";
import * as Access from "./access.ts";
import { handleMcp } from "./mcp.ts";
import { makeApiHarness, ORIGIN, OWNER } from "./testing/apiHarness.ts";
import { applyMigrationsFrom, makeTestD1 } from "./testing/sqliteD1.ts";

type Api = ReturnType<typeof makeApiHarness>;

async function body<A>(response: Response): Promise<A> {
  return (await response.json()) as A;
}

/** The admin signs in and creates a project with one doc. */
async function setup() {
  const api = makeApiHarness();
  const owner = await api.signIn();
  const as = (cookie: string) => ({ Cookie: cookie });
  const { project } = await body<{ project: { id: string } }>(
    await api.call("POST", "/api/projects", { body: { name: "Acme" }, headers: as(owner) }),
  );
  const doc = await body<DocWithTabs>(
    await api.call("POST", "/api/docs", {
      body: { projectId: project.id, title: "Plan" },
      headers: as(owner),
    }),
  );
  const docId = doc.doc.id;
  const tab = doc.tabs[0]!;
  const share = async (email: string, role: DocRole, cookie = owner) =>
    api.call("POST", `/api/docs/${docId}/members`, {
      body: { email, role },
      headers: as(cookie),
    });
  /** Shares the doc with `email` at `role` and signs them in. */
  const person = async (email: string, role: DocRole) => {
    await share(email, role);
    return api.signIn(email);
  };
  const members = async (cookie = owner) =>
    (
      await body<{ members: Array<DocMember> }>(
        await api.call("GET", `/api/docs/${docId}/members`, { headers: as(cookie) }),
      )
    ).members;
  return { api, owner, as, projectId: project.id, docId, tab, share, person, members };
}

async function mintToken(api: Api, cookie: string): Promise<string> {
  const created = await api.call("POST", "/api/tokens", {
    body: { name: "agent" },
    headers: { Cookie: cookie },
  });
  return (await body<{ token: string }>(created)).token;
}

async function mcpTool(api: Api, token: string, name: string, args: Record<string, unknown>) {
  const response = await handleMcp(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    api.deps,
  );
  const { result } = await body<{
    result: { isError?: boolean; content: Array<{ text: string }> };
  }>(response);
  return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) as any };
}

describe("accounts", () => {
  it("signs every OWNER_EMAILS address in as the one admin, with the same tokens", async () => {
    const { api, owner } = await setup();
    await mintToken(api, owner);
    const second = await api.signIn("second@example.com");

    const me = await body<Me>(await api.call("GET", "/api/me", { headers: { Cookie: second } }));
    expect(me.user).toEqual({ id: Access.OWNER_USER_ID, name: "Owner", email: OWNER });
    expect(me.emails).toEqual([OWNER, "second@example.com"]);
    const tokens = await body<{ tokens: Array<unknown> }>(
      await api.call("GET", "/api/tokens", { headers: { Cookie: second } }),
    );
    expect(tokens.tokens).toHaveLength(1);
    const library = await body<{ projects: Array<AccessibleLibraryProject> }>(
      await api.call("GET", "/api/library", { headers: { Cookie: second } }),
    );
    expect(library.projects[0]!.docs[0]!.role).toBe("owner");
  });

  it("sends codes only to owners and people a doc was shared with, answering alike", async () => {
    const { api, share } = await setup();
    const stranger = await api.call("POST", "/api/auth/request-code", {
      body: { email: "stranger@example.com" },
    });
    expect(await stranger.json()).toEqual({ ok: true });
    expect(api.sentCodes.map((entry) => entry.email)).not.toContain("stranger@example.com");

    await share("Guest@Example.com", "viewer");
    await api.call("POST", "/api/auth/request-code", { body: { email: "guest@example.com" } });
    expect(api.sentCodes.map((entry) => entry.email)).toContain("guest@example.com");
  });

  it("keeps a pending invite until first sign-in, then shows the doc as shared", async () => {
    const { api, owner, docId, tab, share, members, as } = await setup();
    await api.call("POST", "/api/projects", { body: { name: "Private" }, headers: as(owner) });

    const shared = await share("guest@example.com", "editor");
    expect(shared.status).toBe(201);
    expect((await members()).find((m) => m.email === "guest@example.com")).toMatchObject({
      pending: true,
      user: null,
      role: "editor",
    });
    expect(api.invites).toEqual([
      {
        to: "guest@example.com",
        inviterName: "Owner",
        docTitle: "Plan",
        url: `${ORIGIN}/d/${docId}/${tab.id}`,
      },
    ]);

    const guest = await api.signIn("guest@example.com");
    const claimed = (await members()).find((m) => m.email === "guest@example.com")!;
    expect(claimed).toMatchObject({ pending: false, role: "editor" });
    expect(claimed.user?.id).toEqual(expect.any(String));

    const library = await body<{ projects: Array<AccessibleLibraryProject> }>(
      await api.call("GET", "/api/library", { headers: as(guest) }),
    );
    // Only the project holding the shared doc, not the admin's other projects.
    expect(library.projects.map((project) => project.name)).toEqual(["Acme"]);
    const doc: LibraryDoc = library.projects[0]!.docs[0]!;
    expect(doc).toMatchObject({
      id: docId,
      role: "editor",
      owner: { id: Access.OWNER_USER_ID, name: "Owner", email: OWNER },
    });
  });

  it("lets a person set their display name", async () => {
    const { api, person } = await setup();
    const guest = await person("guest@example.com", "viewer");
    const updated = await api.call("PATCH", "/api/me", {
      body: { name: "Guest Person" },
      headers: { Cookie: guest },
    });
    expect((await body<Me>(updated)).user).toMatchObject({
      name: "Guest Person",
      email: "guest@example.com",
    });
  });

  it("gives new tokens to the person who minted them, and limits agents to that person's role", async () => {
    const { api, docId, tab, person } = await setup();
    const viewer = await person("viewer@example.com", "viewer");
    const token = await mintToken(api, viewer);
    const bearer = { Authorization: `Bearer ${token}` };

    expect((await api.call("GET", `/api/docs/${docId}`, { headers: bearer })).status).toBe(200);
    const write = await api.call("PATCH", `/api/tabs/${tab.id}`, {
      body: { baseVersion: tab.version, markdown: "agent" },
      headers: bearer,
    });
    expect(write.status).toBe(403);
    // The admin does not see someone else's tokens.
    const ownerTokens = await body<{ tokens: Array<unknown> }>(
      await api.call("GET", "/api/tokens", { headers: { Cookie: await api.signIn() } }),
    );
    expect(ownerTokens.tokens).toHaveLength(0);
  });
});

describe("roles per route class", () => {
  const cases: ReadonlyArray<{
    role: DocRole | "stranger";
    read: number;
    comment: number;
    edit: number;
    share: number;
  }> = [
    { role: "stranger", read: 404, comment: 404, edit: 404, share: 404 },
    { role: "viewer", read: 200, comment: 403, edit: 403, share: 403 },
    { role: "commenter", read: 200, comment: 201, edit: 403, share: 403 },
    { role: "editor", read: 200, comment: 201, edit: 200, share: 403 },
    { role: "owner", read: 200, comment: 201, edit: 200, share: 201 },
  ];

  it.each(cases)(
    "$role: read $read, comment $comment, edit $edit, share $share",
    async (expected) => {
      const { api, owner, as, projectId, docId, tab, person } = await setup();
      let cookie: string;
      if (expected.role === "stranger") {
        // Signed in through a different doc, so they exist but are not on this one.
        const other = await body<DocWithTabs>(
          await api.call("POST", "/api/docs", {
            body: { projectId, title: "Other" },
            headers: as(owner),
          }),
        );
        await api.call("POST", `/api/docs/${other.doc.id}/members`, {
          body: { email: "person@example.com", role: "viewer" },
          headers: as(owner),
        });
        cookie = await api.signIn("person@example.com");
      } else {
        cookie = await person("person@example.com", expected.role);
      }

      expect((await api.call("GET", `/api/docs/${docId}`, { headers: as(cookie) })).status).toBe(
        expected.read,
      );
      expect((await api.call("GET", `/api/tabs/${tab.id}`, { headers: as(cookie) })).status).toBe(
        expected.read,
      );
      const comment = await api.call("POST", `/api/tabs/${tab.id}/comments`, {
        body: { quote: "x", body: "note" },
        headers: as(cookie),
      });
      expect(comment.status).toBe(expected.comment);
      const edit = await api.call("PATCH", `/api/tabs/${tab.id}`, {
        body: { baseVersion: tab.version, markdown: "changed" },
        headers: as(cookie),
      });
      expect(edit.status).toBe(expected.edit);
      const status = await api.call("PATCH", `/api/docs/${docId}`, {
        body: { status: "plan" },
        headers: as(cookie),
      });
      expect(status.status).toBe(expected.edit);
      const share = await api.call("POST", `/api/docs/${docId}/members`, {
        body: { email: "third@example.com", role: "viewer" },
        headers: as(cookie),
      });
      expect(share.status).toBe(expected.share);
    },
  );

  it("returns the caller's role and the doc's owner with the doc", async () => {
    const { api, docId, person } = await setup();
    const commenter = await person("c@example.com", "commenter");
    const doc = await body<{ role: DocRole; owner: { id: string } }>(
      await api.call("GET", `/api/docs/${docId}`, { headers: { Cookie: commenter } }),
    );
    expect(doc.role).toBe("commenter");
    expect(doc.owner.id).toBe(Access.OWNER_USER_ID);
  });

  it("only lets the admin create projects, and others create docs only where they can see", async () => {
    const { api, projectId, person, as } = await setup();
    const editor = await person("e@example.com", "editor");
    const project = await api.call("POST", "/api/projects", {
      body: { name: "Mine" },
      headers: as(editor),
    });
    expect(project.status).toBe(403);
    const created = await body<DocWithTabs & { error?: string }>(
      await api.call("POST", "/api/docs", {
        body: { projectId, title: "Theirs" },
        headers: as(editor),
      }),
    );
    const own = await body<{ role: DocRole }>(
      await api.call("GET", `/api/docs/${created.doc.id}`, { headers: as(editor) }),
    );
    expect(own.role).toBe("owner");
    // Docs are private: the admin does not see a doc nobody shared with them.
    expect(
      (await api.call("GET", `/api/docs/${created.doc.id}`, { headers: as(await api.signIn()) }))
        .status,
    ).toBe(404);
  });

  it("lets people edit only their own comments, and owners delete any", async () => {
    const { api, owner, tab, person, as } = await setup();
    await api.call("PATCH", `/api/tabs/${tab.id}`, {
      body: { baseVersion: tab.version, markdown: "hello world" },
      headers: as(owner),
    });
    const commenter = await person("c@example.com", "commenter");
    const created = await body<{ comment: { id: string } }>(
      await api.call("POST", `/api/tabs/${tab.id}/comments`, {
        body: { quote: "hello", body: "mine" },
        headers: as(commenter),
      }),
    );
    const ownerEdit = await api.call("PATCH", `/api/comments/${created.comment.id}`, {
      body: { body: "rewritten" },
      headers: as(owner),
    });
    expect(ownerEdit.status).toBe(403);
    const ownerDelete = await api.call("DELETE", `/api/comments/${created.comment.id}`, {
      headers: as(owner),
    });
    expect(ownerDelete.status).toBe(200);
  });
});

describe("sharing with yourself", () => {
  it("refuses an address that signs in as the caller instead of changing their role", async () => {
    const { share, members } = await setup();
    const response = await share("second@example.com", "commenter");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "self" });
    expect((await members()).map((m) => [m.email, m.role])).toEqual([[OWNER, "owner"]]);
  });
});

describe("last owner", () => {
  it("refuses to demote or remove the last owner, until another owner exists", async () => {
    const { api, owner, docId, members, person } = await setup();
    const own = (await members())[0]!;
    const demote = await api.call("PATCH", `/api/docs/${docId}/members/${own.id}`, {
      body: { role: "editor" },
      headers: { Cookie: owner },
    });
    expect(demote.status).toBe(409);
    expect(await demote.json()).toEqual({ error: "last_owner" });
    const remove = await api.call("DELETE", `/api/docs/${docId}/members/${own.id}`, {
      headers: { Cookie: owner },
    });
    expect(remove.status).toBe(409);

    await person("co@example.com", "owner");
    const demoted = await api.call("PATCH", `/api/docs/${docId}/members/${own.id}`, {
      body: { role: "editor" },
      headers: { Cookie: owner },
    });
    expect(demoted.status).toBe(200);
  });

  it("lets a member leave but not remove others", async () => {
    const { api, docId, members, person } = await setup();
    const editor = await person("e@example.com", "editor");
    await person("v@example.com", "viewer");
    const list = await members();
    const viewerRow = list.find((m) => m.email === "v@example.com")!;
    const editorRow = list.find((m) => m.email === "e@example.com")!;
    const kick = await api.call("DELETE", `/api/docs/${docId}/members/${viewerRow.id}`, {
      headers: { Cookie: editor },
    });
    expect(kick.status).toBe(403);
    const leave = await api.call("DELETE", `/api/docs/${docId}/members/${editorRow.id}`, {
      headers: { Cookie: editor },
    });
    expect(leave.status).toBe(200);
    expect(
      (await api.call("GET", `/api/docs/${docId}`, { headers: { Cookie: editor } })).status,
    ).toBe(404);
  });
});

describe("people suggestions", () => {
  it("suggests everyone on the caller's docs, never the caller or strangers", async () => {
    const { api, owner, as, projectId, person, share } = await setup();
    const editor = await person("e@example.com", "editor");
    await share("pending@example.com", "viewer");
    // On a doc the editor is not on.
    const other = await body<DocWithTabs>(
      await api.call("POST", "/api/docs", {
        body: { projectId, title: "Private" },
        headers: as(owner),
      }),
    );
    await api.call("POST", `/api/docs/${other.doc.id}/members`, {
      body: { email: "stranger@example.com", role: "viewer" },
      headers: as(owner),
    });
    await api.call("PATCH", "/api/me", { body: { name: "Eve" }, headers: as(editor) });

    const people = async (cookie: string) =>
      (
        await body<{ people: Array<{ name: string; email: string }> }>(
          await api.call("GET", "/api/people", { headers: as(cookie) }),
        )
      ).people;
    expect(await people(owner)).toEqual([
      { name: "Eve", email: "e@example.com" },
      { name: "", email: "pending@example.com" },
      { name: "", email: "stranger@example.com" },
    ]);
    expect(await people(editor)).toEqual([
      { name: "Owner", email: OWNER },
      { name: "", email: "pending@example.com" },
    ]);
  });
});

describe("doc sockets", () => {
  const upgrade = (cookie: string) => ({ Cookie: cookie, Upgrade: "websocket" });

  it("lets a viewer listen but not write, and closes the socket when access is removed", async () => {
    const { api, owner, docId, tab, person, members } = await setup();
    const viewer = await person("v@example.com", "viewer");

    const socket = await api.call("GET", `/api/docs/${docId}/ws`, { headers: upgrade(viewer) });
    expect(socket.status).toBe(204);
    const viewerId = (await members()).find((m) => m.email === "v@example.com")!.user!.id;
    expect(api.sockets).toEqual([{ docId, userId: viewerId, open: true }]);

    for (const write of [
      api.call("PATCH", `/api/tabs/${tab.id}`, {
        body: { baseVersion: tab.version, markdown: "x" },
        headers: { Cookie: viewer },
      }),
      api.call("POST", `/api/docs/${docId}/tabs`, {
        body: { title: "x" },
        headers: { Cookie: viewer },
      }),
      api.call("DELETE", `/api/tabs/${tab.id}`, { headers: { Cookie: viewer } }),
    ]) {
      expect((await write).status).toBe(403);
    }
    expect(api.broadcasts.filter((message) => message.type.startsWith("tab."))).toEqual([]);

    const row = (await members()).find((m) => m.email === "v@example.com")!;
    await api.call("DELETE", `/api/docs/${docId}/members/${row.id}`, {
      headers: { Cookie: owner },
    });
    expect(api.sockets[0]!.open).toBe(false);
  });

  it("refuses a socket to someone not on the doc", async () => {
    const { api, projectId, owner, docId } = await setup();
    const other = await body<DocWithTabs>(
      await api.call("POST", "/api/docs", {
        body: { projectId, title: "Other" },
        headers: { Cookie: owner },
      }),
    );
    await api.call("POST", `/api/docs/${other.doc.id}/members`, {
      body: { email: "person@example.com", role: "editor" },
      headers: { Cookie: owner },
    });
    const stranger = await api.signIn("person@example.com");
    const response = await api.call("GET", `/api/docs/${docId}/ws`, {
      headers: upgrade(stranger),
    });
    expect(response.status).toBe(404);
    expect(api.sockets).toEqual([]);
  });
});

describe("MCP sharing", () => {
  it("lets an owner's agent share, list and unshare, and holds others' agents to their role", async () => {
    const { api, owner, docId, tab, person } = await setup();
    const ownerToken = await mintToken(api, owner);

    const shared = await mcpTool(api, ownerToken, "share_doc", {
      docId,
      email: "c@example.com",
      role: "commenter",
    });
    expect(shared.body).toMatchObject({
      added: true,
      member: { role: "commenter", pending: true },
    });
    expect(api.invites.map((invite) => invite.to)).toEqual(["c@example.com"]);

    const commenter = await api.signIn("c@example.com");
    const agent = await mintToken(api, commenter);
    const read = await mcpTool(api, agent, "read_doc", { docId });
    expect(read.body.doc.role).toBe("commenter");
    const write = await mcpTool(api, agent, "write_tab", {
      tabId: tab.id,
      markdown: "x",
      baseVersion: tab.version,
    });
    expect(write).toMatchObject({ isError: true, body: { error: "forbidden" } });
    expect(
      (await mcpTool(api, agent, "share_doc", { docId, email: "z@example.com", role: "owner" }))
        .body.error,
    ).toBe("forbidden");

    const listed = await mcpTool(api, agent, "list_members", { docId });
    expect(
      listed.body.members.map((m: { email: string; role: string }) => [m.email, m.role]),
    ).toEqual([
      [OWNER, "owner"],
      ["c@example.com", "commenter"],
    ]);

    await person("v@example.com", "viewer");
    const removed = await mcpTool(api, ownerToken, "unshare_doc", {
      docId,
      email: "v@example.com",
    });
    expect(removed.body.members).toHaveLength(2);
    const lastOwner = await mcpTool(api, ownerToken, "unshare_doc", { docId, email: OWNER });
    expect(lastOwner.body.error).toBe("last_owner");

    const listedDocs = await mcpTool(api, agent, "list_docs", {});
    expect(listedDocs.body.docs.map((doc: { docId: string }) => doc.docId)).toEqual([docId]);
  });
});

describe("projects and access", () => {
  it("keeps project sync and new projects with the admin", async () => {
    const { api, owner, person, as } = await setup();
    const editor = await person("e@example.com", "editor");
    const sync = (cookie: string) =>
      api.call("POST", "/api/projects/sync", {
        body: { projects: [{ key: "github.com/up/site", name: "Site" }] },
        headers: as(cookie),
      });
    expect((await sync(editor)).status).toBe(403);
    expect((await sync(owner)).status).toBe(200);

    const agent = await mintToken(api, editor);
    const fresh = await mcpTool(api, agent, "create_doc", {
      projectKey: "github.com/someone/else",
      title: "x",
    });
    expect(fresh.body.error).toBe("forbidden");
    // The synced project holds no doc shared with them, so it is hidden.
    const hidden = await mcpTool(api, agent, "create_doc", {
      projectKey: "github.com/up/site",
      title: "x",
    });
    expect(hidden.body.error).toBe("not_found");
    const loose = await mcpTool(api, agent, "create_doc", { title: "Mine" });
    expect(loose.body.doc.projectId).toBeNull();
  });

  it("scopes no-project docs to their members", async () => {
    const { api, owner, person, as } = await setup();
    const editor = await person("e@example.com", "editor");
    await api.call("POST", "/api/docs", {
      body: { projectId: null, title: "Private" },
      headers: as(owner),
    });
    const library = await body<{ noProjectDocs: Array<LibraryDoc> }>(
      await api.call("GET", "/api/library", { headers: as(editor) }),
    );
    expect(library.noProjectDocs).toEqual([]);
    const own = await body<{ noProjectDocs: Array<LibraryDoc> }>(
      await api.call("GET", "/api/library", { headers: as(owner) }),
    );
    expect(own.noProjectDocs.map((doc) => [doc.title, doc.role])).toEqual([["Private", "owner"]]);
  });

  it("moves a doc only with editor access, into a project the mover can see", async () => {
    const { api, owner, docId, projectId, person, as } = await setup();
    const viewer = await person("v@example.com", "viewer");
    const editor = await person("e@example.com", "editor");
    const move = (cookie: string, target: string | null) =>
      api.call("PATCH", `/api/docs/${docId}`, { body: { projectId: target }, headers: as(cookie) });
    expect((await move(viewer, null)).status).toBe(403);

    const { project: other } = await body<{ project: { id: string } }>(
      await api.call("POST", "/api/projects", { body: { name: "Other" }, headers: as(owner) }),
    );
    expect((await move(editor, other.id)).status).toBe(404);
    expect((await move(editor, null)).status).toBe(200);
    expect((await move(editor, projectId)).status).toBe(404);
    expect((await move(owner, projectId)).status).toBe(200);

    const agent = await mintToken(api, viewer);
    const byAgent = await mcpTool(api, agent, "move_doc", { docId, projectId: null });
    expect(byAgent.body.error).toBe("forbidden");
  });
});

describe("migration 0004 backfill", () => {
  it("gives existing docs and tokens to the admin", async () => {
    const db = makeTestD1({ before: "0004" });
    await db.batch([
      db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p', 'Old', 1)"),
      db.prepare(
        "INSERT INTO docs (id, project_id, title, created_at, updated_at) VALUES ('d1', 'p', 'A', 1, 1), ('d2', 'p', 'B', 2, 2)",
      ),
      db.prepare(
        "INSERT INTO api_tokens (id, name, token_hash, created_at) VALUES ('t', 'agent', 'hash', 1)",
      ),
    ]);
    await applyMigrationsFrom(db, "0004");

    expect(await Access.docRole(db, "d1", Access.OWNER_USER_ID)).toBe("owner");
    expect(await Access.docRole(db, "d2", Access.OWNER_USER_ID)).toBe("owner");
    const token = await db
      .prepare("SELECT user_id FROM api_tokens WHERE id = 't'")
      .first<{ user_id: string }>();
    expect(token?.user_id).toBe(Access.OWNER_USER_ID);
    const owners = new Set(["a@example.com"]);
    expect(await Access.getUser(db, Access.OWNER_USER_ID, owners)).toEqual({
      id: Access.OWNER_USER_ID,
      name: "Owner",
      email: "a@example.com",
    });
  });
});

describe("rich table access", () => {
  it("lets a commenter comment on a cell but only an editor change the table", async () => {
    const { api, owner, as, tab, person } = await setup();
    const table = {
      id: "t1",
      columns: [{ id: "a", name: "A", type: "text" }],
      rows: [{ id: "r1", cells: { a: "x" } }],
    };
    await api.call("PATCH", `/api/tabs/${tab.id}`, {
      body: {
        baseVersion: tab.version,
        markdown: `\`\`\`t3-table\n${JSON.stringify(table)}\n\`\`\``,
      },
      headers: as(owner),
    });
    const commenter = await mintToken(api, await person("c@example.com", "commenter"));
    const editor = await mintToken(api, await person("e@example.com", "editor"));
    const cell = { tabId: tab.id, tableId: "t1", rowId: "r1", colId: "a", value: "y" };
    const anchor = { kind: "cell", blockId: "t1", rowId: "r1", colId: "a" };

    const comment = await mcpTool(api, commenter, "create_comment", {
      tabId: tab.id,
      anchor,
      body: "?",
    });
    expect(comment.isError).toBe(false);
    for (const [name, args] of [
      ["update_table_cell", cell],
      ["add_table_row", { tabId: tab.id, tableId: "t1", cells: {} }],
    ] as const) {
      expect(await mcpTool(api, commenter, name, args)).toMatchObject({
        isError: true,
        body: { error: "forbidden" },
      });
    }
    expect((await mcpTool(api, editor, "update_table_cell", cell)).isError).toBe(false);
  });
});
