import { describe, expect, it } from "vitest";

import type { HomeDoc, HomeLibrary } from "../../shared/home.ts";
import {
  activityLabel,
  ALL_PROJECTS,
  filterEntries,
  homeEntries,
  NO_PROJECT,
  parsePins,
  parseStoredScope,
  pinnedFirst,
  previewBlocks,
  projectMonogram,
  restoreScope,
  searchEntries,
  sortEntries,
  togglePin,
  type HomeEntry,
} from "./homeLogic.ts";

const project = { id: "p1", key: "github.com/acme/app", name: "Acme App", createdAt: 0 };

function doc(id: string, fields: Partial<HomeDoc> = {}): HomeDoc {
  return {
    id,
    projectId: null,
    title: id,
    status: "thinking",
    createdAt: 0,
    updatedAt: 0,
    role: "owner",
    owner: { id: "me", name: "Me", email: "me@x.test" },
    preview: "",
    memberCount: 1,
    openedAt: null,
    ...fields,
  };
}

const library: HomeLibrary = {
  projects: [
    {
      ...project,
      docs: [
        doc("mine", { projectId: "p1", status: "plan" }),
        doc("theirs", {
          projectId: "p1",
          role: "editor",
          owner: { id: "them", name: "", email: "them@x.test" },
          status: "done",
        }),
      ],
    },
  ],
  noProjectDocs: [doc("loose", { owner: null, role: "viewer" })],
};
const entries = homeEntries(library);
const ids = (list: ReadonlyArray<{ id: string }>) => list.map((entry) => entry.id);
const none = new Set<never>();

describe("filterEntries", () => {
  it("splits Yours (you own it) from Shared with you (everything else)", () => {
    const base = { userId: "me", scope: ALL_PROJECTS, statuses: none };
    expect(ids(filterEntries(entries, { ...base, tab: "all" }))).toEqual([
      "mine",
      "theirs",
      "loose",
    ]);
    expect(ids(filterEntries(entries, { ...base, tab: "yours" }))).toEqual(["mine"]);
    // A doc whose owner left still counts as shared, not yours.
    expect(ids(filterEntries(entries, { ...base, tab: "shared" }))).toEqual(["theirs", "loose"]);
  });

  it("filters by project key, no project, and any of the chosen statuses", () => {
    const base = { userId: "me", tab: "all" as const, statuses: none };
    const scope = { kind: "project" as const, key: project.key };
    expect(ids(filterEntries(entries, { ...base, scope }))).toEqual(["mine", "theirs"]);
    expect(ids(filterEntries(entries, { ...base, scope: NO_PROJECT }))).toEqual(["loose"]);
    expect(
      ids(
        filterEntries(entries, {
          ...base,
          scope: ALL_PROJECTS,
          statuses: new Set(["plan", "done"] as const),
        }),
      ),
    ).toEqual(["mine", "theirs"]);
  });
});

describe("sortEntries", () => {
  const list: ReadonlyArray<HomeEntry> = [
    { ...doc("b", { title: "beta", createdAt: 3, updatedAt: 5, openedAt: null }), project: null },
    { ...doc("a", { title: "Alpha 10", createdAt: 1, updatedAt: 2, openedAt: 9 }), project: null },
    { ...doc("c", { title: "alpha 9", createdAt: 2, updatedAt: 8, openedAt: 4 }), project: null },
  ];

  it("orders Last opened by your open, falling back to the last edit", () => {
    expect(ids(sortEntries(list, "opened"))).toEqual(["a", "b", "c"]);
  });

  it("orders by edit, creation and title", () => {
    expect(ids(sortEntries(list, "edited"))).toEqual(["c", "b", "a"]);
    expect(ids(sortEntries(list, "created"))).toEqual(["b", "c", "a"]);
    // Case-insensitive and numeric-aware.
    expect(ids(sortEntries(list, "title"))).toEqual(["c", "a", "b"]);
  });
});

describe("searchEntries", () => {
  it("matches titles at once and adds server hits with their snippet", () => {
    const hits = [
      { docId: "loose", tabId: "t", tabTitle: "Tab", snippet: "first" },
      { docId: "loose", tabId: "u", tabTitle: "Other", snippet: "second" },
      { docId: "hidden", tabId: "v", tabTitle: "Tab", snippet: "not listed" },
    ];
    expect(searchEntries(entries, "MIN", []).map((result) => result.entry.id)).toEqual(["mine"]);
    expect(
      searchEntries(entries, "min", hits).map(({ entry, snippet }) => [entry.id, snippet]),
    ).toEqual([
      ["mine", null],
      ["loose", "first"],
    ]);
    expect(searchEntries(entries, "  ", hits)).toHaveLength(3);
  });
});

