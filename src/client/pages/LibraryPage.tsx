import { useCallback, useEffect, useMemo, useState } from "react";

import { isAdmin } from "../../shared/access.ts";
import { titleProjectKey } from "../../shared/embed.ts";
import {
  SEARCH_MAX_QUERY,
  SEARCH_MIN_QUERY,
  type HomeLibrary,
  type SearchHit,
} from "../../shared/home.ts";
import { DOC_STATUS_LABEL, DOC_STATUSES, type DocStatus } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { isEmbedded } from "../embedBridge.ts";
import { useEmbedProject } from "../embedContext.ts";
import {
  DocCard,
  DocRow,
  NewDocCard,
  NewDocRow,
  type DocActions,
  type MoveTarget,
} from "../home/DocCard.tsx";
import {
  ALL_PROJECTS,
  filterEntries,
  HOME_SORTS,
  HOME_TABS,
  homeEntries,
  NO_PROJECT,
  parsePins,
  parseStoredScope,
  pinnedFirst,
  restoreScope,
  sameScope,
  searchEntries,
  sortEntries,
  togglePin,
  type HomeEntry,
  type HomeSort,
  type HomeTab,
  type HomeView,
  type ProjectScope,
} from "../home/homeLogic.ts";
import {
  CloseIcon,
  FilterIcon,
  GridIcon,
  ListIcon,
  PlusIcon,
  SearchIcon,
  SortIcon,
} from "../home/icons.tsx";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../home/Menu.tsx";
import { AccountMenu } from "../home/AccountMenu.tsx";
import { TitleDialog } from "../home/TitleDialog.tsx";
import { useLocalFilesAvailable } from "../local/hostClient.ts";
import { LocalFilesSection } from "../local/LocalFilesSection.tsx";
import {
  NoProjectBadge,
  ProjectBadge,
  ProjectSwitcher,
  scopeName,
  type SwitcherProject,
} from "../home/ProjectSwitcher.tsx";
import { useMe } from "../me.ts";
import { docPath, navigate } from "../router.ts";
import { canonicalDocUrl } from "../share/ShareDialog.tsx";
import "../home/home.css";

const SEARCH_DEBOUNCE_MS = 250;
const VIEW_KEY = "docs-cloud.home.view";
const SORT_KEY = "docs-cloud.home.sort";
/** Pins stay on this device: never sent to the server or synced. */
const PINS_KEY = "docs-cloud.home.pins";
/** The project pick is remembered separately standalone and inside T3 Code. */
const scopeKey = (embedded: boolean) =>
  `docs-cloud.home.project.${embedded ? "embedded" : "standalone"}`;

// Storage can be unavailable (privacy modes, some embeds); the page then just forgets.
function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Remembering is a convenience.
  }
}

const isSort = (value: string | null): value is HomeSort =>
  HOME_SORTS.some((sort) => sort.id === value);

