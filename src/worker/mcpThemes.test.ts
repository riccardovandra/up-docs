import { describe, expect, it } from "vitest";

import { NEUTRAL_THEME, themeStyleGuide, UPLIFTED_THEME } from "../shared/diagramTheme.ts";
import * as Diagrams from "./diagrams.ts";
import { makeMcpHarness } from "./testing/mcpHarness.ts";
import { hasOwnColours } from "./mcpThemes.ts";

const model = (cells: string) =>
  `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`;
const box = (id: string, label: string, style = "rounded=1;whiteSpace=wrap;html=1;") =>
  `<mxCell id="${id}" value="${label}" style="${style}" vertex="1" parent="1">` +
  `<mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>`;
const edge = (id: string, source: string, target: string) =>
  `<mxCell id="${id}" style="endArrow=block;html=1;" edge="1" parent="1" ` +
  `source="${source}" target="${target}"><mxGeometry relative="1" as="geometry"/></mxCell>`;

const PLAIN = model(box("a", "Lead") + box("b", "Client") + edge("e", "a", "b"));
const COLOURED = model(
  box("a", "Lead", "rounded=1;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;") +
    box("b", "Client") +
    edge("e", "a", "b"),
);

type Harness = Awaited<ReturnType<typeof makeMcpHarness>>;

/** The admin's agent and a project whose diagrams default to `themeId` (none: no default). */
async function setup(themeId?: string) {
  const mcp = await makeMcpHarness();
  const project = await mcp.tool("create_project", { name: "Acme" });
  const projectId = project.body.projectId as string;
  if (themeId) {
    const set = await mcp.tool("set_diagram_theme", { projectId, themeId });
    expect(set.isError).toBe(false);
  }
  return { mcp, projectId };
}

const stored = async (mcp: Harness, diagramId: string) =>
  (await Diagrams.getDiagram(mcp.api.db, diagramId)).xml;

