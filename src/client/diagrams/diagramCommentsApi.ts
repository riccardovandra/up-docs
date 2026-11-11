// The client's calls for comment threads on a diagram.

import type { DiagramComment, DiagramThread } from "../../shared/diagramComments.ts";
import type { DrawioPageLayout } from "../../shared/drawioModel.ts";
import { request } from "../api.ts";

export interface DiagramComments {
  readonly threads: ReadonlyArray<DiagramThread>;
  /** Where each page's shapes sit now, so pins follow them. */
  readonly pages: ReadonlyArray<DrawioPageLayout>;
}

/** Where a new thread goes: a shape (with the point clicked) or a point on a page. */
export interface NewDiagramAnchor {
  readonly page: string | null;
  readonly shapeId: string | null;
  readonly x: number;
  readonly y: number;
}

export const diagramCommentsApi = {
  list: (diagramId: string) =>
    request<DiagramComments>("GET", `/api/diagrams/${diagramId}/comments`),
  create: async (diagramId: string, anchor: NewDiagramAnchor, body: string) =>
    (
      await request<{ thread: DiagramThread }>("POST", `/api/diagrams/${diagramId}/comments`, {
        anchor,
        body,
      })
    ).thread,
  reply: (commentId: string, body: string) =>
    request<{ reply: DiagramComment; thread: DiagramThread }>(
      "POST",
      `/api/diagram-comments/${commentId}/replies`,
      { body },
    ),
  setResolved: async (commentId: string, resolved: boolean) =>
    (
      await request<{ thread: DiagramThread }>(
        "POST",
        `/api/diagram-comments/${commentId}/${resolved ? "resolve" : "reopen"}`,
        // A JSON body: the API refuses a cross-site form post, which has none.
        {},
      )
    ).thread,
};
