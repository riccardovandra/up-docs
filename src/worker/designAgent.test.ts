import { afterEach, describe, expect, it, vi } from "vitest";

import { designAgentSocketPath } from "../shared/design.ts";
import {
  allowedDesignTools,
  designAgentSocketUrl,
  designToolCategory,
  forwardDesignCommand,
  handleDesignAgentSocket,
  handleDesignAgentTicket,
  loadDesignTools,
  parseDesignTools,
} from "./designAgent.ts";
import { DESIGN_TICKET_TTL_MS } from "./designBridge.ts";
import { ORIGIN } from "./testing/apiHarness.ts";
import { makeDesignRooms, TOOL_LIST_FIXTURE } from "./testing/designHarness.ts";
import { makeMcpHarness } from "./testing/mcpHarness.ts";

const EDITOR = "https://design.docs.test";

afterEach(() => vi.useRealTimers());

/** The admin signed in, a design of theirs, and its rooms. */
async function setup() {
  const mcp = await makeMcpHarness();
  const rooms = makeDesignRooms();
  // The ticket route reads the session at the harness clock.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(mcp.api.clock.now);
  rooms.clock.now = mcp.api.clock.now;
  const created = await mcp.api.call("POST", "/api/designs", {
    body: { title: "Landing" },
    headers: { Cookie: mcp.cookie, Origin: ORIGIN },
  });
  const { design } = (await created.json()) as { design: { id: string } };
  const ticketRoute = (
    designId: string,
    init: { cookie?: string | null; origin?: string | null; body?: unknown; type?: string; method?: string; bearer?: string } = {},
  ) => {
    const headers: Record<string, string> = { "Content-Type": init.type ?? "application/json" };
    if (init.cookie !== null) headers.Cookie = init.cookie ?? mcp.cookie;
    if (init.origin !== null) headers.Origin = init.origin ?? ORIGIN;
    if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
    return handleDesignAgentTicket(
      new Request(`${ORIGIN}/api/designs/${designId}/agent-ticket`, {
        method: init.method ?? "POST",
        headers,
        ...(init.method === "GET" ? {} : { body: JSON.stringify(init.body ?? {}) }),
      }),
      { ...mcp.api.deps, room: rooms.room },
    );
  };
  const socketRoute = (url: string, headers: Record<string, string> = {}, method = "GET") =>
    handleDesignAgentSocket(new Request(url, { method, headers }), {
      editorOrigin: EDITOR,
      room: rooms.room,
    });
  return { mcp, rooms, designId: design.id, ticketRoute, socketRoute };
}

const ticketOf = (socketURL: string) => new URL(socketURL).searchParams.get("ticket")!;
const asHttp = (socketURL: string) => socketURL.replace(/^ws/, "http");
const HANDSHAKE = { Upgrade: "websocket", Origin: EDITOR, "Sec-WebSocket-Key": "k", "Sec-WebSocket-Version": "13" };

