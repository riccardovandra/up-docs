// Diagram themes: a named set of colours, fonts and box and arrow styles that
// makes Draw.io diagrams look consistent. Pure and shared: the Worker stores
// and resolves themes, the browser hands one to the Draw.io editor as its
// defaults, and both can restyle an existing diagram to a theme.
//
// A diagram's effective theme is its own theme, else its project's default,
// else Neutral. Built-in themes live here, in code; custom ones are rows.

import { rewriteDrawio, type DrawioCellTarget } from "./drawioModel.ts";

/** The colour roles of a theme, in the order the editor shows them as swatches. */
export const DIAGRAM_THEME_ROLES = [
  "primary",
  "secondary",
  "accent",
  "neutral",
  "success",
  "warning",
  "danger",
] as const;
export type DiagramThemeRole = (typeof DIAGRAM_THEME_ROLES)[number];

export const DIAGRAM_EDGE_STYLES = ["orthogonal", "curved", "straight"] as const;
export type DiagramEdgeStyle = (typeof DIAGRAM_EDGE_STYLES)[number];

/** Draw.io arrowhead names. A connection drawn with no arrowhead keeps none. */
export const DIAGRAM_ARROW_HEADS = ["block", "classic", "open", "blockThin", "oval"] as const;
export type DiagramArrowHead = (typeof DIAGRAM_ARROW_HEADS)[number];

/** One role's colours, each "#rrggbb" in lower case. */
export interface DiagramRoleColours {
  readonly fill: string;
  readonly stroke: string;
  readonly font: string;
}

/**
 * A font Draw.io can draw with: a web-safe family, or a Google Fonts family
 * with the css URL Draw.io loads it from (https://fonts.googleapis.com/css...).
 */
export interface DiagramFont {
  readonly family: string;
  readonly url: string | null;
}

export interface DiagramThemeTokens {
  readonly roles: Readonly<Record<DiagramThemeRole, DiagramRoleColours>>;
  /** The role a new box takes, and a box with no colour or a white one when restyled. */
  readonly defaultRole: DiagramThemeRole;
  readonly canvas: { readonly background: string; readonly text: string };
  /** Body text: every box and connection label. */
  readonly font: DiagramFont;
  /** Container (swimlane) headers. */
  readonly titleFont: DiagramFont;
  /** Body text size in px. */
  readonly fontSize: number;
  /** Box corner radius in px; 0 for square corners. */
  readonly cornerRadius: number;
  /** Line width in px of box borders and connections. */
  readonly strokeWidth: number;
  readonly edgeStyle: DiagramEdgeStyle;
  readonly arrowHead: DiagramArrowHead;
  readonly shadow: boolean;
}

export interface DiagramTheme {
  readonly id: string;
  readonly name: string;
  /** Built-ins live in code and cannot be changed or deleted. */
  readonly builtIn: boolean;
  readonly tokens: DiagramThemeTokens;
}

/** A custom theme as stored: who made it, and when. */
export interface CustomDiagramTheme extends DiagramTheme {
  readonly builtIn: false;
  readonly createdBy: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ---------------------------------------------------------------- limits

export const MAX_DIAGRAM_THEME_NAME_LENGTH = 80;
export const MAX_DIAGRAM_THEME_FONT_LENGTH = 60;
export const MAX_DIAGRAM_THEME_FONT_URL_LENGTH = 300;
/** How many custom themes the workspace may keep. */
export const MAX_CUSTOM_DIAGRAM_THEMES = 50;
export const DIAGRAM_THEME_LIMITS = {
  fontSize: { min: 8, max: 36 },
  cornerRadius: { min: 0, max: 40 },
  strokeWidth: { min: 0.5, max: 6 },
} as const;
/**
 * A body font size above this is a heading someone chose: restyling keeps it.
 * At or below it, or absent, it becomes the theme's size.
 */
export const RESTYLE_BODY_FONT_SIZE_LIMIT = 14;

const GOOGLE_FONTS_CSS = /^https:\/\/fonts\.googleapis\.com\/css2?\?[A-Za-z0-9+%:;@,.&=_-]+$/;
const FONT_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ]*$/;
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const THEME_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const isDiagramThemeId = (value: unknown): value is string =>
  typeof value === "string" && THEME_ID.test(value);

