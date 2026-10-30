import { useCallback, useState } from "react";

export type ColumnWidth = "narrow" | "wide";

export const columnWidthKey = (userId: string) => `docs-cloud:column-width:${userId}`;

/** The saved width, narrow when nothing valid is stored or storage is unavailable. */
export function readColumnWidth(storage: Pick<Storage, "getItem"> | null, userId: string) {
  try {
    return storage?.getItem(columnWidthKey(userId)) === "wide" ? "wide" : "narrow";
  } catch {
    return "narrow";
  }
}

export function writeColumnWidth(
  storage: Pick<Storage, "setItem"> | null,
  userId: string,
  width: ColumnWidth,
): void {
  try {
    storage?.setItem(columnWidthKey(userId), width);
  } catch {
    // Private modes can refuse storage; the width still applies until reload.
  }
}

const localStore = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** The doc column's width, remembered per person on this browser. */
export function useColumnWidth(userId: string): readonly [ColumnWidth, () => void] {
  const [width, setWidth] = useState<ColumnWidth>(() => readColumnWidth(localStore(), userId));
  const toggle = useCallback(() => {
    setWidth((current) => {
      const next = current === "wide" ? "narrow" : "wide";
      writeColumnWidth(localStore(), userId, next);
      return next;
    });
  }, [userId]);
  return [width, toggle] as const;
}
