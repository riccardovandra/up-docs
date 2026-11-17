// The folder sidebar and everything around it on the home page: the folder
// heading (with chips when the sidebar is hidden, a folder bar on phones),
// folder cards and rows, the folder picker, and the view menu.

import { useState, type ReactNode } from "react";

import { childFolders, folderPath, type Folder, type FolderItemKind } from "../../../shared/folders.ts";
import {
  ChevronDownIcon,
  CloseIcon,
  FolderIcon,
  GridIcon,
  HomeIcon,
  ListIcon,
  MoreIcon,
  PlusIcon,
} from "../icons.tsx";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../Menu.tsx";
import { TitleDialog } from "../TitleDialog.tsx";
import type { HomeView } from "../homeLogic.ts";
import {
  DESKTOP_CARDS_PER_ROW,
  PHONE_CARDS_PER_ROW,
  useFolders,
  useOptionalFolders,
  type FolderState,
} from "./folderState.tsx";
import "./folders.css";

const KIND_WORDS: Readonly<Record<FolderItemKind, { readonly one: string; readonly many: string }>> = {
  doc: { one: "doc", many: "docs" },
  diagram: { one: "diagram", many: "diagrams" },
  sheet: { one: "sheet", many: "sheets" },
};

const counted = (kind: FolderItemKind, count: number) =>
  `${count} ${count === 1 ? KIND_WORDS[kind].one : KIND_WORDS[kind].many}`;

const PanelIcon = (props: { readonly size?: number }) => (
  <svg
    aria-hidden="true"
    width={props.size ?? 18}
    height={props.size ?? 18}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </svg>
);

const ChevronRightIcon = () => (
  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="m9 6 6 6-6 6" />
  </svg>
);

const BackIcon = () => (
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="m15 6-6 6 6 6" />
  </svg>
);

/** A dialog asking for a folder name, for New folder and Rename. */
type NameDialog =
  | { readonly mode: "create"; readonly parentId: string | null }
  | { readonly mode: "rename"; readonly folder: Folder };

function FolderNameDialog(props: { readonly dialog: NameDialog; readonly onClose: () => void }) {
  const folders = useFolders();
  const { dialog } = props;
  const parent =
    dialog.mode === "create" && dialog.parentId !== null
      ? folders.folders.find((folder) => folder.id === dialog.parentId)
      : undefined;
  return (
    <TitleDialog
      heading={dialog.mode === "create" ? "New folder" : "Rename folder"}
      detail={dialog.mode === "create" ? `In ${parent?.name ?? folders.projectName}` : null}
      initial={dialog.mode === "rename" ? dialog.folder.name : ""}
      submitLabel={dialog.mode === "create" ? "Create" : "Rename"}
      onSubmit={async (name) => {
        if (dialog.mode === "create") {
          const created = await folders.createFolder(dialog.parentId, name);
          if (created === null) throw new Error("not created");
        } else if (name !== dialog.folder.name) {
          await folders.renameFolder(dialog.folder.id, name);
        }
      }}
      onClose={props.onClose}
    />
  );
}

/** The library's body, with the folder sidebar beside it while it shows. */
export function FolderLayout(props: { readonly kind: FolderItemKind; readonly children: ReactNode }) {
  const folders = useFolders();
  return (
    <div className={folders.sidebarShown ? "folder-layout with-sidebar" : "folder-layout"}>
      {folders.sidebarShown ? <FolderSidebar kind={props.kind} /> : null}
      <div className="folder-main">{props.children}</div>
      {folders.picker ? <FolderPicker kind={props.kind} /> : null}
    </div>
  );
}

