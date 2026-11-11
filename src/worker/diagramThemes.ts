// Diagram themes: custom themes as rows, built-ins from code, and the theme a
// diagram or a project resolves to. The REST API and the MCP tools call the
// same functions, so both share one behaviour.
//
// Who may do what:
// - Everyone signed in sees and uses the built-ins and every custom theme.
// - Only the workspace admin creates, changes and deletes custom themes. Built-ins never change.
// - A diagram or project may name any theme that exists.

import { isAdmin } from "../shared/access.ts";
import {
  BUILT_IN_DIAGRAM_THEMES,
  builtInDiagramTheme,
  DEFAULT_DIAGRAM_THEME_ID,
  isDiagramThemeId,
  MAX_CUSTOM_DIAGRAM_THEMES,
  parseDiagramThemeTokens,
  type CustomDiagramTheme,
  type DiagramTheme,
  type DiagramThemeList,
  type DiagramThemeTokens,
  type EffectiveDiagramTheme,
  restyleDiagram,
  type RestyleSummary,
} from "../shared/diagramTheme.ts";
import type { Diagram, DiagramSummary } from "../shared/drawio.ts";
import { randomId } from "./crypto.ts";
import { diagramSummary, updateDiagram } from "./diagrams.ts";
import { getProject, NotFoundError } from "./docs.ts";

/** A theme write the store refuses; `code` is the API's error, `message` is for the person. */
export class DiagramThemeError extends Error {
  readonly code: "invalid_theme" | "theme_limit" | "built_in_theme" | "admin_only";
  readonly status: 400 | 403 | 409;

