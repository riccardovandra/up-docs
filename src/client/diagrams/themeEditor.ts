// The Settings theme editor without the DOM: a draft a person edits field by
// field, its check against the server's rules, names for copies, and the
// sample diagram the live preview restyles and draws.

import {
  NEUTRAL_THEME,
  parseDiagramThemeName,
  parseDiagramThemeTokens,
  UPLIFTED_THEME,
  type DiagramFont,
  type DiagramTheme,
  type DiagramThemeInput,
  type DiagramThemeRole,
  type DiagramThemeTokens,
  type RestyleSummary,
} from "../../shared/diagramTheme.ts";

/** Fonts every browser and Draw.io draw without loading anything. */
export const WEB_SAFE_FONTS = [
  "Helvetica",
  "Arial",
  "Verdana",
  "Tahoma",
  "Trebuchet MS",
  "Georgia",
  "Times New Roman",
  "Garamond",
  "Courier New",
] as const;

/** A theme being edited: the name and tokens as typed, checked only on save. */
export interface ThemeDraft {
  readonly name: string;
  readonly tokens: DiagramThemeTokens;
}

export const draftOf = (theme: Pick<DiagramTheme, "name" | "tokens">): ThemeDraft => ({
  name: theme.name,
  tokens: theme.tokens,
});

/** A new theme starts as Neutral, under a name not taken yet. */
export const blankDraft = (taken: ReadonlyArray<string>): ThemeDraft => ({
  name: freeName("New theme", taken),
  tokens: NEUTRAL_THEME.tokens,
});

/** A copy of `theme`, named "<name> copy" (then "copy 2", ...) so it reads apart from it. */
export const duplicateDraft = (theme: DiagramTheme, taken: ReadonlyArray<string>): ThemeDraft => ({
  name: freeName(`${theme.name} copy`, taken),
  tokens: theme.tokens,
});

