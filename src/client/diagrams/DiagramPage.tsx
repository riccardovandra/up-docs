import { useCallback, useEffect, useState, type MouseEvent } from "react";

import {
  diagramCommentChatText,
  diagramUrl,
  type DiagramCommentChat,
  type DiagramThread,
} from "../../shared/diagramComments.ts";
import { diagramCommentForChat } from "../../shared/embed.ts";

import type { DiagramUsage, DiagramView } from "../../shared/drawio.ts";
import type { Project } from "../../shared/protocol.ts";
import { ApiError, api } from "../api.ts";
import { formatDay } from "../home/homeLogic.ts";
import { HomeLink } from "../home/HomeLink.tsx";
import { DiagramIcon, DocIcon, LinkIcon, PenIcon } from "../home/icons.tsx";
import { TitleDialog } from "../home/TitleDialog.tsx";
import { useLockedProject } from "../lockedProject.ts";
import { postToEmbedParent, useEmbedFeatures } from "../embedBridge.ts";
import { docPath, navigate } from "../router.ts";
import { DiagramEditor } from "./DiagramEditor.tsx";
import { type DiagramComments, diagramCommentsApi } from "./diagramCommentsApi.ts";
import { DiagramReviewCanvas } from "./DiagramReview.tsx";
import { PageTabs, usePreloadedPages, useUrlPage } from "./PageTabs.tsx";
import { openCountsByPage } from "./pageTabsLogic.ts";
import { subscribeRefresh, watchDiagram } from "./diagramRefresh.ts";
import { diagramErrorMessage, diagramsApi, subscribeDiagram } from "./diagramsApi.ts";
import { ThemeMenu } from "./ThemeMenu.tsx";
import "../home/home.css";
import "./diagrams.css";

const DIAGRAMS_PATH = "/diagrams";

const follow = (path: string) => (event: MouseEvent) => {
  if (event.metaKey || event.ctrlKey) return;
  event.preventDefault();
  navigate(path);
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** While review mode is on and the page is seen, threads are re-read this often. */
const REVIEW_POLL_MS = 5_000;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // A frame without clipboard-write permission: the older copy command still works there.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}

/**
 * The diagram's comment threads and page layouts, re-read when the page's
 * diagram refresh runs (its 20 s timer, focus, the editor closing), when the
 * diagram's version moves, and every few seconds in review mode. That is how
 * an agent's reply or resolve reaches an open page.
 */
function useDiagramComments(diagramId: string, version: number | null, review: boolean) {
  const [comments, setComments] = useState<DiagramComments | null>(null);
  const reload = useCallback(async () => {
    try {
      setComments(await diagramCommentsApi.list(diagramId));
    } catch {
      // Offline, or the diagram is gone: the page says so on its own.
    }
  }, [diagramId]);
  useEffect(() => {
    if (version !== null) void reload();
  }, [reload, version]);
  useEffect(() => subscribeRefresh(() => void reload()), [reload]);
  useEffect(() => {
    if (!review) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, REVIEW_POLL_MS);
    return () => clearInterval(timer);
  }, [reload, review]);
  return { comments, setComments, reload };
}

/**
 * One diagram's own page: its picture, and for its creator and the admin the
 * way to rename, delete and edit it, and the docs that link it. Someone who
 * only reads a doc that links it sees the picture and the title.
 */