function TreeRows(props: {
  readonly kind: FolderItemKind;
  readonly parentId: string | null;
  readonly depth: number;
  readonly openPath: ReadonlySet<string>;
}) {
  const folders = useFolders();
  return childFolders(folders.folders, props.parentId).map((folder) => {
    const hasChildren = folders.folders.some((candidate) => candidate.parentId === folder.id);
    const open = props.openPath.has(folder.id);
    const count = folders.countIn(props.kind, folder.id);
    return (
      <div key={folder.id}>
        <button
          type="button"
          className="folder-tree-row"
          aria-current={folders.at?.id === folder.id ? "true" : undefined}
          style={{ paddingLeft: `${0.5 + props.depth}rem` }}
          onClick={() => folders.go(folder.id)}
          {...folders.dropProps(folder.id)}
        >
          <span className="folder-tree-twisty">
            {hasChildren ? open ? <ChevronDownIcon size={13} /> : <ChevronRightIcon /> : null}
          </span>
          <FolderIcon size={16} />
          <span className="folder-tree-name">{folder.name}</span>
          <span className={count === 0 ? "folder-tree-count zero" : "folder-tree-count"}>{count}</span>
        </button>
        {hasChildren && open ? (
          <TreeRows kind={props.kind} parentId={folder.id} depth={props.depth + 1} openPath={props.openPath} />
        ) : null}
      </div>
    );
  });
}

function FolderSidebar(props: { readonly kind: FolderItemKind }) {
  const folders = useFolders();
  const [naming, setNaming] = useState<NameDialog | null>(null);
  const openPath = new Set(folderPath(folders.folders, folders.at?.id ?? null).map((folder) => folder.id));
  return (
    <nav className="folder-sidebar" aria-label="Folders">
      <div className="folder-sidebar-head">
        <span>Folders</span>
        <button
          type="button"
          className="home-icon-button"
          aria-label="Hide folders"
          title="Hide folders ( [ )"
          onClick={folders.toggleSidebar}
        >
          <PanelIcon size={17} />
        </button>
      </div>
      <button
        type="button"
        className="folder-tree-row"
        aria-current={folders.at === null ? "true" : undefined}
        onClick={() => folders.go(null)}
        {...folders.dropProps(null)}
      >
        <span className="folder-tree-twisty" />
        <HomeIcon size={16} />
        <span className="folder-tree-name">All {KIND_WORDS[props.kind].many}</span>
        <span className="folder-tree-count">{folders.countIn(props.kind, null)}</span>
      </button>
      {folders.folders.length > 0 ? <hr className="folder-sidebar-rule" /> : null}
      <TreeRows kind={props.kind} parentId={null} depth={0} openPath={openPath} />
      {folders.canManage ? (
        <button
          type="button"
          className="folder-tree-row folder-tree-new"
          onClick={() => setNaming({ mode: "create", parentId: folders.at?.id ?? null })}
        >
          <span className="folder-tree-twisty" />
          <PlusIcon size={16} />
          <span className="folder-tree-name">New folder</span>
        </button>
      ) : null}
      {naming ? <FolderNameDialog dialog={naming} onClose={() => setNaming(null)} /> : null}
    </nav>
  );
}

/** Subfolders as chips, with a way up: navigation while the sidebar is hidden or on a phone. */
function FolderChips(props: { readonly kind: FolderItemKind; readonly className: string }) {
  const folders = useFolders();
  const up = folders.at?.parentId ?? null;
  if (folders.at === null && folders.subfolders.length === 0) return null;
  const upFolder = up === null ? null : folders.folders.find((folder) => folder.id === up);
  return (
    <div className={`folder-chips ${props.className}`}>
      {folders.at !== null ? (
        <button type="button" className="folder-chip" onClick={() => folders.go(up)} {...folders.dropProps(up)}>
          <BackIcon />
          {upFolder?.name ?? `All ${KIND_WORDS[props.kind].many}`}
        </button>
      ) : null}
      {folders.subfolders.map((folder) => (
        <button
          key={folder.id}
          type="button"
          className="folder-chip"
          onClick={() => folders.go(folder.id)}
          {...folders.dropProps(folder.id)}
        >
          <FolderIcon size={14} />
          {folder.name}
          <span className="folder-chip-count">{folders.countIn(props.kind, folder.id)}</span>
        </button>
      ))}
    </div>
  );
}

