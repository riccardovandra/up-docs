import { analyzeWidget } from "./validate.ts";

export const MAX_LABEL_LENGTH = 500;

export type LabelRewrite =
  | {
      readonly ok: true;
      readonly source: string;
      /** The label's words before the edit. */
      readonly previous: string;
      /** The source range replaced and its new text; null when the words did not change. */
      readonly replacement: {
        readonly start: number;
        readonly end: number;
        readonly text: string;
      } | null;
    }
  | {
      readonly ok: false;
      readonly error: "invalid_widget" | "unknown_text_id" | "invalid_value";
      readonly message: string;
    };

/** Writes words as JSX text: these characters would end or open JSX syntax. */
function escapeJsxText(value: string): string {
  return value.replace(/[&<>{}]/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * Replaces the words of one label, found by its text id. Only that JSXText
 * changes, and its surrounding whitespace is kept, so every other byte of the
 * module stays as it was.
 */
export function rewriteLabel(source: string, textId: string, value: string): LabelRewrite {
  const words = value.replace(/\s+/g, " ").trim();
  if (!words) return { ok: false, error: "invalid_value", message: "A label needs words." };
  if (words.length > MAX_LABEL_LENGTH) {
    return { ok: false, error: "invalid_value", message: "The label is too long." };
  }
  const analysis = analyzeWidget(source);
  const label = analysis.labels.find((entry) => entry.id === textId);
  if (!label) {
    return analysis.diagnostics.some((entry) => entry.rule === "parse")
      ? { ok: false, error: "invalid_widget", message: "The diagram does not parse." }
      : { ok: false, error: "unknown_text_id", message: `No label with the text id '${textId}'.` };
  }
  if (words === label.text) return { ok: true, source, previous: label.text, replacement: null };
  const raw = source.slice(label.start, label.end);
  const leading = /^\s*/.exec(raw)?.[0] ?? "";
  const trailing = /\s*$/.exec(raw.slice(leading.length))?.[0] ?? "";
  const next = leading + escapeJsxText(words) + trailing;
  return {
    ok: true,
    source: source.slice(0, label.start) + next + source.slice(label.end),
    previous: label.text,
    replacement: { start: label.start, end: label.end, text: next },
  };
}
