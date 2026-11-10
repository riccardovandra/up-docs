// Who else has the sheet open, and where: the room's presence messages folded
// into state, and that state turned into grid outlines and top-bar avatars.
// Pure, so it is tested without a socket or a browser.

import { formatCellAddress } from "../../shared/sheet/address.ts";
import type { CellPosition } from "../../shared/sheet/types.ts";
import type { SheetAuthor, SheetPresence, SheetRoomMessage } from "../../shared/sheets.ts";
import type { GridOverlay } from "./Grid.tsx";
import { selectionFromLabel, selectionLabel, selectionRect, type Dims, type Rect, type Selection } from "./selection.ts";

export interface PresenceState {
  /** This page, as the room knows it; null before the first snapshot. */
  readonly self: SheetPresence | null;
  /** Every other open page, by connection id. */
  readonly others: ReadonlyMap<string, SheetPresence>;
}

export const EMPTY_PRESENCE: PresenceState = { self: null, others: new Map() };

/** Folds one room message into the state; messages that are not presence leave it as it is. */
export function presenceReducer(state: PresenceState, message: SheetRoomMessage): PresenceState {
  switch (message.type) {
    case "sheet.presence.snapshot":
      // A snapshot comes with every (re)connect and replaces what was known.
      return {
        self: message.self,
        others: new Map(
          message.presences
            .filter((presence) => presence.connectionId !== message.self.connectionId)
            .map((presence) => [presence.connectionId, presence]),
        ),
      };
    case "sheet.presence": {
      const { type: _type, ...presence } = message;
      if (presence.connectionId === state.self?.connectionId) return state;
      const others = new Map(state.others);
      others.set(presence.connectionId, presence);
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

/** A palette colour from the theme tokens in sheets.css. */
export const presenceColor = (colorIndex: number) => `var(--sheet-person-${colorIndex})`;

export const personLabel = (name: string) => name.trim() || "Someone";

/** Outlines with name tags for everyone else's selection on tab `tabId`. */
export function presenceOverlays(state: PresenceState, tabId: string, dims: Dims): GridOverlay[] {
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
        ...(index === 0 ? { label } : {}),
      });
    });
  }
  return overlays;
}
