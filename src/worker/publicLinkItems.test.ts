import { describe, expect, it } from "vitest";

import type { DiagramView } from "../shared/drawio.ts";
import type { PageView } from "../shared/htmlPages.ts";
import type { PublicDiagram, PublicLink, PublicPage } from "../shared/publicLinks.ts";
import { handleApi } from "./api.ts";
import { makeApiHarness, ORIGIN, OWNER } from "./testing/apiHarness.ts";

const XML = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>';
const PAGE = "<!doctype html><html><body><p>Hello from v1</p></body></html>";
const PAGE2 = PAGE.replace("v1", "v2");
const FRAME = { "Sec-Fetch-Dest": "iframe" };

/** The admin, a project, a drawn diagram and a page in it, and a helper per action. */
async function setup() {
  const api = makeApiHarness();
  const admin = await api.signIn();
  const send = async <A>(cookie: string | null, method: string, path: string, body?: unknown) => {
    const response = await api.call(method, path, {
      body,
      headers: cookie ? { Cookie: cookie } : {},
    });
    return { status: response.status, body: (await response.json()) as A };
  };
  const upload = async (cookie: string, path: string, html: string) => {
    const response = await handleApi(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: cookie, "Content-Type": "text/html" },
        body: html,
      }),
      api.deps,
    );
    return (await response.json()) as { page: PageView };
  };
  const { project } = (
    await send<{ project: { id: string } }>(admin, "POST", "/api/projects", { name: "Acme" })
  ).body;
  const diagram = (
    await send<{ diagram: DiagramView }>(admin, "POST", "/api/diagrams", {
      title: "Flow",
      xml: XML,
      projectId: project.id,
    })
  ).body.diagram;
  expect(
    (await send(admin, "PUT", `/api/diagrams/${diagram.id}/picture`, { version: 1, svg: SVG }))
      .status,
  ).toBe(200);
  const other = (
    await send<{ diagram: DiagramView }>(admin, "POST", "/api/diagrams", { title: "Other", xml: XML })
  ).body.diagram;
  await send(admin, "PUT", `/api/diagrams/${other.id}/picture`, { version: 1, svg: SVG });
  const { page } = await upload(admin, `/api/pages?title=Model&projectId=${project.id}`, PAGE);
  const visit = (path: string, headers: Record<string, string> = {}, method = "GET") =>
    api.call(method, path, { headers });
  return { api, admin, send, upload, diagram, other, page, visit };
}

const linkPath = (collection: string, id: string) => `/api/${collection}/${id}/public-link`;

