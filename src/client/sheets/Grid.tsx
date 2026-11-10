import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { columnToLetters } from "../../shared/sheet/address.ts";
import { cellKey, type CellFormat, type Sheet, type Workbook } from "../../shared/sheet/types.ts";
import { viewCell } from "../../shared/sheet/workbook.ts";
import { cellStyle, columnAxis, rowAxis } from "./layout.ts";
import { selectionRect, type Rect, type Selection } from "./selection.ts";

export const HEADER_WIDTH = 46;
export const HEADER_HEIGHT = 24;
const OVERSCAN_ROWS = 6;
const OVERSCAN_COLS = 2;
/** The rendered window moves in blocks, so most scroll frames only move a transform. */
const ROW_BLOCK = 8;
const COL_BLOCK = 4;

/**
 * Something drawn over cells: a range outline with an optional name tag.
 * Seam for live presence (S4): remote cursors are overlays with the person's
 * colour and name as `label`, passed in `GridProps.overlays`.
 */
export interface GridOverlay {
  readonly key: string;
  /** The tab it is drawn on. */
  readonly sheetId: string;
  readonly rect: Rect;
  readonly color: string;
  readonly label?: string;
}

export type GridTarget =
  | { readonly kind: "cell"; readonly row: number; readonly col: number }
  | { readonly kind: "row"; readonly row: number }
  | { readonly kind: "column"; readonly col: number }
  | { readonly kind: "corner" };

export interface PointerInfo {
  readonly shift: boolean;
  readonly mod: boolean;
  /** Keeps focus where it is (the formula being typed). */
  readonly preventDefault: () => void;
}

