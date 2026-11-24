import type { Editor } from "@tiptap/core";
import { useCallback, useMemo, useState } from "react";

import type { EmbedSnapshot } from "../../shared/embeds.ts";
import { publicApiBase, type PublicDoc } from "../../shared/publicLinks.ts";
import { OutlineRail } from "../doc/OutlineRail.tsx";
import { useColumnWidth } from "../doc/toolbar/columnWidth.ts";
import { DocToolbar } from "../doc/toolbar/DocToolbar.tsx";
import { TabEditor } from "../editor/TabEditor.tsx";
import { setPublicShare } from "../publicMode.ts";
import { publicGet } from "./publicGet.ts";

const noop = () => undefined;
const refuse = () => Promise.reject(new Error("read_only"));

/**
 * A doc a public link opens: every tab, read-only, with no session, comments,
 * sharing or account controls. PublicLinkPage loads it and re-reads it.
 */
export function PublicDocView(props: { readonly token: string; readonly doc: PublicDoc }) {
  const { token, doc } = props;
  const base = publicApiBase(token);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [width, toggleWidth] = useColumnWidth("public");

  // Before the editor renders: assets and links read it while they mount.
  const diagrams = useMemo(
    () => new Map(doc.diagrams.map((diagram) => [diagram.id, diagram])),
    [doc],
  );
  setPublicShare({ token, docId: doc.docId, diagrams, openTab: setActiveTabId });

  const loadEmbed = useCallback(
    async (url: string): Promise<EmbedSnapshot> =>
      (await publicGet<{ embed: EmbedSnapshot }>(`${base}/embeds?url=${encodeURIComponent(url)}`))
        .embed,
    [base],
  );

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
