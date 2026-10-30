import { useSyncExternalStore } from "react";

import type { Me } from "../shared/access.ts";

let me: Me | null = null;
const listeners = new Set<() => void>();

/** Set by App once `/api/me` answers, and by anything that changes the signed-in person. */
export function setMe(next: Me | null): void {
  if (next === me) return;
  me = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The signed-in person; null only before sign-in, since App renders pages after it loads. */
export function useMe(): Me | null {
  return useSyncExternalStore(subscribe, () => me);
}
