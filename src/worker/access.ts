// People, doc membership and permission checks, shared by the REST API, the
// MCP tools and sign-in. Every address in OWNER_EMAILS is the admin user
// OWNER_USER_ID; everyone else is a `users` row reached through `user_emails`.

import {
  hasRole,
  isAdmin,
  OWNER_USER_ID,
  type AccessibleLibrary,
  type DocMember,
  type DocRole,
  type Me,
  type UserSummary,
} from "../shared/access.ts";
import type { DocSummary, Library } from "../shared/protocol.ts";
import { normalizeEmail } from "./auth.ts";
import { randomId } from "./crypto.ts";
import { NotFoundError } from "./docs.ts";

export { isAdmin, OWNER_USER_ID } from "../shared/access.ts";

/** A member asked for more than their role allows. Non-members get NotFoundError instead. */
export class ForbiddenError extends Error {
  readonly required: DocRole;

  constructor(required: DocRole) {
    super(`forbidden: ${required}`);
    this.required = required;
  }
}

/** The change would leave the doc with nobody who can share or delete it. */
export class LastOwnerError extends Error {
  constructor() {
    super("last_owner");
  }
}

/** The address signs in as the person sharing, e.g. one of the admin's other addresses. */
export class SelfShareError extends Error {
  constructor() {
    super("self");
  }
}

interface UserRow {
  id: string;
  email: string | null;
  name: string;
}

const firstOwnerEmail = (owners: ReadonlySet<string>) => owners.values().next().value ?? "";

const toUser = (row: UserRow, owners: ReadonlySet<string>): UserSummary => ({
  id: row.id,
  name: row.name,
  email: row.email ?? firstOwnerEmail(owners),
});

export async function userIdForEmail(
  db: D1Database,
  email: string,
  owners: ReadonlySet<string>,
): Promise<string | null> {
  const address = normalizeEmail(email);
  if (owners.has(address)) return OWNER_USER_ID;
  const row = await db
    .prepare("SELECT user_id FROM user_emails WHERE email = ?")
    .bind(address)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** Owners, and anyone with a pending or accepted membership on some doc. */
export async function canSignIn(
  db: D1Database,
  email: string,
  owners: ReadonlySet<string>,
): Promise<boolean> {
  const address = normalizeEmail(email);
  if (owners.has(address)) return true;
  const row = await db
    .prepare(
      `SELECT 1 FROM doc_members WHERE email = ?
       UNION ALL
       SELECT 1 FROM doc_members m JOIN user_emails e ON e.user_id = m.user_id WHERE e.email = ?
       LIMIT 1`,
    )
    .bind(address, address)
    .first();
  return row !== null;
}

/**
 * Runs on every sign-in: makes sure the address has a user, then turns its
 * pending invites into memberships. Returns the user id.
 */
export async function claimInvites(
  db: D1Database,
  email: string,
  owners: ReadonlySet<string>,
  now: number,
): Promise<string> {
  const address = normalizeEmail(email);
  let userId = await userIdForEmail(db, address, owners);
  const statements: Array<D1PreparedStatement> = [];
  if (!userId) {
    userId = randomId();
    statements.push(
      db
        .prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, '', ?)")
        .bind(userId, address, now),
      db
        .prepare("INSERT INTO user_emails (email, user_id, created_at) VALUES (?, ?, ?)")
        .bind(address, userId, now),
    );
  }
  // An invite to a doc the person already belongs to keeps their current role.
  statements.push(
    db
      .prepare("UPDATE OR IGNORE doc_members SET user_id = ?, email = NULL WHERE email = ?")
      .bind(userId, address),
    db.prepare("DELETE FROM doc_members WHERE email = ?").bind(address),
  );
  await db.batch(statements);
  return userId;
}

export async function getUser(
  db: D1Database,
  userId: string,
  owners: ReadonlySet<string>,
): Promise<UserSummary> {
  const row = await db
    .prepare("SELECT id, email, name FROM users WHERE id = ?")
    .bind(userId)
    .first<UserRow>();
  if (!row) throw new NotFoundError("user");
  return toUser(row, owners);
}

