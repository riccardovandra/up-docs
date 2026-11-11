import { describe, expect, it } from "vitest";

import {
  NEUTRAL_THEME,
  UPLIFTED_THEME,
  type CustomDiagramTheme,
  type DiagramThemeList,
  type EffectiveDiagramTheme,
  type RestyleSummary,
} from "../shared/diagramTheme.ts";
import type { DiagramView } from "../shared/drawio.ts";
import type { DocWithTabs } from "../shared/protocol.ts";
import { makeApiHarness } from "./testing/apiHarness.ts";

const XML =
  '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="a" value="Start" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="140" height="60" as="geometry"/></mxCell>' +
  "</root></mxGraphModel>";

const tokens = (change: (value: any) => void = () => undefined) => {
  const value = JSON.parse(JSON.stringify(UPLIFTED_THEME.tokens));
  change(value);
  return value;
};

async function setup() {
  const api = makeApiHarness();
  const admin = await api.signIn();
  const send = async <A>(cookie: string, method: string, path: string, body?: unknown) => {
    const response = await api.call(method, path, { body, headers: { Cookie: cookie } });
    return { status: response.status, body: (await response.json()) as A };
  };
  const { project } = (
    await send<{ project: { id: string } }>(admin, "POST", "/api/projects", { name: "Acme" })
  ).body;
  const doc = (
    await send<DocWithTabs>(admin, "POST", "/api/docs", { projectId: project.id, title: "Plan" })
  ).body;
  const person = async (email: string) => {
    await send(admin, "POST", `/api/docs/${doc.doc.id}/members`, { email, role: "editor" });
    return api.signIn(email);
  };
  const alice = await person("alice@example.com");
  const bob = await person("bob@example.com");
  const createTheme = async (cookie: string, name = "Client blue") =>
    send<{ theme: CustomDiagramTheme; error?: string; message?: string }>(
      cookie,
      "POST",
      "/api/diagram-themes",
      { name, tokens: tokens((t) => (t.roles.primary.stroke = "#112233")) },
    );
  const createDiagram = async (cookie: string, xml = XML) =>
    (
      await send<{ diagram: DiagramView }>(cookie, "POST", "/api/diagrams", {
        projectId: project.id,
        title: "Flow",
        xml,
      })
    ).body.diagram;
  return { api, admin, alice, bob, project, send, createTheme, createDiagram };
}

