import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import type { EmbedParentMessage } from "../../shared/embed.ts";
import { copyMarkdown, download } from "../doc/ExportMenu.tsx";
import { readyWidgetsForPrint } from "../editor/widget/WidgetView.ts";
import {
  hasEmbedParent,
  isNativeEmbed,
  postToEmbedParent,
  subscribeEmbedParent,
  subscribeParentMessages,
  useEmbedFeatures,
} from "../embedBridge.ts";
import { docPath } from "../router.ts";

type Scope = "doc" | "tab";

const exportPath = (scope: Scope, docId: string, tabId: string | null, format: "md" | "docx") =>
  scope === "tab" && tabId
    ? `/api/tabs/${tabId}/export.${format}`
    : `/api/docs/${docId}/export.${format}`;

type Status =
  | { readonly kind: "info"; readonly text: string }
  | { readonly kind: "error"; readonly text: string }
  | { readonly kind: "sent"; readonly text: string; readonly url: string | null };

const Icon = (props: { readonly children: ReactNode }) => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
    {props.children}
  </svg>
);

const DownloadIcon = () => (
  <Icon>
    <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" stroke="currentColor" strokeWidth="1.4" />
  </Icon>
);

const OpenIcon = () => (
  <Icon>
    <path
      d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v4H2.5V4h4"
      stroke="currentColor"
      strokeWidth="1.4"
    />
  </Icon>
);

const CopyIcon = () => (
  <Icon>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
    <path d="M10.5 3.5v-1h-8v8h1" stroke="currentColor" strokeWidth="1.4" />
  </Icon>
);

const PeopleIcon = () => (
  <Icon>
    <circle cx="6" cy="5.5" r="2.25" stroke="currentColor" strokeWidth="1.3" />
    <path d="M2 13c.4-2.2 2-3.5 4-3.5s3.6 1.3 4 3.5" stroke="currentColor" strokeWidth="1.3" />
    <path
      d="M10.5 3.5a2.2 2.2 0 0 1 0 4.2M12 9.8c1 .5 1.8 1.6 2 3.2"
      stroke="currentColor"
      strokeWidth="1.3"
    />
  </Icon>
);

/** A small format badge in the theme's colours; brand marks would need their artwork. */
const Badge = (props: { readonly label: string }) => (
  <span className="share-export-badge" aria-hidden="true">
    {props.label}
  </span>
);

function Row(props: {
  readonly badge: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly action: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly extra?: ReactNode;
}) {
  return (
    <li className="share-export-row">
      <button
        type="button"
        className="share-export-action"
        disabled={props.disabled}
        onClick={props.onClick}
      >
        {props.badge}
        <span className="share-export-text">
          <span className="share-export-name">{props.title}</span>
          <span className="muted">{props.description}</span>
        </span>
        <span className="share-export-icon">{props.action}</span>
      </button>
      {props.extra}
    </li>
  );
}

