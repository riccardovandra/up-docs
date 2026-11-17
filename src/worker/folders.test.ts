import { describe, expect, it } from "vitest";

import type { Folder, ProjectFolders } from "../shared/folders.ts";
import type { DocWithTabs } from "../shared/protocol.ts";
import { makeApiHarness } from "./testing/apiHarness.ts";

/** The admin, a project with a doc, a diagram and a sheet, and a guest on the doc. */
async function setup() {
  const api = makeApiHarness();
  const admin = await api.signIn();
  const send = async <A>(cookie: string, method: string, path: string, body?: unknown) => {
    const response = await api.call(method, path, { body, headers: { Cookie: cookie } });
    return { status: response.status, body: (await response.json()) as A };
  };
  const newProject = async (name: string) =>
    (await send<{ project: { id: string } }>(admin, "POST", "/api/projects", { name })).body
      .project;
  const project = await newProject("Acme");
  const newDoc = async (title: string, projectId = project.id) =>
    (await send<DocWithTabs>(admin, "POST", "/api/docs", { projectId, title })).body.doc;
  const doc = await newDoc("Plan");
  const hiddenDoc = await newDoc("Board notes");
  const diagram = (
    await send<{ diagram: { id: string } }>(admin, "POST", "/api/diagrams", {
      projectId: project.id,
      title: "Flow",
    })
  ).body.diagram;
  const sheet = (
    await send<{ sheet: { id: string } }>(admin, "POST", "/api/sheets", {
      projectId: project.id,
      title: "Budget",
    })
  ).body.sheet;
  await send(admin, "POST", `/api/docs/${doc.id}/members`, {
    email: "guest@example.com",
    role: "editor",
  });
  const guest = await api.signIn("guest@example.com");
  const folder = async (name: string, parentId: string | null = null, projectId = project.id) => {
    const created = await send<{ folder: Folder }>(admin, "POST", "/api/folders", {
      projectId,
      parentId,
      name,
    });
    expect(created.status).toBe(201);
    return created.body.folder;
  };
  const place = (kind: string, id: string, folderId: string | null, cookie = admin) =>
    send(cookie, "POST", "/api/folders/place", { kind, id, folderId });
  const list = (cookie = admin, projectId = project.id) =>
    send<ProjectFolders>(cookie, "GET", `/api/folders?projectId=${projectId}`);
  return {
    api,
    admin,
    guest,
    send,
    project,
    newProject,
    newDoc,
    doc,
    hiddenDoc,
    diagram,
    sheet,
    folder,
    place,
    list,
  };
}

