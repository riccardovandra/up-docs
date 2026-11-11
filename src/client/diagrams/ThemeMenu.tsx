import { useEffect, useRef, useState } from "react";

import type {
  DiagramTheme,
  DiagramThemeList,
  EffectiveDiagramTheme,
} from "../../shared/diagramTheme.ts";
import { Menu, MenuItem, MenuSeparator } from "../home/Menu.tsx";
import { navigate } from "../router.ts";
import { DiagramPicture } from "./DiagramPicture.tsx";
import { diagramErrorMessage, diagramsApi } from "./diagramsApi.ts";
import { DRAWIO_RENDERER_URL, mountDrawioFrame } from "./drawioFrame.ts";
import { startRestyleFlow, type RestyleFlow, type RestyleState } from "./restyleFlow.ts";
import { themesApi } from "./themesApi.ts";

/** "Uplifted, from project", "Neutral, default", or the name of the diagram's own theme. */
export function themeLabel(effective: EffectiveDiagramTheme): string {
  const { name } = effective.theme;
  if (effective.source === "project") return `${name}, from project`;
  if (effective.source === "default") return `${name}, default`;
  return name;
}

/** The picture Draw.io drew of the restyled page, in a frame that runs nothing. */
function SvgFrame(props: { readonly svg: string; readonly title: string }) {
  const html =
    "<!doctype html><meta charset=utf-8><style>html,body{margin:0;height:100%;background:#fff}" +
    "body{display:flex;align-items:center;justify-content:center}" +
    "svg{max-width:100%;max-height:100%;width:auto;height:auto}</style>" +
    props.svg;
  return <iframe className="restyle-after" sandbox="" title={props.title} srcDoc={html} />;
}