/** Every address that signs in as this user. */
export async function userEmails(
  db: D1Database,
  userId: string,
  owners: ReadonlySet<string>,
): Promise<ReadonlyArray<string>> {
  if (isAdmin(userId)) return [...owners];
  const { results } = await db
    .prepare("SELECT email FROM user_emails WHERE user_id = ? ORDER BY created_at, email")
    .bind(userId)
    .all<{ email: string }>();
  return results.map((row) => row.email);
}

export async function getMe(
  db: D1Database,
  userId: string,
  owners: ReadonlySet<string>,
): Promise<Me> {
  const [user, emails] = await Promise.all([
    getUser(db, userId, owners),
    userEmails(db, userId, owners),
  ]);
  return { user, emails };
}

export async function setUserName(db: D1Database, userId: string, name: string): Promise<void> {
  await db.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name, userId).run();
}

export async function docRole(
  db: D1Database,
  docId: string,
  userId: string,
): Promise<DocRole | null> {
  const row = await db
    .prepare("SELECT role FROM doc_members WHERE doc_id = ? AND user_id = ?")
    .bind(docId, userId)
    .first<{ role: DocRole }>();
  return row?.role ?? null;
}

/**
 * The caller's role on a doc when it grants at least `minimum`. A doc the
 * caller cannot see is NotFoundError, so ids do not reveal what exists.
 */
export async function requireDocRole(
  db: D1Database,
  docId: string,
  userId: string,
  minimum: DocRole,
): Promise<DocRole> {
  const role = await docRole(db, docId, userId);
  if (role === null) throw new NotFoundError("doc");
  if (!hasRole(role, minimum)) throw new ForbiddenError(minimum);
  return role;
}

/** Makes `userId` the owner of a new doc; batch it with the doc's insert. */
export const ownerMembershipStatement = (
  db: D1Database,
  input: { readonly docId: string; readonly userId: string; readonly now: number },
) =>
  db
    .prepare(
      `INSERT INTO doc_members (id, doc_id, user_id, email, role, added_by, created_at)
       VALUES (?, ?, ?, NULL, 'owner', ?, ?)`,
    )
    .bind(randomId(), input.docId, input.userId, input.userId, input.now);

interface MemberRow {
  id: string;
  doc_id: string;
  role: DocRole;
  email: string | null;
  added_by: string | null;
  created_at: number;
  user_id: string | null;
  user_email: string | null;
  user_name: string | null;
}

const MEMBER_SELECT = `SELECT m.id, m.doc_id, m.role, m.email, m.added_by, m.created_at,
    u.id AS user_id, u.email AS user_email, u.name AS user_name
  FROM doc_members m LEFT JOIN users u ON u.id = m.user_id`;

const toMember = (row: MemberRow, owners: ReadonlySet<string>): DocMember => {
  const user =
    row.user_id === null
      ? null
      : toUser({ id: row.user_id, email: row.user_email, name: row.user_name ?? "" }, owners);
  return {
    id: row.id,
    role: row.role,
    user,
    email: user?.email ?? row.email ?? "",
    pending: user === null,
    addedBy: row.added_by,
    createdAt: row.created_at,
  };
};

/** Owners first (the earliest is the doc's owner), then everyone else in the order they were added. */
export async function listMembers(
  db: D1Database,
  docId: string,
  owners: ReadonlySet<string>,
): Promise<ReadonlyArray<DocMember>> {
  const { results } = await db
    .prepare(
      `${MEMBER_SELECT} WHERE m.doc_id = ?
       ORDER BY m.role = 'owner' DESC, m.created_at, m.id`,
    )
    .bind(docId)
    .all<MemberRow>();
  return results.map((row) => toMember(row, owners));
}

async function getMember(db: D1Database, docId: string, memberId: string): Promise<MemberRow> {
  const row = await db
    .prepare(`${MEMBER_SELECT} WHERE m.doc_id = ? AND m.id = ?`)
    .bind(docId, memberId)
    .first<MemberRow>();
  if (!row) throw new NotFoundError("member");
  return row;
}

