import { useEffect, useState } from "react";

import {
  diagramPictureUrl,
  isPictureCurrent,
  pagePicture,
  type DiagramSummary,
} from "../../shared/drawio.ts";
import { diagramsApi, subscribeDiagram } from "./diagramsApi.ts";
import { requestRedraw } from "./redraw.ts";
import "./diagrams.css";

/** What a picture needs to know about its diagram. A list item and a `DiagramView` both fit. */
export type DiagramPictureInfo = Pick<
  DiagramSummary,
  "id" | "title" | "version" | "pictureVersion" | "picturePages" | "hasSource"
> & { readonly canEdit: boolean };

export type DiagramPictureState =
  /** Not known yet. */
  | { readonly status: "loading" }
  /** Deleted, or not shared with this person. */
  | { readonly status: "missing" }
  /** Nobody has drawn in it yet. */
  | { readonly status: "empty" }
  /** The picture shows the current drawing. */
  | { readonly status: "ready"; readonly src: string }
  /** Being drawn in this browser; `src` is the older picture, when there is one. */
  | { readonly status: "rendering"; readonly src: string | null }
  /** Behind or absent, and this person cannot draw it (or the drawing failed). */
  | { readonly status: "stale"; readonly src: string | null }
  /** The diagram has no page of the name the block gives. */
  | { readonly status: "page_missing" }
  /** The page exists but is past the pages that get a picture. */
  | { readonly status: "page_unpictured" };

const pick = (
  diagram: DiagramSummary | DiagramPictureInfo,
  canEdit: boolean,
): DiagramPictureInfo => ({
  id: diagram.id,
  title: diagram.title,
  version: diagram.version,
  pictureVersion: diagram.pictureVersion,
  picturePages: diagram.picturePages,
  hasSource: diagram.hasSource,
  canEdit: "canEdit" in diagram ? diagram.canEdit : canEdit,
});

/** The later of two views of one diagram: the higher version, then the newer picture, then `b`. */
const later = (a: DiagramPictureInfo, b: DiagramPictureInfo) =>
  b.version > a.version ||
  (b.version === a.version && (b.pictureVersion ?? 0) >= (a.pictureVersion ?? 0))
    ? b
    : a;

/**
 * Follows one diagram's picture: fetches the diagram unless `known` is given,
 * hears every save this page makes to it and every re-read of the page, and
 * has the picture drawn when it is missing or behind and the person manages
 * the diagram.
 */
export function useDiagramPicture(
  diagramId: string,
  known?: DiagramPictureInfo,
  /** The page to show, by name; null or absent for the first page. */
  page: string | null = null,
): { readonly state: DiagramPictureState; readonly title: string | null } {
  const [heard, setHeard] = useState<DiagramPictureInfo | "missing" | null>(null);
  /** The `id:version` a redraw was last asked for, and the one that failed. */
  const [asked, setAsked] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const hasKnown = known !== undefined;

  useEffect(() => {
    setHeard(null);
    setAsked(null);
    setFailed(null);
    let live = true;
    if (!hasKnown) {
      diagramsApi.get(diagramId).then(
        (diagram) => {
          if (live) setHeard((current) => (current === null ? pick(diagram, false) : current));
        },
        () => {
          if (live) setHeard((current) => current ?? "missing");
        },
      );
    }
    const stop = subscribeDiagram(diagramId, (diagram) =>
      setHeard((current) => {
        if (diagram === null) return "missing";
        const before = current === "missing" ? null : current;
        return pick(diagram, before?.canEdit ?? known?.canEdit ?? false);
      }),
    );
    return () => {
      live = false;
      stop();
    };
    // `known.canEdit` is read once per diagram: who the viewer is does not change under a picture.
  }, [diagramId, hasKnown]);

  const info =
    heard === "missing"
      ? null
      : known && heard
        ? later(known, heard)
        : (heard ?? (known?.id === diagramId ? known : null));
  const shown = info === null ? null : pagePicture(info, page);
  // A picture that does not say which page is which is drawn again for a block that names one.
  const behind =
    info !== null && info.hasSource && (!isPictureCurrent(info) || shown?.kind === "unknown");
  const attempt = info ? `${info.id}:${info.version}` : null;

  const canDraw = behind && info.canEdit;
  useEffect(() => {
    // Once per version: a failure is shown, not retried in a loop.
    if (!canDraw || attempt === null || asked === attempt) return;
    setAsked(attempt);
    requestRedraw(diagramId).then(
      // Also covers a picture someone else already drew: the queue then just reports it.
      (diagram) => setHeard((current) => (current === "missing" ? current : pick(diagram, true))),
      () => setFailed(attempt),
    );
  }, [canDraw, diagramId, attempt, asked]);

  if (heard === "missing") return { state: { status: "missing" }, title: null };
  if (!info) return { state: { status: "loading" }, title: null };
  const { title } = info;
  if (!info.hasSource) return { state: { status: "empty" }, title };
  if (!behind && shown?.kind === "not_found") return { state: { status: "page_missing" }, title };
  if (!behind && shown?.kind === "no_picture") {
    return { state: { status: "page_unpictured" }, title };
  }
  const src =
    info.pictureVersion === null || shown?.kind !== "picture"
      ? null
      : diagramPictureUrl(info.id, "svg", info.pictureVersion, shown.index);
  if (!behind && src !== null) return { state: { status: "ready", src }, title };
  const drawing = info.canEdit && failed !== attempt;
  return { state: { status: drawing ? "rendering" : "stale", src }, title };
}

const NOTES: Readonly<Record<DiagramPictureState["status"], string | null>> = {
  loading: null,
  missing: "Diagram not found",
  empty: "Empty diagram",
  ready: null,
  rendering: "Rendering diagram",
  stale: "Picture not ready yet",
  page_missing: "Page not found",
  page_unpictured: "No picture of this page",
};

/**
 * A diagram's picture, by id, on a white card: Draw.io draws for a light page,
 * so the card stays white in dark mode. It loads from the picture route (the
 * page policy allows no data URIs), follows saves made on this page, and shows
 * "Rendering diagram" while the picture is drawn. Pass `diagram` when the
 * caller already has it, to skip the fetch.
 */
export function DiagramPicture(props: {
  readonly diagramId: string;
  readonly diagram?: DiagramPictureInfo;
  /** The page to show, by name; absent or null for the first page. */
  readonly page?: string | null;
  /** Defaults to the diagram's title. */
  readonly alt?: string;
  readonly className?: string;
}) {
  const { state, title } = useDiagramPicture(props.diagramId, props.diagram, props.page ?? null);
  const [broken, setBroken] = useState<string | null>(null);
  const src = "src" in state && state.src !== broken ? state.src : null;
  // An older picture is better than a note; "Rendering diagram" shows over it all the same.
  const note =
    state.status === "ready" || state.status === "stale"
      ? src === null
        ? (NOTES[state.status] ?? "Picture not available")
        : null
      : NOTES[state.status];
  return (
    <span
      className={props.className ? `diagram-picture ${props.className}` : "diagram-picture"}
      data-status={state.status}
    >
      {src !== null ? (
        <img
          src={src}
          alt={props.alt ?? title ?? "Diagram"}
          draggable={false}
          onError={() => setBroken(src)}
        />
      ) : null}
      {note !== null ? (
        <span className="diagram-picture-note" role="status">
          {note}
        </span>
      ) : null}
    </span>
  );
}
