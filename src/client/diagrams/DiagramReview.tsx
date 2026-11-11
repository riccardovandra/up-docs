import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import {
  diagramToPicture,
  layoutPage,
  pictureFrame,
  pictureToDiagram,
  pinPlacement,
  shapeAt,
  type DiagramComment,
  type DiagramThread,
  type PictureFrame,
} from "../../shared/diagramComments.ts";
import {
  diagramPictureUrl,
  isPictureCurrent,
  pagePicture,
  type DiagramSummary,
} from "../../shared/drawio.ts";
import type { DrawioPageLayout } from "../../shared/drawioModel.ts";
import { authorLabel, CommentComposer } from "../comments/CommentCard.tsx";
import { DiagramPicture, type DiagramPictureInfo } from "./DiagramPicture.tsx";
import type { NewDiagramAnchor } from "./diagramCommentsApi.ts";
import { threadsOnPage } from "./pageTabsLogic.ts";

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface Draft {
  readonly anchor: NewDiagramAnchor;
  readonly label: string;
  readonly fx: number;
  readonly fy: number;
}

const formatTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** The SVG url of the page's current picture, or null while it is missing or behind. */
function currentSvgUrl(diagram: DiagramSummary, page: string | null): string | null {
  if (!isPictureCurrent(diagram) || diagram.pictureVersion === null) return null;
  const shown = pagePicture(diagram, page);
  return shown.kind === "picture"
    ? diagramPictureUrl(diagram.id, "svg", diagram.pictureVersion, shown.index)
    : null;
}

