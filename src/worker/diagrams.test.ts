import { describe, expect, it } from "vitest";

import {
  drawioBlock,
  MAX_DIAGRAM_REFRESH_IDS,
  MAX_DIAGRAM_XML_BYTES,
  type DiagramListItem,
  type DiagramRefresh,
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
  /** Puts a block linking the diagram into a doc's first tab, written by `by`. */
  const link = async (target: DocWithTabs, diagramId: string, by = admin) => {
    const tab = target.tabs[0]!;
    const current = (await send<{ tab: { version: number } }>(by, "GET", `/api/tabs/${tab.id}`))
      .body.tab;
    const written = await send(by, "PATCH", `/api/tabs/${tab.id}`, {
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

  it("hides a diagram linked into a doc its creator cannot edit", async () => {
    const { api, admin, creator, otherDoc, person, create, link, upload, send, as } = await setup();
    const diagram = await create(creator, { title: "Onboarding", xml: XML });
    await upload(creator, diagram.id, 1, PNG_BASE64);
    // The admin owns the other doc; the creator is not on it. An editor there links the id.
    const linker = await person("linker@example.com", otherDoc.doc.id, "editor");
    const member = await person("member@example.com", otherDoc.doc.id);
    await link(otherDoc, diagram.id, linker);

    const statuses = async (cookie: string) => {
      const paths = [`/api/diagrams/${diagram.id}`, `/api/diagrams/${diagram.id}/picture.svg`];
      const responses = await Promise.all(paths.map((path) => api.call("GET", path, as(cookie))));
      return responses.map((response) => response.status);
    };
    const exported = async (cookie: string) =>
      (await api.call("GET", `/api/docs/${otherDoc.doc.id}/export.md`, as(cookie))).text();
    for (const cookie of [linker, member]) {
      expect(await statuses(cookie)).toEqual([404, 404]);
      expect(await exported(cookie)).not.toContain("Onboarding");
    }
    // The admin manages every diagram, so sees it; being on the doc shows it to nobody else.
    expect(await statuses(admin)).toEqual([200, 200]);

    // On the doc, but as someone who could not have linked it there: still hidden.
    const members = `/api/docs/${otherDoc.doc.id}/members`;
    for (const role of ["viewer", "commenter"]) {
      await send(admin, "POST", members, { email: "creator@example.com", role });
      expect(await statuses(member)).toEqual([404, 404]);
    }
    // Once the creator can edit the doc, its link shows the diagram to everyone on it.
    await send(admin, "POST", members, { email: "creator@example.com", role: "editor" });
    for (const cookie of [linker, member]) expect(await statuses(cookie)).toEqual([200, 200]);
    expect(await exported(member)).toContain("Onboarding");
  });

  it("shows the admin's own diagram only through docs the admin is on", async () => {
    const { api, admin, creator, doc, person, create, link, upload, send, as } = await setup();
    const diagram = await create(admin, { title: "Pricing", xml: XML });
    await upload(admin, diagram.id, 1);
    const picture = async (cookie: string) =>
      (await api.call("GET", `/api/diagrams/${diagram.id}/picture.svg`, as(cookie))).status;

    // A doc the admin is not on: the admin reaches every diagram, but not this doc.
    const theirs = (await send<DocWithTabs>(creator, "POST", "/api/docs", { title: "Theirs" }))
      .body;
    await link(theirs, diagram.id, creator);
    expect(await picture(creator)).toBe(404);

    // The admin's own doc shows it to a plain reader.
    await link(doc, diagram.id);
    const reader = await person("reader@example.com", doc.doc.id);
    expect(await picture(reader)).toBe(200);

    // A diagram whose creator is gone is the admin's alone, whoever links it.
    const orphan = await create(creator, { title: "Orphan", xml: XML });
    await upload(creator, orphan.id, 1);
    await link(doc, orphan.id);
    const orphanPicture = async (cookie: string) =>
      (await api.call("GET", `/api/diagrams/${orphan.id}/picture.svg`, as(cookie))).status;
    expect(await orphanPicture(reader)).toBe(200);
    // A removed account takes its people-list rows with it (ON DELETE CASCADE).
    await api.db.batch([
      api.db.prepare("UPDATE diagrams SET created_by = NULL WHERE id = ?").bind(orphan.id),
      api.db.prepare("DELETE FROM diagram_members WHERE diagram_id = ?").bind(orphan.id),
    ]);
    expect(await orphanPicture(reader)).toBe(404);
    expect(await orphanPicture(creator)).toBe(404);
    expect(await orphanPicture(admin)).toBe(200);
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
      `diagrams/${diagram.id}/1.png`,
      `diagrams/${diagram.id}/1.svg`,
    ]);

    const svg = await api.call("GET", `/api/diagrams/${diagram.id}/picture.svg`, as(creator));
    expect(svg.status).toBe(200);
    expect(svg.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(svg.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const policy = svg.headers.get("Content-Security-Policy")!;
    expect(policy.startsWith("default-src 'none';")).toBe(true);
    expect(policy.endsWith("; sandbox")).toBe(true);
    expect(policy).not.toContain("script");
    // A theme's Google font is embedded in the SVG as a data URI.
    expect(policy).toContain("font-src data:;");
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

  it("serves no PNG for a version uploaded without one, and drops the replaced picture", async () => {
    const { api, creator, create, upload, send, as } = await setup();
    const diagram = await create(creator, { xml: XML });
    await upload(creator, diagram.id, 1, PNG_BASE64);
    await send(creator, "PATCH", `/api/diagrams/${diagram.id}`, { xml: XML2, baseVersion: 1 });
    expect((await upload(creator, diagram.id, 2)).status).toBe(200);

    const png = await api.call("GET", `/api/diagrams/${diagram.id}/picture.png`, as(creator));
    expect(png.status).toBe(404);
    expect([...api.images.keys()]).toEqual([`diagrams/${diagram.id}/2.svg`]);
  });

  it("keeps the current picture when an upload for an older version lands late", async () => {
    const { api, creator, create, send, as } = await setup();
    const diagram = await create(creator, { xml: XML });
    // The version 1 upload passes its version check, then stalls before storing its bytes.
    let release = () => {};
    const stalled = new Promise<void>((resolve) => (release = resolve));
    const images = {
      ...api.deps.images,
      put: async (key: string, body: ArrayBuffer, type: string) => {
        if (key.endsWith("/1.svg")) await stalled;
        await api.deps.images.put(key, body, type);
      },
    };
    const late = Diagrams.saveDiagramPicture(api.db, images, {
      diagramId: diagram.id,
      version: 1,
      pages: [{ svg: SVG.replace("<rect/>", "<rect id='old'/>"), png: null }],
      pageNames: null,
    });
    await send(creator, "PATCH", `/api/diagrams/${diagram.id}`, { xml: XML2, baseVersion: 1 });
    const current = await Diagrams.saveDiagramPicture(api.db, api.deps.images, {
      diagramId: diagram.id,
      version: 2,
      pages: [{ svg: SVG, png: null }],
      pageNames: null,
    });
    expect(current.ok).toBe(true);
    release();
    expect((await late).ok).toBe(false);

    const served = await api.call("GET", `/api/diagrams/${diagram.id}/picture.svg`, as(creator));
    expect(await served.text()).toBe(SVG);
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
    expect([...api.images.keys()]).toEqual([`diagrams/${kept.id}/1.svg`]);
  });
});

describe("a picture per page", () => {
  const svgOf = (name: string) => SVG.replace("<rect/>", `<rect id="${name}"/>`);
  const pages = (cookie: string, diagramId: string, version: number, names: Array<string | null>) =>
    ({
      cookie,
      path: `/api/diagrams/${diagramId}/picture`,
      body: {
        version,
        svg: svgOf(names[0] ?? "first"),
        png: PNG_BASE64,
        pageNames: names,
        morePages: names.slice(1).map((name) => ({ svg: svgOf(name ?? "unnamed"), png: null })),
      },
    }) as const;

  it("stores one picture per page, keeps the first page where it always was, and serves each", async () => {
    const { api, creator, create, send, as } = await setup();
    const diagram = await create(creator, { xml: XML });
    const put = pages(creator, diagram.id, 1, ["Overview", "Detail", "Notes"]);
    const saved = await send<{ diagram: DiagramSummary }>(creator, "PUT", put.path, put.body);
    expect(saved.status).toBe(200);
    expect(saved.body.diagram).toMatchObject({
      pictureVersion: 1,
      picturePages: ["Overview", "Detail", "Notes"],
    });
    expect([...api.images.keys()].sort()).toEqual(
      [
        `diagrams/${diagram.id}/1.png`,
        `diagrams/${diagram.id}/1.svg`,
        `diagrams/${diagram.id}/1.p1.svg`,
        `diagrams/${diagram.id}/1.p2.svg`,
      ].sort(),
    );
    const served = async (query: string) => {
      const response = await api.call(
        "GET",
        `/api/diagrams/${diagram.id}/picture.svg${query}`,
        as(creator),
      );
      return { status: response.status, text: await response.text(), etag: response.headers.get("ETag") };
    };
    expect((await served("")).text).toBe(svgOf("Overview"));
    expect(await served("?page=0&v=1")).toMatchObject({ text: svgOf("Overview"), etag: '"svg-1"' });
    expect(await served("?page=2&v=1")).toMatchObject({ text: svgOf("Notes"), etag: '"svg-1-p2"' });
    expect((await served("?page=3")).status).toBe(404);
    expect((await served("?page=-1")).status).toBe(400);
    expect((await served("?page=one")).status).toBe(400);
    // Only the first page had a PNG.
    const png = await api.call("GET", `/api/diagrams/${diagram.id}/picture.png?page=1`, as(creator));
    expect(png.status).toBe(404);
    // The diagram says which page is which, to anyone who may see it.
    const read = await send<{ diagram: DiagramView }>(creator, "GET", `/api/diagrams/${diagram.id}`);
    expect(read.body.diagram.picturePages).toEqual(["Overview", "Detail", "Notes"]);
  });

  it("drops the pictures of pages that are gone, and of the version replaced", async () => {
    const { api, creator, create, send } = await setup();
    const diagram = await create(creator, { xml: XML });
    const three = pages(creator, diagram.id, 1, ["A", "B", "C"]);
    await send(creator, "PUT", three.path, three.body);
    const two = pages(creator, diagram.id, 1, ["A", "B"]);
    await send(creator, "PUT", two.path, two.body);
    expect([...api.images.keys()].filter((key) => /\.p\d/.test(key)).sort()).toEqual([
      `diagrams/${diagram.id}/1.p1.svg`,
    ]);
    await send(creator, "PATCH", `/api/diagrams/${diagram.id}`, { xml: XML2, baseVersion: 1 });
    const next = pages(creator, diagram.id, 2, ["A"]);
    await send(creator, "PUT", next.path, next.body);
    expect([...api.images.keys()].sort()).toEqual(
      [`diagrams/${diagram.id}/2.png`, `diagrams/${diagram.id}/2.svg`].sort(),
    );
  });

  it("keeps an upload from before pages working: the first page, its pages unknown", async () => {
    const { creator, create, upload } = await setup();
    const diagram = await create(creator, { xml: XML });
    const saved = await upload(creator, diagram.id, 1, PNG_BASE64);
    expect(saved.body.diagram).toMatchObject({ pictureVersion: 1, picturePages: null });
  });

  it("refuses pictures that do not match the pages", async () => {
    const { creator, create, send } = await setup();
    const diagram = await create(creator, { xml: XML });
    const put = (body: Record<string, unknown>) =>
      send<{ error: string }>(creator, "PUT", `/api/diagrams/${diagram.id}/picture`, {
        version: 1,
        svg: SVG,
        ...body,
      });
    expect((await put({ pageNames: ["A", "B"] })).status).toBe(400);
    expect((await put({ pageNames: ["A"], morePages: [{ svg: SVG }] })).status).toBe(400);
    expect((await put({ pageNames: [] })).status).toBe(400);
    expect((await put({ pageNames: [7] })).body.error).toBe("invalid_picture");
    expect((await put({ pageNames: ["A", "B"], morePages: [{ svg: "<html/>" }] })).status).toBe(400);
    // Past the pages that get a picture, a page is named but not drawn.
    const names = Array.from({ length: 25 }, (_, index) => `P${index}`);
    const many = await put({
      pageNames: names,
      morePages: names.slice(1, 20).map(() => ({ svg: SVG })),
    });
    expect(many.status).toBe(200);
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
    const reader = { id: diagram.id };
    expect(await Diagrams.diagramAccess(api.db, reader, "owner")).toEqual(Diagrams.OWNER_ACCESS);
    expect(await Diagrams.diagramAccess(api.db, reader, "nobody")).toBeNull();
  });
});

describe("re-reading diagrams by id", () => {
  type Refreshed = { diagrams: Array<DiagramRefresh>; error?: string };

  it("gives someone who manages them the current versions and where they are linked", async () => {
    const { creator, doc, create, link, upload, send } = await setup();
    const diagram = await create(creator, { title: "Onboarding", xml: XML });
    const other = await create(creator, { title: "Billing" });
    await upload(creator, diagram.id, 1);
    await link(doc, diagram.id);
    const path = `/api/diagrams?ids=${diagram.id},${other.id}`;

    const first = await send<Refreshed>(creator, "GET", path);
    expect(first.status).toBe(200);
    const byId = new Map(first.body.diagrams.map((item) => [item.id, item]));
    expect(byId.get(diagram.id)).toMatchObject({
      title: "Onboarding",
      version: 1,
      pictureVersion: 1,
      hasSource: true,
      canEdit: true,
      usage: { uses: [{ docId: doc.doc.id, docTitle: "Playbook" }], otherDocs: 0 },
    });
    expect(byId.get(other.id)).toMatchObject({
      canEdit: true,
      hasSource: false,
      usage: { uses: [], otherDocs: 0 },
    });
    // Never the source, which can be a megabyte.
    expect(JSON.stringify(first.body)).not.toContain("mxGraphModel");
    expect(first.body.diagrams[0]).not.toHaveProperty("xml");

    // A save made elsewhere: the next re-read says the version moved on, the picture is behind.
    await send(creator, "PATCH", `/api/diagrams/${diagram.id}`, { xml: XML2, baseVersion: 1 });
    const second = await send<Refreshed>(creator, "GET", path);
    expect(second.body.diagrams.find((item) => item.id === diagram.id)).toMatchObject({
      version: 2,
      pictureVersion: 1,
    });
  });

  it("leaves out a diagram the caller cannot see, and one that is gone", async () => {
    const { creator, doc, otherDoc, person, create, link, send } = await setup();
    const shown = await create(creator, { title: "Shown", xml: XML });
    const hidden = await create(creator, { title: "Hidden", xml: XML });
    const deleted = await create(creator, { title: "Deleted", xml: XML });
    await link(doc, shown.id);
    await send(creator, "DELETE", `/api/diagrams/${deleted.id}`);
    const reader = await person("reader@example.com", doc.doc.id);
    const stranger = await person("stranger@example.com", otherDoc.doc.id);
    const path = `/api/diagrams?ids=${shown.id},${hidden.id},${deleted.id}`;

    // A reader of a doc that links one: that one, without its source or where else it is linked.
    const forReader = await send<Refreshed>(reader, "GET", path);
    expect(forReader.body.diagrams).toEqual([
      expect.objectContaining({ id: shown.id, canEdit: false, usage: null }),
    ]);
    expect(JSON.stringify(forReader.body)).not.toContain("mxGraphModel");
    // The same answer the single read gives each of them.
    for (const [id, status] of [
      [shown.id, 200],
      [hidden.id, 404],
      [deleted.id, 404],
    ] as const) {
      expect((await send(reader, "GET", `/api/diagrams/${id}`)).status).toBe(status);
    }

    expect((await send<Refreshed>(stranger, "GET", path)).body.diagrams).toEqual([]);
    const forCreator = await send<Refreshed>(creator, "GET", path);
    expect(forCreator.body.diagrams.map((item) => item.title).toSorted()).toEqual([
      "Hidden",
      "Shown",
    ]);
  });

  it("answers an empty list with nothing, and refuses a bad id or too many", async () => {
    const { api, creator, create, send } = await setup();
    const diagram = await create(creator, { xml: XML });
    expect((await send<Refreshed>(creator, "GET", "/api/diagrams?ids=")).body).toEqual({
      diagrams: [],
    });
    // Asked twice, answered once.
    const read = (ids: ReadonlyArray<string>) =>
      send<Refreshed>(creator, "GET", `/api/diagrams?ids=${ids.join(",")}`);
    // Asked twice, answered once.
    expect((await read([diagram.id, diagram.id])).body.diagrams).toHaveLength(1);

    const bad = await read([diagram.id, "not%20an%20id"]);
    expect([bad.status, bad.body.error]).toEqual([400, "invalid_ids"]);
    const many = Array.from({ length: MAX_DIAGRAM_REFRESH_IDS + 1 }, (_, at) => `id-${at}`);
    expect((await read(many)).status).toBe(400);
    expect((await read(many.slice(1))).status).toBe(200);
    expect((await api.call("GET", `/api/diagrams?ids=${diagram.id}`)).status).toBe(401);
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
      pages: [{ svg: SVG, png: PNG.slice().buffer }],
      pageNames: null,
    });
    expect(saved.ok).toBe(true);

    const current = { id: diagram.id, pictureVersion: 1, picturePages: null };
    const svg = await Diagrams.diagramPicture(images, current, "svg");
    expect(new TextDecoder().decode(svg!.body as ArrayBuffer)).toBe(SVG);
    const png = await Diagrams.diagramPicture(images, current, "png");
    expect(new Uint8Array(png!.body as ArrayBuffer)).toEqual(PNG);
    const count = async (table: string) =>
      (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n;
    expect(await count("diagram_chunks")).toBe(2);
    expect(await count("image_chunks")).toBe(0);

    await Diagrams.deleteDiagram(db, images, diagram.id);
    expect(await count("diagram_chunks")).toBe(0);
    expect(await Diagrams.diagramPicture(images, current, "svg")).toBeNull();
  });
});

describe("sharing a diagram", () => {
  type Members = {
    members: Array<{ id: string; role: string; email: string; pending: boolean }>;
    member?: { id: string; email: string };
    emailDelivery?: string | null;
    error?: string;
  };

  /** A diagram by `creator`, shared with a new person at `role`, who then signs in. */
  async function shared(role: string) {
    const harness = await setup();
    const { api, creator, create, send } = harness;
    const diagram = await create(creator, { title: "Pipeline", xml: XML });
    const added = await send<Members>(creator, "POST", `/api/diagrams/${diagram.id}/members`, {
      email: "guest@example.com",
      role,
    });
    expect(added.status).toBe(201);
    // Nobody had this address before: the invite alone lets them sign in.
    const guest = await api.signIn("guest@example.com");
    return { ...harness, diagram, guest, added };
  }

  it("makes the creator its owner and lists them as the only person on it", async () => {
    const { creator, create, send } = await setup();
    const diagram = await create(creator, { xml: XML });
    expect(diagram).toMatchObject({ role: "owner", member: true });
    const listed = await send<Members>(creator, "GET", `/api/diagrams/${diagram.id}/members`);
    expect(listed.body.members).toEqual([
      expect.objectContaining({ role: "owner", email: "creator@example.com", pending: false }),
    ]);
  });

  it("emails the invite with the diagram's title and link", async () => {
    const { api, diagram, added } = await shared("viewer");
    expect(added.body.emailDelivery).toBe("sent");
    expect(api.invites.at(-1)).toMatchObject({
      to: "guest@example.com",
      docTitle: "Pipeline",
      url: expect.stringMatching(new RegExp(`/diagrams/${diagram.id}$`)),
    });
  });

  it("lets a viewer see it, and nothing more", async () => {
    const { guest, diagram, send, upload } = await shared("viewer");
    const read = await send<{ diagram: DiagramView }>(guest, "GET", `/api/diagrams/${diagram.id}`);
    expect(read.body.diagram).toMatchObject({ role: "viewer", member: true, canEdit: false, xml: null });
    const listed = await send<{ diagrams: Array<DiagramListItem> }>(guest, "GET", "/api/diagrams");
    expect(listed.body.diagrams.map((item) => [item.id, item.role])).toEqual([[diagram.id, "viewer"]]);
    const comment = await send(guest, "POST", `/api/diagrams/${diagram.id}/comments`, {
      body: "Looks good",
      anchor: { page: null, x: 1, y: 1 },
    });
    expect(comment.status).toBe(403);
    expect((await upload(guest, diagram.id, 1)).status).toBe(403);
    const share = await send(guest, "POST", `/api/diagrams/${diagram.id}/members`, {
      email: "third@example.com",
      role: "viewer",
    });
    expect(share.status).toBe(403);
  });

  it("lets a commenter comment but not change the drawing", async () => {
    const { guest, diagram, send } = await shared("commenter");
    const comment = await send(guest, "POST", `/api/diagrams/${diagram.id}/comments`, {
      body: "Looks good",
      anchor: { page: null, x: 1, y: 1 },
    });
    expect(comment.status).toBe(201);
    const write = await send(guest, "PATCH", `/api/diagrams/${diagram.id}`, { title: "Mine" });
    expect(write.status).toBe(403);
  });

  it("lets an editor change it, but only an owner move, delete or share it", async () => {
    const { guest, diagram, project, send } = await shared("editor");
    const read = await send<{ diagram: DiagramView }>(guest, "GET", `/api/diagrams/${diagram.id}`);
    expect(read.body.diagram).toMatchObject({ role: "editor", canEdit: true, xml: XML });
    const redrawn = await send<{ diagram: DiagramView }>(
      guest,
      "PATCH",
      `/api/diagrams/${diagram.id}`,
      { xml: XML2, baseVersion: 1, title: "Pipeline v2" },
    );
    expect(redrawn.status).toBe(200);
    expect(redrawn.body.diagram).toMatchObject({ version: 2, title: "Pipeline v2", role: "editor" });
    const moved = await send(guest, "PATCH", `/api/diagrams/${diagram.id}`, {
      projectId: project.id,
    });
    expect(moved.status).toBe(403);
    expect((await send(guest, "DELETE", `/api/diagrams/${diagram.id}`)).status).toBe(403);
  });

  it("lets a person leave, and keeps the last owner", async () => {
    const { creator, guest, diagram, send } = await shared("editor");
    const path = `/api/diagrams/${diagram.id}/members`;
    const { members } = (await send<Members>(guest, "GET", path)).body;
    const mine = members.find((member) => member.email === "guest@example.com")!;
    const owner = members.find((member) => member.role === "owner")!;
    expect((await send<Members>(creator, "DELETE", `${path}/${owner.id}`)).body.error).toBe(
      "last_owner",
    );
    expect((await send(guest, "DELETE", `${path}/${mine.id}`)).status).toBe(200);
    expect((await send(guest, "GET", `/api/diagrams/${diagram.id}`)).status).toBe(404);
  });

  it("keeps its people list from someone who only sees it through a doc", async () => {
    const { creator, doc, person, create, link, send } = await setup();
    const diagram = await create(creator, { xml: XML });
    await link(doc, diagram.id, creator);
    const reader = await person("reader@example.com", doc.doc.id);
    const read = await send<{ diagram: DiagramView }>(reader, "GET", `/api/diagrams/${diagram.id}`);
    expect(read.body.diagram).toMatchObject({ role: "viewer", member: false });
    expect((await send(reader, "GET", `/api/diagrams/${diagram.id}/members`)).status).toBe(404);
  });

  it("shows a doc's linked diagram when an editor it was shared with linked it", async () => {
    const { creator, otherDoc, person, create, link, send } = await setup();
    const diagram = await create(creator, { xml: XML });
    // The creator is not on otherDoc; an editor of the diagram who is links it there.
    const editor = await person("editor@example.com", otherDoc.doc.id, "editor");
    await send(creator, "POST", `/api/diagrams/${diagram.id}/members`, {
      email: "editor@example.com",
      role: "editor",
    });
    await link(otherDoc, diagram.id, editor);
    const reader = await person("reader@example.com", otherDoc.doc.id);
    expect((await send(reader, "GET", `/api/diagrams/${diagram.id}`)).status).toBe(200);
  });
});
