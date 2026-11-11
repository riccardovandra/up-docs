// Who else has the sheet open, and where: the room's presence messages folded
// into state, and that state turned into grid outlines and top-bar avatars.
// Pure, so it is tested without a socket or a browser.

import { formatCellAddress } from "../../shared/sheet/address.ts";
import type { CellPosition, Changes, Edit, Workbook } from "../../shared/sheet/types.ts";
import { findSheet } from "../../shared/sheet/workbook.ts";
import { PRESENCE_EXPIRY_MS, type SheetAuthor, type SheetPresence, type SheetRoomMessage } from "../../shared/sheets.ts";
import type { GridOverlay } from "./Grid.tsx";
import { touched } from "./undo.ts";
import { selectionFromLabel, selectionLabel, selectionRect, type Dims, type Rect, type Selection } from "./selection.ts";

/** Another page's presence, with when this page last heard of it and saw it move (local clock). */
export type RemotePresence = SheetPresence & {
  readonly heardAt: number;
  readonly movedAt: number;
};

export interface PresenceState {
  /** This page, as the room knows it; null before the first snapshot. */
  readonly self: SheetPresence | null;
  /** Every other open page, by connection id. */
  readonly others: ReadonlyMap<string, RemotePresence>;
}

export const EMPTY_PRESENCE: PresenceState = { self: null, others: new Map() };

/** A room message as it arrived (at `at`, local ms), or a clock tick that drops cursors gone silent. */
export type PresenceAction =
  | { readonly kind: "message"; readonly message: SheetRoomMessage; readonly at: number }
  | { readonly kind: "prune"; readonly now: number };

/** How long a remote cursor shows its name tag after it moves. */
export const PRESENCE_TAG_MS = 2500;

function stamped(previous: RemotePresence | undefined, presence: SheetPresence, at: number): RemotePresence {
  const still = previous && previous.tabId === presence.tabId && previous.range === presence.range;
  return { ...presence, heardAt: at, movedAt: still ? previous.movedAt : at };
}

/**
 * Folds one action into the state. Messages that are not presence leave it as
 * it is. A heartbeat (the same place again) refreshes `heardAt` but not
 * `movedAt`. Pruning drops pages not heard of for `PRESENCE_EXPIRY_MS`, so a
 * missed `left` cannot strand a cursor.
 */
export function presenceReducer(state: PresenceState, action: PresenceAction): PresenceState {
  if (action.kind === "prune") {
    let others: Map<string, RemotePresence> | null = null;
    for (const [id, presence] of state.others) {
      if (action.now - presence.heardAt < PRESENCE_EXPIRY_MS) continue;
      others ??= new Map(state.others);
      others.delete(id);
    }
    return others ? { ...state, others } : state;
  }
  const { message, at } = action;
  switch (message.type) {
    case "sheet.presence.snapshot":
      // A snapshot comes with every (re)connect and replaces what was known.
      return {
        self: message.self,
        others: new Map(
          message.presences
            .filter((presence) => presence.connectionId !== message.self.connectionId)
            .map((presence) => [
              presence.connectionId,
              stamped(state.others.get(presence.connectionId), presence, at),
            ]),
        ),
      };
    case "sheet.presence": {
      const { type: _type, ...presence } = message;
      if (presence.connectionId === state.self?.connectionId) return state;
      const others = new Map(state.others);
      others.set(presence.connectionId, stamped(state.others.get(presence.connectionId), presence, at));
      return { ...state, others };
    }
    case "sheet.presence.left": {
      if (!state.others.has(message.connectionId)) return state;
      const others = new Map(state.others);
      others.delete(message.connectionId);
      return { ...state, others };
    }
    default:
      return state;
  }
}

/** When the next name tag hides, or null when none is showing. */
export function nextTagChange(state: PresenceState, now: number): number | null {
  let next: number | null = null;
  for (const presence of state.others.values()) {
    const hideAt = presence.movedAt + PRESENCE_TAG_MS;
    if (hideAt > now && (next === null || hideAt < next)) next = hideAt;
  }
  return next;
}

/** A palette colour from the theme tokens in sheets.css. */
export const presenceColor = (colorIndex: number) => `var(--sheet-person-${colorIndex})`;

export const personLabel = (name: string) => name.trim() || "Someone";

/**
 * Outlines with name tags for everyone else's selection on tab `tabId`. A tag
 * shows for `PRESENCE_TAG_MS` after its cursor moves, then only on hover, so it
 * does not hide the cell above.
 */
export function presenceOverlays(state: PresenceState, tabId: string, dims: Dims, now: number): GridOverlay[] {
  const overlays: GridOverlay[] = [];
  for (const presence of state.others.values()) {
    if (presence.tabId !== tabId || !presence.range) continue;
    const selection = selectionFromLabel(presence.range, dims);
    if (!selection) continue;
    overlays.push({
      key: `presence-${presence.connectionId}`,
      sheetId: tabId,
      rect: selectionRect(selection, dims),
      color: presenceColor(presence.colorIndex),
      label: personLabel(presence.name),
      labelShown: now - presence.movedAt < PRESENCE_TAG_MS,
    });
  }
  return overlays;
}

export interface PresenceAvatar {
  readonly userId: string;
  readonly name: string;
  readonly colorIndex: number;
  readonly self: boolean;
}

