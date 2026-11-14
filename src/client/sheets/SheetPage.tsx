import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type MouseEvent } from "react";

import { workbookFromRecords } from "../../shared/sheet/serialize.ts";
import { PRESENCE_HEARTBEAT_MS, type SheetMeta } from "../../shared/sheets.ts";
import { ApiError, clientId } from "../api.ts";
import { HomeLink } from "../home/HomeLink.tsx";
import { TitleDialog } from "../home/TitleDialog.tsx";
import { useLockedProject } from "../lockedProject.ts";
import { forgetTab, setSheetTabTitle } from "../openTabs.ts";
import { navigate } from "../router.ts";
import type { GridOverlay } from "./Grid.tsx";
import {
  agentOverlays,
  changedCells,
  EMPTY_PRESENCE,
  nextTagChange,
  presenceAvatars,
  presenceMessage,
  presenceOverlays,
  presenceReducer,
} from "./presence.ts";
import { PresenceAvatars } from "./PresenceAvatars.tsx";
import type { Selection } from "./selection.ts";
import { SheetWorkbook } from "./SheetWorkbook.tsx";
import { postEdits, SHEETS_PATH, sheetPath, sheetsApi } from "./sheetsApi.ts";
import { SheetSync } from "./sheetSync.ts";
import { useSheetRoom } from "./useSheetRoom.ts";
import "../home/home.css";
import "./sheets.css";

/** How long an agent's edit stays highlighted. */
const FLASH_MS = 2400;
/** How long an agent's changed cells keep its outline and name tag. */
const AGENT_TAG_MS = 4000;
/** At most one selection update to the room per this many ms (the last one always goes). */
const PRESENCE_THROTTLE_MS = 100; // keeps a page within the room's PRESENCE_BURST per second
/** How often cursors not heard of within the expiry are dropped. */
const PRESENCE_PRUNE_MS = 5000;

const follow = (path: string) => (event: MouseEvent) => {
  if (event.metaKey || event.ctrlKey) return;
  event.preventDefault();
  navigate(path);
};

const engineOptions = () => ({ utcOffsetMinutes: -new Date().getTimezoneOffset() });

