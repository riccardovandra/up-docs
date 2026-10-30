import { memo, useState } from "react";

import type { DocRole } from "../../../shared/access.ts";
import { DOC_STATUS_LABEL, DOC_STATUSES, type DocStatus } from "../../../shared/protocol.ts";
import { ShareButton } from "../../share/ShareButton.tsx";
import type { ExportAction } from "../ExportMenu.tsx";
import { ChevronDown, CommentIcon, SparkIcon } from "../toolbar/icons.tsx";
import { InlineRename, MenuItem, MenuLabel, MenuSeparator, Popover } from "../toolbar/Popover.tsx";
import type { DocAbilities } from "./docAbilities.ts";
import { HomeLink } from "../../home/HomeLink.tsx";
import { MoveToProject } from "./MoveToProject.tsx";

/**
 * The bar across the top of a doc: the title and its menu on the left;
 * Start chat, Share and the comments toggle on the right. Memoised, with
 * stable callbacks from the page, so typing in the editor does not repaint it.
 */
export const DocHeader = memo(function DocHeader(props: {
  readonly docId: string;
  readonly title: string;
  readonly status: DocStatus;
  readonly projectId: string | null;
  readonly role: DocRole;
  readonly abilities: DocAbilities;
  readonly tabId: string | null;
  /** Saves the open tab's pending edit. */
  readonly flush: () => Promise<void>;
  readonly exportActions: ReadonlyArray<ExportAction>;
  readonly onRename: (title: string) => void;
  readonly onSetStatus: (status: DocStatus) => void;
  readonly onCopyLink: () => void;
  readonly onDelete: () => void;
  readonly onMoveToProject: (projectId: string | null) => void;
  readonly onStartChat: () => void;
  readonly onExportResult: (message: string | null) => void;
  /** The Share panel closed; the caller's own role may have changed. */
  readonly onShareClosed: () => void;
  readonly commentsOpen: boolean;
  readonly openCommentCount: number;
  readonly onToggleComments: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [choosingProject, setChoosingProject] = useState(false);
  const { abilities } = props;

  const runExport = (action: ExportAction) =>
    action.run().then(props.onExportResult, () => props.onExportResult("Export failed."));

  return (
    <header className="doc-header">
      <div className="doc-header-title">
        <HomeLink />
        <span className="doc-header-crumb" aria-hidden="true">
          /
        </span>
        {renaming ? (
          <InlineRename
            value={props.title}
            label="Doc title"
            className="doc-title-rename"
            onDone={(title) => {
              setRenaming(false);
              if (title && title !== props.title) props.onRename(title);
            }}
          />
        ) : (
          <Popover
            label="Doc menu"
            onClosed={() => setChoosingProject(false)}
            triggerClassName="doc-title-button"
            trigger={
              <>
                <span className="doc-title-text">{props.title}</span>
                <ChevronDown />
              </>
            }
          >
            {() =>
              choosingProject ? (
                <>
                  <MenuItem label="Back" keepOpen onSelect={() => setChoosingProject(false)} />
                  <MenuSeparator />
                  <MenuLabel>Move to project</MenuLabel>
                  <MoveToProject projectId={props.projectId} onMove={props.onMoveToProject} />
                </>
              ) : (
                <>
                  {abilities.manageDoc ? (
                    <MenuItem label="Rename" onSelect={() => setRenaming(true)} />
                  ) : null}
                  {abilities.manageDoc ? (
                    <MenuItem
                      label="Move to project…"
                      keepOpen
                      onSelect={() => setChoosingProject(true)}
                    />
                  ) : null}
                  <MenuItem label="Copy link" onSelect={props.onCopyLink} />
                  {abilities.manageDoc ? (
                    <>
                      <MenuSeparator />
                      <MenuLabel>Status</MenuLabel>
                      {DOC_STATUSES.map((status) => (
                        <MenuItem
                          key={status}
                          label={DOC_STATUS_LABEL[status]}
                          checked={status === props.status}
                          onSelect={() => {
                            if (status !== props.status) props.onSetStatus(status);
                          }}
                        />
                      ))}
                    </>
                  ) : (
                    <MenuLabel>Status: {DOC_STATUS_LABEL[props.status]}</MenuLabel>
                  )}
                  <MenuSeparator />
                  <MenuLabel>Export</MenuLabel>
                  {props.exportActions.map((action) => (
                    // Called straight from the click: copying needs its user activation.
                    <MenuItem
                      key={action.id}
                      label={action.label}
                      onSelect={() => void runExport(action)}
                    />
                  ))}
                  {abilities.deleteDoc ? (
                    <>
                      <MenuSeparator />
                      <MenuItem label="Delete doc…" danger onSelect={props.onDelete} />
                    </>
                  ) : null}
                </>
              )
            }
          </Popover>
        )}
      </div>
      <div className="doc-header-actions">
        {abilities.startChat ? (
          <button type="button" className="start-chat-button" onClick={props.onStartChat}>
            <SparkIcon />
            Start chat
          </button>
        ) : null}
        <ShareButton
          docId={props.docId}
          role={props.role}
          title={props.title}
          tabId={props.tabId}
          flush={props.flush}
          onClosed={props.onShareClosed}
        />
        <button
          type="button"
          className="comments-toggle"
          aria-pressed={props.commentsOpen}
          aria-label={
            props.openCommentCount > 0 ? `Comments, ${props.openCommentCount} open` : "Comments"
          }
          onClick={props.onToggleComments}
        >
          <CommentIcon />
          {props.openCommentCount > 0 ? <span className="comments-dot" aria-hidden="true" /> : null}
        </button>
      </div>
    </header>
  );
});