/** "#rrggbb" in lower case, or null when `value` is not "#rgb" or "#rrggbb". */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string" || !HEX.test(value)) return null;
  const hex = value.slice(1).toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex}`;
}

// ---------------------------------------------------------------- built-ins

export const UPLIFTED_THEME_ID = "uplifted";
export const NEUTRAL_THEME_ID = "neutral";
/** The theme a diagram has when neither it nor its project names one. */
export const DEFAULT_DIAGRAM_THEME_ID = NEUTRAL_THEME_ID;

const googleFont = (family: string): DiagramFont => ({
  family,
  url: `https://fonts.googleapis.com/css?family=${family.replace(/ /g, "+")}`,
});

/**
 * The Uplifted brand: brand blue #4D79D8 with its pale tint as primary, the
 * rest derived from the brand kit's light tokens. Dark ink on pale fills; the
 * accent is the one solid fill, with white text (6:1).
 */
export const UPLIFTED_THEME: DiagramTheme = {
  id: UPLIFTED_THEME_ID,
  name: "Uplifted",
  builtIn: true,
  tokens: {
    roles: {
      primary: { fill: "#dbe5f7", stroke: "#4d79d8", font: "#14131b" },
      secondary: { fill: "#e9eef7", stroke: "#6b8bc4", font: "#14131b" },
      accent: { fill: "#3a5fb5", stroke: "#33559f", font: "#ffffff" },
      neutral: { fill: "#eff1f5", stroke: "#5f6470", font: "#2d3038" },
      success: { fill: "#dcf0e4", stroke: "#217f52", font: "#14131b" },
      warning: { fill: "#fcefd3", stroke: "#8a5a0b", font: "#14131b" },
      danger: { fill: "#fadbdb", stroke: "#c53939", font: "#14131b" },
    },
    defaultRole: "primary",
    canvas: { background: "#ffffff", text: "#14131b" },
    font: googleFont("Inter"),
    titleFont: googleFont("Montserrat"),
    fontSize: 14,
    cornerRadius: 10,
    strokeWidth: 1.5,
    edgeStyle: "orthogonal",
    arrowHead: "block",
    shadow: false,
  },
};

/**
 * Close to Draw.io's own look: white boxes with black lines by default, and
 * the colour pairs the agents' "drawio" format guide names for the roles.
 */
export const NEUTRAL_THEME: DiagramTheme = {
  id: NEUTRAL_THEME_ID,
  name: "Neutral",
  builtIn: true,
  tokens: {
    roles: {
      primary: { fill: "#dae8fc", stroke: "#6c8ebf", font: "#000000" },
      secondary: { fill: "#e1d5e7", stroke: "#9673a6", font: "#000000" },
      accent: { fill: "#ffe6cc", stroke: "#d79b00", font: "#000000" },
      neutral: { fill: "#ffffff", stroke: "#000000", font: "#000000" },
      success: { fill: "#d5e8d4", stroke: "#82b366", font: "#000000" },
      warning: { fill: "#fff2cc", stroke: "#d6b656", font: "#000000" },
      danger: { fill: "#f8cecc", stroke: "#b85450", font: "#000000" },
    },
    defaultRole: "neutral",
    canvas: { background: "#ffffff", text: "#000000" },
    font: { family: "Helvetica", url: null },
    titleFont: { family: "Helvetica", url: null },
    fontSize: 12,
    cornerRadius: 6,
    strokeWidth: 1,
    edgeStyle: "orthogonal",
    arrowHead: "classic",
    shadow: false,
  },
};

export const BUILT_IN_DIAGRAM_THEMES: ReadonlyArray<DiagramTheme> = [NEUTRAL_THEME, UPLIFTED_THEME];

export const builtInDiagramTheme = (id: string): DiagramTheme | null =>
  BUILT_IN_DIAGRAM_THEMES.find((theme) => theme.id === id) ?? null;

export const isBuiltInDiagramThemeId = (id: string) => builtInDiagramTheme(id) !== null;

// ---------------------------------------------------------------- validation