function freeName(base: string, taken: ReadonlyArray<string>): string {
  const names = new Set(taken.map((name) => name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const name = `${base} ${n}`;
    if (!names.has(name.toLowerCase())) return name;
  }
}

export const setName = (draft: ThemeDraft, name: string): ThemeDraft => ({ ...draft, name });

export const setRoleColour = (
  draft: ThemeDraft,
  role: DiagramThemeRole,
  part: "fill" | "stroke" | "font",
  value: string,
): ThemeDraft => ({
  ...draft,
  tokens: {
    ...draft.tokens,
    roles: { ...draft.tokens.roles, [role]: { ...draft.tokens.roles[role], [part]: value } },
  },
});

export const setCanvas = (
  draft: ThemeDraft,
  part: "background" | "text",
  value: string,
): ThemeDraft => ({
  ...draft,
  tokens: { ...draft.tokens, canvas: { ...draft.tokens.canvas, [part]: value } },
});

type PlainToken =
  | "defaultRole"
  | "fontSize"
  | "cornerRadius"
  | "strokeWidth"
  | "edgeStyle"
  | "arrowHead"
  | "shadow";

export const setToken = <K extends PlainToken>(
  draft: ThemeDraft,
  key: K,
  value: DiagramThemeTokens[K],
): ThemeDraft => ({ ...draft, tokens: { ...draft.tokens, [key]: value } });

/** The Google Fonts css URL Draw.io loads a family from. */
export const googleFontUrl = (family: string) =>
  `https://fonts.googleapis.com/css?family=${family.trim().replace(/ +/g, "+")}`;

/** A font as the editor offers it: a family, and whether it comes from Google Fonts. */
export const fontOf = (family: string, google: boolean): DiagramFont => ({
  family: family.trim(),
  url: google ? googleFontUrl(family) : null,
});

export const setFont = (
  draft: ThemeDraft,
  which: "font" | "titleFont",
  font: DiagramFont,
): ThemeDraft => ({ ...draft, tokens: { ...draft.tokens, [which]: font } });

export type DraftCheck =
  | { readonly ok: true; readonly value: DiagramThemeInput }
  | { readonly ok: false; readonly error: string };

/** The draft as the server would take it, or the first rule it breaks, in words. */
export function checkDraft(draft: ThemeDraft): DraftCheck {
  const name = parseDiagramThemeName(draft.name);
  if (!name.ok) return { ok: false, error: "Give the theme a name, up to 80 characters." };
  const tokens = parseDiagramThemeTokens(draft.tokens);
  if (!tokens.ok) return { ok: false, error: tokens.error };
  return { ok: true, value: { name: name.value, tokens: tokens.value } };
}

/** Whether the draft differs from what was saved, once both are checked. */
export function isChanged(draft: ThemeDraft, saved: ThemeDraft): boolean {
  return JSON.stringify(draft) !== JSON.stringify(saved);
}

/** "#rrggbb" for a colour input, from whatever is typed; black when it is not a colour yet. */
export const colourInputValue = (value: string) =>
  /^#[0-9a-fA-F]{6}$/.test(value)
    ? value.toLowerCase()
    : /^#[0-9a-fA-F]{3}$/.test(value)
      ? `#${[...value.slice(1).toLowerCase()].map((digit) => digit + digit).join("")}`
      : "#000000";

// ---------------------------------------------------------------- sample diagram

const ROLE_LABELS: Readonly<Record<DiagramThemeRole, string>> = {
  primary: "Primary",
  secondary: "Secondary",
  accent: "Accent",
  neutral: "Neutral",
  success: "Success",
  warning: "Warning",
  danger: "Danger",
};

/**
 * The colours each sample box is drawn in before restyling: a built-in's exact
 * role colours, so the restyle maps every box to its own role in any theme.
 * Neutral's own neutral is white, which restyling reads as "no colour", so the
 * neutral box takes Uplifted's grey instead.
 */
const sampleColours = (role: DiagramThemeRole) =>
  role === "neutral" ? UPLIFTED_THEME.tokens.roles.neutral : NEUTRAL_THEME.tokens.roles[role];

const sampleBox = (
  role: DiagramThemeRole,
  geometry: readonly [number, number, number, number],
  parent = "1",
) => {
  const { fill, stroke } = sampleColours(role);
  const [x, y, width, height] = geometry;
  return (
    `<mxCell id="${role}" value="${ROLE_LABELS[role]}" style="rounded=0;whiteSpace=wrap;html=1;` +
    `fillColor=${fill};strokeColor=${stroke};" vertex="1" parent="${parent}">` +
    `<mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry"/></mxCell>`
  );
};

const sampleEdge = (id: string, source: string, target: string, label = "") =>
  `<mxCell id="${id}" value="${label}" style="html=1;endArrow=classic;" edge="1" parent="1" ` +
  `source="${source}" target="${target}"><mxGeometry relative="1" as="geometry"/></mxCell>`;

/** A container with three boxes, four more boxes outside it, and arrows, one with a label. */
export const THEME_SAMPLE_XML =
  '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="team" value="Container" style="swimlane;startSize=30;whiteSpace=wrap;html=1;' +
  `fillColor=${NEUTRAL_THEME.tokens.roles.primary.fill};strokeColor=${NEUTRAL_THEME.tokens.roles.primary.stroke};" ` +
  'vertex="1" parent="1"><mxGeometry x="20" y="20" width="280" height="180" as="geometry"/></mxCell>' +
  sampleBox("primary", [20, 50, 110, 44], "team") +
  sampleBox("secondary", [150, 50, 110, 44], "team") +
  sampleBox("neutral", [20, 116, 110, 44], "team") +
  sampleBox("accent", [360, 60, 120, 48]) +
  sampleBox("success", [360, 140, 120, 48]) +
  sampleBox("warning", [540, 60, 110, 48]) +
  sampleBox("danger", [540, 140, 110, 48]) +
  sampleEdge("e1", "primary", "secondary") +
  sampleEdge("e2", "secondary", "accent", "calls") +
  sampleEdge("e3", "accent", "warning") +
  sampleEdge("e4", "accent", "success", "ok") +
  sampleEdge("e5", "warning", "danger") +
  "</root></mxGraphModel>";

export const SAMPLE_SIZE = { width: 670, height: 220 } as const;

// ---------------------------------------------------------------- preview model

export interface PreviewBox {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fill: string;
  readonly stroke: string;
  readonly fontColor: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly radius: number;
  readonly strokeWidth: number;
  readonly shadow: boolean;
  /** A container: its header is `header` px tall, in bold. */
  readonly header: number | null;
}

export interface PreviewEdge {
  readonly id: string;
  readonly label: string;
  /** SVG path data from the source box's side to the target's. */
  readonly path: string;
  readonly labelAt: { readonly x: number; readonly y: number };
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly fontColor: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly arrow: string;
}

export interface PreviewModel {
  readonly background: string;
  readonly boxes: ReadonlyArray<PreviewBox>;
  readonly edges: ReadonlyArray<PreviewEdge>;
}

const decode = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

const attributesOf = (source: string): Map<string, string> =>
  new Map([...source.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)].map((m) => [m[1]!, decode(m[2]!)]));