describe("the agent ticket route", () => {
  it("hands the design page a socket address with a one-use ticket", async () => {
    const { designId, ticketRoute, socketRoute, rooms } = await setup();
    const response = (await ticketRoute(designId))!;
    expect(response.status).toBe(200);
    const body = (await response.json()) as { socketURL: string; expiresAt: string; connected: boolean };
    expect(body.connected).toBe(false);
    expect(body.socketURL).toBe(designAgentSocketUrl(ORIGIN, designId, ticketOf(body.socketURL)));
    expect(body.socketURL.startsWith(`wss://docs.test${designAgentSocketPath(designId)}?ticket=`)).toBe(true);
    expect(Date.parse(body.expiresAt)).toBe(rooms.clock.now + DESIGN_TICKET_TTL_MS);

    expect((await socketRoute(asHttp(body.socketURL), HANDSHAKE))!.status).toBe(200);
    expect(await rooms.room(designId).status()).toEqual({ connected: true });
    // One use.
    expect((await socketRoute(asHttp(body.socketURL), HANDSHAKE))!.status).toBe(403);
  });

  it("refuses a ticket after it expires, and one issued for another design", async () => {
    const { mcp, designId, ticketRoute, socketRoute, rooms } = await setup();
    const other = (await (
      await mcp.api.call("POST", "/api/designs", {
        body: { title: "Other" },
        headers: { Cookie: mcp.cookie, Origin: ORIGIN },
      })
    ).json()) as { design: { id: string } };
    const { socketURL } = (await (await ticketRoute(designId))!.json()) as { socketURL: string };
    const elsewhere = asHttp(socketURL).replace(designId, other.design.id);
    expect((await socketRoute(elsewhere, HANDSHAKE))!.status).toBe(403);

    const late = (await (await ticketRoute(designId))!.json()) as { socketURL: string };
    rooms.clock.now += DESIGN_TICKET_TTL_MS;
    expect((await socketRoute(asHttp(late.socketURL), HANDSHAKE))!.status).toBe(403);
    expect(await rooms.room(designId).status()).toEqual({ connected: false });
  });

  it("answers connected instead of a ticket while an editor holds the socket, when asked", async () => {
    const { designId, ticketRoute, rooms } = await setup();
    const check = async () =>
      (await (await ticketRoute(designId, { body: { ifDisconnected: true } }))!.json()) as {
        connected: boolean;
        socketURL?: string;
      };
    expect((await check()).socketURL).toBeTruthy();
    await rooms.open(designId);
    expect(await check()).toEqual({ connected: true });
    rooms.close(designId);
    expect((await check()).connected).toBe(false);
  });

  it("is for the signed-in design page only: session, editor role, own origin, JSON", async () => {
    const { mcp, designId, ticketRoute } = await setup();
    expect((await ticketRoute(designId, { cookie: null }))!.status).toBe(401);
    // An agent's API token gets no ticket.
    expect((await ticketRoute(designId, { cookie: null, bearer: mcp.token }))!.status).toBe(401);
    expect((await ticketRoute(designId, { origin: "https://evil.test" }))!.status).toBe(403);
    expect((await ticketRoute(designId, { origin: EDITOR }))!.status).toBe(403);
    expect((await ticketRoute(designId, { type: "text/plain" }))!.status).toBe(415);
    expect((await ticketRoute(designId, { method: "GET" }))!.status).toBe(405);
    expect((await ticketRoute("nope"))!.status).toBe(404);

    // Someone not on the design does not learn it exists; a viewer may not edit it.
    const seeded = await mcp.seedDoc("x");
    await mcp.tool("share_doc", { docId: seeded.doc.docId, email: "viewer@example.com", role: "viewer" });
    const cookie = await mcp.api.signIn("viewer@example.com");
    expect((await ticketRoute(designId, { cookie }))!.status).toBe(404);
    const user = await mcp.api.db
      .prepare("SELECT id FROM users WHERE email = ?")
      .bind("viewer@example.com")
      .first<{ id: string }>();
    await mcp.api.db
      .prepare(
        "INSERT INTO design_members (id, design_id, user_id, role, created_at) VALUES ('m1', ?, ?, 'viewer', 0)",
      )
      .bind(designId, user!.id)
      .run();
    const viewer = (await ticketRoute(designId, { cookie }))!;
    expect(viewer.status).toBe(403);
    expect(await viewer.json()).toEqual({ error: "forbidden", required: "editor" });
    await mcp.api.db.prepare("UPDATE design_members SET role = 'editor' WHERE id = 'm1'").run();
    expect((await ticketRoute(designId, { cookie }))!.status).toBe(200);
  });

  it("leaves other paths alone", async () => {
    const response = await handleDesignAgentTicket(new Request(`${ORIGIN}/api/designs/x`), {
      db: undefined as never,
      owners: new Set(),
      publicOrigin: ORIGIN,
      now: () => 0,
      room: () => {
        throw new Error("no room");
      },
    });
    expect(response).toBeNull();
  });
});

describe("the agent socket route", () => {
  it("takes the editor's handshake with a ticket and nothing else, and never forwards the cookie", async () => {
    const { designId, ticketRoute, socketRoute, rooms } = await setup();
    const { socketURL } = (await (await ticketRoute(designId))!.json()) as { socketURL: string };
    const url = asHttp(socketURL);
    const base = `https://docs.test${designAgentSocketPath(designId)}`;
    expect(await socketRoute(`${base}/x`, HANDSHAKE)).toBeNull();
    expect(await socketRoute(`https://docs.test/api/designs/${designId}/agent-ticket`, HANDSHAKE)).toBeNull();
    expect((await socketRoute(url, HANDSHAKE, "POST"))!.status).toBe(405);
    expect((await socketRoute(url, { Origin: EDITOR }))!.status).toBe(426);
    expect((await socketRoute(url, { ...HANDSHAKE, Origin: ORIGIN }))!.status).toBe(403);
    expect((await socketRoute(url, { Upgrade: "websocket" }))!.status).toBe(403);
    expect((await socketRoute(base, HANDSHAKE))!.status).toBe(403);
    expect((await socketRoute(`${base}?ticket=short`, HANDSHAKE))!.status).toBe(403);
    // None of those reached the room or spent the ticket.
    expect(rooms.handshakes).toHaveLength(0);

    const opened = (await socketRoute(url, { ...HANDSHAKE, Cookie: "session=secret", Authorization: "Bearer t" }))!;
    expect(opened.status).toBe(200);
    const sent = rooms.handshakes[0]!;
    expect(sent.headers.get("Cookie")).toBeNull();
    expect(sent.headers.get("Authorization")).toBeNull();
    expect(sent.headers.get("Origin")).toBeNull();
    expect(sent.headers.get("Upgrade")).toBe("websocket");
    expect(sent.headers.get("Sec-WebSocket-Key")).toBe("k");
    expect(new URL(sent.url).searchParams.get("ticket")).toBe(ticketOf(socketURL));
  });
});

