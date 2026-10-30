import type { Editor } from "@tiptap/core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { DocRole, UserSummary } from "../../shared/access.ts";
import type { DocAnchor, StructuredAnchor } from "../../shared/anchors.ts";
import {
  type Comment,
  type DocStatus,
  type DocSummary,
  type DocThreadLink,
  type RoomMessage,
  type Tab,
} from "../../shared/protocol.ts";
import { groupThreads, type CommentThread } from "../../shared/threads.ts";
import { api, ApiError, clientId } from "../api.ts";
import { CommentMargin, DRAFT_COMMENT_ID } from "../comments/CommentMargin.tsx";
import { ResolvedComments } from "../comments/ResolvedComments.tsx";
import {
  addCommentToChat,
  hasAddToChatHandler,
  subscribeAddToChat,
} from "../comments/addToChat.ts";
import { isCommentMessage, useComments } from "../comments/useComments.ts";
import { selectionAnchor, useEditorComments } from "../comments/useEditorComments.ts";
import { useMediaQuery } from "../comments/useMediaQuery.ts";
import { DocThreads, threadKey } from "../doc/DocThreads.tsx";
import { exportActions } from "../doc/ExportMenu.tsx";
import { DocHead } from "../doc/header/DocHead.tsx";
import { DocHeader } from "../doc/header/DocHeader.tsx";
import { docAbilities } from "../doc/header/docAbilities.ts";
import { OutlineRail } from "../doc/OutlineRail.tsx";
import { useColumnWidth } from "../doc/toolbar/columnWidth.ts";
import { DocToolbar } from "../doc/toolbar/DocToolbar.tsx";
import { imageAttributes } from "../editor/image.ts";
import { useStableCallback } from "../doc/useStableCallback.ts";
import { TabSaver } from "../doc/tabSaver.ts";
import { applyPlacements, orderTabs, removeTabs } from "../doc/tabTree.ts";
import { useDocRoom } from "../doc/useDocRoom.ts";
import { SelectionToolbar } from "../editor/SelectionToolbar.tsx";
import { TabEditor } from "../editor/TabEditor.tsx";
import { WIDGET_PICK_EVENT, type WidgetPickDetail } from "../editor/widget/WidgetView.ts";
import { postToEmbedParent, subscribeParentMessages, useEmbedFeatures } from "../embedBridge.ts";
import { leaveDoc, setDocTabTitle } from "../openTabs.ts";
import { docPath, navigate } from "../router.ts";
import { useMe } from "../me.ts";
import { canonicalDocUrl } from "../share/ShareDialog.tsx";