export type DiagramThemeCheck<A> =
  | { readonly ok: true; readonly value: A }
  /** `error` names the field and the rule, in words for a person or an agent. */
  | { readonly ok: false; readonly error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function fontArg(value: unknown, field: string): DiagramThemeCheck<DiagramFont> {
  if (!value || typeof value !== "object") return fail(`${field} must be {family, url}.`);
  const { family, url } = value as { family?: unknown; url?: unknown };
  if (
    typeof family !== "string" ||
    family.length > MAX_DIAGRAM_THEME_FONT_LENGTH ||
    !FONT_FAMILY.test(family)
  ) {
    return fail(
      `${field}.family must be a font name of letters, digits and spaces, up to ` +
        `${MAX_DIAGRAM_THEME_FONT_LENGTH} characters.`,
    );
  }
  if (url === null || url === undefined) return { ok: true, value: { family, url: null } };
  if (
    typeof url !== "string" ||
    url.length > MAX_DIAGRAM_THEME_FONT_URL_LENGTH ||
    !GOOGLE_FONTS_CSS.test(url)
  ) {
    return fail(`${field}.url must be null or a https://fonts.googleapis.com/css URL.`);
  }
  return { ok: true, value: { family, url } };
}

function numberArg(
  value: unknown,
  field: keyof typeof DIAGRAM_THEME_LIMITS,
): DiagramThemeCheck<number> {
  const { min, max } = DIAGRAM_THEME_LIMITS[field];
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? { ok: true, value: Math.round(value * 2) / 2 }
    : fail(`${field} must be a number from ${min} to ${max}.`);
}

const oneOf = <A extends string>(list: ReadonlyArray<A>, value: unknown): value is A =>
  typeof value === "string" && (list as ReadonlyArray<string>).includes(value);

/**
 * Checks a whole token set, as sent by a person or an agent. Every field is
 * required; colours come back as lower-case "#rrggbb", sizes rounded to 0.5.
 */
export function parseDiagramThemeTokens(value: unknown): DiagramThemeCheck<DiagramThemeTokens> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("tokens must be an object.");
  }
  const input = value as Record<string, unknown>;
  const rolesIn = input.roles as Record<string, unknown> | null | undefined;
  if (!rolesIn || typeof rolesIn !== "object") {
    return fail(`roles must hold ${DIAGRAM_THEME_ROLES.join(", ")}.`);
  }
  const roles = {} as Record<DiagramThemeRole, DiagramRoleColours>;
  for (const role of DIAGRAM_THEME_ROLES) {
    const colours = rolesIn[role] as Record<string, unknown> | null | undefined;
    const fill = normalizeHex(colours?.fill);
    const stroke = normalizeHex(colours?.stroke);
    const font = normalizeHex(colours?.font);
    if (!fill || !stroke || !font) {
      return fail(`roles.${role} must be {fill, stroke, font}, each a colour like "#4d79d8".`);
    }
    roles[role] = { fill, stroke, font };
  }
  if (!oneOf(DIAGRAM_THEME_ROLES, input.defaultRole)) {
    return fail(`defaultRole must be one of ${DIAGRAM_THEME_ROLES.join(", ")}.`);
  }
  const canvasIn = input.canvas as Record<string, unknown> | null | undefined;
  const background = normalizeHex(canvasIn?.background);
  const text = normalizeHex(canvasIn?.text);
  if (!background || !text) return fail('canvas must be {background, text}, each like "#ffffff".');
  const font = fontArg(input.font, "font");
  if (!font.ok) return font;
  const titleFont = fontArg(input.titleFont, "titleFont");
  if (!titleFont.ok) return titleFont;
  const fontSize = numberArg(input.fontSize, "fontSize");
  if (!fontSize.ok) return fontSize;
  const cornerRadius = numberArg(input.cornerRadius, "cornerRadius");
  if (!cornerRadius.ok) return cornerRadius;
  const strokeWidth = numberArg(input.strokeWidth, "strokeWidth");
  if (!strokeWidth.ok) return strokeWidth;
  if (!oneOf(DIAGRAM_EDGE_STYLES, input.edgeStyle)) {
    return fail(`edgeStyle must be one of ${DIAGRAM_EDGE_STYLES.join(", ")}.`);
  }
  if (!oneOf(DIAGRAM_ARROW_HEADS, input.arrowHead)) {
    return fail(`arrowHead must be one of ${DIAGRAM_ARROW_HEADS.join(", ")}.`);
  }
  if (typeof input.shadow !== "boolean") return fail("shadow must be true or false.");
  return {
    ok: true,
    value: {
      roles,
      defaultRole: input.defaultRole,
      canvas: { background, text },
      font: font.value,
      titleFont: titleFont.value,
      fontSize: fontSize.value,
      cornerRadius: cornerRadius.value,
      strokeWidth: strokeWidth.value,
      edgeStyle: input.edgeStyle,
      arrowHead: input.arrowHead,
      shadow: input.shadow,
    },
  };
}