describe("the editor tool list", () => {
  it("parses the release's list, hides file arguments and sorts tools into categories", () => {
    const tools = parseDesignTools(TOOL_LIST_FIXTURE);
    expect(tools.size).toBe(9);
    expect(tools.get("export_svg")!.fileArgs).toEqual(["path"]);
    expect(Object.keys(tools.get("export_svg")!.inputSchema.properties as object)).toEqual(["ids"]);
    expect(tools.get("create_shape")!.fileArgs).toEqual([]);
    expect(parseDesignTools({ tools: [{ name: "Bad Name", description: "", inputSchema: {} }] }).size).toBe(0);
    expect(parseDesignTools(null).size).toBe(0);
    // A tool without the flag counts as compiling code.
    const unflagged = parseDesignTools({
      tools: [{ name: "x", description: "d", inputSchema: {}, capabilities: [] }],
    });
    expect(unflagged.get("x")!.evaluatesCode).toBe(true);

    const category = (name: string, mutates: boolean, write: boolean) =>
      designToolCategory({ name, mutates, capabilities: write ? ["document:write"] : ["document:read"] });
    expect(category("get_page_tree", false, false)).toBe("read");
    expect(category("analyze_colors", false, false)).toBe("analyze");
    expect(category("export_image", false, false)).toBe("export");
    expect(category("zoom_to_fit", true, false)).toBe("view");
    expect(category("create_shape", true, true)).toBe("create");
    expect(category("render", true, true)).toBe("create");
    expect(category("set_fill", true, true)).toBe("edit");
    expect(category("create_instance", true, true)).toBe("components");
    expect(category("set_variable", true, true)).toBe("variables");
    expect(category("add_comment", true, true)).toBe("comments");
  });

  it("leaves out the tools that compile code when the editor shares the app's origin", () => {
    const tools = parseDesignTools(TOOL_LIST_FIXTURE);
    expect(allowedDesignTools(tools, true).has("render")).toBe(true);
    const fallback = allowedDesignTools(tools, false);
    expect(fallback.has("render")).toBe(false);
    expect(fallback.has("create_shape")).toBe(true);
  });

  it("loads the list once from the static files, and retries after a failure", async () => {
    let calls = 0;
    const assets = {
      fetch: async (request: Request) => {
        calls += 1;
        expect(new URL(request.url).pathname).toBe("/designer/up-docs-tools.json");
        return calls === 1 ? new Response("missing", { status: 404 }) : Response.json(TOOL_LIST_FIXTURE);
      },
    } as unknown as Fetcher;
    await expect(loadDesignTools(assets, ORIGIN)).rejects.toThrow("404");
    expect((await loadDesignTools(assets, ORIGIN)).size).toBe(9);
    expect((await loadDesignTools(assets, ORIGIN)).size).toBe(9);
    expect(calls).toBe(2);
  });

  it("refuses tools off the list before they reach the editor, and drops file arguments", async () => {
    const rooms = makeDesignRooms({ isolatedEditor: false });
    const editor = await rooms.open("d1");
    for (const name of ["eval", "render", "search_web", 42]) {
      const answer = await forwardDesignCommand(rooms.port, "d1", "tool", { name, args: {} });
      expect(answer.kind).toBe("refused");
    }
    expect(editor.received).toEqual([]);
    await forwardDesignCommand(rooms.port, "d1", "tool", {
      name: "export_svg",
      args: { ids: ["1:1"], path: "/etc/passwd" },
    });
    expect(editor.received).toEqual([
      { command: "tool", args: { name: "export_svg", args: { ids: ["1:1"] } } },
    ]);
  });
});
