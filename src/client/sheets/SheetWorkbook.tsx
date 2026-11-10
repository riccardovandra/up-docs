import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";

import { columnToLetters, formatArea, quoteSheetName } from "../../shared/sheet/address.ts";
import { decreaseDecimals, increaseDecimals } from "../../shared/sheet/numberFormat.ts";
import { cellKey, type Edit, type FormatPatch, type Sheet } from "../../shared/sheet/types.ts";
import { isRefusal, viewCell } from "../../shared/sheet/workbook.ts";
import { clipMatches, formatTsv, pasteInputs, shiftInput, type GridClip } from "./clipboard.ts";
import { FormulaInput } from "./FormulaInput.tsx";
import { formulaRefSpans, putRef, refInsertion, refRect, type PointSpan } from "./formulaRefs.ts";
import { Grid, type GridOverlay, type GridTarget, type PointerInfo } from "./Grid.tsx";
import { boundedRect, storedExtent } from "./layout.ts";
import {
  cellSelection,
  clampSelection,
  clickCell,
  headerSelection,
  isSingleCell,
  moveSelection,
  selectionFromLabel,
  selectionLabel,
  selectionRect,
  type Dims,
  type KeyInput,
  type Rect,
  type Selection,
} from "./selection.ts";
import type { SheetSync } from "./sheetSync.ts";
import { TabsBar } from "./TabsBar.tsx";
import { Toolbar } from "./Toolbar.tsx";
import { chunkEdits, inverseOfLists, UndoStack } from "./undo.ts";

/** A cell being typed into. */
interface Draft {
  readonly sheetId: string;
  readonly row: number;
  readonly col: number;
  readonly text: string;
  readonly original: string;
  /** "enter": started by typing, arrows commit and move. "edit": arrows move the caret. */
  readonly mode: "enter" | "edit";
  /** Which input has the caret. */
  readonly where: "cell" | "bar";
  /** The reference this draft last picked by pointing, still at the caret. */
  readonly pointing: PointSpan | null;
  /** The range being pointed at, and on which tab. */
  readonly point: Selection | null;
  readonly pointSheetId: string | null;
}

const dimsOf = (sheet: Sheet): Dims => ({ rows: sheet.rowCount, cols: sheet.columnCount });
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * The spreadsheet: formula bar, grid, tabs and toolbar over one workbook kept
 * by `sync`. Everything typed or formatted goes through `sync.apply`, which
 * shows it at once and sends it to the sheet's room.
 */
