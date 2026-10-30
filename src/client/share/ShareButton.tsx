import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { DocRole } from "../../shared/access.ts";
import { ShareDialog } from "./ShareDialog.tsx";
import "./share.css";

const noFlush = async () => undefined;

/** The doc header's Share button and the panel it opens beneath itself. */
export function ShareButton(props: {
  readonly docId: string;
  /** The caller's role on the doc, from `GET /api/docs/:docId`. */
  readonly role: DocRole;
  readonly title: string;
  /** The open tab, for the Export segment's tab actions. */
  readonly tabId?: string | null;
  /** Saves the open tab's pending edit before an export. */
  readonly flush?: () => Promise<void>;
  /** After the panel closes: the caller may have changed their own role or left. */
  readonly onClosed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const onClosed = useRef(props.onClosed);
  useLayoutEffect(() => {
    onClosed.current = props.onClosed;
  });
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) onClosed.current?.();
    wasOpen.current = open;
  }, [open]);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  }, []);

  return (
    <div className="share-wrap" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="share-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle cx="6" cy="5.5" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M1.5 13.5c.6-2.3 2.3-3.5 4.5-3.5s3.9 1.2 4.5 3.5M11 4.5v4M9 6.5h4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
        Share
      </button>
      {open ? (
        <ShareDialog
          docId={props.docId}
          title={props.title}
          role={props.role}
          tabId={props.tabId ?? null}
          flush={props.flush ?? noFlush}
          anchor={wrap}
          onClose={close}
        />
      ) : null}
    </div>
  );
}
