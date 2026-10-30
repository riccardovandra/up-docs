// Decisions behind the Share panel, kept free of React so they are testable.

import {
  canShare,
  DOC_ROLES,
  displayName,
  type DocMember,
  type DocRole,
  type UserSummary,
} from "../../shared/access.ts";

// Deliberately loose: the server only needs an "@"; this catches typos like a missing domain.
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

export interface ParsedEmails {
  /** New addresses, normalised and deduplicated, in the order typed. */
  readonly valid: ReadonlyArray<string>;
  /** Fragments that are not addresses, as typed. */
  readonly invalid: ReadonlyArray<string>;
  /** Addresses that already have access. */
  readonly existing: ReadonlyArray<string>;
}

/** Splits pasted or typed input ("a@x.com, b@y.com; Name <c@z.com>") into addresses. */
export function parseEmails(input: string, members: ReadonlyArray<DocMember>): ParsedEmails {
  const taken = new Set(members.map((member) => member.email.toLowerCase()));
  const seen = new Set<string>();
  const valid: Array<string> = [];
  const invalid: Array<string> = [];
  const existing: Array<string> = [];
  for (const fragment of input.split(/[\s,;]+/)) {
    const bare = fragment.replace(/^<|>$/g, "").trim();
    if (!bare) continue;
    if (!bare.includes("@")) {
      // "Name <a@b.com>" leaves bare words behind; only flag them if nothing else parses.
      if (!input.includes("<")) invalid.push(fragment);
      continue;
    }
    const email = bare.toLowerCase();
    if (!EMAIL.test(email)) {
      invalid.push(fragment);
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    (taken.has(email) ? existing : valid).push(email);
  }
  return { valid, invalid, existing };
}

/** Suggestions for the picker: matching people who do not already have access. */
export function suggestPeople(
  query: string,
  people: ReadonlyArray<Pick<UserSummary, "name" | "email">>,
  members: ReadonlyArray<DocMember>,
  limit = 5,
): ReadonlyArray<Pick<UserSummary, "name" | "email">> {
  // Only the fragment being typed matters once earlier addresses are complete.
  const needle = (query.split(/[\s,;]+/).pop() ?? "").trim().toLowerCase();
  if (!needle) return [];
  const taken = new Set(members.map((member) => member.email.toLowerCase()));
  return people
    .filter(
      (person) =>
        !taken.has(person.email.toLowerCase()) &&
        (person.email.toLowerCase().includes(needle) || person.name.toLowerCase().includes(needle)),
    )
    .slice(0, limit);
}

/** Replaces the fragment being typed with a picked address. */
export function completeEmail(query: string, email: string): string {
  const match = /[^\s,;]*$/.exec(query);
  const head = match ? query.slice(0, match.index) : query;
  return `${head}${email}, `;
}

/** The doc keeps a signed-in owner, so the last one cannot be demoted or removed. */
export function isLastOwner(member: DocMember, members: ReadonlyArray<DocMember>): boolean {
  if (member.role !== "owner" || member.pending) return false;
  return members.filter((other) => other.role === "owner" && !other.pending).length <= 1;
}

export interface MemberControls {
  /** Roles the caller may pick for this row; empty means the role is shown read-only. */
  readonly roles: ReadonlyArray<DocRole>;
  /** "remove" for an owner acting on someone, "leave" for the caller's own row. */
  readonly removal: "remove" | "leave" | null;
}

/** What the caller can do to one row. Mirrors the server's checks in worker/access.ts. */
export function memberControls(
  member: DocMember,
  members: ReadonlyArray<DocMember>,
  callerRole: DocRole,
  callerId: string,
): MemberControls {
  const self = member.user?.id === callerId;
  if (isLastOwner(member, members)) return { roles: [], removal: null };
  if (!canShare(callerRole)) return { roles: [], removal: self ? "leave" : null };
  return { roles: DOC_ROLES, removal: self ? "leave" : "remove" };
}

/** Roles an inviter can hand out. Only owners invite, matching POST /members. */
export const inviteRoles = (callerRole: DocRole): ReadonlyArray<DocRole> =>
  canShare(callerRole) ? DOC_ROLES : [];

/** Two letters for the avatar: initials of the name, else the start of the address. */
export function initials(member: Pick<DocMember, "user" | "email">): string {
  const name = member.user?.name.trim() ?? "";
  if (name) {
    const words = name.split(/\s+/);
    const letters = words.length > 1 ? `${words[0]![0]}${words.at(-1)![0]}` : name.slice(0, 2);
    return letters.toUpperCase();
  }
  return member.email.slice(0, 2).toUpperCase();
}

export const memberLabel = (member: DocMember) =>
  member.user ? displayName(member.user) : member.email;

const ERROR_TEXT: Readonly<Record<string, string>> = {
  last_owner: "A doc needs at least one owner. Make someone else an owner first.",
  self: "That address signs in as you, so it already has your access.",
  forbidden: "Only owners can change who has access.",
  invalid_email: "That is not a valid email address.",
  invalid_role: "Pick a role.",
  not_found: "This person no longer has access. Reopen Share to refresh.",
};

/** Inline text for a failed share call, from the API's `error` code. */
export const shareErrorText = (code: string | undefined) =>
  (code && ERROR_TEXT[code]) || "Something went wrong. Try again.";
