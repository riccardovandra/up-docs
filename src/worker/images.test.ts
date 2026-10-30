import { describe, expect, it } from "vitest";

import type { DocRole } from "../shared/access.ts";
import { isDocImageSrc, MAX_IMAGE_BYTES } from "../shared/images.ts";
import type { DocWithTabs } from "../shared/protocol.ts";
import { handleApi } from "./api.ts";
import { makeApiHarness, ORIGIN } from "./testing/apiHarness.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

async function setup() {
  const api = makeApiHarness();
  const owner = await api.signIn();
  const { project } = (await (
    await api.call("POST", "/api/projects", { body: { name: "P" }, headers: { Cookie: owner } })
  ).json()) as { project: { id: string } };
  const created = (await (
    await api.call("POST", "/api/docs", {
      body: { projectId: project.id, title: "Plan" },
      headers: { Cookie: owner },
    })
  ).json()) as DocWithTabs;
  const docId = created.doc.id;
  const person = async (email: string, role: DocRole) => {
    await api.call("POST", `/api/docs/${docId}/members`, {
      body: { email, role },
      headers: { Cookie: owner },
    });
    return api.signIn(email);
  };
  const upload = (
    cookie: string,
    body: BodyInit,
    headers: Record<string, string> = { "Content-Type": "image/png" },
  ) =>
    handleApi(
      new Request(`${ORIGIN}/api/docs/${docId}/images`, {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: cookie, ...headers },
        body,
      }),
      api.deps,
    );
  return { api, owner, projectId: project.id, docId, person, upload };
}

describe("image routes", () => {
  it("stores an editor's upload and serves it to anyone who can read the doc", async () => {
    const { api, owner, docId, person, upload } = await setup();
    const editor = await person("e@example.com", "editor");
    const response = await upload(editor, PNG);
    expect(response.status).toBe(201);
    const { url } = (await response.json()) as { url: string };
    expect(isDocImageSrc(url)).toBe(true);
    expect(url.startsWith(`/api/images/${docId}/`)).toBe(true);
    expect([...api.images.keys()]).toEqual([url.replace("/api/", "")]);

    const viewer = await person("v@example.com", "viewer");
    for (const cookie of [owner, viewer]) {
      const served = await api.call("GET", url, { headers: { Cookie: cookie } });
      expect(served.status).toBe(200);
      expect(served.headers.get("Content-Type")).toBe("image/png");
      expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
    }
  });

  it("refuses uploads from commenters and viewers, and reads by non-members", async () => {
    const { api, owner, projectId, upload, person } = await setup();
    expect((await upload(await person("v@example.com", "viewer"), PNG)).status).toBe(403);
    expect((await upload(await person("c@example.com", "commenter"), PNG)).status).toBe(403);
    const { url } = (await (await upload(owner, PNG)).json()) as { url: string };

    // Signed in through another doc, with no access to this one.
    const elsewhere = (await (
      await api.call("POST", "/api/docs", {
        body: { projectId, title: "Other" },
        headers: { Cookie: owner },
      })
    ).json()) as DocWithTabs;
    await api.call("POST", `/api/docs/${elsewhere.doc.id}/members`, {
      body: { email: "s@example.com", role: "editor" },
      headers: { Cookie: owner },
    });
    const stranger = await api.signIn("s@example.com");
    expect((await api.call("GET", url, { headers: { Cookie: stranger } })).status).toBe(404);
    expect((await api.call("GET", url)).status).toBe(401);
  });

  it("checks type, content and size", async () => {
    const { api, owner, upload } = await setup();
    const { token } = (await (
      await api.call("POST", "/api/tokens", { body: { name: "agent" }, headers: { Cookie: owner } })
    ).json()) as { token: string };
    const bearer = (type: string, body: BodyInit) =>
      upload("", body, { "Content-Type": type, Authorization: `Bearer ${token}` });
    expect((await bearer("image/svg+xml", "<svg/>")).status).toBe(415);
    expect((await bearer("text/html", "<html>")).status).toBe(415);
    // A session may only POST JSON or an allowed image type.
    expect((await upload(owner, "<svg/>", { "Content-Type": "image/svg+xml" })).status).toBe(403);
    expect((await upload(owner, "<html><script>")).status).toBe(400);
    expect((await upload(owner, new Uint8Array())).status).toBe(400);
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(PNG);
    expect((await upload(owner, big)).status).toBe(413);
    expect((await upload(owner, "GIF89a......", { "Content-Type": "image/gif" })).status).toBe(201);
  });

  it("refuses a cross-site upload with the session cookie", async () => {
    const { api, owner, docId } = await setup();
    const response = await handleApi(
      new Request(`${ORIGIN}/api/docs/${docId}/images`, {
        method: "POST",
        headers: { Origin: "https://evil.test", Cookie: owner, "Content-Type": "image/png" },
        body: PNG,
      }),
      api.deps,
    );
    expect(response.status).toBe(403);
  });

  it("does not serve names it never issued", async () => {
    const { api, owner, docId } = await setup();
    for (const file of ["../secret", "x.png", "00000000-0000-0000-0000-000000000000.svg"]) {
      const response = await api.call("GET", `/api/images/${docId}/${file}`, {
        headers: { Cookie: owner },
      });
      expect(response.status).toBe(404);
    }
  });
});
