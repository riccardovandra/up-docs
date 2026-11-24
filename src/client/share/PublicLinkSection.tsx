import { useEffect, useState } from "react";

import type { PublicLink } from "../../shared/publicLinks.ts";
import { api, ApiError, type ShareTarget } from "../api.ts";
import { copyText } from "../copyText.ts";

const failure = (cause: unknown) =>
  cause instanceof ApiError && cause.body.error === "session_required"
    ? "Public links can be changed only from the browser, signed in."
    : "That did not work. Try again.";

/** What a visitor sees, and what stays private, per kind of item. */
const WORDS: Readonly<Record<ShareTarget["kind"], { readonly noun: string; readonly sees: string }>> =
  {
    doc: {
      noun: "doc",
      sees: "can read every tab of this doc, without signing in. Comments and people stay private.",
    },
    diagram: {
      noun: "diagram",
      sees: "can view every page of this diagram as a picture, without signing in. Its source, comments and people stay private.",
    },
    page: {
      noun: "page",
      sees: "can open the latest version of this page, without signing in. Earlier versions and people stay private.",
    },
  };

/**
 * "Anyone with the link" for an item's owner, the same for every kind: turn a
 * read-only public link on or off, copy it, or replace it so the old one
 * stops working.
 */
export function PublicLinkSection(props: { readonly target: ShareTarget }) {
  const { kind, id } = props.target;
  const words = WORDS[kind];
  const [link, setLink] = useState<PublicLink | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    api.publicLink({ kind, id }).then(
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
  }, [kind, id]);

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
          <span className="muted">Off. Only people with access can open this {words.noun}.</span>
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => void run(() => api.createPublicLink({ kind, id }))}
          >
            Create public link
          </button>
        </div>
      ) : (
        <>
          <p className="share-public-warning">
            Anyone with this link {words.sees}
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
              onClick={() => void run(() => api.createPublicLink({ kind, id }))}
            >
              Reset link
            </button>
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              onClick={() => void run(() => api.removePublicLink({ kind, id }))}
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