function FolderMenu(props: { readonly folder: Folder }) {
  const folders = useFolders();
  const [naming, setNaming] = useState<NameDialog | null>(null);
  return (
    <>
      <Menu label={`${props.folder.name} options`} trigger={<MoreIcon size={16} />} align="start">
        {(close) => (
          <>
            <MenuItem
              onSelect={() => {
                close();
                setNaming({ mode: "create", parentId: props.folder.id });
              }}
            >
              New folder inside
            </MenuItem>
            <MenuItem
              onSelect={() => {
                close();
                setNaming({ mode: "rename", folder: props.folder });
              }}
            >
              Rename
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              danger
              onSelect={() => {
                close();
                if (
                  window.confirm(
                    `Delete the folder "${props.folder.name}"? What is in it moves up a level; nothing is deleted.`,
                  )
                ) {
                  void folders.deleteFolder(props.folder.id);
                }
              }}
            >
              Delete folder…
            </MenuItem>
          </>
        )}
      </Menu>
      {naming ? <FolderNameDialog dialog={naming} onClose={() => setNaming(null)} /> : null}
    </>
  );
}

/**
 * Where the view is: the folder's path and name with a count, below the
 * toolbar. Hidden-sidebar desktops get a show button and subfolder chips;
 * phones get a folder bar that opens the picker. Nothing outside a project.
 */
