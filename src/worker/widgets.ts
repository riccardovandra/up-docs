// Diagram checks on the tab write paths. Every REST and MCP write that adds or
// changes a ```t3-widget block is validated; a diagram left byte-identical is
// not, so older content never blocks an unrelated edit.

import { checkMarkdownWidgets, type WidgetProblem } from "../shared/widget/check.ts";

export function widgetProblems(
  markdown: string,
  previous?: string,
): ReadonlyArray<WidgetProblem> | null {
  if (!markdown.includes("t3-widget")) return null;
  const problems = checkMarkdownWidgets(markdown, previous);
  return problems.length > 0 ? problems : null;
}
