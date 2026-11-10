import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";

import { workbookFromRecords } from "../../shared/sheet/serialize.ts";
import type { SheetMeta } from "../../shared/sheets.ts";
import { ApiError, clientId } from "../api.ts";
import { HomeLink } from "../home/HomeLink.tsx";
import { TitleDialog } from "../home/TitleDialog.tsx";
import { useLockedProject } from "../lockedProject.ts";
import { navigate } from "../router.ts";
import type { GridOverlay } from "./Grid.tsx";
import type { Selection } from "./selection.ts";
import { SheetWorkbook } from "./SheetWorkbook.tsx";
import { postEdits, SHEETS_PATH, sheetPath, sheetsApi } from "./sheetsApi.ts";
import { SheetSync } from "./sheetSync.ts";
import { useSheetRoom } from "./useSheetRoom.ts";
import "../home/home.css";
import "./sheets.css";

/** How long an agent's edit stays highlighted. */
const FLASH_MS = 2400;

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
  // Seam for live presence (S4): remote cursors land here as overlays.
  const [overlays] = useState<ReadonlyArray<GridOverlay>>([]);
  const syncRef = useRef<SheetSync | null>(null);
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
            if (change.by.kind === "agent") flash(change.changed.cells);
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

  useSheetRoom(sheetId, {
    onMessage: (message) => {
      if (message.type === "sheet.revision") syncRef.current?.receive(message);
      else if (message.type === "sheet.meta") setMeta(message.sheet);
      else if (message.type === "sheet.deleted") setMissing(true);
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

  // Seam for live presence (S4): publish the shown tab and selection to the room here.
  const onSelectionChange = useCallback((_tabId: string, _selection: Selection) => undefined, []);

  const back = (label: string) => (
    <button type="button" className="button secondary" onClick={() => navigate(SHEETS_PATH)}>
      {label}
    </button>
  );

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
