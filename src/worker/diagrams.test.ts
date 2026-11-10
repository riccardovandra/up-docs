import { describe, expect, it } from "vitest";

import {
  drawioBlock,
  MAX_DIAGRAM_XML_BYTES,
  type DiagramListItem,
  type DiagramSummary,
  type DiagramUsage,
  type DiagramView,
} from "../shared/drawio.ts";
import type { DocWithTabs } from "../shared/protocol.ts";
import * as Diagrams from "./diagrams.ts";
import { d1ImageStore } from "./images.ts";
import { makeApiHarness } from "./testing/apiHarness.ts";
import { makeTestD1 } from "./testing/sqliteD1.ts";

const XML = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
const XML2 = XML.replace('id="1"', 'id="1" value="changed"');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PNG_BASE64 = Buffer.from(PNG).toString("base64");

/**
 * The admin, a project, and two docs. People are added to a doc to get an
 * account: `creator` edits the first doc, and so may make diagrams.
 */
async function setup() {
  const api = makeApiHarness();
  const admin = await api.signIn();
  const as = (cookie: string) => ({ headers: { Cookie: cookie } });
  const send = async <A>(cookie: string, method: string, path: string, body?: unknown) => {
    const response = await api.call(method, path, { body, headers: { Cookie: cookie } });
    return { status: response.status, body: (await response.json()) as A };
  };
  const { project } = (
    await send<{ project: { id: string } }>(admin, "POST", "/api/projects", { name: "Acme" })
  ).body;
  const newDoc = async (title: string) =>
    (await send<DocWithTabs>(admin, "POST", "/api/docs", { projectId: project.id, title })).body;
  const doc = await newDoc("Playbook");
  const otherDoc = await newDoc("Elsewhere");
  const person = async (email: string, docId: string, role = "viewer") => {
    await send(admin, "POST", `/api/docs/${docId}/members`, { email, role });
    return api.signIn(email);
  };
  const creator = await person("creator@example.com", doc.doc.id, "editor");
  const create = async (cookie: string, input: Record<string, unknown> = {}) =>
    (await send<{ diagram: DiagramView }>(cookie, "POST", "/api/diagrams", input)).body.diagram;
  /** Puts a block linking the diagram into a doc's first tab. */
  const link = async (target: DocWithTabs, diagramId: string) => {
    const tab = target.tabs[0]!;
    const current = (await send<{ tab: { version: number } }>(admin, "GET", `/api/tabs/${tab.id}`))
      .body.tab;
    const written = await send(admin, "PATCH", `/api/tabs/${tab.id}`, {
      baseVersion: current.version,
      markdown: `Intro\n\n${drawioBlock(diagramId, "The flow")}\n`,
    });
    expect(written.status).toBe(200);
  };
  const upload = (cookie: string, diagramId: string, version: number, png: string | null = null) =>
    send<{ diagram: DiagramSummary; error?: string; version?: number }>(
      cookie,
      "PUT",
      `/api/diagrams/${diagramId}/picture`,
      { version, svg: SVG, png },
    );
  return { api, admin, creator, project, doc, otherDoc, person, create, link, upload, send, as };
}