/** One avatar per person: this page's person first, then the others in arrival order. */
export function presenceAvatars(state: PresenceState): PresenceAvatar[] {
  const avatars: PresenceAvatar[] = [];
  const seen = new Set<string>();
  const add = (presence: SheetPresence, self: boolean) => {
    if (seen.has(presence.userId)) return;
    seen.add(presence.userId);
    avatars.push({ userId: presence.userId, name: presence.name, colorIndex: presence.colorIndex, self });
  };
  if (state.self) add(state.self, true);
  for (const presence of state.others.values()) add(presence, false);
  return avatars;
}

/** What this page tells the room about its selection. */
export function presenceMessage(tabId: string, selection: Selection, dims: Dims) {
  return {
    type: "presence" as const,
    tabId,
    range: selectionLabel(selection, dims),
    activeCell: formatCellAddress(selection.anchor.row, selection.anchor.col),
  };
}

/** Beyond this many rectangles an agent's change is outlined by its bounding box. */
const MAX_AGENT_RECTS = 40;

/**
 * Rectangles covering a set of cells on one tab: runs along each row, stacked
 * where consecutive rows have the same run. A written block is one rectangle.
 */
export function cellRects(cells: ReadonlyArray<{ readonly row: number; readonly col: number }>): Rect[] {
  const sorted = [...cells].sort((a, b) => a.row - b.row || a.col - b.col);
  const runs: Rect[] = [];
  for (const cell of sorted) {
    const last = runs.at(-1);
    if (last && last.r1 === cell.row && last.c2 === cell.col - 1) {
      runs[runs.length - 1] = { ...last, c2: cell.col };
    } else if (!(last && last.r1 === cell.row && last.c2 >= cell.col)) {
      runs.push({ r1: cell.row, r2: cell.row, c1: cell.col, c2: cell.col });
    }
  }
  const rects: Rect[] = [];
  const open = new Map<string, number>();
  for (const run of runs) {
    const key = `${run.c1}:${run.c2}`;
    const index = open.get(key);
    const above = index === undefined ? undefined : rects[index];
    if (above && above.r2 === run.r1 - 1) {
      rects[index!] = { ...above, r2: run.r1 };
    } else {
      open.set(key, rects.length);
      rects.push(run);
    }
  }
  if (rects.length <= MAX_AGENT_RECTS) return rects;
  return [
    rects.reduce((box, rect) => ({
      r1: Math.min(box.r1, rect.r1),
      c1: Math.min(box.c1, rect.c1),
      r2: Math.max(box.r2, rect.r2),
      c2: Math.max(box.c2, rect.c2),
    })),
  ];
}

/** Edits after which a tab's earlier addresses no longer point at the same cells. */
const RESHAPING: ReadonlySet<Edit["kind"]> = new Set([
  "insertRows",
  "insertColumns",
  "deleteRows",
  "deleteColumns",
  "sortRows",
  "deleteSheet",
]);

/**
 * The cells an edit list changed, to flash and tag. The engine reports no cells
 * for a tab it rebuilt (rows or columns moved), so for those the list itself
 * says: its writes and formats after the tab's last reshaping edit, whose
 * addresses are final. Earlier ones are skipped: their cells have moved.
 */
export function changedCells(
  edits: ReadonlyArray<Edit>,
  workbook: Workbook,
  changed: Pick<Changes, "cells" | "rebuiltSheets">,
): CellPosition[] {
  const rebuilt = new Set(changed.rebuiltSheets);
  if (rebuilt.size === 0) return [...changed.cells];
  const cells = changed.cells.filter((cell) => !rebuilt.has(cell.sheetId));
  const sheetOf = (edit: Edit) => ("sheet" in edit && typeof edit.sheet === "string" ? findSheet(workbook, edit.sheet) : undefined);
  const lastReshape = new Map<string, number>();
  edits.forEach((edit, index) => {
    const sheet = RESHAPING.has(edit.kind) ? sheetOf(edit) : undefined;
    if (sheet) lastReshape.set(sheet.id, index);
  });
  const seen = new Set<string>();
  edits.forEach((edit, index) => {
    const area = touched(workbook, edit);
    if (!area || !rebuilt.has(area.sheetId) || index < (lastReshape.get(area.sheetId) ?? -1)) return;
    for (const rect of area.rects) {
      for (let row = rect.r1; row <= rect.r2; row++) {
        for (let col = rect.c1; col <= rect.c2; col++) {
          const key = `${area.sheetId}:${row}:${col}`;
          if (seen.has(key)) continue;
          seen.add(key);
          cells.push({ sheetId: area.sheetId, row, col });
        }
      }
    }
  });
  return cells;
}

/** Outlines for an agent's changed cells, its name tag on the first one of each tab. */
export function agentOverlays(id: string, by: SheetAuthor, cells: ReadonlyArray<CellPosition>): GridOverlay[] {
  const byTab = new Map<string, CellPosition[]>();
  for (const cell of cells) {
    const list = byTab.get(cell.sheetId);
    if (list) list.push(cell);
    else byTab.set(cell.sheetId, [cell]);
  }
  const label = by.name.trim() ? `${by.name.trim()} (agent)` : "Agent";
  const overlays: GridOverlay[] = [];
  for (const [tabId, list] of byTab) {
    cellRects(list).forEach((rect, index) => {
      overlays.push({
        key: `agent-${id}-${tabId}-${index}`,
        sheetId: tabId,
        rect,
        color: "var(--sheet-agent)",
        ...(index === 0 ? { label, labelShown: true } : {}),
      });
    });
  }
  return overlays;
}