export function DiagramPage(props: { readonly diagramId: string }) {
  const { diagramId } = props;
  const lock = useLockedProject();
  const [diagram, setDiagram] = useState<DiagramView | null>(null);
  const [missing, setMissing] = useState(false);
  const [usage, setUsage] = useState<DiagramUsage | null>(null);
  const [projects, setProjects] = useState<ReadonlyArray<Project>>([]);
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  const { comments, reload: reloadComments } = useDiagramComments(
    diagramId,
    diagram?.version ?? null,
    review,
  );
  const pageNames =
    comments && comments.pages.length > 0
      ? comments.pages.map((page) => page.name)
      : (diagram?.picturePages ?? [null]);
  const [shownPage, showPage] = useUrlPage(pageNames);
  usePreloadedPages(diagram, pageNames, shownPage);
  const features = useEmbedFeatures();
  const hostTakesDiagrams = features?.includes("add-diagram-comment-to-chat") ?? false;

  const reload = useCallback(async () => {
    try {
      const loaded = await diagramsApi.get(diagramId);
      setDiagram(loaded);
      setMissing(false);
      if (loaded.canEdit) setUsage(await diagramsApi.uses(diagramId));
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) setMissing(true);
      else setNotice(diagramErrorMessage(cause));
    }
  }, [diagramId]);

  useEffect(() => {
    void reload();
    // The project's name, for Details; the page works without it.
    api.library().then(
      (library) => setProjects(library.projects),
      () => undefined,
    );
  }, [reload]);

  // A save or a redraw on this page, or a change made elsewhere that a re-read of the page
  // found: keep the title, the versions and the docs that link it in step.
  useEffect(() => {
    const stops = [
      watchDiagram(diagramId),
      subscribeDiagram(diagramId, (next) => {
        if (next === null) setMissing(true);
        else setDiagram((current) => (current ? { ...current, ...next } : current));
      }),
      subscribeRefresh((seen) => {
        const next = seen.get(diagramId)?.usage;
        if (next) setUsage(next);
      }),
    ];
    return () => stops.forEach((stop) => stop());
  }, [diagramId]);

  const back = (label: string) => (
    <button type="button" className="button secondary" onClick={() => navigate(DIAGRAMS_PATH)}>
      {label}
    </button>
  );

  if (missing) {
    return (
      <main className="home">
        <p className="home-empty">This diagram does not exist, or it is not shared with you.</p>
        {back("Back to Diagrams")}
      </main>
    );
  }
  if (!diagram || lock.kind === "loading") {
    return notice ? (
      <main className="home">
        <p className="error">{notice}</p>
        {back("Back to Diagrams")}
      </main>
    ) : null;
  }
  if (
    lock.kind === "locked" &&
    (lock.projectId === null || diagram.projectId !== lock.projectId)
  ) {
    return (
      <main className="home">
        <p className="home-empty">This diagram is not part of {lock.name}.</p>
        {back(`Back to ${lock.name}`)}
      </main>
    );
  }

  const { canEdit } = diagram;
  const pageName = pageNames[shownPage] ?? null;
  const threads = comments?.threads ?? [];
  const openCount = threads.filter((thread) => thread.resolvedAt === null).length;
  const openOnPage = threads.some(
    (thread) => thread.resolvedAt === null && thread.anchor.page === pageName,
  );

  /**
   * Every comment and reply written here goes to the T3 Code chat. A T3 Code
   * too old for diagram comments (or none) gets it on the clipboard instead.
   */
  const sendToChat = async (thread: DiagramThread, body: string) => {
    const chat: DiagramCommentChat = {
      diagramId,
      diagramTitle: diagram.title,
      url: diagramUrl(window.location.origin, diagramId),
      page: thread.anchor.page,
      commentId: thread.id,
      quote: thread.quote,
      body,
    };
    if (hostTakesDiagrams) {
      postToEmbedParent({ type: "t3-docs:add-comment-to-chat", ...diagramCommentForChat(chat) });
      setNotice("Added to the chat. Send your message there when you are ready.");
      return;
    }
    const copied = await copyText(diagramCommentChatText(chat));
    setNotice(
      copied
        ? "Saved. Copy to chat: the comment is on your clipboard, paste it into the chat."
        : "Saved. Use Copy to chat on the thread to put it on your clipboard.",
    );
  };
  const copyToChat = hostTakesDiagrams
    ? null
    : (thread: DiagramThread) => {
        const last = thread.replies.findLast((reply) => reply.authorKind === "person") ?? thread;
        void sendToChat(thread, last.body);
      };
  const linkedDocs = usage ? new Set(usage.uses.map((use) => use.docId)).size + usage.otherDocs : 0;
  const project = projects.find((candidate) => candidate.id === diagram.projectId);

  const remove = async () => {
    const warning =
      linkedDocs > 0
        ? ` It is linked in ${plural(linkedDocs, "doc")}, which will show it as missing.`
        : "";
    if (!window.confirm(`Delete "${diagram.title}" for everyone?${warning}`)) return;
    try {
      await diagramsApi.remove(diagramId);
      navigate(DIAGRAMS_PATH, { replace: true });
    } catch (cause) {
      setNotice(diagramErrorMessage(cause));
    }
  };

  return (
    <div className="diagram-page">
      <header className="doc-header">
        <div className="doc-header-title">
          <HomeLink />
          <span className="doc-header-crumb">/</span>
          <a
            href={DIAGRAMS_PATH}
            className="home-link diagram-crumb"
            onClick={follow(DIAGRAMS_PATH)}
          >
            <DiagramIcon size={16} />
            Diagrams
          </a>
          <span className="doc-header-crumb">/</span>
          <span className="diagram-page-title">{diagram.title}</span>
          {canEdit && usage && linkedDocs > 0 ? (
            <span className="diagram-chip linked">
              <LinkIcon size={12} />
              In {plural(linkedDocs, "doc")}
            </span>
          ) : null}
          {/* Its own line below the title at narrow widths (diagrams.css). */}
          <span className="diagram-theme-slot">
            <ThemeMenu diagramId={diagramId} canEdit={canEdit} />
          </span>
        </div>
        <div className="doc-header-actions">
          {canEdit || threads.length > 0 ? (
            <button
              type="button"
              className="button secondary small diagram-review-toggle"
              aria-pressed={review}
              onClick={() => setReview(!review)}
            >
              {review ? "Exit review" : "Review"} · {openCount} open
            </button>
          ) : null}
        {canEdit ? (
          <>
            <button
              type="button"
              className="button secondary small"
              onClick={() => setRenaming(true)}
            >
              Rename
            </button>
            <button type="button" className="button secondary small" onClick={() => void remove()}>
              Delete
            </button>
            <button
              type="button"
              className="button small diagram-edit-button"
              onClick={() => setEditing(true)}
            >
              <PenIcon size={15} />
              Edit in Draw.io
            </button>
          </>
        ) : null}
        </div>
      </header>

      {notice ? (
        <div className="notice diagram-page-notice" role="status">
          {notice}
          <button type="button" className="link-button" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="diagram-viewer">
        <div className="diagram-stage">
          {(() => {
            const picture = (
              <DiagramReviewCanvas
                diagram={diagram}
                page={pageName}
                layouts={comments?.pages ?? []}
                threads={threads}
                review={review}
                canComment={canEdit}
                copyToChat={copyToChat}
                onCreate={async (anchor, body) => {
                  try {
                    const thread = await diagramCommentsApi.create(diagramId, anchor, body);
                    await reloadComments();
                    await sendToChat(thread, body);
                    return thread;
                  } catch (cause) {
                    setNotice(diagramErrorMessage(cause));
                    throw cause;
                  }
                }}
                onReply={async (thread, body) => {
                  try {
                    await diagramCommentsApi.reply(thread.id, body);
                    await reloadComments();
                    await sendToChat(thread, body);
                  } catch (cause) {
                    setNotice(diagramErrorMessage(cause));
                    throw cause;
                  }
                }}
                onResolve={async (thread, resolved) => {
                  try {
                    await diagramCommentsApi.setResolved(thread.id, resolved);
                    await reloadComments();
                  } catch (cause) {
                    setNotice(diagramErrorMessage(cause));
                  }
                }}
              />
            );
            // Click to edit, unless pins are showing: then clicks are theirs.
            return canEdit && !review && !openOnPage ? (
              <button
                type="button"
                className="diagram-canvas"
                title="Click to edit"
                onClick={() => setEditing(true)}
              >
                {picture}
              </button>
            ) : (
              <div className={review ? "diagram-canvas reviewing" : "diagram-canvas"}>{picture}</div>
            );
          })()}
        </div>
        <aside className="diagram-side">
          {canEdit ? (
            <>
              <h2>Used in</h2>
              {usage && usage.uses.length > 0 ? (
                usage.uses.map((use) => (
                  <a
                    key={use.tabId}
                    href={docPath(use.docId, use.tabId)}
                    className="diagram-use"
                    onClick={follow(docPath(use.docId, use.tabId))}
                  >
                    <DocIcon size={16} />
                    <span className="diagram-use-text">
                      <span>{use.docTitle}</span>
                      {use.tabTitle !== use.docTitle ? (
                        <span className="muted">{use.tabTitle}</span>
                      ) : null}
                    </span>
                  </a>
                ))
              ) : (
                <p className="muted">No doc embeds this diagram yet.</p>
              )}
              {usage && usage.otherDocs > 0 ? (
                <p className="muted">
                  And {plural(usage.otherDocs, "doc")} you are not on.
                </p>
              ) : null}
            </>
          ) : null}
          <h2>Details</h2>
          <dl>
            {canEdit ? (
              <>
                <dt>Project</dt>
                <dd>{project?.name ?? "No project"}</dd>
              </>
            ) : null}
            <dt>Updated</dt>
            <dd>{formatDay(diagram.updatedAt)}</dd>
            <dt>Created</dt>
            <dd>{formatDay(diagram.createdAt)}</dd>
          </dl>
          <h2>How it is stored</h2>
          <p className="muted">
            Once, here in Diagrams. Docs keep a link to it, not a copy, so one save updates every
            doc that shows it.
          </p>
        </aside>
      </div>

      <PageTabs
        names={pageNames}
        active={shownPage}
        onSelect={showPage}
        openCounts={openCountsByPage(threads, pageNames)}
        keys={!editing && !renaming}
      />

      {editing ? (
        <DiagramEditor
          target={{ kind: "existing", diagramId }}
          startPage={shownPage}
          onClose={() => {
            setEditing(false);
            void reload();
          }}
        />
      ) : null}
      {renaming ? (
        <TitleDialog
          heading="Rename diagram"
          detail={null}
          initial={diagram.title}
          submitLabel="Rename"
          onSubmit={async (title) => {
            if (title !== diagram.title) await diagramsApi.update(diagramId, { title });
          }}
          onClose={() => setRenaming(false)}
        />
      ) : null}
    </div>
  );
}