describe("diagram access", () => {
  it("lists a diagram for its creator and the admin, and lets both change it", async () => {
    const { admin, creator, project, create, send } = await setup();
    const diagram = await create(creator, { title: "Onboarding", projectId: project.id, xml: XML });
    expect(diagram).toMatchObject({
      title: "Onboarding",
      projectId: project.id,
      version: 1,
      pictureVersion: null,
      hasSource: true,
      canEdit: true,
      xml: XML,
    });

    for (const cookie of [creator, admin]) {
      const listed = await send<{ diagrams: Array<DiagramListItem> }>(
        cookie,
        "GET",
        "/api/diagrams",
      );
      expect(listed.body.diagrams.map((item) => item.id)).toEqual([diagram.id]);
      // Lists never carry the source.
      expect(listed.body.diagrams[0]).not.toHaveProperty("xml");
      const read = await send<{ diagram: DiagramView }>(
        cookie,
        "GET",
        `/api/diagrams/${diagram.id}`,
      );
      expect(read.body.diagram).toMatchObject({ canEdit: true, xml: XML });
    }

    const renamed = await send<{ diagram: DiagramView }>(
      admin,
      "PATCH",
      `/api/diagrams/${diagram.id}`,
      { title: "Client onboarding" },
    );
    expect(renamed.body.diagram).toMatchObject({ title: "Client onboarding", version: 1 });
    const deleted = await send(creator, "DELETE", `/api/diagrams/${diagram.id}`);
    expect(deleted.status).toBe(200);
    expect((await send(creator, "GET", `/api/diagrams/${diagram.id}`)).status).toBe(404);
  });

  it("gives a reader of a doc that links it the picture and nothing else", async () => {
    const { creator, doc, person, create, link, upload, send, api, as } = await setup();
    const diagram = await create(creator, { title: "Onboarding", xml: XML });
    await upload(creator, diagram.id, 1, PNG_BASE64);
    const reader = await person("reader@example.com", doc.doc.id);

    // Not linked yet: the reader is on the doc, but the doc does not show the diagram.
    expect((await send(reader, "GET", `/api/diagrams/${diagram.id}`)).status).toBe(404);
    const hidden = await api.call("GET", `/api/diagrams/${diagram.id}/picture.svg`, as(reader));
    expect(hidden.status).toBe(404);

    await link(doc, diagram.id);
    const read = await send<{ diagram: DiagramView }>(
      reader,
      "GET",
      `/api/diagrams/${diagram.id}`,
    );
    expect(read.status).toBe(200);
    expect(read.body.diagram).toMatchObject({ title: "Onboarding", canEdit: false, xml: null });
    expect(JSON.stringify(read.body)).not.toContain("mxGraphModel");
    for (const format of ["svg", "png"]) {
      const picture = await api.call(
        "GET",
        `/api/diagrams/${diagram.id}/picture.${format}`,
        as(reader),
      );
      expect(picture.status).toBe(200);
    }

    const listed = await send<{ diagrams: Array<DiagramListItem> }>(reader, "GET", "/api/diagrams");
    expect(listed.body.diagrams).toEqual([]);
    const refused = [
      await send(reader, "PATCH", `/api/diagrams/${diagram.id}`, { title: "Mine now" }),
      await send(reader, "PATCH", `/api/diagrams/${diagram.id}`, { xml: XML2, baseVersion: 1 }),
      await send(reader, "DELETE", `/api/diagrams/${diagram.id}`),
      await send(reader, "GET", `/api/diagrams/${diagram.id}/uses`),
      await upload(reader, diagram.id, 1),
    ];
    expect(refused.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
    expect(refused[0]!.body).toEqual({ error: "forbidden" });
  });

  it("answers a stranger as if the diagram did not exist", async () => {
    const { creator, doc, otherDoc, person, create, link, upload, send, api, as } = await setup();
    const diagram = await create(creator, { xml: XML });
    await upload(creator, diagram.id, 1);
    await link(doc, diagram.id);
    // Signed in, on another doc, but on none that links the diagram.
    const stranger = await person("stranger@example.com", otherDoc.doc.id, "editor");

    const responses = [
      await send(stranger, "GET", `/api/diagrams/${diagram.id}`),
      await send(stranger, "PATCH", `/api/diagrams/${diagram.id}`, { title: "Mine now" }),
      await send(stranger, "DELETE", `/api/diagrams/${diagram.id}`),
      await send(stranger, "GET", `/api/diagrams/${diagram.id}/uses`),
      await upload(stranger, diagram.id, 1),
      await send(stranger, "GET", "/api/diagrams/no-such-diagram"),
    ];
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404, 404]);
    expect(responses[0]!.body).toEqual(responses[5]!.body);
    const picture = await api.call("GET", `/api/diagrams/${diagram.id}/picture.svg`, as(stranger));
    expect(picture.status).toBe(404);
    expect((await api.call("GET", `/api/diagrams/${diagram.id}`)).status).toBe(401);
  });

  it("creates only in a project the person can see", async () => {
    const { admin, creator, project, create, send } = await setup();
    const hidden = (
      await send<{ project: { id: string } }>(admin, "POST", "/api/projects", { name: "Private" })
    ).body.project;
    const refused = await send(creator, "POST", "/api/diagrams", { projectId: hidden.id });
    expect(refused.status).toBe(404);
    const diagram = await create(creator, { projectId: project.id });
    expect(diagram).toMatchObject({ title: "Untitled diagram", hasSource: false, xml: "" });
    const moved = await send(creator, "PATCH", `/api/diagrams/${diagram.id}`, {
      projectId: hidden.id,
    });
    expect(moved.status).toBe(404);

    const inProject = await send<{ diagrams: Array<DiagramListItem> }>(
      creator,
      "GET",
      `/api/diagrams?projectId=${project.id}`,
    );
    expect(inProject.body.diagrams.map((item) => item.id)).toEqual([diagram.id]);
    const inNone = await send<{ diagrams: Array<DiagramListItem> }>(
      creator,
      "GET",
      "/api/diagrams?projectId=none",
    );
    expect(inNone.body.diagrams).toEqual([]);
  });
});

