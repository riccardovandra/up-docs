import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";

import { PAGE_SANDBOX } from "../../shared/htmlPages.ts";
import {
  publicApiBase,
  publicPageContentPath,
  type PublicDiagram,
  type PublicItem,
  type PublicPage,
} from "../../shared/publicLinks.ts";
import { DiagramPicture } from "../diagrams/DiagramPicture.tsx";
import { PageTabs, usePreloadedPages, useUrlPage } from "../diagrams/PageTabs.tsx";
import { ZoomViewport } from "../diagrams/ZoomViewport.tsx";
import "../diagrams/diagrams.css";
import "../htmlPages/pages.css";
import { setPublicShare } from "../publicMode.ts";
import { PublicDocView } from "./PublicDocView.tsx";
import { publicGet } from "./publicGet.ts";

// The formula engine loads only for a sheet.
const PublicSheetView = lazy(() =>
  import("./PublicSheetView.tsx").then((module) => ({ default: module.PublicSheetView })),
);

/** How often an open public page re-reads its item, besides on focus. */
const REFRESH_MS = 60_000;

const NOUNS: Readonly<Record<PublicItem["kind"], string>> = {
  doc: "document",
  diagram: "diagram",
  page: "page",
  sheet: "sheet",
};

/**
 * The page a public link opens (`/p/<token>`): one item, read-only, with no
 * session, comments, sharing or account controls, whatever kind it is. It
 * re-reads the item on focus and every minute instead of holding a live
 * connection.
 */
export function PublicLinkPage(props: { readonly token: string }) {
  const { token } = props;
  const base = publicApiBase(token);
  const [item, setItem] = useState<PublicItem | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(() => {
    publicGet<PublicItem>(base).then(
      (next) => {
        // The same answer keeps the same object, so nothing below re-renders.
        setItem((current) =>
          current && JSON.stringify(current) === JSON.stringify(next) ? current : next,
        );
        setMissing(false);
      },
      () => {
        setItem(null);
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

  useEffect(() => {
    document.title = item ? item.title : "UP Docs";
  }, [item]);

  if (missing) {
    return (
      <div className="public-doc-missing">
        <h1>This link does not work</h1>
        <p>It is no longer shared, or the link is incomplete.</p>
      </div>
    );
  }
  if (!item) return null;
  if (item.kind === "doc") return <PublicDocView token={token} doc={item} />;
  if (item.kind === "diagram") return <PublicDiagramView token={token} item={item} />;
  if (item.kind === "sheet") {
    return (
      <Suspense fallback={null}>
        <PublicSheetView item={item} />
      </Suspense>
    );
  }
  return <PublicPageView token={token} item={item} />;
}

/** The header every public view shares: the title and a read-only badge. */
export function PublicHeader(props: { readonly title: string; readonly kind: PublicItem["kind"] }) {
  return (
    <header className="doc-header">
      <div className="doc-header-title">
        <span className="doc-title-text">{props.title}</span>
      </div>
      <div className="doc-header-actions">
        <span className="public-doc-badge" title={`This ${NOUNS[props.kind]} is shared by link`}>
          Read-only, shared by link
        </span>
      </div>
    </header>
  );
}

/** A diagram a public link opens: its pictures, one page at a time, with zoom and pan. */
function PublicDiagramView(props: { readonly token: string; readonly item: PublicDiagram }) {
  const { token, item } = props;
  const { diagram } = item;
  // Before the picture renders: it reads which diagrams the link may show while it mounts.
  const diagrams = useMemo(() => new Map([[diagram.id, diagram]]), [diagram]);
  setPublicShare({ token, docId: null, diagrams, openTab: () => undefined });
  const known = useMemo(() => ({ ...diagram, canEdit: false }), [diagram]);
  const pageNames = diagram.picturePages ?? [null];
  const [shownPage, showPage] = useUrlPage(pageNames);
  usePreloadedPages(diagram, pageNames, shownPage);
  const openCounts = useMemo(() => pageNames.map(() => 0), [pageNames]);

  return (
    <div className="diagram-page public-diagram">
      <PublicHeader title={item.title} kind="diagram" />
      <div className="diagram-viewer">
        <div className="diagram-stage">
          <ZoomViewport
            className="diagram-canvas"
            wheel="zoomed"
            fitWidth
            startWide
            keys
            resetKey={`${diagram.id}:${shownPage}`}
          >
            <DiagramPicture
              diagramId={diagram.id}
              diagram={known}
              page={pageNames[shownPage] ?? null}
            />
          </ZoomViewport>
        </div>
      </div>
      <PageTabs
        names={pageNames}
        active={shownPage}
        onSelect={showPage}
        openCounts={openCounts}
        keys
      />
    </div>
  );
}

/** A page a public link opens: its latest version's HTML, in the same sandbox as for members. */
function PublicPageView(props: { readonly token: string; readonly item: PublicPage }) {
  const { token, item } = props;
  return (
    <div className="page-viewer public-page">
      <PublicHeader title={item.title} kind="page" />
      <iframe
        key={item.version}
        className="page-viewer-frame"
        title={item.title}
        src={`${publicPageContentPath(token)}?v=${item.version}${window.location.hash}`}
        sandbox={PAGE_SANDBOX}
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
