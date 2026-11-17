import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import {
  centreOn,
  createPanZoom,
  fitRect,
  STEP,
  visibleFraction,
  zoomAround,
  type LocalRect,
  type PanZoom,
} from "./panZoom.ts";

interface View {
  readonly scale: number;
  /** The part of the picture in view, as fractions; null before the picture shows. */
  readonly window: LocalRect | null;
  readonly src: string | null;
  /** The picture's width over its height, to size the map. */
  readonly aspect: number;
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]") !== null);

/**
 * A diagram picture that zooms and pans in place: the zoom buttons sit in the
 * bottom-right corner, and once zoomed in a small map of the whole picture
 * shows where the view is (click it to jump). See panZoom.ts for the gestures.
 */
export function ZoomViewport(props: {
  readonly className: string;
  readonly contentClassName?: string;
  readonly wheel: "zoomed" | "sideways";
  readonly children: ReactNode;
  /** Extra buttons before the zoom buttons, such as Expand or Full screen. */
  readonly controls?: ReactNode;
  /** Shows a "Fit width" button, for tall pictures. */
  readonly fitWidth?: boolean;
  /** +, - and 0 from anywhere on the page (one viewport per page only). */
  readonly keys?: boolean;
  readonly doubleClickZoom?: boolean;
  /** A plain click while not zoomed in, such as opening the editor. */
  readonly onClickAtRest?: () => void;
  readonly clickTitle?: string;
  /**
   * Opens a picture that is much taller than the viewport at the viewport's
   * width, from its top, so it reads top down as before; 0 still fits it whole.
   */
  readonly startWide?: boolean;
  /** The view goes back to rest whenever this changes (another page, another picture). */
  readonly resetKey?: string;
  /** Hands over the zoom once it exists; must be a stable function (a state setter). */
  readonly onReady?: (zoom: PanZoom | null) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const zoom = useRef<PanZoom | null>(null);
  const [view, setView] = useState<View>({ scale: 1, window: null, src: null, aspect: 1 });
  const { onReady } = props;

  useEffect(() => {
    const host = viewport.current;
    const inner = content.current;
    if (!host || !inner) return;
    const created = createPanZoom(host, inner, {
      wheel: props.wheel,
      onChange: (state) => {
        const picture = created.picture();
        setView({
          scale: state.scale,
          window: picture ? visibleFraction(state, created.frame(), picture) : null,
          src: inner.querySelector("img")?.getAttribute("src") ?? null,
          aspect: picture && picture.height > 0 ? picture.width / picture.height : 1,
        });
      },
    });
    zoom.current = created;
    onReady?.(created);
    // A resized viewport keeps the same zoom but must still cover its box.
    const observer = new ResizeObserver(() => created.set(created.state()));
    observer.observe(host);
    return () => {
      observer.disconnect();
      created.destroy();
      zoom.current = null;
      onReady?.(null);
    };
  }, [props.wheel, onReady]);

  /** The resetKey whose opening view has been set, so later loads leave the reader's view alone. */
  const started = useRef<string | null>(null);
  const resetKey = props.resetKey ?? "";
  const start = () => {
    const current = zoom.current;
    const picture = current?.picture();
    if (!current || !picture || started.current === resetKey) return;
    started.current = resetKey;
    const frame = current.frame();
    const tall = picture.width < frame.viewWidth * 0.7 && picture.height >= frame.height * 0.9;
    current.set(props.startWide && tall ? fitRect(picture, frame, "width") : { x: 0, y: 0, scale: 1 });
  };

  useEffect(() => {
    zoom.current?.set({ x: 0, y: 0, scale: 1 });
    start();
    // `start` reads the latest props; it runs again on the picture's load.
  }, [resetKey]);

  useEffect(() => {
    if (!props.keys) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      const current = zoom.current;
      if (!current) return;
      if (event.key === "+" || event.key === "=") current.zoomBy(STEP);
      else if (event.key === "-" || event.key === "_") current.zoomBy(1 / STEP);
      else if (event.key === "0") current.reset();
      else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.keys]);

  const zoomed = view.scale > 1.001;

  const fitWidth = () => {
    const current = zoom.current;
    const picture = current?.picture();
    if (current && picture) current.set(fitRect(picture, current.frame(), "width"), true);
  };

  const jump = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const current = zoom.current;
    const picture = current?.picture();
    if (!current || !picture) return;
    const box = event.currentTarget.getBoundingClientRect();
    const fx = (event.clientX - box.left) / box.width;
    const fy = (event.clientY - box.top) / box.height;
    current.set(centreOn(current.state(), current.frame(), picture, fx, fy), true);
  };

  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!props.onClickAtRest || zoomed) return;
    if ((event.target as Element).closest("[data-zoom-control]")) return;
    props.onClickAtRest();
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const current = zoom.current;
    if (!props.doubleClickZoom || !current) return;
    if ((event.target as Element).closest("[data-zoom-control]")) return;
    const box = event.currentTarget.getBoundingClientRect();
    const state = current.state();
    const px = event.clientX - box.left;
    const py = event.clientY - box.top;
    current.set(zoomAround(state, state.scale * 2, px, py, current.frame()), true);
  };

  const pct = `${Math.round(view.scale * 100)}%`;
  return (
    <div
      ref={viewport}
      className={`zoom-viewport ${props.className}`}
      title={props.onClickAtRest && !zoomed ? props.clickTitle : undefined}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      data-clickable={props.onClickAtRest && !zoomed ? "" : undefined}
    >
      <div
        ref={content}
        className={`zoom-content ${props.contentClassName ?? ""}`}
        onLoadCapture={start}
      >
        {props.children}
      </div>
      {zoomed && view.window && view.src ? (
        <button
          type="button"
          className="zoom-minimap"
          data-zoom-control=""
          aria-label="Where the view is: click to move there"
          style={{ width: `min(8.5rem, ${(12 * view.aspect).toFixed(3)}rem)` }}
          onClick={jump}
        >
          <img src={view.src} alt="" draggable={false} />
          <span
            className="zoom-minimap-window"
            style={{
              left: `${view.window.x * 100}%`,
              top: `${view.window.y * 100}%`,
              width: `${view.window.width * 100}%`,
              height: `${view.window.height * 100}%`,
            }}
          />
        </button>
      ) : null}
      <div className="zoom-controls" data-zoom-control="" onClick={(event) => event.stopPropagation()}>
        {props.controls}
        <div className="zoom-pill" role="group" aria-label="Zoom">
          <button
            type="button"
            aria-label="Zoom out"
            title="Zoom out (-)"
            disabled={!zoomed}
            onClick={() => zoom.current?.zoomBy(1 / STEP)}
          >
            −
          </button>
          <button
            type="button"
            className="zoom-level"
            title="Fit the whole picture (0)"
            onClick={() => zoom.current?.reset()}
          >
            {pct}
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            title="Zoom in (+)"
            onClick={() => zoom.current?.zoomBy(STEP)}
          >
            +
          </button>
          {props.fitWidth ? (
            <button type="button" className="zoom-fit-width" title="Fit width" onClick={fitWidth}>
              Fit width
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