describe("public links for diagrams and pages", () => {
  for (const kind of ["diagrams", "pages"] as const) {
    it(`lets only an owner's browser session publish one of ${kind}`, async () => {
      const { api, admin, send, diagram, other, page } = await setup();
      const id = kind === "diagrams" ? diagram.id : page.id;
      const path = linkPath(kind, id);
      expect((await send(admin, "GET", path)).body).toEqual({ link: null });

      for (const role of ["editor", "commenter", "viewer"]) {
        const email = `${role}@example.com`;
        await send(admin, "POST", `/api/${kind}/${id}/members`, { email, role });
        const cookie = await api.signIn(email);
        for (const method of ["GET", "PUT", "DELETE"]) {
          expect((await send(cookie, method, path)).status).toBe(403);
        }
      }
      // Someone with access to something else only.
      await send(admin, "POST", `/api/diagrams/${other.id}/members`, {
        email: "stranger@example.com",
        role: "owner",
      });
      const stranger = await api.signIn("stranger@example.com");
      expect((await send(stranger, "PUT", path)).status).toBe(404);

      const created = await send<{ token: string }>(admin, "POST", "/api/tokens", { name: "agent" });
      const bearer = { Authorization: `Bearer ${created.body.token}` };
      const agent = await api.call("PUT", path, { headers: bearer });
      expect(agent.status).toBe(403);
      expect(await agent.json()).toEqual({ error: "session_required" });

      const made = await send<{ link: PublicLink }>(admin, "PUT", path);
      expect(made.status).toBe(200);
      expect(made.body.link.url).toBe(`${ORIGIN}/p/${made.body.link.token}`);
      expect((await send<{ link: PublicLink }>(admin, "GET", path)).body.link.token).toBe(
        made.body.link.token,
      );
      expect((await send(admin, "DELETE", path)).body).toEqual({ link: null });
      expect((await send(admin, "GET", path)).body).toEqual({ link: null });
    });
  }

  it("shows a diagram's pictures and nothing else", async () => {
    const { admin, send, diagram, other, visit } = await setup();
    await send(admin, "POST", `/api/diagrams/${diagram.id}/members`, {
      email: "guest@example.com",
      role: "viewer",
    });
    const token = (await send<{ link: PublicLink }>(admin, "PUT", linkPath("diagrams", diagram.id)))
      .body.link.token;
    const base = `/api/public/${token}`;

    const response = await visit(base);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const body = (await response.json()) as PublicDiagram;
    expect(Object.keys(body).toSorted()).toEqual(["diagram", "kind", "title", "updatedAt"]);
    expect(body).toMatchObject({
      kind: "diagram",
      title: "Flow",
      diagram: { id: diagram.id, projectId: null, createdBy: null, hasSource: true },
    });
    const text = JSON.stringify(body);
    for (const leak of ["mxGraphModel", OWNER, "guest@example.com", "Acme"]) {
      expect(text).not.toContain(leak);
    }

    const picture = await visit(`${base}/diagrams/${diagram.id}/picture.svg`);
    expect(picture.status).toBe(200);
    expect(await picture.text()).toBe(SVG);

    const statuses = await Promise.all(
      [
        `${base}/diagrams/${other.id}/picture.svg`,
        `${base}/diagrams/${diagram.id}`,
        `${base}/diagrams/${diagram.id}/picture.svg?page=x`,
        `${base}/content`,
        `${base}/images/11111111-1111-4111-8111-111111111111.png`,
        `${base}/embeds?url=x`,
      ].map(async (path) => (await visit(path)).status),
    );
    expect(statuses.every((status) => status === 404)).toBe(true);
    expect((await visit(base, {}, "POST")).status).toBe(405);

    // Deleting the diagram kills its link.
    expect((await send(admin, "DELETE", `/api/diagrams/${diagram.id}`)).status).toBe(200);
    expect((await visit(base)).status).toBe(404);
  });

  it("serves a page's latest HTML in its sandbox, into a frame only", async () => {
    const { admin, send, upload, page, visit } = await setup();
    const token = (await send<{ link: PublicLink }>(admin, "PUT", linkPath("pages", page.id))).body
      .link.token;
    const base = `/api/public/${token}`;

    const body = (await (await visit(base)).json()) as PublicPage;
    expect(body).toEqual({ kind: "page", title: "Model", updatedAt: page.updatedAt, version: 1 });

    // Opened as a tab of its own, the HTML would show under the app's address.
    expect((await visit(`${base}/content`)).status).toBe(403);
    const framed = await visit(`${base}/content`, FRAME);
    expect(framed.status).toBe(200);
    expect(await framed.text()).toBe(PAGE);
    expect(framed.headers.get("Content-Security-Policy")).toMatch(/^sandbox allow-scripts /);
    expect(framed.headers.get("Content-Security-Policy")).not.toContain("allow-same-origin");
    expect(framed.headers.get("Cache-Control")).toBe("no-store");
    expect(framed.headers.get("Referrer-Policy")).toBe("no-referrer");

    // A new version shows at once; older ones are never reachable.
    await upload(admin, `/api/pages/${page.id}/versions`, PAGE2);
    expect(((await (await visit(base)).json()) as PublicPage).version).toBe(2);
    expect(await (await visit(`${base}/content`, FRAME)).text()).toBe(PAGE2);
    expect((await visit(`${base}/versions/1/content`, FRAME)).status).toBe(404);

    // Reset: the old token stops working.
    const next = (await send<{ link: PublicLink }>(admin, "PUT", linkPath("pages", page.id))).body
      .link.token;
    expect((await visit(base)).status).toBe(404);
    expect((await visit(`/api/public/${next}`)).status).toBe(200);
    expect((await send(admin, "DELETE", `/api/pages/${page.id}`)).status).toBe(200);
    expect((await visit(`/api/public/${next}`)).status).toBe(404);
  });

  it("keeps a token for one item from opening another kind", async () => {
    const { admin, send, diagram, page, visit } = await setup();
    const token = (await send<{ link: PublicLink }>(admin, "PUT", linkPath("pages", page.id))).body
      .link.token;
    expect((await visit(`/api/public/${token}/diagrams/${diagram.id}/picture.svg`)).status).toBe(
      404,
    );
  });
});
