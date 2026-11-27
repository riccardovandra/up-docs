import { useEffect, useRef, useState, type MouseEvent } from "react";

import type { DesignUsage } from "../../../shared/designBlock.ts";
import { docPath, navigate } from "../../router.ts";
import { designDocsApi } from "./designRefresh.ts";
import "./design.css";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "Used in 2 docs" for a usage, or "Not in any doc". */
export function usedInLabel(usage: DesignUsage): string {
  const docs = new Set(usage.uses.map((use) => use.docId)).size + usage.otherDocs;
  return docs === 0 ? "Not in any doc" : `Used in ${plural(docs, "doc")}`;
}

/**
 * Where a design is shown (S4), for its design page: a button that opens the
 * list of docs and tabs whose markdown shows it. Only someone who manages the
 * design is told; for anyone else this renders nothing.
 */
export function DesignUsedIn(props: { readonly designId: string; readonly canEdit: boolean }) {
  const [usage, setUsage] = useState<DesignUsage | null>(null);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!props.canEdit) return;
    let live = true;
    const load = () =>
      designDocsApi.uses(props.designId).then(
        (next) => {
          if (live) setUsage(next);
        },
        () => undefined,
      );
    void load();
    // It may be put into a doc elsewhere while this page is open.
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [props.designId, props.canEdit]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  if (!props.canEdit || usage === null) return null;

  const follow = (path: string) => (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    navigate(path);
  };

  return (
    <div className="design-used-in" ref={wrap}>
      <button
        type="button"
        className="button secondary small"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {usedInLabel(usage)}
      </button>
      {open ? (
        <div className="design-used-in-menu" role="dialog" aria-label="Docs that show this design">
          {usage.uses.length === 0 && usage.otherDocs === 0 ? (
            <p className="muted">No doc shows this design yet. Use Design in a doc's + menu.</p>
          ) : (
            <ul>
              {usage.uses.map((use) => (
                <li key={`${use.docId}/${use.tabId}`}>
                  <a
                    href={docPath(use.docId, use.tabId)}
                    onClick={follow(docPath(use.docId, use.tabId))}
                  >
                    {use.docTitle}
                  </a>
                  {use.tabTitle ? <span className="muted"> · {use.tabTitle}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {usage.otherDocs > 0 ? (
            <p className="muted">And {plural(usage.otherDocs, "doc")} you are not on.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