describe("saving a diagram", () => {
  it("bumps the version on a new source and refuses a stale save, naming the version", async () => {
    const { creator, admin, create, send } = await setup();
    const diagram = await create(creator, { xml: XML });
    const path = `/api/diagrams/${diagram.id}`;

    const saved = await send<{ diagram: DiagramView }>(creator, "PATCH", path, {
      xml: XML2,
      baseVersion: 1,
    });
    expect(saved.body.diagram).toMatchObject({ version: 2, xml: XML2 });

    // The admin still holds version 1.
    const stale = await send<{ error: string; version: number; diagram: DiagramSummary }>(
      admin,
      "PATCH",
      path,
      { xml: XML, baseVersion: 1 },
    );
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "version_conflict", version: 2 });
    expect(stale.body.diagram).toMatchObject({ id: diagram.id, version: 2 });
    expect(stale.body.diagram).not.toHaveProperty("xml");
    expect((await send<{ diagram: DiagramView }>(creator, "GET", path)).body.diagram.xml).toBe(
      XML2,
    );

    // Overwriting is the same save from the version the conflict named.
    const overwritten = await send<{ diagram: DiagramView }>(admin, "PATCH", path, {
      xml: XML,
      baseVersion: stale.body.version,
    });
    expect(overwritten.body.diagram).toMatchObject({ version: 3, xml: XML });
  });

  it("keeps the version for a rename, a move and an unchanged source", async () => {
    const { creator, create, send } = await setup();
    const diagram = await create(creator, { xml: XML });
    const path = `/api/diagrams/${diagram.id}`;
    await send(creator, "PATCH", path, { title: "Renamed" });
    await send(creator, "PATCH", path, { projectId: null });
    const same = await send<{ diagram: DiagramView }>(creator, "PATCH", path, {
      xml: XML,
      baseVersion: 1,
    });
    expect(same.body.diagram).toMatchObject({ title: "Renamed", projectId: null, version: 1 });
  });

  it("refuses a source that is too large, malformed or sent without its version", async () => {
    const { creator, create, send } = await setup();
    const diagram = await create(creator, { xml: XML });
    const path = `/api/diagrams/${diagram.id}`;
    const huge = `<mxGraphModel>${"a".repeat(MAX_DIAGRAM_XML_BYTES)}</mxGraphModel>`;

    const tooLarge = await send<{ error: string; message: string }>(creator, "PATCH", path, {
      xml: huge,
      baseVersion: 1,
    });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.error).toBe("diagram_too_large");
    expect(tooLarge.body.message).toContain("over the 1 MB limit");
    const created = await send<{ error: string }>(creator, "POST", "/api/diagrams", { xml: huge });
    expect(created.status).toBe(413);

    const malformed = await send<{ error: string; message: string }>(creator, "PATCH", path, {
      xml: "<svg/>",
      baseVersion: 1,
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe("invalid_xml");

    expect((await send(creator, "PATCH", path, { xml: XML2 })).status).toBe(400);
    expect((await send(creator, "PATCH", path, {})).status).toBe(400);
    expect((await send(creator, "PATCH", path, { title: "  " })).status).toBe(400);
    // Nothing above was saved.
    expect((await send<{ diagram: DiagramView }>(creator, "GET", path)).body.diagram).toMatchObject(
      { version: 1, xml: XML },
    );
  });
});

