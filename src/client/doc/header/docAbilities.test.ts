import { describe, expect, it } from "vitest";

import { docAbilities } from "./docAbilities.ts";

describe("doc abilities", () => {
  it("gives viewers a read-only page", () => {
    expect(docAbilities("viewer", { startWorkAvailable: true })).toEqual({
      edit: false,
      comment: false,
      manageDoc: false,
      manageTabs: false,
      deleteDoc: false,
      startChat: false,
    });
  });

  it("lets commenters comment but not edit", () => {
    const abilities = docAbilities("commenter", { startWorkAvailable: true });
    expect(abilities.comment).toBe(true);
    expect(abilities.edit).toBe(false);
    expect(abilities.manageTabs).toBe(false);
    expect(abilities.startChat).toBe(false);
  });

  it("keeps deleting the doc to its owners", () => {
    expect(docAbilities("editor", { startWorkAvailable: false }).deleteDoc).toBe(false);
    expect(docAbilities("owner", { startWorkAvailable: false }).deleteDoc).toBe(true);
  });

  it("offers Start chat only to editors inside T3 Code", () => {
    expect(docAbilities("editor", { startWorkAvailable: true }).startChat).toBe(true);
    expect(docAbilities("owner", { startWorkAvailable: false }).startChat).toBe(false);
  });
});