const styleOf = (style: string): Map<string, string> =>
  new Map(
    style
      .split(";")
      .filter((part) => part.includes("="))
      .map((part) => [part.slice(0, part.indexOf("=")), part.slice(part.indexOf("=") + 1)]),
  );

const num = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
};

const colour = (value: string | undefined, fallback: string) =>
  value === undefined || value === "none" ? fallback : value;

interface Point {
  readonly x: number;
  readonly y: number;
}

/** A path from the side of `a` facing `b` to the side of `b` facing `a`. */
function route(a: PreviewBox, b: PreviewBox, edgeStyle: string, curved: boolean) {
  const ca = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const cb = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const horizontal = Math.abs(cb.x - ca.x) - (a.width + b.width) / 2 > 0;
  const start: Point = horizontal
    ? { x: cb.x > ca.x ? a.x + a.width : a.x, y: ca.y }
    : { x: ca.x, y: cb.y > ca.y ? a.y + a.height : a.y };
  const end: Point = horizontal
    ? { x: cb.x > ca.x ? b.x : b.x + b.width, y: cb.y }
    : { x: cb.x, y: cb.y > ca.y ? b.y : b.y + b.height };
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  if (edgeStyle === "none" || edgeStyle === "") {
    return { path: `M${start.x},${start.y} L${end.x},${end.y}`, mid };
  }
  if (curved) {
    const c1 = horizontal ? { x: mid.x, y: start.y } : { x: start.x, y: mid.y };
    const c2 = horizontal ? { x: mid.x, y: end.y } : { x: end.x, y: mid.y };
    return { path: `M${start.x},${start.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`, mid };
  }
  const path = horizontal
    ? `M${start.x},${start.y} H${mid.x} V${end.y} H${end.x}`
    : `M${start.x},${start.y} V${mid.y} H${end.x} V${end.y}`;
  return { path, mid };
}

/**
 * Reads the restyled sample back into boxes and arrows the preview draws: the
 * colours, fonts, corners, line widths, routing and arrowheads restyling wrote.
 * Made for `THEME_SAMPLE_XML`, not for any diagram.
 */
