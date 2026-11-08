// The browser half of a Scribe book: draws each diagram as a standalone SVG and
// fetches the doc's own images with the reader's session. The extension turns
// SVG into PNG, since Kindle does not show SVG reliably.

import { readFrameMessage, WIDGET_SRCDOC } from "../editor/widget/frame.ts";
import { COLOUR_TOKENS } from "../editor/widget/WidgetView.ts";
import type { DiagramRequest, ScribeImage } from "./scribeBook.ts";

const WIDGET_TIMEOUT_MS = 8000;
const SANS = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/** Paper colours, as the print view uses: e-ink is black on white. */
const PELE_PAPER: Record<string, string> = {
  "--pele-bg": "#ffffff",
  "--pele-fg": "#111111",
  "--pele-muted": "#555555",
  "--pele-line": "#555555",
  "--pele-surface": "#f2f2f2",
  "--pele-surface-alt": "#ffffff",
  "--pele-border": "rgba(17, 17, 17, 0.28)",
  "--pele-accent": "#333333",
  "--pele-critical": "#b42318",
  "--pele-font": SANS,
};

/** The widget frame's own print overrides, so text stays dark in a dark theme. */
const WIDGET_PAPER: Record<string, string> = {
  "--cds-text-primary": "#000",
  "--cds-text-secondary": "#555",
  "--cds-chart-axis": "#666",
  "--cds-chart-grid": "#ccc",
  "--cds-chart-reference-tint": "#f3f3f3",
  // The theme accent, which is near-white in dark mode and would vanish on paper.
  "--cds-chart-categorical-1": "#333333",
  "--widget-font": SANS,
};

const SVG_NS = "http://www.w3.org/2000/svg";

/** An SVG that renders on its own: namespaced, sized, with its colour variables set. */
export function standaloneSvg(markup: string, vars: Record<string, string>): string | null {
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  const svg = parsed.documentElement;
  if (svg.localName !== "svg" || parsed.querySelector("parsererror")) return null;
  svg.setAttribute("xmlns", SVG_NS);
  const style = Object.entries(vars)
    .map(([name, value]) => `${name}: ${value};`)
    .join(" ");
  svg.setAttribute("style", `${style} ${svg.getAttribute("style") ?? ""}`.trim());
  const box = (svg.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const [, , width, height] = box;
  // An image needs a size; without one the browser assumes 300 by 150.
  if (width && height && width > 0 && height > 0) {
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
  }
  return new XMLSerializer().serializeToString(svg);
}

async function mermaidSvg(source: string): Promise<string | null> {
  const { diagramCache } = await import("../editor/renderDiagram.ts");
  const render = await diagramCache.get(source);
  return render.status === "rendered" ? standaloneSvg(render.svg, PELE_PAPER) : null;
}

/** Runs one widget in a hidden sandboxed frame, as the editor does, and reads its SVG back. */
async function widgetSvg(source: string): Promise<string | null> {
  const { prepareWidget } = await import("../editor/widget/engine.ts");
  const code = prepareWidget(source).code;
  if (!code) return null;

  // The tokens live on .widget-block (widget.css), so they are read off a stand-in.
  const probe = document.createElement("div");
  probe.className = "widget-block";
  probe.hidden = true;
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const vars: Record<string, string> = {};
  for (const token of COLOUR_TOKENS) vars[token] = style.getPropertyValue(token).trim();
  probe.remove();
  Object.assign(vars, WIDGET_PAPER);

  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:760px;height:400px;border:0;";
  frame.srcdoc = WIDGET_SRCDOC;

  const nonce = 1;
  return new Promise<string | null>((resolve) => {
    const finish = (svg: string | null) => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      frame.remove();
      resolve(svg);
    };
    const timer = setTimeout(() => finish(null), WIDGET_TIMEOUT_MS);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const message = readFrameMessage(event.data);
      const target = frame.contentWindow;
      if (!message || !target) return;
      if (message.type === "ready") {
        target.postMessage({ type: "theme", vars }, "*");
        target.postMessage({ type: "render", nonce, code, editable: false }, "*");
      } else if (message.type === "rendered" && message.nonce === nonce) {
        target.postMessage({ type: "snapshot" }, "*");
      } else if (message.type === "snapshot") {
        finish(message.svg ? standaloneSvg(message.svg, vars) : null);
      } else if (message.type === "error") {
        finish(null);
      }
    };
    window.addEventListener("message", onMessage);
    document.body.append(frame);
  });
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

/** Diagrams that fail to draw are left out; the extension drops images it is not given. */
async function drawDiagram(request: DiagramRequest): Promise<ScribeImage | null> {
  const svg = await (request.kind === "mermaid" ? mermaidSvg : widgetSvg)(request.source).catch(
    () => null,
  );
  if (!svg) return null;
  return {
    url: request.url,
    mediaType: "image/svg+xml",
    base64: bytesToBase64(new TextEncoder().encode(svg)),
  };
}

async function fetchImage(url: string): Promise<ScribeImage | null> {
  try {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) return null;
    const blob = await response.blob();
    return {
      url,
      mediaType: blob.type.split(";")[0] || "application/octet-stream",
      base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
    };
  } catch {
    return null;
  }
}

export async function gatherAssets(input: {
  readonly diagrams: ReadonlyArray<DiagramRequest>;
  readonly sameOriginImages: ReadonlyArray<string>;
}): Promise<ReadonlyArray<ScribeImage>> {
  const images: Array<ScribeImage | null> = [];
  // One widget frame at a time keeps a long doc from opening dozens at once.
  for (const diagram of input.diagrams) images.push(await drawDiagram(diagram));
  images.push(...(await Promise.all(input.sameOriginImages.map(fetchImage))));
  return images.filter((image): image is ScribeImage => image !== null);
}
