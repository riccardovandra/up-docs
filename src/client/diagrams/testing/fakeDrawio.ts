import type {
  DiagramRefresh,
  DiagramSummary,
  DiagramUsage,
  DiagramView,
} from "../../../shared/drawio.ts";
import {
  builtInDiagramTheme,
  NEUTRAL_THEME,
  restyleDiagram,
  type DiagramTheme,
  type EffectiveDiagramTheme,
} from "../../../shared/diagramTheme.ts";
import { ApiError } from "../../api.ts";
import type { DiagramPictureUpload } from "../diagramsApi.ts";
import type { DrawioAction, DrawioEvent, DrawioFrame } from "../drawioFrame.ts";

export const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect/></svg>';
export const PNG_BASE64 = "iVBORw0KGgo".padEnd(400, "A");

export const svgDataUri = (svg: string) =>
  `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
export const pngDataUri = (base64: string) => `data:image/png;base64,${base64}`;

/**
 * Stands in for the Draw.io frame, which a headless browser cannot load. It
 * records what the app posts and, unless told otherwise, answers as Draw.io
 * does: `load` after a load, a data URI after each export.
 */
export function fakeDrawio(options: { readonly png?: boolean; readonly loads?: boolean } = {}) {
  const handlers = new Set<(event: DrawioEvent) => void>();
  const posted: Array<DrawioAction> = [];
  const state = { removed: false, png: options.png ?? true, loads: options.loads ?? true };
  const emit = (event: DrawioEvent) => {
    for (const handler of [...handlers]) handler(event);
  };
  const frame: DrawioFrame = {
    post: (action) => {
      posted.push(action);
      // Draw.io answers in a later task, never inside postMessage.
      queueMicrotask(() => {
        if (action.action === "load" && state.loads) emit({ event: "load" });
        if (action.action === "export" && action.format === "svg") {
          emit({ event: "export", format: "svg", data: svgDataUri(SVG) });
        }
        if (action.action === "export" && action.format === "png" && state.png) {
          emit({ event: "export", format: "png", data: pngDataUri(PNG_BASE64) });
        }
      });
    },
    listen: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    remove: () => {
      state.removed = true;
      handlers.clear();
    },
  };
  return { frame, emit, posted, state, listening: () => handlers.size };
}

export const summary = (overrides: Partial<DiagramSummary> = {}): DiagramSummary => ({
  id: "g1",
  projectId: null,
  title: "Flow",
  version: 1,
  pictureVersion: null,
  picturePages: null,
  hasSource: true,
  createdBy: "owner",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

export const view = (overrides: Partial<DiagramView> = {}): DiagramView => ({
  ...summary(),
  canEdit: true,
  role: "owner",
  member: true,
  xml: "<mxGraphModel/>",
  ...overrides,
});

export const conflictError = (current: DiagramSummary) =>
  new ApiError(409, {
    error: "version_conflict",
    version: current.version,
    diagram: current,
  } as never);

/** An in-memory stand-in for the diagrams API, holding diagrams by id and logging the writes. */
export function fakeApi(initial: ReadonlyArray<DiagramView> = []) {
  const diagrams = new Map(initial.map((diagram) => [diagram.id, diagram]));
  /** Where each diagram is linked, as the server would tell someone who manages it. */
  const usage = new Map<string, DiagramUsage>();
  const calls: Array<readonly [string, ...Array<unknown>]> = [];
  /** The ids each re-read asked about: reads, so kept apart from the writes in `calls`. */
  const reads: Array<ReadonlyArray<string>> = [];
  const fail: {
    update?: unknown;
    create?: unknown;
    upload?: unknown;
    summaries?: unknown;
    restyle?: unknown;
  } = {};
  const take = (key: keyof typeof fail) => {
    const cause = fail[key];
    delete fail[key];
    if (cause !== undefined) throw cause;
  };
  /** The effective theme of each diagram, and of each project for a new one ("none": no project). */
  const themes = new Map<string, DiagramTheme>();
  const effective = (theme: DiagramTheme | undefined): EffectiveDiagramTheme => ({
    theme: theme ?? NEUTRAL_THEME,
    source: theme ? "diagram" : "default",
    diagramThemeId: theme?.id ?? null,
    projectThemeId: null,
  });
  return {
    diagrams,
    usage,
    themes,
    theme: async (diagramId: string): Promise<EffectiveDiagramTheme> =>
      effective(themes.get(diagramId)),
    projectTheme: async (projectId: string | null): Promise<EffectiveDiagramTheme> =>
      effective(themes.get(projectId ?? "none")),
    calls,
    reads,
    fail,
    summaries: async (
      diagramIds: ReadonlyArray<string>,
    ): Promise<ReadonlyArray<DiagramRefresh>> => {
      reads.push([...diagramIds]);
      take("summaries");
      return diagramIds.flatMap((diagramId) => {
        const diagram = diagrams.get(diagramId);
        if (!diagram) return [];
        // The route never says whether the caller is on its list.
        const { xml: _xml, member: _member, ...rest } = diagram;
        const linked = usage.get(diagramId) ?? { uses: [], otherDocs: 0 };
        return [{ ...rest, usage: diagram.canEdit ? linked : null }];
      });
    },
    get: async (diagramId: string): Promise<DiagramView> => {
      const diagram = diagrams.get(diagramId);
      if (!diagram) throw new ApiError(404, { error: "not_found" });
      return diagram;
    },
    create: async (input: {
      readonly projectId: string | null;
      readonly title?: string;
      readonly xml?: string;
    }): Promise<DiagramView> => {
      calls.push(["create", input]);
      take("create");
      const created = view({
        id: `new${diagrams.size + 1}`,
        projectId: input.projectId,
        title: input.title ?? "Untitled diagram",
        xml: input.xml ?? "",
        hasSource: (input.xml ?? "") !== "",
      });
      diagrams.set(created.id, created);
      return created;
    },
    update: async (
      diagramId: string,
      input: { readonly xml?: string; readonly baseVersion?: number; readonly title?: string },
    ): Promise<DiagramView> => {
      calls.push(["update", diagramId, input]);
      take("update");
      const current = diagrams.get(diagramId)!;
      if (input.baseVersion !== undefined && input.baseVersion !== current.version) {
        throw conflictError(current);
      }
      const next = { ...current, xml: input.xml ?? current.xml, version: current.version + 1 };
      diagrams.set(diagramId, next);
      return next;
    },
    uploadPicture: async (
      diagramId: string,
      picture: DiagramPictureUpload,
    ): Promise<DiagramSummary> => {
      calls.push(["uploadPicture", diagramId, picture]);
      take("upload");
      const current = diagrams.get(diagramId)!;
      if (picture.version !== current.version) throw conflictError(current);
      const next = {
        ...current,
        pictureVersion: picture.version,
        picturePages: picture.pageNames ?? null,
      };
      diagrams.set(diagramId, next);
      const { xml: _xml, canEdit: _canEdit, ...rest } = next;
      return rest;
    },
    /** A built-in, or a theme set in `themes` under its own id. */
    themeById: async (themeId: string): Promise<DiagramTheme> => {
      const theme = builtInDiagramTheme(themeId) ?? themes.get(themeId);
      if (!theme) throw new ApiError(404, { error: "not_found" });
      return theme;
    },
    setTheme: async (diagramId: string, themeId: string | null) => {
      calls.push(["setTheme", diagramId, themeId]);
      if (themeId === null) themes.delete(diagramId);
      else themes.set(diagramId, builtInDiagramTheme(themeId) ?? themes.get(themeId)!);
      return effective(themes.get(diagramId));
    },
    restyle: async (diagramId: string, input: { readonly baseVersion: number; readonly themeId?: string }) => {
      calls.push(["restyle", diagramId, input]);
      take("restyle");
      const current = diagrams.get(diagramId)!;
      if (input.baseVersion !== current.version) throw conflictError(current);
      const theme =
        (input.themeId === undefined ? themes.get(diagramId) : builtInDiagramTheme(input.themeId)) ??
        NEUTRAL_THEME;
      const result = await restyleDiagram(current.xml ?? "", theme);
      if (!result.ok) throw new ApiError(400, { error: "invalid_xml" });
      const next = { ...current, xml: result.xml, version: current.version + 1 };
      diagrams.set(diagramId, next);
      return { diagram: next, themeId: theme.id, summary: result.summary };
    },
  };
}
