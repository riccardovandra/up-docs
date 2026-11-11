// "Restyle with theme" without the DOM: restyle the current source in the
// browser, draw page 1 of the result in a hidden Draw.io frame for the
// before/after preview, then on confirm restyle on the server from the version
// previewed. The source from before stays here, so the person can undo.

import { restyleDiagram, type DiagramTheme, type RestyleSummary } from "../../shared/diagramTheme.ts";
import type { DiagramView } from "../../shared/drawio.ts";
import { drawioPageSources } from "../../shared/drawioModel.ts";
import { diagramConflict, diagramErrorMessage, type DiagramsApi } from "./diagramsApi.ts";
import {
  lightSvg,
  nextDrawioEvent,
  svgFromDataUri,
  type DrawioFrame,
} from "./drawioFrame.ts";
import { trimSvgFonts } from "./svgFonts.ts";
import { describeRestyle } from "./themeEditor.ts";

export type RestyleState =
  /** Restyling in the browser and drawing the preview. */
  | { readonly phase: "drawing" }
  /** The preview is ready; `afterSvg` is null when Draw.io could not draw it (the summary still holds). */
  | {
      readonly phase: "ready";
      readonly summary: RestyleSummary;
      readonly text: string;
      readonly afterSvg: string | null;
      /** Nothing would change: there is nothing to apply. */
      readonly unchanged: boolean;
    }
  | { readonly phase: "applying" }
  /** Saved as a new version; `undo` puts the source from before back. */
  | { readonly phase: "done"; readonly text: string }
  /** Someone saved between the preview and the confirm. */
  | { readonly phase: "conflict" }
  | { readonly phase: "undoing" }
  | { readonly phase: "undone" }
  | { readonly phase: "failed"; readonly message: string };

export interface RestyleFlow {
  /** After `ready`: restyle on the server from the version previewed. */
  confirm(): void;
  /** After `conflict` (or a failed preview): read the diagram again and preview anew. */
  retry(): void;
  /** After `done`: save the source from before the restyle as a new version. */
  undo(): void;
  dispose(): void;
}

const INIT_MS = 45_000;
const STEP_MS = 20_000;

/** Draws one page's source in a frame that is ready for `load`; the SVG, or null on failure. */
async function drawSvg(frame: DrawioFrame, xml: string): Promise<string | null> {
  const loaded = nextDrawioEvent(frame, "load", { timeoutMs: STEP_MS, what: "open the preview" });
  frame.post({ action: "load", xml });
  await loaded;
  const answered = nextDrawioEvent(frame, "export", { timeoutMs: STEP_MS, what: "draw the preview" });
  frame.post({ action: "export", format: "svg" });
  const svg = svgFromDataUri((await answered).data);
  return svg === null ? null : trimSvgFonts(lightSvg(svg));
}

export function startRestyleFlow(options: {
  readonly api: Pick<DiagramsApi, "get" | "restyle" | "update">;
  /** Mounts the hidden renderer frame; called once, on the first preview. */
  readonly createFrame: () => DrawioFrame;
  readonly diagramId: string;
  readonly theme: DiagramTheme;
  /**
   * `theme` is the diagram's effective theme: the server resolves it rather
   * than be named it, so a custom theme the person does not own (a project's
   * default set by the admin) still applies.
   */
  readonly effective?: boolean;
  /** Custom themes whose role colours map role to role, as the server's restyle maps them. */
  readonly knownThemes?: ReadonlyArray<DiagramTheme>;
  readonly onState: (state: RestyleState) => void;
  /** After the restyle or its undo saved: the diagram as it now is. */
  readonly onSaved?: (diagram: DiagramView) => void;
}): RestyleFlow {
  const { api, diagramId, theme } = options;
  let state: RestyleState = { phase: "drawing" };
  let disposed = false;
  let frame: { readonly port: DrawioFrame; readonly ready: Promise<unknown> } | null = null;
  /** What was previewed: the version, and its source to undo to. */
  let previewed: { readonly version: number; readonly xml: string } | null = null;
  /** After the restyle: the version it saved, to undo from. */
  let restyledVersion: number | null = null;
  /** Bumped by each preview, so an older one that finishes late is dropped. */
  let run = 0;

  const set = (next: RestyleState) => {
    if (disposed) return;
    state = next;
    options.onState(next);
  };

  const readyFrame = async () => {
    if (!frame) {
      const port = options.createFrame();
      const ready = nextDrawioEvent(port, "init", { timeoutMs: INIT_MS, what: "start" });
      ready.catch(() => undefined);
      frame = { port, ready };
    }
    await frame.ready;
    return frame.port;
  };

  const preview = async () => {
    const mine = (run += 1);
    set({ phase: "drawing" });
    try {
      const diagram = await api.get(diagramId);
      if (!diagram.canEdit || diagram.xml === null) {
        set({ phase: "failed", message: "Only someone who manages this diagram can restyle it." });
        return;
      }
      const result = await restyleDiagram(diagram.xml, theme, {
        knownThemes: (options.knownThemes ?? []).filter((each) => !each.builtIn),
      });
      if (mine !== run) return;
      if (!result.ok) {
        set({ phase: "failed", message: `The diagram could not be read: ${result.error}.` });
        return;
      }
      previewed = { version: diagram.version, xml: diagram.xml };
      const unchanged = result.summary.changed === 0;
      const text = describeRestyle(result.summary);
      if (unchanged) {
        set({ phase: "ready", summary: result.summary, text, afterSvg: null, unchanged });
        return;
      }
      const firstPage = drawioPageSources(result.xml)?.[0]?.xml ?? result.xml;
      const afterSvg = await readyFrame()
        .then((port) => drawSvg(port, firstPage))
        .catch(() => {
          // A frame that timed out may be stuck; the next preview starts a clean one.
          frame?.port.remove();
          frame = null;
          return null;
        });
      if (mine !== run) return;
      set({ phase: "ready", summary: result.summary, text, afterSvg, unchanged });
    } catch (cause) {
      if (mine === run) set({ phase: "failed", message: diagramErrorMessage(cause) });
    }
  };

  const confirm = async () => {
    if (state.phase !== "ready" || state.unchanged || !previewed) return;
    const { text } = state;
    set({ phase: "applying" });
    try {
      const result = await api.restyle(diagramId, {
        baseVersion: previewed.version,
        ...(options.effective ? {} : { themeId: theme.id }),
      });
      restyledVersion = result.diagram.version;
      options.onSaved?.(result.diagram);
      set({ phase: "done", text });
    } catch (cause) {
      if (diagramConflict(cause)) set({ phase: "conflict" });
      else set({ phase: "failed", message: diagramErrorMessage(cause) });
    }
  };

  const undo = async () => {
    if (state.phase !== "done" || !previewed || restyledVersion === null) return;
    set({ phase: "undoing" });
    try {
      const diagram = await api.update(diagramId, {
        xml: previewed.xml,
        baseVersion: restyledVersion,
      });
      restyledVersion = null;
      options.onSaved?.(diagram);
      set({ phase: "undone" });
    } catch (cause) {
      set({
        phase: "failed",
        message: diagramConflict(cause)
          ? "Someone saved the diagram after the restyle, so it was not undone. Open it in Draw.io to change it back."
          : diagramErrorMessage(cause),
      });
    }
  };

  void preview();

  return {
    confirm: () => void confirm(),
    retry: () => {
      if (state.phase === "conflict" || state.phase === "failed") void preview();
    },
    undo: () => void undo(),
    dispose: () => {
      disposed = true;
      run += 1;
      frame?.port.remove();
      frame = null;
    },
  };
}
