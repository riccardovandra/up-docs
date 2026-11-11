// Talking to Draw.io: the hosted editor at embed.diagrams.net runs in a frame
// and speaks JSON over postMessage (`embed=1&proto=json`). The diagram stays in
// the browser: this app hands the frame the source and takes back the source
// and the picture. Everything here works on a `DrawioFrame`, so tests drive it
// with a stand-in for the frame.

import type { DrawioThemeConfig } from "../../shared/diagramTheme.ts";
import { MAX_DIAGRAM_PAGES } from "../../shared/drawio.ts";
import { drawioPageSources } from "../../shared/drawioModel.ts";
import { trimSvgFonts } from "./svgFonts.ts";

export const DRAWIO_ORIGIN = "https://embed.diagrams.net";

/** What the frame tells us. Anything it sends that we do not act on is dropped. */
export type DrawioEvent =
  /** The editor (opened with `configure=1`) waits for `configure` before it starts. */
  | { readonly event: "configure" }
  /** The frame is ready for `load`. */
  | { readonly event: "init" }
  /** The source given with `load` is on the canvas. */
  | { readonly event: "load" }
  /** The person pressed Save, or Save & Exit (`exit`). */
  | { readonly event: "save"; readonly xml: string; readonly exit: boolean }
  /** The answer to `export`: `data` is a data URI. */
  | { readonly event: "export"; readonly format: string | null; readonly data: string }
  /** The person pressed Exit. */
  | { readonly event: "exit" };

export type DrawioAction =
  /** The answer to `configure`: the editor's defaults, here a diagram theme's. */
  | { readonly action: "configure"; readonly config: DrawioThemeConfig }
  | { readonly action: "load"; readonly xml: string; readonly title?: string }
  | {
      readonly action: "export";
      readonly format: "svg" | "png";
      readonly spinKey?: string;
      readonly background?: string;
    }
  /** Clears the frame's "unsaved changes" state after a save. */
  | { readonly action: "status"; readonly modified: boolean };

export interface DrawioFrame {
  post(action: DrawioAction): void;
  /** Hears the frame's events until the returned function is called. */
  listen(handler: (event: DrawioEvent) => void): () => void;
  remove(): void;
}

/** Reads one postMessage payload from the frame. */
export function parseDrawioMessage(data: unknown): DrawioEvent | null {
  if (typeof data !== "string" || data === "") return null;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (!message || typeof message !== "object") return null;
  const fields = message as Record<string, unknown>;
  switch (fields.event) {
    case "configure":
    case "init":
    case "load":
    case "exit":
      return { event: fields.event };
    case "save":
      return typeof fields.xml === "string"
        ? { event: "save", xml: fields.xml, exit: fields.exit === true }
        : null;
    case "export": {
      if (typeof fields.data !== "string") return null;
      // Draw.io echoes the request it answers in `message`.
      const asked = (fields.message as { readonly format?: unknown } | null | undefined)?.format;
      const format = typeof fields.format === "string" ? fields.format : asked;
      return {
        event: "export",
        format: typeof format === "string" ? format : null,
        data: fields.data,
      };
    }
    default:
      return null;
  }
}

/**
 * The editor people draw in: Save & Exit and Exit, no separate Save button. It
 * asks for its configuration first (`configure=1`): the session answers with
 * the diagram's theme, so new shapes and connections come out styled.
 */
export function drawioEditorUrl(options: { readonly dark: boolean }): string {
  const query = new URLSearchParams({
    embed: "1",
    proto: "json",
    spin: "1",
    libraries: "1",
    ui: "kennedy",
    configure: "1",
    saveAndExit: "1",
    noSaveBtn: "1",
    // Said either way, so the editor follows this app and not the system.
    dark: options.dark ? "1" : "0",
  });
  return `${DRAWIO_ORIGIN}/?${query}`;
}

