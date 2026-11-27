import { describe, expect, it } from "vitest";

import type { DesignView } from "../shared/design.ts";
import {
  designBlock,
  MAX_DESIGN_REFRESH_IDS,
  type DesignRefresh,
  type DesignUsage,
} from "../shared/designBlock.ts";
import type { DocWithTabs } from "../shared/protocol.ts";
import { handleApi } from "./api.ts";
import { markdownToDocx } from "./export/docx.ts";
import { ORIGIN, makeApiHarness } from "./testing/apiHarness.ts";

const FIG = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/**
 * The admin, a project, two docs, and `creator`, an editor of the first doc
 * who makes designs. People join a doc to get an account.
 */
async function setup() {
  const api = makeApiHarness();
  const admin = await api.signIn();
  const as = (cookie: string) => ({ headers: { Cookie: cookie } });
  const send = async <A>(cookie: string, method: string, path: string, body?: unknown) => {
    const response = await api.call(method, path, { body, headers: { Cookie: cookie } });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Binary bodies.
    }
    return { status: response.status, body: parsed as A };
  };
  const { project } = (
    await send<{ project: { id: string } }>(admin, "POST", "/api/projects", { name: "Acme" })
  ).body;
  const newDoc = async (title: string, by = admin) =>
    (await send<DocWithTabs>(by, "POST", "/api/docs", { projectId: project.id, title })).body;
  const doc = await newDoc("Playbook");
  const otherDoc = await newDoc("Elsewhere");
  const person = async (email: string, docId: string, role = "viewer") => {
    await send(admin, "POST", `/api/docs/${docId}/members`, { email, role });
    return api.signIn(email);
  };
  const creator = await person("creator@example.com", doc.doc.id, "editor");
  const create = async (cookie: string, title = "Home screen") =>
    (await send<{ design: DesignView }>(cookie, "POST", "/api/designs", { title })).body.design;
  /** One save with a picture, so the design has version 1 and a picture. */
  const save = async (cookie: string, designId: string, baseVersion = 0) => {
    const response = await handleApi(
      new Request(
        `${ORIGIN}/api/designs/${designId}/versions?baseVersion=${baseVersion}&figBytes=${FIG.length}`,
        {
          method: "POST",
          headers: {
            Origin: ORIGIN,
            Cookie: cookie,
            "Content-Type": "application/octet-stream",
          },
          body: new Uint8Array([...FIG, ...PNG]),
        },
      ),
      api.deps,
    );
    expect(response.status).toBe(201);
  };
  /** Writes `markdown` into a doc's first tab, as `by`. */
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
  const link = (target: DocWithTabs, designId: string, by = admin) =>
    write(target, `Intro\n\n${designBlock(designId, "The home screen")}\n`, by);
  /** Statuses of the summary, the picture and the .fig for `cookie`. */
  const statuses = async (cookie: string, designId: string) => {
    const paths = [
      `/api/designs/${designId}`,
      `/api/designs/${designId}/picture/1`,
      `/api/designs/${designId}/fig`,
    ];
    const responses = await Promise.all(paths.map((path) => api.call("GET", path, as(cookie))));
    return responses.map((response) => response.status);
  };
  return {
    api,
    admin,
    creator,
    doc,
    otherDoc,
    newDoc,
    person,
    create,
    save,
    write,
    link,
    send,
    as,
    statuses,
  };
}

describe("seeing a design through a doc", () => {
  it("gives a reader of a doc that shows it the picture and summary, never the file", async () => {
    const { creator, doc, person, create, save, link, send, statuses } = await setup();
    const design = await create(creator);
    await save(creator, design.id);
    const reader = await person("reader@example.com", doc.doc.id);

    // On the doc, but the doc does not show it yet.
    expect(await statuses(reader, design.id)).toEqual([404, 404, 404]);

    await link(doc, design.id, creator);
    expect(await statuses(reader, design.id)).toEqual([200, 200, 404]);
    const read = await send<{ design: DesignView }>(reader, "GET", `/api/designs/${design.id}`);
    expect(read.body.design).toMatchObject({ role: "viewer", canEdit: false, pictureVersion: 1 });

    // Not on its people list: no list entry, no changes, not told where it is used.
    const listed = await send<{ designs: Array<unknown> }>(reader, "GET", "/api/designs");
    expect(listed.body.designs).toEqual([]);
    const refused = [
      await send(reader, "PATCH", `/api/designs/${design.id}`, { title: "Mine" }),
      await send(reader, "DELETE", `/api/designs/${design.id}`),
      await send(reader, "GET", `/api/designs/${design.id}/uses`),
    ];
    expect(refused.map((response) => response.status)).toEqual([404, 404, 403]);
    // The creator still has the file.
    expect(await statuses(creator, design.id)).toEqual([200, 200, 200]);
  });

  it("shows nothing when the doc's editors do not manage the design", async () => {
    const { admin, creator, otherDoc, person, create, save, link, send, statuses } = await setup();
    const design = await create(creator);
    await save(creator, design.id);
    // An editor of a doc the creator is not on pastes the id.
    const linker = await person("linker@example.com", otherDoc.doc.id, "editor");
    const member = await person("member@example.com", otherDoc.doc.id);
    await link(otherDoc, design.id, linker);
    for (const cookie of [linker, member]) {
      expect(await statuses(cookie, design.id)).toEqual([404, 404, 404]);
    }
    const exported = await send<string>(member, "GET", `/api/docs/${otherDoc.doc.id}/export.md`);
    expect(exported.body).toContain("Design not found");
    expect(exported.body).not.toContain("Home screen");

    // The creator as a viewer or commenter of that doc still does not count.
    const members = `/api/docs/${otherDoc.doc.id}/members`;
    for (const role of ["viewer", "commenter"]) {
      await send(admin, "POST", members, { email: "creator@example.com", role });
      expect(await statuses(member, design.id)).toEqual([404, 404, 404]);
    }
    // Once the creator edits the doc, its block shows the picture to everyone on it.
    await send(admin, "POST", members, { email: "creator@example.com", role: "editor" });
    for (const cookie of [linker, member]) {
      expect(await statuses(cookie, design.id)).toEqual([200, 200, 404]);
    }
  });

  it("counts only a block that parses and names the design", async () => {
    const { creator, doc, person, create, save, write, statuses } = await setup();
    const design = await create(creator);
    await save(creator, design.id);
    const reader = await person("reader@example.com", doc.doc.id);
    await write(doc, `Mentions ${design.id} in text\n\n\`\`\`t3-design\n${design.id}\na\nb\n\`\`\`\n`, creator);
    expect(await statuses(reader, design.id)).toEqual([404, 404, 404]);
  });
});

