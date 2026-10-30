import { memo, useState } from "react";

import type { Tab } from "../../../shared/protocol.ts";
import { countDescendants, moveTarget, orderTabs, type TabMove } from "../tabTree.ts";
import { ChevronDown } from "./icons.tsx";
import { InlineRename, MenuItem, MenuSeparator, Popover } from "./Popover.tsx";

const MOVES: ReadonlyArray<{ readonly move: TabMove; readonly label: string }> = [
  { move: "up", label: "Move up" },
  { move: "down", label: "Move down" },
  { move: "indent", label: "Indent" },
  { move: "outdent", label: "Outdent" },
];

export interface TabActions {
  readonly onSelect: (tabId: string) => void;
  readonly onCreate: (parentTabId: string | null) => void;
  readonly onRename: (tabId: string, title: string) => void;
  readonly onMove: (tabId: string, parentTabId: string | null, position: number) => void;
  readonly onDelete: (tabId: string) => void;
}

/**
 * "Tab 1 ▾": the active tab's title, opening the doc's tab tree with child
 * tabs, collapse, rename, reorder and delete. Without `manage`, it only switches.
 */
export const TabSwitcher = memo(function TabSwitcher(
  props: TabActions & {
    readonly tabs: ReadonlyArray<Tab>;
    readonly activeTabId: string | null;
    readonly manage: boolean;
  },
) {
  const active = props.tabs.find((tab) => tab.id === props.activeTabId);
  return (
    <Popover
      label="Tabs"
      triggerClassName="toolbar-button tab-switcher-trigger"
      panelClassName="tab-tree"
      trigger={
        <>
          <span className="tab-switcher-title">{active?.title ?? "Tabs"}</span>
          <ChevronDown />
        </>
      }
    >
      {(close) => <TabTree {...props} close={close} />}
    </Popover>
  );
});

function TabTree(
  props: TabActions & {
    readonly tabs: ReadonlyArray<Tab>;
    readonly activeTabId: string | null;
    readonly manage: boolean;
    readonly close: () => void;
  },
) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [menuTabId, setMenuTabId] = useState<string | null>(null);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);

  const ordered = orderTabs(props.tabs);
  const parentIds = new Set(props.tabs.map((tab) => tab.parentTabId));
  const visible: Array<(typeof ordered)[number]> = [];
  let hiddenBelow = Number.POSITIVE_INFINITY;
  for (const item of ordered) {
    if (item.depth > hiddenBelow) continue;
    hiddenBelow = collapsed.has(item.tab.id) ? item.depth : Number.POSITIVE_INFINITY;
    visible.push(item);
  }

  const setExpanded = (tabId: string, expanded: boolean) =>
    setCollapsed((current) => {
      if (current.has(tabId) !== expanded) return current;
      const next = new Set(current);
      if (expanded) next.delete(tabId);
      else next.add(tabId);
      return next;
    });

  const confirmDelete = (tab: Tab) => {
    const descendants = countDescendants(props.tabs, tab.id);
    const extra =
      descendants > 0 ? ` and its ${descendants} sub-tab${descendants === 1 ? "" : "s"}` : "";
    if (window.confirm(`Delete "${tab.title}"${extra}?`)) props.onDelete(tab.id);
  };

  return (
    <>
      <ul role="tree" aria-label="Tabs">
        {visible.map(({ tab, depth }) => {
          const hasChildren = parentIds.has(tab.id);
          const expanded = hasChildren && !collapsed.has(tab.id);
          const active = tab.id === props.activeTabId;
          return (
            <li
              key={tab.id}
              role="treeitem"
              aria-level={depth + 1}
              aria-selected={active}
              {...(hasChildren ? { "aria-expanded": expanded } : {})}
            >
              <div
                className={active ? "tab-row active" : "tab-row"}
                style={{ paddingLeft: `${depth}rem` }}
              >
                {hasChildren ? (
                  <button
                    type="button"
                    className="tab-row-toggle"
                    data-keep-open=""
                    aria-label={expanded ? "Collapse" : "Expand"}
                    onClick={() => setExpanded(tab.id, !expanded)}
                  >
                    {expanded ? "▾" : "▸"}
                  </button>
                ) : (
                  <span className="tab-row-toggle" aria-hidden="true" />
                )}
                {renamingTabId === tab.id ? (
                  <InlineRename
                    value={tab.title}
                    label="Tab title"
                    className="tab-rename"
                    onDone={(title) => {
                      setRenamingTabId(null);
                      if (title && title !== tab.title) props.onRename(tab.id, title);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="tab-tree-item"
                    onClick={() => props.onSelect(tab.id)}
                  >
                    {tab.title}
                  </button>
                )}
                {props.manage ? (
                  <button
                    type="button"
                    className="tab-row-menu-button"
                    data-keep-open=""
                    aria-label={`Actions for ${tab.title}`}
                    aria-expanded={menuTabId === tab.id}
                    onClick={() => setMenuTabId(menuTabId === tab.id ? null : tab.id)}
                  >
                    ⋯
                  </button>
                ) : null}
              </div>
              {menuTabId === tab.id ? (
                <div className="tab-row-actions" role="group" aria-label={`${tab.title} actions`}>
                  <MenuItem
                    label="Add child tab"
                    onSelect={() => {
                      setExpanded(tab.id, true);
                      props.onCreate(tab.id);
                    }}
                  />
                  <MenuItem
                    label="Rename"
                    keepOpen
                    onSelect={() => {
                      setMenuTabId(null);
                      setRenamingTabId(tab.id);
                    }}
                  />
                  {MOVES.map(({ move, label }) => {
                    const target = moveTarget(props.tabs, tab.id, move);
                    return (
                      <MenuItem
                        key={move}
                        label={label}
                        keepOpen
                        disabled={target === null}
                        onSelect={() => {
                          if (!target) return;
                          if (target.parentTabId) setExpanded(target.parentTabId, true);
                          props.onMove(tab.id, target.parentTabId, target.position);
                        }}
                      />
                    );
                  })}
                  <MenuItem label="Delete" danger onSelect={() => confirmDelete(tab)} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {props.manage ? (
        <>
          <MenuSeparator />
          <MenuItem label="New tab" onSelect={() => props.onCreate(null)} />
        </>
      ) : null}
    </>
  );
}
