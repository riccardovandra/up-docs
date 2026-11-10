export interface ExpandControl {
  /** The zoom buttons (shown in full view) and the Expand/Close button. */
  readonly controls: HTMLElement;
  /** Leaves full view; called from a node view's destroy(). */
  readonly collapse: () => void;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const STEP = 1.25;

function button(className: string, text: string, title: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = text;
  element.title = title;
  element.addEventListener("mousedown", (event) => event.preventDefault());
  return element;
}

/**
 * Full-view mode for rendered mermaid diagrams. The block's own chrome is
 * pinned over the page with CSS (`data-expanded`), so nothing is re-rendered. In full view a transparent pad over the
 * drawing takes the pointer: drag or scroll pans, Ctrl/Cmd-scroll or a
 * trackpad pinch zooms at the pointer. +, - and 0 zoom from the keyboard;
 * Escape or Close returns.
 *
 * `viewport` is the pinned element, `content` the element that is scaled.
 */
export function createExpandControl(
  block: HTMLElement,
  viewport: HTMLElement,
  content: HTMLElement,
): ExpandControl {
  const controls = document.createElement("span");
  controls.className = "diagram-expand-controls";
  const zoom = document.createElement("span");
  zoom.className = "diagram-zoom";
  const zoomOut = button("diagram-zoom-button", "−", "Zoom out (-)");
  const level = button("diagram-zoom-button diagram-zoom-level", "100%", "Fit to screen (0)");
  const zoomIn = button("diagram-zoom-button", "+", "Zoom in (+)");
  zoom.append(zoomOut, level, zoomIn);
  const toggle = button("diagram-expand", "Expand", "View the diagram full screen");
  controls.append(zoom, toggle);

  const pad = document.createElement("div");
  pad.className = "diagram-pan";
  viewport.append(pad);

  let scale = 1;
  let x = 0;
  let y = 0;

  const apply = () => {
    const identity = scale === 1 && x === 0 && y === 0;
    content.style.transform = identity ? "" : `translate(${x}px, ${y}px) scale(${scale})`;
    content.style.transformOrigin = identity ? "" : "0 0";
    level.textContent = `${Math.round(scale * 100)}%`;
  };

  const reset = () => {
    scale = 1;
    x = 0;
    y = 0;
    apply();
  };

  /** Zooms to `next`, keeping the screen point (cx, cy) still. */
  const zoomAt = (next: number, cx: number, cy: number) => {
    next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    const rect = content.getBoundingClientRect();
    // With origin 0 0 the box's top-left is its layout position plus (x, y).
    const left = rect.left - x;
    const top = rect.top - y;
    const localX = (cx - left - x) / scale;
    const localY = (cy - top - y) / scale;
    x = cx - left - next * localX;
    y = cy - top - next * localY;
    scale = next;
    apply();
  };

  const zoomAtCentre = (next: number) => {
    const rect = viewport.getBoundingClientRect();
    zoomAt(next, rect.left + rect.width / 2, rect.top + rect.height / 2);
  };

  zoomOut.addEventListener("click", () => zoomAtCentre(scale / STEP));
  zoomIn.addEventListener("click", () => zoomAtCentre(scale * STEP));
  level.addEventListener("click", reset);

  pad.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        // Trackpad pinches arrive as ctrl+wheel with small deltas.
        zoomAt(scale * Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
      } else {
        x -= event.deltaX;
        y -= event.deltaY;
        apply();
      }
    },
    { passive: false },
  );

  let drag: { readonly id: number; startX: number; startY: number } | null = null;
  pad.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = { id: event.pointerId, startX: event.clientX - x, startY: event.clientY - y };
    pad.setPointerCapture(event.pointerId);
    pad.dataset.dragging = "";
  });
  pad.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    x = event.clientX - drag.startX;
    y = event.clientY - drag.startY;
    apply();
  });
  const endDrag = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    delete pad.dataset.dragging;
  };
  pad.addEventListener("pointerup", endDrag);
  pad.addEventListener("pointercancel", endDrag);
  // Clicks on the pad must not reach the node view (mermaid opens its source).
  pad.addEventListener("click", (event) => event.stopPropagation());

  const onKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") setExpanded(false);
    else if (event.key === "+" || event.key === "=") zoomAtCentre(scale * STEP);
    else if (event.key === "-" || event.key === "_") zoomAtCentre(scale / STEP);
    else if (event.key === "0") reset();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const setExpanded = (expanded: boolean) => {
    block.toggleAttribute("data-expanded", expanded);
    toggle.textContent = expanded ? "Close" : "Expand";
    toggle.title = expanded ? "Close full view (Esc)" : "View the diagram full screen";
    toggle.setAttribute("aria-pressed", String(expanded));
    document.documentElement.classList.toggle("diagram-expanded", expanded);
    reset();
    if (expanded) document.addEventListener("keydown", onKey, true);
    else document.removeEventListener("keydown", onKey, true);
  };

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    setExpanded(!block.hasAttribute("data-expanded"));
  });
  setExpanded(false);

  return {
    controls,
    collapse: () => {
      if (block.hasAttribute("data-expanded")) setExpanded(false);
    },
  };
}
