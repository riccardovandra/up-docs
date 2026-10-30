import { findWidgetFences, type WidgetFence } from "./fence.ts";
import { analyzeWidget, SLUG, type WidgetDiagnostic } from "./validate.ts";

export interface WidgetProblem {
  readonly diagramId: string;
  /** Markdown line of the opening fence. */
  readonly line: number;
  readonly diagnostics: ReadonlyArray<
    Omit<WidgetDiagnostic, "rule"> & { readonly rule: WidgetDiagnostic["rule"] | "diagram-id" }
  >;
}

const fenceKey = (fence: WidgetFence) => `${fence.id}\n${fence.source}`;

/**
 * The diagrams in `markdown` that break the format. A diagram that is
 * byte-identical (same id and source) in `previous` is left alone, so an
 * older diagram never blocks an unrelated edit to its tab.
 */
export function checkMarkdownWidgets(
  markdown: string,
  previous = "",
): ReadonlyArray<WidgetProblem> {
  const fences = findWidgetFences(markdown);
  if (fences.length === 0) return [];
  const unchanged = new Set(findWidgetFences(previous).map(fenceKey));
  const counts = new Map<string, number>();
  for (const fence of fences) counts.set(fence.id, (counts.get(fence.id) ?? 0) + 1);

  const problems: Array<WidgetProblem> = [];
  for (const fence of fences) {
    if (unchanged.has(fenceKey(fence))) continue;
    const diagnostics: Array<WidgetProblem["diagnostics"][number]> = [];
    if (!SLUG.test(fence.id)) {
      diagnostics.push({
        rule: "diagram-id",
        message:
          "Name the diagram in its fence: ```t3-widget id=<slug> (letters, digits, _ and -).",
        line: 0,
        column: 0,
      });
    } else if ((counts.get(fence.id) ?? 0) > 1) {
      diagnostics.push({
        rule: "diagram-id",
        message: `Two diagrams in this tab are named '${fence.id}'; each id appears once.`,
        line: 0,
        column: 0,
      });
    }
    diagnostics.push(...analyzeWidget(fence.source).diagnostics);
    if (diagnostics.length > 0)
      problems.push({ diagramId: fence.id, line: fence.line, diagnostics });
  }
  return problems;
}

/** One line per diagnostic, for error messages agents read. */
export function describeWidgetProblems(problems: ReadonlyArray<WidgetProblem>): string {
  return problems
    .flatMap((problem) =>
      problem.diagnostics.map(
        (entry) =>
          `diagram '${problem.diagramId || "(no id)"}' (fence at markdown line ${problem.line})` +
          (entry.line ? ` ${entry.line}:${entry.column}` : "") +
          ` ${entry.rule}: ${entry.message}`,
      ),
    )
    .join("\n");
}
