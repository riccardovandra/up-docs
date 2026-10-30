import { useSyncExternalStore } from "react";

/** The T3 Code project whose Docs panel frames this app. */
export interface EmbedProject {
  readonly name: string;
  /** Null from a T3 Code that predates project keys. */
  readonly key: string | null;
}

let project: EmbedProject | null = null;
const listeners = new Set<() => void>();

/** Null outside T3 Code, or when the panel belongs to no project. */
export function setEmbedProject(next: EmbedProject | null): void {
  if (next?.name === project?.name && next?.key === project?.key) return;
  project = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useEmbedProject(): EmbedProject | null {
  return useSyncExternalStore(subscribe, () => project);
}
