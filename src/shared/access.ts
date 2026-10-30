// Doc roles and what each allows, shared by the Worker's checks and the SPA's
// UI. Roles are ordered: each one can do everything the ones below it can.

import type { DocSummary, DocWithTabs, LibraryProject } from "./protocol.ts";

/** The admin: owns everything that predates sharing, and is the only one who creates projects. */
export const OWNER_USER_ID = "owner";

export const isAdmin = (userId: string) => userId === OWNER_USER_ID;

export type DocRole = "owner" | "editor" | "commenter" | "viewer";

/** Most to least access; the order role pickers list them in. */
export const DOC_ROLES: ReadonlyArray<DocRole> = ["owner", "editor", "commenter", "viewer"];

export const DOC_ROLE_LABEL: Readonly<Record<DocRole, string>> = {
  owner: "Owner",
  editor: "Editor",
  commenter: "Commenter",
  viewer: "Viewer",
};

const RANK: Readonly<Record<DocRole, number>> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };

export const isDocRole = (value: unknown): value is DocRole =>
  typeof value === "string" && Object.hasOwn(RANK, value);

/** Whether `role` grants at least `minimum`. */
export const hasRole = (role: DocRole | null, minimum: DocRole): boolean =>
  role !== null && RANK[role] >= RANK[minimum];

/** Edit content, tabs, status and linked threads. */
export const canEdit = (role: DocRole | null) => hasRole(role, "editor");
/** Start, reply to and resolve comment threads. */
export const canComment = (role: DocRole | null) => hasRole(role, "commenter");
/** Add, change and remove people; delete the doc. */
export const canShare = (role: DocRole | null) => hasRole(role, "owner");

/** A person as other people see them. `name` is empty until they set one. */
export interface UserSummary {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

/** `GET /api/me`: the signed-in person and every address that signs in as them. */
export interface Me {
  readonly user: UserSummary;
  readonly emails: ReadonlyArray<string>;
}

/**
 * One row of a doc's access list. `user` is null for a pending invite, which
 * becomes a person when `email` first signs in. `email` is the invite address
 * when pending, else the person's primary address.
 */
export interface DocMember {
  readonly id: string;
  readonly role: DocRole;
  readonly user: UserSummary | null;
  readonly email: string;
  readonly pending: boolean;
  readonly addedBy: string | null;
  readonly createdAt: number;
}

/** A doc in `GET /api/library`, with the caller's role and the doc's owner (its earliest owner). */
export interface LibraryDoc extends DocSummary {
  readonly role: DocRole;
  readonly owner: UserSummary | null;
}

/** `GET /api/library` projects: only docs the caller belongs to. */
export interface AccessibleLibraryProject extends Omit<LibraryProject, "docs"> {
  readonly docs: ReadonlyArray<LibraryDoc>;
}

/** `GET /api/library`: visible projects by name, and the caller's docs in no project. */
export interface AccessibleLibrary {
  readonly projects: ReadonlyArray<AccessibleLibraryProject>;
  readonly noProjectDocs: ReadonlyArray<LibraryDoc>;
}

/** `GET /api/docs/:docId`. */
export interface DocView extends DocWithTabs {
  readonly role: DocRole;
  readonly owner: UserSummary | null;
}

export const displayName = (user: Pick<UserSummary, "name" | "email">) =>
  user.name.trim() || user.email;
