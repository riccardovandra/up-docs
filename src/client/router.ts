import { localDocPathFromAppPath } from "../host/docsCloudLocal.ts";
import { useSyncExternalStore } from "react";

export type Route =
  | { readonly name: "library" }
  | { readonly name: "doc"; readonly docId: string; readonly tabId: string | null }
  | { readonly name: "settings" }
  /** A T3 Code project file, by its workspace-relative path (`/local/docs/plan.md`). */
  | { readonly name: "local"; readonly path: string };

export function parseRoute(pathname: string): Route {
  const [first, docId, tabId] = pathname.split("/").filter(Boolean);
  if (first === "d" && docId) return { name: "doc", docId, tabId: tabId ?? null };
  if (first === "settings") return { name: "settings" };
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