describe("folders", () => {
  it("nests folders and files docs, diagrams and sheets in them", async () => {
    const { project, doc, diagram, sheet, folder, place, list } = await setup();
    const research = await folder("  Research  ");
    const brand = await folder("Brand studies", research.id);
    expect(research).toMatchObject({ name: "Research", parentId: null, projectId: project.id });
    expect(brand.parentId).toBe(research.id);

    expect((await place("doc", doc.id, brand.id)).status).toBe(200);
    expect((await place("diagram", diagram.id, research.id)).status).toBe(200);
    expect((await place("sheet", sheet.id, research.id)).status).toBe(200);

    const listed = (await list()).body;
    expect(listed.folders.map((f) => f.name)).toEqual(["Brand studies", "Research"]);
    expect(listed.placements).toEqual(
      expect.arrayContaining([
        { kind: "doc", id: doc.id, folderId: brand.id },
        { kind: "diagram", id: diagram.id, folderId: research.id },
        { kind: "sheet", id: sheet.id, folderId: research.id },
      ]),
    );
    expect(listed.placements).toHaveLength(3);

    expect((await place("doc", doc.id, null)).status).toBe(200);
    expect((await list()).body.placements.map((p) => p.kind).toSorted()).toEqual([
      "diagram",
      "sheet",
    ]);
  });

  it("refuses a folder or parent from another project", async () => {
    const { send, admin, doc, folder, place, newProject } = await setup();
    const other = await newProject("Other");
    const elsewhere = await folder("Elsewhere", null, other.id);
    expect((await place("doc", doc.id, elsewhere.id)).status).toBe(404);
    const nested = await send(admin, "POST", "/api/folders", {
      projectId: (await newProject("Third")).id,
      parentId: elsewhere.id,
      name: "Child",
    });
    expect(nested).toMatchObject({ status: 404, body: { error: "parent_not_found" } });
    expect((await place("doc", "missing", null)).status).toBe(404);
    expect((await place("folder", doc.id, null)).status).toBe(400);
  });

  it("validates names", async () => {
    const { send, admin, project, folder } = await setup();
    for (const name of ["", "   ", "x".repeat(81), 3]) {
      const created = await send(admin, "POST", "/api/folders", { projectId: project.id, name });
      expect(created.status).toBe(400);
    }
    const kept = await folder("Kept");
    expect((await send(admin, "PATCH", `/api/folders/${kept.id}`, { name: " " })).status).toBe(
      400,
    );
    const renamed = await send<{ folder: Folder }>(admin, "PATCH", `/api/folders/${kept.id}`, {
      name: "Renamed",
    });
    expect(renamed.body.folder.name).toBe("Renamed");
  });

  it("deletes a folder but moves what it held up to its parent", async () => {
    const { send, admin, doc, sheet, folder, place, list } = await setup();
    const top = await folder("Top");
    const middle = await folder("Middle", top.id);
    const bottom = await folder("Bottom", middle.id);
    await place("doc", doc.id, middle.id);
    await place("sheet", sheet.id, bottom.id);

    expect((await send(admin, "DELETE", `/api/folders/${middle.id}`)).status).toBe(200);
    const listed = (await list()).body;
    expect(listed.folders.map((f) => [f.name, f.parentId])).toEqual([
      ["Bottom", top.id],
      ["Top", null],
    ]);
    expect(listed.placements).toEqual(
      expect.arrayContaining([
        { kind: "doc", id: doc.id, folderId: top.id },
        { kind: "sheet", id: sheet.id, folderId: bottom.id },
      ]),
    );
    expect((await send(admin, "DELETE", `/api/folders/${middle.id}`)).status).toBe(404);
  });

  it("clears an item's folder when it moves to another project", async () => {
    const { send, admin, doc, diagram, sheet, folder, place, list, newProject } = await setup();
    const kept = await folder("Kept");
    await place("doc", doc.id, kept.id);
    await place("diagram", diagram.id, kept.id);
    await place("sheet", sheet.id, kept.id);
    const other = await newProject("Other");

    expect((await send(admin, "PATCH", `/api/docs/${doc.id}`, { projectId: other.id })).status).toBe(
      200,
    );
    await send(admin, "PATCH", `/api/diagrams/${diagram.id}`, { projectId: other.id });
    await send(admin, "PATCH", `/api/sheets/${sheet.id}`, { projectId: other.id });
    expect((await list()).body.placements).toEqual([]);
    expect((await list(admin, other.id)).body.placements).toEqual([]);
  });

  it("clears folders when a whole project's items move", async () => {
    const { send, admin, project, doc, diagram, folder, place, list, newProject } = await setup();
    const kept = await folder("Kept");
    await place("doc", doc.id, kept.id);
    await place("diagram", diagram.id, kept.id);
    const other = await newProject("Other");
    const moved = await send(admin, "POST", `/api/projects/${project.id}/move-docs`, {
      projectId: other.id,
    });
    expect(moved.status).toBe(200);
    expect((await list(admin, other.id)).body.placements).toEqual([]);
  });

  it("shows a guest only the folders on the way to their items", async () => {
    const { guest, doc, hiddenDoc, diagram, folder, place, list, send, newProject } =
      await setup();
    const top = await folder("Clients");
    const mine = await folder("Shared", top.id);
    const secret = await folder("Board");
    await folder("Empty");
    await place("doc", doc.id, mine.id);
    await place("doc", hiddenDoc.id, secret.id);
    await place("diagram", diagram.id, secret.id);

    const seen = await list(guest);
    expect(seen.status).toBe(200);
    expect(seen.body.folders.map((f) => f.name).toSorted()).toEqual(["Clients", "Shared"]);
    expect(seen.body.placements).toEqual([{ kind: "doc", id: doc.id, folderId: mine.id }]);

    const hidden = await newProject("Hidden");
    expect((await list(guest, hidden.id)).status).toBe(404);
  });

  it("leaves folder changes to the admin", async () => {
    const { guest, send, project, doc, folder, place } = await setup();
    const kept = await folder("Kept");
    const refused = [
      await send(guest, "POST", "/api/folders", { projectId: project.id, name: "Mine" }),
      await send(guest, "PATCH", `/api/folders/${kept.id}`, { name: "Mine" }),
      await send(guest, "DELETE", `/api/folders/${kept.id}`),
      await place("doc", doc.id, kept.id, guest),
    ];
    expect(refused.map((response) => response.status)).toEqual([403, 403, 403, 403]);
  });
});