describe("activityLabel", () => {
  it("says Opened when you opened it, else Edited", () => {
    const now = new Date(2026, 9, 24);
    expect(activityLabel(doc("x", { openedAt: new Date(2026, 9, 21).getTime() }), now)).toMatch(
      /^Opened /,
    );
    expect(activityLabel(doc("x", { updatedAt: new Date(2025, 0, 3).getTime() }), now)).toMatch(
      /^Edited .*2025/,
    );
  });
});

describe("restoreScope", () => {
  const keys = new Set([project.key]);
  const embedScope = { kind: "project" as const, key: project.key };

  it("opens inside T3 Code on the panel's project unless a pick was made there", () => {
    expect(restoreScope({ stored: null, embedKey: project.key, projectKeys: keys })).toEqual(
      embedScope,
    );
    expect(
      restoreScope({
        stored: { embedKey: project.key, scope: NO_PROJECT },
        embedKey: project.key,
        projectKeys: keys,
      }),
    ).toEqual(NO_PROJECT);
    // A pick made in another T3 Code project does not carry over.
    expect(
      restoreScope({
        stored: { embedKey: "github.com/acme/other", scope: NO_PROJECT },
        embedKey: project.key,
        projectKeys: keys,
      }),
    ).toEqual(embedScope);
  });

  it("stays on the panel's project before the person can see it in the library", () => {
    const unseen = { kind: "project" as const, key: "title:new" };
    expect(restoreScope({ stored: null, embedKey: unseen.key, projectKeys: keys })).toEqual(unseen);
    // A pick of a project that has since gone falls back to the panel's project.
    expect(
      restoreScope({
        stored: { embedKey: project.key, scope: { kind: "project", key: "gone" } },
        embedKey: project.key,
        projectKeys: keys,
      }),
    ).toEqual(embedScope);
  });

  it("falls back to All projects standalone for a project the person cannot see", () => {
    expect(
      restoreScope({
        stored: { embedKey: null, scope: { kind: "project", key: "gone" } },
        embedKey: null,
        projectKeys: keys,
      }),
    ).toEqual(ALL_PROJECTS);
  });

  it("parses only well-formed stored picks", () => {
    expect(parseStoredScope('{"embedKey":null,"scope":{"kind":"none"}}')).toEqual({
      embedKey: null,
      scope: NO_PROJECT,
    });
    expect(parseStoredScope('{"scope":{"kind":"project"}}')).toBeNull();
    expect(parseStoredScope("not json")).toBeNull();
    expect(parseStoredScope(null)).toBeNull();
  });
});

describe("pins", () => {
  it("puts pinned docs first and keeps the sort within each group", () => {
    const entries = [doc("a"), doc("b"), doc("c"), doc("d")];
    const ordered = pinnedFirst(entries, new Set(["d", "b", "deleted"]));
    expect(ordered.map((entry) => entry.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("toggles a pin and reads only well-formed stored pins", () => {
    expect(togglePin(["a"], "b")).toEqual(["a", "b"]);
    expect(togglePin(["a", "b"], "a")).toEqual(["b"]);
    expect(parsePins('["a",1,"b"]')).toEqual(["a", "b"]);
    expect(parsePins('{"a":1}')).toEqual([]);
    expect(parsePins("not json")).toEqual([]);
    expect(parsePins(null)).toEqual([]);
  });
});

describe("projectMonogram", () => {
  it("derives T3 Code's initials", () => {
    expect(projectMonogram("Acme Netherlands").text).toBe("AN");
    expect(projectMonogram("weekly-digest").text).toBe("WD");
    expect(projectMonogram("Bolt").text).toBe("BT");
    expect(projectMonogram("T3 Code + AI PM").text).toBe("T3");
    expect(projectMonogram("Tracker").text).toBe("TR");
  });
});

describe("previewBlocks", () => {
  it("reads headings from the preview's line prefix", () => {
    expect(previewBlocks("Intro\n# Risks\nLate")).toEqual([
      { heading: false, text: "Intro" },
      { heading: true, text: "Risks" },
      { heading: false, text: "Late" },
    ]);
  });
});
