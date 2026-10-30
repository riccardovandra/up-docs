// The sandbox a diagram runs in: an iframe with `sandbox="allow-scripts"` (an
// opaque origin, so no access to the page, its cookies or storage) and a CSP
// that blocks every network request. The page talks to it by postMessage.
//
// Page -> frame:
//   { type: "theme", vars: { "--cds-…": "<colour>", "--widget-font": "…" } }
//   { type: "render", nonce, code, editable }   code = compileWidget() output
//   { type: "hide", textId | null }             hides a label under the edit box
// Frame -> page (all carry source: "t3-widget"):
//   { type: "ready" }
//   { type: "rendered", nonce } | { type: "error", nonce, message }
//   { type: "pick", textId, anchor, rect, fontSize, textAnchor, fontWeight }
//     a click; rect is in the frame's CSS pixels, fontSize scaled to match

export const WIDGET_MESSAGE_SOURCE = "t3-widget";

export interface WidgetPick {
  readonly textId: string | null;
  readonly anchor: string | null;
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
  readonly fontSize: number;
  readonly textAnchor: string;
  readonly fontWeight: string;
}

export type FrameMessage =
  | { readonly type: "ready" }
  | { readonly type: "rendered"; readonly nonce: number }
  | { readonly type: "error"; readonly nonce: number; readonly message: string }
  | ({ readonly type: "pick" } & WidgetPick);

export function readFrameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as { source?: unknown; type?: unknown };
  if (message.source !== WIDGET_MESSAGE_SOURCE) return null;
  return ["ready", "rendered", "error", "pick"].includes(String(message.type))
    ? (data as FrameMessage)
    : null;
}

// Plain ES2020 kept as a string, so no bundler transform reaches it.
const RUNTIME = String.raw`
(() => {
  const host = window.parent;
  const SVG = "http://www.w3.org/2000/svg";
  const FRAGMENT = {};
  const CAMEL = new Set(["viewBox","preserveAspectRatio","markerWidth","markerHeight","markerUnits","refX","refY","gradientUnits","gradientTransform","patternUnits","patternContentUnits","patternTransform","clipPathUnits","maskUnits","maskContentUnits","textLength","lengthAdjust","startOffset","spreadMethod","pathLength","stdDeviation"]);
  const send = (message) => host.postMessage(Object.assign({ source: "t3-widget" }, message), "*");
  let nonce = 0;
  let svgWidth = 1;

  const h = (tag, props, ...children) => ({ tag, props: props || {}, children });
  const attributeName = (key) =>
    key === "className" ? "class" : CAMEL.has(key) || /[-:]/.test(key) ? key : key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

  const build = (node, parent) => {
    if (node == null || node === false || node === true) return;
    if (Array.isArray(node)) { for (const item of node) build(item, parent); return; }
    if (typeof node !== "object") { parent.appendChild(document.createTextNode(String(node))); return; }
    if (typeof node.tag === "function") {
      build(node.tag(Object.assign({}, node.props, { children: node.children.length === 1 ? node.children[0] : node.children })), parent);
      return;
    }
    if (node.tag === FRAGMENT) { build(node.children, parent); return; }
    const element = document.createElementNS(SVG, String(node.tag));
    for (const key of Object.keys(node.props)) {
      const value = node.props[key];
      if (key === "key" || key === "children" || value == null || value === false) continue;
      if (/^on/i.test(key) || /href$/i.test(key) || key === "style") continue;
      element.setAttribute(attributeName(key), value === true ? "" : String(value));
    }
    build(node.children, element);
    parent.appendChild(element);
  };

  window.__widgetRun = (factory) => {
    const current = nonce;
    try {
      const drawing = factory(h, FRAGMENT);
      const tree = typeof drawing === "function" ? drawing({}) : drawing;
      const root = document.createDocumentFragment();
      build(tree, root);
      document.body.replaceChildren(root);
      const svg = document.querySelector("svg");
      svgWidth = (svg && svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width) || 1;
      send({ type: "rendered", nonce: current });
    } catch (error) {
      send({ type: "error", nonce: current, message: String((error && error.message) || error) });
    }
  };
  window.addEventListener("error", (event) => {
    send({ type: "error", nonce, message: String(event.message || "The diagram failed to run.") });
  });

  window.addEventListener("message", (event) => {
    if (event.source !== host) return;
    const data = event.data || {};
    if (data.type === "theme") {
      for (const key of Object.keys(data.vars || {})) document.documentElement.style.setProperty(key, String(data.vars[key]));
    } else if (data.type === "render") {
      nonce = data.nonce;
      document.body.classList.toggle("editable", Boolean(data.editable));
      const script = document.createElement("script");
      script.textContent = "window.__widgetRun(function (__widget_h, __widget_fragment) {\n\"use strict\";\nlet __widget_drawing;\n" + data.code + "\n;return __widget_drawing;\n});";
      document.head.appendChild(script);
      script.remove();
    } else if (data.type === "hide") {
      for (const element of document.querySelectorAll("[data-widget-hidden]")) element.removeAttribute("data-widget-hidden");
      if (data.textId) {
        for (const element of document.querySelectorAll("[data-claude-text-id]")) {
          if (element.getAttribute("data-claude-text-id") === data.textId) element.setAttribute("data-widget-hidden", "");
        }
      }
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const label = target && target.closest("[data-claude-text-id]");
    const part = target && target.closest("[data-claude-anchor]");
    let rect = null, fontSize = 0, textAnchor = "start", fontWeight = "400";
    if (label) {
      const box = label.getBoundingClientRect();
      rect = { x: box.x, y: box.y, width: box.width, height: box.height };
      const svg = document.querySelector("svg");
      const scale = svg ? svg.getBoundingClientRect().width / svgWidth : 1;
      const style = getComputedStyle(label);
      fontSize = parseFloat(style.fontSize) * scale;
      textAnchor = style.textAnchor;
      fontWeight = style.fontWeight;
    }
    send({
      type: "pick",
      textId: label ? label.getAttribute("data-claude-text-id") : null,
      anchor: part ? part.getAttribute("data-claude-anchor") : null,
      rect, fontSize, textAnchor, fontWeight,
    });
  });

  send({ type: "ready" });
})();
`;

// Paper is always light: the frame's own print rule wins over posted colours.
// The scheme must match .widget-frame's in widget.css, or Chrome paints an
// opaque canvas behind the transparent frame.
const STYLE = `
:root { color-scheme: light; }
html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
svg { display: block; width: 100%; height: auto; font-family: var(--widget-font, system-ui, sans-serif); }
body.editable [data-claude-text-id] { cursor: text; }
[data-widget-hidden] { visibility: hidden; }
@media print {
  :root {
    --cds-text-primary: #000 !important;
    --cds-text-secondary: #555 !important;
    --cds-chart-axis: #666 !important;
    --cds-chart-grid: #ccc !important;
    --cds-chart-reference-tint: #f3f3f3 !important;
  }
}
`;

export const WIDGET_SRCDOC = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><style>${STYLE}</style></head><body><script>${RUNTIME}</script></body></html>`;
