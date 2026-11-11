import type { Editor } from "@tiptap/core";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { DiagramSummary } from "../../../shared/drawio.ts";
import { DiagramEditor, type DiagramEditorTarget } from "../../diagrams/DiagramEditor.tsx";
import { NewDiagramDialog } from "../../diagrams/NewDiagramDialog.tsx";
import { registerInsertAction } from "../../doc/toolbar/insertActions.ts";
import { DiagramPicker } from "./DiagramPicker.tsx";
import { insertOnFirstSave, newDiagramTarget } from "./blockLogic.ts";
import { type DrawioContext, insertDrawioBlock } from "./drawioSupport.ts";

/** The insert action a doc page registers; the toolbar shows its button while it is there. */
export const INSERT_DRAWIO_ID = "drawio";

/** One sitting in the Draw.io editor, opened from a doc. */
interface Sitting {
  /** Keys the overlay, which reads its target once. */
  readonly key: number;
  readonly target: DiagramEditorTarget;
  /** For a new diagram: called with each save, and on close. Links it on the first. */
  readonly saved: (diagram: DiagramSummary | null) => void;
}

/**
 * Linked diagrams on a doc page: registers "Draw.io diagram" for the toolbar
 * and the "+" menu, shows the picker, and owns the Draw.io editor overlay.
 * The overlay lives here, above the tab's editor, so a remote change that
 * rebuilds a block cannot close a drawing in progress.
 *
 * Returns what the tab's blocks need (`context`, for `TabEditor`) and the
 * picker and overlay to render (`element`).
 */
export function useDocDiagrams(input: {
  readonly docId: string;
  /** The doc's project; null for a doc in no project (or one not loaded yet). */
  readonly projectId: string | null;
  /** Whether the person can edit the doc. */
  readonly editable: boolean;
  /** True inside a parent that keeps this frame in one project. */
  readonly locked: boolean;
  readonly onNotice: (message: string) => void;
}): { readonly context: DrawioContext; readonly element: ReactNode } {
  const { docId, projectId, editable, locked } = input;
  /** The editor the picked diagram goes into: the one "Draw.io diagram" was pressed in. */
  const [picking, setPicking] = useState<Editor | null>(null);
  /** A new diagram's theme step, between the picker and Draw.io, as in the library. */
  const [starting, setStarting] = useState<{ readonly editor: Editor; readonly createIn: string } | null>(
    null,
  );
  const [sitting, setSitting] = useState<Sitting | null>(null);
  const sittings = useRef(0);
  const notify = useRef(input.onNotice);
  notify.current = input.onNotice;

  useEffect(() => {
    if (!editable) return;
    return registerInsertAction({
      id: INSERT_DRAWIO_ID,
      label: "Draw.io diagram",
      order: 61,
      run: ({ editor }) => setPicking(editor),
    });
  }, [editable]);

  const context = useMemo<DrawioContext>(
    () => ({
      docId,
      projectId,
      edit: (diagramId) =>
        setSitting({
          key: (sittings.current += 1),
          target: { kind: "existing", diagramId },
          saved: () => undefined,
        }),
      notify: (message) => notify.current(message),
    }),
    [docId, projectId],
  );

  const link = (
    editor: Editor,
    diagram: Pick<DiagramSummary, "id" | "title">,
    focus: boolean,
    page: string | null = null,
  ) => {
    const what = page === null ? `"${diagram.title}"` : `"${diagram.title}", page "${page}",`;
    notify.current(
      insertDrawioBlock(editor, diagram.id, { focus, page })
        ? `Linked ${what} into this doc.`
        : `"${diagram.title}" is in Diagrams, but this tab can no longer be edited. ` +
            "Use Draw.io diagram to link it.",
    );
  };

  const startNew = (editor: Editor, themeId: string | undefined) => {
    setSitting({
      key: (sittings.current += 1),
      target: newDiagramTarget(projectId, themeId),
      // The diagram exists from its first save, so its block goes in then. Exit
      // without saving leaves no diagram and no block.
      // The overlay is still open then, so the keyboard stays with the drawing.
      saved: insertOnFirstSave((diagram) => link(editor, diagram, false)),
    });
  };

  const element = (
    <>
      {picking ? (
        <DiagramPicker
          projectId={projectId}
          locked={locked}
          onPick={(diagram, page) => {
            setPicking(null);
            link(picking, diagram, true, page);
          }}
          onNew={(createIn) => {
            setPicking(null);
            setStarting({ editor: picking, createIn });
          }}
          onClose={() => setPicking(null)}
        />
      ) : null}
      {starting ? (
        <NewDiagramDialog
          projectId={projectId}
          createIn={starting.createIn}
          onOpen={(themeId) => startNew(starting.editor, themeId)}
          onClose={() => setStarting(null)}
        />
      ) : null}
      {sitting ? (
        <DiagramEditor
          key={sitting.key}
          target={sitting.target}
          onSaved={sitting.saved}
          onClose={(saved) => {
            sitting.saved(saved);
            setSitting(null);
          }}
        />
      ) : null}
    </>
  );

  return { context, element };
}
