import type { DiagramUse } from "../../shared/drawio.ts";

/** The "Used in" list shows a filter box from this many docs. */
export const USED_IN_FILTER_FROM = 6;

export interface UseGroup {
  readonly docId: string;
  readonly docTitle: string;
  readonly uses: ReadonlyArray<DiagramUse>;
}

/**
 * The tabs that embed a diagram, one group per doc in first-seen order. A
 * filter keeps a whole doc when its title matches, otherwise only its
 * matching tabs; docs with nothing left drop out.
 */
export function groupUses(uses: ReadonlyArray<DiagramUse>, filter: string): UseGroup[] {
  const groups = new Map<string, { docId: string; docTitle: string; uses: DiagramUse[] }>();
  for (const use of uses) {
    const group = groups.get(use.docId);
    if (group) group.uses.push(use);
    else groups.set(use.docId, { docId: use.docId, docTitle: use.docTitle, uses: [use] });
  }
  const needle = filter.trim().toLowerCase();
  if (!needle) return [...groups.values()];
  const matches = (text: string) => text.toLowerCase().includes(needle);
  return [...groups.values()].flatMap((group) => {
    if (matches(group.docTitle)) return [group];
    const kept = group.uses.filter((use) => matches(use.tabTitle));
    return kept.length > 0 ? [{ ...group, uses: kept }] : [];
  });
}
