import { describe, expect, it } from "vitest";

import {
  centreOn,
  clampState,
  fitRect,
  IDENTITY,
  MAX_SCALE,
  visibleFraction,
  zoomAround,
  type ZoomFrame,
} from "./panZoom.ts";

// A 400 x 300 viewport with a 20 px padding around a 360 x 260 content box.
const frame: ZoomFrame = { left: 20, top: 20, width: 360, height: 260, viewWidth: 400, viewHeight: 300 };

describe("clampState", () => {
  it("never zooms out past the resting picture, or in past the maximum", () => {
    expect(clampState({ x: 0, y: 0, scale: 0.5 }, frame).scale).toBe(1);
    expect(clampState({ x: 0, y: 0, scale: 50 }, frame).scale).toBe(MAX_SCALE);
  });

  it("keeps the zoomed content covering its resting box", () => {
    expect(clampState({ x: 40, y: 40, scale: 2 }, frame)).toEqual({ x: 0, y: 0, scale: 2 });
    expect(clampState({ x: -1000, y: -1000, scale: 2 }, frame)).toEqual({ x: -360, y: -260, scale: 2 });
  });
});

describe("zoomAround", () => {
  it("keeps the point under the pointer still", () => {
    const px = 120;
    const py = 90;
    const before = (px - frame.left - IDENTITY.x) / IDENTITY.scale;
    const next = zoomAround(IDENTITY, 2, px, py, frame);
    expect(next.scale).toBe(2);
    expect((px - frame.left - next.x) / next.scale).toBeCloseTo(before);
  });

  it("returns to rest when zoomed back out to 1", () => {
    const zoomed = zoomAround(IDENTITY, 3, 300, 200, frame);
    expect(zoomAround(zoomed, 1, 50, 50, frame)).toEqual({ x: 0, y: 0, scale: 1 });
  });
});

describe("fitRect", () => {
  it("fills the viewport with a small box, centred", () => {
    const rect = { x: 90, y: 65, width: 90, height: 65 };
    const state = fitRect(rect, frame, "contain");
    expect(state.scale).toBeGreaterThan(3);
    const centreX = frame.left + state.x + state.scale * (rect.x + rect.width / 2);
    expect(centreX).toBeCloseTo(frame.viewWidth / 2);
  });

  it("fits a tall picture to the width, from its top", () => {
    const tall = { x: 150, y: 0, width: 60, height: 260 };
    const state = fitRect(tall, frame, "width");
    expect(state.scale).toBeCloseTo((400 * 0.96) / 60);
    expect(state.y).toBeLessThanOrEqual(0);
    expect(frame.top + state.y + state.scale * tall.y).toBeGreaterThanOrEqual(0);
  });

  it("stays at rest for an empty box", () => {
    expect(fitRect({ x: 0, y: 0, width: 0, height: 0 }, frame, "contain")).toEqual(IDENTITY);
  });
});

describe("visibleFraction and centreOn", () => {
  const picture = { x: 0, y: 0, width: 360, height: 260 };

  it("sees the whole picture at rest", () => {
    const seen = visibleFraction(IDENTITY, frame, picture);
    expect(seen).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("sees a quarter of the picture at 2x, where it was centred", () => {
    const state = centreOn({ x: 0, y: 0, scale: 2 }, frame, picture, 0.5, 0.5);
    const seen = visibleFraction(state, frame, picture);
    expect(seen.width).toBeCloseTo(400 / 2 / 360);
    expect(seen.x + seen.width / 2).toBeCloseTo(0.5);
    expect(seen.y + seen.height / 2).toBeCloseTo(0.5);
  });
});
