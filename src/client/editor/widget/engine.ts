// The heavy half of the widget renderer (Babel's parser), loaded with a tab's
// first diagram.

import { compileWidget } from "../../../shared/widget/compile.ts";
import { analyzeWidget, type WidgetAnalysis } from "../../../shared/widget/validate.ts";

export { rewriteLabel } from "../../../shared/widget/rewrite.ts";
export { formatDiagnostic } from "../../../shared/widget/validate.ts";

export interface PreparedWidget {
  readonly analysis: WidgetAnalysis;
  /** The script the sandbox runs; null when the module does not parse. */
  readonly code: string | null;
  readonly compileError: string | null;
}

const CAPACITY = 64;
const cache = new Map<string, PreparedWidget>();

/** Analysed and compiled once per distinct source, so recreated views paint at once. */
export function prepareWidget(source: string): PreparedWidget {
  const cached = cache.get(source);
  if (cached) {
    cache.delete(source);
    cache.set(source, cached);
    return cached;
  }
  const analysis = analyzeWidget(source);
  const compiled = compileWidget(source);
  const prepared: PreparedWidget = {
    analysis,
    code: compiled.ok ? compiled.code : null,
    compileError: compiled.ok ? null : compiled.message,
  };
  cache.set(source, prepared);
  if (cache.size > CAPACITY) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return prepared;
}
