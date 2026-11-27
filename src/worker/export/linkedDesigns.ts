// The designs a doc's tabs show, loaded for an export (S4, designs in docs).

import { designIdsIn, type ExportDesign, type ExportDesigns } from "../../shared/designBlock.ts";
import { requireDesign } from "../designs.ts";
import { NotFoundError } from "../docs.ts";

/**
 * Each design `tabs` show that `userId` may see, through its people list or
 * through a doc that shows it, by id. One that is gone, or hidden from them,
 * is left out, and its block comes out as "Design not found".
 */
export async function linkedDesigns(
  db: D1Database,
  tabs: ReadonlyArray<{ readonly markdown: string }>,
  userId: string,
): Promise<ExportDesigns> {
  const ids = new Set(tabs.flatMap((tab) => designIdsIn(tab.markdown)));
  const found = await Promise.all(
    [...ids].map(async (id): Promise<ExportDesign | null> => {
      try {
        const { design } = await requireDesign(db, {
          designId: id,
          userId,
          need: "view",
          throughDocs: true,
        });
        return { id, title: design.title, pictureVersion: design.pictureVersion };
      } catch (cause) {
        if (cause instanceof NotFoundError) return null;
        throw cause;
      }
    }),
  );
  return new Map(found.flatMap((design) => (design ? [[design.id, design] as const] : [])));
}