describe("diagram pictures", () => {
  it("stores the picture for the current version and serves it with image headers", async () => {
    const { api, creator, create, upload, as } = await setup();
    const diagram = await create(creator, { xml: XML });
    const none = await api.call("GET", `/api/diagrams/${diagram.id}/picture.svg`, as(creator));
    expect(none.status).toBe(404);

    const uploaded = await upload(creator, diagram.id, 1, PNG_BASE64);
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.diagram).toMatchObject({ version: 1, pictureVersion: 1 });
    expect([...api.images.keys()].toSorted()).toEqual([
      `diagrams/${diagram.id}/picture.png`,
      `diagrams/${diagram.id}/picture.svg`,
    ]);

    const svg = await api.call("GET", `/api/diagrams/${diagram.id}/picture.svg`, as(creator));
    expect(svg.status).toBe(200);
    expect(svg.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(svg.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const policy = svg.headers.get("Content-Security-Policy")!;
    expect(policy.startsWith("default-src 'none';")).toBe(true);
    expect(policy.endsWith("; sandbox")).toBe(true);
    expect(policy).not.toContain("script");
    expect(svg.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(await svg.text()).toBe(SVG);

    const png = await api.call("GET", `/api/diagrams/${diagram.id}/picture.png?v=1`, as(creator));
    expect(png.headers.get("Content-Type")).toBe("image/png");
    expect(png.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(png.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    // A URL that names the picture's version never changes.
    expect(png.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(PNG);

    const unchanged = await api.call("GET", `/api/diagrams/${diagram.id}/picture.svg`, {
      headers: { Cookie: creator, "If-None-Match": svg.headers.get("ETag")! },
    });
    expect(unchanged.status).toBe(304);
    const other = await api.call("GET", `/api/diagrams/${diagram.id}/picture.gif`, as(creator));
    expect(other.status).toBe(404);
  });

  it("leaves the picture behind after a new source, and drops a late old picture", async () => {
    const { api, creator, create, upload, send, as } = await setup();
    const diagram = await create(creator, { xml: XML });
    await upload(creator, diagram.id, 1);
    const saved = await send<{ diagram: DiagramView }>(
      creator,
      "PATCH",
      `/api/diagrams/${diagram.id}`,
      { xml: XML2, baseVersion: 1 },
    );
    expect(saved.body.diagram).toMatchObject({ version: 2, pictureVersion: 1 });

    const late = await upload(creator, diagram.id, 1);
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ error: "version_conflict", version: 2 });
    expect((await upload(creator, diagram.id, 2)).body.diagram.pictureVersion).toBe(2);

    // No PNG came with either upload, so there is none to hand out.
    const png = await api.call("GET", `/api/diagrams/${diagram.id}/picture.png`, as(creator));
    expect(png.status).toBe(404);
  });

  it("refuses bytes that are not an SVG or a PNG", async () => {
    const { creator, create, send } = await setup();
    const diagram = await create(creator, { xml: XML });
    const put = (body: unknown) =>
      send<{ error: string }>(creator, "PUT", `/api/diagrams/${diagram.id}/picture`, body);
    const html = "<html><script>alert(1)</script></html>";
    expect((await put({ version: 1, svg: html })).body.error).toBe("invalid_picture");
    const notPng = Buffer.from("GIF89a....").toString("base64");
    expect((await put({ version: 1, svg: SVG, png: notPng })).body.error).toBe("invalid_picture");
    expect((await put({ version: 1 })).status).toBe(400);
    expect((await put({ svg: SVG })).status).toBe(400);
    const read = await send<{ diagram: DiagramView }>(
      creator,
      "GET",
      `/api/diagrams/${diagram.id}`,
    );
    expect(read.body.diagram.pictureVersion).toBeNull();
  });

  it("deletes the pictures with the diagram", async () => {
    const { api, creator, create, upload, send } = await setup();
    const diagram = await create(creator, { xml: XML });
    const kept = await create(creator, { xml: XML });
    await upload(creator, diagram.id, 1, PNG_BASE64);
    await upload(creator, kept.id, 1);
    await send(creator, "DELETE", `/api/diagrams/${diagram.id}`);
    expect([...api.images.keys()]).toEqual([`diagrams/${kept.id}/picture.svg`]);
  });
});

describe("where a diagram is used", () => {
  it("finds the docs and tabs that link it, by reading their markdown", async () => {
    const { admin, creator, doc, otherDoc, create, link, send } = await setup();
    const diagram = await create(creator, { xml: XML });
    const unused = await create(creator, { xml: XML });
    await link(doc, diagram.id);
    await link(otherDoc, diagram.id);

    // The admin made both docs and is on both.
    const forAdmin = await send<DiagramUsage>(admin, "GET", `/api/diagrams/${diagram.id}/uses`);
    expect(forAdmin.body.uses.map((use) => use.docTitle)).toEqual(["Elsewhere", "Playbook"]);
    expect(forAdmin.body.uses[1]).toEqual({
      docId: doc.doc.id,
      docTitle: "Playbook",
      tabId: doc.tabs[0]!.id,
      tabTitle: doc.tabs[0]!.title,
    });
    expect(forAdmin.body.otherDocs).toBe(0);

    // The creator is only on the first doc: the other is counted, not named.
    const forCreator = await send<DiagramUsage>(creator, "GET", `/api/diagrams/${diagram.id}/uses`);
    expect(forCreator.body.uses.map((use) => use.docTitle)).toEqual(["Playbook"]);
    expect(forCreator.body.otherDocs).toBe(1);

    const listed = await send<{ diagrams: Array<DiagramListItem> }>(
      creator,
      "GET",
      "/api/diagrams",
    );
    const uses = new Map(listed.body.diagrams.map((item) => [item.id, item.uses]));
    expect(uses.get(diagram.id)?.map((use) => use.docId)).toEqual([doc.doc.id]);
    expect(uses.get(unused.id)).toEqual([]);
    const none = await send<DiagramUsage>(creator, "GET", `/api/diagrams/${unused.id}/uses`);
    expect(none.body).toEqual({ uses: [], otherDocs: 0 });
  });

  it("counts a link only when a block names the diagram", async () => {
    const { api, admin, creator, doc, create, send } = await setup();
    const diagram = await create(creator, { xml: XML });
    const tab = doc.tabs[0]!;
    // The id in prose, in another block's language, and in a t3-drawio block for another diagram.
    const markdown = [
      `See ${diagram.id}.`,
      `\`\`\`text\n${diagram.id}\n\`\`\``,
      drawioBlock("some-other-diagram"),
    ].join("\n\n");
    await send(admin, "PATCH", `/api/tabs/${tab.id}`, { baseVersion: 1, markdown });
    expect(await Diagrams.diagramUsage(api.db, { diagramId: diagram.id, userId: "owner" })).toEqual(
      { uses: [], otherDocs: 0 },
    );
    const reader = { id: diagram.id, createdBy: diagram.createdBy };
    expect(await Diagrams.canViewDiagram(api.db, reader, "owner")).toBe(true);
    expect(await Diagrams.canViewDiagram(api.db, reader, "nobody")).toBe(false);
  });
});

describe("diagrams and their project", () => {
  it("moves a project's diagrams with its docs, and keeps them when the project goes", async () => {
    const { admin, project, create, send } = await setup();
    const diagram = await create(admin, { projectId: project.id, xml: XML });
    const target = (
      await send<{ project: { id: string } }>(admin, "POST", "/api/projects", { name: "Next" })
    ).body.project;

    await send(admin, "POST", `/api/projects/${project.id}/move-docs`, { projectId: target.id });
    const path = `/api/diagrams/${diagram.id}`;
    expect((await send<{ diagram: DiagramView }>(admin, "GET", path)).body.diagram.projectId).toBe(
      target.id,
    );

    await send(admin, "POST", `/api/projects/${target.id}/move-docs`, { projectId: null });
    expect((await send(admin, "DELETE", `/api/projects/${target.id}`)).status).toBe(200);
    expect((await send<{ diagram: DiagramView }>(admin, "GET", path)).body.diagram).toMatchObject({
      projectId: null,
      xml: XML,
    });
  });
});

describe("diagram pictures in D1", () => {
  it("keeps pictures in their own table, and drops them with the diagram", async () => {
    const db = makeTestD1();
    const images = d1ImageStore(db);
    const diagram = await Diagrams.createDiagram(db, {
      projectId: null,
      title: "Flow",
      xml: XML,
      createdBy: "owner",
      now: 1,
    });
    const saved = await Diagrams.saveDiagramPicture(db, images, {
      diagramId: diagram.id,
      version: 1,
      svg: SVG,
      png: PNG.slice().buffer,
    });
    expect(saved.ok).toBe(true);

    const svg = await Diagrams.diagramPicture(images, diagram.id, "svg");
    expect(new TextDecoder().decode(svg!.body as ArrayBuffer)).toBe(SVG);
    const png = await Diagrams.diagramPicture(images, diagram.id, "png");
    expect(new Uint8Array(png!.body as ArrayBuffer)).toEqual(PNG);
    const count = async (table: string) =>
      (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n;
    expect(await count("diagram_chunks")).toBe(2);
    expect(await count("image_chunks")).toBe(0);

    await Diagrams.deleteDiagram(db, images, diagram.id);
    expect(await count("diagram_chunks")).toBe(0);
    expect(await Diagrams.diagramPicture(images, diagram.id, "svg")).toBeNull();
  });
});
