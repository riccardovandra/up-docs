// The client's calls to /api/diagram-themes, and a project's default theme.

import type {
  CustomDiagramTheme,
  DiagramThemeInput,
  DiagramThemeList,
  EffectiveDiagramTheme,
} from "../../shared/diagramTheme.ts";
import { request } from "../api.ts";

export const themesApi = {
  /** Built-ins first, then the caller's own custom themes (the admin: everyone's). */
  list: () => request<DiagramThemeList>("GET", "/api/diagram-themes"),
  create: async (input: DiagramThemeInput): Promise<CustomDiagramTheme> =>
    (await request<{ theme: CustomDiagramTheme }>("POST", "/api/diagram-themes", input)).theme,
  update: async (
    themeId: string,
    input: Partial<DiagramThemeInput>,
  ): Promise<CustomDiagramTheme> =>
    (
      await request<{ theme: CustomDiagramTheme }>(
        "PATCH",
        `/api/diagram-themes/${themeId}`,
        input,
      )
    ).theme,
  remove: async (themeId: string): Promise<void> => {
    await request<{ ok: true }>("DELETE", `/api/diagram-themes/${themeId}`);
  },
  /** The theme a new diagram in the project starts with, and the project's own setting. */
  projectTheme: (projectId: string) =>
    request<EffectiveDiagramTheme>(
      "GET",
      `/api/diagram-themes/effective?projectId=${encodeURIComponent(projectId)}`,
    ),
  /** The admin sets the project's default; null falls back to Neutral. */
  setProjectTheme: (projectId: string, themeId: string | null) =>
    request<EffectiveDiagramTheme>("PUT", `/api/projects/${projectId}/diagram-theme`, {
      themeId,
    }),
};

export type ThemesApi = typeof themesApi;