/** A theme name: trimmed, one line, 1 to MAX_DIAGRAM_THEME_NAME_LENGTH characters. */
export function parseDiagramThemeName(value: unknown): DiagramThemeCheck<string> {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return name !== "" && name.length <= MAX_DIAGRAM_THEME_NAME_LENGTH
    ? { ok: true, value: name }
    : fail(`name must be 1 to ${MAX_DIAGRAM_THEME_NAME_LENGTH} characters.`);
}

// ---------------------------------------------------------------- styles

type StyleValues = Readonly<Record<string, string>>;

const fontStyleValues = (font: DiagramFont): StyleValues => ({
  fontFamily: font.family,
  // Draw.io loads a Google font named in the style, in any viewer of the diagram.
  ...(font.url === null ? {} : { fontSource: encodeURIComponent(font.url) }),
});

const roundedValues = (tokens: DiagramThemeTokens): StyleValues =>
  tokens.cornerRadius > 0
    ? { rounded: "1", absoluteArcSize: "1", arcSize: String(tokens.cornerRadius * 2) }
    : { rounded: "0" };

const EDGE_STYLE_VALUES: Readonly<Record<DiagramEdgeStyle, StyleValues>> = {
  orthogonal: { edgeStyle: "orthogonalEdgeStyle", curved: "0" },
  curved: { edgeStyle: "orthogonalEdgeStyle", curved: "1", rounded: "1" },
  straight: { edgeStyle: "none", curved: "0", rounded: "0" },
};

/** Connection labels are a step smaller than box text. */
const edgeFontSize = (tokens: DiagramThemeTokens) =>
  Math.max(DIAGRAM_THEME_LIMITS.fontSize.min, tokens.fontSize - 1);

/** The colour of connections: the neutral role's line. */
const edgeColour = (tokens: DiagramThemeTokens) => tokens.roles.neutral.stroke;

function vertexValues(tokens: DiagramThemeTokens, role: DiagramThemeRole): StyleValues {
  const colours = tokens.roles[role];
  return {
    ...roundedValues(tokens),
    whiteSpace: "wrap",
    html: "1",
    fillColor: colours.fill,
    strokeColor: colours.stroke,
    fontColor: colours.font,
    ...fontStyleValues(tokens.font),
    fontSize: String(tokens.fontSize),
    strokeWidth: String(tokens.strokeWidth),
    shadow: tokens.shadow ? "1" : "0",
  };
}

function edgeValues(tokens: DiagramThemeTokens): StyleValues {
  return {
    rounded: tokens.cornerRadius > 0 ? "1" : "0",
    ...EDGE_STYLE_VALUES[tokens.edgeStyle],
    html: "1",
    endArrow: tokens.arrowHead,
    strokeColor: edgeColour(tokens),
    strokeWidth: String(tokens.strokeWidth),
    fontColor: tokens.canvas.text,
    ...fontStyleValues(tokens.font),
    fontSize: String(edgeFontSize(tokens)),
    shadow: tokens.shadow ? "1" : "0",
  };
}

const styleString = (values: StyleValues) =>
  Object.entries(values)
    .map(([key, value]) => `${key}=${value};`)
    .join("");

/** The style string for a new box of `role`, as an agent writes it into a cell. */
export const themeVertexStyle = (theme: DiagramTheme, role: DiagramThemeRole) =>
  styleString(vertexValues(theme.tokens, role));

/** The style string for a new connection. */
export const themeEdgeStyle = (theme: DiagramTheme) => styleString(edgeValues(theme.tokens));

/** The style string for a container (swimlane) whose header takes `role`. */
export const themeContainerStyle = (theme: DiagramTheme, role: DiagramThemeRole) =>
  `swimlane;startSize=30;${styleString({
    ...vertexValues(theme.tokens, role),
    ...fontStyleValues(theme.tokens.titleFont),
    fontStyle: "1",
  })}`;

