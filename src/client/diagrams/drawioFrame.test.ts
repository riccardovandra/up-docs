import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DRAWIO_ORIGIN,
  DRAWIO_RENDERER_URL,
  drawioEditorUrl,
  exportDrawioPicture,
  lightSvg,
  nextDrawioEvent,
  parseDrawioMessage,
  pngBase64FromDataUri,
  svgFromDataUri,
} from "./drawioFrame.ts";
import { fakeDrawio, PNG_BASE64, pngDataUri, SVG, svgDataUri } from "./testing/fakeDrawio.ts";

afterEach(() => vi.useRealTimers());

describe("parseDrawioMessage", () => {
  it("reads the events the app acts on", () => {
    expect(parseDrawioMessage('{"event":"init"}')).toEqual({ event: "init" });
    expect(parseDrawioMessage('{"event":"load","xml":"<mxfile/>"}')).toEqual({ event: "load" });
    expect(parseDrawioMessage('{"event":"exit","modified":true}')).toEqual({ event: "exit" });
    expect(parseDrawioMessage('{"event":"save","xml":"<mxfile/>","exit":true}')).toEqual({
      event: "save",
      xml: "<mxfile/>",
      exit: true,
    });
    expect(parseDrawioMessage('{"event":"save","xml":"<mxfile/>"}')).toMatchObject({ exit: false });
  });

  it("takes an export's format from the answer, or from the request it echoes", () => {
    expect(parseDrawioMessage('{"event":"export","format":"svg","data":"data:x"}')).toEqual({
      event: "export",
      format: "svg",
      data: "data:x",
    });
    expect(
      parseDrawioMessage('{"event":"export","data":"data:x","message":{"format":"png"}}'),
    ).toMatchObject({ format: "png" });
  });

  it.each([
    [undefined],
    [""],
    ["not json"],
    ["null"],
    ['"init"'],
    ['{"event":"autosave","xml":"<mxfile/>"}'],
    ['{"event":"save"}'],
    ['{"event":"export"}'],
    [{ event: "init" }],
  ])("drops %j", (data) => {
    expect(parseDrawioMessage(data)).toBeNull();
  });
});

describe("the Draw.io URLs", () => {
  it("opens the editor in embed mode with Save & Exit, in the app's appearance", () => {
    const url = new URL(drawioEditorUrl({ dark: true }));
    expect(url.origin).toBe(DRAWIO_ORIGIN);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      embed: "1",
      proto: "json",
      saveAndExit: "1",
      noSaveBtn: "1",
      dark: "1",
    });
    expect(new URL(drawioEditorUrl({ dark: false })).searchParams.get("dark")).toBe("0");
    const renderer = new URL(DRAWIO_RENDERER_URL);
    expect(renderer.origin).toBe(DRAWIO_ORIGIN);
    expect(Object.fromEntries(renderer.searchParams)).toMatchObject({ embed: "1", proto: "json" });
  });
});

describe("export data", () => {
  it("decodes the SVG Draw.io sends, as UTF-8", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Caffè → 東京</text></svg>';
    expect(svgFromDataUri(svgDataUri(svg))).toBe(svg);
    expect(svgFromDataUri(`data:image/svg+xml,${encodeURIComponent(svg)}`)).toBe(svg);
    expect(svgFromDataUri(svg)).toBe(svg);
    expect(svgFromDataUri("data:image/svg+xml;base64,!!!")).toBeNull();
    expect(svgFromDataUri(svgDataUri("<html></html>"))).toBeNull();
  });

  it("takes a real PNG and drops a blank one", () => {
    expect(pngBase64FromDataUri(pngDataUri(PNG_BASE64))).toBe(PNG_BASE64);
    expect(pngBase64FromDataUri("data:,")).toBeNull();
    expect(pngBase64FromDataUri(pngDataUri("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"))).toBeNull();
    expect(pngBase64FromDataUri(svgDataUri(SVG))).toBeNull();
  });

  it("pins an SVG to its light colours, touching only the root element", () => {
    const svg =
      '<?xml version="1.0"?><svg style="background: #fff; color-scheme: light dark;" width="4">' +
      '<g style="color-scheme: light dark;"/></svg>';
    expect(lightSvg(svg)).toBe(
      '<?xml version="1.0"?><svg style="background: #fff; color-scheme: light;" width="4">' +
        '<g style="color-scheme: light dark;"/></svg>',
    );
    expect(lightSvg(SVG)).toBe(SVG);
    expect(lightSvg("not an svg")).toBe("not an svg");
  });
});

describe("exportDrawioPicture", () => {
  it("asks for the SVG, then the PNG on white", async () => {
    const drawio = fakeDrawio();
    const picture = await exportDrawioPicture(drawio.frame, { spinKey: "saving" });
    expect(picture).toEqual({ svg: SVG, png: PNG_BASE64 });
    expect(drawio.posted).toEqual([
      { action: "export", format: "svg", spinKey: "saving" },
      { action: "export", format: "png", background: "#ffffff", spinKey: "saving" },
    ]);
    expect(drawio.listening()).toBe(0);
  });

  it("goes on without a PNG when the browser makes none", async () => {
    vi.useFakeTimers();
    const drawio = fakeDrawio({ png: false });
    const exported = exportDrawioPicture(drawio.frame);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await exported).toEqual({ svg: SVG, png: null });
    expect(drawio.listening()).toBe(0);
  });

  it("fails when Draw.io never answers", async () => {
    vi.useFakeTimers();
    const drawio = fakeDrawio();
    const waiting = nextDrawioEvent(drawio.frame, "load", { timeoutMs: 1000, what: "open it" });
    const outcome = waiting.then(
      () => "resolved",
      (cause: Error) => cause.message,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toBe("Draw.io did not open it in time.");
    expect(drawio.listening()).toBe(0);
  });
});
