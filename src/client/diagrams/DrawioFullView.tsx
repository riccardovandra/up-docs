import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { PicturePart } from "../../shared/drawio.ts";
import { DiagramPicture, type DiagramPictureInfo } from "./DiagramPicture.tsx";
import { fitRect, type PanZoom } from "./panZoom.ts";
import { ZoomViewport } from "./ZoomViewport.tsx";

/** Past this many parts, a menu instead of a row of buttons. */
const MAX_CHIPS = 8;

/** A part's label up to its first " · ", as the doc block's part menu shows it. */
const shortName = (part: PicturePart) => part.name.split(" · ")[0]?.trim() || "Unnamed part";

/**
 * A doc's Draw.io block opened over the whole window. It shows the block's
 * whole page, so a block that shows one part opens on that part with the rest
 * of the page around it. The page's parts are buttons that fly to them.
 * Escape or Close returns to the doc.
 */
export function DrawioFullView(props: {
  readonly diagramId: string;
  readonly diagram: DiagramPictureInfo;
  readonly page: string | null;
  /** Which picture the page is, for its parts; null when not known. */
  readonly pageIndex: number | null;
  /** The part the block shows, by cell id; null for the whole page. */
  readonly part: string | null;
  readonly title: string;
  readonly onClose: () => void;
}) {
  const { onClose } = props;
  const [zoom, setZoom] = useState<PanZoom | null>(null);
  const [current, setCurrent] = useState<string | null>(props.part);
  const opened = useRef(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const layout =
    props.pageIndex === null ? null : (props.diagram.pictureParts?.[props.pageIndex] ?? null);
  const parts = layout?.parts ?? [];

  const show = useCallback(
    (part: PicturePart | null, animate = true) => {
      const picture = zoom?.picture();
      if (!zoom || !picture) return false;
      if (part === null || !layout || layout.width <= 0) {
        if (animate) zoom.reset();
        else zoom.set({ x: 0, y: 0, scale: 1 });
        return true;
      }
      const k = picture.width / layout.width;
      const rect = {
        x: picture.x + part.x * k,
        y: picture.y + part.y * k,
        width: part.width * k,
        height: part.height * k,
      };
      zoom.set(fitRect(rect, zoom.frame(), "contain"), animate);
      return true;
    },
    [zoom, layout],
  );

  // Open on the block's part, once the picture has a size.
  const openOnPart = useCallback(() => {
    if (opened.current) return;
    const part = parts.find((each) => each.id === props.part) ?? null;
    if (show(part, false)) opened.current = true;
  }, [parts, props.part, show]);
  useEffect(() => {
    const timer = window.setTimeout(openOnPart, 0);
    return () => clearTimeout(timer);
  }, [openOnPart]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("diagram-expanded");
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      root.classList.remove("diagram-expanded");
      before?.focus({ preventScroll: true });
    };
  }, [onClose]);

  const choose = (id: string | null) => {
    setCurrent(id);
    show(parts.find((part) => part.id === id) ?? null);
  };

  return createPortal(
    <div className="drawio-full" role="dialog" aria-modal="true" aria-label={props.title}>
      <div className="drawio-full-bar">
        <span className="drawio-full-title">{props.title}</span>
        {parts.length > 0 && parts.length <= MAX_CHIPS ? (
          <div className="drawio-full-parts" role="group" aria-label="Parts of this page">
            <button
              type="button"
              className="zoom-chip"
              aria-pressed={current === null}
              onClick={() => choose(null)}
            >
              Whole page
            </button>
            {parts.map((part) => (
              <button
                key={part.id}
                type="button"
                className="zoom-chip"
                title={part.name}
                aria-pressed={current === part.id}
                onClick={() => choose(part.id)}
              >
                {shortName(part)}
              </button>
            ))}
          </div>
        ) : parts.length > MAX_CHIPS ? (
          <label className="drawio-full-part-select">
            <span>Part</span>
            <select value={current ?? ""} onChange={(event) => choose(event.target.value || null)}>
              <option value="">Whole page</option>
              {parts.map((part) => (
                <option key={part.id} value={part.id} title={part.name}>
                  {shortName(part)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button ref={closeButton} type="button" className="zoom-chip" title="Close (Esc)" onClick={onClose}>
          Close
        </button>
      </div>
      <ZoomViewport
        className="drawio-full-stage"
        wheel="zoomed"
        fitWidth
        keys
        doubleClickZoom
        onReady={setZoom}
      >
        <div className="drawio-full-picture" onLoadCapture={openOnPart}>
          <DiagramPicture
            diagramId={props.diagramId}
            diagram={props.diagram}
            page={props.page}
            alt={props.title}
          />
        </div>
      </ZoomViewport>
    </div>,
    document.body,
  );
}
