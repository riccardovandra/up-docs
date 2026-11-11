import { useEffect, useRef, useState, type FormEvent } from "react";

import type { DiagramThemeList, EffectiveDiagramTheme } from "../../shared/diagramTheme.ts";
import { diagramsApi } from "./diagramsApi.ts";
import { themeLabel } from "./ThemeMenu.tsx";
import { themesApi } from "./themesApi.ts";

const FOLLOW = "";

/**
 * Before Draw.io opens on a new diagram: the theme it will start in (the
 * project's, else Neutral), and a way to pick another for it.
 */
export function NewDiagramDialog(props: {
  readonly projectId: string | null;
  /** Where it is filed, in words. */
  readonly createIn: string;
  /** `themeId` absent: the diagram follows its project. */
  readonly onOpen: (themeId: string | undefined) => void;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [effective, setEffective] = useState<EffectiveDiagramTheme | null>(null);
  const [list, setList] = useState<DiagramThemeList | null>(null);
  const [picked, setPicked] = useState(FOLLOW);

  useEffect(() => {
    dialog.current?.showModal();
    diagramsApi.projectTheme(props.projectId).then(setEffective, () => undefined);
    themesApi.list().then(setList, () => undefined);
  }, [props.projectId]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onOpen(picked === FOLLOW ? undefined : picked);
    dialog.current?.close();
  };

  return (
    <dialog
      ref={dialog}
      className="title-dialog"
      aria-label="New diagram"
      onClose={props.onClose}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close();
      }}
    >
      <form onSubmit={submit}>
        <h2>New diagram</h2>
        <p className="muted">In {props.createIn}. New shapes start in the theme below.</p>
        <label className="theme-field new-diagram-theme">
          <span>Theme</span>
          <select value={picked} onChange={(event) => setPicked(event.target.value)}>
            <option value={FOLLOW}>
              {effective ? themeLabel(effective) : "The project's theme"}
            </option>
            {(list?.themes ?? []).map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.name}
              </option>
            ))}
          </select>
        </label>
        <div className="title-dialog-actions">
          <button type="button" className="button secondary" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="button" autoFocus>
            Open Draw.io
          </button>
        </div>
      </form>
    </dialog>
  );
}
