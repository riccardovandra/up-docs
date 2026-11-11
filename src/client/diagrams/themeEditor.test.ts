import { describe, expect, it } from "vitest";

import {
  DIAGRAM_THEME_ROLES,
  NEUTRAL_THEME,
  restyleDiagram,
  UPLIFTED_THEME,
  type DiagramTheme,
} from "../../shared/diagramTheme.ts";
import {
  blankDraft,
  checkDraft,
  colourInputValue,
  describeRestyle,
  draftOf,
  duplicateDraft,
  fontOf,
  isChanged,
  previewModel,
  setFont,
  setRoleColour,
  setToken,
  THEME_SAMPLE_XML,
  themeFontUrls,
} from "./themeEditor.ts";

async function preview(theme: DiagramTheme) {
  const result = await restyleDiagram(THEME_SAMPLE_XML, theme);
  if (!result.ok) throw new Error(result.error);
  return previewModel(result.xml);
}

describe("theme drafts", () => {
  it("names copies and new themes apart from the ones there", () => {
    expect(duplicateDraft(UPLIFTED_THEME, ["Neutral", "Uplifted"]).name).toBe("Uplifted copy");
    expect(duplicateDraft(UPLIFTED_THEME, ["Uplifted copy", "uplifted copy 2"]).name).toBe(
      "Uplifted copy 3",
    );
    expect(blankDraft(["New theme"]).name).toBe("New theme 2");
    expect(duplicateDraft(UPLIFTED_THEME, []).tokens).toEqual(UPLIFTED_THEME.tokens);
  });

  it("checks a draft against the server's rules and normalises it", () => {
    const draft = setRoleColour(duplicateDraft(UPLIFTED_THEME, []), "primary", "fill", "#ABC");
    const checked = checkDraft(draft);
    expect(checked.ok && checked.value.tokens.roles.primary.fill).toBe("#aabbcc");
    expect(checkDraft({ ...draft, name: "   " })).toMatchObject({ ok: false });
    const bad = checkDraft(setRoleColour(draft, "danger", "stroke", "red"));
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining("roles.danger") });
    const big = checkDraft(setToken(draft, "fontSize", 99));
    expect(big).toMatchObject({ ok: false, error: expect.stringContaining("fontSize") });
    const empty = checkDraft(setToken(draft, "cornerRadius", Number.NaN));
    expect(empty).toMatchObject({ ok: false, error: expect.stringContaining("cornerRadius") });
  });

  it("builds Google font URLs the server accepts, and web-safe fonts without one", () => {
    const font = fontOf(" Open Sans ", true);
    expect(font).toEqual({
      family: "Open Sans",
      url: "https://fonts.googleapis.com/css?family=Open+Sans",
    });
    const draft = setFont(draftOf(NEUTRAL_THEME), "titleFont", font);
    expect(checkDraft(draft).ok).toBe(true);
    expect(fontOf("Georgia", false).url).toBeNull();
    expect(checkDraft(setFont(draft, "font", fontOf("Bad;Font", true))).ok).toBe(false);
    expect(themeFontUrls(UPLIFTED_THEME.tokens)).toHaveLength(2);
    expect(themeFontUrls(NEUTRAL_THEME.tokens)).toEqual([]);
  });

  it("tells a changed draft from the saved one", () => {
    const saved = draftOf(UPLIFTED_THEME);
    expect(isChanged(saved, draftOf(UPLIFTED_THEME))).toBe(false);
    expect(isChanged(setToken(saved, "shadow", true), saved)).toBe(true);
  });

  it("gives the colour input a full hex while the text is half typed", () => {
    expect(colourInputValue("#4D79D8")).toBe("#4d79d8");
    expect(colourInputValue("#abc")).toBe("#aabbcc");
    expect(colourInputValue("#4d7")).toBe("#44dd77");
    expect(colourInputValue("#4d79")).toBe("#000000");
  });
});

describe("the live preview", () => {
  it("draws every role in the theme's own colours, in any theme", async () => {
    for (const theme of [NEUTRAL_THEME, UPLIFTED_THEME]) {
      const model = await preview(theme);
      for (const role of DIAGRAM_THEME_ROLES) {
        const box = model.boxes.find((each) => each.id === role)!;
        expect(box.fill).toBe(theme.tokens.roles[role].fill);
        expect(box.stroke).toBe(theme.tokens.roles[role].stroke);
        expect(box.fontColor).toBe(theme.tokens.roles[role].font);
      }
    }
  });

  it("follows fonts, corners, lines, routing and arrowheads", async () => {
    const custom: DiagramTheme = {
      ...UPLIFTED_THEME,
      id: "c1",
      builtIn: false,
      tokens: {
        ...UPLIFTED_THEME.tokens,
        cornerRadius: 4,
        strokeWidth: 3,
        edgeStyle: "curved",
        arrowHead: "open",
        shadow: true,
      },
    };
    const model = await preview(custom);
    const container = model.boxes.find((box) => box.id === "team")!;
    expect(container.header).toBe(30);
    expect(container.fontFamily).toBe("Montserrat");
    const primary = model.boxes.find((box) => box.id === "primary")!;
    expect(primary).toMatchObject({ radius: 4, strokeWidth: 3, shadow: true, fontFamily: "Inter" });
    // Inside the container: placed relative to it.
    expect(primary.x).toBe(container.x + 20);
    expect(model.edges).toHaveLength(5);
    expect(model.edges[0]).toMatchObject({ arrow: "open", strokeWidth: 3 });
    expect(model.edges.every((edge) => edge.path.includes("C"))).toBe(true);
    expect(model.edges.find((edge) => edge.id === "e2")!.label).toBe("calls");
    const straight = await preview({
      ...custom,
      tokens: { ...custom.tokens, edgeStyle: "straight" },
    });
    expect(straight.edges.every((edge) => /^M[\d.,]+ L[\d.,]+$/.test(edge.path))).toBe(true);
  });

  it("paints the canvas background a theme sets", async () => {
    const dark: DiagramTheme = {
      ...NEUTRAL_THEME,
      tokens: { ...NEUTRAL_THEME.tokens, canvas: { background: "#101418", text: "#eeeeee" } },
    };
    expect((await preview(dark)).background).toBe("#101418");
    expect((await preview(NEUTRAL_THEME)).background).toBe("#ffffff");
  });
});

describe("describeRestyle", () => {
  const base = {
    pages: 1,
    unreadablePages: 0,
    changed: 17,
    shapes: 12,
    containers: 0,
    connections: 5,
    labels: 0,
    texts: 0,
    images: 0,
    roles: Object.fromEntries(DIAGRAM_THEME_ROLES.map((role) => [role, 0])) as never,
  };
  it("says what the restyle touches", () => {
    expect(describeRestyle(base)).toBe("12 boxes, 5 arrows: 17 items change.");
    expect(describeRestyle({ ...base, changed: 0 })).toMatch(/nothing would change/);
    expect(describeRestyle({ ...base, pages: 2, unreadablePages: 1, shapes: 1 })).toBe(
      "1 box, 5 arrows on 2 pages: 17 items change. 1 page could not be read and stays as it is.",
    );
  });
});
