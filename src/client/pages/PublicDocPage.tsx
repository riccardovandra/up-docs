import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { EmbedSnapshot } from "../../shared/embeds.ts";
import { publicApiBase, type PublicDoc } from "../../shared/publicLinks.ts";
import { OutlineRail } from "../doc/OutlineRail.tsx";
import { useColumnWidth } from "../doc/toolbar/columnWidth.ts";
import { DocToolbar } from "../doc/toolbar/DocToolbar.tsx";
import { TabEditor } from "../editor/TabEditor.tsx";
import { setPublicShare } from "../publicMode.ts";

/** How often an open public page re-reads the doc, besides on focus. */
const REFRESH_MS = 60_000;

const noop = () => undefined;
const refuse = () => Promise.reject(new Error("read_only"));

/** One read of the link's API. No cookies go with it: the token is the only credential. */
async function publicGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error(String(response.status));
  return (await response.json()) as T;
}

/**
 * The page a public link opens: one doc, every tab, read-only, with no
 * session, comments, sharing or account controls. It re-reads the doc on
 * focus and every minute instead of holding a live connection.
 */
export function PublicDocPage(props: { readonly token: string }) {
  const { token } = props;
  const base = publicApiBase(token);
  const [doc, setDoc] = useState<PublicDoc | null>(null);
  const [missing, setMissing] = useState(false);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [width, toggleWidth] = useColumnWidth("public");

  const load = useCallback(() => {
    publicGet<PublicDoc>(base).then(
      (next) => {
        setDoc((current) => (current && current.updatedAt === next.updatedAt &&
          sameTabs(current, next) ? current : next));
        setMissing(false);
      },
      () => {
        setDoc(null);
        setMissing(true);
      },
    );
  }, [base]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    window.addEventListener("focus", load);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [load]);

  // Before the editor renders: assets and links read it while they mount.
  const diagrams = useMemo(
    () => new Map((doc?.diagrams ?? []).map((diagram) => [diagram.id, diagram])),
    [doc],
  );
  const docId = doc?.docId ?? null;
  if (docId) setPublicShare({ token, docId, diagrams, openTab: setActiveTabId });

  useEffect(() => {
    document.title = doc ? doc.title : "UP Docs";
  }, [doc]);

  const loadEmbed = useCallback(
    async (url: string): Promise<EmbedSnapshot> =>
      (await publicGet<{ embed: EmbedSnapshot }>(`${base}/embeds?url=${encodeURIComponent(url)}`))
        .embed,
    [base],
  );

  if (missing) {
    return (
      <div className="public-doc-missing">
        <h1>This link does not work</h1>
        <p>The document is no longer shared, or the link is incomplete.</p>
      </div>
    );
  }
  if (!doc) return null;

  const tabs = [...doc.tabs].sort((a, b) => a.position - b.position);
  const activeTab =
    tabs.find((tab) => tab.id === activeTabId) ??
    tabs.find((tab) => tab.parentTabId === null) ??
    tabs[0];

  return (
    <div className={`doc-page public-doc column-${width}`}>
      <div className="doc-chrome">
        <header className="doc-header">
          <div className="doc-header-title">
            <span className="doc-title-text">{doc.title}</span>
          </div>
          <div className="doc-header-actions">
            <span className="public-doc-badge">Read-only, shared by link</span>
          </div>
        </header>
        <div className="doc-toolbar">
          <DocToolbar
            tabs={tabs.length > 1 ? tabs : []}
            activeTabId={activeTab?.id ?? null}
            editable={false}
            editor={editor}
            width={width}
            onToggleWidth={toggleWidth}
            onInsertImage={noop}
            onInsertVideo={noop}
            onSelect={setActiveTabId}
            onCreate={noop}
            onRename={noop}
            onMove={noop}
            onDelete={noop}
          />
        </div>
      </div>
      <div className="doc-layout">
        <main className="doc-main">
          {activeTab ? (
            <div className="doc-body comments-hidden">
              <div className="doc-column">
                <div className="doc-head">
                  <h1 className="doc-head-title">{doc.title}</h1>
                </div>
                <TabEditor
                  key={activeTab.id}
                  markdown={activeTab.markdown}
                  revision={activeTab.version}
                  editable={false}
                  uploadImage={refuse}
                  onUploadError={noop}
                  onVideoFile={noop}
                  loadEmbed={loadEmbed}
                  onChange={noop}
                  onEditor={setEditor}
                />
              </div>
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

const sameTabs = (a: PublicDoc, b: PublicDoc) =>
  a.tabs.length === b.tabs.length &&
  a.tabs.every((tab, index) => {
    const other = b.tabs[index];
    return other?.id === tab.id && other.version === tab.version && other.title === tab.title;
  }) &&
  a.diagrams.length === b.diagrams.length &&
  a.diagrams.every(
    (diagram, index) => b.diagrams[index]?.pictureVersion === diagram.pictureVersion,
  );
