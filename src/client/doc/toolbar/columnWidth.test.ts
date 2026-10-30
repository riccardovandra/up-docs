import { describe, expect, it } from "vitest";

import { columnWidthKey, readColumnWidth, writeColumnWidth } from "./columnWidth.ts";

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
};

describe("column width", () => {
  it("remembers the width per person", () => {
    const storage = memoryStorage();
    expect(readColumnWidth(storage, "a")).toBe("narrow");
    writeColumnWidth(storage, "a", "wide");
    expect(readColumnWidth(storage, "a")).toBe("wide");
    expect(readColumnWidth(storage, "b")).toBe("narrow");
  });

  it("falls back to narrow for junk or refused storage", () => {
    const storage = memoryStorage();
    storage.setItem(columnWidthKey("a"), "huge");
    expect(readColumnWidth(storage, "a")).toBe("narrow");
    const refusing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readColumnWidth(refusing, "a")).toBe("narrow");
    expect(() => writeColumnWidth(refusing, "a", "wide")).not.toThrow();
  });
});