/** How the page's picture lines up with its diagram, once its SVG is read. */
function usePictureFrame(src: string | null, layout: DrawioPageLayout | null) {
  const [frame, setFrame] = useState<PictureFrame | null>(null);
  const [svg, setSvg] = useState<{ src: string; text: string } | null>(null);
  useEffect(() => {
    if (src === null) return;
    let live = true;
    fetch(src, { credentials: "same-origin" })
      .then((response) => (response.ok ? response.text() : Promise.reject(response.status)))
      .then(
        (text) => {
          if (live) setSvg({ src, text });
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [src]);
  useEffect(() => {
    setFrame(svg && svg.src === src ? pictureFrame(svg.text, layout) : null);
  }, [svg, src, layout]);
  return frame;
}

const lastAuthorIsAgent = (thread: DiagramThread) =>
  (thread.replies.at(-1) ?? thread).authorKind === "agent";

function Entry(props: { readonly comment: DiagramComment }) {
  const agent = props.comment.authorKind === "agent";
  return (
    <div className="comment-entry">
      <div className="comment-meta">
        <span className={agent ? "comment-author diagram-agent" : "comment-author"}>
          {authorLabel(props.comment.author)}
        </span>
        {agent ? <span className="diagram-agent-tag">agent</span> : null}
        <span className="muted">{formatTime(props.comment.createdAt)}</span>
      </div>
      <p className="comment-body">{props.comment.body}</p>
    </div>
  );
}

/**
 * A diagram's picture with its comment pins over it. Open pins always show;
 * in review mode resolved ones show too, and a click drops a new pin, snapped
 * to the shape under it. A pin opens its thread inline.
 */
export function DiagramReviewCanvas(props: {
  readonly diagram: DiagramPictureInfo & DiagramSummary;
  readonly page: string | null;
  readonly layouts: ReadonlyArray<DrawioPageLayout>;
  readonly threads: ReadonlyArray<DiagramThread>;
  readonly review: boolean;
  readonly canComment: boolean;
  /** Shown on each thread when the comment cannot reach the chat by itself. */
  readonly copyToChat: ((thread: DiagramThread) => void) | null;
  readonly onCreate: (anchor: NewDiagramAnchor, body: string) => Promise<DiagramThread>;
  readonly onReply: (thread: DiagramThread, body: string) => Promise<unknown>;
  readonly onResolve: (thread: DiagramThread, resolved: boolean) => Promise<unknown>;
}) {
  const { diagram, page, threads, review } = props;
  const container = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const layout = layoutPage(props.layouts, page);
  const frame = usePictureFrame(currentSvgUrl(diagram, page), layout);

  // The overlay sits exactly over the image, which is fitted inside the canvas.
  const measure = useCallback(() => {
    const host = container.current;
    const image = host?.querySelector("img");
    if (!host || !image || image.clientWidth === 0) {
      setBox(null);
      return;
    }
    const outer = host.getBoundingClientRect();
    const inner = image.getBoundingClientRect();
    setBox((current) => {
      const next = {
        left: inner.left - outer.left,
        top: inner.top - outer.top,
        width: inner.width,
        height: inner.height,
      };
      return current &&
        Object.entries(next).every(
          ([key, value]) => Math.abs(current[key as keyof Box] - value) < 0.5,
        )
        ? current
        : next;
    });
  }, []);
  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (container.current) observer.observe(container.current);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  useEffect(() => {
    if (!review) setDraft(null);
  }, [review]);
  useEffect(() => {
    setDraft(null);
    setActive(null);
  }, [page]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setDraft(null);
      setActive(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onPage = threadsOnPage(threads, page);
  const shown = onPage.filter((thread) => review || thread.resolvedAt === null);
  const number = new Map(threads.map((thread, index) => [thread.id, index + 1]));

  const dropPin = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!review || !props.canComment || !frame || !box) return;
    if ((event.target as HTMLElement).closest(".diagram-pin, .diagram-pop")) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const fx = (event.clientX - bounds.left) / bounds.width;
    const fy = (event.clientY - bounds.top) / bounds.height;
    const point = pictureToDiagram(frame, fx, fy);
    const shape = shapeAt(layout, point.x, point.y);
    setActive(null);
    setDraft({
      anchor: {
        page,
        shapeId: shape?.id ?? null,
        x: Math.round(point.x),
        y: Math.round(point.y),
      },
      label: shape?.label ?? "",
      fx,
      fy,
    });
  };

  const popStyle = (fx: number, fy: number) =>
    fx > 0.6
      ? { right: `${(1 - fx) * 100}%`, top: `${fy * 100}%`, marginRight: "18px" }
      : { left: `${fx * 100}%`, top: `${fy * 100}%`, marginLeft: "18px" };

  return (
    <div
      ref={container}
      className="diagram-review"
      data-review={review ? "on" : "off"}
      onLoadCapture={measure}
    >
      <DiagramPicture diagramId={diagram.id} diagram={diagram} page={page} />
      {box && frame ? (
        <div
          className="diagram-review-layer"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
          onClick={dropPin}
          data-testid="diagram-review-layer"
        >
          {shown.map((thread) => {
            const pin = pinPlacement(thread.anchor, layout);
            const { fx, fy } = diagramToPicture(frame, pin.x, pin.y);
            const kind =
              thread.resolvedAt !== null ? "resolved" : lastAuthorIsAgent(thread) ? "agent" : "open";
            const label = pin.shape?.label || thread.quote || "Point";
            return (
              <div key={thread.id}>
                <button
                  type="button"
                  className={`diagram-pin ${kind}`}
                  style={{ left: `${fx * 100}%`, top: `${fy * 100}%` }}
                  aria-label={`Comment ${number.get(thread.id)} on ${label}`}
                  aria-expanded={active === thread.id}
                  data-thread={thread.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    setDraft(null);
                    setActive(active === thread.id ? null : thread.id);
                  }}
                >
                  <span>{number.get(thread.id)}</span>
                </button>
                {active === thread.id ? (
                  <div
                    className="diagram-pop"
                    style={popStyle(fx, fy)}
                    role="dialog"
                    aria-label={`Thread on ${label}`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="diagram-pop-anchor">
                      {pin.status === "shape" ? "On " : pin.status === "shape_removed" ? "Was on " : ""}
                      <b>{pin.status === "point" ? "A point on the page" : label}</b>
                      {pin.status === "shape_removed" ? " (shape deleted)" : null}
                      {thread.resolvedAt !== null ? <span className="diagram-resolved">Resolved</span> : null}
                    </div>
                    <Entry comment={thread} />
                    {thread.replies.map((reply) => (
                      <Entry key={reply.id} comment={reply} />
                    ))}
                    {props.canComment ? (
                      <>
                        {thread.resolvedAt === null ? (
                          <CommentComposer
                            placeholder="Reply"
                            submitLabel="Reply"
                            onSubmit={(body) => props.onReply(thread, body)}
                          />
                        ) : null}
                        <div className="comment-actions">
                          <button
                            type="button"
                            className="link-button"
                            onClick={() =>
                              void props.onResolve(thread, thread.resolvedAt === null)
                            }
                          >
                            {thread.resolvedAt === null ? "Resolve" : "Reopen"}
                          </button>
                          {props.copyToChat ? (
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => props.copyToChat?.(thread)}
                            >
                              Copy to chat
                            </button>
                          ) : null}
                        </div>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          {draft ? (
            <>
              <span
                className="diagram-pin draft"
                style={{ left: `${draft.fx * 100}%`, top: `${draft.fy * 100}%` }}
              >
                <span>+</span>
              </span>
              <div
                className="diagram-pop"
                style={popStyle(draft.fx, draft.fy)}
                role="dialog"
                aria-label="New comment"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="diagram-pop-anchor">
                  {draft.label ? (
                    <>
                      On <b>{draft.label}</b>
                    </>
                  ) : draft.anchor.shapeId ? (
                    <b>An unlabelled shape</b>
                  ) : (
                    <b>A point on the page</b>
                  )}
                </div>
                <CommentComposer
                  placeholder="Comment, sent to the chat too"
                  submitLabel="Comment"
                  autoFocus
                  onSubmit={async (body) => {
                    const thread = await props.onCreate(draft.anchor, body);
                    setDraft(null);
                    setActive(thread.id);
                  }}
                  onCancel={() => setDraft(null)}
                />
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      {review ? (
        <span className="diagram-review-hint">
          {props.canComment
            ? "Review: click a shape or anywhere to drop a pin"
            : "Review: you can read these comments"}
        </span>
      ) : null}
    </div>
  );
}