/** The frame that only draws pictures: no buttons, no spinner, always light. */
export const DRAWIO_RENDERER_URL = `${DRAWIO_ORIGIN}/?${new URLSearchParams({
  embed: "1",
  proto: "json",
  spin: "0",
  noSaveBtn: "1",
  noExitBtn: "1",
  dark: "0",
})}`;

/**
 * Puts a Draw.io frame in the page. Only messages from that frame's own
 * window, at Draw.io's origin, are heard; the source is posted to that origin
 * alone, so it reaches nothing the frame may have navigated to.
 */
export function mountDrawioFrame(options: {
  readonly url: string;
  readonly parent: HTMLElement;
  readonly title: string;
  /** Set for the picture frame: off screen to the eye, but laid out at a real size. */
  readonly hidden?: boolean;
}): DrawioFrame {
  const frame = document.createElement("iframe");
  frame.title = options.title;
  if (options.hidden) {
    // A hidden frame still needs a real size, or Draw.io drops the edges from the picture.
    frame.style.cssText =
      "position:fixed;left:0;top:0;width:1200px;height:800px;opacity:0;pointer-events:none;" +
      "z-index:-1;border:0;";
    frame.tabIndex = -1;
    frame.setAttribute("aria-hidden", "true");
  } else {
    frame.allow = "clipboard-read; clipboard-write";
  }
  frame.src = options.url;

  const handlers = new Set<(event: DrawioEvent) => void>();
  const onMessage = (message: MessageEvent) => {
    if (message.source !== frame.contentWindow || message.origin !== DRAWIO_ORIGIN) return;
    const event = parseDrawioMessage(message.data);
    if (event) for (const handler of [...handlers]) handler(event);
  };
  window.addEventListener("message", onMessage);
  options.parent.append(frame);

  return {
    post: (action) => frame.contentWindow?.postMessage(JSON.stringify(action), DRAWIO_ORIGIN),
    listen: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    remove: () => {
      window.removeEventListener("message", onMessage);
      handlers.clear();
      frame.remove();
    },
  };
}

/** Draw.io did not answer in time: it is unreachable, or it could not open the source. */
export class DrawioTimeoutError extends Error {
  constructor(what: string) {
    super(`Draw.io did not ${what} in time.`);
  }
}

/** The next event of one kind, or DrawioTimeoutError. */
export function nextDrawioEvent<Name extends DrawioEvent["event"]>(
  frame: DrawioFrame,
  name: Name,
  options: { readonly timeoutMs: number; readonly what: string },
): Promise<Extract<DrawioEvent, { readonly event: Name }>> {
  return new Promise((resolve, reject) => {
    const stop = frame.listen((event) => {
      if (event.event !== name) return;
      clearTimeout(timer);
      stop();
      resolve(event as Extract<DrawioEvent, { readonly event: Name }>);
    });
    const timer = setTimeout(() => {
      stop();
      reject(new DrawioTimeoutError(options.what));
    }, options.timeoutMs);
  });
}

const fromBase64 = (text: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(text), (char) => char.charCodeAt(0)));

/** The SVG text inside the data URI Draw.io answers an SVG export with. */
export function svgFromDataUri(data: string): string | null {
  const match = /^data:image\/svg\+xml(?:;charset=[^;,]+)?(;base64)?,(.*)$/s.exec(data);
  try {
    const svg = match ? (match[1] ? fromBase64(match[2]!) : decodeURIComponent(match[2]!)) : data;
    return /<svg[\s>]/.test(svg) ? svg : null;
  } catch {
    return null;
  }
}

/** The base64 inside the data URI Draw.io answers a PNG export with. */
export function pngBase64FromDataUri(data: string): string | null {
  const base64 = /^data:image\/png;base64,([A-Za-z0-9+/]+=*)$/.exec(data)?.[1];
  // A failed bitmap comes back as "data:," or a one-pixel image: not a picture worth storing.
  return base64 && base64.length > 256 ? base64 : null;
}

/**
 * Pins an exported SVG to its light colours. Draw.io marks an SVG as following
 * the viewer's light or dark preference; the picture always sits on a white
 * card, so a dark-mode viewer must still get the light drawing.
 */
