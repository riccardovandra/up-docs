// What the home page needs beyond the scoped library: card previews, member
// counts, the caller's last opens, and search over tab Markdown. Every query
// joins the caller's own doc_members row, so it only reaches docs they are on.

import type { AccessibleLibrary, LibraryDoc } from "../shared/access.ts";
import {
  docPreview,
  PREVIEW_SOURCE_LENGTH,
  SEARCH_LIMIT,
  searchSnippet,
  type HomeDoc,
  type HomeLibrary,
  type SearchHit,
} from "../shared/home.ts";
import { richBlockText, visibleText } from "../shared/visibleText.ts";

interface CardRow {
  doc_id: string;
  head: string | null;
  members: number;
  opened_at: number | null;
}

/**
 * Adds each doc's preview, member count and the caller's last open to their
 * library, reading the cards while the library itself still loads.
 */
export async function homeLibrary(
  db: D1Database,
  libraryLoad: Promise<AccessibleLibrary>,
  userId: string,
): Promise<HomeLibrary> {
  // Only the start of the first top-level tab leaves D1, so a large doc costs
  // the grid no more than a short one.
  const cardRows = db
    .prepare(
      `SELECT me.doc_id,
         (SELECT substr(t.markdown, 1, ?) FROM tabs t
          WHERE t.doc_id = me.doc_id AND t.parent_tab_id IS NULL
          ORDER BY t.position LIMIT 1) AS head,
         (SELECT count(*) FROM doc_members m WHERE m.doc_id = me.doc_id) AS members,
         o.opened_at
       FROM doc_members me
       LEFT JOIN doc_opens o ON o.doc_id = me.doc_id AND o.user_id = me.user_id
       WHERE me.user_id = ?`,
    )
    .bind(PREVIEW_SOURCE_LENGTH, userId)
    .all<CardRow>();
  const [library, { results }] = await Promise.all([libraryLoad, cardRows]);
  const cards = new Map(results.map((row) => [row.doc_id, row]));
  const withCard = (docs: ReadonlyArray<LibraryDoc>): ReadonlyArray<HomeDoc> =>
    docs.map((doc) => {
      const card = cards.get(doc.id);
      return {
        ...doc,
        preview: card?.head ? docPreview(card.head, doc.title, richBlockText) : "",
        memberCount: card?.members ?? 1,
        openedAt: card?.opened_at ?? null,
      };
    });
  return {
    projects: library.projects.map((project) => ({ ...project, docs: withCard(project.docs) })),
    noProjectDocs: withCard(library.noProjectDocs),
  };
}

/** Records that a person opened a doc; agent tokens never call this. */
export async function recordOpen(
  db: D1Database,
  input: { readonly docId: string; readonly userId: string; readonly now: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO doc_opens (doc_id, user_id, opened_at) VALUES (?, ?, ?)
       ON CONFLICT (doc_id, user_id) DO UPDATE SET opened_at = excluded.opened_at`,
    )
    .bind(input.docId, input.userId, input.now)
    .run();
}

const likePattern = (query: string) => `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

/**
 * More LIKE matches than hits are read, since a match only in a table's JSON
 * or a diagram's code is dropped.
 */
const SEARCH_CANDIDATES = SEARCH_LIMIT * 2;

interface SearchRow {
  doc_id: string;
  tab_id: string;
  tab_title: string;
  markdown: string;
}

/**
 * Tabs whose visible text contains `query` (ASCII case-insensitive, like
 * SQLite's LIKE), in docs the user is on, most recently edited first. LIKE on
 * the Markdown narrows the tabs; the snippet comes from what a reader sees.
 */
export async function searchTabs(
  db: D1Database,
  input: { readonly userId: string; readonly query: string },
): Promise<ReadonlyArray<SearchHit>> {
  const { results } = await db
    .prepare(
      `SELECT t.doc_id, t.id AS tab_id, t.title AS tab_title, t.markdown
       FROM tabs t
       JOIN doc_members me ON me.doc_id = t.doc_id AND me.user_id = ?1
       WHERE t.markdown LIKE ?2 ESCAPE '\\'
       ORDER BY t.updated_at DESC, t.id
       LIMIT ?3`,
    )
    .bind(input.userId, likePattern(input.query), SEARCH_CANDIDATES)
    .all<SearchRow>();
  const hits: Array<SearchHit> = [];
  for (const row of results) {
    const snippet = searchSnippet(visibleText(row.markdown), input.query);
    if (snippet === null) continue;
    hits.push({ docId: row.doc_id, tabId: row.tab_id, tabTitle: row.tab_title, snippet });
    if (hits.length === SEARCH_LIMIT) break;
  }
  return hits;
}