export function FolderHead(props: { readonly kind: FolderItemKind; readonly count: number }) {
  const folders = useFolders();
  if (!folders.active) return null;
  const path = folderPath(folders.folders, folders.at?.id ?? null);
  const all = `All ${KIND_WORDS[props.kind].many}`;

  if (folders.narrow) {
    return (
      <div className="folder-phone-bar">
        <button type="button" className="folder-phone-path" onClick={() => folders.openPicker({ mode: "go" })}>
          {folders.at ? <FolderIcon size={18} /> : <HomeIcon size={18} />}
          <span className="folder-phone-path-text">
            {path.length === 0
              ? all
              : path.map((folder, index) =>
                  index === path.length - 1 ? (
                    <span key={folder.id}>{folder.name}</span>
                  ) : (
                    <span key={folder.id} className="folder-phone-path-dim">
                      {folder.name} /{" "}
                    </span>
                  ),
                )}
          </span>
          <span className="folder-phone-path-count">{folders.countIn(props.kind, folders.at?.id ?? null)}</span>
          <ChevronDownIcon size={15} />
        </button>
        <FolderChips kind={props.kind} className="folder-chips-scroll" />
      </div>
    );
  }

  const subCount = folders.subfolders.length;
  return (
    <>
      <div className="folder-head">
        {folders.sidebarShown ? null : (
          <button
            type="button"
            className="home-icon-button"
            aria-label="Show folders"
            title="Show folders ( [ )"
            onClick={folders.toggleSidebar}
          >
            <PanelIcon size={17} />
          </button>
        )}
        <div className="folder-head-where">
          {path.length > 0 ? (
            <div className="folder-head-path">
              <button type="button" onClick={() => folders.go(null)} {...folders.dropProps(null)}>
                {all}
              </button>
              {path.slice(0, -1).map((folder) => (
                <span key={folder.id}>
                  /
                  <button type="button" onClick={() => folders.go(folder.id)} {...folders.dropProps(folder.id)}>
                    {folder.name}
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <h2 className="folder-head-title">{folders.at?.name ?? all}</h2>
        </div>
        <span className="folder-head-count">
          {counted(props.kind, props.count)}
          {folders.at !== null && subCount > 0
            ? ` · ${subCount} folder${subCount === 1 ? "" : "s"}`
            : ""}
        </span>
        {folders.at !== null && folders.canManage ? <FolderMenu folder={folders.at} /> : null}
      </div>
      {folders.sidebarShown ? null : <FolderChips kind={props.kind} className="" />}
    </>
  );
}

/** Whether a view shows subfolders as cards or rows: inside a folder, with the sidebar showing. */
export const showsFolderCards = (folders: FolderState) =>
  folders.active && folders.sidebarShown && folders.at !== null;

/** The folder shown's subfolders as cards, for the start of a grid. */
export function FolderCards(props: { readonly kind: FolderItemKind }) {
  const folders = useFolders();
  if (!showsFolderCards(folders)) return null;
  return folders.subfolders.map((folder) => {
    const count = folders.countIn(props.kind, folder.id);
    const inside = folders.folders.filter((candidate) => candidate.parentId === folder.id).length;
    const titles = folders.titlesIn(props.kind, folder.id);
    return (
      <button
        key={folder.id}
        type="button"
        className="doc-card folder-card"
        onClick={() => folders.go(folder.id)}
        {...folders.dropProps(folder.id)}
      >
        <span className="folder-card-cover" aria-hidden="true">
          <span className="folder-card-back" />
          {titles.map((title, index) => (
            <span key={index} className={`folder-card-peek peek-${index + 1}`}>
              {title}
            </span>
          ))}
          <span className="folder-card-front">{count}</span>
        </span>
        <span className="doc-card-footer">
          <span className="doc-card-icon folder-card-icon">
            <FolderIcon size={18} />
          </span>
          <span className="doc-card-text">
            <span className="doc-card-title">{folder.name}</span>
            <span className="doc-card-meta">
              {count === 0 ? "Empty" : counted(props.kind, count)}
              {inside > 0 ? ` · ${inside} folder${inside === 1 ? "" : "s"}` : ""}
            </span>
          </span>
        </span>
      </button>
    );
  });
}

/** The folder shown's subfolders as list rows. */
export function FolderRows(props: { readonly kind: FolderItemKind; readonly columns: number }) {
  const folders = useFolders();
  if (!showsFolderCards(folders)) return null;
  return folders.subfolders.map((folder) => (
    <tr
      key={folder.id}
      className="doc-row folder-row"
      onClick={() => folders.go(folder.id)}
      {...folders.dropProps(folder.id)}
    >
      <td className="doc-row-title">
        <button type="button" className="folder-row-button">
          <FolderIcon size={16} />
          <span className="doc-row-title-text">
            <span>{folder.name}</span>
          </span>
        </button>
      </td>
      <td className="doc-row-muted" colSpan={props.columns - 1}>
        {counted(props.kind, folders.countIn(props.kind, folder.id))}
      </td>
    </tr>
  ));
}

/** The list's Folder cell: the item's folder as a chip that opens it. */
export function FolderCell(props: { readonly kind: FolderItemKind; readonly id: string }) {
  const folders = useOptionalFolders();
  if (!folders?.active) return null;
  const folder = folders.folderOf(props.kind, props.id);
  return (
    <td className="doc-row-folder" onClick={(event) => event.stopPropagation()}>
      {folder ? (
        <button type="button" className="folder-cell-chip" onClick={() => folders.go(folder.id)}>
          <FolderIcon size={13} />
          {folder.name}
        </button>
      ) : (
        <span className="doc-row-muted">None</span>
      )}
    </td>
  );
}

/** The list header's Folder column, while folders apply. */
export function FolderHeaderCell() {
  return useOptionalFolders()?.active ? <th>Folder</th> : null;
}

/** "Move to folder…" for an item's menu; nothing when filing is off. */
export function MoveToFolderItem(props: {
  readonly kind: FolderItemKind;
  readonly id: string;
  readonly title: string;
  readonly close: () => void;
}) {
  const folders = useOptionalFolders();
  if (!folders?.canManage) return null;
  return (
    <MenuItem
      onSelect={() => {
        props.close();
        folders.openPicker({ mode: "move", kind: props.kind, id: props.id, title: props.title });
      }}
    >
      Move to folder…
    </MenuItem>
  );
}

function PickerRows(props: { readonly parentId: string | null; readonly depth: number; readonly current: string | null; readonly kind: FolderItemKind; readonly onPick: (folderId: string) => void; readonly counts: boolean }) {
  const folders = useFolders();
  return childFolders(folders.folders, props.parentId).map((folder) => (
    <div key={folder.id}>
      <button
        type="button"
        className="folder-tree-row"
        aria-current={props.current === folder.id ? "true" : undefined}
        style={{ paddingLeft: `${0.6 + props.depth * 1.1}rem` }}
        onClick={() => props.onPick(folder.id)}
      >
        <FolderIcon size={16} />
        <span className="folder-tree-name">{folder.name}</span>
        {props.current === folder.id ? <span className="folder-tree-current">Current</span> : null}
        {props.counts ? <span className="folder-tree-count">{folders.countIn(props.kind, folder.id)}</span> : null}
      </button>
      <PickerRows {...props} parentId={folder.id} depth={props.depth + 1} />
    </div>
  ));
}

/**
 * The folder picker: on a phone it opens from the folder bar to jump to a
 * folder; anywhere it files one item ("Move to folder…"). A bottom sheet on
 * phones, a centred dialog elsewhere.
 */
function FolderPicker(props: { readonly kind: FolderItemKind }) {
  const folders = useFolders();
  const picker = folders.picker;
  const [naming, setNaming] = useState<NameDialog | null>(null);
  if (!picker) return null;
  const moving = picker.mode === "move";
  const current = moving ? (folders.folderOf(picker.kind, picker.id)?.id ?? null) : (folders.at?.id ?? null);
  const pick = (folderId: string | null) => {
    folders.closePicker();
    if (moving) {
      if (folderId !== current) void folders.place(picker.kind, picker.id, folderId);
    } else {
      folders.go(folderId);
    }
  };
  return (
    <div
      className="folder-picker-scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) folders.closePicker();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") folders.closePicker();
      }}
    >
      <div className="folder-picker" role="dialog" aria-modal="true" aria-label={moving ? "Move to folder" : "Folders"}>
        <div className="folder-picker-grab" />
        <div className="folder-picker-head">
          <h3>
            {moving ? (
              <>
                Move <span className="doc-row-muted">“{picker.title}”</span>
              </>
            ) : (
              "Folders"
            )}
          </h3>
          <button type="button" className="home-icon-button" aria-label="Close" autoFocus onClick={folders.closePicker}>
            <CloseIcon size={16} />
          </button>
        </div>
        <button
          type="button"
          className="folder-tree-row"
          aria-current={current === null ? "true" : undefined}
          onClick={() => pick(null)}
        >
          <HomeIcon size={16} />
          <span className="folder-tree-name">{moving ? "No folder" : `All ${KIND_WORDS[props.kind].many}`}</span>
          {current === null ? <span className="folder-tree-current">Current</span> : null}
          {moving ? null : <span className="folder-tree-count">{folders.countIn(props.kind, null)}</span>}
        </button>
        <hr className="folder-sidebar-rule" />
        <PickerRows parentId={null} depth={0} current={current} kind={props.kind} onPick={pick} counts={!moving} />
        {folders.canManage ? (
          <button
            type="button"
            className="folder-tree-row folder-tree-new"
            onClick={() => setNaming({ mode: "create", parentId: moving ? null : (folders.at?.id ?? null) })}
          >
            <PlusIcon size={16} />
            <span className="folder-tree-name">New folder</span>
          </button>
        ) : null}
      </div>
      {naming ? <FolderNameDialog dialog={naming} onClose={() => setNaming(null)} /> : null}
    </div>
  );
}

/** The toolbar's view menu: grid or list, cards per row, and the folder sidebar. */
export function ViewMenu(props: { readonly view: HomeView; readonly onView: (view: HomeView) => void }) {
  const folders = useFolders();
  const options = folders.narrow ? PHONE_CARDS_PER_ROW : DESKTOP_CARDS_PER_ROW;
  return (
    <Menu label="View" trigger={props.view === "grid" ? <GridIcon /> : <ListIcon />} align="end">
      {(close) => (
        <>
          <MenuLabel>Layout</MenuLabel>
          <MenuItem kind="radio" checked={props.view === "grid"} icon={<GridIcon size={16} />} onSelect={() => { props.onView("grid"); close(); }}>
            Grid
          </MenuItem>
          <MenuItem kind="radio" checked={props.view === "list"} icon={<ListIcon size={16} />} onSelect={() => { props.onView("list"); close(); }}>
            List
          </MenuItem>
          {props.view === "grid" ? (
            <>
              <MenuSeparator />
              <MenuLabel>{folders.narrow ? "Cards per row on this phone" : "Cards per row"}</MenuLabel>
              <div className="view-menu-cols" role="group" aria-label="Cards per row">
                {options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="menuitemradio"
                    tabIndex={-1}
                    aria-checked={folders.cardsPerRow === option}
                    className="view-menu-col"
                    onClick={() => folders.setCardsPerRow(option)}
                  >
                    {option === "auto" ? "Auto" : option}
                  </button>
                ))}
              </div>
            </>
          ) : null}
          {folders.active && !folders.narrow ? (
            <>
              <MenuSeparator />
              <MenuItem kind="checkbox" checked={folders.sidebarOpen} onSelect={() => { folders.toggleSidebar(); close(); }}>
                Folder sidebar <span className="view-menu-key">[</span>
              </MenuItem>
            </>
          ) : null}
        </>
      )}
    </Menu>
  );
}
