import { describe, expect, it } from "vitest";

import type { DiagramThread } from "../../shared/diagramComments.ts";
import {
  openCountsByPage,
  pageFromSearch,
  pageStep,
  searchForPage,
  steppedPage,
  threadsOnPage,
  type PageKey,
} from "./pageTabsLogic.ts";

const NAMES = ["1. Moving pieces", "2. How it connects", "3. Every field", "4. Workflows"];

describe("the page an address asks for", () => {
  it("reads ?page= as a number counted from 1", () => {
    expect(pageFromSearch("", NAMES)).toBe(0);
    expect(pageFromSearch("?page=1", NAMES)).toBe(0);
    expect(pageFromSearch("?page=2", NAMES)).toBe(1);
    expect(pageFromSearch("?page=4", NAMES)).toBe(3);
  });

  it("falls back to the first page for a number out of range or junk", () => {
    expect(pageFromSearch("?page=0", NAMES)).toBe(0);
    expect(pageFromSearch("?page=5", NAMES)).toBe(0);
    expect(pageFromSearch("?page=-1", NAMES)).toBe(0);
    expect(pageFromSearch("?page=", NAMES)).toBe(0);
    expect(pageFromSearch("?page=2", [null])).toBe(0);
  });

  it("takes a page's name too", () => {
    expect(pageFromSearch(`?page=${encodeURIComponent("3. Every field")}`, NAMES)).toBe(2);
    expect(pageFromSearch("?page=Nowhere", NAMES)).toBe(0);
  });

  it("writes the query for a page and keeps other parameters", () => {
    expect(searchForPage("", 0)).toBe("");
    expect(searchForPage("", 1)).toBe("?page=2");
    expect(searchForPage("?page=3", 0)).toBe("");
    expect(searchForPage("?x=1&page=3", 3)).toBe("?x=1&page=4");
    expect(pageFromSearch(searchForPage("", 2), NAMES)).toBe(2);
  });
});

const key = (overrides: Partial<PageKey>): PageKey => ({
  key: "PageDown",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  defaultPrevented: false,
  target: null,
  ...overrides,
});

/** A stand-in element: `typing` says whether it sits in a field. */
const element = (typing: boolean) =>
  ({ closest: (selector: string) => (typing && selector.includes("textarea") ? {} : null) }) as
    unknown as EventTarget;

describe("the keys that switch pages", () => {
  it("steps back on PageUp and forward on PageDown", () => {
    expect(pageStep(key({ key: "PageUp" }))).toBe(-1);
    expect(pageStep(key({ key: "PageDown" }))).toBe(1);
    expect(pageStep(key({ key: "PageDown", target: element(false) }))).toBe(1);
  });

  it("ignores other keys, modifiers and handled keys", () => {
    expect(pageStep(key({ key: "ArrowRight" }))).toBe(0);
    expect(pageStep(key({ key: "ArrowLeft", altKey: true }))).toBe(0);
    expect(pageStep(key({ ctrlKey: true }))).toBe(0);
    expect(pageStep(key({ metaKey: true }))).toBe(0);
    expect(pageStep(key({ shiftKey: true }))).toBe(0);
    expect(pageStep(key({ altKey: true }))).toBe(0);
    expect(pageStep(key({ defaultPrevented: true }))).toBe(0);
  });

  it("leaves keys typed into a field, such as a review comment, alone", () => {
    expect(pageStep(key({ target: element(true) }))).toBe(0);
  });

  it("stays within the pages there are", () => {
    expect(steppedPage(0, -1, 4)).toBe(0);
    expect(steppedPage(0, 1, 4)).toBe(1);
    expect(steppedPage(3, 1, 4)).toBe(3);
    expect(steppedPage(0, 1, 1)).toBe(0);
  });
});

const thread = (id: string, page: string | null, resolved = false): DiagramThread => ({
  id,
  diagramId: "d1",
  parentId: null,
  anchor: { page, shapeId: null, x: 0, y: 0 },
  quote: "",
  body: id,
  author: "someone@example.com",
  authorKind: "person",
  resolvedAt: resolved ? 1 : null,
  createdAt: 0,
  updatedAt: 0,
  replies: [],
});

describe("comments per page", () => {
  const threads = [
    thread("a", NAMES[0] as string),
    thread("b", NAMES[1] as string),
    thread("c", NAMES[1] as string, true),
    thread("d", NAMES[3] as string),
    thread("e", NAMES[3] as string),
  ];

  it("shows only the active page's pins", () => {
    expect(threadsOnPage(threads, NAMES[1] as string).map((t) => t.id)).toEqual(["b", "c"]);
    expect(threadsOnPage(threads, NAMES[2] as string)).toEqual([]);
    expect(threadsOnPage(threads, null)).toEqual([]);
  });

  it("counts open threads per tab", () => {
    expect(openCountsByPage(threads, NAMES)).toEqual([1, 1, 0, 2]);
  });
});
