import { describe, expect, it } from "vitest";

import {
  BUILT_IN_DIAGRAM_THEMES,
  DIAGRAM_THEME_ROLES,
  NEUTRAL_THEME,
  parseDiagramThemeName,
  parseDiagramThemeTokens,
  restyleDiagram,
  themeEdgeStyle,
  themeStyleGuide,
  themeToDrawioConfig,
  themeVertexStyle,
  UPLIFTED_THEME,
  type DiagramTheme,
} from "./diagramTheme.ts";
import { readDrawio } from "./drawioModel.ts";

const model = (cells: string, attributes = "") =>
  `<mxGraphModel${attributes}><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`;

const box = (id: string, style: string, value = id) =>
  `<mxCell id="${id}" value="${value}" style="${style}" vertex="1" parent="1"><mxGeometry x="10" y="20" width="140" height="60" as="geometry"/></mxCell>`;

const edge = (id: string, style: string, source = "a", target = "b") =>
  `<mxCell id="${id}" style="${style}" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry"/></mxCell>`;

/** The style of every cell, by id, read back from restyled XML. */
function styles(xml: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of xml.matchAll(/<mxCell id="([^"]+)"[^>]*?style="([^"]*)"/g)) {
    found[match[1]!] = match[2]!;
  }
  return found;
}

const keyOf = (style: string, key: string) =>
  style
    .split(";")
    .find((part) => part.startsWith(`${key}=`))
    ?.slice(key.length + 1);

