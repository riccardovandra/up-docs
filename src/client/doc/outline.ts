import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export type OutlineLevel = 1 | 2 | 3;

export interface OutlineHeading {
  /** Stable across edits elsewhere in the doc: level, text, and occurrence. */
  readonly key: string;
  readonly level: OutlineLevel;
  readonly text: string;
  /** Document position of the heading node; valid only for the doc it came from. */
  readonly pos: number;
}

/**
 * H1–H3 headings of a document in reading order. Headings carry no ids, so the
 * key is derived from level and text, with an occurrence suffix for repeats.
 * Empty headings are skipped; they appear once they have text.
 */
export function extractHeadings(doc: ProseMirrorNode): Array<OutlineHeading> {
  const headings: Array<OutlineHeading> = [];
  const seen = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return !node.isTextblock;
    const level = node.attrs.level as number;
    if (level < 1 || level > 3) return false;
    const text = node.textContent.replace(/\s+/g, " ").trim();
    if (!text) return false;
    const base = `${level}:${text}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    headings.push({
      key: occurrence === 0 ? base : `${base}#${occurrence}`,
      level: level as OutlineLevel,
      text,
      pos,
    });
    return false;
  });
  return headings;
}

/** Whether two outlines render the same; positions are ignored. */
export function sameOutline(
  a: ReadonlyArray<OutlineHeading>,
  b: ReadonlyArray<OutlineHeading>,
): boolean {
  return a.length === b.length && a.every((heading, index) => heading.key === b[index]!.key);
}

/** Keys in `next` that were not in `previous`, in reading order. */
export function newHeadingKeys(
  previous: ReadonlyArray<OutlineHeading>,
  next: ReadonlyArray<OutlineHeading>,
): Array<string> {
  const known = new Set(previous.map((heading) => heading.key));
  return next.filter((heading) => !known.has(heading.key)).map((heading) => heading.key);
}

/**
 * The section being read after an IntersectionObserver update. `inBand` holds
 * headings inside the reading band; `exitedBelow` holds headings that just left
 * it downward, which happens when scrolling back up past them. Between
 * headings the last one passed stays active.
 */
export function activeAfter(
  order: ReadonlyArray<string>,
  active: string | null,
  inBand: ReadonlySet<string>,
  exitedBelow: ReadonlySet<string>,
): string | null {
  const topmost = order.find((key) => inBand.has(key));
  if (topmost) return topmost;
  if (active === null) return null;
  const index = order.indexOf(active);
  if (index === -1) return null;
  return exitedBelow.has(active) ? (order[index - 1] ?? null) : active;
}
