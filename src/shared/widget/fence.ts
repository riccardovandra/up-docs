// Diagrams are stored in a tab's markdown as a fenced block whose info string
// names the language and the diagram's stable id:
//
//   ```t3-widget id=release-flow
//   export default () => <svg …>…</svg>;
//   ```
//
// The body is the module source, verbatim.

export const WIDGET_LANGUAGE = "t3-widget";

/** The diagram id in a code block's info string, `""` when it has none, null when not a widget. */
export function widgetInfo(info: string | null | undefined): { readonly id: string } | null {
  if (!info) return null;
  const [language, ...rest] = info.trim().split(/\s+/);
  if (language !== WIDGET_LANGUAGE) return null;
  const id = rest.find((part) => part.startsWith("id="))?.slice(3) ?? "";
  return { id };
}

export const widgetInfoString = (id: string) => `${WIDGET_LANGUAGE} id=${id}`;

export interface WidgetFence {
  /** The id from the info string; may be empty or malformed (see checkMarkdownWidgets). */
  readonly id: string;
  readonly source: string;
  /** 1-based markdown line of the opening fence. */
  readonly line: number;
  /** Maps a source offset to its markdown offset. */
  readonly toMarkdown: (offset: number) => number;
}

/**
 * Every top-level ```t3-widget block, following CommonMark fences: a block
 * closes at a line holding at least as many of the same fence characters, and
 * fences inside other code blocks are not seen. Content lines lose up to the
 * opening fence's indentation, as CommonMark strips it.
 */
export function findWidgetFences(markdown: string): ReadonlyArray<WidgetFence> {
  const fences: Array<WidgetFence> = [];
  const lines: Array<{ readonly text: string; readonly start: number }> = [];
  for (let start = 0; start <= markdown.length;) {
    const newline = markdown.indexOf("\n", start);
    const end = newline === -1 ? markdown.length : newline;
    lines.push({ text: markdown.slice(start, end), start });
    if (newline === -1) break;
    start = newline + 1;
  }

  for (let index = 0; index < lines.length; index++) {
    const opening = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[index]!.text);
    if (!opening) continue;
    const indent = opening[1]!.length;
    const fence = opening[2]!;
    const info = opening[3]!;
    if (fence.startsWith("`") && info.includes("`")) continue;
    const closing = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
    let close = index + 1;
    while (close < lines.length && !closing.test(lines[close]!.text)) close++;
    const widget = widgetInfo(info);
    if (widget) {
      const body = lines.slice(index + 1, close).map((line) => {
        const stripped = /^ */.exec(line.text)![0].length;
        const cut = Math.min(stripped, indent);
        return { text: line.text.slice(cut), start: line.start + cut };
      });
      const source = body.map((line) => line.text).join("\n");
      fences.push({
        id: widget.id,
        source,
        line: index + 1,
        toMarkdown: (offset) => {
          let at = 0;
          for (const line of body) {
            if (offset <= at + line.text.length) return line.start + (offset - at);
            at += line.text.length + 1;
          }
          return (body.at(-1)?.start ?? lines[index]!.start) + (body.at(-1)?.text.length ?? 0);
        },
      });
    }
    index = close;
  }
  return fences;
}

/** Replaces `[start, end)` of a fence's source with `text`, in the markdown. */
export function spliceFenceSource(
  markdown: string,
  fence: WidgetFence,
  start: number,
  end: number,
  text: string,
): string {
  return markdown.slice(0, fence.toMarkdown(start)) + text + markdown.slice(fence.toMarkdown(end));
}
