import { localDocPathFromAppPath } from "../host/docsCloudLocal.ts";
import { useSyncExternalStore } from "react";

export type Route =
  | { readonly name: "library" }
  /** The library's Diagrams view. */
  | { readonly name: "diagrams" }
  /** One Draw.io diagram's own page. */
  | { readonly name: "diagram"; readonly diagramId: string }
  /** The library's Sheets view. */
  | { readonly name: "sheets" }
  /** One sheet's own page, optionally on one tab. */
  | { readonly name: "sheet"; readonly sheetId: string; readonly tabId: string | null }
  | { readonly name: "doc"; readonly docId: string; readonly tabId: string | null }
  | { readonly name: "settings" }
  /** A T3 Code project file, by its workspace-relative path (`/local/docs/plan.md`). */
  | { readonly name: "local"; readonly path: string };

export function parseRoute(pathname: string): Route {
  const [first, docId, tabId] = pathname.split("/").filter(Boolean);
  if (first === "d" && docId) return { name: "doc", docId, tabId: tabId ?? null };
  if (first === "settings") return { name: "settings" };
  if (first === "diagrams") {
    return docId ? { name: "diagram", diagramId: docId } : { name: "diagrams" };
  }
  if (first === "sheets") {
    return docId
      ? { name: "sheet", sheetId: docId, tabId: tabId ? decodeURIComponent(tabId) : null }
      : { name: "sheets" };
  }
  const localPath = localDocPathFromAppPath(pathname);
  if (localPath !== null) return { name: "local", path: localPath };
  return { name: "library" };
}

const listeners = new Set<() => void>();
export const subscribePathname = (listener: () => void) => {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
};

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (path === window.location.pathname) return;
  if (options.replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  for (const listener of listeners) listener();
}

export function usePathname(): string {
  return useSyncExternalStore(subscribePathname, () => window.location.pathname);
}

export const docPath = (docId: string, tabId?: string | null) =>
  tabId ? `/d/${docId}/${tabId}` : `/d/${docId}`;