/** The Share panel's Export segment, after Claude Docs' Export panel. */
export function ShareExportTab(props: {
  readonly docId: string;
  readonly tabId: string | null;
  /** Saves the open tab's pending edit, so exports include it. */
  readonly flush: () => Promise<void>;
  readonly title?: string;
  /** Switches the panel to its Share segment. */
  readonly onInvite?: () => void;
  readonly onCopyLink?: () => void;
  readonly copied?: boolean;
}) {
  const { docId, tabId, flush } = props;
  const inT3Code = useSyncExternalStore(subscribeEmbedParent, hasEmbedParent);
  const canSendTo = useEmbedFeatures()?.includes("send-to") ?? false;
  const [scope, setScope] = useState<Scope>("doc");
  const [status, setStatus] = useState<Status | null>(null);
  const [sending, setSending] = useState(false);
  const pendingRequest = useRef<string | null>(null);

  useEffect(
    () =>
      subscribeParentMessages((message: EmbedParentMessage) => {
        if (message.type !== "t3-docs:sent-to" || message.requestId !== pendingRequest.current) {
          return;
        }
        pendingRequest.current = null;
        setSending(false);
        setStatus(
          message.error === null
            ? { kind: "sent", text: "Sent to Notion.", url: message.url }
            : { kind: "error", text: message.error },
        );
      }),
    [],
  );

  const run = (action: () => Promise<unknown>, done?: string) => {
    setStatus(null);
    action().then(
      () => setStatus(done ? { kind: "info", text: done } : null),
      () => setStatus({ kind: "error", text: "Export failed" }),
    );
  };

  const docUrl = `${window.location.origin}${docPath(docId)}`;
  const title = props.title ?? "Untitled";

  const sendToNotion = () => {
    if (sending) return;
    const requestId = crypto.randomUUID();
    pendingRequest.current = requestId;
    setSending(true);
    setStatus({ kind: "info", text: "Sending to Notion…" });
    // T3 Code reads the doc from UP Docs, so pending edits go first.
    flush().then(
      () =>
        postToEmbedParent({
          type: "t3-docs:send-to",
          requestId,
          target: "notion",
          docId,
          title,
          url: docUrl,
        }),
      () => {
        pendingRequest.current = null;
        setSending(false);
        setStatus({ kind: "error", text: "Could not save the latest edits. Try again." });
      },
    );
  };

  return (
    <div className="share-export">
      <section className="share-export-card">
        <span className="share-export-card-icon">
          <PeopleIcon />
        </span>
        <div>
          <h3 className="share-export-card-title">Sending this to someone?</h3>
          <p className="muted share-export-card-text">
            Share the link instead of a file and they will always have the latest changes.
          </p>
          <div className="share-export-card-actions">
            {props.onCopyLink ? (
              <button type="button" className="button secondary small" onClick={props.onCopyLink}>
                {props.copied ? "Copied" : "Copy link"}
              </button>
            ) : null}
            {props.onInvite ? (
              <button type="button" className="button secondary small" onClick={props.onInvite}>
                Invite people
              </button>
            ) : null}
          </div>
          <p className="muted share-export-card-foot">Only people with access can open this link</p>
        </div>
      </section>

      {tabId ? (
        <div className="share-export-scope" role="radiogroup" aria-label="What to export">
          {(["doc", "tab"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={scope === option}
              onClick={() => setScope(option)}
            >
              {option === "doc" ? "Whole doc" : "This tab"}
            </button>
          ))}
        </div>
      ) : null}

      <ul className="share-export-list">
        <Row
          badge={<Badge label="W" />}
          title="Word"
          description="Editable .docx document"
          action={<DownloadIcon />}
          onClick={() =>
            run(() => flush().then(() => download(exportPath(scope, docId, tabId, "docx"))))
          }
        />
        <Row
          badge={<Badge label="PDF" />}
          title="PDF"
          description="Document for printing and sharing"
          action={<DownloadIcon />}
          onClick={() =>
            run(async () => {
              await readyWidgetsForPrint();
              window.print();
            })
          }
        />
        <Row
          badge={<Badge label="M↓" />}
          title="Markdown"
          description="Plain-text .md file"
          action={<DownloadIcon />}
          onClick={() =>
            run(() => flush().then(() => download(exportPath(scope, docId, tabId, "md"))))
          }
          extra={
            <button
              type="button"
              className="share-icon-button share-export-copy"
              aria-label="Copy as Markdown"
              onClick={() =>
                run(() => copyMarkdown(flush, exportPath(scope, docId, tabId, "md")), "Copied")
              }
            >
              <CopyIcon />
            </button>
          }
        />
      </ul>

      {inT3Code ? (
        <>
          <h3 className="share-section-label">Send to</h3>
          <ul className="share-export-list">
            <Row
              badge={<Badge label="G" />}
              title="Google Docs"
              description="Coming soon"
              action={<OpenIcon />}
              disabled
              onClick={() => undefined}
            />
            {canSendTo ? (
              <Row
                badge={<Badge label="N" />}
                title="Notion"
                description="New page in your Notion workspace"
                action={<OpenIcon />}
                disabled={sending}
                onClick={sendToNotion}
              />
            ) : null}
            {isNativeEmbed() ? null : (
              <Row
                badge={<Badge label="C" />}
                title="Claude Docs"
                description="Recreate this doc in Claude Docs"
                action={<OpenIcon />}
                onClick={() =>
                  run(async () => {
                    // The agent reads the doc from the server, so pending edits go first.
                    await flush();
                    postToEmbedParent({
                      type: "t3-docs:copy-to-claude-doc",
                      docId,
                      title,
                      url: docUrl,
                    });
                  })
                }
              />
            )}
          </ul>
        </>
      ) : null}

      {status ? (
        <p
          className={status.kind === "error" ? "share-error" : "muted share-status"}
          role={status.kind === "error" ? "alert" : "status"}
        >
          {status.text}
          {status.kind === "sent" && status.url ? (
            <>
              {" "}
              <a href={status.url} target="_blank" rel="noopener noreferrer">
                Open page
              </a>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
