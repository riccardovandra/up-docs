import { docTitleFromPath } from "../../host/docPaths.ts";
import type { Editor } from "@tiptap/core";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { DocAnchor } from "../../shared/anchors.ts";
import type { Comment } from "../../shared/protocol.ts";
import { groupThreads, type CommentThread } from "../../shared/threads.ts";
import { CommentMargin, DRAFT_COMMENT_ID } from "../comments/CommentMargin.tsx";
import { ResolvedComments } from "../comments/ResolvedComments.tsx";
import { hasAddToChatHandler, subscribeAddToChat } from "../comments/addToChat.ts";
import { useCommentSource } from "../comments/useComments.ts";
import { selectionAnchor, useEditorComments } from "../comments/useEditorComments.ts";
import { useMediaQuery } from "../comments/useMediaQuery.ts";
import { SelectionToolbar } from "../editor/SelectionToolbar.tsx";

import { HomeLink } from "../home/HomeLink.tsx";
import { OutlineRail } from "../doc/OutlineRail.tsx";
import { useColumnWidth } from "../doc/toolbar/columnWidth.ts";
import { DocToolbar } from "../doc/toolbar/DocToolbar.tsx";
import { CommentIcon } from "../doc/toolbar/icons.tsx";
import { useStableCallback } from "../doc/useStableCallback.ts";
import { TabEditor } from "../editor/TabEditor.tsx";
import { useMe } from "../me.ts";
import { navigate } from "../router.ts";
import { DocSaver } from "./docSaver.ts";
import { localDocSource, type DocSnapshot, type DocSource } from "./docSource.ts";
import {
  hostClient,
  useLocalCommentsAvailable,
  useLocalFilesAvailable,
  useLocalImportAvailable,
} from "./hostClient.ts";
import { localCommentSource } from "./localCommentSource.ts";
import { LocalRequestError } from "./localClient.ts";
import { LocalImportActions } from "./LocalImportActions.tsx";

const NO_TABS: ReadonlyArray<never> = [];
const noop = () => undefined;
const quietly = (promise: Promise<unknown>) => void promise.catch(() => undefined);
const refuseImage = () => Promise.reject(new Error("Images cannot be added to project files."));

/** A T3 Code project file, on the local route. Only T3 Code can serve one. */
export function LocalDocPage(props: { readonly path: string }) {
  const available = useLocalFilesAvailable();
  const source = useMemo(() => localDocSource(hostClient, props.path), [props.path]);
  if (available === null) return null;
  if (!available) {
    return (
      <main className="home">
        <p className="home-empty">
          {docTitleFromPath(props.path)} is a project file. It opens in T3 Code&apos;s Docs panel.
        </p>
        <HomeLink />
      </main>
    );
  }
  return <LocalDoc path={props.path} source={source} />;
}