export function SheetWorkbook(props: {
  readonly sync: SheetSync;
  readonly sheetId: string;
  /** The tab the address bar names, if any. */
  readonly tabId: string | null;
  readonly onTabChange: (tabId: string) => void;
  /** Cells an agent just changed, by tab id then `cellKey`. */
  readonly flashes: ReadonlyMap<string, ReadonlySet<number>>;
  /** Remote cursors and name tags (S4). */
  readonly overlays: ReadonlyArray<GridOverlay>;
  /**
   * Seam for live presence (S4): called with the shown tab and the selection
   * whenever either changes, for the page to publish to the room.
   */
  readonly onSelectionChange?: (sheetId: string, selection: Selection) => void;
  readonly onNotice: (message: string) => void;
}) {
  const { sync, onNotice } = props;
  const workbook = useSyncExternalStore(sync.subscribe, sync.getView);
  const lastName = useRef<string | null>(null);
  const active =
    workbook.sheets.find((sheet) => sheet.id === props.tabId) ??
    workbook.sheets.find((sheet) => sheet.name === lastName.current) ??
    (workbook.sheets[0] as Sheet);
  lastName.current = active.name;
  const dims = dimsOf(active);

  const [selections, setSelections] = useState<ReadonlyMap<string, Selection>>(() => new Map());
  const selection = clampSelection(selections.get(active.id) ?? cellSelection({ row: 0, col: 0 }), dims);
  const setSelection = useCallback(
    (sheetId: string, next: Selection) =>
      setSelections((current) => new Map(current).set(sheetId, next)),
    [],
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [copy, setCopy] = useState<{ sheetId: string; rect: Rect } | null>(null);
  const [menu, setMenu] = useState<{ target: GridTarget; x: number; y: number } | null>(null);
  const clip = useRef<GridClip | null>(null);
  const undo = useRef(new UndoStack());
  const scrollerRef = useRef<HTMLDivElement>(null);
  const cellInput = useRef<HTMLInputElement>(null);
  const barInput = useRef<HTMLInputElement>(null);
  const caretAfter = useRef<number | null>(null);

  const { onSelectionChange } = props;
  useEffect(() => {
    onSelectionChange?.(active.id, selection);
    // The selection object is rebuilt each render; publish on its content.
  }, [onSelectionChange, active.id, selection.anchor.row, selection.anchor.col, selection.focus.row, selection.focus.col, selection.kind]);

  const focusGrid = () => scrollerRef.current?.focus({ preventScroll: true });
  const showTab = (sheetId: string) => {
    if (sheetId !== active.id) props.onTabChange(sheetId);
  };

  // ---- sending ----

  /** Applies edits here and sends them; cell writes and formats can be undone. */
  const send = useCallback(
    (edits: ReadonlyArray<Edit>, options: { readonly undoable: boolean; readonly sheetId?: string }) => {
      if (edits.length === 0) return true;
      const lists = chunkEdits(edits);
      const inverse = options.undoable ? inverseOfLists(sync.view, lists) : null;
      for (const list of lists) {
        const applied = sync.apply(list);
        if (isRefusal(applied)) {
          if (applied.refusal !== "nothingToChange") onNotice(applied.detail);
          return false;
        }
      }
      if (inverse) {
        undo.current.record({ forward: edits, inverse, sheetId: options.sheetId ?? active.id });
      }
      return true;
    },
    [sync, onNotice, active.id],
  );
  const sendUndo = (edits: ReadonlyArray<Edit>) => send(edits, { undoable: false });

  const runUndo = (redo: boolean) => {
    const entry = redo
      ? undo.current.redo(sync.view, sendUndo)
      : undo.current.undo(sendUndo);
    if (entry) showTab(entry.sheetId);
  };

  const formatRect = () => boundedRect(selectionRect(selection, dims), active, selection.kind);
  const rangeText = (rect: Rect) =>
    formatArea({ startRow: rect.r1, startCol: rect.c1, endRow: rect.r2, endCol: rect.c2 });

  const applyFormat = (format: FormatPatch) =>
    send([{ kind: "formatCells", sheet: active.id, ranges: [rangeText(formatRect())], format }], {
      undoable: true,
    });

  const activeView = viewCell(workbook, active.id, selection.anchor.row, selection.anchor.col);

  // ---- drafting ----

  const draftSheet = draft ? workbook.sheets.find((sheet) => sheet.id === draft.sheetId) : undefined;

  const startDraft = (mode: Draft["mode"], text: string, where: Draft["where"]) => {
    const { row, col } = selection.anchor;
    const original = viewCell(workbook, active.id, row, col).input;
    setDraft({
      sheetId: active.id,
      row,
      col,
      text,
      original,
      mode,
      where,
      pointing: null,
      point: null,
      pointSheetId: null,
    });
    caretAfter.current = text.length;
  };

  // Focus and caret follow the draft into whichever input holds it.
  useLayoutEffect(() => {
    if (!draft) return;
    const input = draft.where === "cell" ? cellInput.current : barInput.current;
    if (!input) return;
    if (document.activeElement !== input) input.focus({ preventScroll: true });
    if (caretAfter.current !== null) {
      input.setSelectionRange(caretAfter.current, caretAfter.current);
      caretAfter.current = null;
    }
  });

  const finishDraft = (then: KeyInput | null) => {
    if (!draft) return;
    const sheet = workbook.sheets.find((candidate) => candidate.id === draft.sheetId);
    setDraft(null);
    if (!sheet) return;
    if (draft.text !== draft.original) {
      const value = draft.text === "" ? null : draft.text;
      send(
        [
          {
            kind: "writeCells",
            sheet: sheet.id,
            topLeft: formatArea({ startRow: draft.row, startCol: draft.col, endRow: draft.row, endCol: draft.col }),
            rows: [[value]],
          },
        ],
        { undoable: true, sheetId: sheet.id },
      );
    }
    showTab(sheet.id);
    const from = selections.get(sheet.id) ?? cellSelection({ row: draft.row, col: draft.col });
    const at = { ...from, anchor: { row: draft.row, col: draft.col }, focus: { row: draft.row, col: draft.col }, kind: "cells" as const };
    const isFilled = (row: number, col: number) => (sheet.cells.get(cellKey(row, col))?.input ?? "") !== "";
    const moved = then ? moveSelection(at, then, dimsOf(sheet), isFilled) : null;
    setSelection(sheet.id, moved ?? at);
    focusGrid();
  };

  const cancelDraft = () => {
    if (!draft) return;
    const sheetId = draft.sheetId;
    setDraft(null);
    showTab(sheetId);
    focusGrid();
  };

  const caretOf = () => {
    const input = draft?.where === "bar" ? barInput.current : cellInput.current;
    return input?.selectionStart ?? draft?.text.length ?? 0;
  };

  /** Puts the picked range's reference into the formula, replacing the one picked before. */
  const pickRef = (point: Selection, pickedSheet: Sheet) => {
    if (!draft || !draftSheet) return false;
    const span = refInsertion(draft.text, caretOf(), draft.pointing);
    if (!span) return false;
    const label = selectionLabel(point, dimsOf(pickedSheet));
    const text =
      pickedSheet.id === draftSheet.id ? label : `${quoteSheetName(pickedSheet.name)}!${label}`;
    const next = putRef(draft.text, span, text);
    caretAfter.current = next.span.end;
    setDraft({ ...draft, text: next.input, pointing: next.span, point, pointSheetId: pickedSheet.id });
    return true;
  };

  /** Whether a click or an arrow now would pick a reference. */
  const pointable = () => draft !== null && refInsertion(draft.text, caretOf(), draft.pointing) !== null;

  const onDraftKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!draft) return;
    event.stopPropagation();
    const key = event.key;
    if (key === "Escape") {
      event.preventDefault();
      cancelDraft();
      return;
    }
    if (key === "Enter" || key === "Tab") {
      event.preventDefault();
      finishDraft({ key, shift: event.shiftKey, mod: false });
      return;
    }
    if (key.startsWith("Arrow")) {
      const mod = event.metaKey || event.ctrlKey;
      if (pointable()) {
        event.preventDefault();
        const pickedSheet =
          workbook.sheets.find((sheet) => sheet.id === (draft.pointSheetId ?? active.id)) ?? active;
        const from = draft.point ?? cellSelection({ row: draft.row, col: draft.col });
        const isFilled = (row: number, col: number) =>
          (pickedSheet.cells.get(cellKey(row, col))?.input ?? "") !== "";
        const moved = moveSelection(from, { key, shift: event.shiftKey, mod }, dimsOf(pickedSheet), isFilled);
        if (moved) {
          pickRef(moved, pickedSheet);
          if (pickedSheet.id === active.id) setSelection(active.id, { ...selection, focus: moved.focus });
        }
        return;
      }
      if (draft.mode === "enter" && draft.where === "cell") {
        event.preventDefault();
        finishDraft({ key, shift: event.shiftKey, mod });
      }
    }
  };

  const onDraftChange = (text: string) => {
    if (!draft) return;
    setDraft({ ...draft, text, pointing: null, point: null });
  };

  // ---- grid input ----

  const isFilled = (row: number, col: number) => (active.cells.get(cellKey(row, col))?.input ?? "") !== "";

  const clearSelection = () => {
    const rect = formatRect();
    const extent = storedExtent(active);
    const r2 = Math.min(rect.r2, extent.row);
    const c2 = Math.min(rect.c2, extent.col);
    if (r2 < rect.r1 || c2 < rect.c1) return;
    const rows = Array.from({ length: r2 - rect.r1 + 1 }, () =>
      Array.from({ length: c2 - rect.c1 + 1 }, () => null),
    );
    send(
      [{ kind: "writeCells", sheet: active.id, topLeft: formatArea({ startRow: rect.r1, startCol: rect.c1, endRow: rect.r1, endCol: rect.c1 }), rows }],
      { undoable: true },
    );
  };

  const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== scrollerRef.current) return;
    const mod = IS_MAC ? event.metaKey : event.ctrlKey;
    const key = event.key;
    if (mod && key.toLowerCase() === "z") {
      event.preventDefault();
      runUndo(event.shiftKey);
      return;
    }
    if (mod && key.toLowerCase() === "y") {
      event.preventDefault();
      runUndo(true);
      return;
    }
    if (mod && ["b", "i", "u"].includes(key.toLowerCase())) {
      event.preventDefault();
      const name = ({ b: "bold", i: "italic", u: "underline" } as const)[key.toLowerCase() as "b" | "i" | "u"];
      applyFormat({ font: { [name]: !activeView.format?.font?.[name] } });
      return;
    }
    if (mod && key.toLowerCase() === "a") {
      event.preventDefault();
      setSelection(active.id, { anchor: { row: 0, col: 0 }, focus: { row: dims.rows - 1, col: dims.cols - 1 }, kind: "cells" });
      return;
    }
    if (key === "Escape") {
      setCopy(null);
      return;
    }
    if (key === "F2" || (key === "Enter" && !event.shiftKey && isSingleCell(selection))) {
      event.preventDefault();
      startDraft("edit", activeView.input, "cell");
      return;
    }
    if (key === "Delete" || key === "Backspace") {
      event.preventDefault();
      clearSelection();
      return;
    }
    const moved = moveSelection(selection, { key, shift: event.shiftKey, mod }, dims, isFilled);
    if (moved) {
      event.preventDefault();
      setSelection(active.id, moved);
      return;
    }
    if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      startDraft("enter", key, "cell");
    }
  };

  const dragFrom = useRef<"cells" | "rows" | "columns" | "point" | null>(null);

  const onPointer = (target: GridTarget, phase: "down" | "drag", info: PointerInfo) => {
    if (phase === "down") setMenu(null);
    // Pointing: a click or drag while typing a formula picks a reference.
    if (draft && (phase === "drag" ? dragFrom.current === "point" : pointable())) {
      info.preventDefault();
      if (target.kind === "corner") return;
      const from = draft.point && draft.pointSheetId === active.id ? draft.point : null;
      let point: Selection;
      if (target.kind === "cell") {
        point =
          phase === "drag" && from
            ? { anchor: from.anchor, focus: { row: target.row, col: target.col }, kind: from.kind === "cells" ? "cells" : from.kind }
            : cellSelection({ row: target.row, col: target.col });
      } else {
        const kind = target.kind === "row" ? "rows" : "columns";
        const index = target.kind === "row" ? target.row : target.col;
        point = headerSelection(from ?? selection, kind, index, phase === "drag", dims);
      }
      if (phase === "drag" && point.kind === "cells" && from?.kind !== "cells" && from) {
        // A header drag stays on headers.
        point = headerSelection(from, from.kind as "rows" | "columns", from.kind === "rows" ? point.focus.row : point.focus.col, true, dims);
      }
      dragFrom.current = "point";
      pickRef(point, active);
      return;
    }
    if (phase === "down") {
      if (draft) finishDraft(null);
      dragFrom.current = target.kind === "cell" ? "cells" : target.kind === "row" ? "rows" : target.kind === "column" ? "columns" : null;
      if (target.kind === "cell") setSelection(active.id, clickCell(selection, target, info.shift));
      else if (target.kind === "row") setSelection(active.id, headerSelection(selection, "rows", target.row, info.shift, dims));
      else if (target.kind === "column") setSelection(active.id, headerSelection(selection, "columns", target.col, info.shift, dims));
      else setSelection(active.id, { anchor: { row: 0, col: 0 }, focus: { row: dims.rows - 1, col: dims.cols - 1 }, kind: "cells" });
      info.preventDefault();
      focusGrid();
      return;
    }
    // Dragging extends the selection the press started.
    const kind = dragFrom.current;
    if (kind === "cells" && target.kind === "cell") {
      setSelection(active.id, { anchor: selection.anchor, focus: { row: target.row, col: target.col }, kind: "cells" });
    } else if (kind === "rows" && (target.kind === "cell" || target.kind === "row")) {
      setSelection(active.id, headerSelection(selection, "rows", target.row, true, dims));
    } else if (kind === "columns" && (target.kind === "cell" || target.kind === "column")) {
      setSelection(active.id, headerSelection(selection, "columns", target.col, true, dims));
    }
  };

  // ---- clipboard ----

  useEffect(() => {
    const inGrid = () => document.activeElement === scrollerRef.current;
    const onCopy = (event: ClipboardEvent, cut: boolean) => {
      if (!inGrid() || !event.clipboardData) return;
      event.preventDefault();
      const rect = formatRect();
      const extent = storedExtent(active);
      const r2 = Math.max(rect.r1, Math.min(rect.r2, extent.row));
      const c2 = Math.max(rect.c1, Math.min(rect.c2, extent.col));
      const shown: string[][] = [];
      const inputs: string[][] = [];
      for (let row = rect.r1; row <= r2; row++) {
        const shownRow: string[] = [];
        const inputRow: string[] = [];
        for (let col = rect.c1; col <= c2; col++) {
          const view = viewCell(workbook, active.id, row, col);
          shownRow.push(view.shown);
          inputRow.push(view.input);
        }
        shown.push(shownRow);
        inputs.push(inputRow);
      }
      const text = formatTsv(shown);
      event.clipboardData.setData("text/plain", text);
      clip.current = { text, inputs, sheetId: active.id, row: rect.r1, col: rect.c1, cut };
      setCopy(cut ? null : { sheetId: active.id, rect: { ...rect, r2, c2 } });
      if (cut) {
        send(
          [{ kind: "writeCells", sheet: active.id, topLeft: formatArea({ startRow: rect.r1, startCol: rect.c1, endRow: rect.r1, endCol: rect.c1 }), rows: inputs.map((row) => row.map(() => null)) }],
          { undoable: true },
        );
      }
    };
    const copyHandler = (event: ClipboardEvent) => onCopy(event, false);
    const cutHandler = (event: ClipboardEvent) => onCopy(event, true);
    const pasteHandler = (event: ClipboardEvent) => {
      if (!inGrid() || !event.clipboardData) return;
      event.preventDefault();
      const text = event.clipboardData.getData("text/plain");
      if (text === "") return;
      const rect = selectionRect(selection, dims);
      let rows: Array<Array<string | null>> = pasteInputs(text, clip.current, { row: rect.r1, col: rect.c1 });
      const single = rows.length === 1 && rows[0]?.length === 1;
      if (single && (rect.r1 !== rect.r2 || rect.c1 !== rect.c2) && selection.kind === "cells") {
        // One value pasted over a range fills it; a copied formula shifts per cell.
        const own = clipMatches(text, clip.current);
        const source = own ? (clip.current?.inputs[0]?.[0] ?? null) : (rows[0]?.[0] ?? null);
        rows = [];
        for (let row = rect.r1; row <= rect.r2; row++) {
          const line: Array<string | null> = [];
          for (let col = rect.c1; col <= rect.c2; col++) {
            const c = clip.current;
            line.push(
              own && c && source !== null && !c.cut ? shiftInput(source, row - c.row, col - c.col) : source,
            );
          }
          rows.push(line);
        }
      }
      const cells = rows.map((row) => row.map((value) => (value === "" ? null : value)));
      const width = Math.max(...cells.map((row) => row.length));
      const filled = cells.map((row) => [...row, ...Array.from({ length: width - row.length }, () => null)]);
      if (
        send(
          [{ kind: "writeCells", sheet: active.id, topLeft: formatArea({ startRow: rect.r1, startCol: rect.c1, endRow: rect.r1, endCol: rect.c1 }), rows: filled }],
          { undoable: true },
        )
      ) {
        setSelection(active.id, {
          anchor: { row: rect.r1, col: rect.c1 },
          focus: { row: rect.r1 + filled.length - 1, col: rect.c1 + width - 1 },
          kind: "cells",
        });
        if (clip.current?.cut) clip.current = null;
      }
    };
    document.addEventListener("copy", copyHandler);
    document.addEventListener("cut", cutHandler);
    document.addEventListener("paste", pasteHandler);
    return () => {
      document.removeEventListener("copy", copyHandler);
      document.removeEventListener("cut", cutHandler);
      document.removeEventListener("paste", pasteHandler);
    };
  });

  // ---- rows, columns and tabs ----

  const menuActions = (target: GridTarget) => {
    const rect = selectionRect(selection, dims);
    const rowCount = rect.r2 - rect.r1 + 1;
    const colCount = rect.c2 - rect.c1 + 1;
    const plural = (n: number, word: string) => (n === 1 ? `1 ${word}` : `${n} ${word}s`);
    const items: Array<{ label: string; run: () => void; danger?: boolean } | "sep"> = [];
    const sheet = active.id;
    if (target.kind !== "column") {
      items.push(
        { label: `Insert ${plural(rowCount, "row")} above`, run: () => send([{ kind: "insertRows", sheet, besideRow: rect.r1 + 1, side: "before", count: rowCount }], { undoable: false }) },
        { label: `Insert ${plural(rowCount, "row")} below`, run: () => send([{ kind: "insertRows", sheet, besideRow: rect.r2 + 1, side: "after", count: rowCount }], { undoable: false }) },
        { label: `Delete ${rowCount === 1 ? `row ${rect.r1 + 1}` : `rows ${rect.r1 + 1}-${rect.r2 + 1}`}`, danger: true, run: () => send([{ kind: "deleteRows", sheet, rows: [`${rect.r1 + 1}:${rect.r2 + 1}`] }], { undoable: false }) },
      );
    }
    if (target.kind === "row") {
      const frozen = active.settings.lastFrozenRow;
      items.push("sep", {
        label: frozen === rect.r2 + 1 ? "Unfreeze rows" : `Freeze up to row ${rect.r2 + 1}`,
        run: () => send([{ kind: "setSheetSettings", sheet, settings: { lastFrozenRow: frozen === rect.r2 + 1 ? 0 : rect.r2 + 1 } }], { undoable: false }),
      });
    }
    if (target.kind !== "row") {
      if (items.length > 0) items.push("sep");
      const first = columnToLetters(rect.c1);
      const last = columnToLetters(rect.c2);
      items.push(
        { label: `Insert ${plural(colCount, "column")} left`, run: () => send([{ kind: "insertColumns", sheet, besideColumn: first, side: "before", count: colCount }], { undoable: false }) },
        { label: `Insert ${plural(colCount, "column")} right`, run: () => send([{ kind: "insertColumns", sheet, besideColumn: last, side: "after", count: colCount }], { undoable: false }) },
        { label: `Delete ${colCount === 1 ? `column ${first}` : `columns ${first}-${last}`}`, danger: true, run: () => send([{ kind: "deleteColumns", sheet, columns: [colCount === 1 ? first : `${first}:${last}`] }], { undoable: false }) },
      );
      const frozenRow = active.settings.lastFrozenRow;
      const lastRow = storedExtent(active).row;
      const sortable = lastRow >= frozenRow;
      const sort = (direction: "ascending" | "descending") =>
        send([{ kind: "sortRows", sheet, rows: [`${frozenRow + 1}:${lastRow + 1}`], byColumn: first, direction }], { undoable: false });
      items.push("sep");
      if (sortable) {
        items.push(
          { label: `Sort sheet A to Z by ${first}`, run: () => sort("ascending") },
          { label: `Sort sheet Z to A by ${first}`, run: () => sort("descending") },
        );
      }
      if (target.kind === "column") {
        const frozen = active.settings.lastFrozenColumn;
        items.push({
          label: frozen === rect.c2 + 1 ? "Unfreeze columns" : `Freeze up to column ${last}`,
          run: () => send([{ kind: "setSheetSettings", sheet, settings: { lastFrozenColumn: frozen === rect.c2 + 1 ? 0 : rect.c2 + 1 } }], { undoable: false }),
        });
      }
    }
    return items;
  };

  const onContextMenu = (target: GridTarget, x: number, y: number) => {
    if (draft) finishDraft(null);
    if (target.kind === "corner") return;
    const rect = selectionRect(selection, dims);
    if (target.kind === "cell" && !(target.row >= rect.r1 && target.row <= rect.r2 && target.col >= rect.c1 && target.col <= rect.c2)) {
      setSelection(active.id, cellSelection(target));
    } else if (target.kind === "row" && !(selection.kind === "rows" && target.row >= rect.r1 && target.row <= rect.r2)) {
      setSelection(active.id, headerSelection(selection, "rows", target.row, false, dims));
    } else if (target.kind === "column" && !(selection.kind === "columns" && target.col >= rect.c1 && target.col <= rect.c2)) {
      setSelection(active.id, headerSelection(selection, "columns", target.col, false, dims));
    }
    setMenu({ target, x, y });
  };

  const addTab = () => {
    const names = new Set(workbook.sheets.map((sheet) => sheet.name.toLowerCase()));
    let n = workbook.sheets.length + 1;
    while (names.has(`sheet${n}`)) n += 1;
    const before = new Set(workbook.sheets.map((sheet) => sheet.id));
    const applied = sync.apply([{ kind: "addSheet", name: `Sheet${n}` }]);
    if (isRefusal(applied)) {
      onNotice(applied.detail);
      return;
    }
    const added = applied.workbook.sheets.find((sheet) => !before.has(sheet.id));
    if (added) props.onTabChange(added.id);
  };

  const selectTab = (sheetId: string) => {
    if (draft && draft.text.startsWith("=")) {
      // Typing a formula: show the other tab to point at its cells. The in-cell
      // editor is not on that tab, so the formula bar takes the caret.
      if (draft.where === "cell") {
        caretAfter.current = caretOf();
        setDraft({ ...draft, where: "bar" });
      }
      props.onTabChange(sheetId);
      return;
    }
    if (draft) finishDraft(null);
    props.onTabChange(sheetId);
    focusGrid();
  };

  // ---- what the grid draws ----

  const editingHere = draft !== null && draft.sheetId === active.id;
  const refOutlines = useMemo(() => {
    if (!draft || !draftSheet) return [];
    return formulaRefSpans(draft.text).flatMap((span) => {
      const rect = refRect(span.ref, active.name, draftSheet.name, dims);
      return rect ? [{ rect, color: span.color }] : [];
    });
  }, [draft, draftSheet, active.name, dims.rows, dims.cols]);

  const pointRect =
    draft?.point && draft.pointSheetId === active.id ? selectionRect(draft.point, dims) : null;

  const editor =
    editingHere && draft
      ? {
          row: draft.row,
          col: draft.col,
          node: (
            <FormulaInput
              className="sheet-cell-editor"
              ariaLabel="Cell contents"
              inputRef={cellInput}
              value={draft.text}
              onChange={onDraftChange}
              onKeyDown={onDraftKey}
              onFocus={() => {
                if (draft.where !== "cell") setDraft({ ...draft, where: "cell" });
              }}
            />
          ),
        }
      : null;

  const [nameBox, setNameBox] = useState<string | null>(null);
  const label = selectionLabel(selection, dims);
  const activeLabel = draft
    ? formatArea({ startRow: draft.row, startCol: draft.col, endRow: draft.row, endCol: draft.col })
    : label;

  const nextDecimals = (direction: -1 | 1) => {
    const pattern = activeView.pattern;
    const next =
      direction > 0 ? increaseDecimals(pattern, activeView.value) : decreaseDecimals(pattern, activeView.value);
    applyFormat({ numberFormat: { pattern: next } });
  };

  return (
    <div className="sheet-workbook">
      <div className="sheet-formula-row">
        <input
          className="sheet-name-box"
          aria-label="Name box"
          spellCheck={false}
          value={nameBox ?? activeLabel}
          onFocus={(event) => {
            setNameBox(activeLabel);
            event.currentTarget.select();
          }}
          onChange={(event) => setNameBox(event.target.value)}
          onBlur={() => setNameBox(null)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setNameBox(null);
              focusGrid();
            }
            if (event.key !== "Enter") return;
            const picked = selectionFromLabel(nameBox ?? "", dims);
            setNameBox(null);
            if (picked) setSelection(active.id, picked);
            else onNotice(`"${nameBox}" is not a cell or range on this tab.`);
            focusGrid();
          }}
        />
        <span className="sheet-fx" aria-hidden="true">
          fx
        </span>
        <FormulaInput
          className="sheet-formula-bar"
          ariaLabel="Formula bar"
          inputRef={barInput}
          value={draft ? draft.text : activeView.input}
          onChange={(text) => {
            if (draft) onDraftChange(text);
            else startDraft("edit", text, "bar");
          }}
          onKeyDown={(event) => {
            if (draft) onDraftKey(event);
            else if (event.key === "Enter" || event.key === "Escape") focusGrid();
          }}
          onFocus={() => {
            if (!draft) startDraft("edit", activeView.input, "bar");
            else if (draft.where !== "bar") setDraft({ ...draft, where: "bar" });
          }}
        />
      </div>

      <div className="sheet-grid-wrap">
        <Grid
          workbook={workbook}
          sheet={active}
          selection={selection}
          showSelection={!(draft?.point && draft.pointSheetId === active.id) && (draft === null || editingHere)}
          pointRect={pointRect}
          refOutlines={refOutlines}
          overlays={props.overlays.filter((overlay) => overlay.sheetId === active.id)}
          flashes={props.flashes.get(active.id)}
          copyRect={copy && copy.sheetId === active.id ? copy.rect : null}
          editor={editor}
          scrollerRef={scrollerRef}
          onPointer={onPointer}
          onDoubleClick={(row, col) => {
            setSelection(active.id, cellSelection({ row, col }));
            const input = viewCell(workbook, active.id, row, col).input;
            setDraft({ sheetId: active.id, row, col, text: input, original: input, mode: "edit", where: "cell", pointing: null, point: null, pointSheetId: null });
            caretAfter.current = input.length;
          }}
          onContextMenu={onContextMenu}
          onResizeColumn={(col, width) => {
            const rect = selectionRect(selection, dims);
            const columns =
              selection.kind === "columns" && col >= rect.c1 && col <= rect.c2
                ? [`${columnToLetters(rect.c1)}:${columnToLetters(rect.c2)}`]
                : [columnToLetters(col)];
            send([{ kind: "setColumnWidths", sheet: active.id, columns, widthInPixels: width }], { undoable: false });
          }}
          onKeyDown={onGridKey}
        />
        <Toolbar
          format={activeView.format}
          onFormat={applyFormat}
          onNumberFormat={(pattern) => applyFormat({ numberFormat: pattern === null ? null : { pattern } })}
          onDecimals={nextDecimals}
        />
      </div>

      <TabsBar
        sheets={workbook.sheets}
        activeId={active.id}
        onSelect={selectTab}
        onAdd={addTab}
        onRename={(sheetId, name) => send([{ kind: "renameSheet", sheet: sheetId, name }], { undoable: false })}
        onDelete={(sheetId) => {
          const sheet = workbook.sheets.find((candidate) => candidate.id === sheetId);
          if (!sheet || !window.confirm(`Delete the tab "${sheet.name}" for everyone? Formulas that use it will show #REF!.`)) return;
          send([{ kind: "deleteSheet", sheet: sheetId }], { undoable: false });
        }}
        onMove={(sheetId, afterId) => send([{ kind: "moveSheets", sheets: [sheetId], afterSheet: afterId }], { undoable: false })}
      />

      {menu ? (
        <div className="sheet-menu-backdrop" onPointerDown={() => setMenu(null)} onContextMenu={(event) => { event.preventDefault(); setMenu(null); }}>
          <div
            className="sheet-context-menu"
            role="menu"
            style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 320) }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {menuActions(menu.target).map((item, index) =>
              item === "sep" ? (
                <div key={`sep-${index}`} className="sheet-menu-sep" />
              ) : (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className={`sheet-menu-item${item.danger ? " danger" : ""}`}
                  onClick={() => {
                    setMenu(null);
                    item.run();
                    focusGrid();
                  }}
                >
                  {item.label}
                </button>
              ),
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