/** The style string for words without a box. */
export const themeTextStyle = (theme: DiagramTheme) =>
  `text;${styleString({
    html: "1",
    whiteSpace: "wrap",
    fillColor: "none",
    strokeColor: "none",
    fontColor: theme.tokens.canvas.text,
    ...fontStyleValues(theme.tokens.font),
    fontSize: String(theme.tokens.fontSize),
  })}`;

/**
 * Short lines for agents: each role, then a connection, a container and text,
 * each followed by the exact style string to write into a cell.
 */
export function themeStyleGuide(theme: DiagramTheme): ReadonlyArray<string> {
  const { tokens } = theme;
  return [
    `Theme "${theme.name}" (${theme.id}). Default box role: ${tokens.defaultRole}.`,
    ...DIAGRAM_THEME_ROLES.map((role) => `${role} box: ${themeVertexStyle(theme, role)}`),
    `connection: ${themeEdgeStyle(theme)}`,
    `container (${tokens.defaultRole} header): ${themeContainerStyle(theme, tokens.defaultRole)}`,
    `text: ${themeTextStyle(theme)}`,
  ];
}

// ---------------------------------------------------------------- editor config

/** The diagrams.net `configure` payload: what the editor starts new shapes with. */
export interface DrawioThemeConfig {
  readonly defaultVertexStyle: StyleValues;
  readonly defaultEdgeStyle: StyleValues;
  /** One row of swatches, the roles in order, ahead of Draw.io's own. */
  readonly customColorSchemes: ReadonlyArray<
    ReadonlyArray<{ readonly fill: string; readonly stroke: string; readonly font: string }>
  >;
  /** The theme's fonts first in the font menu; Google fonts with the URL Draw.io loads them from. */
  readonly customFonts: ReadonlyArray<
    string | { readonly fontFamily: string; readonly fontUrl: string }
  >;
}

/** The editor's defaults for a theme, sent in answer to the frame's `configure` event. */
export function themeToDrawioConfig(theme: DiagramTheme): DrawioThemeConfig {
  const { tokens } = theme;
  const fonts = [tokens.font, tokens.titleFont].filter(
    (font, index, all) => all.findIndex((other) => other.family === font.family) === index,
  );
  return {
    defaultVertexStyle: vertexValues(tokens, tokens.defaultRole),
    defaultEdgeStyle: edgeValues(tokens),
    customColorSchemes: [
      DIAGRAM_THEME_ROLES.map((role) => ({ ...tokens.roles[role] })),
    ],
    customFonts: fonts.map((font) =>
      font.url === null ? font.family : { fontFamily: font.family, fontUrl: font.url },
    ),
  };
}

// ---------------------------------------------------------------- restyle

interface StylePart {
  /** Null for a bare name such as "ellipse" or "swimlane". */
  readonly key: string | null;
  readonly value: string;
}

function parseStyle(style: string): Array<StylePart> {
  return style
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const at = part.indexOf("=");
      return at === -1
        ? { key: null, value: part }
        : { key: part.slice(0, at).trim(), value: part.slice(at + 1).trim() };
    });
}

const formatStyle = (parts: ReadonlyArray<StylePart>) =>
  parts.map((part) => (part.key === null ? part.value : `${part.key}=${part.value}`)).join(";") +
  (parts.length > 0 ? ";" : "");

class Style {
  readonly parts: Array<StylePart>;
  readonly names: ReadonlySet<string>;

  constructor(style: string) {
    this.parts = parseStyle(style);
    this.names = new Set(this.parts.filter((part) => part.key === null).map((part) => part.value));
  }

  get(key: string): string | undefined {
    return this.parts.find((part) => part.key === key)?.value;
  }

  has(key: string): boolean {
    return this.parts.some((part) => part.key === key);
  }

  /** Sets each key in place where the style has it, else at the end. */
  set(values: StyleValues): void {
    for (const [key, value] of Object.entries(values)) {
      const at = this.parts.findIndex((part) => part.key === key);
      if (at === -1) this.parts.push({ key, value });
      else this.parts[at] = { key, value };
    }
  }

  delete(key: string): void {
    const at = this.parts.findIndex((part) => part.key === key);
    if (at !== -1) this.parts.splice(at, 1);
  }
}