/** Before and after, then Restyle; afterwards Undo while the source from before is at hand. */
function RestyleDialog(props: {
  readonly diagramId: string;
  readonly theme: DiagramTheme;
  /** Set when the person just chose the theme: Cancel then keeps the drawing as it is. */
  readonly justChosen: boolean;
  /** The themes the person can see, and the one the diagram had: their roles map role to role. */
  readonly knownThemes: ReadonlyArray<DiagramTheme>;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const flow = useRef<RestyleFlow | null>(null);
  const [state, setState] = useState<RestyleState>({ phase: "drawing" });
  const [diagram, setDiagram] = useState<Awaited<ReturnType<typeof diagramsApi.get>> | null>(null);
  const { diagramId, theme } = props;

  useEffect(() => {
    dialog.current?.showModal();
    diagramsApi.get(diagramId).then(setDiagram, () => undefined);
    const started = startRestyleFlow({
      api: diagramsApi,
      diagramId,
      theme,
      // Both ways in restyle with the diagram's effective theme: just chosen, or as it is.
      effective: true,
      knownThemes: props.knownThemes,
      onState: setState,
      createFrame: () =>
        mountDrawioFrame({
          url: DRAWIO_RENDERER_URL,
          parent: document.body,
          title: "Draw.io restyle preview",
          hidden: true,
        }),
    });
    flow.current = started;
    return () => {
      started.dispose();
      flow.current = null;
    };
  }, [diagramId, theme]);

  const close = () => dialog.current?.close();
  const busy = state.phase === "drawing" || state.phase === "applying" || state.phase === "undoing";

  return (
    <dialog
      ref={dialog}
      className="title-dialog restyle-dialog"
      aria-label={`Restyle with ${theme.name}`}
      onClose={props.onClose}
    >
      <h2>Restyle with {theme.name}</h2>
      {state.phase === "drawing" || state.phase === "ready" ? (
        <>
          <p className="muted" role="status">
            {state.phase === "drawing"
              ? "Restyling a copy to show you first. Nothing is saved yet."
              : state.text}
          </p>
          <div className="restyle-compare">
            <figure>
              <figcaption>Now</figcaption>
              <div className="restyle-pane">
                {diagram ? <DiagramPicture diagramId={diagramId} diagram={diagram} /> : null}
              </div>
            </figure>
            <figure>
              <figcaption>With {theme.name}</figcaption>
              <div className="restyle-pane">
                {state.phase === "drawing" ? (
                  <span className="muted">Drawing the preview…</span>
                ) : state.unchanged ? (
                  <span className="muted">No change</span>
                ) : state.afterSvg ? (
                  <SvgFrame svg={state.afterSvg} title={`Preview with ${theme.name}`} />
                ) : (
                  <span className="muted">
                    Draw.io could not draw the preview. The summary above still holds.
                  </span>
                )}
              </div>
            </figure>
          </div>
          <p className="muted restyle-note">
            The preview shows the first page. Restyling changes every page, keeps each box and
            arrow where it is, and saves a new version.
          </p>
        </>
      ) : null}
      {state.phase === "applying" ? <p role="status">Restyling…</p> : null}
      {state.phase === "undoing" ? <p role="status">Putting it back…</p> : null}
      {state.phase === "done" ? (
        <p role="status">
          Restyled: {state.text} The picture redraws in a moment. Undo puts back the drawing from
          before, as a new version.
        </p>
      ) : null}
      {state.phase === "undone" ? <p role="status">Back to how it was before the restyle.</p> : null}
      {state.phase === "conflict" ? (
        <p role="alert">
          Someone saved this diagram after the preview was drawn, so nothing was changed. Preview
          again with their version?
        </p>
      ) : null}
      {state.phase === "failed" ? (
        <p className="error" role="alert">
          {state.message || diagramErrorMessage(null)}
        </p>
      ) : null}
      <div className="title-dialog-actions">
        {state.phase === "done" ? (
          <>
            <button type="button" className="button secondary" onClick={() => flow.current?.undo()}>
              Undo restyle
            </button>
            <button type="button" className="button" onClick={close}>
              Done
            </button>
          </>
        ) : state.phase === "undone" ? (
          <button type="button" className="button" onClick={close}>
            Close
          </button>
        ) : (
          <>
            <button type="button" className="button secondary" onClick={close} disabled={busy && state.phase !== "drawing"}>
              {props.justChosen ? "Not now" : "Cancel"}
            </button>
            {state.phase === "conflict" || state.phase === "failed" ? (
              <button type="button" className="button" onClick={() => flow.current?.retry()}>
                Preview again
              </button>
            ) : (
              <button
                type="button"
                className="button"
                disabled={state.phase !== "ready" || state.unchanged}
                onClick={() => flow.current?.confirm()}
              >
                Restyle
              </button>
            )}
          </>
        )}
      </div>
      {props.justChosen && (state.phase === "drawing" || state.phase === "ready") ? (
        <p className="muted restyle-note">
          New shapes already start in {theme.name}. Not now leaves what is drawn as it is.
        </p>
      ) : null}
    </dialog>
  );
}

/**
 * The diagram page's theme control: the effective theme and where it comes
 * from. Someone who manages the diagram can choose another, or follow the
 * project, and restyle what is drawn after a before/after preview.
 */
export function ThemeMenu(props: { readonly diagramId: string; readonly canEdit: boolean }) {
  const { diagramId, canEdit } = props;
  const [effective, setEffective] = useState<EffectiveDiagramTheme | null>(null);
  const [list, setList] = useState<DiagramThemeList | null>(null);
  const [restyle, setRestyle] = useState<{
    readonly theme: DiagramTheme;
    readonly justChosen: boolean;
    readonly knownThemes: ReadonlyArray<DiagramTheme>;
  } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    diagramsApi.theme(diagramId).then(
      (found) => live && setEffective(found),
      () => undefined,
    );
    if (canEdit) {
      themesApi.list().then(
        (found) => live && setList(found),
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, [diagramId, canEdit]);

  if (!effective) return null;
  const label = themeLabel(effective);
  if (!canEdit) {
    return (
      <span className="theme-chip" title="This diagram's theme">
        Theme: {label}
      </span>
    );
  }

  const known = list?.themes ?? [];
  const projectTheme =
    list?.themes.find((theme) => theme.id === effective.projectThemeId)?.name ?? "Neutral";

  const choose = async (themeId: string | null) => {
    setProblem(null);
    try {
      const next = await diagramsApi.setTheme(diagramId, themeId);
      const changedTheme = next.theme.id !== effective.theme.id;
      setEffective(next);
      if (changedTheme) {
        setRestyle({ theme: next.theme, justChosen: true, knownThemes: [effective.theme, ...known] });
      }
    } catch (cause) {
      setProblem(diagramErrorMessage(cause));
    }
  };

  return (
    <>
      <Menu
        label="Diagram theme"
        align="start"
        triggerClassName="theme-chip theme-trigger"
        trigger={<>Theme: {label}</>}
      >
        {(close) => (
          <>
            <MenuItem
              kind="radio"
              checked={effective.diagramThemeId === null}
              onSelect={() => {
                close();
                void choose(null);
              }}
            >
              Follow project ({projectTheme})
            </MenuItem>
            {(list?.themes ?? []).map((theme) => (
              <MenuItem
                key={theme.id}
                kind="radio"
                checked={effective.diagramThemeId === theme.id}
                onSelect={() => {
                  close();
                  void choose(theme.id);
                }}
              >
                {theme.name}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem
              onSelect={() => {
                close();
                setRestyle({ theme: effective.theme, justChosen: false, knownThemes: known });
              }}
            >
              Restyle with {effective.theme.name}…
            </MenuItem>
            <MenuItem
              onSelect={() => {
                close();
                navigate("/settings");
              }}
            >
              Edit themes in Settings
            </MenuItem>
          </>
        )}
      </Menu>
      {problem ? (
        <span className="error theme-problem" role="alert">
          {problem}
        </span>
      ) : null}
      {restyle ? (
        <RestyleDialog
          diagramId={diagramId}
          theme={restyle.theme}
          justChosen={restyle.justChosen}
          knownThemes={restyle.knownThemes}
          onClose={() => setRestyle(null)}
        />
      ) : null}
    </>
  );
}
