import { describe, expect, it } from "vitest";

import { drawioBlock, type DiagramView } from "../shared/drawio.ts";
import type { DocWithTabs } from "../shared/protocol.ts";
import type { PublicDoc, PublicLink } from "../shared/publicLinks.ts";
import { makeApiHarness, ORIGIN, OWNER } from "./testing/apiHarness.ts";

const XML = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>';
const IMAGE_A = "11111111-1111-4111-8111-111111111111.png";
const IMAGE_B = "22222222-2222-4222-8222-222222222222.png";
const VIDEO_A = "33333333-3333-4333-8333-333333333333.mp4";
const POST = "https://www.linkedin.com/feed/update/urn:li:activity:7209442266791186432";

/** The admin, two docs in a project, an image in each, and a helper per action. */
async function setup() {
  const api = makeApiHarness();
  const admin = await api.signIn();
  const send = async <A>(cookie: string | null, method: string, path: string, body?: unknown) => {
    const response = await api.call(method, path, {
      body,
      headers: cookie ? { Cookie: cookie } : {},
    });
    return { status: response.status, body: (await response.json()) as A, response };
  };
  const { project } = (
    await send<{ project: { id: string } }>(admin, "POST", "/api/projects", { name: "Acme" })
  ).body;
  const newDoc = async (title: string) =>
    (await send<DocWithTabs>(admin, "POST", "/api/docs", { projectId: project.id, title })).body;
  const docA = await newDoc("Shared plan");
  const docB = await newDoc("Private plan");
  const write = async (target: DocWithTabs, markdown: string, by = admin) => {
    const tab = target.tabs[0]!;
    const current = (await send<{ tab: { version: number } }>(by, "GET", `/api/tabs/${tab.id}`))
      .body.tab;
    const written = await send(by, "PATCH", `/api/tabs/${tab.id}`, {
      baseVersion: current.version,
      markdown,
    });
    expect(written.status).toBe(200);
  };
  const png = { body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer, contentType: "image/png" };
  api.images.set(`images/${docA.doc.id}/${IMAGE_A}`, png);
  api.images.set(`images/${docB.doc.id}/${IMAGE_B}`, png);
  api.videos.set(`videos/${docA.doc.id}/${VIDEO_A}`, new Uint8Array([1, 2, 3, 4]));
  await write(docA, `Shared secret-free text\n\n![A](/api/images/${docA.doc.id}/${IMAGE_A})\n`);
  await write(docB, "TOP SECRET doc B text");
  const person = async (email: string, docId: string, role: string) => {
    await send(admin, "POST", `/api/docs/${docId}/members`, { email, role });
    return api.signIn(email);
  };
  const publish = async (docId: string, cookie = admin) =>
    send<{ link: PublicLink }>(cookie, "PUT", `/api/docs/${docId}/public-link`);
  const visit = (path: string, method = "GET", headers: Record<string, string> = {}) =>
    api.call(method, path, { headers });
  return { api, admin, send, docA, docB, write, person, publish, visit };
}

