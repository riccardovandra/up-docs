// Diagram themes as the MCP tools show them to agents: a theme in short form,
// the effective theme with its style lines, and the rule for when create_drawio
// applies a theme by itself.

import {
  DIAGRAM_THEME_ROLES,
  themeStyleGuide,
  type DiagramTheme,
  type DiagramThemeRole,
  type EffectiveDiagramTheme,
} from "../shared/diagramTheme.ts";
import { rewriteDrawio } from "../shared/drawioModel.ts";

/** How list_diagram_themes writes each role's colours. */
export const ROLE_COLOUR_FORMAT = "fill/line/text";

/** One theme for list_diagram_themes: its role colours as "fill/line/text", and its look in a line. */
export function themeListing(theme: DiagramTheme, userId: string) {
  const { tokens } = theme;
  const roles = Object.fromEntries(
    DIAGRAM_THEME_ROLES.map((role) => {
      const { fill, stroke, font } = tokens.roles[role];
      return [role, `${fill}/${stroke}/${font}`];
    }),
  ) as Record<DiagramThemeRole, string>;
  const created = "createdBy" in theme ? (theme.createdBy as string | null) : null;
  return {
    themeId: theme.id,
    name: theme.name,
    builtIn: theme.builtIn,
    ...(theme.builtIn ? {} : { mine: created === userId }),
    defaultRole: tokens.defaultRole,
    roles,
    look:
      `${tokens.font.family} ${tokens.fontSize}` +
      (tokens.titleFont.family === tokens.font.family ? "" : `, titles ${tokens.titleFont.family}`) +
      `, radius ${tokens.cornerRadius}, line ${tokens.strokeWidth}, ${tokens.edgeStyle} connections` +
      `, ${tokens.arrowHead} arrows${tokens.shadow ? ", shadow" : ""}`,
  };
}

/**
 * The theme a diagram is drawn with, for read_drawio, create_drawio,
 * update_drawio and set_diagram_theme: which one, where it comes from, and the
 * style strings to write so new cells match it.
 */
export function effectiveThemeBrief(effective: EffectiveDiagramTheme) {
  return {
    themeId: effective.theme.id,
    name: effective.theme.name,
    source: effective.source,
    styleGuide: themeStyleGuide(effective.theme),
  };
}

// A colour of a cell's own. "none" (no fill or no line) and "default" are not colours.
const COLOUR_KEYS = ["fillColor", "strokeColor", "fontColor"];
const NOT_A_COLOUR = new Set(["", "none", "default"]);

/** Whether any cell of any page sets a fill, line or text colour of its own. */
export async function hasOwnColours(xml: string): Promise<boolean> {
  let found = false;
  const read = await rewriteDrawio(xml, {
    cell: ({ style }) => {
      if (found) return null;
      for (const part of style.split(";")) {
        const at = part.indexOf("=");
        if (at === -1) continue;
        const key = part.slice(0, at).trim();
        const value = part.slice(at + 1).trim().toLowerCase();
        if (COLOUR_KEYS.includes(key) && !NOT_A_COLOUR.has(value)) found = true;
      }
      return null;
    },
  });
  // XML that cannot be read is refused before this; count it as coloured so nothing restyles it.
  return read.ok ? found : true;
}

/**
 * Whether create_drawio restyles the XML it was given to the effective theme.
 * `applyTheme` true or false decides. Left out, it applies only a theme chosen
 * for the project (never the Neutral fallback, which is Draw.io's own look) and
 * only to XML in which no cell sets a fill, line or text colour, so colours an
 * agent picked on purpose are kept.
 */
export async function shouldApplyTheme(
  applyTheme: boolean | undefined,
  effective: EffectiveDiagramTheme,
  xml: string,
): Promise<boolean> {
  if (applyTheme !== undefined) return applyTheme;
  if (effective.source === "default") return false;
  return !(await hasOwnColours(xml));
}
