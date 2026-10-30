import { describe, expect, it } from "vitest";

import { rewriteLabel } from "./rewrite.ts";
import { FLOW_EXAMPLE } from "./testing/examples.ts";
import { analyzeWidget } from "./validate.ts";

describe("rewriteLabel", () => {
  it("changes only that label's words", () => {
    const result = rewriteLabel(FLOW_EXAMPLE, "ship", "THIS IS CHANGED");
    if (!result.ok) throw new Error(result.message);
    expect(result.previous).toBe("Ship to production");
    const at = FLOW_EXAMPLE.indexOf("Ship to production");
    expect(result.source).toBe(
      FLOW_EXAMPLE.slice(0, at) +
        "THIS IS CHANGED" +
        FLOW_EXAMPLE.slice(at + "Ship to production".length),
    );
    expect(analyzeWidget(result.source).diagnostics).toEqual([]);
  });

  it("keeps the whitespace around multi-line JSX text and escapes JSX syntax", () => {
    const source =
      "export default () => <svg viewBox='0 0 1 1'>\n  <text data-claude-text-id='a'>\n    Old\n  </text>\n</svg>;\n";
    const result = rewriteLabel(source, "a", "a < b & {c}");
    if (!result.ok) throw new Error(result.message);
    expect(result.source).toBe(
      "export default () => <svg viewBox='0 0 1 1'>\n  <text data-claude-text-id='a'>\n    a &#60; b &#38; &#123;c&#125;\n  </text>\n</svg>;\n",
    );
    expect(analyzeWidget(result.source).labels[0]?.text).toBe("a < b & {c}");
  });

  it("reports no change for the same words, and refuses unknown ids and empty words", () => {
    expect(rewriteLabel(FLOW_EXAMPLE, "ship", " Ship to  production ")).toMatchObject({
      ok: true,
      replacement: null,
    });
    expect(rewriteLabel(FLOW_EXAMPLE, "missing", "x")).toMatchObject({
      ok: false,
      error: "unknown_text_id",
    });
    expect(rewriteLabel(FLOW_EXAMPLE, "ship", "  ")).toMatchObject({
      ok: false,
      error: "invalid_value",
    });
  });
});