describe("theme library", () => {
  it("lists the built-ins and every custom theme for everyone signed in", async () => {
    const { admin, alice, bob, send, createTheme } = await setup();
    const made = await createTheme(admin);
    expect(made.status).toBe(201);
    expect(made.body.theme).toMatchObject({ name: "Client blue", builtIn: false });
    expect(made.body.theme.tokens.roles.primary.stroke).toBe("#112233");

    const ids = async (cookie: string) =>
      (await send<DiagramThemeList>(cookie, "GET", "/api/diagram-themes")).body.themes.map(
        (theme) => theme.id,
      );
    for (const cookie of [admin, alice, bob]) {
      expect(await ids(cookie)).toEqual(["neutral", "uplifted", made.body.theme.id]);
    }
    const list = (await send<DiagramThemeList>(bob, "GET", "/api/diagram-themes")).body;
    expect(list.defaultThemeId).toBe("neutral");
    expect(list.themes[1]).toEqual(UPLIFTED_THEME);

    const read = await send<{ theme: CustomDiagramTheme }>(
      bob,
      "GET",
      `/api/diagram-themes/${made.body.theme.id}`,
    );
    expect(read).toMatchObject({ status: 200, body: { theme: { id: made.body.theme.id } } });
    expect((await send(alice, "GET", `/api/diagram-themes/uplifted`)).status).toBe(200);
    expect((await send(alice, "GET", `/api/diagram-themes/abcdefgh`)).status).toBe(404);
  });

  it("lets only the admin create, change and delete a custom theme, and nobody a built-in", async () => {
    const { admin, alice, send, createTheme } = await setup();
    const refused = await createTheme(alice);
    expect(refused).toMatchObject({ status: 403, body: { error: "admin_only" } });
    // Refused before the body is read: a malformed one is still admin_only.
    expect(
      (await send<{ error: string }>(alice, "POST", "/api/diagram-themes", { name: "" })).body,
    ).toMatchObject({ error: "admin_only" });

    const { theme } = (await createTheme(admin)).body;
    const path = `/api/diagram-themes/${theme.id}`;
    const patch = await send<{ error: string }>(alice, "PATCH", path, { name: "Mine now" });
    expect(patch).toMatchObject({ status: 403, body: { error: "admin_only" } });
    const removed = await send<{ error: string }>(alice, "DELETE", path);
    expect(removed).toMatchObject({ status: 403, body: { error: "admin_only" } });
    expect(
      (await send<{ error: string }>(alice, "PATCH", "/api/diagram-themes/uplifted", { name: "X" }))
        .body,
    ).toMatchObject({ error: "admin_only" });

    const renamed = await send<{ theme: CustomDiagramTheme }>(admin, "PATCH", path, {
      name: "Renamed",
    });
    expect(renamed.body.theme).toMatchObject({ name: "Renamed" });
    expect(renamed.body.theme.tokens).toEqual(theme.tokens);
    const restyled = await send<{ theme: CustomDiagramTheme }>(admin, "PATCH", path, {
      tokens: tokens((t) => (t.shadow = true)),
    });
    expect(restyled.body.theme.tokens.shadow).toBe(true);
    expect((await send(admin, "PATCH", path, {})).status).toBe(400);

    const builtIn = await send<{ error: string }>(admin, "PATCH", "/api/diagram-themes/uplifted", {
      name: "Mine",
    });
    expect(builtIn).toMatchObject({ status: 403, body: { error: "built_in_theme" } });
    expect((await send(admin, "DELETE", "/api/diagram-themes/neutral")).status).toBe(403);

    expect((await send(admin, "DELETE", path)).status).toBe(200);
    expect((await send(alice, "GET", path)).status).toBe(404);
  });

  it("keeps a theme a non-admin made before usable by everyone and editable only by the admin", async () => {
    const { api, admin, alice, bob, send, createDiagram } = await setup();
    // A row from before the rule: made by Alice, written straight into the table.
    const aliceId = (await send<{ user: { id: string } }>(alice, "GET", "/api/me")).body.user.id;
    await api.db
      .prepare(
        `INSERT INTO diagram_themes (id, name, tokens, created_by, created_at, updated_at)
         VALUES ('legacy01', 'Old green', ?, ?, 1, 1)`,
      )
      .bind(JSON.stringify(tokens()), aliceId)
      .run();
    const path = "/api/diagram-themes/legacy01";
    expect((await send(bob, "GET", path)).status).toBe(200);
    const bobs = await createDiagram(bob);
    expect(
      (await send(bob, "PUT", `/api/diagrams/${bobs.id}/theme`, { themeId: "legacy01" })).status,
    ).toBe(200);
    expect((await send(alice, "PATCH", path, { name: "Mine" })).status).toBe(403);
    expect((await send(alice, "DELETE", path)).status).toBe(403);
    expect((await send(admin, "PATCH", path, { name: "Green" })).status).toBe(200);
  });

  it("refuses invalid tokens with the field named", async () => {
    const { admin, send } = await setup();
    const sent = await send<{ error: string; message: string }>(
      admin,
      "POST",
      "/api/diagram-themes",
      { name: "Bad", tokens: tokens((t) => (t.font.family = "Inter;fillColor=red")) },
    );
    expect(sent.status).toBe(400);
    expect(sent.body.error).toBe("invalid_theme");
    expect(sent.body.message).toContain("font.family");
    expect(
      (await send(admin, "POST", "/api/diagram-themes", { name: "", tokens: tokens() })).status,
    ).toBe(400);
  });
});

