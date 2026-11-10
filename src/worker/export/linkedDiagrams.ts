// The Draw.io diagrams a doc's tabs link, loaded for an export.

import { drawioDiagramIds } from "../../shared/drawio.ts";
import type { ExportDiagram, ExportDiagrams } from "../../shared/drawioExport.ts";
import { getDiagram } from "../diagrams.ts";
import { NotFoundError } from "../docs.ts";

/**
 * Each diagram `tabs` link, by id; a deleted one is left out. The caller has
 * already checked that the person can read the tabs, and anyone who can read a
 * tab that links a diagram may see its title and picture.
 */
export async function linkedDiagrams(
  db: D1Database,
  tabs: ReadonlyArray<{ readonly markdown: string }>,
): Promise<ExportDiagrams> {
  const ids = new Set(tabs.flatMap((tab) => drawioDiagramIds(tab.markdown)));
  const found = await Promise.all(
    [...ids].map(async (id): Promise<ExportDiagram | null> => {
      try {
        const { title, pictureVersion, hasSource } = await getDiagram(db, id);
        return { id, title, pictureVersion, hasSource };
      } catch (cause) {
        if (cause instanceof NotFoundError) return null;
        throw cause;
      }
    }),
  );
  return new Map(found.flatMap((diagram) => (diagram ? [[diagram.id, diagram] as const] : [])));
}