export function DocPage(props: { readonly docId: string; readonly tabId: string | null }) {
  const [doc, setDoc] = useState<DocSummary | null>(null);
  const [role, setRole] = useState<DocRole>("viewer");
  const [owner, setOwner] = useState<UserSummary | null>(null);
  const [threadLinks, setThreadLinks] = useState<ReadonlyArray<DocThreadLink>>([]);
  const [tabs, setTabs] = useState<ReadonlyMap<string, Tab>>(new Map());
  const [notice, setNotice] = useState<string | null>(null);
  // A tab someone else, such as an agent, added while this doc was open.
  const [newTabId, setNewTabId] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const saver = useRef<TabSaver | null>(null);
  // Bumped when the active tab's content changes underneath the editor.
  const [revision, setRevision] = useState(0);

  const upsertTab = useCallback((tab: Tab) => {
    setTabs((current) => {
      const existing = current.get(tab.id);
      if (existing && existing.version > tab.version) return current;
      return new Map(current).set(tab.id, tab);
    });
  }, []);

  const comments = useComments(props.docId);
  const loadComments = comments.load;
  const load = useCallback(async () => {
    const [loaded, linked] = await Promise.all([
      api.doc(props.docId),
      api.docThreads(props.docId),
      loadComments(),
    ]);
    setDoc(loaded.doc);
    setRole(loaded.role);
    setOwner(loaded.owner);
    setThreadLinks(linked.threads);
    setTabs(new Map(loaded.tabs.map((tab) => [tab.id, tab])));
  }, [props.docId, loadComments]);

  useEffect(() => {
    void load().catch((cause: unknown) => {
      if (!(cause instanceof ApiError && cause.status === 404)) throw cause;
      leaveDoc(props.docId);
    });
  }, [load, props.docId]);

  const tabList = [...tabs.values()];
  const activeTab =
    (props.tabId ? tabs.get(props.tabId) : undefined) ?? orderTabs(tabList)[0]?.tab ?? null;
  const activeTabId = activeTab?.id ?? null;
  // Visiting the tab by any route counts as seeing it, so the notice never returns.
  if (newTabId !== null && newTabId === activeTabId) setNewTabId(null);
  const newTab = newTabId && newTabId !== activeTabId ? tabs.get(newTabId) : undefined;

  // The URL follows the active tab, including after it is deleted elsewhere.
  useEffect(() => {
    if (activeTabId && props.tabId !== activeTabId) {
      navigate(docPath(props.docId, activeTabId), { replace: true });
    }
  }, [activeTabId, props.docId, props.tabId]);

  const tabsRef = useRef(tabs);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
  });

  // One saver per active tab; leaving a tab flushes its pending edit.
  useEffect(() => {
    const current = activeTabId ? tabsRef.current.get(activeTabId) : undefined;
    if (!current) return;
    const tabSaver = new TabSaver(current.id, current.version, {
      onSaved: upsertTab,
      onConflict: (tab) => {
        upsertTab(tab);
        setRevision((value) => value + 1);
        setNotice(
          "This tab was changed elsewhere, so it was reloaded. Your last edit was not saved.",
        );
      },
      onInvalidBlock: (kind) =>
        setNotice(`A ${kind} in this tab has errors, so it is not saved until they are fixed.`),
    });
    saver.current = tabSaver;
    return () => {
      void tabSaver.flush();
      if (saver.current === tabSaver) saver.current = null;
    };
  }, [activeTabId, upsertTab]);

  useEffect(() => {
    const flush = () => void saver.current?.flush();
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  useDocRoom(props.docId, {
    onMessage: (message: RoomMessage) => {
      if (isCommentMessage(message)) {
        comments.apply(message);
        return;
      }
      if (message.type === "doc.updated") {
        setDoc(message.doc);
        return;
      }
      if (message.type === "doc.deleted") {
        leaveDoc(props.docId);
        return;
      }
      if (message.type === "doc.threads") {
        setThreadLinks(message.threads);
        return;
      }
      if (message.type === "tab.created") {
        upsertTab(message.tab);
        if (message.origin !== clientId) setNewTabId(message.tab.id);
        return;
      }
      // Moves and deletes are idempotent, so our own echoes are applied too.
      if (message.type === "tab.moved") {
        setTabs((current) => applyPlacements(current, message.placements));
        return;
      }
      if (message.type === "tab.deleted") {
        setTabs((current) =>
          applyPlacements(removeTabs(current, message.tabIds), message.placements),
        );
        return;
      }
      const tab = message.tab;
      if (message.origin === clientId) return;
      const tabSaver = saver.current;
      if (tab.id === activeTabId && tabSaver) {
        // With an unsaved local edit, the next save conflicts and reloads instead.
        if (tabSaver.dirty) return;
        tabSaver.acceptRemote(tab);
        setRevision((value) => value + 1);
      }
      upsertTab(tab);
    },
    onReconnect: () => void load(),
  });

  const report = (action: string) => (cause: unknown) => {
    const code = cause instanceof ApiError ? cause.body.error : undefined;
    setNotice(
      code === "last_tab"
        ? "A doc needs at least one top-level tab."
        : `Could not ${action} the tab. Reload and try again.`,
    );
  };

  const createTab = async (parentTabId: string | null) => {
    const { tab } = await api.createTab(props.docId, { title: "Untitled tab", parentTabId });
    upsertTab(tab);
    navigate(docPath(props.docId, tab.id));
  };

  const renameTab = async (tabId: string, title: string) => {
    const tabSaver = tabId === activeTabId ? saver.current : null;
    // Land pending edits first so the title write does not race the body save.
    await tabSaver?.flush();
    const write = (baseVersion: number) => api.writeTab(tabId, { baseVersion, title });
    let saved: Tab;
    try {
      saved = (await write(tabsRef.current.get(tabId)?.version ?? 1)).tab;
    } catch (cause) {
      // A title-only write is safe to reapply on top of a newer version.
      if (!(cause instanceof ApiError && cause.status === 409 && cause.body.tab)) throw cause;
      saved = (await write(cause.body.tab.version)).tab;
    }
    tabSaver?.acceptRemote(saved);
    upsertTab(saved);
  };

  const moveTab = async (tabId: string, parentTabId: string | null, position: number) => {
    const { placements } = await api.moveTab(tabId, { parentTabId, position });
    setTabs((current) => applyPlacements(current, placements));
  };

  const deleteTab = async (tabId: string) => {
    const { tabIds } = await api.deleteTab(tabId);
    setTabs((current) => removeTabs(current, tabIds));
  };

  const embedFeatures = useEmbedFeatures();
  const abilities = useMemo(
    () => docAbilities(role, { startWorkAvailable: !!embedFeatures?.includes("start-work") }),
    [role, embedFeatures],
  );

  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    tabId: string;
    anchor: DocAnchor;
    structured: StructuredAnchor | null;
  } | null>(null);
  const [docBody, setDocBody] = useState<HTMLDivElement | null>(null);
  const narrow = useMediaQuery("(max-width: 1279px)");
  const canAddToChat = useSyncExternalStore(subscribeAddToChat, hasAddToChatHandler);

  const threads = useMemo(() => groupThreads(comments.comments.values()), [comments.comments]);
  const openThreads = useMemo(
    () =>
      threads.filter(
        (thread) => thread.root.tabId === activeTabId && thread.root.resolvedAt === null,
      ),
    [threads, activeTabId],
  );
  const resolvedThreads = threads.filter(
    (thread) => thread.root.resolvedAt !== null && tabs.has(thread.root.tabId),
  );
  const draftAnchor = draft && draft.tabId === activeTabId ? draft : null;
  const anchors = useMemo(
    () => [
      ...openThreads.map(({ root }) => ({
        id: root.id,
        quote: root.quote,
        prefix: root.prefix,
        suffix: root.suffix,
        structured: root.anchor,
      })),
      ...(draftAnchor
        ? [{ id: DRAFT_COMMENT_ID, ...draftAnchor.anchor, structured: draftAnchor.structured }]
        : []),
    ],
    [openThreads, draftAnchor],
  );

  const startComment = () => {
    if (!abilities.comment) return;
    const anchor = editor ? selectionAnchor(editor) : null;
    if (!anchor || !activeTabId) return;
    setCommentsOpen(true);
    setDraft({ tabId: activeTabId, anchor, structured: null });
    setActiveCommentId(DRAFT_COMMENT_ID);
  };

  const startCellComment = (structured: StructuredAnchor, text: string) => {
    if (!abilities.comment || !activeTabId) return;
    setCommentsOpen(true);
    setDraft({ tabId: activeTabId, anchor: { quote: text, prefix: "", suffix: "" }, structured });
    setActiveCommentId(DRAFT_COMMENT_ID);
  };

  // A diagram label just clicked: its thread opens, or "Comment" is offered beside the diagram.
  const [labelPick, setLabelPick] = useState<{
    anchor: StructuredAnchor;
    top: number;
  } | null>(null);
  const openThreadsRef = useRef(openThreads);
  useLayoutEffect(() => {
    openThreadsRef.current = openThreads;
  });
  useEffect(() => {
    if (!docBody) return;
    const onPick = (event: Event) => {
      const { diagramId, textId } = (event as CustomEvent<WidgetPickDetail>).detail;
      if (!textId || !(event.target instanceof HTMLElement)) {
        setLabelPick(null);
        return;
      }
      const thread = openThreadsRef.current.find(
        ({ root }) =>
          root.anchor?.kind === "label" &&
          root.anchor.blockId === diagramId &&
          root.anchor.textId === textId,
      );
      if (thread) setActiveCommentId(thread.root.id);
      const top = event.target.getBoundingClientRect().top - docBody.getBoundingClientRect().top;
      setLabelPick({
        anchor: { kind: "label", blockId: diagramId, textId },
        top: Math.round(top),
      });
    };
    docBody.addEventListener(WIDGET_PICK_EVENT, onPick);
    return () => docBody.removeEventListener(WIDGET_PICK_EVENT, onPick);
  }, [docBody]);

  const startLabelComment = (structured: StructuredAnchor) => {
    if (!abilities.comment || !activeTabId) return;
    setLabelPick(null);
    setCommentsOpen(true);
    // The Worker fills the quote with the label's current words.
    setDraft({ tabId: activeTabId, anchor: { quote: "", prefix: "", suffix: "" }, structured });
    setActiveCommentId(DRAFT_COMMENT_ID);
  };

  const tops = useEditorComments(editor, {
    anchors,
    activeId: activeCommentId,
    container: docBody,
    onClick: (id) => {
      setLabelPick(null);
      setActiveCommentId(id);
    },
    onShortcut: startComment,
    onCellComment: startCellComment,
  });

  const commentFailed = (cause: unknown) => {
    setNotice("Could not update the comment. Reload and try again.");
    throw cause;
  };
  const quietly = (promise: Promise<unknown>) => void promise.catch(() => undefined);

  const addToChat = (root: Comment) => {
    addCommentToChat({
      docId: props.docId,
      tabId: root.tabId,
      docTitle: doc?.title ?? "",
      url: `${window.location.origin}${docPath(props.docId, root.tabId)}`,
      commentId: root.id,
      quote: root.quote,
      body: root.body,
      anchor: root.anchor,
    });
    setNotice("Added to the chat. Send your message there when you are ready.");
  };

  const handlersFor = (thread: CommentThread) => ({
    ...(abilities.comment ? commentHandlers(thread) : {}),
    ...(canAddToChat && abilities.comment ? { onAddToChat: () => addToChat(thread.root) } : {}),
  });

  const commentHandlers = (thread: CommentThread) => ({
    onReply: (body: string) => comments.actions.reply(thread.root.id, body).catch(commentFailed),
    onResolve: () => {
      setActiveCommentId(null);
      quietly(comments.actions.setResolved(thread.root.id, true).catch(commentFailed));
    },
    onDelete: (commentId: string) =>
      quietly(comments.actions.delete(commentId).catch(commentFailed)),
  });

  const embedded = embedFeatures !== null;
  // Which linked threads the embedding T3 Code can open, and their live titles.
  const [openable, setOpenable] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(
    () =>
      subscribeParentMessages((message) => {
        if (message.type === "t3-docs:threads") {
          setOpenable(new Map(message.threads.map((thread) => [threadKey(thread), thread.title])));
        }
      }),
    [],
  );
  useEffect(() => {
    if (!embedded || threadLinks.length === 0) return;
    postToEmbedParent({
      type: "t3-docs:resolve-threads",
      threads: threadLinks.map(({ environmentId, threadId }) => ({ environmentId, threadId })),
    });
  }, [embedded, threadLinks]);

  const flush = useStableCallback(async () => saver.current?.flush());

  const setStatus = useStableCallback(
    (status: DocStatus) =>
      void api.setDocStatus(props.docId, status).then(
        (result) => setDoc(result.doc),
        () => setNotice("Could not change the status. Reload and try again."),
      ),
  );

  const renameDoc = useStableCallback(
    (title: string) =>
      void api.renameDoc(props.docId, title).then(
        (result) => setDoc(result.doc),
        () => setNotice("Could not rename the doc. Reload and try again."),
      ),
  );

  const moveDoc = useStableCallback(
    (projectId: string | null) =>
      void api.moveDoc(props.docId, projectId).then(
        (result) => setDoc(result.doc),
        () => setNotice("Could not move the doc. Reload and try again."),
      ),
  );

  const deleteDoc = useStableCallback(() => {
    if (!doc) return;
    if (
      !window.confirm(`Delete "${doc.title}" for everyone? Its tabs, comments and images go too.`)
    )
      return;
    void api.deleteDoc(props.docId).then(
      () => leaveDoc(props.docId),
      () => setNotice("Could not delete the doc. Reload and try again."),
    );
  });

  const copyLink = useStableCallback(
    () =>
      void navigator.clipboard.writeText(canonicalDocUrl(props.docId)).then(
        () => setNotice("Link copied. Only people the doc is shared with can open it."),
        () => setNotice("Could not copy the link."),
      ),
  );

  const startWork = useStableCallback(async () => {
    if (!doc) return;
    await saver.current?.flush();
    postToEmbedParent({
      type: "t3-docs:start-work",
      docId: props.docId,
      tabId: activeTabId,
      title: doc.title,
      url: `${window.location.origin}${docPath(props.docId, activeTabId)}`,
    });
  });

  // Someone may change their own role in the Share panel, or leave the doc.
  const refreshRole = useStableCallback(
    () =>
      void api.doc(props.docId).then(
        (loaded) => {
          setRole(loaded.role);
          setOwner(loaded.owner);
        },
        (cause: unknown) => {
          if (cause instanceof ApiError && cause.status === 404) leaveDoc(props.docId);
        },
      ),
  );

  const showMessage = useStableCallback((message: string | null) => {
    if (message) setNotice(message);
  });

  const tabActions = {
    onSelect: useStableCallback((tabId: string) => navigate(docPath(props.docId, tabId))),
    onCreate: useStableCallback(
      (parentTabId: string | null) => void createTab(parentTabId).catch(report("create")),
    ),
    onRename: useStableCallback(
      (tabId: string, title: string) => void renameTab(tabId, title).catch(report("rename")),
    ),
    onMove: useStableCallback(
      (tabId: string, parentTabId: string | null, position: number) =>
        void moveTab(tabId, parentTabId, position).catch(report("move")),
    ),
    onDelete: useStableCallback((tabId: string) => void deleteTab(tabId).catch(report("delete"))),
  };

  const uploadImage = useStableCallback((file: File) => api.uploadImage(props.docId, file));
  const imageFailed = useStableCallback((cause: unknown) => {
    const code = cause instanceof ApiError ? cause.body.error : undefined;
    setNotice(
      code === "too_large"
        ? "That image is over 10 MB."
        : code === "unsupported_type" || code === "invalid_image"
          ? "Only PNG, JPEG, GIF and WebP images can be added."
          : "Could not upload the image. Try again.",
    );
  });
  const insertImage = useStableCallback((file: File) => {
    const target = editor;
    void uploadImage(file).then((src) => {
      if (target && !target.isDestroyed) {
        target
          .chain()
          .focus()
          .insertContent({ type: "image", attrs: imageAttributes(src, file) })
          .run();
      }
    }, imageFailed);
  });

  const me = useMe();
  const [width, toggleWidth] = useColumnWidth(me?.user.id ?? "");
  const [commentsOpen, setCommentsOpen] = useState(true);
  const toggleComments = useStableCallback(() => setCommentsOpen((open) => !open));
  const openCommentCount = useMemo(
    () =>
      threads.filter((thread) => thread.root.resolvedAt === null && tabs.has(thread.root.tabId))
        .length,
    [threads, tabs],
  );

  // Recomputed with tab structure and titles only, so a body save does not
  // repaint the toolbar.
  const tabShape = tabList
    .map((tab) => `${tab.id}:${tab.parentTabId}:${tab.position}:${tab.title}`)
    .join("\n");
  const toolbarTabs = useMemo(() => tabList, [tabShape]);

  const docTitle = doc?.title ?? "";
  useEffect(() => {
    if (docTitle) setDocTabTitle(props.docId, docTitle);
  }, [props.docId, docTitle]);
  const exports = useMemo(
    () =>
      exportActions({
        docId: props.docId,
        docTitle,
        tabId: activeTabId,
        flush,
        inT3Code: embedded,
      }),
    [props.docId, docTitle, activeTabId, flush, embedded],
  );

  if (!doc) return null;

  return (
    <div className={`doc-page column-${width}`}>
      <div className="doc-chrome">
        <DocHeader
          docId={props.docId}
          title={doc.title}
          status={doc.status}
          projectId={doc.projectId}
          role={role}
          abilities={abilities}
          tabId={activeTabId}
          flush={flush}
          exportActions={exports}
          onRename={renameDoc}
          onSetStatus={setStatus}
          onCopyLink={copyLink}
          onDelete={deleteDoc}
          onMoveToProject={moveDoc}
          onStartChat={startWork}
          onExportResult={showMessage}
          onShareClosed={refreshRole}
          commentsOpen={commentsOpen}
          openCommentCount={openCommentCount}
          onToggleComments={toggleComments}
        />
        <div className="doc-toolbar">
          <DocToolbar
            tabs={toolbarTabs}
            activeTabId={activeTabId}
            editable={abilities.edit}
            editor={editor}
            width={width}
            onToggleWidth={toggleWidth}
            onInsertImage={insertImage}
            {...tabActions}
          />
          <div className="doc-toolbar-aside">
            <DocThreads
              threads={threadLinks}
              openable={openable}
              onOpen={({ environmentId, threadId }) =>
                postToEmbedParent({ type: "t3-docs:open-thread", environmentId, threadId })
              }
              onUnlink={(linkId) =>
                void api.unlinkThread(props.docId, linkId).then(
                  (result) => setThreadLinks(result.threads),
                  () => setNotice("Could not remove the thread. Reload and try again."),
                )
              }
            />
            {abilities.comment ? (
              <ResolvedComments
                threads={resolvedThreads}
                tabs={tabs}
                onReopen={(commentId) =>
                  quietly(comments.actions.setResolved(commentId, false).catch(commentFailed))
                }
                onDelete={(commentId) =>
                  quietly(comments.actions.delete(commentId).catch(commentFailed))
                }
              />
            ) : null}
          </div>
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
          {newTab ? (
            <div className="notice" role="status">
              New tab: {newTab.title}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setNewTabId(null);
                  navigate(docPath(props.docId, newTab.id));
                }}
              >
                Open
              </button>
              <button type="button" className="link-button" onClick={() => setNewTabId(null)}>
                Dismiss
              </button>
            </div>
          ) : null}
          {activeTab ? (
            <div
              className={commentsOpen ? "doc-body" : "doc-body comments-hidden"}
              ref={setDocBody}
            >
              <div className="doc-column">
                <DocHead title={doc.title} createdAt={doc.createdAt} owner={owner} />
                {editor && abilities.comment && draftAnchor === null ? (
                  <SelectionToolbar
                    editor={editor}
                    canEdit={abilities.edit}
                    onComment={startComment}
                  />
                ) : null}
                <TabEditor
                  key={activeTab.id}
                  markdown={activeTab.markdown}
                  revision={revision}
                  editable={abilities.edit}
                  uploadImage={uploadImage}
                  onUploadError={imageFailed}
                  onChange={(markdown) => saver.current?.schedule(markdown)}
                  onEditor={setEditor}
                />
              </div>
              {commentsOpen ? (
                <CommentMargin
                  threads={openThreads}
                  tops={tops}
                  activeId={activeCommentId}
                  narrow={narrow}
                  selectionTop={abilities.comment ? (labelPick?.top ?? null) : null}
                  draftOpen={draftAnchor !== null}
                  offerAddToChat={canAddToChat}
                  onStartComment={() => labelPick && startLabelComment(labelPick.anchor)}
                  onSubmitDraft={async (body, toChat) => {
                    if (!draft) return;
                    const comment = await comments.actions
                      .create(draft.tabId, draft.anchor, body, draft.structured)
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