export function lightSvg(svg: string): string {
  const start = svg.search(/<svg[\s>]/);
  const end = start === -1 ? -1 : svg.indexOf(">", start);
  if (end === -1) return svg;
  const root = svg
    .slice(start, end + 1)
    .replace(/color-scheme\s*:\s*light\s+dark/gi, "color-scheme: light");
  return svg.slice(0, start) + root + svg.slice(end + 1);
}

export interface DrawioPicture {
  readonly svg: string;
  /** Base64. Null when the browser did not produce a PNG in time. */
  readonly png: string | null;
}

const SVG_EXPORT_MS = 20_000;
const PNG_EXPORT_MS = 15_000;

/**
 * Asks the frame for a picture of what is on its canvas: the SVG, then the
 * PNG. The SVG is required; the PNG is best effort, since some browsers cannot
 * turn a drawing with rich text into a bitmap.
 */
export async function exportDrawioPicture(
  frame: DrawioFrame,
  options: { readonly spinKey?: string } = {},
): Promise<DrawioPicture> {
  const spin = options.spinKey === undefined ? {} : { spinKey: options.spinKey };
  const answered = nextDrawioEvent(frame, "export", {
    timeoutMs: SVG_EXPORT_MS,
    what: "draw the picture",
  });
  frame.post({ action: "export", format: "svg", ...spin });
  const svg = svgFromDataUri((await answered).data);
  if (svg === null) throw new Error("Draw.io answered with something that is not an SVG.");

  const bitmap = nextDrawioEvent(frame, "export", {
    timeoutMs: PNG_EXPORT_MS,
    what: "draw the bitmap",
  });
  // On white: agents are handed the PNG, and a transparent one reads as black to some.
  frame.post({ action: "export", format: "png", background: "#ffffff", ...spin });
  const png = await bitmap.then(
    (event) => pngBase64FromDataUri(event.data),
    () => null,
  );
  // Only the font subsets the picture shows: a Google-font theme otherwise adds ~0.5 MB.
  return { svg: trimSvgFonts(lightSvg(svg)), png };
}

/** A picture of every page: the first page's at the top, as an upload sends it. */
export interface DrawioPictures extends DrawioPicture {
  /** Every page's name, in order; null when the source could not be split into pages. */
  readonly pageNames: ReadonlyArray<string | null> | null;
  /** The second page's picture on, up to MAX_DIAGRAM_PAGES pages in all. */
  readonly morePages: ReadonlyArray<DrawioPicture>;
}

const LOAD_PAGE_MS = 20_000;

/**
 * Draws a picture of each page of `xml` in a frame that is ready for `load`:
 * every page is loaded on its own and exported, so each picture shows that
 * page alone. A source of one page, or one this app cannot split, is loaded
 * whole and exported once.
 */
export async function drawDrawioPictures(
  frame: DrawioFrame,
  xml: string,
  options: { readonly loadTimeoutMs?: number } = {},
): Promise<DrawioPictures> {
  const timeoutMs = options.loadTimeoutMs ?? LOAD_PAGE_MS;
  const sources = drawioPageSources(xml);
  const draw = async (source: string) => {
    const loaded = nextDrawioEvent(frame, "load", { timeoutMs, what: "open the diagram" });
    frame.post({ action: "load", xml: source });
    await loaded;
    return exportDrawioPicture(frame);
  };
  if (sources === null || sources.length <= 1) {
    const picture = await draw(xml);
    return {
      ...picture,
      pageNames: sources?.length === 1 ? [sources[0]!.name] : null,
      morePages: [],
    };
  }
  const pictures: Array<DrawioPicture> = [];
  for (const source of sources.slice(0, MAX_DIAGRAM_PAGES)) pictures.push(await draw(source.xml));
  const [first, ...morePages] = pictures;
  return { ...first!, pageNames: sources.map((source) => source.name), morePages };
}