/** One sheet's own page: `/sheets/:id`, or `/sheets/:id/:tabId` for one tab. */
export function SheetPage(props: { readonly sheetId: string; readonly tabId: string | null }) {
  const { sheetId } = props;
  const lock = useLockedProject();
  const [meta, setMeta] = useState<SheetMeta | null>(null);
  const [sync, setSync] = useState<SheetSync | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [flashes, setFlashes] = useState<ReadonlyMap<string, ReadonlySet<number>>>(() => new Map());
  const [presence, dispatchPresence] = useReducer(presenceReducer, EMPTY_PRESENCE);
  const [agentTags, setAgentTags] = useState<ReadonlyArray<GridOverlay>>([]);
  const syncRef = useRef<SheetSync | null>(null);
  const agentTagSeq = useRef(0);
  const [tabId, setTabId] = useState(props.tabId);

  const flash = useCallback((cells: ReadonlyArray<{ sheetId: string; row: number; col: number }>) => {
    if (cells.length === 0) return;
    const add = (current: ReadonlyMap<string, ReadonlySet<number>>) => {
      const next = new Map(current);
      for (const cell of cells) {
        const set = new Set(next.get(cell.sheetId));
        set.add(cell.row * 32768 + cell.col);
        next.set(cell.sheetId, set);
      }
      return next;
    };
    setFlashes(add);
    window.setTimeout(() => {
      setFlashes((current) => {
        const next = new Map(current);
        for (const cell of cells) {
          const set = new Set(next.get(cell.sheetId));
          set.delete(cell.row * 32768 + cell.col);
          if (set.size === 0) next.delete(cell.sheetId);
          else next.set(cell.sheetId, set);
        }
        return next;
      });
    }, FLASH_MS);
  }, []);

  useEffect(() => {
    let live = true;
    sheetsApi.get(sheetId).then(
      ({ sheet, records }) => {
        if (!live) return;
        const created = new SheetSync(workbookFromRecords(records, engineOptions()), {
          clientId,
          post: (base, edits) => postEdits(sheetId, base, edits),
          fetch: async () => {
            const fresh = await sheetsApi.get(sheetId);
            setMeta(fresh.sheet);
            return workbookFromRecords(fresh.records, engineOptions());
          },
          onRemote: (change) => {
            // People see where an agent's edits land.
            if (change.by.kind !== "agent") return;
            const cells = changedCells(change.edits, change.workbook, change.changed);
            flash(cells);
            const tags = agentOverlays(String(++agentTagSeq.current), change.by, cells);
            if (tags.length === 0) return;
            setAgentTags((current) => [...current, ...tags]);
            window.setTimeout(
              () => setAgentTags((current) => current.filter((tag) => !tags.includes(tag))),
              AGENT_TAG_MS,
            );
          },
          onRefused: (refusal) => setNotice(`The change was not saved: ${refusal.detail}`),
          onGone: () => setMissing(true),
        });
        syncRef.current = created;
        setMeta(sheet);
        setSync(created);
      },
      (cause) => {
        if (!live) return;
        if (cause instanceof ApiError && cause.status === 404) setMissing(true);
        else setFailed(true);
      },
    );
    return () => {
      live = false;
      syncRef.current?.close();
      syncRef.current = null;
    };
  }, [sheetId, flash]);

  const room = useSheetRoom(sheetId, {
    onMessage: (message) => {
      if (message.type === "sheet.revision") syncRef.current?.receive(message);
      else if (message.type === "sheet.meta") setMeta(message.sheet);
      else if (message.type === "sheet.deleted") setMissing(true);
      else {
        dispatchPresence({ kind: "message", message, at: Date.now() });
        // A (re)connected socket is a new presence: tell the room where this page is.
        if (message.type === "sheet.presence.snapshot") publish.current.flush(true);
      }
    },
    onReconnect: () => syncRef.current?.resync(),
    onClosed: () => setMissing(true),
  });

  const changeTab = useCallback(
    (next: string) => {
      setTabId(next);
      navigate(sheetPath(sheetId, next), { replace: true });
    },
    [sheetId],
  );

  // Publishes the shown tab and selection: the first change at once, then at most
  // every PRESENCE_THROTTLE_MS with the latest last. Tab switches too: the room
  // drops more than 10 updates a second, so a dropped final update would stick.
  const publish = useRef({
    latest: null as { readonly tabId: string; readonly selection: Selection } | null,
    timer: null as ReturnType<typeof setTimeout> | null,
    dirty: false,
    flush(force = false) {
      if (!force && !this.dirty) return;
      this.dirty = false;
      const latest = this.latest;
      const tab = syncRef.current?.view.sheets.find((sheet) => sheet.id === latest?.tabId);
      if (!latest || !tab) {
        // Nothing selected yet: still tell the room this page is here.
        if (force) sendRef.current({ type: "presence.clear" });
        return;
      }
      sendRef.current(
        presenceMessage(latest.tabId, latest.selection, { rows: tab.rowCount, cols: tab.columnCount }),
      );
    },
  });
  const sendRef = useRef(room.send);
  sendRef.current = room.send;
  useEffect(() => {
    const state = publish.current;
    // Heartbeat: the room drops a page it has not heard from in PRESENCE_EXPIRY_MS.
    const heartbeat = setInterval(() => state.flush(true), PRESENCE_HEARTBEAT_MS);
    // And this page drops cursors it has not heard of as long, in case a "left" was missed.
    const prune = setInterval(() => dispatchPresence({ kind: "prune", now: Date.now() }), PRESENCE_PRUNE_MS);
    return () => {
      if (state.timer) clearTimeout(state.timer);
      clearInterval(heartbeat);
      clearInterval(prune);
    };
  }, []);

  // Re-renders when the next remote name tag is due to hide.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const now = Date.now();
    const next = nextTagChange(presence, now);
    if (next === null) return;
    const timer = setTimeout(() => setClock(Date.now()), next - now + 20);
    return () => clearTimeout(timer);
  }, [presence, clock]);
  const onSelectionChange = useCallback((nextTab: string, selection: Selection) => {
    const state = publish.current;
    state.latest = { tabId: nextTab, selection };
    state.dirty = true;
    if (state.timer === null) {
      state.flush();
      const tick = () => {
        if (!state.dirty) {
          state.timer = null;
          return;
        }
        state.flush();
        state.timer = setTimeout(tick, PRESENCE_THROTTLE_MS);
      };
      state.timer = setTimeout(tick, PRESENCE_THROTTLE_MS);
    }
  }, []);

  const overlays = useMemo(() => {
    const tabs = sync?.view.sheets ?? [];
    const remote = tabs.flatMap((tab) =>
      presenceOverlays(presence, tab.id, { rows: tab.rowCount, cols: tab.columnCount }, Math.max(clock, Date.now())),
    );
    return [...remote, ...agentTags];
  }, [presence, agentTags, sync, clock]);
  const avatars = useMemo(() => presenceAvatars(presence), [presence]);

  const back = (label: string) => (
    <button type="button" className="button secondary" onClick={() => navigate(SHEETS_PATH)}>
      {label}
    </button>
  );

  const sheetTitle = meta?.title ?? "";
  useEffect(() => {
    if (sheetTitle) setSheetTabTitle(sheetId, sheetTitle);
  }, [sheetId, sheetTitle]);

  if (missing) {
    return (
      <main className="home">
        <p className="home-empty">This sheet does not exist, or it is not shared with you.</p>
        {back("Back to Sheets")}
      </main>
    );
  }
  if (failed) {
    return (
      <main className="home">
        <p className="error">Could not load this sheet.</p>
        {back("Back to Sheets")}
      </main>
    );
  }
  if (!meta || !sync || lock.kind === "loading") return null;
  if (lock.kind === "locked" && (lock.projectId === null || meta.projectId !== lock.projectId)) {
    return (
      <main className="home">
        <p className="home-empty">This sheet is not part of {lock.name}.</p>
        {back(`Back to ${lock.name}`)}
      </main>
    );
  }

  const remove = async () => {
    if (!window.confirm(`Delete "${meta.title}" for everyone? Its tabs and cells go too.`)) return;
    try {
      await sheetsApi.remove(sheetId);
      forgetTab(`sheet:${sheetId}`);
      navigate(SHEETS_PATH, { replace: true });
    } catch {
      setNotice("Could not delete the sheet. Try again.");
    }
  };

  const shownTab = sync.view.sheets.find((sheet) => sheet.id === tabId) ?? sync.view.sheets[0];

  return (
    <div className="sheet-page">
      <header className="doc-header sheet-header">
        <div className="doc-header-title">
          <HomeLink />
          <span className="doc-header-crumb">/</span>
          <a href={SHEETS_PATH} className="home-link sheet-crumb" onClick={follow(SHEETS_PATH)}>
            Sheets
          </a>
          <span className="doc-header-crumb">/</span>
          <button type="button" className="sheet-title" title="Rename" onClick={() => setRenaming(true)}>
            {meta.title}
          </button>
        </div>
        <div className="doc-header-actions">
          <PresenceAvatars avatars={avatars} />
          {shownTab ? (
            <a className="button secondary small" href={sheetsApi.csvUrl(sheetId, shownTab.id)} download>
              Export CSV
            </a>
          ) : null}
          <button type="button" className="button secondary small sheet-delete" onClick={() => void remove()}>
            Delete
          </button>
        </div>
      </header>

      {notice ? (
        <div className="notice sheet-notice" role="status">
          {notice}
          <button type="button" className="link-button" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <SheetWorkbook
        sync={sync}
        sheetId={sheetId}
        tabId={tabId}
        onTabChange={changeTab}
        flashes={flashes}
        overlays={overlays}
        onSelectionChange={onSelectionChange}
        onNotice={setNotice}
      />

      {renaming ? (
        <TitleDialog
          heading="Rename sheet"
          detail={null}
          initial={meta.title}
          submitLabel="Rename"
          onSubmit={async (title) => {
            if (title !== meta.title) setMeta(await sheetsApi.rename(sheetId, title));
          }}
          onClose={() => setRenaming(false)}
        />
      ) : null}
    </div>
  );
}
