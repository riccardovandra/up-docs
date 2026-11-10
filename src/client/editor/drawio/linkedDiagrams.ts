// The Draw.io diagrams a doc's tabs link, loaded in the browser for an export
// that is built here (Send to Scribe).

import { drawioDiagramIds } from "../../../shared/drawio.ts";
import type { ExportDiagram, ExportDiagrams } from "../../../shared/drawioExport.ts";
import { ApiError } from "../../api.ts";
import { diagramsApi, type DiagramsApi } from "../../diagrams/diagramsApi.ts";

/** Each diagram `tabs` link, by id. One that is gone, or not shared with the person, is left out. */
export async function loadLinkedDiagrams(
  tabs: ReadonlyArray<{ readonly markdown: string }>,
  api: Pick<DiagramsApi, "get"> = diagramsApi,
): Promise<ExportDiagrams> {
  const ids = new Set(tabs.flatMap((tab) => drawioDiagramIds(tab.markdown)));
  const found = await Promise.all(
    [...ids].map(async (id): Promise<ExportDiagram | null> => {
      try {
        const { title, pictureVersion, hasSource } = await api.get(id);
        return { id, title, pictureVersion, hasSource };
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 404) return null;
        throw cause;
      }
    }),
  );
  return new Map(found.flatMap((diagram) => (diagram ? [[diagram.id, diagram] as const] : [])));
}
