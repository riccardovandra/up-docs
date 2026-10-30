import type { Editor } from "@tiptap/core";
import { memo, type ReactNode } from "react";

import { IMAGE_TYPES } from "../../../shared/images.ts";
import type { Tab } from "../../../shared/protocol.ts";
import type { ColumnWidth } from "./columnWidth.ts";
import {
  ChecklistIcon,
  ChevronDown,
  DrawIcon,
  ImageIcon,
  PlusIcon,
  TableIcon,
  WidthIcon,
} from "./icons.tsx";
import { getInsertAction, useInsertActions } from "./insertActions.ts";
import { MenuItem, Popover } from "./Popover.tsx";
import { TabSwitcher, type TabActions } from "./TabSwitcher.tsx";

function chooseImage(onFile: (file: File) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = Object.keys(IMAGE_TYPES).join(",");
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) onFile(file);
  });
  input.click();
}

/**
 * The row under the header: tab switcher, then (for editors) Draw, Width,
 * Table, Image, Checklist and the "+" insert menu. It re-renders when tabs or
 * the editor change, not on keystrokes.
 */
export const DocToolbar = memo(function DocToolbar(
  props: TabActions & {
    readonly tabs: ReadonlyArray<Tab>;
    readonly activeTabId: string | null;
    readonly editable: boolean;
    readonly editor: Editor | null;
    readonly width: ColumnWidth;
    readonly onToggleWidth: () => void;
    readonly onInsertImage: (file: File) => void;
  },
) {
  const menu = useInsertActions();
  const { editor, onInsertImage } = props;
  const run = (id: string) => {
    const action = getInsertAction(id);
    if (!action || !editor) return;
    action.run({ editor, pickImage: () => chooseImage(onInsertImage) });
  };

  const tool = (id: string, label: string, icon: ReactNode) => (
    <button
      type="button"
      className="toolbar-button"
      aria-label={label}
      disabled={!editor}
      // Keep the editor's selection, so the insert lands at the caret.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => run(id)}
    >
      {icon}
    </button>
  );

  return (
    <div className="doc-toolbar-tools" role="toolbar" aria-label="Doc toolbar">
      {/* A cloud doc always has a tab; a project file has none to switch. */}
      {props.tabs.length > 0 ? (
        <TabSwitcher
          tabs={props.tabs}
          activeTabId={props.activeTabId}
          manage={props.editable}
          onSelect={props.onSelect}
          onCreate={props.onCreate}
          onRename={props.onRename}
          onMove={props.onMove}
          onDelete={props.onDelete}
        />
      ) : null}
      {props.editable ? (
        <>
          {tool("diagram", "Draw a diagram", <DrawIcon />)}
          <button
            type="button"
            className="toolbar-button"
            aria-label={props.width === "wide" ? "Narrow column" : "Wide column"}
            aria-pressed={props.width === "wide"}
            onClick={props.onToggleWidth}
          >
            <WidthIcon />
          </button>
          <span className="toolbar-separator" aria-hidden="true" />
          {tool("table", "Table", <TableIcon />)}
          {tool("image", "Image", <ImageIcon />)}
          {tool("checklist", "Checklist", <ChecklistIcon />)}
          <Popover
            label="Insert"
            disabled={!editor}
            trigger={
              <>
                <PlusIcon />
                <ChevronDown />
              </>
            }
          >
            {() =>
              menu.map((action) => (
                <MenuItem key={action.id} label={action.label} onSelect={() => run(action.id)} />
              ))
            }
          </Popover>
        </>
      ) : (
        <button
          type="button"
          className="toolbar-button"
          aria-label={props.width === "wide" ? "Narrow column" : "Wide column"}
          aria-pressed={props.width === "wide"}
          onClick={props.onToggleWidth}
        >
          <WidthIcon />
        </button>
      )}
    </div>
  );
});