/** The first "#rgb" or "#rrggbb" in a style colour (also inside light-dark()), or null. */
function colourOf(value: string | undefined): string | null {
  const match = value === undefined ? null : /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/.exec(value);
  return match ? normalizeHex(match[0]) : null;
}

const NO_COLOUR = new Set(["none", "transparent"]);
const isNone = (value: string | undefined) =>
  value !== undefined && NO_COLOUR.has(value.toLowerCase());

/** Hue in degrees, chroma and lightness, each of the last two from 0 to 1. */
function colourFeatures(hex: string) {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  let hue = 0;
  if (chroma > 0) {
    if (max === r) hue = ((g - b) / chroma + 6) % 6;
    else if (max === g) hue = (b - r) / chroma + 2;
    else hue = (r - g) / chroma + 4;
  }
  return { hue: hue * 60, chroma, lightness: (max + min) / 2 };
}

/** Below this chroma a colour reads as grey, whatever its hue. */
const GREY_CHROMA = 0.04;

/**
 * How far apart two colours read as roles: hue first (30 degrees counts 0.5),
 * then lightness and chroma; a grey against a colour is always far.
 */
function colourDistance(a: string, b: string): number {
  const x = colourFeatures(a);
  const y = colourFeatures(b);
  const light = Math.abs(x.lightness - y.lightness);
  const greyX = x.chroma < GREY_CHROMA;
  const greyY = y.chroma < GREY_CHROMA;
  if (greyX && greyY) return light;
  if (greyX !== greyY) return 1 + light;
  const turn = Math.abs(x.hue - y.hue);
  return Math.min(turn, 360 - turn) / 60 + light + Math.abs(x.chroma - y.chroma);
}

/** The role whose colours are nearest, over whichever of fill and line the box has. */
function nearestRole(
  tokens: DiagramThemeTokens,
  colours: { readonly fill: string | null; readonly stroke: string | null },
): DiagramThemeRole {
  let best: DiagramThemeRole = tokens.defaultRole;
  let distance = Number.POSITIVE_INFINITY;
  for (const role of DIAGRAM_THEME_ROLES) {
    const own = tokens.roles[role];
    const each =
      (colours.fill === null ? 0 : colourDistance(colours.fill, own.fill)) +
      (colours.stroke === null ? 0 : colourDistance(colours.stroke, own.stroke));
    if (each < distance) {
      best = role;
      distance = each;
    }
  }
  return best;
}

/**
 * The role a box is drawn in now: the nearest to its fill and line together.
 * No fill colour, Draw.io's default, or white is the default role.
 */
function roleOf(
  theme: DiagramTheme,
  style: Style,
  known: ReadonlyArray<DiagramTheme>,
): DiagramThemeRole {
  const { tokens } = theme;
  const fillValue = style.get("fillColor");
  const fill = isNone(fillValue) ? null : colourOf(fillValue);
  const stroke = colourOf(style.get("strokeColor"));
  const exact = (known: DiagramTheme) =>
    DIAGRAM_THEME_ROLES.find((each) => {
      const own = known.tokens.roles[each];
      return (fill ?? own.fill) === own.fill && (stroke ?? own.stroke) === own.stroke;
    });
  if (fill === null && stroke === null) return tokens.defaultRole;
  // A box already in one of this theme's roles keeps it, even a white one, so a rerun changes nothing.
  const own = exact(theme);
  if (own) return own;
  if (!isNone(fillValue) && (fill === null || fill === "#ffffff")) return tokens.defaultRole;
  // Colours a built-in or another known theme gave a role keep that role, so themes map role to role.
  for (const other of known) {
    const role = exact(other);
    if (role) return role;
  }
  return nearestRole(tokens, { fill, stroke });
}

/** Bare style names that draw a box whose corners `cornerRadius` rounds. */
const ROUNDABLE = new Set(["rounded", "swimlane", "label"]);

function isPlainBox(style: Style): boolean {
  const shape = style.get("shape");
  if (shape !== undefined && shape !== "rect" && shape !== "rectangle") return false;
  return [...style.names].every((name) => ROUNDABLE.has(name));
}

function fontSizeValues(style: Style, size: number): StyleValues {
  const current = Number.parseFloat(style.get("fontSize") ?? "");
  return Number.isFinite(current) && current > RESTYLE_BODY_FONT_SIZE_LIMIT
    ? {}
    : { fontSize: String(size) };
}

