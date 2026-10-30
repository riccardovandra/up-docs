import { memo, useState } from "react";

import { canEdit, canShare, displayName } from "../../shared/access.ts";
import { DOC_STATUS_LABEL } from "../../shared/protocol.ts";
import { docPath, navigate } from "../router.ts";
import { DocIcon, MoreIcon, PeopleIcon, PinIcon, PlusIcon } from "./icons.tsx";
import { activityLabel, formatDay, previewBlocks, type HomeEntry } from "./homeLogic.ts";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "./Menu.tsx";
import { NoProjectBadge, ProjectBadge, type SwitcherProject } from "./ProjectSwitcher.tsx";

/** Where a doc may move: the projects the person can see, keyed by id. */
export interface MoveTarget extends SwitcherProject {
  readonly id: string;
}

export interface DocActions {
  readonly moveTargets: ReadonlyArray<MoveTarget>;
  readonly onMove: (entry: HomeEntry, projectId: string | null) => void;
  readonly onCopyLink: (entry: HomeEntry) => void;
  readonly onRename: (entry: HomeEntry) => void;
  readonly onDelete: (entry: HomeEntry) => void;
  readonly onTogglePin: (entry: HomeEntry) => void;
}

const open = (docId: string) => (event: { preventDefault: () => void }) => {
  event.preventDefault();
  navigate(docPath(docId));
};

/**
 * The miniature page on a card: title, date chip and the first paragraphs as
 * plain static text, cropped by the card. Never an editor, so a grid of
 * hundreds stays cheap.
 */
function Preview(props: { readonly entry: HomeEntry }) {
  const blocks = previewBlocks(props.entry.preview);
  return (
    <div className="doc-card-paper" aria-hidden="true">
      <div className="doc-card-sheet">
        <div className="doc-card-sheet-title">{props.entry.title}</div>
        <div className="doc-card-sheet-meta">
          <span className="doc-card-chip">{formatDay(props.entry.updatedAt)}</span>
          <span className="doc-card-chip">{DOC_STATUS_LABEL[props.entry.status]}</span>
        </div>
        {blocks.length === 0 ? (
          <div className="doc-card-sheet-empty" />
        ) : (
          blocks.map((block, index) =>
            block.heading ? (
              <div key={index} className="doc-card-sheet-heading">
                {block.text}
              </div>
            ) : (
              <p key={index}>{block.text}</p>
            ),
          )
        )}
      </div>
    </div>
  );
}

function DocMenu(props: {
  readonly entry: HomeEntry;
  readonly pinned: boolean;
  readonly actions: DocActions;
}) {
  return (
    <Menu label={`Actions for ${props.entry.title}`} trigger={<MoreIcon size={16} />}>
      {(close) => (
        <DocMenuBody
          entry={props.entry}
          pinned={props.pinned}
          actions={props.actions}
          close={close}
        />
      )}
    </Menu>
  );
}

