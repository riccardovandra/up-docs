import { useEffect, useState } from "react";

import type { PublicLink } from "../../shared/publicLinks.ts";
import { api, ApiError } from "../api.ts";
import { copyText } from "../copyText.ts";

const failure = (cause: unknown) =>
  cause instanceof ApiError && cause.body.error === "session_required"
    ? "Public links can be changed only from the browser, signed in."
    : "That did not work. Try again.";

/**
 * "Anyone with the link" for a doc's owner: turn a read-only public link on
 * or off, copy it, or replace it so the old one stops working.
 */
export function PublicLinkSection(props: { readonly docId: string }) {
  const { docId } = props;
  const [link, setLink] = useState<PublicLink | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    api.publicLink(docId).then(
      (result) => live && setLink(result.link),
      (cause: unknown) => {
        if (!live) return;
        setLink(null);
        setError(failure(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [docId]);

  const run = async (call: () => Promise<{ link: PublicLink | null }>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setLink((await call()).link);
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (link) setCopied(await copyText(link.url));
  };

  return (
    <section className="share-public">
      <h3 className="share-section-label">Anyone with the link</h3>
      {link === undefined ? (
        <p className="muted share-status">Loading…</p>
      ) : link === null ? (
        <div className="share-public-row">
          <span className="muted">Off. Only people with access can open this doc.</span>
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => void run(() => api.createPublicLink(docId))}
          >
            Create public link
          </button>
        </div>
      ) : (
        <>
          <p className="share-public-warning">
            Anyone with this link can read every tab of this doc, without signing in. Comments and
            people stay private.
          </p>
          <p className="share-email-link share-public-url">{link.url}</p>
          <div className="share-public-actions">
            <button type="button" className="button small" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy public link"}
            </button>
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              title="Make a new link. The current one stops working."
              onClick={() => void run(() => api.createPublicLink(docId))}
            >
              Reset link
            </button>
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              onClick={() => void run(() => api.removePublicLink(docId))}
            >
              Turn off
            </button>
          </div>
        </>
      )}
      {error ? (
        <p className="share-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
