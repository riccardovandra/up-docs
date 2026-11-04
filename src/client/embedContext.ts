import { useSyncExternalStore } from "react";

/** The T3 Code project whose Docs panel frames this app. */
export interface EmbedProject {
  readonly name: string;
  /** Null from a T3 Code that predates project keys. */
  readonly key: string | null;
  /** True when the parent keeps the frame inside this project (never from T3 Code). */
  readonly locked: boolean;
  /** The groups a locked home splits the project into, in order. */
  readonly groups: ReadonlyArray<string>;
}

let project: EmbedProject | null = null;
const listeners = new Set<() => void>();

/** Null outside T3 Code, or when the panel belongs to no project. */
export function setEmbedProject(next: EmbedProject | null): void {
  if (
    next?.name === project?.name &&
    next?.key === project?.key &&
    next?.locked === project?.locked &&
    next?.groups.join("\n") === project?.groups.join("\n")
  ) {
    return;
  }
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
