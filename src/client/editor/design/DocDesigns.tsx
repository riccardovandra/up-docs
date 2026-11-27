import type { Editor } from "@tiptap/core";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { registerInsertAction } from "../../doc/toolbar/insertActions.ts";
import { DesignPicker } from "./DesignPicker.tsx";
import { insertDesignBlock } from "./designBlockSteps.ts";

/** The insert action a doc page registers for the "+" menu. */
export const INSERT_DESIGN_ID = "design";

/**
 * Designs on a doc page (S4): registers "Design" in the "+" menu for people
 * who edit the doc, and shows the picker. Returns the picker to render.
 */
export function useDocDesigns(input: {
  /** The doc's project; null for a doc in no project (or one not loaded yet). */
  readonly projectId: string | null;
  /** Whether the person can edit the doc. */
  readonly editable: boolean;
  /** True inside a parent that keeps this frame in one project. */
  readonly locked: boolean;
  readonly onNotice: (message: string) => void;
}): ReactNode {
  const { projectId, editable, locked } = input;
  /** The editor the picked design goes into: the one "Design" was pressed in. */
  const [picking, setPicking] = useState<Editor | null>(null);
  const notify = useRef(input.onNotice);
  notify.current = input.onNotice;

  useEffect(() => {
    if (!editable) return;
    return registerInsertAction({
      id: INSERT_DESIGN_ID,
      label: "Design",
      order: 62,
      run: ({ editor }) => setPicking(editor),
    });
  }, [editable]);

  return picking ? (
    <DesignPicker
      projectId={projectId}
      locked={locked}
      onPick={(design) => {
        setPicking(null);
        notify.current(
          insertDesignBlock(picking, design.id)
            ? `Inserted "${design.title}" into this doc.`
            : `This tab can no longer be edited, so "${design.title}" was not inserted.`,
        );
      }}
      onClose={() => setPicking(null)}
    />
  ) : null;
}