const focusMenuView = (view: HTMLDivElement | null) => {
  const items = [...(view?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];
  (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
};

/** Mounted only while the menu is open, so it always reopens on the main view. */
function DocMenuBody(props: {
  readonly entry: HomeEntry;
  readonly pinned: boolean;
  readonly actions: DocActions;
  readonly close: () => void;
}) {
  const { entry, pinned, actions, close } = props;
  const [moving, setMoving] = useState(false);
  const editable = canEdit(entry.role);

  const move = (projectId: string | null) => {
    close();
    if ((entry.project?.id ?? null) !== projectId) actions.onMove(entry, projectId);
  };

  return (
    // Keyed per view: switching views unmounts the focused item, so focus the new view.
    <div key={moving ? "move" : "main"} ref={focusMenuView}>
      {moving ? (
        <>
          <MenuItem onSelect={() => setMoving(false)}>Back</MenuItem>
          <MenuSeparator />
          <MenuLabel>Move to project</MenuLabel>
          <div className="home-menu-scroll">
            {actions.moveTargets.map((target) => (
              <MenuItem
                key={target.id}
                kind="radio"
                checked={entry.project?.id === target.id}
                icon={<ProjectBadge name={target.name} />}
                onSelect={() => move(target.id)}
              >
                {target.name}
              </MenuItem>
            ))}
          </div>
          <MenuItem
            kind="radio"
            checked={entry.project === null}
            icon={<NoProjectBadge />}
            onSelect={() => move(null)}
          >
            No project
          </MenuItem>
        </>
      ) : (
        <>
          <MenuItem
            onSelect={() => {
              close();
              navigate(docPath(entry.id));
            }}
          >
            Open
          </MenuItem>
          <MenuItem
            onSelect={() => {
              close();
              actions.onTogglePin(entry);
            }}
          >
            {pinned ? "Unpin" : "Pin"}
          </MenuItem>
          <MenuItem
            onSelect={() => {
              close();
              actions.onCopyLink(entry);
            }}
          >
            Copy link
          </MenuItem>
          {editable ? (
            <MenuItem
              onSelect={() => {
                close();
                actions.onRename(entry);
              }}
            >
              Rename
            </MenuItem>
          ) : null}
          {editable ? <MenuItem onSelect={() => setMoving(true)}>Move…</MenuItem> : null}
          {canShare(entry.role) ? (
            <>
              <MenuSeparator />
              <MenuItem
                danger
                onSelect={() => {
                  close();
                  actions.onDelete(entry);
                }}
              >
                Delete…
              </MenuItem>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

const PinnedMark = () => (
  <span className="doc-card-mark" aria-label="Pinned">
    <PinIcon size={16} />
  </span>
);

const SharedMark = () => (
  <span className="doc-card-mark" aria-label="Shared">
    <PeopleIcon size={16} />
  </span>
);

export const DocCard = memo(function DocCard(props: {
  readonly entry: HomeEntry;
  readonly snippet: string | null;
  readonly pinned: boolean;
  readonly actions: DocActions;
}) {
  const { entry } = props;
  return (
    <article className="doc-card">
      <a href={docPath(entry.id)} className="doc-card-link" onClick={open(entry.id)}>
        <Preview entry={entry} />
        <div className="doc-card-footer">
          <span className="doc-card-icon">
            <DocIcon size={18} />
          </span>
          <span className="doc-card-text">
            <span className="doc-card-title">{entry.title}</span>
            <span className="doc-card-meta">{props.snippet ?? activityLabel(entry)}</span>
          </span>
          {props.pinned ? <PinnedMark /> : null}
          {entry.memberCount > 1 ? <SharedMark /> : null}
        </div>
      </a>
      <div className="doc-card-menu">
        <DocMenu entry={entry} pinned={props.pinned} actions={props.actions} />
      </div>
    </article>
  );
});

export const DocRow = memo(function DocRow(props: {
  readonly entry: HomeEntry;
  readonly snippet: string | null;
  readonly pinned: boolean;
  readonly actions: DocActions;
}) {
  const { entry } = props;
  return (
    <tr className="doc-row" onClick={open(entry.id)}>
      <td className="doc-row-title">
        <a href={docPath(entry.id)} onClick={open(entry.id)}>
          <DocIcon size={16} />
          <span className="doc-row-title-text">
            <span>{entry.title}</span>
            {props.snippet ? <span className="doc-row-snippet">{props.snippet}</span> : null}
          </span>
          {props.pinned ? <PinnedMark /> : null}
          {entry.memberCount > 1 ? <SharedMark /> : null}
        </a>
      </td>
      <td>
        <span className="doc-row-project">
          {entry.project ? <ProjectBadge name={entry.project.name} /> : <NoProjectBadge />}
          <span>{entry.project?.name ?? "No project"}</span>
        </span>
      </td>
      <td>
        <span className="doc-card-chip">{DOC_STATUS_LABEL[entry.status]}</span>
      </td>
      <td className="doc-row-muted">{entry.owner ? displayName(entry.owner) : "Unknown"}</td>
      <td className="doc-row-muted">{entry.openedAt ? formatDay(entry.openedAt) : "Never"}</td>
      <td className="doc-row-muted">{formatDay(entry.updatedAt)}</td>
      <td className="doc-row-actions" onClick={(event) => event.stopPropagation()}>
        <DocMenu entry={entry} pinned={props.pinned} actions={props.actions} />
      </td>
    </tr>
  );
});

/** The grid's first tile: a card-sized way to start a doc in the current project. */
export function NewDocCard(props: { readonly detail: string; readonly onCreate: () => void }) {
  return (
    <button type="button" className="doc-card doc-card-new" onClick={props.onCreate}>
      <span className="doc-card-paper doc-card-new-paper" aria-hidden="true">
        <PlusIcon size={46} />
      </span>
      <span className="doc-card-footer">
        <span className="doc-card-icon">
          <DocIcon size={18} />
        </span>
        <span className="doc-card-text">
          <span className="doc-card-title">New doc</span>
          <span className="doc-card-meta">{props.detail}</span>
        </span>
      </span>
    </button>
  );
}

export function NewDocRow(props: { readonly detail: string; readonly onCreate: () => void }) {
  return (
    <tr className="doc-row doc-row-new">
      <td className="doc-row-title" colSpan={7}>
        <button type="button" onClick={props.onCreate}>
          <PlusIcon size={16} />
          <span>New doc</span>
          <span className="doc-row-muted">{props.detail}</span>
        </button>
      </td>
    </tr>
  );
}