  constructor(code: DiagramThemeError["code"], status: DiagramThemeError["status"], message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

interface ThemeRow {
  id: string;
  name: string;
  tokens: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

/** A row as a theme; null when its tokens no longer read as a valid set. */
function toTheme(row: ThemeRow): CustomDiagramTheme | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.tokens);
  } catch {
    return null;
  }
  const tokens = parseDiagramThemeTokens(parsed);
  if (!tokens.ok) return null;
  return {
    id: row.id,
    name: row.name,
    builtIn: false,
    tokens: tokens.value,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Only the workspace admin creates, changes and deletes custom themes, whoever made them. */
export const canManageDiagramThemes = (userId: string) => isAdmin(userId);

/** Throws DiagramThemeError admin_only (403) unless `userId` is the workspace admin. */
export function requireThemeAdmin(userId: string): void {
  if (!canManageDiagramThemes(userId)) {
    throw new DiagramThemeError(
      "admin_only",
      403,
      "Only the workspace admin creates, changes and deletes diagram themes. Everyone can use them.",
    );
  }
}

async function customTheme(db: D1Database, themeId: string): Promise<CustomDiagramTheme | null> {
  if (!isDiagramThemeId(themeId)) return null;
  const row = await db
    .prepare("SELECT * FROM diagram_themes WHERE id = ?")
    .bind(themeId)
    .first<ThemeRow>();
  return row ? toTheme(row) : null;
}

/** Any theme by id, built-in or custom, whoever made it; null when there is none. */
export async function findDiagramTheme(
  db: D1Database,
  themeId: string,
): Promise<DiagramTheme | null> {
  return builtInDiagramTheme(themeId) ?? (await customTheme(db, themeId));
}

/**
 * A theme anyone signed in may use: a built-in or any custom theme. One that
 * does not exist (or no longer reads) is NotFoundError("theme").
 */
export async function requireUsableDiagramTheme(
  db: D1Database,
  input: { readonly themeId: string },
): Promise<DiagramTheme> {
  const theme = await findDiagramTheme(db, input.themeId);
  if (!theme) throw new NotFoundError("theme");
  return theme;
}

/** The built-ins, then every custom theme, by name. The same list for everyone. */
export async function listDiagramThemes(db: D1Database): Promise<DiagramThemeList> {
  const { results } = await db
    .prepare("SELECT * FROM diagram_themes ORDER BY name COLLATE NOCASE, id")
    .all<ThemeRow>();
  const custom = results.map(toTheme).filter((theme) => theme !== null);
  return { themes: [...BUILT_IN_DIAGRAM_THEMES, ...custom], defaultThemeId: DEFAULT_DIAGRAM_THEME_ID };
}

export async function createDiagramTheme(
  db: D1Database,
  input: {
    readonly name: string;
    readonly tokens: DiagramThemeTokens;
    readonly createdBy: string;
    readonly now: number;
  },
): Promise<CustomDiagramTheme> {
  requireThemeAdmin(input.createdBy);
  const count = await db
    .prepare("SELECT count(*) AS n FROM diagram_themes")
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_CUSTOM_DIAGRAM_THEMES) {
    throw new DiagramThemeError(
      "theme_limit",
      409,
      `The workspace has ${MAX_CUSTOM_DIAGRAM_THEMES} custom themes, the most it may keep. ` +
        `Delete one first.`,
    );
  }
  const theme: CustomDiagramTheme = {
    id: randomId(),
    name: input.name,
    builtIn: false,
    tokens: input.tokens,
    createdBy: input.createdBy,
    createdAt: input.now,
    updatedAt: input.now,
  };
  await db
    .prepare(
      `INSERT INTO diagram_themes (id, name, tokens, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(theme.id, theme.name, JSON.stringify(theme.tokens), theme.createdBy, input.now, input.now)
    .run();
  return theme;
}

/** The custom theme, once `userId` is known to be the admin. A built-in is refused. */
async function requireManagedTheme(
  db: D1Database,
  input: { readonly themeId: string; readonly userId: string },
): Promise<CustomDiagramTheme> {
  requireThemeAdmin(input.userId);
  if (builtInDiagramTheme(input.themeId)) {
    throw new DiagramThemeError(
      "built_in_theme",
      403,
      "Built-in themes cannot be changed or deleted. Create a custom theme from it instead.",
    );
  }
  const theme = await customTheme(db, input.themeId);
  if (!theme) throw new NotFoundError("theme");
  return theme;
}

export async function updateDiagramTheme(
  db: D1Database,
  input: {
    readonly themeId: string;
    readonly userId: string;
    readonly name?: string | undefined;
    readonly tokens?: DiagramThemeTokens | undefined;
    readonly now: number;
  },
): Promise<CustomDiagramTheme> {
  const current = await requireManagedTheme(db, input);
  const next: CustomDiagramTheme = {
    ...current,
    name: input.name ?? current.name,
    tokens: input.tokens ?? current.tokens,
    updatedAt: input.now,
  };
  await db
    .prepare("UPDATE diagram_themes SET name = ?, tokens = ?, updated_at = ? WHERE id = ?")
    .bind(next.name, JSON.stringify(next.tokens), input.now, next.id)
    .run();
  return next;
}

/** Deletes a custom theme. Diagrams and projects that named it go back to following their default. */
export async function deleteDiagramTheme(
  db: D1Database,
  input: { readonly themeId: string; readonly userId: string },
): Promise<void> {
  const theme = await requireManagedTheme(db, input);
  await db.batch([
    db.prepare("UPDATE diagrams SET theme_id = NULL WHERE theme_id = ?").bind(theme.id),
    db.prepare("UPDATE projects SET diagram_theme_id = NULL WHERE diagram_theme_id = ?").bind(theme.id),
    db.prepare("DELETE FROM diagram_themes WHERE id = ?").bind(theme.id),
  ]);
}

/** Sets the diagram's own theme; null follows its project. The caller checks access. */
export async function setDiagramTheme(
  db: D1Database,
  input: { readonly diagramId: string; readonly themeId: string | null },
): Promise<void> {
  const row = await db
    .prepare("UPDATE diagrams SET theme_id = ? WHERE id = ? RETURNING id")
    .bind(input.themeId, input.diagramId)
    .first();
  if (!row) throw new NotFoundError("diagram");
}

/** Sets a project's default theme; null falls back to Neutral. The caller checks access. */
export async function setProjectDiagramTheme(
  db: D1Database,
  input: { readonly projectId: string; readonly themeId: string | null },
): Promise<void> {
  const row = await db
    .prepare("UPDATE projects SET diagram_theme_id = ? WHERE id = ? RETURNING id")
    .bind(input.themeId, input.projectId)
    .first();
  if (!row) throw new NotFoundError("project");
}

/**
 * Picks the first of the diagram's theme, the project's and Neutral that still
 * exists. A theme named but gone (or unreadable) is passed over, not an error.
 */
async function resolve(
  db: D1Database,
  diagramThemeId: string | null,
  projectThemeId: string | null,
): Promise<EffectiveDiagramTheme> {
  const fromDiagram = diagramThemeId === null ? null : await findDiagramTheme(db, diagramThemeId);
  if (fromDiagram) return { theme: fromDiagram, source: "diagram", diagramThemeId, projectThemeId };
  const fromProject = projectThemeId === null ? null : await findDiagramTheme(db, projectThemeId);
  if (fromProject) return { theme: fromProject, source: "project", diagramThemeId, projectThemeId };
  return {
    theme: builtInDiagramTheme(DEFAULT_DIAGRAM_THEME_ID)!,
    source: "default",
    diagramThemeId,
    projectThemeId,
  };
}

/** The theme a diagram is drawn with. The caller checks the person may view the diagram. */
export async function effectiveDiagramTheme(
  db: D1Database,
  diagramId: string,
): Promise<EffectiveDiagramTheme> {
  const row = await db
    .prepare(
      `SELECT d.theme_id, p.diagram_theme_id FROM diagrams d
       LEFT JOIN projects p ON p.id = d.project_id WHERE d.id = ?`,
    )
    .bind(diagramId)
    .first<{ theme_id: string | null; diagram_theme_id: string | null }>();
  if (!row) throw new NotFoundError("diagram");
  return resolve(db, row.theme_id, row.diagram_theme_id);
}

/** The theme a new diagram in the project (null: no project) starts with. */
export async function effectiveProjectTheme(
  db: D1Database,
  projectId: string | null,
): Promise<EffectiveDiagramTheme> {
  if (projectId === null) return resolve(db, null, null);
  await getProject(db, projectId);
  const row = await db
    .prepare("SELECT diagram_theme_id FROM projects WHERE id = ?")
    .bind(projectId)
    .first<{ diagram_theme_id: string | null }>();
  return resolve(db, null, row?.diagram_theme_id ?? null);
}

export type RestyleStoredResult =
  | { readonly ok: true; readonly diagram: Diagram; readonly summary: RestyleSummary }
  /** Someone saved since `baseVersion`: the diagram as it is now. */
  | { readonly ok: false; readonly conflict: DiagramSummary }
  /** The stored source is not XML Draw.io can open. */
  | { readonly ok: false; readonly invalidXml: string };

/**
 * Restyles a stored diagram to `theme` and saves the result as a new version
 * when anything changed (an unchanged result keeps the version). The diagram's
 * theme setting is left as it is. The caller checks the person may edit it.
 */
export async function restyleStoredDiagram(
  db: D1Database,
  input: {
    readonly diagram: Diagram;
    readonly theme: DiagramTheme;
    readonly baseVersion: number;
    readonly now: number;
    /** Custom themes whose role colours map role to role (see `restyleDiagram`). */
    readonly knownThemes?: ReadonlyArray<DiagramTheme>;
  },
): Promise<RestyleStoredResult> {
  const { diagram } = input;
  if (diagram.version !== input.baseVersion) {
    return { ok: false, conflict: diagramSummary(diagram) };
  }
  const restyled = await restyleDiagram(diagram.xml, input.theme, {
    knownThemes: input.knownThemes ?? [],
  });
  if (!restyled.ok) return { ok: false, invalidXml: restyled.error };
  const result = await updateDiagram(db, {
    diagramId: diagram.id,
    xml: restyled.xml,
    baseVersion: input.baseVersion,
    now: input.now,
  });
  return result.ok ? { ok: true, diagram: result.diagram, summary: restyled.summary } : result;
}