function setFont(style: Style, font: DiagramFont): void {
  style.set({ fontFamily: font.family });
  if (font.url === null) style.delete("fontSource");
  else style.set({ fontSource: encodeURIComponent(font.url) });
}

/** Routers the theme's edge style replaces: none named, straight, or plain orthogonal. */
const PLAIN_ROUTES = new Set(["", "none", "orthogonalEdgeStyle"]);

const isPlainRoute = (style: Style) => PLAIN_ROUTES.has(style.get("edgeStyle") ?? "");

type CellKind = "shape" | "connection" | "label" | "text" | "image" | "container" | "other";

/** What restyling did to one cell: its kind, its role for a shape, and the new style. */
interface CellRestyle {
  readonly kind: CellKind;
  readonly role: DiagramThemeRole | null;
  readonly style: string;
}

function restyleCell(
  theme: DiagramTheme,
  cell: DrawioCellTarget,
  known: ReadonlyArray<DiagramTheme>,
): CellRestyle | null {
  const { tokens } = theme;
  const style = new Style(cell.style);
  const done = (kind: CellKind, role: DiagramThemeRole | null = null): CellRestyle => ({
    kind,
    role,
    style: formatStyle(style.parts),
  });
  if (cell.edge) {
    if (!isNone(style.get("strokeColor"))) style.set({ strokeColor: edgeColour(tokens) });
    // A special router (entity relation, elbow, isometric...) keeps its own routing and corners.
    if (isPlainRoute(style)) {
      style.set({ rounded: tokens.cornerRadius > 0 ? "1" : "0", ...EDGE_STYLE_VALUES[tokens.edgeStyle] });
    }
    style.set({
      fontColor: tokens.canvas.text,
      strokeWidth: String(tokens.strokeWidth),
      shadow: tokens.shadow ? "1" : "0",
      ...fontSizeValues(style, edgeFontSize(tokens)),
    });
    setFont(style, tokens.font);
    // A line drawn without an arrowhead stays without one.
    if (style.get("endArrow") !== "none") style.set({ endArrow: tokens.arrowHead });
    const start = style.get("startArrow");
    if (start !== undefined && start !== "none") style.set({ startArrow: tokens.arrowHead });
    return done("connection");
  }
  if (!cell.vertex) return null;
  if (cell.parentIsEdge || style.names.has("edgeLabel")) {
    setFont(style, tokens.font);
    style.set({
      fontColor: tokens.canvas.text,
      ...fontSizeValues(style, edgeFontSize(tokens)),
    });
    return done("label");
  }
  if (style.names.has("group")) return null;
  if (style.names.has("image") || style.get("shape") === "image" || style.has("image")) {
    // A picture keeps its own colours; only its caption's font follows the theme.
    setFont(style, tokens.font);
    return done("image");
  }
  if (style.names.has("text")) {
    setFont(style, tokens.font);
    style.set({ fontColor: tokens.canvas.text, ...fontSizeValues(style, tokens.fontSize) });
    return done("text");
  }
  const role = roleOf(theme, style, known);
  const colours = tokens.roles[role];
  if (!isNone(style.get("fillColor"))) style.set({ fillColor: colours.fill });
  if (!isNone(style.get("strokeColor"))) style.set({ strokeColor: colours.stroke });
  style.set({
    fontColor: colours.font,
    strokeWidth: String(tokens.strokeWidth),
    shadow: tokens.shadow ? "1" : "0",
    ...fontSizeValues(style, tokens.fontSize),
  });
  const container = style.names.has("swimlane");
  setFont(style, container ? tokens.titleFont : tokens.font);
  if (container || isPlainBox(style)) style.set(roundedValues(tokens));
  return done(container ? "container" : "shape", role);
}

/** How many cells a restyle touched, of what kinds, and how many shapes took each role. */
export interface RestyleSummary {
  /** Pages restyled, and pages left as they were because they could not be read. */
  readonly pages: number;
  readonly unreadablePages: number;
  /** Cells whose style the restyle rewrote. */
  readonly changed: number;
  /** Cells the theme reached, by kind; a cell already in the theme counts but is not changed. */
  readonly shapes: number;
  readonly containers: number;
  readonly connections: number;
  readonly labels: number;
  readonly texts: number;
  readonly images: number;
  /** Shapes and containers per role they now take. */
  readonly roles: Readonly<Record<DiagramThemeRole, number>>;
}