async function restyled(xml: string, theme: DiagramTheme = UPLIFTED_THEME) {
  const result = await restyleDiagram(xml, theme);
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("built-in themes", () => {
  it("are valid token sets with stable ids", () => {
    expect(BUILT_IN_DIAGRAM_THEMES.map((theme) => theme.id)).toEqual(["neutral", "uplifted"]);
    for (const theme of BUILT_IN_DIAGRAM_THEMES) {
      const parsed = parseDiagramThemeTokens(JSON.parse(JSON.stringify(theme.tokens)));
      expect(parsed).toEqual({ ok: true, value: theme.tokens });
    }
  });

  it("gives Uplifted the brand blue as primary, Inter body and Montserrat titles", () => {
    expect(UPLIFTED_THEME.tokens.roles.primary.stroke).toBe("#4d79d8");
    expect(UPLIFTED_THEME.tokens.font).toEqual({
      family: "Inter",
      url: "https://fonts.googleapis.com/css?family=Inter",
    });
    expect(UPLIFTED_THEME.tokens.titleFont.family).toBe("Montserrat");
  });
});

describe("validating tokens", () => {
  const valid = () => JSON.parse(JSON.stringify(UPLIFTED_THEME.tokens));

  it("normalises colours and rounds sizes", () => {
    const input = valid();
    input.roles.primary.fill = "#ABC";
    input.strokeWidth = 1.3;
    const parsed = parseDiagramThemeTokens(input);
    expect(parsed.ok && parsed.value.roles.primary.fill).toBe("#aabbcc");
    expect(parsed.ok && parsed.value.strokeWidth).toBe(1.5);
  });

  it.each([
    ["a missing role", (t: any) => delete t.roles.danger, "roles.danger"],
    ["a named colour", (t: any) => (t.roles.primary.fill = "red"), "roles.primary"],
    ["a font with a semicolon", (t: any) => (t.font.family = "Inter;x=1"), "font.family"],
    ["a font url off Google Fonts", (t: any) => (t.font.url = "https://evil.test/a.css"), "font.url"],
    ["a size out of range", (t: any) => (t.fontSize = 72), "fontSize"],
    ["a radius below 0", (t: any) => (t.cornerRadius = -1), "cornerRadius"],
    ["an unknown edge style", (t: any) => (t.edgeStyle = "zigzag"), "edgeStyle"],
    ["an unknown arrow", (t: any) => (t.arrowHead = "none"), "arrowHead"],
    ["a shadow that is not a boolean", (t: any) => (t.shadow = "yes"), "shadow"],
    ["an unknown default role", (t: any) => (t.defaultRole = "brand"), "defaultRole"],
  ])("refuses %s", (_name, change, field) => {
    const input = valid();
    change(input);
    const parsed = parseDiagramThemeTokens(input);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain(field);
  });

  it("checks names", () => {
    expect(parseDiagramThemeName("  Client   blue ")).toEqual({ ok: true, value: "Client blue" });
    expect(parseDiagramThemeName("").ok).toBe(false);
    expect(parseDiagramThemeName("x".repeat(81)).ok).toBe(false);
  });
});

describe("themeToDrawioConfig", () => {
  it("gives the editor the theme's defaults, swatches and fonts", () => {
    const config = themeToDrawioConfig(UPLIFTED_THEME);
    expect(config.defaultVertexStyle).toMatchObject({
      fillColor: "#dbe5f7",
      strokeColor: "#4d79d8",
      fontColor: "#14131b",
      fontFamily: "Inter",
      fontSource: encodeURIComponent("https://fonts.googleapis.com/css?family=Inter"),
      fontSize: "14",
      rounded: "1",
      absoluteArcSize: "1",
      arcSize: "20",
      strokeWidth: "1.5",
    });
    expect(config.defaultEdgeStyle).toMatchObject({
      edgeStyle: "orthogonalEdgeStyle",
      endArrow: "block",
      strokeColor: "#5f6470",
    });
    expect(config.customColorSchemes).toHaveLength(1);
    expect(config.customColorSchemes[0]).toHaveLength(DIAGRAM_THEME_ROLES.length);
    expect(config.customColorSchemes[0]![0]).toEqual(UPLIFTED_THEME.tokens.roles.primary);
    expect(config.customFonts).toEqual([
      { fontFamily: "Inter", fontUrl: "https://fonts.googleapis.com/css?family=Inter" },
      { fontFamily: "Montserrat", fontUrl: "https://fonts.googleapis.com/css?family=Montserrat" },
    ]);
  });

  it("lists a web-safe font once, by name", () => {
    expect(themeToDrawioConfig(NEUTRAL_THEME).customFonts).toEqual(["Helvetica"]);
    expect(themeToDrawioConfig(NEUTRAL_THEME).defaultVertexStyle.fontSource).toBeUndefined();
  });
});

describe("themeStyleGuide", () => {
  it("names each role with its exact style string", () => {
    const lines = themeStyleGuide(UPLIFTED_THEME);
    expect(lines).toContain(`primary box: ${themeVertexStyle(UPLIFTED_THEME, "primary")}`);
    expect(lines).toContain(`connection: ${themeEdgeStyle(UPLIFTED_THEME)}`);
    expect(lines.every((line) => line.length < 400)).toBe(true);
  });

  it("writes styles that restyling leaves as they are", async () => {
    const xml = model(
      DIAGRAM_THEME_ROLES.map((role) => box(role, themeVertexStyle(UPLIFTED_THEME, role))).join(
        "",
      ) + edge("e", themeEdgeStyle(UPLIFTED_THEME), "primary", "danger"),
    );
    const result = await restyled(xml);
    expect(result.summary.changed).toBe(0);
    expect(result.xml).toBe(xml);
  });
});

describe("restyleDiagram", () => {
  const neutralFlow = model(
    box("a", "rounded=1;whiteSpace=wrap;html=1;") +
      box("b", "rhombus;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;") +
      box("c", "whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;myKey=keep;") +
      box("t", "text;html=1;align=center;", "Words") +
      box("i", "shape=image;image=https://example.com/a.png;") +
      `<mxCell id="s" value="Lane" style="swimlane;startSize=30;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1"><mxGeometry x="300" y="0" width="200" height="200" as="geometry"/></mxCell>` +
      edge("e1", "edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;") +
      edge("e2", "endArrow=none;html=1;", "b", "c") +
      `<mxCell id="l" value="yes" style="edgeLabel;html=1;" vertex="1" connectable="0" parent="e1"><mxGeometry x="-0.2" relative="1" as="geometry"><mxPoint as="offset"/></mxGeometry></mxCell>`,
  );

  it("maps each box to its nearest role and keeps ids, geometry and labels", async () => {
    const result = await restyled(neutralFlow);
    const after = styles(result.xml);
    // No colour: the default role.
    expect(keyOf(after.a!, "fillColor")).toBe("#dbe5f7");
    expect(keyOf(after.b!, "fillColor")).toBe("#dcf0e4");
    expect(keyOf(after.b!, "strokeColor")).toBe("#217f52");
    expect(keyOf(after.c!, "fillColor")).toBe("#fadbdb");
    expect(keyOf(after.c!, "fontFamily")).toBe("Inter");
    expect(keyOf(after.c!, "myKey")).toBe("keep");
    // The rhombus keeps its shape and is not given box corners.
    expect(after.b!.startsWith("rhombus;")).toBe(true);
    expect(keyOf(after.b!, "absoluteArcSize")).toBeUndefined();
    expect(keyOf(after.a!, "arcSize")).toBe("20");

    const before = await readDrawio(neutralFlow);
    const now = await readDrawio(result.xml);
    expect(now).toEqual(before);
    expect(result.xml.match(/<mxGeometry[^>]*>/g)).toEqual(neutralFlow.match(/<mxGeometry[^>]*>/g));
    expect(result.summary).toMatchObject({
      pages: 1,
      shapes: 3,
      containers: 1,
      connections: 2,
      labels: 1,
      texts: 1,
      images: 1,
    });
    expect(result.summary.roles).toMatchObject({ primary: 2, success: 1, danger: 1 });
  });

  it("styles text, pictures, containers, connections and their labels sensibly", async () => {
    const after = styles((await restyled(neutralFlow)).xml);
    expect(keyOf(after.t!, "fillColor")).toBeUndefined();
    expect(keyOf(after.t!, "fontColor")).toBe("#14131b");
    expect(keyOf(after.i!, "fillColor")).toBeUndefined();
    expect(keyOf(after.i!, "image")).toBe("https://example.com/a.png");
    expect(keyOf(after.s!, "fontFamily")).toBe("Montserrat");
    expect(keyOf(after.s!, "fillColor")).toBe("#dbe5f7");
    expect(keyOf(after.s!, "startSize")).toBe("30");
    expect(keyOf(after.e1!, "endArrow")).toBe("block");
    expect(keyOf(after.e1!, "strokeColor")).toBe("#5f6470");
    // A plain line keeps no arrowhead.
    expect(keyOf(after.e2!, "endArrow")).toBe("none");
    expect(keyOf(after.e2!, "edgeStyle")).toBe("orthogonalEdgeStyle");
    expect(keyOf(after.l!, "fontFamily")).toBe("Inter");
    expect(keyOf(after.l!, "fillColor")).toBeUndefined();
  });

  it("maps a custom theme's roles to the target's roles when it is known", async () => {
    const orange: DiagramTheme = {
      ...UPLIFTED_THEME,
      id: "orange",
      name: "Orange",
      builtIn: false,
      tokens: {
        ...UPLIFTED_THEME.tokens,
        roles: {
          ...UPLIFTED_THEME.tokens.roles,
          primary: { fill: "#ffe1c2", stroke: "#e8701a", font: "#14131b" },
        },
      },
    };
    const xml = model(box("a", "rounded=1;html=1;fillColor=#ffe1c2;strokeColor=#e8701a;"));
    const unknown = styles((await restyled(xml, NEUTRAL_THEME)).xml);
    expect(keyOf(unknown.a!, "fillColor")).not.toBe("#dae8fc");
    const result = await restyleDiagram(xml, NEUTRAL_THEME, { knownThemes: [orange] });
    if (!result.ok) throw new Error(result.error);
    expect(keyOf(styles(result.xml).a!, "fillColor")).toBe("#dae8fc");
    expect(result.summary.roles.primary).toBe(1);
  });

  it("keeps a special connection router and restyles only plain ones", async () => {
    const xml = model(
      box("a", "rounded=0;whiteSpace=wrap;html=1;") +
        box("b", "rounded=0;whiteSpace=wrap;html=1;") +
        edge("er", "edgeStyle=entityRelationEdgeStyle;rounded=0;html=1;endArrow=ERmany;") +
        edge("el", "edgeStyle=elbowEdgeStyle;elbow=vertical;html=1;") +
        edge("plain", "html=1;"),
    );
    const curvy: DiagramTheme = {
      ...UPLIFTED_THEME,
      tokens: { ...UPLIFTED_THEME.tokens, edgeStyle: "curved" },
    };
    const after = styles((await restyled(xml, curvy)).xml);
    expect(keyOf(after.er!, "edgeStyle")).toBe("entityRelationEdgeStyle");
    expect(keyOf(after.er!, "rounded")).toBe("0");
    expect(keyOf(after.er!, "curved")).toBeUndefined();
    expect(keyOf(after.er!, "strokeColor")).toBe("#5f6470");
    expect(keyOf(after.el!, "edgeStyle")).toBe("elbowEdgeStyle");
    expect(keyOf(after.el!, "elbow")).toBe("vertical");
    expect(keyOf(after.plain!, "edgeStyle")).toBe("orthogonalEdgeStyle");
    expect(keyOf(after.plain!, "curved")).toBe("1");
  });

  it("changes nothing on a second run", async () => {
    const once = await restyled(neutralFlow);
    const twice = await restyled(once.xml);
    expect(twice.xml).toBe(once.xml);
    expect(twice.summary.changed).toBe(0);
  });

  it("changes nothing on a second run when a theme has a white role", async () => {
    const white: DiagramTheme = {
      ...UPLIFTED_THEME,
      tokens: {
        ...UPLIFTED_THEME.tokens,
        roles: {
          ...UPLIFTED_THEME.tokens.roles,
          secondary: { fill: "#ffffff", stroke: "#6b8bc4", font: "#14131b" },
        },
      },
    };
    const once = await restyled(model(box("w", "fillColor=#e1d5e7;strokeColor=#9673a6;")), white);
    expect(keyOf(styles(once.xml).w!, "fillColor")).toBe("#ffffff");
    const twice = await restyled(once.xml, white);
    expect(twice.summary.changed).toBe(0);
    expect(twice.xml).toBe(once.xml);
  });

  it("goes back to Neutral and keeps the roles", async () => {
    const uplifted = await restyled(neutralFlow);
    const back = styles((await restyled(uplifted.xml, NEUTRAL_THEME)).xml);
    expect(keyOf(back.b!, "fillColor")).toBe("#d5e8d4");
    expect(keyOf(back.c!, "fillColor")).toBe("#f8cecc");
    expect(keyOf(back.a!, "fillColor")).toBe("#dae8fc");
  });

  it("maps colours from no theme to the role of the nearest hue", async () => {
    const after = styles(
      (
        await restyled(
          model(
            box("r", "fillColor=#ff9999;strokeColor=#cc0000;") +
              box("g", "fillColor=#ccffcc;strokeColor=#009900;") +
              box("y", "fillColor=#ffff88;strokeColor=#999900;") +
              box("grey", "fillColor=#eeeeee;strokeColor=#888888;") +
              box("lined", "fillColor=none;strokeColor=#0000ff;"),
          ),
        )
      ).xml,
    );
    expect(keyOf(after.r!, "fillColor")).toBe("#fadbdb");
    expect(keyOf(after.g!, "fillColor")).toBe("#dcf0e4");
    expect(keyOf(after.y!, "fillColor")).toBe("#fcefd3");
    expect(keyOf(after.grey!, "fillColor")).toBe("#eff1f5");
    expect(keyOf(after.lined!, "fillColor")).toBe("none");
    expect(["#4d79d8", "#6b8bc4", "#33559f"]).toContain(keyOf(after.lined!, "strokeColor"));
  });

  it("keeps a heading's own size and sets the body size", async () => {
    const after = styles(
      (await restyled(model(box("h", "text;html=1;fontSize=24;") + box("p", "html=1;fontSize=11;"))))
        .xml,
    );
    expect(keyOf(after.h!, "fontSize")).toBe("24");
    expect(keyOf(after.p!, "fontSize")).toBe("14");
  });

  it("restyles every page of an mxfile, including a compressed one", async () => {
    const page2 = model(box("x", "fillColor=#fff2cc;strokeColor=#d6b656;"));
    const compressed = await deflate(page2);
    const file =
      `<mxfile host="test"><diagram name="One" id="p1">${neutralFlow}</diagram>` +
      `<diagram name="Two" id="p2">${compressed}</diagram></mxfile>`;
    const result = await restyled(file);
    expect(result.summary.pages).toBe(2);
    expect(result.xml).toContain('<diagram name="Two" id="p2"><mxGraphModel>');
    expect(keyOf(styles(result.xml).x!, "fillColor")).toBe("#fcefd3");
    const pages = await readDrawio(result.xml);
    expect(pages.ok && pages.pages.map((page) => page.name)).toEqual(["One", "Two"]);
    expect((await restyled(result.xml)).summary.changed).toBe(0);
  });

  it("leaves an unreadable page as it is and counts it", async () => {
    const file = `<mxfile><diagram name="Bad">not-base64!</diagram><diagram name="Ok">${neutralFlow}</diagram></mxfile>`;
    const result = await restyled(file);
    expect(result.summary).toMatchObject({ pages: 1, unreadablePages: 1 });
    expect(result.xml).toContain('<diagram name="Bad">not-base64!</diagram>');
  });

  it("sets a non-white canvas background on the model", async () => {
    const dark: DiagramTheme = {
      ...UPLIFTED_THEME,
      tokens: { ...UPLIFTED_THEME.tokens, canvas: { background: "#101010", text: "#ffffff" } },
    };
    expect((await restyled(neutralFlow, dark)).xml).toMatch(/^<mxGraphModel background="#101010">/);
    expect((await restyled(neutralFlow)).xml).toMatch(/^<mxGraphModel>/);
  });

  it("refuses XML Draw.io cannot open", async () => {
    expect((await restyleDiagram("<mxGraphModel>", UPLIFTED_THEME)).ok).toBe(false);
  });

  it("keeps a wrapped cell's object and escapes what it writes", async () => {
    const xml = model(
      `<object label="A &amp; B" id="o" owner="me"><mxCell style="fillColor=#dae8fc;" vertex="1" parent="1"><mxGeometry width="80" height="40" as="geometry"/></mxCell></object>`,
    );
    const result = await restyled(xml);
    expect(result.xml).toContain('<object label="A &amp; B" id="o" owner="me">');
    expect(result.xml).toContain("fontSource=https%3A%2F%2Ffonts.googleapis.com");
    expect(result.summary.changed).toBe(1);
  });
});

async function deflate(text: string): Promise<string> {
  const stream = new Blob([encodeURIComponent(text)])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return Buffer.from(bytes).toString("base64");
}
