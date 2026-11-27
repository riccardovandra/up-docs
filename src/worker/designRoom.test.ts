import { describe, expect, it, vi } from "vitest";

import { newEditorAttachment } from "./designRoom.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

describe("editor connections", () => {
  it("order after every open one, and get an id of their own even when the order repeats", () => {
    expect(newEditorAttachment([], 100).seq).toBe(100);
    expect(newEditorAttachment([100, 250], 100).seq).toBe(251);
    // The first closed, and the next connected in the same millisecond: same order, new id.
    const first = newEditorAttachment([], 100);
    const next = newEditorAttachment([], 100);
    expect(next.seq).toBe(first.seq);
    expect(next.id).not.toBe(first.id);
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