function LocalDoc(props: { readonly path: string; readonly source: DocSource }) {
  const { source } = props;
  const [snapshot, setSnapshot] = useState<DocSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  // Bumped when the file changed on disk underneath the editor.
  const [revision, setRevision] = useState(0);
  const saver = useRef<DocSaver | null>(null);
  const shown = useRef<DocSnapshot | null>(null);

  const show = (next: DocSnapshot) => {
    shown.current = next;
    setSnapshot(next);
  };
  /** Text from disk; the editor takes it only when it differs from what it has. */
  const adopt = useStableCallback((next: DocSnapshot) => {
    const current = shown.current;
    saver.current?.acceptRemote(next.version);
    if (current?.version === next.version && current.readOnlyReason === next.readOnlyReason) {
      return;
    }
    show(next);
    if (current !== null) setRevision((value) => value + 1);
  });

  const reload = useStableCallback(async () => {
    try {
      const next = await source.load();
      // An edit being saved wins; if the file moved on meanwhile, its save conflicts.
      if (saver.current?.dirty) return;
      adopt(next);
      setLoadError(null);
    } catch (cause) {
      setLoadError(cause instanceof LocalRequestError ? cause.message : "Could not open the file.");
    }
  });

  useEffect(() => {
    void reload();
    return source.subscribe(() => void reload());
  }, [source, reload]);

  const loaded = snapshot !== null;
  useEffect(() => {
    if (!loaded) return;
    const docSaver = new DocSaver(source, shown.current?.version ?? "", {
      onSaved: (saved) => {
        setSaving(docSaver.pending);
        // The editor already has this text; only the version moves on.
        if (!shown.current) return;
        shown.current = { ...shown.current, version: saved };
        setSnapshot(shown.current);
      },
      onConflict: (current) => {
        setSaving(false);
        adopt(current);
        setNotice(
          "This file changed on disk, so it was reloaded. Your last edit was not saved over it.",
        );
      },
      onError: (cause) =>
        setNotice(
          cause instanceof LocalRequestError
            ? `Could not save: ${cause.message}`
            : "Could not save the file. Retrying.",
        ),
    });
    saver.current = docSaver;
    const flush = () => void docSaver.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      void docSaver.flush();
      if (saver.current === docSaver) saver.current = null;
    };
  }, [loaded, source, adopt]);

  const me = useMe();
  const [width, toggleWidth] = useColumnWidth(me?.user.id ?? "");
  const editable = snapshot !== null && snapshot.readOnlyReason === null;
  const insertImage = useStableCallback(() =>
    setNotice("Images cannot be added to project files here. Ask the agent to add one."),
  );
  const insertVideo = useStableCallback(() =>
    setNotice("Videos cannot be uploaded to project files. A YouTube or Loom link works."),
  );
  const title = docTitleFromPath(props.path);
  const importAvailable = useLocalImportAvailable();
  const saveBeforeImport = useStableCallback(async () => {
    await saver.current?.flush();
  });

  // Comments on the file live on the T3 server; the host answers for them.
  const commentsAvailable = useLocalCommentsAvailable();
  const commentSource = useMemo(() => localCommentSource(hostClient, props.path), [props.path]);
  const comments = useCommentSource(commentSource);
  const loadComments = useStableCallback(
    () =>
      void comments.load().catch((cause: unknown) => {
        if (cause instanceof LocalRequestError) setNotice(`Comments: ${cause.message}`);
      }),
  );
  useEffect(() => {
    if (!commentsAvailable) return;
    loadComments();
    return commentSource.subscribe(loadComments);
  }, [commentsAvailable, commentSource, loadComments]);
  const canComment = commentsAvailable && !!comments.capabilities?.comment;
  const canSendToAgent = canComment && !!comments.capabilities?.sendToAgent;
  const canAddToChat = useSyncExternalStore(subscribeAddToChat, hasAddToChatHandler) && canComment;

  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DocAnchor | null>(null);
  const [docBody, setDocBody] = useState<HTMLDivElement | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(true);
  const narrow = useMediaQuery("(max-width: 1279px)");
  const threads = useMemo(() => groupThreads(comments.comments.values()), [comments.comments]);
  const openThreads = useMemo(
    () => threads.filter((thread) => thread.root.resolvedAt === null),
    [threads],
  );
  const resolvedThreads = threads.filter((thread) => thread.root.resolvedAt !== null);
  const anchors = useMemo(
    () => [
      ...openThreads.map(({ root }) => ({
        id: root.id,
        quote: root.quote,
        prefix: root.prefix,
        suffix: root.suffix,
      })),
      ...(draft ? [{ id: DRAFT_COMMENT_ID, ...draft }] : []),
    ],
    [openThreads, draft],
  );

  const startComment = () => {
    const anchor = canComment && editor ? selectionAnchor(editor) : null;
    if (!anchor) return;
    setCommentsOpen(true);
    setDraft(anchor);
    setActiveCommentId(DRAFT_COMMENT_ID);
  };

  const tops = useEditorComments(editor, {
    anchors,
    activeId: activeCommentId,
    container: docBody,
    onClick: setActiveCommentId,
    onShortcut: startComment,
    // A project file's comments anchor to quotes only, as T3 Code stores them.
    onCellComment: noop,
  });

  const commentFailed = (cause: unknown) => {
    setNotice(
      cause instanceof LocalRequestError
        ? `Could not update the comment: ${cause.message}`
        : "Could not update the comment. Try again.",
    );
    throw cause;
  };

  const addToChat = (root: Comment) =>
    void hostClient
      .request({ kind: "comment.chat", path: props.path, commentId: root.id })
      .then(
        () => setNotice("Added to the chat. Send your message there when you are ready."),
        commentFailed,
      )
      .catch(noop);

  const handlersFor = (thread: CommentThread) =>
    canComment
      ? {
          offerSendToAgent: canSendToAgent,
          onReply: (body: string, sendToAgent: boolean) =>
            comments.actions.reply(thread.root.id, body, sendToAgent).catch(commentFailed),
          onResolve: () => {
            setActiveCommentId(null);
            quietly(comments.actions.setResolved(thread.root.id, true).catch(commentFailed));
          },
          onDelete: (commentId: string) =>
            quietly(comments.actions.delete(commentId).catch(commentFailed)),
          ...(canAddToChat ? { onAddToChat: () => addToChat(thread.root) } : {}),
        }
      : {};

  return (
    <div className={`doc-page column-${width}`}>
      <div className="doc-chrome">
        <header className="doc-header">
          <div className="doc-header-title">
            <HomeLink />
            <span className="doc-header-crumb" aria-hidden="true">
              /
            </span>
            <span className="doc-title-text local-doc-title">{title}</span>
            <span className="local-doc-path">{props.path}</span>
          </div>
          <div className="doc-header-actions">
            <span className="local-doc-status" aria-live="polite">
              {saving ? "Saving…" : null}
            </span>
            {importAvailable ? (
              <LocalImportActions
                path={props.path}
                beforeImport={saveBeforeImport}
                onNotice={setNotice}
              />
            ) : null}
            {commentsAvailable ? (
              <button
                type="button"
                className="comments-toggle"
                aria-pressed={commentsOpen}
                aria-label={
                  openThreads.length > 0 ? `Comments, ${openThreads.length} open` : "Comments"
                }
                onClick={() => setCommentsOpen((open) => !open)}
              >
                <CommentIcon />
                {openThreads.length > 0 ? (
                  <span className="comments-dot" aria-hidden="true" />
                ) : null}
              </button>
            ) : null}
          </div>
        </header>
        <div className="doc-toolbar">
          {/* No tabs: a project file is one page. */}
          <DocToolbar
            tabs={NO_TABS}
            activeTabId={null}
            editable={editable}
            editor={editor}
            width={width}
            onToggleWidth={toggleWidth}
            onInsertImage={insertImage}
            onInsertVideo={insertVideo}
            onSelect={noop}
            onCreate={noop}
            onRename={noop}
            onMove={noop}
            onDelete={noop}
          />
          {canComment ? (
            <div className="doc-toolbar-aside">
              <ResolvedComments
                threads={resolvedThreads}
                onReopen={(commentId) =>
                  quietly(comments.actions.setResolved(commentId, false).catch(commentFailed))
                }
                onDelete={(commentId) =>
                  quietly(comments.actions.delete(commentId).catch(commentFailed))
                }
              />
            </div>
          ) : null}
        </div>
      </div>
      <div className="doc-layout">
        <main className="doc-main">
          {notice ? (
            <div className="notice" role="status">
              {notice}
              <button type="button" className="link-button" onClick={() => setNotice(null)}>
                Dismiss
              </button>
            </div>
          ) : null}
          {snapshot?.readOnlyReason ? (
            <div className="notice" role="note">
              {snapshot.readOnlyReason}
            </div>
          ) : null}
          {loadError && snapshot === null ? (
            <div className="notice" role="alert">
              <p>This file can&apos;t be opened: {loadError}</p>
              <button type="button" className="link-button" onClick={() => navigate("/")}>
                All docs
              </button>
            </div>
          ) : null}
          {snapshot ? (
            <div
              className={
                commentsAvailable && commentsOpen ? "doc-body" : "doc-body comments-hidden"
              }
              ref={setDocBody}
            >
              <div className="doc-column">
                <div className="doc-head">
                  <h1 className="doc-head-title">{title}</h1>
                </div>
                {editor && canComment && draft === null ? (
                  <SelectionToolbar editor={editor} canEdit={editable} onComment={startComment} />
                ) : null}
                <TabEditor
                  markdown={snapshot.markdown}
                  revision={revision}
                  editable={editable}
                  uploadImage={refuseImage}
                  onUploadError={insertImage}
                  onVideoFile={insertVideo}
                  onChange={(markdown) => {
                    setSaving(true);
                    saver.current?.schedule(markdown);
                  }}
                  onEditor={setEditor}
                />
              </div>
              {commentsAvailable && commentsOpen ? (
                <CommentMargin
                  threads={openThreads}
                  tops={tops}
                  activeId={activeCommentId}
                  narrow={narrow}
                  selectionTop={null}
                  draftOpen={draft !== null}
                  offerAddToChat={canAddToChat}
                  offerSendToAgent={canSendToAgent}
                  onStartComment={noop}
                  onSubmitDraft={async (body, toChat, toAgent) => {
                    if (!draft) return;
                    const comment = await comments.actions
                      .create(props.path, draft, body, null, toAgent)
                      .catch(commentFailed);
                    setDraft(null);
                    setActiveCommentId(comment.id);
                    if (toChat) addToChat(comment);
                  }}
                  onCancelDraft={() => {
                    setDraft(null);
                    setActiveCommentId(null);
                  }}
                  onActivate={setActiveCommentId}
                  handlersFor={handlersFor}
                />
              ) : null}
            </div>
          ) : null}
        </main>
        <aside className="doc-rail doc-rail-right">
          <OutlineRail editor={editor} />
        </aside>
      </div>
    </div>
  );
}
