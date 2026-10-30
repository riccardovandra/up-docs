import * as NodeFS from "node:fs";

import { describe, expect, it } from "vitest";

import { compileWidget, WIDGET_BUDGET_MESSAGE } from "../../../shared/widget/compile.ts";
import { WIDGET_SRCDOC } from "./frame.ts";

/** Boots the sandbox's own runtime against a minimal fake DOM and renders one module. */
function renderInSandbox(source: string): ReadonlyArray<Record<string, unknown>> {
  const compiled = compileWidget(source);
  if (!compiled.ok) throw new Error(compiled.message);
  const sent: Array<Record<string, unknown>> = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const node = () => ({ setAttribute() {}, appendChild() {} });
  const fakeWindow: Record<string, unknown> = {
    parent: { postMessage: (message: Record<string, unknown>) => sent.push(message) },
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
  };
  const fakeDocument = {
    addEventListener() {},
    body: { classList: { toggle() {} }, replaceChildren() {} },
    documentElement: { style: { setProperty() {} } },
    head: {
      appendChild: (script: { textContent: string }) =>
        new Function("window", script.textContent)(fakeWindow),
    },
    createElement: () => ({ remove() {} }),
    createElementNS: node,
    createDocumentFragment: node,
    createTextNode: () => ({}),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const runtime = /<script>([\s\S]*)<\/script>/.exec(WIDGET_SRCDOC)?.[1] ?? "";
  new Function("window", "document", runtime)(fakeWindow, fakeDocument);
  listeners.get("message")?.({
    source: fakeWindow.parent,
    data: { type: "render", nonce: 1, code: compiled.code, editable: false },
  });
  return sent.filter((message) => message.type !== "ready");
}

describe("widget sandbox", () => {
  it("reports a module that never finishes as the diagram's error", () => {
    expect(
      renderInSandbox("export default () => { while (true) {} return <svg viewBox='0 0 1 1'/>; };"),
    ).toEqual([{ source: "t3-widget", type: "error", nonce: 1, message: WIDGET_BUDGET_MESSAGE }]);
  });

  it("renders a module that finishes", () => {
    expect(renderInSandbox("export default () => <svg viewBox='0 0 1 1'/>;")).toEqual([
      { source: "t3-widget", type: "rendered", nonce: 1 },
    ]);
  });
});

describe("widget frame colour scheme", () => {
  // `normal` on the iframe follows the page's dark scheme while the srcdoc's
  // stays light, and Chrome then paints an opaque light canvas behind it.
  it("gives the iframe and its document the same explicit scheme", () => {
    const css = NodeFS.readFileSync(new URL("./widget.css", import.meta.url), "utf8");
    const frameScheme = /\.widget-frame\s*\{[^}]*color-scheme:\s*([\w-]+)/.exec(css)?.[1];
    const documentScheme = /:root\s*\{\s*color-scheme:\s*([\w-]+)/.exec(WIDGET_SRCDOC)?.[1];
    expect(documentScheme).toBe("light");
    expect(frameScheme).toBe(documentScheme);
  });
});
