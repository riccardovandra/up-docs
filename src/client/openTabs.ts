import { docTitleFromPath } from "../host/docPaths.ts";
import { useSyncExternalStore } from "react";

import { navigate, parseRoute, type Route } from "./router.ts";

/** A doc open in the tab strip. `path` is where it was last, in-doc tab included. */
export interface OpenTab {
  readonly key: string;
  readonly path: string;
  readonly title: string;
}

export function openTabKey(route: Route): string | null {
  if (route.name === "doc") return `doc:${route.docId}`;
  if (route.name === "local") return `local:${route.path}`;
  return null;
}

/** Records a visit to `path`: adds its doc as a tab, or moves that tab to it. */
export function visitTab(tabs: ReadonlyArray<OpenTab>, path: string): ReadonlyArray<OpenTab> {
  const route = parseRoute(path);
  const key = openTabKey(route);
  if (key === null) return tabs;
  const index = tabs.findIndex((tab) => tab.key === key);
  if (index === -1) {
    const title = route.name === "local" ? docTitleFromPath(route.path) : "Untitled";
    return [...tabs, { key, path, title }];
  }
  if (tabs[index]!.path === path) return tabs;
  return tabs.with(index, { ...tabs[index]!, path });
}

export function retitleTab(
  tabs: ReadonlyArray<OpenTab>,
  key: string,
  title: string,
): ReadonlyArray<OpenTab> {
  const index = tabs.findIndex((tab) => tab.key === key);
  if (index === -1 || tabs[index]!.title === title) return tabs;
  return tabs.with(index, { ...tabs[index]!, title });
}

/**
 * Removes a tab. Closing the active one moves to its right-hand neighbour,
 * else its left, else home; closing another tab stays put (`next` is null).
 */
export function closeTab(
  tabs: ReadonlyArray<OpenTab>,
  key: string,
  activeKey: string | null,
): { readonly tabs: ReadonlyArray<OpenTab>; readonly next: string | null } {
  const index = tabs.findIndex((tab) => tab.key === key);
  if (index === -1) return { tabs, next: null };
  const rest = tabs.toSpliced(index, 1);
  if (key !== activeKey) return { tabs: rest, next: null };
  return { tabs: rest, next: rest[Math.min(index, rest.length - 1)]?.path ?? "/" };
}

function parseOpenTabs(value: unknown): ReadonlyArray<OpenTab> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (tab): tab is OpenTab =>
      typeof tab?.key === "string" &&
      typeof tab.path === "string" &&
      typeof tab.title === "string" &&
      openTabKey(parseRoute(tab.path)) === tab.key,
  );
}

/** Open tabs by T3 Code project key, "" for no project. */
type TabSets = Readonly<Record<string, ReadonlyArray<OpenTab>>>;

export function parseTabSets(raw: string | null): TabSets {
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    // Tabs stored before they were kept per project had no project to go with.
    if (Array.isArray(value)) return { "": parseOpenTabs(value) };
    if (typeof value !== "object" || value === null) return {};
    return Object.fromEntries(
      Object.entries(value).map(([project, tabs]) => [project, parseOpenTabs(tabs)]),
    );
  } catch {
    return {};
  }
}

// Remembered per browser. Only T3 Code's Docs panel and mobile app show them.
const STORAGE_KEY = "docs-cloud:open-tabs";

const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const NO_TABS: ReadonlyArray<OpenTab> = [];
let sets: TabSets | null = null;
// Null until T3 Code says which project the panel is in, so no visit lands in the wrong one.
let project: string | null = null;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

function read(): ReadonlyArray<OpenTab> {
  if (project === null) return NO_TABS;
  sets ??= parseTabSets(storage()?.getItem(STORAGE_KEY) ?? null);
  return sets[project] ?? NO_TABS;
}

function write(next: ReadonlyArray<OpenTab>): void {
  if (project === null || next === read()) return;
  sets = { ...sets, [project]: next };
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(sets));
  } catch {
    // Private modes can refuse storage; the tabs still last until reload.
  }
  notify();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useOpenTabs(): ReadonlyArray<OpenTab> {
  return useSyncExternalStore(subscribe, read);
}

/**
 * Shows the tabs of the panel's project. The doc on screen joins them when the
 * panel first loads; after a project switch it stays only if already open there.
 */
export function setTabsProject(key: string): void {
  if (key === project) return;
  const first = project === null;
  project = key;
  notify();
  const path = window.location.pathname;
  const tabKey = openTabKey(parseRoute(path));
  if (first || tabKey === null || read().some((tab) => tab.key === tabKey)) {
    rememberTab(path);
  } else {
    navigate("/", { replace: true });
  }
}

/** Adds or updates the tab for `path` without navigating, e.g. for a background tab. */
export const rememberTab = (path: string) => write(visitTab(read(), path));

export const setDocTabTitle = (docId: string, title: string) =>
  write(retitleTab(read(), `doc:${docId}`, title));

export function closeOpenTab(key: string): void {
  const active = openTabKey(parseRoute(window.location.pathname));
  const { tabs, next } = closeTab(read(), key, active);
  write(tabs);
  if (next !== null) navigate(next);
}

/** The doc is gone or out of reach: drop its tab and go home. */
export function leaveDoc(docId: string): void {
  write(closeTab(read(), `doc:${docId}`, null).tabs);
  navigate("/", { replace: true });
}
