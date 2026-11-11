// The Draw.io diagrams a doc's tabs link, loaded for an export.

import { drawioDiagramIds } from "../../shared/drawio.ts";
import type { ExportDiagram, ExportDiagrams } from "../../shared/drawioExport.ts";
import { requireDiagram } from "../diagrams.ts";
import { NotFoundError } from "../docs.ts";

/**
 * Each diagram `tabs` link that `userId` may see, by id. One that is gone, or
 * that the link does not show to them, is left out.
 */
export async function linkedDiagrams(
  db: D1Database,
  tabs: ReadonlyArray<{ readonly markdown: string }>,
  userId: string,
): Promise<ExportDiagrams> {
  const ids = new Set(tabs.flatMap((tab) => drawioDiagramIds(tab.markdown)));
  const found = await Promise.all(
    [...ids].map(async (id): Promise<ExportDiagram | null> => {
      try {
        const { diagram } = await requireDiagram(db, { diagramId: id, userId, need: "view" });
        const { title, pictureVersion, picturePages, hasSource } = diagram;
        return { id, title, pictureVersion, picturePages, hasSource };
      } catch (cause) {
        if (cause instanceof NotFoundError) return null;
        throw cause;
      }
    }),
  );
  return new Map(found.flatMap((diagram) => (diagram ? [[diagram.id, diagram] as const] : [])));
}
