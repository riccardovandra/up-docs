// Designs in docs (S4): which docs show a design, who sees one through a doc,
// and the routes an open doc and the design page use for that.
//
// The rule is the Draw.io one: anyone who edits a doc can type any design's id
// into a block, so a doc shows a design to its people (as viewers) only when
// someone who manages the design (its owner or editor on design_members) is an
// owner or editor of that doc. The admin owns every design, but that alone
// counts for nothing here: only the people list does. Viewers through a doc get
// the picture and the summary, never the .fig file or the editor. Links are
// found by reading tab markdown for the block; there is no index table.

import { canEdit, type DocRole } from "../shared/access.ts";
import { isDesignId, type DesignSummary } from "../shared/design.ts";
import {
  DESIGN_LANGUAGE,
  MAX_DESIGN_REFRESH_IDS,
  parseDesignBlock,
  type DesignRefresh,
  type DesignUsage,
  type DesignUse,
} from "../shared/designBlock.ts";
import { findFences } from "../shared/table.ts";
import { designRole, getDesign, requireDesign } from "./designs.ts";
import { NotFoundError } from "./docs.ts";

interface LinkRow {
  tab_id: string;
  tab_title: string;
  markdown: string;
  doc_id: string;
  doc_title: string;
  readable: number;
  by_manager: number;
}

/**
 * Every tab whose markdown shows the design in a block that parses. `readable`
 * says whether `userId` is on the tab's doc, `byManager` whether someone who
 * manages the design is an owner or editor of that doc.
 */
async function linkedTabs(
  db: D1Database,
  input: { readonly designId: string; readonly userId: string | null },
): Promise<
  ReadonlyArray<{ readonly use: DesignUse; readonly readable: boolean; readonly byManager: boolean }>
> {
  const { results } = await db
    .prepare(
      `SELECT t.id AS tab_id, t.title AS tab_title, t.markdown, t.doc_id, d.title AS doc_title,
         (m.user_id IS NOT NULL) AS readable,
         EXISTS (
           SELECT 1 FROM doc_members c
           JOIN design_members g ON g.user_id = c.user_id
           WHERE c.doc_id = t.doc_id AND c.role IN ('owner', 'editor')
             AND g.design_id = ?3 AND g.role IN ('owner', 'editor')) AS by_manager
       FROM tabs t JOIN docs d ON d.id = t.doc_id
       LEFT JOIN doc_members m ON m.doc_id = t.doc_id AND m.user_id = ?1
       WHERE instr(t.markdown, ?2) > 0 AND instr(t.markdown, ?3) > 0
       ORDER BY d.title COLLATE NOCASE, d.id, t.position, t.id`,
    )
    .bind(input.userId, DESIGN_LANGUAGE, input.designId)
    .all<LinkRow>();
  return results
    .filter((row) =>
      findFences(row.markdown).some(
        (fence) =>
          fence.language === DESIGN_LANGUAGE &&
          parseDesignBlock(fence.body)?.designId === input.designId,
      ),
    )
    .map((row) => ({
      use: {
        docId: row.doc_id,
        docTitle: row.doc_title,
        tabId: row.tab_id,
        tabTitle: row.tab_title,
      },
      readable: row.readable === 1,
      byManager: row.by_manager === 1,
    }));
}

/** Whether `userId` sees the design through a doc they are on (see the rule at the top). */
export async function seesDesignThroughDocs(
  db: D1Database,
  designId: string,
  userId: string,
): Promise<boolean> {
  const links = await linkedTabs(db, { designId, userId });
  return links.some((link) => link.readable && link.byManager);
}

/** The tabs that show the design in docs `userId` is on, and a count of the other docs. */
export async function designUsage(
  db: D1Database,
  input: { readonly designId: string; readonly userId: string },
): Promise<DesignUsage> {
  const links = await linkedTabs(db, input);
  const hidden = new Set(links.filter((link) => !link.readable).map((link) => link.use.docId));
  return {
    uses: links.filter((link) => link.readable).map((link) => link.use),
    otherDocs: hidden.size,
  };
}

/**
 * The designs among `designIds` that `userId` may see, as they are now, for an
 * open doc to re-read. One the person cannot see is left out, like one that is gone.
 */
export async function refreshDesigns(
  db: D1Database,
  input: { readonly designIds: ReadonlyArray<string>; readonly userId: string },
): Promise<ReadonlyArray<DesignRefresh>> {
  const seen = await Promise.all(
    [...new Set(input.designIds)].map(async (designId): Promise<DesignRefresh | null> => {
      let design: DesignSummary;
      try {
        design = await getDesign(db, designId);
      } catch (cause) {
        if (cause instanceof NotFoundError) return null;
        throw cause;
      }
      const role: DocRole | null = await designRole(db, designId, input.userId, {
        throughDocs: true,
      });
      return role ? { ...design, role, canEdit: canEdit(role) } : null;
    }),
  );
  return seen.filter((design) => design !== null);
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const IDS = /^[A-Za-z0-9_-]{1,64}(,[A-Za-z0-9_-]{1,64})*$/;

/**
 * The design routes S4 adds, answered before `handleDesigns`:
 * - `GET /api/designs?ids=<id>,<id>`: `{designs: DesignRefresh[]}`, at most MAX_DESIGN_REFRESH_IDS.
 * - `GET /api/designs/:id/uses` (editors of the design): `DesignUsage`.
 * Null for anything else.
 */
export async function handleDesignDocs(
  route: {
    readonly segments: ReadonlyArray<string>;
    readonly method: string;
    readonly url: URL;
    readonly userId: string;
  },
  deps: { readonly db: D1Database },
): Promise<Response | null> {
  if (route.method !== "GET") return null;
  const [, id, sub, leaf] = route.segments;
  if (!id) {
    const ids = route.url.searchParams.get("ids");
    if (ids === null) return null;
    if (ids === "") return json({ designs: [] });
    if (!IDS.test(ids)) return json({ error: "invalid_ids" }, 400);
    const designIds = ids.split(",");
    if (designIds.length > MAX_DESIGN_REFRESH_IDS) return json({ error: "too_many_ids" }, 400);
    return json({ designs: await refreshDesigns(deps.db, { designIds, userId: route.userId }) });
  }
  if (sub === "uses" && !leaf) {
    if (!isDesignId(id)) return json({ error: "not_found" }, 404);
    // Only someone who manages the design may know which docs show it. A viewer
    // through a doc is 403, a stranger 404, as for every other design route.
    await requireDesign(deps.db, {
      designId: id,
      userId: route.userId,
      need: "edit",
      throughDocs: true,
    });
    return json(await designUsage(deps.db, { designId: id, userId: route.userId }));
  }
  return null;
}