export type RestyleResult =
  | { readonly ok: true; readonly xml: string; readonly summary: RestyleSummary }
  /** The source is not XML Draw.io can open. */
  | { readonly ok: false; readonly error: string };

/**
 * Restyles a diagram to a theme: each box's fill, line and text colour become
 * those of the role nearest its current colours, and fonts, corner radius,
 * line width, shadow and connection style become the theme's. Ids, geometry,
 * labels and every style key the theme does not own are kept; pictures keep
 * their colours; words without a box take the canvas text colour. A second run
 * with the same theme changes nothing. Takes one `<mxGraphModel>` or a
 * multi-page `<mxfile>`; a compressed page comes back uncompressed.
 */
export async function restyleDiagram(
  xml: string,
  theme: DiagramTheme,
  options: {
    /**
     * Custom themes whose exact role colours map role to role, after the
     * built-ins: a box in a custom theme's primary becomes this theme's primary.
     */
    readonly knownThemes?: ReadonlyArray<DiagramTheme>;
  } = {},
): Promise<RestyleResult> {
  const { tokens } = theme;
  const known = [...BUILT_IN_DIAGRAM_THEMES, ...(options.knownThemes ?? [])];
  const counts = {
    changed: 0,
    shape: 0,
    container: 0,
    connection: 0,
    label: 0,
    text: 0,
    image: 0,
    other: 0,
  };
  const roles = Object.fromEntries(DIAGRAM_THEME_ROLES.map((role) => [role, 0])) as Record<
    DiagramThemeRole,
    number
  >;
  const result = await rewriteDrawio(xml, {
    cell: (cell) => {
      const restyled = restyleCell(theme, cell, known);
      if (!restyled) return null;
      counts[restyled.kind] += 1;
      if (restyled.role) roles[restyled.role] += 1;
      if (formatStyle(parseStyle(cell.style)) === restyled.style) return null;
      counts.changed += 1;
      return restyled.style;
    },
    model: (attributes) => {
      const background = tokens.canvas.background;
      const current = attributes.get("background");
      if (current === undefined ? background === "#ffffff" : current === background) return null;
      return { background };
    },
  });
  if (!result.ok) return result;
  return {
    ok: true,
    xml: result.xml,
    summary: {
      pages: result.pages,
      unreadablePages: result.unreadablePages,
      changed: counts.changed,
      shapes: counts.shape,
      containers: counts.container,
      connections: counts.connection,
      labels: counts.label,
      texts: counts.text,
      images: counts.image,
      roles,
    },
  };
}

// ---------------------------------------------------------------- API shapes

/** Where a diagram's effective theme comes from. */
export type DiagramThemeSource = "diagram" | "project" | "default";

/** `GET /api/diagrams/:id/theme` and `GET /api/diagram-themes/effective?projectId=`. */
export interface EffectiveDiagramTheme {
  readonly theme: DiagramTheme;
  readonly source: DiagramThemeSource;
  /** The diagram's own setting; null follows the project. Always null for a project query. */
  readonly diagramThemeId: string | null;
  /** The project's default; null when the diagram is in no project or the project names none. */
  readonly projectThemeId: string | null;
}

/** `GET /api/diagram-themes`. */
export interface DiagramThemeList {
  /** Built-ins first, then custom themes by name. */
  readonly themes: ReadonlyArray<DiagramTheme | CustomDiagramTheme>;
  readonly defaultThemeId: string;
}

/** `POST /api/diagram-themes` and `PATCH /api/diagram-themes/:id` (each field optional on PATCH). */
export interface DiagramThemeInput {
  readonly name: string;
  readonly tokens: DiagramThemeTokens;
}

/** `PUT /api/diagrams/:id/theme` and `PUT /api/projects/:id/diagram-theme`. */
export interface SetDiagramThemeInput {
  /** Null: the diagram follows its project, or the project falls back to Neutral. */
  readonly themeId: string | null;
}

/** `POST /api/diagrams/:id/restyle`. */
export interface RestyleDiagramInput {
  /** The version the caller read; a stale one is refused with 409 version_conflict. */
  readonly baseVersion: number;
  /** Restyle to this theme; omitted: the diagram's effective theme. Does not change the setting. */
  readonly themeId?: string;
}
