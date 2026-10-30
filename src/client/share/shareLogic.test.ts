import { describe, expect, it } from "vitest";

import type { DocMember, DocRole } from "../../shared/access.ts";
import {
  completeEmail,
  initials,
  inviteRoles,
  isLastOwner,
  memberControls,
  parseEmails,
  suggestPeople,
} from "./shareLogic.ts";

const member = (id: string, role: DocRole, email: string, name: string | null = ""): DocMember => ({
  id: `m-${id}`,
  role,
  user: name === null ? null : { id, name, email },
  email,
  pending: name === null,
  addedBy: null,
  createdAt: 0,
});

const owner = member("owner", "owner", "owner@example.com", "Ada Lovelace");
const editor = member("eve", "editor", "eve@example.com", "Eve");
const viewer = member("vic", "viewer", "vic@example.com");
const pendingOwner = member("p", "owner", "new@example.com", null);

describe("parseEmails", () => {
  it("normalises, dedupes, and separates bad and existing addresses", () => {
    expect(
      parseEmails(" A@x.com, a@x.com;b@y.io  nope eve@example.com bad@domain", [owner, editor]),
    ).toEqual({
      valid: ["a@x.com", "b@y.io"],
      invalid: ["nope", "bad@domain"],
      existing: ["eve@example.com"],
    });
  });

  it("reads addresses pasted with display names", () => {
    expect(parseEmails("Ann Lee <ann@x.com>, Bo <bo@y.com>", [])).toEqual({
      valid: ["ann@x.com", "bo@y.com"],
      invalid: [],
      existing: [],
    });
  });

  it("returns nothing for blank input", () => {
    expect(parseEmails(" , ", [])).toEqual({ valid: [], invalid: [], existing: [] });
  });
});

describe("people picker", () => {
  const people = [
    { name: "Eve", email: "eve@example.com" },
    { name: "Ann Lee", email: "ann@x.com" },
    { name: "", email: "annex@y.com" },
  ];

  it("matches the fragment being typed by name or address, skipping members", () => {
    expect(suggestPeople("bo@y.com, an", people, [editor])).toEqual([
      { name: "Ann Lee", email: "ann@x.com" },
      { name: "", email: "annex@y.com" },
    ]);
    expect(suggestPeople("eve", people, [editor])).toEqual([]);
    expect(suggestPeople("bo@y.com, ", people, [])).toEqual([]);
  });

  it("completes only the fragment being typed", () => {
    expect(completeEmail("bo@y.com, an", "ann@x.com")).toBe("bo@y.com, ann@x.com, ");
  });
});

describe("member controls", () => {
  it("gives owners every role and Remove, and Leave on their own row", () => {
    const coOwner = member("co", "owner", "co@x.com", "Co");
    const members = [owner, coOwner, editor];
    expect(memberControls(editor, members, "owner", "owner")).toEqual({
      roles: ["owner", "editor", "commenter", "viewer"],
      removal: "remove",
    });
    expect(memberControls(owner, members, "owner", "owner").removal).toBe("leave");
  });

  it("shows the last signed-in owner read-only, even to themselves", () => {
    const members = [owner, pendingOwner, editor];
    expect(isLastOwner(owner, members)).toBe(true);
    expect(isLastOwner(pendingOwner, members)).toBe(false);
    expect(memberControls(owner, members, "owner", "owner")).toEqual({ roles: [], removal: null });
    expect(memberControls(pendingOwner, members, "owner", "owner").removal).toBe("remove");
  });

  it("gives everyone else a read-only list and Leave for themselves", () => {
    const members = [owner, editor, viewer];
    for (const role of ["editor", "commenter", "viewer"] as const) {
      expect(memberControls(editor, members, role, "eve")).toEqual({ roles: [], removal: "leave" });
      expect(memberControls(viewer, members, role, "eve")).toEqual({ roles: [], removal: null });
      expect(inviteRoles(role)).toEqual([]);
    }
    expect(inviteRoles("owner")).toEqual(["owner", "editor", "commenter", "viewer"]);
  });
});

it("builds avatar initials from the name, else the address", () => {
  expect(initials(owner)).toBe("AL");
  expect(initials(editor)).toBe("EV");
  expect(initials(pendingOwner)).toBe("NE");
});
