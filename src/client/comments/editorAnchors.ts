import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import { anchorAt, locateAnchor, type DocAnchor } from "../../shared/anchors.ts";
import { isTableNode } from "../editor/table/TableView.ts";

/**
 * The editor's visible text, with a newline between blocks, in the same shape
 * as the Worker's `markdownToText`. `positions[i]` is the editor position of
 * character `i`, or -1 for a block separator.
 */
export interface DocTextIndex {
  readonly text: string;
  readonly positions: ReadonlyArray<number>;
}

export function buildDocTextIndex(doc: ProseMirrorNode): DocTextIndex {
  let text = "";
  const positions: Array<number> = [];
  const separate = () => {
    if (text.length > 0 && !text.endsWith("\n")) {
      text += "\n";
      positions.push(-1);
    }
  };
  doc.descendants((node, pos) => {
    if (node.isText) {
      const value = node.text ?? "";
      for (let offset = 0; offset < value.length; offset += 1) {
        text += value[offset];
        positions.push(pos + offset);
      }
      return false;
    }
    // A rich table's text is its JSON; its cells take cell anchors instead.
    if (isTableNode(node)) return false;
    if (node.type.name === "hardBreak" || node.isTextblock) separate();
    return true;
  });
  return { text, positions };
}

/** Captures an anchor for the editor range `from..to`, or null when it holds no text. */
export function captureDocAnchor(index: DocTextIndex, from: number, to: number): DocAnchor | null {
  let start = index.positions.findIndex((position) => position >= from);
  if (start === -1) return null;
  let end = start;
  while (end < index.positions.length) {
    const position = index.positions[end]!;
    if (position !== -1 && position >= to) break;
    end += 1;
  }
  while (start < end && /\s/.test(index.text[start]!)) start += 1;
  while (end > start && /\s/.test(index.text[end - 1]!)) end -= 1;
  if (start === end) return null;
  return anchorAt(index.text, start, end);
}

/** The editor range for an anchor, or null when the quoted text is gone. */
export function resolveDocAnchor(
  index: DocTextIndex,
  anchor: DocAnchor,
): { readonly from: number; readonly to: number } | null {
  const located = locateAnchor(index.text, anchor);
  if (located === null) return null;
  const from = index.positions[located.start];
  const last = index.positions[located.end - 1];
  if (from === undefined || last === undefined || from === -1 || last === -1) return null;
  return { from, to: last + 1 };
}
