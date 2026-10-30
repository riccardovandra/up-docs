import type { Tab, TabPlacement } from "../../shared/protocol.ts";

/** Tabs in reading order: each tab followed by its children, siblings by position. */
export function orderTabs(tabs: ReadonlyArray<Tab>): ReadonlyArray<{ tab: Tab; depth: number }> {
  const children = new Map<string | null, Array<Tab>>();
  for (const tab of tabs) {
    const siblings = children.get(tab.parentTabId) ?? [];
    siblings.push(tab);
    children.set(tab.parentTabId, siblings);
  }
  const ordered: Array<{ tab: Tab; depth: number }> = [];
  const visit = (parentId: string | null, depth: number) => {
    const siblings = (children.get(parentId) ?? []).toSorted((a, b) => a.position - b.position);
    for (const tab of siblings) {
      ordered.push({ tab, depth });
      visit(tab.id, depth + 1);
    }
  };
  visit(null, 0);
  return ordered;
}

export function applyPlacements(
  tabs: ReadonlyMap<string, Tab>,
  placements: ReadonlyArray<TabPlacement>,
): ReadonlyMap<string, Tab> {
  const next = new Map(tabs);
  for (const { tabId, parentTabId, position } of placements) {
    const tab = next.get(tabId);
    if (tab) next.set(tabId, { ...tab, parentTabId, position });
  }
  return next;
}

export function removeTabs(
  tabs: ReadonlyMap<string, Tab>,
  tabIds: ReadonlyArray<string>,
): ReadonlyMap<string, Tab> {
  const next = new Map(tabs);
  for (const tabId of tabIds) next.delete(tabId);
  return next;
}

export type TabMove = "up" | "down" | "indent" | "outdent";

const siblingsOf = (tabs: ReadonlyArray<Tab>, parentTabId: string | null) =>
  tabs.filter((tab) => tab.parentTabId === parentTabId).toSorted((a, b) => a.position - b.position);

/**
 * The `moveTab` arguments for a rail menu action, or null when the action does
 * not apply. `position` is the index among the new siblings once the tab has
 * left its current place, which is what the server expects.
 */
export function moveTarget(
  tabs: ReadonlyArray<Tab>,
  tabId: string,
  move: TabMove,
): { readonly parentTabId: string | null; readonly position: number } | null {
  const tab = tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return null;
  const siblings = siblingsOf(tabs, tab.parentTabId);
  const index = siblings.findIndex((sibling) => sibling.id === tabId);
  switch (move) {
    case "up":
      return index > 0 ? { parentTabId: tab.parentTabId, position: index - 1 } : null;
    case "down":
      return index < siblings.length - 1
        ? { parentTabId: tab.parentTabId, position: index + 1 }
        : null;
    case "indent": {
      const previous = siblings[index - 1];
      return previous
        ? { parentTabId: previous.id, position: siblingsOf(tabs, previous.id).length }
        : null;
    }
    case "outdent": {
      const parent = tabs.find((candidate) => candidate.id === tab.parentTabId);
      if (!parent) return null;
      const parentIndex = siblingsOf(tabs, parent.parentTabId).findIndex(
        (sibling) => sibling.id === parent.id,
      );
      return { parentTabId: parent.parentTabId, position: parentIndex + 1 };
    }
  }
}

export function countDescendants(tabs: ReadonlyArray<Tab>, tabId: string): number {
  const children = tabs.filter((tab) => tab.parentTabId === tabId);
  return children.reduce((count, child) => count + 1 + countDescendants(tabs, child.id), 0);
}