export function previewModel(xml: string): PreviewModel {
  const cells = [...xml.matchAll(/<mxCell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)/g)].map(
    (match) => {
      const attributes = attributesOf(match[1]!);
      const geometry = attributesOf(/<mxGeometry\b([^>]*)/.exec(match[2] ?? "")?.[1] ?? "");
      return { attributes, geometry, style: styleOf(attributes.get("style") ?? "") };
    },
  );
  const boxes = new Map<string, PreviewBox>();
  for (const { attributes, geometry, style } of cells) {
    if (attributes.get("vertex") !== "1") continue;
    const parent = boxes.get(attributes.get("parent") ?? "");
    const container = (attributes.get("style") ?? "").startsWith("swimlane");
    const rounded = style.get("rounded") === "1";
    const id = attributes.get("id")!;
    boxes.set(id, {
      id,
      label: attributes.get("value") ?? "",
      x: num(geometry.get("x"), 0) + (parent?.x ?? 0),
      y: num(geometry.get("y"), 0) + (parent?.y ?? 0),
      width: num(geometry.get("width"), 0),
      height: num(geometry.get("height"), 0),
      fill: colour(style.get("fillColor"), "#ffffff"),
      stroke: colour(style.get("strokeColor"), "#000000"),
      fontColor: colour(style.get("fontColor"), "#000000"),
      fontFamily: style.get("fontFamily") ?? "Helvetica",
      fontSize: num(style.get("fontSize"), 12),
      radius: rounded ? num(style.get("arcSize"), 0) / 2 : 0,
      strokeWidth: num(style.get("strokeWidth"), 1),
      shadow: style.get("shadow") === "1",
      header: container ? num(style.get("startSize"), 30) : null,
    });
  }
  const edges: Array<PreviewEdge> = [];
  for (const { attributes, style } of cells) {
    if (attributes.get("edge") !== "1") continue;
    const from = boxes.get(attributes.get("source") ?? "");
    const to = boxes.get(attributes.get("target") ?? "");
    if (!from || !to) continue;
    const { path, mid } = route(from, to, style.get("edgeStyle") ?? "", style.get("curved") === "1");
    edges.push({
      id: attributes.get("id")!,
      label: attributes.get("value") ?? "",
      path,
      labelAt: mid,
      stroke: colour(style.get("strokeColor"), "#000000"),
      strokeWidth: num(style.get("strokeWidth"), 1),
      fontColor: colour(style.get("fontColor"), "#000000"),
      fontFamily: style.get("fontFamily") ?? "Helvetica",
      fontSize: num(style.get("fontSize"), 11),
      arrow: style.get("endArrow") ?? "classic",
    });
  }
  const background = /<mxGraphModel\b[^>]*\bbackground="([^"]*)"/.exec(xml)?.[1] ?? "#ffffff";
  return { background: colour(background, "#ffffff"), boxes: [...boxes.values()], edges };
}

/** The Google font css URLs a theme's text needs, for the page to load before drawing. */
export const themeFontUrls = (tokens: DiagramThemeTokens): ReadonlyArray<string> =>
  [...new Set([tokens.font.url, tokens.titleFont.url])].filter(
    (url): url is string => url !== null,
  );

// ---------------------------------------------------------------- restyle summary

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "12 boxes, 5 arrows ... changed" from a restyle summary; says so when nothing would change. */
export function describeRestyle(summary: RestyleSummary): string {
  if (summary.changed === 0) return "Already in this theme: nothing would change.";
  const parts = [
    summary.shapes > 0 ? `${summary.shapes} ${summary.shapes === 1 ? "box" : "boxes"}` : null,
    summary.containers > 0 ? plural(summary.containers, "container") : null,
    summary.connections > 0 ? plural(summary.connections, "arrow") : null,
    summary.labels + summary.texts > 0 ? plural(summary.labels + summary.texts, "label") : null,
    summary.images > 0 ? plural(summary.images, "picture") : null,
  ].filter((part): part is string => part !== null);
  const pages = summary.pages > 1 ? ` on ${plural(summary.pages, "page")}` : "";
  const unreadable =
    summary.unreadablePages > 0
      ? ` ${plural(summary.unreadablePages, "page")} could not be read and stays as it is.`
      : "";
  return `${parts.join(", ")}${pages}: ${plural(summary.changed, "item")} change.${unreadable}`;
}

export const ROLE_NAMES = ROLE_LABELS;
