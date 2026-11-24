import { describe, expect, it } from "vitest";

import type { DocMember } from "../shared/access.ts";
import type { PublicLink, PublicSheet } from "../shared/publicLinks.ts";
import type { SheetListResponse, SheetResponse } from "../shared/sheets.ts";
import { makeApiHarness, OWNER } from "./testing/apiHarness.ts";

/** The admin, a project, a sheet with one written cell, and a helper per action. */
async function setup() {
  const api = makeApiHarness();
  const admin = await api.signIn();
  const send = async <A>(cookie: string | null, method: string, path: string, body?: unknown) => {
    const response = await api.call(method, path, {
      body,
      headers: cookie ? { Cookie: cookie } : {},
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as A };
  };
  const { project } = (
    await send<{ project: { id: string } }>(admin, "POST", "/api/projects", { name: "Acme" })
  ).body;
  const created = (
    await send<SheetResponse>(admin, "POST", "/api/sheets", { title: "Budget", projectId: project.id })
  ).body;
  const sheetId = created.sheet.id;
  const tab = created.records.sheets[0]!.id;
  const write = (cookie: string, base: number, text: string) =>
    send<{ revision: number }>(cookie, "POST", `/api/sheets/${sheetId}/edits`, {
      base,
      edits: [{ kind: "writeCells", sheet: tab, topLeft: "A1", rows: [[text]] }],
      origin: "client-1",
    });
  expect((await write(admin, 0, "Rent")).status).toBe(200);
  /** Shares the sheet with `email` at `role` and signs them in. */
  const person = async (email: string, role: string) => {
    const shared = await send(admin, "POST", `/api/sheets/${sheetId}/members`, { email, role });
    expect(shared.status).toBe(201);
    return api.signIn(email);
  };
  return { api, admin, send, project, created, sheetId, write, person };
}

describe("sheet sharing", () => {
  it("makes the creator the owner and lists the sheet for the people on it", async () => {
    const { admin, send, sheetId, person } = await setup();
    expect((await send<SheetResponse>(admin, "GET", `/api/sheets/${sheetId}`)).body.role).toBe(
      "owner",
    );
    const members = await send<{ members: Array<DocMember> }>(
      admin,
      "GET",
      `/api/sheets/${sheetId}/members`,
    );
    expect(members.body.members.map((member) => [member.email, member.role])).toEqual([
      [OWNER, "owner"],
    ]);

    const viewer = await person("viewer@example.com", "viewer");
    const listed = await send<SheetListResponse>(viewer, "GET", "/api/sheets");
    expect(listed.body.sheets.map((sheet) => [sheet.id, sheet.role])).toEqual([[sheetId, "viewer"]]);
    expect(
      (await send<{ members: Array<DocMember> }>(viewer, "GET", `/api/sheets/${sheetId}/members`))
        .body.members,
    ).toHaveLength(2);
  });

  it("lets viewers read, editors change cells and rename, and only owners move, delete or share", async () => {
    const { api, send, project, sheetId, write, person } = await setup();
    const viewer = await person("viewer@example.com", "viewer");
    const commenter = await person("commenter@example.com", "commenter");
    const editor = await person("editor@example.com", "editor");
    const path = `/api/sheets/${sheetId}`;

    for (const cookie of [viewer, commenter]) {
      const read = await send<SheetResponse>(cookie, "GET", path);
      expect(read.status).toBe(200);
      expect(read.body.records.cells.map((cell) => cell.input)).toEqual(["Rent"]);
      const csv = await api.call("GET", `${path}/export.csv?tab=Sheet1`, { headers: { Cookie: cookie } });
      expect(csv.status).toBe(200);
      expect((await write(cookie, 1, "Nope")).status).toBe(403);
      expect((await send(cookie, "PATCH", path, { title: "Nope" })).status).toBe(403);
      expect((await send(cookie, "DELETE", path)).status).toBe(403);
      expect(
        (await send(cookie, "POST", `${path}/members`, { email: "x@example.com", role: "viewer" }))
          .status,
      ).toBe(403);
    }

    expect((await write(editor, 1, "Rent 2")).status).toBe(200);
    expect((await send(editor, "PATCH", path, { title: "Budget 2" })).status).toBe(200);
    expect((await send(editor, "PATCH", path, { projectId: null })).status).toBe(403);
    expect((await send(editor, "DELETE", path)).status).toBe(403);
    expect(
      (await send(editor, "POST", `${path}/members`, { email: "x@example.com", role: "viewer" }))
        .status,
    ).toBe(403);
    expect((await send<SheetResponse>(editor, "GET", path)).body.sheet).toMatchObject({
      title: "Budget 2",
      projectId: project.id,
    });
  });

  it("hides a sheet from people who are not on it, and after they are removed", async () => {
    const { api, admin, send, sheetId, person } = await setup();
    // Someone with an account, on another sheet only.
    const other = (
      await send<SheetResponse>(admin, "POST", "/api/sheets", { title: "Other" })
    ).body.sheet.id;
    await send(admin, "POST", `/api/sheets/${other}/members`, {
      email: "stranger@example.com",
      role: "owner",
    });
    const stranger = await api.signIn("stranger@example.com");
    expect((await send(stranger, "GET", `/api/sheets/${sheetId}`)).status).toBe(404);
    expect((await send(stranger, "GET", `/api/sheets/${sheetId}/members`)).status).toBe(404);
    expect(
      (await send<SheetListResponse>(stranger, "GET", "/api/sheets")).body.sheets.map((s) => s.id),
    ).toEqual([other]);

    const viewer = await person("viewer@example.com", "viewer");
    const members = (
      await send<{ members: Array<DocMember> }>(admin, "GET", `/api/sheets/${sheetId}/members`)
    ).body.members;
    const row = members.find((member) => member.email === "viewer@example.com")!;
    expect((await send(admin, "DELETE", `/api/sheets/${sheetId}/members/${row.id}`)).status).toBe(
      200,
    );
    expect((await send(viewer, "GET", `/api/sheets/${sheetId}`)).status).toBe(404);
  });

  it("closes a removed person's open sheet sockets, and only theirs", async () => {
    const { api, admin, send, sheetId, person } = await setup();
    const viewer = await person("viewer@example.com", "viewer");
    const ws = (cookie: string) =>
      api.call("GET", `/api/sheets/${sheetId}/ws`, { headers: { Cookie: cookie, Upgrade: "websocket" } });
    expect((await ws(viewer)).status).toBe(204);
    expect((await ws(admin)).status).toBe(204);
    const members = (
      await send<{ members: Array<DocMember> }>(admin, "GET", `/api/sheets/${sheetId}/members`)
    ).body.members;
    const row = members.find((member) => member.email === "viewer@example.com")!;
    await send(admin, "DELETE", `/api/sheets/${sheetId}/members/${row.id}`);
    expect(api.sheetSockets.map((socket) => socket.open)).toEqual([false, true]);
    expect((await ws(viewer)).status).toBe(404);
  });

  it("emails a new person a link to the sheet", async () => {
    const { api, admin, send, sheetId } = await setup();
    await send(admin, "POST", `/api/sheets/${sheetId}/members`, {
      email: "new@example.com",
      role: "viewer",
    });
    expect(api.invites.at(-1)).toMatchObject({
      to: "new@example.com",
      docTitle: "Budget",
      url: expect.stringContaining(`/sheets/${sheetId}`),
    });
  });

  it("publishes a read-only public link from the owner's browser session only", async () => {
    const { api, admin, send, sheetId, person } = await setup();
    const path = `/api/sheets/${sheetId}/public-link`;
    const editor = await person("editor@example.com", "editor");
    expect((await send(editor, "PUT", path)).status).toBe(403);
    const created = await send<{ token: string }>(admin, "POST", "/api/tokens", { name: "agent" });
    const agent = await api.call("PUT", path, {
      headers: { Authorization: `Bearer ${created.body.token}` },
    });
    expect(agent.status).toBe(403);

    const { token } = (await send<{ link: PublicLink }>(admin, "PUT", path)).body.link;
    const visit = await send<PublicSheet>(null, "GET", `/api/public/${token}`);
    expect(visit.status).toBe(200);
    expect(Object.keys(visit.body).toSorted()).toEqual(["kind", "records", "title", "updatedAt"]);
    expect(visit.body.title).toBe("Budget");
    expect(visit.body.records.cells.map((cell) => cell.input)).toEqual(["Rent"]);
    const text = JSON.stringify(visit.body);
    for (const leak of [OWNER, "editor@example.com", "Acme"]) expect(text).not.toContain(leak);

    // Nothing else hangs off a sheet's link, and nothing is written through it.
    for (const sub of ["edits", "export.csv", "members", "content", "ws"]) {
      expect((await send(null, "GET", `/api/public/${token}/${sub}`)).status).toBe(404);
    }
    expect((await send(null, "POST", `/api/public/${token}`)).status).toBe(405);

    expect((await send(admin, "DELETE", `/api/sheets/${sheetId}`)).status).toBe(200);
    expect((await send(null, "GET", `/api/public/${token}`)).status).toBe(404);
  });
});
