import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";

import { PAGE_SANDBOX, type PageView } from "../../shared/htmlPages.ts";
import { ApiError } from "../api.ts";
import { HomeLink } from "../home/HomeLink.tsx";
import { TitleDialog } from "../home/TitleDialog.tsx";
import { useLockedProject } from "../lockedProject.ts";
import { navigate } from "../router.ts";
import { ShareButton } from "../share/ShareButton.tsx";
import { formatBytes, PAGES_PATH, pagesApi, uploadErrorText } from "./pagesApi.ts";
import "../home/home.css";
import "./pages.css";

const follow = (path: string) => (event: MouseEvent) => {
  if (event.metaKey || event.ctrlKey) return;
  event.preventDefault();
  navigate(path);
};

const versionLabel = (page: PageView, version: number) => {
  const entry = page.versions.find((candidate) => candidate.version === version);
  const when = entry ? new Date(entry.createdAt).toLocaleDateString() : "";
  const current = version === page.version ? " (current)" : "";
  return `v${version}${current}${when ? ` · ${when}` : ""}${entry?.note ? ` · ${entry.note}` : ""}`;
};

/**
 * One page's own view, `/pages/:id`: a thin header and the HTML below it in a
 * sandboxed frame. A `#section` in the address opens that section of the page.
 */
export function PageViewer(props: { readonly pageId: string }) {
  const { pageId } = props;
  const lock = useLockedProject();
  const [page, setPage] = useState<PageView | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // The section the address names, passed to the page when it opens or the address changes.
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const follow = () => setHash(window.location.hash);
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);

  const load = useCallback(async () => {
    try {
      const loaded = await pagesApi.get(pageId);
      setPage(loaded);
      setVersion((shown) => shown ?? loaded.version);
      setFailed(false);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) setMissing(true);
      else setFailed(true);
    }
  }, [pageId]);

  useEffect(() => {
    void load();
  }, [load]);

  const back = (label: string) => (
    <button type="button" className="button secondary" onClick={() => navigate(PAGES_PATH)}>
      {label}
    </button>
  );

  if (missing) {
    return (
      <main className="home">
        <p className="home-empty">This page does not exist, or it is not shared with you.</p>
        {back("Back to Pages")}
      </main>
    );
  }
  if (failed && !page) {
    return (
      <main className="home">
        <p className="error">Could not load this page.</p>
        {back("Back to Pages")}
      </main>
    );
  }
  if (!page || version === null || lock.kind === "loading") return null;
  if (lock.kind === "locked" && (lock.projectId === null || page.projectId !== lock.projectId)) {
    return (
      <main className="home">
        <p className="home-empty">This page is not part of {lock.name}.</p>
        {back(`Back to ${lock.name}`)}
      </main>
    );
  }

  const uploadVersion = async (file: File) => {
    setBusy(true);
    setNotice(null);
    try {
      const updated = await pagesApi.addVersion(pageId, file);
      setPage(updated);
      setVersion(updated.version);
    } catch (cause) {
      setNotice(uploadErrorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${page.title}" and all its versions for everyone?`)) return;
    try {
      await pagesApi.remove(pageId);
      navigate(PAGES_PATH, { replace: true });
    } catch {
      setNotice("Could not delete the page. Try again.");
    }
  };

  const shown = page.versions.find((entry) => entry.version === version);

  return (
    <div className="page-viewer">
      <header className="doc-header page-viewer-header">
        <div className="doc-header-title">
          <HomeLink />
          <span className="doc-header-crumb">/</span>
          <a href={PAGES_PATH} className="home-link page-viewer-crumb" onClick={follow(PAGES_PATH)}>
            Pages
          </a>
          <span className="doc-header-crumb">/</span>
          {page.canEdit ? (
            <button type="button" className="page-viewer-title" title="Rename" onClick={() => setRenaming(true)}>
              {page.title}
            </button>
          ) : (
            <span className="page-viewer-title">{page.title}</span>
          )}
        </div>
        <div className="doc-header-actions">
          <label className="page-viewer-version">
            <select aria-label="Version" value={version} onChange={(event) => setVersion(Number(event.target.value))}>
              {page.versions.map((entry) => (
                <option key={entry.version} value={entry.version}>
                  {versionLabel(page, entry.version)}
                </option>
              ))}
            </select>
          </label>
          {shown ? (
            <a
              className="button secondary small"
              href={pagesApi.downloadUrl(pageId, shown.version)}
              download
              title={`Download v${shown.version} (${formatBytes(shown.bytes)})`}
            >
              Download
            </a>
          ) : null}
          {page.canEdit ? (
            <>
              <button
                type="button"
                className="button secondary small"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              >
                {busy ? "Uploading…" : "Upload new version"}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".html,.htm,text/html"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void uploadVersion(file);
                }}
              />
            </>
          ) : null}
          {page.role === "owner" ? (
            <button type="button" className="button secondary small" onClick={() => void remove()}>
              Delete
            </button>
          ) : null}
          {page.member ? (
            <ShareButton target={{ kind: "page", id: pageId }} role={page.role} title={page.title} onClosed={() => void load()} />
          ) : null}
        </div>
      </header>

      {notice ? (
        <div className="notice page-viewer-notice" role="status">
          {notice}
          <button type="button" className="link-button" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <iframe
        key={version}
        className="page-viewer-frame"
        title={page.title}
        src={`${pagesApi.contentUrl(pageId, version)}${hash}`}
        sandbox={PAGE_SANDBOX}
        referrerPolicy="no-referrer"
      />

      {renaming ? (
        <TitleDialog
          heading="Rename page"
          detail={null}
          initial={page.title}
          submitLabel="Rename"
          onSubmit={async (title) => {
            if (title !== page.title) setPage(await pagesApi.rename(pageId, title));
          }}
          onClose={() => setRenaming(false)}
        />
      ) : null}
    </div>
  );
}
