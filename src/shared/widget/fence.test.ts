import { describe, expect, it } from "vitest";

import { checkMarkdownWidgets } from "./check.ts";
import { findWidgetFences, spliceFenceSource, widgetInfo } from "./fence.ts";

const good =
  "export default () => <svg viewBox='0 0 760 40'><text data-claude-text-id='t' fill='var(--cds-text-primary)'>Hi</text></svg>;";
const bad =
  "export default () => <svg viewBox='0 0 760 40'><text data-claude-text-id='t' fill='red'>Hi</text></svg>;";

describe("widget fences", () => {
  it("reads the diagram id from the info string", () => {
    expect(widgetInfo("t3-widget id=flow")).toEqual({ id: "flow" });
    expect(widgetInfo("t3-widget")).toEqual({ id: "" });
    expect(widgetInfo("mermaid")).toBeNull();
  });

  it("finds widget blocks, skipping fences inside other code blocks", () => {
    const markdown = `# A\n\n\`\`\`t3-widget id=one\n${good}\n\`\`\`\n\n\`\`\`\`md\n\`\`\`t3-widget id=quoted\nx\n\`\`\`\n\`\`\`\`\n\n~~~t3-widget id=two\nline1\n\nline3\n~~~\n`;
    const fences = findWidgetFences(markdown);
    expect(fences.map((fence) => [fence.id, fence.line])).toEqual([
      ["one", 3],
      ["two", 13],
    ]);
    expect(fences[1]!.source).toBe("line1\n\nline3");
  });

  it("maps source offsets back into the markdown, indented fences included", () => {
    const markdown = "- item\n\n  ```t3-widget id=a\n  abc\n  def\n  ```\n";
    const [fence] = findWidgetFences(markdown);
    expect(fence!.source).toBe("abc\ndef");
    const at = fence!.source.indexOf("def");
    expect(spliceFenceSource(markdown, fence!, at, at + 3, "XYZ")).toBe(
      "- item\n\n  ```t3-widget id=a\n  abc\n  XYZ\n  ```\n",
    );
  });

  it("checks new or changed diagrams and leaves identical ones alone", () => {
    const fence = (id: string, body: string) => `\`\`\`t3-widget id=${id}\n${body}\n\`\`\``;
    expect(checkMarkdownWidgets(fence("a", good))).toEqual([]);
    const problems = checkMarkdownWidgets(fence("a", bad));
    expect(problems[0]?.diagnostics.map((entry) => entry.rule)).toEqual(["colour"]);
    expect(checkMarkdownWidgets(`${fence("a", bad)}\n\nmore`, fence("a", bad))).toEqual([]);
    expect(checkMarkdownWidgets(`\`\`\`t3-widget\n${good}\n\`\`\``)[0]?.diagnostics[0]?.rule).toBe(
      "diagram-id",
    );
    expect(
      checkMarkdownWidgets(`${fence("a", good)}\n\n${fence("a", good)}`)[0]?.diagnostics[0]?.rule,
    ).toBe("diagram-id");
  });
});