/** The membership an address names: the person it signs in as, or a pending invite to it. */
export async function findMemberId(
  db: D1Database,
  input: { readonly docId: string; readonly email: string; readonly owners: ReadonlySet<string> },
): Promise<string | null> {
  const address = normalizeEmail(input.email);
  const userId = await userIdForEmail(db, address, input.owners);
  const row = await db
    .prepare("SELECT id FROM doc_members WHERE doc_id = ? AND (user_id = ? OR email = ?)")
    .bind(input.docId, userId, address)
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function ownerCount(db: D1Database, docId: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM doc_members WHERE doc_id = ? AND role = 'owner' AND user_id IS NOT NULL",
    )
    .bind(docId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/** Refuses to take away the last signed-in owner. */
async function assertKeepsAnOwner(db: D1Database, member: MemberRow, nextRole: DocRole | null) {
  if (member.role !== "owner" || member.user_id === null || nextRole === "owner") return;
  if ((await ownerCount(db, member.doc_id)) <= 1) throw new LastOwnerError();
}

/**
 * Gives `email` a role on the doc: a membership when the address already
 * signs in as someone, else a pending invite. An existing member's role is
 * changed instead. `created` says whether anyone new was added, so callers
 * only send an invite email for a new person.
 */
export async function shareDoc(
  db: D1Database,
  input: {
    readonly docId: string;
    readonly email: string;
    readonly role: DocRole;
    readonly addedBy: string;
    readonly owners: ReadonlySet<string>;
    readonly now: number;
  },
): Promise<{ readonly member: DocMember; readonly created: boolean }> {
  const address = normalizeEmail(input.email);
  // Without this, sharing to your own other address edits your own role.
  if ((await userIdForEmail(db, address, input.owners)) === input.addedBy) {
    throw new SelfShareError();
  }
  const existing = await findMemberId(db, { ...input, email: address });
  if (existing) {
    return {
      member: await setMemberRole(db, { ...input, memberId: existing }),
      created: false,
    };
  }
  const userId = await userIdForEmail(db, address, input.owners);
  const id = randomId();
  await db
    .prepare(
      `INSERT INTO doc_members (id, doc_id, user_id, email, role, added_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.docId, userId, userId ? null : address, input.role, input.addedBy, input.now)
    .run();
  return { member: toMember(await getMember(db, input.docId, id), input.owners), created: true };
}

export async function setMemberRole(
  db: D1Database,
  input: {
    readonly docId: string;
    readonly memberId: string;
    readonly role: DocRole;
    readonly owners: ReadonlySet<string>;
  },
): Promise<DocMember> {
  const member = await getMember(db, input.docId, input.memberId);
  await assertKeepsAnOwner(db, member, input.role);
  await db
    .prepare("UPDATE doc_members SET role = ? WHERE id = ?")
    .bind(input.role, member.id)
    .run();
  return toMember({ ...member, role: input.role }, input.owners);
}

/**
 * Owners remove anyone; everyone else may only leave. Returns the removed
 * person's user id (null for a pending invite) so their open sockets can close.
 */
export async function removeMember(
  db: D1Database,
  input: {
    readonly docId: string;
    readonly memberId: string;
    readonly by: { readonly userId: string; readonly role: DocRole };
  },
): Promise<{ readonly userId: string | null }> {
  const member = await getMember(db, input.docId, input.memberId);
  if (input.by.role !== "owner" && member.user_id !== input.by.userId) {
    throw new ForbiddenError("owner");
  }
  await assertKeepsAnOwner(db, member, null);
  await db.prepare("DELETE FROM doc_members WHERE id = ?").bind(member.id).run();
  return { userId: member.user_id };
}

/**
 * Narrows the library to the docs the user belongs to. The admin keeps every
 * project, even empty ones; anyone else sees only projects holding a doc
 * shared with them. The library is still loading when this starts, so the
 * two reads overlap.
 */
export async function scopeLibrary(
  db: D1Database,
  input: {
    readonly library: Promise<Library>;
    readonly userId: string;
    readonly owners: ReadonlySet<string>;
  },
): Promise<AccessibleLibrary> {
  const [library, [mine, docOwners]] = await Promise.all([
    input.library,
    db.batch<Record<string, unknown>>([
      db.prepare("SELECT doc_id, role FROM doc_members WHERE user_id = ?").bind(input.userId),
      db
        .prepare(
          `SELECT o.doc_id, u.id, u.email, u.name FROM doc_members o
           JOIN users u ON u.id = o.user_id
           JOIN doc_members me ON me.doc_id = o.doc_id AND me.user_id = ?
           WHERE o.role = 'owner'
           ORDER BY o.created_at DESC, o.id DESC`,
        )
        .bind(input.userId),
    ]),
  ]);
  const roles = new Map(
    ((mine?.results ?? []) as unknown as Array<{ doc_id: string; role: DocRole }>).map((row) => [
      row.doc_id,
      row.role,
    ]),
  );
  // Rows run newest first, so the earliest owner is the one left in the map.
  const ownerOf = new Map<string, UserSummary>();
  for (const row of (docOwners?.results ?? []) as unknown as Array<UserRow & { doc_id: string }>) {
    ownerOf.set(row.doc_id, toUser(row, input.owners));
  }
  const visible = (docs: ReadonlyArray<DocSummary>) =>
    docs.flatMap((doc) => {
      const role = roles.get(doc.id);
      return role ? [{ ...doc, role, owner: ownerOf.get(doc.id) ?? null }] : [];
    });
  return {
    projects: library.projects.flatMap((project) => {
      const docs = visible(project.docs);
      return docs.length > 0 || isAdmin(input.userId) ? [{ ...project, docs }] : [];
    }),
    noProjectDocs: visible(library.noProjectDocs),
  };
}

/**
 * Everyone on a doc the user is also on, as share suggestions: people by
 * their primary address and pending invites by theirs. Never the user.
 */
export async function listPeople(
  db: D1Database,
  userId: string,
  owners: ReadonlySet<string>,
): Promise<ReadonlyArray<Pick<UserSummary, "name" | "email">>> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT o.user_id, o.email AS pending_email, u.email AS user_email, u.name
       FROM doc_members o
       JOIN doc_members me ON me.doc_id = o.doc_id AND me.user_id = ?
       LEFT JOIN users u ON u.id = o.user_id
       WHERE o.user_id IS NULL OR o.user_id <> ?
       LIMIT 500`,
    )
    .bind(userId, userId)
    .all<{
      user_id: string | null;
      pending_email: string | null;
      user_email: string | null;
      name: string | null;
    }>();
  const people = new Map<string, Pick<UserSummary, "name" | "email">>();
  for (const row of results) {
    const person =
      row.user_id === null
        ? { name: "", email: row.pending_email ?? "" }
        : toUser({ id: row.user_id, email: row.user_email, name: row.name ?? "" }, owners);
    // A signed-in person outranks a pending invite to the same address.
    if (person.email && !people.get(person.email)?.name) {
      people.set(person.email, { name: person.name, email: person.email });
    }
  }
  return [...people.values()].sort(
    (a, b) =>
      (a.name || a.email).localeCompare(b.name || b.email) || a.email.localeCompare(b.email),
  );
}

/** The doc's owner: the earliest owner member. */
export async function docOwner(
  db: D1Database,
  docId: string,
  owners: ReadonlySet<string>,
): Promise<UserSummary | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.name FROM doc_members m JOIN users u ON u.id = m.user_id
       WHERE m.doc_id = ? AND m.role = 'owner' ORDER BY m.created_at, m.id LIMIT 1`,
    )
    .bind(docId)
    .first<UserRow>();
  return row ? toUser(row, owners) : null;
}

/** Whether the user may see a project: the admin sees all, others only those holding a doc they belong to. */
export async function canSeeProject(
  db: D1Database,
  projectId: string,
  userId: string,
): Promise<boolean> {
  if (isAdmin(userId)) return true;
  const row = await db
    .prepare(
      `SELECT 1 FROM docs d JOIN doc_members m ON m.doc_id = d.id
       WHERE d.project_id = ? AND m.user_id = ? LIMIT 1`,
    )
    .bind(projectId, userId)
    .first();
  return row !== null;
}