describe("public links", () => {
  it("lets only an owner's browser session turn the link on, read it and turn it off", async () => {
    const { api, admin, send, docA, person, publish } = await setup();
    const path = `/api/docs/${docA.doc.id}/public-link`;
    expect((await send<{ link: null }>(admin, "GET", path)).body).toEqual({ link: null });

    for (const role of ["editor", "commenter", "viewer"]) {
      const cookie = await person(`${role}@example.com`, docA.doc.id, role);
      expect((await publish(docA.doc.id, cookie)).status).toBe(403);
      expect((await send(cookie, "GET", path)).status).toBe(403);
      expect((await send(cookie, "DELETE", path)).status).toBe(403);
    }
    const stranger = await person("stranger@example.com", (await setupOtherDoc()).id, "owner");
    expect((await publish(docA.doc.id, stranger)).status).toBe(404);

    // An agent token cannot publish, even the admin's.
    const created = await send<{ token: string }>(admin, "POST", "/api/tokens", { name: "agent" });
    const bearer = { Authorization: `Bearer ${created.body.token}` };
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await api.call(method, path, { headers: bearer });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "session_required" });
    }
    // A cookie sent from another site cannot publish.
    const crossSite = await api.call("PUT", path, {
      headers: { Cookie: admin, Origin: "https://evil.test" },
    });
    expect(crossSite.status).toBe(403);
    expect((await send(admin, "GET", path)).body).toEqual({ link: null });

    const made = await publish(docA.doc.id);
    expect(made.status).toBe(200);
    expect(made.body.link.url).toBe(`${ORIGIN}/p/${made.body.link.token}`);
    expect(made.body.link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await send<{ link: PublicLink }>(admin, "GET", path)).body.link.token).toBe(
      made.body.link.token,
    );
    expect((await send(admin, "DELETE", path)).body).toEqual({ link: null });
    expect((await send(admin, "GET", path)).body).toEqual({ link: null });

    async function setupOtherDoc() {
      return (
        await send<DocWithTabs>(admin, "POST", "/api/docs", { title: "Stranger's", projectId: null })
      ).body.doc;
    }
  });

  it("shows the one doc with an allowlist of fields and no session", async () => {
    const { send, docA, publish, visit, person } = await setup();
    await person("guest@example.com", docA.doc.id, "viewer");
    const { token } = (await publish(docA.doc.id)).body.link;
    const response = await visit(`/api/public/${token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    const body = (await response.json()) as PublicDoc;
    expect(Object.keys(body).toSorted()).toEqual(["diagrams", "docId", "tabs", "title", "updatedAt"]);
    expect(body.title).toBe("Shared plan");
    expect(body.tabs).toHaveLength(1);
    expect(body.tabs[0]!.markdown).toContain("Shared secret-free text");
    const text = JSON.stringify(body);
    for (const leak of [OWNER, "guest@example.com", "TOP SECRET", "Acme"]) {
      expect(text).not.toContain(leak);
    }
    // The link does not sign the visitor in to anything else.
    expect((await send(null, "GET", "/api/library")).status).toBe(401);
    expect((await send(null, "GET", `/api/docs/${docA.doc.id}`)).status).toBe(401);
  });

  it("never reaches another doc, its uploads or a write", async () => {
    const { docA, docB, publish, visit } = await setup();
    const { token } = (await publish(docA.doc.id)).body.link;
    const base = `/api/public/${token}`;

    expect((await visit(`${base}/images/${IMAGE_A}`)).status).toBe(200);
    expect((await visit(`${base}/videos/${VIDEO_A}`)).status).toBe(200);
    const statuses = await Promise.all(
      [
        `${base}/images/${IMAGE_B}`,
        `${base}/images/..%2F${docB.doc.id}%2F${IMAGE_B}`,
        `${base}/images/${docB.doc.id}/${IMAGE_B}`,
        `${base}/images/../../images/${docB.doc.id}/${IMAGE_B}`,
        `${base}/docs/${docB.doc.id}`,
        `${base}/tabs/${docB.tabs[0]!.id}`,
        `${base}/comments`,
        `${base}/members`,
        `${base}/embeds?url=${encodeURIComponent(POST)}`,
        `/api/public/${token.slice(0, -1)}A`,
        `/api/public/${token}x`,
        "/api/public/not-a-token",
        "/api/public",
      ].map(async (path) => (await visit(path)).status),
    );
    expect(statuses.every((status) => status === 404)).toBe(true);

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await visit(base, method);
      expect(response.status).toBe(405);
    }
  });

  it("serves only the doc's saved copy of a post and never fetches it", async () => {
    const { api, docA, publish, visit } = await setup();
    const { token } = (await publish(docA.doc.id)).body.link;
    const path = `/api/public/${token}/embeds?url=${encodeURIComponent(POST)}`;
    expect((await visit(path)).status).toBe(404);
    expect(api.fetched).toEqual([]);
    await api.db
      .prepare("INSERT INTO embed_snapshots (doc_id, url, data, fetched_at) VALUES (?, ?, ?, 1)")
      .bind(docA.doc.id, POST, JSON.stringify({ provider: "linkedin", url: POST, text: "Hi" }))
      .run();
    const saved = await visit(path);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ embed: { text: "Hi" } });
    expect(api.fetched).toEqual([]);
  });

  it("shows a linked diagram only where someone who can edit it can edit the doc", async () => {
    const { admin, send, docA, write, person, publish, visit } = await setup();
    const creator = await person("creator@example.com", docA.doc.id, "viewer");
    const created = await send<{ diagram: DiagramView }>(creator, "POST", "/api/diagrams", {
      title: "Flow",
      xml: XML,
    });
    const diagram = created.body.diagram;
    expect(
      (await send(creator, "PUT", `/api/diagrams/${diagram.id}/picture`, { version: 1, svg: SVG }))
        .status,
    ).toBe(200);
    // An editor of the doc who was never given the diagram pastes its id.
    const linker = await person("linker@example.com", docA.doc.id, "editor");
    await write(docA, `Intro\n\n${drawioBlock(diagram.id, "The flow")}\n`, linker);
    const { token } = (await publish(docA.doc.id)).body.link;
    const picture = `/api/public/${token}/diagrams/${diagram.id}/picture.svg`;
    const shown = async () =>
      ((await (await visit(`/api/public/${token}`)).json()) as PublicDoc).diagrams;

    expect(await shown()).toEqual([]);
    expect((await visit(picture)).status).toBe(404);

    // Once the diagram's creator can edit the doc, the link may show it.
    await send(admin, "POST", `/api/docs/${docA.doc.id}/members`, {
      email: "creator@example.com",
      role: "editor",
    });
    const listed = await shown();
    expect(listed.map((each) => each.id)).toEqual([diagram.id]);
    expect(listed[0]).toMatchObject({ title: "Flow", projectId: null, createdBy: null });
    expect(JSON.stringify(listed)).not.toContain("mxGraphModel");
    const served = await visit(picture);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(SVG);
    expect(served.headers.get("Cache-Control")).toBe("no-store");
    // The source is never reachable through the link.
    expect((await visit(`/api/public/${token}/diagrams/${diagram.id}`)).status).toBe(404);

    // Unlinked from the doc: gone again.
    await write(docA, "No diagram now");
    expect((await visit(picture)).status).toBe(404);
  });

  it("stops working at once when turned off, reset or the doc is deleted", async () => {
    const { send, admin, docA, publish, visit } = await setup();
    const first = (await publish(docA.doc.id)).body.link.token;
    const second = (await publish(docA.doc.id)).body.link.token;
    expect(second).not.toBe(first);
    expect((await visit(`/api/public/${first}`)).status).toBe(404);
    expect((await visit(`/api/public/${second}`)).status).toBe(200);

    await send(admin, "DELETE", `/api/docs/${docA.doc.id}/public-link`);
    expect((await visit(`/api/public/${second}`)).status).toBe(404);
    expect((await visit(`/api/public/${second}/images/${IMAGE_A}`)).status).toBe(404);

    const third = (await publish(docA.doc.id)).body.link.token;
    expect((await send(admin, "DELETE", `/api/docs/${docA.doc.id}`)).status).toBe(200);
    expect((await visit(`/api/public/${third}`)).status).toBe(404);
  });
});