describe("where a design is used", () => {
  it("lists the docs and tabs that show it, and counts the others", async () => {
    const { admin, creator, doc, otherDoc, person, create, link, send } = await setup();
    const design = await create(creator);
    await link(doc, design.id, creator);
    await link(otherDoc, design.id, admin);
    const usage = await send<DesignUsage>(creator, "GET", `/api/designs/${design.id}/uses`);
    expect(usage.status).toBe(200);
    expect(usage.body).toEqual({
      uses: [
        { docId: doc.doc.id, docTitle: "Playbook", tabId: doc.tabs[0]!.id, tabTitle: expect.any(String) },
      ],
      otherDocs: 1,
    });
    // The admin is on both docs.
    const all = await send<DesignUsage>(admin, "GET", `/api/designs/${design.id}/uses`);
    expect(all.body.uses.map((use) => use.docId).sort()).toEqual(
      [doc.doc.id, otherDoc.doc.id].sort(),
    );
    // Someone who only sees it through a doc is not told.
    const reader = await person("reader@example.com", doc.doc.id);
    expect((await send(reader, "GET", `/api/designs/${design.id}/uses`)).status).toBe(403);
  });
});

describe("re-reading designs by id", () => {
  it("returns the designs the caller may see, newest version, never the file", async () => {
    const { creator, doc, person, create, save, link, send } = await setup();
    const shown = await create(creator, "Shown");
    const hidden = await create(creator, "Hidden");
    await save(creator, shown.id);
    await link(doc, shown.id, creator);
    const reader = await person("reader@example.com", doc.doc.id);
    const ids = [shown.id, hidden.id, "gone"].join(",");
    const seen = await send<{ designs: Array<DesignRefresh> }>(reader, "GET", `/api/designs?ids=${ids}`);
    expect(seen.status).toBe(200);
    expect(seen.body.designs).toEqual([
      expect.objectContaining({ id: shown.id, version: 1, pictureVersion: 1, role: "viewer", canEdit: false }),
    ]);
    await save(creator, shown.id, 1);
    const again = await send<{ designs: Array<DesignRefresh> }>(reader, "GET", `/api/designs?ids=${shown.id}`);
    expect(again.body.designs[0]).toMatchObject({ version: 2, pictureVersion: 2 });

    const mine = await send<{ designs: Array<DesignRefresh> }>(creator, "GET", `/api/designs?ids=${ids}`);
    expect(mine.body.designs.map((design) => design.id)).toEqual([shown.id, hidden.id]);
  });

  it("answers an empty list with nothing, and refuses a bad id or too many", async () => {
    const { creator, send } = await setup();
    expect((await send(creator, "GET", "/api/designs?ids=")).body).toEqual({ designs: [] });
    expect((await send(creator, "GET", "/api/designs?ids=a,b!")).status).toBe(400);
    const many = Array.from({ length: MAX_DESIGN_REFRESH_IDS + 1 }, (_, index) => `d${index}`);
    expect((await send(creator, "GET", `/api/designs?ids=${many.join(",")}`)).status).toBe(400);
  });
});

describe("exporting a doc that shows a design", () => {
  it("writes the picture into Markdown, linked to the design page", async () => {
    const { creator, doc, person, create, save, link, send } = await setup();
    const design = await create(creator, "Home screen");
    await save(creator, design.id);
    await link(doc, design.id, creator);
    const reader = await person("reader@example.com", doc.doc.id);
    for (const path of [`/api/docs/${doc.doc.id}/export.md`, `/api/tabs/${doc.tabs[0]!.id}/export.md`]) {
      const exported = await send<string>(reader, "GET", path);
      expect(exported.status).toBe(200);
      expect(exported.body).toContain(
        `[![Home screen](${ORIGIN}/api/designs/${design.id}/picture/1)](${ORIGIN}/designs/${design.id})`,
      );
      expect(exported.body).toContain("The home screen");
      expect(exported.body).not.toContain("t3-design");
    }
  });

  it("links the picture in Word", async () => {
    const { creator, doc, create, save, link, api, as } = await setup();
    const design = await create(creator, "Home screen");
    await save(creator, design.id);
    await link(doc, design.id, creator);
    const response = await api.call("GET", `/api/docs/${doc.doc.id}/export.docx`, as(creator));
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Stored (uncompressed) zip: the parts are readable as text.
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("[Home screen]");
    expect(text).toContain(`/api/designs/${design.id}/picture/1`);
    expect(text).not.toContain("t3-design");

    const gone = new TextDecoder().decode(
      markdownToDocx({
        title: "T",
        markdown: designBlock("gone"),
        docUrl: `${ORIGIN}/d/x`,
        designs: new Map(),
      }),
    );
    expect(gone).toContain("Design not found.");
  });
});