/** A custom theme made through the REST route by `email` (the owner when left out). */
async function customTheme(mcp: Harness, name: string, email?: string) {
  const cookie = email ? await mcp.api.signIn(email) : mcp.cookie;
  const response = await mcp.api.call("POST", "/api/diagram-themes", {
    body: { name, tokens: { ...UPLIFTED_THEME.tokens, defaultRole: "success" } },
    headers: { Cookie: cookie },
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { theme: { id: string } }).theme.id;
}

describe("MCP diagram themes", () => {
  it("tells whether XML sets colours of its own", async () => {
    expect(await hasOwnColours(PLAIN)).toBe(false);
    expect(await hasOwnColours(COLOURED)).toBe(true);
    // "none" and "default" are not colour choices; text cells carry them.
    expect(
      await hasOwnColours(model(box("t", "Note", "text;html=1;fillColor=none;strokeColor=none;fontColor=default;"))),
    ).toBe(false);
    expect(await hasOwnColours(model(box("t", "Note", "text;html=1;fontColor=#ff0000;")))).toBe(true);
  });

  it("create_drawio in an Uplifted project returns its style lines and stores plain XML themed", async () => {
    const { mcp, projectId } = await setup("uplifted");
    const created = await mcp.tool("create_drawio", { projectId, title: "Funnel", xml: PLAIN });
    expect(created.isError).toBe(false);
    expect(created.body.theme).toEqual({
      themeId: "uplifted",
      name: "Uplifted",
      source: "project",
      styleGuide: themeStyleGuide(UPLIFTED_THEME),
      applied: expect.stringContaining('Restyled to the theme "Uplifted"'),
    });
    const xml = await stored(mcp, created.body.diagramId);
    expect(xml).toContain("fillColor=#dbe5f7");
    expect(xml).toContain("strokeColor=#4d79d8");
    expect(xml).toContain("fontFamily=Inter");
    // Ids and labels are kept, so the description reads the same.
    expect(created.body.shapes).toEqual(["Lead", "Client"]);
    expect(created.body.connections).toEqual(["Lead -> Client"]);

    const read = await mcp.tool("read_drawio", { diagramId: created.body.diagramId });
    expect(read.body.theme).toMatchObject({ themeId: "uplifted", source: "project" });
  });

  it("keeps colours the agent chose, unless applyTheme is true", async () => {
    const { mcp, projectId } = await setup("uplifted");
    const kept = await mcp.tool("create_drawio", { projectId, title: "Mine", xml: COLOURED });
    expect(kept.body.theme.applied).toContain("keeping the colours");
    expect(await stored(mcp, kept.body.diagramId)).toBe(COLOURED);

    const forced = await mcp.tool("create_drawio", {
      projectId,
      title: "Forced",
      xml: COLOURED,
      applyTheme: true,
    });
    const forcedXml = await stored(mcp, forced.body.diagramId);
    expect(forcedXml).not.toContain("#b85450");
    expect(forcedXml).toContain("fontFamily=Inter");

    const never = await mcp.tool("create_drawio", {
      projectId,
      title: "As written",
      xml: PLAIN,
      applyTheme: false,
    });
    expect(never.body.theme.applied).toContain("applyTheme: false");
    expect(await stored(mcp, never.body.diagramId)).toBe(PLAIN);

    const bad = await mcp.tool("create_drawio", { projectId, title: "x", xml: PLAIN, applyTheme: "yes" });
    expect(bad).toMatchObject({ isError: true, body: { error: "invalid_argument" } });
  });

  it("leaves XML as written when only the Neutral fallback applies", async () => {
    const { mcp, projectId } = await setup();
    const created = await mcp.tool("create_drawio", { projectId, title: "Plain", xml: PLAIN });
    expect(created.body.theme).toMatchObject({
      themeId: "neutral",
      source: "default",
      styleGuide: themeStyleGuide(NEUTRAL_THEME),
    });
    expect(await stored(mcp, created.body.diagramId)).toBe(PLAIN);
  });

  it("lists built-ins and the caller's own themes with role colours", async () => {
    const mcp = await makeMcpHarness();
    const own = await customTheme(mcp, "Board deck");
    const list = await mcp.tool("list_diagram_themes", {});
    expect(list.body.defaultThemeId).toBe("neutral");
    expect(list.body.roleColours).toBe("fill/line/text");
    expect(list.body.themes.map((theme: { themeId: string }) => theme.themeId)).toEqual([
      "neutral",
      "uplifted",
      own,
    ]);
    expect(list.body.themes[1]).toMatchObject({
      name: "Uplifted",
      builtIn: true,
      defaultRole: "primary",
      roles: { primary: "#dbe5f7/#4d79d8/#14131b", accent: "#3a5fb5/#33559f/#ffffff" },
      look: expect.stringContaining("Inter 14, titles Montserrat"),
    });
    expect(list.body.themes[2]).toMatchObject({ name: "Board deck", builtIn: false, mine: true, defaultRole: "success" });

    // Someone else (signed up through a shared doc) sees only the built-ins.
    const { doc } = await mcp.seedDoc("Intro");
    await mcp.tool("share_doc", { docId: doc.docId, email: "guest@example.com", role: "viewer" });
    const other = await mcp.asUser("guest@example.com");
    const theirs = await other("list_diagram_themes", {});
    expect(theirs.body.themes.map((theme: { themeId: string }) => theme.themeId)).toEqual(["neutral", "uplifted"]);
  });

  it("set_diagram_theme sets a diagram's theme, with and without a restyle", async () => {
    const { mcp, projectId } = await setup();
    const created = await mcp.tool("create_drawio", { projectId, title: "Flow", xml: PLAIN });
    const diagramId = created.body.diagramId as string;

    const set = await mcp.tool("set_diagram_theme", { diagramId, themeId: "uplifted" });
    expect(set.body).toMatchObject({
      diagramId,
      version: 1,
      theme: { themeId: "uplifted", source: "diagram" },
      note: expect.stringContaining("No drawing was changed"),
    });
    expect(await stored(mcp, diagramId)).toBe(PLAIN);

    const restyled = await mcp.tool("set_diagram_theme", { diagramId, themeId: "uplifted", restyle: true });
    expect(restyled.isError).toBe(false);
    expect(restyled.body).toMatchObject({
      diagramId,
      version: 2,
      theme: { themeId: "uplifted", source: "diagram" },
      restyle: { pages: 1, shapes: 2, connections: 1, roles: { primary: 2 } },
    });
    expect(restyled.body.restyle.changed).toBeGreaterThan(0);
    expect(await stored(mcp, diagramId)).toContain("fillColor=#dbe5f7");

    // A second restyle to the same theme changes nothing and keeps the version.
    const again = await mcp.tool("set_diagram_theme", { diagramId, themeId: "uplifted", restyle: true });
    expect(again.body).toMatchObject({ version: 2, restyle: { changed: 0 } });

    // null follows the project again (here: Neutral), and update_drawio reports it.
    const cleared = await mcp.tool("set_diagram_theme", { diagramId, themeId: null });
    expect(cleared.body.theme).toMatchObject({ themeId: "neutral", source: "default" });
    const updated = await mcp.tool("update_drawio", { diagramId, baseVersion: 2, title: "Flow 2" });
    expect(updated.body.theme).toMatchObject({ themeId: "neutral", source: "default" });

    const bad = await mcp.tool("set_diagram_theme", { diagramId, themeId: "not a theme!" });
    expect(bad).toMatchObject({ isError: true, body: { error: "invalid_argument" } });
    const missing = await mcp.tool("set_diagram_theme", { diagramId });
    expect(missing).toMatchObject({ isError: true, body: { error: "invalid_argument" } });
    const unknown = await mcp.tool("set_diagram_theme", { diagramId, themeId: "no-such-theme" });
    expect(unknown).toMatchObject({ isError: true, body: { error: "not_found" } });
  });

  it("sets a project's default for the admin, and new diagrams follow it", async () => {
    const { mcp, projectId } = await setup();
    const set = await mcp.tool("set_diagram_theme", { projectId, themeId: "uplifted" });
    expect(set.body).toMatchObject({ projectId, theme: { themeId: "uplifted", source: "project" } });
    const restyle = await mcp.tool("set_diagram_theme", { projectId, themeId: "uplifted", restyle: true });
    expect(restyle).toMatchObject({ isError: true, body: { error: "invalid_argument" } });
    const both = await mcp.tool("set_diagram_theme", { projectId, diagramId: "x", themeId: null });
    expect(both).toMatchObject({ isError: true, body: { error: "invalid_argument" } });
    const cleared = await mcp.tool("set_diagram_theme", { projectId, themeId: null });
    expect(cleared.body.theme).toMatchObject({ themeId: "neutral", source: "default" });
  });

  it("refuses what the caller may not use or change", async () => {
    const { mcp, projectId } = await setup();
    const created = await mcp.tool("create_drawio", { projectId, title: "Flow", xml: PLAIN });
    const diagramId = created.body.diagramId as string;
    const doc = await mcp.tool("create_doc", { projectId, title: "Plan" });
    expect(
      (await mcp.tool("share_doc", { docId: doc.body.doc.docId, email: "guest@example.com", role: "editor" }))
        .isError,
    ).toBe(false);
    const other = await mcp.asUser("guest@example.com");

    // Another person's diagram: they cannot change it.
    const theirs = await other("set_diagram_theme", { diagramId, themeId: "uplifted", restyle: true });
    expect(theirs.isError).toBe(true);
    expect(["forbidden", "not_found"]).toContain(theirs.body.error);
    expect(await stored(mcp, diagramId)).toBe(PLAIN);

    // A project default is admin-only.
    const project = await other("set_diagram_theme", { projectId, themeId: "uplifted" });
    expect(project.isError).toBe(true);
    expect(["forbidden", "not_found"]).toContain(project.body.error);

    // Someone else's custom theme reads as not found, even on their own diagram.
    const hidden = await customTheme(mcp, "Owner only");
    const own = await other("create_drawio", { title: "Mine", xml: PLAIN });
    expect(own.isError).toBe(false);
    const borrowed = await other("set_diagram_theme", { diagramId: own.body.diagramId, themeId: hidden });
    expect(borrowed).toMatchObject({ isError: true, body: { error: "not_found" } });
  });
});