describe("effective theme", () => {
  it("is the diagram's own, else the project's, else Neutral", async () => {
    const { admin, alice, bob, project, send, createTheme, createDiagram } = await setup();
    const diagram = await createDiagram(alice);
    const effective = async () =>
      (await send<EffectiveDiagramTheme>(alice, "GET", `/api/diagrams/${diagram.id}/theme`)).body;
    expect(await effective()).toEqual({
      theme: NEUTRAL_THEME,
      source: "default",
      diagramThemeId: null,
      projectThemeId: null,
    });

    // Only the admin sets a project's default, like any project housekeeping.
    const projectTheme = `/api/projects/${project.id}/diagram-theme`;
    expect((await send(alice, "PUT", projectTheme, { themeId: "uplifted" })).status).toBe(403);
    const set = await send<EffectiveDiagramTheme>(admin, "PUT", projectTheme, {
      themeId: "uplifted",
    });
    expect(set.body).toMatchObject({ source: "project", projectThemeId: "uplifted" });
    expect(await effective()).toMatchObject({ source: "project", theme: { id: "uplifted" } });
    const forNew = await send<EffectiveDiagramTheme>(
      alice,
      "GET",
      `/api/diagram-themes/effective?projectId=${project.id}`,
    );
    expect(forNew.body).toMatchObject({ source: "project", theme: { id: "uplifted" } });
    expect(
      (await send<EffectiveDiagramTheme>(alice, "GET", "/api/diagram-themes/effective?projectId=none"))
        .body.theme.id,
    ).toBe("neutral");

    const { theme } = (await createTheme(admin)).body;
    const own = `/api/diagrams/${diagram.id}/theme`;
    // Bob may not set Alice's diagram, but may put the admin's theme on his own.
    expect((await send(bob, "PUT", own, { themeId: "uplifted" })).status).toBe(404);
    const bobs = await createDiagram(bob);
    const onBobs = await send<EffectiveDiagramTheme>(bob, "PUT", `/api/diagrams/${bobs.id}/theme`, {
      themeId: theme.id,
    });
    expect(onBobs.body).toMatchObject({ source: "diagram", theme: { id: theme.id } });
    expect(
      (await send(bob, "PUT", `/api/diagrams/${bobs.id}/theme`, { themeId: "abcdefgh" })).status,
    ).toBe(404);
    expect((await send(alice, "PUT", own, { themeId: "nope!" })).status).toBe(400);

    const mine = await send<EffectiveDiagramTheme>(alice, "PUT", own, { themeId: theme.id });
    expect(mine.body).toMatchObject({
      source: "diagram",
      diagramThemeId: theme.id,
      theme: { id: theme.id },
    });
    // Deleting the theme sends the diagram back to its project's default.
    await send(admin, "DELETE", `/api/diagram-themes/${theme.id}`);
    expect(await effective()).toMatchObject({ source: "project", diagramThemeId: null });

    await send(alice, "PUT", own, { themeId: "neutral" });
    expect(await effective()).toMatchObject({ source: "diagram", theme: { id: "neutral" } });
    await send(alice, "PUT", own, { themeId: null });
    expect(await effective()).toMatchObject({ source: "project" });
    await send(admin, "PUT", projectTheme, { themeId: null });
    expect(await effective()).toMatchObject({ source: "default", theme: { id: "neutral" } });
  });
});

