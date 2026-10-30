import { describe, expect, it } from "vitest";

import {
  compileWidget,
  WIDGET_BUDGET_MESSAGE,
  WIDGET_DRAWING,
  WIDGET_FRAGMENT,
  WIDGET_H,
  WIDGET_STEP,
} from "./compile.ts";
import { FLOW_EXAMPLE, PILLARS_EXAMPLE } from "./testing/examples.ts";

interface VNode {
  readonly tag: unknown;
  readonly props: Record<string, unknown>;
  readonly children: ReadonlyArray<unknown>;
}

/** Runs compiled code the way the sandbox does, with a plain h(). */
function draw(source: string): VNode {
  const compiled = compileWidget(source);
  if (!compiled.ok) throw new Error(compiled.message);
  const factory = new Function(
    WIDGET_H,
    WIDGET_FRAGMENT,
    `"use strict"; let ${WIDGET_DRAWING};\n${compiled.code}\n; return ${WIDGET_DRAWING};`,
  );
  const h = (tag: unknown, props: Record<string, unknown>, ...children: Array<unknown>) => ({
    tag,
    props,
    children: children.flat(),
  });
  const drawing = factory(h, "fragment") as () => VNode;
  return drawing();
}

const texts = (node: unknown): Array<string> => {
  if (typeof node === "string") return [node];
  if (!node || typeof node !== "object") return [];
  return (node as VNode).children.flatMap(texts);
};

describe("compileWidget", () => {
  it("turns the flow example into h() calls that draw its svg", () => {
    const tree = draw(FLOW_EXAMPLE);
    expect(tree.tag).toBe("svg");
    expect(tree.props.viewBox).toBe("0 0 760 280");
    expect(texts(tree)).toContain("Ship to production");
    // Helpers ran: five boxes from box(), plus the decision polygon.
    expect(JSON.stringify(tree).match(/"tag":"rect"/g)).toHaveLength(5);
  });

  it("keeps template paths and computed attributes", () => {
    const tree = draw(PILLARS_EXAMPLE);
    const json = JSON.stringify(tree);
    expect(json).toContain('"fill":"var(--cds-chart-categorical-1)"');
    expect(texts(tree)).toContain("Foundation: reliability, security, support");
  });

  it("supports fragments, spreads, components and JSX whitespace", () => {
    const tree = draw(
      `const Dot = ({r, children}) => <circle r={r}>{children}</circle>;
export default () => <svg viewBox='0 0 10 10'><>
  <Dot r={2} {...{ cx: 1 }}>a</Dot>
  <text data-claude-text-id='t'>
    Two   words
    here
  </text>
</></svg>;`,
    );
    const fragment = tree.children[0] as VNode;
    expect(fragment.tag).toBe("fragment");
    const [dot, text] = fragment.children as Array<VNode>;
    expect(dot!.props).toEqual({ r: 2, cx: 1 });
    expect(text!.children).toEqual(["Two   words here"]);
  });

  it("copies non-JSX code byte for byte, counting each function's steps", () => {
    const compiled = compileWidget(
      "const a = 1 /* keep */;\nexport default () => <svg viewBox='0 0 1 1'/>;",
    );
    expect(compiled.ok && compiled.code.slice(compiled.code.indexOf("\n") + 1)).toBe(
      `const a = 1 /* keep */;\n${WIDGET_DRAWING} = (() => (${WIDGET_STEP}(), ${WIDGET_H}("svg", {"viewBox": "0 0 1 1"})));`,
    );
  });

  it("stops a module that never finishes instead of hanging", () => {
    const svg = "<svg viewBox='0 0 1 1'/>";
    for (const body of [
      "while (true) {}",
      "for (;;) ;",
      "do {} while (true);",
      "function f() { try { return f(); } catch { return f(); } } f();",
      "for (;;) { try { [1].map((x) => x); } catch {} }",
      "Array.from({ length: 1e9 }, (_, i) => i);",
    ]) {
      expect(() => draw(`export default () => { ${body} return ${svg}; };`), body).toThrow(
        WIDGET_BUDGET_MESSAGE,
      );
    }
    // Plain recursion already ends at the stack limit; recursion that catches
    // that error would otherwise branch for ever (the try/catch case above).
    expect(() =>
      draw(`const spin = (n) => spin(n + 1);\nexport default () => { spin(0); return ${svg}; };`),
    ).toThrow();
    // A component that loops runs while the sandbox builds the tree.
    const Loop = "const Spin = () => { for (const x of [1]) { while (x) {} } return null; };";
    const compiled = compileWidget(`${Loop}\nexport default () => ${svg};`);
    expect(compiled.ok && compiled.code).toContain(`while (x) {${WIDGET_STEP}();}`);
  });

  it("leaves bounded loops and helpers working", () => {
    const tree = draw(
      `const dots = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(<circle r={i} />); return out; };
export default () => <svg viewBox='0 0 10 10'>{dots(3)}{[1, 2].map((r) => <rect width={r} />)}</svg>;`,
    );
    expect(tree.children.map((node) => (node as VNode).tag)).toEqual([
      "circle",
      "circle",
      "circle",
      "rect",
      "rect",
    ]);
  });
});
