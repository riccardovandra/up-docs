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