describe("restyle", () => {
  it("saves the restyled source as a new version, leaving the picture to be redrawn", async () => {
    const { alice, bob, send, createDiagram } = await setup();
    const diagram = await createDiagram(alice);
    const path = `/api/diagrams/${diagram.id}/restyle`;
    expect((await send(alice, "POST", path, {})).status).toBe(400);
    expect((await send(bob, "POST", path, { baseVersion: 1 })).status).toBe(404);
    const stale = await send<{ error: string; version: number }>(alice, "POST", path, {
      baseVersion: 0,
      themeId: "uplifted",
    });
    expect(stale).toMatchObject({ status: 409, body: { error: "version_conflict", version: 1 } });

    const done = await send<{ diagram: DiagramView; themeId: string; summary: RestyleSummary }>(
      alice,
      "POST",
      path,
      { baseVersion: 1, themeId: "uplifted" },
    );
    expect(done.status).toBe(200);
    expect(done.body.themeId).toBe("uplifted");
    expect(done.body.summary).toMatchObject({ pages: 1, changed: 1, shapes: 1 });
    expect(done.body.diagram).toMatchObject({ version: 2, pictureVersion: null });
    expect(done.body.diagram.xml).toContain('id="a" value="Start"');
    expect(done.body.diagram.xml).toContain("fillColor=#dcf0e4");
    expect(done.body.diagram.xml).toContain('<mxGeometry x="40" y="40" width="140" height="60"');

    // The setting is unchanged, and a second restyle saves nothing new.
    expect(
      (await send<EffectiveDiagramTheme>(alice, "GET", `/api/diagrams/${diagram.id}/theme`)).body
        .diagramThemeId,
    ).toBeNull();
    const again = await send<{ diagram: DiagramView; summary: RestyleSummary }>(
      alice,
      "POST",
      path,
      { baseVersion: 2, themeId: "uplifted" },
    );
    expect(again.body.diagram.version).toBe(2);
    expect(again.body.summary.changed).toBe(0);

    // Without a theme: the effective one (Neutral here) maps the roles back.
    const back = await send<{ diagram: DiagramView; themeId: string }>(alice, "POST", path, {
      baseVersion: 2,
    });
    expect(back.body.themeId).toBe("neutral");
    expect(back.body.diagram.xml).toContain("fillColor=#d5e8d4");
  });

  it("lets a non-admin list the admin's theme, set it on their diagram and restyle to it", async () => {
    const { admin, alice, send, createTheme, createDiagram } = await setup();
    const { theme } = (await createTheme(admin)).body;
    const listed = (await send<DiagramThemeList>(alice, "GET", "/api/diagram-themes")).body;
    expect(listed.themes.map((each) => each.id)).toContain(theme.id);
    const diagram = await createDiagram(alice);
    const set = await send<EffectiveDiagramTheme>(alice, "PUT", `/api/diagrams/${diagram.id}/theme`, {
      themeId: theme.id,
    });
    expect(set.body).toMatchObject({ source: "diagram", theme: { id: theme.id } });
    const done = await send<{ diagram: DiagramView; themeId: string; summary: RestyleSummary }>(
      alice,
      "POST",
      `/api/diagrams/${diagram.id}/restyle`,
      { baseVersion: 1, themeId: theme.id },
    );
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ themeId: theme.id, diagram: { version: 2 } });
    expect(done.body.summary.changed).toBe(1);
    // The box was success green in Neutral and stays the success role.
    expect(done.body.diagram.xml).toContain(`fillColor=${theme.tokens.roles.success.fill}`);
  });

  it("maps a box in any custom theme to the same role", async () => {
    const { admin, alice, send, createDiagram } = await setup();
    const orange = (
      await send<{ theme: CustomDiagramTheme }>(admin, "POST", "/api/diagram-themes", {
        name: "Orange",
        tokens: tokens((t) => (t.roles.primary = { fill: "#ffe1c2", stroke: "#e8701a", font: "#14131b" })),
      })
    ).body.theme;
    const xml = XML.replace("fillColor=#d5e8d4;strokeColor=#82b366;", "fillColor=#ffe1c2;strokeColor=#e8701a;");
    const diagram = await createDiagram(alice, xml);
    await send(alice, "PUT", `/api/diagrams/${diagram.id}/theme`, { themeId: orange.id });
    const done = await send<{ diagram: DiagramView; summary: RestyleSummary }>(
      alice,
      "POST",
      `/api/diagrams/${diagram.id}/restyle`,
      { baseVersion: 1, themeId: "uplifted" },
    );
    expect(done.body.summary.roles.primary).toBe(1);
    expect(done.body.diagram.xml).toContain("fillColor=#dbe5f7");
  });
});
