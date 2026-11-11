import { useState } from "react";

import type { Sheet } from "../../shared/sheet/types.ts";

/**
 * The tabs along the bottom: click to switch, double-click to rename, drag to
 * reorder, the menu to delete, + to add. Pressing a tab keeps focus where it
 * is, so a formula being typed can point at another tab's cells.
 */
export function TabsBar(props: {
  readonly sheets: ReadonlyArray<Sheet>;
  readonly activeId: string;
  readonly onSelect: (sheetId: string) => void;
  readonly onAdd: () => void;
  readonly onRename: (sheetId: string, name: string) => void;
  readonly onDelete: (sheetId: string) => void;
  /** Moves a tab after another, or to the front with null. */
  readonly onMove: (sheetId: string, afterId: string | null) => void;
}) {
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  const finishRename = () => {
    if (!renaming) return;
    const sheet = props.sheets.find((candidate) => candidate.id === renaming.id);
    const name = renaming.name.trim();
    setRenaming(null);
    if (sheet && name && name !== sheet.name) props.onRename(sheet.id, name);
  };

  const dropOn = (targetId: string, after: boolean) => {
    if (!dragging || dragging === targetId) return;
    const order = props.sheets.map((sheet) => sheet.id).filter((id) => id !== dragging);
    const at = order.indexOf(targetId);
    const afterId = after ? targetId : at > 0 ? (order[at - 1] as string) : null;
    props.onMove(dragging, afterId);
  };

  return (
    <div className="sheet-tabs" role="tablist" aria-label="Tabs">
      <button type="button" className="sheet-tab-add" aria-label="Add tab" title="Add tab" onClick={props.onAdd}>
        +
      </button>
      {props.sheets.map((sheet) =>
        renaming?.id === sheet.id ? (
          <input
            key={sheet.id}
            className="sheet-tab-rename"
            aria-label="Tab name"
            autoFocus
            // The whole name is selected, so typing replaces it.
            onFocus={(event) => event.currentTarget.select()}
            maxLength={100}
            value={renaming.name}
            onChange={(event) => setRenaming({ id: sheet.id, name: event.target.value })}
            onBlur={finishRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") finishRename();
              if (event.key === "Escape") setRenaming(null);
            }}
          />
        ) : (
          <button
            key={sheet.id}
            type="button"
            role="tab"
            aria-selected={sheet.id === props.activeId}
            className={`sheet-tab${dragging === sheet.id ? " dragging" : ""}`}
            draggable
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => props.onSelect(sheet.id)}
            onDoubleClick={() => setRenaming({ id: sheet.id, name: sheet.name })}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ id: sheet.id, x: event.clientX, y: event.clientY });
            }}
            onDragStart={(event) => {
              setDragging(sheet.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", sheet.name);
            }}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => {
              if (dragging) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              const box = event.currentTarget.getBoundingClientRect();
              dropOn(sheet.id, event.clientX > box.left + box.width / 2);
              setDragging(null);
            }}
          >
            {sheet.name}
            {sheet.id === props.activeId ? (
              <span
                className="sheet-tab-more"
                role="button"
                aria-label={`${sheet.name} options`}
                onClick={(event) => {
                  event.stopPropagation();
                  const box = event.currentTarget.getBoundingClientRect();
                  setMenu({ id: sheet.id, x: box.left, y: box.top });
                }}
              >
                ▾
              </span>
            ) : null}
          </button>
        ),
      )}
      {menu ? (
        <div className="sheet-menu-backdrop" onPointerDown={() => setMenu(null)}>
          <div
            className="sheet-context-menu"
            role="menu"
            style={{ left: menu.x, bottom: window.innerHeight - menu.y + 4 }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="sheet-menu-item"
              onClick={() => {
                const sheet = props.sheets.find((candidate) => candidate.id === menu.id);
                setMenu(null);
                if (sheet) setRenaming({ id: sheet.id, name: sheet.name });
              }}
            >
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              className="sheet-menu-item danger"
              disabled={props.sheets.length <= 1}
              onClick={() => {
                const id = menu.id;
                setMenu(null);
                props.onDelete(id);
              }}
            >
              Delete
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
