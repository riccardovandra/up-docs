/**
 * Zoom and pan for a diagram picture. The content element is scaled with a
 * CSS transform inside a viewport that clips it, so whatever sits on the
 * picture (comment pins) moves with it. Scale 1 is the picture as the page
 * lays it out; the content never zooms out past that, and its edges never
 * come inside their resting place, so it cannot be lost off screen.
 */

export const MIN_SCALE = 1;
/** High enough to read one lane of a tall page that rests fitted whole. */
export const MAX_SCALE = 24;
/** One click of + or -. */
export const STEP = 1.5;

/** Translation (px, in the viewport) and scale of the content. */
export interface ZoomState {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/** A box in content-local pixels: the content as laid out, before any zoom. */
export interface LocalRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The content's laid-out box inside the viewport, and the viewport's size. */
export interface ZoomFrame {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly viewWidth: number;
  readonly viewHeight: number;
}

export const IDENTITY: ZoomState = { x: 0, y: 0, scale: 1 };

const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** Keeps the scaled content covering its resting box: no edge comes inside it. */
export function clampState(state: ZoomState, frame: ZoomFrame): ZoomState {
  const scale = clampScale(state.scale);
  const x = Math.min(0, Math.max(frame.width * (1 - scale), state.x));
  const y = Math.min(0, Math.max(frame.height * (1 - scale), state.y));
  return { x, y, scale };
}

/** Zooms to `next`, keeping the viewport point (px, py) over the same spot of the content. */
export function zoomAround(
  state: ZoomState,
  next: number,
  px: number,
  py: number,
  frame: ZoomFrame,
): ZoomState {
  const scale = clampScale(next);
  const localX = (px - frame.left - state.x) / state.scale;
  const localY = (py - frame.top - state.y) / state.scale;
  return clampState(
    { x: px - frame.left - scale * localX, y: py - frame.top - scale * localY, scale },
    frame,
  );
}

/**
 * Shows `rect` (content-local) as large as fits, centred; with `width`, as
 * wide as the viewport and from its top, for a tall picture read top down.
 */
export function fitRect(rect: LocalRect, frame: ZoomFrame, mode: "contain" | "width"): ZoomState {
  if (rect.width <= 0 || rect.height <= 0) return IDENTITY;
  const margin = 0.96;
  const scale = clampScale(
    mode === "width"
      ? (frame.viewWidth * margin) / rect.width
      : Math.min(frame.viewWidth / rect.width, frame.viewHeight / rect.height) * margin,
  );
  const x = frame.viewWidth / 2 - frame.left - scale * (rect.x + rect.width / 2);
  const y =
    mode === "width"
      ? frame.viewHeight * ((1 - margin) / 2) - frame.top - scale * rect.y
      : frame.viewHeight / 2 - frame.top - scale * (rect.y + rect.height / 2);
  return clampState({ x, y, scale }, frame);
}

/** The part of `picture` (content-local) in view, as fractions of the picture. */
export function visibleFraction(
  state: ZoomState,
  frame: ZoomFrame,
  picture: LocalRect,
): LocalRect {
  const left = (0 - frame.left - state.x) / state.scale;
  const top = (0 - frame.top - state.y) / state.scale;
  const right = left + frame.viewWidth / state.scale;
  const bottom = top + frame.viewHeight / state.scale;
  const fx = (value: number) => Math.min(1, Math.max(0, (value - picture.x) / picture.width));
  const fy = (value: number) => Math.min(1, Math.max(0, (value - picture.y) / picture.height));
  return { x: fx(left), y: fy(top), width: fx(right) - fx(left), height: fy(bottom) - fy(top) };
}

/** Moves the view so the picture point at fractions (fx, fy) is in the middle. */
export function centreOn(
  state: ZoomState,
  frame: ZoomFrame,
  picture: LocalRect,
  fx: number,
  fy: number,
): ZoomState {
  const localX = picture.x + fx * picture.width;
  const localY = picture.y + fy * picture.height;
  return clampState(
    {
      x: frame.viewWidth / 2 - frame.left - state.scale * localX,
      y: frame.viewHeight / 2 - frame.top - state.scale * localY,
      scale: state.scale,
    },
    frame,
  );
}

export interface PanZoomOptions {
  /**
   * What a plain wheel does: "zoomed" pans while zoomed in (a full view or the
   * diagram page), "sideways" pans only on a sideways scroll so the doc keeps
   * scrolling up and down.
   */
  readonly wheel: "zoomed" | "sideways";
  readonly onChange: (state: ZoomState) => void;
}

export interface PanZoom {
  readonly state: () => ZoomState;
  readonly frame: () => ZoomFrame;
  /** The picture's box in content-local pixels, or null before it shows. */
  readonly picture: () => LocalRect | null;
  readonly set: (state: ZoomState, animate?: boolean) => void;
  readonly zoomBy: (factor: number) => void;
  readonly reset: () => void;
  readonly destroy: () => void;
}

const DRAG_SLOP = 4;

/**
 * Wires the pointer, wheel and pinch handling. Ctrl or Cmd with the wheel
 * (and a trackpad pinch, which arrives as one) zooms at the pointer; two
 * fingers pinch; a drag pans once zoomed. A click that ends a drag, zoomed or
 * not, does not reach anything under it.
 */
export function createPanZoom(
  viewport: HTMLElement,
  content: HTMLElement,
  options: PanZoomOptions,
): PanZoom {
  let state = IDENTITY;
  let animation = 0;
  let landing = 0;

  const frame = (): ZoomFrame => {
    const view = viewport.getBoundingClientRect();
    const box = content.getBoundingClientRect();
    return {
      left: box.left - view.left - state.x,
      top: box.top - view.top - state.y,
      width: box.width / state.scale,
      height: box.height / state.scale,
      viewWidth: view.width,
      viewHeight: view.height,
    };
  };

  const picture = (): LocalRect | null => {
    const image = content.querySelector("img");
    if (!image || image.clientWidth === 0) return null;
    const box = content.getBoundingClientRect();
    const rect = image.getBoundingClientRect();
    return {
      x: (rect.left - box.left) / state.scale,
      y: (rect.top - box.top) / state.scale,
      width: rect.width / state.scale,
      height: rect.height / state.scale,
    };
  };

  const apply = (next: ZoomState) => {
    state = next;
    const identity = next.scale === 1 && next.x === 0 && next.y === 0;
    content.style.transform = identity
      ? ""
      : `translate(${next.x}px, ${next.y}px) scale(${next.scale})`;
    content.style.transformOrigin = identity ? "" : "0 0";
    viewport.style.setProperty("--diagram-zoom", String(next.scale));
    viewport.toggleAttribute("data-zoomed", next.scale > 1.001);
    options.onChange(next);
  };

  const set = (next: ZoomState, animate = false) => {
    cancelAnimationFrame(animation);
    clearTimeout(landing);
    const target = clampState(next, frame());
    if (!animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      apply(target);
      return;
    }
    const from = state;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 260);
      const e = 1 - (1 - t) ** 3;
      apply({
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
        scale: from.scale + (target.scale - from.scale) * e,
      });
      if (t < 1) animation = requestAnimationFrame(step);
    };
    animation = requestAnimationFrame(step);
    // Frames pause in a hidden page; the view still lands where it was sent.
    landing = window.setTimeout(() => {
      cancelAnimationFrame(animation);
      apply(target);
    }, 400);
  };

  const zoomAt = (next: number, clientX: number, clientY: number) => {
    const view = viewport.getBoundingClientRect();
    set(zoomAround(state, next, clientX - view.left, clientY - view.top, frame()));
  };

  const zoomBy = (factor: number) => {
    const f = frame();
    set(zoomAround(state, state.scale * factor, f.viewWidth / 2, f.viewHeight / 2, f), true);
  };

  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      zoomAt(state.scale * Math.exp(-event.deltaY * 0.005), event.clientX, event.clientY);
      return;
    }
    if (state.scale <= 1.001) return;
    const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    if (options.wheel === "sideways" && !sideways) return;
    event.preventDefault();
    const dy = options.wheel === "sideways" ? 0 : event.deltaY;
    set({ x: state.x - event.deltaX, y: state.y - dy, scale: state.scale });
  };

  const pointers = new Map<number, { x: number; y: number }>();
  let last: { x: number; y: number } | null = null;
  let pinch: number | null = null;
  let travelled = 0;

  const swallowClick = (event: Event) => {
    event.stopPropagation();
    event.preventDefault();
  };

  const onDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((event.target as Element).closest("[data-zoom-control]")) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      last = { x: event.clientX, y: event.clientY };
      travelled = 0;
    }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
      for (const id of pointers.keys()) viewport.setPointerCapture?.(id);
    } else if (state.scale > 1.001) {
      viewport.setPointerCapture?.(event.pointerId);
    }
  };

  const onMove = (event: PointerEvent) => {
    const known = pointers.get(event.pointerId);
    if (!known) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2 && pinch !== null) {
      const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      travelled += DRAG_SLOP + 1;
      zoomAt(state.scale * (distance / pinch), (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch = distance;
      return;
    }
    if (last === null) return;
    const dx = event.clientX - last.x;
    const dy = event.clientY - last.y;
    // Counted at rest too, so the click that ends any drag is swallowed.
    travelled += Math.abs(dx) + Math.abs(dy);
    last = { x: event.clientX, y: event.clientY };
    if (state.scale <= 1.001) return;
    if (travelled > DRAG_SLOP) {
      viewport.dataset.dragging = "";
      set({ x: state.x + dx, y: state.y + dy, scale: state.scale });
    }
  };

  const onUp = (event: PointerEvent) => {
    if (!pointers.delete(event.pointerId)) return;
    if (pointers.size < 2) pinch = null;
    if (pointers.size > 0) return;
    last = null;
    delete viewport.dataset.dragging;
    if (travelled > DRAG_SLOP) {
      viewport.addEventListener("click", swallowClick, { capture: true, once: true });
      // A drag that ends outside the viewport sends no click to swallow.
      setTimeout(() => viewport.removeEventListener("click", swallowClick, { capture: true }), 0);
    }
  };

  viewport.addEventListener("wheel", onWheel, { passive: false });
  viewport.addEventListener("pointerdown", onDown);
  viewport.addEventListener("pointermove", onMove);
  viewport.addEventListener("pointerup", onUp);
  viewport.addEventListener("pointercancel", onUp);

  return {
    state: () => state,
    frame,
    picture,
    set,
    zoomBy,
    reset: () => set(IDENTITY, true),
    destroy: () => {
      cancelAnimationFrame(animation);
      clearTimeout(landing);
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("pointerdown", onDown);
      viewport.removeEventListener("pointermove", onMove);
      viewport.removeEventListener("pointerup", onUp);
      viewport.removeEventListener("pointercancel", onUp);
      content.style.transform = "";
      content.style.transformOrigin = "";
    },
  };
}