export interface GridProps {
  readonly workbook: Workbook;
  readonly sheet: Sheet;
  readonly selection: Selection;
  /** False while a formula is being pointed at: no active-cell box then. */
  readonly showSelection: boolean;
  /** The range being picked for a formula. */
  readonly pointRect: Rect | null;
  /** The references of the formula being typed. */
  readonly refOutlines: ReadonlyArray<{ readonly rect: Rect; readonly color: string }>;
  readonly overlays: ReadonlyArray<GridOverlay>;
  /** Cells an agent just changed, by `cellKey`. */
  readonly flashes: ReadonlySet<number> | undefined;
  readonly copyRect: Rect | null;
  /** The in-cell editor, placed over its cell. */
  readonly editor: { readonly row: number; readonly col: number; readonly node: ReactNode } | null;
  readonly scrollerRef: RefObject<HTMLDivElement | null>;
  readonly onPointer: (target: GridTarget, phase: "down" | "drag", info: PointerInfo) => void;
  readonly onDoubleClick: (row: number, col: number) => void;
  readonly onContextMenu: (target: GridTarget, x: number, y: number) => void;
  readonly onResizeColumn: (col: number, width: number) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

interface Window {
  readonly r0: number;
  readonly r1: number;
  readonly c0: number;
  readonly c1: number;
}

type Align = "left" | "center" | "right";

const Cell = memo(function Cell(props: {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly shown: string;
  readonly align: Align;
  readonly wrap: boolean;
  readonly spill: boolean;
  readonly error: boolean;
  readonly format: CellFormat | undefined;
}) {
  const style: CSSProperties = {
    left: props.left,
    top: props.top,
    width: props.width,
    height: props.height,
    textAlign: props.align,
    ...cellStyle(props.format),
  };
  const className = `sheet-cell${props.wrap ? " wrap" : ""}${props.spill ? " spill" : ""}${props.error ? " error" : ""}`;
  return (
    <div className={className} style={style}>
      {props.shown === "" ? null : <span className="sheet-cell-text">{props.shown}</span>}
    </div>
  );
});

function cellAlign(value: unknown, format: CellFormat | undefined): Align {
  const explicit = format?.alignment?.horizontal;
  if (explicit) return explicit;
  if (typeof value === "number") return "right";
  if (typeof value === "boolean" || (value !== null && typeof value === "object")) return "center";
  return "left";
}

interface PaneSpec {
  readonly key: string;
  readonly rows: readonly [number, number];
  readonly cols: readonly [number, number];
  /** Grid pixel where the pane starts. */
  readonly x0: number;
  readonly y0: number;
  readonly scrollsX: boolean;
  readonly scrollsY: boolean;
  /** Where the pane sits in the viewport. */
  readonly box: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
}

/**
 * The virtualised grid: headers, frozen rows and columns, cells, and the
 * layers drawn over them (selection, formula references, agent flashes,
 * overlays). Only the visible window of cells is in the page; scrolling moves
 * a transform and swaps cells in blocks.
 */
export function Grid(props: GridProps) {
  const { sheet, workbook } = props;
  const rows = useMemo(() => rowAxis(sheet), [sheet.rowCount, sheet.rowHeights]);
  const cols = useMemo(() => columnAxis(sheet), [sheet.columnCount, sheet.columnWidths]);
  const frozenRows = Math.min(sheet.settings.lastFrozenRow, sheet.rowCount);
  const frozenCols = Math.min(sheet.settings.lastFrozenColumn, sheet.columnCount);
  const frozenHeight = rows.start(frozenRows);
  const frozenWidth = cols.start(frozenCols);

  const scrollerRef = props.scrollerRef;
  const viewportRef = useRef<HTMLDivElement>(null);
  const scroll = useRef({ x: 0, y: 0 });
  const [size, setSize] = useState({ width: 800, height: 500 });
  const movers = useRef(new Map<string, { el: HTMLDivElement; x: boolean; y: boolean }>());

  const windowAt = useCallback(
    (x: number, y: number): Window => {
      const visibleW = Math.max(0, size.width - HEADER_WIDTH - frozenWidth);
      const visibleH = Math.max(0, size.height - HEADER_HEIGHT - frozenHeight);
      const lastRow = sheet.rowCount - 1;
      const lastCol = sheet.columnCount - 1;
      const r0 = rows.indexAt(frozenHeight + y) - OVERSCAN_ROWS;
      const r1 = rows.indexAt(frozenHeight + y + visibleH) + OVERSCAN_ROWS;
      const c0 = cols.indexAt(frozenWidth + x) - OVERSCAN_COLS;
      const c1 = cols.indexAt(frozenWidth + x + visibleW) + OVERSCAN_COLS;
      return {
        r0: Math.max(frozenRows, Math.floor(r0 / ROW_BLOCK) * ROW_BLOCK),
        r1: Math.min(lastRow, Math.ceil((r1 + 1) / ROW_BLOCK) * ROW_BLOCK - 1),
        c0: Math.max(frozenCols, Math.floor(c0 / COL_BLOCK) * COL_BLOCK),
        c1: Math.min(lastCol, Math.ceil((c1 + 1) / COL_BLOCK) * COL_BLOCK - 1),
      };
    },
    [size, rows, cols, frozenRows, frozenCols, frozenHeight, frozenWidth, sheet.rowCount, sheet.columnCount],
  );
  const [win, setWin] = useState<Window>(() => windowAt(0, 0));

  const placeMovers = useCallback(() => {
    const { x, y } = scroll.current;
    for (const { el, x: mx, y: my } of movers.current.values()) {
      el.style.transform = `translate(${mx ? -x : 0}px, ${my ? -y : 0}px)`;
    }
  }, []);

  const refresh = useCallback(() => {
    const next = windowAt(scroll.current.x, scroll.current.y);
    setWin((current) =>
      current.r0 === next.r0 && current.r1 === next.r1 && current.c0 === next.c0 && current.c1 === next.c1
        ? current
        : next,
    );
  }, [windowAt]);

  useLayoutEffect(() => {
    placeMovers();
    refresh();
  });

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollerRef]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    scroll.current = { x: el.scrollLeft, y: el.scrollTop };
    placeMovers();
    refresh();
  };

  // Keep the cell the keyboard moved to in sight.
  const { focus, kind } = props.selection;
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const visibleH = el.clientHeight - HEADER_HEIGHT - frozenHeight;
    const visibleW = el.clientWidth - HEADER_WIDTH - frozenWidth;
    if (kind !== "columns" && focus.row >= frozenRows) {
      const top = rows.start(focus.row) - frozenHeight;
      const bottom = rows.start(focus.row + 1) - frozenHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + visibleH) el.scrollTop = bottom - visibleH;
    }
    if (kind !== "rows" && focus.col >= frozenCols) {
      const left = cols.start(focus.col) - frozenWidth;
      const right = cols.start(focus.col + 1) - frozenWidth;
      if (left < el.scrollLeft) el.scrollLeft = left;
      else if (right > el.scrollLeft + visibleW) el.scrollLeft = Math.max(0, right - visibleW);
    }
  }, [focus.row, focus.col, kind, rows, cols, frozenRows, frozenCols, frozenHeight, frozenWidth, scrollerRef]);

  const targetAt = (clientX: number, clientY: number): GridTarget => {
    const box = viewportRef.current?.getBoundingClientRect();
    const x = clientX - (box?.left ?? 0);
    const y = clientY - (box?.top ?? 0);
    const gx = x - HEADER_WIDTH;
    const gy = y - HEADER_HEIGHT;
    const col = gx < frozenWidth ? cols.indexAt(gx) : cols.indexAt(gx + scroll.current.x);
    const row = gy < frozenHeight ? rows.indexAt(gy) : rows.indexAt(gy + scroll.current.y);
    if (x < HEADER_WIDTH && y < HEADER_HEIGHT) return { kind: "corner" };
    if (x < HEADER_WIDTH) return { kind: "row", row };
    if (y < HEADER_HEIGHT) return { kind: "column", col };
    return { kind: "cell", row, col };
  };

  // Mouse: press selects, dragging extends. Touch: a tap selects, a drag scrolls.
  const drag = useRef<{ pointerId: number; touch: boolean; x: number; y: number; target: GridTarget } | null>(
    null,
  );
  const info = (event: PointerEvent): PointerInfo => ({
    shift: event.shiftKey,
    mod: event.metaKey || event.ctrlKey,
    preventDefault: () => event.preventDefault(),
  });
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest(".sheet-editor-box, .sheet-col-resize")) return;
    if (event.button === 2) return;
    const target = targetAt(event.clientX, event.clientY);
    const touch = event.pointerType === "touch";
    drag.current = { pointerId: event.pointerId, touch, x: event.clientX, y: event.clientY, target };
    if (touch) return;
    props.onPointer(target, "down", info(event));
    viewportRef.current?.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || current.touch) return;
    const el = scrollerRef.current;
    const box = viewportRef.current?.getBoundingClientRect();
    if (el && box) {
      // Dragging past an edge scrolls on.
      if (event.clientY > box.bottom - 16) el.scrollTop += 24;
      else if (event.clientY < box.top + HEADER_HEIGHT + frozenHeight && scroll.current.y > 0) el.scrollTop -= 24;
      if (event.clientX > box.right - 16) el.scrollLeft += 24;
      else if (event.clientX < box.left + HEADER_WIDTH + frozenWidth && scroll.current.x > 0) el.scrollLeft -= 24;
    }
    props.onPointer(targetAt(event.clientX, event.clientY), "drag", info(event));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    drag.current = null;
    if (!current || !current.touch) return;
    if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 8) {
      props.onPointer(current.target, "down", info(event));
    }
  };

  // Column resize by dragging the header's right edge.
  const [resizing, setResizing] = useState<{ col: number; width: number } | null>(null);
  const startResize = (col: number) => (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = cols.size(col);
    let width = startWidth;
    setResizing({ col, width });
    const move = (e: globalThis.PointerEvent) => {
      width = Math.max(24, Math.min(2000, Math.round(startWidth + e.clientX - startX)));
      setResizing({ col, width });
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      setResizing(null);
      if (width !== startWidth) props.onResizeColumn(col, width);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const rect = selectionRect(props.selection, { rows: sheet.rowCount, cols: sheet.columnCount });
  const restW = Math.max(0, size.width - HEADER_WIDTH - frozenWidth);
  const restH = Math.max(0, size.height - HEADER_HEIGHT - frozenHeight);
  const scrollRows: readonly [number, number] = [win.r0, win.r1];
  const scrollCols: readonly [number, number] = [win.c0, win.c1];
  const fixedRows: readonly [number, number] = [0, frozenRows - 1];
  const fixedCols: readonly [number, number] = [0, frozenCols - 1];

  const panes: PaneSpec[] = [
    {
      key: "main",
      rows: scrollRows,
      cols: scrollCols,
      x0: frozenWidth,
      y0: frozenHeight,
      scrollsX: true,
      scrollsY: true,
      box: { left: HEADER_WIDTH + frozenWidth, top: HEADER_HEIGHT + frozenHeight, width: restW, height: restH },
    },
  ];
  if (frozenRows > 0) {
    panes.push({
      key: "top",
      rows: fixedRows,
      cols: scrollCols,
      x0: frozenWidth,
      y0: 0,
      scrollsX: true,
      scrollsY: false,
      box: { left: HEADER_WIDTH + frozenWidth, top: HEADER_HEIGHT, width: restW, height: frozenHeight },
    });
  }
  if (frozenCols > 0) {
    panes.push({
      key: "left",
      rows: scrollRows,
      cols: fixedCols,
      x0: 0,
      y0: frozenHeight,
      scrollsX: false,
      scrollsY: true,
      box: { left: HEADER_WIDTH, top: HEADER_HEIGHT + frozenHeight, width: frozenWidth, height: restH },
    });
  }
  if (frozenRows > 0 && frozenCols > 0) {
    panes.push({
      key: "corner",
      rows: fixedRows,
      cols: fixedCols,
      x0: 0,
      y0: 0,
      scrollsX: false,
      scrollsY: false,
      box: { left: HEADER_WIDTH, top: HEADER_HEIGHT, width: frozenWidth, height: frozenHeight },
    });
  }

  const mover = (key: string, x: boolean, y: boolean) => (el: HTMLDivElement | null) => {
    if (el) {
      movers.current.set(key, { el, x, y });
      el.style.transform = `translate(${x ? -scroll.current.x : 0}px, ${y ? -scroll.current.y : 0}px)`;
    } else movers.current.delete(key);
  };

  const boxStyle = (r: Rect, pane: PaneSpec): CSSProperties => ({
    left: cols.start(r.c1) - pane.x0,
    top: rows.start(r.r1) - pane.y0,
    width: cols.start(r.c2 + 1) - cols.start(r.c1),
    height: rows.start(r.r2 + 1) - rows.start(r.r1),
  });
  const intersects = (r: Rect, pane: PaneSpec) =>
    r.r2 >= pane.rows[0] && r.r1 <= pane.rows[1] && r.c2 >= pane.cols[0] && r.c1 <= pane.cols[1];

  const renderCells = (pane: PaneSpec, out: ReactNode[]) => {
    const [r0, r1] = pane.rows;
    const [c0, c1] = pane.cols;
    for (let row = r0; row <= r1; row++) {
      const top = rows.start(row) - pane.y0;
      const height = rows.size(row);
      for (let col = c0; col <= c1; col++) {
        const view = viewCell(workbook, sheet.id, row, col);
        const align = cellAlign(view.value, view.format);
        const wrap = view.format?.alignment?.wrap === true;
        const next = sheet.cells.get(cellKey(row, col + 1));
        const spill =
          !wrap && align === "left" && view.shown !== "" && typeof view.value === "string" && !next?.input;
        out.push(
          <Cell
            key={`${row}:${col}`}
            left={cols.start(col) - pane.x0}
            top={top}
            width={cols.size(col)}
            height={height}
            shown={view.shown}
            align={align}
            wrap={wrap}
            spill={spill}
            error={view.value !== null && typeof view.value === "object"}
            format={view.format}
          />,
        );
      }
    }
  };

  const renderLayers = (pane: PaneSpec, out: ReactNode[]) => {
    if (props.flashes && props.flashes.size > 0) {
      for (const key of props.flashes) {
        const row = Math.floor(key / 32768);
        const col = key % 32768;
        const cell = { r1: row, c1: col, r2: row, c2: col };
        if (intersects(cell, pane)) {
          out.push(<div key={`flash-${key}`} className="sheet-flash" style={boxStyle(cell, pane)} />);
        }
      }
    }
    if (props.showSelection) {
      if (intersects(rect, pane) && (rect.r1 !== rect.r2 || rect.c1 !== rect.c2)) {
        out.push(<div key="range" className="sheet-range" style={boxStyle(rect, pane)} />);
      }
      const active = { r1: props.selection.anchor.row, c1: props.selection.anchor.col, r2: props.selection.anchor.row, c2: props.selection.anchor.col };
      if (intersects(active, pane)) {
        out.push(<div key="active" className="sheet-active" style={boxStyle(active, pane)} />);
      }
    }
    props.refOutlines.forEach((outline, index) => {
      if (!intersects(outline.rect, pane)) return;
      out.push(
        <div
          key={`ref-${index}`}
          className="sheet-ref"
          style={{ ...boxStyle(outline.rect, pane), borderColor: outline.color, background: `${outline.color}14` }}
        />,
      );
    });
    if (props.pointRect && intersects(props.pointRect, pane)) {
      out.push(<div key="point" className="sheet-point" style={boxStyle(props.pointRect, pane)} />);
    }
    if (props.copyRect && intersects(props.copyRect, pane)) {
      out.push(<div key="copy" className="sheet-copy" style={boxStyle(props.copyRect, pane)} />);
    }
    // Overlay layer (S4 draws remote cursors and name tags here).
    for (const overlay of props.overlays) {
      if (!intersects(overlay.rect, pane)) continue;
      out.push(
        <div
          key={`overlay-${overlay.key}`}
          className="sheet-overlay"
          style={{ ...boxStyle(overlay.rect, pane), borderColor: overlay.color }}
        >
          {overlay.label ? (
            <span className="sheet-overlay-label" style={{ background: overlay.color }}>
              {overlay.label}
            </span>
          ) : null}
        </div>,
      );
    }
    const editor = props.editor;
    if (editor) {
      const cell = { r1: editor.row, c1: editor.col, r2: editor.row, c2: editor.col };
      const inRows = pane.scrollsY ? editor.row >= frozenRows : editor.row < frozenRows;
      const inCols = pane.scrollsX ? editor.col >= frozenCols : editor.col < frozenCols;
      if (inRows && inCols) {
        const style = boxStyle(cell, pane);
        out.push(
          <div
            key="editor"
            className="sheet-editor-box"
            style={{ left: style.left, top: style.top, minWidth: style.width, minHeight: style.height }}
          >
            {editor.node}
          </div>,
        );
      }
    }
  };

  const columnHeaders = (range: readonly [number, number], x0: number, out: ReactNode[]) => {
    for (let col = range[0]; col <= range[1]; col++) {
      const picked = col >= rect.c1 && col <= rect.c2;
      const whole = props.selection.kind === "columns" && picked;
      out.push(
        <div
          key={col}
          className={`sheet-col-header${picked ? " picked" : ""}${whole ? " whole" : ""}`}
          style={{ left: cols.start(col) - x0, width: cols.size(col) }}
        >
          {columnToLetters(col)}
          <div className="sheet-col-resize" onPointerDown={startResize(col)} />
        </div>,
      );
    }
  };
  const rowHeaders = (range: readonly [number, number], y0: number, out: ReactNode[]) => {
    for (let row = range[0]; row <= range[1]; row++) {
      const picked = row >= rect.r1 && row <= rect.r2;
      const whole = props.selection.kind === "rows" && picked;
      out.push(
        <div
          key={row}
          className={`sheet-row-header${picked ? " picked" : ""}${whole ? " whole" : ""}`}
          style={{ top: rows.start(row) - y0, height: rows.size(row) }}
        >
          {row + 1}
        </div>,
      );
    }
  };

  const colHeadFixed: ReactNode[] = [];
  const colHeadScroll: ReactNode[] = [];
  const rowHeadFixed: ReactNode[] = [];
  const rowHeadScroll: ReactNode[] = [];
  if (frozenCols > 0) columnHeaders(fixedCols, 0, colHeadFixed);
  columnHeaders(scrollCols, frozenWidth, colHeadScroll);
  if (frozenRows > 0) rowHeaders(fixedRows, 0, rowHeadFixed);
  rowHeaders(scrollRows, frozenHeight, rowHeadScroll);

  const resizeGuide =
    resizing === null
      ? null
      : HEADER_WIDTH +
        (resizing.col < frozenCols
          ? cols.start(resizing.col)
          : cols.start(resizing.col) - scroll.current.x) +
        resizing.width;

  return (
    <div
      ref={scrollerRef}
      className={`sheet-scroller${sheet.settings.areGridlinesHidden ? " no-gridlines" : ""}`}
      tabIndex={0}
      role="grid"
      aria-label={`${sheet.name} cells`}
      aria-rowcount={sheet.rowCount}
      aria-colcount={sheet.columnCount}
      onScroll={onScroll}
      onKeyDown={props.onKeyDown}
    >
      <div
        ref={viewportRef}
        className="sheet-viewport"
        style={{ width: size.width, height: size.height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest(".sheet-editor-box, .sheet-col-resize")) return;
          const target = targetAt(event.clientX, event.clientY);
          if (target.kind === "cell") props.onDoubleClick(target.row, target.col);
        }}
        onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest(".sheet-editor-box")) return;
          event.preventDefault();
          props.onContextMenu(targetAt(event.clientX, event.clientY), event.clientX, event.clientY);
        }}
      >
        {panes.map((pane) => {
          const out: ReactNode[] = [];
          renderCells(pane, out);
          renderLayers(pane, out);
          return (
            <div key={pane.key} className={`sheet-pane sheet-pane-${pane.key}`} style={pane.box}>
              <div className="sheet-pane-inner" ref={mover(pane.key, pane.scrollsX, pane.scrollsY)}>
                {out}
              </div>
            </div>
          );
        })}
        <div className="sheet-headers-col" style={{ left: HEADER_WIDTH, width: size.width - HEADER_WIDTH }}>
          {frozenCols > 0 ? (
            <div className="sheet-pane" style={{ left: 0, top: 0, width: frozenWidth, height: HEADER_HEIGHT }}>
              {colHeadFixed}
            </div>
          ) : null}
          <div className="sheet-pane" style={{ left: frozenWidth, top: 0, width: restW, height: HEADER_HEIGHT }}>
            <div className="sheet-pane-inner" ref={mover("colhead", true, false)}>
              {colHeadScroll}
            </div>
          </div>
        </div>
        <div className="sheet-headers-row" style={{ top: HEADER_HEIGHT, height: size.height - HEADER_HEIGHT }}>
          {frozenRows > 0 ? (
            <div className="sheet-pane" style={{ left: 0, top: 0, width: HEADER_WIDTH, height: frozenHeight }}>
              {rowHeadFixed}
            </div>
          ) : null}
          <div className="sheet-pane" style={{ left: 0, top: frozenHeight, width: HEADER_WIDTH, height: restH }}>
            <div className="sheet-pane-inner" ref={mover("rowhead", false, true)}>
              {rowHeadScroll}
            </div>
          </div>
        </div>
        <div className="sheet-corner" />
        {frozenRows > 0 ? (
          <div className="sheet-freeze-line horizontal" style={{ top: HEADER_HEIGHT + frozenHeight - 1 }} />
        ) : null}
        {frozenCols > 0 ? (
          <div className="sheet-freeze-line vertical" style={{ left: HEADER_WIDTH + frozenWidth - 1 }} />
        ) : null}
        {resizeGuide !== null ? <div className="sheet-resize-guide" style={{ left: resizeGuide }} /> : null}
      </div>
      <div
        aria-hidden="true"
        style={{
          width: HEADER_WIDTH + cols.total,
          height: HEADER_HEIGHT + rows.total,
          marginTop: -size.height,
        }}
      />
    </div>
  );
}