export function LibraryPage() {
  const me = useMe();
  const userId = me?.user.id ?? "";
  const admin = isAdmin(userId);
  const embedProject = useEmbedProject();
  const embedded = isEmbedded();
  const embedKey =
    embedProject === null ? null : (embedProject.key ?? titleProjectKey(embedProject.name));
  const localFiles = useLocalFilesAvailable() === true;

  const [library, setLibrary] = useState<HomeLibrary | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<HomeTab>("all");
  const [sort, setSort] = useState<HomeSort>(() => {
    const stored = readStorage(SORT_KEY);
    return isSort(stored) ? stored : "opened";
  });
  const [view, setView] = useState<HomeView>(() =>
    readStorage(VIEW_KEY) === "list" ? "list" : "grid",
  );
  const [pins, setPins] = useState(() => parsePins(readStorage(PINS_KEY)));
  const [statuses, setStatuses] = useState<ReadonlySet<DocStatus>>(() => new Set());
  // A pick holds only while the panel stays on the project it was made in.
  const [picked, setPicked] = useState<{
    readonly embedKey: string | null;
    readonly scope: ProjectScope;
  } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [serverHits, setServerHits] = useState<{
    readonly query: string;
    readonly hits: ReadonlyArray<SearchHit>;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<HomeEntry | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setLibrary(await api.library());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const trimmedQuery = query.trim();
  useEffect(() => {
    if (trimmedQuery.length < SEARCH_MIN_QUERY || trimmedQuery.length > SEARCH_MAX_QUERY) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.search(trimmedQuery, controller.signal).then(
        ({ hits }) => setServerHits({ query: trimmedQuery, hits }),
        () => undefined,
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [trimmedQuery]);

  const entries = useMemo(() => (library ? homeEntries(library) : []), [library]);

  const projects = useMemo((): ReadonlyArray<SwitcherProject> => {
    const listed = (library?.projects ?? []).map(({ key, name }) => ({ key, name }));
    // Inside T3 Code its project is always offered, even before it has docs here.
    if (embedProject && embedKey && !listed.some((project) => project.key === embedKey)) {
      listed.push({ key: embedKey, name: embedProject.name });
    }
    return listed.toSorted((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
  }, [library, embedProject, embedKey]);

  const scope = useMemo((): ProjectScope => {
    if (picked && picked.embedKey === embedKey) return picked.scope;
    return restoreScope({
      stored: parseStoredScope(readStorage(scopeKey(embedded))),
      embedKey,
      projectKeys: new Set(projects.map((project) => project.key)),
    });
  }, [picked, embedKey, embedded, projects]);

  const chooseScope = useCallback(
    (next: ProjectScope) => {
      setPicked({ embedKey, scope: next });
      writeStorage(scopeKey(embedded), JSON.stringify({ embedKey, scope: next }));
    },
    [embedKey, embedded],
  );

  const chooseSort = (next: HomeSort) => {
    setSort(next);
    writeStorage(SORT_KEY, next);
  };
  const toggleView = () => {
    const next = view === "grid" ? "list" : "grid";
    setView(next);
    writeStorage(VIEW_KEY, next);
  };
  const toggleStatus = (status: DocStatus) =>
    setStatuses((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });

  const pinned = useMemo(() => new Set(pins), [pins]);
  const visible = useMemo(
    () =>
      pinnedFirst(
        sortEntries(filterEntries(entries, { tab, userId, scope, statuses }), sort),
        pinned,
      ),
    [entries, tab, userId, scope, statuses, sort, pinned],
  );
  const hits = serverHits?.query === trimmedQuery ? serverHits.hits : [];
  const results = useMemo(
    () => searchEntries(visible, trimmedQuery, hits),
    [visible, trimmedQuery, hits],
  );

  const moveTargets = useMemo(
    (): ReadonlyArray<MoveTarget> =>
      (library?.projects ?? []).map(({ id, key, name }) => ({ id, key, name })),
    [library],
  );
  const actions = useMemo(
    (): DocActions => ({
      moveTargets,
      onMove: (entry: HomeEntry, projectId: string | null) => {
        void api.moveDoc(entry.id, projectId).then(reload, reload);
      },
      onCopyLink: (entry: HomeEntry) =>
        // Same wording as the doc page's Copy link.
        void navigator.clipboard.writeText(canonicalDocUrl(entry.id)).then(
          () => setNotice("Link copied. Only people the doc is shared with can open it."),
          () => setNotice("Could not copy the link."),
        ),
      onRename: setRenaming,
      onDelete: (entry: HomeEntry) => {
        // Same wording as the doc page's Delete.
        if (
          !window.confirm(
            `Delete "${entry.title}" for everyone? Its tabs, comments and images go too.`,
          )
        ) {
          return;
        }
        void api.deleteDoc(entry.id).then(reload, reload);
      },
      onTogglePin: (entry: HomeEntry) =>
        setPins((current) => {
          const next = togglePin(current, entry.id);
          writeStorage(PINS_KEY, JSON.stringify(next));
          return next;
        }),
    }),
    [moveTargets, reload],
  );

  const scopeProject =
    scope.kind === "project"
      ? library?.projects.find((candidate) => candidate.key === scope.key)
      : undefined;
  // Only the admin creates projects, so others start docs outside a project T3 Code has not synced.
  const createsProject =
    scopeProject === undefined &&
    admin &&
    embedProject !== null &&
    scope.kind === "project" &&
    scope.key === embedKey;

  const createDoc = async (title: string) => {
    let projectId = scopeProject?.id ?? null;
    if (createsProject && embedProject && embedKey) {
      projectId = (await api.createProject(embedProject.name, embedKey)).project.id;
    }
    const created = await api.createDoc(projectId, title);
    navigate(docPath(created.doc.id));
  };

  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
  };

  if (failed && !library) {
    return (
      <main className="home">
        <p className="error">Could not load your docs.</p>
        <button type="button" className="button secondary" onClick={() => void reload()}>
          Try again
        </button>
      </main>
    );
  }
  if (!library) return null;

  const scopeLabel = scopeName(scope, projects);
  const createIn = scopeProject || createsProject ? scopeLabel : "No project";
  const startDoc = () => setCreating(true);
  const filtering = statuses.size > 0;

  return (
    <main className="home">
      <div className="home-title-row">
        <h1 className="home-title">UP Docs</h1>
        <ProjectSwitcher scope={scope} projects={projects} onChange={chooseScope} />
        <AccountMenu />
      </div>

      {notice ? (
        <div className="notice" role="status">
          {notice}
          <button type="button" className="link-button" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="home-toolbar">
        <div className="home-tabs" role="tablist" aria-label="Whose docs">
          {HOME_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className="home-tab"
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="home-controls">
          {searchOpen ? (
            <div className="home-search">
              <SearchIcon size={16} />
              <input
                autoFocus
                type="search"
                aria-label="Search docs"
                placeholder="Search docs"
                maxLength={SEARCH_MAX_QUERY}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") closeSearch();
                }}
                onBlur={() => {
                  if (!query) setSearchOpen(false);
                }}
              />
              <button
                type="button"
                className="home-search-clear"
                aria-label="Close search"
                onClick={closeSearch}
              >
                <CloseIcon size={14} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="home-icon-button"
              aria-label="Search"
              onClick={() => setSearchOpen(true)}
            >
              <SearchIcon />
            </button>
          )}
          <Menu label="Sort" trigger={<SortIcon />}>
            {(close) => (
              <>
                <MenuLabel>Sort by</MenuLabel>
                {HOME_SORTS.map((item) => (
                  <MenuItem
                    key={item.id}
                    kind="radio"
                    checked={sort === item.id}
                    onSelect={() => {
                      chooseSort(item.id);
                      close();
                    }}
                  >
                    {item.label}
                  </MenuItem>
                ))}
              </>
            )}
          </Menu>
          <button
            type="button"
            className="home-icon-button"
            aria-label={view === "grid" ? "Show as list" : "Show as grid"}
            onClick={toggleView}
          >
            {view === "grid" ? <ListIcon /> : <GridIcon />}
          </button>
          <Menu
            label="Filter"
            triggerClassName={`home-icon-button${filtering ? " active" : ""}`}
            trigger={<FilterIcon />}
          >
            {() => (
              <>
                <MenuLabel>Status</MenuLabel>
                {DOC_STATUSES.map((status) => (
                  <MenuItem
                    key={status}
                    kind="checkbox"
                    checked={statuses.has(status)}
                    onSelect={() => toggleStatus(status)}
                  >
                    {DOC_STATUS_LABEL[status]}
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuLabel>Project</MenuLabel>
                <MenuItem
                  kind="radio"
                  checked={sameScope(scope, ALL_PROJECTS)}
                  onSelect={() => chooseScope(ALL_PROJECTS)}
                >
                  All projects
                </MenuItem>
                <div className="home-menu-scroll">
                  {projects.map((project) => {
                    const option: ProjectScope = { kind: "project", key: project.key };
                    return (
                      <MenuItem
                        key={project.key}
                        kind="radio"
                        checked={sameScope(scope, option)}
                        icon={<ProjectBadge name={project.name} />}
                        onSelect={() => chooseScope(option)}
                      >
                        {project.name}
                      </MenuItem>
                    );
                  })}
                </div>
                <MenuItem
                  kind="radio"
                  checked={sameScope(scope, NO_PROJECT)}
                  icon={<NoProjectBadge />}
                  onSelect={() => chooseScope(NO_PROJECT)}
                >
                  No project
                </MenuItem>
                {filtering || scope.kind !== "all" ? (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      onSelect={() => {
                        setStatuses(new Set());
                        chooseScope(ALL_PROJECTS);
                      }}
                    >
                      Clear filters
                    </MenuItem>
                  </>
                ) : null}
              </>
            )}
          </Menu>
          <button
            type="button"
            className="home-icon-button"
            aria-label="New doc"
            onClick={startDoc}
          >
            <PlusIcon />
          </button>
        </div>
      </div>

      {view === "grid" ? (
        <div className="doc-grid">
          <NewDocCard detail={`In ${createIn}`} onCreate={startDoc} />
          {results.map(({ entry, snippet }) => (
            <DocCard
              key={entry.id}
              entry={entry}
              snippet={snippet}
              pinned={pinned.has(entry.id)}
              actions={actions}
            />
          ))}
        </div>
      ) : (
        <table className="doc-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Project</th>
              <th>Status</th>
              <th>Owner</th>
              <th>Opened</th>
              <th>Edited</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            <NewDocRow detail={`In ${createIn}`} onCreate={startDoc} />
            {results.map(({ entry, snippet }) => (
              <DocRow
                key={entry.id}
                entry={entry}
                snippet={snippet}
                pinned={pinned.has(entry.id)}
                actions={actions}
              />
            ))}
          </tbody>
        </table>
      )}

      {results.length === 0 ? (
        <EmptyState
          query={trimmedQuery}
          tab={tab}
          scopeLabel={scope.kind === "all" ? null : scopeLabel}
          filtering={filtering}
          libraryEmpty={entries.length === 0}
          admin={admin}
        />
      ) : null}

      {localFiles ? <LocalFilesSection query={trimmedQuery} /> : null}

      {creating ? (
        <TitleDialog
          heading="New doc"
          detail={`In ${createIn}`}
          initial=""
          submitLabel="Create"
          onSubmit={createDoc}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {renaming ? (
        <TitleDialog
          heading="Rename doc"
          detail={null}
          initial={renaming.title}
          submitLabel="Rename"
          onSubmit={async (title) => {
            if (title !== renaming.title) await api.renameDoc(renaming.id, title);
            await reload();
          }}
          onClose={() => setRenaming(null)}
        />
      ) : null}
    </main>
  );
}

function EmptyState(props: {
  readonly query: string;
  readonly tab: HomeTab;
  readonly scopeLabel: string | null;
  readonly filtering: boolean;
  readonly libraryEmpty: boolean;
  readonly admin: boolean;
}) {
  let message: string;
  if (props.libraryEmpty) {
    message = props.admin
      ? "No docs yet. Start one with New doc."
      : "Nothing has been shared with you yet. Docs you create or are invited to show up here.";
  } else if (props.query) {
    message = `No docs match "${props.query}".`;
  } else if (props.filtering) {
    message = "No docs match these filters.";
  } else if (props.tab === "shared") {
    message = "Nothing has been shared with you here yet.";
  } else if (props.tab === "yours") {
    message = "You have not created any docs here yet.";
  } else {
    message = props.scopeLabel ? `No docs in ${props.scopeLabel} yet.` : "No docs yet.";
  }
  return <p className="home-empty">{message}</p>;
}
