import { useMemo, useState } from "react";

import { workbookFromRecords } from "../../shared/sheet/serialize.ts";
import type { PublicSheet } from "../../shared/publicLinks.ts";
import { clientId } from "../api.ts";
import { SheetWorkbook } from "../sheets/SheetWorkbook.tsx";
import { SheetSync } from "../sheets/sheetSync.ts";
import "../sheets/sheets.css";
import { PublicHeader } from "./PublicLinkPage.tsx";

const NO_FLASHES: ReadonlyMap<string, ReadonlySet<number>> = new Map();
const NO_OVERLAYS: ReadonlyArray<never> = [];
const engineOptions = () => ({ utcOffsetMinutes: -new Date().getTimezoneOffset() });

/**
 * A sheet a public link opens: every tab, view only. Cells select and copy;
 * nothing is sent. PublicLinkPage re-reads it, and a new revision redraws it.
 */
export function PublicSheetView(props: { readonly item: PublicSheet }) {
  const { records } = props.item;
  const [tabId, setTabId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sync = useMemo(() => {
    const workbook = workbookFromRecords(records, engineOptions());
    return new SheetSync(workbook, {
      clientId,
      // View only: the workbook never sends, so these never run.
      post: async () => ({ kind: "gone" }),
      fetch: async () => workbook,
    });
  }, [records]);

  return (
    <div className="sheet-page public-sheet">
      <PublicHeader title={props.item.title} kind="sheet" />
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
        sheetId="public"
        tabId={tabId}
        onTabChange={setTabId}
        flashes={NO_FLASHES}
        overlays={NO_OVERLAYS}
        onNotice={setNotice}
        readOnly
      />
    </div>
  );
}
